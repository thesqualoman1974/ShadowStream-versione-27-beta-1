'use strict';

const api = window.electronAPI;
if (!api) {
  throw new Error('Preload Electron API non disponibile.');
}

const els = {
  statusText: document.getElementById('status-text'),
  statusIndicator: document.querySelector('.status-indicator'),
  btnSave: document.getElementById('btn-save-clip'),
  btnToggleReplay: document.getElementById('btn-toggle-replay'),
  btnToggleRecord: document.getElementById('btn-toggle-record'),
  btnCheckUpdates: document.getElementById('btn-check-updates'),
  updateDialog: document.getElementById('update-dialog'),
  updateDialogTitle: document.getElementById('update-dialog-title'),
  updateDialogMessage: document.getElementById('update-dialog-message'),
  updateProgress: document.getElementById('update-progress'),
  btnUpdateDownload: document.getElementById('btn-update-download'),
  btnUpdateClose: document.getElementById('btn-update-close'),
  btnMinimize: document.getElementById('btn-minimize'),
  btnMaximize: document.getElementById('btn-maximize'),
  btnClose: document.getElementById('btn-close'),
  content: document.querySelector('.content'),
  navDashboard: document.getElementById('nav-dashboard'),
  navClips: document.getElementById('nav-clips'),
  navSettings: document.getElementById('nav-settings'),

  // Slider & Buffer
  bufferSlider: document.getElementById('buffer-slider'),
  sliderValText: document.getElementById('slider-val'),
  displayBufferMin: document.getElementById('display-buffer-min'),
  bufferTotalMin: document.getElementById('buffer-total-min'),
  bufferCurrentS: document.getElementById('buffer-current-s'),
  progressCircle: document.getElementById('progress-ring-circle'),

  // Paths & Sources
  lastClip: document.getElementById('lastclip'),
  lastClipPath: document.getElementById('lastclip-path'),
  outputPathInput: document.getElementById('input-output-path'),

  // Toggles
  btnModeScreen: document.getElementById('btn-mode-screen'),
  btnModeGame: document.getElementById('btn-mode-game'),
  selectGameWindow: document.getElementById('select-game-window'),
  btnRefreshWindows: document.getElementById('btn-refresh-windows'),
  preview: document.getElementById('preview-video'),
  previewPlaceholder: document.getElementById('preview-placeholder'),
  previewBox: document.querySelector('.preview-box'),
  zoomSlider: document.getElementById('zoom-slider'),
  zoomValue: document.getElementById('zoom-value'),
  zoomIn: document.getElementById('btn-zoom-in'),
  zoomOut: document.getElementById('btn-zoom-out'),
  zoomReset: document.getElementById('btn-zoom-reset'),
  audioOutput: document.getElementById('select-audio-output'),
  audioMicrophone: document.getElementById('select-audio-mic'),
  audioOutputMeter: document.getElementById('audio-output-meter'),
  audioMicrophoneMeter: document.getElementById('audio-mic-meter'),
  audioOutputStatus: document.getElementById('audio-output-status'),
  audioMicrophoneStatus: document.getElementById('audio-mic-status'),
  audioOutputName: document.getElementById('audio-output-name'),
  audioMicrophoneName: document.getElementById('audio-mic-name'),
  audioOutputVolume: document.getElementById('audio-output-volume'),
  audioOutputVolumeValue: document.getElementById('audio-output-volume-value'),
  audioMicrophoneVolume: document.getElementById('audio-mic-volume'),
  audioMicrophoneVolumeValue: document.getElementById('audio-mic-volume-value'),
};

