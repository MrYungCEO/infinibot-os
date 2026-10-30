/**
 * Background plan-usage refresh loop.
 *
 * Runs IN-PROCESS (not a forked worker like the reports system) because plan
 * pullers are cheap, isolated HTTP calls with hard timeouts — there's no
 * puppeteer/Chrome to crash the gateway, so the out-of-process isolation the
 * report worker needs isn't warranted here. Every tick is wrapped in try/catch
 * and an overlap guard, so a slow/hung/killed pull can never stack up or crash
 * anything; the last-good cached usage simply persists until the next success.
 *
 * Started from the gateway boot sequence (server-runtime-state.ts).
 */
import { createSubsystemLogger } from "../logging/subsystem.js";
import { refreshAllProviderPlans } from "./plan-service.js";

const log = createSubsystemLogger("credits").child("plan-refresh");

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const INITIAL_DELAY_MS = 30 * 1000; // let boot settle before first pull

let timer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running) {
    // Previous tick still in flight (slow provider) — skip rather than stack.
    return;
  }
  running = true;
  try {
    const results = await refreshAllProviderPlans();
    if (results.length > 0) {
      log.info("plan usage refreshed", {
        providers: results.map((r) => `${r.provider}:${r.source}/${r.status}`).join(","),
      });
    }
  } catch (e) {
    // refreshAllProviderPlans already isolates per-provider; this is belt-and-braces.
    log.warn("plan refresh tick failed", { err: String(e) });
  } finally {
    running = false;
  }
}

export function startPlanRefreshLoop(intervalMs = DEFAULT_INTERVAL_MS): void {
  if (timer) return; // idempotent
  initialTimer = setTimeout(() => {
    void tick();
  }, INITIAL_DELAY_MS);
  if (typeof initialTimer.unref === "function") initialTimer.unref();
  timer = setInterval(() => {
    void tick();
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  log.info("plan refresh loop started", { intervalMs });
}

export function stopPlanRefreshLoop(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
}
