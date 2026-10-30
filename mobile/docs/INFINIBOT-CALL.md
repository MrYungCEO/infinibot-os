# InfiniBot call page, quick capture and Ideas

## What it is
- **Call page** (`src/screens/InfiniCallScreen.js`): a full-screen, friendly InfiniBot character (`src/infini/InfiniFace.js`). It's a gold glass orb with a dark visor and the logo's ∞ for eyes.
  - **States:** idle, listening, thinking, speaking, error. The mouth follows the mic level while listening and the TTS amplitude while speaking.
  - **Gestures:** tap = talk / send / interrupt. Long-press = call options. A separate "Hold to talk" button does push-to-talk.
  - **Reduce Motion:** freezes all movement. The face still changes expression with each state.
- **Voice**: LOCAL by default, using the same protocol as the web Voice page's local engine (`ui/src/ui/views/voice-robovoice/local-call-session.ts`):
  - `POST /api/voice/stt` (local Whisper)
  - `POST /api/voice/turn` (SSE; the gateway voice seam answers via direct CLI routing or the selected gateway agent)
  - `POST /api/voice/tts` (local Kokoro), sentence by sentence
- **Options** (long-press) share the web Voice Terminal's switches through the same RPCs:
  - `voice.cliRoute.*`: gateway agent vs CLI agent (Claude Code / Codex / OpenCode, open session or start a new one)
  - `agents.list`: which agent
  - `sessions.list`: which session
  - `voice.providers.*`: voice engine, Local or Cloud. Choosing Cloud opens the Robovoice console; that's the only phone entry to it besides `infinibot://robovoice`.
- **Quick capture**: Note / Idea / Task / Project / Log buttons orbit the face. Each one records speech (or takes typed text), then:
  1. `capture.structure` (AI title, body, tags, project, due date and priority; heuristics if no model answers)
  2. a confirm card where you edit, save or discard
  3. `capture.save` (idempotent `clientRequestId`)
  
  If the gateway can't be reached, captures are queued in AsyncStorage and retried (`src/infini/capture-queue.js`).
- **Ideas** (Knowledge › Ideas, `src/screens/IdeasScreen.js`): list, search, status filter, quick add, promote to task / project / document. They refresh live on `ideas.changed`.
- **Entry points**:
  - the dock's gold ∞ button
  - More/Launchpad › "InfiniBot"
  - `infinibot://voice`, `infinibot://call`
  - `infinibot://ideas`

## Web export served by the gateway
`npm run web:build` builds with `baseUrl=/mobile-web` (see `app.config.js`), because the gateway serves the export at `/mobile-web/`. The live install serves `<repo>/mobile/dist`.

On first open the export connects to its own origin:
- `wss://host` behind Tailscale Serve, or `ws://host:port`.
- It reuses the web control UI's saved password or token on that origin.
- Otherwise the chooser is prefilled and asks for the password, which is then saved on the device.

A banner shows connection failures with Retry and Change connection.

The secret is never compiled into the bundle, because `/mobile-web` is a public static route.

## Native build (EAS)
This change adds two native modules, `expo-audio` (recording, playback, metering) and `expo-haptics`. Both are in Expo Go SDK 57.

The **InfiniBot dev client and release builds must be rebuilt** before the call page can use the mic:

```bash
cd mobile
npm ci --legacy-peer-deps          # NPM_CONFIG_LEGACY_PEER_DEPS=true in eas.json env
npx eas-cli build --profile development --platform android   # dev client (APK, internal)
npx eas-cli build --profile development --platform ios       # dev client (registered devices)
npx eas-cli build --profile preview --platform android       # shareable APK
npx eas-cli build --profile production --platform ios        # App Store / TestFlight IPA
```

Requirements: an Expo login (`npx expo login`) as the project owner, or `EXPO_TOKEN`; and `.env.owner` with `INFINIBOT_EAS_PROJECT_ID`, `INFINIBOT_EXPO_OWNER` and the bundle ids.

EAS cloud builds are billed per build, so trigger them deliberately. Microphone permission strings come from the `expo-audio` and `expo-camera` plugins in `app.json`.
