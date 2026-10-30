import { onAgentEvent, type AgentEventPayload } from "../infra/agent-events.js";
import { emitNotification } from "./emit.js";
import {
  formatDurationHuman,
  formatSubagentNotificationSummary,
  formatSubagentNotificationTitle,
  humanizeSubagentLabel,
  severityForSubagentPhase,
  subagentTaskExcerpt,
} from "./subagent-format.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  getSubagentRun,
  getSubagentRunBySessionKey,
  type SubagentRunRecord,
} from "../agents/subagent-registry.js";

const log = createSubsystemLogger("mobile-push");

// runId:phase → sent timestamp (10-min TTL prevents duplicate pushes)
const DEDUP_TTL_MS = 10 * 60 * 1000;
const sentCache = new Map<string, number>();

function cleanDedup() {
  const now = Date.now();
  for (const [key, ts] of sentCache) {
    if (now - ts > DEDUP_TTL_MS) sentCache.delete(key);
  }
}

function alreadySent(runId: string, phase: string): boolean {
  const key = `${runId}:${phase}`;
  if (sentCache.has(key)) return true;
  sentCache.set(key, Date.now());
  return false;
}

/** Exported for tests only. */
export function resetDedupForTests(): void {
  sentCache.clear();
}

let _stopFn: (() => void) | null = null;

export function startMobilePushDispatcher(stateDir?: string): () => void {
  if (_stopFn) return _stopFn;

  const unsub = onAgentEvent((evt) => {
    if (evt.stream !== "lifecycle") return;
    const phase = evt.data?.phase as string | undefined;
    if (phase !== "start" && phase !== "end" && phase !== "error") return;
    if (alreadySent(evt.runId, phase)) return;

    void dispatchPush(evt, phase, stateDir).catch((err) =>
      log.warn("push dispatch error", { error: String(err) }),
    );
  });

  const cleanInterval = setInterval(cleanDedup, 60_000);

  _stopFn = () => {
    unsub();
    clearInterval(cleanInterval);
    _stopFn = null;
  };

  log.info("mobile push dispatcher started");
  return _stopFn;
}

export function stopMobilePushDispatcher(): void {
  _stopFn?.();
}

