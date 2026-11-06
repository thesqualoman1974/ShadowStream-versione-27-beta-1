'use strict';

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const PROFILE_NAME = 'ShadowStream';
const COLLECTION_NAME = 'ShadowStream';
const SCENE_NAME = 'ShadowStream';
const DESKTOP_AUDIO_NAME = 'Audio del desktop';
const MICROPHONE_NAME = 'Microfono/disp. ausiliario';
const AUDIO_SAMPLE_RATE_HZ = 48000;
const AUDIO_BITRATE_KBPS = 192;
const AUDIO_TRACK_COUNT = 6;
const VIDEO_FPS = 60;
const OBS_NOT_READY_STATUS = 601;
const OBS_READY_TIMEOUT_MS = 30000;

function encodeObsWindowPart(value) {
  return value.replace(/#/g, '#22').replace(/:/g, '#3A');
}

class ObsEngine extends EventEmitter {
  constructor({ userDataPath, clipsPath, log }) {
    super();
    this.userDataPath = userDataPath;
    this.clipsPath = clipsPath;
    this.log = log;
    this.process = null;
    this.socket = null;
    this.connecting = false;
    this.requestCounter = 0;
    this.pendingRequests = new Map();
    this.authentication = null;
    this.wsPort = null;
    this.replayRunning = false;
    this.recording = false;
    this.wasReplayRunning = false;
    this.windowTitle = '';
    this.readyOnce = false;
    this.hardlinkCount = 0;
    this.copyCount = 0;
    this.stopRequested = false;
    this.zoomBaselines = new Map();
    this.zoomQueue = Promise.resolve();
    this.activeCaptureMode = 'display';
    this.zoomBaselinesPath = path.join(this.userDataPath, 'zoom-transform-baselines.json');
    if (fs.existsSync(this.zoomBaselinesPath)) {
      try {
        const baselines = JSON.parse(fs.readFileSync(this.zoomBaselinesPath, 'utf8'));
        for (const [id, transform] of Object.entries(baselines)) {
          if (Number.isInteger(Number(id)) && transform && Number.isFinite(transform.scaleX)
            && Number.isFinite(transform.scaleY)) {
            this.zoomBaselines.set(Number(id), transform);
          }
        }
      } catch (error) {
        this.log('error', `Impossibile leggere le trasformazioni base dello zoom: ${error.message}`);
      }
    }
  }

  get pid() {
    return this.process?.pid ?? null;
  }

  get running() {
    return this.process !== null && this.process.exitCode === null;
  }

  async start() {
    if (this.running || this.connecting) return;
    this.connecting = true;
    this.readyOnce = false;
    this.stopRequested = false;
    try {
      const { executable, configDirectory } = this.prepareRuntime();
      if (this.stopRequested) return;
      this.wsPort = await this.findFreePort();
      this.authentication = this.prepareWebSocketConfig(configDirectory, this.wsPort);
      if (this.stopRequested) return;
      this.log('system', 'Avvio OBS dedicato in modalità minimizzata…');
      const obsProcess = spawn(executable, [
        '--portable',
        '--multi',
        '--profile', PROFILE_NAME,
        '--collection', COLLECTION_NAME,
        '--minimize-to-tray',
      ], {
        cwd: path.dirname(executable),
        stdio: 'ignore',
        windowsHide: true,
      });
      this.process = obsProcess;
      obsProcess.once('spawn', () => {
        try {
          os.setPriority(obsProcess.pid, os.constants.priority.PRIORITY_ABOVE_NORMAL);
          this.log('system', 'Priorità del processo OBS impostata su superiore al normale.');
        } catch (error) {
          this.log('error', `Impossibile aumentare la priorità del processo OBS: ${error.message}`);
        }
      });

      obsProcess.once('error', (error) => {
        this.log('error', `Avvio OBS non riuscito: ${error.message}`);
        if (this.process === obsProcess) this.resetProcess();
      });
      obsProcess.once('close', (code, signal) => {
        this.log('system', `OBS terminato (exit ${code}${signal ? `, ${signal}` : ''}).`);
        if (this.process === obsProcess) {
          this.resetProcess();
          this.emit('closed', this.readyOnce);
        }
      });

      await this.connectWithRetry();
      await this.configureInitialState();
      this.readyOnce = true;
      this.emit('ready');
      this.log('system', `OBS pronto (pid ${this.pid}); profilo isolato "${PROFILE_NAME}".`);
    } catch (error) {
      this.connecting = false;
      if (this.stopRequested) return;
      this.log('error', `Motore OBS non avviato: ${error.message}`);
      if (this.running) {
        try { this.process.kill(); } catch { /* process is already closing */ }
      }
      throw error;
    } finally {
      this.connecting = false;
    }
  }

  async stop() {
    this.stopRequested = true;
    const proc = this.process;
    if (!proc || proc.exitCode !== null) return;
    try {
      const replay = await this.request('GetReplayBufferStatus');
      if (replay.outputActive) {
        await this.request('StopReplayBuffer');
        await this.waitForOutputState('GetReplayBufferStatus', false, 'Instant Replay');
      }
    } catch (error) {
      this.log('error', `Arresto Instant Replay OBS non riuscito: ${error.message}`);
    }
    try {
      const record = await this.request('GetRecordStatus');
      if (record.outputActive) {
        await this.request('StopRecord');
        await this.waitForOutputState('GetRecordStatus', false, 'registrazione');
      }
    } catch (error) {
      this.log('error', `Arresto registrazione OBS non riuscito: ${error.message}`);
    }
    await this.requestWindowClose(proc.pid);
    await new Promise((resolve) => {
      if (proc.exitCode !== null) return resolve();
      const timeout = setTimeout(() => {
        if (proc.exitCode === null) {
          this.log('error', 'Timeout chiudendo OBS; termino il processo.');
          try { proc.kill(); } catch { /* process is already closing */ }
        }
      }, 15000);
      proc.once('close', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  async requestWindowClose(pid) {
    if (process.platform !== 'win32' || !Number.isInteger(pid)) return;
    const script = [
      `$targetPid = ${pid}`,
      "Add-Type -TypeDefinition @'",
      'using System;',
      'using System.Runtime.InteropServices;',
      'public static class ShadowStreamWindowClose {',
      '  public delegate bool EnumWindowsProc(IntPtr handle, IntPtr state);',
      '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr state);',
      '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);',
      '  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);',
      '}',
      "'@",
      '$script:postedClose = $false',
      '$callback = [ShadowStreamWindowClose+EnumWindowsProc] {',
      '  param($handle, $state)',
      '  [uint32]$ownerPid = 0',
      '  [void][ShadowStreamWindowClose]::GetWindowThreadProcessId($handle, [ref]$ownerPid)',
      '  if ($ownerPid -eq $targetPid) {',
      '    $script:postedClose = [ShadowStreamWindowClose]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)',
      '    return $false',
      '  }',
      '  return $true',
      '}',
      '[void][ShadowStreamWindowClose]::EnumWindows($callback, [IntPtr]::Zero)',
      'if (-not $script:postedClose) { exit 2 }',
    ].join('\n');
    await new Promise((resolve) => {
      const closer = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        stdio: 'ignore',
        windowsHide: true,
      });
      closer.once('error', (error) => {
        this.log('error', `Invio chiusura finestra OBS non riuscito: ${error.message}`);
        resolve();
      });
      closer.once('close', (code) => {
        if (code !== 0) this.log('error', 'Chiusura finestra OBS non confermata; attendo la terminazione del processo.');
        resolve();
      });
    });
  }

  async startReplay() {
    const [replay, record] = await Promise.all([
      this.request('GetReplayBufferStatus'),
      this.request('GetRecordStatus'),
    ]);
    this.replayRunning = Boolean(replay.outputActive);
    this.recording = Boolean(record.outputActive);
    if (this.recording || this.replayRunning) return false;
    await this.request('StartReplayBuffer');
    await this.waitForOutputState('GetReplayBufferStatus', true, 'Instant Replay');
    this.replayRunning = true;
    this.emit('status');
    return true;
  }

  async stopReplay() {
    const status = await this.request('GetReplayBufferStatus');
    if (!status.outputActive) {
      this.replayRunning = false;
      this.emit('status');
      return true;
    }
    await this.request('StopReplayBuffer');
    await this.waitForOutputState('GetReplayBufferStatus', false, 'Instant Replay');
    this.replayRunning = false;
    this.emit('status');
    return true;
  }

  async saveReplay() {
    this.replayRunning = Boolean((await this.request('GetReplayBufferStatus')).outputActive);
    if (!this.replayRunning) throw new Error('Instant Replay non è attivo.');
    await this.request('SaveReplayBuffer');
    return true;
  }

  async toggleRecording() {
    this.recording = Boolean((await this.request('GetRecordStatus')).outputActive);
    if (this.recording) {
      await this.request('StopRecord');
      await this.waitForOutputState('GetRecordStatus', false, 'registrazione');
      this.recording = false;
      this.emit('status');
      if (this.wasReplayRunning) {
        this.wasReplayRunning = false;
        await this.startReplay();
      }
      return true;
    }

    this.replayRunning = Boolean((await this.request('GetReplayBufferStatus')).outputActive);
    this.wasReplayRunning = this.replayRunning;
    if (this.replayRunning) await this.stopReplay();
    try {
      await this.request('StartRecord');
      await this.waitForOutputState('GetRecordStatus', true, 'registrazione');
    } catch (error) {
      if (this.wasReplayRunning) {
        this.wasReplayRunning = false;
        try { await this.startReplay(); } catch (resumeError) {
          this.log('error', `Ripresa Instant Replay dopo l'errore di registrazione non riuscita: ${resumeError.message}`);
        }
      }
      throw error;
    }
    this.recording = true;
    this.emit('status');
    return true;
  }

  async setBufferSeconds(seconds) {
    const deadline = Date.now() + OBS_READY_TIMEOUT_MS;
    while (true) {
      try {
        await this.request('SetProfileParameter', {
          parameterCategory: 'SimpleOutput',
          parameterName: 'RecRBTime',
          parameterValue: String(seconds),
        });
        return;
      } catch (error) {
        if (error.obsStatusCode !== OBS_NOT_READY_STATUS) throw error;
        if (Date.now() >= deadline) {
          throw new Error(`OBS non è pronto dopo ${OBS_READY_TIMEOUT_MS / 1000} secondi: ${error.message}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }

  async setAudioDevices(settings) {
    const desktopId = settings.systemAudioEnabled
      ? settings.outputDeviceId || 'default'
      : 'default';
    const microphoneId = settings.microphoneEnabled
      ? settings.inputDeviceId || 'default'
      : 'default';
    await Promise.all([
      this.request('SetInputSettings', {
        inputName: DESKTOP_AUDIO_NAME,
        inputSettings: { device_id: desktopId },
        overlay: true,
      }),
      this.request('SetInputSettings', {
        inputName: MICROPHONE_NAME,
        inputSettings: { device_id: microphoneId },
        overlay: true,
      }),
      this.request('SetInputMute', {
        inputName: DESKTOP_AUDIO_NAME,
        inputMuted: !settings.systemAudioEnabled,
      }),
      this.request('SetInputMute', {
        inputName: MICROPHONE_NAME,
        inputMuted: !settings.microphoneEnabled,
      }),
    ]);
    await this.setAudioVolumes(settings);
  }

  async setAudioVolumes(settings) {
    const inputs = [
      { inputName: DESKTOP_AUDIO_NAME, volume: settings.systemVolume },
      { inputName: MICROPHONE_NAME, volume: settings.microphoneVolume },
    ];

    await Promise.all(inputs.map(async ({ inputName, volume }) => {
      const expectedVolume = volume / 100;
      await this.request('SetInputVolume', { inputName, inputVolumeMul: expectedVolume });
      const applied = await this.request('GetInputVolume', { inputName });
      if (!Number.isFinite(applied.inputVolumeMul)
        || Math.abs(applied.inputVolumeMul - expectedVolume) > 0.001) {
        throw new Error(`OBS non ha applicato il volume richiesto a "${inputName}".`);
      }
    }));
  }

  async setCaptureMode(mode, windowTarget) {
    const sceneItems = await this.request('GetSceneItemList', { sceneName: SCENE_NAME });
    const display = sceneItems.sceneItems.find((item) => item.sourceName === 'Cattura schermo');
    const window = sceneItems.sceneItems.find((item) => item.sourceName === 'Cattura finestra');
    if (!display || !window) throw new Error('Sorgenti OBS di cattura non disponibili.');

    const useWindow = mode === 'window'
      && windowTarget
      && typeof windowTarget.title === 'string'
      && typeof windowTarget.className === 'string'
      && typeof windowTarget.executable === 'string';
    if (useWindow) {
      await this.request('SetInputSettings', {
        inputName: 'Cattura finestra',
        inputSettings: {
          window: [
            windowTarget.title,
            windowTarget.className,
            windowTarget.executable,
          ].map(encodeObsWindowPart).join(':'),
        },
        overlay: true,
      });
    }
    await Promise.all([
      this.request('SetSceneItemEnabled', {
        sceneName: SCENE_NAME,
        sceneItemId: display.sceneItemId,
        sceneItemEnabled: !useWindow,
      }),
      this.request('SetSceneItemEnabled', {
        sceneName: SCENE_NAME,
        sceneItemId: window.sceneItemId,
        sceneItemEnabled: useWindow,
      }),
    ]);
    this.activeCaptureMode = useWindow ? 'window' : 'display';
    this.windowTitle = useWindow ? windowTarget.title : '';
  }

  setZoom(settings) {
    const update = this.zoomQueue.then(() => this.applyZoom(settings));
    this.zoomQueue = update.catch(() => {});
    return update;
  }

  async applyZoom({ zoom, centerX, centerY }) {
    const { sceneItems } = await this.request('GetSceneItemList', { sceneName: SCENE_NAME });
    const activeSourceName = this.activeCaptureMode === 'window' ? 'Cattura finestra' : 'Cattura schermo';
    const sources = sceneItems.filter((item) => item.sourceName === activeSourceName);
    if (sources.length !== 1) throw new Error('Sorgente OBS attiva non disponibile per lo zoom.');

    await Promise.all(sources.map(async (item) => {
      const { sceneItemTransform: current } = await this.request('GetSceneItemTransform', {
        sceneName: SCENE_NAME,
        sceneItemId: item.sceneItemId,
      });
      if (!(current.sourceWidth > 0) || !(current.sourceHeight > 0)) {
        this.log('system', `Zoom in attesa di una sorgente video disponibile: ${item.sourceName}.`);
        return;
      }

      let baseline = this.zoomBaselines.get(item.sceneItemId);
      if (!baseline) {
        baseline = { ...current };
        this.zoomBaselines.set(item.sceneItemId, baseline);
        fs.mkdirSync(path.dirname(this.zoomBaselinesPath), { recursive: true });
        fs.writeFileSync(
          this.zoomBaselinesPath,
          JSON.stringify(Object.fromEntries(this.zoomBaselines), null, 2),
          'utf8',
        );
      }

      const sourceWidth = current.sourceWidth;
      const sourceHeight = current.sourceHeight;
      const baseCropLeft = baseline.cropLeft || 0;
      const baseCropRight = baseline.cropRight || 0;
      const baseCropTop = baseline.cropTop || 0;
      const baseCropBottom = baseline.cropBottom || 0;
      const width = sourceWidth - baseCropLeft - baseCropRight;
      const height = sourceHeight - baseCropTop - baseCropBottom;
      if (!(width > 0) || !(height > 0)) throw new Error(`Dimensioni di ritaglio OBS non valide: ${item.sourceName}.`);

      const croppedWidth = Math.round(width / zoom);
      const croppedHeight = Math.round(height / zoom);
      const localLeft = Math.max(0, Math.min(width - croppedWidth, Math.round(centerX * width - croppedWidth / 2)));
      const localTop = Math.max(0, Math.min(height - croppedHeight, Math.round(centerY * height - croppedHeight / 2)));
      const left = baseCropLeft + localLeft;
      const top = baseCropTop + localTop;
      const right = baseCropRight + width - localLeft - croppedWidth;
      const bottom = baseCropBottom + height - localTop - croppedHeight;
      const actualCenterX = (localLeft + croppedWidth / 2) / width;
      const actualCenterY = (localTop + croppedHeight / 2) / height;
      const scaleX = baseline.scaleX * zoom;
      const scaleY = baseline.scaleY * zoom;

      const sceneItemTransform = {
        positionX: baseline.positionX + (width / 2 - actualCenterX * width * zoom) * baseline.scaleX,
        positionY: baseline.positionY + (height / 2 - actualCenterY * height * zoom) * baseline.scaleY,
        rotation: baseline.rotation,
        scaleX,
        scaleY,
        alignment: baseline.alignment,
        boundsType: baseline.boundsType,
        boundsAlignment: baseline.boundsAlignment,
        cropToBounds: baseline.cropToBounds,
        cropLeft: left,
        cropRight: right,
        cropTop: top,
        cropBottom: bottom,
      };
      if (Number.isFinite(baseline.boundsWidth) && baseline.boundsWidth >= 1) {
        sceneItemTransform.boundsWidth = baseline.boundsWidth;
      }
      if (Number.isFinite(baseline.boundsHeight) && baseline.boundsHeight >= 1) {
        sceneItemTransform.boundsHeight = baseline.boundsHeight;
      }

      await this.request('SetSceneItemTransform', {
        sceneName: SCENE_NAME,
        sceneItemId: item.sceneItemId,
        sceneItemTransform,
      });
    }));
  }

  async applySettings({ bufferSeconds, audioSettings, captureMode, captureWindowTarget, zoomSettings }) {
    await this.setBufferSeconds(bufferSeconds);
    await this.setAudioDevices(audioSettings);
    await this.setCaptureMode(captureMode, captureWindowTarget);
    await this.setZoom(zoomSettings);
  }

  prepareRuntime() {
    const installRoot = this.findInstallRoot();
    const runtimeRoot = path.join(this.userDataPath, 'obs-runtime');
    const versionFile = path.join(runtimeRoot, '.shadowstream-version');
    const executableStat = fs.statSync(path.join(installRoot, 'bin', '64bit', 'obs64.exe'));
    const version = `${executableStat.size}:${executableStat.mtimeMs}`;

    if (!fs.existsSync(versionFile)) {
      fs.mkdirSync(runtimeRoot, { recursive: true });
      this.linkTree(installRoot, runtimeRoot);
      fs.writeFileSync(versionFile, version, 'utf8');
      this.log('system', `Runtime OBS isolato preparato (${this.hardlinkCount} hard link, ${this.copyCount} copie).`);
    } else if (fs.readFileSync(versionFile, 'utf8').trim() !== version) {
      throw new Error('La versione OBS installata è cambiata; rimuovere o aggiornare manualmente la copia OBS in ShadowStream.');
    }

    const executable = path.join(runtimeRoot, 'bin', '64bit', 'obs64.exe');
    if (!fs.existsSync(executable)) throw new Error(`Eseguibile OBS non trovato: ${executable}`);

    const configDirectory = path.join(runtimeRoot, 'config', 'obs-studio');
    fs.mkdirSync(this.clipsPath, { recursive: true });
    this.prepareConfig(configDirectory);
    return { executable, configDirectory };
  }

  findInstallRoot() {
    const candidates = [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'obs-studio'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'obs-studio'),
    ];
    const root = candidates.find((candidate) => fs.existsSync(path.join(candidate, 'bin', '64bit', 'obs64.exe')));
    if (!root) throw new Error('OBS Studio 64 bit non trovato in Program Files.');
    return root;
  }

  linkTree(source, destination) {
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      const sourcePath = path.join(source, entry.name);
      const destinationPath = path.join(destination, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(destinationPath, { recursive: true });
        this.linkTree(sourcePath, destinationPath);
      } else if (entry.isFile()) {
        try {
          fs.linkSync(sourcePath, destinationPath);
          this.hardlinkCount += 1;
        } catch (error) {
          if (error.code === 'EEXIST') continue;
          if (['EACCES', 'EPERM', 'EXDEV'].includes(error.code)) {
            try {
              fs.copyFileSync(sourcePath, destinationPath);
              this.copyCount += 1;
            } catch (copyError) {
              throw new Error(`Impossibile copiare il runtime OBS (${entry.name}): ${copyError.message}`);
            }
          } else {
            throw new Error(`Impossibile creare la copia OBS isolata (${entry.name}): ${error.message}`);
          }
        }
      }
    }
  }

  prepareConfig(configDirectory) {
    const basicDirectory = path.join(configDirectory, 'basic');
    const profileDirectory = path.join(basicDirectory, 'profiles', PROFILE_NAME);
    const scenesDirectory = path.join(basicDirectory, 'scenes');
    fs.mkdirSync(profileDirectory, { recursive: true });
    fs.mkdirSync(scenesDirectory, { recursive: true });
    this.writeProfile(path.join(profileDirectory, 'basic.ini'));
    this.writeSceneCollection(path.join(scenesDirectory, `${COLLECTION_NAME}.json`));
    fs.writeFileSync(path.join(configDirectory, 'global.ini'), [
      '[General]',
      'Language=en-US',
      'FirstRun=false',
      '',
      '[BasicWindow]',
      'PreviewEnabled=false',
      'PreviewProgramMode=false',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(basicDirectory, 'global.ini'), [
      '[Basic]',
      `Profile=${PROFILE_NAME}`,
      `ProfileDir=${PROFILE_NAME}`,
      `SceneCollection=${COLLECTION_NAME}`,
      `SceneCollectionFile=${COLLECTION_NAME}`,
      '',
    ].join('\n'), 'utf8');
  }

  writeProfile(profilePath) {
    const lines = [
      '[General]',
      `Name=${PROFILE_NAME}`,
      '',
      '[Output]',
      'Mode=Simple',
      '',
      '[SimpleOutput]',
      `FilePath=${this.clipsPath.replace(/\\/g, '/')}`,
      'RecFormat2=mp4',
      'VBitrate=15000',
      `ABitrate=${AUDIO_BITRATE_KBPS}`,
      'Preset=veryfast',
      'NVENCPreset2=p5',
      'RecQuality=HQ',
      'RecRB=true',
      'RecRBTime=300',
      'RecRBSize=512',
      'RecAudioEncoder=aac',
      'RecEncoder=nvenc',
      'UseAdvanced=false',
      '',
      '[AdvOut]',
      ...Array.from(
        { length: AUDIO_TRACK_COUNT },
        (_, index) => `Track${index + 1}Bitrate=${AUDIO_BITRATE_KBPS}`,
      ),
      `FFmpegAACBitrate=${AUDIO_BITRATE_KBPS}`,
      '',
      '[Video]',
      'BaseCX=3440',
      'BaseCY=1440',
      'OutputCX=3440',
      'OutputCY=1440',
      'FPSType=0',
      `FPSCommon=${VIDEO_FPS}`,
      `FPSInt=${VIDEO_FPS}`,
      `FPSNum=${VIDEO_FPS}`,
      'FPSDen=1',
      'ScaleType=bicubic',
      'ColorFormat=NV12',
      'ColorSpace=709',
      'ColorRange=Partial',
      '',
      '[Audio]',
      'MonitoringDeviceId=default',
      `SampleRate=${AUDIO_SAMPLE_RATE_HZ}`,
      'ChannelSetup=Stereo',
      '',
    ];
    fs.writeFileSync(profilePath, lines.join('\n'), 'utf8');
  }

  writeSceneCollection(collectionPath) {
    const basicDirectory = path.join(
      process.env.APPDATA || '',
      'obs-studio',
      'basic',
    );
    const sourceDirectory = path.join(basicDirectory, 'scenes');
    const activeSettings = path.join(basicDirectory, 'global.ini');
    const activeCollection = fs.existsSync(activeSettings)
      ? fs.readFileSync(activeSettings, 'utf8').match(/^SceneCollectionFile=(.+)$/m)?.[1]?.trim()
      : null;
    if (!fs.existsSync(sourceDirectory)) {
      throw new Error('Configurazione schermo OBS iniziale non trovata; aprire OBS una volta e creare una cattura schermo.');
    }
    const candidateNames = [
      activeCollection && `${path.basename(activeCollection).replace(/\.json$/i, '')}.json`,
      ...fs.readdirSync(sourceDirectory).filter((name) => name.toLowerCase().endsWith('.json')),
    ].filter((name, index, list) => name && list.indexOf(name) === index);
    const sourcePath = candidateNames
      .map((name) => path.join(sourceDirectory, name))
      .find((candidate) => fs.existsSync(candidate));
    if (!sourcePath) {
      throw new Error('Configurazione schermo OBS iniziale non trovata; aprire OBS una volta e creare una cattura schermo.');
    }
    const original = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
    const sources = Array.isArray(original.sources) ? original.sources : [];
    const sourceMap = new Map(sources.map((source) => [source.uuid, source]));
    const sceneCandidates = sources.filter((source) => source.id === 'scene');
    const activeScene = sceneCandidates.find((source) => source.name === original.current_program_scene);
    const selectedScene = [activeScene, ...sceneCandidates].find((candidate) =>
      candidate?.settings?.items?.some((item) => {
        const source = sourceMap.get(item.source_uuid);
        return source?.id === 'monitor_capture' || source?.id === 'display_capture';
      }));
    const sceneItems = selectedScene?.settings?.items || [];
    const displayItem = sceneItems.find((item) => sourceMap.get(item.source_uuid)?.id === 'monitor_capture')
      || sceneItems.find((item) => sourceMap.get(item.source_uuid)?.id === 'display_capture');
    const displaySource = displayItem && sourceMap.get(displayItem.source_uuid);
    const windowSource = sources.find((source) => source.id === 'window_capture');
    const desktopAudio = original.DesktopAudioDevice1;
    const microphone = original.AuxAudioDevice1;
    if (!selectedScene || !displayItem || !displaySource || !desktopAudio || !microphone || !windowSource) {
      throw new Error('La configurazione OBS esistente non contiene sorgenti desktop, audio e finestra utilizzabili.');
    }

    const display = structuredClone(displaySource);
    display.name = 'Cattura schermo';
    display.uuid = crypto.randomUUID();
    const window = structuredClone(windowSource);
    window.name = 'Cattura finestra';
    window.uuid = crypto.randomUUID();
    const scene = structuredClone(selectedScene);
    scene.name = SCENE_NAME;
    scene.uuid = crypto.randomUUID();
    scene.settings.items = sceneItems
      .filter((item) => item.source_uuid === displaySource.uuid || item.source_uuid === windowSource.uuid)
      .map((item) => {
        const clone = structuredClone(item);
        const source = sourceMap.get(item.source_uuid);
        const useDisplay = source?.id === 'monitor_capture' || source?.id === 'display_capture';
        clone.name = useDisplay ? 'Cattura schermo' : 'Cattura finestra';
        clone.source_uuid = useDisplay ? display.uuid : window.uuid;
        clone.visible = useDisplay;
        return clone;
      });
    if (!scene.settings.items.some((item) => item.name === 'Cattura finestra')) {
      const windowItem = structuredClone(scene.settings.items[0]);
      windowItem.name = 'Cattura finestra';
      windowItem.source_uuid = window.uuid;
      windowItem.visible = false;
      windowItem.id = (scene.settings.id_counter || 1) + 1;
      scene.settings.id_counter = windowItem.id;
      scene.settings.items.push(windowItem);
    }
    const collection = structuredClone(original);
    collection.name = COLLECTION_NAME;
    collection.DesktopAudioDevice1 = structuredClone(desktopAudio);
    collection.DesktopAudioDevice1.uuid = crypto.randomUUID();
    collection.DesktopAudioDevice1.name = DESKTOP_AUDIO_NAME;
    collection.DesktopAudioDevice1.filters = [];
    collection.AuxAudioDevice1 = structuredClone(microphone);
    collection.AuxAudioDevice1.uuid = crypto.randomUUID();
    collection.AuxAudioDevice1.name = MICROPHONE_NAME;
    collection.AuxAudioDevice1.filters = [];
    collection.sources = [display, window, scene];
    collection.groups = [];
    collection.scene_order = [{ name: SCENE_NAME }];
    collection.current_scene = SCENE_NAME;
    collection.current_program_scene = SCENE_NAME;
    collection.saved_projectors = [];
    collection.modules = {};
    collection.transitions = [];
    collection.resolution = { x: 3440, y: 1440 };
    delete collection.canvases;
    delete collection['virtual-camera'];
    fs.writeFileSync(collectionPath, JSON.stringify(collection, null, 2), 'utf8');
  }

  prepareWebSocketConfig(configDirectory, port) {
    const password = crypto.randomBytes(32).toString('base64url');
    const pluginDirectory = path.join(configDirectory, 'plugin_config', 'obs-websocket');
    fs.mkdirSync(pluginDirectory, { recursive: true });
    fs.writeFileSync(path.join(pluginDirectory, 'config.json'), JSON.stringify({
      alerts_enabled: false,
      auth_required: true,
      first_load: false,
      server_enabled: true,
      server_password: password,
      server_port: port,
    }, null, 2), 'utf8');
    return password;
  }

  findFreePort() {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          server.close();
          reject(new Error('Impossibile assegnare una porta WebSocket locale.'));
          return;
        }
        server.close((error) => {
          if (error) reject(error);
          else resolve(address.port);
        });
      });
    });
  }

  async connectWithRetry() {
    const deadline = Date.now() + 30000;
    let lastError;
    while (Date.now() < deadline && this.running) {
      try {
        await this.connectWebSocket();
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    throw new Error(`OBS WebSocket non disponibile${lastError ? `: ${lastError.message}` : ''}`);
  }

  connectWebSocket() {
    if (typeof WebSocket !== 'function') return Promise.reject(new Error('WebSocket non disponibile nel runtime Electron.'));
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${this.wsPort}`);
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.close();
          reject(new Error('timeout durante il collegamento WebSocket'));
        }
      }, 5000);
      socket.addEventListener('message', async (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.op === 0) {
          try {
            const identifyData = { rpcVersion: 1, eventSubscriptions: 2047 };
            const auth = message.d?.authentication;
            if (auth) {
              const secret = crypto.createHash('sha256')
                .update(this.authentication + auth.salt)
                .digest('base64');
              identifyData.authentication = crypto.createHash('sha256')
                .update(secret + auth.challenge)
                .digest('base64');
            }
            socket.send(JSON.stringify({ op: 1, d: identifyData }));
          } catch (error) {
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              reject(error);
            }
          }
          return;
        }
        if (message.op === 2) {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          this.socket = socket;
          socket.addEventListener('message', (incoming) => this.handleSocketMessage(incoming));
          socket.addEventListener('close', () => {
            this.socket = null;
            this.rejectPendingRequests(new Error('Connessione OBS chiusa.'));
          });
          resolve();
        } else if (message.op === 7) {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(new Error(message.d?.requestStatus?.comment || 'Identificazione OBS rifiutata.'));
          }
        }
      });
      socket.addEventListener('error', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error('errore di connessione WebSocket'));
        }
      });
    });
  }

  handleSocketMessage(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      this.log('error', `Messaggio OBS non valido: ${error.message}`);
      return;
    }
    if (message.op === 7) {
      const pending = this.pendingRequests.get(message.d.requestId);
      if (!pending) return;
      this.pendingRequests.delete(message.d.requestId);
      if (message.d.requestStatus?.result) pending.resolve(message.d.responseData || {});
      else {
        const error = new Error(`${message.d.requestType || 'Richiesta OBS'}: ${message.d.requestStatus?.comment || 'non riuscita.'}`);
        error.obsStatusCode = message.d.requestStatus?.code;
        pending.reject(error);
      }
    } else if (message.op === 5) {
      this.handleEvent(message.d.eventType, message.d.eventData || {});
    }
  }

  handleEvent(type, data) {
    if (type === 'ReplayBufferStateChanged') {
      this.replayRunning = Boolean(data.outputActive);
      this.emit('status');
    } else if (type === 'RecordStateChanged') {
      this.recording = Boolean(data.outputActive);
      if (!data.outputActive && typeof data.outputPath === 'string' && data.outputPath) {
        this.emit('clip', data.outputPath);
      }
      this.emit('status');
    } else if (type === 'ReplayBufferSaved' && typeof data.savedReplayPath === 'string') {
      this.emit('clip', data.savedReplayPath);
    }
  }

  async configureInitialState() {
    const [replay, record] = await Promise.all([
      this.requestWhenReady('GetReplayBufferStatus'),
      this.requestWhenReady('GetRecordStatus'),
    ]);
    this.replayRunning = Boolean(replay.outputActive);
    this.recording = Boolean(record.outputActive);
  }

  async requestWhenReady(requestType) {
    const deadline = Date.now() + OBS_READY_TIMEOUT_MS;
    while (true) {
      try {
        return await this.request(requestType);
      } catch (error) {
        if (error.obsStatusCode !== OBS_NOT_READY_STATUS) throw error;
        if (Date.now() >= deadline) {
          throw new Error(`OBS non è pronto dopo ${OBS_READY_TIMEOUT_MS / 1000} secondi: ${error.message}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }

  async waitForOutputState(requestType, expectedActive, outputName) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const status = await this.request(requestType);
      if (Boolean(status.outputActive) === expectedActive) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`${outputName} non ha raggiunto lo stato richiesto.`);
  }

  request(requestType, requestData = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('OBS non è connesso.'));
    }
    const requestId = `shadowstream-${++this.requestCounter}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Timeout OBS: ${requestType}`));
      }, 10000);
      this.pendingRequests.set(requestId, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      this.socket.send(JSON.stringify({
        op: 6,
        d: { requestType, requestId, requestData },
      }));
    });
  }

  rejectPendingRequests(error) {
    for (const pending of this.pendingRequests.values()) pending.reject(error);
    this.pendingRequests.clear();
  }

  resetProcess() {
    this.socket = null;
    this.replayRunning = false;
    this.recording = false;
    this.rejectPendingRequests(new Error('Processo OBS terminato.'));
    this.emit('status');
    this.process = null;
  }
}

module.exports = ObsEngine;
