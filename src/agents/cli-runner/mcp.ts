/**
 * InfiniBot tools for CLI model providers.
 *
 * A chat routed through a subscription CLI (claude-cli, codex-cli, …) keeps
 * InfiniBot's tools — memory, kanban, notes, workflows, message, … — by
 * handing the CLI the same `infinibot` MCP server claude_coder spawns use
 * (mcp/claude-code-register.ts buildInfinibotEntry). Tool calls go back
 * through the gateway, so its tool policy and approvals still apply, and are
 * attributed to the chat's own session key.
 *
 * Each CLI takes MCP config differently:
 *   claude    --mcp-config <file> --strict-mcp-config --allowedTools mcp__infinibot
 *   codex     -c mcp_servers.infinibot.* overrides (TOML values), tools pre-approved
 *   gemini    GEMINI_CLI_SYSTEM_SETTINGS_PATH → settings file with mcpServers
 *   opencode  OPENCODE_CONFIG_CONTENT → inline config with mcp.infinibot
 *   grok      not wired: Grok Build reads MCP servers only from config.toml
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { InfinibotConfig } from "../../config/config.js";
import type { CliStreamDialect } from "../../config/types.js";
import { resolveGatewayPort } from "../../config/paths.js";
import { INFINIBOT_MCP_ENTRY_KEY, buildInfinibotEntry } from "../../mcp/claude-code-register.js";

export type CliMcpInjection = {
  /** Args inserted before the session placeholder / prompt. */
  args: string[];
  env: Record<string, string>;
  cleanup: () => Promise<void>;
};

type StdioEntry = { command: string; args: string[]; env: Record<string, string> };

/** Which streaming dialects get InfiniBot tools. */
export function cliSupportsMcpTools(dialect: CliStreamDialect | undefined): boolean {
  return (
    dialect === "claude-stream-json" ||
    dialect === "codex-jsonl" ||
    dialect === "gemini-stream-json" ||
    dialect === "opencode-json"
  );
}

export function buildInfinibotStdioEntry(
  cfg: InfinibotConfig | undefined,
  sessionKey: string | undefined,
): StdioEntry {
  const auth = cfg?.gateway?.auth as { password?: unknown; token?: unknown } | undefined;
  const password = typeof auth?.password === "string" ? auth.password.trim() : "";
  const token = typeof auth?.token === "string" ? auth.token.trim() : "";
  const entry = buildInfinibotEntry({
    gatewayUrl: `ws://127.0.0.1:${resolveGatewayPort(cfg)}`,
    gatewayToken: token || undefined,
    gatewayPassword: password || undefined,
    defaultSessionKey: sessionKey,
  }) as { command: string; args: string[]; env: Record<string, string> };
  return { command: entry.command, args: entry.args, env: entry.env };
}

/** TOML basic string. */
function toml(value: string): string {
  return JSON.stringify(value);
}

export async function prepareCliMcp(params: {
  dialect: CliStreamDialect;
  cfg: InfinibotConfig | undefined;
  sessionKey: string | undefined;
  /** Test seam. */
  entry?: StdioEntry;
}): Promise<CliMcpInjection | null> {
  if (!cliSupportsMcpTools(params.dialect)) return null;
  const entry = params.entry ?? buildInfinibotStdioEntry(params.cfg, params.sessionKey);
  const name = INFINIBOT_MCP_ENTRY_KEY;

  if (params.dialect === "codex-jsonl") {
    const envToml = `{${Object.entries(entry.env)
      .map(([k, v]) => `${k}=${toml(v)}`)
      .join(",")}}`;
    return {
      args: [
        "-c",
        `mcp_servers.${name}.command=${toml(entry.command)}`,
        "-c",
        `mcp_servers.${name}.args=[${entry.args.map(toml).join(",")}]`,
        "-c",
        `mcp_servers.${name}.env=${envToml}`,
        "-c",
        `mcp_servers.${name}.enabled=true`,
        // `codex exec` runs with approval policy "never", which otherwise
        // fails every MCP call ("requires approval"). The gateway still
        // applies its own tool policy and approvals to each call.
        "-c",
        `mcp_servers.${name}.default_tools_approval_mode="approve"`,
      ],
      env: {},
      cleanup: async () => {},
    };
  }

  if (params.dialect === "opencode-json") {
    return {
      args: [],
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          mcp: {
            [name]: {
              type: "local",
              command: [entry.command, ...entry.args],
              environment: entry.env,
              enabled: true,
            },
          },
        }),
      },
      cleanup: async () => {},
    };
  }

  // Claude + Gemini read a JSON file. It holds the gateway credential, so it
  // lives in a private temp dir and is removed after the turn.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "infinibot-cli-mcp-"));
  const file = path.join(
    dir,
    params.dialect === "gemini-stream-json" ? "settings.json" : "mcp.json",
  );
  const cleanup = async () => {
    await fs.rm(dir, { recursive: true, force: true });
  };
  if (params.dialect === "gemini-stream-json") {
    await fs.writeFile(
      file,
      JSON.stringify({ mcpServers: { [name]: { ...entry, trust: true } } }),
      { mode: 0o600 },
    );
    return { args: [], env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: file }, cleanup };
  }
  await fs.writeFile(
    file,
    JSON.stringify({ mcpServers: { [name]: { type: "stdio", ...entry } } }),
    { mode: 0o600 },
  );
  return {
    args: ["--mcp-config", file, "--strict-mcp-config", "--allowedTools", `mcp__${name}`],
    env: {},
    cleanup,
  };
}
