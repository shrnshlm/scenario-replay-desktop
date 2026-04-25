module.exports = {
  packagerConfig: {
    name: 'ScenarioReplay',
    asar: true,
    // Strip devDependencies from node_modules before packaging — without
    // this, the Squirrel installer ships @electron-forge/* and friends
    // (~50MB of dev tooling that runtime never touches).
    prune: true,
    // Ship resources/<platform>/ios.exe and any other resources alongside the app
    extraResource: ['./resources'],
    // ignore dev-only files in the packaged build
    ignore: [
      /^\/out($|\/)/,
      /^\/\.git($|\/)/,
      /^\/\.gitignore$/,
      /^\/DEPLOYMENT\.md$/,
      /^\/forge\.config\.js$/,
      /^\/selfIdentity\.plist$/,
      /^\/\.claude($|\/)/,
    ],
  },
  rebuildConfig: {},
  makers: [
    // Windows: Squirrel installer (.exe)
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'ScenarioReplay',
        setupExe: 'ScenarioReplay-Setup.exe',
      },
    },
    // macOS: DMG
    {
      name: '@electron-forge/maker-dmg',
      config: {},
      platforms: ['darwin'],
    },
    // Linux: .deb
    {
      name: '@electron-forge/maker-deb',
      config: {},
      platforms: ['linux'],
    },
    // Cross-platform fallback: zip
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'linux', 'win32'],
    },
  ],
};