const ANSI = /\u001b\[[0-9;]*m/g;
const CIRCUMFERENCE = 2 * Math.PI * 40;

function stripAnsi(text) {
  return String(text).replace(ANSI, '');
}

function setProgress(percent) {
  const offset = CIRCUMFERENCE - (percent / 100) * CIRCUMFERENCE;
  els.progressCircle.style.strokeDasharray = `${CIRCUMFERENCE} ${CIRCUMFERENCE}`;
  els.progressCircle.style.strokeDashoffset = offset;
}

function updateBufferUI(currentSeconds, totalMinutes) {
  const totalSeconds = totalMinutes * 60;
  const percent = Math.min(100, (currentSeconds / totalSeconds) * 100);

  els.bufferCurrentS.textContent = Math.floor(currentSeconds);
  els.bufferTotalMin.textContent = totalMinutes;
  setProgress(percent);
  const replayRunning = els.btnToggleReplay.classList.contains('stop');
  const recording = els.btnToggleRecord.classList.contains('stop');
  els.btnSave.disabled = !replayRunning || recording || savingClip;
  els.btnSave.title = `Salva il buffer disponibile fino a ${totalMinutes} minuti`;
}

function setReplayState(running) {
  const indicator = els.statusIndicator;
  const text = els.statusText;
  const btn = els.btnToggleReplay;
  const btnText = btn.querySelector('.btn-text');

  if (running) {
    indicator.classList.add('on');
    indicator.classList.remove('off');
    text.textContent = 'Replay on';
    btn.classList.remove('start');
    btn.classList.add('stop');
    btnText.textContent = 'Ferma Instant Replay';
    updateBufferUI(currentBufferS, parseInt(els.bufferSlider.value, 10));
  } else {
    indicator.classList.remove('on');
    indicator.classList.add('off');
    text.textContent = 'Replay off';
    btn.classList.remove('stop');
    btn.classList.add('start');
    btnText.textContent = 'Avvia Instant Replay';
    updateBufferUI(0, parseInt(els.bufferSlider.value, 10));
  }
}

function setRecordingState(recording) {
  const btn = els.btnToggleRecord;
  const btnText = btn.querySelector('.btn-text');
  btn.classList.toggle('stop', recording);
  btn.classList.toggle('start', !recording);
  btnText.textContent = recording ? 'Ferma Registrazione' : 'Avvia Registrazione MP4';
  els.btnToggleReplay.disabled = recording;
  updateBufferUI(currentBufferS, parseInt(els.bufferSlider.value, 10));
  if (recording) {
    els.statusIndicator.classList.add('on');
    els.statusIndicator.classList.remove('off');
    els.statusText.textContent = 'Registrazione in corso';
  }
}

function updateBufferSelection(minutes) {
  const val = Number(minutes);
  els.sliderValText.textContent = `${val} min`;
  els.displayBufferMin.textContent = val;
  els.bufferTotalMin.textContent = val;
  updateBufferUI(currentBufferS, val);
}

// Handle Slider
els.bufferSlider.addEventListener('input', (e) => {
  const val = parseInt(e.target.value, 10);
  updateBufferSelection(val);
  api.setBufferSeconds(val * 60).catch((error) => {
    console.error('Impossibile salvare la durata Instant Replay:', error);
  });
});

// Mode Toggles - collegate al backend
const gameWindowGroup = document.getElementById('game-window-group');
let previewStream = null;
let previewRequestId = 0;
const zoomSettings = { zoom: 1, centerX: 0.5, centerY: 0.5 };
let zoomSaveTimeout = null;
let panPointer = null;

function renderZoom() {
  const { zoom, centerX, centerY } = zoomSettings;
  els.zoomSlider.value = String(zoom);
  els.zoomValue.textContent = `${zoom.toFixed(1)}×`;
  els.preview.style.transform = `translate(${((0.5 - centerX) * zoom * 100).toFixed(2)}%, ${((0.5 - centerY) * zoom * 100).toFixed(2)}%) scale(${zoom})`;
  els.previewBox.classList.toggle('can-pan', zoom > 1);
}

function setZoom(zoom, center = null) {
  zoomSettings.zoom = Math.max(1, Math.min(4, Number(zoom)));
  if (center) {
    zoomSettings.centerX = center.x;
    zoomSettings.centerY = center.y;
  }
  const limit = 0.5 / zoomSettings.zoom;
  zoomSettings.centerX = zoomSettings.zoom === 1
    ? 0.5 : Math.max(limit, Math.min(1 - limit, zoomSettings.centerX));
  zoomSettings.centerY = zoomSettings.zoom === 1
    ? 0.5 : Math.max(limit, Math.min(1 - limit, zoomSettings.centerY));
  renderZoom();
  clearTimeout(zoomSaveTimeout);
  zoomSaveTimeout = setTimeout(() => {
    api.setZoomSettings({ ...zoomSettings }).catch((error) => {
      console.error('Impossibile aggiornare lo zoom della cattura:', error);
    });
  }, 100);
}

api.getZoomSettings().then((settings) => {
  if (settings && Number.isFinite(settings.zoom)) {
    Object.assign(zoomSettings, settings);
    renderZoom();
  }
}).catch((error) => console.error('Impossibile caricare lo zoom:', error));

els.zoomSlider.addEventListener('input', () => setZoom(els.zoomSlider.value));
els.zoomIn.addEventListener('click', () => setZoom(Math.min(4, zoomSettings.zoom + 0.2)));
els.zoomOut.addEventListener('click', () => setZoom(Math.max(1, zoomSettings.zoom - 0.2)));
els.zoomReset.addEventListener('click', () => setZoom(1, { x: 0.5, y: 0.5 }));

els.previewBox.addEventListener('wheel', (event) => {
  if (event.target.closest('.preview-zoom')) return;
  event.preventDefault();
  const bounds = els.previewBox.getBoundingClientRect();
  const point = {
    x: (event.clientX - bounds.left) / bounds.width,
    y: (event.clientY - bounds.top) / bounds.height,
  };
  const nextZoom = Math.max(1, Math.min(4, zoomSettings.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1)));
  const ratio = zoomSettings.zoom / nextZoom;
  setZoom(nextZoom, {
    x: point.x + (zoomSettings.centerX - point.x) * ratio,
    y: point.y + (zoomSettings.centerY - point.y) * ratio,
  });
}, { passive: false });

