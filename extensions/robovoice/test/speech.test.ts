import { describe, expect, it } from "vitest";

import { RobovoiceEdgeApi } from "../src/edge-api.js";
import type { RobovoiceLinkService } from "../src/link.js";
import type { RobovoiceSettingsStore } from "../src/settings.js";
import { RobovoiceSpeechService, SPEECH_BUSY_MESSAGE } from "../src/speech.js";
import { registerSpeechRpcs } from "../src/speech-rpc.js";

// Test fixtures only: a scripted Robovoice edge answering the speech routes.
type Seen = { method: string; path: string; body: Record<string, unknown> | null };

function scriptedEdge(answers: Record<string, (body: Record<string, unknown> | null) => [number, unknown]>) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    seen.push({ method: init?.method ?? "GET", path: url.pathname + url.search, body });
    const fn = answers[`${init?.method ?? "GET"} ${url.pathname}`];
    const [status, json] = fn ? fn(body) : [404, { error: "not found" }];
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { seen, api: new RobovoiceEdgeApi("https://rv.test", "rve_test_token_000000000000", { fetchImpl }) };
}

const WALLET_OK = { available_credits: 982, balance_credits: 982, enforcement: "enforce", empty: false };
const WALLET_EMPTY = { available_credits: 0, balance_credits: 0, enforcement: "enforce", empty: true };

const CATALOG = {
  location_id: "loc-1",
  tts: [
    {
      id: "elevenlabs",
      label: "ElevenLabs",
      local: false,
      models: [{ id: "eleven_turbo_v2_5", name: "Turbo v2.5" }],
      voices: [{ id: "v-1", name: "Rachel" }],
    },
  ],
  tts_unavailable: [{ id: "kokoro", label: "Kokoro", reason: "Kokoro is unreachable" }],
  stt: [{ id: "groq", label: "Groq", models: [{ id: "whisper-large-v3-turbo", name: "whisper" }] }],
  pricing: {
    credit_usd: 0.001,
    tts_credits_per_1k_chars: { standard: 60, premium: 180, expressive: 340 },
    tts_tier_rules: [{ provider: "elevenlabs", tier: "premium" }, { provider: "*", tier: "standard" }],
    stt_credits_per_second: 0.3333,
    limits: { tts_max_chars: 2000, stt_max_seconds: 300 },
  },
  wallet: WALLET_OK,
};

const svc = (api: RobovoiceEdgeApi | null, now = () => 1_000_000) =>
  new RobovoiceSpeechService({ api: () => api, locationId: () => (api ? "loc-1" : null), now, requestId: () => "ib-req-0001" });

describe("robovoice speech — gating", () => {
  it("not linked: catalog says so, tts/stt refuse without calling Robovoice", async () => {
    const s = svc(null);
    expect(await s.catalog()).toMatchObject({ available: false, reason: "not_linked" });
    await expect(s.tts({ provider: "elevenlabs", voice: "v-1", text: "hi" })).rejects.toMatchObject({ code: "not_linked" });
    await expect(
      s.stt({ provider: "groq", model: "whisper-large-v3-turbo", audioBase64: "AAAA", mime: "audio/webm", durationMs: 900 }),
    ).rejects.toMatchObject({ code: "not_linked" });
  });

  it("catalog is exactly Robovoice's answer (no invented providers or voices)", async () => {
    const { api } = scriptedEdge({ "GET /api/edge/infinibot/speech": () => [200, CATALOG] });
    const cat = await svc(api).catalog();
    expect(cat.available).toBe(true);
    if (!cat.available) return;
    expect(cat.tts.map((t) => t.id)).toEqual(["elevenlabs"]);
    expect(cat.tts[0].voices).toEqual([{ id: "v-1", name: "Rachel" }]);
    expect(cat.ttsUnavailable[0]).toEqual({ id: "kokoro", label: "Kokoro", reason: "Kokoro is unreachable" });
    expect(cat.stt[0].models[0].id).toBe("whisper-large-v3-turbo");
    expect(cat.pricing.ttsCreditsPer1kChars.premium).toBe(180);
    expect(cat.wallet).toEqual({ availableCredits: 982, balanceCredits: 982, enforcement: "enforce", empty: false });
  });

  it("an unreachable Robovoice is reported, never replaced by defaults", async () => {
    const { api } = scriptedEdge({ "GET /api/edge/infinibot/speech": () => [503, { error: "down" }] });
    expect(await svc(api).catalog()).toMatchObject({ available: false, reason: "error" });
  });
});

