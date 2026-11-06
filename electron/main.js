'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  dialog,
  desktopCapturer,
  screen,
  session,
} = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');
const ObsEngine = require('./obs-engine');

for (const output of [process.stdout, process.stderr]) {
  output.on('error', (error) => {
    if (error.code !== 'EPIPE') setImmediate(() => { throw error; });
  });
}

const ROOT = path.join(__dirname, '..');
const APP_ROOT = app.isPackaged ? process.resourcesPath : ROOT;
const BUILD_CONFIG = 'Debug';
const BACKEND_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'backend')
  : path.join(ROOT, 'bin', BUILD_CONFIG, 'net8.0');
const BACKEND_DLL = path.join(BACKEND_DIR, 'ShadowStream.dll');
const BACKEND_EXE = path.join(BACKEND_DIR, 'ShadowStream.exe');
const CLIPS_PATH = path.join('D:\\', 'ShadowStream', 'Clips');

let mainWindow = null;
let backend = null;
let starting = false;
let quitting = false;
let backendStopPromise = null;
let captureRunning = false;
let recording = false;
let captureReady = false;
let captureModeQueue = Promise.resolve();
let pendingReplayStart = false;
let obsEngine = null;
let launchedConfiguration = null;
let configuredBufferSeconds = 300;
const DEFAULT_ZOOM_SETTINGS = { zoom: 1, centerX: 0.5, centerY: 0.5 };
let zoomSettings = { ...DEFAULT_ZOOM_SETTINGS };
const MIN_BUFFER_SECONDS = 5 * 60;
const MAX_BUFFER_SECONDS = 30 * 60;
const BUFFER_STEP_SECONDS = 5 * 60;
const DEFAULT_AUDIO_VOLUME = 100;
const MAX_AUDIO_VOLUME = 200;
let captureMode = 'display'; // 'display' | 'window'
let captureWindowTitle = '';
let captureWindowTarget = null;
let updateCheckPromise = null;
let audioSettingsQueue = Promise.resolve();
let audioSettings = {
  outputDeviceId: null,
  inputDeviceId: null,
  systemAudioEnabled: true,
  microphoneEnabled: true,
  systemVolume: DEFAULT_AUDIO_VOLUME,
  microphoneVolume: DEFAULT_AUDIO_VOLUME,
};

function isValidAudioVolume(value) {
  return Number.isFinite(value) && value >= 0 && value <= MAX_AUDIO_VOLUME;
}

function audioSettingsPath() {
  return path.join(app.getPath('userData'), 'audio-settings.json');
}

function replaySettingsPath() {
  return path.join(app.getPath('userData'), 'replay-settings.json');
}

function captureSettingsPath() {
  return path.join(app.getPath('userData'), 'capture-settings.json');
}

function zoomSettingsPath() {
  return path.join(app.getPath('userData'), 'zoom-settings.json');
}

function isValidZoomSettings(settings) {
  return settings && typeof settings === 'object'
    && Number.isFinite(settings.zoom) && settings.zoom >= 1 && settings.zoom <= 4
    && Number.isFinite(settings.centerX) && settings.centerX >= 0 && settings.centerX <= 1
    && Number.isFinite(settings.centerY) && settings.centerY >= 0 && settings.centerY <= 1;
}

function normalizeZoomSettings(settings) {
  const zoom = settings.zoom;
  const centerLimit = 0.5 / zoom;
  return {
    zoom,
    centerX: zoom === 1 ? 0.5 : Math.max(centerLimit, Math.min(1 - centerLimit, settings.centerX)),
    centerY: zoom === 1 ? 0.5 : Math.max(centerLimit, Math.min(1 - centerLimit, settings.centerY)),
  };
}

function loadZoomSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(zoomSettingsPath(), 'utf8'));
    if (isValidZoomSettings(saved)) zoomSettings = normalizeZoomSettings(saved);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      log('error', `Impossibile leggere le preferenze zoom: ${error.message}`);
    }
  }
}

