/**
 * Tests for the cross-node forwarding behavior added to `terminal.spawnAgent`.
 *
 * Local-spawn behavior (the existing path) is not exhaustively re-tested here
 * — it's covered by the terminal-manager test suite. These tests focus on the
 * decision tree introduced by the nodeId param:
 *   - local / empty / missing nodeId → spawn locally
 *   - remote nodeId + hub present → forward via forwardGatewayCall
 *   - remote nodeId + no hub → fall back to local spawn (best-effort)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../../terminal/spawn-agent.js", () => ({
  spawnAgentInTerminal: vi.fn(async () => ({ success: true, terminalId: "local-term-xyz" })),
  handleSpawnTerminalExit: vi.fn(),
}));

vi.mock("../../terminal/manager.js", () => ({
  // Must be a real constructable function (not an arrow) because terminal.ts
  // calls `new TerminalManager(...)`.
  TerminalManager: vi.fn(function MockTerminalManager(this: Record<string, unknown>) {
    this.addBeforeDestroyHook = vi.fn();
    this.setBroadcaster = vi.fn();
  }),
}));

vi.mock("../../federation/hub.js", () => ({
  getFederationHub: vi.fn(() => null),
}));

vi.mock("../../federation/hub-forward.js", () => ({
  forwardGatewayCall: vi.fn(async () => ({
    success: true,
    payload: { success: true, terminalId: "remote-term-abc" },
  })),
}));

// Deterministic local-vs-remote: only empty / "local" / blank are local here.
vi.mock("../../federation/local-node.js", () => ({
  isLocalNodeId: (id: unknown) => {
    const s = (typeof id === "string" ? id : "").trim();
    return s === "" || s === "local";
  },
}));

vi.mock("../../federation/spawn-idempotency.js", () => ({
  getIdempotentResult: vi.fn(() => undefined),
  recordIdempotentResult: vi.fn(),
}));

import { spawnAgentInTerminal } from "../../terminal/spawn-agent.js";
import { getFederationHub } from "../../federation/hub.js";
import { forwardGatewayCall } from "../../federation/hub-forward.js";
import { terminalHandlers, initializeTerminalManager } from "./terminal.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeOpts(params: Record<string, unknown>) {
  const respond = vi.fn();
  // The handler only touches params + respond; everything else can be the
  // minimum shape vitest will tolerate.
  return {
    req: {} as never,
    params,
    client: null,
    isWebchatConnect: () => false,
    respond,
    context: {} as never,
  };
}

beforeEach(() => {
  vi.mocked(spawnAgentInTerminal).mockClear();
  vi.mocked(getFederationHub).mockReset();
  vi.mocked(getFederationHub).mockReturnValue(null);
  vi.mocked(forwardGatewayCall).mockClear();
  // Ensure the terminal manager singleton is initialized so the local-spawn
  // path doesn't short-circuit to INTERNAL_ERROR.
  initializeTerminalManager();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("terminal.spawnAgent nodeId routing", () => {
  const handler = terminalHandlers["terminal.spawnAgent"];

  it("rejects invalid CLI before doing any routing work", async () => {
    const opts = makeOpts({ cli: "bogus", nodeId: "sat-1" });
    await handler(opts);
    expect(opts.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_PARAMS" }),
    );
    expect(forwardGatewayCall).not.toHaveBeenCalled();
    expect(spawnAgentInTerminal).not.toHaveBeenCalled();
  });

  it("spawns locally when nodeId is omitted", async () => {
    const opts = makeOpts({ cli: "claude", task: "do a thing" });
    await handler(opts);
    expect(spawnAgentInTerminal).toHaveBeenCalledOnce();
    expect(forwardGatewayCall).not.toHaveBeenCalled();
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ terminalId: "local-term-xyz" }),
    );
  });

  it("passes CLI options through to local spawns", async () => {
    const opts = makeOpts({
      cli: "codex",
      task: "research",
      options: { extraFlags: ["--search"] },
    });
    await handler(opts);

    expect(spawnAgentInTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        cli: "codex",
        task: "research",
        options: { extraFlags: ["--search"] },
      }),
    );
  });

  it("spawns locally when nodeId is 'local'", async () => {
    const opts = makeOpts({ cli: "claude", nodeId: "local" });
    await handler(opts);
    expect(spawnAgentInTerminal).toHaveBeenCalledOnce();
    expect(forwardGatewayCall).not.toHaveBeenCalled();
  });

  it("spawns locally when nodeId is an empty/whitespace string", async () => {
    const opts = makeOpts({ cli: "claude", nodeId: "   " });
    await handler(opts);
    expect(spawnAgentInTerminal).toHaveBeenCalledOnce();
    expect(forwardGatewayCall).not.toHaveBeenCalled();
  });

  it("forwards to the remote node when nodeId is non-local and hub is present", async () => {
    vi.mocked(getFederationHub).mockReturnValue({} as ReturnType<typeof getFederationHub>);
    const opts = makeOpts({
      cli: "claude",
      cwd: "/repo",
      task: "audit federation",
      nodeId: "sat-42",
      runId: "rid-1",
      sessionKey: "skey-1",
      agentId: "coder",
    });
    await handler(opts);

    expect(forwardGatewayCall).toHaveBeenCalledOnce();
    const [nodeId, method, forwardedParams] = vi.mocked(forwardGatewayCall).mock.calls[0];
    expect(nodeId).toBe("sat-42");
    expect(method).toBe("terminal.spawnAgent");
    // The forwarded params must NOT include nodeId (otherwise the remote
    // would try to re-forward).
    expect(forwardedParams).not.toHaveProperty("nodeId");
    expect(forwardedParams).toMatchObject({
      cli: "claude",
      cwd: "/repo",
      task: "audit federation",
      runId: "rid-1",
      sessionKey: "skey-1",
      agentId: "coder",
    });

    expect(spawnAgentInTerminal).not.toHaveBeenCalled();
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ terminalId: "remote-term-abc", nodeId: "sat-42" }),
    );
  });

  it("surfaces forward errors with the right code", async () => {
    vi.mocked(getFederationHub).mockReturnValue({} as ReturnType<typeof getFederationHub>);
    vi.mocked(forwardGatewayCall).mockResolvedValueOnce({
      success: false,
      code: "INVOKE_FAILED",
      error: "satellite not connected",
    });

    const opts = makeOpts({ cli: "claude", nodeId: "sat-down" });
    await handler(opts);

    expect(spawnAgentInTerminal).not.toHaveBeenCalled();
    expect(opts.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVOKE_FAILED", message: "satellite not connected" }),
    );
  });

  it("falls back to local spawn only when routing reports NOT_FEDERATED", async () => {
    // Standalone install (no hub + no satellite): the forwarder returns
    // NOT_FEDERATED and we spawn locally rather than 500ing. Any other failure
    // surfaces (see the previous test) so we never launch on the wrong node.
    vi.mocked(getFederationHub).mockReturnValue(null);
    vi.mocked(forwardGatewayCall).mockResolvedValueOnce({
      success: false,
      code: "NOT_FEDERATED",
      error: "no hub or satellite",
    });

    const opts = makeOpts({ cli: "claude", nodeId: "sat-1" });
    await handler(opts);

    // The forwarder IS consulted; it reports routing is impossible, then we
    // fall through to a local spawn.
    expect(forwardGatewayCall).toHaveBeenCalledOnce();
    expect(spawnAgentInTerminal).toHaveBeenCalledOnce();
  });
});
