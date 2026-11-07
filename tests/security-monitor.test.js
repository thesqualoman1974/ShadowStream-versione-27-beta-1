'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSecurityMonitor } = require('../electron/security-monitor');

test('scans only the configured FiveM directory and reports findings locally', async () => {
  const gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowstream-monitor-'));
  const scannedDirectories = [];
  const logs = [];
  const statuses = [];
  try {
    const monitor = createSecurityMonitor({
      gameDir,
      intervalMs: 60_000,
      scanDirectory: async (directory) => {
        scannedDirectories.push(directory);
        return { name: 'local-only.asi', kind: 'file' };
      },
      onLog: (message) => logs.push(message),
      onStatus: (status) => statuses.push(status),
    });

    const status = await monitor.scanNow();

    assert.deepEqual(scannedDirectories, [gameDir]);
    assert.equal(status.state, 'complete');
    assert.equal(status.suspicious, true);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /Nessun dato inviato/);
    assert.doesNotMatch(logs[0], /local-only\.asi/);
    assert.equal(statuses.at(-1), status);
  } finally {
    fs.rmSync(gameDir, { recursive: true, force: true });
  }
});

test('reports a missing FiveM directory without invoking the scanner', async () => {
  const gameDir = path.join(os.tmpdir(), `shadowstream-missing-${Date.now()}`);
  let scanned = false;
  const monitor = createSecurityMonitor({
    gameDir,
    intervalMs: 60_000,
    scanDirectory: async () => {
      scanned = true;
      return null;
    },
  });

  const status = await monitor.scanNow();

  assert.equal(scanned, false);
  assert.equal(status.state, 'unavailable');
});

test('local test command does not read files or invoke the scanner', () => {
  let scanned = false;
  const logs = [];
  const monitor = createSecurityMonitor({
    gameDir: os.tmpdir(),
    intervalMs: 60_000,
    scanDirectory: async () => {
      scanned = true;
      return null;
    },
    onLog: (message) => logs.push(message),
  });

  const status = monitor.testScan();

  assert.equal(scanned, false);
  assert.equal(status.state, 'test-complete');
  assert.match(logs[0], /nessun file letto/i);
});

test('rejects invalid repeat intervals', () => {
  assert.throws(
    () => createSecurityMonitor({ intervalMs: 999 }),
    /almeno 1000 ms/,
  );
});