describe("robovoice speech — metering", () => {
  it("tts: one charged request, request id + location sent, charge relayed", async () => {
    const { api, seen } = scriptedEdge({
      "POST /api/edge/infinibot/speech/tts": () => [
        200,
        {
          request_id: "ib-req-0001",
          audio_base64: "SUQz",
          mime: "audio/mpeg",
          rating: { kind: "tts", tier: "premium", chars: 100, seconds: null, credits: 18 },
          charge: { credits: 18, rated_credits: 18, charged: true, ledger_kind: "tts", wallet: WALLET_OK },
        },
      ],
    });
    const out = await svc(api).tts({ provider: "elevenlabs", model: "eleven_turbo_v2_5", voice: "v-1", text: "x".repeat(100) });
    expect(seen).toHaveLength(1);
    expect(seen[0].body).toMatchObject({ location: "loc-1", request_id: "ib-req-0001", provider: "elevenlabs", voice: "v-1" });
    expect(out.charge).toMatchObject({ credits: 18, charged: true, ledgerKind: "tts" });
    expect(out.rating).toMatchObject({ kind: "tts", chars: 100 });
    expect(out.audioBase64).toBe("SUQz");
  });

  it("stt: per-second charge relayed with the transcript", async () => {
    const { api, seen } = scriptedEdge({
      "POST /api/edge/infinibot/speech/stt": () => [
        200,
        {
          text: "hello there",
          rating: { kind: "stt", tier: null, chars: null, seconds: 5, credits: 1.67 },
          charge: { credits: 1.67, rated_credits: 1.67, charged: true, ledger_kind: "stt", wallet: WALLET_OK },
        },
      ],
    });
    const out = await svc(api).stt({
      provider: "groq",
      model: "whisper-large-v3-turbo",
      audioBase64: "AAAA",
      mime: "audio/webm",
      durationMs: 4200,
    });
    expect(seen[0].body).toMatchObject({ duration_ms: 4200, mime: "audio/webm", model: "whisper-large-v3-turbo" });
    expect(out.text).toBe("hello there");
    expect(out.charge).toMatchObject({ credits: 1.67, ledgerKind: "stt" });
    expect(out.rating.seconds).toBe(5);
  });

  it("free cloud speech: an empty wallet never refuses locally — the request always reaches Robovoice", async () => {
    const { api, seen } = scriptedEdge({
      "GET /api/edge/infinibot/speech": () => [200, { ...CATALOG, wallet: WALLET_EMPTY }],
      "POST /api/edge/infinibot/speech/tts": () => [200, { request_id: "r", rating: {}, charge: { credits: 0, charged: false } }],
    });
    const s = svc(api);
    await s.catalog();
    await s.tts({ provider: "elevenlabs", voice: "v-1", text: "Hi" }).catch(() => undefined);
    expect(seen.map((r) => r.path)).toContain("/api/edge/infinibot/speech/tts");
  });

  it("a balance or fair-use refusal becomes the friendly 'cloud voice is busy' (no credit wording)", async () => {
    for (const [status, code] of [[402, "wallet_empty"], [402, "insufficient_balance"], [429, "cloud_voice_busy"]] as const) {
      const { api } = scriptedEdge({
        "POST /api/edge/infinibot/speech/tts": () => [status, { error: "nope", code, wallet: WALLET_EMPTY }],
      });
      const err = await svc(api).tts({ provider: "elevenlabs", voice: "v-1", text: "Hello" }).catch((e) => e);
      expect(err).toMatchObject({ code: "cloud_voice_busy", status: 429, message: SPEECH_BUSY_MESSAGE });
      expect(String(err.message)).not.toMatch(/credit|top.?up|wallet/i);
    }
  });

  it("requires a chosen voice / model (no defaults)", async () => {
    const { api, seen } = scriptedEdge({});
    const s = svc(api);
    await expect(s.tts({ provider: "", voice: "", text: "Hi" })).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      s.stt({ provider: "groq", model: "", audioBase64: "AAAA", mime: "audio/webm", durationMs: 800 }),
    ).rejects.toMatchObject({ code: "bad_request" });
    expect(seen).toHaveLength(0);
  });

  it("estimate relays Robovoice's price + refusal", async () => {
    const { api } = scriptedEdge({
      "POST /api/edge/infinibot/speech/estimate": (b) => [
        200,
        {
          estimate: { kind: b?.kind, tier: "standard", chars: 1000, seconds: null, credits: 60 },
          allowed: false,
          code: "wallet_empty",
          message: "Wallet empty — top up to use Robovoice speech.",
          wallet: WALLET_EMPTY,
        },
      ],
    });
    const e = await svc(api).estimate({ kind: "tts", provider: "kokoro", chars: 1000 });
    expect(e).toMatchObject({ allowed: false, code: "wallet_empty", estimate: { credits: 60 } });
    expect(e.wallet.empty).toBe(true);
  });
});

