'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const ObsEngine = require('../electron/obs-engine');

function createEngine() {
  const engine = new ObsEngine({
    userDataPath: path.join(os.tmpdir(), 'shadowstream-obs-stream-test'),
    clipsPath: os.tmpdir(),
    log: () => {},
  });
  let outputActive = false;
  const requests = [];
  engine.request = async (type, data) => {
    requests.push({ type, data });
    if (type === 'GetStreamStatus') return { outputActive };
    if (type === 'StartStream') outputActive = true;
    if (type === 'StopStream') outputActive = false;
    return {};
  };
  engine.waitForOutputState = async (_type, expected) => {
    assert.equal(outputActive, expected);
  };
  return { engine, requests };
}

test('configures OBS to publish one stream into the local relay and stops cleanly', async () => {
  const { engine, requests } = createEngine();
  const statuses = [];
  engine.on('status', () => statuses.push(engine.streaming));

  await engine.startStream({ server: 'rtmp://127.0.0.1:1935/live', key: 'local-key' });
  assert.equal(engine.streaming, true);
  assert.deepEqual(requests[1], {
    type: 'SetStreamServiceSettings',
    data: {
      streamServiceType: 'rtmp_custom',
      streamServiceSettings: {
        server: 'rtmp://127.0.0.1:1935/live',
        key: 'local-key',
        use_auth: false,
      },
      save: false,
    },
  });
  assert.equal(requests[2].type, 'StartStream');

  await engine.stopStream();
  assert.equal(engine.streaming, false);
  assert.equal(requests.at(-1).type, 'StopStream');
  assert.deepEqual(statuses, [true, false]);
});

test('does not replace an already active OBS stream', async () => {
  const { engine, requests } = createEngine();
  engine.request = async (type) => {
    requests.push({ type });
    if (type === 'GetStreamStatus') return { outputActive: true };
    return {};
  };

  await assert.rejects(() => engine.startStream({
    server: 'rtmp://127.0.0.1:1935/live',
    key: 'local-key',
  }), /già trasmettendo/);
  assert.deepEqual(requests.map(({ type }) => type), ['GetStreamStatus']);
});
