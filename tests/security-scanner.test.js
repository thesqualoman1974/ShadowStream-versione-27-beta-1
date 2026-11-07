'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scan } = require('../security/services/scanner');

test('does not flag normal FiveM DLL files', () => {
    const gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowstream-scanner-'));
    try {
        fs.writeFileSync(path.join(gameDir, 'adhesive.dll'), '');
        fs.writeFileSync(path.join(gameDir, 'citizen-game-main.dll'), '');
        assert.equal(scan(gameDir), null);
    } finally {
        fs.rmSync(gameDir, { recursive: true, force: true });
    }
});

test('detects ASI files and suspicious names', () => {
    const gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowstream-scanner-'));
    try {
        fs.writeFileSync(path.join(gameDir, 'injector.asi'), '');
        assert.deepEqual(scan(gameDir), { name: 'injector.asi', kind: 'file' });
        fs.unlinkSync(path.join(gameDir, 'injector.asi'));

        fs.writeFileSync(path.join(gameDir, 'modmenu.dll'), '');
        assert.deepEqual(scan(gameDir), { name: 'modmenu.dll', kind: 'file' });
    } finally {
        fs.rmSync(gameDir, { recursive: true, force: true });
    }
});
