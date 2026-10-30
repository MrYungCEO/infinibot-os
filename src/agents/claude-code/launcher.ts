/**
 * Claude Code Launcher
 *
 * Spawns Claude Code CLI agents with scoped MCP configuration.
 * Integrates with the MCP bridge to generate per-agent config files,
 * builds the appropriate CLI flags, and manages the subprocess lifecycle.
 */

import { randomUUID } from "node:crypto";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runCommandWithTimeout, type SpawnResult } from "../../process/exec.js";
import { resolveCommandStdio } from "../../process/spawn-utils.js";
import {
  exceedsInlineArgLimit,
  inlineArgvFits,
  spawnCoderProcess,
  writeRunPromptFile,
} from "../coder-backend/durable-spawn.js";
import { resolveBin } from "../coder-backend/bin-detect.js";
import { applyCoderSpawnEnv } from "../coder-install/keys.js";
import { allowCoderBypassFlag } from "../coder-backend/approval-policy.js";
import { prepareClaudeInboxSettings } from "../subagent-inbox/launch.js";
import type { CLIAgentConfig } from "../types/agent-types.js";
import { generateMCPConfig, cleanupMCPConfig, type SyncResult } from "./mcp-bridge.js";
import {
  isSkillSystemEnabled,
  buildClaudeCoderPreamble,
  triggerPostMortem,
  triggerReflection,
  isSubstantialRun,
} from "./skill-system.js";
import { CappedOutput } from "../coder-backend/capped-output.js";

const log = createSubsystemLogger("agent").child("claude-code-launcher");

// ══════════════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════════════

export interface SessionInfo {
  /** Unique run identifier. */
  runId: string;
  /** Agent config used for this session. */
  agentId: string;
  /** Raw text output from the CLI. */
  output: string;
  /** Parsed JSON output if the CLI returned JSON. */
  json?: Record<string, unknown>;
  /** Claude Code session ID (if returned). */
  sessionId?: string;
  /** Exit code of the CLI process. */
  exitCode: number | null;
  /** Whether the process was killed (timeout). */
  killed: boolean;
  /** MCP servers that were made available to this run. */
  mcpServers: string[];
  /** Wall-clock duration in ms. */
  durationMs: number;
}

export interface LaunchOptions {
  /** Override the run ID (defaults to random UUID). */
  runId?: string;
  /** Additional environment variables merged on top of the agent's env. */
  env?: Record<string, string>;
  /** Model override (e.g. "opus", "sonnet"). */
  model?: string;
  /** System prompt to append. */
  systemPrompt?: string;
  /** Resume an existing Claude Code session. */
  resumeSessionId?: string;
  /**
   * Backends that hang silently on misconfigured auth (currently OpenCode) hard-kill
   * the child if no stdout/stderr chunk arrives within this window. Set to 0 to
   * disable. Default: 60_000ms. Env override: OPENCODE_FIRST_OUTPUT_TIMEOUT_MS.
   */
  firstOutputTimeoutMs?: number;
  /**
   * Launch this run inside a detached tmux session keyed on the given runId so
   * it survives a gateway restart (see `spawnCoderProcess` in
   * coder-backend/durable-spawn.ts). Only honoured by the *background* spawn
   * paths — sync spawns block the caller and gain nothing from durability.
   * Ignored on Windows / when tmux is unavailable.
   */
  durableRunId?: string;
}

// ══════════════════════════════════════════════════════════════════════════════
// CLI Argument Builder
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Build the claude CLI argv. Text too large for a single argv element (Linux
 * E2BIG above 128 KiB — the skill preamble alone can approach it) is written
 * into the run's scratch dir instead: the system prompt goes through
 * `--append-system-prompt-file`, the task through stdin (`claude -p` reads
 * its prompt from stdin when no positional prompt is given).
 */
