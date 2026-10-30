/**
 * Merge the persistent sub-agent archive (`subagents.history`) into the live
 * run spine (`subagents.list`).
 *
 * `subagents.list` only knows runs that are still in gateway memory (progress
 * store + registry), so after every gateway restart it returns just the runs
 * spawned since boot. Finished runs live on in `<state>/subagents/history.json`,
 * served by `subagents.history`. Live rows win on runId collisions.
 */

export type SubagentHistoryRow = {
  runId?: unknown;
  label?: unknown;
  task?: unknown;
  status?: unknown;
  startedAt?: unknown;
  endedAt?: unknown;
  outcome?: unknown;
  error?: unknown;
  childSessionKey?: unknown;
  kanbanTaskId?: unknown;
  coderBackend?: unknown;
  filesTouchedCount?: unknown;
};

const HISTORY_STATUS: Record<string, string> = {
  complete: "completed",
  error: "error",
  timeout: "timeout",
};

/** Project one archive row into the `subagents.list` item shape. */
export function historyRowToSubagent(h: SubagentHistoryRow): Record<string, unknown> | null {
  const runId = typeof h.runId === "string" ? h.runId : "";
  const endedAt = typeof h.endedAt === "number" ? h.endedAt : 0;
  if (!runId || !endedAt) return null;
  const startedAt = typeof h.startedAt === "number" ? h.startedAt : undefined;
  const rawStatus = typeof h.status === "string" ? h.status : "";
  const outcome =
    h.outcome && typeof h.outcome === "object"
      ? (h.outcome as { status?: string; error?: string })
      : typeof h.error === "string"
        ? { status: "error", error: h.error }
        : undefined;
  return {
    runId,
    sessionKey: typeof h.childSessionKey === "string" ? h.childSessionKey : "",
    label: typeof h.label === "string" ? h.label : undefined,
    task: typeof h.task === "string" ? h.task : "",
    status: HISTORY_STATUS[rawStatus] ?? rawStatus,
    progress: rawStatus === "complete" ? 100 : 0,
    createdAt: startedAt ?? endedAt,
    startedAt,
    endedAt,
    lastUpdateAt: endedAt,
    outcome,
    recentUpdates: [],
    filesTouchedCount: typeof h.filesTouchedCount === "number" ? h.filesTouchedCount : undefined,
    coderBackend: typeof h.coderBackend === "string" ? h.coderBackend : undefined,
    kanbanTaskId: typeof h.kanbanTaskId === "string" ? h.kanbanTaskId : undefined,
    archived: true,
  };
}

/** Live rows first; archive rows appended when their runId isn't live. Newest first. */
export function mergeLiveAndHistory(
  live: Array<Record<string, unknown>>,
  history: SubagentHistoryRow[],
): Array<Record<string, unknown>> {
  const seen = new Set(live.map((s) => s.runId).filter((id): id is string => typeof id === "string"));
  const out = [...live];
  for (const h of history) {
    const row = historyRowToSubagent(h);
    if (!row || seen.has(row.runId as string)) continue;
    seen.add(row.runId as string);
    out.push(row);
  }
  const ts = (s: Record<string, unknown>) =>
    (typeof s.lastUpdateAt === "number" && s.lastUpdateAt) ||
    (typeof s.endedAt === "number" && s.endedAt) ||
    (typeof s.createdAt === "number" && s.createdAt) ||
    0;
  return out.sort((a, b) => ts(b) - ts(a));
}
