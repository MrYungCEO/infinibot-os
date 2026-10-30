/**
 * Local voice is the default; Robovoice is the opt-in cloud voice
 * (docs/voice/LOCAL-DEFAULT.md). The Voice page keeps its current UI: the same
 * console + session view run on a local engine (VAD → /api/voice/stt →
 * /api/voice/turn → /api/voice/tts) unless "Cloud voice (Robovoice)" is chosen.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  cloudVoiceSelected,
  isCloudVoiceActive,
  setVoiceProvidersState,
  type VoiceProvidersPayload,
} from "../../controllers/voice-provider.js";
import { LOCAL_SPEECH_CATALOG, speechGate } from "../../components/chat-speech-state.js";

const here = dirname(fileURLToPath(import.meta.url));
const UI = join(here, "../.."); // ui/src/ui
const code = (f: string) => readFileSync(join(UI, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const payload = (backend: string, realtime: string): VoiceProvidersPayload => ({
  backend,
  active: { realtime, stt: "local", tts: "local", wakeWord: "local" },
  fellBack: false,
  providers: [],
});

describe("local voice is the default", () => {
  afterEach(() => setVoiceProvidersState(null));

  it("unknown / auto / local selections run local voice; only an explicit, served robovoice is cloud", () => {
    expect(isCloudVoiceActive()).toBe(false);
    expect(cloudVoiceSelected(null)).toBe(false);
    expect(cloudVoiceSelected(payload("auto", "local"))).toBe(false);
    expect(cloudVoiceSelected(payload("local", "local"))).toBe(false);
    // Selected but the plugin is off / unlinked: the gateway falls back to local.
    expect(cloudVoiceSelected(payload("robovoice", "local"))).toBe(false);
    expect(cloudVoiceSelected(payload("robovoice", "robovoice"))).toBe(true);
    setVoiceProvidersState(payload("robovoice", "robovoice"));
    expect(isCloudVoiceActive()).toBe(true);
  });

  it("the call store runs the local engine unless cloud voice is active", () => {
    const store = code("views/voice-robovoice/call-store.ts");
    expect(store).toMatch(/isCloudVoiceActive\(\) \? "robovoice" : "local"/);
    expect(store).toMatch(/new LocalVoiceCallSession\(browserLocalCallDeps\(emit\)\)/);
    // Wake words / voice buttons start a local call with no account check.
    expect(store).toMatch(/if \(voiceCallEngine\(\) === "local"\) \{[\s\S]*?return "calling";/);
  });

  it("the local engine uses this gateway's local STT, voice turn and TTS", () => {
    const local = code("views/voice-robovoice/local-call-session.ts");
    expect(local).toMatch(/\/api\/voice\/stt/);
    expect(local).toMatch(/\/api\/voice\/turn/);
    expect(local).toMatch(/\/api\/voice\/tts/);
    expect(local).toMatch(/MicVAD/);
    expect(existsSync(join(UI, "../../public/vad/silero_vad_v5.onnx"))).toBe(true);
  });

  it("the Voice page offers the engine choice: Local voice (default) + Cloud voice (Robovoice)", () => {
    const console_ = code("views/voice-robovoice/voice-console.ts");
    expect(console_).toMatch(/Local voice \(default\)/);
    expect(console_).toMatch(/Cloud voice \(Robovoice\)/);
    expect(console_).toMatch(/Optional: studio voices on Robovoice's cloud/);
    expect(console_).toMatch(/Free, nothing to top up/);
    expect(console_).not.toMatch(/billed to your Robovoice credits/);
    // Local mode: Session + Settings only, no Robovoice connect overlay.
    expect(console_).toMatch(/if \(this\.engine === "local"\) return this\.renderLocalSession\(\)/);
    // Direct CLI mode keeps the live CLI terminal stream under the session.
    expect(console_).toMatch(/renderLocalSession[\s\S]*?<voice-terminal-stream/);
  });

  it("chat mic + read-aloud use local speech by default (Robovoice speech only with cloud voice)", () => {
    const speech = code("components/chat-speech.ts");
    expect(speech).toMatch(/\/api\/voice\/stt/);
    expect(speech).toMatch(/\/api\/voice\/tts/);
    expect(speech).toMatch(/"robovoice\.speech\.stt"/);
    const tts = code("controllers/tts.ts");
    expect(tts).toMatch(/if \(!isCloudVoiceActive\(\)\)/);
    expect(tts).toMatch(/\/api\/voice\/tts/);
    // The local catalog is a usable gate on its own (no plugin, no wallet).
    expect(speechGate({ pluginEnabled: true, loaded: true, catalog: LOCAL_SPEECH_CATALOG }).kind).toBe("ready");
  });

  it("keeps the current Voice UI: the pre-Robovoice voice terminal is not brought back", () => {
    for (const f of ["views/voice-chat.ts", "components/voice-setup-overlay.ts", "controllers/grid-voice.ts"]) {
      expect(existsSync(join(UI, f)), f).toBe(false);
    }
    const app = code("app-render.ts");
    expect(app).toMatch(/<voice-robovoice-console/);
  });
});
