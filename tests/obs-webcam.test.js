'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const ObsEngine = require('../electron/obs-engine');

function createEngine() {
  const engine = new ObsEngine({
    userDataPath: path.join(os.tmpdir(), 'shadowstream-obs-webcam-test'),
    clipsPath: os.tmpdir(),
    log: () => {},
  });
  const requests = [];
  let webcamCreated = false;
  let borderCreated = false;
  engine.request = async (type, data) => {
    requests.push({ type, data });
    if (type === 'GetInputList') {
      return {
        inputs: [
          ...(webcamCreated ? [{ inputName: 'Webcam ShadowStream' }] : []),
          ...(borderCreated ? [{ inputName: 'Webcam Border ShadowStream' }] : []),
        ],
      };
    }
    if (type === 'CreateInput') {
      if (data.inputName === 'Webcam ShadowStream') webcamCreated = true;
      if (data.inputName === 'Webcam Border ShadowStream') borderCreated = true;
      return { inputCreated: true };
    }
    if (type === 'GetSceneItemList') {
      return {
        sceneItems: [
          { sourceName: 'Webcam ShadowStream', sceneItemId: 12, sceneItemIndex: 5 },
          ...(borderCreated
            ? [{ sourceName: 'Webcam Border ShadowStream', sceneItemId: 13, sceneItemIndex: 6 }]
            : []),
        ],
      };
    }
    if (type === 'GetInputPropertiesListPropertyItems') {
      return {
        propertyItems: [
          { itemName: 'USB Camera', itemValue: 'device-camera', itemEnabled: true },
          { itemName: 'Unavailable camera', itemValue: 'device-off', itemEnabled: false },
        ],
      };
    }
    if (type === 'GetSceneItemTransform') {
      return { sceneItemTransform: { scaleX: 1, scaleY: 1, alignment: 0 } };
    }
    if (type === 'GetSourceFilterList') return { filters: [] };
    return {};
  };
  return { engine, requests };
}

test('creates an isolated DirectShow webcam source and lists available cameras', async () => {
  const { engine, requests } = createEngine();
  const devices = await engine.getWebcamDevices();
  assert.deepEqual(devices, [{ id: 'device-camera', name: 'USB Camera' }]);
  assert.ok(requests.some(({ type, data }) => type === 'CreateInput'
    && data.inputKind === 'dshow_input'
    && data.sceneItemEnabled === false));
  assert.ok(requests.some(({ type, data }) => type === 'GetInputPropertiesListPropertyItems'
    && data.propertyName === 'video_device_id'));
});

test('applies webcam placement, visibility, and optional chromakey filter', async () => {
  const { engine, requests } = createEngine();
  await engine.setWebcamSettings({
    enabled: true,
    deviceId: 'device-camera',
    x: 1480,
    y: 1100,
    width: 480,
    height: 270,
    chromaKeyEnabled: true,
    borderEnabled: true,
    borderColor: '#ffffff',
  });
  const settings = requests.find(({ type }) => type === 'SetInputSettings');
  assert.deepEqual(settings.data.inputSettings, { video_device_id: 'device-camera' });
  const visibility = requests.find(({ type }) => type === 'SetSceneItemEnabled');
  assert.equal(visibility.data.sceneItemEnabled, true);
  const transform = requests.find(({ type }) => type === 'SetSceneItemTransform');
  assert.equal(transform.data.sceneItemTransform.positionX, 1480);
  assert.equal(transform.data.sceneItemTransform.boundsWidth, 480);
  assert.equal(transform.data.sceneItemTransform.boundsType, 'OBS_BOUNDS_SCALE_INNER');
  assert.ok(requests.some(({ type, data }) => type === 'CreateInput'
    && data.inputKind === 'color_source_v3'));
  assert.ok(requests.some(({ type, data }) => type === 'SetSceneItemIndex'
    && data.sceneItemId === 13
    && data.sceneItemIndex === 6));
  assert.ok(requests.some(({ type, data }) => type === 'CreateSourceFilter'
    && data.filterKind === 'chroma_key_filter'));
});

test('rejects webcam geometry outside the OBS canvas', async () => {
  const { engine } = createEngine();
  await assert.rejects(() => engine.setWebcamSettings({
    enabled: true,
    deviceId: 'device-camera',
    x: 3400,
    y: 1100,
    width: 480,
    height: 270,
    chromaKeyEnabled: false,
    borderEnabled: false,
    borderColor: '#ffffff',
  }), /non valide/);
});
