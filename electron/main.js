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
  safeStorage,
} = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');
const ObsEngine = require('./obs-engine');
const { applyGainToMeterLevel } = require('./audio-meter');
const { RtmpRelay } = require('./streaming/rtmp-relay');
const { createDestinationStore } = require('./streaming/destination-store');
const { authorizeYoutube } = require('./streaming/youtube-oauth');
const { getYoutubeStreamIngest, listYoutubeStreams } = require('./streaming/youtube-api');

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
let destinationStore = null;
let streamRelay = null;
let streamStartPromise = null;
let streamStopPromise = null;
let liveDestinations = [];
let youtubeOAuthPromise = null;
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
let updateDownloadPromise = null;
let updateDownloaded = false;
let mandatoryUpdateVersion = null;
let audioSettingsQueue = Promise.resolve();
const pendingBackendCommands = [];
let audioSettings = {
  outputDeviceId: null,
  inputDeviceId: null,
  systemAudioEnabled: true,
  microphoneEnabled: true,
  systemVolume: DEFAULT_AUDIO_VOLUME,
  microphoneVolume: DEFAULT_AUDIO_VOLUME,
};
const DEFAULT_WEBCAM_SETTINGS = {
  enabled: false,
  deviceId: null,
  x: 1480,
  y: 1100,
  width: 480,
  height: 270,
  chromaKeyEnabled: false,
  borderEnabled: false,
  borderColor: '#ffffff',
};
let webcamSettings = { ...DEFAULT_WEBCAM_SETTINGS };

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

function webcamSettingsPath() {
  return path.join(app.getPath('userData'), 'webcam-settings.json');
}

function streamingSettingsPath() {
  return path.join(app.getPath('userData'), 'streaming-settings.json');
}

function getDestinationStore() {
  if (!destinationStore) {
    destinationStore = createDestinationStore({
      filePath: streamingSettingsPath(),
      safeStorage,
    });
  }
  return destinationStore;
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

function isValidWebcamSettings(settings) {
  return settings && typeof settings === 'object'
    && typeof settings.enabled === 'boolean'
    && (settings.deviceId === null || (typeof settings.deviceId === 'string' && settings.deviceId.length <= 512))
    && Number.isInteger(settings.x) && settings.x >= 0 && settings.x <= 3440
    && Number.isInteger(settings.y) && settings.y >= 0 && settings.y <= 1440
    && Number.isInteger(settings.width) && settings.width >= 160 && settings.width <= 1720
    && Number.isInteger(settings.height) && settings.height >= 90 && settings.height <= 960
    && settings.x + settings.width <= 3440
    && settings.y + settings.height <= 1440
    && typeof settings.chromaKeyEnabled === 'boolean'
    && typeof settings.borderEnabled === 'boolean'
    && typeof settings.borderColor === 'string'
    && /^#[0-9a-fA-F]{6}$/.test(settings.borderColor);
}

function loadWebcamSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(webcamSettingsPath(), 'utf8'));
    if (isValidWebcamSettings(saved)) {
      webcamSettings = { ...DEFAULT_WEBCAM_SETTINGS, ...saved };
    } else {
      log('error', 'Impostazioni webcam salvate non valide; uso i valori predefiniti.');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      log('error', `Impossibile leggere le impostazioni webcam: ${error.message}`);
    }
  }
}

