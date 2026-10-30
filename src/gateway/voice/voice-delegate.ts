/**
 * Delegation from a live voice call to the MAIN tool-use agent.
 *
 * The voice front-end (voice-fast-turn.ts) answers conversation and quick
 * lookups itself. Anything it cannot do fast — spawning sub-agents or coders,
 * kanban changes, plugins (Droid Swarm, content posting, FlyPic…), multi-step
 * work — is handed to the main agent with the conversation so far, the caller
 * hears a short confirmation at once, and the call goes on. The hand-off never
 * blocks a turn:
 *
 *   startVoiceDelegation  runs the main agent (agentCommand: full tool set,
 *                         skills, memory) on its own session key under the
 *                         call (`<call session>:dlg-<id>`), so several tasks of
 *                         one call run side by side and a quick question on
 *                         the call is never queued behind a long task;
 *   watchCallChildren     follows the sub-agents a full-agent voice turn
 *                         started on the call's own session.
 *
 * A tracker per task follows the main agent's run (its tool calls and reply),
 * the sub-agents it starts (registry + progress + verified completion) and
 * the main agent's reply when they finish, and reports to the call's
 * VoiceProgressHub: milestones ("the main agent started a coder"), activity
 * ("Still working: the coder is running tests"), a heartbeat on long quiet
 * stretches, and the final result (spoken summary + full text in the chat).
 */

import { randomUUID } from "node:crypto";

import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { GatewayTurnDeps } from "./voice-llm-turn.js";
import {
  ensureVoiceProgressSweeper,
  voiceProgress,
  type VoiceProgressHub,
} from "./voice-progress.js";
import { cleanInline, splitSentences } from "./voice-speech.js";

const log = createSubsystemLogger("voice/delegate");

/** Tools that start background runs (milestones + children to follow). */
export const SPAWN_TOOLS = new Set([
  "sessions_spawn",
  "claude_coder",
  "codex_coder",
  "grok_coder",
  "opencode_coder",
  "goal_run",
  "queue_run",
]);

export type ChildRun = {
  runId: string;
  label: string;
  startedAt: number;
  endedAt?: number;
  failed?: boolean;
  coder?: boolean;
};

export type ChildCompletion = {
  terminal: boolean;
  state: string;
  verdict?: string;
  summary?: string;
  reasons?: string[];
};

export type ChildActivity = {
  kind: string;
  label: string;
  at: number;
  message?: string;
  /** Status of the last progress update (starting / working / checkpoint / blocked / finishing). */
  status?: string;
};

export type DelegateDeps = {
  runAgent: GatewayTurnDeps["runAgent"];
  onAgentEvent: (
    listener: (evt: {
      runId?: string;
      stream?: string;
      sessionKey?: string;
      data?: Record<string, unknown>;
    }) => void,
  ) => () => void;
  /** Runs started from a session (sub-agent registry). */
  listChildRuns: (requesterSessionKey: string) => ChildRun[];
  /** Verified-completion state of a run. */
  completion: (runId: string) => ChildCompletion | undefined;
  /** Live activity of a run (last tool / progress message). */
  activity: (runId: string) => ChildActivity | undefined;
  hub: VoiceProgressHub;
  now: () => number;
  /** How often runs are checked. */
  tickMs: number;
  /** After the last sub-agent finished: wait this long for the main agent's own summary. */
  finalGraceMs: number;
  /** Give up following a task after this long (the chat still gets results). */
  maxTaskMs: number;
};

let defaultDeps: Promise<DelegateDeps> | null = null;

