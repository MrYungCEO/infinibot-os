import { describe, expect, it } from "vitest";

import {
  EMPTY_PREFS,
  SPEECH_PREFS_KEY,
  WALLET_EMPTY_TEXT,
  estimateSttCredits,
  estimateTtsCredits,
  formatCredits,
  isWalletEmptyError,
  loadSpeechPrefs,
  reconcilePrefs,
  saveSpeechPrefs,
  speechChunks,
  speechGate,
  speechText,
  sttReady,
  ttsReady,
  ttsTier,
  type SpeechCatalog,
} from "./chat-speech-state";

// Test fixture only — shaped like a robovoice.speech.catalog answer.
const catalog = (over: Partial<SpeechCatalog> = {}): SpeechCatalog => ({
  available: true,
  locationId: "loc-1",
  tts: [
    {
      id: "elevenlabs",
      label: "ElevenLabs",
      local: false,
      models: [
        { id: "eleven_turbo_v2_5", name: "Turbo v2.5" },
        { id: "eleven_v3", name: "v3" },
      ],
      voices: [{ id: "v-1", name: "Rachel" }],
    },
    { id: "kokoro", label: "Kokoro", local: true, models: [], voices: [{ id: "af_x", name: "af_x" }] },
  ],
  ttsUnavailable: [],
  stt: [{ id: "groq", label: "Groq", models: [{ id: "whisper-large-v3-turbo", name: "whisper" }] }],
  pricing: {
    creditUsd: 0.001,
    ttsCreditsPer1kChars: { standard: 60, premium: 180, expressive: 340 },
    ttsTierRules: [
      { provider: "elevenlabs", model: "eleven_v3", tier: "expressive" },
      { provider: "elevenlabs", tier: "premium" },
      { provider: "*", tier: "standard" },
    ],
    sttCreditsPerSecond: 0.3333,
    limits: { ttsMaxChars: 2000, sttMaxSeconds: 300 },
  },
  wallet: { availableCredits: 982, balanceCredits: 982, enforcement: "enforce", empty: false },
  fetchedAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

function memStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

describe("speech gating", () => {
  it("plugin disabled → connect hint only", () => {
    expect(speechGate({ pluginEnabled: false, loaded: true, catalog: catalog() })).toEqual({
      kind: "connect",
      pluginEnabled: false,
    });
  });
  it("plugin on but not linked → connect hint", () => {
    expect(
      speechGate({ pluginEnabled: true, loaded: true, catalog: { available: false, reason: "not_linked", message: "x" } }),
    ).toEqual({ kind: "connect", pluginEnabled: true });
  });
  it("RPC not served (plugin not loaded) → connect; other failures → error", () => {
    expect(speechGate({ pluginEnabled: true, loaded: true, catalog: null, rpcError: "unknown method: robovoice.speech.catalog" }).kind).toBe(
      "connect",
    );
    expect(speechGate({ pluginEnabled: true, loaded: true, catalog: null, rpcError: "timed out" })).toEqual({
      kind: "error",
      message: "timed out",
    });
  });
  it("hidden until the first answer", () => {
    expect(speechGate({ pluginEnabled: true, loaded: false, catalog: null }).kind).toBe("hidden");
  });
  it("$0 wallet → empty (controls disabled), from the catalog or a later charge", () => {
    const empty = { availableCredits: 0, balanceCredits: 0, enforcement: "enforce", empty: true };
    expect(speechGate({ pluginEnabled: true, loaded: true, catalog: catalog({ wallet: empty }) }).kind).toBe("empty");
    expect(speechGate({ pluginEnabled: true, loaded: true, catalog: catalog(), wallet: empty }).kind).toBe("empty");
    expect(speechGate({ pluginEnabled: true, loaded: true, catalog: catalog() }).kind).toBe("ready");
  });
  it("recognises the wallet-empty refusal from the gateway error message", () => {
    expect(isWalletEmptyError(new Error(WALLET_EMPTY_TEXT))).toBe(true);
    expect(isWalletEmptyError({ code: "wallet_empty" })).toBe(true);
    expect(isWalletEmptyError(new Error("provider_error"))).toBe(false);
  });
});

describe("speech picks", () => {
  it("start empty — no provider, model or voice is chosen for the user", () => {
    expect(loadSpeechPrefs(memStorage())).toEqual(EMPTY_PREFS);
    expect(ttsReady(EMPTY_PREFS, catalog())).toBe(false);
    expect(sttReady(EMPTY_PREFS, catalog())).toBe(false);
  });
  it("persist and round-trip", () => {
    const st = memStorage();
    const p = { ...EMPTY_PREFS, readAloud: true, ttsProvider: "kokoro", ttsVoice: "af_x", autoSend: true };
    saveSpeechPrefs(st, p);
    expect(JSON.parse(st.m.get(SPEECH_PREFS_KEY)!)).toMatchObject({ ttsProvider: "kokoro" });
    expect(loadSpeechPrefs(st)).toEqual(p);
  });
  it("drop picks that left the org's catalog (and turn read-aloud off without a voice)", () => {
    const p = { ...EMPTY_PREFS, readAloud: true, ttsProvider: "elevenlabs", ttsModel: "gone", ttsVoice: "gone", sttProvider: "x", sttModel: "y" };
    const r = reconcilePrefs(p, catalog());
    expect(r).toMatchObject({ ttsProvider: "elevenlabs", ttsModel: null, ttsVoice: null, sttProvider: null, sttModel: null, readAloud: false });
  });
  it("ready needs voice (+ model when the provider lists models)", () => {
    const c = catalog();
    expect(ttsReady({ ...EMPTY_PREFS, ttsProvider: "kokoro", ttsVoice: "af_x" }, c)).toBe(true);
    expect(ttsReady({ ...EMPTY_PREFS, ttsProvider: "elevenlabs", ttsVoice: "v-1" }, c)).toBe(false);
    expect(ttsReady({ ...EMPTY_PREFS, ttsProvider: "elevenlabs", ttsVoice: "v-1", ttsModel: "eleven_turbo_v2_5" }, c)).toBe(true);
    expect(sttReady({ ...EMPTY_PREFS, sttProvider: "groq", sttModel: "whisper-large-v3-turbo" }, c)).toBe(true);
  });
});

describe("estimates follow Robovoice's pricing", () => {
  it("tier rules pick the per-1k-char rate", () => {
    const c = catalog();
    expect(ttsTier(c, "elevenlabs", "eleven_v3")).toBe("expressive");
    expect(ttsTier(c, "elevenlabs", "eleven_turbo_v2_5")).toBe("premium");
    expect(ttsTier(c, "kokoro", null)).toBe("standard");
    expect(estimateTtsCredits(c, "kokoro", null, 1000)).toBe(60);
    expect(estimateTtsCredits(c, "elevenlabs", "eleven_turbo_v2_5", 100)).toBe(18);
  });
  it("stt per whole second, at least one", () => {
    expect(estimateSttCredits(catalog(), 0.2)).toBe(0.33);
    expect(estimateSttCredits(catalog(), 12)).toBe(4);
  });
  it("formats credits", () => {
    expect(formatCredits(0)).toBe("0 cr");
    expect(formatCredits(0.33)).toBe("0.33 cr");
    expect(formatCredits(4.04)).toBe("4 cr");
    expect(formatCredits(1234)).toMatch(/^1,?234 cr$/);
  });
});

describe("what gets spoken", () => {
  it("strips markdown, code and links", () => {
    const t = speechText("## Plan\n**Bold** move — see [docs](https://x.y).\n```js\nconst a=1\n```\n- one\n- two `x`");
    expect(t).toBe("Plan\nBold move — see docs.\none\ntwo x");
  });
  it("chunks at sentence boundaries within the per-request limit", () => {
    const text = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
    const chunks = speechChunks(text, 200);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 200)).toBe(true);
    expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(text);
    expect(speechChunks("x".repeat(450), 200).every((c) => c.length <= 200)).toBe(true);
    expect(speechChunks("", 200)).toEqual([]);
  });
});
