'use strict';

const MAX_LOG_ENTRIES = 500;

// ── DOM refs ──────────────────────────────────────────────────────────────
const dotProxy     = document.getElementById('dot-proxy');
const detailProxy  = document.getElementById('detail-proxy');
const dotDevice    = document.getElementById('dot-device');
const detailDevice = document.getElementById('detail-device');
const dotWda       = document.getElementById('dot-wda');
const detailWda    = document.getElementById('detail-wda');

const errorBanner  = document.getElementById('error-banner');
const errorText    = document.getElementById('error-text');

const btnConnect     = document.getElementById('btn-connect');
const btnDisconnect  = document.getElementById('btn-disconnect');
const btnStartWda    = document.getElementById('btn-start-wda');

const requestCount   = document.getElementById('request-count');
const logBody        = document.getElementById('log-body');
const btnCopyLog     = document.getElementById('btn-copy-log');
const copiedToast    = document.getElementById('copied-toast');

// ── State ─────────────────────────────────────────────────────────────────
let platform = 'darwin';
let logEntries = []; // { ts, source, level, message }

// ── Init ──────────────────────────────────────────────────────────────────
(async () => {
  platform = await window.electronAPI.getPlatform();

  // Hide "Start WDA" on non-macOS (xcodebuild not available)
  if (platform !== 'darwin') btnStartWda.style.display = 'none';

  // Restore existing log entries (in case window was reopened)
  const existing = await window.electronAPI.getLog();
  if (existing && existing.length) {
    for (const e of existing) appendLogEntry(e);
  }
})();

// ── IPC listeners ─────────────────────────────────────────────────────────
window.electronAPI.onStateUpdate((state) => {
  updateProxy(state);
  updateDevice(state);
  updateWda(state);
  updateButtons(state);
  updateErrorBanner(state);
  requestCount.textContent = state.requestCount > 0
    ? `${state.requestCount} request${state.requestCount === 1 ? '' : 's'} proxied`
    : '';
});

window.electronAPI.onLogEntry((entry) => appendLogEntry(entry));

// ── Status dot helpers ────────────────────────────────────────────────────
function setDot(el, color) {
  el.className = `status-dot dot-${color}`;
}

function updateProxy(state) {
  if (state.proxyRunning) {
    setDot(dotProxy, 'green');
    detailProxy.textContent = `Running on port ${state.proxyPort}`;
  } else {
    setDot(dotProxy, 'red');
    detailProxy.textContent = 'Stopped';
  }
}

function updateDevice(state) {
  if (state.device) {
    setDot(dotDevice, 'green');
    detailDevice.textContent = `${state.device.deviceName} (iOS ${state.device.osVersion})`;
  } else {
    setDot(dotDevice, 'gray');
    detailDevice.textContent = 'No device connected';
  }
}

const STATUS_COLORS = {
  'Connected': 'green',
  'Error':     'red',
  'No device connected': 'gray',
};

function wdaStatusColor(status) {
  if (status === 'Connected') return 'green';
  if (status === 'Error') return 'red';
  if (status === 'No device connected' || status === 'Device detected') return 'gray';
  return 'orange'; // transitional states
}

function updateWda(state) {
  setDot(dotWda, wdaStatusColor(state.wdaStatus));
  detailWda.textContent = state.wdaStatus;
}

function updateButtons(state) {
  const { device, wdaStatus } = state;

  // Connect: shown when device detected but not yet connecting
  const showConnect = device && wdaStatus === 'Device detected';
  btnConnect.style.display = showConnect ? '' : 'none';

  // Disconnect: shown when setup is running or finished
  const showDisconnect = wdaStatus === 'Connected' || wdaStatus === 'Error';
  btnDisconnect.style.display = showDisconnect ? '' : 'none';

  // Start WDA: macOS only, when error or launching
  const showStartWda = platform === 'darwin' && device &&
    (wdaStatus === 'Error' || wdaStatus === 'Launching WebDriverAgent...');
  if (platform === 'darwin') {
    btnStartWda.style.display = showStartWda ? '' : 'none';
  }
}

function updateErrorBanner(state) {
  if (state.errorMessage) {
    errorText.textContent = state.errorMessage;
    errorBanner.classList.add('visible');
  } else {
    errorBanner.classList.remove('visible');
  }
}

// ── Button handlers ───────────────────────────────────────────────────────
btnConnect.onclick    = () => window.electronAPI.connect();
btnDisconnect.onclick = () => window.electronAPI.disconnect();
btnStartWda.onclick   = () => window.electronAPI.startWDAXcodebuild();

// ── Log ───────────────────────────────────────────────────────────────────
const SOURCE_CLASS = { proxy: 'src-proxy', device: 'src-device', wda: 'src-wda', app: 'src-app' };
const SOURCE_LABEL = { proxy: '[PROXY]', device: '[DEVICE]', wda: '[WDA]', app: '[APP]' };

function formatTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleTimeString('en-GB', { hour12: false });
}

function appendLogEntry(entry) {
  logEntries.push(entry);
  if (logEntries.length > MAX_LOG_ENTRIES) {
    logEntries.shift();
    logBody.firstChild && logBody.removeChild(logBody.firstChild);
  }

  const row = document.createElement('div');
  row.className = 'log-entry';

  const ts = document.createElement('span');
  ts.className = 'log-ts';
  ts.textContent = formatTime(entry.timestamp);

  const src = document.createElement('span');
  src.className = `log-src ${SOURCE_CLASS[entry.source] || 'src-app'}`;
  src.textContent = SOURCE_LABEL[entry.source] || `[${entry.source?.toUpperCase()}]`;

  const msg = document.createElement('span');
  msg.className = `log-msg${entry.level === 'error' ? ' error' : ''}`;
  msg.textContent = entry.message;

  row.append(ts, src, msg);
  logBody.appendChild(row);

  // Auto-scroll to bottom
  logBody.scrollTop = logBody.scrollHeight;
}

// Copy log
btnCopyLog.onclick = () => {
  const text = logEntries.map(e =>
    `${formatTime(e.timestamp)} ${SOURCE_LABEL[e.source] || '[APP]'} ${e.message}`
  ).join('\n');
  navigator.clipboard.writeText(text).then(() => {
    copiedToast.classList.add('visible');
    setTimeout(() => copiedToast.classList.remove('visible'), 2000);
  });
};
