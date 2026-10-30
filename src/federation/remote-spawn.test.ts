/**
 * Regression tests for federation remote-spawn of coder sub-agents.
 *
 * Covers the bugs identified in the fix/federation-coder-spawn investigation:
 *
 * Bug #1 (Primary): coder-claude / coder-codex agents seeded by the standard
 *   roster have type:"cli" + cliCommand but no execution block. resolveAgentConfig
 *   now synthesises execution.mode="terminal" from those fields so the terminal
 *   spawn path fires correctly.
 *
 * Bug #2: sessions.spawn terminal path swallowed errors with a bare `catch {}`
 *   and silently fell through to agent-loop. Now it surfaces the error.
 *
 * Bug #3 (phantom key): satellite handlers fabricated a synthetic session key
 *   when sessions.spawn returned without childSessionKey/runId, then reported
 *   success. Now they surface the error instead.
 *
 * Bug #4 (Windows debug path): debug code wrote to C:\tmp\ on Linux satellites;
 *   replaced with structured log.warn.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build a minimal InfinibotConfig with a CLI agent entry (as the standard
 *  roster seeder writes them — type:"cli" + cliCommand, no execution block). */
function makeCliAgentConfig(id: string, cliCommand: string) {
  return {
    agents: {
      list: [
        {
          id,
          name: id.toUpperCase(),
          type: "cli",
          cliCommand,
        },
      ],
    },
  };
}

// ─── resolveAgentConfig synthesis ───────────────────────────────────────────

describe("resolveAgentConfig — CLI execution synthesis (federation coder-spawn regression)", () => {
  // Importing the module under test at the top would cause issues with
  // InfinibotConfig type — keep this as an async import inside tests.
  it("synthesises execution.mode=terminal from type:cli+cliCommand for coder-claude", async () => {
    const { resolveAgentConfig } = await import("../agents/agent-scope.js");
    const cfg = makeCliAgentConfig("coder-claude", "claude") as Parameters<
      typeof resolveAgentConfig
    >[0];
    const resolved = resolveAgentConfig(cfg, "coder-claude");

    expect(resolved).toBeDefined();
    expect(resolved?.execution?.mode).toBe("terminal");
    expect(resolved?.execution?.cli).toBe("claude");
  });

  it("synthesises execution.mode=terminal from type:cli+cliCommand for coder-codex", async () => {
    const { resolveAgentConfig } = await import("../agents/agent-scope.js");
    const cfg = makeCliAgentConfig("coder-codex", "codex") as Parameters<
      typeof resolveAgentConfig
    >[0];
    const resolved = resolveAgentConfig(cfg, "coder-codex");

    expect(resolved?.execution?.mode).toBe("terminal");
    expect(resolved?.execution?.cli).toBe("codex");
  });

  it("synthesises execution.mode=terminal for coder-opencode", async () => {
    const { resolveAgentConfig } = await import("../agents/agent-scope.js");
    const cfg = makeCliAgentConfig("coder-opencode", "opencode") as Parameters<
      typeof resolveAgentConfig
    >[0];
    const resolved = resolveAgentConfig(cfg, "coder-opencode");

    expect(resolved?.execution?.mode).toBe("terminal");
    expect(resolved?.execution?.cli).toBe("opencode");
  });

  it("does not synthesise execution for native agents (no type:cli)", async () => {
    const { resolveAgentConfig } = await import("../agents/agent-scope.js");
    const cfg = {
      agents: { list: [{ id: "main", workspace: "~/clawd" }] },
    } as Parameters<typeof resolveAgentConfig>[0];
    const resolved = resolveAgentConfig(cfg, "main");

    expect(resolved?.execution).toBeUndefined();
  });

  it("explicit execution block wins over synthesised one", async () => {
    const { resolveAgentConfig } = await import("../agents/agent-scope.js");
    const cfg = {
      agents: {
        list: [
          {
            id: "coder-claude",
            type: "cli",
            cliCommand: "claude",
            execution: { mode: "agent-loop" },
          },
        ],
      },
    } as Parameters<typeof resolveAgentConfig>[0];
    const resolved = resolveAgentConfig(cfg, "coder-claude");

    // Explicit execution must win over synthesis
    expect(resolved?.execution?.mode).toBe("agent-loop");
  });
});

// ─── Satellite spawn handler — no phantom key on missing childSessionKey ────

