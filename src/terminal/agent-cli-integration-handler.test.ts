import { describe, expect, it } from "vitest";

import { buildAgentCLIShellCommand } from "./agent-cli-integration-handler.js";

describe("buildAgentCLIShellCommand", () => {
  it("passes Codex search and initial prompt as CLI arguments", () => {
    const command = buildAgentCLIShellCommand("codex", {
      cli: "codex",
      cwd: "/repo",
      options: {
        extraFlags: ["--search"],
        initialPrompt: "Find latest AI news.",
      },
    });

    expect(command).toContain("codex --dangerously-bypass-approvals-and-sandbox");
    expect(command).toContain("--search 'Find latest AI news.'");
    expect(command).toContain("cd /repo &&");
  });

  it("passes model through for Codex", () => {
    const command = buildAgentCLIShellCommand("codex", {
      cli: "codex",
      options: {
        model: "gpt-5.2-codex",
      },
    });

    expect(command).toContain("codex --dangerously-bypass-approvals-and-sandbox");
    expect(command).toContain("--model gpt-5.2-codex");
  });
});