function buildArgs(
  config: CLIAgentConfig,
  task: string,
  mcpSync: SyncResult,
  options: LaunchOptions,
  runId: string,
): { args: string[]; stdinPath?: string; stdinText?: string } {
  const args: string[] = [];

  // Print mode with stream-json so we get a discrete NDJSON event for each
  // tool call (Read/Edit/Bash/...). --verbose is required by Claude Code
  // when stream-json is paired with -p. The launcher's parseOutput knows
  // how to consume NDJSON or a single legacy json blob.
  args.push("-p", "--output-format", "stream-json", "--verbose");

  // MCP config injection (scoped, never the user's main config)
  if (mcpSync.serverCount > 0) {
    args.push("--mcp-config", mcpSync.configPath);
    // Strict mode ensures only our scoped MCPs are available
    args.push("--strict-mcp-config");
  }

  // Auto-approve / full-auto mode (tools.coder.autoApprove="never" suppresses it)
  if (allowCoderBypassFlag(config.autoApprove)) {
    args.push("--dangerously-skip-permissions");
  }

  // Allowed tools (if specified)
  if (config.allowedTools && config.allowedTools.length > 0) {
    for (const tool of config.allowedTools) {
      args.push("--allowedTools", tool);
    }
  }

  // Model override
  const model = options.model;
  if (model) {
    args.push("--model", model);
  }

  // System prompt
  if (options.systemPrompt) {
    // Windows: always a file — tens of KB never fit a 32,767-char command line.
    if (process.platform === "win32" || exceedsInlineArgLimit(options.systemPrompt)) {
      const file = writeRunPromptFile(runId, "system-prompt.md", options.systemPrompt);
      args.push("--append-system-prompt-file", file);
    } else {
      args.push("--append-system-prompt", options.systemPrompt);
    }
  }

  // Resume existing session
  if (options.resumeSessionId) {
    args.push("--resume", options.resumeSessionId);
  }

  // In-flight operator inbox: PostToolUse/Stop hooks that inject messages sent
  // via subagent_message / sessions_send while this run is working (see
  // src/agents/subagent-inbox). Skipped when the caller brings its own --settings.
  if (!config.cliArgs?.includes("--settings")) {
    const inboxSettings = prepareClaudeInboxSettings(options.runId);
    if (inboxSettings) args.push("--settings", inboxSettings);
  }

  // Extra CLI args from config
  if (config.cliArgs && config.cliArgs.length > 0) {
    args.push(...config.cliArgs);
  }

  // The task/prompt itself (must be last for -p mode)
  if (
    exceedsInlineArgLimit(task) ||
    !inlineArgvFits(config.cliCommand || "claude", [...args, task])
  ) {
    return { args, stdinPath: writeRunPromptFile(runId, "prompt.txt", task), stdinText: task };
  }
  args.push(task);

  return { args };
}

export function buildClaudeArgsForTest(
  config: CLIAgentConfig,
  task: string,
  options: LaunchOptions,
  runId: string,
): { args: string[]; stdinPath?: string } {
  const { args, stdinPath } = buildArgs(
    config,
    task,
    { serverCount: 0, configPath: "" } as unknown as SyncResult,
    options,
    runId,
  );
  return { args, stdinPath };
}

// ══════════════════════════════════════════════════════════════════════════════
// Environment
// ══════════════════════════════════════════════════════════════════════════════

function buildEnv(config: CLIAgentConfig, options: LaunchOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  // Key / OAuth token stored in Setup › Coders for Claude Code (config and
  // per-launch env below still override it).
  applyCoderSpawnEnv("claude-code", env);

  // Agent-level env from config
  if (config.env) {
    for (const [key, value] of Object.entries(config.env)) {
      env[key] = value;
    }
  }

  // Per-launch overrides
  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      env[key] = value;
    }
  }

  // Claude Code authenticates via its own `claude login` (OAuth stored on disk).
  // Any ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN present in the environment —
  // inherited from the gateway, or injected by the auth-profile env export —
  // OVERRIDES that login in headless mode. When the value is an auth/OAuth token
  // (not a real sk-ant API key), the CLI sends it as x-api-key and the run dies
  // with "401 Invalid API key" in ~1s (status:error, empty workdir deleted).
  // Strip them LAST — after the config/options merges above — so no path can
  // re-inject them and the CLI falls back to the stored login. ANTHROPIC_AUTH_TOKEN
  // was previously missed, which is why the 401 persisted after the earlier fix.
  // Cross-OS safe: only strip an ANTHROPIC_API_KEY that is NOT a real Anthropic
  // key (sk-ant-…). The leak we guard against is an OAuth/auth token injected
  // here (auth-profile export or inherited env), which the CLI sends as
  // x-api-key → 401. A genuine sk-ant- key (e.g. a Linux/CI user intentionally
  // running the coder headless with their own key) is preserved so we don't
  // break that flow. ANTHROPIC_AUTH_TOKEN is always an OAuth token → always strip.
  if (env.ANTHROPIC_API_KEY && !env.ANTHROPIC_API_KEY.startsWith("sk-ant-")) {
    delete env.ANTHROPIC_API_KEY;
  }
  delete env.ANTHROPIC_API_KEY_OLD;
  delete env.ANTHROPIC_AUTH_TOKEN;

  return env;
}

// ══════════════════════════════════════════════════════════════════════════════
// Output Parsing
// ══════════════════════════════════════════════════════════════════════════════

