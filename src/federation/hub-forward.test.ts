/**
 * Tests for the cross-node gateway-call forwarding helper.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("./hub.js", () => ({
  getFederationHub: vi.fn(() => null),
}));

import { getFederationHub } from "./hub.js";
import {
  forwardGatewayCallToNode,
  forwardGatewayCallToNodeStreamed,
  registerStreamListener,
  unregisterStreamListener,
  pushStreamChunk,
  pushStreamError,
} from "./hub-forward.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMockHub(invokeImpl: (...args: unknown[]) => Promise<unknown>) {
  return {
    invokeOnNode: vi.fn(invokeImpl as never),
  };
}

beforeEach(() => {
  vi.mocked(getFederationHub).mockReset();
  vi.mocked(getFederationHub).mockReturnValue(null);
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("forwardGatewayCallToNode", () => {
  it("returns NOT_MASTER when no hub is configured", async () => {
    const result = await forwardGatewayCallToNode("sat-1", "terminal.spawnAgent", {
      cli: "claude",
    });
    expect(result.success).toBe(false);
    expect(result.code).toBe("NOT_MASTER");
  });

  it("calls invokeOnNode with gateway.proxy.invoke envelope", async () => {
    const hub = makeMockHub(async () => ({
      success: true,
      reply: JSON.stringify({ success: true, terminalId: "term-123" }),
    }));
    vi.mocked(getFederationHub).mockReturnValue(
      hub as unknown as ReturnType<typeof getFederationHub>,
    );

    const result = await forwardGatewayCallToNode<{ success: boolean; terminalId: string }>(
      "sat-1",
      "terminal.spawnAgent",
      { cli: "claude", cwd: "." },
    );

    expect(hub.invokeOnNode).toHaveBeenCalledWith(
      "sat-1",
      "gateway.proxy.invoke",
      { method: "terminal.spawnAgent", params: { cli: "claude", cwd: "." } },
      30_000,
    );
    expect(result.success).toBe(true);
    expect(result.payload).toEqual({ success: true, terminalId: "term-123" });
  });

  it("surfaces invoke failures as INVOKE_FAILED", async () => {
    const hub = makeMockHub(async () => ({
      success: false,
      error: "node not connected",
    }));
    vi.mocked(getFederationHub).mockReturnValue(
      hub as unknown as ReturnType<typeof getFederationHub>,
    );

    const result = await forwardGatewayCallToNode("sat-1", "terminal.spawnAgent", {});
    expect(result.success).toBe(false);
    expect(result.code).toBe("INVOKE_FAILED");
    expect(result.error).toBe("node not connected");
  });

  it("catches thrown invoke errors as INVOKE_THREW", async () => {
    const hub = makeMockHub(async () => {
      throw new Error("network died");
    });
    vi.mocked(getFederationHub).mockReturnValue(
      hub as unknown as ReturnType<typeof getFederationHub>,
    );

    const result = await forwardGatewayCallToNode("sat-1", "terminal.spawnAgent", {});
    expect(result.success).toBe(false);
    expect(result.code).toBe("INVOKE_THREW");
    expect(result.error).toBe("network died");
  });

  it("returns raw string when reply is not JSON-parseable", async () => {
    const hub = makeMockHub(async () => ({
      success: true,
      reply: "not-json-just-a-string",
    }));
    vi.mocked(getFederationHub).mockReturnValue(
      hub as unknown as ReturnType<typeof getFederationHub>,
    );

    const result = await forwardGatewayCallToNode("sat-1", "some.method", {});
    expect(result.success).toBe(true);
    expect(result.payload).toBe("not-json-just-a-string");
  });

  it("respects custom timeoutMs", async () => {
    const hub = makeMockHub(async () => ({ success: true, reply: "{}" }));
    vi.mocked(getFederationHub).mockReturnValue(
      hub as unknown as ReturnType<typeof getFederationHub>,
    );

    await forwardGatewayCallToNode("sat-1", "x", {}, 5_000);
    expect(hub.invokeOnNode).toHaveBeenCalledWith(
      "sat-1",
      "gateway.proxy.invoke",
      { method: "x", params: {} },
      5_000,
    );
  });
});

describe("forwardGatewayCallToNodeStreamed", () => {
  it("throws when no hub is configured", async () => {
    await expect(async () => {
      for await (const _ of forwardGatewayCallToNodeStreamed("sat-1", "x", {})) {
        // drain
      }
    }).rejects.toThrow("forwardGatewayCallToNodeStreamed requires a federation master hub");
  });

  it("throws when initial invoke fails", async () => {
    const hub = makeMockHub(async () => ({
      success: false,
      error: "node not connected",
    }));
    vi.mocked(getFederationHub).mockReturnValue(
      hub as unknown as ReturnType<typeof getFederationHub>,
    );

    await expect(async () => {
      for await (const _ of forwardGatewayCallToNodeStreamed("sat-1", "x", {})) {
        // drain
      }
    }).rejects.toThrow("node not connected");
  });

  it("yields chunks pushed via pushStreamChunk", async () => {
    const hub = makeMockHub(async () => ({
      success: true,
      reply: "",
    }));
    vi.mocked(getFederationHub).mockReturnValue(
      hub as unknown as ReturnType<typeof getFederationHub>,
    );

    const chunks: Array<{ index: number; payload: unknown; done: boolean }> = [];
    const iter = forwardGatewayCallToNodeStreamed("sat-1", "x", {});

    // We need to push chunks after the initial invoke resolves.
    // Run the iterator in a microtask and push from outside.
    const collectPromise = (async () => {
      for await (const chunk of iter) {
        chunks.push(chunk);
      }
    })();

    // Give the iterator a tick to start and resolve the initial invoke
    await new Promise((r) => setTimeout(r, 10));

    // Find the correlationId that was registered — the invoke call will have it
    const invokeCall = hub.invokeOnNode.mock.calls[0];
    const params = invokeCall[2] as Record<string, unknown>;
    const correlationId = params.correlationId as string;

    // Push two chunks
    pushStreamChunk(correlationId, { index: 0, payload: { data: "chunk-0" }, done: false });
    pushStreamChunk(correlationId, { index: 1, payload: { data: "chunk-1" }, done: true });

    await collectPromise;

    expect(chunks).toHaveLength(2);
    expect(chunks[0].payload).toEqual({ data: "chunk-0" });
    expect(chunks[0].done).toBe(false);
    expect(chunks[1].payload).toEqual({ data: "chunk-1" });
    expect(chunks[1].done).toBe(true);
  });

  it("propagates errors from pushStreamError", async () => {
    const hub = makeMockHub(async () => ({
      success: true,
      reply: "",
    }));
    vi.mocked(getFederationHub).mockReturnValue(
      hub as unknown as ReturnType<typeof getFederationHub>,
    );

    const iter = forwardGatewayCallToNodeStreamed("sat-1", "x", {});

    const collectPromise = (async () => {
      const chunks: unknown[] = [];
      try {
        for await (const chunk of iter) {
          chunks.push(chunk);
        }
      } catch (err) {
        return { error: (err as Error).message, chunks };
      }
      return { error: null, chunks };
    })();

    await new Promise((r) => setTimeout(r, 10));

    const invokeCall = hub.invokeOnNode.mock.calls[0];
    const params = invokeCall[2] as Record<string, unknown>;
    const correlationId = params.correlationId as string;

    pushStreamError(correlationId, new Error("remote stream error"));

    const result = await collectPromise;
    expect(result.error).toBe("remote stream error");
  });
});

describe("stream listener registry", () => {
  it("registerStreamListener and pushStreamChunk round-trip", () => {
    const received: unknown[] = [];
    registerStreamListener("test-corr-1", {
      push(chunk) {
        received.push(chunk);
      },
      throwError() {},
    });

    const ok = pushStreamChunk("test-corr-1", { index: 0, payload: "hello", done: false });
    expect(ok).toBe(true);
    expect(received).toHaveLength(1);

    unregisterStreamListener("test-corr-1");

    const ok2 = pushStreamChunk("test-corr-1", { index: 1, payload: "gone", done: true });
    expect(ok2).toBe(false);
    // No new entry because listener was removed
    expect(received).toHaveLength(1);
  });

  it("pushStreamError returns false for unknown correlationId", () => {
    const ok = pushStreamError("nonexistent", new Error("nope"));
    expect(ok).toBe(false);
  });
});
