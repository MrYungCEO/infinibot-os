import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock gateway broadcaster singleton so tests control in-process vs external path.
let broadcasterFn: ((event: string, payload: unknown) => void) | null = null;
vi.mock("../coder-runtime/subagent-broadcast.js", () => ({
  getGatewayBroadcaster: () => broadcasterFn,
  onGatewayBroadcasterReady: (_cb: unknown) => {
    /* no-op in tests */
  },
}));

// Mock callGatewayTool — captures what the external-process path would send.
const callGatewayMock = vi.fn();
vi.mock("./gateway.js", () => ({
  callGatewayTool: (...args: unknown[]) => callGatewayMock(...args),
}));

import { createProactiveTool } from "./proactive-tool.js";
import { closePopupStore } from "../../proactive/popup-store.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "proactive-test-"));
  closePopupStore(); // reset singleton so each test gets a fresh DB in tmpDir
  callGatewayMock.mockReset();
  callGatewayMock.mockResolvedValue({ event: { id: "gw-event-1", tier: "NOTABLE" }, routing: {} });
  broadcasterFn = null;
});

afterEach(() => {
  closePopupStore();
  rmSync(tmpDir, { recursive: true, force: true });
});

// Override resolveStateDir + STATE_DIR so the tool uses our tmp dir.
// Spread real module so other exports (resolveConfigPath, etc.) stay intact.
vi.mock("../../config/paths.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../config/paths.js");
  const mod: Record<string, unknown> = {
    ...actual,
    resolveStateDir: () => tmpDir,
  };
  Object.defineProperty(mod, "STATE_DIR", {
    get: () => tmpDir,
    enumerable: true,
    configurable: true,
  });
  return mod;
});

describe("proactive tool — emit (in-process path)", () => {
  beforeEach(() => {
    // Simulate gateway context: broadcaster is wired.
    const received: Array<{ event: string; payload: unknown }> = [];
    broadcasterFn = (event, payload) => received.push({ event, payload });
  });

  it("returns event + routing on valid emit", async () => {
    const tool = createProactiveTool({ agentId: "test-agent" });
    const result = await tool.execute("c1", {
      action: "emit",
      tier: "NOTABLE",
      title: "Hello world",
    });
    expect(result.details).toMatchObject({ status: "ok" });
    const out = result.details as Record<string, unknown>;
    expect(out.event).toBeTruthy();
    const ev = out.event as Record<string, unknown>;
    expect(ev.title).toBe("Hello world");
    // requestedTier reflects what was asked for; appliedTier may differ due to quiet-hours.
    expect(ev.requestedTier).toBe("NOTABLE");
    expect(out.routing).toBeTruthy();
  });

  it("auto-generates dedupKey when omitted", async () => {
    const tool = createProactiveTool({ agentId: "test-agent" });
    const r1 = await tool.execute("c1", {
      action: "emit",
      tier: "FYI",
      title: "Dedup test",
      body: "body",
    });
    const r2 = await tool.execute("c2", {
      action: "emit",
      tier: "FYI",
      title: "Dedup test",
      body: "body",
    });
    const ev1 = (r1.details as Record<string, unknown>).event as Record<string, unknown>;
    const ev2 = (r2.details as Record<string, unknown>).event as Record<string, unknown>;
    // Both should have the same dedup key (same minute bucket).
    expect(ev1.dedupKey).toBe(ev2.dedupKey);
  });

  it("returns INVALID_PARAMS when title is missing", async () => {
    const tool = createProactiveTool({ agentId: "test-agent" });
    const result = await tool.execute("c1", { action: "emit", tier: "NOTABLE" });
    const out = result.details as Record<string, unknown>;
    expect(out.status).toBe("error");
    expect(out.code).toBe("INVALID_PARAMS");
  });

  it("does NOT call callGatewayTool when broadcaster is wired", async () => {
    const tool = createProactiveTool({ agentId: "test-agent" });
    await tool.execute("c1", { action: "emit", tier: "NOTABLE", title: "Test" });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });
});

