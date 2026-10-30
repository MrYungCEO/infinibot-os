import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("autonomy.cli-planner");

const PLANNER_CLI_TIMEOUT_MS = 60_000;
// Re-probe CLI availability at most every 30s. The autonomy heartbeat runs
// every ~20s and used to fork a `--version` subprocess each tick; on a busy
// box that adds up fast, and a transient failure put the goal into the
// "credentials unavailable" branch for the rest of the turn.
const CLI_PROBE_TTL_MS = 30_000;

export type CliPlannerBackend = "claude-code" | "opencode" | "codex" | "gemini" | "grok";

export interface CliPlannerOptions {
  backend: CliPlannerBackend;
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Overrides the default 60s spawn timeout (the verification judge waits longer under load). */
  timeoutMs?: number;
}

function defaultBinaryName(backend: CliPlannerBackend): string {
  switch (backend) {
    case "claude-code":
      return "claude";
    case "opencode":
      return "opencode";
    case "codex":
      return "codex";
    case "gemini":
      return "gemini";
    case "grok":
      return "grok";
    default:
      return backend as string;
  }
}

// Known install locations to probe when PATH lookup fails. Autonomy runs from
// the gateway process which, depending on launch (systemd / electron / IDE),
// may not inherit the user's login PATH — so `which claude` returns nothing
// and the orchestrator falls back to the API path with no key. This list
// covers npm-global, the local Claude versioned dir, nvm (all installed Node
// versions, including the one currently selected), pnpm, bun and Homebrew.
function fallbackPaths(backend: CliPlannerBackend): string[] {
  const name = defaultBinaryName(backend);
  const home = homedir();
  const candidates: Array<string | undefined> = [
    process.env[envOverrideKey(backend)],
    join(home, ".npm-global", "bin", name),
    join(home, ".local", "bin", name),
    join(home, ".local", "share", "pnpm", name),
    join(home, ".bun", "bin", name),
    `/usr/local/bin/${name}`,
    `/opt/homebrew/bin/${name}`,
  ];
  // nvm: scan ~/.nvm/versions/node/* for every installed Node and add each
  // bin/<name> path. This catches the common case where opencode/codex were
  // installed under the active nvm node — its bin dir is only on PATH when
  // launched from a login shell that ran `nvm use`.
  try {
    const nvmRoot = join(home, ".nvm", "versions", "node");
    if (existsSync(nvmRoot)) {
      const versions = readdirSync(nvmRoot).sort().reverse();
      for (const v of versions) candidates.push(join(nvmRoot, v, "bin", name));
    }
  } catch {
    /* nvm not installed — skip silently */
  }
  return candidates.filter((p): p is string => !!p);
}

function envOverrideKey(backend: CliPlannerBackend): string {
  switch (backend) {
    case "claude-code":
      return "INFINIBOT_CLAUDE_CLI_PATH";
    case "opencode":
      return "INFINIBOT_OPENCODE_CLI_PATH";
    case "codex":
      return "INFINIBOT_CODEX_CLI_PATH";
    case "gemini":
      return "INFINIBOT_GEMINI_CLI_PATH";
    case "grok":
      return "INFINIBOT_GROK_CLI_PATH";
    default:
      return `INFINIBOT_${(backend as string).toUpperCase()}_CLI_PATH`;
  }
}

const resolvedPathCache = new Map<CliPlannerBackend, { path: string | null; checkedAt: number }>();

/**
 * Resolve the actual path to a CLI binary. Tries (in order):
 *   1. Env override (INFINIBOT_<NAME>_CLI_PATH)
 *   2. Bare name via PATH (spawnSync `<name> --version`)
 *   3. Known install paths (npm-global, ~/.local/bin, pnpm, bun, homebrew)
 *
 * Caches the result for 30s. Returns null if nothing works.
 */
