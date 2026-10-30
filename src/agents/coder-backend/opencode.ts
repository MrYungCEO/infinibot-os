/**
 * OpenCodeBackend — wraps the OpenCode CLI (github.com/sst/opencode v1.15.10+).
 *
 * Key differences from ClaudeCodeBackend (see docs/research/opencode-vs-claude-code.md):
 *   - CLI:            `opencode run "task"` vs `claude -p "task"`
 *   - JSON output:    `--format json` vs `--output-format stream-json`
 *   - Permissions:    `--dangerously-skip-permissions` — identical flag name
 *   - Model format:   `provider/model` prefix required
 *   - MCP config:     injected via OPENCODE_CONFIG_CONTENT env var (no temp file)
 *   - Session resume: `--session <id>` vs `--resume <id>`
 *   - Global config:  ~/.config/opencode/opencode.json (XDG-compliant)
 *
 * COORDINATION: opencode-swap — new file; no existing code modified here.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnCli, isWindowsBatchCommand, resolveCmdShimTarget } from "../../process/win-spawn.js";
import {
  exceedsInlineArgLimit,
  inlineArgvFits,
  spawnCoderProcess,
  writeRunPromptFile,
} from "./durable-spawn.js";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { checkCliInstalled, enrichedPath, resolveBin, osInstallHint } from "./bin-detect.js";
import { applyCoderSpawnEnv } from "../coder-install/keys.js";

import {
  isSkillSystemEnabled,
  buildClaudeCoderPreamble,
  triggerPostMortem,
  triggerReflection,
  isSubstantialRun,
} from "../claude-code/skill-system.js";
import { generateMCPConfig, cleanupMCPConfig } from "../claude-code/mcp-bridge.js";
import { loadConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createCliCreditHook } from "./cli-credit-hook.js";
import { allowCoderBypassFlag } from "./approval-policy.js";
import { prepareOpencodeInboxPlugin } from "../subagent-inbox/launch.js";

const log = createSubsystemLogger("opencode-backend");
import type { CLIAgentConfig } from "../types/agent-types.js";
import type { SessionInfo, LaunchOptions, BackgroundSession } from "../claude-code/launcher.js";
import type {
  CoderBackend,
  CoderBackendCapabilities,
  BackendInstallStatus,
  McpServerEntry,
} from "./types.js";
import { CappedOutput } from "./capped-output.js";

// Last-resort default when neither infinibot.json (coder.models.opencode)
// nor ~/.config/opencode/opencode.json has a model set. ollama-cloud is the
// provider that ships authed in most local installs; anthropic is not.
const OPENCODE_FALLBACK_MODEL = "ollama-cloud/glm-5.1";

function readConfiguredOpencodeModel(): string | undefined {
  try {
    const cfg = loadConfig() as { coder?: { models?: { opencode?: unknown } } };
    const v = cfg.coder?.models?.opencode;
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  } catch {
    return undefined;
  }
}

// ── Path helpers ───────────────────────────────────────────────────────────

function ocConfigDir(): string {
  return join(homedir(), ".config", "opencode");
}

function ocConfigPath(): string {
  return join(ocConfigDir(), "opencode.json");
}

function repoRoot(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return resolve(here, "..", "..", "..");
  } catch {
    return process.cwd();
  }
}

// ── OC global config read/write ────────────────────────────────────────────

function readOcConfig(): Record<string, unknown> {
  const p = ocConfigPath();
  if (!existsSync(p)) return {};
  try {
    // OC supports JSONC — strip single-line // comments before JSON.parse
    const raw = readFileSync(p, "utf8")
      .split("\n")
      .map((line) => line.replace(/\/\/.*/, ""))
      .join("\n")
      .trim();
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeOcConfig(data: Record<string, unknown>): void {
  mkdirSync(ocConfigDir(), { recursive: true });
  writeFileSync(ocConfigPath(), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

// ── CC → OC entry translation ──────────────────────────────────────────────

function ccEntryToOcEntry(entry: McpServerEntry): Record<string, unknown> {
  if (entry.url) {
    return {
      type: "remote",
      url: entry.url,
      ...(entry.headers ? { headers: entry.headers } : {}),
    };
  }
  const command: string[] = [];
  if (entry.command) command.push(entry.command);
  if (entry.args) command.push(...entry.args);
  return {
    type: "local",
    command,
    ...(entry.env ? { environment: entry.env } : {}),
    ...(entry.enabled === false ? { enabled: false } : {}),
  };
}

// ── Model normalization ────────────────────────────────────────────────────

function normalizeOcModel(model: string): string {
  if (model.includes("/")) return model;
  if (model.startsWith("claude-")) return `anthropic/${model}`;
  if (model.startsWith("gpt-")) return `openai/${model}`;
  if (model.startsWith("gemini-")) return `google/${model}`;
  return model;
}

/**
 * The list of `provider/model` ids this opencode install can actually serve
 * (from `opencode models`), cached for the process. Empty array = the query
 * failed and we can't validate, so callers should trust the requested model.
 */
let _ocModelsCache: string[] | null = null;
function availableOpencodeModels(): string[] {
  if (_ocModelsCache) return _ocModelsCache;
  try {
    const bin = resolveBin("opencode") ?? "opencode";
    // `opencode models` is a plain .exe/node invocation; resolve the Windows
    // .cmd shim to its real target so execFileSync doesn't hit EINVAL.
    const target = isWindowsBatchCommand(bin) ? resolveCmdShimTarget(bin) : null;
    const cmd = target?.command ?? bin;
    const pre = target?.prefixArgs ?? [];
    const out = execFileSync(cmd, [...pre, "models"], {
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, PATH: enrichedPath() },
    });
    _ocModelsCache = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.includes("/") && !l.includes(" "));
  } catch {
    _ocModelsCache = [];
  }
  return _ocModelsCache;
}

