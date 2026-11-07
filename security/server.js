const express = require('express');
const { isIP } = require('net');
const { randomBytes, timingSafeEqual } = require('crypto');
const config = require('./config');
const firewall = require('./services/firewall');
const storage = require('./services/storage');

const app = express();
app.use(express.json({ limit: '16kb' }));

function initializeStaffToken() {
    if (config.staffToken) {
        if (config.staffToken.length < 32) {
            throw new Error('SHADOWSTREAM_STAFF_TOKEN deve contenere almeno 32 caratteri.');
        }
        console.log('[STAFF TOKEN] Uso il token configurato nell’ambiente. Non viene scritto nei log.');
        return config.staffToken;
    }

    const savedToken = storage.readStaffToken();
    if (savedToken) {
        console.log(`[STAFF TOKEN] Token locale recuperato da ${config.staffTokenFile}.`);
        return savedToken;
    }

    const generatedToken = randomBytes(32).toString('base64url');
    storage.writeStaffToken(generatedToken);
    console.log(`[STAFF TOKEN] Token locale generato e salvato in ${config.staffTokenFile}.`);
    return generatedToken;
}

const staffToken = initializeStaffToken();
let getDaemonStatus = () => ({
    running: false,
    scanning: false,
    lastRunAt: null,
    lastError: 'Daemon non avviato.'
});

function normalizeSteamHex(value) {
    if (typeof value !== 'string') return null;
    const match = /^(?:steam[:_])?([0-9a-f]{15,17})$/i.exec(value.trim());
    return match ? match[1].toLowerCase() : null;
}

function normalizeSteamName(value, { required = false } = {}) {
    if (typeof value !== 'string') return required ? null : 'Non registrato';
    const normalized = value.trim().replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ');
    if (!normalized && !required) return 'Non registrato';
    if (!normalized || normalized.length > 64 || /[\u0000-\u001f\u007f]/.test(normalized)) return null;
    return normalized;
}

function hasValidStaffToken(request) {
    const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.get('authorization') || '');
    if (!match) return false;
    const provided = Buffer.from(match[1], 'utf8');
    const expected = Buffer.from(staffToken, 'utf8');
    return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function sendBanStatus(res, steamHex, ban) {
    return res.json({
        success: true,
        banned: true,
        steamHex,
        steamName: ban.steamName || 'Non registrato',
        detectedFile: ban.detectedFile,
        detectedKind: ban.detectedKind || 'file',
        reason: ban.reason || '',
        message: 'Integrità compromessa. Il blocco resta attivo fino alla revisione staff.'
    });
}

function firewallErrorMessage(error) {
    const details = `${error.message || ''}\n${error.stderr || ''}`;
    if (/accesso negato|access denied|system error 5|permissiondenied/i.test(details)) {
        return 'Windows ha negato l’accesso al Firewall. Chiudi Sentinel Core e conferma la richiesta di privilegi amministrativi per applicare il ban.';
    }
    return 'Impossibile salvare o applicare il blocco Firewall. Controlla il registro del backend per i dettagli.';
}

app.get('/api/status', (req, res) => {
    res.json({ success: true, daemon: getDaemonStatus() });
});

app.post('/api/ban', async (req, res) => {
    if (!hasValidStaffToken(req)) {
        return res.status(403).json({ success: false, error: 'Autorizzazione staff non valida o non configurata.' });
    }

    const { steamHex: inputHex, steamName: inputName, serverIp, reason: inputReason } = req.body || {};
    const steamHex = normalizeSteamHex(inputHex);
    if (!steamHex) return res.status(400).json({ success: false, error: 'Steam Hex non valido.' });

    const steamName = normalizeSteamName(inputName, { required: true });
    if (!steamName) {
        return res.status(400).json({ success: false, error: 'Inserisci un nome Steam valido (massimo 64 caratteri).' });
    }
    if (typeof serverIp !== 'string' || isIP(serverIp) === 0) {
        return res.status(400).json({ success: false, error: 'Inserisci un indirizzo IP valido del server da isolare.' });
    }
    if (inputReason !== undefined && (typeof inputReason !== 'string' || inputReason.length > 200)) {
        return res.status(400).json({ success: false, error: 'La motivazione deve contenere al massimo 200 caratteri.' });
    }

    const reason = (inputReason || '').trim().replace(/[\r\n]/g, ' ') || 'Ban manuale staff';
    const ban = {
        detectedFile: null,
        detectedKind: null,
        steamName,
        reason,
        source: 'staff',
        remoteAddress: serverIp,
        createdAt: new Date().toISOString()
    };

    try {
        await firewall.withRuleLock(steamHex, async () => {
            storage.upsertBan(steamHex, ban);
            await firewall.ensureRuleUnlocked(steamHex, serverIp);
        });
        storage.appendAuditLog(`BAN STAFF - ${steamName} (steam_${steamHex}) - IP: ${serverIp} - Motivo: ${reason}`);
    } catch (error) {
        console.error(`[BAN ERROR] ${error.message}`);
        return res.status(500).json({ success: false, banned: true, error: firewallErrorMessage(error) });
    }
    return sendBanStatus(res, steamHex, ban);
});

