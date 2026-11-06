'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDestinationStore } = require('../electron/streaming/destination-store');

function makeStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowstream-live-'));
  const filePath = path.join(directory, 'streaming-settings.json');
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value.split('').reverse().join(''), 'utf8'),
    decryptString: (value) => value.toString('utf8').split('').reverse().join(''),
  };
  return {
    directory,
    filePath,
    store: createDestinationStore({ filePath, safeStorage }),
  };
}

test('stores stream keys encrypted and only returns safe destination metadata', (t) => {
  const { directory, filePath, store } = makeStore();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  store.saveDestinations([{
    platform: 'twitch',
    server: 'rtmps://live.twitch.tv/app/',
    key: 'secret-stream-key',
  }]);

  const persisted = fs.readFileSync(filePath, 'utf8');
  assert.equal(persisted.includes('secret-stream-key'), false);
  assert.equal(persisted.includes('encryptedKey'), true);
  assert.deepEqual(store.getDestinations(), [{
    platform: 'twitch',
    name: 'Twitch',
    server: 'rtmps://live.twitch.tv/app',
    configured: true,
  }]);
  assert.deepEqual(store.getConfiguredDestinations(), [{
    platform: 'twitch',
    name: 'Twitch',
    server: 'rtmps://live.twitch.tv/app',
    key: 'secret-stream-key',
  }]);
});

test('preserves an existing encrypted key when only the server changes', (t) => {
  const { directory, store } = makeStore();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  store.saveDestinations([{ platform: 'kick', server: 'rtmp://one.example/app', key: 'key-1' }]);
  store.saveDestinations([{ platform: 'kick', server: 'rtmp://two.example/app', key: '' }]);
  assert.equal(store.getConfiguredDestinations()[0].key, 'key-1');
  assert.equal(store.getDestinations()[0].server, 'rtmp://two.example/app');
});

test('rejects duplicate platforms, unsupported platforms, and missing keys', (t) => {
  const { directory, store } = makeStore();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  assert.throws(() => store.saveDestinations([
    { platform: 'twitch', server: 'rtmp://one.example/app', key: 'one' },
    { platform: 'twitch', server: 'rtmp://two.example/app', key: 'two' },
  ]));
  assert.throws(() => store.saveDestinations([
    { platform: 'other', server: 'rtmp://one.example/app', key: 'one' },
  ]));
  assert.throws(() => store.saveDestinations([
    { platform: 'youtube', server: 'rtmp://one.example/app', key: '' },
  ]));
});

test('stores YouTube OAuth tokens encrypted and exposes no credential values', (t) => {
  const { directory, filePath, store } = makeStore();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const expiresAt = Date.now() + 3600000;
  store.saveYoutubeCredentials({
    clientId: 'public-client.apps.googleusercontent.com',
    accessToken: 'access-token-secret',
    refreshToken: 'refresh-token-secret',
    expiresAt,
  });

  const persisted = fs.readFileSync(filePath, 'utf8');
  assert.equal(persisted.includes('access-token-secret'), false);
  assert.equal(persisted.includes('refresh-token-secret'), false);
  assert.equal(store.getYoutubeClientId(), 'public-client.apps.googleusercontent.com');
  assert.deepEqual(store.getYoutubeCredentials(), {
    accessToken: 'access-token-secret',
    refreshToken: 'refresh-token-secret',
    expiresAt,
  });

  store.saveVerticalCropX(0.75);
  store.saveFfmpegPath('D:\\ffmpeg\\bin\\ffmpeg.exe');
  store.saveDestinations([{
    platform: 'youtube',
    server: 'rtmps://a.rtmps.youtube.com/live2',
    key: 'stream-key',
  }]);
  assert.equal(store.getYoutubeClientId(), 'public-client.apps.googleusercontent.com');
  assert.equal(store.getYoutubeCredentials().refreshToken, 'refresh-token-secret');
  assert.equal(store.getVerticalCropX(), 0.75);
  assert.equal(store.getFfmpegPath(), 'D:\\ffmpeg\\bin\\ffmpeg.exe');
});
