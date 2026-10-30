import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
// @ts-ignore: plain ESM test helpers.
import { makeStubRoot, pairedState, silentLog, startRelayStub, waitFor, writeState } from "./relay-link.test.helpers.mjs";

type Respond = (ok: boolean, payload?: any, error?: { code: string; message: string }) => void;
type Method = (ctx: { params?: Record<string, unknown>; respond: Respond }) => unknown;

const saved = {
  stateDir: process.env.INFINIBOT_STATE_DIR,
  root: process.env.INFINIBOT_ROOT,
  skip: process.env.KV_RELAY_SKIP_CLAUDE_MCP,
};
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kvr-plugin-"));
const relayDir = path.join(stateDir, "kinglyvault-relay");
const log = silentLog();
const methods = new Map<string, Method>();
const services: Array<{ start: () => Promise<void>; stop: () => Promise<void> }> = [];

const call = (name: string) =>
  new Promise<{ ok: boolean; payload?: any; error?: { code: string; message: string } }>((resolve) => {
    void methods.get(name)!({ params: {}, respond: (ok, payload, error) => resolve({ ok, payload, error }) });
  });

let relay: Awaited<ReturnType<typeof startRelayStub>>;

beforeAll(async () => {
  process.env.INFINIBOT_STATE_DIR = stateDir;
  process.env.INFINIBOT_ROOT = makeStubRoot();
  process.env.KV_RELAY_SKIP_CLAUDE_MCP = "1";
  const { default: plugin } = await import("./index.js");
  plugin.register({
    pluginConfig: { relayUrl: "http://127.0.0.1:9/unused" },
    config: {},
    logger: log,
    registerService: (s: (typeof services)[number]) => services.push(s),
    registerHttpRoute: () => {},
    registerGatewayMethod: (name: string, fn: Method) => methods.set(name, fn),
    registerCli: () => {},
    registerTool: () => {},
  } as never);
});

afterAll(() => {
  process.env.INFINIBOT_STATE_DIR = saved.stateDir;
  process.env.INFINIBOT_ROOT = saved.root;
  process.env.KV_RELAY_SKIP_CLAUDE_MCP = saved.skip;
});

beforeEach(async () => {
  relay = await startRelayStub();
  fs.rmSync(relayDir, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(services.map((s) => s.stop()));
  await relay.close();
});

describe("kvconnect.restart", () => {
  test("refuses when there is no link", async () => {
    await services[0].start();
    const r = await call("kvconnect.restart");
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("NOT_FOUND");
  });

  test("reconnects a running link without restarting anything else", async () => {
    writeState(pairedState(relay.url));
    await services[0].start();
    await waitFor(() => relay.pulls().length >= 1, { timeoutMs: 8000, label: "first pull" });
    const r = await call("kvconnect.restart");
    expect(r.ok).toBe(true);
    expect(r.payload.link.running).toBe(true);
    const seen = relay.pulls().length;
    await waitFor(() => relay.pulls().length > seen + 3, { timeoutMs: 8000, label: "pulls after reconnect" });
    expect(log.lines.join("\n")).toContain("reconnecting on request");
    expect((await call("kvconnect.status")).payload.health.online).toBe(true);
  });

  test("starts a link that is not running", async () => {
    await services[0].start();
    writeState(pairedState(relay.url));
    expect((await call("kvconnect.status")).payload.link.running).toBe(false);
    const r = await call("kvconnect.restart");
    expect(r.ok).toBe(true);
    expect(r.payload.link.running).toBe(true);
    await waitFor(() => relay.pulls().length >= 1, { timeoutMs: 8000, label: "pull" });
  });

  test("says so when another process holds the link", async () => {
    await services[0].start();
    writeState(pairedState(relay.url));
    fs.writeFileSync(path.join(relayDir, "link.lock"), JSON.stringify({ pid: process.ppid }));
    const r = await call("kvconnect.restart");
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("UNAVAILABLE");
    expect(r.error?.message).toContain(String(process.ppid));
  });
});

describe("kvconnect.status", () => {
  test("a link that stopped reporting is offline with a way out, whatever health.json last said", async () => {
    await services[0].start();
    writeState(pairedState(relay.url));
    fs.writeFileSync(path.join(relayDir, "link.lock"), JSON.stringify({ pid: process.ppid }));
    const lastSyncAt = new Date(Date.now() - 10 * 60_000).toISOString();
    fs.writeFileSync(path.join(relayDir, "health.json"), JSON.stringify({ ok: true, lastSyncAt, error: null }));
    const { health } = (await call("kvconnect.status")).payload;
    expect(health.online).toBe(false);
    expect(health.error).toMatch(/Reconnect/);
  });
});