/** Gateway wiring (lazy: the agent stack loads on the first delegation). */
export function defaultDelegateDeps(): Promise<DelegateDeps> {
  defaultDeps ??= (async () => {
    const [
      { agentCommand },
      { createDefaultDeps },
      { defaultRuntime },
      { onAgentEvent },
      registry,
      progress,
      store,
    ] = await Promise.all([
      import("../../commands/agent.js"),
      import("../../cli/deps.js"),
      import("../../runtime.js"),
      import("../../infra/agent-events.js"),
      import("../../agents/subagent-registry.js"),
      import("../../agents/subagent-progress.js"),
      import("../../verification/store.js"),
    ]);
    return {
      runAgent: (o) =>
        agentCommand(
          {
            message: o.message,
            agentId: o.agentId,
            sessionKey: o.sessionKey,
            runId: o.runId,
            extraSystemPrompt: o.extraSystemPrompt,
            abortSignal: o.abortSignal,
            deliver: false,
            bestEffortDeliver: false,
            messageChannel: "voice",
          },
          defaultRuntime,
          createDefaultDeps(),
        ),
      onAgentEvent: onAgentEvent as DelegateDeps["onAgentEvent"],
      listChildRuns: (key) =>
        registry.listSubagentRunsForRequester(key).map((r) => ({
          runId: r.runId,
          label: (r.label || r.task || "sub-agent").slice(0, 80),
          startedAt: r.startedAt ?? r.createdAt,
          endedAt: r.endedAt ?? (r.interruptedAt && !r.durableSpawn ? r.interruptedAt : undefined),
          failed: r.outcome ? r.outcome.status !== "ok" : undefined,
          coder: !!r.coderBackend,
        })),
      completion: (runId) => {
        const rec = store.getRecord(runId);
        if (!rec) return undefined;
        return {
          terminal: store.isTerminal(rec),
          state: rec.state,
          verdict: rec.review?.verdict,
          summary: rec.result?.summary,
          reasons: rec.review?.reasons,
        };
      },
      activity: (runId) => {
        const p = progress.getProgress(runId);
        if (!p) return undefined;
        const last = p.updates[p.updates.length - 1];
        const a = p.lastActivity;
        if (!a && !last) return undefined;
        return {
          kind: a?.kind ?? "progress",
          label: a?.label ?? "",
          at: Math.max(a?.at ?? 0, last?.timestamp ?? 0),
          message: last?.message,
          status: last?.status,
        };
      },
      hub: voiceProgress,
      now: Date.now,
      tickMs: 3_000,
      finalGraceMs: 25_000,
      maxTaskMs: 3 * 3600_000,
    };
  })();
  return defaultDeps;
}

// ── wording ───────────────────────────────────────────────────────────────────

/** System prompt of the delegated main-agent run. */
export function delegateSystemPrompt(): string {
  return [
    "[Delegated from a live voice call]",
    "The owner asked for this on a voice call. The voice assistant already told them you are handling it and that they will get updates. Do the work now with your full tool set: use messages, Telegram, the board, notes, plugins, Droid Swarm, content posting, FlyPic, or whatever direct tool the task needs.",
    "Do simple actions directly. Sending a message, updating kanban, or writing a note must use the direct tool and must not spawn a coder. Coders are only for code, repository changes, builds/tests, or genuinely long engineering work.",
    "When a coder is appropriate, choose the coder tool as the backend. Never put a backend/tool name such as codex, claude, claude-code, opencode, gemini, or default in the model field; omit model unless the owner named an actual model.",
    "Never wait on background work: do not call subagents_wait and do not pass waitSec to subagents_events. Start it and reply. The voice system follows every run you start, speaks progress to the owner, and you are told when each run finishes.",
    "The spoken request is the owner's go-ahead: do not use request_approval or wait_approval. If a step is irreversible or spends money and the request was not explicit about it, do not do that step: say in your reply what needs a yes.",
    "Reply in plain text. Lead with one or two short sentences the owner can hear (what you did or started, or the answer), no markdown in them. Details for the chat may follow.",
  ].join("\n");
}

function firstSentence(text: string, max = 140): string {
  const flat = cleanInline(text).replace(/\s+/g, " ").trim();
  const s = splitSentences(flat)[0] ?? flat;
  return s.length > max ? `${s.slice(0, max).replace(/\s+\S*$/, "")}…` : s;
}

function isNoReply(text: string): boolean {
  const t = text.trim();
  return !t || /^(?:NO_REPLY|HEARTBEAT_OK)\.?$/i.test(t);
}

function spawnMilestone(tool: string): string {
  if (/coder/.test(tool)) return "I started a coder on it.";
  if (tool === "sessions_spawn") return "I started a sub-agent on it.";
  if (tool === "goal_run") return "I started a goal run for it.";
  if (tool === "queue_run") return "I queued the work.";
  return "";
}

