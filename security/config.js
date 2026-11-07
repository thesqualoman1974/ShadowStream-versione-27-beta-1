const path = require('path');
const { isIP } = require('net');

const DATA_DIR = process.env.SHADOWSTREAM_DATA_DIR || __dirname;
const scanIntervalMs = Number(process.env.SHADOWSTREAM_SCAN_INTERVAL_MS || 30 * 60 * 1000);
const port = Number(process.env.PORT || 3000);

if (!Number.isSafeInteger(scanIntervalMs) || scanIntervalMs < 1_000) {
    throw new Error('SHADOWSTREAM_SCAN_INTERVAL_MS deve essere un numero intero di almeno 1000 ms.');
}
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT deve essere un numero compreso tra 1 e 65535.');
}
const scanSteamHex = process.env.SHADOWSTREAM_SCAN_STEAM_HEX || null;
const scanServerIp = process.env.SHADOWSTREAM_SCAN_SERVER_IP || null;
if ((scanSteamHex || scanServerIp) && (
    !scanSteamHex ||
    !/^(?:steam[:_])?[0-9a-f]{15,17}$/i.test(scanSteamHex.trim()) ||
    !scanServerIp ||
    isIP(scanServerIp) === 0
)) {
    throw new Error('Configurare insieme SHADOWSTREAM_SCAN_STEAM_HEX e SHADOWSTREAM_SCAN_SERVER_IP con valori validi.');
}

module.exports = Object.freeze({
    port,
    scanIntervalMs,
    gameDir: process.env.SHADOWSTREAM_GAME_DIR || (
        process.env.LOCALAPPDATA
            ? path.join(process.env.LOCALAPPDATA, 'FiveM', 'FiveM.app')
            : 'C:\\ShadowStreamTest'
    ),
    dataDir: DATA_DIR,
    logDir: path.join(DATA_DIR, 'logs'),
    logFile: path.join(DATA_DIR, 'logs', 'shadowstream.log'),
    staffTokenFile: path.join(DATA_DIR, 'logs', 'staff-token.log'),
    stateDir: path.join(DATA_DIR, 'data'),
    stateFile: path.join(DATA_DIR, 'data', 'active-bans.json'),
    staffToken: process.env.SHADOWSTREAM_STAFF_TOKEN || null,
    testMode: process.env.SHADOWSTREAM_TEST_MODE === '1',
    scanSteamHex,
    scanServerIp
});
