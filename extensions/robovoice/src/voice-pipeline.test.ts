import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RunVoiceTurn, VoiceLlmTurnRequest } from "infinibot/plugin-sdk";
import { startMockRobovoice, type MockRobovoice } from "../test/mock-robovoice-server.js";
import { RobovoiceLinkService } from "./link.js";
import {
  agentFromInfinibotModel,
  buildPatch,
  decide,
  effectivePipeline,
  overlayCharacter,
  sanitizePatch,
} from "./pipeline.js";
import { accountOf } from "./provider.js";
import { RobovoiceSettingsStore, type SecretCipher } from "./settings.js";
import { conversationHistory, formatTurnLine, handleVoiceLlmHttp, lastUserMessage, OperatorCalls, ownerCallerEmails, turnStat, VOICE_LLM_BASE_PATH, VoiceLlmStats } from "./voice-llm.js";
import { inheritedFor, registerVoicePipelineRpcs } from "./voice-pipeline-rpc.js";

const testCipher: SecretCipher = {
  encrypt: (p) => Buffer.from(`x:${p}`).toString("base64"),
  decrypt: (b) => {
    const t = Buffer.from(b, "base64").toString();
    return t.startsWith("x:") ? t.slice(2) : null;
  },
};

const ORG = {
  stt_provider: "speaches",
  stt_model_speaches: "Systran/faster-whisper-small",
  stt_model_groq: "whisper-large-v3-turbo",
  llm_provider: "groq",
  groq_model: "llama-3.3-70b-versatile",
  openrouter_model: "google/gemini-2.5-flash",
  tts_provider: "kokoro",
  tts_voice_kokoro: "af_heart",
  tts_voice_elevenlabs: "daniel",
};

// ── precedence merge ─────────────────────────────────────────────────────────