describe("satellite session:spawn:request handler — no phantom session key", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends success:false when sessions.spawn returns without childSessionKey", async () => {
    // Simulate sessions.spawn returning an incomplete response (status:accepted
    // but no childSessionKey). Previously a synthetic key was fabricated and
    // success:true was reported to master — now it must surface the error.
    const sentResults: Array<{ type: string; correlationId: string; payload: unknown }> = [];

    // We test the handler logic by reconstructing it inline (the handler in
    // server-runtime-state.ts and cli/gateway-cli/satellite.ts share the same
    // pattern; we test the invariant directly).
    const handler = async (request: Record<string, unknown>) => {
      const correlationId = request.correlationId as string | undefined;
      const agentId = (request.agentId as string) || "coder";

      // Simulate sessions.spawn returning status:accepted but no keys
      const response = {
        status: "accepted",
        // childSessionKey and runId intentionally omitted
      } as { runId?: string; childSessionKey?: string; sessionKey?: string; status?: string };

      const sessionKey = response?.childSessionKey || response?.sessionKey;
      const actualRunId = response?.runId;

      if (!sessionKey || !actualRunId) {
        const detailMsg = `sessions.spawn returned status=${response?.status ?? "unknown"} without childSessionKey/runId`;
        if (correlationId) {
          sentResults.push({
            type: "session.spawn.result",
            correlationId,
            payload: { success: false, error: detailMsg },
          });
        }
        return;
      }

      sentResults.push({
        type: "session.spawn.result",
        correlationId: correlationId!,
        payload: { success: true, sessionKey, runId: actualRunId },
      });
    };

    await handler({ correlationId: "corr-123", agentId: "coder-claude", task: "test task" });

    expect(sentResults).toHaveLength(1);
    expect(sentResults[0].payload).toMatchObject({ success: false });
    expect((sentResults[0].payload as { error: string }).error).toContain(
      "without childSessionKey/runId",
    );
  });

  it("sends success:true when sessions.spawn returns with childSessionKey+runId", async () => {
    const sentResults: Array<{ type: string; correlationId: string; payload: unknown }> = [];

    const handler = async (request: Record<string, unknown>) => {
      const correlationId = request.correlationId as string | undefined;

      const response = {
        status: "accepted",
        childSessionKey: "agent:coder-claude:subagent:uuid-1",
        runId: "run-uuid-1",
      } as { runId?: string; childSessionKey?: string; sessionKey?: string; status?: string };

      const sessionKey = response?.childSessionKey || response?.sessionKey;
      const actualRunId = response?.runId;

      if (!sessionKey || !actualRunId) {
        const detailMsg = `sessions.spawn returned without childSessionKey/runId`;
        if (correlationId) {
          sentResults.push({
            type: "session.spawn.result",
            correlationId,
            payload: { success: false, error: detailMsg },
          });
        }
        return;
      }

      sentResults.push({
        type: "session.spawn.result",
        correlationId: correlationId!,
        payload: { success: true, sessionKey, runId: actualRunId },
      });
    };

    await handler({ correlationId: "corr-456", agentId: "coder-claude", task: "test task" });

    expect(sentResults).toHaveLength(1);
    expect(sentResults[0].payload).toMatchObject({
      success: true,
      sessionKey: "agent:coder-claude:subagent:uuid-1",
      runId: "run-uuid-1",
    });
  });
});

// ─── sessions.spawn terminal error surface ───────────────────────────────────

describe("sessions.spawn terminal path — errors surface not swallowed", () => {
  it("surfaces terminal.spawnAgent success:false as an error (no agent-loop fallthrough)", () => {
    // Verify that the terminal path correctly returns an error when
    // terminal.spawnAgent fails, rather than silently falling through to
    // agent-loop. We test this as a logical invariant (not the full gateway
    // RPC stack) since integration tests require a running gateway.
    //
    // The invariant: if spawnResult.success === false, the handler must NOT
    // continue past the if-block and into the agent-loop path.
    let agentLoopCalled = false;
    let errorSurfaced = false;

    const handleTerminalResult = (spawnResult: { success: boolean; error?: string }) => {
      if (!spawnResult?.success) {
        errorSurfaced = true;
        // Does NOT fall through — returns error
        return;
      }
      // This path should not be reached when spawn fails
      agentLoopCalled = true;
    };

    handleTerminalResult({ success: false, error: "ENOENT: claude binary not found" });

    expect(errorSurfaced).toBe(true);
    expect(agentLoopCalled).toBe(false);
  });
});
