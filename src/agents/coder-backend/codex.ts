/**
 * CodexCliBackend — wraps the OpenAI Codex CLI (@openai/codex).
 *
 * Research findings (2026-05-27):
 *   Package:        @openai/codex  (npm install -g @openai/codex)
 *   Binary:         codex
 *   Version flag:   codex --version
 *   Non-interactive: codex exec "task"  (NOT `codex run`)
 *   JSON output:    codex exec --json "task"  → JSONL events on stdout
 *   Auto-approve:   --dangerously-bypass-approvals-and-sandbox  (exec flag)
 *   Model:          codex --model <name> exec ...  (global flag, before subcommand)
 *   Session resume: codex exec [flags] resume <SESSION_ID> "task"
 *   Config dir:     ~/.codex/  (override via $CODEX_HOME)
 *   Config file:    ~/.codex/config.toml  (TOML)
 *   MCP servers:    [mcp_servers.<name>] sections in config.toml
 *   Per-session MCPs: named profile at $CODEX_HOME/<name>.config.toml,
 *                    selected via codex --profile <name> exec ...
 *   API key:        CODEX_API_KEY or OPENAI_API_KEY in env
 *   Note: `instructions` config key is reserved/future-use; system prompts
 *         are prepended to the task string instead.
 *
 * COORDINATION: codex-backend
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
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
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createCliCreditHook } from "./cli-credit-hook.js";
import type { CLIAgentConfig } from "../types/agent-types.js";

const log = createSubsystemLogger("codex-backend");
import type { SessionInfo, LaunchOptions, BackgroundSession } from "../claude-code/launcher.js";
import type {
  CoderBackend,
  CoderBackendCapabilities,
  BackendInstallStatus,
  McpServerEntry,
} from "./types.js";
import { allowCoderBypassFlag } from "./approval-policy.js";
import { CappedOutput } from "./capped-output.js";

export const CODEX_EXEC_STDIO: ["ignore", "pipe", "pipe"] = ["ignore", "pipe", "pipe"];

const CODEX_BYPASS_APPROVALS_FLAG = "--dangerously-bypass-approvals-and-sandbox";
const CODEX_APPROVAL_SANDBOX_FLAGS_WITH_VALUE = new Set([
  "--ask-for-approval",
  "--approval-mode",
  "--approval-policy",
  "--sandbox",
  "--sandbox-mode",
]);
const CODEX_APPROVAL_SANDBOX_FLAG_PREFIXES = [
  "--ask-for-approval=",
  "--approval-mode=",
  "--approval-policy=",
  "--sandbox=",
  "--sandbox-mode=",
];

/** True when operator-configured args pin an approval policy or sandbox mode. */
function hasCodexApprovalOrSandboxArgs(cliArgs: string[] | undefined): boolean {
  return (cliArgs ?? []).some(
    (arg) =>
      CODEX_APPROVAL_SANDBOX_FLAGS_WITH_VALUE.has(arg) ||
      CODEX_APPROVAL_SANDBOX_FLAG_PREFIXES.some((prefix) => arg.startsWith(prefix)),
  );
}

/**
 * Operator-configured codex args are kept verbatim — including stricter
 * approval / sandbox settings, which win over autoApprove (see
 * resolveCodexBypass). Only `--json` (always added by us) and the bypass flag
 * itself (added by us only when allowed) are dropped so they can't duplicate
 * or sneak a bypass into an untrusted spawn.
 */
function sanitizeCodexCliArgs(cliArgs: string[] | undefined): string[] {
  return (cliArgs ?? []).filter((arg) => arg !== "--json" && arg !== CODEX_BYPASS_APPROVALS_FLAG);
}

/**
 * Whether to append the approvals+sandbox bypass. Never when the operator
 * pinned an approval/sandbox mode in cliArgs (codex rejects both together, and
 * the stricter operator choice must win), never when autoApprove is off, and
 * never under tools.coder.autoApprove="never".
 */
function resolveCodexBypass(config: CLIAgentConfig): boolean {
  if (hasCodexApprovalOrSandboxArgs(config.cliArgs)) return false;
  return allowCoderBypassFlag(config.autoApprove);
}

