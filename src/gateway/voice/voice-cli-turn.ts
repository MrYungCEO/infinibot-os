/**
 * One voice turn answered by a SELECTED CLI session (Voice page → "CLI
 * session" routing). runVoiceLlmTurn sends owner turns here while the route
 * (voice-cli-route.ts) is "cli"; every voice provider that calls the gateway's
 * voice-LLM seam — Robovoice included — gets this without any change.
 *
 *   utterance ─▶ typed into the session (terminal) / its inbox (coder run)
 *             ─▶ output tapped, cleaned (voice-cli-output.ts), streamed into
 *                the SpeechShaper sentence by sentence
 *             ─▶ the turn ends when the session goes quiet after replying,
 *                or when it asks for permission (the question is read out).
 *
 *   - permission prompts: "yes / approve / deny / no" on the next turn answer
 *     the open prompt with the keys the CLI expects (numbered menu or y/n);
 *   - barge-in (the provider drops the turn while the session is still
 *     producing) → the session is interrupted (Esc / Ctrl-C; inbox stop for
 *     coder runs); "stop / cancel" spoken does the same at any time;
 *   - long work: no reply within the speak budget → "still working" is said,
 *     the turn returns, and the session keeps being watched in the
 *     background: tool milestones and the final reply go through the call's
 *     progress hub (voice-progress.ts), which the provider's update poll
 *     speaks;
 *   - the session died / vanished → spoken notice, the route falls back to
 *     the API LLM and THIS utterance is answered by it.
 */

import {
  capitalize,
  cliDisplayName,
  CliOutputCleaner,
  classifyVoiceCommand,
  detectApprovalPrompt,
  interruptKeysFor,
  screenReplyText,
  stripAnsi,
  type ApprovalPrompt,
} from "./voice-cli-output.js";
import { fallBackToApi, writeVoiceCliRoute, type VoiceCliTarget } from "./voice-cli-route.js";
import {
  openCliSessionPort,
  type CliSessionPort,
  type VoiceCliHost,
} from "./voice-cli-sessions.js";
import {
  makeTurnTracker,
  voiceCallSessionKey,
  type VoiceLlmTurnRequest,
  type VoiceLlmTurnResult,
} from "./voice-llm-turn.js";
import { voiceProgress, type VoiceProgressHub } from "./voice-progress.js";
import { SpeechShaper } from "./voice-speech.js";

/** Quiet time after reply text before the turn counts as answered. */
export const CLI_SETTLE_MS = 1_500;
/** No reply text by then → "still working", the rest goes to the background. */
export const CLI_SPEAK_BUDGET_MS = 14_000;
/** A CLI that keeps a transcript gets this long to create / name it before the screen is read instead. */
export const TRANSCRIPT_FIND_MS = 6_000;
/** How long a background watch follows the session after the turn returned. */
export const CLI_BACKGROUND_MS = 15 * 60_000;
const ALIVE_CHECK_MS = 1_000;

export type CliSessionTurnDeps = {
  host?: VoiceCliHost;
  /** Tests: the port to use instead of opening one through the host. */
  port?: CliSessionPort | null;
  /** The API LLM path (fallback when the session is gone). */
  apiTurn: (req: VoiceLlmTurnRequest) => Promise<VoiceLlmTurnResult>;
  progress?: VoiceProgressHub;
  settleMs?: number;
  speakBudgetMs?: number;
  backgroundMs?: number;
  /** Route store writes (tests stub these). */
  fallBack?: (reason: string) => unknown;
  setApiRoute?: () => unknown;
  /** Live turn events for the Voice page (default: gateway broadcast "voice.cli.turn"). */
  emit?: (evt: VoiceCliTurnEvent) => void;
};

export type VoiceCliTurnEvent = {
  phase:
    | "ack"
    | "sent"
    | "output"
    | "reply"
    | "approval"
    | "interrupted"
    | "background"
    | "done"
    | "fallback";
  target: string;
  callKey: string;
  text?: string;
  at: number;
};

// ── per-session state shared across turns ──────────────────────────────────────

type SessionState = {
  approval?: ApprovalPrompt & { at: number };
  /** A background watch of earlier work; a new turn takes over from it. */
  stopBackground?: () => void;
  lastTurn?: {
    at: number;
    utterance: string;
    reply: string;
    firstSpokenMs: number | null;
    totalMs: number;
    path: string;
  };
};

