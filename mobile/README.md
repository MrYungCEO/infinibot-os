# InfiniBot Mobile

A React Native / Expo client for the InfiniBot gateway: chat, sessions, kanban,
notes and terminals. Voice is local by default: the Voice page (More › Voice,
the dock mic, `infinibot://voice`) is the InfiniBot call page, which talks to
your gateway's local voice (Whisper → the selected agent → Kokoro). The
Robovoice console is the optional cloud voice (Voice engine › Cloud on that
page, or `infinibot://robovoice`).

Built on **Expo SDK 58** (React Native 0.88, React 19.3, New Architecture only).

> **Expo Go (SDK 58) runs the app** for day-to-day JavaScript work: `npx expo start`
> and scan the QR code. Two things need a **development build** (EAS or
> Xcode/Android Studio) instead: remote push notifications (Expo Go has none, so
> the app skips push registration there; local alerts and the in-app
> notification center still work) and your own bundle id, deep-link scheme and
> app links.

## Prerequisites

- Node.js 22.13+ (or 24.3+) and npm — Expo SDK 58 rejects Node 20 and odd-numbered releases
- A running InfiniBot gateway reachable from your phone (WebSocket on port `18789`)
- One of:
  - an [Expo account](https://expo.dev/signup) plus `npm i -g eas-cli` (cloud builds), or
  - Xcode (iOS) or Android Studio with the Android SDK (local builds)

## 1. Install

```bash
cd mobile
npm install
```

## 2. Set your own app identity

Nothing in the repo points at a real Expo account or store listing. `app.json`
ships neutral defaults (`com.example.infinibot`, no EAS project, no owner) and
`app.config.js` overlays your values from environment variables:

| Variable | Used for | Default |
|---|---|---|
| `INFINIBOT_IOS_BUNDLE_ID` | `ios.bundleIdentifier` | `com.example.infinibot` |
| `INFINIBOT_ANDROID_PACKAGE` | `android.package` | the iOS bundle id |
| `INFINIBOT_EAS_PROJECT_ID` | `extra.eas.projectId` | unset |
| `INFINIBOT_EXPO_OWNER` | `owner` (Expo account or org) | unset |
| `INFINIBOT_EXPO_SLUG` | `slug` (must match your EAS project) | `moltbot-mobile` |
| `INFINIBOT_GOOGLE_SERVICES_FILE` | `android.googleServicesFile` | `./google-services.json` if present |

Put them in `mobile/.env.owner` (gitignored), or point
`INFINIBOT_MOBILE_ENV_FILE` at another dotenv file. Real environment variables
win over the file.

```bash
# mobile/.env.owner
INFINIBOT_IOS_BUNDLE_ID=com.yourname.infinibot
INFINIBOT_ANDROID_PACKAGE=com.yourname.infinibot
INFINIBOT_EXPO_OWNER=your-expo-username
INFINIBOT_EAS_PROJECT_ID=        # filled in by step 3
```

Check what Expo will use:

```bash
npx expo config --type public
```

## 3. Create the development build

### With EAS (cloud)

```bash
eas login
eas init          # creates an EAS project and prints its id
# copy the id into INFINIBOT_EAS_PROJECT_ID in .env.owner
eas build --profile development --platform ios      # or android
```

EAS evaluates `app.config.js` again on its build servers, so those servers need
the same values. EAS respects `.gitignore` when uploading, which means
`.env.owner` is **not** uploaded by default. Pick one:

- add the variables as EAS environment variables (`eas env:create`), or
- add them to the `env` block of the build profile in `eas.json` (in your fork), or
- add a `mobile/.easignore` (it replaces `.gitignore` for uploads) that does not
  exclude `.env.owner`.

Install the resulting build on your phone (EAS prints a QR/link).

### Locally

```bash
npx expo run:ios --device       # needs Xcode and an Apple developer team
npx expo run:android --device   # needs Android Studio / SDK
```

This runs `expo prebuild` (generating the gitignored `ios/` and `android/`
folders) and installs the dev build.

## 4. Run

```bash
npm start          # expo start --port 8082
```

Open the dev build on your phone and pick the dev server. Rebuild the app only
when native dependencies or `app.json`/`app.config.js` change.

## 5. Connect

On first launch the app shows a connection chooser (you can add more later in
More › Connections and switch between them):

- **InfiniBot Cloud** — sign in with your InfiniBot account (Clerk: email +
  password / email code, or Google). The app resolves your workspace's gateway
  through the fleet orchestrator (`POST /fleet/resolve`, waking it if it is
  asleep) and sends a fresh Clerk session token with every request. Only shown
  when the build has `INFINIBOT_CLERK_PUBLISHABLE_KEY` and
  `INFINIBOT_CLOUD_ORCHESTRATOR_URL` (see `app.config.js`).
- **Self-hosted gateway** — scan the pairing QR on the web UI's Setup › Mobile
  page, or type the address and the gateway password or token. A bare host
  gets port `18789` (`192.168.1.20`, `my-pc.tailnet.ts.net`); `https://` /
  `wss://` addresses use 443 (reverse proxy / `tailscale serve`). The app runs
  a real handshake before saving, so a wrong port or secret is reported
  right away.

Every HTTP call and the WebSocket carry the credential (the gateway's HTTP
auth gate answers 401 otherwise). Web pages (the Voice page, plugin pages, …) are
served by the gateway from that same URL.

## Plugins

The More index and the Launchpad show one section per plugin that is **on**
on the connected gateway (`plugins.list`), refreshed on every reconnect. Pages
with a native screen (Discipline, Content Studio, Business & Agency CRM
pages, …) open natively; the rest open the plugin's web page in an
authenticated, chromeless WebView. More › Plugins lists every plugin, lets the
owner/admin turn them on or off (the gateway restarts, same as on the web), and
shows what each one adds and is allowed to do.

## Deep links

Alerts (push, Telegram, in-app, proactive) carry `infinibot://…` links, or
`https://<gateway-or-cloud>/m/…` where an https URL is required. See
[`docs/mobile/DEEP-LINKS.md`](../docs/mobile/DEEP-LINKS.md) for the path
table. Try one on a device or emulator:

```bash
adb shell am start -a android.intent.action.VIEW -d "infinibot://plugin/infinitrade/signals"
```

## Android APK (sideload)

A release APK can be built locally without EAS (Android SDK + JDK 17):
`npx expo prebuild -p android`, then `cd android && ./gradlew assembleRelease`.
Publish it to the gateway so Setup › Mobile offers the download and a QR:
`node scripts/mobile-apk-publish.mjs <app-release.apk>` (from the repo root).
Keep the signing keystore outside the repo. Or with EAS:
`eas build -p android --profile preview` (produces an APK).

## Push notifications (optional)

Android push needs a Firebase project. Copy `google-services.example.json` to
`google-services.json` (gitignored), replace it with the file Firebase gives you
for your package name, and rebuild. Without it the app builds and runs, but
it gets no FCM push.

## Tests

```bash
npm test
```

## Troubleshooting

| Issue | Solution |
|---|---|
| "Disconnected" status | Check the gateway URL in Settings and make sure the gateway is running on `18789` |
| Can't connect from phone | Use the computer's LAN or Tailscale IP, not `localhost`, and make sure it's reachable |
| Auth errors / 401 | Re-add the connection (More › Connections) with the right password or token — pick Token vs Password to match `gateway.auth.mode` |
| "Project is incompatible with this version of Expo Go" | The app is on SDK 58; update Expo Go to 58.x (or use a development build, step 3) |
| EAS: "project id does not match" / slug mismatch | Set `INFINIBOT_EAS_PROJECT_ID` and `INFINIBOT_EXPO_SLUG` for your project, and make them visible to EAS (step 3) |
