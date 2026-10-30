import { describe, expect, it } from "vitest";
import type { MeshAgent, MeshNode } from "./activity-map";
import { buildAgentHoverCardModel, placeAgentHoverCard } from "./agent-hover-card";

const agent: MeshAgent = {
  sessionKey: "agent:codex-7",
  agentId: "coder-codex",
  label: "Codex · Hover cards",
  nodeId: "local",
  status: "working",
  progress: 72,
  currentTask: "Polish the Agent Mesh hover experience",
  activityLabel: "Vitest: agent-hover-card.test.ts",
  coderBackend: "codex",
  startedAt: 1_000,
  lastActivityAt: 120_000,
  totalTokens: 12_430,
  currentCheckpoint: "Responsive pass",
  runId: "d6077d5d-c2a7-497b-9185-730ef392f2a1",
  pluginId: "core",
};

const node: MeshNode = {
  id: "local",
  name: "Bangkok workstation",
  role: "hub",
  status: "online",
  agentCount: 3,
};

describe("agent hover card", () => {
  it("builds rich live-agent details", () => {
    const model = buildAgentHoverCardModel(
      agent,
      node,
      { status: "approved", summary: "Responsive behavior verified" },
      181_000,
    );
    expect(model).toMatchObject({
      name: "Codex · Hover cards",
      statusLabel: "Working",
      tone: "active",
      backend: "Codex CLI",
      node: "Bangkok workstation",
      progress: 72,
      runtime: "3m",
      tokens: "12.4K",
      updated: "Updated 1m ago",
      checkpoint: "Responsive pass",
      review: "Responsive behavior verified",
    });
  });

  it("uses honest fallbacks for sparse data", () => {
    const model = buildAgentHoverCardModel(
      { ...agent, label: "", status: "idle", currentTask: undefined, activityLabel: undefined, startedAt: undefined, totalTokens: undefined },
      undefined,
      null,
      181_000,
    );
    expect(model.name).toBe("coder-codex");
    expect(model.statusLabel).toBe("Idle");
    expect(model.task).toBe("Waiting for the next action");
    expect(model.runtime).toBe("—");
    expect(model.tokens).toBe("—");
  });

  it("flips and clamps the desktop card inside the map", () => {
    expect(placeAgentHoverCard({
      anchorX: 950,
      anchorY: 40,
      hostWidth: 1_000,
      hostHeight: 700,
      cardWidth: 320,
      cardHeight: 380,
      mobile: false,
    })).toEqual({ left: 614, top: 12, mobile: false });
  });

  it("docks the card above the lower edge on mobile", () => {
    expect(placeAgentHoverCard({
      anchorX: 100,
      anchorY: 100,
      hostWidth: 390,
      hostHeight: 844,
      cardWidth: 366,
      cardHeight: 420,
      mobile: true,
    })).toEqual({ left: 12, top: 412, mobile: true });
  });

  it("places the desktop card beside the agent's name tag, not on it", () => {
    const anchorRect = { x: 480, y: 300, width: 90, height: 100 };
    const place = placeAgentHoverCard({
      anchorX: 520,
      anchorY: 340,
      hostWidth: 1_440,
      hostHeight: 900,
      cardWidth: 340,
      cardHeight: 380,
      mobile: false,
      anchorRect,
    });
    const overlapsX = place.left < anchorRect.x + anchorRect.width && place.left + 340 > anchorRect.x;
    const overlapsY = place.top < anchorRect.y + anchorRect.height && place.top + 380 > anchorRect.y;
    expect(overlapsX && overlapsY).toBe(false);
  });

  it("flips the mobile sheet to the top when the agent is under it", () => {
    expect(placeAgentHoverCard({
      anchorX: 100,
      anchorY: 700,
      hostWidth: 390,
      hostHeight: 844,
      cardWidth: 366,
      cardHeight: 420,
      mobile: true,
      anchorRect: { x: 80, y: 660, width: 60, height: 80 },
    })).toEqual({ left: 12, top: 12, mobile: true });
  });
});
