/**
 * Streaming output for CLI model providers (cli-runner.ts).
 *
 * Each CLI prints one JSON event per line. A parser turns those lines into the
 * reply text (streamed as it grows), the CLI's own session id (for resume),
 * token usage, the tools it called, and — when the run fails — a classified
 * error so failover can move on to the next CLI.
 *
 *   claude-stream-json   claude -p --output-format stream-json --verbose --include-partial-messages
 *   codex-jsonl          codex exec --json
 *   gemini-stream-json   gemini --output-format stream-json
 *   grok-streaming-json  grok --output-format streaming-json -p
 *   opencode-json        opencode run --format json
 */

import { spawnCli } from "../../process/win-spawn.js";

import type { CliStreamDialect } from "../../config/types.js";
import type { CliOutput } from "./helpers.js";

type CliUsage = NonNullable<CliOutput["usage"]>;

export type CliFailureKind =
  | "rate_limit"
  | "auth"
  | "timeout"
  | "not_installed"
  | "unsupported_account"
  | "untrusted_dir"
  /** The OS refused to start the CLI (Windows .cmd EINVAL, EACCES, bad binary). */
  | "spawn_failed"
  /** The OS refused the command line as too long (Windows ENAMETOOLONG, POSIX E2BIG). */
  | "command_too_long"
  /** Signed in, but the account's plan/tier doesn't include this CLI or model. */
  | "plan_required"
  | "unknown";

export type CliStreamState = {
  /** Reply text so far (all assistant text blocks, joined). */
  text: string;
  sessionId?: string;
  usage?: CliUsage;
  /** Tool names the CLI called, in order. */
  tools: string[];
  /** Error text the CLI reported in-band (result is_error, error event, …). */
  error?: string;
  /** The CLI said its plan's usage / rate limit is exhausted. */
  limited?: { message?: string; resetsAt?: number };
};

export interface CliStreamParser {
  /** Feed one stdout line. Returns true when the visible reply text changed. */
  push(line: string): boolean;
  readonly state: CliStreamState;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function toUsage(raw: unknown): CliUsage | undefined {
  if (!isRecord(raw)) return undefined;
  const input = num(raw.input_tokens) ?? num(raw.inputTokens) ?? num(raw.input);
  const output = num(raw.output_tokens) ?? num(raw.outputTokens) ?? num(raw.output);
  const cacheRead =
    num(raw.cache_read_input_tokens) ?? num(raw.cached_input_tokens) ?? num(raw.cacheRead);
  const cacheWrite = num(raw.cache_creation_input_tokens) ?? num(raw.cache_write_input_tokens);
  const total = num(raw.total_tokens) ?? num(raw.total);
  if (input === undefined && output === undefined && total === undefined) return undefined;
  return { input, output, cacheRead, cacheWrite, total };
}

function parseLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Accumulates text blocks; a new block after a tool call starts a new paragraph. */
class TextAccumulator {
  private blocks: string[] = [];
  private open = false;
  append(delta: string): void {
    if (!delta) return;
    if (!this.open) {
      this.blocks.push("");
      this.open = true;
    }
    this.blocks[this.blocks.length - 1] += delta;
  }
  /** Replace the current block's full text (CLIs that send whole blocks). */
  setCurrent(text: string): void {
    if (!this.open) {
      this.blocks.push("");
      this.open = true;
    }
    this.blocks[this.blocks.length - 1] = text;
  }
  /** Add a finished block in one go. */
  addBlock(text: string): void {
    if (!text) return;
    this.close();
    this.blocks.push(text);
  }
  close(): void {
    this.open = false;
  }
  get text(): string {
    return this.blocks
      .map((b) => b.trim())
      .filter(Boolean)
      .join("\n\n");
  }
}

// ── Claude Code ─────────────────────────────────────────────────────────────

class ClaudeParser implements CliStreamParser {
  readonly state: CliStreamState = { text: "", tools: [] };
  private acc = new TextAccumulator();
  private sawDeltas = false;