/**
 * Validate a desired model against what this opencode install actually exposes.
 * If the requested model isn't available (e.g. the hardcoded `ollama-cloud/...`
 * fallback on a host that only has the opencode-zen free tier — which fails the
 * run with "Model not found"), substitute an available model: prefer a coding
 * model, then a non-free one, else the first listed. When the model list can't
 * be read, trust the requested model unchanged.
 */
function resolveOcModel(preferred: string): string {
  const norm = normalizeOcModel(preferred);
  const avail = availableOpencodeModels();
  if (avail.length === 0 || avail.includes(norm)) return norm;
  const pick =
    avail.find((m) => /code/i.test(m)) ?? avail.find((m) => !/free/i.test(m)) ?? avail[0];
  if (pick && pick !== norm) {
    log.warn(
      `opencode model "${norm}" not available on this install; using "${pick}" instead. ` +
        `Set coder.models.opencode in infinibot.json to silence this.`,
    );
  }
  return pick ?? norm;
}

// ── CLI argument builder ───────────────────────────────────────────────────

function buildOcArgs(config: CLIAgentConfig, task: string, options: LaunchOptions): string[] {
  const args: string[] = ["run"];

  if (allowCoderBypassFlag(config.autoApprove)) {
    args.push("--dangerously-skip-permissions");
  }

  if (options.model) {
    args.push("--model", resolveOcModel(options.model));
  } else {
    // OpenCode hangs silently with no auth-default — force a known-good model.
    // Priority: user setting (infinibot.json coder.models.opencode) > opencode's
    // own config (~/.config/opencode/opencode.json) > hardcoded fallback.
    // Every branch is validated against `opencode models` so an unavailable
    // model (e.g. the ollama-cloud fallback on an opencode-zen-only install)
    // is swapped for one this host can actually serve instead of erroring.
    const configured = readConfiguredOpencodeModel();
    if (configured) {
      args.push("--model", resolveOcModel(configured));
    } else {
      const cfg = readOcConfig();
      if (typeof cfg.model !== "string" || !cfg.model) {
        args.push("--model", resolveOcModel(OPENCODE_FALLBACK_MODEL));
      }
    }
  }

  if (options.resumeSessionId) {
    args.push("--session", options.resumeSessionId);
  }

  args.push("--format", "json");

  if (config.cliArgs && config.cliArgs.length > 0) {
    args.push(...config.cliArgs);
  }

  args.push(task);
  return args;
}

