import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startMockRobovoice, type MockRobovoice } from "../test/mock-robovoice-server.js";
import { agentSessionKey, agentToolInvoker, handleAgentMcpHttp } from "./agent-mcp.js";
import { registerRobovoiceCli } from "./cli.js";
import { parseCredits } from "./client.js";
import { REMOTE_FRESH_MS, REMOTE_STALE_MAX_MS, RobovoiceLinkService, voicePrompt } from "./link.js";
import { createRobovoiceProvider } from "./provider.js";
import { RobovoiceSettingsStore, type SecretCipher } from "./settings.js";
import { createRobovoiceCallTool } from "./tool.js";

/** Reversible stand-in for the install-key cipher (never touches infinibot.json). */
const testCipher: SecretCipher = {
  encrypt: (p) => Buffer.from(`x:${p}`).toString("base64"),
  decrypt: (b) => {
    const t = Buffer.from(b, "base64").toString();
    return t.startsWith("x:") ? t.slice(2) : null;
  },
};

const PERSONAS = [
  { id: "main", name: "INFINI", description: "Chief Executive · routes work." },
  { id: "cmo", name: "CMO", description: "Marketing lead." },
  { id: "archivist", name: "Archivist" },
];

let mock: MockRobovoice;
let dir: string;
let store: RobovoiceSettingsStore;

function service(opts: { running?: boolean } = {}) {
  return new RobovoiceLinkService({
    store,
    personas: () => PERSONAS,
    sleep: async () => {},
    env: {},
    detectDesktop: () => ({ installed: Boolean(opts.running), running: Boolean(opts.running) }),
  });
}

async function login(svc: RobovoiceLinkService) {
  const { apiBase, start } = await svc.startLogin(mock.url);
  const token = await svc.waitForLogin(apiBase, start);
  return svc.completeLogin(apiBase, token);
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rv-link-"));
  store = new RobovoiceSettingsStore(dir, {}, undefined, {}, testCipher);
  mock = await startMockRobovoice({});
});
afterEach(async () => {
  await mock.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("encrypted install-wide secrets", () => {
  it("encrypts every secret at rest, migrates legacy plaintext, keeps 0600", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "secrets.json"), JSON.stringify({ edgeToken: "rve_legacy_plain_1234" }));
    expect(store.secrets().edgeToken).toBe("rve_legacy_plain_1234");
    expect(store.secretsEncrypted()).toBe(false);
    store.setSecrets({ deviceKey: "devkey-abcdef" });
    const raw = fs.readFileSync(path.join(dir, "secrets.json"), "utf8");
    expect(raw).not.toContain("rve_legacy_plain_1234");
    expect(raw).not.toContain("devkey-abcdef");
    expect(store.secretsEncrypted()).toBe(true);
    expect(store.secrets()).toMatchObject({ edgeToken: "rve_legacy_plain_1234", deviceKey: "devkey-abcdef" });
    expect(fs.statSync(path.join(dir, "secrets.json")).mode & 0o777).toBe(0o600);
    // A store without the key can't read the ciphertext (and doesn't leak it).
    expect(new RobovoiceSettingsStore(dir, {}, undefined, {}, null).secrets().deviceKey).toBeUndefined();
  });

  it("mints a stable install id and per-agent MCP tokens with constant-time lookup", () => {
    const id = store.ensureInstallId();
    expect(id).toMatch(/^ib_[A-Za-z0-9_-]{16,}$/);
    expect(store.ensureInstallId()).toBe(id);
    const main = store.ensureMcpToken("main");
    const cmo = store.ensureMcpToken("cmo");
    expect(main).toMatch(/^rvib_/);
    expect(store.ensureMcpToken("main")).toBe(main);
    expect(store.agentForMcpToken(main)).toBe("main");
    expect(store.agentForMcpToken(cmo)).toBe("cmo");
    expect(store.agentForMcpToken("rvib_nope")).toBeNull();
    expect(store.agentForMcpToken(undefined)).toBeNull();
    store.revokeMcpTokens(["main"]);
    expect(store.agentForMcpToken(main)).toBeNull();
    expect(fs.readFileSync(path.join(dir, "secrets.json"), "utf8")).not.toContain(cmo);
  });
});

