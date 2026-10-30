/**
 * GeminiCliBackend — wraps Google's official Gemini CLI (`gemini`).
 *
 * Research findings (2026-06-16, gemini-cli 0.23.0):
 *   Package:        @google/gemini-cli  (npm i -g @google/gemini-cli)
 *   Binary:         gemini
 *   Version flag:   gemini --version
 *   Non-interactive: gemini "<prompt>"  (positional, one-shot by default)
 *   JSON output:    gemini -o json "<prompt>"  → single final JSON object:
 *                     { session_id, response, stats: { models: { <m>: { tokens } } } }
 *                   (also supports -o stream-json for JSONL)
 *   Auto-approve:   --approval-mode yolo   (or -y)
 *   Model:          gemini -m <name> ...   (e.g. gemini-2.5-pro, gemini-2.5-flash)
 *   Session resume: gemini -r <session-id> "<prompt>"  (or -r latest)
 *   Config dir:     ~/.gemini/
 *   Config file:    ~/.gemini/settings.json  (JSON)
 *   MCP servers:    settings.json `mcpServers` map — same shape as Claude Code
 *                   ({ command, args, env }). No env-injection path, so MCP is
 *                   registered globally (mirrors ClaudeCodeBackend).
 *   System prompt:  no flag — prepended to the task string (like Codex).
 *   Auth:           `gemini` once interactively for OAuth, or GEMINI_API_KEY.
 *
 * COORDINATION: gemini-backend
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnCli } from "../../process/win-spawn.js";
import {
  exceedsInlineArgLimit,
  inlineArgvFits,
  spawnCoderProcess,
  writeRunPromptFile,
} from "./durable-spawn.js";
import { randomUUID } from "node:crypto";

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
import { recordCredit } from "../../credits/recorder.js";

const log = createSubsystemLogger("gemini-backend");
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

// stdin must be ignored: an open stdin pipe makes the CLI wait for additional
// piped input even with a positional prompt.
const GEMINI_STDIO: ["ignore", "pipe", "pipe"] = ["ignore", "pipe", "pipe"];

// Default model when the spawn doesn't pin one. Flash is the cheapest capable
// coding model that ships enabled for both OAuth and API-key auth.
const GEMINI_DEFAULT_MODEL = "gemini-2.5-flash";

/**
 * Models the gemini CLI accepts via -m. Kept self-contained here (mirrors
 * opencode's local fallback model) rather than forked into the shared provider
 * list, to avoid colliding with the in-flight Quickstart provider/model work.
 *
 * TODO(coordinate: quickstart-ui): surface these in the shared provider/model
 * picker. Add a "google" / "gemini-cli" provider entry pointing at GEMINI_MODELS
 * so the model search filter can target Gemini, instead of re-declaring the
 * list there. Entry shape: { id: "gemini-2.5-pro", provider: "google",
 * backend: "gemini" } (and flash / flash-lite).
 */
export const GEMINI_MODELS: string[] = [
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
];

// ── Path helpers ───────────────────────────────────────────────────────────

function geminiHome(): string {
  return process.env.GEMINI_DIR ?? join(homedir(), ".gemini");
}

function geminiSettingsPath(): string {
  return join(geminiHome(), "settings.json");
}

function repoRoot(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return resolve(here, "..", "..", "..");
  } catch {
    return process.cwd();
  }
}

// ── Global settings.json read/write ────────────────────────────────────────