els.previewBox.addEventListener('pointerdown', (event) => {
  if (zoomSettings.zoom <= 1 || event.target.closest('.preview-zoom')) return;
  panPointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
  els.previewBox.classList.add('is-panning');
  els.previewBox.setPointerCapture(event.pointerId);
});

els.previewBox.addEventListener('pointermove', (event) => {
  if (!panPointer || panPointer.id !== event.pointerId) return;
  const bounds = els.previewBox.getBoundingClientRect();
  const dx = event.clientX - panPointer.x;
  const dy = event.clientY - panPointer.y;
  panPointer.x = event.clientX;
  panPointer.y = event.clientY;
  setZoom(zoomSettings.zoom, {
    x: zoomSettings.centerX - dx / (bounds.width * zoomSettings.zoom),
    y: zoomSettings.centerY - dy / (bounds.height * zoomSettings.zoom),
  });
});

function stopPanning(event) {
  if (!panPointer || panPointer.id !== event.pointerId) return;
  panPointer = null;
  els.previewBox.classList.remove('is-panning');
}

els.previewBox.addEventListener('pointerup', stopPanning);
els.previewBox.addEventListener('pointercancel', stopPanning);

function selectedWindowTarget() {
  try {
    return JSON.parse(els.selectGameWindow?.value || 'null');
  } catch {
    return null;
  }
}

let captureModeRequestId = 0;

async function applyCaptureMode(mode) {
  const requestId = ++captureModeRequestId;
  const useWindow = mode === 'window';
  els.btnModeGame.classList.toggle('active', useWindow);
  els.btnModeScreen.classList.toggle('active', !useWindow);
  if (gameWindowGroup) gameWindowGroup.hidden = !useWindow;

  const target = useWindow ? selectedWindowTarget() : null;
  if (useWindow && !target) {
    stopPreviewStream();
    api.getWindows().catch((error) => console.error('Impossibile aggiornare le finestre:', error));
    return;
  }

  stopPreviewStream();
  els.previewPlaceholder.textContent = 'Cambio sorgente di cattura...';
  try {
    const updated = await api.setCaptureMode(mode, target);
    if (updated !== true) throw new Error('OBS non ha accettato la sorgente selezionata.');
    if (requestId !== captureModeRequestId) return;
    await restartPreviewStream();
  } catch (error) {
    if (requestId !== captureModeRequestId) return;
    console.error('Impossibile cambiare sorgente di cattura:', error);
    stopPreviewStream();
    els.previewPlaceholder.textContent = `Cambio sorgente non riuscito: ${error.message}`;
  }
}

function applyModeDisplay() {
  return applyCaptureMode('display');
}

function applyModeGame() {
  return applyCaptureMode('window');
}

els.btnModeScreen.addEventListener('click', applyModeDisplay);
els.btnModeGame.addEventListener('click', applyModeGame);

// Window selector
if (els.selectGameWindow) {
  els.selectGameWindow.addEventListener('change', () => {
    if (els.btnModeGame.classList.contains('active')) {
      void applyModeGame();
    }
  });
}