function saveZoomSettings() {
  fs.mkdirSync(path.dirname(zoomSettingsPath()), { recursive: true });
  fs.writeFileSync(zoomSettingsPath(), JSON.stringify(zoomSettings, null, 2), 'utf8');
}

function isValidBufferSeconds(seconds) {
  return Number.isInteger(seconds)
    && seconds >= MIN_BUFFER_SECONDS
    && seconds <= MAX_BUFFER_SECONDS
    && seconds % BUFFER_STEP_SECONDS === 0;
}

function loadReplaySettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(replaySettingsPath(), 'utf8'));
    if (saved && isValidBufferSeconds(saved.bufferSeconds)) {
      configuredBufferSeconds = saved.bufferSeconds;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      log('error', `Impossibile leggere le preferenze Instant Replay: ${error.message}`);
    }
  }
}

function saveReplaySettings() {
  fs.mkdirSync(path.dirname(replaySettingsPath()), { recursive: true });
  fs.writeFileSync(replaySettingsPath(), JSON.stringify({
    bufferSeconds: configuredBufferSeconds,
  }, null, 2), 'utf8');
}

function loadCaptureSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(captureSettingsPath(), 'utf8'));
    if (saved?.mode === 'window' && saved.windowTarget
      && typeof saved.windowTarget.title === 'string'
      && typeof saved.windowTarget.className === 'string'
      && typeof saved.windowTarget.executable === 'string'
      && saved.windowTarget.title && saved.windowTarget.className && saved.windowTarget.executable) {
      captureMode = 'window';
      captureWindowTarget = {
        title: saved.windowTarget.title.slice(0, 512),
        className: saved.windowTarget.className.slice(0, 256),
        executable: saved.windowTarget.executable.slice(0, 256),
      };
      captureWindowTitle = captureWindowTarget.title;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      log('error', `Impossibile leggere le preferenze di cattura: ${error.message}`);
    }
  }
}

function saveCaptureSettings() {
  fs.mkdirSync(path.dirname(captureSettingsPath()), { recursive: true });
  fs.writeFileSync(captureSettingsPath(), JSON.stringify({
    mode: captureMode,
    windowTarget: captureWindowTarget,
  }, null, 2), 'utf8');
}

function loadAudioSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(audioSettingsPath(), 'utf8'));
    if (saved && typeof saved === 'object') {
      audioSettings = {
        outputDeviceId: typeof saved.outputDeviceId === 'string' ? saved.outputDeviceId : null,
        inputDeviceId: typeof saved.inputDeviceId === 'string' ? saved.inputDeviceId : null,
        systemAudioEnabled: saved.systemAudioEnabled !== false,
        microphoneEnabled: saved.microphoneEnabled !== false,
        systemVolume: isValidAudioVolume(saved.systemVolume)
          ? saved.systemVolume : DEFAULT_AUDIO_VOLUME,
        microphoneVolume: isValidAudioVolume(saved.microphoneVolume)
          ? saved.microphoneVolume : DEFAULT_AUDIO_VOLUME,
      };
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      log('error', `Impossibile leggere le preferenze audio: ${error.message}`);
    }
  }
}