// ── input_required helper (unchanged contract, friendlier copy) ──────────────
export async function emitInputRequired(params: {
  runId: string;
  sessionKey: string;
  agentLabel: string;
  prompt?: string;
  stateDir?: string;
}): Promise<void> {
  const deepLink = `infinibot://activity/session/${encodeURIComponent(params.sessionKey)}`;
  const label = humanizeSubagentLabel(params.agentLabel, "Sub-agent");
  const displayTitle = `${label} needs your input`;
  const summary = params.prompt ? subagentTaskExcerpt(params.prompt, 110) : "Tap to review";
  await emitNotification({
    category: "agent.input_required",
    severity: "warn",
    title: displayTitle,
    body: summary,
    source: "agent",
    sourceId: params.sessionKey || params.runId,
    deepLink,
    displayTitle,
    summary,
    data: {
      runId: params.runId,
      sessionKey: params.sessionKey,
      agentLabel: label,
      prompt: params.prompt,
      phase: "input_required",
    },
    stateDir: params.stateDir,
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isCancellation(errorMsg?: string): boolean {
  if (!errorMsg) return false;
  const lower = errorMsg.toLowerCase();
  return lower.includes("cancel") || lower.includes("aborted") || lower.includes("stopped");
}

function sanitizeError(raw: string, maxLen = 160): string {
  const firstLine =
    raw
      .split("\n")[0]
      ?.replace(/\s+at\s+\S+.*$/s, "")
      .trim() ?? "";
  if (!firstLine) return "An unexpected error occurred.";
  return firstLine.length > maxLen ? firstLine.slice(0, maxLen - 1) + "…" : firstLine;
}

function projectHintFromSessionKey(sessionKey?: string): string | undefined {
  if (!sessionKey) return undefined;
  // session keys often look like "agent:<id>:main" or "coder-mobile-..."
  const tail = sessionKey.split(":").pop() ?? sessionKey;
  if (!tail || tail === "main") return undefined;
  const segs = tail.split(/[-_]+/).filter(Boolean);
  // First non-noise segment hints at the project (e.g. "mobile" / "voice")
  const hint = segs.find(
    (s) => !/^(coder|claude|opencode|codex|subagent|run|x[0-9a-f]+)$/i.test(s),
  );
  if (!hint) return undefined;
  return hint.charAt(0).toUpperCase() + hint.slice(1);
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

/**
 * Look up the SubagentRunRecord that owns this lifecycle event. The emit
 * sites (`pi-embedded-subscribe.handlers.lifecycle.ts`, `agent-runner-execution.ts`,
 * `terminal/spawn-agent.ts`, ...) only put `{ phase, startedAt, endedAt, error }`
 * into `evt.data` — the friendly label and original task prompt live in the
 * subagent registry. Falling back to the registry lets the push notification
 * carry the same humanized label + real task description the Activity page
 * shows, without having to thread those fields through every emitter call.
 */
function resolveRunRecord(evt: AgentEventPayload): SubagentRunRecord | undefined {
  const byRun = getSubagentRun(evt.runId);
  if (byRun) return byRun;
  if (evt.sessionKey) return getSubagentRunBySessionKey(evt.sessionKey);
  return undefined;
}

async function dispatchPush(
  evt: AgentEventPayload,
  phase: string,
  stateDir?: string,
): Promise<void> {
  const record = resolveRunRecord(evt);

  // Prefer the registry-stored label/task (the same fields the Activity page
  // renders) over whatever the lifecycle emit site happened to include. Most
  // emit sites currently include neither — so without this fallback the title
  // ends up as a raw runId or sessionKey, defeating the formatter entirely.
  const rawLabel =
    record?.label ||
    (evt.data?.label as string | undefined) ||
    (evt.data?.agentLabel as string | undefined) ||
    evt.sessionKey ||
    evt.runId.slice(0, 8);
  const label = humanizeSubagentLabel(rawLabel, "Sub-agent");

  const taskHint =
    record?.task ||
    (evt.data?.task as string | undefined) ||
    (evt.data?.taskSummary as string | undefined) ||
    "";
  const projectHint = projectHintFromSessionKey(evt.sessionKey);
  const summary = (evt.data?.summary as string | undefined) ?? "";
  const filesTouched = Array.isArray(evt.data?.filesTouched)
    ? (evt.data?.filesTouched as unknown[]).length
    : typeof evt.data?.filesTouchedCount === "number"
      ? (evt.data?.filesTouchedCount as number)
      : typeof record?.filesTouched?.length === "number"
        ? record.filesTouched.length
        : undefined;
  const endedAt =
    typeof evt.data?.endedAt === "number"
      ? (evt.data.endedAt as number)
      : (record?.endedAt ?? Date.now());
  const startedAt = (evt.data?.startedAt as number | undefined) ?? record?.startedAt;
  const durationMs = startedAt ? endedAt - startedAt : undefined;
  const sessionKey = evt.sessionKey ?? record?.childSessionKey ?? "";
  const deepLink = `infinibot://activity/session/${encodeURIComponent(sessionKey)}`;
  const agentBackend = (evt.data?.coderBackend as string | undefined) ?? record?.coderBackend;

  if (phase === "start") {
    const displayTitle = formatSubagentNotificationTitle({
      phase: "spawn",
      label,
      runId: evt.runId,
      sessionKey,
      task: taskHint,
    });
    const summaryLine = formatSubagentNotificationSummary({
      phase: "spawn",
      task: taskHint,
      projectHint,
    });
    await emitNotification({
      category: "agent.completed",
      severity: severityForSubagentPhase("spawn"),
      title: displayTitle,
      body: summaryLine || (taskHint ? subagentTaskExcerpt(taskHint, 110) : "Sub-agent started"),
      source: "agent",
      sourceId: sessionKey || evt.runId,
      deepLink,
      displayTitle,
      summary: summaryLine,
      data: {
        runId: evt.runId,
        sessionKey,
        agentLabel: label,
        agentBackend,
        phase: "spawn",
        task: taskHint || undefined,
        projectHint,
      },
      stateDir,
    });
    return;
  }

  if (phase === "end") {
    const displayTitle = formatSubagentNotificationTitle({
      phase: "complete",
      label,
      runId: evt.runId,
      sessionKey,
      task: taskHint,
    });
    const summaryLine = formatSubagentNotificationSummary({
      phase: "complete",
      durationMs,
      filesTouchedCount: filesTouched,
      summary,
      task: taskHint,
    });
    await emitNotification({
      category: "agent.completed",
      severity: severityForSubagentPhase("complete", "ok"),
      title: displayTitle,
      body:
        summaryLine ||
        (durationMs
          ? `Completed in ${formatDurationHuman(durationMs)}`
          : "Task finished successfully."),
      source: "agent",
      sourceId: sessionKey || evt.runId,
      deepLink,
      displayTitle,
      summary: summaryLine,
      data: {
        runId: evt.runId,
        sessionKey,
        agentLabel: label,
        agentBackend,
        duration: durationMs,
        filesTouchedCount: filesTouched,
        summary: summary || undefined,
        phase: "complete",
      },
      stateDir,
    });
    return;
  }

  // phase === "error"
  const errRaw = (evt.data?.error as string | undefined) ?? summary ?? "";
  const cancelled = isCancellation(errRaw);

  if (cancelled) {
    const displayTitle = formatSubagentNotificationTitle({
      phase: "cancel",
      label,
      runId: evt.runId,
      sessionKey,
      task: taskHint,
    });
    const summaryLine = formatSubagentNotificationSummary({
      phase: "cancel",
      durationMs,
      task: taskHint,
    });
    await emitNotification({
      category: "agent.completed",
      severity: severityForSubagentPhase("cancel"),
      title: displayTitle,
      body:
        summaryLine ||
        (durationMs ? `Stopped after ${formatDurationHuman(durationMs)}` : "Cancelled."),
      source: "agent",
      sourceId: sessionKey || evt.runId,
      deepLink,
      displayTitle,
      summary: summaryLine,
      data: {
        runId: evt.runId,
        sessionKey,
        agentLabel: label,
        duration: durationMs,
        phase: "cancel",
      },
      stateDir,
    });
    return;
  }

  const errorMessage = sanitizeError(errRaw);
  const displayTitle = formatSubagentNotificationTitle({
    phase: "fail",
    label,
    runId: evt.runId,
    sessionKey,
    task: taskHint,
  });
  const summaryLine = formatSubagentNotificationSummary({
    phase: "fail",
    durationMs,
    errorMessage,
    task: taskHint,
  });
  await emitNotification({
    category: "agent.error",
    severity: severityForSubagentPhase("fail", "error"),
    title: displayTitle,
    body: summaryLine || errorMessage,
    source: "agent",
    sourceId: sessionKey || evt.runId,
    deepLink,
    displayTitle,
    summary: summaryLine,
    data: {
      runId: evt.runId,
      sessionKey,
      agentLabel: label,
      agentBackend,
      duration: durationMs,
      errorMessage,
      phase: "fail",
    },
    stateDir,
  });
}
