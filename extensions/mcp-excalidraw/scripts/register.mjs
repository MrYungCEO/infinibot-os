#!/usr/bin/env node
/**
 * Register the @infinibot/mcp-excalidraw server with the local InfiniBot
 * config so agents can use it via `enabledMCPs: ["excalidraw"]`.
 *
 * Cross-platform: resolves absolute paths from this script's location,
 * so it works the same on Windows, macOS, and Linux without touching
 * any developer-machine specifics.
 *
 * What this writes:
 *   • ~/.infinibot/mcp-servers.json   ← MCP server config (preferred source)
 *   • ~/.infinibot/infinibot.json     ← adds `enabledMCPs: ["excalidraw"]`
 *                                       to the graphic-designer agent if
 *                                       it doesn't already include it
 *
 * Reads gateway URL/password from ~/.infinibot/infinibot.json so the
 * MCP server can connect to the running gateway on first start.
 *
 * Idempotent: safe to re-run after a `pnpm build` to re-anchor the
 * absolute path (e.g. after moving the repo).
 *
 * Usage:
 *   node extensions/mcp-excalidraw/scripts/register.mjs
 *   node extensions/mcp-excalidraw/scripts/register.mjs --agent <agentId>   # default: graphic-designer
 *   node extensions/mcp-excalidraw/scripts/register.mjs --no-agent          # only register the server, don't touch agents
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_NAME = "excalidraw";
const DEFAULT_AGENT = "graphic-designer";

function parseArgs(argv) {
  const args = { agent: DEFAULT_AGENT, attachAgent: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-agent") args.attachAgent = false;
    else if (a === "--agent") args.agent = argv[++i];
    else if (a.startsWith("--agent=")) args.agent = a.slice("--agent=".length);
  }
  return args;
}

function resolveStateDir() {
  const fromEnv = process.env.INFINIBOT_STATE_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(homedir(), ".infinibot");
}

function resolveServerEntrypoint() {
  // scripts/register.mjs → ../dist/index.js
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidate = path.resolve(here, "..", "dist", "index.js");
  if (!existsSync(candidate)) {
    throw new Error(
      `Built MCP entrypoint not found at ${candidate}.\n` +
        `Run \`pnpm --filter @infinibot/mcp-excalidraw build\` first ` +
        `(or \`cd extensions/mcp-excalidraw && pnpm build\`).`,
    );
  }
  return candidate;
}

function resolveNodeBinary() {
  // Prefer the same node that ran this script — it's almost certainly the
  // one the user wants the MCP spawned from. Fall back to bare "node" if
  // process.execPath looks weird (e.g. running under tsx).
  const exe = process.execPath;
  if (typeof exe === "string" && exe.toLowerCase().endsWith(process.platform === "win32" ? "node.exe" : "node")) {
    return exe;
  }
  return "node";
}

function readJsonOrEmpty(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

function writeJsonAtomic(p, data) {
  mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  try {
    renameSync(tmp, p);
  } catch {
    // Some Windows configurations (AV mid-scan, FS that doesn't support
    // atomic replace) reject rename-over-existing. Fall back to direct write.
    writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf8");
    try { unlinkSync(tmp); } catch { /* tmp already cleaned */ }
  }
}

function gatewayConnectionFromInfinibotConfig(stateDir) {
  const cfgPath = path.join(stateDir, "infinibot.json");
  const cfg = readJsonOrEmpty(cfgPath);
  const gw = cfg?.gateway ?? {};
  const port = typeof gw.port === "number" ? gw.port : 18789;
  const url = `ws://127.0.0.1:${port}`;
  const auth = gw.auth ?? {};
  return {
    url,
    token: typeof auth.token === "string" ? auth.token : undefined,
    password: typeof auth.password === "string" ? auth.password : undefined,
  };
}

function registerServer(stateDir, entrypoint, nodeBin, gw) {
  const file = path.join(stateDir, "mcp-servers.json");
  const existing = readJsonOrEmpty(file);
  const mcpServers = (existing.mcpServers && typeof existing.mcpServers === "object") ? { ...existing.mcpServers } : {};

  const env = { INFINIBOT_GATEWAY_URL: gw.url };
  if (gw.token) env.INFINIBOT_GATEWAY_TOKEN = gw.token;
  if (gw.password) env.INFINIBOT_GATEWAY_PASSWORD = gw.password;

  mcpServers[SERVER_NAME] = {
    command: nodeBin,
    args: [entrypoint],
    env,
  };

  const next = { ...existing, mcpServers };
  writeJsonAtomic(file, next);
  return file;
}

function attachServerToAgent(stateDir, agentId) {
  const cfgPath = path.join(stateDir, "infinibot.json");
  if (!existsSync(cfgPath)) {
    return { skipped: true, reason: `${cfgPath} not found — run \`infinibot setup\` first.` };
  }
  const cfg = readJsonOrEmpty(cfgPath);
  const list = Array.isArray(cfg?.agents?.list) ? cfg.agents.list.slice() : [];
  const idx = list.findIndex((a) => a?.id === agentId);
  if (idx < 0) {
    return { skipped: true, reason: `agent "${agentId}" not in config.agents.list` };
  }
  const agent = { ...list[idx] };
  const enabled = new Set(Array.isArray(agent.enabledMCPs) ? agent.enabledMCPs : []);
  if (enabled.has(SERVER_NAME)) {
    return { skipped: true, reason: `agent "${agentId}" already has "${SERVER_NAME}" enabled` };
  }
  enabled.add(SERVER_NAME);
  agent.enabledMCPs = [...enabled].sort();
  list[idx] = agent;
  cfg.agents = { ...(cfg.agents ?? {}), list };
  writeJsonAtomic(cfgPath, cfg);
  return { skipped: false, agentId, enabled: agent.enabledMCPs };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const stateDir = resolveStateDir();
  const entrypoint = resolveServerEntrypoint();
  const nodeBin = resolveNodeBinary();
  const gw = gatewayConnectionFromInfinibotConfig(stateDir);

  const serverFile = registerServer(stateDir, entrypoint, nodeBin, gw);
  console.log(`✓ registered "${SERVER_NAME}" MCP server`);
  console.log(`  config:    ${serverFile}`);
  console.log(`  command:   ${nodeBin}`);
  console.log(`  entry:     ${entrypoint}`);
  console.log(`  gateway:   ${gw.url}${gw.password ? " (password auth)" : gw.token ? " (token auth)" : " (no auth)"}`);

  if (args.attachAgent) {
    const result = attachServerToAgent(stateDir, args.agent);
    if (result.skipped) {
      console.log(`• agent attach skipped: ${result.reason}`);
    } else {
      console.log(`✓ enabled on agent "${result.agentId}" — enabledMCPs: [${result.enabled.join(", ")}]`);
    }
  }

  console.log("\nDone. Restart the gateway/agent runtime to pick up the change.");
}

try {
  main();
} catch (err) {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
