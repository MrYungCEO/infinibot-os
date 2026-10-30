import { describe, expect, it } from "vitest";
import type { InfinibotConfig } from "../config/config.js";
import {
  resolveAgentConfig,
  resolveAgentModelFallbacksOverride,
  resolveAgentModelPrimary,
} from "./agent-scope.js";

describe("resolveAgentConfig", () => {
  it("should return undefined when no agents config exists", () => {
    const cfg: InfinibotConfig = {};
    const result = resolveAgentConfig(cfg, "main");
    expect(result).toBeUndefined();
  });

  it("should return undefined when agent id does not exist", () => {
    const cfg: InfinibotConfig = {
      agents: {
        list: [{ id: "main", workspace: "~/clawd" }],
      },
    };
    const result = resolveAgentConfig(cfg, "nonexistent");
    expect(result).toBeUndefined();
  });

  it("should return basic agent config", () => {
    const cfg: InfinibotConfig = {
      agents: {
        list: [
          {
            id: "main",
            name: "Main Agent",
            workspace: "~/clawd",
            agentDir: "~/.infinibot/agents/main",
            model: "anthropic/claude-opus-4",
          },
        ],
      },
    };
    const result = resolveAgentConfig(cfg, "main");
    expect(result).toEqual({
      name: "Main Agent",
      workspace: "~/clawd",
      agentDir: "~/.infinibot/agents/main",
      model: "anthropic/claude-opus-4",
      identity: undefined,
      groupChat: undefined,
      subagents: undefined,
      sandbox: undefined,
      tools: undefined,
    });
  });

  it("supports per-agent model primary+fallbacks", () => {
    const cfg: InfinibotConfig = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-sonnet-4",
            fallbacks: ["openai/gpt-4.1"],
          },
        },
        list: [
          {
            id: "linus",
            model: {
              primary: "anthropic/claude-opus-4",
              fallbacks: ["openai/gpt-5.2"],
            },
          },
        ],
      },
    };

    expect(resolveAgentModelPrimary(cfg, "linus")).toBe("anthropic/claude-opus-4");
    expect(resolveAgentModelFallbacksOverride(cfg, "linus")).toEqual(["openai/gpt-5.2"]);

    // If fallbacks isn't present, we don't override the global fallbacks.
    const cfgNoOverride: InfinibotConfig = {
      agents: {
        list: [
          {
            id: "linus",
            model: {
              primary: "anthropic/claude-opus-4",
            },
          },
        ],
      },
    };
    expect(resolveAgentModelFallbacksOverride(cfgNoOverride, "linus")).toBe(undefined);

    // Explicit empty list disables global fallbacks for that agent.
    const cfgDisable: InfinibotConfig = {
      agents: {
        list: [
          {
            id: "linus",
            model: {
              primary: "anthropic/claude-opus-4",
              fallbacks: [],
            },
          },
        ],
      },
    };
    expect(resolveAgentModelFallbacksOverride(cfgDisable, "linus")).toEqual([]);
  });

  it("should return agent-specific sandbox config", () => {
    const cfg: InfinibotConfig = {
      agents: {
        list: [
          {
            id: "work",
            workspace: "~/clawd-work",
            sandbox: {
              mode: "all",
              scope: "agent",
              perSession: false,
              workspaceAccess: "ro",
              workspaceRoot: "~/sandboxes",
            },
          },
        ],
      },
    };
    const result = resolveAgentConfig(cfg, "work");
    expect(result?.sandbox).toEqual({
      mode: "all",
      scope: "agent",
      perSession: false,
      workspaceAccess: "ro",
      workspaceRoot: "~/sandboxes",
    });
  });

  it("should return agent-specific tools config", () => {
    const cfg: InfinibotConfig = {
      agents: {
        list: [
          {
            id: "restricted",
            workspace: "~/clawd-restricted",
            tools: {
              allow: ["read"],
              deny: ["exec", "write", "edit"],
              elevated: {
                enabled: false,
                allowFrom: { whatsapp: ["+15555550123"] },
              },
            },
          },
        ],
      },
    };
    const result = resolveAgentConfig(cfg, "restricted");
    expect(result?.tools).toEqual({
      allow: ["read"],
      deny: ["exec", "write", "edit"],
      elevated: {
        enabled: false,
        allowFrom: { whatsapp: ["+15555550123"] },
      },
    });
  });

  it("should return both sandbox and tools config", () => {
    const cfg: InfinibotConfig = {
      agents: {
        list: [
          {
            id: "family",
            workspace: "~/clawd-family",
            sandbox: {
              mode: "all",
              scope: "agent",
            },
            tools: {
              allow: ["read"],
              deny: ["exec"],
            },
          },
        ],
      },
    };
    const result = resolveAgentConfig(cfg, "family");
    expect(result?.sandbox?.mode).toBe("all");
    expect(result?.tools?.allow).toEqual(["read"]);
  });

  it("should normalize agent id", () => {
    const cfg: InfinibotConfig = {
      agents: {
        list: [{ id: "main", workspace: "~/clawd" }],
      },
    };
    // Should normalize to "main" (default)
    const result = resolveAgentConfig(cfg, "");
    expect(result).toBeDefined();
    expect(result?.workspace).toBe("~/clawd");
  });

  // ── federation/coder-spawn regression: type:cli + cliCommand must synthesise
  //    an execution block so coder-claude/coder-codex agents take the terminal
  //    path during sessions_spawn instead of silently falling through to
  //    agent-loop. These agents are seeded by the standard roster which writes
  //    type:"cli" + cliCommand but no explicit execution block.
  describe("CLI agent execution synthesis", () => {
    it("synthesises execution.mode=terminal from type:cli + cliCommand for coder-claude", () => {
      const cfg = {
        agents: {
          list: [
            {
              id: "coder-claude",
              name: "CLAUDE CODE",
              type: "cli",
              cliCommand: "claude",
            },
          ],
        },
      } as unknown as InfinibotConfig;

      const result = resolveAgentConfig(cfg, "coder-claude");
      expect(result).toBeDefined();
      expect(result?.execution?.mode).toBe("terminal");
      expect(result?.execution?.cli).toBe("claude");
    });

    it("synthesises execution.mode=terminal from type:cli + cliCommand for coder-codex", () => {
      const cfg = {
        agents: {
          list: [
            {
              id: "coder-codex",
              name: "CODEX",
              type: "cli",
              cliCommand: "codex",
            },
          ],
        },
      } as unknown as InfinibotConfig;

      const result = resolveAgentConfig(cfg, "coder-codex");
      expect(result?.execution?.mode).toBe("terminal");
      expect(result?.execution?.cli).toBe("codex");
    });

    it("synthesises execution.mode=terminal for coder-opencode", () => {
      const cfg = {
        agents: {
          list: [
            {
              id: "coder-opencode",
              name: "OPENCODE",
              type: "cli",
              cliCommand: "opencode",
            },
          ],
        },
      } as unknown as InfinibotConfig;

      const result = resolveAgentConfig(cfg, "coder-opencode");
      expect(result?.execution?.mode).toBe("terminal");
      expect(result?.execution?.cli).toBe("opencode");
    });

    it("does NOT synthesise execution for type:native agents", () => {
      const cfg: InfinibotConfig = {
        agents: {
          list: [{ id: "main", workspace: "~/clawd" }],
        },
      };

      const result = resolveAgentConfig(cfg, "main");
      // No synthesised execution — native agents use agent-loop
      expect(result?.execution).toBeUndefined();
    });

    it("explicit execution block takes priority over type:cli synthesis", () => {
      const cfg = {
        agents: {
          list: [
            {
              id: "coder-claude",
              type: "cli",
              cliCommand: "claude",
              // Explicit override — e.g. operator set mode:agent-loop intentionally
              execution: {
                mode: "agent-loop",
              },
            },
          ],
        },
      } as unknown as InfinibotConfig;

      const result = resolveAgentConfig(cfg, "coder-claude");
      // Explicit execution wins over synthesised one
      expect(result?.execution?.mode).toBe("agent-loop");
    });

    it("does not synthesise if cliCommand is empty string", () => {
      const cfg = {
        agents: {
          list: [
            {
              id: "coder-claude",
              type: "cli",
              cliCommand: "   ", // whitespace-only
            },
          ],
        },
      } as unknown as InfinibotConfig;

      const result = resolveAgentConfig(cfg, "coder-claude");
      expect(result?.execution).toBeUndefined();
    });
  });
});