function parseOutput(stdout: string): {
  text: string;
  json?: Record<string, unknown>;
  sessionId?: string;
} {
  const trimmed = stdout.trim();
  if (!trimmed) return { text: "" };

  // Stream-json: NDJSON, one event per line. The final "result" line carries
  // the synthesized answer + session id; intermediate lines are
  // system/user/assistant/tool events. Fall back to single-blob json if the
  // CLI was invoked with the legacy format.
  if (trimmed.includes("\n") || (trimmed.startsWith("{") && trimmed.endsWith("}\n"))) {
    const lines = trimmed
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    let finalEvent: Record<string, unknown> | undefined;
    let sessionId: string | undefined;
    let resultText: string | undefined;
    for (const line of lines) {
      try {
        const ev = JSON.parse(line) as Record<string, unknown>;
        if (typeof ev.session_id === "string") sessionId = ev.session_id;
        if (ev.type === "result") {
          finalEvent = ev;
          if (typeof ev.result === "string") resultText = ev.result;
        }
      } catch {
        // not all lines are JSON when the CLI hits a hard error mid-stream
      }
    }
    if (finalEvent) {
      return {
        text: resultText ?? trimmed,
        json: finalEvent,
        sessionId,
      };
    }
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null) {
      const text =
        typeof parsed.result === "string"
          ? parsed.result
          : typeof parsed.text === "string"
            ? parsed.text
            : trimmed;
      const sessionId =
        parsed.session_id ?? parsed.sessionId ?? parsed.conversation_id ?? undefined;
      return { text, json: parsed, sessionId };
    }
  } catch {
    // Not JSON, treat as plain text
  }

  return { text: trimmed };
}

// ══════════════════════════════════════════════════════════════════════════════
// Launcher
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Spawn a Claude Code CLI agent with scoped MCP configuration.
 *
 * 1. Generates a per-agent MCP config via the bridge.
 * 2. Builds CLI arguments with proper flags.
 * 3. Executes the CLI with timeout.
 * 4. Cleans up the scoped MCP config.
 * 5. Returns structured session info.
 */
