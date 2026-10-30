/**
 * Regression tests: a pty client detaching from a `spawn-*` pane is NOT a run exit.
 *
 * `handleSpawnTerminalExit` fires whenever the node-pty **client** attached to a
 * tmux pane goes away. That happens on a genuine agent exit — but also when a
 * viewer tab closes or the gateway drops the client. Treating the second case
 * as the first is how the 2026-09-04 kill compounded: the detach emitted a
 * lifecycle "error" (marking a healthy run failed) and then scheduled an
 * autoClose `manager.destroy` on a pane that was still mid-turn.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const hasLiveSessionSync = vi.fn<(id: string) => boolean>();
const emitAgentEvent = vi.fn();

vi.mock("./tmux-backend.js", () => ({
  hasLiveSessionSync: (id: string) => hasLiveSessionSync(id),
  tmuxSessionName: (id: string) => `infinibot_${id.replace(/[^a-zA-Z0-9_]/g, "_")}`,
}));

vi.mock("../infra/agent-events.js", () => ({
  emitAgentEvent: (...args: unknown[]) => emitAgentEvent(...args),
  onAgentEvent: () => () => {},
}));

const { reattachSpawnAgentTerminal, handleSpawnTerminalExit } = await import("./spawn-agent.js");

/** Minimal TerminalManager stand-in: enough surface for the reattach path. */
function fakeManager(terminalId: string) {
  const destroyed: string[] = [];
  const terminal = { id: terminalId, pty: { onExit: () => {} }, outputBuffer: "", spawnMeta: null };
  return {
    destroyed,
    manager: {
      create: async () => ({ success: true, terminalId }),
      getTerminal: () => terminal,
      destroy: async (id: string) => {
        destroyed.push(id);
        return { success: true };
      },
    } as any,
  };
}

let counter = 0;
/** Unique id per test — spawn metadata lives in a module-level map. */
const nextId = () => `spawn-detachtest${counter++}-${Date.now()}`;

beforeEach(() => {
  hasLiveSessionSync.mockReset();
  emitAgentEvent.mockReset();
  vi.useRealTimers();
});

describe("handleSpawnTerminalExit — client detach vs run exit", () => {
  it("ignores a pty exit while the tmux session is still live", async () => {
    const terminalId = nextId();
    const { manager, destroyed } = fakeManager(terminalId);
    hasLiveSessionSync.mockReturnValue(true);

    await reattachSpawnAgentTerminal({
      manager,
      terminalId,
      runId: "coder-tfh-menu-photo-pipeline-1aoa",
      sessionKey: "agent:main:subagent:x",
      agentId: "main",
    });

    const broadcast = vi.fn();
    const handled = handleSpawnTerminalExit(terminalId, 1, manager, broadcast);

    expect(handled).toBe(false);
    // No bogus "CLI exited with code 1" lifecycle error for a healthy run…
    expect(emitAgentEvent).not.toHaveBeenCalled();
    // …no spawnComplete, and crucially no autoClose destroy.
    expect(broadcast).not.toHaveBeenCalled();
    expect(destroyed).toEqual([]);
  });

  it("still settles the run when the pane is genuinely gone", async () => {
    const terminalId = nextId();
    const { manager } = fakeManager(terminalId);
    // Session already gone by the time the pty exit lands — a real run exit.
    hasLiveSessionSync.mockReturnValue(false);

    await reattachSpawnAgentTerminal({
      manager,
      terminalId,
      runId: "coder-real-exit",
      sessionKey: "agent:main:subagent:y",
      agentId: "main",
      autoClose: false,
    });

    const broadcast = vi.fn();
    const handled = handleSpawnTerminalExit(terminalId, 0, manager, broadcast);

    expect(handled).toBe(true);
    expect(emitAgentEvent).toHaveBeenCalledTimes(1);
    expect(emitAgentEvent.mock.calls[0][0]).toMatchObject({
      stream: "lifecycle",
      runId: "coder-real-exit",
      data: expect.objectContaining({ phase: "end" }),
    });
    expect(broadcast).toHaveBeenCalledWith("terminal.spawnComplete", expect.anything());
  });

  it("leaves spawn metadata intact after a detach, so a later real exit still settles", async () => {
    const terminalId = nextId();
    const { manager } = fakeManager(terminalId);
    hasLiveSessionSync.mockReturnValue(true);

    await reattachSpawnAgentTerminal({
      manager,
      terminalId,
      runId: "coder-detach-then-exit",
      sessionKey: "agent:main:subagent:z",
      agentId: "main",
      autoClose: false,
    });

    expect(handleSpawnTerminalExit(terminalId, 1, manager)).toBe(false);

    hasLiveSessionSync.mockReturnValue(false);
    expect(handleSpawnTerminalExit(terminalId, 0, manager)).toBe(true);
    expect(emitAgentEvent).toHaveBeenCalledTimes(1);
  });
});
