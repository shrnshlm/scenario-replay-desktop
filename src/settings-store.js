'use strict';

// Lazy-initialized electron-store singleton.
// device-manager.js imports this at call time (not module load) to avoid
// initializing electron-store before the Electron app is ready.

let _store = null;

function getStore() {
  if (!_store) {
    const Store = require('electron-store');
    _store = new Store({
      defaults: {
        proxyPort: 4723,
        wdaProjectPath: '',
      },
    });
  }
  return _store;
}

module.exports = {
  get: (key, def) => getStore().get(key, def),
  set: (key, value) => getStore().set(key, value),
};