function saveWebcamSettings() {
  fs.mkdirSync(path.dirname(webcamSettingsPath()), { recursive: true });
  fs.writeFileSync(webcamSettingsPath(), JSON.stringify(webcamSettings, null, 2), 'utf8');
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
            system: applyGainToMeterLevel(levels.system, audioSettings.systemVolume),
            microphone: applyGainToMeterLevel(levels.microphone, audioSettings.microphoneVolume),
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
    const pendingCommands = pendingBackendCommands.splice(0);
    for (const command of pendingCommands) sendCommand(command);
    if (!pendingCommands.includes('AUDIODEVICES')) sendCommand('AUDIODEVICES');
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
    if (webcamSettings.enabled) {
      try {
        await obsEngine.setWebcamSettings(webcamSettings);
      } catch (error) {
        log('error', `Ripristino webcam non riuscito: ${error.message}`);
      }
    }
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
  if (quitting) {
    log('error', 'Backend non attivo: impossibile inviare il comando.');
    return false;
  }
  if (!isBackendRunning() || !backend.stdin || !backend.stdin.writable) {
    if (cmd === 'W' || cmd === 'AUDIODEVICES') {
      if (!pendingBackendCommands.includes(cmd)) pendingBackendCommands.push(cmd);
      return true;
    }
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
  pendingBackendCommands.length = 0;
  try {
    await stopLiveStream();
  } catch (error) {
    log('error', `Arresto della diretta non riuscito: ${error.message}`);
  }
  if (obsEngine?.running) {
    try { await obsEngine.stop(); } catch (error) {
      log('error', `Arresto OBS non riuscito: ${error.message}`);
    }
  }
  await stopBackend();
}

function sendLiveStatus(state, details = {}) {
  send('live:status', { state, ...details });
}

function verifyFfmpeg(ffmpegPath) {
  if (!fs.existsSync(ffmpegPath) || !fs.statSync(ffmpegPath).isFile()) {
    throw new Error('FFmpeg non trovato nel percorso selezionato. Seleziona ffmpeg.exe nelle impostazioni Live.');
  }
  return new Promise((resolve, reject) => {
    const process = spawn(ffmpegPath, ['-version'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    const timeout = setTimeout(() => {
      if (process.exitCode === null) process.kill();
      reject(new Error('FFmpeg non ha risposto al controllo di versione.'));
    }, 5000);
    process.once('error', (error) => {
      clearTimeout(timeout);
      reject(new Error(`Impossibile avviare FFmpeg: ${error.message}`));
    });
    process.once('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`Il file selezionato non è un FFmpeg avviabile (exit ${code}).`));
    });
  });
}

function verifyNvenc(ffmpegPath) {
  return new Promise((resolve, reject) => {
    const process = spawn(ffmpegPath, [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'lavfi',
      '-i', 'color=c=black:s=320x240:d=0.1',
      '-frames:v', '1',
      '-c:v', 'h264_nvenc',
      '-f', 'null',
      '-',
    ], {
      windowsHide: true,
      stdio: 'ignore',
    });
    const timeout = setTimeout(() => {
      if (process.exitCode === null) process.kill();
      reject(new Error('Verifica NVENC scaduta. Controlla GPU NVIDIA e driver aggiornati.'));
    }, 10000);
    process.once('error', (error) => {
      clearTimeout(timeout);
      reject(new Error(`Verifica NVENC non riuscita: ${error.message}`));
    });
    process.once('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error('TikTok verticale richiede h264_nvenc funzionante. Controlla GPU NVIDIA, driver e build FFmpeg.'));
    });
  });
}

function connectYoutubeAccount(clientId) {
  if (youtubeOAuthPromise) return youtubeOAuthPromise;
  const store = getDestinationStore();
  youtubeOAuthPromise = authorizeYoutube({ clientId, shell })
    .then((credentials) => {
      store.saveYoutubeCredentials({ clientId, ...credentials });
      return { connected: true };
    })
    .finally(() => { youtubeOAuthPromise = null; });
  return youtubeOAuthPromise;
}

async function getYoutubeAccessToken(forceRefresh = false) {
  const store = getDestinationStore();
  const credentials = store.getYoutubeCredentials();
  const clientId = store.getYoutubeClientId();
  if (!credentials || !clientId) throw new Error('Collega prima un account YouTube.');
  if (!forceRefresh && credentials.expiresAt > Date.now() + 60000) {
    return credentials.accessToken;
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      refresh_token: credentials.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!response.ok) {
    throw new Error(`Aggiornamento token YouTube rifiutato (HTTP ${response.status}). Ricollega l’account.`);
  }
  const token = await response.json();
  if (typeof token.access_token !== 'string' || !Number.isFinite(token.expires_in) || token.expires_in <= 0) {
    throw new Error('YouTube non ha restituito un access token valido.');
  }
  const refreshed = {
    accessToken: token.access_token,
    refreshToken: credentials.refreshToken,
    expiresAt: Date.now() + token.expires_in * 1000,
  };
  store.saveYoutubeCredentials({ clientId, ...refreshed });
  return refreshed.accessToken;
}

async function youtubeApiFetch(url, options = {}) {
  let token = await getYoutubeAccessToken();
  let response = await fetch(url, {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${token}` },
  });
  if (response.status === 401) {
    token = await getYoutubeAccessToken(true);
    response = await fetch(url, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${token}` },
    });
  }
  return response;
}