describe("location pipeline precedence (org → location → character → location×character)", () => {
  it("inherits everything from the org when nothing is overridden", () => {
    const e = effectivePipeline({ org: ORG });
    expect(e.stt).toEqual({ provider: "speaches", model: "Systran/faster-whisper-small", providerFrom: "org", modelFrom: "org" });
    expect(e.llm).toMatchObject({ provider: "groq", model: "llama-3.3-70b-versatile", providerFrom: "org" });
    expect(e.tts).toMatchObject({ provider: "kokoro", model: "af_heart", modelFrom: "org" });
  });

  it("location defaults beat org; per-provider model fields follow the provider", () => {
    const e = effectivePipeline({ org: ORG, defaults: { llm_provider: "openrouter", stt_provider: "groq", tts_voice_kokoro: "bf_emma" } });
    expect(e.llm).toMatchObject({ provider: "openrouter", model: "google/gemini-2.5-flash", providerFrom: "location", modelFrom: "org" });
    expect(e.stt).toMatchObject({ provider: "groq", model: "whisper-large-v3-turbo", providerFrom: "location" });
    expect(e.tts).toMatchObject({ model: "bf_emma", modelFrom: "location" });
  });

  it("character beats location; the override beats the character; most specific SET value wins", () => {
    const character = { llm_provider: "ollama", llm_model: "qwen3:8b", tts_provider: "elevenlabs", tts_voice_elevenlabs: "rachel" };
    const e1 = effectivePipeline({ org: ORG, defaults: { llm_provider: "openrouter" }, character });
    expect(e1.llm).toMatchObject({ provider: "ollama", model: "qwen3:8b", providerFrom: "character", modelFrom: "character" });
    expect(e1.tts).toMatchObject({ provider: "elevenlabs", model: "rachel", providerFrom: "character" });
    const e2 = effectivePipeline({
      org: ORG,
      defaults: { llm_provider: "openrouter" },
      character,
      override: { llm_provider: "infinibot", llm_model: "infinibot:main", tts_voice_elevenlabs: "" },
    });
    expect(e2.llm).toMatchObject({ provider: "infinibot", model: "infinibot:main", providerFrom: "override", modelFrom: "override" });
    // "" is not set → the character's voice still applies.
    expect(e2.tts).toMatchObject({ model: "rachel", modelFrom: "character" });
  });

  it("false and 0 are real values; null/undefined/'' are not", () => {
    const e = effectivePipeline({ org: { ...ORG, temperature: 0.7 }, defaults: { temperature: 0, llm_provider: null, stt_provider: "" } });
    expect(e.llm.providerFrom).toBe("org");
    expect(e.stt.providerFrom).toBe("org");
    expect(overlayCharacter(ORG, {}, { temperature: 0 }, {})).toEqual({});
  });

  it("a more specific provider switch drops a less specific pinned model (Robovoice overlayCharacter)", () => {
    // Location switches LLM away from the org's; the character only pinned a model for the org provider.
    const base = overlayCharacter(ORG, { llm_model: "llama-3.3-70b-versatile" }, { llm_provider: "openrouter" }, {});
    expect(base.llm_model).toBe("");
    expect(effectivePipeline({ org: ORG, defaults: { llm_provider: "openrouter" }, character: { llm_model: "llama-3.3-70b-versatile" } }).llm.model).toBe(
      "google/gemini-2.5-flash",
    );
    // Override switches provider without a model → pinned model dropped.
    const o = overlayCharacter(ORG, { llm_provider: "groq", llm_model: "llama-3.3-70b-versatile" }, {}, { llm_provider: "openrouter" });
    expect(o).toMatchObject({ llm_provider: "openrouter", llm_model: "" });
    // Same provider → model kept.
    expect(overlayCharacter(ORG, { llm_model: "x" }, {}, { llm_provider: "groq" }).llm_model).toBe("x");
  });

  it("decide(): equal to inherited or empty clears the override, a change is sent, no-op is skipped", () => {
    expect(decide("groq", "groq", "openrouter")).toBeNull();
    expect(decide("", "groq", "openrouter")).toBeNull();
    expect(decide("groq", "groq", undefined)).toBeUndefined();
    expect(decide("openrouter", "groq", undefined)).toBe("openrouter");
    expect(decide("openrouter", "groq", "openrouter")).toBeUndefined();
    expect(
      buildPatch({
        fields: ["llm_provider", "tts_voice_kokoro", "stt_provider"],
        edited: { llm_provider: "groq", tts_voice_kokoro: "am_puck", stt_provider: "speaches", junk: 1 },
        inherited: { llm_provider: "groq", tts_voice_kokoro: "af_heart", stt_provider: "speaches" },
        stored: { llm_provider: "openrouter" },
      }),
    ).toEqual({ llm_provider: null, tts_voice_kokoro: "am_puck" });
  });

  it("sanitizePatch keeps only per-location fields", () => {
    expect(sanitizePatch({ defaults: { llm_provider: "groq", tts_voice_kokoro: "" } })).toEqual({
      defaults: { llm_provider: "groq", tts_voice_kokoro: null },
    });
    expect(() => sanitizePatch({ defaults: { groq_api_key: "sk" } })).toThrow(/can't be set per location/);
    expect(() => sanitizePatch({ characters: { c1: { groq_api_key: "x" } } })).toThrow(/can't be set per location/);
    expect(() => sanitizePatch({ defaults: { tts_voice_piper: "x" } })).toThrow(/can't be set per location/);
    // Coerced like Robovoice's coerceField: ranges, types, providers.
    expect(sanitizePatch({ defaults: { idle_billing_timeout_seconds: 62, allow_interruptions: false, preemptive_generation: "auto" } })).toEqual({
      defaults: { idle_billing_timeout_seconds: 62, allow_interruptions: false, preemptive_generation: "auto" },
    });
    expect(() => sanitizePatch({ defaults: { temperature: 3 } })).toThrow(/between 0 and 2/);
    expect(() => sanitizePatch({ defaults: { stt_provider: "whisper" } })).toThrow(/unknown provider/);
    expect(() => sanitizePatch({ defaults: { llm_provider: "infinibot" } })).toThrow(/unknown provider/);
    expect(sanitizePatch({ characters: { c1: { llm_provider: "infinibot", llm_model: "infinibot:main" } } })).toEqual({
      characters: { c1: { llm_provider: "infinibot", llm_model: "infinibot:main" } },
    });
    expect(agentFromInfinibotModel("infinibot:main")).toBe("main");
    expect(agentFromInfinibotModel("infinibot:../x")).toBeNull();
  });
});

// ── agent sync + RPCs against the mock ───────────────────────────────────────

const PERSONAS = [
  { id: "main", name: "INFINI", description: "Chief Executive · routes work." },
  { id: "coder", name: "Coder", description: "Writes code." },
  { id: "cmo", name: "CMO" },
];

let mock: MockRobovoice;
let dir: string;
let store: RobovoiceSettingsStore;

function service() {
  return new RobovoiceLinkService({ store, personas: () => PERSONAS, sleep: async () => {}, env: {}, detectDesktop: () => ({ installed: false, running: false }) });
}

async function linked(publicUrl = "https://gw.example.ts.net") {
  const svc = service();
  const { apiBase, start } = await svc.startLogin(mock.url);
  const token = await svc.waitForLogin(apiBase, start);
  store.update({ mcpPublicUrl: publicUrl });
  await svc.completeLogin(apiBase, token);
  return svc;
}

type Handler = (o: { params: unknown; respond: (ok: boolean, payload?: unknown, err?: unknown) => void }) => unknown;

function rpcHarness(svc: RobovoiceLinkService, voiceTurn?: RunVoiceTurn, cloudBrokerUrl?: string) {
  const methods = new Map<string, Handler>();
  registerVoicePipelineRpcs({
    cloudBrokerUrl,
    register: (m, h) => methods.set(m, h as unknown as Handler),
    store,
    service: () => svc,
    personas: () => PERSONAS,
    stats: new VoiceLlmStats(),
    voiceTurn: voiceTurn ?? (async () => ({ text: "hi", backend: "gateway", sessionKey: "k", trust: "caller", firstTokenMs: 1, totalMs: 2 })),
  });
  return async <T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    let out: { ok: boolean; payload?: unknown; err?: unknown } | null = null;
    await methods.get(method)!({ params, respond: (ok, payload, err) => (out = { ok, payload, err }) });
    if (!out!.ok) throw new Error((out!.err as { message?: string })?.message ?? "rpc failed");
    return out!.payload as T;
  };
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rv-vp-"));
  store = new RobovoiceSettingsStore(dir, {}, undefined, {}, testCipher);
  mock = await startMockRobovoice({});
});
afterEach(async () => {
  await mock.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("InfiniBot Cloud (hosted voice broker, no Robovoice link)", () => {
  it("main is a callable voice agent with its own id as the character; toggles stay local", async () => {
    const call = rpcHarness(service(), undefined, "https://cloud.example.com");
    type Row = { id: string; voiceAgent: boolean; characterId: string | null; robovoice?: unknown };
    const list = await call<{ linked: boolean; agents: Row[]; voicesError: string | null }>("robovoice.voiceAgents.list", { remote: true });
    expect(list.linked).toBe(true);
    expect(list.voicesError).toBeNull();
    expect(list.agents.find((a) => a.id === "main")).toMatchObject({ voiceAgent: true, characterId: "main", robovoice: null });
    expect(list.agents.find((a) => a.id === "coder")).toMatchObject({ voiceAgent: false, characterId: null });
    // Turning an agent on needs no Robovoice account: it becomes callable as itself.
    const after = await call<{ agents: Row[]; syncError: string | null }>("robovoice.voiceAgent.set", { agentId: "coder", enabled: true });
    expect(after.syncError).toBeNull();
    expect(after.agents.find((a) => a.id === "coder")).toMatchObject({ voiceAgent: true, characterId: "coder" });
  });

  it("pipeline.config.get answers with the broker's hosted pipeline (read-only); edits are refused", async () => {
    const hits: string[] = [];
    const broker = http.createServer((req, res) => {
      hits.push(`${req.method} ${req.url} auth=${req.headers.authorization ?? "none"}`);
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          ok: true,
          resolved: true,
          editable: false,
          stt: { provider: "groq", model: "whisper-large-v3" },
          llm: { provider: "openrouter", model: "qwen/qwen3-235b-a22b" },
          tts: { provider: "kokoro", model: "am_adam" },
        }),
      );
    });
    await new Promise<void>((r) => broker.listen(0, "127.0.0.1", () => r()));
    try {
      const url = `http://127.0.0.1:${(broker.address() as AddressInfo).port}`;
      const call = rpcHarness(service(), undefined, url);
      type View = { cloud: boolean; editable: boolean; readOnlyReason: string; effective: { location: Record<string, { provider: string; model: string }> | null } };
      const view = await call<View>("robovoice.pipeline.config.get");
      expect(view).toMatchObject({ cloud: true, editable: false });
      expect(view.readOnlyReason).toMatch(/read-only/);
      expect(view.effective.location).toMatchObject({
        stt: { provider: "groq", model: "whisper-large-v3" },
        llm: { provider: "openrouter", model: "qwen/qwen3-235b-a22b" },
        tts: { provider: "kokoro", model: "am_adam" },
      });
      // Cached for a minute; no member session is sent.
      await call("robovoice.pipeline.config.get");
      expect(hits).toEqual(["GET /api/voice/pipeline auth=none"]);
      await expect(call("robovoice.pipeline.config.set", { values: { llm_provider: "groq" } })).rejects.toThrow(/read-only/);
      await expect(call("robovoice.pipeline.catalog.get", { stage: "llm" })).rejects.toThrow(/read-only/);
    } finally {
      broker.close();
    }
  });

  it("broker without a published pipeline → no stages (shown as unavailable), never a default", async () => {
    const methods = new Map<string, Handler>();
    registerVoicePipelineRpcs({
      cloudBrokerUrl: "https://cloud.example.com",
      fetchBrokerPipeline: async () => ({ resolved: false, editable: false, reason: "not published" }),
      register: (m, h) => methods.set(m, h as unknown as Handler),
      store,
      service: () => service(),
      personas: () => PERSONAS,
      stats: new VoiceLlmStats(),
      voiceTurn: async () => ({ text: "", backend: "gateway", sessionKey: "k", trust: "caller", firstTokenMs: 1, totalMs: 2 }),
    });
    let out: { ok: boolean; payload?: unknown } | null = null;
    await methods.get("robovoice.pipeline.config.get")!({ params: {}, respond: (ok, payload) => (out = { ok, payload }) });
    expect(out!.ok).toBe(true);
    expect(out!.payload).toMatchObject({ cloud: true, resolved: false, effective: { location: null } });
  });

  it("without the broker an unlinked install still has no voice agents (local path unchanged)", async () => {
    const call = rpcHarness(service());
    const list = await call<{ linked: boolean; agents: Array<{ voiceAgent: boolean; characterId: string | null }> }>("robovoice.voiceAgents.list");
    expect(list.linked).toBe(false);
    expect(list.agents.every((a) => !a.voiceAgent && a.characterId === null)).toBe(true);
  });
});

