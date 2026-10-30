import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startMockRobovoice, type MockRobovoice } from "../test/mock-robovoice-server.js";
import { agentFromRoomName, encodeAgentIdForRoom, resolveCharacterForAgent } from "./character-map.js";
import { RobovoiceClient } from "./client.js";
import { handleMcpMessage } from "./mcp.js";
import { createRobovoiceProvider } from "./provider.js";
import { assessRobovoiceSafety } from "./safety.js";
import { RobovoiceSettingsStore, robovoiceDataDir } from "./settings.js";

let mock: MockRobovoice;
let dir: string;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rv-plugin-"));
  mock = await startMockRobovoice({ edgeToken: "rve_test_token" });
});
afterEach(async () => {
  await mock.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function store(extra: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = {}) {
  const s = new RobovoiceSettingsStore(dir, {}, undefined, env);
  s.update({ baseUrl: mock.url, deployment: "cloud", deviceId: "infinibot-gw", ...extra });
  s.setSecrets({ edgeToken: "rve_test_token", deviceKey: "devkey123456" });
  return s;
}

describe("character mapping", () => {
  it("round-trips the voice UI's room-name agent encoding", () => {
    const room = `voice-emp_${encodeAgentIdForRoom("sales.bot")}-123e4567-e89b-12d3-a456-426614174000`;
    expect(agentFromRoomName(room)).toBe("sales_bot");
    expect(agentFromRoomName("voice-123e4567-e89b-12d3-a456-426614174000")).toBeUndefined();
  });

  it("resolves explicit agent id, encoded room agent, default, then leaves it to Robovoice", () => {
    const settings = { characterMap: { "sales.bot": "char-kate", main: "char-ash" }, defaultCharacterId: "char-lab" };
    expect(resolveCharacterForAgent(settings, { agentId: "main" })).toMatchObject({ characterId: "char-ash", source: "mapping" });
    const room = `voice-emp_sales_bot-123e4567-e89b-12d3-a456-426614174000`;
    expect(resolveCharacterForAgent(settings, { room })).toMatchObject({ characterId: "char-kate", agentId: "sales.bot" });
    expect(resolveCharacterForAgent(settings, { agentId: "other" })).toMatchObject({ characterId: "char-lab", source: "default" });
    expect(resolveCharacterForAgent({ characterMap: {} }, {})).toEqual({ source: "robovoice", agentId: undefined });
  });
});

describe("settings store", () => {
  it("keeps secrets out of settings, masks them, writes 0600 and falls back to env", () => {
    const s = store();
    expect(JSON.stringify(s.get())).not.toContain("rve_test_token");
    expect(s.secretState().edgeToken).toEqual({ set: true, source: "stored", hint: "••••oken" });
    const mode = fs.statSync(path.join(dir, "secrets.json")).mode & 0o777;
    expect(mode).toBe(0o600);
    s.setSecrets({ edgeToken: null });
    expect(s.secretState().edgeToken).toEqual({ set: false });
    const envStore = new RobovoiceSettingsStore(dir, {}, undefined, { ROBOVOICE_EDGE_TOKEN: "rve_env_abcd" });
    expect(envStore.secretState().edgeToken).toMatchObject({ set: true, source: "env" });
  });

  it("stores under the host plugin-data dir and moves a pre-release plugins/robovoice dir once", () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "rv-state-"));
    fs.mkdirSync(path.join(state, "plugins", "robovoice"), { recursive: true });
    fs.writeFileSync(path.join(state, "plugins", "robovoice", "secrets.json"), '{"edgeToken":"rve_old"}');
    const dir = robovoiceDataDir(state);
    expect(dir).toBe(path.join(state, "plugin-data", "robovoice"));
    expect(fs.existsSync(path.join(dir, "secrets.json"))).toBe(true);
    expect(fs.existsSync(path.join(state, "plugins", "robovoice"))).toBe(false);
    expect(new RobovoiceSettingsStore(dir).secrets().edgeToken).toBe("rve_old");
    expect(robovoiceDataDir(state)).toBe(dir);
    fs.rmSync(state, { recursive: true, force: true });
  });

  it("reads write-only secrets saved from Setup › Plugins › Settings (stored > config > env)", () => {
    const s = new RobovoiceSettingsStore(dir, { edgeToken: "rve_cfg_wxyz" }, undefined, {
      ROBOVOICE_EDGE_TOKEN: "rve_env_abcd",
    });
    expect(s.secrets().edgeToken).toBe("rve_cfg_wxyz");
    expect(s.secretState().edgeToken).toEqual({ set: true, source: "config", hint: "••••wxyz" });
    s.setSecrets({ edgeToken: "rve_stored_1234" });
    expect(s.secrets().edgeToken).toBe("rve_stored_1234");
    expect(s.get()).not.toHaveProperty("edgeToken");
  });

  it("layers stored settings over plugin config over the legacy robovoiceUrl", () => {
    const legacy = new RobovoiceSettingsStore(dir, {}, "http://legacy:3011/");
    expect(legacy.get().baseUrl).toBe("http://legacy:3011");
    const cfg = new RobovoiceSettingsStore(dir, { baseUrl: "http://from-config:3011" }, "http://legacy:3011");
    expect(cfg.get().baseUrl).toBe("http://from-config:3011");
    cfg.update({ baseUrl: "http://stored:3011" });
    expect(cfg.get().baseUrl).toBe("http://stored:3011");
  });
});