export async function spawnClaudeCodeAgent(
  config: CLIAgentConfig,
  task: string,
  workdir: string,
  options: LaunchOptions = {},
): Promise<SessionInfo> {
  const runId = options.runId ?? randomUUID();
  const started = Date.now();

  log.info(`launching claude-code agent "${config.id}" (runId=${runId})`);

  // Inject InfiniBot preamble (skill index + memory guidance + self-improvement protocols).
  // Pass the task so browser-task detection can load browser-specific skills.
  let launchOptions = options;
  if (isSkillSystemEnabled()) {
    const { preamble, skillCount, cacheState } = buildClaudeCoderPreamble(workdir, { task });
    log.info(`claude-coder spawn ${runId}: injected ${skillCount} skills (${cacheState})`);
    const combined = preamble + (options.systemPrompt ? "\n\n" + options.systemPrompt : "");
    launchOptions = { ...options, systemPrompt: combined };
  }

  // Step 1: Generate scoped MCP config
  const mcpSync = generateMCPConfig(config);
  log.info(`MCP bridge: ${mcpSync.serverCount} servers synced for agent "${config.id}"`);

  try {
    // Step 2: Build command — resolve the absolute path so Windows PATHEXT
    // picks up the `.cmd` shim that npm-global installs put alongside the
    // POSIX-only `claude` script. Without this, raw spawn() on Windows
    // ENOENTs because it won't try PATHEXT for a bare name in execFile mode.
    const requested = config.cliCommand || "claude";
    const command = resolveBin(requested) ?? requested;
    const { args, stdinText } = buildArgs(config, task, mcpSync, launchOptions, runId);
    const env = buildEnv(config, launchOptions);
    const timeoutMs = config.timeoutMinutes * 60_000;

    log.debug(`exec: ${command} ${args.slice(0, 4).join(" ")} ... (${args.length} args total)`);

    // Step 3: Execute
    const result: SpawnResult = await runCommandWithTimeout([command, ...args], {
      timeoutMs,
      cwd: workdir,
      env,
      ...(stdinText !== undefined ? { input: stdinText } : {}),
    });

    // Step 4: Parse output
    const { text, json, sessionId } = parseOutput(result.stdout);

    // Record per-turn usage from the stream-json transcript into the credit ledger.
    try {
      const hook = (await import("../coder-backend/cli-credit-hook.js")).createCliCreditHook({
        backend: "claude-code",
        agentId: config.id,
        taskId: runId,
        defaultProvider: "anthropic",
      });
      hook.feed(result.stdout);
      hook.end();
    } catch {
      /* never block on accounting */
    }

    if (result.code !== 0) {
      const errorInfo = result.stderr.trim() || text || "CLI exited with non-zero code";
      log.warn(`agent "${config.id}" exited with code ${result.code}: ${errorInfo.slice(0, 200)}`);
    }

    const info: SessionInfo = {
      runId,
      agentId: config.id,
      output: text,
      json,
      sessionId,
      exitCode: result.code,
      killed: result.killed,
      mcpServers: mcpSync.serverNames,
      durationMs: Date.now() - started,
    };

    // Post-mortem / reflection (fire-and-forget; never blocks the return).
    if (isSkillSystemEnabled()) {
      if (result.code !== 0) {
        const lines = result.stdout.split("\n");
        triggerPostMortem({
          info,
          task,
          workdir,
          stdoutTail: lines.slice(-200).join("\n"),
          stderrTail: result.stderr.slice(-2000),
        });
      } else if (isSubstantialRun(task, info.durationMs)) {
        triggerReflection({ info, task, workdir, output: text });
      }
    }

    return info;
  } finally {
    // Step 5: Cleanup scoped MCP config
    cleanupMCPConfig(config.id);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Background Launcher (detached, non-blocking)
// ══════════════════════════════════════════════════════════════════════════════

export type BackgroundSession = {
  runId: string;
  agentId: string;
  mcpServers: string[];
  startedAt: number;
  pid?: number;
  /** Resolves when the child exits, with the same shape as spawnClaudeCodeAgent. */
  finalPromise: Promise<SessionInfo>;
  /** Subscribe to stdout chunks (called for every Buffer received). */
  onStdout: (fn: (chunk: string) => void) => () => void;
  /** Subscribe to stderr chunks. */
  onStderr: (fn: (chunk: string) => void) => () => void;
  /** Terminate the child process. */
  kill: (signal?: NodeJS.Signals) => boolean;
};

/**
 * Spawn a Claude Code CLI agent and return immediately with a handle. The
 * child runs in the background; `finalPromise` resolves with SessionInfo when
 * it exits. Cleanup of the scoped MCP config happens after exit.
 */
export function spawnClaudeCodeAgentBackground(
  config: CLIAgentConfig,
  task: string,
  workdir: string,
  options: LaunchOptions = {},
): BackgroundSession {
  const runId = options.runId ?? randomUUID();
  const startedAt = Date.now();

  log.info(`launching claude-code agent in background "${config.id}" (runId=${runId})`);

  // Inject InfiniBot preamble before spawning.
  // Pass the task so browser-task detection can load browser-specific skills.
  let launchOptions = options;
  if (isSkillSystemEnabled()) {
    const { preamble, skillCount, cacheState } = buildClaudeCoderPreamble(workdir, { task });
    log.info(`claude-coder spawn ${runId}: injected ${skillCount} skills (${cacheState})`);
    const combined = preamble + (options.systemPrompt ? "\n\n" + options.systemPrompt : "");
    launchOptions = { ...options, systemPrompt: combined };
  }

  const mcpSync = generateMCPConfig(config);
  log.info(`MCP bridge: ${mcpSync.serverCount} servers synced for agent "${config.id}"`);

  // Same Windows-shim resolution as the sync path — raw spawn() won't try
  // PATHEXT for a bare "claude", so resolve to the absolute `.cmd` first.
  const requested = config.cliCommand || "claude";
  const command = resolveBin(requested) ?? requested;
  const { args, stdinPath } = buildArgs(config, task, mcpSync, launchOptions, runId);
  const env = buildEnv(config, launchOptions);
  const timeoutMs = config.timeoutMinutes * 60_000;

  const stdoutSubs = new Set<(chunk: string) => void>();
  const stderrSubs = new Set<(chunk: string) => void>();

  const stdio = resolveCommandStdio({ hasInput: false, preferInherit: false });
  // spawnCli routes a resolved Windows .cmd/.bat shim (e.g. claude.cmd) through
  // cmd.exe so it doesn't throw EINVAL (Node ≥18.20/20.12/22). For the bare-name
  // fallback (resolveBin miss), the shell flag lets the OS apply PATHEXT.
  const child = spawnCoderProcess(
    command,
    args,
    {
      stdio,
      cwd: workdir,
      env,
      shell: command === requested && process.platform === "win32",
    },
    options.durableRunId,
    { stdinPath },
  );
  // Detach so the child keeps running independently of the spawning request.
  child.unref?.();

  const stdoutBuf = new CappedOutput();
  const stderrBuf = new CappedOutput(16 * 1024, 1024 * 1024);

  // Stream credit hook — records per-turn usage as the CLI emits stream-json events.
  let creditHook: { feed: (s: string) => void; end: () => void } | null = null;
  void (async () => {
    try {
      creditHook = (await import("../coder-backend/cli-credit-hook.js")).createCliCreditHook({
        backend: "claude-code",
        agentId: config.id,
        taskId: runId,
        defaultProvider: "anthropic",
      });
    } catch {
      creditHook = null;
    }
  })();

  child.stdout?.on("data", (d) => {
    const chunk = d.toString();
    stdoutBuf.push(chunk);
    try {
      creditHook?.feed(chunk);
    } catch {
      /* ignore */
    }
    for (const fn of stdoutSubs) {
      try {
        fn(chunk);
      } catch {
        // listener errors must not affect the child
      }
    }
  });
  child.stderr?.on("data", (d) => {
    const chunk = d.toString();
    stderrBuf.push(chunk);
    for (const fn of stderrSubs) {
      try {
        fn(chunk);
      } catch {
        // ignore
      }
    }
  });

  const timer = setTimeout(() => {
    if (!child.killed) {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
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
      try {
        creditHook?.end();
      } catch {
        /* ignore */
      }
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        creditHook?.end();
      } catch {
        /* ignore */
      }
      const stdout = stdoutBuf.toString();
      const stderr = stderrBuf.toString();
      const { text, json, sessionId } = parseOutput(stdout);
      if (code !== 0) {
        const errInfo = stderr.trim() || text || `exited with code ${code}`;
        log.warn(`bg agent "${config.id}" exited code ${code}: ${errInfo.slice(0, 200)}`);
      }
      cleanupMCPConfig(config.id);
      const info: SessionInfo = {
        runId,
        agentId: config.id,
        output: text,
        json,
        sessionId,
        exitCode: code,
        killed: child.killed,
        mcpServers: mcpSync.serverNames,
        durationMs: Date.now() - startedAt,
      };

      // Post-mortem / reflection (fire-and-forget).
      if (isSkillSystemEnabled()) {
        if (code !== 0) {
          const lines = stdout.split("\n");
          triggerPostMortem({
            info,
            task,
            workdir,
            stdoutTail: lines.slice(-200).join("\n"),
            stderrTail: stderr.slice(-2000),
          });
        } else if (isSubstantialRun(task, info.durationMs)) {
          triggerReflection({ info, task, workdir, output: text });
        }
      }

      resolve(info);
    });
  });

  // Ensure unhandled rejection doesn't crash the process — callers attach as needed.
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

/**
 * Background variant of runClaudeCodeWithMCPs. Returns a handle immediately;
 * the child runs in the background. Use `finalPromise` to await completion.
 */
export function runClaudeCodeWithMCPsBackground(params: {
  agentId: string;
  agentName: string;
  task: string;
  workdir: string;
  enabledMCPs: string[];
  autoApprove?: boolean;
  timeoutMinutes?: number;
  model?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  env?: Record<string, string>;
}): BackgroundSession {
  const config: CLIAgentConfig = {
    id: params.agentId,
    name: params.agentName,
    type: "cli",
    cliCommand: "claude",
    autoApprove: params.autoApprove ?? true,
    timeoutMinutes: params.timeoutMinutes ?? 10,
    enabledMCPs: params.enabledMCPs,
    allowedTools: params.allowedTools,
    env: params.env,
  };
  return spawnClaudeCodeAgentBackground(config, params.task, params.workdir, {
    model: params.model,
    systemPrompt: params.systemPrompt,
  });
}

/**
 * Convenience wrapper: spawn a Claude Code agent with typical defaults.
 */
export async function runClaudeCodeWithMCPs(params: {
  agentId: string;
  agentName: string;
  task: string;
  workdir: string;
  enabledMCPs: string[];
  autoApprove?: boolean;
  timeoutMinutes?: number;
  model?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  env?: Record<string, string>;
}): Promise<SessionInfo> {
  const config: CLIAgentConfig = {
    id: params.agentId,
    name: params.agentName,
    type: "cli",
    cliCommand: "claude",
    autoApprove: params.autoApprove ?? true,
    timeoutMinutes: params.timeoutMinutes ?? 10,
    enabledMCPs: params.enabledMCPs,
    allowedTools: params.allowedTools,
    env: params.env,
  };

  return spawnClaudeCodeAgent(config, params.task, params.workdir, {
    model: params.model,
    systemPrompt: params.systemPrompt,
  });
}
