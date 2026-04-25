'use strict';

/**
 * Thin wrapper around the `adb` command-line tool.
 * Searches common install locations when adb is not on PATH.
 */

const { execFile } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

// ── Binary resolution ────────────────────────────────────────────────────────

function _findAdb() {
  const extras = process.platform === 'win32'
    ? [
        path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
        path.join(process.env.PROGRAMFILES || '', 'Android', 'android-sdk', 'platform-tools', 'adb.exe'),
      ]
    : process.platform === 'darwin'
    ? [
        '/usr/local/bin/adb',
        '/opt/homebrew/bin/adb',
        path.join(os.homedir(), 'Library', 'Android', 'sdk', 'platform-tools', 'adb'),
        path.join(os.homedir(), 'Library', 'Android', 'Sdk', 'platform-tools', 'adb'),
      ]
    : [
        '/usr/bin/adb',
        '/usr/local/bin/adb',
        path.join(os.homedir(), 'Android', 'Sdk', 'platform-tools', 'adb'),
      ];

  for (const p of extras) {
    if (fs.existsSync(p)) return p;
  }
  return 'adb'; // rely on PATH
}

const adbBin = _findAdb();

// ── Helpers ──────────────────────────────────────────────────────────────────

function _run(args, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    execFile(adbBin, args, { timeout: timeoutMs }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns an array of connected Android devices in 'device' state.
 * Each entry: { serial, model }
 */
async function listDevices() {
  let stdout;
  try { stdout = await _run(['devices', '-l']); }
  catch (err) {
    // Propagate "not found" so callers can surface a helpful message
    if (err.code === 'ENOENT' || /not found|no such file/i.test(err.message)) throw err;
    return [];
  }

  const devices = [];
  for (const line of stdout.split('\n').slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    // Skip unauthorized, offline, etc.
    if (parts.length < 2 || parts[1] !== 'device') continue;
    const serial = parts[0];
    const modelMatch = trimmed.match(/model:(\S+)/);
    const model = modelMatch ? modelMatch[1].replace(/_/g, ' ') : serial;
    devices.push({ serial, model });
  }
  return devices;
}

/**
 * Returns detailed info for a specific device.
 * Result: { serial, deviceName, osVersion }
 */
async function getDeviceInfo(serial) {
  const prop = async (name) => {
    try { return (await _run(['-s', serial, 'shell', 'getprop', name], 5_000)).trim(); }
    catch (_) { return ''; }
  };

  const [model, version] = await Promise.all([
    prop('ro.product.model'),
    prop('ro.build.version.release'),
  ]);

  return {
    serial,
    deviceName: model || 'Android Device',
    osVersion: version || '',
  };
}

/**
 * Infer ANDROID_HOME / ANDROID_SDK_ROOT from the detected adb binary.
 * adb.exe lives at <ANDROID_HOME>/platform-tools/adb(.exe), so the SDK
 * root is the parent of platform-tools.
 * Returns null if we're falling back to PATH (no known root).
 */
function getAndroidHome() {
  if (adbBin === 'adb') return null; // on PATH only — unknown root
  const platformTools = path.dirname(adbBin);
  return path.dirname(platformTools);
}

module.exports = { listDevices, getDeviceInfo, getAndroidHome, adbBin };
