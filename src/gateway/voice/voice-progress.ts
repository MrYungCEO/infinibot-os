/**
 * Spoken progress of work a live voice call started — what to say, and WHEN.
 *
 * Delegated work (voice-delegate.ts) and the sub-agents it starts report
 * progress here; two consumers take what is due:
 *
 *   - the next turn of the call (voice-fast-turn.ts): due lines are handed to
 *     the model to weave into its reply, first, in a sentence — merged with
 *     what the caller just said;
 *   - the voice provider's update poll (Robovoice polls while the caller and
 *     the agent are quiet and speaks what comes back), so long work is
 *     narrated without the caller having to ask.
 *
 * Rules (per call):
 *   - a progress line is spoken at most every `progressIntervalMs`, counted
 *     from anything the agent said (an acknowledgement, a reply, an update);
 *   - only the newest pending progress of a task is kept, and a line already
 *     spoken for that task is never repeated;
 *   - a task's final result is due at once; its full text goes to the chat
 *     immediately (spoken or not), the spoken part is a one or two sentence
 *     summary;
 *   - once the call has ended (provider said so, or no turn / poll for
 *     `callIdleMs`) nothing more is queued for speech: the chat has it.
 */

import { cleanInline, normalizeSentence, splitSentences, OVERFLOW_NOTE } from "./voice-speech.js";

export type VoiceTaskState = "running" | "done" | "failed" | "cancelled";

export type VoiceTask = {
  id: string;
  callKey: string;
  label: string;
  startedAt: number;
  state: VoiceTaskState;
  doneAt?: number;
  /** Last progress line spoken (or queued) for the task. */
  lastProgress?: string;
  lastProgressAt?: number;
  /** Final summary as spoken (empty while running). */
  summary?: string;
  abort?: () => void;
};

type Pending = { taskId: string; kind: "progress" | "final"; text: string; at: number };

type CallState = {
  key: string;
  lastSeenAt: number;
  /** Last time the agent said anything on the call (reply, ack, update). */
  lastSpokeAt: number;
  pending: Pending[];
  tasks: Map<string, VoiceTask>;
  spoken: Map<string, Set<string>>;
  ended: boolean;
  chatSessionKey?: string;
  intervalMs: number;
  idleMs: number;
};

export type VoiceProgressDeps = {
  now?: () => number;
  /** Full result text for the chat (bound chat session, else the agent's main session). */
  deliverToChat?: (chatSessionKey: string, text: string) => unknown;
  log?: (msg: string) => void;
};

const MAX_CALLS = 200;
const MAX_TASKS_PER_CALL = 12;
const MAX_SPOKEN_SUMMARY_CHARS = 260;
let seq = 0;