describe("login → InfiniBot becomes a Robovoice location", () => {
  it("device-code login stores the token, creates the location + device and syncs main", async () => {
    const svc = service();
    const summary = await login(svc);
    const s = store.get();
    expect(summary.linked).toBe(true);
    expect(summary.org?.name).toBe("Mock Org");
    expect(s.link?.locationName).toBe(`InfiniBot · ${os.hostname()}`);
    expect(s.deviceId).toMatch(/^infinibot-[0-9a-f]{16}$/);
    expect(s.baseUrl).toBe(mock.url);
    expect(s.deployment).toBe("cloud");
    expect(store.secrets().edgeToken).toMatch(/^rve_mock_/);
    expect(store.secrets().deviceKey).toBeTruthy();
    expect(s.characterMap.main).toMatch(/^ib/);
    expect(s.linkedCharacters.main).toMatchObject({ managed: true, characterId: s.characterMap.main });
    // Persona: voice-shaped prompt from the agent identity, on the location.
    const ch = mock.edge.roster.find((c) => c.id === s.characterMap.main)!;
    expect(ch.name).toBe("INFINI");
    // No language invented by InfiniBot: Robovoice keeps/decides its own.
    expect(ch.language).toBeUndefined();
    expect(ch.agent_location_id).toBe(s.locationId);
    expect(ch.system_prompt).toMatch(/You are INFINI/);
    expect(summary.credits).toMatchObject({ available: true, availableCredits: 2450 });
    // The public roster never shows the prompt.
    const pub = await (await fetch(`${mock.url}/api/call/characters`)).json();
    expect(JSON.stringify(pub)).not.toContain("You are INFINI");
  });

  it("relink reuses the location and device (no duplicates); unlink retires the device and keeps the location", async () => {
    const svc = service();
    await login(svc);
    const first = store.get();
    const locations = mock.edge.locations.length;
    await svc.link();
    await login(svc); // a second full login of the same install
    expect(store.get().locationId).toBe(first.locationId);
    expect(store.get().deviceId).toBe(first.deviceId);
    expect(mock.edge.locations.length).toBe(locations);
    expect(mock.edge.devices.size).toBe(1);
    expect(Object.keys(mock.edge.links.values().next().value!.agents)).toEqual(["main"]);

    const u = await svc.unlink();
    expect(u).toMatchObject({ ok: true, deviceRevoked: first.deviceId, locationKept: first.locationId });
    expect(mock.edge.devices.get(first.deviceId!)?.revoked).toBe(true);
    expect(mock.edge.locations.some((l) => l.id === first.locationId)).toBe(true);
    expect(store.secrets().deviceKey).toBeUndefined();
    const st = await svc.status({ remote: true });
    expect(st.linked).toBe(false);
    expect(st.unlinkedAt).toBeTruthy();
    expect(st.location?.id).toBe(first.locationId);

    await svc.link();
    expect(mock.edge.devices.get(first.deviceId!)?.revoked).toBe(false);
    expect(store.get().locationId).toBe(first.locationId);
    expect(mock.edge.locations.length).toBe(locations);
  });

  it("recreates the location when it was deleted in Robovoice", async () => {
    const svc = service();
    await login(svc);
    const old = store.get().locationId;
    mock.edge.locations = mock.edge.locations.filter((l) => l.id !== old);
    await svc.link();
    expect(store.get().locationId).not.toBe(old);
    expect(mock.edge.locations.filter((l) => l.name.startsWith("InfiniBot ·")).length).toBe(1);
  });

  it("a declined sign-in stores nothing", async () => {
    await mock.close();
    mock = await startMockRobovoice({ approveAfterPolls: 0 });
    const svc = service();
    const { apiBase, start } = await svc.startLogin(mock.url);
    await fetch(`${mock.url}/api/edge/auth/approve`, { method: "POST", body: JSON.stringify({ code: start.user_code, approve: false }) });
    await expect(svc.waitForLogin(apiBase, start)).rejects.toMatchObject({ code: "access_denied" });
    expect(store.secrets().edgeToken).toBeUndefined();
    expect(store.get().link).toBeUndefined();
  });

  it("beginLogin finishes in the background for the UI", async () => {
    const svc = service();
    const p = await svc.beginLogin(mock.url);
    expect(p).toMatchObject({ status: "pending", apiBase: mock.url });
    expect(p.userCode).toMatch(/^MOCK-/);
    for (let i = 0; i < 50 && svc.pendingLogin()?.status !== "linked"; i++) await new Promise((r) => setTimeout(r, 20));
    expect(svc.pendingLogin()?.status).toBe("linked");
    expect(store.get().link?.deviceId).toBeTruthy();
  });

  it("logout retires the device, revokes the token and drops local secrets", async () => {
    const svc = service();
    await login(svc);
    const token = store.secrets().edgeToken!;
    const r = await svc.logout();
    expect(r).toMatchObject({ ok: true, unlinked: true, tokenRevoked: true });
    expect(mock.edge.tokens.has(token)).toBe(false);
    expect(store.secrets()).toEqual({ deviceKey: undefined, edgeToken: undefined, mcpTokens: undefined });
  });
});