function saveAudioSettings() {
  fs.mkdirSync(path.dirname(audioSettingsPath()), { recursive: true });
  fs.writeFileSync(audioSettingsPath(), JSON.stringify(audioSettings, null, 2), 'utf8');
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function log(stream, text) {
  const clean = String(text).replace(/\r/g, '');
  for (const line of clean.split('\n')) {
    if (line.length === 0) continue;
    // Intercetta la lista finestre inviata dal backend
    if (line.startsWith('[WINDOWS] ')) {
      try {
        const list = JSON.parse(line.substring('[WINDOWS] '.length));
        send('backend:windows-list', list);
      } catch { /* ignore parse errors */ }
      continue;
    }
    if (line.startsWith('[AUDIO_DEVICES] ')) {
      try {
        send('backend:audio-devices', {
          ...JSON.parse(line.substring('[AUDIO_DEVICES] '.length)),
          settings: audioSettings,
        });
      } catch (error) {
        console.error('Invalid audio device list from backend:', error);
        send('backend:log', { stream: 'error', text: 'Elenco dispositivi audio non leggibile.', time: Date.now() });
      }
      continue;
    }
    if (line.startsWith('[AUDIO_LEVELS] ')) {
      try {
        const levels = JSON.parse(line.substring('[AUDIO_LEVELS] '.length));
        if (Number.isFinite(levels.system) && Number.isFinite(levels.microphone)
          && typeof levels.systemCapturing === 'boolean'
          && typeof levels.microphoneCapturing === 'boolean') {
          send('backend:audio-levels', {
            system: Math.max(0, Math.min(100, levels.system)),
            microphone: Math.max(0, Math.min(100, levels.microphone)),
            systemCapturing: levels.systemCapturing,
            microphoneCapturing: levels.microphoneCapturing,
          });
        } else {
          throw new TypeError('Formato livelli audio non valido.');
        }
      } catch (error) {
        console.error('Invalid audio level data from backend:', error);
        send('backend:log', { stream: 'error', text: 'Livelli audio non leggibili.', time: Date.now() });
      }
      continue;
    }
    if (line.startsWith('[CAPTURE_STATUS] ')) {
      continue;
    }
    if (line.startsWith('[RECORDING_STATUS] ')) {
      continue;
    }
    console.log(`[${stream}] ${line}`);
    send('backend:log', { stream, text: line, time: Date.now() });
  }
}

function attachLogStream(stream, readable) {
  let pending = '';
  readable.on('data', (data) => {
    const lines = (pending + data.toString()).split(/\r?\n/);
    pending = lines.pop();
    lines.forEach((line) => log(stream, line));
  });
  readable.on('end', () => {
    if (pending) log(stream, pending);
    pending = '';
  });
}

function isBackendRunning() {
  return backend !== null && backend.exitCode === null;
}

function emitStatus() {
  send('backend:status', {
    running: captureRunning && !recording,
    recording,
    processRunning: isBackendRunning() || Boolean(obsEngine?.running),
    pid: obsEngine?.pid || (backend ? backend.pid : null),
  });
}

function resolveLaunch() {
  const isWin = process.platform === 'win32';
  const args = ['--headless', '--no-autostart', '--meter-only'];
  if (audioSettings.outputDeviceId) args.push('--audio-output-id', audioSettings.outputDeviceId);
  if (audioSettings.inputDeviceId) args.push('--audio-input-id', audioSettings.inputDeviceId);
  if (!audioSettings.systemAudioEnabled) args.push('--no-system-audio');
  if (!audioSettings.microphoneEnabled) args.push('--no-microphone');
  if (isWin && fs.existsSync(BACKEND_EXE)) {
    return { cmd: BACKEND_EXE, args };
  }
  if (fs.existsSync(BACKEND_DLL)) {
    return { cmd: 'dotnet', args: [BACKEND_DLL, ...args] };
  }
  return null;
}

function startBackend() {
  startObsEngine();
  if (isBackendRunning() || starting) return;

  quitting = false; // Reset esplicito del ciclo di vita

  const launch = resolveLaunch();
  if (!launch) {
    if (app.isPackaged) {
      log('error', `Backend installato non trovato: ${BACKEND_EXE}`);
      return;
    }
    starting = true;
    log('system', 'Backend non compilato: eseguo "dotnet build"…');
    const build = spawn('dotnet', ['build', '-nologo', '-v', 'q'], { cwd: ROOT, windowsHide: true });
    attachLogStream('system', build.stdout);
    attachLogStream('system', build.stderr);
    build.on('error', (err) => { starting = false; log('error', `dotnet build non eseguibile: ${err.message}`); });
    build.on('close', (code) => {
      starting = false;
      if (code === 0) {
        startBackend();
      } else {
        log('error', `dotnet build fallito (exit ${code}).`);
      }
    });
    return;
  }

  log('system', `Avvio backend: ${path.basename(launch.cmd)} ${launch.args.join(' ')}`);
  captureReady = Boolean(obsEngine?.running && !obsEngine?.connecting);
  captureRunning = Boolean(obsEngine?.replayRunning);
  recording = Boolean(obsEngine?.recording);
  launchedConfiguration = currentConfiguration();
  backend = spawn(launch.cmd, launch.args, {
    cwd: APP_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  backend.stdin.on('error', (error) => {
    if (error.code !== 'EPIPE') {
      log('error', `Errore pipe stdin backend: ${error.message}`);
    }
  });

  attachLogStream('stdout', backend.stdout);
  attachLogStream('stderr', backend.stderr);

  backend.on('spawn', () => {
    log('system', `Backend avviato (pid ${backend.pid}).`);
    emitStatus();
    sendCommand('AUDIODEVICES');
  });

  backend.on('error', (err) => {
    log('error', `Errore backend: ${err.message}`);
    backend = null;
    emitStatus();
  });

  backend.on('close', (code, signal) => {
    log('system', `Backend terminato (exit ${code}${signal ? ', ' + signal : ''}).`);
    backend = null;
    captureRunning = Boolean(obsEngine?.replayRunning);
    recording = Boolean(obsEngine?.recording);
    captureReady = Boolean(obsEngine?.running && !obsEngine?.connecting && obsEngine?.readyOnce);
    if (!captureReady && !obsEngine?.connecting) pendingReplayStart = false;
    launchedConfiguration = null;
    send('backend:audio-levels', {
      system: 0,
      microphone: 0,
      systemCapturing: false,
      microphoneCapturing: false,
    });
    emitStatus();
    if (!quitting) {
      log('system', 'Riavvio automatico del backend…');
      setTimeout(() => startBackend(), 800);
    }
  });

  emitStatus();
}

function startObsEngine() {
  if (obsEngine?.running || obsEngine?.connecting) return;
  if (!obsEngine) {
    obsEngine = new ObsEngine({
      userDataPath: app.getPath('userData'),
      clipsPath: CLIPS_PATH,
      log,
    });
    obsEngine.on('ready', async () => {
      await configureObsEngine();
    });
    obsEngine.on('status', () => {
      captureRunning = obsEngine.replayRunning;
      recording = obsEngine.recording;
      emitStatus();
    });
    obsEngine.on('clip', (clipPath) => log('system', `Clip salvata: ${clipPath}`));
    obsEngine.on('closed', (wasReady) => {
      captureReady = false;
      captureRunning = false;
      recording = false;
      emitStatus();
      if (!quitting && wasReady) setTimeout(() => startObsEngine(), 1000);
    });
  }
  void obsEngine.start().catch(() => {
    captureReady = false;
    emitStatus();
  });
}

async function configureObsEngine() {
  try {
    const configuration = currentConfiguration();
    await obsEngine.applySettings(configuration);
    launchedConfiguration = configuration;
    captureRunning = obsEngine.replayRunning;
    recording = obsEngine.recording;
    captureReady = true;
    emitStatus();
    if (pendingReplayStart && !recording) {
      pendingReplayStart = false;
      await obsEngine.startReplay();
    }
  } catch (error) {
    captureReady = false;
    emitStatus();
    log('error', `Configurazione iniziale OBS non riuscita: ${error.message}`);
  }
}

function sendCommand(cmd) {
  if (quitting || !isBackendRunning() || !backend.stdin || !backend.stdin.writable) {
    log('error', 'Backend non attivo: impossibile inviare il comando.');
    return false;
  }
  return writeCommandToProcess(backend, cmd);
}

function writeCommandToProcess(proc, cmd) {
  if (!proc || proc.exitCode !== null || !proc.stdin || !proc.stdin.writable) {
    return false;
  }

  try {
    proc.stdin.write(`${cmd}\n`, (error) => {
      if (error && error.code !== 'EPIPE') {
        log('error', `Invio comando backend non riuscito: ${error.message}`);
      }
    });
    return true;
  } catch (error) {
    if (error.code !== 'EPIPE') {
      log('error', `Invio comando backend non riuscito: ${error.message}`);
    }
    return false;
  }
}

function forceStopBackend(proc) {
  try {
    if (!proc.kill()) {
      log('error', 'Windows non ha accettato la terminazione forzata del backend.');
    }
  } catch (error) {
    log('error', `Terminazione forzata del backend non riuscita: ${error.message}`);
  }
}

function stopBackend() {
  const proc = backend;
  if (!proc || proc.exitCode !== null) return Promise.resolve();
  if (backendStopPromise) return backendStopPromise;

  quitting = true;
  pendingReplayStart = false;
  backendStopPromise = new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (proc.exitCode === null) {
        log('error', 'Timeout arrestando il backend; termino il processo forzatamente.');
        forceStopBackend(proc);
      }
    }, 15000);

    proc.once('close', () => {
      clearTimeout(timeout);
      backendStopPromise = null;
      resolve();
    });

    if (!writeCommandToProcess(proc, 'Q')) {
      log('error', 'Impossibile inviare il comando di chiusura al backend; termino il processo.');
      forceStopBackend(proc);
    }
  });
  return backendStopPromise;
}

