import { describe, expect, it } from "vitest";
import {
  classifyReattachable,
  parseSpawnTerminalId,
  backendToKind,
  splitForeignEntries,
  type ClassifyContext,
  type SpawnRunLite,
} from "./reattachable.js";

function ctx(partial: Partial<ClassifyContext> & { liveIds: string[] }): ClassifyContext {
  return {
    runs: [],
    memTerminals: new Map(),
    savedSessions: new Map(),
    cwdFallback: new Map(),
    ...partial,
  };
}

describe("parseSpawnTerminalId", () => {
  it("parses spawn-<runId8>-<epoch>", () => {
    expect(parseSpawnTerminalId("spawn-1a2b3c4d-1699999999999")).toEqual({
      runIdPrefix: "1a2b3c4d",
      startedAtMs: 1699999999999,
    });
  });

  it("returns null for non-spawn ids", () => {
    expect(parseSpawnTerminalId("term-abc")).toBeNull();
    expect(parseSpawnTerminalId("abc123")).toBeNull();
  });

  it("still recognises a malformed spawn-* id as an agent pane", () => {
    expect(parseSpawnTerminalId("spawn-weird")).toEqual({ runIdPrefix: "weird" });
  });

  it("accepts the tmux-sanitized underscore form (hyphens → underscores)", () => {
    // tmuxSessionName() sanitizes `spawn-1a2b3c4d-169…` → `spawn_1a2b3c4d_169…`,
    // which is what listLiveSessions() surfaces.
    expect(parseSpawnTerminalId("spawn_1a2b3c4d_1699999999999")).toEqual({
      runIdPrefix: "1a2b3c4d",
      startedAtMs: 1699999999999,
    });
  });
});

describe("backendToKind", () => {
  it("codex → codex, everything else → cloud", () => {
    expect(backendToKind("codex")).toBe("codex");
    expect(backendToKind("claude-code")).toBe("cloud");
    expect(backendToKind("opencode")).toBe("cloud");
    expect(backendToKind(undefined)).toBe("cloud");
  });
});

