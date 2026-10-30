/**
 * Build / heavy-op queue — keeps parallel coder agents from OOMing a hosted
 * tenant Machine. Docs: docs/saas/BUILD_QUEUE.md.
 *
 * WHAT WE CHOSE (and why): a cooperative, flock-based slot queue that the
 * agents' own build invocations route through, installed first on the tenant
 * gateway's PATH.
 *   - Coder agents are separate CLI processes (Claude Code / Codex / OpenCode in
 *     tmux) running arbitrary shell commands, so an in-process gateway
 *     semaphore can't see their `pnpm build`. A file lock can: every process on
 *     the Machine shares it.
 *   - `flock` locks are owned by an open fd, so the kernel releases a slot when
 *     the holder dies for ANY reason (exit, SIGKILL, OOM kill). No stale-lock
 *     cleanup, no deadlock.
 *   - The queue is transparent: PATH shims (scripts/infinibot-build-shim,
 *     symlinked as tsc / vite / esbuild / next / pnpm / npm / npx / yarn / bun /
 *     chromium …) only queue heavy invocations (builds, headless Chrome) and
 *     exec everything else (installs, dev servers, watch mode) untouched.
 *   - Belt and braces: the wrapper (scripts/infinibot-build) also waits briefly
 *     for MemAvailable to recover before starting, and gives up waiting (runs
 *     unqueued) after a timeout, so the worst case is "no queue", never "hang".
 *
 * The slot count is the plan's `builds` limit (src/agents/plan-limits.ts),
 * written to `<queueDir>/limit` and re-read on every wrapper call, so a plan
 * change takes effect without restarting anything.
 *
 * Gateway-side heavy work (an in-process puppeteer verify, say) can use
 * {@link withHeavyOp} — an in-process FIFO semaphore with the same limit — or
 * spawn its subprocess through {@link wrapHeavyCommand}, which joins the
 * cross-process queue.
 *
 * Installed lazily by the spawn gate (agent-concurrency-gate.ts) in SaaS mode
 * only; local / self-hosted installs never get shims on their PATH.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRepoRoot } from "../config/paths.js";

// ── in-process semaphore ───────────────────────────────────────────────────

export type Release = () => void;

/**
 * FIFO async semaphore. `max === null` means unlimited. `release` is
 * idempotent, and lowering `max` never strands waiters (they run as slots free).
 */
export class HeavyOpSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private max: number | null) {}

  get running(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiters.length;
  }

  get limit(): number | null {
    return this.max;
  }

  setLimit(max: number | null): void {
    this.max = max;
    this.drain();
  }

  private hasRoom(): boolean {
    return this.max === null || this.active < Math.max(1, this.max);
  }

  private drain(): void {
    while (this.waiters.length > 0 && this.hasRoom()) {
      this.active++;
      this.waiters.shift()!();
    }
  }

  private makeRelease(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.drain();
    };
  }

  acquire(): Promise<Release> {
    if (this.waiters.length === 0 && this.hasRoom()) {
      this.active++;
      return Promise.resolve(this.makeRelease());
    }
    return new Promise((resolve) => {
      this.waiters.push(() => resolve(this.makeRelease()));
    });
  }

  /** Run `fn` inside a slot; the slot is released however `fn` settles. */
  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

const heavyOps = new HeavyOpSemaphore(null);

/** Run a gateway-side heavy op (build, headless verify) under the plan's limit. */
export function withHeavyOp<T>(fn: () => Promise<T> | T): Promise<T> {
  return heavyOps.run(fn);
}

export function getHeavyOpSemaphore(): HeavyOpSemaphore {
  return heavyOps;
}

// ── cross-process queue (flock wrapper + PATH shims) ───────────────────────

/** Tools whose heavy invocations are queued (the shim decides per call). */
export const SHIMMED_TOOLS = [
  "tsc",
  "vite",
  "esbuild",
  "tsup",
  "tsdown",
  "next",
  "rollup",
  "webpack",
  "pnpm",
  "npm",
  "npx",
  "yarn",
  "bun",
  "chromium",
  "chromium-browser",
  "google-chrome",
  "google-chrome-stable",
] as const;

export type BuildQueueInstall = {
  dir: string;
  binDir: string;
  wrapper: string;
  maxConcurrent: number | null;
};

let installed: { key: string; result: BuildQueueInstall } | null = null;

export function defaultBuildQueueDir(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return path.join(os.tmpdir(), `infinibot-build-queue-${uid}`);
}

function findScript(name: string, env: NodeJS.ProcessEnv): string | null {
  const candidates = [
    env.INFINIBOT_BUILD_SCRIPTS_DIR ? path.join(env.INFINIBOT_BUILD_SCRIPTS_DIR, name) : null,
    path.join(resolveRepoRoot(), "scripts", name),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

function linkTo(target: string, linkPath: string): void {
  try {
    if (fs.readlinkSync(linkPath) === target) return;
    fs.rmSync(linkPath, { force: true });
  } catch {
    // not a symlink (or missing) — replace it
    fs.rmSync(linkPath, { force: true });
  }
  fs.symlinkSync(target, linkPath);
}

/**
 * Install (idempotently) the queue for this process tree: write the slot
 * limit, link the wrapper + shims into `<dir>/bin`, and put that bin dir first
 * on `env.PATH` so every agent spawned afterwards inherits it. Returns null
 * when the scripts can't be found (then nothing is queued — never blocked).
 */
export function ensureBuildQueueInstalled(params: {
  maxConcurrent: number | null;
  env?: NodeJS.ProcessEnv;
  dir?: string;
}): BuildQueueInstall | null {
  const env = params.env ?? process.env;
  const dir = params.dir ?? (env.INFINIBOT_BUILD_QUEUE_DIR?.trim() || defaultBuildQueueDir());
  const max = params.maxConcurrent;
  heavyOps.setLimit(max);

  const key = `${dir}|${max}`;
  const binDir = path.join(dir, "bin");
  if (installed?.key === key && (env.PATH ?? "").split(path.delimiter)[0] === binDir) {
    return installed.result;
  }

  const wrapperSrc = findScript("infinibot-build", env);
  const shimSrc = findScript("infinibot-build-shim", env);
  if (!wrapperSrc || !shimSrc) return null;

  fs.mkdirSync(path.join(dir, "slots"), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  // 0 = unlimited for the shell wrapper.
  fs.writeFileSync(path.join(dir, "limit"), `${max === null ? 0 : Math.max(1, max)}\n`);
  const wrapper = path.join(binDir, "infinibot-build");
  linkTo(wrapperSrc, wrapper);
  for (const tool of SHIMMED_TOOLS) linkTo(shimSrc, path.join(binDir, tool));

  const rest = (env.PATH ?? "").split(path.delimiter).filter((p) => p && p !== binDir);
  env.PATH = [binDir, ...rest].join(path.delimiter);
  env.INFINIBOT_BUILD_QUEUE_DIR = dir;
  env.INFINIBOT_BUILD_WRAPPER = wrapper;

  const result: BuildQueueInstall = { dir, binDir, wrapper, maxConcurrent: max };
  installed = { key, result };
  return result;
}

/**
 * Argv for running a heavy subprocess inside the cross-process queue, or the
 * command unchanged when the queue isn't installed.
 */
export function wrapHeavyCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  const wrapper = env.INFINIBOT_BUILD_WRAPPER;
  if (!wrapper || !fs.existsSync(wrapper)) return { command, args };
  return { command: wrapper, args: [command, ...args] };
}

export function resetBuildQueueForTests(): void {
  installed = null;
  heavyOps.setLimit(null);
}