describe("real Robovoice voices only (NO MOCK DATA)", () => {
  it("voiceAgents.list never defaults a voice; { remote: true } reads each voice agent's voice from Robovoice", async () => {
    const svc = await linked();
    const call = rpcHarness(svc);
    type Row = { id: string; ttsProvider: string | null; robovoice?: { tts: { provider: string | null; voice: string | null }; language: string | null } | null };
    const local = await call<{ agents: Row[] }>("robovoice.voiceAgents.list");
    // Nothing picked here → null, not "kokoro"; the local list has no Robovoice voice at all.
    expect(local.agents.map((a) => a.ttsProvider)).toEqual([null, null, null]);
    expect(local.agents.every((a) => a.robovoice === undefined)).toBe(true);

    const remote = await call<{ agents: Row[]; voicesError: string | null }>("robovoice.voiceAgents.list", { remote: true });
    expect(remote.voicesError).toBeNull();
    const main = remote.agents.find((a) => a.id === "main")!;
    const ch = mock.edge.roster.find((c) => c.id === store.get().linkedCharacters.main.characterId)!;
    expect(main.robovoice?.tts.provider).toBe(ch.tts_provider);
    expect(main.robovoice?.language ?? null).toBe(ch.language ?? null);
    // Not a voice agent → no character → no voice (never a guessed one).
    expect(remote.agents.find((a) => a.id === "cmo")!.robovoice).toBeNull();
  });

  it("agent sync sends no invented voice or language — only what the owner picked", async () => {
    const svc = await linked();
    const call = rpcHarness(svc);
    const syncBodies = () =>
      mock.requests
        .filter((r) => r.method === "POST" && r.path === "/api/edge/infinibot/agents")
        .flatMap((r) => ((r.body as { agents?: Array<Record<string, unknown>> })?.agents ?? []));
    const main = syncBodies().filter((a) => a.agent_id === "main").at(-1)!;
    expect(main).toBeTruthy();
    expect(main).not.toHaveProperty("tts_provider");
    expect(main).not.toHaveProperty("tts_voice_kokoro");
    expect(main).not.toHaveProperty("language");
    // An explicit pick is sent as-is.
    await call("robovoice.voiceAgent.set", { agentId: "main", ttsProvider: "elevenlabs", voice: "v123", language: "fr" });
    expect(syncBodies().filter((a) => a.agent_id === "main").at(-1)).toMatchObject({ tts_provider: "elevenlabs", tts_voice_elevenlabs: "v123", language: "fr" });
  });

  it("Robovoice unreachable → voicesError and no voice, never a fallback", async () => {
    const svc = await linked();
    const call = rpcHarness(svc);
    store.update({ link: { ...store.get().link!, apiBase: "http://127.0.0.1:1" } });
    const remote = await call<{ agents: Array<{ id: string; robovoice?: unknown }>; voicesError: string | null }>("robovoice.voiceAgents.list", { remote: true });
    expect(remote.voicesError).toMatch(/unreachable/i);
    expect(remote.agents.every((a) => a.robovoice === null)).toBe(true);
  });

  it("effectivePipeline invents no provider when no Robovoice layer sets one", () => {
    const eff = effectivePipeline({ org: {}, defaults: {} });
    expect(eff.stt.provider).toBe("");
    expect(eff.llm.provider).toBe("");
    expect(eff.tts).toMatchObject({ provider: "", model: "" });
  });
});

