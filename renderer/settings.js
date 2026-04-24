'use strict';

const portInput   = document.getElementById('proxy-port');
const portError   = document.getElementById('port-error');
const portUrl     = document.getElementById('port-url');
const wdaPath     = document.getElementById('wda-path');
const wdaSection  = document.getElementById('wda-section');
const btnSave     = document.getElementById('btn-save');

(async () => {
  const [settings, platform] = await Promise.all([
    window.electronAPI.getSettings(),
    window.electronAPI.getPlatform(),
  ]);

  portInput.value = settings.proxyPort;
  wdaPath.value   = settings.wdaProjectPath || '';
  portUrl.textContent = `Chrome extension cluster URL: http://localhost:${settings.proxyPort}`;

  // WDA path only relevant on macOS
  if (platform !== 'darwin') wdaSection.style.display = 'none';
})();

portInput.addEventListener('input', () => {
  const p = parseInt(portInput.value, 10);
  const valid = p > 1024 && p <= 65535;
  portError.style.display = valid ? 'none' : '';
  portUrl.textContent = valid
    ? `Chrome extension cluster URL: http://localhost:${p}`
    : '';
});

btnSave.addEventListener('click', async () => {
  const p = parseInt(portInput.value, 10);
  if (!(p > 1024 && p <= 65535)) return;
  await window.electronAPI.saveSettings({
    proxyPort: p,
    wdaProjectPath: wdaPath.value.trim(),
  });
  window.close();
});
