'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getLocalBotUrl, notifyDiscordEvent } = require('../client/discord-notifier');

const token = 'a'.repeat(43);

test('limits the bot integration to local HTTP endpoints', () => {
    assert.equal(getLocalBotUrl(), 'http://127.0.0.1:3001');
    assert.equal(getLocalBotUrl('http://localhost:3001'), 'http://localhost:3001');
    assert.throws(() => getLocalBotUrl('https://localhost:3001'), /solo al bot locale/);
    assert.throws(() => getLocalBotUrl('http://example.com:3001'), /solo al bot locale/);
    assert.throws(() => getLocalBotUrl('http://localhost:3001/path'), /solo al bot locale/);
});

test('sends authenticated moderation events to the local bot', async () => {
    let requestOptions;
    const result = await notifyDiscordEvent({
        action: 'ban',
        steamHex: '110000100000001',
        steamName: 'Player',
        serverIp: '203.0.113.10',
        reason: 'Manual review'
    }, {
        token,
        fetchImpl: async (url, options) => {
            requestOptions = { url, options };
            return {
                ok: true,
                json: async () => ({ success: true, sent: ['ban-unban', 'resoconto-player'] })
            };
        }
    });

    assert.equal(result.success, true);
    assert.equal(requestOptions.url, 'http://127.0.0.1:3001/api/shadowstream/events');
    assert.equal(requestOptions.options.headers.Authorization, `Bearer ${token}`);
    assert.equal(JSON.parse(requestOptions.options.body).action, 'ban');
});

test('reports bot errors and partial channel delivery', async () => {
    const result = await notifyDiscordEvent({ action: 'unban' }, {
        token,
        fetchImpl: async () => ({
            ok: false,
            json: async () => ({
                success: false,
                error: 'Notifica parziale.',
                sent: ['ban-unban'],
                failed: ['resoconto-player']
            })
        })
    });

    assert.deepEqual(result, {
        success: false,
        error: 'Notifica parziale.',
        sent: ['ban-unban'],
        failed: ['resoconto-player']
    });
});

test('does not send when the local staff token is unavailable', async () => {
    let requestSent = false;
    const result = await notifyDiscordEvent({}, {
        token: null,
        fetchImpl: async () => {
            requestSent = true;
        }
    });

    assert.equal(requestSent, false);
    assert.equal(result.success, false);
});