// ── Path helpers ───────────────────────────────────────────────────────────
// COORDINATION: codex-backend

function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

function codexConfigPath(): string {
  return join(codexHome(), "config.toml");
}

function repoRoot(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return resolve(here, "..", "..", "..");
  } catch {
    return process.cwd();
  }
}

// ── Minimal TOML section manager ───────────────────────────────────────────
// Handles [section.key] blocks in ~/.codex/config.toml.
// Full TOML parsing isn't needed — we only manage [mcp_servers.<name>] blocks.
// COORDINATION: codex-backend

export interface TomlDoc {
  /** Lines before any section header */
  preamble: string[];
  /** section-key → body lines (not including the [header] line itself) */
  sections: Map<string, string[]>;
  /** Insertion-order list of section keys */
  order: string[];
}

export function parseTomlSections(raw: string): TomlDoc {
  const lines = raw.split("\n");
  const preamble: string[] = [];
  const sections = new Map<string, string[]>();
  const order: string[] = [];
  let current: string | null = null;

  for (const line of lines) {
    // Match bare TOML section headers like [mcp_servers.foo] or [section]
    const m = line.match(/^\[([^\]]+)\]\s*(?:#.*)?$/);
    if (m) {
      current = m[1];
      if (!sections.has(current)) {
        sections.set(current, []);
        order.push(current);
      }
    } else if (current === null) {
      preamble.push(line);
    } else {
      sections.get(current)!.push(line);
    }
  }

  return { preamble, sections, order };
}

export function serializeTomlDoc(doc: TomlDoc): string {
  const parts: string[] = [];

  // Preserve preamble (comments, top-level keys, blank lines)
  const preambleStr = doc.preamble.join("\n").trimEnd();
  if (preambleStr) parts.push(preambleStr);

  for (const name of doc.order) {
    const bodyLines = [...(doc.sections.get(name) ?? [])];
    // Trim trailing blank lines inside the section body
    while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === "") {
      bodyLines.pop();
    }
    parts.push(`\n[${name}]\n${bodyLines.join("\n")}`);
  }

  const result = parts.join("\n");
  return (result.trimEnd() || "") + "\n";
}

// ── TOML value serializers ─────────────────────────────────────────────────
// COORDINATION: codex-backend

/** Serialize a string array as TOML array: ["a", "b"] */
function toTomlStringArray(arr: string[]): string {
  return "[" + arr.map((v) => JSON.stringify(v)).join(", ") + "]";
}

/** Serialize a string→string map as TOML inline table: { KEY = "value" } */
function toTomlInlineTable(obj: Record<string, string>): string {
  const pairs = Object.entries(obj)
    .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
    .join(", ");
  return `{ ${pairs} }`;
}

/** Render an McpServerEntry as [mcp_servers.<name>] TOML section body lines */
function mcpEntryToTomlLines(entry: McpServerEntry): string[] {
  const lines: string[] = [];
  if (entry.url) {
    lines.push(`url = ${JSON.stringify(entry.url)}`);
    if (entry.headers && Object.keys(entry.headers).length > 0) {
      lines.push(`http_headers = ${toTomlInlineTable(entry.headers)}`);
    }
  } else {
    if (entry.command) {
      lines.push(`command = ${JSON.stringify(entry.command)}`);
    }
    if (entry.args && entry.args.length > 0) {
      lines.push(`args = ${toTomlStringArray(entry.args)}`);
    }
    if (entry.env && Object.keys(entry.env).length > 0) {
      lines.push(`env = ${toTomlInlineTable(entry.env)}`);
    }
  }
  if (entry.enabled === false) {
    lines.push(`enabled = false`);
  }
  return lines;
}

// ── Global config read/write ───────────────────────────────────────────────
// COORDINATION: codex-backend

function readCodexConfigDoc(): TomlDoc {
  const p = codexConfigPath();
  if (!existsSync(p)) return { preamble: [], sections: new Map(), order: [] };
  try {
    return parseTomlSections(readFileSync(p, "utf8"));
  } catch {
    return { preamble: [], sections: new Map(), order: [] };
  }
}