if (els.btnRefreshWindows) {
  els.btnRefreshWindows.addEventListener('click', () => {
    api.getWindows();
  });
}

// Ricezione lista finestre dal backend
api.onWindowsList((list) => {
  if (!els.selectGameWindow) return;
  const current = selectedWindowTarget() || preferredWindowTarget;
  els.selectGameWindow.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Seleziona una finestra...';
  els.selectGameWindow.appendChild(placeholder);
  list.forEach((target) => {
    const opt = document.createElement('option');
    opt.value = JSON.stringify(target);
    opt.textContent = target.title.length > 60
      ? `${target.title.substring(0, 57)}...`
      : target.title;
    if (current && target.title === current.title
      && target.className === current.className
      && target.executable === current.executable) opt.selected = true;
    els.selectGameWindow.appendChild(opt);
  });
  if (!els.selectGameWindow.value && list.length > 0 && !preferredWindowTarget) {
    els.selectGameWindow.value = JSON.stringify(list[0]);
  }
  if (preferredWindowTarget && !els.selectGameWindow.value) {
    console.warn('La finestra di gioco salvata non è disponibile; uso la cattura schermo.');
    preferredWindowTarget = null;
    applyModeDisplay();
    return;
  }
  if (els.selectGameWindow.value) preferredWindowTarget = null;
  if (els.btnModeGame.classList.contains('active') && els.selectGameWindow.value) {
    applyModeGame();
  }
});

// IPC Actions
els.btnToggleReplay.addEventListener('click', () => {
  api.toggleReplay();
});

els.btnToggleRecord.addEventListener('click', () => api.record());

let savingClip = false;
els.btnSave.addEventListener('click', async () => {
  if (savingClip || els.btnSave.disabled) return;
  savingClip = true;
  els.btnSave.querySelector('.btn-text').textContent = 'Salvataggio...';
  updateBufferUI(currentBufferS, parseInt(els.bufferSlider.value, 10));
  try {
    const saved = await api.saveClip();
    if (!saved) console.error('OBS non ha salvato la clip: Instant Replay potrebbe essere fermo.');
  } catch (error) {
    console.error('Salvataggio clip non riuscito:', error);
  } finally {
    savingClip = false;
    els.btnSave.querySelector('.btn-text').textContent = 'Salva clip';
    updateBufferUI(currentBufferS, parseInt(els.bufferSlider.value, 10));
  }
});
els.btnMinimize?.addEventListener('click', () => api.minimizeWindow());
els.btnMaximize?.addEventListener('click', () => api.toggleMaximizeWindow());
els.btnClose?.addEventListener('click', () => api.closeWindow());
function showUpdateDialog(state, details = {}) {
  els.updateDialogTitle.textContent = 'Aggiornamento ShadowStream';
  els.updateProgress.hidden = true;
  els.btnUpdateDownload.hidden = true;
  els.btnUpdateClose.hidden = false;
  els.btnUpdateClose.textContent = 'Chiudi';
  els.btnUpdateDownload.disabled = false;

  switch (state) {
    case 'checking':
      els.updateDialogMessage.textContent = 'Ricerca aggiornamenti in corso...';
      els.btnUpdateClose.textContent = 'Annulla';
      break;
    case 'not-available':
      els.updateDialogMessage.textContent = 'Hai la versione aggiornata.';
      break;
    case 'available':
      els.updateDialogMessage.textContent = `È disponibile la versione ${details.version}.`;
      els.btnUpdateDownload.hidden = false;
      els.btnUpdateClose.textContent = 'Più tardi';
      break;
    case 'downloading':
      els.updateDialogMessage.textContent = `Download aggiornamento in corso... ${details.percent ?? 0}%`;
      els.updateProgress.hidden = false;
      els.updateProgress.value = details.percent ?? 0;
      els.btnUpdateClose.hidden = true;
      break;
    case 'error':
      els.updateDialogMessage.textContent = `Controllo aggiornamenti non riuscito: ${details.message || 'errore sconosciuto'}`;
      break;
    case 'unsupported':
      els.updateDialogMessage.textContent = 'Il controllo aggiornamenti è disponibile nella versione installata.';
      break;
    default:
      return;
  }

  if (!els.updateDialog.open) els.updateDialog.showModal();
}