describe("robovoice.speech.* RPCs", () => {
  function harness(linked: boolean, api: RobovoiceEdgeApi) {
    const handlers = new Map<string, (o: { params: unknown; respond: (...a: unknown[]) => void }) => Promise<void>>();
    const store = {
      get: () => ({ link: linked ? { locationId: "loc-1", orgId: "o", orgName: "Org" } : undefined }),
      secrets: () => ({ edgeToken: linked ? "rve_x" : undefined }),
    } as unknown as RobovoiceSettingsStore;
    const service = () => ({ api: () => api, apiBase: () => "https://rv.test" }) as unknown as RobovoiceLinkService;
    registerSpeechRpcs({ register: (m, h) => handlers.set(m, h as never), store, service });
    const call = async (method: string, params: unknown) => {
      let out: unknown[] = [];
      await handlers.get(method)!({ params, respond: (...a: unknown[]) => (out = a) });
      return out;
    };
    return { handlers, call };
  }

  it("registers catalog, estimate, tts and stt", () => {
    const { api } = scriptedEdge({});
    expect([...harness(true, api).handlers.keys()].sort()).toEqual([
      "robovoice.speech.catalog",
      "robovoice.speech.estimate",
      "robovoice.speech.stt",
      "robovoice.speech.tts",
    ]);
  });

  it("unlinked: catalog answers available:false (the UI shows 'Connect Robovoice')", async () => {
    const { api, seen } = scriptedEdge({});
    const [ok, payload] = await harness(false, api).call("robovoice.speech.catalog", {});
    expect(ok).toBe(true);
    expect(payload).toMatchObject({ available: false, reason: "not_linked" });
    expect(seen).toHaveLength(0);
  });

  it("linked: catalog has no top-up page (cloud voice is free)", async () => {
    const { api } = scriptedEdge({ "GET /api/edge/infinibot/speech": () => [200, CATALOG] });
    const [ok, payload] = await harness(true, api).call("robovoice.speech.catalog", {});
    expect(ok).toBe(true);
    expect(payload).toMatchObject({ available: true });
    expect(payload).not.toHaveProperty("topUpUrl");
  });

  it("a refusal reaches the UI as code cloud_voice_busy (the UI offers the switch to local voice)", async () => {
    const { api } = scriptedEdge({
      "POST /api/edge/infinibot/speech/tts": () => [402, { error: "Wallet empty", code: "wallet_empty", wallet: WALLET_EMPTY }],
    });
    const [ok, , err] = await harness(true, api).call("robovoice.speech.tts", { provider: "elevenlabs", voice: "v-1", text: "Hi" });
    expect(ok).toBe(false);
    expect(err).toMatchObject({ code: "cloud_voice_busy", message: SPEECH_BUSY_MESSAGE });
  });
});
