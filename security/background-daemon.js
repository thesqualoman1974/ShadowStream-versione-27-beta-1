const { isIP } = require('net');
const config = require('./config');
const scanner = require('./services/scanner');
const firewall = require('./services/firewall');
const storage = require('./services/storage');

const SCAN_STEAM_HEX_PATTERN = /^(?:steam[:_])?([0-9a-f]{15,17})$/i;

function describeAnomaly(anomaly) {
    return `${anomaly.kind === 'cartella' ? 'Cartella anomala' : 'File anomalo'}: ${anomaly.name}`;
}

function getScanIdentity(settings) {
    const steamMatch = settings.scanSteamHex && SCAN_STEAM_HEX_PATTERN.exec(settings.scanSteamHex.trim());
    if (!steamMatch || !settings.scanServerIp || isIP(settings.scanServerIp) === 0) return null;
    return { steamHex: steamMatch[1].toLowerCase(), serverIp: settings.scanServerIp };
}

function startBackgroundDaemon(services = {}) {
    const scanService = services.scanner || scanner;
    const firewallService = services.firewall || firewall;
    const storageService = services.storage || storage;
    const settings = services.config || config;
    const status = { running: true, scanning: false, lastRunAt: null, lastError: null };
    let scanRunning = false;
    let lastAnomalyKey = null;
    let missingScanIdentityWarned = false;

    async function runOnce() {
        if (scanRunning) return;
        scanRunning = true;
        status.scanning = true;
        status.lastRunAt = new Date().toISOString();
        status.lastError = null;

        try {
            const anomaly = await scanService.scan(settings.gameDir);
            let newlyDetectedBanHex = null;
            if (anomaly) {
                const description = describeAnomaly(anomaly);
                const anomalyKey = `${anomaly.kind}:${anomaly.name}`;
                const newDetection = anomalyKey !== lastAnomalyKey;
                if (newDetection) {
                    storageService.appendAuditLog(`ANOMALIA RILEVATA - ${description}`);
                }
                lastAnomalyKey = anomalyKey;
                const identity = getScanIdentity(settings);
                if (!identity) {
                    if (!missingScanIdentityWarned) {
                        console.warn('[SCANNER] Rilevamento registrato senza isolamento automatico. Configurare SHADOWSTREAM_SCAN_STEAM_HEX e SHADOWSTREAM_SCAN_SERVER_IP per abilitarlo.');
                        missingScanIdentityWarned = true;
                    }
                } else {
                    missingScanIdentityWarned = false;
                    await firewallService.withRuleLock(identity.steamHex, () => {
                        const existingBan = storageService.loadBanState().bans[identity.steamHex];
                        if (!existingBan || existingBan.source !== 'staff') {
                            const needsUpdate = !existingBan ||
                                existingBan.detectedFile !== anomaly.name ||
                                existingBan.remoteAddress !== identity.serverIp;
                            if (needsUpdate) {
                                storageService.upsertBan(identity.steamHex, {
                                    ...existingBan,
                                    detectedFile: anomaly.name,
                                    detectedKind: anomaly.kind,
                                    steamName: existingBan?.steamName || 'Non registrato',
                                    reason: description,
                                    source: 'scan',
                                    remoteAddress: identity.serverIp,
                                    createdAt: existingBan?.createdAt || new Date().toISOString()
                                });
                                newlyDetectedBanHex = identity.steamHex;
                            }
                        }
                    });
                }
            } else {
                lastAnomalyKey = null;
            }

            const { bans } = storageService.loadBanState();
            const firewallFailures = new Set();
            for (const steamHex of Object.keys(bans)) {
                try {
                    await firewallService.withRuleLock(steamHex, async () => {
                        const currentBan = storageService.loadBanState().bans[steamHex];
                        if (!currentBan) return;
                        const restored = await firewallService.ensureRuleUnlocked(steamHex, currentBan.remoteAddress);
                        if (restored && steamHex !== newlyDetectedBanHex) {
                            storageService.appendAuditLog(`REGOLA RIPRISTINATA - Blocco attivo per steam_${steamHex}`);
                        }
                    });
                } catch (error) {
                    firewallFailures.add(steamHex);
                    console.error(`[FIREWALL WATCHDOG ERROR] steam_${steamHex}: ${error.message}`);
                    status.lastError = 'Uno o più blocchi Firewall non sono stati verificati.';
                }
            }
            if (anomaly && newlyDetectedBanHex && !firewallFailures.has(newlyDetectedBanHex)) {
                const identity = getScanIdentity(settings);
                if (identity) {
                    storageService.appendAuditLog(`BLOCCO ATTIVO - ${describeAnomaly(anomaly)} - steam_${identity.steamHex}`);
                }
            }
        } catch (error) {
            status.lastError = 'Scansione o aggiornamento dello stato non riusciti.';
            console.error('[SCANNER ERROR]', error);
        } finally {
            scanRunning = false;
            status.scanning = false;
        }
    }

    void runOnce();
    const timer = setInterval(() => { void runOnce(); }, settings.scanIntervalMs);
    timer.unref();

    return {
        getStatus: () => ({ ...status }),
        runOnce,
        stop: () => {
            clearInterval(timer);
            status.running = false;
        }
    };
}

module.exports = { startBackgroundDaemon };