export function resolveCliPath(backend: CliPlannerBackend): string | null {
  const cached = resolvedPathCache.get(backend);
  const now = Date.now();
  if (cached && now - cached.checkedAt < CLI_PROBE_TTL_MS) {
    return cached.path;
  }
  const name = defaultBinaryName(backend);
  const tried: Array<{ path: string; reason: string }> = [];

  const override = process.env[envOverrideKey(backend)]?.trim();
  if (override) {
    if (existsSync(override) && probeBinary(override)) {
      resolvedPathCache.set(backend, { path: override, checkedAt: now });
      return override;
    }
    tried.push({ path: override, reason: "env override unusable" });
  }

  // Bare name on PATH (cheapest happy path)
  if (probeBinary(name)) {
    resolvedPathCache.set(backend, { path: name, checkedAt: now });
    return name;
  }
  tried.push({ path: name, reason: "not on PATH" });

  for (const candidate of fallbackPaths(backend)) {
    if (!existsSync(candidate)) continue;
    if (probeBinary(candidate)) {
      log.info("cli-planner: resolved via fallback path", { backend, path: candidate });
      resolvedPathCache.set(backend, { path: candidate, checkedAt: now });
      return candidate;
    }
    tried.push({ path: candidate, reason: "exists but --version failed" });
  }

  log.warn("cli-planner: CLI binary unresolvable", { backend, tried });
  resolvedPathCache.set(backend, { path: null, checkedAt: now });
  return null;
}

function probeBinary(binary: string): boolean {
  try {
    const result = spawnSync(binary, ["--version"], {
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

export function checkCliAvailable(backend: CliPlannerBackend): boolean {
  return resolveCliPath(backend) !== null;
}

/** Test-only: clear the resolved-path cache so probes re-run on next call. */
export function resetCliPathCacheForTests(): void {
  resolvedPathCache.clear();
}

/** Single final JSON object (`gemini -o json` → response, `grok --output-format json` → text). */
function parseJsonField(stdout: string, field: string): string {
  const trimmed = stdout.trim();
  const start = trimmed.indexOf("{");
  if (start < 0) return "";
  try {
    const obj = JSON.parse(trimmed.slice(start)) as Record<string, unknown>;
    return typeof obj[field] === "string" ? (obj[field] as string).trim() : "";
  } catch {
    return "";
  }
}

function parseClaudeOutput(stdout: string): string {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  let resultText = "";
  for (const line of lines) {
    try {
      const ev = JSON.parse(line) as Record<string, unknown>;
      if (ev.type === "result" && typeof ev.result === "string") {
        resultText = ev.result;
      }
    } catch {
      // skip non-JSON lines
    }
  }
  return resultText || (lines.at(-1) ?? "");
}

function parseOpencodeOutput(stdout: string): string {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  let resultText = "";
  for (const line of lines) {
    try {
      const ev = JSON.parse(line) as Record<string, unknown>;
      if (ev.type === "text" && typeof ev.text === "string") {
        resultText = ev.text;
      }
      if ((ev.type === "step_finish" || ev.type === "result") && typeof ev.result === "string") {
        resultText = ev.result;
      }
    } catch {
      // skip non-JSON lines
    }
  }
  return resultText || (lines.at(-1) ?? "");
}

function parseCodexOutput(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof parsed.result === "string") return parsed.result;
    if (typeof parsed.text === "string") return parsed.text;
  } catch {
    // not JSON, return raw
  }
  return trimmed;
}

function buildArgs(backend: CliPlannerBackend, combinedPrompt: string): string[] {
  switch (backend) {
    case "claude-code":
      return [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
        combinedPrompt,
      ];
    case "opencode":
      return ["run", "--format", "json", "--dangerously-skip-permissions", combinedPrompt];
    case "codex":
      return ["exec", "--json", "--dangerously-bypass-approvals-and-sandbox", combinedPrompt];
    case "gemini":
      return ["-o", "json", "--approval-mode", "yolo", "-p", combinedPrompt];
    case "grok":
      return [
        "--output-format",
        "json",
        "--always-approve",
        "--no-auto-update",
        "-p",
        combinedPrompt,
      ];
    default:
      return [combinedPrompt];
  }
}

function buildEnv(backend: CliPlannerBackend, systemPrompt: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  // Strip raw provider API keys so the CLI uses its own OAuth/login
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_API_KEY_OLD;
  delete env.OPENAI_API_KEY;
  // Grok Build: the gateway's xAI API key would turn a subscription sign-in
  // into billed API usage.
  if (backend === "grok") {
    delete env.XAI_API_KEY;
    delete env.GROK_CODE_XAI_API_KEY;
  }

  if (systemPrompt && backend === "opencode") {
    try {
      const existing = env.OPENCODE_CONFIG_CONTENT
        ? (JSON.parse(env.OPENCODE_CONFIG_CONTENT) as Record<string, unknown>)
        : {};
      const inner = (existing.claudeCoderConfig as Record<string, unknown>) ?? {};
      inner.systemPrompt = systemPrompt;
      existing.claudeCoderConfig = inner;
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify(existing);
    } catch {
      // If existing config is unparseable, set fresh
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        claudeCoderConfig: { systemPrompt },
      });
    }
  }

  return env;
}

