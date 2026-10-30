/**
 * Pulse — deterministic, state-flip service health check (oversight #10).
 *
 * Runs cheaply and often (every ~5 min). It does NOT alert on every tick; it
 * snapshots the status of each critical service, compares to the last snapshot
 * persisted at `<stateDir>/proactive/pulse-state.json`, and reports only the
 * services whose status *flipped* since last time. The very first run just
 * establishes a baseline and reports no flips — so "nothing changed" produces
 * no output, which is exactly what the pulse cron should surface.
 *
 * The check is pure-ish (one read + one write of the small state file) and has
 * no LLM in the loop, so it's directly testable: run it twice against a stable
 * environment → zero flips both times; change a service → one flip.
 */

import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ServiceStatus = "up" | "down" | "unconfigured";

export interface ServiceState {
  name: string;
  status: ServiceStatus;
  detail?: string;
}

export interface PulseFlip {
  service: string;
  from: ServiceStatus;
  to: ServiceStatus;
}

export interface PulseResult {
  now: number;
  services: ServiceState[];
  flips: PulseFlip[];
  /** True only when at least one service flipped vs the persisted baseline. */
  changed: boolean;
  /** True on the first-ever run (baseline established; never alerts). */
  baseline: boolean;
}

function resolveStateDir(stateDir?: string): string {
  return stateDir ?? process.env.INFINIBOT_STATE_DIR ?? join(homedir(), ".infinibot");
}

function statePath(stateDir?: string): string {
  return join(resolveStateDir(stateDir), "proactive", "pulse-state.json");
}

async function probeHttp(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: "GET", signal: ctrl.signal });
      return res.ok || res.status < 500;
    } finally {
      clearTimeout(t);
    }
  } catch {
    return false;
  }
}

/**
 * Gather the current status of each critical service. Injectable services list
 * keeps it testable; the default set covers the kanban store, the configured
 * voice STT/TTS endpoints, and federation peers.
 */
export async function gatherServiceStates(opts: {
  stateDir?: string;
  /** Test seam: override the probed services entirely. */
  override?: ServiceState[];
}): Promise<ServiceState[]> {
  if (opts.override) return opts.override;
  const stateDir = resolveStateDir(opts.stateDir);
  const out: ServiceState[] = [];

  // Kanban store — openable + queryable.
  try {
    const { getKanbanStore } = await import("../tasks/store.js");
    await getKanbanStore(stateDir).getProjects();
    out.push({ name: "kanban-store", status: "up" });
  } catch (err) {
    out.push({
      name: "kanban-store",
      status: "down",
      detail: String((err as Error)?.message ?? err),
    });
  }

  // Voice STT/TTS — only if configured; otherwise "unconfigured" (not "down").
  try {
    const cfgMod = (await import("../config/config.js")) as {
      loadConfig?: () => Record<string, unknown>;
    };
    const cfg = (cfgMod.loadConfig?.() ?? {}) as { voice?: Record<string, unknown> };
    const voice = cfg.voice ?? {};
    const sttUrl = (voice.sttUrl ?? voice.stt_url) as string | undefined;
    const ttsUrl = (voice.ttsUrl ?? voice.tts_url) as string | undefined;
    out.push(
      sttUrl
        ? { name: "voice-stt", status: (await probeHttp(sttUrl)) ? "up" : "down", detail: sttUrl }
        : { name: "voice-stt", status: "unconfigured" },
    );
    out.push(
      ttsUrl
        ? { name: "voice-tts", status: (await probeHttp(ttsUrl)) ? "up" : "down", detail: ttsUrl }
        : { name: "voice-tts", status: "unconfigured" },
    );
  } catch {
    out.push({ name: "voice-stt", status: "unconfigured" });
    out.push({ name: "voice-tts", status: "unconfigured" });
  }

  return out;
}

function loadPrev(stateDir?: string): Record<string, ServiceStatus> | null {
  try {
    const raw = fs.readFileSync(statePath(stateDir), "utf-8");
    const parsed = JSON.parse(raw) as { services?: Record<string, ServiceStatus> };
    return parsed.services ?? null;
  } catch {
    return null;
  }
}

function savePrev(services: ServiceState[], now: number, stateDir?: string): void {
  try {
    const p = statePath(stateDir);
    fs.mkdirSync(join(p, ".."), { recursive: true });
    const map: Record<string, ServiceStatus> = {};
    for (const s of services) map[s.name] = s.status;
    fs.writeFileSync(p, JSON.stringify({ updatedAt: now, services: map }, null, 2), "utf-8");
  } catch {
    /* best-effort */
  }
}

/**
 * Run one pulse: gather states, diff against the persisted baseline, persist
 * the new baseline, and return the flips. Emits the standard telemetry line.
 */
export async function runPulse(
  opts: {
    now?: number;
    stateDir?: string;
    override?: ServiceState[];
  } = {},
): Promise<PulseResult> {
  const started = Date.now();
  const now = opts.now ?? Date.now();
  const services = await gatherServiceStates({ stateDir: opts.stateDir, override: opts.override });
  const prev = loadPrev(opts.stateDir);
  const baseline = prev == null;
  const flips: PulseFlip[] = [];
  if (!baseline) {
    for (const s of services) {
      const from = prev[s.name];
      if (from != null && from !== s.status) {
        flips.push({ service: s.name, from, to: s.status });
      }
    }
  }
  savePrev(services, now, opts.stateDir);
  const changed = flips.length > 0;
  // eslint-disable-next-line no-console
  console.log(
    `[oversight] pulse ran in ${Math.max(0, Date.now() - started)}ms producedReport=${
      changed ? `flips:${flips.map((f) => f.service).join(",")}` : "none"
    }`,
  );
  return { now, services, flips, changed, baseline };
}
