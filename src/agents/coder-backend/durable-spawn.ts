/**
 * Durable (tmux-backed) coder spawns.
 *
 * PROBLEM: `claude_coder` detach mode used to spawn the CLI as a plain
 * background child of the gateway process. A gateway restart therefore killed
 * every in-flight sub-agent — either because the shutdown handler SIGTERM'd the
 * tracked `childPid`, or because the child died with its parent.
 *
 * FIX: run the very same CLI invocation inside a **detached tmux session** on
 * the isolated `-L infinibot` socket (the same durable substrate the terminal
 * path already uses via `spawnTmuxPty`). The tmux server is owned by init, not
 * by the gateway, so the coder process keeps working across a restart.
 *
 * The gateway keeps streaming output by **tailing a log file** the session
 * writes to, rather than by holding a pipe. That is what makes reattachment
 * after a restart trivial: re-open the same file and keep reading from the last
 * offset (or from 0 — the caller's stream parser is line-oriented and
 * idempotent per line).
 *
 * The returned handle is deliberately shaped like a `ChildProcess` so the four
 * coder backends (`claude-code`, `codex`, `opencode`, `gemini`) can swap
 * `spawnCli(...)` for `spawnCoderProcess(...)` with a one-line change and keep
 * every downstream behaviour (stdout/stderr subscribers, `close` handling,
 * timeout kill, credit hooks) untouched.
 *
 * Session naming: terminal id `spawn-<runId>` → tmux session
 * `infinibot_spawn_<runId with - → _>` (see `tmuxSessionName`). The `spawn-`
 * prefix is intentional: `TerminalManager.reconcileTmuxSessions()` skips those
 * ids, so the terminal manager never attaches a second client to a pane the
 * subagent registry owns.
 */

import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { commandLineFits } from "../../process/argv-budget.js";
import type { SpawnOptions } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import { resolveStateDir } from "../../config/paths.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  hasLiveSessionSync,
  isTmuxAvailable,
  tmuxSessionName,
} from "../../terminal/tmux-backend.js";
import { spawnCli } from "../../process/win-spawn.js";
import { resolveTmuxSocketName } from "../../terminal/tmux-socket.js";

const log = createSubsystemLogger("durable-spawn");

/** How often we drain the log files. */
const POLL_INTERVAL_MS = 250;

/**
 * How often we shell out to `tmux has-session`. Liveness is a process spawn, so
 * it runs at 1Hz rather than on every drain — with N concurrent sub-agents the
 * 250ms cadence would mean 4N spawns/second for no added responsiveness.
 */
const LIVENESS_INTERVAL_MS = 1000;

/**
 * Consecutive "session is gone" probes required before we declare the run
 * finished. Guards against a transient tmux hiccup racing session creation.
 */
const DEAD_POLLS_REQUIRED = 2;

// ── Identity helpers ────────────────────────────────────────────────────────

/** Terminal id for a durable coder run. Kept stable across restarts. */
export function durableTerminalId(runId: string): string {
  return `spawn-${runId}`;
}

/** tmux session name for a durable coder run (`infinibot_spawn_…`). */
export function durableTmuxSession(runId: string): string {
  return tmuxSessionName(durableTerminalId(runId));
}

/** Per-run scratch dir holding stdout/stderr logs, the exit code, and the launcher script. */
export function durableRunDir(runId: string): string {
  return path.join(resolveStateDir(), "subagents", "durable", runId);
}

/**
 * Run ids this INSTANCE has ever spawned durably, read straight off disk.
 *
 * Ownership ground truth that survives a restart with an unrecovered registry.
 * Needed because the tmux socket (`resolveTmuxSocketName()`, `-L infinibot` for
 * the default state dir) can still be shared, e.g. by several gateways on one
 * state dir: `tmux list-sessions` alone cannot tell you whether an
 * `infinibot_spawn_*` pane is yours.
 */
export function listDurableRunIds(): string[] {
  try {
    return readdirSync(path.join(resolveStateDir(), "subagents", "durable"), {
      withFileTypes: true,
    })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return []; // dir absent → this instance has never spawned a durable run
  }
}