async function waitForObsReady() {
  if (!obsEngine?.running && !obsEngine?.connecting) startObsEngine();
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (quitting) throw new Error('ShadowStream si sta chiudendo.');
    if (captureReady && obsEngine?.running) return;
    if (!obsEngine?.running && !obsEngine?.connecting) {
      throw new Error('Il motore OBS non è riuscito ad avviarsi.');
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Timeout attendendo che il motore OBS sia pronto.');
}

async function startLiveStream() {
  if (quitting) throw new Error('ShadowStream si sta chiudendo.');
  if (streamRelay) throw new Error('Una diretta ShadowStream è già in corso.');
  const store = getDestinationStore();
  const ffmpegPath = store.getFfmpegPath();
  if (!ffmpegPath) throw new Error('Seleziona ffmpeg.exe nelle impostazioni Live prima di avviare.');
  await verifyFfmpeg(ffmpegPath);
  const destinations = store.getConfiguredDestinations();
  if (destinations.length === 0) throw new Error('Configura e salva almeno una piattaforma RTMP.');
  if (destinations.some(({ platform }) => platform === 'tiktok')) await verifyNvenc(ffmpegPath);

  sendLiveStatus('starting', { platforms: destinations.map(({ name }) => name) });
  await waitForObsReady();

  const relay = new RtmpRelay({ ffmpegPath, log });
  streamRelay = relay;
  relay.once('exit', (result) => {
    if (streamRelay !== relay) return;
    streamRelay = null;
    liveDestinations = [];
    if (obsEngine?.streaming) {
      void obsEngine.stopStream().catch((error) => log('error', `Arresto OBS dopo l'uscita del relay non riuscito: ${error.message}`));
    }
    log('error', `Il relay FFmpeg si è arrestato inaspettatamente (exit ${result.code ?? result.signal}).`);
    sendLiveStatus('error', { message: 'Relay FFmpeg interrotto. Verifica le destinazioni RTMP.' });
  });

  try {
    const service = await relay.start(destinations, {
      verticalCropX: store.getVerticalCropX(),
    });
    if (quitting) throw new Error('ShadowStream si sta chiudendo.');
    await obsEngine.startStream(service);
    if (streamRelay !== relay || !relay.running) {
      throw new Error('Il relay RTMP si è interrotto durante l’avvio della diretta.');
    }
    liveDestinations = destinations.map(({ name }) => name);
    sendLiveStatus('live', { platforms: liveDestinations });
    return true;
  } catch (error) {
    if (streamRelay === relay) streamRelay = null;
    if (obsEngine?.streaming) {
      try { await obsEngine.stopStream(); } catch (stopError) {
        log('error', `Arresto stream OBS dopo errore non riuscito: ${stopError.message}`);
      }
    }
    await relay.stop();
    liveDestinations = [];
    sendLiveStatus('error', { message: error.message });
    throw error;
  }
}

function requestLiveStart() {
  if (streamStartPromise) return streamStartPromise;
  streamStartPromise = startLiveStream()
    .catch((error) => {
      log('error', `Avvio diretta non riuscito: ${error.message}`);
      throw error;
    })
    .finally(() => { streamStartPromise = null; });
  return streamStartPromise;
}

function stopLiveStream() {
  if (streamStopPromise) return streamStopPromise;
  if (!streamRelay && !obsEngine?.streaming && !streamStartPromise) return Promise.resolve(true);
  streamStopPromise = (async () => {
    if (streamStartPromise) await streamStartPromise.catch(() => {});
    sendLiveStatus('stopping', { platforms: liveDestinations });
    let stopError = null;
    if (obsEngine?.streaming) {
      try { await obsEngine.stopStream(); } catch (error) { stopError = error; }
    }
    const relay = streamRelay;
    streamRelay = null;
    liveDestinations = [];
    if (relay) await relay.stop();
    if (stopError) {
      sendLiveStatus('error', { message: stopError.message });
      throw stopError;
    }
    sendLiveStatus('offline');
    return true;
  })().finally(() => { streamStopPromise = null; });
  return streamStopPromise;
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
    mandatoryUpdateVersion = null;
    log('update', 'ShadowStream è aggiornato.');
    send('update:status', { state: 'not-available' });
  });
  autoUpdater.on('error', (error) => {
    log('error', `Aggiornamento non riuscito: ${error.message}`);
    send('update:status', {
      state: 'error',
      message: error.message,
      mandatory: mandatoryUpdateVersion !== null,
    });
  });
  autoUpdater.on('download-progress', (progress) => {
    send('update:status', { state: 'downloading', percent: Math.round(progress.percent) });
  });
  autoUpdater.on('update-available', (info) => {
    mandatoryUpdateVersion = info.version;
    log('update', `Disponibile la versione ${info.version}.`);
    send('update:status', { state: 'available', version: info.version, mandatory: true });
    void downloadUpdate();
  });
  autoUpdater.on('update-downloaded', (info) => {
    updateDownloaded = true;
    send('update:status', { state: 'downloaded', version: info.version });
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
  if (updateDownloadPromise) return updateDownloadPromise;
  updateDownloaded = false;
  send('update:status', { state: 'downloading', percent: 0 });
  updateDownloadPromise = autoUpdater.downloadUpdate()
    .then(() => true)
    .catch((error) => {
      log('error', `Download aggiornamento non riuscito: ${error.message}`);
      send('update:status', {
        state: 'error',
        message: error.message,
        mandatory: mandatoryUpdateVersion !== null,
      });
      return false;
    })
    .finally(() => {
      updateDownloadPromise = null;
    });
  return updateDownloadPromise;
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
ipcMain.handle('updates:install', () => {
  if (!updateDownloaded) {
    log('error', 'Installazione rifiutata: l’aggiornamento non è stato scaricato.');
    return false;
  }
  void installDownloadedUpdate();
  return true;
});
ipcMain.handle('backend:get-audio-settings', () => audioSettings);
ipcMain.handle('live:get-settings', (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('Richiesta Live non autorizzata.');
  return {
    destinations: getDestinationStore().getDestinations(),
    ffmpegPath: getDestinationStore().getFfmpegPath(),
    verticalCropX: getDestinationStore().getVerticalCropX(),
    youtubeClientId: getDestinationStore().getYoutubeClientId(),
    youtubeConnected: Boolean(getDestinationStore().getYoutubeCredentials()),
    webcamSettings: { ...webcamSettings },
  };
});
ipcMain.handle('live:save-destinations', (event, destinations) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('Richiesta Live non autorizzata.');
  return getDestinationStore().saveDestinations(destinations);
});
ipcMain.removeHandler('live:set-vertical-crop');
ipcMain.handle('live:set-vertical-crop', (event, value) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('Richiesta Live non autorizzata.');
  return getDestinationStore().saveVerticalCropX(value);
});
ipcMain.handle('live:youtube-connect', (event, clientId) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('Richiesta OAuth non autorizzata.');
  return connectYoutubeAccount(clientId);
});
ipcMain.handle('live:youtube-streams', async (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('Richiesta YouTube non autorizzata.');
  return listYoutubeStreams('', youtubeApiFetch);
});
ipcMain.handle('live:youtube-use-stream', async (event, streamId) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('Richiesta YouTube non autorizzata.');
  const ingest = await getYoutubeStreamIngest('', streamId, youtubeApiFetch);
  const destinations = getDestinationStore().saveSingleDestination({
    platform: 'youtube',
    server: ingest.server,
    key: ingest.key,
  });
  return destinations.find((destination) => destination.platform === 'youtube');
});
ipcMain.handle('live:webcam-devices', async (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('Richiesta webcam non autorizzata.');
  await waitForObsReady();
  return obsEngine.getWebcamDevices();
});
ipcMain.handle('live:set-webcam-settings', async (event, settings) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('Richiesta webcam non autorizzata.');
  if (!isValidWebcamSettings(settings)) throw new TypeError('Impostazioni webcam non valide.');
  await waitForObsReady();
  await obsEngine.setWebcamSettings(settings);
  webcamSettings = { ...settings };
  saveWebcamSettings();
  return { ...webcamSettings };
});
ipcMain.handle('live:select-ffmpeg', async (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('Richiesta Live non autorizzata.');
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Seleziona ffmpeg.exe',
    properties: ['openFile'],
    filters: [{ name: 'FFmpeg', extensions: ['exe'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const ffmpegPath = result.filePaths[0];
  if (path.basename(ffmpegPath).toLowerCase() !== 'ffmpeg.exe') {
    throw new Error('Seleziona il file ffmpeg.exe.');
  }
  await verifyFfmpeg(ffmpegPath);
  return getDestinationStore().saveFfmpegPath(ffmpegPath);
});
ipcMain.handle('live:start', (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('Richiesta Live non autorizzata.');
  return requestLiveStart();
});
ipcMain.handle('live:stop', (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('Richiesta Live non autorizzata.');
  return stopLiveStream();
});
ipcMain.handle('live:get-status', async (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('Richiesta Live non autorizzata.');
  if (!streamRelay || !obsEngine?.streaming) return { state: 'offline' };
  const status = await obsEngine.request('GetStreamStatus');
  if (!status.outputActive) {
    await stopLiveStream();
    return {
      state: 'error',
      message: 'OBS ha interrotto la diretta; il relay locale è stato fermato.',
    };
  }
  const outputDuration = status.outputDuration;
  const bitrateKbps = Number.isFinite(outputDuration) && outputDuration > 0
    && Number.isFinite(status.outputBytes)
    ? Math.round((status.outputBytes * 8) / outputDuration)
    : null;
  return {
    state: status.outputActive ? 'live' : 'error',
    bitrateKbps,
    platforms: liveDestinations,
  };
});
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

ipcMain.handle('backend:set-audio-devices', async (_event, settings) => {
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

  const requestedSettings = {
    outputDeviceId: settings.outputDeviceId || null,
    inputDeviceId: settings.inputDeviceId || null,
    systemAudioEnabled: settings.systemAudioEnabled,
    microphoneEnabled: settings.microphoneEnabled,
    systemVolume: settings.systemVolume ?? audioSettings.systemVolume,
    microphoneVolume: settings.microphoneVolume ?? audioSettings.microphoneVolume,
  };
  if (captureReady) {
    const update = audioSettingsQueue.then(() => obsEngine.setAudioDevices(requestedSettings));
    audioSettingsQueue = update.catch(() => {});
    try {
      await update;
    } catch (error) {
      log('error', `Cambio dispositivo audio OBS non riuscito: ${error.message}`);
      throw error;
    }
  }
  audioSettings = requestedSettings;
  saveAudioSettings();
  if (captureReady) {
    const encoded = Buffer.from(JSON.stringify(audioSettings), 'utf8').toString('base64');
    sendCommand(`A ${encoded}`);
  }
  return true;
});

ipcMain.handle('backend:set-audio-volumes', async (_event, volumes) => {
  if (!volumes || typeof volumes !== 'object'
    || !isValidAudioVolume(volumes.systemVolume)
    || !isValidAudioVolume(volumes.microphoneVolume)) {
    log('error', 'Livelli volume audio non validi.');
    return false;
  }

  const requestedSettings = {
    ...audioSettings,
    systemVolume: volumes.systemVolume,
    microphoneVolume: volumes.microphoneVolume,
  };

  if (captureReady) {
    const update = audioSettingsQueue.then(() => obsEngine.setAudioVolumes(requestedSettings));
    audioSettingsQueue = update.catch(() => {});
    try {
      await update;
    } catch (error) {
      log('error', `Aggiornamento volume audio OBS non riuscito: ${error.message}`);
      throw error;
    }
  }
  audioSettings = requestedSettings;
  saveAudioSettings();
  return true;
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
    loadWebcamSettings();
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
    if ((!backend || backend.exitCode !== null) && !obsEngine?.running
      && !obsEngine?.connecting && !streamRelay && !streamStartPromise) return;

    event.preventDefault();
    void stopServices().then(() => app.quit());
  });

  process.on('exit', () => {
    if (backend && backend.exitCode === null) {
      try { backend.kill(); } catch { /* ignore */ }
    }
    if (streamRelay?.process && streamRelay.process.exitCode === null) {
      try { streamRelay.process.kill(); } catch { /* ignore */ }
    }
    if (obsEngine?.running) {
      try { obsEngine.process.kill(); } catch { /* ignore */ }
    }
  });
}