/**
 * `opencode run` appends a non-TTY stdin to the message, so a prompt too large
 * for argv (E2BIG above 128 KiB) goes in `prompt.txt` and is fed on stdin.
 */
export function buildOcLaunch(
  config: CLIAgentConfig,
  task: string,
  options: LaunchOptions,
  runId: string,
): { args: string[]; stdinPath?: string } {
  const inline = buildOcArgs(config, task, options);
  if (!exceedsInlineArgLimit(task) && inlineArgvFits(config.cliCommand || "opencode", inline))
    return { args: inline };
  const stdinPath = writeRunPromptFile(runId, "prompt.txt", task);
  return { args: buildOcArgs(config, "", options).slice(0, -1), stdinPath };
}

// ── Environment builder — injects MCP + system prompt via env var ──────────

function buildOcEnv(
  config: CLIAgentConfig,
  options: LaunchOptions,
  mcpServers: Record<string, McpServerEntry>,
  promptRunId?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Ensure the CLI is reachable wherever detection found it (daemon PATH may
  // omit user bin dirs like ~/.local/bin, nvm, bun, npm-global).
  env.PATH = enrichedPath();
  // Keys stored in Setup › Coders for this CLI (config/options still override).
  applyCoderSpawnEnv("opencode", env);

  if (config.env) {
    for (const [k, v] of Object.entries(config.env)) env[k] = v;
  }
  if (options.env) {
    for (const [k, v] of Object.entries(options.env)) env[k] = v;
  }

  const extra: Record<string, unknown> = {};

  if (Object.keys(mcpServers).length > 0) {
    const mcp: Record<string, Record<string, unknown>> = {};
    for (const [name, entry] of Object.entries(mcpServers)) {
      mcp[name] = ccEntryToOcEntry(entry);
    }
    extra.mcp = mcp;
  }

  if (options.systemPrompt) {
    // OpenCode treats each `instructions` entry as a file path / glob, never as
    // literal text (raw text was silently dropped), and an inline preamble in
    // this env var could also blow the 128 KiB per-string exec limit.
    extra.instructions = [
      promptRunId
        ? writeRunPromptFile(promptRunId, "instructions.md", options.systemPrompt)
        : options.systemPrompt,
    ];
  }

  // In-flight operator inbox: a tool.execute.after plugin appends messages sent
  // via subagent_message / sessions_send to the next tool result.
  const inbox = prepareOpencodeInboxPlugin(options.runId);
  if (inbox) {
    extra.plugin = [inbox.pluginUrl];
    for (const [k, v] of Object.entries(inbox.env)) env[k] = v;
  }

  if (Object.keys(extra).length > 0) {
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify(extra);
  }

  return env;
}

// ── MCP servers: read back from the scoped config the bridge wrote ─────────

function readMcpServersFromBridge(agentId: string): Record<string, McpServerEntry> {
  const sanitized = agentId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const p = join(homedir(), ".claude", `mcp-infinibot-${sanitized}.json`);
  if (!existsSync(p)) return {};
  try {
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, McpServerEntry> };
    return parsed.mcpServers ?? {};
  } catch (err) {
    log.warn(
      `MCP bridge file present but unreadable (${p}): ${(err as Error).message}. ` +
        `OpenCode will run with zero MCP servers.`,
    );
    return {};
  }
}

// ── Output parser ──────────────────────────────────────────────────────────

function parseOcOutput(stdout: string): {
  text: string;
  sessionId?: string;
  json?: Record<string, unknown>;
} {
  const trimmed = stdout.trim();
  if (!trimmed) return { text: "" };

  const lines = trimmed
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let resultText = "";
  let sessionId: string | undefined;
  let lastEvent: Record<string, unknown> | undefined;

  for (const line of lines) {
    try {
      const ev = JSON.parse(line) as Record<string, unknown>;
      if (typeof ev.sessionID === "string") sessionId = ev.sessionID;
      if (typeof ev.session_id === "string") sessionId = ev.session_id;
      if (ev.type === "text" && typeof ev.text === "string") {
        resultText = ev.text;
        lastEvent = ev;
      }
      if ((ev.type === "step_finish" || ev.type === "result") && typeof ev.result === "string") {
        resultText = ev.result;
        lastEvent = ev;
      }
    } catch {
      // non-JSON line
    }
  }

  return { text: resultText || trimmed, sessionId, json: lastEvent };
}