function executeCli(options: CliPlannerOptions): Promise<string> {
  const { backend, systemPrompt, userMessage, signal } = options;
  const timeoutMs = options.timeoutMs ?? PLANNER_CLI_TIMEOUT_MS;
  // Use the resolved path (env override / fallback dir) when PATH lookup
  // doesn't find it — same fix as checkCliAvailable, applied at spawn time.
  const binary = resolveCliPath(backend) ?? defaultBinaryName(backend);

  const combinedPrompt = `${systemPrompt}\n\n${userMessage}`;
  const args = buildArgs(backend, combinedPrompt);
  const env = buildEnv(backend, systemPrompt);

  // stdin: "ignore" for opencode (blocks on open empty pipe), "pipe"
  // for claude and codex (no input sent, but safe).
  const stdinMode: "ignore" | "pipe" =
    backend === "opencode" || backend === "gemini" || backend === "grok" ? "ignore" : "pipe";

  return new Promise<string>((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: [stdinMode, "pipe", "pipe"],
      env,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const safeKill = () => {
      if (!child.killed) child.kill("SIGKILL");
    };

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal?.aborted) {
        safeKill();
        reject(new Error("CLI planner aborted"));
        return;
      }
      if (err) {
        safeKill();
        reject(err);
        return;
      }
      const text = (() => {
        switch (backend) {
          case "claude-code":
            return parseClaudeOutput(stdout);
          case "opencode":
            return parseOpencodeOutput(stdout);
          case "codex":
            return parseCodexOutput(stdout);
          case "gemini":
            return parseJsonField(stdout, "response");
          case "grok":
            return parseJsonField(stdout, "text");
        }
      })();
      if (text) {
        resolve(text);
      } else {
        const fallback = stderr.trim() || stdout.trim() || "(empty output)";
        reject(new Error(`CLI planner returned no parsable text: ${fallback.slice(0, 500)}`));
      }
    };

    const timer = setTimeout(() => {
      safeKill();
      finish(new Error(`CLI planner timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        safeKill();
        reject(new Error("CLI planner aborted before spawn"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          safeKill();
          finish(new Error("CLI planner aborted"));
        },
        { once: true },
      );
    }

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });

    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    child.on("error", (err) => finish(err));

    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0 && !stdout.trim()) {
        finish(
          new Error(
            `CLI planner exited with code ${code}: ${stderr.trim().slice(0, 500) || "(no stderr)"}`,
          ),
        );
      } else {
        finish();
      }
    });
  });
}

/**
 * Shell out to a CLI binary (claude / opencode / codex) for the
 * orchestrator's planner call. Requires the CLI to be installed and
 * logged in via its own auth flow (no direct provider API key needed).
 *
 * Returns the assistant text response, or throws on failure.
 */
export function runCliPlanner(options: CliPlannerOptions): Promise<string> {
  const { backend } = options;
  const binary = resolveCliPath(backend) ?? defaultBinaryName(backend);

  log.info("cli-planner: spawning", { backend, binary });

  return executeCli(options);
}
