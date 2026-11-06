'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRelayArguments, validateDestination } = require('../electron/streaming/rtmp-relay');

test('validates RTMP and RTMPS destinations without logging or rewriting keys', () => {
  assert.deepEqual(validateDestination({
    name: 'Twitch',
    server: 'rtmps://live.twitch.tv/app/',
    key: 'live_123-secret',
  }), {
    name: 'Twitch',
    url: 'rtmps://live.twitch.tv/app/live_123-secret',
  });
});

test('rejects insecure, malformed, and credential-embedded destination servers', () => {
  for (const server of [
    'https://live.example.com/app',
    'rtmp://user:password@live.example.com/app',
    'rtmp://live.example.com/app?key=secret',
    'not a url',
  ]) {
    assert.throws(() => validateDestination({
      name: 'Test',
      server,
      key: 'stream-key',
    }));
  }
});

test('builds one copy-only tee output per platform behind a local RTMP ingest', () => {
  const args = buildRelayArguments('rtmp://127.0.0.1:1935/live/private', [
    { name: 'Twitch', server: 'rtmp://live.twitch.tv/app', key: 'twitch-key' },
    { name: 'YouTube', server: 'rtmps://a.rtmp.youtube.com/live2', key: 'youtube-key' },
  ]);
  assert.equal(args[args.indexOf('-c') + 1], 'copy');
  assert.equal(args[args.indexOf('-f') + 1], 'tee');
  assert.match(args.at(-1), /rtmp:\/\/live\.twitch\.tv\/app\/twitch-key/);
  assert.match(args.at(-1), /rtmps:\/\/a\.rtmp\.youtube\.com\/live2\/youtube-key/);
  assert.equal((args.at(-1).match(/\[f=flv:onfail=abort\]/g) || []).length, 2);
});

test('escapes tee separators contained in a stream key', () => {
  const args = buildRelayArguments('rtmp://127.0.0.1:1935/live/private', [
    { name: 'Test', server: 'rtmp://live.example.com/app', key: 'stream|key[1]' },
  ]);
  assert.match(args.at(-1), /stream\\\|key\\\[1\\\]/);
});

test('encodes TikTok as a centered vertical NVENC output alongside landscape copies', () => {
  const args = buildRelayArguments('rtmp://127.0.0.1:1935/live/private', [
    { platform: 'twitch', name: 'Twitch', server: 'rtmp://live.twitch.tv/app', key: 'twitch-key' },
    { platform: 'tiktok', name: 'TikTok', server: 'rtmp://push.example.com/live', key: 'tiktok-key' },
  ]);
  const filterIndex = args.indexOf('-vf');
  assert.ok(filterIndex > args.indexOf('-f'));
  assert.equal(args[filterIndex + 1], 'crop=ih*9/16:ih:(iw-ih*9/16)*0.5000:0,scale=1080:1920');
  assert.equal(args[args.indexOf('-c:v', filterIndex) + 1], 'h264_nvenc');
  assert.ok(args.includes('rtmp://push.example.com/live/tiktok-key'));
  assert.match(args[args.indexOf('-f', filterIndex) + 1], /flv/);
});

test('supports TikTok as the only vertical destination without a tee output', () => {
  const args = buildRelayArguments('rtmp://127.0.0.1:1935/live/private', [
    { platform: 'tiktok', name: 'TikTok', server: 'rtmp://push.example.com/live', key: 'tiktok-key' },
  ]);
  assert.equal(args.includes('tee'), false);
  assert.ok(args.includes('h264_nvenc'));
});

test('requires a loopback ingest and at least one destination', () => {
  assert.throws(() => buildRelayArguments('rtmp://0.0.0.0:1935/live/key', [
    { name: 'Test', server: 'rtmp://live.example.com/app', key: 'key' },
  ]));
  assert.throws(() => buildRelayArguments('rtmp://127.0.0.1:1935/live/key', []));
});