/**
 * Whether detached coder spawns should go through tmux.
 *
 * Requires a real tmux binary and a POSIX host (the tmux backend is
 * non-Windows only). `INFINIBOT_DURABLE_SUBAGENTS=0` forces the legacy
 * direct-child behaviour — an escape hatch, not a default.
 */
export function isDurableSpawnEnabled(): boolean {
  if (process.env.INFINIBOT_DURABLE_SUBAGENTS === "0") return false;
  if (process.platform === "win32") return false;
  return isTmuxAvailable();
}

/** True when this run's tmux session is currently alive. */
export function isDurableRunAlive(runId: string): boolean {
  if (process.platform === "win32") return false;
  return hasLiveSessionSync(durableTerminalId(runId));
}

/**
 * Explicitly destroy a durable run's tmux session (operator Stop, timeout,
 * launch-probe abort). This is the ONLY path allowed to kill one — gateway
 * shutdown must never call it.
 */
export function killDurableRun(runId: string): boolean {
  if (!isTmuxAvailable()) return false;
  try {
    execFileSync(
      "tmux",
      ["-L", resolveTmuxSocketName(), "kill-session", "-t", durableTmuxSession(runId)],
      {
        stdio: "ignore",
      },
    );
    return true;
  } catch {
    return false; // already gone
  }
}

// ── In-process bookkeeping ──────────────────────────────────────────────────

type DurableSpawnInfo = { runId: string; terminalId: string; tmuxSession: string; pid?: number };

const durableSpawns = new Map<string, DurableSpawnInfo>();

/**
 * Identity of a durable run spawned (or reattached) in this process, or
 * undefined when the run went down the legacy direct-child path.
 */
export function getDurableSpawnInfo(runId: string): DurableSpawnInfo | undefined {
  return durableSpawns.get(runId);
}

export function forgetDurableSpawnForTests(runId: string): void {
  durableSpawns.delete(runId);
}

// ── Shell quoting ───────────────────────────────────────────────────────────

/** POSIX single-quote escaping — safe for arbitrary task prompts. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the `/bin/sh` launcher script that runs inside the tmux pane.
 *
 * It exports the caller's env explicitly (a pre-existing tmux *server* does not
 * inherit a new client's environment, so `-e` / inheritance is not reliable),
 * cds into the workdir, runs the CLI with stdout/stderr redirected to the log
 * files, and finally records the exit status. The session dies when the script
 * returns, which is what the poller watches for.
 */
export function buildDurableScript(params: {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  stdoutPath: string;
  stderrPath: string;
  exitPath: string;
  /** Feed this file to the CLI's stdin (large prompts — see `writeRunPromptFile`). */
  stdinPath?: string;
  /**
   * Vars to `unset` first: the tmux server keeps the environment it was
   * started with (the gateway's), so a key the caller removed from `env`
   * would otherwise still reach the CLI.
   */
  unsetEnv?: readonly string[];
}): string {
  const { command, args, cwd, env, stdoutPath, stderrPath, exitPath, stdinPath } = params;
  const lines = ["#!/bin/sh", "# InfiniBot durable subagent launcher (tmux-backed)"];
  for (const key of params.unsetEnv ?? []) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && env[key] === undefined) lines.push(`unset ${key}`);
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === null) continue;
    // Only export names that are legal shell identifiers.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    lines.push(`export ${key}=${shQuote(String(value))}`);
  }
  // Record early startup failures too. Previously a bad cwd exited before
  // `exit.code` was written, so the shim mistook it for an external SIGKILL
  // and reported code 137 with empty logs.
  lines.push(
    `if ! cd ${shQuote(cwd)}; then`,
    `  printf '%s\n' ${shQuote(`Coder working directory is unavailable: ${cwd}`)} > ${shQuote(stderrPath)}`,
    `  printf '%s' '127' > ${shQuote(exitPath)}`,
    "  exit 127",
    "fi",
  );
  const invocation = [command, ...args].map((a) => shQuote(a)).join(" ");
  const stdin = stdinPath ? ` < ${shQuote(stdinPath)}` : "";
  lines.push(`${invocation}${stdin} > ${shQuote(stdoutPath)} 2> ${shQuote(stderrPath)}`);
  lines.push("code=$?");
  lines.push(`printf '%s' "$code" > ${shQuote(exitPath)}`);
  lines.push('exit "$code"');
  lines.push("");
  return lines.join("\n");
}

