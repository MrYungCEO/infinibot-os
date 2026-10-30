/**
 * Tests for the proactive MCP tool (src/agents/tools/proactive-tool.ts).
 *
 * Uses INFINIBOT_STATE_DIR env var to point all state to an isolated tmp dir.
 * The gateway broadcaster is not wired; events persist to SQLite and return ok.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Stub the broadcaster so emitProactiveServerSide never tries to contact gateway.
// Path is relative to THIS FILE: src/proactive/proactive-tool.test.ts
// → ../agents/coder-runtime/subagent-broadcast.js = src/agents/coder-runtime/subagent-broadcast.js ✓
vi.mock("../agents/coder-runtime/subagent-broadcast.js", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../agents/coder-runtime/subagent-broadcast.js")>();
  return {
    ...real,
    getGatewayBroadcaster: () => null,
    onGatewayBroadcasterReady: (_cb: unknown) => {
      /* no-op in tests */
    },
  };
});

import { createProactiveTool } from "../agents/tools/proactive-tool.js";
import { closePopupStore } from "./popup-store.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Unique key that can never collide across test runs. */
function uniqueKey(tag: string): string {
  return `test:${tag}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

let tmpDir = "";

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "proactive-test-"));
  // Point resolveStateDir() at our isolated tmpDir.
  process.env.INFINIBOT_STATE_DIR = tmpDir;
  // Close any existing singleton so the next call creates a fresh store at tmpDir.
  closePopupStore();
});

afterAll(() => {
  closePopupStore();
  delete process.env.INFINIBOT_STATE_DIR;
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("proactive MCP tool", () => {
  it("emit returns event + routing for a valid NOTABLE pop", async () => {
    const tool = createProactiveTool({ agentId: "test-agent" });
    const result = await tool.execute("call_1", {
      action: "emit",
      tier: "NOTABLE",
      title: "Deploy complete",
      body: "main pushed to prod",
      agentId: "test-agent",
      dedupKey: uniqueKey("notable-1"),
    });

    const data = result.details as Record<string, unknown>;
    expect(data.status).toBe("ok");
    const event = data.event as Record<string, unknown>;
    expect(event).toBeDefined();
    expect(event.title).toBe("Deploy complete");
    expect(event.id).toBeTruthy();
    const routing = data.routing as Record<string, unknown>;
    expect(routing).toBeDefined();
    expect(routing.requestedTier).toBe("NOTABLE");
  });

  it("auto-derives dedupKey: two identical calls within the same minute share the same key", async () => {
    const tool = createProactiveTool({ agentId: "test-agent" });

    const r1 = await tool.execute("call_2a", {
      action: "emit",
      tier: "FYI",
      title: "Heartbeat",
      body: "all good",
      agentId: "test-agent",
    });
    const r2 = await tool.execute("call_2b", {
      action: "emit",
      tier: "FYI",
      title: "Heartbeat",
      body: "all good",
      agentId: "test-agent",
    });

    const e1 = (r1.details as Record<string, unknown>).event as Record<string, unknown>;
    const e2 = (r2.details as Record<string, unknown>).event as Record<string, unknown>;
    expect(e1.dedupKey).toBe(e2.dedupKey);
  });

  it("missing title returns INVALID_PARAMS error", async () => {
    const tool = createProactiveTool({ agentId: "test-agent" });
    const result = await tool.execute("call_3", {
      action: "emit",
      tier: "NOTABLE",
      agentId: "test-agent",
      // title deliberately omitted
    });

    const data = result.details as Record<string, unknown>;
    expect(data.status).toBe("error");
    expect(data.code).toBe("INVALID_PARAMS");
  });

  it("invalid tier returns INVALID_TIER error", async () => {
    const tool = createProactiveTool({ agentId: "test-agent" });
    const result = await tool.execute("call_4", {
      action: "emit",
      tier: "URGENT", // not a valid tier
      title: "Something",
      agentId: "test-agent",
    });

    const data = result.details as Record<string, unknown>;
    expect(data.status).toBe("error");
    expect(data.code).toBe("INVALID_TIER");
  });

  it("list returns events array including the one just emitted", async () => {
    const tool = createProactiveTool({ agentId: "list-agent" });
    const dedupKey = uniqueKey("list-5");

    const emitResult = await tool.execute("call_5a", {
      action: "emit",
      tier: "FYI",
      title: "List test event",
      agentId: "list-agent",
      dedupKey,
    });
    expect((emitResult.details as Record<string, unknown>).status).toBe("ok");

    const result = await tool.execute("call_5b", { action: "list", limit: 100 });

    const data = result.details as Record<string, unknown>;
    expect(data.status).toBe("ok");
    const events = data.events as Array<Record<string, unknown>>;
    expect(Array.isArray(events)).toBe(true);
    const found = events.find((e) => e.dedupKey === dedupKey);
    expect(found).toBeDefined();
  });

  it("ack transitions event to acted state", async () => {
    const tool = createProactiveTool({ agentId: "ack-agent" });

    const emitResult = await tool.execute("call_6a", {
      action: "emit",
      tier: "FYI",
      title: "Ack me",
      agentId: "ack-agent",
      dedupKey: uniqueKey("ack-6"),
    });
    const emitData = emitResult.details as Record<string, unknown>;
    expect(emitData.status).toBe("ok");
    const eventId = (emitData.event as Record<string, unknown>).id as string;

    const ackResult = await tool.execute("call_6b", {
      action: "ack",
      id: eventId,
      actionId: "ok",
    });

    const data = ackResult.details as Record<string, unknown>;
    expect(data.status).toBe("ok");
    const event = data.event as Record<string, unknown>;
    expect(event.state).toBe("acted");
    expect(event.ackAction).toBe("ok");
  });

  it("dismiss transitions event to dismissed state", async () => {
    const tool = createProactiveTool({ agentId: "dismiss-agent" });

    const emitResult = await tool.execute("call_7a", {
      action: "emit",
      tier: "FYI",
      title: "Dismiss me",
      agentId: "dismiss-agent",
      dedupKey: uniqueKey("dismiss-7"),
    });
    const emitData = emitResult.details as Record<string, unknown>;
    expect(emitData.status).toBe("ok");
    const eventId = (emitData.event as Record<string, unknown>).id as string;

    const dismissResult = await tool.execute("call_7b", {
      action: "dismiss",
      id: eventId,
      reason: "not relevant",
    });

    const data = dismissResult.details as Record<string, unknown>;
    expect(data.status).toBe("ok");
    const event = data.event as Record<string, unknown>;
    expect(event.state).toBe("dismissed");
    expect(event.dismissReason).toBe("not relevant");
  });
});
