import fs from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { WorkEvent, WorkloadSummary, WorkloadWeeklyStats } from "./types.js";

const log = createSubsystemLogger("workload-store");

const MAX_EVENT_BYTES = 2048;
const MAX_EVENTS_PER_DAY = 5000;

function workActivityDir(stateDir: string): string {
  return path.join(stateDir, "work-activity");
}

function dayFilePath(stateDir: string, dateIso: string): string {
  return path.join(workActivityDir(stateDir), `${dateIso}.jsonl`);
}

function ensureDir(stateDir: string): void {
  fs.mkdirSync(workActivityDir(stateDir), { recursive: true });
}

function truncateEvent(event: WorkEvent): WorkEvent {
  const serialized = JSON.stringify(event);
  if (serialized.length <= MAX_EVENT_BYTES) return event;
  return {
    ...event,
    label: event.label.slice(0, 120),
    metadata: undefined,
  };
}

export function appendWorkEvent(stateDir: string, event: WorkEvent): void {
  try {
    ensureDir(stateDir);
    const dateIso = new Date(event.ts).toISOString().slice(0, 10);
    const filePath = dayFilePath(stateDir, dateIso);

    const safe = truncateEvent(event);
    const line = JSON.stringify(safe) + "\n";
    fs.appendFileSync(filePath, line, "utf-8");
  } catch (err) {
    log.warn("failed to append work event", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

export function readWorkEvents(stateDir: string, dateIso: string): WorkEvent[] {
  try {
    const filePath = dayFilePath(stateDir, dateIso);
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    const events: WorkEvent[] = [];
    for (const line of lines.slice(-MAX_EVENTS_PER_DAY)) {
      try {
        events.push(JSON.parse(line) as WorkEvent);
      } catch {
        /* skip malformed line */
      }
    }
    return events;
  } catch (err) {
    log.warn("failed to read work events", {
      date: dateIso,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export function readWorkEventRange(
  stateDir: string,
  startDateIso: string,
  endDateIso: string,
): WorkEvent[] {
  const start = new Date(`${startDateIso}T00:00:00`);
  const end = new Date(`${endDateIso}T00:00:00`);
  const events: WorkEvent[] = [];
  const current = new Date(start);
  while (current <= end) {
    const iso = current.toISOString().slice(0, 10);
    events.push(...readWorkEvents(stateDir, iso));
    current.setDate(current.getDate() + 1);
  }
  return events;
}

export function purgeWorkDay(stateDir: string, dateIso: string): boolean {
  try {
    const filePath = dayFilePath(stateDir, dateIso);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
  } catch (err) {
    log.warn("failed to purge work day", {
      date: dateIso,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export function computeWorkloadSummary(events: WorkEvent[], dateIso: string): WorkloadSummary {
  const byKind: WorkloadSummary["byKind"] = {};
  const bySource: WorkloadSummary["bySource"] = {};
  const projectMap: Record<string, { label: string; totalMs: number }> = {};
  let totalMs = 0;

  for (const e of events) {
    const dur = e.durationMs ?? 0;
    totalMs += dur;

    byKind[e.kind] = (byKind[e.kind] ?? 0) + dur;
    bySource[e.source] = (bySource[e.source] ?? 0) + dur;

    if (e.projectId) {
      if (!projectMap[e.projectId]) {
        projectMap[e.projectId] = { label: e.projectId, totalMs: 0 };
      }
      projectMap[e.projectId]!.totalMs += dur;
      if (e.metadata?.projectName && typeof e.metadata.projectName === "string") {
        projectMap[e.projectId]!.label = e.metadata.projectName;
      }
    }
  }

  const byProject = Object.entries(projectMap)
    .map(([projectId, v]) => ({ projectId, label: v.label, totalMs: v.totalMs }))
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, 5);

  return {
    date: dateIso,
    totalMs,
    byKind,
    bySource,
    byProject,
    eventCount: events.length,
  };
}

export function computeWeeklyStats(stateDir: string, endDateIso: string): WorkloadWeeklyStats[] {
  const result: WorkloadWeeklyStats[] = [];
  const end = new Date(`${endDateIso}T00:00:00`);
  for (let i = 6; i >= 0; i--) {
    const d = new Date(end);
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    const events = readWorkEvents(stateDir, iso);
    const totalMs = events.reduce((sum, e) => sum + (e.durationMs ?? 0), 0);
    result.push({ date: iso, totalMs, eventCount: events.length });
  }
  return result;
}
