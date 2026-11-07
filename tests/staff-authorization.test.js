'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getStaffToken } = require('../client/staff-authorization');

test('uses the configured backend token without exposing it to the UI', () => {
    const token = 'environment-token-123456789012345678901234';
    assert.equal(getStaffToken({ environment: { SHADOWSTREAM_STAFF_TOKEN: token } }), token);
});

test('loads the generated backend token from the configured data directory', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowstream-auth-'));
    const token = 'A'.repeat(43);
    try {
        const logDir = path.join(dataDir, 'logs');
        fs.mkdirSync(logDir);
        fs.writeFileSync(path.join(logDir, 'staff-token.log'), `[06/11/2026, 18:00:00] ${token}\n`);
        assert.equal(getStaffToken({ environment: {}, dataDir }), token);
    } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});

test('reports missing and malformed backend credentials distinctly', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowstream-auth-'));
    try {
        assert.equal(getStaffToken({ environment: {}, dataDir }), null);
        const logDir = path.join(dataDir, 'logs');
        fs.mkdirSync(logDir);
        fs.writeFileSync(path.join(logDir, 'staff-token.log'), 'invalid token file\n');
        assert.throws(() => getStaffToken({ environment: {}, dataDir }), /Token staff non valido/);
    } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});