describe("InfiniBot agents as Robovoice location agents", () => {
  it("sync is idempotent by InfiniBot agent id: same character, no duplicates, LLM step = InfiniBot", async () => {
    const svc = await linked();
    const call = rpcHarness(svc);
    await call("robovoice.voiceAgent.set", { agentId: "coder", enabled: true, llmBackend: "claude-code", ttsProvider: "elevenlabs", voice: "21m00Tcm4TlvDq8ikWAM" });
    const first = store.get().linkedCharacters.coder.characterId!;
    const rosterSize = mock.edge.roster.length;
    // Toggle again, change voice, resync explicitly — still one character, same id.
    await call("robovoice.voiceAgent.set", { agentId: "coder", enabled: true, voice: "onwK4e9ZLuTAKqWW03F9" });
    await svc.sync();
    expect(store.get().linkedCharacters.coder.characterId).toBe(first);
    expect(mock.edge.roster.length).toBe(rosterSize);
    expect(mock.edge.roster.filter((c) => c.name === "Coder")).toHaveLength(1);
    expect(mock.edge.characterPipeline[first]).toEqual({ llm_provider: "infinibot", llm_model: "infinibot:coder" });
    // Voice binding for the location: base URL + scoped token (never the gateway password).
    const loc = store.get().link!.locationId!;
    expect(mock.edge.voiceLlm[loc].base_url).toBe(`https://gw.example.ts.net${VOICE_LLM_BASE_PATH}`);
    expect(mock.edge.voiceLlm[loc].token).toMatch(/^rvllm_/);
    expect(store.locationForVoiceLlmToken(mock.edge.voiceLlm[loc].token)).toBe(loc);
    expect(mock.edge.voiceLlm[loc].agents.sort()).toEqual(["coder", "main"]);
    const list = await call<{ agents: Array<{ id: string; voiceAgent: boolean; llmBackend: string; voice: string | null }> }>("robovoice.voiceAgents.list");
    expect(list.agents.find((a) => a.id === "coder")).toMatchObject({ voiceAgent: true, llmBackend: "claude-code", voice: "onwK4e9ZLuTAKqWW03F9" });
  });

  it("switching an agent to the location's own LLM clears llm_provider; removing it detaches", async () => {
    const svc = await linked();
    const call = rpcHarness(svc);
    await call("robovoice.voiceAgent.set", { agentId: "cmo", enabled: true });
    const cid = store.get().linkedCharacters.cmo.characterId!;
    await call("robovoice.voiceAgent.set", { agentId: "cmo", llm: "robovoice" });
    expect(mock.edge.characterPipeline[cid]).toEqual({});
    await call("robovoice.voiceAgent.set", { agentId: "cmo", enabled: false });
    expect(store.get().linkedAgents).not.toContain("cmo");
    expect(Object.keys([...mock.edge.links.values()][0].agents)).not.toContain("cmo");
    // Unlinking the install revokes the voice-LLM token.
    const token = mock.edge.voiceLlm[store.get().link!.locationId!].token;
    await svc.unlink();
    expect(store.locationForVoiceLlmToken(token)).toBeNull();
  });

  it("without a public gateway URL nothing is bound (agents keep Robovoice's LLM)", async () => {
    const svc = await linked("");
    store.update({ mcpPublicUrl: undefined });
    await svc.sync();
    expect(Object.keys(mock.edge.voiceLlm)).toHaveLength(0);
    expect(Object.values(mock.edge.characterPipeline).every((p) => !p.llm_provider)).toBe(true);
  });

  it("pipeline editor: reads org/location/character layers and writes with Robovoice's precedence", async () => {
    const svc = await linked();
    const call = rpcHarness(svc);
    const acct = await call<{ org: { name: string }; locations: Array<{ id: string }>; selectedLocationId: string }>("robovoice.account.get");
    expect(acct.org.name).toBe("Mock Org");
    expect(acct.locations.map((l) => l.id)).toContain(acct.selectedLocationId);
    type View = {
      defaults: Record<string, unknown>;
      effective: { location: { llm: { provider: string; providerFrom: string } }; characters: Record<string, { llm: { provider: string; providerFrom: string } }> };
      characters: Array<{ id: string; infinibot_agent_id: string | null; override: Record<string, unknown> }>;
    };
    let v = await call<View>("robovoice.pipeline.config.get");
    expect(v.effective.location.llm).toMatchObject({ provider: "groq", providerFrom: "org" });
    // Location default override.
    let r = await call<{ changed: boolean; view: View }>("robovoice.pipeline.config.set", { values: { llm_provider: "openrouter", tts_voice_kokoro: "am_puck" } });
    expect(r.changed).toBe(true);
    expect(r.view.defaults).toEqual({ llm_provider: "openrouter", tts_voice_kokoro: "am_puck" });
    expect(r.view.effective.location.llm).toMatchObject({ provider: "openrouter", providerFrom: "location" });
    // Setting a value equal to what's inherited clears the override (decide()).
    r = await call("robovoice.pipeline.config.set", { values: { llm_provider: "groq" } });
    expect(r.view.defaults).toEqual({ tts_voice_kokoro: "am_puck" });
    // Unchanged → nothing sent.
    const before = mock.requests.filter((q) => q.method === "PATCH").length;
    r = await call("robovoice.pipeline.config.set", { values: { tts_voice_kokoro: "am_puck" } });
    expect(r.changed).toBe(false);
    expect(mock.requests.filter((q) => q.method === "PATCH").length).toBe(before);
    // Per-agent override on the synced main character.
    v = r.view;
    const mainChar = v.characters.find((c) => c.infinibot_agent_id === "main")!;
    expect(v.effective.characters[mainChar.id].llm).toMatchObject({ provider: "infinibot", providerFrom: "character" });
    r = await call("robovoice.pipeline.config.set", { characterId: mainChar.id, values: { tts_provider: "elevenlabs", tts_voice_elevenlabs: "21m00Tcm4TlvDq8ikWAM" } });
    expect(r.view.characters.find((c) => c.id === mainChar.id)!.override).toEqual({ tts_provider: "elevenlabs", tts_voice_elevenlabs: "21m00Tcm4TlvDq8ikWAM" });
    // Reset to inherited.
    r = await call("robovoice.pipeline.config.set", { characterId: mainChar.id, reset: ["tts_provider", "tts_voice_elevenlabs"] });
    expect(r.view.characters.find((c) => c.id === mainChar.id)!.override).toEqual({});
    // Inherited values for a character scope come from character + location, not the override.
    const cfg = await svc.api().pipelineGet(acct.selectedLocationId);
    expect(inheritedFor(cfg, mainChar.id)).toMatchObject({ llm_provider: "infinibot", llm_model: "infinibot:main", stt_provider: "speaches" });
    // Reset every location default.
    r = await call("robovoice.pipeline.config.set", { resetAll: true });
    expect(r.view.defaults).toEqual({});
  });

  it("pipeline editor: one Apply writes location defaults + the active agent's TTS; catalog + field kinds", async () => {
    const svc = await linked();
    const call = rpcHarness(svc);
    type View = {
      defaults: Record<string, unknown>;
      activeCharacterId: string | null;
      fieldKinds: { defaults: Record<string, { type: string }>; character: Record<string, { type: string }> };
      characters: Array<{ id: string; infinibot_agent_id: string | null; override: Record<string, unknown> }>;
    };
    const v = await call<View>("robovoice.pipeline.config.get");
    // The global view's TTS card edits the main agent's character (Robovoice: the active character).
    const mainChar = v.characters.find((c) => c.infinibot_agent_id === "main")!;
    expect(v.activeCharacterId).toBe(mainChar.id);
    expect(v.fieldKinds.defaults.idle_billing_timeout_seconds).toMatchObject({ type: "int" });
    expect(v.fieldKinds.defaults.adaptive_language_enabled).toMatchObject({ type: "bool" });
    expect(v.fieldKinds.character.llm_provider).toMatchObject({ type: "provider" });
    const patches = () => mock.requests.filter((q) => q.method === "PATCH").length;
    const before = patches();
    const r = await call<{ changed: boolean; view: View }>("robovoice.pipeline.config.set", {
      values: { idle_billing_timeout_seconds: 60, adaptive_language_enabled: false },
      characterValues: { [mainChar.id]: { tts_provider: "elevenlabs", tts_voice_elevenlabs: "21m00Tcm4TlvDq8ikWAM" } },
    });
    expect(r.changed).toBe(true);
    expect(patches()).toBe(before + 1);
    expect(r.view.defaults).toEqual({ idle_billing_timeout_seconds: 60, adaptive_language_enabled: false });
    expect(r.view.characters.find((c) => c.id === mainChar.id)!.override).toEqual({ tts_provider: "elevenlabs", tts_voice_elevenlabs: "21m00Tcm4TlvDq8ikWAM" });
    // Out-of-range values are refused before Robovoice sees them.
    await expect(call("robovoice.pipeline.config.set", { values: { idle_billing_timeout_seconds: 2 } })).rejects.toThrow(/between 5 and 3600/);
    await expect(call("robovoice.pipeline.config.set", { characterValues: { nope: { tts_provider: "kokoro" } } })).rejects.toThrow(/not at this location/);
    // The org's tiered catalog + credits/min per tier (price labels).
    const cat = await call<{ tiers: Array<{ tier: string }>; prices: Record<string, number> }>("robovoice.pipeline.catalog.get", { stage: "tts" });
    expect(cat.tiers.map((t) => t.tier)).toEqual(["standard", "premium", "expressive"]);
    expect(Object.keys(cat.prices)).toEqual(["standard", "premium", "expressive"]);
    await expect(call("robovoice.pipeline.catalog.get", { stage: "vision" })).rejects.toThrow(/stage/);
  });

  it("provider status names org + location and InfiniBot as the LLM", async () => {
    await linked();
    const acc = accountOf(store.get(), 4)!;
    expect(acc).toMatchObject({ org: "Mock Org", agents: 4, llm: "InfiniBot" });
    expect(acc.location).toMatch(/^InfiniBot · /);
  });
});