const sessions = new Map<string, SessionState>();

export function targetKey(t: VoiceCliTarget): string {
  return t.kind === "coder" ? `coder:${t.runId}` : `terminal:${t.terminalId}`;
}

function stateOf(t: VoiceCliTarget): SessionState {
  const k = targetKey(t);
  let s = sessions.get(k);
  if (!s) {
    s = {};
    sessions.set(k, s);
  }
  return s;
}

/** For voice.cliRoute.get: open prompt + last turn of the routed session. */
export function voiceCliSessionState(t: VoiceCliTarget | undefined): {
  approval?: { question: string; at: number };
  lastTurn?: SessionState["lastTurn"];
} {
  if (!t) return {};
  const s = sessions.get(targetKey(t));
  if (!s) return {};
  return {
    ...(s.approval ? { approval: { question: s.approval.question, at: s.approval.at } } : {}),
    ...(s.lastTurn ? { lastTurn: s.lastTurn } : {}),
  };
}

export function resetVoiceCliTurnsForTests(): void {
  for (const s of sessions.values()) s.stopBackground?.();
  sessions.clear();
}

async function defaultEmit(evt: VoiceCliTurnEvent): Promise<void> {
  try {
    const { getGatewayBroadcaster } =
      await import("../../agents/coder-runtime/subagent-broadcast.js");
    getGatewayBroadcaster()?.("voice.cli.turn", evt);
  } catch {
    /* no broadcaster (tests / CLI): the turn itself is unaffected */
  }
}

// ── the turn ───────────────────────────────────────────────────────────────────