describe("classifyReattachable — cloud/codex agent panes", () => {
  const run: SpawnRunLite = {
    runId: "1a2b3c4d5e6f7080",
    terminalId: "spawn-1a2b3c4d-1699999999999",
    agentId: "dev",
    workdir: "/work/proj",
    label: "refactor auth",
    coderBackend: "claude-code",
    childSessionKey: "agent:dev:run-1a2b3c4d",
    task: "refactor the auth flow end to end",
  };

  it("classifies a claude-code spawn as cloud and maps reattachSpawnAgent", () => {
    const [e] = classifyReattachable(
      ctx({ liveIds: ["spawn-1a2b3c4d-1699999999999"], runs: [run] }),
    );
    expect(e.kind).toBe("cloud");
    expect(e.backend).toBe("claude-code");
    expect(e.runId).toBe("1a2b3c4d5e6f7080");
    expect(e.agentId).toBe("dev");
    expect(e.cwd).toBe("/work/proj");
    expect(e.sessionKey).toBe("agent:dev:run-1a2b3c4d");
    expect(e.reattach.method).toBe("terminal.reattachSpawnAgent");
    expect(e.reattach.params).toMatchObject({
      terminalId: "spawn-1a2b3c4d-1699999999999",
      runId: "1a2b3c4d5e6f7080",
      agentId: "dev",
      cwd: "/work/proj",
    });
    expect(e.label).toContain("Claude Code");
    expect(e.label).toContain("refactor auth");
  });

  it("classifies a codex spawn into the codex bucket", () => {
    const codexRun: SpawnRunLite = { ...run, coderBackend: "codex" };
    const [e] = classifyReattachable(
      ctx({ liveIds: ["spawn-1a2b3c4d-1699999999999"], runs: [codexRun] }),
    );
    expect(e.kind).toBe("codex");
    expect(e.backend).toBe("codex");
    expect(e.label).toContain("Codex");
  });

  it("matches a sanitized live id back to its run and emits the canonical (original) terminalId", () => {
    // Live id comes back underscore-sanitized; registry stores the original.
    const [e] = classifyReattachable(
      ctx({ liveIds: ["spawn_1a2b3c4d_1699999999999"], runs: [run] }),
    );
    expect(e.kind).toBe("cloud");
    expect(e.backend).toBe("claude-code");
    // Canonical id (from registry) is emitted so reattach hits the double-attach
    // guard keyed the same way boot recovery keys it.
    expect(e.id).toBe("spawn-1a2b3c4d-1699999999999");
    expect(e.reattach.params.terminalId).toBe("spawn-1a2b3c4d-1699999999999");
    expect(e.reattach.params.runId).toBe("1a2b3c4d5e6f7080");
  });

  it("matches by runId prefix when terminalId isn't recorded", () => {
    const noTerm: SpawnRunLite = { ...run, terminalId: undefined };
    const [e] = classifyReattachable(
      ctx({ liveIds: ["spawn-1a2b3c4d-1699999999999"], runs: [noTerm] }),
    );
    expect(e.runId).toBe("1a2b3c4d5e6f7080");
    expect(e.kind).toBe("cloud");
  });

  it("registry-empty fallback: still reattachable via id-derived runId prefix", () => {
    const [e] = classifyReattachable(
      ctx({
        liveIds: ["spawn-1a2b3c4d-1699999999999"],
        runs: [],
        cwdFallback: new Map([["spawn-1a2b3c4d-1699999999999", "/tmp/wt"]]),
      }),
    );
    expect(e.kind).toBe("cloud");
    expect(e.backend).toBe("unknown");
    // No real run id available — fall back to the 8-char prefix so terminalId
    // + runId are still both present for reattachSpawnAgent.
    expect(e.runId).toBe("1a2b3c4d");
    expect(e.reattach.method).toBe("terminal.reattachSpawnAgent");
    expect(e.reattach.params).toMatchObject({
      terminalId: "spawn-1a2b3c4d-1699999999999",
      runId: "1a2b3c4d",
    });
    expect(e.cwd).toBe("/tmp/wt");
    expect(e.agentId).toBe("agent");
  });
});

describe("classifyReattachable — CLI/shell panes", () => {
  it("classifies an in-memory claude CLI pane as cli via terminal.create", () => {
    const [e] = classifyReattachable(
      ctx({
        liveIds: ["term-xyz"],
        memTerminals: new Map([
          [
            "term-xyz",
            { cliType: "claude", title: "Claude · dev", cwd: "/repo", isClaudeMode: true },
          ],
        ]),
      }),
    );
    expect(e.kind).toBe("cli");
    expect(e.backend).toBe("claude");
    expect(e.reattach.method).toBe("terminal.create");
    expect(e.reattach.params).toMatchObject({ id: "term-xyz", cwd: "/repo", cliType: "claude" });
    expect(e.label).toBe("Claude · dev");
  });

  it("classifies a plain shell pane as shell", () => {
    const [e] = classifyReattachable(
      ctx({ liveIds: ["term-sh"], cwdFallback: new Map([["term-sh", "/home/u"]]) }),
    );
    expect(e.kind).toBe("shell");
    expect(e.backend).toBeUndefined();
    expect(e.reattach.method).toBe("terminal.create");
    expect(e.reattach.params).toMatchObject({ id: "term-sh", cwd: "/home/u" });
  });

  it("enriches a CLI pane from persisted session when not in memory", () => {
    const [e] = classifyReattachable(
      ctx({
        liveIds: ["term-persist"],
        savedSessions: new Map([
          ["term-persist", { cliType: "codex", title: "Codex · old", cwd: "/old" }],
        ]),
      }),
    );
    expect(e.kind).toBe("cli");
    expect(e.backend).toBe("codex");
    expect(e.cwd).toBe("/old");
  });
});

