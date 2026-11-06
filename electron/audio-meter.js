'use strict';

function applyGainToMeterLevel(level, volumePercent) {
  if (!Number.isFinite(level) || !Number.isFinite(volumePercent) || level <= 0 || volumePercent <= 0) {
    return 0;
  }

  const inputDb = (Math.min(100, level) * 0.6) - 60;
  const gainDb = 20 * Math.log10(volumePercent / 100);
  return Math.max(0, Math.min(100, Math.round(((inputDb + gainDb + 60) / 60) * 100)));
}

module.exports = { applyGainToMeterLevel };
