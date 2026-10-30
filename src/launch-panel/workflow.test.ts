import { describe, expect, it } from "vitest";
import { topologicalLayers } from "../shared/group-chat/workflow-graph.js";
import { DEFAULT_LAUNCH_PERSONAS } from "./personas.js";
import {
  DEFAULT_LAUNCH_FLOWS,
  assignPersonasToAgents,
  buildLaunchPanelWorkflow,
} from "./workflow.js";

describe("Launch Panel room turn-taking", () => {
  it("serializes browser work to one workflow step per layer", () => {
    const personas = DEFAULT_LAUNCH_PERSONAS.slice(0, 5);
    const workflow = buildLaunchPanelWorkflow({
      assignments: assignPersonasToAgents(personas, ["alpha", "beta"]),
      moderatorAgentId: "moderator",
      url: "https://example.com",
      flows: DEFAULT_LAUNCH_FLOWS,
      credentialsPath: "/tmp/launch-panel-secrets.json",
      runId: "lp-test-run",
      depth: "standard",
    });
    const layers = topologicalLayers(workflow);
    expect(workflow.nodes).toHaveLength(16);
    expect(layers.every((layer) => layer.length === 1)).toBe(true);
    expect(layers.at(-1)?.[0]?.id).toBe("r4-moderator");
    const personaPrompt = workflow.nodes.find(
      (node) => node.id === "r2-nontechnical-beginner",
    )?.prompt;
    expect(personaPrompt).toContain("launch-panel://lp-test-run/nontechnical-beginner/password");
    expect(personaPrompt).toContain('browser({ action: "resize", value: "390x844" })');
    expect(personaPrompt).toContain("Do not call `read`");
  });

  it("reuses available configured agents while preserving persona-specific steps", () => {
    const assignments = assignPersonasToAgents(DEFAULT_LAUNCH_PERSONAS.slice(0, 5), [
      "alpha",
      "beta",
    ]);
    expect(assignments.map((a) => a.agentId)).toEqual(["alpha", "beta", "alpha", "beta", "alpha"]);
    expect(new Set(assignments.map((a) => a.persona.id)).size).toBe(5);
  });
});