/** One or two sentences of a result, for the ear. */
export function spokenSummary(text: string, maxChars = MAX_SPOKEN_SUMMARY_CHARS): string {
  const flat = cleanInline(text.replace(/```[\s\S]*?```/g, " "))
    .replace(/^\s*[-*•#>]+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return "";
  const sentences = splitSentences(flat);
  let out = "";
  for (const s of sentences.slice(0, 2)) {
    if (out && out.length + s.length + 1 > maxChars) break;
    out = out ? `${out} ${s}` : s;
  }
  if (!out) out = flat.slice(0, maxChars);
  if (out.length > maxChars) out = `${out.slice(0, maxChars).replace(/\s+\S*$/, "")}…`;
  const rest = flat.length - out.length;
  return rest > 60 ? `${out} ${OVERFLOW_NOTE}` : out;
}

export class VoiceProgressHub {
  private readonly calls = new Map<string, CallState>();
  private readonly byTask = new Map<string, VoiceTask>();
  private readonly now: () => number;

  constructor(private readonly deps: VoiceProgressDeps = {}) {
    this.now = deps.now ?? Date.now;
  }

  /** Swap the chat sink / clock (gateway wiring, tests). */
  configure(deps: VoiceProgressDeps): void {
    Object.assign(this.deps, deps);
  }

  private call(key: string): CallState {
    let c = this.calls.get(key);
    if (!c) {
      const t = this.now();
      c = {
        key,
        lastSeenAt: t,
        lastSpokeAt: 0,
        pending: [],
        tasks: new Map(),
        spoken: new Map(),
        ended: false,
        intervalMs: 18_000,
        idleMs: 120_000,
      };
      this.calls.set(key, c);
      if (this.calls.size > MAX_CALLS) {
        const oldest = this.calls.keys().next().value!;
        this.dropCall(oldest);
      }
    }
    return c;
  }

  private dropCall(key: string) {
    const c = this.calls.get(key);
    if (!c) return;
    for (const id of c.tasks.keys()) this.byTask.delete(id);
    this.calls.delete(key);
  }

  /**
   * The call is alive (a turn or an update poll). `spoke`: the agent is
   * saying something right now (a reply), so the next progress line waits a
   * full interval.
   */
  callSeen(
    callKey: string,
    opts: {
      spoke?: boolean;
      chatSessionKey?: string;
      intervalMs?: number;
      idleMs?: number;
      /** false = an update poll: it keeps a live call alive but never reopens one that ended. */
      revive?: boolean;
    } = {},
  ): void {
    const c = this.call(callKey);
    const t = this.now();
    if (c.ended && opts.revive === false) return;
    c.lastSeenAt = t;
    c.ended = false;
    if (opts.spoke) c.lastSpokeAt = t;
    if (opts.chatSessionKey) c.chatSessionKey = opts.chatSessionKey;
    if (opts.intervalMs) c.intervalMs = opts.intervalMs;
    if (opts.idleMs) c.idleMs = opts.idleMs;
  }

  startTask(
    callKey: string,
    label: string,
    opts: { abort?: () => void; chatSessionKey?: string; spoke?: boolean } = {},
  ): VoiceTask {
    const c = this.call(callKey);
    if (opts.chatSessionKey) c.chatSessionKey = opts.chatSessionKey;
    const task: VoiceTask = {
      id: `vt${++seq}`,
      callKey,
      label: label.trim().slice(0, 120) || "the task",
      startedAt: this.now(),
      state: "running",
      abort: opts.abort,
    };
    c.tasks.set(task.id, task);
    this.byTask.set(task.id, task);
    // The confirmation is spoken as the task starts: the first progress waits a full interval.
    if (opts.spoke !== false) c.lastSpokeAt = this.now();
    while (c.tasks.size > MAX_TASKS_PER_CALL) {
      const oldest = [...c.tasks.values()].find((x) => x.state !== "running");
      if (!oldest) break;
      c.tasks.delete(oldest.id);
      this.byTask.delete(oldest.id);
    }
    return task;
  }

  getTask(taskId: string): VoiceTask | undefined {
    return this.byTask.get(taskId);
  }

  running(callKey: string): VoiceTask[] {
    return [...(this.calls.get(callKey)?.tasks.values() ?? [])].filter(
      (t) => t.state === "running",
    );
  }

  isEnded(callKey: string): boolean {
    return this.calls.get(callKey)?.ended ?? true;
  }

  private spokenSet(c: CallState, taskId: string): Set<string> {
    let s = c.spoken.get(taskId);
    if (!s) {
      s = new Set();
      c.spoken.set(taskId, s);
    }
    return s;
  }

  /**
   * Queue a progress line for a running task. Returns false when it was
   * dropped (task over, call ended, or the same line was already said).
   */
  progress(taskId: string, text: string): boolean {
    const task = this.byTask.get(taskId);
    const line = text.trim();
    if (!task || task.state !== "running" || !line) return false;
    const c = this.calls.get(task.callKey);
    if (!c || c.ended) return false;
    const key = normalizeSentence(line);
    if (!key || this.spokenSet(c, taskId).has(key)) return false;
    if (task.lastProgress && normalizeSentence(task.lastProgress) === key) return false;
    // Only the newest progress of a task waits.
    c.pending = c.pending.filter((p) => !(p.taskId === taskId && p.kind === "progress"));
    c.pending.push({ taskId, kind: "progress", text: line, at: this.now() });
    task.lastProgress = line;
    task.lastProgressAt = this.now();
    return true;
  }

  /** The task is over: speak a summary (if the call is live), put the full text in the chat. */
  finish(
    taskId: string,
    result: { text: string; failed?: boolean; cancelled?: boolean; chatText?: string },
  ): void {
    const task = this.byTask.get(taskId);
    if (!task || task.state !== "running") return;
    task.state = result.cancelled ? "cancelled" : result.failed ? "failed" : "done";
    task.doneAt = this.now();
    const c = this.calls.get(task.callKey);
    if (!c) return;
    c.pending = c.pending.filter((p) => p.taskId !== taskId);
    if (result.cancelled) return;
    const full = (result.chatText ?? result.text).trim();
    const summary = spokenSummary(result.text) || (result.failed ? "That didn't work out." : "");
    task.summary = summary;
    if (full && c.chatSessionKey && this.deps.deliverToChat) {
      const header = `Voice task "${task.label}" ${result.failed ? "failed" : "finished"}:`;
      Promise.resolve(this.deps.deliverToChat(c.chatSessionKey, `${header}\n\n${full}`)).catch(
        (err) =>
          this.deps.log?.(
            `voice task result not delivered to chat: ${err instanceof Error ? err.message : String(err)}`,
          ),
      );
    }
    if (!c.ended && summary) {
      c.pending.push({ taskId, kind: "final", text: summary, at: this.now() });
    }
  }

  /**
   * What is due on the call now (marked as said). Finals always; at most one
   * progress line, and only when `progressIntervalMs` passed since the agent
   * last spoke (`inTurn`: the caller is talking with the agent right now, so
   * a fresh progress line may go into the reply).
   */
  take(callKey: string, opts: { inTurn?: boolean } = {}): string[] {
    const c = this.calls.get(callKey);
    if (!c || c.ended || !c.pending.length) return [];
    const t = this.now();
    const finals = c.pending.filter((p) => p.kind === "final");
    const progressDue = opts.inTurn || t - c.lastSpokeAt >= c.intervalMs;
    const progress = progressDue
      ? c.pending
          .filter((p) => p.kind === "progress")
          // A task whose final is due needs no progress line.
          .filter((p) => !finals.some((f) => f.taskId === p.taskId))
      : [];
    const out: string[] = [];
    for (const f of finals) {
      const set = this.spokenSet(c, f.taskId);
      const key = normalizeSentence(f.text);
      if (set.has(key)) continue;
      set.add(key);
      out.push(f.text);
    }
    if (progress.length) {
      // Several tasks: one merged line, newest first, at most two.
      const lines = progress
        .slice(-2)
        .reverse()
        .map((p) => p.text.replace(/[.!?…]+$/, ""));
      for (const p of progress) this.spokenSet(c, p.taskId).add(normalizeSentence(p.text));
      out.push(`${lines.join("; ")}.`);
    }
    const takenIds = new Set([...finals, ...progress]);
    c.pending = c.pending.filter(
      (p) => !takenIds.has(p) && !(progressDue && p.kind === "progress"),
    );
    if (out.length) c.lastSpokeAt = t;
    return out;
  }

  /** Pending lines (not yet due included), for diagnostics and tests. */
  pendingCount(callKey: string): number {
    return this.calls.get(callKey)?.pending.length ?? 0;
  }

  /** "Stop": abort everything still running on the call. */
  cancel(callKey: string): number {
    const running = this.running(callKey);
    for (const task of running) {
      try {
        task.abort?.();
      } catch {
        // best effort
      }
      this.finish(task.id, { text: "", cancelled: true });
    }
    return running.length;
  }

  /** The caller hung up: nothing more is spoken; results keep going to the chat. */
  endCall(callKey: string): void {
    const c = this.calls.get(callKey);
    if (!c) return;
    c.ended = true;
    c.pending = [];
  }

  /** Calls nobody has seen for `idleMs` are over. */
  sweep(): string[] {
    const t = this.now();
    const ended: string[] = [];
    for (const c of this.calls.values()) {
      if (!c.ended && t - c.lastSeenAt >= c.idleMs) {
        this.endCall(c.key);
        ended.push(c.key);
      }
      // Forget calls with nothing running long after they ended.
      if (
        c.ended &&
        t - c.lastSeenAt >= 6 * 3600_000 &&
        ![...c.tasks.values()].some((x) => x.state === "running")
      )
        this.dropCall(c.key);
    }
    return ended;
  }

  /** Short state of the call's work, for the model ("how's it going?"). */
  statusNote(callKey: string): string {
    const running = this.running(callKey);
    if (!running.length) return "";
    const t = this.now();
    return [
      "Work you started for the caller that is still running (answer status questions from this; the voice system speaks updates by itself):",
      ...running.map((x) => {
        const mins = Math.max(0, Math.round((t - x.startedAt) / 60_000));
        const age = mins < 1 ? "under a minute ago" : `${mins} minute${mins === 1 ? "" : "s"} ago`;
        return `- "${x.label}", started ${age}${x.lastProgress ? `; latest: ${x.lastProgress}` : ""}`;
      }),
    ].join("\n");
  }

  resetForTests(): void {
    this.calls.clear();
    this.byTask.clear();
  }
}

/** The gateway's hub (one per process). */
export const voiceProgress = new VoiceProgressHub();

let sweeper: ReturnType<typeof setInterval> | null = null;

/** Idle-call sweep, started lazily with the first delegated task. */
export function ensureVoiceProgressSweeper(intervalMs = 15_000): void {
  if (sweeper) return;
  sweeper = setInterval(() => voiceProgress.sweep(), intervalMs);
  sweeper.unref?.();
}
