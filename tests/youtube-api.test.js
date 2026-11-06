'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getYoutubeStreamIngest, listYoutubeStreams } = require('../electron/streaming/youtube-api');

test('lists YouTube streams without exposing their ingestion keys', async () => {
  let requestedUrl;
  const streams = await listYoutubeStreams('access-token', async (url) => {
    requestedUrl = new URL(url);
    return {
      ok: true,
      json: async () => ({
        items: [
          { id: 'stream-1', snippet: { title: 'Main stream' }, status: { streamStatus: 'ready' } },
          { id: 'stream-2', snippet: { title: 'Missing status' } },
          { id: 8, snippet: { title: 'Invalid ID' } },
        ],
      }),
    };
  });
  assert.equal(requestedUrl.searchParams.get('mine'), 'true');
  assert.equal(requestedUrl.searchParams.get('part'), 'id,snippet,status');
  assert.deepEqual(streams, [
    { id: 'stream-1', title: 'Main stream', status: 'ready' },
    { id: 'stream-2', title: 'Missing status', status: 'unknown' },
  ]);
});

test('returns the selected YouTube RTMP endpoint and stream key only to the caller', async () => {
  const ingest = await getYoutubeStreamIngest('access-token', 'stream-1', async (url) => {
    assert.equal(new URL(url).searchParams.get('id'), 'stream-1');
    return {
      ok: true,
      json: async () => ({
        items: [{
          id: 'stream-1',
          cdn: {
            ingestionInfo: {
              ingestionAddress: 'rtmps://a.rtmps.youtube.com/live2',
              streamName: 'private-key',
            },
          },
        }],
      }),
    };
  });
  assert.deepEqual(ingest, {
    server: 'rtmps://a.rtmps.youtube.com/live2',
    key: 'private-key',
  });
});
