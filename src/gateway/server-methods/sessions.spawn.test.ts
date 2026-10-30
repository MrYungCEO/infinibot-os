/**
 * Tests for the cross-node nodeId routing added to `sessions.spawn`.
 *
 * Mirrors the structure of terminal.spawnAgent.test.ts. Three cases that
 * matter for the federation path:
 *   - Empty / "local" / current node nodeId → existing local-spawn path runs
 *   - Remote nodeId + hub present → call is forwarded via
 *     forwardGatewayCall, remote response is tagged with `remote:true`
 *     and the run is recorded in the remote-session registry
 *   - Remote nodeId + no hub → falls back to local spawn (best-effort)
 *
 * Local-spawn behavior is exhaustively covered elsewhere; we just confirm the
 * gateway routes correctly and registers remote runs for the activity feed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../../config/config.js", () => ({
  loadConfig: vi.fn(() => ({})),
}));

vi.mock("../../federation/hub.js", () => ({
  getFederationHub: vi.fn(() => null),
}));

vi.mock("../../federation/hub-forward.js", () => ({
  forwardGatewayCall: vi.fn(async () => ({
    success: true,
    payload: {
      status: "accepted",
      childSessionKey: "agent:coder:subagent:remote-uuid",
      runId: "remote-run-id",
      executionMode: "terminal",
      terminalId: "remote-term-id",
    },
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

vi.mock("../../federation/remote-session-registry.js", () => ({
  registerRemoteSession: vi.fn(),
  listRemoteSessions: vi.fn(() => []),
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: vi.fn(async () => ({
    runId: "local-run-id",
    success: true,
    terminalId: "local-term-id",
  })),
}));

vi.mock("../../agents/subagent-registry.js", () => ({
  registerSubagentRun: vi.fn(),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentConfig: vi.fn(() => ({})),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp"),
}));

vi.mock("../../agents/subagent-announce.js", () => ({
  buildSubagentSystemPrompt: vi.fn(() => "system"),
}));

vi.mock("../../auto-reply/reply/abort.js", () => ({
  stopSubagentsForRequester: vi.fn(),
}));

vi.mock("../../auto-reply/reply/queue.js", () => ({
  clearSessionQueues: vi.fn(),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn(),
  waitForEmbeddedPiRunEnd: vi.fn(),
}));

import { getFederationHub } from "../../federation/hub.js";
import { forwardGatewayCall } from "../../federation/hub-forward.js";
import { registerRemoteSession } from "../../federation/remote-session-registry.js";
import { sessionsHandlers } from "./sessions.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeOpts(params: Record<string, unknown>) {
  const respond = vi.fn();
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
  vi.mocked(getFederationHub).mockReset();
  vi.mocked(getFederationHub).mockReturnValue(null);
  vi.mocked(forwardGatewayCall).mockClear();
  vi.mocked(registerRemoteSession).mockClear();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("sessions.spawn nodeId routing", () => {
  const handler = sessionsHandlers["sessions.spawn"];

  it("forwards to the remote node when nodeId is supplied and hub is present", async () => {
    vi.mocked(getFederationHub).mockReturnValue({} as ReturnType<typeof getFederationHub>);

    const opts = makeOpts({
      task: "audit federation",
      agentId: "coder",
      label: "Audit",
      nodeId: "sat-42",
      runTimeoutSeconds: 120,
    });
    await handler(opts);

    expect(forwardGatewayCall).toHaveBeenCalledOnce();
    const [nodeId, method, forwardedParams] = vi.mocked(forwardGatewayCall).mock.calls[0];
    expect(nodeId).toBe("sat-42");
    expect(method).toBe("sessions.spawn");
    // Routing fields must be stripped before forwarding to avoid loops.
    expect(forwardedParams).not.toHaveProperty("nodeId");
    expect(forwardedParams).not.toHaveProperty("node");
    expect(forwardedParams).toMatchObject({
      task: "audit federation",
      agentId: "coder",
      label: "Audit",
    });

    // Master records the remote run so its activity feed can tag the node.
    expect(registerRemoteSession).toHaveBeenCalledOnce();
    expect(vi.mocked(registerRemoteSession).mock.calls[0][0]).toMatchObject({
      runId: "remote-run-id",
      sessionKey: "agent:coder:subagent:remote-uuid",
      nodeId: "sat-42",
      agentId: "coder",
    });

    expect(opts.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        remote: true,
        nodeId: "sat-42",
        runId: "remote-run-id",
        childSessionKey: "agent:coder:subagent:remote-uuid",
      }),
      undefined,
    );
  });

  it("accepts the legacy `node` field when `nodeId` is absent", async () => {
    vi.mocked(getFederationHub).mockReturnValue({} as ReturnType<typeof getFederationHub>);

    const opts = makeOpts({
      task: "legacy field test",
      node: "sat-legacy",
    });
    await handler(opts);

    expect(forwardGatewayCall).toHaveBeenCalledOnce();
    expect(vi.mocked(forwardGatewayCall).mock.calls[0][0]).toBe("sat-legacy");
  });

  it("does NOT forward when nodeId is 'local'", async () => {
    vi.mocked(getFederationHub).mockReturnValue({} as ReturnType<typeof getFederationHub>);

    const opts = makeOpts({ task: "stay home", nodeId: "local" });
    await handler(opts);

    expect(forwardGatewayCall).not.toHaveBeenCalled();
  });

  it("does NOT forward when nodeId is omitted", async () => {
    vi.mocked(getFederationHub).mockReturnValue({} as ReturnType<typeof getFederationHub>);

    const opts = makeOpts({ task: "default to local" });
    await handler(opts);

    expect(forwardGatewayCall).not.toHaveBeenCalled();
  });

  it("does NOT forward when nodeId is whitespace-only", async () => {
    vi.mocked(getFederationHub).mockReturnValue({} as ReturnType<typeof getFederationHub>);

    const opts = makeOpts({ task: "ws", nodeId: "   " });
    await handler(opts);

    expect(forwardGatewayCall).not.toHaveBeenCalled();
  });

  it("falls back to local spawn only when routing reports NOT_FEDERATED", async () => {
    // Standalone install (no hub + no satellite): the forwarder returns
    // NOT_FEDERATED and the handler spawns locally rather than 500ing. Every
    // OTHER failure surfaces (see the next test) — we must never silently land
    // the sub-agent on the wrong node.
    vi.mocked(getFederationHub).mockReturnValue(null);
    vi.mocked(forwardGatewayCall).mockResolvedValueOnce({
      success: false,
      code: "NOT_FEDERATED",
      error: "no hub or satellite",
    });

    const opts = makeOpts({ task: "no hub here", nodeId: "sat-1" });
    await handler(opts);

    // The forwarder IS consulted; it decides routing is impossible, then we
    // fall through to a local spawn.
    expect(forwardGatewayCall).toHaveBeenCalledOnce();
    expect(registerRemoteSession).not.toHaveBeenCalled();
    // A local-path response (not a remote one) was produced.
    const lastCall = vi.mocked(opts.respond).mock.calls.at(-1);
    expect(lastCall?.[0]).toBe(true);
    expect(lastCall?.[1]).not.toHaveProperty("remote", true);
  });

  it("surfaces forward errors with a structured error code", async () => {
    vi.mocked(getFederationHub).mockReturnValue({} as ReturnType<typeof getFederationHub>);
    vi.mocked(forwardGatewayCall).mockResolvedValueOnce({
      success: false,
      code: "INVOKE_FAILED",
      error: "satellite offline",
    });

    const opts = makeOpts({ task: "x", nodeId: "sat-down" });
    await handler(opts);

    expect(registerRemoteSession).not.toHaveBeenCalled();
    expect(opts.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("satellite offline") }),
    );
  });

  it("rejects empty task before any routing work", async () => {
    const opts = makeOpts({ task: "   ", nodeId: "sat-1" });
    await handler(opts);
    expect(forwardGatewayCall).not.toHaveBeenCalled();
    expect(opts.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("task is required") }),
    );
  });
});
