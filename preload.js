const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Listen for state updates pushed from main
  onStateUpdate: (callback) =>
    ipcRenderer.on('state-update', (_, data) => callback(data)),
  // Listen for individual log entries streamed from main
  onLogEntry: (callback) =>
    ipcRenderer.on('log-entry', (_, data) => callback(data)),

  // Actions
  connect: () => ipcRenderer.invoke('connect'),
  disconnect: () => ipcRenderer.invoke('disconnect'),
  startWDAXcodebuild: () => ipcRenderer.invoke('start-wda-xcodebuild'),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  openSettings: () => ipcRenderer.invoke('open-settings'),

  // Info
  getPlatform: () => ipcRenderer.invoke('get-platform'),
  getLog: () => ipcRenderer.invoke('get-log'),
});
