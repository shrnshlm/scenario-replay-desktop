# Deployment Guide

This guide walks through installing ScenarioReplay + the QA Automation
Chrome extension on a tester's Windows machine. Follow it top-to-bottom.

The whole stack:

```
Chrome extension (UI, recording, replay)
        │
        ▼  HTTP
ScenarioReplay desktop app
   ├── port 4723 → iOS proxy → go-ios → WDA on iPhone (port 8100)
   └── port 4724 → managed Appium → ADB → Android device
```

## 0. Prerequisites

Install these once on the machine:

- **Node.js LTS** — https://nodejs.org (gives you `node` and `npm`)
- **Google Chrome** — for the extension
- **Git** — to clone the repos (optional if you copy files manually)

## 1. ScenarioReplay desktop app

```powershell
git clone https://github.com/shrnshlm/scenario-replay-desktop
cd scenario-replay-desktop
npm install
npm start
```

The window should open with a STATUS panel for iOS and Android.

If `npm start` crashes with `Cannot read properties of undefined (reading 'requestSingleInstanceLock')`,
the shell has `ELECTRON_RUN_AS_NODE=1` set (VS Code does this). Either run from
a regular terminal, or `unset ELECTRON_RUN_AS_NODE` before `npm start`.

## 2. QA Automation Chrome extension

```powershell
git clone https://github.com/shrnshlm/qa-automation-extension
cd qa-automation-extension
npm install
npm run build
```

Then in Chrome:

1. Go to `chrome://extensions/`
2. Toggle **Developer mode** on (top right)
3. Click **Load unpacked**
4. Select the `dist` folder inside the cloned repo
5. Pin the extension to the toolbar so it's easy to click

## 3. Android setup

### 3.1 Install the Android SDK

Easiest path: install **Android Studio** from https://developer.android.com/studio.
After installation it auto-installs the SDK to
`%LOCALAPPDATA%\Android\Sdk` (which is what ScenarioReplay looks for).

If you don't want the full IDE, you can install just the platform-tools
(only `adb`) but Android Studio is simplest because it also helps create
emulators if you don't have a physical phone.

### 3.2 Enable USB debugging on the phone

1. **Settings → About phone**
2. Tap **Build number** 7 times to unlock developer options
3. Go to **Settings → Developer options**
4. Enable **USB debugging**

### 3.3 Xiaomi / MIUI extras

MIUI restricts more than stock Android. In **Developer options**, also enable:

- **Install via USB**
- **USB debugging (Security settings)** — may require a Mi account
- **Turn off MIUI optimization** (then reboot)

Without these, Appium can't install its helper APK and reset commands silently fail.

### 3.4 Connect and verify

1. Plug in the phone with USB
2. Tap **Allow USB debugging** on the phone
3. ScenarioReplay should show **Android Device: \<model\> (Android XX)**
   and **Appium: Connected**
4. First connection may take a minute — Appium installs a helper APK on the
   device

### 3.5 Add a cluster in the Chrome extension

- **Platform**: Android
- **Appium URL**: `http://localhost:4724`
- **Device Name**: leave the default or use the device serial from `adb devices`
- **App Package**: optional — if blank, the recorder kills whatever app is
  in the foreground when you start recording

## 4. iOS setup (Windows)

iOS is significantly harder than Android on Windows because of Apple driver
quirks. If the tester has a Mac, do the install there instead — the Mac
side just needs Xcode, no driver gymnastics.

### 4.1 Install iTunes (for the Apple USB drivers)

Don't use the Microsoft Store version — it's UWP and skips the desktop
drivers we need. Download the classic desktop installer from
https://www.apple.com/itunes/ and install it.

After install, verify:

```powershell
sc.exe query "Apple Mobile Device Service"
Test-Path "C:\Program Files\Common Files\Apple\Mobile Device Support"
```

Both should report success / `True`.

### 4.2 Install the Apple USB driver (if needed)

If `Test-Path` for `\Mobile Device Support\Drivers\usbaapl64.sys` returns
`False`, the silent install dropped components. Extract the driver from
the iTunes bundle and install it manually — open an **admin PowerShell**:

