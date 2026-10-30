/**
 * GrokCliBackend — wraps xAI's Grok Build CLI (`grok`).
 *
 * From the Grok Build user guide (headless mode, ~/.grok/docs/user-guide/14):
 *   Install:         Setup › Coders (prebuilt binary from x.ai/cli) or
 *                    `curl -fsSL https://x.ai/cli/install.sh | bash`
 *   Binary:          grok            Version: grok --version
 *   Headless:        grok -p "<prompt>"  (or --prompt-file <path>; headless
 *                    mode never reads piped stdin)
 *   Output:          --output-format streaming-json → JSONL events:
 *                      {type:"text",data} {type:"thought",data}
 *                      {type:"tool_call",toolCallId,toolName,rawInput,…}
 *                      {type:"tool_call_update",toolCallId,status,rawOutput,…}
 *                      {type:"usage",usage} {type:"error",message}
 *                      {type:"end",sessionId,usage,…}  (always last)
 *   Auto-approve:    --always-approve (alias --yolo)
 *   Model:           -m <model>  (omitted → the account's default)
 *   Resume:          -r/--resume <session-id>
 *   Working dir:     --cwd <path>
 *   MCP servers:     [mcp_servers.<name>] in ~/.grok/config.toml (GROK_HOME
 *                    relocates ~/.grok). Grok also reads ~/.claude.json, so
 *                    the InfiniBot entry registered for Claude Code reaches it
 *                    too; registerInfinibotInGrok makes it explicit.
 *   Auth:            `grok login --device-auth` (SuperGrok / X Premium+), or
 *                    XAI_API_KEY.
 *   System prompt:   no replace flag — preamble is folded into the prompt.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawnCli } from "../../process/win-spawn.js";
import {
  exceedsInlineArgLimit,
  inlineArgvFits,
  spawnCoderProcess,
  writeRunPromptFile,
} from "./durable-spawn.js";
import {
  isSkillSystemEnabled,
  buildClaudeCoderPreamble,
  triggerPostMortem,
  triggerReflection,
  isSubstantialRun,
} from "../claude-code/skill-system.js";
import { generateMCPConfig, cleanupMCPConfig } from "../claude-code/mcp-bridge.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createCliCreditHook } from "./cli-credit-hook.js";
import { checkCliInstalled, enrichedPath, resolveBin, osInstallHint } from "./bin-detect.js";
import { applyCoderSpawnEnv } from "../coder-install/keys.js";
import type { CLIAgentConfig } from "../types/agent-types.js";
import type { SessionInfo, LaunchOptions, BackgroundSession } from "../claude-code/launcher.js";
import type {
  CoderBackend,
  CoderBackendCapabilities,
  BackendInstallStatus,
  McpServerEntry,
} from "./types.js";
import { allowCoderBypassFlag } from "./approval-policy.js";
import { CappedOutput } from "./capped-output.js";
import { parseTomlSections, serializeTomlDoc, type TomlDoc } from "./codex.js";

const log = createSubsystemLogger("grok-backend");

const GROK_STDIO: ["ignore", "pipe", "pipe"] = ["ignore", "pipe", "pipe"];

/** xAI API keys kept away from a subscription sign-in (re-added only when saved for Grok Build). */
const GROK_CLEARED_ENV = ["XAI_API_KEY", "GROK_CODE_XAI_API_KEY"] as const;

/** Models offered in pickers; the CLI also accepts any id its account lists. */
export const GROK_MODELS: string[] = ["grok-build", "grok-4.6", "grok-code-fast-1"];

// ── Path helpers ───────────────────────────────────────────────────────────

function grokHome(): string {
  return process.env.GROK_HOME ?? join(homedir(), ".grok");
}

function grokConfigPath(): string {
  return join(grokHome(), "config.toml");
}

function repoRoot(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return resolve(here, "..", "..", "..");
  } catch {
    return process.cwd();
  }
}

// ── ~/.grok/config.toml [mcp_servers.<name>] ───────────────────────────────

function readGrokConfigDoc(): TomlDoc {
  const p = grokConfigPath();
  if (!existsSync(p)) return { preamble: [], sections: new Map(), order: [] };
  try {
    return parseTomlSections(readFileSync(p, "utf8"));
  } catch {
    return { preamble: [], sections: new Map(), order: [] };
  }
}

function writeGrokConfigDoc(doc: TomlDoc): void {
  mkdirSync(grokHome(), { recursive: true });
  writeFileSync(grokConfigPath(), serializeTomlDoc(doc), "utf8");
}