// ── Log tailing ─────────────────────────────────────────────────────────────

/**
 * Incremental file reader. Polling (rather than fs.watch) is deliberate: it is
 * the only approach that behaves identically for a file being written by a
 * process in another session, and it resumes trivially after a restart.
 */
class LogTailer {
  private offset: number;
  private fd: number | null = null;
  private readonly buf = Buffer.allocUnsafe(64 * 1024);

  constructor(
    private readonly filePath: string,
    startOffset = 0,
  ) {
    this.offset = startOffset;
  }

  get position(): number {
    return this.offset;
  }

  /** Read everything appended since the last call. Never throws. */
  read(): string {
    try {
      if (this.fd === null) {
        if (!existsSync(this.filePath)) return "";
        this.fd = openSync(this.filePath, "r");
      }
      const size = fstatSync(this.fd).size;
      if (size <= this.offset) return "";
      let out = "";
      while (this.offset < size) {
        const want = Math.min(this.buf.length, size - this.offset);
        const got = readSync(this.fd, this.buf, 0, want, this.offset);
        if (got <= 0) break;
        out += this.buf.toString("utf8", 0, got);
        this.offset += got;
      }
      return out;
    } catch {
      return "";
    }
  }

  close(): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        /* ignore */
      }
      this.fd = null;
    }
  }
}

// ── ChildProcess-compatible shim ────────────────────────────────────────────

/**
 * Minimal `ChildProcess` look-alike backed by a tmux session + log files.
 * Implements exactly the surface the coder backends use: `stdout`/`stderr`
 * `data` events, `error`/`close` events, `kill()`, `killed`, `pid`, `unref()`.
 */
export class DurableChildShim extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = null;
  killed = false;
  pid: number | undefined;

  private timer: ReturnType<typeof setInterval> | null = null;
  private deadPolls = 0;
  private closed = false;
  private lastLivenessCheck = 0;

  constructor(
    private readonly runId: string,
    private readonly outTail: LogTailer,
    private readonly errTail: LogTailer,
    private readonly exitPath: string,
  ) {
    super();
  }

  /** Begin polling logs + tmux liveness. */
  start(): this {
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    this.timer.unref?.();
    // First drain is deferred to the next tick, NOT run inline: callers attach
    // `stdout.on("data")` immediately after this function returns (exactly as
    // they would to a real ChildProcess), so draining synchronously here would
    // emit the opening chunk — the whole replayed backlog, on reattach — into a
    // listener-less void and then advance the offset past it. Matches Node's
    // own "data flows on the next tick" contract.
    setImmediate(() => this.poll());
    return this;
  }

  private drain(): void {
    const out = this.outTail.read();
    if (out) this.stdout.emit("data", out);
    const err = this.errTail.read();
    if (err) this.stderr.emit("data", err);
  }

  private poll(): void {
    if (this.closed) return;
    this.drain();
    // An explicit kill() destroys the whole session, so there is nothing to
    // wait for — settle on the next tick instead of paying two liveness probes.
    // This also stops the poller before a same-runId respawn (backend fallback)
    // can be mistaken for "still alive".
    if (this.killed) {
      this.finish();
      return;
    }
    const now = Date.now();
    if (now - this.lastLivenessCheck < LIVENESS_INTERVAL_MS) return;
    this.lastLivenessCheck = now;
    if (isDurableRunAlive(this.runId)) {
      this.deadPolls = 0;
      return;
    }
    this.deadPolls++;
    if (this.deadPolls < DEAD_POLLS_REQUIRED) return;
    this.finish();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // One last drain so the tail of the transcript is never lost.
    this.drain();
    this.outTail.close();
    this.errTail.close();
    durableSpawns.delete(this.runId);
    // The launcher script writes the CLI's exit status just before the pane
    // dies. An empty/absent file means the session was killed instead.
    let code = this.killed ? 143 : 137;
    try {
      const raw = readFileSync(this.exitPath, "utf8").trim();
      const parsed = Number.parseInt(raw, 10);
      if (raw !== "" && Number.isFinite(parsed)) code = parsed;
    } catch {
      /* keep the killed/unknown default */
    }
    this.emit("exit", code, null);
    this.emit("close", code, null);
  }

  /** Kill the tmux session (explicit stop / timeout). */
  kill(_signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    const ok = killDurableRun(this.runId);
    // Let the poller observe the dead session and emit `close` normally.
    return ok;
  }

  unref(): void {
    /* no-op: the tmux server already owns the process tree */
  }

  ref(): void {
    /* no-op */
  }
}

