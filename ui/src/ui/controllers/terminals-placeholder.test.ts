import { describe, it, expect } from "vitest";
import {
  dedupeTerminalSessions,
  canonicalPtyId,
  reconcilePlaceholderSessions,
  type TerminalSession,
  type TerminalCellDescriptor,
} from "./terminals";

const NOW = "2026-06-12T00:00:00.000Z";

function cell(over: Partial<TerminalCellDescriptor> & { id: string }): TerminalCellDescriptor {
  return { title: "T", cli: "shell", cwd: "/tmp", ...over };
}

describe("reconcilePlaceholderSessions", () => {
  it("creates placeholders only for saved cells with no live PTY", () => {
    const live = [{ id: "a" }];
    const saved = [cell({ id: "a" }), cell({ id: "b", title: "Dead", cli: "claude", cwd: "/proj" })];

    const result = reconcilePlaceholderSessions(live, saved, NOW);

    expect(result).toHaveLength(1);
    const ph = result[0];
    expect(ph.id).toBe("b");
    expect(ph.isPlaceholder).toBe(true);
    expect(ph.status).toBe("exited");
    expect(ph.cli).toBe("claude");
    expect(ph.cwd).toBe("/proj");
    expect(ph.title).toBe("Dead");
    expect(ph.createdAt).toBe(NOW);
  });

  it("returns nothing when every saved cell is still live", () => {
    const live = [{ id: "a" }, { id: "b" }];
    const saved = [cell({ id: "a" }), cell({ id: "b" })];
    expect(reconcilePlaceholderSessions(live, saved, NOW)).toHaveLength(0);
  });

  it("rebuilds slots even when zero terminals survived", () => {
    const result = reconcilePlaceholderSessions([], [cell({ id: "x" }), cell({ id: "y" })], NOW);
    expect(result.map((s) => s.id)).toEqual(["x", "y"]);
    expect(result.every((s) => s.isPlaceholder)).toBe(true);
  });

  it("dedupes repeated cell ids and preserves federation node metadata", () => {
    const saved = [
      cell({ id: "dup", nodeId: "node-2", nodeName: "Laptop" }),
      cell({ id: "dup" }),
    ];
    const result = reconcilePlaceholderSessions([], saved, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].nodeId).toBe("node-2");
    expect(result[0].nodeName).toBe("Laptop");
  });

  it("falls back to a generated title and cwd when the descriptor is sparse", () => {
    const result = reconcilePlaceholderSessions([], [{ id: "z", cli: "gemini" } as TerminalCellDescriptor], NOW);
    expect(result[0].title).toBeTruthy();
    expect(result[0].cwd).toBe(".");
  });
});

describe("dedupeTerminalSessions", () => {
  const session = (over: Partial<TerminalSession>): TerminalSession => ({
    id: "term-1",
    title: "Terminal",
    cli: "shell",
    status: "running",
    cwd: "/tmp",
    createdAt: NOW,
    expandedView: false,
    ...over,
  });

  it("collapses repeated restore rows on the same node and merges metadata", () => {
    const result = dedupeTerminalSessions([
      session({ nodeId: "local" }),
      session({ nodeId: "local", reattach: { method: "terminal.reattach", params: {} } }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].reattach?.method).toBe("terminal.reattach");
  });

  it("keeps same-id terminals from different nodes but collapses mirror panels", () => {
    const result = dedupeTerminalSessions([
      session({ nodeId: "local" }),
      session({ nodeId: "node-2" }),
      session({ id: "mirror-1", ptyId: "term-1", nodeId: "local" }),
    ]);

    expect(result).toHaveLength(2);
    expect(result.map((item) => item.nodeId)).toEqual(["local", "node-2"]);
  });

  it("hard-dedupes manager and tmux forms while retaining the manager id", () => {
    expect(canonicalPtyId("term-123-abc")).toBe("term_123_abc");
    const result = dedupeTerminalSessions([
      session({ id: "term-123-abc", title: "Manager" }),
      session({ id: "term_123_abc", title: "Tmux", reattach: { method: "terminal.create", params: {} } }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("term-123-abc");
    expect(result[0].reattach?.method).toBe("terminal.create");
  });
});