els.btnCheckUpdates?.addEventListener('click', () => {
  if (els.updateDialog.open) return;
  showUpdateDialog('checking');
  api.checkForUpdates().catch((error) => showUpdateDialog('error', { message: error.message }));
});
els.btnUpdateClose?.addEventListener('click', () => els.updateDialog.close());
els.btnUpdateDownload?.addEventListener('click', () => {
  els.btnUpdateDownload.disabled = true;
  showUpdateDialog('downloading');
  api.downloadUpdate().catch((error) => showUpdateDialog('error', { message: error.message }));
});
api.onUpdateStatus((status) => {
  if (status.state === 'downloaded') {
    if (els.updateDialog.open) els.updateDialog.close();
    return;
  }
  if (status.state === 'available' && !els.updateDialog.open) {
    showUpdateDialog(status.state, status);
    return;
  }
  if (els.updateDialog.open) showUpdateDialog(status.state, status);
});

// Output open handlers
const btnOpenOutput = document.querySelector('.content-right .panel:last-child .link-btn');
if (btnOpenOutput) {
  btnOpenOutput.addEventListener('click', () => api.openClips());
}
const btnBrowse = document.getElementById('btn-browse');
if (btnBrowse) {
  btnBrowse.addEventListener('click', () => api.openClips());
}

document.getElementById('btn-refresh-audio')?.addEventListener('click', () => api.getAudioDevices());

// Listeners
api.onLog((entry) => {
  const text = stripAnsi(entry.text);
  const clip = text.match(/(?:Clip|Registrazione) salvata:\s*(.+)$/);
  if (clip) {
    const clipPath = clip[1].trim();
    if (els.lastClipPath) {
      els.lastClipPath.textContent = clipPath;
    }
  }
});

function setSelectOptions(select, automaticLabel, devices, selectedId, enabled) {
  select.replaceChildren();
  const automatic = document.createElement('option');
  automatic.value = 'default';
  automatic.textContent = automaticLabel;
  select.appendChild(automatic);

  const disabled = document.createElement('option');
  disabled.value = 'disabled';
  disabled.textContent = 'Disattivato';
  select.appendChild(disabled);

  devices.forEach((device) => {
    const option = document.createElement('option');
    option.value = device.id;
    option.textContent = device.name;
    select.appendChild(option);
  });

  select.value = enabled && selectedId && devices.some((device) => device.id === selectedId)
    ? selectedId
    : enabled ? 'default' : 'disabled';
}

function updateAudioSelection() {
  const outputValue = els.audioOutput.value;
  const inputValue = els.audioMicrophone.value;
  api.setAudioDevices({
    outputDeviceId: outputValue === 'default' || outputValue === 'disabled' ? null : outputValue,
    inputDeviceId: inputValue === 'default' || inputValue === 'disabled' ? null : inputValue,
    systemAudioEnabled: outputValue !== 'disabled',
    microphoneEnabled: inputValue !== 'disabled',
    systemVolume: Number(els.audioOutputVolume.value),
    microphoneVolume: Number(els.audioMicrophoneVolume.value),
  }).catch((error) => {
    console.error('Impossibile aggiornare i dispositivi audio:', error);
  });
  updateMixerDeviceNames();
}

function volumeToDecibels(volume) {
  return volume <= 0 ? -60 : Math.max(-60, Math.min(6, 20 * Math.log10(volume / 100)));
}

function decibelsToVolume(decibels) {
  return decibels <= -60 ? 0 : Math.min(200, 100 * (10 ** (decibels / 20)));
}

function formatDecibels(decibels) {
  return decibels > 0 ? `+${decibels.toFixed(1)} dB` : `${decibels.toFixed(1)} dB`;
}

function updateAudioVolumeControls(settings) {
  const systemVolume = Number.isFinite(settings?.systemVolume)
    ? Math.max(0, Math.min(200, settings.systemVolume)) : 100;
  const microphoneVolume = Number.isFinite(settings?.microphoneVolume)
    ? Math.max(0, Math.min(200, settings.microphoneVolume)) : 100;
  const systemDecibels = Math.round(volumeToDecibels(systemVolume));
  const microphoneDecibels = Math.round(volumeToDecibels(microphoneVolume));
  els.audioOutputVolume.value = String(systemDecibels);
  els.audioOutputVolumeValue.textContent = formatDecibels(systemDecibels);
  els.audioMicrophoneVolume.value = String(microphoneDecibels);
  els.audioMicrophoneVolumeValue.textContent = formatDecibels(microphoneDecibels);
}

