'use strict';

/**
 * Manages the Android device + Appium lifecycle.
 * Mirrors device-manager.js in structure but uses ADB instead of go-ios
 * and starts a full Appium server on port 4724 instead of a thin WDA proxy.
 *
 * Appium is installed locally to the app's userData directory so no elevated
 * privileges are ever needed (avoids sudo/admin prompts).
 */

const { EventEmitter } = require('events');
const { exec, spawn } = require('child_process');
const { app } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');

const adb = require('./adb-runner');

// ── Constants ────────────────────────────────────────────────────────────────

const DEVICE_POLL_MS    = 3_000;
const APPIUM_POLL_MS    = 2_000;
const APPIUM_TIMEOUT_MS = 60_000;
const APPIUM_WATCHER_MS = 5_000;
const APPIUM_PORT       = 4724;

// ── Status enum ──────────────────────────────────────────────────────────────

const AndroidStatus = {
  IDLE:          'No Android device',
  DETECTED:      'Android device detected',
  CHECKING:      'Checking Appium...',
  NEEDS_INSTALL: 'Appium not installed',
  INSTALLING:    'Installing Appium...',
  LAUNCHING:     'Starting Appium...',
  READY:         'Connected',
  ERROR:         'Error',
};

// ── Manager ──────────────────────────────────────────────────────────────────

class AndroidManager extends EventEmitter {
  constructor() {
    super();
    this.connectedDevice = null;
    this.status = AndroidStatus.IDLE;
    this.errorMessage = null;

    this._pollTimer = null;
    this._watcherTimer = null;
    this._appiumProc = null;
    this._setupCancelled = false;
    this._adbMissingLogged = false;
  }

  // ── Local Appium path helpers ──────────────────────────────────────────────

  _localAppiumDir() {
    return path.join(app.getPath('userData'), 'appium');
  }

  _localAppiumBin() {
    const bin = process.platform === 'win32' ? 'appium.cmd' : 'appium';
    return path.join(this._localAppiumDir(), 'node_modules', '.bin', bin);
  }

