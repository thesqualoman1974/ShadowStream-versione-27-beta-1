'use strict';

const fs = require('fs');
const path = require('path');
const { scan } = require('../security/services/scanner');

function createSecurityMonitor({
  gameDir = process.env.SHADOWSTREAM_GAME_DIR || path.join(
    process.env.LOCALAPPDATA || '',
    'FiveM',
    'FiveM.app',
  ),
  intervalMs = Number(process.env.SHADOWSTREAM_SCAN_INTERVAL_MS || 30 * 60 * 1000),
  scanDirectory = scan,
  onLog = () => {},
  onStatus = () => {},
} = {}) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000) {
    throw new Error('SHADOWSTREAM_SCAN_INTERVAL_MS deve essere un numero intero di almeno 1000 ms.');
  }

  let running = false;
  let timer = null;
  let status = {
    state: 'idle',
    checkedAt: null,
    suspicious: false,
  };

  async function scanNow() {
    if (running) return status;
    running = true;
    status = { ...status, state: 'scanning' };
    onStatus(status);

    try {
      if (!fs.existsSync(gameDir)) {
        status = {
          state: 'unavailable',
          checkedAt: new Date().toISOString(),
          suspicious: false,
        };
        onLog('Cartella FiveM non trovata; scansione non eseguita.');
      } else {
        const anomaly = await scanDirectory(gameDir);
        status = {
          state: 'complete',
          checkedAt: new Date().toISOString(),
          suspicious: Boolean(anomaly),
        };
        onLog(anomaly
          ? 'Rilevamento locale nella cartella FiveM. Nessun dato inviato e nessun ban eseguito.'
          : 'Scansione locale FiveM completata. Nessun elemento sospetto rilevato.');
      }
    } catch (error) {
      status = {
        state: 'error',
        checkedAt: new Date().toISOString(),
        suspicious: false,
        message: error.message,
      };
      onLog(`Scansione locale non riuscita: ${error.message}`);
    } finally {
      running = false;
      onStatus(status);
    }

    return status;
  }

  function testScan() {
    status = {
      state: 'test-complete',
      checkedAt: new Date().toISOString(),
      suspicious: false,
    };
    onLog('Test scanner completato. Nessun file letto, nessun dato inviato e nessun ban eseguito.');
    onStatus(status);
    return status;
  }

  function start() {
    if (timer) return;
    void scanNow();
    timer = setInterval(() => { void scanNow(); }, intervalMs);
    timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    getStatus: () => ({ ...status }),
    scanNow,
    start,
    stop,
    testScan,
  };
}

module.exports = { createSecurityMonitor };