function updateMixerDeviceNames() {
  els.audioOutputName.textContent = els.audioOutput.selectedOptions[0]?.textContent || 'Uscita audio';
  els.audioMicrophoneName.textContent = els.audioMicrophone.selectedOptions[0]?.textContent || 'Microfono';
}

api.getAudioSettings()
  .then(updateAudioVolumeControls)
  .catch((error) => console.error('Impossibile caricare i livelli volume audio:', error));

api.onAudioDevices((result) => {
  updateAudioVolumeControls(result.settings);
  setSelectOptions(
    els.audioOutput,
    'Uscita predefinita (automatico)',
    result.outputs || [],
    result.settings?.outputDeviceId,
    result.settings?.systemAudioEnabled !== false,
  );
  setSelectOptions(
    els.audioMicrophone,
    'Microfono predefinito (automatico)',
    result.inputs || [],
    result.settings?.inputDeviceId,
    result.settings?.microphoneEnabled !== false,
  );
  updateMixerDeviceNames();
});

function updateAudioMeter(meter, status, value, capturing, disabled) {
  const percent = capturing && !disabled ? Math.round(Math.max(0, Math.min(100, value))) : 0;
  const litSegments = Math.ceil((percent / 100) * meter.childElementCount);
  Array.from(meter.children).forEach((segment, index) => {
    segment.classList.toggle('lit', index < litSegments);
  });
  meter.setAttribute('aria-valuenow', String(percent));
  meter.setAttribute('aria-valuetext', percent > 0 ? `Segnale ${percent}%` : 'Nessun segnale');
  meter.classList.toggle('capturing', capturing && !disabled);

  const hasSignal = capturing && !disabled && percent > 0;
  status.textContent = disabled ? 'DISATTIVATO' : !capturing ? 'INATTIVO' : hasSignal ? 'SEGNALE' : 'SILENZIO';
  status.classList.toggle('active', capturing && !disabled);
  status.classList.toggle('signal', hasSignal);
}

api.onAudioLevels((levels) => {
  updateAudioMeter(
    els.audioOutputMeter,
    els.audioOutputStatus,
    levels.system,
    levels.systemCapturing,
    els.audioOutput.value === 'disabled',
  );
  updateAudioMeter(
    els.audioMicrophoneMeter,
    els.audioMicrophoneStatus,
    levels.microphone,
    levels.microphoneCapturing,
    els.audioMicrophone.value === 'disabled',
  );
});

els.audioOutput.addEventListener('change', updateAudioSelection);
els.audioMicrophone.addEventListener('change', updateAudioSelection);

let audioVolumeSaveTimeout = null;
function saveAudioVolumes() {
  clearTimeout(audioVolumeSaveTimeout);
  audioVolumeSaveTimeout = setTimeout(() => {
    api.setAudioVolumes({
      systemVolume: decibelsToVolume(Number(els.audioOutputVolume.value)),
      microphoneVolume: decibelsToVolume(Number(els.audioMicrophoneVolume.value)),
    }).then((updated) => {
      if (updated !== true) console.error('OBS non ha applicato i nuovi volumi audio.');
    }).catch((error) => {
      console.error('Impossibile aggiornare i volumi audio:', error);
    });
  }, 100);
}

els.audioOutputVolume.addEventListener('input', () => {
  els.audioOutputVolumeValue.textContent = formatDecibels(Number(els.audioOutputVolume.value));
  saveAudioVolumes();
});
els.audioMicrophoneVolume.addEventListener('input', () => {
  els.audioMicrophoneVolumeValue.textContent = formatDecibels(Number(els.audioMicrophoneVolume.value));
  saveAudioVolumes();
});

api.onUpdateStatus((status) => {
  if (!els.btnCheckUpdates) return;
  if (status.state === 'downloading') {
    els.btnCheckUpdates.textContent = `Download ${status.percent}%`;
  } else if (status.state === 'available') {
    els.btnCheckUpdates.textContent = `Disponibile ${status.version}`;
  } else if (status.state === 'downloaded') {
    els.btnCheckUpdates.textContent = 'Pronto a installare';
  }
});

