/**
 * Regression tests for the spawn-pane destroy guard.
 *
 * The bug (2026-09-04): two live detached coder runs were killed mid-turn
 * because a gateway attached a pty client to their tmux panes via the reattach
 * dropdown and then closed the tabs. `destroyTerminal()` ran the ordinary
 * teardown — `tmux kill-session` — on panes that were actively streaming, so
 * the launcher script never wrote `exit.code` and the runs died at 137.
 *
 * The invariant these tests lock: a pty client is a VIEW of a `spawn-*` pane,
 * never its owner. Closing the view (or losing it) must leave the tmux session
 * — and the agent inside it — running. Only an explicit kill may end it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const hasLiveSessionSync = vi.fn<(id: string) => boolean>();
const killSession = vi.fn(async (_id: string) => {});
const isTmuxAvailable = vi.fn(() => true);

vi.mock("./tmux-backend.js", () => ({
  hasLiveSessionSync: (id: string) => hasLiveSessionSync(id),
  killSession: (id: string) => killSession(id),
  isTmuxAvailable: () => isTmuxAvailable(),
  tmuxSessionName: (id: string) => `infinibot_${id.replace(/[^a-zA-Z0-9_]/g, "_")}`,
}));

vi.mock("./session-handler.js", () => ({
  removePersistedSession: vi.fn(),
}));

vi.mock("./pty-manager.js", () => ({
  killPty: vi.fn(),
}));

const { isLiveAgentPane } = await import("./agent-pane-guard.js");
const { destroyTerminal } = await import("./terminal-lifecycle.js");

function fakeTerminals(id: string) {
  const map = new Map<string, any>();
  map.set(id, { id, pty: { kill: () => {} } });
  return map;
}

const noopCleanup = () => {};

beforeEach(() => {
  hasLiveSessionSync.mockReset();
  killSession.mockReset();
  isTmuxAvailable.mockReset().mockReturnValue(true);
});

describe("isLiveAgentPane", () => {
  it("is true for a live spawn-* pane (both id spellings)", () => {
    hasLiveSessionSync.mockReturnValue(true);
    expect(isLiveAgentPane("spawn-coder-tfh-menu-photo-pipeline-1aoa")).toBe(true);
    // tmux sanitizes hyphens → underscores, so listLiveSessions() hands back
    // the underscore form for the very same pane.
    expect(isLiveAgentPane("spawn_coder_tfh_menu_photo_pipeline_1aoa")).toBe(true);
  });

  it("is false once the session is gone", () => {
    hasLiveSessionSync.mockReturnValue(false);
    expect(isLiveAgentPane("spawn-coder-x")).toBe(false);
  });

  it("is false for ordinary terminals — and never probes tmux for them", () => {
    hasLiveSessionSync.mockReturnValue(true);
    expect(isLiveAgentPane("term-1788455639503-qejtu9")).toBe(false);
    expect(isLiveAgentPane("voice_1786607337051_fgt7dl")).toBe(false);
    expect(isLiveAgentPane("")).toBe(false);
    expect(hasLiveSessionSync).not.toHaveBeenCalled();
  });
});

describe("destroyTerminal — live agent panes survive", () => {
  it("does NOT kill the tmux session of a live spawn-* pane", async () => {
    hasLiveSessionSync.mockReturnValue(true);
    const id = "spawn-coder-tfh-menu-photo-pipeline-1aoa";
    const terminals = fakeTerminals(id);

    const res = await destroyTerminal(id, terminals, noopCleanup);

    expect(res.success).toBe(true);
    expect(res.tmuxSessionPreserved).toBe(true);
    // The exact call that killed two live runs on 2026-09-04.
    expect(killSession).not.toHaveBeenCalled();
    // The viewer is still dropped — only the session survives.
    expect(terminals.has(id)).toBe(false);
  });

  it("kills the tmux session of an ordinary terminal", async () => {
    hasLiveSessionSync.mockReturnValue(true);
    const id = "term-1788455639503-qejtu9";
    const terminals = fakeTerminals(id);

    const res = await destroyTerminal(id, terminals, noopCleanup);

    expect(res.success).toBe(true);
    expect(res.tmuxSessionPreserved).toBeUndefined();
    expect(killSession).toHaveBeenCalledWith(id);
  });

  it("kills a spawn-* pane whose session is already dead (no leak)", async () => {
    hasLiveSessionSync.mockReturnValue(false);
    const id = "spawn-coder-dead";
    const terminals = fakeTerminals(id);

    await destroyTerminal(id, terminals, noopCleanup);

    expect(killSession).toHaveBeenCalledWith(id);
  });

  it("kills a live spawn-* pane when explicitly asked to (killAgentPane)", async () => {
    hasLiveSessionSync.mockReturnValue(true);
    const id = "spawn-coder-explicit-stop";
    const terminals = fakeTerminals(id);

    const res = await destroyTerminal(id, terminals, noopCleanup, { killAgentPane: true });

    expect(res.tmuxSessionPreserved).toBeUndefined();
    expect(killSession).toHaveBeenCalledWith(id);
  });

  it("decides BEFORE dropping the pty, so the client kill can't flip the verdict", async () => {
    // killPty drops the tmux *client*; if the pane's process had already
    // exited, that ends the session. Probing after the kill would then read
    // "not live" and we'd kill a session we had just decided to preserve.
    const id = "spawn-coder-order";
    const terminals = fakeTerminals(id);
    let probes = 0;
    hasLiveSessionSync.mockImplementation(() => {
      probes++;
      return probes === 1; // live on the first probe only
    });

    const res = await destroyTerminal(id, terminals, noopCleanup);

    expect(res.tmuxSessionPreserved).toBe(true);
    expect(killSession).not.toHaveBeenCalled();
  });
});
