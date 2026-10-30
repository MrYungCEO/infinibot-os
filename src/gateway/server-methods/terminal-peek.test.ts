import { beforeEach, describe, expect, it, vi } from "vitest";

const term = { outputBuffer: "x".repeat(10) + "TAIL", title: "repo", cwd: "/tmp/repo" };
const manager = {
  getTerminal: vi.fn((id: string) => (id === "term-1" ? term : undefined)),
  isTerminalAlive: vi.fn(() => true),
  getSavedSessions: vi.fn(() => [] as Array<{ id: string }>),
  write: vi.fn(),
  resize: vi.fn(),
};
vi.mock("./terminal.js", () => ({ getTerminalManager: () => manager }));
const tmux = {
  hasLiveSession: vi.fn(async () => true),
  capturePane: vi.fn(async () => "coder output\n"),
};
vi.mock("../../terminal/tmux-backend.js", () => tmux);
const runs: Array<{ terminalId?: string }> = [];
vi.mock("../../agents/subagent-registry.js", () => ({ listAllSubagentRuns: () => runs }));
vi.mock("../../agents/coder-backend/durable-spawn.js", () => ({
  listDurableRunIds: () => [],
  durableTerminalId: (r: string) => `spawn-${r}`,
}));

const { terminalPeekHandlers } = await import("./terminal-peek.js");

async function peek(params: Record<string, unknown>) {
  let out: { ok: boolean; body: any; err: any } = { ok: false, body: null, err: null };
  await terminalPeekHandlers["terminal.peek"]({
    params,
    respond: (ok: boolean, body: unknown, err: unknown) => (out = { ok, body, err }),
  } as never);
  return out;
}

describe("terminal.peek (read-only)", () => {
  beforeEach(() => {
    runs.length = 0;
    vi.clearAllMocks();
  });

  it("requires an id", async () => {
    expect((await peek({})).ok).toBe(false);
  });

  it("a tmux-backed manager terminal answers with the clean pane capture", async () => {
    const r = await peek({ id: "term-1" });
    expect(r.body).toMatchObject({ id: "term-1", text: "coder output\n", source: "tmux", title: "repo" });
  });

  it("answers from the PTY manager's buffer, tail-bounded by maxChars", async () => {
    tmux.hasLiveSession.mockResolvedValueOnce(false);
    const r = await peek({ id: "term-1", maxChars: 4 });
    expect(r.body).toMatchObject({
      id: "term-1",
      text: "TAIL",
      source: "pty",
      alive: true,
      title: "repo",
    });
    expect(manager.write).not.toHaveBeenCalled();
    expect(manager.resize).not.toHaveBeenCalled();
  });

  it("reads an owned coder pane with tmux capture-pane", async () => {
    runs.push({ terminalId: "spawn-abc" });
    const r = await peek({ id: "spawn-abc" });
    expect(r.body).toMatchObject({ text: "coder output\n", source: "tmux", alive: true });
    expect(tmux.capturePane).toHaveBeenCalledWith("spawn-abc", 2000);
  });

  it("never reads a pane this gateway does not own", async () => {
    const r = await peek({ id: "spawn-foreign" });
    expect(r.body).toMatchObject({ text: "", source: "none", alive: false });
    expect(tmux.capturePane).not.toHaveBeenCalled();
  });
});
