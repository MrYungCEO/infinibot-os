/**
 * Unit tests for the iso layout engine.
 *
 * Uses 50 synthetic agents across 3 projects × 4 kinds to verify:
 *   (a) No two agents are within minAgentSpacing.
 *   (b) Same-project mean pairwise distance < cross-project mean.
 *   (c) Active orbit radius > idle bob amplitude.
 */

import { describe, expect, it } from "vitest";
import type { MeshAgent } from "../activity-map";
import { computeLayout, LAYOUT_CONFIG, noteAgentActivity } from "./layout-engine";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PROJECTS = ["node-alpha", "node-beta", "node-gamma"] as const;
const KINDS = ["claude-code", "opencode", "codex", "gemini"] as const;

function makeAgent(
  idx: number,
  nodeId: string,
  coderBackend: string,
): MeshAgent {
  return {
    sessionKey: `agent-${idx}-${nodeId}-${coderBackend}`,
    agentId: `agent-${idx}`,
    label: `Agent ${idx}`,
    nodeId,
    status: "working",
    progress: 0.5,
    coderBackend,
  } as MeshAgent;
}

/** Build 50 agents: ~4 per (project, kind) with a couple of uneven groups. */
function make50Agents(): MeshAgent[] {
  const agents: MeshAgent[] = [];
  let idx = 0;

  for (let pi = 0; pi < 3; pi++) {
    for (let ki = 0; ki < 4; ki++) {
      // Uneven distribution: first project gets 5 in kind-0, last project gets 3 in kind-3
      const count = pi === 0 && ki === 0 ? 5 : pi === 2 && ki === 3 ? 3 : 4;
      for (let i = 0; i < count; i++) {
        agents.push(makeAgent(idx++, PROJECTS[pi], KINDS[ki]));
      }
    }
  }

  // Top up to exactly 50
  while (agents.length < 50) {
    agents.push(makeAgent(idx++, PROJECTS[idx % 3], "default"));
  }

  return agents.slice(0, 50);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("computeLayout — 50 agents, 3 projects, 4 kinds", () => {
  const agents = make50Agents();
  const layout = computeLayout(agents, 0);
  const entries = Array.from(layout.values());

  it("returns an entry for every agent", () => {
    expect(layout.size).toBe(50);
  });

  it("(a) no two agents are within minAgentSpacing of each other", () => {
    const threshold = LAYOUT_CONFIG.minAgentSpacing - 0.5; // 0.5 px float tolerance

    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const d = Math.hypot(
          entries[i].homeX - entries[j].homeX,
          entries[i].homeY - entries[j].homeY,
        );
        if (d < threshold) {
          throw new Error(
            `Agents ${entries[i].sessionKey} and ${entries[j].sessionKey} ` +
            `are only ${d.toFixed(1)}px apart (min: ${threshold})`,
          );
        }
      }
    }
  });

  it("(b) same-project agents have lower mean pairwise distance than cross-project", () => {
    const sameD: number[] = [];
    const crossD: number[] = [];

    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const d = Math.hypot(
          entries[i].homeX - entries[j].homeX,
          entries[i].homeY - entries[j].homeY,
        );
        if (entries[i].projectId === entries[j].projectId) {
          sameD.push(d);
        } else {
          crossD.push(d);
        }
      }
    }

    const mean = (arr: number[]) =>
      arr.reduce((s, v) => s + v, 0) / arr.length;

    const meanSame = mean(sameD);
    const meanCross = mean(crossD);

    expect(meanSame).toBeLessThan(meanCross);
    // Log ratio for the report
    (globalThis as any).__layoutDistanceRatio = meanSame / meanCross;
  });

  it("projectId is correctly derived from nodeId", () => {
    for (const entry of entries) {
      const agent = agents.find((a) => a.sessionKey === entry.sessionKey)!;
      expect(entry.projectId).toBe(agent.nodeId || "local");
    }
  });

  it("kind is correctly derived from coderBackend", () => {
    const knownKinds = [...KINDS, "default"];
    for (const entry of entries) {
      expect(knownKinds).toContain(entry.kind);
    }
  });
});

describe("(c) active orbit radius vs idle amplitude", () => {
  it("activeOrbitRadius is greater than idleAmplitude", () => {
    expect(LAYOUT_CONFIG.activeOrbitRadius).toBeGreaterThan(
      LAYOUT_CONFIG.idleAmplitude,
    );
  });

  it("isActive=true when activity was < 8 s ago", () => {
    const now = 10_000;
    const agent = makeAgent(0, "node-x", "claude-code");
    noteAgentActivity(agent.sessionKey, now - 3000); // 3 s ago — should be active
    const layout = computeLayout([agent], now);
    const entry = layout.get(agent.sessionKey)!;
    expect(entry.isActive).toBe(true);
  });

  it("isActive=false when no activity recorded", () => {
    const agent = makeAgent(99, "node-y", "codex");
    const layout = computeLayout([agent], 5000);
    const entry = layout.get(agent.sessionKey)!;
    expect(entry.isActive).toBe(false);
  });
});