function selectView(view) {
  const settingsVisible = view === 'settings';
  els.content.classList.toggle('show-settings', settingsVisible);
  for (const [button, selected] of [
    [els.navDashboard, view === 'dashboard'],
    [els.navSettings, settingsVisible],
  ]) {
    button.classList.toggle('active', selected);
    if (selected) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
}

els.navDashboard.addEventListener('click', () => selectView('dashboard'));
els.navSettings.addEventListener('click', () => selectView('settings'));
els.navClips.addEventListener('click', () => api.openClips());

// Initial calls
setProgress(0);

api.getBufferSeconds()
  .then((seconds) => {
    const minutes = seconds / 60;
    if (Number.isInteger(minutes) && minutes >= 5 && minutes <= 30 && minutes % 5 === 0) {
      els.bufferSlider.value = String(minutes);
      updateBufferSelection(minutes);
    }
  })
  .catch((error) => console.error('Impossibile caricare la durata Instant Replay salvata:', error));
let preferredWindowTarget = null;
api.getCaptureSettings()
  .then((settings) => {
    if (settings?.mode === 'window' && settings.windowTarget) {
      preferredWindowTarget = settings.windowTarget;
      els.btnModeScreen.classList.remove('active');
      els.btnModeGame.classList.add('active');
      if (gameWindowGroup) gameWindowGroup.hidden = false;
      api.getWindows();
      return;
    }
    applyModeDisplay();
  })
  .catch((error) => {
    console.error('Impossibile caricare la sorgente di cattura salvata:', error);
    applyModeDisplay();
  });

// Simple simulation of buffer growth for visual feedback
let bufferSimInterval = null;
let currentBufferS = 0;

function startBufferSim() {
  stopBufferSim();
  currentBufferS = 0;
  updateBufferUI(currentBufferS, parseInt(els.bufferSlider.value, 10));
  bufferSimInterval = setInterval(() => {
    currentBufferS += 1;
    updateBufferUI(currentBufferS, parseInt(els.bufferSlider.value, 10));
  }, 1000);
}

function stopBufferSim() {
  if (bufferSimInterval) {
    clearInterval(bufferSimInterval);
    bufferSimInterval = null;
  }
}

// Update simulation based on status
function stopPreviewStream() {
  previewRequestId += 1;
  if (previewStream) {
    for (const track of previewStream.getTracks()) track.stop();
    previewStream = null;
  }
  if (els.preview) {
    els.preview.pause();
    els.preview.srcObject = null;
    els.preview.hidden = true;
  }
  if (els.previewPlaceholder) {
    els.previewPlaceholder.textContent = 'Anteprima non disponibile per la sorgente selezionata.';
    els.previewPlaceholder.hidden = false;
  }
}

async function restartPreviewStream() {
  stopPreviewStream();
  const requestId = previewRequestId;
  if (!els.preview || !els.previewPlaceholder) return;
  els.previewPlaceholder.textContent = 'Avvio anteprima live...';

  try {
    const source = await api.getPreviewSource();
    if (requestId !== previewRequestId) return;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: source.id,
          maxWidth: 1920,
          maxHeight: 1080,
          maxFrameRate: 60,
        },
      },
    });
    if (requestId !== previewRequestId) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }

    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) {
      for (const track of stream.getTracks()) track.stop();
      throw new Error('La sorgente non ha restituito un flusso video.');
    }
    previewStream = stream;
    videoTrack.addEventListener('ended', () => {
      if (requestId !== previewRequestId) return;
      stopPreviewStream();
      els.previewPlaceholder.textContent = 'La sorgente video è stata interrotta.';
    }, { once: true });
    els.preview.srcObject = stream;
    els.preview.hidden = false;
    els.previewPlaceholder.hidden = true;
    await els.preview.play();
  } catch (error) {
    if (requestId !== previewRequestId) return;
    stopPreviewStream();
    els.previewPlaceholder.textContent = `Anteprima non disponibile: ${error.message}`;
  }
}

function syncCaptureStatus(status) {
  setReplayState(status.running);
  setRecordingState(status.recording === true);
  if (status.running) {
    startBufferSim();
  } else if (status.recording) {
    stopBufferSim();
  } else {
    stopBufferSim();
    updateBufferUI(0, parseInt(els.bufferSlider.value, 10));
  }
}

api.onStatus(syncCaptureStatus);
api.getStatus().then(syncCaptureStatus);

window.addEventListener('beforeunload', stopPreviewStream, { once: true });