  push(line: string): boolean {
    const ev = parseLine(line);
    if (!ev) return false;
    const before = this.state.text;
    const type = str(ev.type);
    if (str(ev.session_id)) this.state.sessionId = str(ev.session_id);
    if (type === "stream_event" && isRecord(ev.event)) {
      const inner = ev.event;
      const innerType = str(inner.type);
      if (innerType === "content_block_delta" && isRecord(inner.delta)) {
        const text = inner.delta.type === "text_delta" ? str(inner.delta.text) : undefined;
        if (text) {
          this.sawDeltas = true;
          this.acc.append(text);
        }
      } else if (innerType === "content_block_stop" || innerType === "message_stop") {
        this.acc.close();
      }
    } else if (type === "assistant" && isRecord(ev.message)) {
      const content = Array.isArray(ev.message.content) ? ev.message.content : [];
      for (const block of content) {
        if (!isRecord(block)) continue;
        if (block.type === "tool_use" && str(block.name)) this.state.tools.push(String(block.name));
        // Without --include-partial-messages there are no deltas: use whole blocks.
        if (!this.sawDeltas && block.type === "text" && str(block.text)) {
          this.acc.addBlock(String(block.text));
        }
      }
      this.acc.close();
    } else if (type === "rate_limit_event" && isRecord(ev.rate_limit_info)) {
      const info = ev.rate_limit_info;
      if (info.status === "rejected") {
        this.state.limited = {
          resetsAt: num(info.resetsAt),
          message: `usage limit reached (${str(info.rateLimitType) ?? "plan limit"})`,
        };
      }
    } else if (type === "result") {
      this.state.usage = toUsage(ev.usage) ?? this.state.usage;
      const resultText = str(ev.result);
      if (ev.is_error === true || (str(ev.subtype) && ev.subtype !== "success")) {
        this.state.error = resultText ?? str(ev.subtype) ?? "Claude Code reported an error";
      } else if (resultText && !this.acc.text) {
        this.acc.addBlock(resultText);
      }
    }
    this.state.text = this.acc.text;
    return this.state.text !== before;
  }
}

// ── Codex CLI ───────────────────────────────────────────────────────────────

class CodexParser implements CliStreamParser {
  readonly state: CliStreamState = { text: "", tools: [] };
  private acc = new TextAccumulator();

  push(line: string): boolean {
    const ev = parseLine(line);
    if (!ev) return false;
    const before = this.state.text;
    const type = str(ev.type);
    if (type === "thread.started" && str(ev.thread_id)) this.state.sessionId = str(ev.thread_id);
    const item = isRecord(ev.item) ? ev.item : null;
    if (item) {
      const itemType = str(item.type) ?? "";
      if (type === "item.completed" && itemType === "agent_message" && str(item.text)) {
        this.acc.addBlock(String(item.text));
      } else if (type === "item.started" && itemType === "mcp_tool_call") {
        const name = str(item.tool) ?? str(item.name);
        if (name) this.state.tools.push(name);
      } else if (type === "item.completed" && itemType === "error" && str(item.message)) {
        this.state.error = String(item.message);
      }
    }
    if (type === "turn.completed") this.state.usage = toUsage(ev.usage) ?? this.state.usage;
    if (type === "turn.failed" || type === "error") {
      const err = isRecord(ev.error) ? ev.error : ev;
      this.state.error = str(err.message) ?? "Codex reported an error";
    }
    this.state.text = this.acc.text;
    return this.state.text !== before;
  }
}

// ── Gemini CLI ──────────────────────────────────────────────────────────────

class GeminiParser implements CliStreamParser {
  readonly state: CliStreamState = { text: "", tools: [] };
  private acc = new TextAccumulator();

