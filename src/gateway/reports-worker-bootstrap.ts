/**
 * Report worker supervisor (gateway side).
 *
 * Forks the report render worker (`src/reports/worker/index.ts`, compiled to
 * `dist/reports/worker/index.js`) as a CHILD PROCESS and restarts it with
 * backoff if it dies. The hard process boundary is the whole point: a
 * puppeteer/Chrome crash in the worker can never destabilize the gateway —
 * worst case the worker respawns and reclaims any `rendering` row on its boot
 * sweep.
 *
 * Mirrors the fire-and-forget bootstrap style of kokoro-bootstrap.ts: failures
 * log a warning and the gateway keeps running.
 */

import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let child: ChildProcess | null = null;
let restartCount = 0;
let stopped = false;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
const MAX_RAPID_RESTARTS = 10;

type Logger = { info: (m: string) => void; warn: (m: string) => void };

/** Locate the compiled worker entry next to this module's dist location. */
function resolveWorkerEntry(): string | null {
  // Compiled: dist/gateway/reports-worker-bootstrap.js → dist/reports/worker/index.js
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidate = join(here, "..", "reports", "worker", "index.js");
    if (existsSync(candidate)) return candidate;
  } catch {
    // import.meta.url unavailable — fall through to cwd guess.
  }
  const cwdCandidate = join(process.cwd(), "dist", "reports", "worker", "index.js");
  if (existsSync(cwdCandidate)) return cwdCandidate;
  return null;
}

function spawnWorker(entry: string, log: Logger): void {
  if (stopped) return;
  child = fork(entry, [], {
    // Inherit the gateway's env (state dir, config path) so the worker resolves
    // the same ~/.infinibot. stdio inherit so worker logs land in gateway logs.
    env: process.env,
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    child = null;
    if (stopped) return;
    restartCount++;
    if (restartCount > MAX_RAPID_RESTARTS) {
      log.warn(
        `[REPORTS-WORKER] crashed ${restartCount}x (last code=${code} signal=${signal}); giving up auto-restart. Reports will queue until restarted.`,
      );
      return;
    }
    const delay = Math.min(1000 * restartCount, 15_000);
    log.warn(
      `[REPORTS-WORKER] exited (code=${code} signal=${signal}); restarting in ${delay}ms (attempt ${restartCount})`,
    );
    restartTimer = setTimeout(() => spawnWorker(entry, log), delay);
    if (typeof restartTimer.unref === "function") restartTimer.unref();
  });

  child.on("error", (err) => {
    log.warn(`[REPORTS-WORKER] spawn error: ${err.message}`);
  });

  // Reset the rapid-restart counter once a worker survives a while.
  const stableTimer = setTimeout(() => {
    restartCount = 0;
  }, 60_000);
  if (typeof stableTimer.unref === "function") stableTimer.unref();
}

/** Start (and supervise) the report worker. Idempotent. */
export function startReportsWorker(log: Logger): void {
  if (child) return;
  stopped = false;
  const entry = resolveWorkerEntry();
  if (!entry) {
    log.warn(
      "[REPORTS-WORKER] compiled worker not found (dist/reports/worker/index.js); skipping. Run a build, then restart the gateway.",
    );
    return;
  }
  log.info(`[REPORTS-WORKER] starting render worker: ${entry}`);
  spawnWorker(entry, log);
}

/** Stop the worker (shutdown / tests). */
export function stopReportsWorker(): void {
  stopped = true;
  if (restartTimer) clearTimeout(restartTimer);
  if (child) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    child = null;
  }
}
