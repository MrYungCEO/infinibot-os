/**
 * In-process daily scheduler that regenerates AI current-state summaries for
 * every in-progress project. The operator-visible cadence + enabled flag live
 * on the `project-summary-daily` cron job; this scheduler reads them and does
 * the actual work (cron payloads can only nudge an agent session).
 */
import { regenerateInProgressSummaries } from "./generate.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("project-summary");

export interface ProjectSummarySchedulerOptions {
  intervalMs: number;
  /** Gate each tick on the cron job's enabled flag. */
  isEnabled: () => Promise<boolean>;
  /** Delay before the first tick so boot isn't blocked by an LLM sweep. */
  initialDelayMs?: number;
}

export function startProjectSummaryScheduler(
  opts: ProjectSummarySchedulerOptions,
): { stop: () => void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      if (await opts.isEnabled()) {
        await regenerateInProgressSummaries();
      }
    } catch (err) {
      log.warn(`scheduler tick failed: ${String(err)}`);
    } finally {
      running = false;
    }
  };

  const loop = () => {
    if (stopped) return;
    void tick().finally(() => {
      if (stopped) return;
      timer = setTimeout(loop, opts.intervalMs);
    });
  };

  // First sweep after the initial delay (default 5 min) so gateway boot stays
  // snappy and the LLM isn't hit during the startup storm.
  timer = setTimeout(loop, opts.initialDelayMs ?? 5 * 60_000);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