  push(line: string): boolean {
    const ev = parseLine(line);
    if (!ev) return false;
    const before = this.state.text;
    const type = str(ev.type);
    const sid = str(ev.session_id) ?? str(ev.sessionId);
    if (sid) this.state.sessionId = sid;
    if (type === "message" && ev.role === "assistant") {
      const content = str(ev.content) ?? "";
      if (ev.delta === true) this.acc.append(content);
      else this.acc.addBlock(content);
    } else if (type === "tool_use") {
      this.acc.close();
      const name = str(ev.tool_name) ?? str(ev.name);
      if (name) this.state.tools.push(name);
    } else if (type === "error") {
      this.state.error = str(ev.message) ?? "Gemini CLI reported an error";
    } else if (type === "result") {
      const stats = isRecord(ev.stats) ? ev.stats : {};
      this.state.usage = toUsage(stats) ?? this.state.usage;
      if (ev.status === "error") {
        const err = isRecord(ev.error) ? ev.error : {};
        this.state.error = str(err.message) ?? this.state.error ?? "Gemini CLI reported an error";
      }
    }
    this.state.text = this.acc.text;
    return this.state.text !== before;
  }
}

// ── Grok Build ──────────────────────────────────────────────────────────────

class GrokParser implements CliStreamParser {
  readonly state: CliStreamState = { text: "", tools: [] };
  private acc = new TextAccumulator();

  push(line: string): boolean {
    const ev = parseLine(line);
    if (!ev) return false;
    const before = this.state.text;
    const type = str(ev.type);
    if (str(ev.sessionId)) this.state.sessionId = str(ev.sessionId);
    if (type === "text") {
      this.acc.append(typeof ev.data === "string" ? ev.data : "");
    } else if (type === "tool_call") {
      this.acc.close();
      const name = str(ev.toolName);
      if (name) this.state.tools.push(name);
    } else if (type === "end") {
      this.state.usage = toUsage(ev.usage) ?? this.state.usage;
    } else if (type === "error") {
      this.state.error = str(ev.message) ?? "Grok Build reported an error";
    } else if (type === "max_turns_reached") {
      this.state.error = "Grok Build stopped: max turns reached";
    }
    this.state.text = this.acc.text;
    return this.state.text !== before;
  }
}

// ── OpenCode ────────────────────────────────────────────────────────────────

class OpenCodeParser implements CliStreamParser {
  readonly state: CliStreamState = { text: "", tools: [] };
  private parts = new Map<string, string>();
  private order: string[] = [];