export async function runCliSessionVoiceTurn(
  req: VoiceLlmTurnRequest,
  target: VoiceCliTarget,
  deps: CliSessionTurnDeps,
): Promise<VoiceLlmTurnResult> {
  const start = Date.now();
  const tracker = makeTurnTracker(start, req.onDelta);
  const shaper = new SpeechShaper({ emit: (t) => tracker.push(t) });
  const sessionKey = voiceCallSessionKey(req);
  const progress = deps.progress ?? voiceProgress;
  const settleMs = deps.settleMs ?? CLI_SETTLE_MS;
  const speakBudgetMs = deps.speakBudgetMs ?? CLI_SPEAK_BUDGET_MS;
  const tKey = targetKey(target);
  const emit = (phase: VoiceCliTurnEvent["phase"], text?: string) => {
    const evt: VoiceCliTurnEvent = {
      phase,
      target: tKey,
      callKey: req.callKey,
      ...(text ? { text } : {}),
      at: Date.now(),
    };
    if (deps.emit) deps.emit(evt);
    else void defaultEmit(evt);
  };
  const state = stateOf(target);
  progress.callSeen(sessionKey, { spoke: true });

  const result = (
    text: string,
    routeReason: string,
    extra: Partial<VoiceLlmTurnResult> = {},
  ): VoiceLlmTurnResult => {
    shaper.end();
    const firstSentenceMs = tracker.firstSentenceMs;
    state.lastTurn = {
      at: start,
      utterance: req.message,
      reply: text,
      firstSpokenMs: tracker.firstTokenMs,
      totalMs: Date.now() - start,
      path: routeReason,
    };
    return {
      text: text || shaper.spokenText.trim(),
      backend: req.backend,
      sessionKey,
      trust: "owner",
      firstTokenMs: tracker.firstTokenMs,
      totalMs: Date.now() - start,
      timings: {
        path: "cli",
        model: `cli:${target.cliType ?? "session"}`,
        prepMs: 0,
        firstTokenMs: tracker.firstTokenMs,
        firstSentenceMs,
        totalMs: Date.now() - start,
        routeReason: `cli session ${target.label}: ${routeReason}`,
      },
      ...extra,
    };
  };

  const name =
    target.kind === "coder"
      ? `${cliDisplayName(target.cliType)} coder`
      : cliDisplayName(target.cliType);
  const Name = capitalize(name);

  // The session is gone: say so, switch the route back, answer with the API LLM.
  const fallBack = async (
    why: string,
    notice = `Your ${target.label} session isn't running any more, so I'm switching back to the regular assistant.`,
    priorText = "",
  ): Promise<VoiceLlmTurnResult> => {
    (deps.fallBack ?? fallBackToApi)(`${target.label}: ${why}`);
    state.stopBackground?.();
    sessions.delete(tKey);
    emit("fallback", why);
    req.onDelta(`${notice} `);
    const api = await deps.apiTurn({ ...req, onDelta: req.onDelta });
    return {
      ...api,
      text: [priorText, notice, api.text].filter(Boolean).join("\n").trim(),
      firstTokenMs: 0,
      timings: {
        ...(api.timings ?? {
          path: "agent",
          prepMs: 0,
          firstTokenMs: null,
          firstSentenceMs: null,
          totalMs: 0,
        }),
        routeReason: `cli fallback (${why}) → ${api.timings?.routeReason ?? "api"}`,
      },
    };
  };

  let port: CliSessionPort | null;
  try {
    port =
      deps.port !== undefined
        ? deps.port
        : deps.host
          ? await openCliSessionPort(deps.host, target, { interruptKeys: interruptKeysFor })
          : null;
  } catch {
    port = null;
  }
  if (!port || !(await port.isAlive().catch(() => false)))
    return fallBack(port ? "session ended" : "session not found");

  const command = classifyVoiceCommand(req.message, { promptOpen: !!state.approval });

  if (command === "fallback") {
    (deps.setApiRoute ?? (() => writeVoiceCliRoute({ mode: "api", target })))();
    state.stopBackground?.();
    shaper.say("Okay, I'm back on the regular assistant.");
    emit("fallback", "asked by voice");
    return result("Okay, I'm back on the regular assistant.", "switched to the API LLM by voice");
  }
  if (command === "interrupt") {
    state.stopBackground?.();
    state.approval = undefined;
    const how = await port.interrupt().catch(() => "none" as const);
    const said =
      how === "inbox"
        ? `I've asked the ${name} to stop.`
        : how === "keys"
          ? "Stopped."
          : "I couldn't stop it from here.";
    shaper.say(said);
    emit("interrupted", "by voice");
    return result(said, `interrupt (${how})`);
  }

  // A new turn takes the session over from any background watch.
  state.stopBackground?.();
  state.stopBackground = undefined;

  let input = req.message;
  if (command === "approve" || command === "deny") {
    const prompt = state.approval!;
    state.approval = undefined;
    await port.keys(command === "approve" ? prompt.approveKeys : prompt.denyKeys);
    const ack = command === "approve" ? "Approved." : "Denied.";
    shaper.say(ack);
    emit("ack", ack);
    input = "";
  }
  // Direct conversation: the caller is talking TO the CLI, so nothing relays
  // ("Sending that to Claude Code.") — the first words they hear are its reply.

  const cleaner = new CliOutputCleaner({ cliType: port.cliType, input });
  // Reply source, best first (the old Voice Terminal's order):
  //   transcript  the CLI's own JSONL (Claude Code / Codex): exact text + end of turn;
  //   screen      the rendered tmux screen, read once the session goes quiet;
  //   stream      the raw PTY bytes, cleaned (coder runs without a pane).
  // A full-screen TUI's raw bytes are cursor moves and spinner frames, so the
  // stream is only spoken live when neither of the others exists.
  const transcript = port.transcript?.() ?? null;
  const transcriptStartedAt = Date.now();
  const tReply: string[] = [];
  const tActivities: string[] = [];
  let tEnded = false;
  /** The transcript is (still) the reply source: found, or not given up on yet. */
  const useTranscript = () =>
    !!transcript && (!!transcript.file() || Date.now() - transcriptStartedAt < TRANSCRIPT_FIND_MS);
  const useScreen = () => !useTranscript() && !!port.screen;
  const streamSpeech = () => !useTranscript() && !useScreen();
  const pollTranscript = (speak: boolean) => {
    if (!transcript) return;
    for (const e of transcript.poll()) {
      if (e.kind === "text") {
        tReply.push(e.text);
        lastReplyChangeAt = Date.now();
        if (speak) shaper.push(`${e.text}\n`);
      } else if (e.kind === "tool") {
        const act = `using ${e.name}`;
        if (tActivities[tActivities.length - 1] !== act) tActivities.push(act);
      } else {
        if (e.text && !tReply.length) {
          tReply.push(e.text);
          if (speak) shaper.push(`${e.text}\n`);
        }
        tEnded = true;
      }
    }
  };
  /** The reply as read off the rendered screen (null: no screen). */
  const screenReply = async (): Promise<string | null> => {
    if (!port.screen) return null;
    const scr = await port.screen().catch(() => "");
    // An approval answer types nothing: the reply follows the previous utterance.
    return scr
      ? screenReplyText(scr, input || state.lastTurn?.utterance || "", port.cliType)
      : null;
  };
  let lastOutputAt = Date.now();
  let lastReplyChangeAt = 0;
  let lastReplyKey = "";
  let spokenLines = 0;
  let resolveDone: (why: string) => void = () => {};
  const done = new Promise<string>((r) => (resolveDone = r));
  let finished = false;
  const finish = (why: string) => {
    if (finished) return;
    finished = true;
    resolveDone(why);
  };

  /** Lines of the reply, minus an open permission prompt (read out as a question instead). */
  const replyLines = () => {
    const prompt = detectApprovalPrompt(cleaner.plain().slice(-4000), Name);
    if (!prompt) return cleaner.lines();
    const raw = prompt.raw.replace(/\s+/g, " ").trim();
    return cleaner
      .lines()
      .filter((l) => !l.includes(raw) && !raw.includes(l) && !/^(?:[❯›>]\s*)?\d[.)]\s/.test(l));
  };
  /** Speak reply lines that are complete (all but the newest, which may still grow). */
  const speakNew = (all: boolean) => {
    const lines = replyLines();
    const upto = all ? lines.length : Math.max(0, lines.length - 1);
    for (; spokenLines < upto; spokenLines++) shaper.push(`${lines[spokenLines]}\n`);
  };

  const unsubscribe = port.subscribe((chunk) => {
    cleaner.push(chunk);
    lastOutputAt = Date.now();
    const key = cleaner.text();
    if (key !== lastReplyKey) {
      lastReplyKey = key;
      lastReplyChangeAt = Date.now();
    }
    if (!finished && streamSpeech()) speakNew(false);
    emit("output", stripAnsi(chunk).slice(-2000));
  });

  try {
    if (input) await port.send(input);
    emit("sent", input || "approval answer");
  } catch (err) {
    unsubscribe();
    const msg = err instanceof Error ? err.message : String(err);
    if (!(await port.isAlive().catch(() => false))) return fallBack(msg);
    shaper.say(`I couldn't reach the ${name}: ${msg}.`);
    return result(`I couldn't reach the ${name}: ${msg}.`, "send failed");
  }

  // Barge-in: the caller spoke over a session that is still producing → interrupt it.
  const onAbort = () => {
    if (finished) return;
    void port!.interrupt().catch(() => {});
    emit("interrupted", "barge-in");
    finish("barge-in");
  };
  if (req.signal?.aborted) onAbort();
  req.signal?.addEventListener("abort", onAbort, { once: true });

  const sentAt = Date.now();
  const tick = setInterval(() => {
    const now = Date.now();
    const quietFor = now - Math.max(lastOutputAt, sentAt);
    if (useTranscript()) {
      pollTranscript(true);
      if (tEnded) return finish("settled");
      // Waiting on the owner (permission menu on screen) — the transcript can't say that.
      if (quietFor >= settleMs && detectApprovalPrompt(cleaner.plain().slice(-4000), Name))
        return finish("approval");
      if (!tReply.length && now - sentAt >= speakBudgetMs) return finish("budget");
      return;
    }
    // Screen / stream: the turn is answered once the session has gone quiet.
    const reply = useScreen() ? (cleaner.rawLength ? "output" : "") : cleaner.text();
    if (quietFor >= settleMs) {
      const prompt = detectApprovalPrompt(cleaner.plain().slice(-4000), Name);
      if (prompt) return finish("approval");
      if (reply && now - lastReplyChangeAt >= settleMs) return finish("settled");
    }
    if (!reply && now - sentAt >= speakBudgetMs) return finish("budget");
  }, 150);
  tick.unref?.();
  const alive = setInterval(() => {
    void port!.isAlive().then((ok) => {
      if (!ok) finish("died");
    });
  }, ALIVE_CHECK_MS);
  alive.unref?.();

  const why = await done;
  clearInterval(tick);
  clearInterval(alive);
  req.signal?.removeEventListener("abort", onAbort);

  if (why === "died") {
    unsubscribe();
    const notice = `The ${name} session just closed, so I'm switching back to the regular assistant.`;
    return fallBack("session ended mid-turn", notice, cleaner.text());
  }
  if (why === "barge-in") {
    unsubscribe();
    return result(cleaner.text(), "barge-in interrupt");
  }
  if (why === "approval") {
    unsubscribe();
    if (streamSpeech()) speakNew(true);
    const prompt = detectApprovalPrompt(cleaner.plain().slice(-4000), Name)!;
    state.approval = { ...prompt, at: Date.now() };
    shaper.boundary();
    shaper.say(prompt.question);
    emit("approval", prompt.question);
    return result([...replyLines(), prompt.question].join("\n").trim(), "permission prompt");
  }
  if (why === "settled") {
    unsubscribe();
    let reply: string;
    let source: string;
    if (useTranscript()) {
      pollTranscript(true);
      reply = tReply.join("\n");
      source = "transcript";
    } else if (useScreen()) {
      reply = (await screenReply()) || cleaner.text();
      if (reply) shaper.push(`${reply}\n`);
      source = "screen";
    } else {
      speakNew(true);
      reply = cleaner.text();
      source = "stream";
    }
    emit("reply", reply);
    emit("done");
    return result(reply, `reply (${source})`);
  }

  // Speak budget: keep following the session in the background.
  const still = "Still working on it. I'll tell you when it's done.";
  shaper.boundary();
  shaper.say(still);
  emit("background", still);
  const task = progress.startTask(sessionKey, `${target.label}: ${req.message.slice(0, 60)}`, {
    abort: () => void port!.interrupt().catch(() => {}),
  });
  let bgSpokenActivities = 0;
  let bgStopped = false;
  const stopBg = () => {
    if (bgStopped) return;
    bgStopped = true;
    clearInterval(bgTick);
    clearTimeout(bgLimit);
    unsubscribe();
  };
  let bgReading = false;
  const bgTick = setInterval(() => {
    const now = Date.now();
    if (useTranscript()) {
      pollTranscript(false);
      if (tActivities.length > bgSpokenActivities) {
        bgSpokenActivities = tActivities.length;
        progress.progress(task.id, `${capitalize(tActivities[tActivities.length - 1])}.`);
      }
      if (tEnded) {
        const reply = tReply.join("\n");
        progress.finish(task.id, { text: reply.trim() || "Done.", chatText: reply });
        emit("reply", reply);
        stopBg();
        return;
      }
      if (now - lastOutputAt < settleMs) return;
      const prompt = detectApprovalPrompt(cleaner.plain().slice(-4000), Name);
      if (prompt) {
        state.approval = { ...prompt, at: now };
        progress.finish(task.id, { text: prompt.question });
        emit("approval", prompt.question);
        stopBg();
      }
      return;
    }
    const acts = cleaner.activities();
    if (acts.length > bgSpokenActivities) {
      bgSpokenActivities = acts.length;
      progress.progress(task.id, `${capitalize(acts[acts.length - 1])}.`);
    }
    if (now - lastOutputAt < settleMs) return;
    const prompt = detectApprovalPrompt(cleaner.plain().slice(-4000), Name);
    if (prompt) {
      state.approval = { ...prompt, at: now };
      progress.finish(task.id, { text: prompt.question });
      emit("approval", prompt.question);
      stopBg();
      return;
    }
    if (useScreen()) {
      if (bgReading || !cleaner.rawLength) return;
      bgReading = true;
      void screenReply().then((r) => {
        bgReading = false;
        if (bgStopped) return;
        const reply = r || cleaner.text();
        progress.finish(task.id, { text: reply.trim() || "Done.", chatText: reply });
        emit("reply", reply);
        stopBg();
      });
      return;
    }
    const reply = cleaner.text();
    if (reply && now - lastReplyChangeAt >= settleMs) {
      progress.finish(task.id, { text: `${Name} is done. ${reply}`, chatText: reply });
      emit("reply", reply);
      stopBg();
    }
  }, 500);
  bgTick.unref?.();
  const bgLimit = setTimeout(() => {
    progress.finish(task.id, { text: "", cancelled: true });
    stopBg();
  }, deps.backgroundMs ?? CLI_BACKGROUND_MS);
  bgLimit.unref?.();
  state.stopBackground = () => {
    progress.finish(task.id, { text: "", cancelled: true });
    stopBg();
  };
  return result(still, "still working (background)", { running: 1 });
}
