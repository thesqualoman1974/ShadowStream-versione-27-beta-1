'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const electronAPI = {
  onLog: (callback) => ipcRenderer.on('backend:log', (_event, entry) => callback(entry)),
  onStatus: (callback) => ipcRenderer.on('backend:status', (_event, status) => callback(status)),
  onAudioDevices: (callback) => ipcRenderer.on('backend:audio-devices', (_event, devices) => callback(devices)),
  onAudioLevels: (callback) => ipcRenderer.on('backend:audio-levels', (_event, levels) => callback(levels)),
  onUpdateStatus: (callback) => ipcRenderer.on('update:status', (_event, status) => callback(status)),
  getStatus: () => ipcRenderer.invoke('backend:status:get'),
  getAudioSettings: () => ipcRenderer.invoke('backend:get-audio-settings'),
  start: (options) => ipcRenderer.invoke('backend:start', options),
  toggleReplay: (options) => ipcRenderer.invoke('backend:toggle-replay', options),
  stop: () => ipcRenderer.invoke('backend:stop'),
  save: () => ipcRenderer.invoke('backend:save'),
  saveClip: () => ipcRenderer.invoke('backend:save'),
  record: () => ipcRenderer.invoke('backend:record'),
  restart: () => ipcRenderer.invoke('backend:restart'),
  setBufferSeconds: (sec) => ipcRenderer.invoke('backend:set-buffer-seconds', sec),
  getBufferSeconds: () => ipcRenderer.invoke('backend:get-buffer-seconds'),
  getZoomSettings: () => ipcRenderer.invoke('backend:get-zoom-settings'),
  setZoomSettings: (settings) => ipcRenderer.invoke('backend:set-zoom-settings', settings),
  openClips: () => ipcRenderer.send('open-clips'),
  quit: () => ipcRenderer.invoke('backend:quit'),
  onWindowsList: (callback) => ipcRenderer.on('backend:windows-list', (_event, list) => callback(list)),
  setCaptureMode: (mode, windowTarget) => ipcRenderer.invoke('backend:set-capture-mode', mode, windowTarget),
  getCaptureSettings: () => ipcRenderer.invoke('backend:get-capture-settings'),
  getWindows: () => ipcRenderer.invoke('backend:get-windows'),
  getAudioDevices: () => ipcRenderer.invoke('backend:get-audio-devices'),
  setAudioDevices: (settings) => ipcRenderer.invoke('backend:set-audio-devices', settings),
  setAudioVolumes: (volumes) => ipcRenderer.invoke('backend:set-audio-volumes', volumes),
  getPreviewSource: () => ipcRenderer.invoke('capture:preview-source'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  downloadUpdate: () => ipcRenderer.invoke('updates:download'),
  installUpdate: () => ipcRenderer.invoke('updates:install'),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
contextBridge.exposeInMainWorld('shadow', electronAPI);
