import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { SubagentRunRecord } from "./subagent-registry.js";

const log = createSubsystemLogger("spawn-ledger");

export type SpawnLedgerEvent =
  | {
      v: 1;
      ts: number;
      event: "spawn.intent";
      runId: string;
      kind: "coder" | "session" | "resume" | "federated";
      backend?: string;
      task: string;
      label?: string;
      requesterSessionKey?: string;
      childSessionKey?: string;
      workdir?: string;
      node?: string;
      respawnOfRunId?: string;
    }
  | { v: 1; ts: number; event: "spawn.pid"; runId: string; pid: number }
  | { v: 1; ts: number; event: "spawn.failed"; runId: string; error: string }
  | {
      v: 1;
      ts: number;
      event: "run.ended";
      runId: string;
      outcome: "ok" | "error" | "interrupted" | "timeout";
      durationMs?: number;
      error?: string;
    };

function ledgerPath(): string {
  return path.join(resolveStateDir(), "subagents", "spawn-ledger.ndjson");
}

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/** Synchronously append one event as a JSON line. Never throws to caller. */
export function appendSpawnEvent(event: SpawnLedgerEvent): void {
  try {
    const p = ledgerPath();
    ensureDir(p);
    fs.appendFileSync(p, `${JSON.stringify(event)}\n`, { flag: "a", encoding: "utf8" });
  } catch (err) {
    log.warn("spawn-ledger: append failed", {
      event: event.event,
      runId: (event as { runId?: string }).runId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Read all valid events from the ledger, optionally filtered by timestamp. */
export function readSpawnLedger(opts?: { sinceMs?: number }): SpawnLedgerEvent[] {
  const p = ledgerPath();
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    return [];
  }
  const sinceMs = opts?.sinceMs ?? 0;
  const results: SpawnLedgerEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const ev = JSON.parse(trimmed) as SpawnLedgerEvent;
      if (typeof ev !== "object" || ev === null) continue;
      if (ev.v !== 1) continue;
      if (typeof ev.ts !== "number") continue;
      if (ev.ts < sinceMs) continue;
      results.push(ev);
    } catch {
      // Torn line at end of file — skip silently
    }
  }
  return results;
}

/**
 * Fold a set of ledger events into a minimal per-runId state map.
 * Useful for rehydrating runs.json after a hard crash.
 */
export function replayLedgerToRunRecords(
  events: SpawnLedgerEvent[],
): Map<string, Partial<SubagentRunRecord>> {
  const map = new Map<string, Partial<SubagentRunRecord>>();

  for (const ev of events) {
    if (ev.event === "spawn.intent") {
      const existing = map.get(ev.runId) ?? {};
      map.set(ev.runId, {
        ...existing,
        runId: ev.runId,
        task: ev.task,
        label: ev.label,
        childSessionKey: ev.childSessionKey ?? ev.runId,
        requesterSessionKey: ev.requesterSessionKey ?? "",
        requesterDisplayKey: ev.requesterSessionKey ?? "",
        coderBackend:
          ev.kind === "coder" && ev.backend
            ? (ev.backend as SubagentRunRecord["coderBackend"])
            : existing.coderBackend,
        workdir: ev.workdir ?? existing.workdir,
        respawnOfRunId: ev.respawnOfRunId ?? existing.respawnOfRunId,
        createdAt: existing.createdAt ?? ev.ts,
        cleanup: existing.cleanup ?? "delete",
        cleanupHandled: existing.cleanupHandled ?? false,
      });
    } else if (ev.event === "spawn.pid") {
      const existing = map.get(ev.runId) ?? {};
      map.set(ev.runId, { ...existing, childPid: ev.pid, startedAt: existing.startedAt ?? ev.ts });
    } else if (ev.event === "spawn.failed") {
      const existing = map.get(ev.runId) ?? {};
      map.set(ev.runId, {
        ...existing,
        endedAt: existing.endedAt ?? ev.ts,
        outcome: existing.outcome ?? { status: "error", error: ev.error },
      });
    } else if (ev.event === "run.ended") {
      const existing = map.get(ev.runId) ?? {};
      map.set(ev.runId, {
        ...existing,
        endedAt: existing.endedAt ?? ev.ts,
        outcome:
          existing.outcome ??
          (ev.outcome === "ok"
            ? { status: "ok" }
            : { status: ev.outcome === "timeout" ? "timeout" : "error", error: ev.error }),
      });
    }
  }

  return map;
}

/**
 * Rewrite the ledger keeping only events for runs in keepRunIds.
 * Call from a background sweeper occasionally; NOT on the hot path.
 */
export function compactLedger(opts: { keepRunIds: Set<string> }): void {
  const p = ledgerPath();
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    return;
  }
  const kept: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const ev = JSON.parse(trimmed) as SpawnLedgerEvent;
      if (typeof ev === "object" && ev !== null && opts.keepRunIds.has(ev.runId)) {
        kept.push(trimmed);
      }
    } catch {
      // Drop malformed lines
    }
  }
  try {
    fs.writeFileSync(p, kept.length ? `${kept.join("\n")}\n` : "", { encoding: "utf8" });
  } catch (err) {
    log.warn("spawn-ledger: compact write failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