// ── Large prompts (argv limit) ──────────────────────────────────────────────

/**
 * Largest string we hand a CLI as a single argv element (or env value).
 *
 * Linux caps each argv/env string at MAX_ARG_STRLEN = 128 KiB and `execve`
 * fails with E2BIG ("Argument list too long") above it. The coder preamble plus
 * a long task crossed that and every codex spawn died at exec. Anything larger
 * than this goes through a file instead: the CLI's stdin, or a `*-file` flag.
 */
export const MAX_INLINE_ARG_BYTES = 32 * 1024;

/** True when `value` is too big to pass safely as one argv element. */
export function exceedsInlineArgLimit(value: string): boolean {
  return Buffer.byteLength(value, "utf8") > MAX_INLINE_ARG_BYTES;
}

/**
 * True when `command args` fits this platform's command line. On Windows that
 * is the WHOLE quoted line — 32,767 chars, or 8,191 when a `.cmd` shim runs
 * through cmd.exe. A bare `command` name is sized as the cmd.exe case since it
 * may resolve to a shim at spawn time; a prompt file is always safe.
 */
export function inlineArgvFits(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  return commandLineFits({ command, args, platform });
}

/**
 * Write a prompt into the run's scratch dir (owner-only) and return its path.
 * Used for stdin redirection and `--append-system-prompt-file`-style flags.
 */
export function writeRunPromptFile(runId: string, name: string, text: string): string {
  const dir = durableRunDir(runId);
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  writeFileSync(filePath, text, { mode: 0o600 });
  return filePath;
}

// ── Spawn / reattach ────────────────────────────────────────────────────────

/**
 * Launch `command args` inside a detached tmux session and return a
 * ChildProcess-shaped handle. Throws if the tmux session could not be created,
 * so callers can fall back to a direct spawn.
 */
export function spawnDurableTmux(params: {
  runId: string;
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  stdinPath?: string;
  unsetEnv?: readonly string[];
}): DurableChildShim {
  const { runId, command, args, cwd, env, stdinPath, unsetEnv } = params;
  const dir = durableRunDir(runId);
  mkdirSync(dir, { recursive: true });
  const stdoutPath = path.join(dir, "stdout.log");
  const stderrPath = path.join(dir, "stderr.log");
  const exitPath = path.join(dir, "exit.code");
  const scriptPath = path.join(dir, "launch.sh");

  // Fresh logs per spawn attempt (a fallback retry reuses the same runId).
  writeFileSync(stdoutPath, "");
  writeFileSync(stderrPath, "");
  try {
    // Stale exit code from a previous attempt would end the run instantly.
    writeFileSync(exitPath, "");
  } catch {
    /* ignore */
  }

  writeFileSync(
    scriptPath,
    buildDurableScript({
      command,
      args,
      cwd,
      env,
      stdoutPath,
      stderrPath,
      exitPath,
      stdinPath,
      unsetEnv,
    }),
    { mode: 0o700 },
  );
  writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify(
      { runId, command, cwd, tmuxSession: durableTmuxSession(runId), startedAt: Date.now() },
      null,
      2,
    ),
  );

  const session = durableTmuxSession(runId);
  // A backend fallback retries with the SAME runId, so a session from the
  // aborted first attempt may still be shutting down. tmux refuses a duplicate
  // name; clear it first so the retry can't fail on a name collision.
  killDurableRun(runId);
  execFileSync(
    "tmux",
    [
      "-L",
      resolveTmuxSocketName(),
      "new-session",
      "-d",
      "-s",
      session,
      "-c",
      cwd,
      "/bin/sh",
      scriptPath,
    ],
    { stdio: "ignore" },
  );

  const shim = new DurableChildShim(
    runId,
    new LogTailer(stdoutPath),
    new LogTailer(stderrPath),
    exitPath,
  );
  shim.pid = readPanePid(session);
  durableSpawns.set(runId, {
    runId,
    terminalId: durableTerminalId(runId),
    tmuxSession: session,
    pid: shim.pid,
  });
  log.info("durable coder spawn started", { runId, tmuxSession: session, pid: shim.pid });
  return shim.start();
}