// The tool is registered server-side and always emits in-process. With no
// broadcaster wired yet the event is persisted and queued for flush-on-ready
// (src/proactive/emit.ts) — there is no gateway WS fallback.
describe("proactive tool — emit (broadcaster not wired yet)", () => {
  it("still emits in-process and never falls back to callGatewayTool", async () => {
    broadcasterFn = null;
    const tool = createProactiveTool({ agentId: "test-agent" });
    const result = await tool.execute("c1", {
      action: "emit",
      tier: "NOTABLE",
      title: "From MCP stdio",
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
    const out = result.details as Record<string, unknown>;
    expect(out.status).toBe("ok");
    expect(out.event).toMatchObject({ tier: "NOTABLE", title: "From MCP stdio" });
  });

  it("records the attribution agentId on the emitted event", async () => {
    broadcasterFn = null;
    const tool = createProactiveTool({ agentId: "voice-orchestrator" });
    const result = await tool.execute("c1", {
      action: "emit",
      tier: "FYI",
      title: "Voice check-in",
    });
    const event = (result.details as { event: { attribution: Record<string, unknown> } }).event;
    expect(event.attribution.agentId).toBe("voice-orchestrator");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });
});

describe("proactive tool — dedup coalescing", () => {
  it("two emits with the same dedupKey produce the same key on the events", async () => {
    broadcasterFn = (e, p) => void p; // in-process path
    const tool = createProactiveTool({ agentId: "test-agent" });
    const key = "my-static-dedup";
    const r1 = await tool.execute("c1", {
      action: "emit",
      tier: "FYI",
      title: "T1",
      dedupKey: key,
    });
    const r2 = await tool.execute("c2", {
      action: "emit",
      tier: "FYI",
      title: "T2",
      dedupKey: key,
    });
    const e1 = (r1.details as Record<string, unknown>).event as Record<string, unknown>;
    const e2 = (r2.details as Record<string, unknown>).event as Record<string, unknown>;
    expect(e1.dedupKey).toBe(key);
    expect(e2.dedupKey).toBe(key);
  });
});

describe("proactive tool — list", () => {
  it("returns empty list when no events", async () => {
    const tool = createProactiveTool({ agentId: "test-agent" });
    const result = await tool.execute("c1", { action: "list" });
    const out = result.details as Record<string, unknown>;
    expect(out.status).toBe("ok");
    expect(out.count).toBe(0);
    expect(Array.isArray(out.events)).toBe(true);
  });

  it("returns events inserted via emit", async () => {
    broadcasterFn = () => void 0;
    const tool = createProactiveTool({ agentId: "test-agent" });
    await tool.execute("c1", { action: "emit", tier: "NOTABLE", title: "List test" });
    const result = await tool.execute("c2", { action: "list" });
    const out = result.details as Record<string, unknown>;
    expect(out.count).toBeGreaterThan(0);
  });
});

describe("proactive tool — ack / snooze / dismiss", () => {
  beforeEach(() => {
    // Use in-process path so emit inserts into local DB (needed for ack/snooze/dismiss to find events).
    broadcasterFn = () => void 0;
  });

  it("returns error for unknown event id", async () => {
    const tool = createProactiveTool({ agentId: "test-agent" });
    const result = await tool.execute("c1", { action: "ack", id: "no-such-id" });
    const out = result.details as Record<string, unknown>;
    expect(out.status).toBe("error");
    const hasNotFound =
      out.code === "NOT_FOUND" ||
      (typeof out.message === "string" && out.message.toLowerCase().includes("not found"));
    expect(hasNotFound).toBe(true);
  });

  it("acks an emitted event", async () => {
    const tool = createProactiveTool({ agentId: "test-agent" });
    const emitR = await tool.execute("c1", { action: "emit", tier: "NOTABLE", title: "Ack me" });
    const ev = (emitR.details as Record<string, unknown>).event as Record<string, unknown>;
    const ackR = await tool.execute("c2", { action: "ack", id: ev.id as string });
    const ackOut = ackR.details as Record<string, unknown>;
    expect(ackOut.status).toBe("ok");
    expect((ackOut.event as Record<string, unknown>).state).toBe("acted");
  });

  it("requires id for ack", async () => {
    const tool = createProactiveTool({ agentId: "test-agent" });
    const result = await tool.execute("c1", { action: "ack" });
    const out = result.details as Record<string, unknown>;
    expect(out.status).toBe("error");
  });

  it("snoozes an event", async () => {
    const tool = createProactiveTool({ agentId: "test-agent" });
    const emitR = await tool.execute("c1", { action: "emit", tier: "FYI", title: "Snooze me" });
    const ev = (emitR.details as Record<string, unknown>).event as Record<string, unknown>;
    const snoozR = await tool.execute("c2", {
      action: "snooze",
      id: ev.id as string,
      duration: "30m",
    });
    const out = snoozR.details as Record<string, unknown>;
    expect(out.status).toBe("ok");
    expect((out.event as Record<string, unknown>).state).toBe("snoozed");
  });

  it("dismisses an event", async () => {
    const tool = createProactiveTool({ agentId: "test-agent" });
    const emitR = await tool.execute("c1", {
      action: "emit",
      tier: "NOTABLE",
      title: "Dismiss me",
    });
    const ev = (emitR.details as Record<string, unknown>).event as Record<string, unknown>;
    const dismissR = await tool.execute("c2", {
      action: "dismiss",
      id: ev.id as string,
      reason: "done",
    });
    const out = dismissR.details as Record<string, unknown>;
    expect(out.status).toBe("ok");
    expect((out.event as Record<string, unknown>).state).toBe("dismissed");
  });
});
