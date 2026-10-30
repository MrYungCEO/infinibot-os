import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { getMcpDefaultsForAgent } from "../gateway/agent-mcp-defaults.js";
import { STANDARD_AGENT_ROSTER } from "../agents/standard-roster.js";

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function source(relativePath: string): string {
  return fs.readFileSync(path.join(srcRoot, relativePath), "utf8");
}

describe("media provider core boundary", () => {
  it("does not grant the removed external FlyPic MCP server to agent roles", () => {
    for (const role of ["brand-designer", "designer", "graphic-designer"]) {
      expect(getMcpDefaultsForAgent(role)).not.toContain("flypic");
    }
  });

  it("lets content production roles consume tools from enabled plugins", () => {
    // The content roles moved out of the core roster into the content-studio
    // plugin's own roster; that is where their tool allowlist now lives.
    const rosterPath = path.resolve(srcRoot, "../extensions/content-studio/agents/roster.json");
    const roster = JSON.parse(fs.readFileSync(rosterPath, "utf8")) as {
      agents: Array<{ id: string; toolsAllow?: string[] }>;
    };
    for (const role of ["content-director", "brand-designer"]) {
      expect(
        STANDARD_AGENT_ROSTER.some((agent) => agent.id === role),
        role,
      ).toBe(false);
      const entry = roster.agents.find((agent) => agent.id === role);
      expect(entry?.toolsAllow, role).toContain("group:plugins");
    }
  });

  it("keeps storyboard and composition code provider-neutral", () => {
    const files = [
      "compositions/notes-edit-storyboard.ts",
      "compositions/notes-edit.ts",
      "compositions/notes-edit-ui.ts",
      "storyboard/image-generator.ts",
      "storyboard/types.ts",
    ];
    for (const file of files) {
      expect(source(file), file).not.toMatch(/flypic/i);
    }
    expect(fs.existsSync(path.join(srcRoot, "compositions/notes-edit-flypic.ts"))).toBe(false);
  });

  it("limits the old project id name to a one-way database migration", () => {
    const taskStore = source("tasks/store.ts");
    expect(taskStore.match(/flypicProjectId/g)).toHaveLength(2);
    expect(taskStore).toContain(
      "UPDATE project_meta SET mediaProjectId = flypicProjectId WHERE mediaProjectId IS NULL",
    );
  });
});