```powershell
# Extract iTunes installer payload
$out = "$env:TEMP\iTunesExtract"
New-Item -ItemType Directory $out -Force | Out-Null
Start-Process -FilePath "$env:TEMP\iTunesSetup.exe" `
  -ArgumentList "/extract `"$out`"" -Wait

# Administrative install of AMDS (extracts files only)
$amdsOut = "$env:TEMP\amdsContents"
New-Item -ItemType Directory $amdsOut -Force | Out-Null
Start-Process msiexec -ArgumentList '/a',
  "$out\AppleMobileDeviceSupport64.msi", '/qb',
  "TARGETDIR=`"$amdsOut`"" -Wait

# Install the USB driver
$inf = "$amdsOut\Common Files\Apple\Mobile Device Support\Drivers\usbaapl64.inf"
pnputil /add-driver "$inf" /install
```

### 4.3 Pair the iPhone

1. Plug in the iPhone
2. **Unlock the phone** (the trust prompt only shows on an unlocked screen)
3. Tap **Trust This Computer** when asked, enter passcode
4. Verify go-ios sees it:
   ```powershell
   $env:ENABLE_GO_IOS_AGENT='user'
   & "C:\path\to\scenario-replay-desktop\resources\win32\ios.exe" list
   ```
   Should print `{"deviceList":["<UDID>"]}`.

### 4.4 Install WebDriverAgent on the iPhone

WDA is the on-device tool that receives automation commands. It must be
built and signed with Xcode, so this step requires a Mac.

On the Mac:

1. Clone `https://github.com/appium/WebDriverAgent`
2. Open in Xcode, sign with your Apple Developer team
3. Build the **WebDriverAgentRunner** target for your iPhone (the device, not
   a simulator) — this side-loads the app onto the phone

Free Apple Developer accounts work but the signing expires every 7 days,
so you'll need to rebuild weekly. A paid account ($99/year) lasts a year.

You can verify WDA is installed by listing apps via go-ios:

```powershell
& "C:\path\to\scenario-replay-desktop\resources\win32\ios.exe" `
  apps --udid=<UDID> | Select-String "WebDriverAgent"
```

You should see a bundle ID like `com.facebook.WebDriverAgentRunner.xctrunner`
or `com.<your-team>.WebDriverAgentRunner.xctrunner`.

### 4.5 Restart ScenarioReplay and verify

After all of the above, restart the desktop app. The iOS panel should show:

- **Device**: \<phone name\> (iOS XX.X.X)
- **Proxy Server**: Running on port 4723
- **WebDriverAgent**: Connected (eventually — it can take 30-60 seconds the first time)

### 4.6 Add a cluster in the Chrome extension

- **Platform**: iOS
- **Appium URL**: `http://localhost:4723` (the proxy, NOT 4724)
- **Bundle ID**: bundle ID of the app under test
- **Device Name**: phone name from the desktop app

## 5. Verifying end-to-end

In the Chrome extension popup:

1. Open it, create a project
2. Add a cluster (per step 3.5 or 4.6)
3. Go to **Scenarios → Mobile**
4. Pick a cluster, name a scenario, click **Record**
5. Tap on the screenshot inside the popup — that controls the device
6. Click **Stop** when done
7. Go to **Run**, pick the scenario, pick clusters, click **Run**

If everything works, you'll see screenshots from each step in the results.

## 6. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Recorder error: "ANDROID_HOME not exported" | ScenarioReplay can't find SDK | Install Android Studio (puts SDK at `%LOCALAPPDATA%\Android\Sdk`) and restart the app |
| Recorder error: "Unable to resolve launchable activity" | App package set on a non-launchable system app | Leave App Package blank — the recorder auto-detects whatever's in the foreground |
| MIUI: "INSTALL_FAILED_USER_RESTRICTED" | "Install via USB" toggle is off | See section 3.3 |
| iOS: "Failed to start tunnel server: bind 60105" | Stale `ios.exe` from a previous run | `Stop-Process -Name ios -Force` and reconnect |
| iOS: "ReadPair failed errorcode 2" | Phone wasn't unlocked when plugged in | Unlock, replug, tap Trust |
| iOS: "WDA did not respond within 60 seconds" | WDA expired (free dev signing) or not installed | Rebuild WDA on the Mac |
| App resumes mid-flow on replay | Android restoring saved activity state | The recorder uses `am start --activity-clear-task` — make sure you're on the latest extension build |

## 7. Updating

To pull the latest version of either repo:

```powershell
cd C:\path\to\scenario-replay-desktop
git pull
npm install     # if package.json changed
# restart the app

cd C:\path\to\qa-automation-extension
git pull
npm install
npm run build
# in chrome://extensions click the "reload" icon on the extension
```