function writeCodexConfigDoc(doc: TomlDoc): void {
  mkdirSync(codexHome(), { recursive: true });
  writeFileSync(codexConfigPath(), serializeTomlDoc(doc), "utf8");
}

// ── Per-session profile management ────────────────────────────────────────
// Named profiles live at $CODEX_HOME/<profile-name>.config.toml
// Selected via: codex --profile <profile-name> exec ...
// Auth tokens stay in the global config.toml; profile just adds MCP servers.
// COORDINATION: codex-backend

function codexProfileName(agentId: string): string {
  const sanitized = agentId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `codex-bridge-${sanitized}`;
}

function codexProfilePath(agentId: string): string {
  return join(codexHome(), `${codexProfileName(agentId)}.config.toml`);
}

function generateCodexProfile(
  agentId: string,
  mcpServers: Record<string, McpServerEntry>,
): string | undefined {
  if (Object.keys(mcpServers).length === 0) return undefined;

  const lines: string[] = [];
  for (const [name, entry] of Object.entries(mcpServers)) {
    lines.push(`[mcp_servers.${name}]`);
    lines.push(...mcpEntryToTomlLines(entry));
    lines.push("");
  }

  const profilePath = codexProfilePath(agentId);
  mkdirSync(codexHome(), { recursive: true });
  writeFileSync(profilePath, lines.join("\n"), "utf8");
  return codexProfileName(agentId);
}

function cleanupCodexProfile(agentId: string): void {
  try {
    const p = codexProfilePath(agentId);
    if (existsSync(p)) unlinkSync(p);
  } catch {
    /* ignore — best-effort cleanup */
  }
}

// ── Read MCP servers from the Claude Code bridge file ─────────────────────
// (Same bridge file that opencode.ts reads)
// COORDINATION: codex-backend

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
        `Codex will run with zero MCP servers.`,
    );
    return {};
  }
}

// ── CLI argument builder ───────────────────────────────────────────────────
// COORDINATION: codex-backend

function buildCodexArgs(
  config: CLIAgentConfig,
  task: string,
  options: LaunchOptions,
  profileName?: string,
): string[] {
  const args: string[] = [];

  // Global flags (must come before the subcommand)
  if (options.model) {
    args.push("--model", options.model);
  }
  if (profileName) {
    args.push("--profile", profileName);
  }

  // Subcommand: exec
  args.push("exec");

  // exec-level flags
  args.push("--json"); // JSONL output on stdout
  const cliArgs = sanitizeCodexCliArgs(config.cliArgs);
  if (cliArgs.length > 0) {
    args.push(...cliArgs);
  }
  if (resolveCodexBypass(config)) {
    args.push(CODEX_BYPASS_APPROVALS_FLAG);
  }

  // Session resume — must come before the prompt
  if (options.resumeSessionId) {
    args.push("resume", options.resumeSessionId);
  }

  // Final positional: the task prompt
  args.push(task);
  return args;
}

// ── Environment builder ────────────────────────────────────────────────────
// COORDINATION: codex-backend

/**
 * Large prompts can't ride in argv (E2BIG above 128 KiB per string), so write
 * them to `prompt.txt` in the run dir and pass `-`, which makes `codex exec`
 * (and `codex exec resume`) read the prompt from stdin.
 */
export function buildCodexLaunch(
  config: CLIAgentConfig,
  task: string,
  options: LaunchOptions,
  runId: string,
  profileName?: string,
): { args: string[]; stdinPath?: string } {
  const inline = buildCodexArgs(config, task, options, profileName);
  if (!exceedsInlineArgLimit(task) && inlineArgvFits(config.cliCommand || "codex", inline))
    return { args: inline };
  const stdinPath = writeRunPromptFile(runId, "prompt.txt", task);
  return { args: buildCodexArgs(config, "-", options, profileName), stdinPath };
}