// ── Backend class ──────────────────────────────────────────────────────────

export class OpenCodeBackend implements CoderBackend {
  readonly id = "opencode" as const;

  async spawn(
    config: CLIAgentConfig,
    task: string,
    workdir: string,
    options: LaunchOptions = {},
  ): Promise<SessionInfo> {
    const runId = options.runId ?? randomUUID();
    const started = Date.now();

    let launchOptions = options;
    if (isSkillSystemEnabled()) {
      const { preamble } = buildClaudeCoderPreamble(workdir, { task });
      const combined = preamble + (options.systemPrompt ? "\n\n" + options.systemPrompt : "");
      launchOptions = { ...options, systemPrompt: combined };
    }

    const mcpSync = generateMCPConfig(config);
    const mcpServers = readMcpServersFromBridge(config.id);

    const command = resolveBin("opencode") ?? "opencode";
    const { args, stdinPath } = buildOcLaunch(config, task, launchOptions, runId);
    const env = buildOcEnv(config, launchOptions, mcpServers, runId);
    const timeoutMs = config.timeoutMinutes * 60_000;

    return new Promise<SessionInfo>((resolve, reject) => {
      // stdin: "ignore" — see spawnBackground for why an open empty stdin pipe
      // makes opencode block on its first event.
      const stdio: ["ignore", "pipe", "pipe"] = ["ignore", "pipe", "pipe"];
      const child = stdinPath
        ? spawnCoderProcess(command, args, { stdio, cwd: workdir, env }, undefined, { stdinPath })
        : spawnCli(command, args, { stdio, cwd: workdir, env });
      let stdout = "";
      let stderr = "";
      const creditHook = createCliCreditHook({
        backend: "opencode",
        agentId: config.id,
        taskId: runId,
        defaultProvider: "opencode",
        defaultModel: launchOptions.model,
      });
      child.stdout?.on("data", (d: Buffer) => {
        const text = d.toString();
        stdout += text;
        creditHook.feed(text);
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
        const { text, json, sessionId } = parseOcOutput(stdout);
        const durationMs = Date.now() - started;
        const info: SessionInfo = {
          runId,
          agentId: config.id,
          output: text,
          json,
          sessionId,
          exitCode: code,
          killed: child.killed,
          mcpServers: mcpSync.serverNames,
          durationMs,
        };

        if (isSkillSystemEnabled()) {
          if (code !== 0) {
            triggerPostMortem({
              info,
              task,
              workdir,
              stdoutTail: stdout.split("\n").slice(-200).join("\n"),
              stderrTail: stderr.slice(-2000),
            });
          } else if (isSubstantialRun(task, durationMs)) {
            triggerReflection({ info, task, workdir, output: text });
          }
        }

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

    let launchOptions = options;
    if (isSkillSystemEnabled()) {
      const { preamble } = buildClaudeCoderPreamble(workdir, { task });
      const combined = preamble + (options.systemPrompt ? "\n\n" + options.systemPrompt : "");
      launchOptions = { ...options, systemPrompt: combined };
    }

    const mcpSync = generateMCPConfig(config);
    const mcpServers = readMcpServersFromBridge(config.id);

    const command = resolveBin("opencode") ?? "opencode";
    const { args, stdinPath } = buildOcLaunch(config, task, launchOptions, runId);
    const env = buildOcEnv(config, launchOptions, mcpServers, runId);
    const timeoutMs = config.timeoutMinutes * 60_000;

    const stdoutSubs = new Set<(chunk: string) => void>();
    const stderrSubs = new Set<(chunk: string) => void>();

    // stdin: "ignore" — OpenCode blocks on an open empty stdin pipe and never
    // emits its first event. resolveCommandStdio(hasInput:false) returned
    // "pipe" for stdin which triggered the hang; "ignore" lets the child boot.
    const stdio: ["ignore", "pipe", "pipe"] = ["ignore", "pipe", "pipe"];
    const child = spawnCoderProcess(
      command,
      args,
      { stdio, cwd: workdir, env },
      options.durableRunId,
      { stdinPath },
    );
    child.unref?.();

    const stdoutBuf = new CappedOutput();
    const stderrBuf = new CappedOutput(16 * 1024, 1024 * 1024);
    let firstOutputSeen = false;
    let watchdogKilled = false;
    const creditHook = createCliCreditHook({
      backend: "opencode",
      agentId: config.id,
      taskId: runId,
      defaultProvider: "opencode",
      defaultModel: launchOptions.model,
    });

    // First-output watchdog: OpenCode can hang silently for minutes with the
    // wrong model/auth, never closing the TCP to the provider. Force a hard
    // fail if no chunk has hit stdout or stderr. Configurable via launch
    // option, env var, or defaults to 60s. Set to 0 to disable entirely.
    const envTimeout = Number(process.env.OPENCODE_FIRST_OUTPUT_TIMEOUT_MS);
    const firstOutputTimeoutMs =
      typeof launchOptions.firstOutputTimeoutMs === "number"
        ? launchOptions.firstOutputTimeoutMs
        : Number.isFinite(envTimeout) && envTimeout >= 0
          ? envTimeout
          : 60_000;
    const firstOutputTimer =
      firstOutputTimeoutMs > 0
        ? setTimeout(() => {
            if (firstOutputSeen || child.killed) return;
            watchdogKilled = true;
            try {
              child.kill("SIGKILL");
            } catch {
              /* ignore */
            }
          }, firstOutputTimeoutMs)
        : null;

    const markFirstOutput = () => {
      if (firstOutputSeen) return;
      firstOutputSeen = true;
      if (firstOutputTimer) clearTimeout(firstOutputTimer);
    };

    child.stdout?.on("data", (d: Buffer) => {
      markFirstOutput();
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
      markFirstOutput();
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
        if (firstOutputTimer) clearTimeout(firstOutputTimer);
        cleanupMCPConfig(config.id);
        creditHook.end();
        reject(err);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (firstOutputTimer) clearTimeout(firstOutputTimer);
        cleanupMCPConfig(config.id);
        creditHook.end();
        const stdout = stdoutBuf.toString();
        const stderr = stderrBuf.toString();
        const { text, json, sessionId } = parseOcOutput(stdout);
        const durationMs = Date.now() - startedAt;
        const watchdogMsg = watchdogKilled
          ? `OpenCode produced no output within ${Math.round(firstOutputTimeoutMs / 1000)}s — likely a model/auth misconfiguration. ` +
            "Check ~/.config/opencode/opencode.json, pass model: in spawn options, or raise firstOutputTimeoutMs / OPENCODE_FIRST_OUTPUT_TIMEOUT_MS." +
            (stderr.trim() ? `\n\nstderr tail:\n${stderr.slice(-1000)}` : "")
          : null;
        const info: SessionInfo = {
          runId,
          agentId: config.id,
          output: watchdogMsg ?? text,
          json,
          sessionId,
          exitCode: watchdogKilled ? null : code,
          killed: child.killed || watchdogKilled,
          mcpServers: mcpSync.serverNames,
          durationMs,
        };

        if (isSkillSystemEnabled()) {
          if (code !== 0) {
            triggerPostMortem({
              info,
              task,
              workdir,
              stdoutTail: stdout.split("\n").slice(-200).join("\n"),
              stderrTail: stderr.slice(-2000),
            });
          } else if (isSubstantialRun(task, durationMs)) {
            triggerReflection({ info, task, workdir, output: text });
          }
        }

        // Watchdog kills must surface as a rejected promise so the parent
        // (claude-coder-tool finishKanban) records a real error message
        // instead of the generic "Failed: Unknown error".
        if (watchdogKilled && watchdogMsg) {
          reject(new Error(watchdogMsg));
          return;
        }

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

  // ── MCP global config (OC ~/.config/opencode/opencode.json) ───────────────

  async installMcp(serverName: string, entry: McpServerEntry): Promise<void> {
    const cfg = readOcConfig();
    const mcp: Record<string, unknown> =
      cfg.mcp && typeof cfg.mcp === "object" && !Array.isArray(cfg.mcp)
        ? { ...(cfg.mcp as Record<string, unknown>) }
        : {};
    mcp[serverName] = ccEntryToOcEntry(entry);
    writeOcConfig({ ...cfg, mcp });
  }

  async uninstallMcp(serverName: string): Promise<void> {
    const cfg = readOcConfig();
    const mcp: Record<string, unknown> =
      cfg.mcp && typeof cfg.mcp === "object" && !Array.isArray(cfg.mcp)
        ? { ...(cfg.mcp as Record<string, unknown>) }
        : {};
    delete mcp[serverName];
    writeOcConfig({ ...cfg, mcp });
  }

  async listInstalledMcps(): Promise<string[]> {
    const cfg = readOcConfig();
    if (!cfg.mcp || typeof cfg.mcp !== "object" || Array.isArray(cfg.mcp)) return [];
    return Object.keys(cfg.mcp as Record<string, unknown>);
  }

  getCapabilities(): CoderBackendCapabilities {
    return {
      id: "opencode",
      displayName: "OpenCode",
      supportsStreamJson: true,
      supportsMcpConfig: true,
      supportsSessionResume: true,
      supportsParallelSessions: true,
      modelFormat: "provider/name",
    };
  }

  async checkInstalled(): Promise<BackendInstallStatus> {
    return checkCliInstalled(
      "opencode",
      osInstallHint({
        win: "npm i -g opencode-ai@latest   (or: scoop install opencode)",
        unix: "npm install -g opencode-ai@latest",
      }),
    );
  }
}

// ── Register InfiniBot in OC's global MCP config ───────────────────────────

export function registerInfinibotInOpenCode(opts: {
  gatewayUrl: string;
  gatewayToken?: string;
  gatewayPassword?: string;
  defaultSessionKey?: string;
  force?: boolean;
}): { path: string; changed: boolean } {
  const path = ocConfigPath();
  const existing = readOcConfig();
  const mcp: Record<string, unknown> =
    existing.mcp && typeof existing.mcp === "object" && !Array.isArray(existing.mcp)
      ? { ...(existing.mcp as Record<string, unknown>) }
      : {};

  const env: Record<string, string> = { MOLTBOT_GATEWAY_URL: opts.gatewayUrl };
  if (opts.gatewayToken) env.MOLTBOT_GATEWAY_TOKEN = opts.gatewayToken;
  if (opts.gatewayPassword) env.MOLTBOT_GATEWAY_PASSWORD = opts.gatewayPassword;
  if (opts.defaultSessionKey) env.MOLTBOT_DEFAULT_SESSION_KEY = opts.defaultSessionKey;

  const distEntry = join(repoRoot(), "dist", "cli", "mcp-stdio.js");
  const entry: Record<string, unknown> = {
    type: "local",
    command: [process.execPath, distEntry],
    environment: env,
  };

  const current = mcp["infinibot"];
  const currentJson = current ? JSON.stringify(current) : "";
  const newJson = JSON.stringify(entry);

  if (!opts.force && currentJson === newJson) {
    return { path, changed: false };
  }

  mcp["infinibot"] = entry;
  writeOcConfig({ ...existing, mcp });
  return { path, changed: true };
}

export function isInfinibotRegisteredInOpenCode(): { path: string; registered: boolean } {
  const path = ocConfigPath();
  const existing = readOcConfig();
  const mcp = existing.mcp as Record<string, unknown> | undefined;
  const registered = !!mcp && typeof mcp === "object" && !Array.isArray(mcp) && "infinibot" in mcp;
  return { path, registered };
}

export function unregisterInfinibotFromOpenCode(): { path: string; removed: boolean } {
  const path = ocConfigPath();
  const existing = readOcConfig();
  const mcp: Record<string, unknown> =
    existing.mcp && typeof existing.mcp === "object" && !Array.isArray(existing.mcp)
      ? { ...(existing.mcp as Record<string, unknown>) }
      : {};

  if (!("infinibot" in mcp)) return { path, removed: false };
  delete mcp["infinibot"];
  writeOcConfig({ ...existing, mcp });
  return { path, removed: true };
}
