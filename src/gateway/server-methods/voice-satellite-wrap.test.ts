/**
 * Federation satellite-proxy wraps applied to voice gateway methods.
 *
 * The voice page on a satellite must talk to the master's voice infrastructure
 * (Kokoro, Speaches, LiveKit). Two pieces:
 *
 *   1. Audio bytes themselves go through the HTTP routes (/api/voice/tts,
 *      /api/voice/stt, /api/voice/chat) whose URLs are resolved by
 *      `resolveVoiceUrls()` — already master-aware (commit ce8da33). No proxy
 *      wrap needed; the satellite gateway just relays HTTP to master's
 *      containers.
 *
 *   2. Voice CONFIG / PREFS gateway methods are wrapped here so the satellite
 *      UI sees + edits the same provider/voice/wake-word state as master.
 *
 * `tts.convert` is intentionally NOT wrapped — it writes the rendered audio
 * to a node-local file path that the satellite can't access if master rendered
 * it. The proxy stripping is verified here too.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/config.js", () => ({
  loadConfig: vi.fn(() => ({ federation: { mode: "standalone" } })),
}));

vi.mock("../../federation/satellite.js", () => ({
  getFederationSatellite: vi.fn(() => null),
}));

// Stub the heavy tts module so importing the handler doesn't hit disk / probe
// kokoro at module load.
vi.mock("../../tts/tts.js", () => ({
  OPENAI_TTS_MODELS: [],
  OPENAI_TTS_VOICES: [],
  getTtsProvider: vi.fn(() => "kokoro"),
  getTtsVoiceSettings: vi.fn(() => ({})),
  isTtsEnabled: vi.fn(() => true),
  isTtsProviderConfigured: vi.fn(() => true),
  resolveTtsAutoMode: vi.fn(() => "off"),
  resolveTtsApiKey: vi.fn(() => undefined),
  resolveTtsConfig: vi.fn(() => ({ kokoro: { baseUrl: "http://localhost:8882" } })),
  resolveTtsPrefsPath: vi.fn(() => "/tmp/tts-prefs.json"),
  resolveTtsProviderOrder: vi.fn(() => ["kokoro"]),
  setTtsEnabled: vi.fn(),
  setTtsProvider: vi.fn(),
  setTtsVoiceSettings: vi.fn(),
  textToSpeech: vi.fn(async () => ({ success: true, audioPath: "/local/audio.mp3" })),
}));

vi.mock("../../infra/voicewake.js", () => ({
  loadVoiceWakeConfig: vi.fn(async () => ({ triggers: ["hey infinibot"] })),
  setVoiceWakeTriggers: vi.fn(async (t: string[]) => ({ triggers: t })),
}));

import { loadConfig } from "../../config/config.js";
import { getFederationSatellite } from "../../federation/satellite.js";
import { ttsHandlers } from "./tts.js";
import { voicewakeHandlers } from "./voicewake.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

function makeConnectedSatellite() {
  return {
    getState: () => "connected",
    invokeOnMaster: vi.fn().mockResolvedValue({ success: true, data: { source: "master" } }),
  };
}

function makeOpts(params: Record<string, unknown> = {}): GatewayRequestHandlerOptions {
  const respond = vi.fn();
  return {
    req: {} as never,
    params,
    client: null,
    isWebchatConnect: () => false,
    respond,
    context: { broadcastVoiceWakeChanged: vi.fn() } as never,
  };
}

function setSatelliteConnected() {
  vi.mocked(loadConfig).mockReturnValue({ federation: { mode: "satellite" } } as ReturnType<
    typeof loadConfig
  >);
  const sat = makeConnectedSatellite();
  vi.mocked(getFederationSatellite).mockReturnValue(
    sat as unknown as ReturnType<typeof getFederationSatellite>,
  );
  return sat;
}

function setStandalone() {
  vi.mocked(loadConfig).mockReturnValue({
    federation: { mode: "standalone" },
  } as ReturnType<typeof loadConfig>);
  vi.mocked(getFederationSatellite).mockReturnValue(null);
}

beforeEach(() => {
  vi.mocked(loadConfig).mockReset();
  vi.mocked(getFederationSatellite).mockReset();
});

describe("voice satellite wraps — config/prefs proxy to master", () => {
  it("proxies tts.status to master when satellite connected", async () => {
    const sat = setSatelliteConnected();
    const opts = makeOpts({});
    await ttsHandlers["tts.status"](opts);
    expect(sat.invokeOnMaster).toHaveBeenCalledWith("tts.status", {});
    expect(opts.respond).toHaveBeenCalledWith(true, { source: "master" });
  });

  it("proxies tts.setProvider to master so prefs are shared", async () => {
    const sat = setSatelliteConnected();
    const opts = makeOpts({ provider: "elevenlabs" });
    await ttsHandlers["tts.setProvider"](opts);
    expect(sat.invokeOnMaster).toHaveBeenCalledWith("tts.setProvider", {
      provider: "elevenlabs",
    });
  });

  it("proxies tts.voiceSettings to master", async () => {
    const sat = setSatelliteConnected();
    const opts = makeOpts({});
    await ttsHandlers["tts.voiceSettings"](opts);
    expect(sat.invokeOnMaster).toHaveBeenCalledWith("tts.voiceSettings", {});
  });

  it("proxies voicewake.get to master so wake triggers are user-level", async () => {
    const sat = setSatelliteConnected();
    const opts = makeOpts({});
    await voicewakeHandlers["voicewake.get"](opts);
    expect(sat.invokeOnMaster).toHaveBeenCalledWith("voicewake.get", {});
  });

  it("proxies voicewake.set to master", async () => {
    const sat = setSatelliteConnected();
    const opts = makeOpts({ triggers: ["hey infinibot"] });
    await voicewakeHandlers["voicewake.set"](opts);
    expect(sat.invokeOnMaster).toHaveBeenCalledWith("voicewake.set", {
      triggers: ["hey infinibot"],
    });
  });

  it("does NOT proxy tts.convert — audio file path must stay node-local", async () => {
    const sat = setSatelliteConnected();
    const opts = makeOpts({ text: "hello" });
    await ttsHandlers["tts.convert"](opts);
    expect(sat.invokeOnMaster).not.toHaveBeenCalledWith("tts.convert", expect.anything());
    // Local handler responded.
    expect(opts.respond).toHaveBeenCalled();
  });

  it("runs tts.status locally in standalone mode", async () => {
    setStandalone();
    const opts = makeOpts({});
    await ttsHandlers["tts.status"](opts);
    // local handler used the stubbed resolvers
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ provider: "kokoro" }),
    );
  });
});
