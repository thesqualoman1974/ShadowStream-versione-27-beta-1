'use strict';

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const crypto = require('crypto');
const net = require('net');

function validateDestination(destination) {
  if (!destination || typeof destination !== 'object'
    || typeof destination.name !== 'string'
    || typeof destination.server !== 'string'
    || typeof destination.key !== 'string') {
    throw new TypeError('Destinazione RTMP non valida.');
  }

  const name = destination.name.trim();
  const server = destination.server.trim().replace(/\/+$/, '');
  const key = destination.key.trim();
  let parsed;
  try {
    parsed = new URL(server);
  } catch {
    throw new TypeError(`Indirizzo RTMP non valido per ${name || 'destinazione'}.`);
  }

  if (!name || name.length > 64 || !['rtmp:', 'rtmps:'].includes(parsed.protocol)
    || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash
    || /[\u0000-\u001f\u007f]/.test(key) || !key || key.length > 1024) {
    throw new TypeError(`Configurazione RTMP non valida per ${name || 'destinazione'}.`);
  }

  return {
    name,
    url: `${server}/${key}`,
  };
}

function escapeTeeUrl(value) {
  return value.replace(/[\\[\]|]/g, '\\$&');
}

function buildRelayArguments(inputUrl, destinations, { verticalCropX = 0.5 } = {}) {
  if (typeof inputUrl !== 'string' || !inputUrl.startsWith('rtmp://127.0.0.1:')) {
    throw new TypeError('Indirizzo RTMP locale non valido.');
  }
  if (!Array.isArray(destinations) || destinations.length === 0) {
    throw new TypeError('Configura almeno una destinazione RTMP.');
  }
  if (!Number.isFinite(verticalCropX) || verticalCropX < 0 || verticalCropX > 1) {
    throw new TypeError('Posizione crop verticale non valida.');
  }

  const validatedDestinations = destinations.map((destination) => ({
    ...validateDestination(destination),
    platform: destination.platform,
  }));
  const landscapeOutputs = validatedDestinations
    .filter((destination) => destination.platform !== 'tiktok')
    .map((destination) => `[f=flv:onfail=abort]${escapeTeeUrl(destination.url)}`);
  const verticalOutput = validatedDestinations.find((destination) => destination.platform === 'tiktok');
  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-rtmp_listen', '1',
    '-i', inputUrl,
  ];

  if (landscapeOutputs.length > 0) {
    args.push(
      '-map', '0',
      '-c', 'copy',
      '-f', 'tee',
      '-use_fifo', '1',
      landscapeOutputs.join('|'),
    );
  }

  if (verticalOutput) {
    args.push(
      '-map', '0:v:0',
      '-map', '0:a?',
      '-vf', `crop=ih*9/16:ih:(iw-ih*9/16)*${verticalCropX.toFixed(4)}:0,scale=1080:1920`,
      '-c:v', 'h264_nvenc',
      '-pix_fmt', 'yuv420p',
      '-preset', 'p4',
      '-b:v', '6000k',
      '-maxrate', '6000k',
      '-bufsize', '12000k',
      '-c:a', 'copy',
      '-f', 'flv',
      verticalOutput.url,
    );
  }

  return args;
}

function reserveLocalPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Impossibile assegnare una porta locale al relay.'));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

class RtmpRelay extends EventEmitter {
  constructor({ ffmpegPath, log }) {
    super();
    if (typeof ffmpegPath !== 'string' || !ffmpegPath.trim()) {
      throw new TypeError('Seleziona il percorso di ffmpeg.exe.');
    }
    this.ffmpegPath = ffmpegPath;
    this.log = log;
    this.process = null;
    this.inputKey = null;
    this.stderrBuffer = '';
  }

  get running() {
    return this.process !== null && this.process.exitCode === null;
  }

  async start(destinations, options = {}) {
    if (this.running) throw new Error('Il relay RTMP è già attivo.');
    const validated = destinations.map(validateDestination);
    if (validated.length === 0) throw new Error('Seleziona almeno una piattaforma.');

    const port = await reserveLocalPort();
    this.inputKey = crypto.randomBytes(24).toString('hex');
    const inputUrl = `rtmp://127.0.0.1:${port}/live/${this.inputKey}`;
    const args = buildRelayArguments(inputUrl, destinations, options);
    const relayProcess = spawn(this.ffmpegPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.process = relayProcess;
    relayProcess.stderr.setEncoding('utf8');
    relayProcess.stderr.on('data', (chunk) => {
      this.stderrBuffer = (this.stderrBuffer + chunk).slice(-8192);
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        if (relayProcess.exitCode !== null) {
          reject(new Error('FFmpeg non è riuscito ad avviare il relay. Verifica che il percorso sia corretto e che la porta locale sia disponibile.'));
        } else {
          resolve();
        }
      }, 500);
      const onError = (error) => {
        cleanup();
        reject(new Error(`Avvio del relay FFmpeg non riuscito: ${error.message}`));
      };
      const onExit = (code, signal) => {
        cleanup();
        reject(new Error(`FFmpeg ha terminato il relay durante l’avvio (exit ${code ?? signal}). Verifica l’installazione di FFmpeg e le destinazioni RTMP.`));
      };
      const cleanup = () => {
        clearTimeout(timeout);
        relayProcess.removeListener('error', onError);
        relayProcess.removeListener('exit', onExit);
      };
      relayProcess.once('error', onError);
      relayProcess.once('exit', onExit);
    }).catch(async (error) => {
      await this.stop();
      throw error;
    });

    relayProcess.once('exit', (code, signal) => {
      if (this.process !== relayProcess) return;
      this.process = null;
      this.inputKey = null;
      this.emit('exit', {
        code,
        signal,
        message: this.stderrBuffer.trim(),
      });
    });

    this.log('system', `Relay RTMP locale pronto sulla porta ${port}; destinazioni: ${validated.map(({ name }) => name).join(', ')}.`);
    return {
      server: `rtmp://127.0.0.1:${port}/live`,
      key: this.inputKey,
    };
  }

  async stop() {
    const relayProcess = this.process;
    if (!relayProcess) return;
    this.process = null;
    this.inputKey = null;
    if (relayProcess.exitCode !== null) return;

    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (relayProcess.exitCode === null) relayProcess.kill();
      }, 3000);
      relayProcess.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
      relayProcess.kill();
    });
  }
}

module.exports = {
  RtmpRelay,
  buildRelayArguments,
  validateDestination,
};