/** "Still working: the coder is running tests." from a run's last activity. */
export function activityPhrase(a: ChildActivity | undefined, who: string): string {
  if (!a) return "";
  const l = `${a.label} ${a.kind}`.toLowerCase();
  const k = a.kind.toLowerCase();
  if (/\b(?:test|tests|vitest|jest|pytest|playwright|spec)\b/.test(l))
    return `Still working: ${who} is running tests.`;
  if (/\b(?:build|tsc|compile|bundle)\b/.test(l)) return `Still working: ${who} is building.`;
  if (/\bgit (?:commit|push)\b|\bgh pr\b|pull request/.test(l))
    return `Still working: ${who} is committing the changes.`;
  if (/^(?:edit|write|multiedit|notebookedit|apply_patch|patch)$/.test(k))
    return `Still working: ${who} is editing the code.`;
  if (/^(?:read|grep|glob|ls|search)$/.test(k))
    return `Still working: ${who} is reading through the code.`;
  if (/web|fetch|browse/.test(k)) return `Still working: ${who} is researching.`;
  if (a.message && a.kind === "progress") {
    // The registry's own bookkeeping ("Starting: <label>", "Task completed") says nothing.
    if (a.status === "starting") return "";
    if (/^(?:starting\b|task completed|completed|done|finished)\b/i.test(a.message.trim()))
      return "";
    if (a.status === "blocked")
      return `${who[0].toUpperCase()}${who.slice(1)} is blocked: ${firstSentence(a.message, 100)}`;
    return `Still working: ${firstSentence(a.message, 100)}`;
  }
  return "";
}

function composeFinal(children: Map<string, TrackedChild>): { text: string; failed: boolean } {
  const all = [...children.values()];
  const bad = all.filter((c) => c.failed);
  const line = (c: TrackedChild) => {
    const what = c.summary ? ` ${firstSentence(c.summary, 220)}` : "";
    if (c.failed) {
      const why = c.reasons?.[0]
        ? firstSentence(c.reasons[0], 180)
        : c.summary
          ? firstSentence(c.summary, 180)
          : "no detailed failure reason was recorded";
      return `${c.label} failed because ${why}`;
    }
    return `${c.label} is done${c.verdict === "VERIFIED" ? " and verified" : ""}.${what}`;
  };
  if (all.length === 1) {
    const c = all[0];
    return {
      text: c.failed
        ? `${line(c)} I can retry the failed run with the corrected settings.`
        : `Done: ${line(c)}`,
      failed: !!c.failed,
    };
  }
  const lead =
    bad.length === all.length
      ? `None of the ${all.length} runs worked out.`
      : bad.length
        ? `Done: ${all.length} runs finished, ${bad.length === 1 ? "one" : bad.length} with a problem.`
        : `Done: all ${all.length} runs finished.`;
  const retry = bad.length ? " I can retry the failed run with the corrected settings." : "";
  return {
    text: `${lead} ${all.map(line).join(" ")}${retry}`,
    failed: bad.length === all.length,
  };
}

function ensureFailureReasonAndRetry(text: string, children: Map<string, TrackedChild>): string {
  const bad = [...children.values()].filter((c) => c.failed);
  if (bad.length === 0) return text;
  const first = bad[0];
  const reason = first.reasons?.[0] ?? first.summary ?? "no detailed failure reason was recorded";
  let out = text.trim();
  if (!out.toLowerCase().includes(firstSentence(reason, 80).toLowerCase())) {
    out += ` ${first.label} failed because ${firstSentence(reason, 180)}`;
  }
  if (!/\bretr(?:y|ied|ying)\b/i.test(out)) {
    out += " I can retry the failed run with the corrected settings.";
  }
  return out;
}

// ── tracking ──────────────────────────────────────────────────────────────────

type TrackedChild = {
  runId: string;
  label: string;
  coder?: boolean;
  done: boolean;
  /** When the run itself ended (before its review settled). */
  endedAt?: number;
  failed?: boolean;
  verdict?: string;
  summary?: string;
  reasons?: string[];
};

export type VoiceTaskHandle = {
  taskId: string;
  /** Session the delegated run works on. */
  sessionKey: string;
  /** Settles when the task is finished (or given up). */
  done: Promise<void>;
};

type TrackOptions = {
  taskId: string;
  /** Session whose runs and sub-agents belong to the task. */
  watchKey: string;
  /** Only sub-agents started at or after this time. */
  since: number;
  label: string;
  /** The main agent's replies on `watchKey` are the task's summaries (delegated sessions only). */
  captureReplies: boolean;
  /** A run of ours is in flight (delegation); false = children only. */
  expectMainRun: boolean;
  progressIntervalMs: number;
};

class TaskTracker {
  readonly children = new Map<string, TrackedChild>();
  private readonly runText = new Map<string, string>();
  private readonly runStartedAt = new Map<string, number>();
  private readonly runEndedAt = new Map<string, number>();
  private mainRunId: string | null = null;
  private mainDone: boolean;
  private mainDoneAt = 0;
  private mainText = "";
  private spawnStarts = 0;
  private allDoneAt = 0;
  private finished = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private resolveDone!: () => void;
  readonly done = new Promise<void>((r) => (this.resolveDone = r));
  private readonly startedAt: number;

