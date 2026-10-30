/**
 * Report worker daemon — a SEPARATE process from the gateway.
 *
 * Polls the `reports` table for `status='queued'` rows, claims them atomically,
 * and renders each to a PDF (HTML→puppeteer) before fanning out to sinks. It
 * runs in its own process so a puppeteer/Chrome crash here can never take down
 * the gateway — the gateway only ever writes queued rows (see ../trigger.ts).
 *
 * Lifecycle:
 *   - On boot, requeue any rows stuck in `rendering` (a previous worker that was
 *     killed mid-render) so they get retried.
 *   - Poll on an interval; process at most one report per tick (renders are
 *     heavy and serialized — one Chrome at a time).
 *   - SIGTERM/SIGINT exit cleanly; whatever was claimed gets requeued by the
 *     next worker's boot sweep.
 *
 * Run standalone: `node dist/reports/worker/index.js`
 * (the gateway forks exactly this via ../../gateway/reports-worker-bootstrap.ts)
 */

import { getReportsStore } from "../store.js";
import { processReport } from "./engine.js";

const POLL_INTERVAL_MS = Number(process.env.REPORTS_POLL_INTERVAL_MS ?? 4000);
let stopping = false;

function log(msg: string, extra?: unknown): void {
  const line = `[REPORTS-WORKER] ${msg}`;
  // eslint-disable-next-line no-console
  if (extra !== undefined) console.log(line, extra);
  else console.log(line);
}

async function tick(): Promise<void> {
  const store = getReportsStore();
  let report = store.claimNextQueued();
  // Drain the queue within a tick, but yield between renders so SIGTERM lands.
  while (report && !stopping) {
    log(`rendering ${report.id} (${report.kind})`);
    const result = await processReport(store, report);
    if (result.status === "failed") {
      log(`FAILED ${report.id}: ${result.error}`);
    } else {
      log(`done ${report.id} → ${result.status} ${result.filePath ?? ""}`);
      for (const s of result.sinks ?? []) {
        log(`  sink ${s.sink}: ${s.ok ? "ok" : "FAIL"} ${s.detail ?? ""}`);
      }
    }
    report = store.claimNextQueued();
  }
}

async function main(): Promise<void> {
  log(`starting (poll ${POLL_INTERVAL_MS}ms, state ${getReportsStore().stateDir})`);

  // Boot sweep: reset rows a dead worker left mid-render. olderThanMs=0 because
  // any `rendering` row at boot is by definition orphaned (single worker).
  try {
    const requeued = getReportsStore().requeueStuckRendering(0);
    if (requeued) log(`requeued ${requeued} stuck rendering row(s)`);
  } catch (err) {
    log(`boot sweep failed: ${(err as Error).message}`);
  }

  const loop = async () => {
    if (stopping) return;
    try {
      await tick();
    } catch (err) {
      log(`tick error: ${(err as Error).message}`);
    }
    if (!stopping) setTimeout(() => void loop(), POLL_INTERVAL_MS);
  };
  void loop();
}

function shutdown(signal: string): void {
  log(`received ${signal}, shutting down`);
  stopping = true;
  // Give an in-flight render a moment, then exit. Anything still `rendering`
  // is recovered on the next boot sweep.
  setTimeout(() => process.exit(0), 500);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
// Forked by the gateway (IPC channel): leave with it. A gateway killed from
// outside (desktop app quit, crash) otherwise left this worker orphaned,
// holding the gateway's inherited stdio pipes open.
if (typeof process.send === "function") process.on("disconnect", () => shutdown("gateway exit"));
// The inherited pipes break once the gateway is gone; an EPIPE on a log line
// must not bounce through uncaughtException instead of letting us exit.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
process.on("uncaughtException", (err) => {
  log(`uncaughtException: ${err?.message ?? err}`);
  // Stay alive — one bad render must not kill the worker. The row is already
  // marked failed (or will be reclaimed by the boot sweep).
});
process.on("unhandledRejection", (reason) => {
  log(`unhandledRejection: ${String(reason)}`);
});

void main();