describe("agents ↔ characters", () => {
  it("links more agents: create a managed character, or attach an existing one", async () => {
    const svc = service();
    await login(svc);
    await svc.linkAgent("cmo", { override: { ttsProvider: "kokoro", voice: "am_puck", language: "es", name: "Maya" } });
    const s1 = store.get();
    const cmo = mock.edge.roster.find((c) => c.id === s1.characterMap.cmo)!;
    expect(cmo).toMatchObject({ name: "Maya", language: "es", voice: "am_puck" });
    expect(s1.linkedAgents).toEqual(["main", "cmo"]);

    await svc.linkAgent("archivist", { characterId: "char-kate" });
    const s2 = store.get();
    expect(s2.characterMap.archivist).toBe("char-kate");
    expect(s2.linkedCharacters.archivist).toMatchObject({ managed: false, characterId: "char-kate" });
    // Resync keeps managed ids stable (no duplicates).
    const before = mock.edge.roster.length;
    await svc.sync();
    expect(mock.edge.roster.length).toBe(before);
    expect(store.get().characterMap.cmo).toBe(s1.characterMap.cmo);

    await expect(svc.linkAgent("nobody")).rejects.toMatchObject({ code: "unknown_agent" });
    await expect(svc.linkAgent("cmo", { characterId: "char-missing" })).resolves.toMatchObject({ ok: false });
  });

  it("unlinking an agent detaches it and revokes its MCP token", async () => {
    const svc = service();
    await login(svc);
    store.update({ mcpPublicUrl: "https://gw.example.ts.net" });
    await svc.linkAgent("cmo");
    const tok = store.secrets().mcpTokens!.cmo;
    await svc.unlinkAgent("cmo");
    expect(store.get().characterMap.cmo).toBeUndefined();
    expect(store.get().linkedAgents).toEqual(["main"]);
    expect(store.agentForMcpToken(tok)).toBeNull();
    expect(Object.keys(mock.edge.links.values().next().value!.agents)).toEqual(["main"]);
  });

  it("binds each agent to the gateway MCP with its own token (owner org); tenants get 'unsupported'", async () => {
    const svc = service();
    await login(svc);
    store.update({ mcpPublicUrl: "https://gw.example.ts.net/" });
    await svc.linkAgent("cmo");
    const reg = mock.edge.mcpRegistry;
    expect(reg.map((r) => r.id).sort()).toEqual(["infinibot-cmo", "infinibot-main"]);
    const main = reg.find((r) => r.id === "infinibot-main")!;
    expect(main.url).toBe("https://gw.example.ts.net/plugins/robovoice/agent-mcp?agent=main");
    expect(store.agentForMcpToken(String(main.auth_token))).toBe("main");
    expect(mock.edge.characterMcp[store.get().characterMap.main]).toEqual(["infinibot-main"]);
    expect(voicePrompt(PERSONAS[0], { tools: true })).toMatch(/use your InfiniBot tools/);

    await mock.close();
    mock = await startMockRobovoice({ ownerOrg: false });
    store = new RobovoiceSettingsStore(fs.mkdtempSync(path.join(os.tmpdir(), "rv-link-t-")), {}, undefined, {}, testCipher);
    const tenant = service();
    await login(tenant);
    store.update({ mcpPublicUrl: "https://gw.example.ts.net" });
    const r = await tenant.sync();
    expect(r.mcp.status).toBe("unsupported");
  });
});