  push(line: string): boolean {
    const ev = parseLine(line);
    if (!ev) return false;
    const before = this.state.text;
    const type = str(ev.type);
    const part = isRecord(ev.part) ? ev.part : {};
    const sid = str(ev.sessionID) ?? str(part.sessionID);
    if (sid) this.state.sessionId = sid;
    if (type === "text") {
      const id = str(part.id) ?? `part-${this.order.length}`;
      if (!this.parts.has(id)) this.order.push(id);
      this.parts.set(id, typeof part.text === "string" ? part.text : "");
    } else if (type === "tool_use") {
      const name = str(part.tool);
      const callId = str(part.callID);
      if (name && (!callId || !this.state.tools.includes(`${name}#${callId}`))) {
        this.state.tools.push(callId ? `${name}#${callId}` : name);
      }
    } else if (type === "step_finish") {
      const tokens = isRecord(part.tokens) ? part.tokens : null;
      if (tokens) {
        const cache = isRecord(tokens.cache) ? tokens.cache : {};
        this.state.usage = {
          input: num(tokens.input),
          output: num(tokens.output),
          cacheRead: num(cache.read),
          cacheWrite: num(cache.write),
        };
      }
    } else if (type === "error") {
      const err = isRecord(ev.error) ? ev.error : {};
      const data = isRecord(err.data) ? err.data : {};
      this.state.error = str(data.message) ?? str(err.name) ?? "OpenCode reported an error";
    }
    this.state.text = this.order
      .map((id) => (this.parts.get(id) ?? "").trim())
      .filter(Boolean)
      .join("\n\n");
    return this.state.text !== before;
  }
}

export function createCliStreamParser(dialect: CliStreamDialect): CliStreamParser {
  switch (dialect) {
    case "claude-stream-json":
      return new ClaudeParser();
    case "codex-jsonl":
      return new CodexParser();
    case "gemini-stream-json":
      return new GeminiParser();
    case "grok-streaming-json":
      return new GrokParser();
    case "opencode-json":
      return new OpenCodeParser();
  }
}

// ── failure classification ──────────────────────────────────────────────────

const RATE_LIMIT_RE =
  /usage limit|rate[ _-]?limit|limit reached|hit your (?:usage )?limit|quota|too many requests|\b429\b|resource[_ ]exhausted|out of (?:credits|messages)|try again (?:at|in|after)|usage credits|add (?:usage )?credits|insufficient (?:credits|balance|funds|quota)|credit balance (?:is )?too low|payment (?:failed|required)|update your payment method/i;
const AUTH_RE =
  /not (?:signed|logged) in|please (?:run )?\/?login|run `?\w+ (?:auth )?login|login required|sign in (?:again|to)|unauthori[sz]ed|\b401\b|\b403\b|invalid (?:api key|credentials|token)|authentication (?:failed|required)|oauth token (?:has )?expired|credentials? (?:expired|not found)/i;
const TIMEOUT_RE = /timed? ?out|deadline exceeded|ETIMEDOUT/i;
// Google ended Gemini CLI for the free "Code Assist for individuals" tier
// (IneligibleTierError / UNSUPPORTED_CLIENT); older CLIs asked for a project.
const GEMINI_UNSUPPORTED_RE =
  /IneligibleTierError|UNSUPPORTED_CLIENT|no longer supported for Gemini Code Assist/i;
const GEMINI_PROJECT_RE = /GOOGLE_CLOUD_PROJECT(?:_ID)?/;
const UNTRUSTED_DIR_RE = /not running in a trusted (?:directory|folder)/i;
// The OS refused to start the process: Windows .cmd shims without a shell
// (EINVAL, CVE-2024-27980), no execute bit (EACCES), wrong-arch binary, …
// The command line was too long for the OS: Windows CreateProcess
// (ENAMETOOLONG, 32,767 chars) / cmd.exe (8,191), POSIX execve (E2BIG).
const COMMAND_TOO_LONG_RE =
  /\b(?:ENAMETOOLONG|E2BIG)\b|argument list too long|the command line is too long|filename or extension is too long/i;
const SPAWN_FAILED_RE =
  /\bspawn\b[^\n]*\b(?:EINVAL|EACCES|EPERM|ENOEXEC|EFTYPE|UNKNOWN)\b|\b(?:EINVAL|EACCES|ENOEXEC|EFTYPE)\b|exec format error|is not a valid win32 application/i;
// Signed in, but the plan/tier doesn't cover this CLI or model.
const PLAN_REQUIRED_RE =
  /not (?:available|included|supported) (?:on|in|for|with) your (?:current )?(?:plan|tier|subscription|account)|upgrade (?:your|to a) (?:plan|subscription|paid)|requires? an? (?:paid|pro|plus|max|premium|team|enterprise) (?:plan|subscription|account|tier)|does(?:n't| not) have access to (?:this )?(?:model|claude code|codex|grok)|subscription (?:is )?(?:required|inactive|expired)|no active subscription|organization (?:has been|is) disabled/i;

export function classifyCliFailure(text: string): CliFailureKind {
  if (!text) return "unknown";
  if (COMMAND_TOO_LONG_RE.test(text)) return "command_too_long";
  if (/ENOENT|command not found|not installed|no such file/i.test(text)) return "not_installed";
  if (GEMINI_UNSUPPORTED_RE.test(text) || GEMINI_PROJECT_RE.test(text))
    return "unsupported_account";
  if (UNTRUSTED_DIR_RE.test(text)) return "untrusted_dir";
  if (SPAWN_FAILED_RE.test(text)) return "spawn_failed";
  if (RATE_LIMIT_RE.test(text)) return "rate_limit";
  if (PLAN_REQUIRED_RE.test(text)) return "plan_required";
  if (AUTH_RE.test(text)) return "auth";
  if (TIMEOUT_RE.test(text)) return "timeout";
  return "unknown";
}

const GEMINI_KEY_HINT = "Use a Gemini API key (free from aistudio.google.com/apikey)";
const UNSUPPORTED_ACCOUNT_TEXT = `Google no longer lets free Google accounts use Gemini CLI. ${GEMINI_KEY_HINT} or a paid Google AI Pro/Ultra or Code Assist Standard account.`;
const NEEDS_PROJECT_TEXT = `This Google account needs a Google Cloud project to use Gemini CLI. ${GEMINI_KEY_HINT}, or use a paid Google AI Pro/Ultra or Code Assist Standard account.`;
const UNTRUSTED_DIR_TEXT =
  "Gemini CLI wouldn't run because it doesn't trust its working folder. Update InfiniBot and try again, or run `gemini` once in a terminal and trust the folder.";

/** Is this one of describeCliFailure's Gemini "account not allowed" messages? */
export function isUnsupportedAccountMessage(message: string): boolean {
  return message === UNSUPPORTED_ACCOUNT_TEXT || message === NEEDS_PROJECT_TEXT;
}

export function isUntrustedDirMessage(message: string): boolean {
  return message === UNTRUSTED_DIR_TEXT;
}

/** One-line, user-facing explanation for a failed CLI turn. */
export function describeCliFailure(params: {
  kind: CliFailureKind;
  label: string;
  command: string;
  detail?: string;
  resetsAt?: number;
}): string {
  const { label, command } = params;
  const detail = pickDetailLine(params.detail);
  switch (params.kind) {
    case "rate_limit": {
      const when = params.resetsAt
        ? ` It resets ${new Date(params.resetsAt * (params.resetsAt < 1e12 ? 1000 : 1)).toLocaleString()}.`
        : "";
      return `${label} has hit your plan's usage limit.${when}${detail ? ` (${detail})` : ""}`;
    }
    case "auth":
      return `${label} isn't signed in. Sign in from Setup › Coders, or run \`${command} login\` in a terminal.`;
    case "timeout":
      return `${label} didn't answer in time.${detail ? ` (${detail})` : ""}`;
    case "not_installed":
      return `${label} isn't installed on this computer (\`${command}\` was not found). Install it from Setup › Coders.`;
    case "unsupported_account": {
      const d = params.detail ?? "";
      return GEMINI_PROJECT_RE.test(d) && !GEMINI_UNSUPPORTED_RE.test(d)
        ? NEEDS_PROJECT_TEXT
        : UNSUPPORTED_ACCOUNT_TEXT;
    }
    case "untrusted_dir":
      return UNTRUSTED_DIR_TEXT;
    case "spawn_failed":
      return `${label} couldn't be started on this computer. Reinstall it from Setup › Coders (or update InfiniBot), then try again.`;
    case "command_too_long":
      return `${label} couldn't be started: this chat's instructions were too long for your computer's command line. Update InfiniBot to the latest version (it sends long instructions through a file), then try again.`;
    case "plan_required":
      return `${label} is signed in, but your plan doesn't include this. Sign in with an account whose plan does, or pick another AI account.${detail ? ` (${detail})` : ""}`;
    default:
      return `${label} failed${detail ? `: ${detail}` : "."}`;
  }
}