function tomlInline(obj: Record<string, string>): string {
  return `{ ${Object.entries(obj)
    .map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`)
    .join(", ")} }`;
}

/** Render an MCP entry as the body of a Grok `[mcp_servers.<name>]` table. */
export function grokMcpTomlLines(entry: McpServerEntry): string[] {
  const lines: string[] = [];
  if (entry.url) {
    lines.push(`url = ${JSON.stringify(entry.url)}`);
    if (entry.headers && Object.keys(entry.headers).length > 0) {
      lines.push(`headers = ${tomlInline(entry.headers)}`);
    }
  } else {
    if (entry.command) lines.push(`command = ${JSON.stringify(entry.command)}`);
    if (entry.args && entry.args.length > 0) {
      lines.push(`args = [${entry.args.map((a) => JSON.stringify(a)).join(", ")}]`);
    }
    if (entry.env && Object.keys(entry.env).length > 0) {
      lines.push(`env = ${tomlInline(entry.env)}`);
    }
  }
  if (entry.enabled === false) lines.push("enabled = false");
  return lines;
}

// ── CLI argument builder ───────────────────────────────────────────────────

function buildGrokArgs(
  config: CLIAgentConfig,
  options: LaunchOptions,
  workdir: string | undefined,
  prompt: { inline: string } | { file: string },
): string[] {
  const args: string[] = ["--output-format", "streaming-json", "--no-auto-update"];
  if (options.model) args.push("-m", options.model);
  if (allowCoderBypassFlag(config.autoApprove)) args.push("--always-approve");
  if (options.resumeSessionId) args.push("--resume", options.resumeSessionId);
  if (workdir) args.push("--cwd", workdir);
  if (config.cliArgs && config.cliArgs.length > 0) args.push(...config.cliArgs);
  if ("file" in prompt) args.push("--prompt-file", prompt.file);
  else args.push("-p", prompt.inline);
  return args;
}

/**
 * Build the argv for one run. A prompt too large for argv (E2BIG above
 * 128 KiB) goes in the run's `prompt.txt` via `--prompt-file`.
 */
export function buildGrokLaunch(
  config: CLIAgentConfig,
  task: string,
  options: LaunchOptions,
  runId: string,
  workdir?: string,
): { args: string[] } {
  const inline = buildGrokArgs(config, options, workdir, { inline: task });
  if (!exceedsInlineArgLimit(task) && inlineArgvFits(config.cliCommand || "grok", inline))
    return { args: inline };
  const file = writeRunPromptFile(runId, "prompt.txt", task);
  return { args: buildGrokArgs(config, options, workdir, { file }) };
}

export function buildGrokArgsForTest(
  config: CLIAgentConfig,
  task: string,
  options: LaunchOptions = {},
  workdir?: string,
): string[] {
  return buildGrokArgs(config, options, workdir, { inline: task });
}

function buildGrokEnv(config: CLIAgentConfig, options: LaunchOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.PATH = enrichedPath();
  // The gateway's own XAI_API_KEY (an API provider key) must not turn a
  // subscription sign-in into billed API usage. A key stored for Grok Build
  // in Setup › Coders is re-applied right after.
  for (const key of GROK_CLEARED_ENV) delete env[key];
  applyCoderSpawnEnv("grok", env);
  if (config.env) for (const [k, v] of Object.entries(config.env)) env[k] = v;
  if (options.env) for (const [k, v] of Object.entries(options.env)) env[k] = v;
  return env;
}

// ── Output parser ──────────────────────────────────────────────────────────

export function parseGrokOutput(stdout: string): {
  text: string;
  sessionId?: string;
  error?: string;
  json?: Record<string, unknown>;
} {
  let text = "";
  let sessionId: string | undefined;
  let error: string | undefined;
  let end: Record<string, unknown> | undefined;
  for (const line of stdout.split("\n")) {
    const l = line.trim();
    if (!l || l[0] !== "{") continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(l) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof ev.sessionId === "string") sessionId = ev.sessionId;
    if (ev.type === "text" && typeof ev.data === "string") text += ev.data;
    else if (ev.type === "error")
      error = typeof ev.message === "string" ? ev.message : "Grok Build reported an error";
    else if (ev.type === "end") end = ev;
  }
  if (!text && !end && stdout.trim() && !stdout.trim().startsWith("{")) text = stdout.trim();
  return { text: text || error || "", sessionId, error, json: end };
}

// ── Backend class ──────────────────────────────────────────────────────────

export class GrokCliBackend implements CoderBackend {
  readonly id = "grok" as const;

  async spawn(
    config: CLIAgentConfig,
    task: string,
    workdir: string,
    options: LaunchOptions = {},
  ): Promise<SessionInfo> {
    const bg = this.spawnBackground(config, task, workdir, { ...options, durableRunId: undefined });
    return bg.finalPromise;
  }

  spawnBackground(
    config: CLIAgentConfig,
    task: string,
    workdir: string,
    options: LaunchOptions = {},
  ): BackgroundSession {
    const runId = options.runId ?? randomUUID();
    const startedAt = Date.now();
    const { effectiveTask, launchOptions } = this.prepareTask(task, workdir, options);
    const mcpSync = generateMCPConfig(config);
    const command = resolveBin("grok") ?? "grok";
    const { args } = buildGrokLaunch(config, effectiveTask, launchOptions, runId, workdir);
    const env = buildGrokEnv(config, launchOptions);
    const timeoutMs = config.timeoutMinutes * 60_000;

    const stdoutSubs = new Set<(chunk: string) => void>();
    const stderrSubs = new Set<(chunk: string) => void>();
    const child = options.durableRunId
      ? spawnCoderProcess(
          command,
          args,
          { stdio: GROK_STDIO, cwd: workdir, env },
          options.durableRunId,
          { unsetEnv: GROK_CLEARED_ENV },
        )
      : spawnCli(command, args, { stdio: GROK_STDIO, cwd: workdir, env });
    if (options.durableRunId) child.unref?.();

    const stdoutBuf = new CappedOutput();
    const stderrBuf = new CappedOutput(16 * 1024, 1024 * 1024);
    const creditHook = createCliCreditHook({
      backend: "grok",
      agentId: config.id,
      taskId: runId,
      defaultProvider: "xai",
      defaultModel: launchOptions.model ?? "grok-build",
    });

    child.stdout?.on("data", (d: Buffer) => {
      const chunk = d.toString();
      stdoutBuf.push(chunk);
      creditHook.feed(chunk);
      for (const fn of stdoutSubs) {
        try {
          fn(chunk);
        } catch {
          /* ignore */
        }
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      const chunk = d.toString();
      stderrBuf.push(chunk);
      for (const fn of stderrSubs) {
        try {
          fn(chunk);
        } catch {
          /* ignore */
        }
      }
    });

    const timer = setTimeout(() => {
      try {
        if (!child.killed) child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    const finalPromise = new Promise<SessionInfo>((resolvePromise, reject) => {
      let settled = false;
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanupMCPConfig(config.id);
        creditHook.end();
        reject(err);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanupMCPConfig(config.id);
        creditHook.end();
        const stdout = stdoutBuf.toString();
        const stderr = stderrBuf.toString();
        const parsed = parseGrokOutput(stdout);
        const durationMs = Date.now() - startedAt;
        const info: SessionInfo = {
          runId,
          agentId: config.id,
          output: parsed.text,
          json: parsed.json,
          sessionId: parsed.sessionId,
          exitCode: code,
          killed: child.killed,
          mcpServers: mcpSync.serverNames,
          durationMs,
        };
        this.maybeReflect(code, info, task, workdir, stdout, stderr, durationMs, parsed.text);
        resolvePromise(info);
      });
    });
    finalPromise.catch(() => {});

    return {
      runId,
      agentId: config.id,
      mcpServers: mcpSync.serverNames,
      startedAt,
      pid: child.pid,
      finalPromise,
      onStdout: (fn) => {
        stdoutSubs.add(fn);
        return () => stdoutSubs.delete(fn);
      },
      onStderr: (fn) => {
        stderrSubs.add(fn);
        return () => stderrSubs.delete(fn);
      },
      kill: (signal) => {
        try {
          return child.kill(signal);
        } catch {
          return false;
        }
      },
    };
  }

  /** Grok has no system-prompt replace flag — fold preamble + systemPrompt into the task. */
  private prepareTask(
    task: string,
    workdir: string,
    options: LaunchOptions,
  ): { effectiveTask: string; launchOptions: LaunchOptions } {
    let prefix = "";
    if (isSkillSystemEnabled()) prefix = buildClaudeCoderPreamble(workdir, { task }).preamble;
    if (options.systemPrompt)
      prefix = prefix ? `${prefix}\n\n${options.systemPrompt}` : options.systemPrompt;
    if (!prefix) return { effectiveTask: task, launchOptions: options };
    return {
      effectiveTask: `${prefix}\n\n---\n\n${task}`,
      launchOptions: { ...options, systemPrompt: undefined },
    };
  }

  private maybeReflect(
    code: number | null,
    info: SessionInfo,
    task: string,
    workdir: string,
    stdout: string,
    stderr: string,
    durationMs: number,
    output: string,
  ): void {
    if (!isSkillSystemEnabled()) return;
    if (code !== 0) {
      triggerPostMortem({
        info,
        task,
        workdir,
        stdoutTail: stdout.split("\n").slice(-200).join("\n"),
        stderrTail: stderr.slice(-2000),
      });
    } else if (isSubstantialRun(task, durationMs)) {
      triggerReflection({ info, task, workdir, output });
    }
  }

  // ── MCP global config (~/.grok/config.toml) ──────────────────────────────

  async installMcp(serverName: string, entry: McpServerEntry): Promise<void> {
    const doc = readGrokConfigDoc();
    const key = `mcp_servers.${serverName}`;
    doc.sections.set(key, grokMcpTomlLines(entry));
    if (!doc.order.includes(key)) doc.order.push(key);
    writeGrokConfigDoc(doc);
  }

  async uninstallMcp(serverName: string): Promise<void> {
    const doc = readGrokConfigDoc();
    const key = `mcp_servers.${serverName}`;
    doc.sections.delete(key);
    const idx = doc.order.indexOf(key);
    if (idx !== -1) doc.order.splice(idx, 1);
    writeGrokConfigDoc(doc);
  }

  async listInstalledMcps(): Promise<string[]> {
    return readGrokConfigDoc()
      .order.filter((k) => k.startsWith("mcp_servers."))
      .map((k) => k.slice("mcp_servers.".length));
  }

  getCapabilities(): CoderBackendCapabilities {
    return {
      id: "grok",
      displayName: "Grok Build",
      supportsStreamJson: true, // --output-format streaming-json
      supportsMcpConfig: true, // ~/.grok/config.toml [mcp_servers.*]
      supportsSessionResume: true, // --resume <session-id>
      supportsParallelSessions: true,
      modelFormat: "name",
    };
  }

  async checkInstalled(): Promise<BackendInstallStatus> {
    return checkCliInstalled(
      "grok",
      osInstallHint({
        win: "Install Grok Build from Setup › Coders",
        unix: "curl -fsSL https://x.ai/cli/install.sh | bash",
      }),
    );
  }
}

// ── Register InfiniBot in Grok's global MCP config ─────────────────────────

export function registerInfinibotInGrok(opts: {
  gatewayUrl: string;
  gatewayToken?: string;
  gatewayPassword?: string;
  defaultSessionKey?: string;
  force?: boolean;
}): { path: string; changed: boolean } {
  const path = grokConfigPath();
  const doc = readGrokConfigDoc();
  const key = "mcp_servers.infinibot";
  const env: Record<string, string> = { MOLTBOT_GATEWAY_URL: opts.gatewayUrl };
  if (opts.gatewayToken) env.MOLTBOT_GATEWAY_TOKEN = opts.gatewayToken;
  if (opts.gatewayPassword) env.MOLTBOT_GATEWAY_PASSWORD = opts.gatewayPassword;
  if (opts.defaultSessionKey) env.MOLTBOT_DEFAULT_SESSION_KEY = opts.defaultSessionKey;
  const lines = grokMcpTomlLines({
    command: process.execPath,
    args: [join(repoRoot(), "dist", "cli", "mcp-stdio.js")],
    env,
  });
  // A re-read section keeps the blank separator line(s) serializeTomlDoc wrote.
  const current = doc.sections.get(key)?.filter((l) => l.trim() !== "");
  if (!opts.force && current && JSON.stringify(current) === JSON.stringify(lines)) {
    return { path, changed: false };
  }
  doc.sections.set(key, lines);
  if (!doc.order.includes(key)) doc.order.push(key);
  writeGrokConfigDoc(doc);
  log.info(`Registered InfiniBot MCP in ${path}`);
  return { path, changed: true };
}

export function isInfinibotRegisteredInGrok(): { path: string; registered: boolean } {
  return {
    path: grokConfigPath(),
    registered: readGrokConfigDoc().sections.has("mcp_servers.infinibot"),
  };
}