  constructor(
    private readonly o: TrackOptions,
    private readonly d: DelegateDeps,
  ) {
    this.mainDone = !o.expectMainRun;
    this.startedAt = d.now();
    this.unsubscribe = d.onAgentEvent((evt) => this.onEvent(evt));
    this.timer = setInterval(() => this.tick(), d.tickMs);
    this.timer.unref?.();
  }

  setMainRun(runId: string) {
    this.mainRunId = runId;
  }

  private onEvent(evt: {
    runId?: string;
    stream?: string;
    sessionKey?: string;
    data?: Record<string, unknown>;
  }) {
    if (this.finished || !evt.runId) return;
    const mine = evt.runId === this.mainRunId || evt.sessionKey === this.o.watchKey;
    if (!mine) return;
    // On the call's own session only our tool milestones matter, not its replies.
    if (!this.o.captureReplies && evt.runId !== this.mainRunId) return;
    const runId = evt.runId;
    if (evt.stream === "lifecycle") {
      const phase = evt.data?.phase;
      if (phase === "start") this.runStartedAt.set(runId, this.d.now());
      else if (phase === "end" || phase === "error") this.runEndedAt.set(runId, this.d.now());
      return;
    }
    if (evt.stream === "tool") {
      const name = evt.data?.name;
      if (evt.data?.phase === "start" && typeof name === "string" && SPAWN_TOOLS.has(name)) {
        this.spawnStarts++;
        const m = spawnMilestone(name);
        if (m) this.d.hub.progress(this.o.taskId, m);
      }
      return;
    }
    if (evt.stream === "assistant") {
      const delta = evt.data?.delta;
      if (typeof delta === "string" && delta) {
        this.runText.set(runId, (this.runText.get(runId) ?? "") + delta);
        if (!this.runStartedAt.has(runId)) this.runStartedAt.set(runId, this.d.now());
      }
    }
  }

  /** The delegated run returned (or failed). */
  mainRunSettled(result: { text: string; error?: string }) {
    if (this.finished) return;
    this.mainDone = true;
    this.mainDoneAt = this.d.now();
    const streamed = this.mainRunId ? (this.runText.get(this.mainRunId) ?? "") : "";
    this.mainText = (streamed.trim() ? streamed : result.text).trim();
    if (result.error) {
      this.finish({
        text: `The main agent hit an error: ${firstSentence(result.error, 160)}`,
        failed: true,
      });
      return;
    }
    this.tick();
  }

  tick() {
    if (this.finished) return;
    const now = this.d.now();
    this.discoverChildren();
    const who = (c: TrackedChild) =>
      this.children.size > 1 ? `the ${c.label} run` : c.coder ? "the coder" : "the sub-agent";
    for (const c of this.children.values()) {
      if (c.done) continue;
      const comp = this.d.completion(c.runId);
      const run = this.lastRuns.get(c.runId);
      if (run?.endedAt) c.endedAt ??= run.endedAt;
      if (comp?.terminal) {
        c.endedAt ??= now;
        c.done = true;
        c.verdict = comp.verdict;
        c.summary = comp.summary;
        c.reasons = comp.reasons;
        c.failed =
          comp.verdict === "FAILED" || /^(?:failed|stalled|blocked|rejected)$/.test(comp.state);
        continue;
      }
      if (run?.endedAt && (!comp || now - run.endedAt > 180_000)) {
        // No verified-completion record (verification off), or it never settled.
        if (!comp && now - run.endedAt < 8_000) continue;
        c.endedAt ??= run.endedAt;
        c.done = true;
        c.failed = run.failed;
        continue;
      }
      const phrase = activityPhrase(this.d.activity(c.runId), who(c));
      if (phrase) this.d.hub.progress(this.o.taskId, phrase);
    }

    if (!this.mainDone) return this.heartbeat(now);

    if (this.children.size === 0) {
      // Following a turn's sub-agents: wait for them to show up (or be dropped).
      if (!this.o.expectMainRun) return;
      // Nothing was started in the background: the main agent's reply is the result.
      const waitingForSpawn = this.spawnStarts > 0 && now - this.mainDoneAt < 15_000;
      if (waitingForSpawn) return;
      this.finish({
        text: isNoReply(this.mainText) ? "Done." : this.mainText,
        failed: false,
      });
      return;
    }
    // Background work started: the main agent's reply is a milestone.
    if (this.mainText && !isNoReply(this.mainText)) {
      this.d.hub.progress(this.o.taskId, firstSentence(this.mainText));
      this.mainText = "";
    }
    const pending = [...this.children.values()].filter((c) => !c.done);
    if (pending.length) return this.heartbeat(now);

    this.allDoneAt ||= now;
    if (this.o.captureReplies) {
      // The main agent is told when its runs finish (as soon as each run ends,
      // before its review settles) and summarises them.
      const lastEnd = Math.max(
        ...[...this.children.values()].map((c) => c.endedAt ?? this.allDoneAt),
      );
      const reply = this.replyAfter(lastEnd - 5_000);
      if (reply) {
        const allFailed = [...this.children.values()].every((c) => c.failed);
        this.finish({
          text: ensureFailureReasonAndRetry(reply, this.children),
          failed: allFailed,
        });
        return;
      }
      if (now - this.allDoneAt < this.d.finalGraceMs) return;
    }
    this.finish(composeFinal(this.children));
  }