/** CLI chatter that never explains a failure. */
const NOISE_LINE_RE =
  /^(?:loaded cached credentials\.?|reading prompt from stdin\.*|data collection is disabled\.?|\[?debug\]?.*|warning: .*deprecated.*)$/i;

/** A line with nothing to read: only brackets, quotes, commas, colons. */
const PUNCT_ONLY_RE = /^[\s{}[\](),;:'"`]*$/;
const ERROR_LINE_RE = /\b(?:error|failed|failure|exception|denied|refused|unsupported)\b/i;
const REASON_LINE_RE = /^(?:reasonMessage|message)\s*:\s*['"`]?(.+?)['"`]?,?$/i;

/**
 * The most informative line of a CLI's error output: a `reasonMessage:` /
 * `message:` field, else the first line that names an error, else the first
 * readable line. Never a lone bracket from a multi-line error object.
 */
export function pickDetailLine(detail: string | undefined): string | undefined {
  const lines = (detail ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !NOISE_LINE_RE.test(l) && l !== "ENOENT" && !PUNCT_ONLY_RE.test(l));
  for (const l of lines) {
    const m = REASON_LINE_RE.exec(l);
    if (m?.[1] && m[1].length > 8) return m[1].slice(0, 240);
  }
  const named = lines.find((l) => ERROR_LINE_RE.test(l));
  return (named ?? lines[0])?.slice(0, 240);
}

// ── process ─────────────────────────────────────────────────────────────────

export type CliProcessResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdoutTail: string;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: NodeJS.ErrnoException;
};

const STDERR_CAP = 64 * 1024;
const KILL_GRACE_MS = 3000;

/** Spawn a CLI, hand each stdout line to onLine, enforce timeout + abort. */
export function runCliProcess(params: {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onLine: (line: string) => void;
}): Promise<CliProcessResult> {
  return new Promise((resolve) => {
    const [command, ...args] = params.argv;
    let stderr = "";
    let stdoutTail = "";
    let buffered = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    // spawnCli: Windows .cmd shims (claude.cmd, gemini.cmd) run via their real
    // target instead of failing with EINVAL.
    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(command ?? "", args, {
        cwd: params.cwd,
        env: params.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      // Some spawn failures throw synchronously (Windows ENAMETOOLONG, EINVAL):
      // report them like any other, so the user gets the plain-English text.
      resolve({
        code: null,
        signal: null,
        stderr: "",
        stdoutTail: "",
        timedOut: false,
        aborted: false,
        spawnError: err as NodeJS.ErrnoException,
      });
      return;
    }
    const kill = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, KILL_GRACE_MS).unref?.();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, params.timeoutMs);
    timer.unref?.();
    const onAbort = () => {
      aborted = true;
      kill();
    };
    if (params.signal?.aborted) onAbort();
    params.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (code: number | null, sig: NodeJS.Signals | null, spawnError?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      params.signal?.removeEventListener("abort", onAbort);
      if (buffered.trim()) {
        try {
          params.onLine(buffered);
        } catch {
          /* parser errors never fail the run */
        }
      }
      resolve({
        code,
        signal: sig,
        stderr,
        stdoutTail,
        timedOut,
        aborted,
        spawnError: spawnError as NodeJS.ErrnoException | undefined,
      });
    };
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      stdoutTail = (stdoutTail + chunk).slice(-STDERR_CAP);
      buffered += chunk;
      let idx = buffered.indexOf("\n");
      while (idx >= 0) {
        const line = buffered.slice(0, idx);
        buffered = buffered.slice(idx + 1);
        try {
          params.onLine(line);
        } catch {
          /* parser errors never fail the run */
        }
        idx = buffered.indexOf("\n");
      }
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      if (stderr.length < STDERR_CAP) stderr += chunk;
    });
    child.on("error", (err) => finish(null, null, err));
    child.on("close", (code, sig) => finish(code, sig));
    child.stdin!.on("error", () => {
      /* CLI closed stdin early (it doesn't read it) */
    });
    child.stdin!.end(params.stdin ?? "");
  });
}
