const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { getStaffToken } = require('./staff-authorization');
const { notifyDiscordEvent } = require('./discord-notifier');
const { getUpdateErrorMessage } = require('./update-errors');

const electronDataDir = path.join(app.getPath('appData'), 'SentinelCore');
fs.mkdirSync(electronDataDir, { recursive: true });
app.setPath('userData', electronDataDir);
app.setPath('sessionData', path.join(electronDataDir, 'session'));

let backendOrigin = `http://127.0.0.1:${process.env.SHADOWSTREAM_SECURITY_PORT || 3000}`;
let banUrl = `${backendOrigin}/api/ban`;
let bansUrl = `${backendOrigin}/api/bans`;
let unbanUrl = `${backendOrigin}/api/unban`;
let statusUrl = `${backendOrigin}/api/status`;
let logsUrl = `${backendOrigin}/api/logs?limit=100`;
let securityBackend = null;
let backendShutdownStarted = false;
let mainWindow = null;
let updateCheckPromise = null;
let updateDownloaded = false;
let updateStatus = { state: 'idle', version: app.getVersion() };

function setBackendPort(port) {
    backendOrigin = `http://127.0.0.1:${port}`;
    banUrl = `${backendOrigin}/api/ban`;
    bansUrl = `${backendOrigin}/api/bans`;
    unbanUrl = `${backendOrigin}/api/unban`;
    statusUrl = `${backendOrigin}/api/status`;
    logsUrl = `${backendOrigin}/api/logs?limit=100`;
}

function sendUpdateStatus(status) {
    updateStatus = { currentVersion: app.getVersion(), ...status };
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('updates:status', updateStatus);
    }
}

function configureAutoUpdater() {
    if (!app.isPackaged) {
        sendUpdateStatus({ state: 'unsupported', version: app.getVersion() });
        return;
    }

    autoUpdater.allowPrerelease = true;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;

    autoUpdater.on('checking-for-update', () => {
        sendUpdateStatus({ state: 'checking', version: app.getVersion() });
    });
    autoUpdater.on('update-available', info => {
        sendUpdateStatus({ state: 'available', version: info.version });
    });
    autoUpdater.on('update-not-available', () => {
        sendUpdateStatus({ state: 'up-to-date', version: app.getVersion() });
    });
    autoUpdater.on('download-progress', progress => {
        sendUpdateStatus({
            state: 'downloading',
            version: updateStatus.version,
            percent: Math.round(progress.percent)
        });
    });
    autoUpdater.on('update-downloaded', info => {
        updateDownloaded = true;
        sendUpdateStatus({ state: 'downloaded', version: info.version });
    });
    autoUpdater.on('error', error => {
        const statusCode = Number(error?.statusCode ?? error?.response?.statusCode ?? error?.response?.status);
        console.error('Aggiornamento Sentinel Core non riuscito.', Number.isInteger(statusCode) ? `HTTP ${statusCode}` : 'Errore di rete o feed.');
        sendUpdateStatus({ state: 'error', message: getUpdateErrorMessage(error) });
    });
}

function checkForUpdates() {
    if (!app.isPackaged) {
        sendUpdateStatus({ state: 'unsupported', version: app.getVersion() });
        return Promise.resolve(false);
    }
    if (updateCheckPromise) return updateCheckPromise;

    updateCheckPromise = autoUpdater.checkForUpdates()
        .then(() => true)
        .catch(error => {
            const statusCode = Number(error?.statusCode ?? error?.response?.statusCode ?? error?.response?.status);
            console.error('Controllo aggiornamenti Sentinel Core non riuscito.', Number.isInteger(statusCode) ? `HTTP ${statusCode}` : 'Errore di rete o feed.');
            sendUpdateStatus({ state: 'error', message: getUpdateErrorMessage(error) });
            return false;
        })
        .finally(() => {
            updateCheckPromise = null;
        });
    return updateCheckPromise;
}