async function stopServices() {
  quitting = true;
  pendingReplayStart = false;
  if (obsEngine?.running) await obsEngine.stop();
  await stopBackend();
}

function currentConfiguration() {
  return {
    bufferSeconds: configuredBufferSeconds,
    captureMode,
    captureWindowTitle,
    captureWindowTarget,
    zoomSettings: { ...zoomSettings },
    audioSettings: { ...audioSettings },
  };
}

function syncPendingConfiguration() {
  if (!captureReady || !obsEngine?.running) return;

  launchedConfiguration = currentConfiguration();
  return obsEngine.applySettings(launchedConfiguration);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 700,
    frame: false,
    backgroundColor: '#0b0d12',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    title: `ShadowStream ${app.getVersion()}`,
    autoHideMenuBar: true,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.once('did-finish-load', () => {
    if (!app.isPackaged && process.argv.includes('--devtools')) {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
    startBackend();
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

async function getPreviewSource(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error('Richiesta anteprima non autorizzata.');
  }

  const isWindowCapture = captureMode === 'window' && captureWindowTitle;
  const sources = await desktopCapturer.getSources({
    types: [isWindowCapture ? 'window' : 'screen'],
    thumbnailSize: { width: 1, height: 1 },
    fetchWindowIcons: false,
  });

  const source = isWindowCapture
    ? sources.find((item) => item.name === captureWindowTitle)
      || sources.find((item) => item.name.includes(captureWindowTitle))
    : sources.find((item) => item.display_id === String(screen.getPrimaryDisplay().id))
      || sources.find((item) => item.id.startsWith('screen:'));

  if (!source) {
    throw new Error(isWindowCapture
      ? `Finestra non disponibile per l'anteprima: ${captureWindowTitle}`
      : 'Schermo principale non disponibile per l’anteprima.');
  }
  return { id: source.id, name: source.name };
}

function configureUpdater() {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = true;

  autoUpdater.on('checking-for-update', () => {
    log('update', 'Controllo aggiornamenti beta…');
    send('update:status', { state: 'checking' });
  });
  autoUpdater.on('update-not-available', () => {
    log('update', 'ShadowStream è aggiornato.');
    send('update:status', { state: 'not-available' });
  });
  autoUpdater.on('error', (error) => {
    log('error', `Aggiornamento non riuscito: ${error.message}`);
    send('update:status', { state: 'error', message: error.message });
  });
  autoUpdater.on('download-progress', (progress) => {
    send('update:status', { state: 'downloading', percent: Math.round(progress.percent) });
  });
  autoUpdater.on('update-available', (info) => {
    log('update', `Disponibile la versione ${info.version}.`);
    send('update:status', { state: 'available', version: info.version });
  });
  autoUpdater.on('update-downloaded', async (info) => {
    send('update:status', { state: 'downloaded', version: info.version });
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['Installa e riavvia', 'Più tardi'],
      defaultId: 0,
      cancelId: 1,
      title: 'Aggiornamento pronto',
      message: `La versione ${info.version} è stata scaricata.`,
      detail: 'L’installazione chiuderà ShadowStream e lo riavvierà.',
    });
    if (result.response === 0) installDownloadedUpdate();
  });
}

async function installDownloadedUpdate() {
  quitting = true;
  await stopServices();
  autoUpdater.quitAndInstall();
}

function checkForUpdates() {
  if (!app.isPackaged) {
    log('update', 'Il controllo aggiornamenti è disponibile nella versione installata.');
    send('update:status', { state: 'unsupported' });
    return Promise.resolve(false);
  }

  if (updateCheckPromise) return updateCheckPromise;

  updateCheckPromise = autoUpdater.checkForUpdates()
    .then(() => true)
    .catch((error) => {
      log('error', `Controllo aggiornamenti non riuscito: ${error.message}`);
      send('update:status', { state: 'error', message: error.message });
      return false;
    })
    .finally(() => {
      updateCheckPromise = null;
    });
  return updateCheckPromise;
}

function downloadUpdate() {
  if (!app.isPackaged) return Promise.resolve(false);
  send('update:status', { state: 'downloading', percent: 0 });
  return autoUpdater.downloadUpdate()
    .then(() => true)
    .catch((error) => {
      log('error', `Download aggiornamento non riuscito: ${error.message}`);
      send('update:status', { state: 'error', message: error.message });
      return false;
    });
}

function requestReplayStart(opts) {
  quitting = false;
  if (opts && isValidBufferSeconds(opts.bufferSeconds)) {
    configuredBufferSeconds = opts.bufferSeconds;
    saveReplaySettings();
  }
  if (!isBackendRunning()) startBackend();
  if (captureReady && !captureRunning && !recording) {
    void obsEngine.setBufferSeconds(configuredBufferSeconds)
      .then(() => obsEngine.startReplay())
      .catch((error) => log('error', `Avvio Instant Replay non riuscito: ${error.message}`));
  } else if (!captureReady) {
    pendingReplayStart = true;
    startObsEngine();
  }
  return true;
}

ipcMain.handle('backend:start', (_event, opts) => requestReplayStart(opts));
ipcMain.handle('backend:toggle-replay', (_event, opts) => {
  if (captureRunning && !recording) {
    pendingReplayStart = false;
    return obsEngine.stopReplay().catch((error) => {
      log('error', `Arresto Instant Replay non riuscito: ${error.message}`);
      return false;
    });
  }
  if (recording) return false;
  return requestReplayStart(opts);
});
ipcMain.handle('backend:stop', () => {
  pendingReplayStart = false;
  return captureReady ? obsEngine.stopReplay().catch((error) => {
    log('error', `Arresto Instant Replay non riuscito: ${error.message}`);
    return false;
  }) : true;
});
ipcMain.handle('backend:save', () => {
  if (!captureReady) {
    log('error', 'OBS non è pronto: impossibile salvare la clip.');
    return false;
  }
  return obsEngine.saveReplay().catch((error) => {
    log('error', `Salvataggio clip non riuscito: ${error.message}`);
    return false;
  });
});
ipcMain.handle('backend:record', () => captureReady
  ? obsEngine.toggleRecording().catch((error) => {
    log('error', `Registrazione OBS non riuscita: ${error.message}`);
    return false;
  })
  : false);
ipcMain.handle('backend:restart', (_event, opts) => {
  if (opts && isValidBufferSeconds(opts.bufferSeconds)) {
    configuredBufferSeconds = opts.bufferSeconds;
    saveReplaySettings();
  }
  if (!captureReady && obsEngine?.running && !obsEngine?.connecting) void configureObsEngine();
  else if (!captureReady) startObsEngine();
  else void syncPendingConfiguration()
    .then(() => !captureRunning && !recording ? obsEngine.startReplay() : true)
    .catch((error) => log('error', `Aggiornamento cattura non riuscito: ${error.message}`));
  return true;
});
ipcMain.handle('backend:quit', () => { void stopServices(); return true; });
ipcMain.handle('backend:status:get', () => ({
  running: captureRunning && !recording,
  recording,
  processRunning: isBackendRunning() || Boolean(obsEngine?.running),
  pid: obsEngine?.pid || (backend ? backend.pid : null),
}));
ipcMain.handle('backend:get-buffer-seconds', () => configuredBufferSeconds);
ipcMain.handle('backend:get-capture-settings', () => ({
  mode: captureMode,
  windowTarget: captureWindowTarget,
}));
ipcMain.handle('backend:get-zoom-settings', () => ({ ...zoomSettings }));
ipcMain.handle('capture:preview-source', getPreviewSource);
ipcMain.handle('updates:check', checkForUpdates);
ipcMain.handle('updates:download', downloadUpdate);
ipcMain.handle('backend:get-audio-settings', () => audioSettings);
ipcMain.handle('window:minimize', () => mainWindow?.minimize());
ipcMain.handle('window:toggle-maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.handle('window:close', () => mainWindow?.close());

ipcMain.handle('backend:set-buffer-seconds', (_event, seconds) => {
  if (isValidBufferSeconds(seconds)) {
    configuredBufferSeconds = seconds;
    saveReplaySettings();
    if (captureReady) void obsEngine.setBufferSeconds(seconds)
      .catch((error) => log('error', `Aggiornamento durata buffer non riuscito: ${error.message}`));
  } else {
    log('error', `Durata Instant Replay non valida: ${seconds}`);
    return false;
  }
  return true;
});

ipcMain.handle('backend:set-zoom-settings', (_event, settings) => {
  if (!isValidZoomSettings(settings)) {
    log('error', 'Impostazioni zoom non valide.');
    return false;
  }
  zoomSettings = normalizeZoomSettings(settings);
  saveZoomSettings();
  if (captureReady) void obsEngine.setZoom(zoomSettings)
    .catch((error) => log('error', `Aggiornamento zoom OBS non riuscito: ${error.message}`));
  return true;
});

ipcMain.handle('backend:set-capture-mode', async (_event, mode, windowTarget) => {
  if (mode !== 'display' && mode !== 'window') {
    log('error', `Modalità di cattura non valida: ${mode}`);
    return false;
  }
  const useWindow = mode === 'window';
  const targetIsValid = windowTarget
    && typeof windowTarget.title === 'string'
    && typeof windowTarget.className === 'string'
    && typeof windowTarget.executable === 'string';
  if (useWindow && (!targetIsValid
    || !windowTarget.title || !windowTarget.className || !windowTarget.executable)) {
    log('error', 'Impossibile selezionare la finestra: metadati di cattura non validi.');
    return false;
  }
  captureMode = useWindow ? 'window' : 'display';
  captureWindowTarget = useWindow ? {
    title: windowTarget.title.replace(/[\r\n]/g, ' ').slice(0, 512),
    className: windowTarget.className.replace(/[\r\n]/g, ' ').slice(0, 256),
    executable: windowTarget.executable.replace(/[\r\n]/g, ' ').slice(0, 256),
  } : null;
  captureWindowTitle = captureWindowTarget?.title || '';
  saveCaptureSettings();
  if (captureReady) {
    const requestedMode = captureMode;
    const requestedTarget = captureWindowTarget;
    const applyMode = captureModeQueue.then(async () => {
      await obsEngine.setCaptureMode(requestedMode, requestedTarget);
      await obsEngine.setZoom(zoomSettings);
    });
    captureModeQueue = applyMode.catch(() => {});
    try {
      await applyMode;
    } catch (error) {
      log('error', `Cambio sorgente di cattura non riuscito: ${error.message}`);
      throw error;
    }
  }
  return true;
});

ipcMain.handle('backend:get-windows', () => {
  sendCommand('W');
  return true;
});

ipcMain.handle('backend:get-audio-devices', () => {
  sendCommand('AUDIODEVICES');
  return true;
});

ipcMain.handle('backend:set-audio-devices', (_event, settings) => {
  if (!settings || typeof settings !== 'object'
    || (settings.outputDeviceId !== null && typeof settings.outputDeviceId !== 'string')
    || (settings.inputDeviceId !== null && typeof settings.inputDeviceId !== 'string')
    || (typeof settings.outputDeviceId === 'string' && settings.outputDeviceId.length > 512)
    || (typeof settings.inputDeviceId === 'string' && settings.inputDeviceId.length > 512)
    || typeof settings.systemAudioEnabled !== 'boolean'
    || typeof settings.microphoneEnabled !== 'boolean'
    || (settings.systemVolume !== undefined && !isValidAudioVolume(settings.systemVolume))
    || (settings.microphoneVolume !== undefined && !isValidAudioVolume(settings.microphoneVolume))) {
    log('error', 'Selezione dei dispositivi audio non valida.');
    return false;
  }

  audioSettings = {
    outputDeviceId: settings.outputDeviceId || null,
    inputDeviceId: settings.inputDeviceId || null,
    systemAudioEnabled: settings.systemAudioEnabled,
    microphoneEnabled: settings.microphoneEnabled,
    systemVolume: settings.systemVolume ?? audioSettings.systemVolume,
    microphoneVolume: settings.microphoneVolume ?? audioSettings.microphoneVolume,
  };
  saveAudioSettings();
  if (captureReady) {
    const requestedSettings = { ...audioSettings };
    const update = audioSettingsQueue.then(() => obsEngine.setAudioDevices(requestedSettings));
    audioSettingsQueue = update.catch(() => {});
    void update.catch((error) => log('error', `Cambio dispositivo audio OBS non riuscito: ${error.message}`));
  }
  if (captureReady) {
    const encoded = Buffer.from(JSON.stringify(audioSettings), 'utf8').toString('base64');
    sendCommand(`A ${encoded}`);
  }
  return true;
});

ipcMain.handle('backend:set-audio-volumes', (_event, volumes) => {
  if (!volumes || typeof volumes !== 'object'
    || !isValidAudioVolume(volumes.systemVolume)
    || !isValidAudioVolume(volumes.microphoneVolume)) {
    log('error', 'Livelli volume audio non validi.');
    return false;
  }

  audioSettings = {
    ...audioSettings,
    systemVolume: volumes.systemVolume,
    microphoneVolume: volumes.microphoneVolume,
  };
  saveAudioSettings();

  if (!captureReady) return true;

  const requestedVolumes = {
    systemVolume: audioSettings.systemVolume,
    microphoneVolume: audioSettings.microphoneVolume,
  };
  const update = audioSettingsQueue.then(() => obsEngine.setAudioVolumes(requestedVolumes));
  audioSettingsQueue = update.catch(() => {});
  return update.then(() => true).catch((error) => {
    log('error', `Aggiornamento volume audio OBS non riuscito: ${error.message}`);
    return false;
  });
});

ipcMain.on('open-clips', () => {
  fs.mkdirSync(CLIPS_PATH, { recursive: true });
  shell.openPath(CLIPS_PATH).then((error) => {
    if (error) throw new Error(error);
  }).catch(err => {
    console.error('Failed to open clips path:', err);
  });
});

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    loadAudioSettings();
    loadReplaySettings();
    loadCaptureSettings();
    loadZoomSettings();
    configureUpdater();
    session.defaultSession.setPermissionCheckHandler((webContents, permission, _origin, details) => (
      permission === 'display-capture'
      && webContents === mainWindow?.webContents
      && details.isMainFrame
      && details.requestingUrl === webContents.getURL()
    ));
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
      callback(
        permission === 'display-capture'
        && webContents === mainWindow?.webContents
        && details.isMainFrame
        && details.requestingUrl === webContents.getURL(),
      );
    });
    createWindow();
    if (app.isPackaged) {
      setTimeout(() => checkForUpdates(), 3000);
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', (event) => {
    quitting = true;
    if ((!backend || backend.exitCode !== null) && !obsEngine?.running) return;

    event.preventDefault();
    void stopServices().then(() => app.quit());
  });

  process.on('exit', () => {
    if (backend && backend.exitCode === null) {
      try { backend.kill(); } catch { /* ignore */ }
    }
    if (obsEngine?.running) {
      try { obsEngine.process.kill(); } catch { /* ignore */ }
    }
  });
}