describe("Robovoice client against the mock deployment", () => {
  it("reads health, roster and pipeline", async () => {
    const c = new RobovoiceClient({ baseUrl: mock.url });
    expect(await c.health()).toMatchObject({ ok: true, status: "ok" });
    const roster = await c.characters();
    expect(roster.characters.map((x) => x.id)).toEqual(["char-ash", "char-kate", "char-lab"]);
    expect(roster.default_character_id).toBe("char-ash");
    const p = await c.pipeline("char-lab", "loc-1");
    expect(p.tts).toMatchObject({ provider: "piper", model: "en_US-lessac-medium" });
    expect(mock.requests.at(-1)?.query).toEqual({ character: "char-lab", location: "loc-1" });
  });

  it("reports credits from /api/edge/me in Robovoice credits (1 credit = $0.01)", async () => {
    const c = new RobovoiceClient({ baseUrl: mock.url, edgeToken: "rve_test_token" });
    expect(await c.credits()).toMatchObject({ available: true, availableUsd: 24.5, availableCredits: 2450, orgName: "Mock Org" });
    const noToken = new RobovoiceClient({ baseUrl: mock.url });
    expect(await noToken.credits()).toMatchObject({ available: false });
  });

  it("maps 402 / 429 to the friendly cloud_voice_busy VoiceProviderError", async () => {
    mock.options.enforceInfinibotLink = false;
    const c = new RobovoiceClient({ baseUrl: mock.url, edgeToken: "rve_test_token", deviceId: "infinibot-gw", deviceKey: "k" });
    mock.options.insufficientBalance = true;
    await expect(c.connectionDetails({ characterId: "char-ash" })).rejects.toMatchObject({ status: 429, code: "cloud_voice_busy" });
    mock.options.insufficientBalance = false;
    mock.options.cloudVoiceBusy = true;
    await expect(c.connectionDetails({ characterId: "char-ash" })).rejects.toMatchObject({ status: 429, code: "cloud_voice_busy" });
    mock.options.cloudVoiceBusy = false;
  });

  it("never asks for an anonymous / character-less session", async () => {
    const c = new RobovoiceClient({ baseUrl: mock.url, edgeToken: "rve_test_token" });
    await expect(c.connectionDetails({ characterId: "char-ash" })).rejects.toMatchObject({ status: 409, code: "robovoice_not_linked" });
    const d = new RobovoiceClient({ baseUrl: mock.url, deviceId: "infinibot-gw", deviceKey: "k" });
    await expect(d.connectionDetails({})).rejects.toMatchObject({ code: "robovoice_not_linked" });
    expect(mock.requests.some((r) => r.path === "/api/connection-details")).toBe(false);
  });

  it("maps an unreachable deployment to a 503", async () => {
    const c = new RobovoiceClient({ baseUrl: "http://127.0.0.1:1", timeoutMs: 1000 });
    await expect(c.health()).rejects.toMatchObject({ status: 503, code: "robovoice_unreachable" });
  });
});

