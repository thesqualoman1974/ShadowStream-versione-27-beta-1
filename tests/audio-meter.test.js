'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyGainToMeterLevel } = require('../electron/audio-meter');

test('unity gain preserves the incoming meter level', () => {
  assert.equal(applyGainToMeterLevel(64, 100), 64);
});

test('attenuation lowers the displayed meter level', () => {
  assert.equal(applyGainToMeterLevel(80, 10), 47);
});

test('amplification raises the displayed meter level without exceeding full scale', () => {
  assert.equal(applyGainToMeterLevel(50, 200), 60);
  assert.equal(applyGainToMeterLevel(100, 200), 100);
});

test('mute and silence remain at zero', () => {
  assert.equal(applyGainToMeterLevel(80, 0), 0);
  assert.equal(applyGainToMeterLevel(0, 200), 0);
});

test('invalid meter input is safely reported as silence', () => {
  assert.equal(applyGainToMeterLevel(Number.NaN, 100), 0);
  assert.equal(applyGainToMeterLevel(50, Number.NaN), 0);
});
