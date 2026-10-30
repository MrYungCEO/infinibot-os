/**
 * Every place that picks a coder backend / CLI accepts Grok Build: config
 * schema, coder tools, queue phases, goal backends, voice CLI turns, terminal
 * launches and the tool allowlists.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateConfigObject } from "../../config/validation.js";
import { createClaudeCoderTool, createGrokCoderTool } from "../tools/claude-coder-tool.js";
import {
  QUEUE_CLI_BACKENDS,
  authStateFor,
  mapModelForBackend,
  resolveAgent,
} from "../../queue/backends.js";
import {
  VOICE_LLM_BACKENDS,
  buildCliInvocation,
  parseCliStreamLine,
} from "../../gateway/voice/voice-llm-turn.js";
import {
  buildAgentCLIShellCommand,
  getCLIDisplayName,
} from "../../terminal/agent-cli-integration-handler.js";
import { KNOWN_CLIS } from "../../gateway/voice/voice-cli-sessions.js";
import { coderForBackend } from "../coder-install/catalog.js";
import { TOOL_GROUPS } from "../tool-policy.js";
import { resolveOrchestratorBackend } from "../../autonomy/orchestrator-backends.js";

describe("config schema accepts grok wherever a coder backend is chosen", () => {
  it("coder.backend", () => {
    expect(validateConfigObject({ coder: { backend: "grok" } }).ok).toBe(true);
    expect(validateConfigObject({ coder: { backend: "grok-cli" } }).ok).toBe(false);
  });

  it("per-agent default / fallback coder backend and terminal execution cli", () => {
    const res = validateConfigObject({
      agents: {
        list: [
          {
            id: "coder",
            defaultCoderBackend: "grok",
            fallbackCoderBackend: "gemini",
            execution: { mode: "terminal", cli: "grok" },
          },
        ],
      },
    });
    expect(res.ok).toBe(true);
  });

  it("autonomy goal-mode backend { kind: grok }", () => {
    expect(validateConfigObject({ autonomy: { defaultBackend: { kind: "grok" } } }).ok).toBe(true);
  });
});

describe("coder tools", () => {
  it("claude_coder backend enum lists grok", () => {
    const schema = createClaudeCoderTool().parameters as {
      properties: { backend: { enum?: string[]; anyOf?: Array<{ const: string }> } };
    };
    const b = schema.properties.backend;
    const values = b.enum ?? b.anyOf?.map((x) => x.const) ?? [];
    expect(values).toEqual(
      expect.arrayContaining(["claude-code", "codex", "opencode", "gemini", "grok"]),
    );
  });

  it("grok_coder is a pinned tool with no backend param", () => {
    const tool = createGrokCoderTool();
    expect(tool.name).toBe("grok_coder");
    const props = (tool.parameters as { properties: Record<string, unknown> }).properties;
    expect(props.backend).toBeUndefined();
    expect(props.task).toBeDefined();
  });

  it("grok_coder is in the sessions tool group next to codex_coder", () => {
    const group = Object.values(TOOL_GROUPS).find((g) => g.includes("codex_coder"));
    expect(group).toContain("grok_coder");
  });
});

describe("Setup › Coders catalog", () => {
  it("Grok Build maps to the grok coder backend (sub-agents, not terminal-only)", () => {
    expect(coderForBackend("grok")?.id).toBe("grok-build");
  });
});

describe("queue phases / scheduled tasks / goals", () => {
  it("grok is a queue CLI backend with aliases", () => {
    expect(QUEUE_CLI_BACKENDS).toContain("grok");
    for (const a of ["grok", "grok-cli", "grok-build"]) {
      expect(resolveAgent(a)).toMatchObject({ kind: "cli", backend: "grok" });
    }
  });

  it("model mapping keeps grok models and drops other vendors", () => {
    expect(mapModelForBackend("grok", "grok-4.6").model).toBe("grok-4.6");
    expect(mapModelForBackend("grok", "xai/grok-4.6").model).toBe("grok-4.6");
    expect(mapModelForBackend("grok", "gpt-5").model).toBeUndefined();
  });

  it("auth: ~/.grok/auth.json (GROK_HOME honoured) means signed in", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-auth-"));
    const prevHome = process.env.GROK_HOME;
    const prevKey = process.env.XAI_API_KEY;
    delete process.env.XAI_API_KEY;
    process.env.GROK_HOME = path.join(home, ".grok");
    try {
      expect(authStateFor("grok", home)).toBe("auth-required");
      fs.mkdirSync(path.join(home, ".grok"));
      fs.writeFileSync(path.join(home, ".grok", "auth.json"), "{}");
      expect(authStateFor("grok", home)).toBe("ok");
    } finally {
      if (prevHome === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prevHome;
      if (prevKey !== undefined) process.env.XAI_API_KEY = prevKey;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("autonomy goal-mode grok backend plans + works on Grok Build", () => {
    const r = resolveOrchestratorBackend({ kind: "grok" });
    expect(r.workerCoderBackend).toBe("grok");
    expect(r.plannerProvider).toBe("xai");
    expect(r.displayName).toBe("Grok Build");
  });
});

describe("voice", () => {
  it("grok is a voice CLI backend with a streaming-json invocation", () => {
    expect(VOICE_LLM_BACKENDS).toContain("grok");
    const inv = buildCliInvocation("grok", {
      bin: "grok",
      message: "hi",
      system: "sys",
      trusted: false,
    });
    expect(inv.args).toEqual(
      expect.arrayContaining(["--output-format", "streaming-json", "--disallowed-tools"]),
    );
    expect(inv.args.at(-2)).toBe("-p");
    const resumed = buildCliInvocation("grok", {
      bin: "grok",
      message: "again",
      system: "sys",
      resume: "s1",
      trusted: true,
    });
    expect(resumed.args).toContain("--resume");
    expect(resumed.args.at(-1)).toBe("again");
    expect(resumed.args).not.toContain("--disallowed-tools");
  });

  it("parses Grok text chunks as deltas and end as the session id", () => {
    expect(parseCliStreamLine(JSON.stringify({ type: "text", data: "Hel" }))).toMatchObject({
      delta: "Hel",
    });
    expect(parseCliStreamLine(JSON.stringify({ type: "end", sessionId: "s-2" }))?.sessionId).toBe(
      "s-2",
    );
  });

  it("voice CLI session picker can start Grok Build", () => {
    expect(KNOWN_CLIS.find((c) => c.id === "grok")).toMatchObject({
      managed: true,
      coderId: "grok",
    });
  });
});

describe("terminals", () => {
  it("launches grok with its own auto-approve flag and model", () => {
    const cmd = buildAgentCLIShellCommand("grok", {
      cli: "grok",
      options: { dangerouslySkipPermissions: true, model: "grok-4.6" },
    });
    expect(cmd).toContain("grok");
    expect(cmd).toContain("--always-approve");
    expect(cmd).toContain("grok-4.6");
    expect(getCLIDisplayName("grok")).toBe("Grok");
  });
});
