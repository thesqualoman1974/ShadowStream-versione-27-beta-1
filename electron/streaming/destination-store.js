'use strict';

const fs = require('fs');
const path = require('path');

const PLATFORMS = Object.freeze({
  twitch: 'Twitch',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  kick: 'Kick',
});

function createDestinationStore({ filePath, safeStorage, fileSystem = fs }) {
  function read() {
    try {
      const contents = JSON.parse(fileSystem.readFileSync(filePath, 'utf8'));
      if (contents?.version !== 1 || !Array.isArray(contents.destinations)
        || typeof contents.ffmpegPath !== 'string'
        || (contents.verticalCropX !== undefined
          && (!Number.isFinite(contents.verticalCropX) || contents.verticalCropX < 0 || contents.verticalCropX > 1))
        || (contents.youtubeClientId !== undefined && typeof contents.youtubeClientId !== 'string')
        || (contents.youtubeCredentials !== undefined && typeof contents.youtubeCredentials !== 'string')
        || contents.destinations.some((destination) => !destination
          || !Object.hasOwn(PLATFORMS, destination.platform)
          || typeof destination.server !== 'string'
          || typeof destination.encryptedKey !== 'string')) {
        throw new Error('Il file delle destinazioni multi-streaming ha un formato non supportato.');
      }
      return contents;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, ffmpegPath: '', destinations: [] };
      throw error;
    }
  }

  function getDestinations() {
    const saved = read();
    return saved.destinations.map((destination) => ({
      platform: destination.platform,
      name: PLATFORMS[destination.platform],
      server: destination.server,
      configured: typeof destination.encryptedKey === 'string',
    }));
  }

  function getFfmpegPath() {
    return read().ffmpegPath;
  }

  function write(saved) {
    fileSystem.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.tmp`;
    fileSystem.writeFileSync(temporaryPath, JSON.stringify(saved, null, 2), { encoding: 'utf8', mode: 0o600 });
    fileSystem.renameSync(temporaryPath, filePath);
  }

  function saveDestinations(destinations) {
    if (!Array.isArray(destinations) || destinations.length > Object.keys(PLATFORMS).length) {
      throw new TypeError('Elenco piattaforme non valido.');
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('La protezione Windows per le chiavi streaming non è disponibile.');
    }

    const saved = read();
    const existing = new Map(saved.destinations.map((destination) => [destination.platform, destination]));
    const seen = new Set();
    const normalized = destinations.map((destination) => {
      if (!destination || !Object.hasOwn(PLATFORMS, destination.platform) || seen.has(destination.platform)
        || typeof destination.server !== 'string' || typeof destination.key !== 'string') {
        throw new TypeError('Configurazione piattaforma non valida.');
      }
      seen.add(destination.platform);
      const server = destination.server.trim().replace(/\/+$/, '');
      const key = destination.key.trim();
      const previous = existing.get(destination.platform);
      if (server.length > 512 || /[\u0000-\u001f\u007f]/.test(server)) {
        throw new TypeError(`Indirizzo server non valido per ${PLATFORMS[destination.platform]}.`);
      }
      let parsedServer;
      try {
        parsedServer = new URL(server);
      } catch {
        throw new TypeError(`Indirizzo server non valido per ${PLATFORMS[destination.platform]}.`);
      }
      if (!['rtmp:', 'rtmps:'].includes(parsedServer.protocol) || !parsedServer.hostname
        || parsedServer.username || parsedServer.password || parsedServer.search || parsedServer.hash) {
        throw new TypeError(`Indirizzo server non valido per ${PLATFORMS[destination.platform]}.`);
      }

      let encryptedKey = previous?.encryptedKey;
      if (key) {
        if (key.length > 1024 || /[\u0000-\u001f\u007f]/.test(key)) {
          throw new TypeError(`Chiave streaming non valida per ${PLATFORMS[destination.platform]}.`);
        }
        encryptedKey = safeStorage.encryptString(key).toString('base64');
      }
      if (!encryptedKey) {
        throw new TypeError(`Inserisci la chiave streaming per ${PLATFORMS[destination.platform]}.`);
      }
      return {
        platform: destination.platform,
        server,
        encryptedKey,
      };
    });

    write({ ...saved, destinations: normalized });
    return getDestinations();
  }

  function saveSingleDestination(destination) {
    if (!destination || !Object.hasOwn(PLATFORMS, destination.platform)
      || typeof destination.server !== 'string' || typeof destination.key !== 'string'
      || !destination.key.trim()) {
      throw new TypeError('Configurazione piattaforma non valida.');
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('La protezione Windows per le chiavi streaming non è disponibile.');
    }
    const name = PLATFORMS[destination.platform];
    const server = destination.server.trim().replace(/\/+$/, '');
    const key = destination.key.trim();
    let parsedServer;
    try {
      parsedServer = new URL(server);
    } catch {
      throw new TypeError(`Indirizzo server non valido per ${name}.`);
    }
    if (!['rtmp:', 'rtmps:'].includes(parsedServer.protocol) || !parsedServer.hostname
      || parsedServer.username || parsedServer.password || parsedServer.search || parsedServer.hash
      || server.length > 512 || key.length > 1024
      || /[\u0000-\u001f\u007f]/.test(server) || /[\u0000-\u001f\u007f]/.test(key)) {
      throw new TypeError(`Configurazione RTMP non valida per ${name}.`);
    }
    const saved = read();
    const encryptedKey = safeStorage.encryptString(key).toString('base64');
    const destinations = saved.destinations
      .filter((item) => item.platform !== destination.platform);
    destinations.push({
      platform: destination.platform,
      server,
      encryptedKey,
    });
    write({ ...saved, destinations });
    return getDestinations();
  }

  function getConfiguredDestinations() {
    const saved = read();
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('La protezione Windows per le chiavi streaming non è disponibile.');
    }
    return saved.destinations.map((destination) => {
      const name = PLATFORMS[destination.platform];
      if (!name || typeof destination.server !== 'string' || typeof destination.encryptedKey !== 'string') {
        throw new Error('Una configurazione di destinazione streaming è danneggiata.');
      }
      let key;
      try {
        key = safeStorage.decryptString(Buffer.from(destination.encryptedKey, 'base64'));
      } catch {
        throw new Error(`Impossibile decifrare la chiave streaming di ${name}.`);
      }
      return {
        platform: destination.platform,
        name,
        server: destination.server,
        key,
      };
    });
  }

  function saveFfmpegPath(ffmpegPath) {
    if (typeof ffmpegPath !== 'string' || !ffmpegPath.trim() || ffmpegPath.length > 2048) {
      throw new TypeError('Percorso FFmpeg non valido.');
    }
    const saved = read();
    write({ ...saved, ffmpegPath: ffmpegPath.trim() });
    return ffmpegPath.trim();
  }

  function getVerticalCropX() {
    return read().verticalCropX ?? 0.5;
  }

  function saveVerticalCropX(value) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new TypeError('Posizione crop verticale non valida.');
    }
    const saved = read();
    write({ ...saved, verticalCropX: value });
    return value;
  }

  function getYoutubeClientId() {
    return read().youtubeClientId || '';
  }

  function getYoutubeCredentials() {
    const saved = read();
    if (!saved.youtubeCredentials) return null;
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('La protezione Windows per le credenziali YouTube non è disponibile.');
    }
    let credentials;
    try {
      credentials = JSON.parse(safeStorage.decryptString(Buffer.from(saved.youtubeCredentials, 'base64')));
    } catch {
      throw new Error('Impossibile decifrare le credenziali OAuth YouTube.');
    }
    if (typeof credentials.accessToken !== 'string'
      || typeof credentials.refreshToken !== 'string'
      || !Number.isFinite(credentials.expiresAt)) {
      throw new Error('Credenziali OAuth YouTube danneggiate.');
    }
    return credentials;
  }

  function saveYoutubeCredentials({ clientId, accessToken, refreshToken, expiresAt }) {
    if (typeof clientId !== 'string' || !clientId.trim() || clientId.length > 256
      || typeof accessToken !== 'string' || !accessToken
      || (refreshToken !== undefined && (typeof refreshToken !== 'string' || !refreshToken))
      || !Number.isFinite(expiresAt)) {
      throw new TypeError('Credenziali OAuth YouTube non valide.');
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('La protezione Windows per le credenziali YouTube non è disponibile.');
    }
    const saved = read();
    const previous = getYoutubeCredentials();
    const credentials = {
      accessToken,
      refreshToken: refreshToken || previous?.refreshToken,
      expiresAt,
    };
    if (!credentials.refreshToken) {
      throw new Error('YouTube non ha restituito un refresh token. Ricollega l’account e approva l’accesso offline.');
    }
    write({
      ...saved,
      youtubeClientId: clientId.trim(),
      youtubeCredentials: safeStorage.encryptString(JSON.stringify(credentials)).toString('base64'),
    });
  }

  return {
    getDestinations,
    getConfiguredDestinations,
    getFfmpegPath,
    getVerticalCropX,
    saveDestinations,
    saveSingleDestination,
    saveFfmpegPath,
    saveVerticalCropX,
    getYoutubeClientId,
    getYoutubeCredentials,
    saveYoutubeCredentials,
  };
}

module.exports = { createDestinationStore, PLATFORMS };
