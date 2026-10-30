/**
 * Standalone stdio entry for the infinibot MCP server.
 *
 * Claude Code spawns this as a child process and speaks the MCP protocol
 * over its stdin/stdout. Unlike `mcp-cli.ts` (which just registers a
 * Commander subcommand on the main CLI), this file is directly runnable:
 *   node dist/cli/mcp-stdio.js
 *
 * Configuration comes from env vars that our claude-code-register writes
 * into the `~/.claude.json` entry:
 *   MOLTBOT_GATEWAY_URL     — ws://host:port of the running gateway
 *   MOLTBOT_GATEWAY_TOKEN   — bearer token (optional, for token-mode gateways)
 *   MOLTBOT_GATEWAY_PASSWORD — shared password (optional, for password-mode gateways)
 *   MOLTBOT_DEFAULT_SESSION_KEY — session key for attributed activity (optional)
 *   MOLTBOT_MCP_VERBOSE     — "1" to enable diagnostic logging to stderr
 * With neither TOKEN nor PASSWORD set (entries written by Setup › AI apps),
 * the credential is read from the InfiniBot config (INFINIBOT_STATE_DIR).
 */

import os from "node:os";
import { randomBytes } from "node:crypto";

import { ensureStateDirEnv } from "../config/paths.js";
import { runMcpServer } from "../mcp/server.js";

async function main(): Promise<void> {
  // Split-brain guard: normally this process inherits INFINIBOT_STATE_DIR from
  // its parent (gateway → detached coder agent → here). When launched
  // standalone with a stripped env, pin it to the canonical state dir so any
  // in-process store resolves the SAME directory as the gateway rather than a
  // repo-local `<cwd>/state`. No-op when the var is already set/inherited.
  ensureStateDirEnv();

  const url = process.env.MOLTBOT_GATEWAY_URL?.trim() || "ws://127.0.0.1:18789";
  let token = process.env.MOLTBOT_GATEWAY_TOKEN?.trim() || undefined;
  let password = process.env.MOLTBOT_GATEWAY_PASSWORD?.trim() || undefined;
  // Entries written by Setup › AI apps carry no secret: read the credential
  // from the InfiniBot config so it never lands in another app's config file.
  if (!token && !password) {
    // stdout is the MCP channel: keep any config-loader chatter on stderr.
    const saved = { log: console.log, info: console.info, debug: console.debug };
    console.log = console.info = console.debug = (...a: unknown[]) => console.error(...a);
    try {
      const [{ loadConfig }, { resolveGatewayAuth }] = await Promise.all([
        import("../config/io.js"),
        import("../gateway/auth.js"),
      ]);
      const auth = resolveGatewayAuth({ authConfig: loadConfig().gateway?.auth });
      if (auth.mode === "password") password = auth.password?.trim() || undefined;
      else token = auth.token?.trim() || undefined;
    } catch (err) {
      process.stderr.write(
        `[infinibot-mcp] could not read the gateway credential from the InfiniBot config: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    } finally {
      Object.assign(console, saved);
    }
  }
  const verbose = (process.env.MOLTBOT_MCP_VERBOSE ?? "").toLowerCase() === "1";

  // Each Claude CLI / MCP client gets its own sessionKey so it shows up as a
  // distinct row in the activity feed. If the parent (e.g. terminal.create)
  // injected MOLTBOT_DEFAULT_SESSION_KEY we use that; otherwise we mint a
  // hostname/pid-tagged key that survives for the lifetime of this MCP
  // process. INFINIBOT_SESSION_KEY is the fallback name used by terminal-
  // spawned PTYs, so we honor that too.
  const explicitKey =
    process.env.MOLTBOT_DEFAULT_SESSION_KEY?.trim() ||
    process.env.INFINIBOT_SESSION_KEY?.trim() ||
    undefined;
  const host = (os.hostname() || "host").replace(/[^a-z0-9-]/gi, "").slice(0, 16) || "host";
  const tag = randomBytes(3).toString("hex");
  const sessionKey = explicitKey || `agent:main:mcp-${host}-${process.pid}-${tag}`;

  // Friendly label for the activity feed. Pulled from env so callers can
  // override (e.g. terminal.create can pass a CLI-specific label).
  const sessionLabel =
    process.env.MOLTBOT_SESSION_LABEL?.trim() || `Claude Code · ${host} · pid ${process.pid}`;

  try {
    await runMcpServer({
      gatewayUrl: url,
      gatewayToken: token,
      gatewayPassword: password,
      defaultSessionKey: sessionKey,
      defaultSessionLabel: sessionLabel,
      verbose,
      rejectUnauthorized: false,
    });
  } catch (err) {
    // Write the error to stderr so Claude Code's MCP logs show something
    // actionable instead of silently dropping the server.
    process.stderr.write(
      `[infinibot-mcp] failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}

void main();