  // Resolve the appium binary: local userData install first, then PATH.
  async _resolveAppiumBin() {
    const local = this._localAppiumBin();
    if (fs.existsSync(local)) return local;

    // Fall back to PATH
    return new Promise((resolve) => {
      exec('appium --version', { timeout: 5_000 }, (err, stdout) => {
        resolve(!err && stdout.trim() ? 'appium' : null);
      });
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  startMonitoring() {
    this._pollTimer = setInterval(() => this._pollDevices(), DEVICE_POLL_MS);
    this._pollDevices();
  }

  stopMonitoring() {
    clearInterval(this._pollTimer);
    this._pollTimer = null;
  }

  disconnect() {
    this._setupCancelled = true;
    this._teardown();
    const hadDevice = this.connectedDevice !== null;
    this.connectedDevice = null;
    this.errorMessage = null;
    this._setState(hadDevice ? AndroidStatus.DETECTED : AndroidStatus.IDLE);
  }

  /**
   * Called from IPC when the user clicks "Install Appium".
   * Installs appium + uiautomator2 to the app's userData directory
   * (no sudo/admin needed), then resumes the setup flow automatically.
   */
  async installAppium() {
    if (this.status === AndroidStatus.INSTALLING) return;

    this._setState(AndroidStatus.INSTALLING);
    this._log('info', 'android', 'Installing Appium — this may take a minute...');

    const prefix = this._localAppiumDir();
    const appiumBin = this._localAppiumBin();

    try {
      // Step 1: npm install --prefix <userData>/appium appium
      await this._runCmd(
        `npm install --prefix "${prefix}" appium`,
        'npm install appium'
      );

      // Step 2: install uiautomator2 driver into the local appium
      await this._runCmd(
        `"${appiumBin}" driver install uiautomator2`,
        'appium driver install uiautomator2'
      );

      this._log('info', 'android', 'Appium installed successfully');

      // Resume setup if a device is still connected
      if (this.connectedDevice && !this._setupCancelled) {
        this._setupCancelled = false;
        this._runSetup(this.connectedDevice).catch((err) => {
          if (!this._setupCancelled) this._setError(`Setup failed: ${err.message}`);
        });
      }
    } catch (err) {
      const msg = err.message || '';
      const isPermission = /EACCES|EPERM|permission denied|access denied/i.test(msg);
      const isNpmMissing = /npm.*not found|command not found.*npm|'npm' is not recognized/i.test(msg);

      if (isNpmMissing) {
        this._setError('npm not found. Install Node.js from https://nodejs.org then try again.');
      } else if (isPermission) {
        const hint = process.platform === 'win32'
          ? 'Right-click ScenarioReplay and choose "Run as administrator", then try again.'
          : 'Try running ScenarioReplay with elevated privileges (sudo).';
        this._setError(`Permission denied during install. ${hint}`);
      } else {
        this._setError(`Appium installation failed: ${msg}`);
      }
    }
  }

  // ── Device polling ─────────────────────────────────────────────────────────

  async _pollDevices() {
    let devices;
    try {
      devices = await adb.listDevices();
      this._adbMissingLogged = false; // reset if adb comes back
    } catch (err) {
      if (!this._adbMissingLogged) {
        this._adbMissingLogged = true;
        const hint = process.platform === 'darwin'
          ? 'Install Android Studio, or run: brew install android-platform-tools'
          : process.platform === 'win32'
          ? 'Install Android Studio and ensure platform-tools are in your PATH.'
          : 'Run: sudo apt install adb  (or equivalent for your distro)';
        this._log('warn', 'android', `ADB not found — Android device detection disabled. ${hint}`);
      }
      devices = [];
    }

    const first = devices[0] ?? null;

    if (!first && this.connectedDevice) {
      this._log('info', 'android', 'Android device disconnected');
      this._teardown();
      this.connectedDevice = null;
      this._setState(AndroidStatus.IDLE);
    } else if (first && (!this.connectedDevice || first.serial !== this.connectedDevice.serial)) {
      this._log('info', 'android', `Android device detected: ${first.model}`);
      if (this.connectedDevice) this._teardown();
      this.connectedDevice = first;
      this._setupCancelled = false;
      this._setState(AndroidStatus.DETECTED);
      this._runSetup(first).catch((err) => {
        if (!this._setupCancelled) this._setError(`Setup failed: ${err.message}`);
      });
    }
  }

  // ── Setup sequence ─────────────────────────────────────────────────────────

  async _runSetup(device) {
    // Fetch full device info
    try {
      const info = await adb.getDeviceInfo(device.serial);
      this.connectedDevice = info;
      this._emit();
      this._log('info', 'android', `${info.deviceName} (Android ${info.osVersion})`);
    } catch (_) {}
    if (this._setupCancelled) return;

    // Reuse if Appium is already running
    if (await this._isAppiumReady()) {
      this._log('info', 'android', 'Appium already running — reusing');
      this._setState(AndroidStatus.READY);
      this._startWatcher();
      return;
    }
    if (this._setupCancelled) return;

    // Find Appium binary
    this._setState(AndroidStatus.CHECKING);
    const appiumBin = await this._resolveAppiumBin();
    if (!appiumBin) {
      // Not found — ask user to install via the UI button
      this._log('warn', 'android', 'Appium not found — click "Install Appium" to install automatically');
      this.status = AndroidStatus.NEEDS_INSTALL;
      this.errorMessage = null;
      this._emit();
      return;
    }
    if (this._setupCancelled) return;

    await this._launchAppium(appiumBin);
  }

  async _launchAppium(appiumBin) {
    this._setState(AndroidStatus.LAUNCHING);
    this._log('info', 'android', `Starting Appium on port ${APPIUM_PORT}...`);

    const proc = spawn(appiumBin, ['--port', String(APPIUM_PORT), '--log-level', 'warn'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    proc.stdout?.on('data', (d) => {
      const text = d.toString().trim();
      if (text) this._log('info', 'android', `[appium] ${text}`);
    });
    proc.stderr?.on('data', (d) => {
      const text = d.toString().trim();
      if (text) this._log('info', 'android', `[appium] ${text}`);
    });
    proc.on('exit', (code) => {
      if (!this._setupCancelled && this.status === AndroidStatus.READY) {
        this._setError(`Appium exited unexpectedly (code ${code})`);
      }
    });
    this._appiumProc = proc;

    // Poll for readiness
    const deadline = Date.now() + APPIUM_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this._setupCancelled) return;
      await sleep(APPIUM_POLL_MS);
      if (await this._isAppiumReady()) {
        this._setState(AndroidStatus.READY);
        this._startWatcher();
        return;
      }
    }

    if (!this._setupCancelled) {
      this._setError('Appium did not start within 60 seconds');
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  _isAppiumReady() {
    return new Promise((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port: APPIUM_PORT, path: '/status', method: 'GET' },
        (res) => { res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 400); }
      );
      req.setTimeout(3_000, () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
      req.end();
    });
  }

  // Run a shell command and stream its output to the activity log.
  _runCmd(cmd, label) {
    return new Promise((resolve, reject) => {
      this._log('info', 'android', `Running: ${label}`);
      const proc = exec(cmd, { timeout: 300_000 /* 5 min */ });
      proc.stdout?.on('data', (d) => {
        const text = d.toString().trim();
        if (text) this._log('info', 'android', text);
      });
      proc.stderr?.on('data', (d) => {
        const text = d.toString().trim();
        if (text) this._log('info', 'android', text);
      });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`"${label}" exited with code ${code}`));
      });
      proc.on('error', reject);
    });
  }

  _startWatcher() {
    clearInterval(this._watcherTimer);
    this._watcherTimer = setInterval(async () => {
      const ready = await this._isAppiumReady();
      if (ready && this.status !== AndroidStatus.READY) {
        this.errorMessage = null;
        this._setState(AndroidStatus.READY);
      } else if (!ready && this.status === AndroidStatus.READY) {
        this.errorMessage = 'Appium stopped responding';
        this.status = AndroidStatus.ERROR;
        this._emit();
      }
    }, APPIUM_WATCHER_MS);
  }

  _teardown() {
    clearInterval(this._watcherTimer);
    this._watcherTimer = null;
    if (this._appiumProc) {
      try { this._appiumProc.kill(); } catch (_) {}
      this._appiumProc = null;
    }
  }

  _setState(status) { this.status = status; this._emit(); }

  _setError(msg) {
    this.status = AndroidStatus.ERROR;
    this.errorMessage = msg;
    this._log('error', 'android', msg);
    this._emit();
  }

  _log(level, source, message) {
    this.emit('log', { level, source, message, timestamp: new Date() });
  }

  _emit() { this.emit('state-changed'); }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { AndroidManager, AndroidStatus };