describe("Robovoice voice provider", () => {
  /** A linked install: link record + device in the mock (as `robovoice login` leaves it). */
  function linkedStore(extra: Record<string, unknown> = {}) {
    const s = store(extra);
    s.update({
      link: { apiBase: mock.url, orgId: "11111111-2222-4333-8444-555555555555", orgName: "Mock Org", locationId: "loc-lobby", deviceId: "infinibot-gw", linkedAt: new Date().toISOString() },
    });
    mock.edge.devices.set("infinibot-gw", { device_id: "infinibot-gw", name: "InfiniBot", location_id: "loc-lobby", revoked: false, key: "devkey123456" });
    mock.edge.links.set("ib_test", { installId: "ib_test", locationId: "loc-lobby", deviceId: "infinibot-gw", unlinkedAt: null, agents: {}, mcp: {} });
    return s;
  }

  it("issues a session for the mapped org character with the link's device credentials", async () => {
    const s = linkedStore({ characterMap: { main: "char-kate" }, expressive: true });
    const provider = createRobovoiceProvider(s);
    expect(provider.capabilities).toEqual(["realtime"]);
    expect(provider.configured?.()).toBe(true);
    const session = await provider.createRealtimeSession!({ agentId: "main", room: "ignored" });
    expect(session).toMatchObject({
      url: "wss://mock-livekit.robovoice.test",
      room: "robopark-infinibot-gw",
      participant: "user",
      characterId: "char-kate",
      characterName: "Kate Mint",
    });
    expect(session.token.split(".")).toHaveLength(3);
    const req = mock.requests.find((r) => r.path === "/api/connection-details")!;
    expect(req.method).toBe("POST");
    expect(req.query).toEqual({ character: "char-kate", device: "infinibot-gw", location: "loc-lobby", expressive: "1" });
    expect(req.body).toEqual({ device_id: "infinibot-gw", device_key: "devkey123456" });
    expect(req.auth).toBe("Bearer rve_test_token");
  });

  it("status is ready with the org's agent count, and carries safety flags for Lessac", async () => {
    const s = linkedStore({ characterMap: { lab: "char-lab" } });
    const status = await createRobovoiceProvider(s).status();
    expect(status.ready).toBe(true);
    expect(status.deployment).toBe("cloud");
    expect(status.detail).toBe("Mock Org · 3 agents");
    expect(status.safety?.map((f) => f.code)).toEqual(["piper-lessac-voice"]);
    expect(status.error).toMatch(/Non-commercial model in use on a cloud deployment/);
  });

  it("is not ready without a link and refuses sessions with 409 robovoice_not_linked", async () => {
    const empty = new RobovoiceSettingsStore(dir, {}, undefined, {});
    const provider = createRobovoiceProvider(empty);
    expect(provider.configured?.()).toBe(false);
    expect(await provider.status()).toMatchObject({ ready: false });
    await expect(provider.createRealtimeSession!({})).rejects.toMatchObject({ status: 409, code: "robovoice_not_linked" });
    // A URL + device + key without a link is still not linked.
    const s = store({ characterMap: { main: "char-kate" } });
    expect(createRobovoiceProvider(s).configured?.()).toBe(false);
  });
});

describe("commercial safety for Robovoice", () => {
  it("labels openWakeWord default weights and Lessac; only a cloud deployment is a violation", () => {
    const pipelines = [{ tts: { provider: "piper", model: "en_US-lessac-medium" } }];
    const selfHost = assessRobovoiceSafety(
      { deployment: "self-hosted", wakeWord: { engine: "openwakeword", model: "models/hey_jarvis.onnx" } },
      pipelines,
    );
    expect(selfHost.flags.map((f) => f.code).sort()).toEqual(["openwakeword-default-weights", "piper-lessac-voice"]);
    expect(selfHost.cloudViolation).toBe(false);
    expect(assessRobovoiceSafety({ deployment: "cloud" }, pipelines).cloudViolation).toBe(true);
    expect(assessRobovoiceSafety({ deployment: "cloud" }, [{ tts: { provider: "elevenlabs", model: "x" } }]).flags).toEqual([]);
  });
});

describe("plugin MCP endpoint", () => {
  const req = {} as IncomingMessage;
  it("initializes, lists only allowlisted tools and refuses others", async () => {
    const calls: string[] = [];
    const invoke = async (name: string) => {
      calls.push(name);
      return { ok: true, result: { content: [{ type: "text", text: `ran ${name}` }] } };
    };
    const init = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "initialize" }, ["notes"], invoke, req);
    expect(init).toMatchObject({ result: { serverInfo: { name: "infinibot-robovoice" } } });
    expect(await handleMcpMessage({ method: "notifications/initialized" }, ["notes"], invoke, req)).toBeNull();
    const list = await handleMcpMessage({ id: 2, method: "tools/list" }, ["notes", "kanban"], invoke, req);
    expect((list as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name)).toEqual(["notes", "kanban"]);
    const ok = await handleMcpMessage({ id: 3, method: "tools/call", params: { name: "notes", arguments: {} } }, ["notes"], invoke, req);
    expect(ok).toMatchObject({ result: { content: [{ text: "ran notes" }], isError: false } });
    const denied = await handleMcpMessage({ id: 4, method: "tools/call", params: { name: "gateway" } }, ["notes"], invoke, req);
    expect(denied).toMatchObject({ error: { code: -32602 } });
    expect(calls).toEqual(["notes"]);
  });
});