function readGeminiSettings(): Record<string, unknown> {
  const p = geminiSettingsPath();
  if (!existsSync(p)) return {};
  try {
    const raw = readFileSync(p, "utf8").trim();
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeGeminiSettings(data: Record<string, unknown>): void {
  mkdirSync(geminiHome(), { recursive: true });
  writeFileSync(geminiSettingsPath(), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function getMcpServersMap(settings: Record<string, unknown>): Record<string, unknown> {
  const m = settings.mcpServers;
  return m && typeof m === "object" && !Array.isArray(m)
    ? { ...(m as Record<string, unknown>) }
    : {};
}

/** Translate a Claude-shape MCP entry into the gemini settings.json shape. */
function ccEntryToGeminiEntry(entry: McpServerEntry): Record<string, unknown> {
  if (entry.url) {
    return {
      url: entry.url,
      ...(entry.headers ? { headers: entry.headers } : {}),
    };
  }
  return {
    ...(entry.command ? { command: entry.command } : {}),
    ...(entry.args && entry.args.length ? { args: entry.args } : {}),
    ...(entry.env ? { env: entry.env } : {}),
  };
}

// ── CLI argument builder ───────────────────────────────────────────────────

function buildGeminiArgs(config: CLIAgentConfig, task: string, options: LaunchOptions): string[] {
  const args: string[] = [];

  args.push("-m", options.model || GEMINI_DEFAULT_MODEL);
  args.push("-o", "json"); // single final JSON object on stdout

  if (allowCoderBypassFlag(config.autoApprove)) {
    args.push("--approval-mode", "yolo");
  }

  if (options.resumeSessionId) {
    args.push("-r", options.resumeSessionId);
  }

  if (config.cliArgs && config.cliArgs.length > 0) {
    args.push(...config.cliArgs);
  }

  // Positional prompt — one-shot by default.
  args.push(task);
  return args;
}

/**
 * Gemini prepends a piped stdin to the prompt, so a prompt too large for argv
 * (E2BIG above 128 KiB) goes in `prompt.txt` on stdin with a short positional.
 */
export function buildGeminiLaunch(
  config: CLIAgentConfig,
  task: string,
  options: LaunchOptions,
  runId: string,
): { args: string[]; stdinPath?: string } {
  const inline = buildGeminiArgs(config, task, options);
  if (!exceedsInlineArgLimit(task) && inlineArgvFits(config.cliCommand || "gemini", inline))
    return { args: inline };
  const stdinPath = writeRunPromptFile(runId, "prompt.txt", task);
  const args = buildGeminiArgs(config, GEMINI_STDIN_PROMPT, options);
  return { args, stdinPath };
}

const GEMINI_STDIN_PROMPT = "Carry out the task given above.";

export function buildGeminiArgsForTest(
  config: CLIAgentConfig,
  task: string,
  options: LaunchOptions = {},
): string[] {
  return buildGeminiArgs(config, task, options);
}

function buildGeminiEnv(config: CLIAgentConfig, options: LaunchOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Make `gemini` reachable wherever detection found it (daemon PATH may omit
  // user bin dirs like ~/.npm-global/bin).
  env.PATH = enrichedPath();
  // Keys stored in Setup › Coders for this CLI (config/options still override).
  applyCoderSpawnEnv("gemini", env);
  if (config.env) {
    for (const [k, v] of Object.entries(config.env)) env[k] = v;
  }
  if (options.env) {
    for (const [k, v] of Object.entries(options.env)) env[k] = v;
  }
  return env;
}

// ── Output parser ──────────────────────────────────────────────────────────
// gemini -o json prints a single JSON object: { session_id, response, stats }.
// Be permissive: tolerate leading banner lines ("Loaded cached credentials.")
// and fall back to JSONL/raw text.

interface GeminiTokens {
  input?: number;
  prompt?: number;
  candidates?: number;
  total?: number;
  cached?: number;
}

function parseGeminiOutput(stdout: string): {
  text: string;
  sessionId?: string;
  json?: Record<string, unknown>;
  usage?: { model: string; tokens: GeminiTokens };
} {
  const trimmed = stdout.trim();
  if (!trimmed) return { text: "" };

  // Find the JSON object — the CLI may print a banner line before it.
  const start = trimmed.indexOf("{");
  const candidate = start >= 0 ? trimmed.slice(start) : trimmed;
  try {
    const obj = JSON.parse(candidate) as Record<string, unknown>;
    const sessionId =
      typeof obj.session_id === "string"
        ? obj.session_id
        : typeof obj.sessionId === "string"
          ? obj.sessionId
          : undefined;
    const response = typeof obj.response === "string" ? obj.response : "";

    // Pull token usage from stats.models.<firstModel>.tokens.
    let usage: { model: string; tokens: GeminiTokens } | undefined;
    const stats = obj.stats as { models?: Record<string, { tokens?: GeminiTokens }> } | undefined;
    if (stats?.models) {
      const [model, entry] = Object.entries(stats.models)[0] ?? [];
      if (model && entry?.tokens) usage = { model, tokens: entry.tokens };
    }

    return { text: response || candidate, sessionId, json: obj, usage };
  } catch {
    // Fall back: scan JSONL lines for a `response`/`text` field.
    let resultText = "";
    let sessionId: string | undefined;
    for (const line of trimmed.split("\n")) {
      const l = line.trim();
      if (!l || l[0] !== "{") continue;
      try {
        const ev = JSON.parse(l) as Record<string, unknown>;
        if (typeof ev.session_id === "string") sessionId = ev.session_id;
        if (typeof ev.response === "string") resultText = ev.response;
        else if (typeof ev.text === "string") resultText = ev.text;
      } catch {
        /* skip */
      }
    }
    return { text: resultText || trimmed, sessionId };
  }
}

// ── Backend class ──────────────────────────────────────────────────────────

export class GeminiCliBackend implements CoderBackend {
  readonly id = "gemini" as const;

  async spawn(
    config: CLIAgentConfig,
    task: string,
    workdir: string,
    options: LaunchOptions = {},
  ): Promise<SessionInfo> {
    const runId = options.runId ?? randomUUID();
    const started = Date.now();

    const { effectiveTask, launchOptions } = this.prepareTask(task, workdir, options);

    const mcpSync = generateMCPConfig(config);
    const command = resolveBin("gemini") ?? "gemini";
    const { args, stdinPath } = buildGeminiLaunch(config, effectiveTask, launchOptions, runId);
    const env = buildGeminiEnv(config, launchOptions);
    const timeoutMs = config.timeoutMinutes * 60_000;

    return new Promise<SessionInfo>((resolve, reject) => {
      const child = stdinPath
        ? spawnCoderProcess(command, args, { stdio: GEMINI_STDIO, cwd: workdir, env }, undefined, {
            stdinPath,
          })
        : spawnCli(command, args, { stdio: GEMINI_STDIO, cwd: workdir, env });
      let stdout = "";
      let stderr = "";
      const creditHook = createCliCreditHook({
        backend: "gemini",
        agentId: config.id,
        taskId: runId,
        defaultProvider: "google",
        defaultModel: launchOptions.model ?? GEMINI_DEFAULT_MODEL,
      });
      child.stdout?.on("data", (d: Buffer) => {
        const chunk = d.toString();
        stdout += chunk;
        creditHook.feed(chunk);
      });
      child.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString();
      });

      const timer = setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, timeoutMs);

      child.on("error", (err) => {
        clearTimeout(timer);
        cleanupMCPConfig(config.id);
        creditHook.end();
        reject(err);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        cleanupMCPConfig(config.id);
        creditHook.end();
        const parsed = parseGeminiOutput(stdout);
        this.recordUsage(creditHook.count(), parsed, config.id, runId);
        const durationMs = Date.now() - started;
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
        resolve(info);
      });
    });
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
    const command = resolveBin("gemini") ?? "gemini";
    const { args, stdinPath } = buildGeminiLaunch(config, effectiveTask, launchOptions, runId);
    const env = buildGeminiEnv(config, launchOptions);
    const timeoutMs = config.timeoutMinutes * 60_000;

    const stdoutSubs = new Set<(chunk: string) => void>();
    const stderrSubs = new Set<(chunk: string) => void>();

    const child = spawnCoderProcess(
      command,
      args,
      { stdio: GEMINI_STDIO, cwd: workdir, env },
      options.durableRunId,
      { stdinPath },
    );
    child.unref?.();

    const stdoutBuf = new CappedOutput();
    const stderrBuf = new CappedOutput(16 * 1024, 1024 * 1024);
    const creditHook = createCliCreditHook({
      backend: "gemini",
      agentId: config.id,
      taskId: runId,
      defaultProvider: "google",
      defaultModel: launchOptions.model ?? GEMINI_DEFAULT_MODEL,
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
      if (!child.killed) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }, timeoutMs);

    const finalPromise = new Promise<SessionInfo>((resolve, reject) => {
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
        const parsed = parseGeminiOutput(stdout);
        this.recordUsage(creditHook.count(), parsed, config.id, runId);
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
        resolve(info);
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

  // ── Shared spawn helpers ──────────────────────────────────────────────────

  /** Gemini has no system-prompt flag — fold preamble + systemPrompt into task. */
  private prepareTask(
    task: string,
    workdir: string,
    options: LaunchOptions,
  ): { effectiveTask: string; launchOptions: LaunchOptions } {
    if (isSkillSystemEnabled()) {
      const { preamble } = buildClaudeCoderPreamble(workdir, { task });
      const combined = preamble + (options.systemPrompt ? "\n\n" + options.systemPrompt : "");
      return {
        effectiveTask: combined + "\n\n---\n\n" + task,
        launchOptions: { ...options, systemPrompt: undefined },
      };
    }
    if (options.systemPrompt) {
      return {
        effectiveTask: options.systemPrompt + "\n\n---\n\n" + task,
        launchOptions: { ...options, systemPrompt: undefined },
      };
    }
    return { effectiveTask: task, launchOptions: options };
  }

  /** Record token usage from the final stats object when the stream hook saw none. */
  private recordUsage(
    hookCount: number,
    parsed: ReturnType<typeof parseGeminiOutput>,
    agentId: string,
    runId: string,
  ): void {
    if (hookCount > 0 || !parsed.usage) return; // hook already accounted for it
    try {
      const { model, tokens } = parsed.usage;
      recordCredit({
        provider: "google",
        model,
        usage: {
          tokensIn: Number(tokens.input ?? tokens.prompt ?? 0),
          tokensOut: Number(tokens.candidates ?? 0),
          cacheReadTokens: Number(tokens.cached ?? 0),
        },
        agentBackend: "gemini",
        agentId,
        taskId: runId,
        source: "ledger.cli.transcript",
      });
    } catch {
      /* best-effort accounting */
    }
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

  // ── MCP global config (~/.gemini/settings.json mcpServers) ────────────────

  async installMcp(serverName: string, entry: McpServerEntry): Promise<void> {
    const settings = readGeminiSettings();
    const mcp = getMcpServersMap(settings);
    mcp[serverName] = ccEntryToGeminiEntry(entry);
    writeGeminiSettings({ ...settings, mcpServers: mcp });
  }

  async uninstallMcp(serverName: string): Promise<void> {
    const settings = readGeminiSettings();
    const mcp = getMcpServersMap(settings);
    delete mcp[serverName];
    writeGeminiSettings({ ...settings, mcpServers: mcp });
  }

  async listInstalledMcps(): Promise<string[]> {
    return Object.keys(getMcpServersMap(readGeminiSettings()));
  }

  getCapabilities(): CoderBackendCapabilities {
    return {
      id: "gemini",
      displayName: "Gemini CLI",
      supportsStreamJson: true, // gemini -o stream-json emits JSONL
      supportsMcpConfig: true, // via ~/.gemini/settings.json mcpServers
      supportsSessionResume: true, // gemini -r <session-id>
      supportsParallelSessions: true,
      modelFormat: "name", // bare model name, e.g. "gemini-2.5-pro"
    };
  }

  async checkInstalled(): Promise<BackendInstallStatus> {
    return checkCliInstalled(
      "gemini",
      osInstallHint({
        win: "npm i -g @google/gemini-cli",
        unix: "npm install -g @google/gemini-cli",
      }),
    );
  }
}

// ── Register InfiniBot in Gemini's global MCP config ───────────────────────
// Writes an `infinibot` entry to ~/.gemini/settings.json mcpServers so every
// Gemini session can call back into the gateway via the mcp-stdio bridge.
// COORDINATION: gemini-backend

export function registerInfinibotInGemini(opts: {
  gatewayUrl: string;
  gatewayToken?: string;
  gatewayPassword?: string;
  defaultSessionKey?: string;
  force?: boolean;
}): { path: string; changed: boolean } {
  const path = geminiSettingsPath();
  const settings = readGeminiSettings();
  const mcp = getMcpServersMap(settings);

  const env: Record<string, string> = { MOLTBOT_GATEWAY_URL: opts.gatewayUrl };
  if (opts.gatewayToken) env.MOLTBOT_GATEWAY_TOKEN = opts.gatewayToken;
  if (opts.gatewayPassword) env.MOLTBOT_GATEWAY_PASSWORD = opts.gatewayPassword;
  if (opts.defaultSessionKey) env.MOLTBOT_DEFAULT_SESSION_KEY = opts.defaultSessionKey;

  const distEntry = join(repoRoot(), "dist", "cli", "mcp-stdio.js");
  const entry: Record<string, unknown> = {
    command: process.execPath,
    args: [distEntry],
    env,
  };

  const current = mcp["infinibot"];
  const currentJson = current ? JSON.stringify(current) : "";
  const newJson = JSON.stringify(entry);
  if (!opts.force && currentJson === newJson) {
    return { path, changed: false };
  }

  mcp["infinibot"] = entry;
  writeGeminiSettings({ ...settings, mcpServers: mcp });
  log.info(`Registered InfiniBot MCP in ${path}`);
  return { path, changed: true };
}

export function isInfinibotRegisteredInGemini(): { path: string; registered: boolean } {
  const path = geminiSettingsPath();
  const mcp = getMcpServersMap(readGeminiSettings());
  return { path, registered: "infinibot" in mcp };
}

export function unregisterInfinibotFromGemini(): { path: string; removed: boolean } {
  const path = geminiSettingsPath();
  const settings = readGeminiSettings();
  const mcp = getMcpServersMap(settings);
  if (!("infinibot" in mcp)) return { path, removed: false };
  delete mcp["infinibot"];
  writeGeminiSettings({ ...settings, mcpServers: mcp });
  return { path, removed: true };
}