async function installDownloadedUpdate() {
    if (!updateDownloaded) return false;

    sendUpdateStatus({ state: 'installing', version: updateStatus.version });
    if (securityBackend) {
        await securityBackend.shutdown();
        securityBackend = null;
        backendShutdownStarted = true;
    }
    autoUpdater.quitAndInstall(true, true);
    return true;
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

async function startBundledBackend() {
    if (!app.isPackaged) return;

    const port = await findAvailablePort();
    const backendDataDir = path.join(app.getPath('appData'), 'ShadowStream', 'security');
    fs.mkdirSync(backendDataDir, { recursive: true });
    process.env.PORT = String(port);
    process.env.SHADOWSTREAM_DATA_DIR = backendDataDir;
    process.env.SHADOWSTREAM_TEST_MODE = '0';
    setBackendPort(port);

    const backendEntryPoint = path.join(process.resourcesPath, 'security', 'index.js');
    const { start } = require(backendEntryPoint);
    securityBackend = await start();
}

function staffAuthorization() {
    const token = getStaffToken();
    return token ? { Authorization: `Bearer ${token}` } : null;
}

async function readBackendResponse(response) {
    let result;
    try {
        result = await response.json();
    } catch {
        return { success: false, error: 'Il backend ha restituito una risposta non valida.' };
    }
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
        return { success: false, error: 'Il backend ha restituito una risposta non valida.' };
    }

    if (!response.ok) {
        return { ...result, success: false };
    }
    return result;
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1100,
        height: 820,
        minWidth: 760,
        minHeight: 640,
        title: `Sentinel Core ${app.getVersion()} - Security & Integrity Suite`,
        backgroundColor: '#111111',
        icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    mainWindow.webContents.on('context-menu', (event, params) => {
        if (!params.isEditable && !params.selectionText) return;

        const editMenu = Menu.buildFromTemplate([
            { role: 'cut', enabled: params.editFlags.canCut },
            { role: 'copy', enabled: params.editFlags.canCopy },
            { role: 'paste', enabled: params.editFlags.canPaste },
            { type: 'separator' },
            { role: 'selectAll', enabled: params.editFlags.canSelectAll }
        ]);
        editMenu.popup({ window: mainWindow });
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
    mainWindow.loadFile(path.join(__dirname, 'index.html'));
    mainWindow.webContents.once('did-finish-load', () => {
        void checkForUpdates();
    });
}

app.whenReady().then(async () => {
    configureAutoUpdater();
    try {
        await startBundledBackend();
    } catch (error) {
        console.error('Avvio del backend Sentinel Core non riuscito:', error);
        await dialog.showMessageBox({
            type: 'error',
            title: 'Sentinel Core',
            message: 'Impossibile avviare il backend di sicurezza.',
            detail: error.message
        });
        app.quit();
        return;
    }

    Menu.setApplicationMenu(Menu.buildFromTemplate([
        {
            label: 'Modifica',
            submenu: [
                { role: 'undo' },
                { role: 'redo' },
                { type: 'separator' },
                { role: 'cut' },
                { role: 'copy' },
                { role: 'paste' },
                { type: 'separator' },
                { role: 'selectAll' }
            ]
        }
    ]));
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', event => {
    if (!securityBackend || backendShutdownStarted) return;
    event.preventDefault();
    backendShutdownStarted = true;
    securityBackend.shutdown()
        .catch(error => console.error('Arresto del backend Sentinel Core non riuscito:', error))
        .finally(() => app.quit());
});

ipcMain.handle('updates:get-status', () => updateStatus);
ipcMain.handle('updates:check', () => checkForUpdates());
ipcMain.handle('updates:install', () => installDownloadedUpdate());

ipcMain.handle('get-security-status', async () => {
    try {
        const response = await fetch(statusUrl);
        return await readBackendResponse(response);
    } catch (err) {
        return { success: false, error: 'Impossibile verificare lo stato del backend di sicurezza.' };
    }
});

ipcMain.handle('get-security-logs', async () => {
    try {
        const response = await fetch(logsUrl);
        return await readBackendResponse(response);
    } catch (err) {
        return { success: false, error: 'Impossibile leggere i log del backend.' };
    }
});

ipcMain.handle('get-active-bans', async () => {
    try {
        const authorization = staffAuthorization();
        if (!authorization) {
            return { success: false, error: 'Token locale non disponibile. Avvia il backend Sentinel Core.' };
        }
        const response = await fetch(bansUrl, {
            headers: authorization
        });
        return await readBackendResponse(response);
    } catch (error) {
        console.error('Errore durante il caricamento dei ban:', error);
        return { success: false, error: 'Impossibile caricare i ban attivi dal backend.' };
    }
});

ipcMain.handle('run-ban', async (event, request = {}) => {
    const { steamHex, steamName, serverIp, reason } = request || {};
    if (
        typeof steamHex !== 'string' ||
        typeof steamName !== 'string' ||
        typeof serverIp !== 'string' ||
        (reason !== undefined && typeof reason !== 'string')
    ) {
        return { success: false, error: 'Nome Steam, Steam Hex e IP server sono richiesti.' };
    }

    try {
        const authorization = staffAuthorization();
        if (!authorization) {
            return { success: false, error: 'Token locale non disponibile. Avvia il backend Sentinel Core.' };
        }
        const response = await fetch(banUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...authorization
            },
            body: JSON.stringify({ steamHex, steamName, serverIp, reason })
        });
        const result = await readBackendResponse(response);
        if (result.success && result.banned) {
            result.discordNotification = await notifyDiscordEvent({
                action: 'ban',
                steamHex: result.steamHex || steamHex,
                steamName: result.steamName || steamName,
                serverIp,
                reason: result.reason || reason || 'Ban manuale staff',
                occurredAt: new Date().toISOString()
            }, { token: getStaffToken() });
        }
        return result;
    } catch (error) {
        console.error('Errore durante la richiesta di ban:', error);
        return { success: false, error: 'Impossibile connettersi al backend per il ban.' };
    }
});

ipcMain.handle('run-unban', async (event, request = {}) => {
    const { steamHex, steamName, serverIp, reason } = request || {};
    if (typeof steamHex !== 'string') {
        return { success: false, error: 'Steam Hex non valido.' };
    }

    try {
        const authorization = staffAuthorization();
        if (!authorization) {
            return { success: false, error: 'Token locale non disponibile. Avvia il backend Sentinel Core.' };
        }
        const response = await fetch(unbanUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...authorization
            },
            body: JSON.stringify({ steamHex, reason })
        });
        const result = await readBackendResponse(response);
        if (result.success) {
            result.discordNotification = await notifyDiscordEvent({
                action: 'unban',
                steamHex: result.steamHex || steamHex,
                steamName: result.steamName || steamName || 'Non registrato',
                serverIp: result.serverIp || serverIp || '',
                reason: result.reason || reason || 'Sblocco manuale staff',
                occurredAt: new Date().toISOString()
            }, { token: getStaffToken() });
        }
        return result;
    } catch (error) {
        console.error('Errore durante la richiesta di sblocco:', error);
        return { success: false, error: 'Impossibile connettersi al backend per lo sblocco.' };
    }
});