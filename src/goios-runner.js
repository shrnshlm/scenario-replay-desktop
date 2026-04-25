'use strict';

/**
 * Wraps the bundled go-ios binary via child_process.
 * Port of GoIOSRunner.swift.
 */

const { execFile, spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app } = require('electron');

const WDA_BUNDLE_ID = 'com.facebook.WebDriverAgentRunner';
const WDA_XCTRUNNER_ID = 'com.facebook.WebDriverAgentRunner.xctrunner';
const WDA_XCTEST_CONFIG = 'WebDriverAgentRunner.xctest';

class GoIOSRunner {
  constructor() {
    this._binaryPath = null;
    this._workDir = null;
  }

  init() {
    this._binaryPath = this._resolveBinary();
    this._workDir = this._resolveWorkDir();

    // Ensure binary is executable
    try { fs.chmodSync(this._binaryPath, 0o755); } catch (_) {}

    // Remove macOS quarantine attribute so the binary runs without a dialog
    if (process.platform === 'darwin') {
      try {
        execFileSync('xattr', ['-d', 'com.apple.quarantine', this._binaryPath], { stdio: 'ignore' });
      } catch (_) {}
    }
  }

  _resolveBinary() {
    // In packaged app: resources/<platform>/ios (or ios.exe on Windows)
    const exe = process.platform === 'win32' ? 'ios.exe' : 'ios';
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'resources', process.platform, exe);
    }
    // In development: look relative to project root
    const devPath = path.join(__dirname, '..', 'resources', process.platform, exe);
    if (fs.existsSync(devPath)) return devPath;
    // Last resort: system PATH
    return process.platform === 'win32' ? 'ios.exe' : 'ios';
  }

  _resolveWorkDir() {
    const appData = app.getPath('userData');
    const dir = path.join(appData, 'goios');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  _baseEnv() {
    return { ...process.env, ENABLE_GO_IOS_AGENT: 'user' };
  }

  // ── One-shot commands ──────────────────────────────────────────────────

  listDevices() {
    return new Promise((resolve, reject) => {
      execFile(this._binaryPath, ['list'], { env: this._baseEnv(), cwd: this._workDir }, async (err, stdout) => {
        if (err) { reject(err); return; }
        try {
          const parsed = JSON.parse(stdout.trim());
          // v1+ format: { deviceList: ["udid1", ...] }
          let udids = parsed.deviceList;
          if (!Array.isArray(udids)) {
            // Older format: direct array of DeviceInfo objects
            const items = Array.isArray(parsed) ? parsed : [];
            resolve(items.map(d => ({
              id: d.Udid || d.udid || d.UDID || '',
              deviceName: d.DeviceName || d.deviceName || 'iPhone',
              osVersion: d.ProductVersion || d.productVersion || 'Unknown',
            })));
            return;
          }
          // Fetch info for each UDID
          const devices = [];
          for (const udid of udids) {
            try {
              const info = await this.fetchDeviceInfo(udid);
              devices.push(info);
            } catch (_) {
              devices.push({ id: udid, deviceName: 'iPhone', osVersion: 'Unknown' });
            }
          }
          resolve(devices);
        } catch (_) {
          resolve([]);
        }
      });
    });
  }

  fetchDeviceInfo(udid) {
    return new Promise((resolve, reject) => {
      execFile(
        this._binaryPath, ['info', `--udid=${udid}`],
        { env: this._baseEnv(), cwd: this._workDir },
        (err, stdout) => {
          if (err) { reject(err); return; }
          try {
            const info = JSON.parse(stdout.trim());
            resolve({
              id: udid,
              deviceName: info.DeviceName || info.deviceName || 'iPhone',
              osVersion: info.ProductVersion || info.productVersion || 'Unknown',
            });
          } catch (_) {
            resolve({ id: udid, deviceName: 'iPhone', osVersion: 'Unknown' });
          }
        },
      );
    });
  }

  /**
   * List all installed user apps on the device. Returns an array of
   * { bundleId, name } objects, sorted by bundleId.
   *
   * Used to auto-detect the WDA bundle ID — it's almost never
   * com.facebook.WebDriverAgentRunner.xctrunner in practice (you have to
   * re-sign WDA with your own Apple Developer team prefix to install it
   * on a real device, e.g. com.<team>.WebDriverAgentRunner.xctrunner).
   */
  listApps(udid) {
    return new Promise((resolve, reject) => {
      // `ios apps --udid=X` produces a giant JSON dump (one object per app).
      // We bump maxBuffer to avoid truncation on devices with hundreds of apps.
      execFile(
        this._binaryPath,
        ['apps', `--udid=${udid}`],
        { env: this._baseEnv(), cwd: this._workDir, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 },
        (err, stdout) => {
          if (err) { reject(err); return; }
          try {
            // Output format: a JSON array of app dicts. Each has CFBundleIdentifier
            // and either CFBundleDisplayName or CFBundleName.
            const arr = JSON.parse(stdout.trim());
            const apps = (Array.isArray(arr) ? arr : []).map(a => ({
              bundleId: a.CFBundleIdentifier ?? '',
              name: a.CFBundleDisplayName ?? a.CFBundleName ?? '',
            })).filter(a => a.bundleId);
            apps.sort((a, b) => a.bundleId.localeCompare(b.bundleId));
            resolve(apps);
          } catch (e) {
            reject(new Error(`Failed to parse app list: ${e.message}`));
          }
        },
      );
    });
  }

  /**
   * Find the bundle ID of the WebDriverAgentRunner installed on this device.
   * Matches any bundle ID ending in `.WebDriverAgentRunner.xctrunner`, so it
   * works whether WDA was signed with com.facebook.* (Apple's example) or
   * com.<your-team>.* (the typical case for self-built WDA).
   * Returns null if no WDA is installed.
   */
  async findWDABundleId(udid) {
    try {
      const apps = await this.listApps(udid);
      const match = apps.find(a => /\.WebDriverAgentRunner\.xctrunner$/.test(a.bundleId));
      return match ? match.bundleId : null;
    } catch {
      return null;
    }
  }

  /**
   * Run `ios pair --udid=...`. Triggers the Trust dialog on the device
   * and blocks until the user taps Trust or the timeout fires.
   * Resolves on success, rejects on failure (timeout / declined / no device).
   */
  pair(udid, timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
      execFile(
        this._binaryPath,
        ['pair', `--udid=${udid}`],
        { env: this._baseEnv(), cwd: this._workDir, timeout: timeoutMs },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error((stderr && stderr.trim()) || err.message));
          } else {
            resolve(stdout);
          }
        },
      );
    });
  }

  installWDA(udid, ipaPath) {
    return new Promise((resolve, reject) => {
      execFile(
        this._binaryPath,
        ['install', `--path=${ipaPath}`, `--udid=${udid}`],
        { env: this._baseEnv(), cwd: this._workDir, timeout: 120_000 },
        (err, stdout, stderr) => {
          if (err) reject(new Error(stderr || err.message));
          else resolve(stdout);
        },
      );
    });
  }

  // ── Long-running processes ─────────────────────────────────────────────

  /**
   * Spawn a long-running go-ios process.
   * @param {string[]} args - CLI arguments
   * @param {(line: string) => void} onOutput - called for each output line
   * @returns {ChildProcess}
   */
  _launch(args, onOutput) {
    const proc = spawn(this._binaryPath, args, {
      env: this._baseEnv(),
      cwd: this._workDir,
    });

    const handleData = (prefix) => (data) => {
      const text = data.toString();
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) onOutput(prefix + trimmed);
      }
    };

    proc.stdout.on('data', handleData(''));
    proc.stderr.on('data', handleData('[stderr] '));

    return proc;
  }

  startTunnel(udid, onOutput) {
    return this._launch(['tunnel', 'start', `--udid=${udid}`, '--userspace'], onOutput);
  }

  startPortForward(udid, onOutput) {
    return this._launch(['forward', '8100', '8100', `--udid=${udid}`], onOutput);
  }

  /**
   * Launch WebDriverAgent on the device.
   * @param {string} udid
   * @param {string} bundleId - the WDA xctrunner bundle id (e.g.
   *   com.facebook.WebDriverAgentRunner.xctrunner or
   *   com.<team>.WebDriverAgentRunner.xctrunner). Pass the value returned
   *   by findWDABundleId(udid) so it works with self-signed builds too.
   */
  startWDA(udid, bundleId, onOutput) {
    // Back-compat: if called as startWDA(udid, onOutput), fall back to the
    // hardcoded Facebook id so older callers still work.
    if (typeof bundleId === 'function' && onOutput === undefined) {
      onOutput = bundleId;
      bundleId = WDA_XCTRUNNER_ID;
    }
    return this._launch([
      'runwda',
      `--bundleid=${bundleId}`,
      `--testrunnerbundleid=${bundleId}`,
      `--xctestconfig=${WDA_XCTEST_CONFIG}`,
      `--udid=${udid}`,
    ], onOutput);
  }
}

module.exports = new GoIOSRunner();