export function buildCodexArgsForTest(
  config: CLIAgentConfig,
  task: string,
  options: LaunchOptions = {},
  profileName?: string,
): string[] {
  return buildCodexArgs(config, task, options, profileName);
}

function buildCodexEnv(config: CLIAgentConfig, options: LaunchOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Ensure `codex` is reachable wherever detection found it (daemon PATH may
  // omit user bin dirs like nvm, bun, npm-global).
  env.PATH = enrichedPath();
  // Keys stored in Setup › Coders for this CLI (config/options still override).
  applyCoderSpawnEnv("codex", env);
  if (config.env) {
    for (const [k, v] of Object.entries(config.env)) env[k] = v;
  }
  if (options.env) {
    for (const [k, v] of Object.entries(options.env)) env[k] = v;
  }
  return env;
}

// ── JSONL output parser ────────────────────────────────────────────────────
// Codex --json emits newline-delimited JSON events on stdout.
// COORDINATION: codex-backend

function parseCodexOutput(stdout: string): {
  text: string;
  sessionId?: string;
  json?: Record<string, unknown>;
} {
  const trimmed = stdout.trim();
  if (!trimmed) return { text: "" };

  let resultText = "";
  let sessionId: string | undefined;
  let lastEvent: Record<string, unknown> | undefined;

  for (const line of trimmed.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    try {
      const ev = JSON.parse(l) as Record<string, unknown>;

      // Session ID — look in common field names
      if (typeof ev.session_id === "string") sessionId = ev.session_id;
      if (typeof ev.sessionId === "string") sessionId = ev.sessionId;
      if (ev.type === "session" && typeof ev.id === "string") sessionId = ev.id;

      // Final text — prefer result/message events
      if (ev.type === "result" && typeof ev.output === "string") {
        resultText = ev.output;
        lastEvent = ev;
      }
      if (ev.type === "message" && ev.role === "assistant") {
        const content = ev.content;
        if (Array.isArray(content)) {
          const textParts = (content as Record<string, unknown>[])
            .filter((c) => c.type === "output_text" && typeof c.text === "string")
            .map((c) => c.text as string);
          if (textParts.length > 0) {
            resultText = textParts.join("\n");
            lastEvent = ev;
          }
        } else if (typeof content === "string") {
          resultText = content;
          lastEvent = ev;
        }
      }
      if (ev.type === "text" && typeof ev.text === "string") {
        resultText = ev.text;
        lastEvent = ev;
      }
    } catch {
      // non-JSON line — skip
    }
  }

  return { text: resultText || trimmed, sessionId, json: lastEvent };
}

// ── Backend class ──────────────────────────────────────────────────────────
// COORDINATION: codex-backend

export class CodexCliBackend implements CoderBackend {
  readonly id = "codex" as const;

  async spawn(
    config: CLIAgentConfig,
    task: string,
    workdir: string,
    options: LaunchOptions = {},
  ): Promise<SessionInfo> {
    const runId = options.runId ?? randomUUID();
    const started = Date.now();

    // Skill system — prepend preamble to task (instructions key is future-use in Codex)
    let effectiveTask = task;
    let launchOptions = options;
    if (isSkillSystemEnabled()) {
      const { preamble } = buildClaudeCoderPreamble(workdir, { task });
      const combined = preamble + (options.systemPrompt ? "\n\n" + options.systemPrompt : "");
      // For Codex: prepend system prompt to the task string (no env-var injection path)
      effectiveTask = combined + "\n\n---\n\n" + task;
      launchOptions = { ...options, systemPrompt: undefined };
    } else if (options.systemPrompt) {
      effectiveTask = options.systemPrompt + "\n\n---\n\n" + task;
      launchOptions = { ...options, systemPrompt: undefined };
    }

    const mcpSync = generateMCPConfig(config);
    const mcpServers = readMcpServersFromBridge(config.id);
    const profileName = generateCodexProfile(config.id, mcpServers);

    const command = resolveBin("codex") ?? "codex";
    const { args, stdinPath } = buildCodexLaunch(
      config,
      effectiveTask,
      launchOptions,
      runId,
      profileName,
    );
    const env = buildCodexEnv(config, launchOptions);
    const timeoutMs = config.timeoutMinutes * 60_000;

    return new Promise<SessionInfo>((resolve, reject) => {
      // codex exec reads stdin in addition to the prompt argument. In gateway
      // spawns stdin is a long-lived socket, so a pipe keeps Codex stuck at
      // "Reading additional input from stdin..." until EOF. Ignore stdin for
      // unattended prompt-as-argv runs; large prompts get a file (EOF-terminated).
      const child = stdinPath
        ? spawnCoderProcess(
            command,
            args,
            { stdio: CODEX_EXEC_STDIO, cwd: workdir, env },
            undefined,
            {
              stdinPath,
            },
          )
        : spawnCli(command, args, { stdio: CODEX_EXEC_STDIO, cwd: workdir, env });
      let stdout = "";
      let stderr = "";
      const creditHook = createCliCreditHook({
        backend: "codex",
        agentId: config.id,
        taskId: runId,
        defaultProvider: "openai",
        defaultModel: launchOptions.model,
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
        cleanupCodexProfile(config.id);
        creditHook.end();
        reject(err);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        cleanupMCPConfig(config.id);
        cleanupCodexProfile(config.id);
        creditHook.end();
        const { text, json, sessionId } = parseCodexOutput(stdout);
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

    // Skill system — same preamble injection as spawn()
    let effectiveTask = task;
    let launchOptions = options;
    if (isSkillSystemEnabled()) {
      const { preamble } = buildClaudeCoderPreamble(workdir, { task });
      const combined = preamble + (options.systemPrompt ? "\n\n" + options.systemPrompt : "");
      effectiveTask = combined + "\n\n---\n\n" + task;
      launchOptions = { ...options, systemPrompt: undefined };
    } else if (options.systemPrompt) {
      effectiveTask = options.systemPrompt + "\n\n---\n\n" + task;
      launchOptions = { ...options, systemPrompt: undefined };
    }

    const mcpSync = generateMCPConfig(config);
    const mcpServers = readMcpServersFromBridge(config.id);
    const profileName = generateCodexProfile(config.id, mcpServers);

    const command = resolveBin("codex") ?? "codex";
    const { args, stdinPath } = buildCodexLaunch(
      config,
      effectiveTask,
      launchOptions,
      runId,
      profileName,
    );
    const env = buildCodexEnv(config, launchOptions);
    const timeoutMs = config.timeoutMinutes * 60_000;

    const stdoutSubs = new Set<(chunk: string) => void>();
    const stderrSubs = new Set<(chunk: string) => void>();

    // See spawn(): Codex must not inherit an open stdin stream for exec runs.
    const child = spawnCoderProcess(
      command,
      args,
      { stdio: CODEX_EXEC_STDIO, cwd: workdir, env },
      options.durableRunId,
      { stdinPath },
    );
    child.unref?.();

    const stdoutBuf = new CappedOutput();
    const stderrBuf = new CappedOutput(16 * 1024, 1024 * 1024);
    const creditHook = createCliCreditHook({
      backend: "codex",
      agentId: config.id,
      taskId: runId,
      defaultProvider: "openai",
      defaultModel: launchOptions.model,
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
        cleanupCodexProfile(config.id);
        creditHook.end();
        reject(err);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanupMCPConfig(config.id);
        creditHook.end();
        cleanupCodexProfile(config.id);
        const stdout = stdoutBuf.toString();
        const stderr = stderrBuf.toString();
        const { text, json, sessionId } = parseCodexOutput(stdout);
        const durationMs = Date.now() - startedAt;
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

  // ── MCP global config (~/.codex/config.toml) ──────────────────────────────
  // COORDINATION: codex-backend

  async installMcp(serverName: string, entry: McpServerEntry): Promise<void> {
    const doc = readCodexConfigDoc();
    const sectionKey = `mcp_servers.${serverName}`;
    doc.sections.set(sectionKey, mcpEntryToTomlLines(entry));
    if (!doc.order.includes(sectionKey)) {
      doc.order.push(sectionKey);
    }
    writeCodexConfigDoc(doc);
  }

  async uninstallMcp(serverName: string): Promise<void> {
    const doc = readCodexConfigDoc();
    const sectionKey = `mcp_servers.${serverName}`;
    doc.sections.delete(sectionKey);
    const idx = doc.order.indexOf(sectionKey);
    if (idx !== -1) doc.order.splice(idx, 1);
    writeCodexConfigDoc(doc);
  }

  async listInstalledMcps(): Promise<string[]> {
    const doc = readCodexConfigDoc();
    return doc.order
      .filter((k) => k.startsWith("mcp_servers."))
      .map((k) => k.slice("mcp_servers.".length));
  }

  getCapabilities(): CoderBackendCapabilities {
    return {
      id: "codex",
      displayName: "Codex CLI",
      supportsStreamJson: true, // codex exec --json emits JSONL
      supportsMcpConfig: true, // via named profiles + global config.toml
      supportsSessionResume: true, // codex exec resume <SESSION_ID>
      supportsParallelSessions: true,
      modelFormat: "name", // bare model name, e.g. "gpt-4o"
    };
  }

  async checkInstalled(): Promise<BackendInstallStatus> {
    return checkCliInstalled(
      "codex",
      osInstallHint({
        win: "npm i -g @openai/codex",
        unix: "npm install -g @openai/codex",
      }),
    );
  }
}

// ── Register InfiniBot in Codex's global MCP config ───────────────────────
// Writes an `infinibot` entry to ~/.codex/config.toml so every Codex session
// can call back into the InfiniBot gateway via the mcp-stdio bridge.
// COORDINATION: codex-backend

export function registerInfinibotInCodex(opts: {
  gatewayUrl: string;
  gatewayToken?: string;
  gatewayPassword?: string;
  defaultSessionKey?: string;
  force?: boolean;
}): { path: string; changed: boolean } {
  const path = codexConfigPath();
  const doc = readCodexConfigDoc();
  const sectionKey = "mcp_servers.infinibot";

  const env: Record<string, string> = { MOLTBOT_GATEWAY_URL: opts.gatewayUrl };
  if (opts.gatewayToken) env.MOLTBOT_GATEWAY_TOKEN = opts.gatewayToken;
  if (opts.gatewayPassword) env.MOLTBOT_GATEWAY_PASSWORD = opts.gatewayPassword;
  if (opts.defaultSessionKey) env.MOLTBOT_DEFAULT_SESSION_KEY = opts.defaultSessionKey;

  const distEntry = join(repoRoot(), "dist", "cli", "mcp-stdio.js");
  const newEntry: McpServerEntry = {
    command: process.execPath,
    args: [distEntry],
    env,
  };

  const newLines = mcpEntryToTomlLines(newEntry);
  const currentLines = doc.sections.get(sectionKey);
  const currentJson = currentLines ? JSON.stringify(currentLines) : "";
  const newJson = JSON.stringify(newLines);

  if (!opts.force && currentJson === newJson) {
    return { path, changed: false };
  }

  doc.sections.set(sectionKey, newLines);
  if (!doc.order.includes(sectionKey)) {
    doc.order.push(sectionKey);
  }
  writeCodexConfigDoc(doc);
  return { path, changed: true };
}

export function isInfinibotRegisteredInCodex(): { path: string; registered: boolean } {
  const path = codexConfigPath();
  const doc = readCodexConfigDoc();
  return { path, registered: doc.sections.has("mcp_servers.infinibot") };
}

export function unregisterInfinibotFromCodex(): { path: string; removed: boolean } {
  const path = codexConfigPath();
  const doc = readCodexConfigDoc();
  const sectionKey = "mcp_servers.infinibot";

  if (!doc.sections.has(sectionKey)) return { path, removed: false };

  doc.sections.delete(sectionKey);
  const idx = doc.order.indexOf(sectionKey);
  if (idx !== -1) doc.order.splice(idx, 1);
  writeCodexConfigDoc(doc);
  return { path, removed: true };
}
