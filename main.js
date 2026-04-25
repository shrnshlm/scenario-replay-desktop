'use strict';

const { app, BrowserWindow, ipcMain, Menu, Notification, dialog } = require('electron');
const path = require('path');

// ── Single-instance lock ──────────────────────────────────────────────────
// If another instance tries to start, focus the existing window instead.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => {
  // Show a notification so the user knows why nothing new opened
  if (Notification.isSupported()) {
    new Notification({
      title: 'ScenarioReplay is already running',
      body: 'Bringing the existing window to focus.',
      silent: true,
    }).show();
  }
  // Bring the existing window to front
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// ── Services ──────────────────────────────────────────────────────────────
const ProxyServer = require('./src/proxy-server');
const { DeviceManager } = require('./src/device-manager');
const { AndroidManager } = require('./src/android-manager');
const goios = require('./src/goios-runner');
const store = require('./src/settings-store');

// ── State ─────────────────────────────────────────────────────────────────
const proxyServer    = new ProxyServer();
const deviceManager  = new DeviceManager();
const androidManager = new AndroidManager();
const logBuffer     = []; // up to 500 entries, replayed when window opens
const MAX_LOG       = 500;

let mainWindow    = null;
let settingsWindow = null;

// Sync the OS login-item state with the saved preference.
// Safe to call repeatedly; setLoginItemSettings is idempotent.
function applyLaunchOnStartup() {
  if (process.platform === 'linux') return; // unsupported by Electron API
  const enabled = store.get('launchOnStartup', true);
  app.setLoginItemSettings({ openAtLogin: enabled });
}

// ── App init ──────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  goios.init();
  applyLaunchOnStartup();
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
  androidManager.stopMonitoring();
  androidManager.disconnect();
  proxyServer.stop();
});

// ── Windows ───────────────────────────────────────────────────────────────
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 680,
    minWidth: 480,
    minHeight: 600,
    title: 'ScenarioReplay',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Push initial state once the renderer is ready
  mainWindow.webContents.on('did-finish-load', () => sendState());

  // Log renderer errors to main process console for debugging
  mainWindow.webContents.on('did-fail-load', (_, code, desc) => {
    console.error('[main] Renderer failed to load:', code, desc);
  });
  mainWindow.webContents.on('render-process-gone', (_, details) => {
    console.error('[main] Renderer process gone:', details.reason);
  });

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

  // Device manager (iOS) → buffer + forward to renderer
  deviceManager.on('log', (entry) => pushLog(entry));
  deviceManager.on('state-changed', () => sendState());

  // Android manager → buffer + forward to renderer
  androidManager.on('log', (entry) => pushLog(entry));
  androidManager.on('state-changed', () => sendState());
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
    proxyRunning:    proxyServer.isRunning,
    proxyPort:       proxyServer.port,
    requestCount:    proxyServer.requestCount,
    device:          deviceManager.connectedDevice,
    wdaStatus:       deviceManager.wdaStatus,
    errorMessage:    deviceManager.errorMessage,
    androidDevice:   androidManager.connectedDevice,
    androidStatus:   androidManager.status,
    androidError:    androidManager.errorMessage,
  };
}

// ── Services startup ──────────────────────────────────────────────────────
function startServices() {
  const port = store.get('proxyPort', 4723);
  proxyServer.start(port);
  deviceManager.startMonitoring();
  androidManager.startMonitoring();
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

ipcMain.handle('install-appium', () => androidManager.installAppium());

ipcMain.handle('get-settings', () => ({
  proxyPort:        store.get('proxyPort', 4723),
  wdaProjectPath:   store.get('wdaProjectPath', ''),
  launchOnStartup:  store.get('launchOnStartup', true),
}));

ipcMain.handle('save-settings', (_, settings) => {
  if (settings.proxyPort) store.set('proxyPort', settings.proxyPort);
  if (settings.wdaProjectPath !== undefined) store.set('wdaProjectPath', settings.wdaProjectPath);
  if (settings.launchOnStartup !== undefined) {
    store.set('launchOnStartup', settings.launchOnStartup);
    applyLaunchOnStartup();
  }
});

ipcMain.handle('open-settings', () => openSettingsWindow());

ipcMain.handle('get-platform', () => process.platform);

ipcMain.handle('get-log', () => logBuffer);
