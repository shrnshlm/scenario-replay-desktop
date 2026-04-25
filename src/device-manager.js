'use strict';

/**
 * Orchestrates the full device + WDA lifecycle.
 * Port of DeviceManager.swift — same state machine, same timing constants.
 */

const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const wda = require('./wda-client');
const goios = require('./goios-runner');

// ── Timing constants (match Swift exactly) ────────────────────────────────
const DEVICE_POLL_MS   = 3_000;
const TUNNEL_ATTEMPTS  = 3;
const TUNNEL_WAIT_MS   = 15_000;  // max wait per attempt
const TUNNEL_ALIVE_MS  = 3_000;   // process must be alive this long to count
const TUNNEL_SETTLE_MS = 1_500;
const FORWARD_SETTLE_MS = 1_500;
const WDA_POLL_MS      = 2_000;
const WDA_TIMEOUT_MS   = 60_000;
const WDA_WATCHER_MS   = 5_000;

// ── State enum (rawValues match Swift WDAStatus exactly) ──────────────────
const WDAStatus = {
  IDLE:       'No device connected',
  DETECTED:   'Device detected',
  PAIRING:    'Pairing — tap Trust on the iPhone',
  TUNNELING:  'Starting iOS tunnel...',
  INSTALLING: 'Installing WebDriverAgent...',
  FORWARDING: 'Starting port forward...',
  LAUNCHING:  'Launching WebDriverAgent...',
  READY:      'Connected',
  ERROR:      'Error',
};

class DeviceManager extends EventEmitter {
  constructor() {
    super();
    this.connectedDevice = null;
    this.wdaStatus = WDAStatus.IDLE;
    this.errorMessage = null;

    this._pollTimer = null;
    this._watcherTimer = null;
    this._tunnelProc = null;
    this._forwardProc = null;
    this._wdaProc = null;
    this._setupCancelled = false;
  }

  // ── Public API ────────────────────────────────────────────────────────

  startMonitoring() {
    this._pollTimer = setInterval(() => this._pollDevices(), DEVICE_POLL_MS);
    this._pollDevices(); // immediate first check
  }

  stopMonitoring() {
    clearInterval(this._pollTimer);
    this._pollTimer = null;
  }

  connect(device) {
    this._setupCancelled = false;
    this._runSetup(device).catch((err) => {
      if (!this._setupCancelled) {
        this._setError(`Setup failed: ${err.message}`);
      }
    });
  }

  disconnect() {
    this._setupCancelled = true;
    this._teardown();
    const hadDevice = this.connectedDevice !== null;
    this.connectedDevice = null;
    this._setState(hadDevice ? WDAStatus.DETECTED : WDAStatus.IDLE);
    this.errorMessage = null;
    this._emit();
  }

  startWDAViaXcodebuild() {
    if (process.platform !== 'darwin') return;
    if (!this.connectedDevice) return;

    if (this._wdaProc) { try { this._wdaProc.kill(); } catch (_) {} this._wdaProc = null; }

    const store = require('./settings-store');
    const savedPath = store.get('wdaProjectPath', '');
    const projectPath = savedPath || path.join(os.homedir(), 'Downloads', 'WebDriverAgent');

    if (!fs.existsSync(projectPath)) {
      this._log('error', 'wda', `WebDriverAgent project not found at ${projectPath}. Set the path in Settings.`);
      return;
    }

    this._log('info', 'wda', `Starting WDA via xcodebuild for ${this.connectedDevice.deviceName}...`);
    this._setState(WDAStatus.LAUNCHING);

    const proc = execFile(
      '/usr/bin/xcodebuild',
      ['-scheme', 'WebDriverAgentRunner', '-destination', `id=${this.connectedDevice.id}`, 'test'],
      { cwd: projectPath },
      (err) => { if (err && !this._setupCancelled) this._log('error', 'wda', `xcodebuild exited: ${err.message}`); },
    );
    proc.stdout?.on('data', (d) => {
      const text = d.toString().trim();
      if (text) this._log('info', 'wda', `[xcodebuild] ${text}`);
    });
    proc.stderr?.on('data', (d) => {
      const text = d.toString().trim();
      if (text) this._log('info', 'wda', `[xcodebuild] ${text}`);
    });
    this._wdaProc = proc;
  }

  // ── Setup sequence (mirrors Swift runSetup) ───────────────────────────

