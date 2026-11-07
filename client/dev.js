const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { promisify } = require('util');

const rootDir = path.resolve(__dirname, '..');
const backendPath = path.join(rootDir, 'security', 'index.js');
const clientDir = __dirname;
const backendDataDir = path.join(process.env.APPDATA || os.homedir(), 'ShadowStream', 'security');
const logDir = path.join(backendDataDir, 'logs');
fs.mkdirSync(logDir, { recursive: true });
const launcherLogHandle = fs.openSync(path.join(logDir, 'launcher.log'), 'a');
function writeLauncherLog(level, args) {
    const message = args.map(value => value instanceof Error ? value.stack || value.message : String(value)).join(' ');
    fs.writeSync(launcherLogHandle, `[${new Date().toISOString()}] [${level}] ${message}\n`);
}
console.log = (...args) => writeLauncherLog('INFO', args);
console.error = (...args) => writeLauncherLog('ERROR', args);
const execFileAsync = promisify(execFile);
let backend;
let electron;
let shuttingDown = false;

function quotePowerShell(value) {
    return `'${value.replace(/'/g, "''")}'`;
}

async function isElevated() {
    const script = '$identity = [Security.Principal.WindowsIdentity]::GetCurrent(); $principal = [Security.Principal.WindowsPrincipal]::new($identity); $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)';
    const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        script
    ], { windowsHide: true });
    return stdout.trim().toLowerCase() === 'true';
}

async function relaunchElevated() {
    const scriptPath = path.join(clientDir, 'dev.js');
    const argumentList = `"${scriptPath}" --elevated`;
    const script = `Start-Process -FilePath ${quotePowerShell(process.execPath)} -ArgumentList ${quotePowerShell(argumentList)} -WorkingDirectory ${quotePowerShell(rootDir)} -WindowStyle Hidden -Verb RunAs -ErrorAction Stop`;
    await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        script
    ], { windowsHide: true });
}

function findAvailablePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(error => error ? reject(error) : resolve(port));
        });
    });
}

async function waitForBackend(port) {
    const url = `http://127.0.0.1:${port}/api/status`;
    for (let attempt = 0; attempt < 50; attempt += 1) {
        if (backend.exitCode !== null) throw new Error('Il backend si è chiuso durante l’avvio.');
        try {
            const response = await fetch(url);
            if (response.ok) return;
        } catch {
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }
    throw new Error('Timeout avviando il backend.');
}

function stopChild(child) {
    if (!child || child.exitCode !== null) return Promise.resolve();
    return new Promise(resolve => {
        child.once('exit', resolve);
        child.kill();
    });
}

function shutdown(exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    Promise.all([stopChild(electron), stopChild(backend)])
        .then(() => { process.exitCode = exitCode; })
        .catch(error => {
            console.error('Errore durante la chiusura dell’applicazione:', error.message);
            process.exitCode = 1;
        });
}

async function start() {
    if (process.platform === 'win32' && !process.argv.includes('--elevated') && !(await isElevated())) {
        console.log('Richiesta dei privilegi amministrativi per poter gestire Windows Firewall...');
        await relaunchElevated();
        process.exit(0);
    }

    fs.mkdirSync(backendDataDir, { recursive: true });
    const port = await findAvailablePort();

    backend = spawn(process.execPath, [backendPath], {
        cwd: rootDir,
        env: {
            ...process.env,
            PORT: String(port),
            SHADOWSTREAM_DATA_DIR: backendDataDir,
            SHADOWSTREAM_TEST_MODE: '0'
        },
        stdio: ['ignore', launcherLogHandle, launcherLogHandle]
    });
    backend.once('error', error => {
        console.error('Impossibile avviare il backend:', error.message);
        shutdown(1);
    });
    backend.once('exit', code => {
        if (!shuttingDown) {
            console.error(`Backend terminato con codice ${code}.`);
            shutdown(code || 1);
        }
    });

    await waitForBackend(port);

    electron = spawn(require('electron'), [clientDir], {
        cwd: clientDir,
        env: {
            ...process.env,
            SHADOWSTREAM_SECURITY_PORT: String(port),
            SHADOWSTREAM_DATA_DIR: backendDataDir,
            SHADOWSTREAM_TEST_MODE: '0'
        },
        stdio: ['ignore', launcherLogHandle, launcherLogHandle]
    });
    electron.once('error', error => {
        console.error('Impossibile avviare Electron:', error.message);
        shutdown(1);
    });
    electron.once('exit', code => shutdown(code || 0));

    const gameDir = process.env.SHADOWSTREAM_GAME_DIR || (
        process.env.LOCALAPPDATA
            ? path.join(process.env.LOCALAPPDATA, 'FiveM', 'FiveM.app')
            : 'C:\\ShadowStreamTest'
    );
    console.log('\nModalità reale: scansione FiveM effettiva e Windows Firewall attivo.');
    console.log(`Cartella FiveM: ${gameDir}`);
    console.log(`Log anomalie: ${path.join(backendDataDir, 'logs', 'shadowstream.log')}`);
    console.log('Il token staff viene gestito automaticamente dalla dashboard. Le regole Firewall richiedono privilegi amministrativi.');
    if (!process.env.SHADOWSTREAM_SCAN_STEAM_HEX || !process.env.SHADOWSTREAM_SCAN_SERVER_IP) {
        console.log('Le scansioni registrano le anomalie; per l’isolamento automatico configura SHADOWSTREAM_SCAN_STEAM_HEX e SHADOWSTREAM_SCAN_SERVER_IP.');
    }
}

process.once('SIGINT', () => shutdown(0));
process.once('SIGTERM', () => shutdown(0));

start().catch(error => {
    console.error(error.message);
    shutdown(1);
});