// ── voice-LLM callback: auth + routing ───────────────────────────────────────

async function serve(voiceTurn: RunVoiceTurn) {
  const stats = new VoiceLlmStats();
  const server = http.createServer((req, res) => void handleVoiceLlmHttp(req, res, { store, voiceTurn, stats }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${VOICE_LLM_BASE_PATH}/chat/completions`;
  return { url, stats, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function recordingTurn(calls: VoiceLlmTurnRequest[]): RunVoiceTurn {
  return async (req) => {
    calls.push(req);
    for (const piece of ["Hello ", "from ", req.backend, "."]) req.onDelta(piece);
    return { text: `Hello from ${req.backend}.`, backend: req.backend, sessionKey: "k", trust: req.callerIsOwner ? "owner" : "caller", firstTokenMs: 3, totalMs: 9 };
  };
}

describe("voice-LLM callback", () => {
  it("rejects missing, foreign and non-voice-agent tokens; routes to the agent's gateway or CLI backend", async () => {
    const svc = await linked();
    const call = rpcHarness(svc);
    await call("robovoice.voiceAgent.set", { agentId: "coder", enabled: true, llmBackend: "codex" });
    const loc = store.get().link!.locationId!;
    const token = store.ensureVoiceLlmToken(loc);
    const calls: VoiceLlmTurnRequest[] = [];
    const srv = await serve(recordingTurn(calls));
    const post = (body: unknown, auth?: string, extra: Record<string, string> = {}) =>
      fetch(srv.url, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...extra }, body: JSON.stringify(body) });
    const msg = (model: string, extra: Record<string, unknown> = {}) => ({ model, messages: [{ role: "system", content: "persona" }, { role: "user", content: "what's up?" }], user: "robopark-room-1", ...extra });
    try {
      expect((await post(msg("infinibot:main"))).status).toBe(401);
      expect((await post(msg("infinibot:main"), "rvib_not_a_voice_token")).status).toBe(401);
      expect((await post(msg("infinibot:main"), "rvllm_forged")).status).toBe(401);
      // A token minted for a different location can't drive this install's agents.
      const other = store.ensureVoiceLlmToken("loc-other");
      expect((await post(msg("infinibot:main"), other)).status).toBe(403);
      // Not a voice agent / bad model.
      expect((await post(msg("infinibot:cmo"), token)).status).toBe(403);
      expect((await post(msg("gpt-4o"), token)).status).toBe(400);
      expect((await post({ model: "infinibot:main", messages: [] }, token)).status).toBe(400);
      expect(calls).toHaveLength(0);

      // Gateway-backed agent (default backend), non-streaming.
      let r = await post(msg("infinibot:main"), token);
      expect(r.status).toBe(200);
      const j = (await r.json()) as { choices: Array<{ message: { content: string } }>; infinibot: { backend: string; trust: string; first_token_ms: number } };
      expect(j.choices[0].message.content).toBe("Hello from gateway.");
      expect(j.infinibot).toMatchObject({ backend: "gateway", trust: "caller", first_token_ms: 3 });
      expect(calls[0]).toMatchObject({ agentId: "main", backend: "gateway", message: "what's up?", provider: "robovoice", callerIsOwner: false, callKey: `${loc}:robopark-room-1` });

      // CLI-backed agent, streaming SSE — deltas arrive as chunks, then timing + [DONE].
      r = await post(msg("infinibot:coder", { stream: true }), token);
      expect(r.headers.get("content-type")).toContain("text/event-stream");
      const sse = await r.text();
      const events = sse.split("\n\n").filter((e) => e.startsWith("data: ")).map((e) => e.slice(6));
      expect(events.at(-1)).toBe("[DONE]");
      const parsed = events.slice(0, -1).map((e) => JSON.parse(e));
      expect(parsed.map((p) => p.choices[0].delta.content ?? "").join("")).toBe("Hello from codex.");
      expect(parsed.at(-1)).toMatchObject({ choices: [{ finish_reason: "stop" }], infinibot: { backend: "codex", agent: "coder" } });
      expect(calls[1]).toMatchObject({ agentId: "coder", backend: "codex" });
      expect(srv.stats.list()[0]).toMatchObject({ agentId: "coder", backend: "codex", ok: true, firstTokenMs: 3 });
    } finally {
      await srv.close();
    }
  });

  it("treats callers as untrusted unless Robovoice vouches for a verified owner email; rotation kills the old token", async () => {
    const svc = await linked();
    const loc = store.get().link!.locationId!;
    store.update({ ownerCallerEmails: ["Owner@Mock.test"] });
    const calls: VoiceLlmTurnRequest[] = [];
    const srv = await serve(recordingTurn(calls));
    const token = store.ensureVoiceLlmToken(loc);
    const post = (tok: string, caller: unknown) =>
      fetch(srv.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tok}` },
        body: JSON.stringify({ model: "infinibot:main", messages: [{ role: "user", content: "hi" }], metadata: { caller } }),
      });
    try {
      await post(token, { role: "owner", email: "owner@mock.test" }); // not verified
      await post(token, { email: "owner@mock.test", verified: true });
      await post(token, { email: "someone@else.test", verified: true });
      expect(calls.map((c) => c.callerIsOwner)).toEqual([false, true, false]);
      const call = rpcHarness(svc);
      await call("robovoice.voiceLlm.rotate");
      expect((await post(token, null)).status).toBe(401);
      const fresh = mock.edge.voiceLlm[loc].token;
      expect(fresh).not.toBe(token);
      expect((await post(fresh, null)).status).toBe(200);
    } finally {
      await srv.close();
    }
  });

  it("the mock Robovoice agent completes a turn end-to-end through the callback", async () => {
    const calls: VoiceLlmTurnRequest[] = [];
    const srv = await serve(recordingTurn(calls));
    const base = srv.url.replace(/\/chat\/completions$/, "").replace(VOICE_LLM_BASE_PATH, "");
    const svc = await linked(base);
    const main = store.get().linkedCharacters.main.characterId!;
    try {
      const r = await fetch(`${mock.url}/__mock/voice-turn`, { method: "POST", body: JSON.stringify({ character_id: main, text: "Hey INFINI", room: "robopark-e2e" }) });
      const j = (await r.json()) as { text: string; chunks: number; first_token_ms: number; infinibot: { backend: string } };
      expect(j.text).toBe("Hello from gateway.");
      expect(j.chunks).toBe(4);
      expect(j.infinibot.backend).toBe("gateway");
      expect(calls[0]).toMatchObject({ agentId: "main", message: "Hey INFINI" });
    } finally {
      await srv.close();
      void svc;
    }
  });

  it("gateway turns default to the fast path and carry the call's history; voiceLlm.set switches it", async () => {
    const svc = await linked();
    const call = rpcHarness(svc);
    const loc = store.get().link!.locationId!;
    const token = store.ensureVoiceLlmToken(loc);
    const calls: VoiceLlmTurnRequest[] = [];
    const srv = await serve(recordingTurn(calls));
    const post = (messages: unknown[]) =>
      fetch(srv.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ model: "infinibot:main", messages, user: "room-9" }) });
    try {
      await post([{ role: "system", content: "persona" }, { role: "user", content: "hi" }, { role: "assistant", content: "Hello." }, { role: "user", content: "and now?" }]);
      expect(calls[0]).toMatchObject({ mode: "auto", message: "and now?", fastModel: undefined });
      expect(calls[0].history).toEqual([{ role: "user", content: "hi" }, { role: "assistant", content: "Hello." }, { role: "user", content: "and now?" }]);

      const st = (await call("robovoice.voiceLlm.set", { mode: "agent", fastModel: " groq/openai/gpt-oss-120b " })) as { mode: string; fastModel: string | null };
      expect(st).toMatchObject({ mode: "agent", fastModel: "groq/openai/gpt-oss-120b" });
      await post([{ role: "user", content: "again" }]);
      expect(calls[1]).toMatchObject({ mode: "agent", fastModel: "groq/openai/gpt-oss-120b" });
      await expect(call("robovoice.voiceLlm.set", { mode: "turbo" })).rejects.toThrow(/auto.*agent/);
      // "" clears the model override; the mode is kept.
      expect(await call("robovoice.voiceLlm.set", { fastModel: "" })).toMatchObject({ mode: "agent", fastModel: null });
    } finally {
      await srv.close();
    }
  });

  it("owner by default = the linked Robovoice account (verified by Robovoice); an explicit list, even empty, is final", async () => {
    await linked();
    const loc = store.get().link!.locationId!;
    expect(store.get().ownerCallerEmails).toBeUndefined();
    const linkedEmail = store.get().link!.userEmail!;
    expect(ownerCallerEmails(store.get())).toEqual([linkedEmail.toLowerCase()]);
    const calls: VoiceLlmTurnRequest[] = [];
    const srv = await serve(recordingTurn(calls));
    const token = store.ensureVoiceLlmToken(loc);
    const post = (caller: unknown) =>
      fetch(srv.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: "infinibot:main", messages: [{ role: "user", content: "hi" }], metadata: { caller } }),
      });
    try {
      await post({ email: linkedEmail, verified: true });
      await post({ email: linkedEmail }); // Robovoice did not vouch for it
      await post({ role: "anonymous" });
      store.update({ ownerCallerEmails: [] });
      await post({ email: linkedEmail, verified: true });
      expect(calls.map((c) => c.callerIsOwner)).toEqual([true, false, false, false]);
      expect(srv.stats.list().map((t) => t.trustReason?.split(";")[0]).reverse()).toEqual([
        "verified owner email",
        "anonymous",
        "anonymous",
        "signed-in, not on the owner list",
      ]);
    } finally {
      await srv.close();
    }
  });

  it("a call the operator started from this install is the owner's: the room the page joined, exact match, until it ends", async () => {
    await linked();
    const loc = store.get().link!.locationId!;
    let now = 1_000;
    const operatorCalls = new OperatorCalls(60_000, () => now);
    const calls: VoiceLlmTurnRequest[] = [];
    const stats = new VoiceLlmStats();
    const server = http.createServer((req, res) => void handleVoiceLlmHttp(req, res, { store, voiceTurn: recordingTurn(calls), stats, operatorCalls }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${VOICE_LLM_BASE_PATH}/chat/completions`;
    const token = store.ensureVoiceLlmToken(loc);
    // The real Robovoice turn shape (infinibot_voice_llm.prepare_runtime): header + user = the room.
    const post = (room: string, characterId = "char-main") =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-robovoice-session": room },
        body: JSON.stringify({
          model: "infinibot:main",
          user: room,
          messages: [{ role: "user", content: "hi" }],
          metadata: { location_id: loc, room, character_id: characterId, caller: { role: "anonymous" } },
        }),
      });
    try {
      await post("robopark-infinibot-dev1"); // nobody started it here
      // 2026-10-03: a cloud call.start answers robopark-<characterId>, but the
      // page joins robopark-<install device> through connection-details.
      operatorCalls.start("robopark-char-main", { agentId: "main", characterId: "char-main", mode: "cloud" });
      await post("robopark-infinibot-dev1"); // start alone does not trust any room
      await post("robopark-char-main"); // the cloud start handle is not a call room (public link rooms look like it)
      operatorCalls.joined("robopark-infinibot-dev1", { agentId: "main", characterId: "char-main" });
      await post("robopark-infinibot-dev1"); // owner
      await post("robopark-evil_robopark-infinibot-dev1"); // no suffix matching
      await post("robopark-infinibot-dev1", "char-other"); // another character in that room is not this call
      await post("robopark-kiosk-7"); // another room
      operatorCalls.end("robopark-char-main"); // the UI ends by the start room
      await post("robopark-infinibot-dev1");
      operatorCalls.joined("robopark-infinibot-dev1", { agentId: "main" });
      now += 61_000; // expired
      await post("robopark-infinibot-dev1");
      expect(calls.map((c) => c.callerIsOwner)).toEqual([false, false, false, true, false, false, false, false, false]);
      const reasons = stats.list().map((t) => t.trustReason).reverse();
      expect(reasons[3]).toBe("call started from this install");
      expect(reasons[0]).toBe("anonymous; room robopark-infinibot-dev1, no operator call active");
      expect(reasons[4]).toBe("anonymous; room robopark-evil_robopark-infinibot-dev1 is not an operator call (active: robopark-infinibot-dev1)");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("a call started from a chat session runs its turns on that session; warm-up answers without a turn; keepalive comments flow", async () => {
    await linked();
    const loc = store.get().link!.locationId!;
    const operatorCalls = new OperatorCalls(60_000, () => 1_000);
    const calls: VoiceLlmTurnRequest[] = [];
    const stats = new VoiceLlmStats();
    const slowTurn: RunVoiceTurn = async (req) => {
      calls.push(req);
      if (req.warmup) return { text: "", backend: req.backend, sessionKey: "k", trust: "owner", firstTokenMs: null, totalMs: 1, timings: { path: "fast", model: "fake/m", prepMs: 1, firstTokenMs: null, firstSentenceMs: null, totalMs: 1 } };
      await new Promise((r) => setTimeout(r, 60));
      req.onDelta("Hi.");
      return { text: "Hi.", backend: req.backend, sessionKey: "k", trust: "owner", firstTokenMs: 60, totalMs: 60 };
    };
    const { KEEPALIVE_MS: _k } = await import("./voice-llm.js");
    const server = http.createServer((req, res) => void handleVoiceLlmHttp(req, res, { store, voiceTurn: slowTurn, stats, operatorCalls }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${VOICE_LLM_BASE_PATH}/chat/completions`;
    const token = store.ensureVoiceLlmToken(loc);
    const post = (room: string, body: Record<string, unknown> = {}) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-robovoice-session": room },
        body: JSON.stringify({
          model: "infinibot:main",
          user: room,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
          metadata: { location_id: loc, room, character_id: "char-main", caller: { role: "anonymous" } },
          ...body,
        }),
      });
    try {
      operatorCalls.start("robopark-char-main", { agentId: "main", characterId: "char-main", mode: "cloud", sessionKey: "agent:main:webchat:grid-7" });
      operatorCalls.joined("robopark-infinibot-dev1", { agentId: "main", characterId: "char-main" });
      // A foreign agent's session is never accepted (the pending call.start's session applies instead).
      operatorCalls.joined("robopark-infinibot-dev2", { agentId: "main", characterId: "char-main", sessionKey: "agent:other:webchat:x" });
      const warm = await post("robopark-infinibot-dev1", { messages: [], metadata: { location_id: loc, room: "robopark-infinibot-dev1", warmup: true } });
      expect(warm.status).toBe(200);
      expect(await warm.json()).toMatchObject({ ok: true, model: "fake/m" });
      const sse = await (await post("robopark-infinibot-dev1")).text();
      expect(sse).toContain('"content":"Hi."');
      await (await post("robopark-infinibot-dev2")).text();
      expect(calls.map((c) => [c.warmup ?? false, c.callerIsOwner, c.sessionKey])).toEqual([
        [true, true, "agent:main:webchat:grid-7"],
        [false, true, "agent:main:webchat:grid-7"],
        [false, true, "agent:main:webchat:grid-7"],
      ]);
      expect(operatorCalls.get("robopark-infinibot-dev2")?.sessionKey).not.toBe("agent:other:webchat:x");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("operator calls survive a gateway restart (persisted) and a local call trusts the Desktop's room", () => {
    let saved: unknown = [];
    const persist = { load: () => saved, save: (c: unknown) => void (saved = JSON.parse(JSON.stringify(c))) };
    let now = 1_000;
    const a = new OperatorCalls(60_000, () => now, persist);
    a.start("robopark-desktop-1", { agentId: "main", mode: "local" });
    a.joined("robopark-infinibot-dev1", { agentId: "main", characterId: "c1" });
    const b = new OperatorCalls(60_000, () => now, persist); // "restarted"
    expect(b.has("robopark-desktop-1")).toBe(true);
    expect(b.has("robopark-infinibot-dev1", "c1")).toBe(true);
    now += 61_000;
    expect(new OperatorCalls(60_000, () => now, persist).rooms()).toEqual([]);
  });

  it("a request the voice agent dropped (caller spoke again) is a cancelled turn, not a failure", async () => {
    await linked();
    const loc = store.get().link!.locationId!;
    const warns: string[] = [];
    const infos: string[] = [];
    const stats = new VoiceLlmStats();
    let started: () => void;
    const turnStarted = new Promise<void>((r) => (started = r));
    const voiceTurn: RunVoiceTurn = (req) =>
      new Promise((_resolve, reject) => {
        started();
        req.signal?.addEventListener("abort", () => reject(Object.assign(new Error("voice turn aborted"), { code: "aborted" })));
      });
    const server = http.createServer((req, res) =>
      void handleVoiceLlmHttp(req, res, { store, voiceTurn, stats, log: { info: (m) => infos.push(m), warn: (m) => warns.push(m) } }),
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${VOICE_LLM_BASE_PATH}/chat/completions`;
    const token = store.ensureVoiceLlmToken(loc);
    const abort = new AbortController();
    try {
      const pending = fetch(url, {
        method: "POST",
        signal: abort.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: "infinibot:main", stream: true, messages: [{ role: "user", content: "can you spawn" }] }),
      }).then((r) => r.text()).catch(() => "aborted");
      await turnStarted;
      abort.abort();
      await pending;
      for (let i = 0; i < 50 && !stats.list().length; i++) await new Promise((r) => setTimeout(r, 20));
      expect(stats.list()[0]).toMatchObject({ ok: true, cancelled: true });
      expect(stats.list()[0].error).toBeUndefined();
      expect(warns).toEqual([]);
      expect(infos[0]).toContain("cancelled (caller spoke again or hung up)");
      expect(stats.summary()).toMatchObject({ turns: 1, ok: 0 });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("the turn line says why a turn was routed and which tools the agent called", () => {
    const stat = turnStat(
      { agentId: "main", locationId: "loc", backend: "gateway", trust: "owner", trustReason: "call started from this install", call: "room" },
      {
        text: "On it, one moment. Sent.",
        backend: "gateway",
        sessionKey: "k",
        trust: "owner",
        firstTokenMs: 1,
        totalMs: 4200,
        timings: { path: "fast+agent", prepMs: 0, firstTokenMs: 1, firstSentenceMs: 1, totalMs: 4200, agentPrepMs: 300, agentFirstTokenMs: 3900, routeReason: "prefilter: action request", toolCalls: ["sessions_spawn"] },
      },
      Date.now(),
    );
    expect(formatTurnLine(stat)).toBe(
      'voice-llm main via gateway path=fast+agent (owner: call started from this install) route "prefilter: action request" prep 0ms first-token 1ms first-sentence 1ms agent-prep 300ms agent-first-token 3900ms total 4200ms chars 24 tools sessions_spawn',
    );
  });

  it("one log line per turn says where the time went", () => {
    const stat = turnStat(
      { agentId: "main", locationId: "loc", backend: "gateway", trust: "caller", call: "room" },
      {
        text: "One moment. Done.",
        backend: "gateway",
        sessionKey: "k",
        trust: "caller",
        firstTokenMs: 640,
        totalMs: 5200,
        timings: { path: "fast+agent", model: "ollama-cloud/gpt-oss:120b", prepMs: 2, firstTokenMs: 640, firstSentenceMs: 655, totalMs: 5200, agentPrepMs: 900, agentFirstTokenMs: 3100 },
      },
      Date.now(),
    );
    expect(formatTurnLine(stat)).toBe(
      "voice-llm main via gateway path=fast+agent model=ollama-cloud/gpt-oss:120b (caller) prep 2ms first-token 640ms first-sentence 655ms agent-prep 900ms agent-first-token 3100ms total 5200ms chars 17",
    );
    const failed = turnStat({ agentId: "main", locationId: "loc", backend: "gateway", trust: "caller" }, null, Date.now(), "boom");
    expect(formatTurnLine(failed)).toMatch(/path=agent \(caller\) prep — first-token — first-sentence — total \d+ms chars 0 error "boom"$/);
    const stats = new VoiceLlmStats();
    stats.add(stat);
    stats.add(failed);
    expect(stats.summary()).toMatchObject({ turns: 2, ok: 1, firstTokenP50Ms: 640, paths: { "fast+agent": 1, agent: 1 } });
  });

  it("conversationHistory keeps user/assistant text only", () => {
    expect(conversationHistory([{ role: "system", content: "x" }, { role: "user", content: [{ type: "text", text: "a" }] }, { role: "assistant", content: " b " }, { role: "tool", content: "t" }, { role: "user", content: "" }])).toEqual([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]);
    expect(conversationHistory(undefined)).toEqual([]);
  });

  it("lastUserMessage takes the newest user turn (text or parts)", () => {
    expect(lastUserMessage([{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: [{ type: "text", text: "c" }] }])).toBe("c");
    expect(lastUserMessage([{ role: "system", content: "x" }])).toBe("");
  });
});

// ── delegated work: update poll, hang-up, timing settings ────────────────────

describe("voice-LLM update poll", () => {
  it("owner calls get their due updates; guests get none; hang-up is passed through; timing settings round-trip", async () => {
    const svc = await linked();
    const loc = store.get().link!.locationId!;
    const operatorCalls = new OperatorCalls();
    operatorCalls.joined("robopark-dev1", { agentId: "main" });
    const calls: VoiceLlmTurnRequest[] = [];
    const voiceTurn: RunVoiceTurn = async (req) => {
      calls.push(req);
      return {
        text: "",
        backend: req.backend,
        sessionKey: "k",
        trust: "owner",
        firstTokenMs: null,
        totalMs: 1,
        updates: req.pollUpdates ? ["Still working: the coder is running tests."] : [],
        running: 1,
      };
    };
    const stats = new VoiceLlmStats();
    const server = http.createServer((req, res) => void handleVoiceLlmHttp(req, res, { store, voiceTurn, stats, operatorCalls }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${VOICE_LLM_BASE_PATH}/chat/completions`;
    const token = store.ensureVoiceLlmToken(loc);
    const poll = (room: string, metadata: Record<string, unknown>) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-robovoice-session": room },
        body: JSON.stringify({ model: "infinibot:main", user: room, metadata }),
      }).then((r) => r.json() as Promise<{ ok: boolean; updates: string[]; running: number; next_poll_ms: number }>);
    try {
      const call = rpcHarness(svc);
      await call("robovoice.voiceLlm.set", { timing: { progressIntervalMs: 20_000, slowTools: ["gmail"], bogus: 1 } });
      await call("robovoice.voiceLlm.set", { timing: { fastToolTimeoutMs: 5_000 } });
      expect(store.get().voiceTiming).toEqual({ progressIntervalMs: 20_000, slowTools: ["gmail"], fastToolTimeoutMs: 5_000 });

      const owner = await poll("robopark-dev1", { poll_updates: true });
      expect(owner).toEqual({ ok: true, updates: ["Still working: the coder is running tests."], running: 1, next_poll_ms: 4_000 });
      expect(calls[0]).toMatchObject({
        pollUpdates: true,
        callerIsOwner: true,
        callKey: `${loc}:robopark-dev1`,
        voiceTiming: { progressIntervalMs: 20_000, fastToolTimeoutMs: 5_000 },
      });
      const guest = await poll("robopark-stranger", { poll_updates: true });
      expect(guest.updates).toEqual([]);
      expect(calls).toHaveLength(1);
      await poll("robopark-dev1", { call_ended: true });
      expect(calls[1]).toMatchObject({ callEnded: true, pollUpdates: false });
      // Polls are not turns: nothing in the turn stats.
      expect(stats.list()).toHaveLength(0);

      await call("robovoice.voiceLlm.set", { timing: null });
      expect(store.get().voiceTiming).toBeUndefined();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