describe("classifyReattachable — mixed fleet + federation", () => {
  it("classifies a mixed set and stamps nodeId", () => {
    const runs: SpawnRunLite[] = [
      {
        runId: "aaaaaaaa1111",
        terminalId: "spawn-aaaaaaaa-1",
        agentId: "dev",
        workdir: "/a",
        coderBackend: "claude-code",
        childSessionKey: "agent:dev:1",
      },
      {
        runId: "bbbbbbbb2222",
        terminalId: "spawn-bbbbbbbb-2",
        agentId: "ops",
        workdir: "/b",
        coderBackend: "codex",
        childSessionKey: "agent:ops:2",
      },
    ];
    const entries = classifyReattachable(
      ctx({
        liveIds: ["spawn-aaaaaaaa-1", "spawn-bbbbbbbb-2", "term-shell"],
        runs,
        memTerminals: new Map([["term-shell", { cwd: "/c" }]]),
        nodeId: "sat-1",
      }),
    );
    expect(entries.map((e) => e.kind)).toEqual(["cloud", "codex", "shell"]);
    expect(entries.every((e) => e.nodeId === "sat-1")).toBe(true);
    expect(entries.every((e) => e.live === true)).toBe(true);
  });
});

describe("classifyReattachable — cross-instance ownership", () => {
  // Gateways sharing one state directory also share its tmux socket. Before
  // state-scoped sockets, the ~/.infinibot gateway listed the
  // ~/.infinibot-omnitrade gateway's live coder panes as its own reattachable
  // agents (runId fell back to the id prefix, "coder"), an operator reattached
  // and then closed the tabs — killing two running agents. Foreign panes must
  // be flagged so callers never offer them.
  const FOREIGN = "spawn_coder_tfh_menu_photo_pipeline_1aoa";

  it("flags a live spawn pane this instance cannot prove it owns", () => {
    const [entry] = classifyReattachable(
      ctx({ liveIds: [FOREIGN], ownedSpawnIds: new Set(["spawn_something_else"]) }),
    );
    expect(entry.kind).toBe("cloud");
    expect(entry.foreign).toBe(true);
    // The exact mis-derivation the incident log shows: no matching run, so the
    // runId degrades to the id prefix.
    expect(entry.runId).toBe("coder");
  });

  it("does not flag a pane backed by one of our own registry runs", () => {
    const runs: SpawnRunLite[] = [
      {
        runId: "coder-tfh-menu-photo-pipeline-1aoa",
        terminalId: "spawn-coder-tfh-menu-photo-pipeline-1aoa",
        coderBackend: "claude-code",
        childSessionKey: "agent:main:subagent:1",
      },
    ];
    const [entry] = classifyReattachable(
      ctx({ liveIds: [FOREIGN], runs, ownedSpawnIds: new Set() }),
    );
    expect(entry.foreign).toBeUndefined();
    expect(entry.runId).toBe("coder-tfh-menu-photo-pipeline-1aoa");
  });

  it("does not flag a pane listed as owned (durable run dir / persisted session)", () => {
    const [entry] = classifyReattachable(
      ctx({ liveIds: [FOREIGN], ownedSpawnIds: new Set([FOREIGN]) }),
    );
    expect(entry.foreign).toBeUndefined();
  });

  it("never flags CLI/shell panes, and stays off when no owned-set is supplied", () => {
    const entries = classifyReattachable(ctx({ liveIds: [FOREIGN, "term-shell"] }));
    expect(entries.every((e) => e.foreign === undefined)).toBe(true);
  });

  it("splitForeignEntries partitions offerable from foreign", () => {
    const entries = classifyReattachable(
      ctx({ liveIds: [FOREIGN, "term-shell"], ownedSpawnIds: new Set() }),
    );
    const split = splitForeignEntries(entries);
    expect(split.entries.map((e) => e.id)).toEqual(["term-shell"]);
    expect(split.foreign.map((e) => e.id)).toEqual([FOREIGN]);
  });
});
