module.exports = {
  packagerConfig: {
    name: 'ScenarioReplay',
    asar: true,
    // Ship resources/<platform>/ios.exe and any other resources alongside the app
    extraResource: ['./resources'],
    // ignore dev-only files in the packaged build
    ignore: [
      /^\/out($|\/)/,
      /^\/\.git($|\/)/,
      /^\/\.gitignore$/,
      /^\/DEPLOYMENT\.md$/,
      /^\/forge\.config\.js$/,
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