  private lastRuns = new Map<string, ChildRun>();

  private discoverChildren() {
    let runs: ChildRun[] = [];
    try {
      runs = this.d.listChildRuns(this.o.watchKey);
    } catch {
      return;
    }
    for (const r of runs) {
      if (r.startedAt < this.o.since - 1_000) continue;
      this.lastRuns.set(r.runId, r);
      if (!this.children.has(r.runId)) {
        this.children.set(r.runId, {
          runId: r.runId,
          label: r.label.replace(/[-_]+/g, " ").trim() || "sub-agent",
          coder: r.coder,
          done: false,
        });
      }
    }
  }

  /** A finished reply of the main agent on the task session that started after `since`. */
  private replyAfter(since: number): string {
    let best = "";
    let bestAt = 0;
    for (const [runId, text] of this.runText) {
      const started = this.runStartedAt.get(runId) ?? 0;
      const ended = this.runEndedAt.get(runId);
      if (runId === this.mainRunId || !ended || started < since) continue;
      if (isNoReply(text)) continue;
      if (ended > bestAt) {
        best = text.trim();
        bestAt = ended;
      }
    }
    return best;
  }

  private heartbeat(now: number) {
    if (now - this.startedAt > this.d.maxTaskMs) {
      this.finish({
        text: `${this.o.label} is still running after a long time. I'll put the result in the chat when it's done.`,
        failed: false,
      });
      return;
    }
    // A quiet stretch: a short "still going" (at most every two intervals, and only when nothing newer was said).
    const task = this.d.hub.getTask(this.o.taskId);
    const last = Math.max(task?.lastProgressAt ?? 0, this.startedAt);
    const every = Math.max(30_000, this.o.progressIntervalMs * 2);
    if (now - last < every) return;
    const running = [...this.children.values()].filter((c) => !c.done);
    const who =
      running.length > 1
        ? `${running.length} runs are`
        : running.length === 1
          ? `${running[0].coder ? "the coder" : `the ${running[0].label} run`} is`
          : "";
    const mins = Math.floor((now - this.startedAt) / 60_000);
    const when = mins >= 1 ? `, about ${mins} minute${mins === 1 ? "" : "s"} in` : "";
    this.d.hub.progress(
      this.o.taskId,
      who ? `Still working: ${who} still going${when}.` : `Still working on it${when}.`,
    );
  }

  finish(result: { text: string; failed: boolean }) {
    if (this.finished) return;
    this.finished = true;
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe?.();
    this.d.hub.finish(this.o.taskId, {
      text: result.text,
      chatText: result.text,
      failed: result.failed,
    });
    this.resolveDone();
  }

  cancel() {
    if (this.finished) return;
    this.finished = true;
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe?.();
    this.resolveDone();
  }
}

function payloadText(result: unknown): string {
  const payloads = (result as { payloads?: Array<{ text?: string }> } | null)?.payloads;
  return Array.isArray(payloads)
    ? payloads
        .map((p) => (typeof p.text === "string" ? p.text : ""))
        .filter(Boolean)
        .join("\n")
    : "";
}

function shortLabel(task: string): string {
  const t = cleanInline(task).replace(/\s+/g, " ").trim();
  return t.length > 70 ? `${t.slice(0, 70).replace(/\s+\S*$/, "")}…` : t || "the task";
}

