import { describe, expect, it } from "vitest";

import type { MeshAgent } from "../activity-map";
import { inferProvider, inferZone } from "../agency-world";
import { getRoadPath } from "../agency-buildings";

// Minimal MeshAgent factory — only the fields the inference helpers read.
function makeAgent(over: Partial<MeshAgent> & Record<string, unknown> = {}): MeshAgent {
  return {
    sessionKey: "main:agent:1",
    agentId: "agent",
    label: "Agent",
    nodeId: "local",
    status: "working",
    progress: 0,
    ...over,
  } as MeshAgent;
}

describe("inferZone", () => {
  it("maps idle / completed status to the lounge", () => {
    expect(inferZone(makeAgent({ status: "idle" }))).toBe("lounge");
    expect(inferZone(makeAgent({ status: "completed" }))).toBe("lounge");
  });

  it("maps starting status to the entry", () => {
    expect(inferZone(makeAgent({ status: "starting" }))).toBe("entry");
  });

  it("maps read / grep / glob activity to the library", () => {
    expect(inferZone(makeAgent({ lastActivityKind: "read" }))).toBe("library");
    expect(inferZone(makeAgent({ lastActivityKind: "grep" }))).toBe("library");
    expect(inferZone(makeAgent({ lastActivityKind: "glob" }))).toBe("library");
  });

  it("maps bash activity to the terminal", () => {
    expect(inferZone(makeAgent({ lastActivityKind: "bash" }))).toBe("terminal");
  });

  it("maps edit / write activity to drafting", () => {
    expect(inferZone(makeAgent({ lastActivityKind: "edit" }))).toBe("drafting");
    expect(inferZone(makeAgent({ lastActivityKind: "write" }))).toBe("drafting");
  });

  it("maps webfetch activity to the browser pit", () => {
    expect(inferZone(makeAgent({ lastActivityKind: "webfetch" }))).toBe("browser");
  });

  it("maps task activity to comms", () => {
    expect(inferZone(makeAgent({ lastActivityKind: "task" }))).toBe("comm");
  });

  it("maps taskcreate activity to the kanban wall", () => {
    expect(inferZone(makeAgent({ lastActivityKind: "taskcreate" }))).toBe("kanban");
  });

  it("maps memoryget activity to the records archive", () => {
    expect(inferZone(makeAgent({ lastActivityKind: "memoryget" }))).toBe("records");
  });

  it("reads lastActivityKind case-insensitively", () => {
    expect(inferZone(makeAgent({ lastActivityKind: "BASH" }))).toBe("terminal");
  });

  it("also accepts a nested lastActivity.kind", () => {
    expect(inferZone(makeAgent({ lastActivity: { kind: "read" } }))).toBe("library");
  });

  it("falls back to the agentId keyword when the kind is unknown", () => {
    expect(inferZone(makeAgent({ agentId: "claude-coder", lastActivityKind: "weirdtool" }))).toBe(
      "drafting",
    );
    expect(inferZone(makeAgent({ agentId: "research-bot", lastActivityKind: "weirdtool" }))).toBe(
      "library",
    );
    expect(inferZone(makeAgent({ agentId: "tester-1", lastActivityKind: "weirdtool" }))).toBe(
      "terminal",
    );
  });

  it("defaults to drafting when neither kind nor keyword matches", () => {
    expect(inferZone(makeAgent({ agentId: "mystery", lastActivityKind: "weirdtool" }))).toBe(
      "drafting",
    );
    expect(inferZone(makeAgent({ agentId: "mystery" }))).toBe("drafting");
  });
});

describe("inferProvider", () => {
  it("maps anthropic family identifiers to claude", () => {
    expect(inferProvider(makeAgent({ agentId: "claude-coder" }))).toBe("claude");
    expect(inferProvider(makeAgent({ model: "opus" }))).toBe("claude");
    expect(inferProvider(makeAgent({ model: "sonnet" }))).toBe("claude");
    expect(inferProvider(makeAgent({ label: "Anthropic Agent" }))).toBe("claude");
  });

  it("maps gpt / openai / codex to openai", () => {
    expect(inferProvider(makeAgent({ model: "gpt-4" }))).toBe("openai");
    expect(inferProvider(makeAgent({ agentId: "openai-bot" }))).toBe("openai");
    expect(inferProvider(makeAgent({ agentId: "codex-coder" }))).toBe("openai");
  });

  it("maps gemini / google to gemini", () => {
    expect(inferProvider(makeAgent({ model: "gemini-pro" }))).toBe("gemini");
    expect(inferProvider(makeAgent({ label: "Google Bard" }))).toBe("gemini");
  });

  it("maps ollama / local to ollama", () => {
    expect(inferProvider(makeAgent({ model: "ollama" }))).toBe("ollama");
    expect(inferProvider(makeAgent({ agentId: "local-model" }))).toBe("ollama");
  });

  it("maps grok / xai to xai", () => {
    expect(inferProvider(makeAgent({ model: "grok-1" }))).toBe("xai");
    expect(inferProvider(makeAgent({ agentId: "xai-agent" }))).toBe("xai");
  });

  it("falls back to default for unknown providers", () => {
    expect(inferProvider(makeAgent({ agentId: "mystery", label: "Mystery", model: "" }))).toBe(
      "default",
    );
  });
});

describe("getRoadPath", () => {
  it("drops to the road, runs across, then rises to the target", () => {
    const from = { x: 100, y: 600 };
    const to = { x: 900, y: 600 };
    const path = getRoadPath(from, to);
    // No collinear/duplicate points to strip for this L-shape: 4 waypoints.
    expect(path).toHaveLength(4);
    expect(path[0]).toEqual(from);
    expect(path[path.length - 1]).toEqual(to);
    // The two intermediate waypoints ride the default road at y=965.
    expect(path[1]).toEqual({ x: 100, y: 965 });
    expect(path[2]).toEqual({ x: 900, y: 965 });
    for (let i = 1; i < path.length - 1; i++) {
      expect(path[i].y).toBe(965);
    }
  });

  it("collapses a vertical from.x === to.x route to a single segment", () => {
    const from = { x: 100, y: 600 };
    const to = { x: 100, y: 800 };
    const path = getRoadPath(from, to);
    // Duplicate {100,965} removed, then the three collinear x=100 points fold
    // down to just the endpoints.
    expect(path).toEqual([from, to]);
  });

  it("honors a custom roadY argument", () => {
    const from = { x: 0, y: 100 };
    const to = { x: 400, y: 100 };
    const path = getRoadPath(from, to, 500);
    expect(path).toHaveLength(4);
    expect(path[1]).toEqual({ x: 0, y: 500 });
    expect(path[2]).toEqual({ x: 400, y: 500 });
    expect(path[0]).toEqual(from);
    expect(path[path.length - 1]).toEqual(to);
  });
});
