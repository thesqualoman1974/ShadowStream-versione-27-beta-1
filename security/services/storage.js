const fs = require('fs');
const path = require('path');
const { isIP } = require('net');
const config = require('../config');

function formatLocalTimestamp(date = new Date()) {
    const parts = new Intl.DateTimeFormat('it-IT', {
        timeZone: 'Europe/Rome',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(date);
    const value = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
    return `${value.day}/${value.month}/${value.year}, ${value.hour}:${value.minute}:${value.second}`;
}

function loadBanState() {
    if (!fs.existsSync(config.stateFile)) return { bans: {} };

    const parsed = JSON.parse(fs.readFileSync(config.stateFile, 'utf8'));
    if (!parsed || typeof parsed.bans !== 'object' || Array.isArray(parsed.bans)) {
        throw new Error(`Formato non valido nello stato dei ban: ${config.stateFile}`);
    }
    for (const [steamHex, ban] of Object.entries(parsed.bans)) {
        if (
            !/^[0-9a-f]{15,17}$/.test(steamHex) ||
            !ban ||
            (ban.detectedFile !== null && typeof ban.detectedFile !== 'string') ||
            (ban.steamName !== undefined && typeof ban.steamName !== 'string') ||
            typeof ban.remoteAddress !== 'string' ||
            (isIP(ban.remoteAddress) === 0 && ban.remoteAddress !== '0.0.0.0/0')
        ) {
            throw new Error(`Record ban non valido nello stato: ${steamHex}`);
        }
    }
    return parsed;
}

function saveBanState(bans) {
    fs.mkdirSync(config.stateDir, { recursive: true });
    const tempFile = `${config.stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tempFile, `${JSON.stringify({ bans }, null, 2)}\n`, { encoding: 'utf8' });
    fs.renameSync(tempFile, config.stateFile);
}

function upsertBan(steamHex, ban) {
    const { bans } = loadBanState();
    const nextBans = { ...bans, [steamHex]: ban };
    saveBanState(nextBans);
    return ban;
}

function removeBan(steamHex) {
    const { bans } = loadBanState();
    const ban = bans[steamHex] || null;
    if (!ban) return null;
    const nextBans = { ...bans };
    delete nextBans[steamHex];
    saveBanState(nextBans);
    return ban;
}

function appendAuditLog(message) {
    fs.mkdirSync(config.logDir, { recursive: true });
    fs.appendFileSync(
        config.logFile,
        `[${formatLocalTimestamp()}] ${String(message).replace(/[\r\n]/g, ' ')}\n`,
        'utf8'
    );
}

function readAuditLog(limit) {
    if (!fs.existsSync(config.logFile)) return [];
    return fs.readFileSync(config.logFile, 'utf8').split(/\r?\n/).filter(Boolean).slice(-limit);
}

function readStaffToken() {
    if (!fs.existsSync(config.staffTokenFile)) return null;
    const savedToken = fs.readFileSync(config.staffTokenFile, 'utf8').trim();
    const match = /^\[[^\]]+\] ([A-Za-z0-9_-]{43})$/.exec(savedToken);
    if (!match) {
        throw new Error(`Token staff non valido in ${config.staffTokenFile}; correggi o rimuovi il file per generarne uno nuovo.`);
    }
    return match[1];
}

function writeStaffToken(token) {
    fs.mkdirSync(path.dirname(config.staffTokenFile), { recursive: true });
    fs.writeFileSync(
        config.staffTokenFile,
        `[${formatLocalTimestamp()}] ${token}\n`,
        { encoding: 'utf8', mode: 0o600, flag: 'wx' }
    );
}

module.exports = {
    appendAuditLog,
    formatLocalTimestamp,
    loadBanState,
    readAuditLog,
    readStaffToken,
    removeBan,
    saveBanState,
    upsertBan,
    writeStaffToken
};