/**
 * Hand a task to the main agent. Returns at once: the run, its sub-agents and
 * the spoken progress continue in the background.
 */
export async function startVoiceDelegation(
  p: {
    agentId: string;
    /** The call's session (voicecall-owner key, or the chat session it is bound to). */
    callSessionKey: string;
    /** Where the full result text goes (bound chat session or the agent's main session). */
    chatSessionKey?: string;
    task: string;
    /** The conversation so far, as text. */
    context?: string;
    label?: string;
    progressIntervalMs: number;
    callIdleMs?: number;
  },
  deps?: DelegateDeps,
): Promise<VoiceTaskHandle> {
  const d = deps ?? (await defaultDelegateDeps());
  if (!deps) ensureVoiceProgressSweeper();
  const abort = new AbortController();
  const label = p.label?.trim() || shortLabel(p.task);
  d.hub.callSeen(p.callSessionKey, {
    chatSessionKey: p.chatSessionKey,
    intervalMs: p.progressIntervalMs,
    idleMs: p.callIdleMs,
  });
  const vt = d.hub.startTask(p.callSessionKey, label, {
    abort: () => abort.abort(),
    chatSessionKey: p.chatSessionKey,
  });
  const sessionKey = `${p.callSessionKey}:dlg-${randomUUID().slice(0, 8)}`;
  const runId = `voicedlg_${randomUUID()}`;
  const tracker = new TaskTracker(
    {
      taskId: vt.id,
      watchKey: sessionKey,
      since: d.now(),
      label,
      captureReplies: true,
      expectMainRun: true,
      progressIntervalMs: p.progressIntervalMs,
    },
    d,
  );
  tracker.setMainRun(runId);
  const task = vt;
  task.abort = () => {
    abort.abort();
    tracker.cancel();
  };
  const message = [
    p.context ? `${p.context}\n` : "",
    `The owner asked on the call: ${p.task.trim()}`,
  ]
    .filter(Boolean)
    .join("\n");
  log.info(`voice delegation ${vt.id} → ${sessionKey}: ${label}`);
  void Promise.resolve()
    .then(() =>
      d.runAgent({
        message,
        agentId: p.agentId,
        sessionKey,
        runId,
        extraSystemPrompt: delegateSystemPrompt(),
        abortSignal: abort.signal,
      }),
    )
    .then(
      (r) => tracker.mainRunSettled({ text: payloadText(r) }),
      (err) => {
        if (abort.signal.aborted) return tracker.cancel();
        tracker.mainRunSettled({
          text: "",
          error: err instanceof Error ? err.message : String(err),
        });
      },
    );
  return { taskId: vt.id, sessionKey, done: tracker.done };
}

/**
 * Follow the sub-agents a voice turn started on the call's own session (the
 * full agent's turn, or a spawn tool the fast step called directly).
 */
export async function watchCallChildren(
  p: {
    callSessionKey: string;
    chatSessionKey?: string;
    since: number;
    label: string;
    progressIntervalMs: number;
    callIdleMs?: number;
  },
  deps?: DelegateDeps,
): Promise<VoiceTaskHandle | null> {
  const d = deps ?? (await defaultDelegateDeps());
  if (!deps) ensureVoiceProgressSweeper();
  // Already followed by another task of this call?
  const running = d.hub.running(p.callSessionKey);
  if (running.some((t) => t.label === p.label)) return null;
  d.hub.callSeen(p.callSessionKey, {
    chatSessionKey: p.chatSessionKey,
    intervalMs: p.progressIntervalMs,
    idleMs: p.callIdleMs,
  });
  const vt = d.hub.startTask(p.callSessionKey, p.label, { chatSessionKey: p.chatSessionKey });
  const tracker = new TaskTracker(
    {
      taskId: vt.id,
      watchKey: p.callSessionKey,
      since: p.since,
      label: p.label,
      captureReplies: false,
      expectMainRun: false,
      progressIntervalMs: p.progressIntervalMs,
    },
    d,
  );
  vt.abort = () => tracker.cancel();
  // Nothing was actually started (the spawn failed): drop the task quietly.
  setTimeout(() => {
    if (!tracker.children.size) {
      tracker.cancel();
      d.hub.finish(vt.id, { text: "", cancelled: true });
    }
  }, 20_000).unref?.();
  return { taskId: vt.id, sessionKey: p.callSessionKey, done: tracker.done };
}

export function resetVoiceDelegateForTests(): void {
  defaultDeps = null;
}
