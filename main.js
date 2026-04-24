'use strict';

const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');

// ── Services ──────────────────────────────────────────────────────────────
const ProxyServer = require('./src/proxy-server');
const { DeviceManager } = require('./src/device-manager');
const goios = require('./src/goios-runner');
const store = require('./src/settings-store');

// ── State ─────────────────────────────────────────────────────────────────
const proxyServer   = new ProxyServer();
const deviceManager = new DeviceManager();
const logBuffer     = []; // up to 500 entries, replayed when window opens
const MAX_LOG       = 500;

let mainWindow    = null;
let settingsWindow = null;

// ── App init ──────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  goios.init();
  createMainWindow();
  wireEvents();
  startServices();
});

app.on('window-all-closed', () => {
  // Keep running on macOS when last window is closed (like most macOS apps)
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
});

app.on('before-quit', () => {
  deviceManager.stopMonitoring();
  deviceManager.disconnect();
  proxyServer.stop();
});

// ── Windows ───────────────────────────────────────────────────────────────
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 600,
    minWidth: 480,
    minHeight: 520,
    title: 'ScenarioReplay',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Remove the default menu (or set a minimal one)
  const menu = Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { label: 'Settings...', click: openSettingsWindow, accelerator: 'CmdOrCtrl+,' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
  ]);
  Menu.setApplicationMenu(menu);

  mainWindow.on('closed', () => { mainWindow = null; });
}

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 420,
    height: 360,
    resizable: false,
    title: 'Settings',
    parent: mainWindow ?? undefined,
    modal: process.platform !== 'darwin',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWindow.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

// ── Event wiring ──────────────────────────────────────────────────────────
function wireEvents() {
  // Proxy log → buffer + forward to renderer
  proxyServer.on('log', (entry) => pushLog({ ...entry, timestamp: new Date() }));
  proxyServer.on('request', () => sendState());
  proxyServer.on('started', () => sendState());
  proxyServer.on('stopped', () => sendState());

  // Device manager → buffer + forward to renderer
  deviceManager.on('log', (entry) => pushLog(entry));
  deviceManager.on('state-changed', () => sendState());
}

function pushLog(entry) {
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG) logBuffer.shift();
  mainWindow?.webContents.send('log-entry', entry);
}

function sendState() {
  const state = getState();
  mainWindow?.webContents.send('state-update', state);
}

function getState() {
  return {
    proxyRunning:  proxyServer.isRunning,
    proxyPort:     proxyServer.port,
    requestCount:  proxyServer.requestCount,
    device:        deviceManager.connectedDevice,
    wdaStatus:     deviceManager.wdaStatus,
    errorMessage:  deviceManager.errorMessage,
  };
}

// ── Services startup ──────────────────────────────────────────────────────
function startServices() {
  const port = store.get('proxyPort', 4723);
  proxyServer.start(port);
  deviceManager.startMonitoring();
}

// ── IPC handlers ──────────────────────────────────────────────────────────
ipcMain.handle('get-state', () => getState());

ipcMain.handle('connect', () => {
  if (deviceManager.connectedDevice) {
    deviceManager.connect(deviceManager.connectedDevice);
  }
});

ipcMain.handle('disconnect', () => deviceManager.disconnect());

ipcMain.handle('start-wda-xcodebuild', () => deviceManager.startWDAViaXcodebuild());

ipcMain.handle('get-settings', () => ({
  proxyPort:      store.get('proxyPort', 4723),
  wdaProjectPath: store.get('wdaProjectPath', ''),
}));

ipcMain.handle('save-settings', (_, settings) => {
  if (settings.proxyPort)      store.set('proxyPort', settings.proxyPort);
  if (settings.wdaProjectPath !== undefined) store.set('wdaProjectPath', settings.wdaProjectPath);
});

ipcMain.handle('open-settings', () => openSettingsWindow());

ipcMain.handle('get-platform', () => process.platform);

ipcMain.handle('get-log', () => logBuffer);