describe("per-agent MCP endpoint (/plugins/robovoice/agent-mcp)", () => {
  async function serve(invoked: Array<{ agent: string; tool: string }>) {
    const server = http.createServer((req, res) =>
      handleAgentMcpHttp(req, res, store, async () => ({}), (agent) => async (tool) => {
        invoked.push({ agent, tool });
        return { ok: true, result: `ran ${tool} as ${agent}` };
      }),
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/plugins/robovoice/agent-mcp`;
    return { url, close: () => new Promise<void>((r) => server.close(() => r())) };
  }
  const call = (url: string, token: string | null, body: unknown) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });

  it("the token picks the agent, the agent's tools run, gateway is never reachable", async () => {
    store.update({ mcpTools: ["notes", "gateway", "kanban"] });
    const main = store.ensureMcpToken("main");
    const cmo = store.ensureMcpToken("cmo");
    const invoked: Array<{ agent: string; tool: string }> = [];
    const srv = await serve(invoked);
    try {
      expect((await call(srv.url, null, { id: 1, method: "tools/list" })).status).toBe(401);
      expect((await call(srv.url, "rvib_forged", { id: 1, method: "tools/list" })).status).toBe(401);
      expect((await call(`${srv.url}?agent=main`, cmo, { id: 1, method: "tools/list" })).status).toBe(403);
      const list = await (await call(`${srv.url}?agent=main`, main, { id: 1, method: "tools/list" })).json();
      expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(["notes", "kanban"]);
      const denied = await (await call(srv.url, main, { id: 2, method: "tools/call", params: { name: "gateway" } })).json();
      expect(denied.error.code).toBe(-32602);
      const ok = await (await call(srv.url, cmo, { id: 3, method: "tools/call", params: { name: "notes", arguments: {} } })).json();
      expect(ok.result.content[0].text).toBe("ran notes as cmo");
      expect(invoked).toEqual([{ agent: "cmo", tool: "notes" }]);
    } finally {
      await srv.close();
    }
  });

  it("invokes /tools/invoke as the agent's session with the gateway's own credential", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { content: [{ type: "text", text: "done" }] } })));
    const inv = agentToolInvoker("cmo", async () => ({ Authorization: "Bearer gw-secret" }), fetchImpl as unknown as typeof fetch);
    const r = await inv("notes", { q: 1 }, { req: { socket: { localPort: 18999 } } as never });
    expect(r.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:18999/tools/invoke");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer gw-secret");
    expect(JSON.parse(String(init.body))).toEqual({ tool: "notes", args: { q: 1 }, sessionKey: agentSessionKey("cmo") });
    expect(agentSessionKey("cmo")).toBe("agent:cmo:robovoice");
  });
});

describe("calls", () => {
  it("cloud: call link for the agent, watched to the end with credits used", async () => {
    const svc = service();
    await login(svc);
    const call = await svc.startCall("main", { mode: "cloud" });
    const charId = store.get().characterMap.main;
    expect(call).toMatchObject({ mode: "cloud", room: `robopark-${charId}` });
    expect(call.url).toBe(`${mock.url}/call/${charId}?mode=voice&autostart=1&location=${store.get().locationId}`);
    const phases: string[] = [];
    const r = await svc.waitForCall(call, { pollMs: 1, onUpdate: (_s, p) => phases.push(p) });
    expect(r.connected).toBe(true);
    expect(phases).toContain("live");
    expect(r.status.usage).toMatchObject({ billable_seconds: 42, credits_charged: 42 });
    expect(r.status.credits.available_credits).toBe(2450 - 42);
  });

  it("local: start_call (with the character) to the org's online Robovoice Desktop; auto falls back to cloud", async () => {
    await mock.close();
    mock = await startMockRobovoice({ desktops: [{ device_id: "desk-1", name: "Studio PC", hostname: "studio" }] });
    const svc = service({ running: true });
    await login(svc);
    const local = await svc.startCall("main", { mode: "auto" });
    expect(local).toMatchObject({ mode: "local", device: { device_id: "desk-1" }, room: "robopark-desk-1" });
    expect(mock.edge.commands).toEqual([{ device_id: "desk-1", kind: "start_call", character_id: store.get().characterMap.main }]);

    await mock.close();
    mock = await startMockRobovoice({});
    store = new RobovoiceSettingsStore(fs.mkdtempSync(path.join(os.tmpdir(), "rv-link-l-")), {}, undefined, {}, testCipher);
    const noDesk = service({ running: true });
    await login(noDesk);
    await expect(noDesk.startCall("main", { mode: "local" })).rejects.toMatchObject({ status: 409 });
    await expect(noDesk.startCall("main", { mode: "auto" })).resolves.toMatchObject({ mode: "cloud", fellBackToCloud: true });
  });

  it("refuses calls before linking", async () => {
    await expect(service().startCall("main")).rejects.toMatchObject({ code: "not_signed_in" });
  });

  it("the voice provider uses the linked device credentials for the mapped character", async () => {
    const svc = service();
    await login(svc);
    const session = await createRobovoiceProvider(store).createRealtimeSession!({ agentId: "main" });
    expect(session.characterId).toBe(store.get().characterMap.main);
    const req = mock.requests.filter((r) => r.path === "/api/connection-details").at(-1)!;
    expect(req.body).toEqual({ device_id: store.get().deviceId, device_key: store.secrets().deviceKey });
  });
});

describe("robovoice_call tool", () => {
  it("start / status / end / link_status", async () => {
    const svc = service();
    await login(svc);
    const tool = createRobovoiceCallTool(() => svc, { agentId: "main" });
    const start = (await tool.execute("t1", { action: "start", mode: "cloud" })).details as Record<string, unknown>;
    expect(start).toMatchObject({ started: true, agent: "main", mode: "cloud" });
    expect(String(start.url)).toContain("/call/");
    const st = (await tool.execute("t2", { action: "status", room: start.room, since: start.since })).details;
    expect(st).toMatchObject({ live: false, minutes_used: 0 });
    expect(st).not.toHaveProperty("credits_used");
    const end = (await tool.execute("t3", { action: "end", room: start.room })).details;
    expect(end).toMatchObject({ ok: true, ended: true });
    const link = (await tool.execute("t4", { action: "link_status" })).details;
    expect(link).toMatchObject({ linked: true, org: "Mock Org" });
    const bad = (await tool.execute("t5", { action: "status" })).details;
    expect(bad).toMatchObject({ error: expect.stringMatching(/room is required/) });
  });
});

describe("infinibot robovoice CLI", () => {
  async function runCli(argv: string[], svc: RobovoiceLinkService) {
    const program = new Command();
    program.exitOverride();
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    const errors: string[] = [];
    try {
      registerRobovoiceCli({
        program,
        service: () => svc,
        personas: () => PERSONAS,
        logger: { info: () => {}, warn: () => {}, error: (m) => errors.push(m) },
      });
      await program.parseAsync(["node", "infinibot", ...argv]);
    } finally {
      spy.mockRestore();
    }
    return { out: lines.join(""), errors };
  }

  it("login → status → agents → link → call → unlink", async () => {
    const svc = service();
    const login = await runCli(["robovoice", "login", "--api", mock.url, "--no-open"], svc);
    expect(login.errors).toEqual([]);
    expect(login.out).toMatch(/MOCK-[0-9A-F]{4}/);
    expect(login.out).toMatch(/Location\s+InfiniBot · /);
    expect(login.out).toMatch(/Cloud voice\s+free/);
    expect(login.out).not.toMatch(/Credits/);

    const status = await runCli(["robovoice", "status", "--json"], svc);
    expect(JSON.parse(status.out)).toMatchObject({ linked: true, org: { name: "Mock Org" } });

    const link = await runCli(["robovoice", "link", "cmo", "--language", "de"], svc);
    expect(link.out).toMatch(/cmo → Robovoice character ib[0-9a-f]+ at InfiniBot · /);
    const agents = await runCli(["robovoice", "agents"], svc);
    expect(agents.out).toMatch(/● cmo/);
    expect(agents.out).toMatch(/○ archivist/);

    const call = await runCli(["robovoice", "call", "main", "--cloud"], svc);
    expect(call.errors).toEqual([]);
    expect(call.out).toMatch(/\/call\/ib/);
    expect(call.out).toMatch(/Call ended after \d+s · 42 s of conversation \(free\)/);

    const unlink = await runCli(["robovoice", "unlink"], svc);
    expect(unlink.out).toMatch(/retired\. The location stays/);
    const after = await runCli(["robovoice", "status"], svc);
    expect(after.out).toMatch(/unlinked .*location kept/);
  });

  it("reports errors with a non-zero exit code", async () => {
    const prev = process.exitCode;
    const r = await runCli(["robovoice", "call", "main"], service());
    expect(r.errors[0]).toMatch(/Not signed in/);
    expect(process.exitCode).toBe(1);
    process.exitCode = prev;
  });
});

describe("real Robovoice data only: link status cache + credits", () => {
  it("marks Robovoice's last real answer stale (with its age) when Robovoice stops answering; drops it after REMOTE_STALE_MAX_MS", async () => {
    let down = false;
    const fetchImpl: typeof fetch = (input, init) =>
      down ? Promise.reject(new TypeError("The operation was aborted due to timeout")) : fetch(input, init);
    const svc = new RobovoiceLinkService({
      store,
      personas: () => PERSONAS,
      sleep: async () => {},
      env: {},
      fetchImpl,
      detectDesktop: () => ({ installed: false, running: false }),
    });
    await login(svc);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const fresh = await svc.status({ remote: true });
      expect(fresh.remote?.stale).toBe(false);
      const t0 = Date.parse(fresh.remote!.fetchedAt);
      expect(fresh.credits?.available).toBe(true);
      expect(fresh.remoteError).toBeUndefined();

      down = true;
      vi.setSystemTime(t0 + REMOTE_FRESH_MS + 1);
      const stale = await svc.status({ remote: true });
      expect(stale.remoteError).toMatch(/Cannot reach Robovoice.*timeout/);
      expect(stale.remote).toEqual({ fetchedAt: new Date(t0).toISOString(), stale: true });
      expect(stale.credits).toEqual(fresh.credits);

      vi.setSystemTime(t0 + REMOTE_STALE_MAX_MS + 1);
      const gone = await svc.status({ remote: true });
      expect(gone.remoteError).toMatch(/Cannot reach Robovoice/);
      expect(gone.remote).toBeUndefined();
      expect(gone.credits).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("parseCredits reports only what Robovoice sent — no guessed credit price, no made-up zero balance", () => {
    expect(parseCredits({ org: { name: "RoboPark" }, credits: { available_credits: 0, balance_credits: 0, held_credits: 0, credit_usd: 0.001, standard_credits_per_second: 1, low_balance_state: "empty" } })).toMatchObject({
      available: true,
      orgName: "RoboPark",
      availableCredits: 0,
      availableUsd: 0,
      creditUsd: 0.001,
      lowBalance: true,
    });
    // No credit_usd → not available (was: assumed $0.01/credit).
    expect(parseCredits({ credits: { available_credits: 500 } })).toMatchObject({ available: false });
    // No balance → not available (was: 0 credits = "wallet empty").
    expect(parseCredits({ credits: { credit_usd: 0.001 } })).toMatchObject({ available: false });
    // USD-only legacy wallet → no invented credit count.
    expect(parseCredits({ wallet: { available_usd: 4.5 } })).toEqual({ available: false, reason: expect.stringContaining("$4.50") });
    expect(parseCredits({})).toMatchObject({ available: false });
  });
});