app.post('/api/unban', async (req, res) => {
    if (!hasValidStaffToken(req)) {
        return res.status(403).json({ success: false, error: 'Autorizzazione staff non valida o non configurata.' });
    }

    const steamHex = normalizeSteamHex(req.body?.steamHex);
    if (!steamHex) return res.status(400).json({ success: false, error: 'Steam Hex non valido.' });
    const inputReason = req.body?.reason;
    if (inputReason !== undefined && (typeof inputReason !== 'string' || inputReason.length > 200)) {
        return res.status(400).json({ success: false, error: 'La motivazione deve contenere al massimo 200 caratteri.' });
    }
    const reason = (inputReason || '').trim().replace(/[\r\n]/g, ' ') || 'Sblocco manuale staff';

    try {
        let ban;
        await firewall.withRuleLock(steamHex, async () => {
            await firewall.removeRuleUnlocked(steamHex);
            ban = storage.removeBan(steamHex);
        });
        const steamName = ban?.steamName || 'Nome non registrato';
        storage.appendAuditLog(`SBLOCCO STAFF - ${steamName} (steam_${steamHex}) - Motivo: ${reason}`);
        return res.json({
            success: true,
            steamHex,
            steamName,
            serverIp: ban?.remoteAddress || null,
            reason,
            message: `Utente steam_${steamHex} sbloccato con successo.`
        });
    } catch (error) {
        console.error(`[UNBAN ERROR] ${error.message}`);
        return res.status(500).json({ success: false, error: 'Errore nella rimozione o registrazione dello sblocco.' });
    }
});

app.get('/api/bans', (req, res) => {
    if (!hasValidStaffToken(req)) {
        return res.status(403).json({ success: false, error: 'Token staff non valido.' });
    }

    try {
        const { bans } = storage.loadBanState();
        const entries = Object.entries(bans)
            .map(([steamHex, ban]) => ({
                steamHex,
                steamName: ban.steamName || 'Non registrato',
                serverIp: ban.remoteAddress,
                reason: ban.reason || (ban.detectedFile ? `Rilevamento: ${ban.detectedFile}` : 'Ban staff'),
                source: ban.source || 'scan',
                createdAt: ban.createdAt || null
            }))
            .sort((left, right) => (right.createdAt || '').localeCompare(left.createdAt || ''));
        return res.json({ success: true, entries });
    } catch (error) {
        console.error('Errore nella lettura dello stato dei ban:', error);
        return res.status(500).json({ success: false, error: 'Impossibile leggere lo stato dei ban.' });
    }
});

app.get('/api/logs', (req, res) => {
    const limit = Number(req.query.limit ?? 100);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        return res.status(400).json({ success: false, error: 'Il limite dei log deve essere tra 1 e 200.' });
    }
    try {
        return res.json({ success: true, entries: storage.readAuditLog(limit) });
    } catch (error) {
        console.error('Errore nella lettura del log locale:', error);
        return res.status(500).json({ success: false, error: 'Impossibile leggere il log locale.' });
    }
});

app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === 'entity.parse.failed') {
        return res.status(400).json({ success: false, error: 'JSON non valido.' });
    }
    if (error.type === 'entity.too.large') {
        return res.status(413).json({ success: false, error: 'Richiesta troppo grande.' });
    }
    console.error('Errore HTTP non gestito:', error);
    return res.status(500).json({ success: false, error: 'Errore interno del backend.' });
});

function setDaemonStatusProvider(provider) {
    if (typeof provider !== 'function') throw new TypeError('Il provider dello stato daemon deve essere una funzione.');
    getDaemonStatus = provider;
}

module.exports = { app, setDaemonStatusProvider };
