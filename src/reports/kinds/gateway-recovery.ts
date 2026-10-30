/**
 * `gateway_recovery` report kind.
 *
 * Collector reads the subagent registry snapshots on disk
 * (`~/.infinibot/subagents/runs.json` + `history.json`) for the incident window
 * and builds the same content the manual recovery PDF had: the crash trigger,
 * per-agent stacked cards (status pills), what's running, and recovery
 * observations. The collector only *reads* — the worker persists the result.
 *
 * Config:
 *   - incidentWindow?: [startMs, endMs]  (defaults to last 2h ending now)
 *   - trigger?: string                   (human description of what fired it)
 *   - mock?: boolean                     (synthesize sample data if disk empty)
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CollectedReport, ReportKindModule, Theme } from "../types.js";
import {
  buildGatewayRecoveryHtml,
  type AgentCard,
  type GatewayRecoveryData,
} from "../templates/gateway-recovery.js";
import { readSpawnLedger, replayLedgerToRunRecords } from "../../agents/spawn-ledger.js";

const DEFAULT_WINDOW_MS = 2 * 60 * 60 * 1000;

type RunsFile = {
  version?: number;
  runs?: Record<string, RawRun>;
};
type RawRun = {
  runId: string;
  label?: string;
  task?: string;
  childPid?: number;
  coderBackend?: string;
  createdAt?: number;
  startedAt?: number;
  endedAt?: number;
  interruptedAt?: number;
  outcome?: { status?: string; error?: string };
  filesTouched?: unknown[];
};

type HistoryFile = {
  version?: number;
  entries?: RawHistory[];
};
type RawHistory = {
  runId: string;
  label?: string;
  task?: string;
  status?: string;
  startedAt?: number;
  endedAt?: number;
  outcome?: { status?: string; error?: string };
  coderBackend?: string;
  filesTouchedCount?: number;
  error?: string;
};

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function runToCard(r: RawRun): AgentCard {
  const status = r.interruptedAt
    ? "interrupted"
    : r.endedAt
      ? r.outcome?.status === "ok"
        ? "complete"
        : "error"
      : "running";
  const started = r.startedAt ?? r.createdAt ?? null;
  return {
    runId: r.runId,
    label: r.label ?? "",
    task: r.task ?? "",
    status,
    backend: r.coderBackend,
    startedAt: started,
    endedAt: r.endedAt ?? null,
    durationMs: r.endedAt && started ? r.endedAt - started : null,
    error: r.outcome?.error ?? null,
    filesTouched: Array.isArray(r.filesTouched) ? r.filesTouched.length : undefined,
  };
}

function historyToCard(h: RawHistory): AgentCard {
  const status =
    h.status === "complete"
      ? "complete"
      : h.status === "timeout"
        ? "timeout"
        : h.status === "error"
          ? "error"
          : (h.status ?? "complete");
  return {
    runId: h.runId,
    label: h.label ?? "",
    task: h.task ?? "",
    status,
    backend: h.coderBackend,
    startedAt: h.startedAt ?? null,
    endedAt: h.endedAt ?? null,
    durationMs: h.endedAt && h.startedAt ? h.endedAt - h.startedAt : null,
    error: h.outcome?.error ?? h.error ?? null,
    filesTouched: h.filesTouchedCount,
  };
}

function inWindow(t: number | undefined | null, start: number, end: number): boolean {
  return typeof t === "number" && t >= start && t <= end;
}

function mockData(window: [number, number]): GatewayRecoveryData {
  const [start, end] = window;
  return {
    generatedAt: Date.now(),
    incidentWindow: window,
    trigger:
      "MOCK: simulated gateway crash detected at boot — 2 interrupted runs queued for resurrection.",
    interrupted: [
      {
        runId: "coder-mock-interrupted-a1b2",
        label: "Refactor billing module",
        task: "Refactor the billing module to use the new credits ledger and add idempotency keys to all charge paths.",
        status: "interrupted",
        backend: "claude-code",
        startedAt: start + 60_000,
        endedAt: null,
        durationMs: null,
        filesTouched: 4,
      },
    ],
    running: [
      {
        runId: "coder-mock-running-c3d4",
        label: "Cloud coder standby",
        task: "Stand by as a cloud coding helper; orient on the repo and await instructions.",
        status: "running",
        backend: "codex",
        startedAt: end - 30_000,
        endedAt: null,
        durationMs: null,
      },
    ],
    resolved: [
      {
        runId: "coder-mock-resolved-e5f6",
        label: "Fix flaky voice test",
        task: "Investigate and fix the intermittently failing voice-stream reconnect test.",
        status: "complete",
        backend: "claude-code",
        startedAt: start + 10_000,
        endedAt: start + 220_000,
        durationMs: 210_000,
        filesTouched: 2,
      },
    ],
    observations: [
      "This is a MOCK report generated with config.mock=true — no real incident occurred.",
      "1 run was interrupted by the crash and is being resurrected via claude --resume.",
      "1 run completed successfully inside the incident window before the crash.",
      "No runs exceeded their timeout deadline; recovery path is healthy.",
    ],
    mock: true,
  };
}

function collectReal(
  stateDir: string,
  window: [number, number],
  trigger: string,
): GatewayRecoveryData {
  const [start, end] = window;

  // Build a base map from the ledger so even a corrupt/empty runs.json produces
  // useful recovery data. We look 24h before the window start for intent events.
  const ledgerSinceMs = start - 24 * 60 * 60 * 1000;
  const ledgerEvents = readSpawnLedger({ sinceMs: ledgerSinceMs });
  const ledgerMap = replayLedgerToRunRecords(ledgerEvents);

  const runsFile = readJson<RunsFile>(join(stateDir, "subagents", "runs.json"));
  const historyFile = readJson<HistoryFile>(join(stateDir, "subagents", "history.json"));

  // Merge: runs.json is authoritative when present; ledger fills gaps.
  const merged = new Map<string, RawRun>();
  for (const [runId, partial] of ledgerMap) {
    if (!partial.endedAt) {
      // Ledger says still-running within window — candidate for interrupted list
      merged.set(runId, {
        runId,
        label: partial.label,
        task: partial.task ?? "",
        childPid: partial.childPid,
        coderBackend: partial.coderBackend,
        createdAt: partial.createdAt,
        startedAt: partial.startedAt,
      });
    }
  }
  for (const r of Object.values(runsFile?.runs ?? {})) {
    // runs.json overrides ledger — it has richer data
    merged.set(r.runId, r);
  }

  const allRuns = [...merged.values()];
  const interrupted: AgentCard[] = [];
  const running: AgentCard[] = [];
  for (const r of allRuns) {
    if (r.interruptedAt) {
      interrupted.push(runToCard(r));
    } else if (!r.endedAt) {
      running.push(runToCard(r));
    }
  }

  const resolved: AgentCard[] = (historyFile?.entries ?? [])
    .filter((h) => inWindow(h.endedAt, start, end))
    .map(historyToCard);

  const failures = resolved.filter((c) => c.status === "error" || c.status === "timeout").length;
  const observations: string[] = [];
  observations.push(`${interrupted.length} run(s) interrupted by the crash are being resurrected.`);
  observations.push(`${running.length} run(s) are live after recovery.`);
  observations.push(
    `${resolved.length} run(s) completed inside the ${Math.round(
      (end - start) / 60000,
    )}-minute window (${failures} failed/timed out).`,
  );
  if (interrupted.length === 0 && running.length === 0) {
    observations.push("No active runs at recovery time — clean restart, nothing to resurrect.");
  }

  return {
    generatedAt: Date.now(),
    incidentWindow: window,
    trigger,
    interrupted,
    running,
    resolved,
    observations,
  };
}

export const gatewayRecoveryKind: ReportKindModule = {
  kind: "gateway_recovery",
  collect({ theme, config, stateDir }): CollectedReport {
    const now = Date.now();
    const rawWindow = config.incidentWindow as [number, number] | undefined;
    const window: [number, number] =
      Array.isArray(rawWindow) &&
      rawWindow.length === 2 &&
      rawWindow.every((n) => typeof n === "number")
        ? [rawWindow[0], rawWindow[1]]
        : [now - DEFAULT_WINDOW_MS, now];
    const trigger =
      (config.trigger as string | undefined) ??
      "Gateway restart detected — post-recovery subagent analysis.";

    const data = config.mock ? mockData(window) : collectReal(stateDir, window, trigger);

    const title = data.mock
      ? "Gateway Recovery (mock)"
      : `Gateway Recovery — ${data.interrupted.length} interrupted, ${data.running.length} running`;
    const summaryText = `${data.interrupted.length} interrupted · ${data.running.length} running · ${data.resolved.length} resolved in window`;

    return {
      title,
      summaryText,
      html: buildGatewayRecoveryHtml(data, theme as Theme),
    };
  },
};