/** PID of the tmux pane's shell, used only for observability. */
function readPanePid(session: string): number | undefined {
  try {
    const out = execFileSync(
      "tmux",
      ["-L", resolveTmuxSocketName(), "list-panes", "-t", session, "-F", "#{pane_pid}"],
      { encoding: "utf8" },
    );
    const pid = Number.parseInt(out.trim().split("\n")[0] ?? "", 10);
    return Number.isFinite(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reattach to a durable run whose tmux session outlived a gateway restart.
 *
 * Returns a fresh shim streaming the run's logs **from the beginning** — the
 * downstream stream-json parsers are per-line and idempotent, and replaying
 * gives the restarted gateway the full activity history it lost. Returns null
 * when the session is gone (nothing to reattach to).
 */
export function reattachDurableTmux(runId: string): DurableChildShim | null {
  if (!isDurableRunAlive(runId)) return null;
  const dir = durableRunDir(runId);
  const stdoutPath = path.join(dir, "stdout.log");
  const stderrPath = path.join(dir, "stderr.log");
  const exitPath = path.join(dir, "exit.code");
  const session = durableTmuxSession(runId);
  const shim = new DurableChildShim(
    runId,
    new LogTailer(stdoutPath),
    new LogTailer(stderrPath),
    exitPath,
  );
  shim.pid = readPanePid(session);
  durableSpawns.set(runId, {
    runId,
    terminalId: durableTerminalId(runId),
    tmuxSession: session,
    pid: shim.pid,
  });
  log.info("durable coder run reattached after restart", { runId, tmuxSession: session });
  return shim.start();
}

/**
 * Drop-in for `spawnCli` used by the coder backends' background paths.
 *
 * When `durableRunId` is set and tmux is usable, the CLI is launched inside a
 * detached tmux session and a ChildProcess-shaped shim is returned. Otherwise
 * (Windows, no tmux, sync mode, opt-out) this is exactly `spawnCli`.
 *
 * A tmux failure is never fatal: we log and fall back to the direct child so a
 * broken tmux install degrades to the old behaviour rather than breaking spawns.
 */
export function spawnCoderProcess(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
  durableRunId?: string,
  io?: { stdinPath?: string; unsetEnv?: readonly string[] },
): ChildProcess {
  const stdinPath = io?.stdinPath;
  if (durableRunId && isDurableSpawnEnabled()) {
    try {
      return spawnDurableTmux({
        runId: durableRunId,
        command,
        args,
        cwd: typeof options.cwd === "string" ? options.cwd : process.cwd(),
        env: (options.env ?? {}) as Record<string, string>,
        stdinPath,
        unsetEnv: io?.unsetEnv,
      }) as unknown as ChildProcess;
    } catch (err) {
      log.warn("durable tmux spawn failed, falling back to direct child", {
        runId: durableRunId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (!stdinPath) return spawnCli(command, args, options);
  // Direct child: hand the prompt file to the CLI as its stdin (EOF after the
  // prompt, so nothing waits on a never-closing pipe).
  const fd = openSync(stdinPath, "r");
  try {
    const base = Array.isArray(options.stdio) ? options.stdio : ["ignore", "pipe", "pipe"];
    const stdio = [fd, base[1] ?? "pipe", base[2] ?? "pipe", ...base.slice(3)];
    return spawnCli(command, args, { ...options, stdio: stdio as SpawnOptions["stdio"] });
  } finally {
    closeSync(fd); // the child holds its own dup
  }
}