  async _runSetup(device) {
    this.connectedDevice = device;
    this.errorMessage = null;

    // Step 0: Ensure the device is paired with this PC. If it isn't, the
    // tunnel + WDA stages will fail with "ReadPair failed errorcode 2".
    // The osVersion === 'Unknown' fallback in goios.listDevices is a
    // reliable signal that fetchDeviceInfo failed — usually because the
    // pair record doesn't exist on this host.
    if (!device.osVersion || device.osVersion === 'Unknown') {
      const paired = await this._ensurePaired(device.id);
      if (this._setupCancelled) return;
      if (!paired) {
        this._setError('Pairing was not completed. Unlock the iPhone and tap Trust, then unplug and replug.');
        return;
      }
      // Refresh device info now that pairing succeeded
      try {
        const info = await goios.fetchDeviceInfo(device.id);
        this.connectedDevice = info;
        this._log('info', 'device', `Paired: ${info.deviceName} (iOS ${info.osVersion})`);
        this._emit();
      } catch (_) {}
    }

    // Step 1: Tunnel
    this._setState(WDAStatus.TUNNELING);
    const tunnelOk = await this._startTunnelWithRetry(device.id);
    if (this._setupCancelled) return;

    if (!tunnelOk) {
      this._setError('Tunnel failed after 3 attempts. Make sure your iPhone is unlocked.');
      this._startWDAWatcher();
      return;
    }

    // Refresh device info after tunnel connects (may reveal real iOS version)
    try {
      const info = await goios.fetchDeviceInfo(device.id);
      this.connectedDevice = info;
    } catch (_) {}
    if (this._setupCancelled) return;

    // Step 2: Port forward
    this._setState(WDAStatus.FORWARDING);
    this._startPortForward(device.id);
    await sleep(FORWARD_SETTLE_MS);
    if (this._setupCancelled) return;

    // Step 3: Check if WDA already running
    if (await wda.isReady()) {
      this._log('info', 'device', 'WDA already running — skipping install and launch');
      this._setState(WDAStatus.READY);
      this._startWDAWatcher();
      return;
    }
    if (this._setupCancelled) return;

    // Step 4: Install WDA (non-fatal)
    this._setState(WDAStatus.INSTALLING);
    const ipaPath = this._resolveIPA();
    if (ipaPath) {
      try {
        await goios.installWDA(device.id, ipaPath);
        this._log('info', 'device', 'WDA installed');
      } catch (err) {
        this._log('warn', 'device', `WDA install warning (continuing): ${err.message}`);
      }
    } else {
      this._log('warn', 'device', 'WebDriverAgent.ipa not found — skipping install');
    }
    if (this._setupCancelled) return;

    // Step 5: Launch WDA
    this._setState(WDAStatus.LAUNCHING);
    this._wdaProc = goios.startWDA(device.id, (line) => {
      this._log('info', 'wda', line);
    });

    // Step 6: Poll for WDA readiness
    const deadline = Date.now() + WDA_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this._setupCancelled) return;
      await sleep(WDA_POLL_MS);
      if (await wda.isReady()) {
        this._setState(WDAStatus.READY);
        this._startWDAWatcher();
        return;
      }
    }

    if (!this._setupCancelled) {
      this._setError('WebDriverAgent did not respond within 60 seconds');
      this._startWDAWatcher();
    }
  }

  // ── Pairing ───────────────────────────────────────────────────────────

  /**
   * Run `ios pair`. Triggers the Trust dialog on the iPhone and blocks
   * until the user taps Trust. We surface a system notification + log
   * + state change so the user knows to look at their phone.
   * Returns true on success, false on timeout / decline / error.
   */
  async _ensurePaired(udid) {
    this._setState(WDAStatus.PAIRING);
    this._log('info', 'device', 'Pairing iPhone — tap Trust on the device when prompted');
    this.emit('user-action-required', {
      title: 'Tap Trust on your iPhone',
      body: 'ScenarioReplay is pairing with this device. Unlock the iPhone and tap Trust when prompted.',
    });

    try {
      await goios.pair(udid);
      this._log('info', 'device', 'Pairing succeeded');
      return true;
    } catch (err) {
      this._log('error', 'device', `Pairing failed: ${err.message}`);
      return false;
    }
  }

  // ── Tunnel with retry ─────────────────────────────────────────────────

  async _startTunnelWithRetry(udid) {
    for (let attempt = 1; attempt <= TUNNEL_ATTEMPTS; attempt++) {
      this._log('info', 'device', `Starting iOS tunnel (attempt ${attempt}/${TUNNEL_ATTEMPTS})...`);

      const result = await this._tryTunnel(udid);
      if (result === 'ok') {
        await sleep(TUNNEL_SETTLE_MS);
        return true;
      }
      if (result === 'reuse') {
        this._log('info', 'device', 'Tunnel already running — reusing');
        await sleep(TUNNEL_SETTLE_MS);
        return true;
      }

      if (attempt < TUNNEL_ATTEMPTS) {
        this._log('warn', 'device', `Tunnel attempt ${attempt} failed, retrying...`);
        if (this._tunnelProc) { try { this._tunnelProc.kill(); } catch (_) {} this._tunnelProc = null; }
      }
    }
    return false;
  }

  _tryTunnel(udid) {
    return new Promise((resolve) => {
      let tunnelReady = false;
      let aliveTimer = null;
      let deadlineTimer = null;

      const done = (result) => {
        clearTimeout(aliveTimer);
        clearTimeout(deadlineTimer);
        if (!tunnelReady) { tunnelReady = true; resolve(result); }
      };

      this._tunnelProc = goios.startTunnel(udid, (line) => {
        this._log('info', 'device', line);

        if (line.includes('address already in use')) {
          done('reuse');
          return;
        }

        // Detect tunnel-ready signals
        const lower = line.toLowerCase();
        if (lower.includes('tunnel') &&
            (lower.includes('address') || lower.includes('route') ||
             lower.includes('fd') || lower.includes('tunnel info'))) {
          done('ok');
        }
      });

      this._tunnelProc.on('exit', () => {
        if (!tunnelReady) done('failed');
      });

      // If process stays alive for TUNNEL_ALIVE_MS, assume tunnel is up
      aliveTimer = setTimeout(() => {
        if (this._tunnelProc && !this._tunnelProc.exitCode) done('ok');
      }, TUNNEL_ALIVE_MS);

      // Hard deadline
      deadlineTimer = setTimeout(() => done('failed'), TUNNEL_WAIT_MS);
    });
  }

  // ── Port forward ──────────────────────────────────────────────────────

  _startPortForward(udid) {
    const SUPPRESS = [
      'new client connected', 'could not connect to phone', 'error code:3',
      'forward: close clientConn', '"Connected to port"', '"msg":"Connected to port"',
    ];

    this._forwardProc = goios.startPortForward(udid, (line) => {
      if (line.includes('address already in use')) {
        this._log('info', 'device', 'Port forward already running — reusing existing forward');
        return;
      }
      if (SUPPRESS.some(s => line.toLowerCase().includes(s.toLowerCase())) && !line.includes('Start listening')) return;
      this._log('info', 'device', line);
    });
  }

  // ── WDA watcher ───────────────────────────────────────────────────────

  _startWDAWatcher() {
    clearInterval(this._watcherTimer);
    this._watcherTimer = setInterval(async () => {
      const ready = await wda.isReady();
      if (ready && this.wdaStatus !== WDAStatus.READY) {
        this._setState(WDAStatus.READY);
        this.errorMessage = null;
        this._emit();
      } else if (!ready && this.wdaStatus === WDAStatus.READY) {
        this._setState(WDAStatus.ERROR);
        this.errorMessage = 'WDA stopped responding';
        this._emit();
      }
    }, WDA_WATCHER_MS);
  }

  // ── Device polling ────────────────────────────────────────────────────

  async _pollDevices() {
    let devices;
    try { devices = await goios.listDevices(); }
    catch (_) { devices = []; }

    const first = devices[0] ?? null;

    if (!first && this.connectedDevice) {
      // Device disconnected
      this._log('info', 'device', 'Device disconnected');
      this._teardown();
      this.connectedDevice = null;
      this._setState(WDAStatus.IDLE);
      this._emit();
    } else if (first && (!this.connectedDevice || first.id !== this.connectedDevice.id)) {
      // New device appeared
      this._log('info', 'device', `Device detected: ${first.deviceName} (iOS ${first.osVersion})`);
      if (this.connectedDevice) this._teardown();
      this.connectedDevice = first;
      this._setState(WDAStatus.DETECTED);
      this._emit();
      // Auto-connect
      this.connect(first);
    }
  }

  // ── Teardown ──────────────────────────────────────────────────────────

  _teardown() {
    clearInterval(this._watcherTimer);
    this._watcherTimer = null;
    for (const key of ['_tunnelProc', '_forwardProc', '_wdaProc']) {
      if (this[key]) {
        try { this[key].kill(); } catch (_) {}
        this[key] = null;
      }
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  _resolveIPA() {
    // In packaged app
    const packed = path.join(process.resourcesPath, 'WebDriverAgent.ipa');
    if (fs.existsSync(packed)) return packed;
    // In development
    const dev = path.join(__dirname, '..', 'resources', 'WebDriverAgent.ipa');
    if (fs.existsSync(dev)) return dev;
    return null;
  }

  _setState(status) {
    this.wdaStatus = status;
    this._emit();
  }

  _setError(msg) {
    this.wdaStatus = WDAStatus.ERROR;
    this.errorMessage = msg;
    this._log('error', 'device', msg);
    this._emit();
  }

  _log(level, source, message) {
    this.emit('log', { level, source, message, timestamp: new Date() });
  }

  _emit() {
    this.emit('state-changed');
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { DeviceManager, WDAStatus };
