/**
 * Discipline notification + AI-assist helpers.
 *
 * Kept separate from controllers/discipline.ts because the core controller is
 * already large and these helpers have a different shape: they're side-effect
 * fan-outs (telegram, browser notifications, AI prompts) layered on top of the
 * pure state machine. Wired into the discipline view via state hooks the
 * dispatcher reads on every ticker tick.
 */

import type { GatewayBrowserClient } from "../gateway";
import type {
  DisciplineBlock,
  DisciplineCategory,
  DisciplineState,
  TelegramEventToggles,
} from "./discipline";
import { type DisciplineAlertKind, type DisciplineAlertPayload, fireDisciplineAlert } from "../components/discipline-alert";
import {
  blockLinkContext,
  blockPriority,
  currentBlock,
  isQuietHoursNow,
  streakDays,
} from "./discipline";

const CATEGORY_ICONS: Record<DisciplineCategory, string> = {
  "deep-work": "🎯",
  meetings: "📅",
  ops: "⚙️",
  body: "💪",
  admin: "📋",
  break: "☕",
  personal: "🌿",
};

function fmtHHMM(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

/** Build a human-readable telegram message for a block transition. */
export function formatBlockMessage(
  state: DisciplineState,
  block: DisciplineBlock,
  kind: "start" | "end" | "complete" | "abort",
  extra?: { reason?: string; savedMin?: number },
): string {
  const ctx = blockLinkContext(state, block);
  const icon = CATEGORY_ICONS[block.category] ?? "•";
  const label = block.label;
  const window = `${fmtHHMM(block.startMinute)}–${fmtHHMM(block.endMinute)}`;
  const priorityTag =
    ctx.priority === "critical" ? "🔥 CRITICAL"
    : ctx.priority === "high" ? "⚡ HIGH"
    : ctx.priority === "low" ? "▫ low"
    : "";
  const parts: string[] = [];
  switch (kind) {
    case "start":
      parts.push(`${icon} **${label}** is up`);
      parts.push(`⏱ ${window}`);
      if (block.intent) parts.push(`💭 ${block.intent}`);
      break;
    case "end":
      parts.push(`✅ **${label}** window closed`);
      parts.push(`⏱ ${window}`);
      break;
    case "complete":
      parts.push(`✓ Completed: **${label}**`);
      if (extra?.savedMin && extra.savedMin > 0) {
        parts.push(`+${extra.savedMin}m banked early`);
      }
      break;
    case "abort":
      parts.push(`⛔ Aborted: **${label}**`);
      if (extra?.reason) parts.push(`Reason: ${extra.reason}`);
      break;
  }
  if (ctx.taskTitle) parts.push(`🔗 ${ctx.taskTitle}${ctx.projectName ? ` · ${ctx.projectName}` : ""}`);
  else if (ctx.projectName) parts.push(`🔗 ${ctx.projectName}`);
  if (priorityTag) parts.push(priorityTag);
  return parts.join("\n");
}

/** Should we send to telegram for this event class? Honors the per-event toggle and quiet hours. */
export function shouldSendTelegram(
  state: DisciplineState,
  event: keyof TelegramEventToggles,
  opts?: { ignoreQuietHours?: boolean },
): boolean {
  const s = state.settings;
  if (!s.telegramEnabled) return false;
  if (!s.telegramEvents[event]) return false;
  if (!opts?.ignoreQuietHours && isQuietHoursNow(s)) return false;
  return true;
}

/** Fire a telegram message via the gateway's `send` RPC.
 *
 *  Gateway expects: `{ channel, to, message, idempotencyKey }`. Earlier
 *  versions of this caller used `message.send` (no such method) and `chatId`
 *  (gateway field is `to`), which produced the "unknown method: message.send"
 *  error in the discipline settings test panel.
 */
export async function sendTelegram(
  client: GatewayBrowserClient,
  state: DisciplineState,
  message: string,
): Promise<{ ok: boolean; error?: string }> {
  const chatId = (state.settings.telegramChatId ?? "").trim();
  if (!chatId) {
    return {
      ok: false,
      error: "No telegram chat id set — fill in the override field above first",
    };
  }
  try {
    await client.request("send", {
      channel: "telegram",
      to: chatId,
      message,
      // Idempotency key is required by the gateway. Including the message
      // hash keeps repeat-test clicks deduplicated within the gateway's
      // dedupe window without blocking distinct messages.
      idempotencyKey: `discipline:${Date.now()}:${hashString(message)}`,
    });
    return { ok: true };
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    console.warn("[discipline] telegram send failed:", msg);
    return { ok: false, error: msg };
  }
}

function hashString(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

/** Send the same payload to the in-app browser notifications layer (independent of telegram). */
export function showBrowserNotification(title: string, body: string, tag: string): void {
  try {
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    new Notification(title, { body, tag, icon: "/infinibot-logo.png" });
  } catch {
    /* ignore */
  }
}

/** Run a one-shot AI advice request through chat.send to the discipline session. */
export async function requestAiAdvice(
  client: GatewayBrowserClient,
  state: DisciplineState,
  kind: "plan" | "review" | "advice",
  userPrompt?: string,
): Promise<{ ok: boolean; text?: string; error?: string }> {
  if (!state.settings.ai.enabled) {
    return { ok: false, error: "AI assistant is disabled in settings." };
  }
  const sessionKey = state.settings.ai.sessionKey || "agent:main:discipline";
  const ctx = buildDisciplineContextSnapshot(state);
  const promptHeader =
    kind === "plan"
      ? "Suggest tomorrow's discipline blocks given my current schedule, top kanban priorities, and where I drifted today. Recommend 3–6 blocks with categories and times. Keep it tight."
      : kind === "review"
      ? "Give me a daily discipline review: what I shipped vs planned, where I slipped, and one specific tweak for tomorrow. Be honest."
      : "Give me a one-paragraph advice nudge for the rest of today based on the context.";
  const fullPrompt = [
    promptHeader,
    userPrompt ? `\nUser note: ${userPrompt}` : "",
    "\n--- Discipline context ---\n",
    ctx,
  ].join("");
  try {
    const res = (await client.request("chat.send", {
      sessionKey,
      message: fullPrompt,
      deliver: false,
    })) as { reply?: string; text?: string; content?: string };
    const text = res?.reply ?? res?.text ?? res?.content ?? "";
    if (!text) {
      return { ok: false, error: "AI returned an empty response." };
    }
    return { ok: true, text };
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    console.warn("[discipline] AI request failed:", msg);
    return { ok: false, error: msg };
  }
}

/** Compact, structured snapshot of today's discipline state for the AI prompt. */
function buildDisciplineContextSnapshot(state: DisciplineState): string {
  const today = state.today;
  const week = state.week;
  const streak = streakDays(week);
  const cur = currentBlock(state);
  const lines: string[] = [];
  lines.push(`Date: ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`Compliance today: ${today?.compliance ?? 0}%`);
  lines.push(`Logged today: ${today?.actualMinutes ?? 0}m of ${today?.plannedMinutes ?? 0}m planned`);
  lines.push(`Slips today: ${today?.slippageCount ?? 0}`);
  lines.push(`Day streak (≥80%): ${streak}`);
  if (today?.nonNegotiableTotal) {
    lines.push(`Non-negotiables: ${today.nonNegotiableTotal - today.nonNegotiableMissed}/${today.nonNegotiableTotal}`);
  }
  lines.push(`Current block: ${cur ? `${cur.label} (${cur.category})` : "none — open window"}`);

  const todayBlocks = state.blocks.filter((b) => b.enabled && (b.days ?? []).includes(new Date().getDay())).slice(0, 12);
  if (todayBlocks.length > 0) {
    lines.push("\nToday's blocks:");
    for (const b of todayBlocks) {
      const ctx = blockLinkContext(state, b);
      const tag = ctx.priority !== "normal" ? ` [${ctx.priority}]` : "";
      const link = ctx.taskTitle ? ` ↪ ${ctx.taskTitle}` : "";
      lines.push(`  ${fmtHHMM(b.startMinute)}-${fmtHHMM(b.endMinute)} ${b.label} (${b.category})${tag}${link}`);
    }
  }

  const topTasks = state.kanbanTasks
    .filter((t) => (t.status ?? "").toLowerCase() !== "done")
    .slice(0, 8);
  if (topTasks.length > 0) {
    lines.push("\nOpen kanban tasks (sample):");
    for (const t of topTasks) {
      const proj = state.kanbanProjects.find((p) => p.id === t.projectId);
      const pr = (t as any).priority ? ` [${(t as any).priority}]` : "";
      lines.push(`  • ${t.title}${pr}${proj ? ` — ${proj.name}` : ""}`);
    }
  }

  return lines.join("\n");
}

/**
 * Auto-notify dispatcher — call from the discipline ticker on every tick.
 * Detects current-block transitions (start/end) and fires the configured
 * notifications, using firedNotifications as a per-day idempotency set so a
 * 20-second tick doesn't spam the same event.
 */
export function tickAutoNotifications(
  state: DisciplineState,
  client: GatewayBrowserClient,
): void {
  const today = new Date().toISOString().slice(0, 10);
  // Day rollover — clear the fired-set so today's events can fire again tomorrow.
  if (state.dailyStateDate !== today) {
    state.firedNotifications = {};
  }
  const cur = currentBlock(state);
  const curId = cur?.id ?? null;
  const prevId = state.lastObservedBlockId;

  if (curId !== prevId) {
    // Block end (we left a block we were inside).
    if (prevId && prevId !== curId) {
      const ended = state.blocks.find((b) => b.id === prevId);
      if (ended) {
        fireBlockEvent(state, client, ended, "blockEnd", "end");
        // Post-block "log what you did" nudge. Fires when leaving a block the
        // user neither completed nor logged anything for — the most common
        // way discipline data goes stale. Tap-to-log is the operator's job;
        // we just remind them while the block is fresh in memory. Suppressed
        // if the block was explicitly completed or aborted (those already
        // have their own row in state.blockDone / abort log).
        const completedToday = !!state.blockDone[ended.id];
        const blockLogsToday = state.logs.filter(
          (l) => l.blockId === ended.id &&
                 new Date(l.startMs).toISOString().slice(0, 10) === today,
        );
        const hadAbort = blockLogsToday.some((l) => l.source === "abort");
        const nudgeKey = `postblock:${ended.id}:${today}`;
        if (!completedToday && !hadAbort && blockLogsToday.length === 0
            && !state.firedNotifications[nudgeKey]) {
          state.firedNotifications[nudgeKey] = true;
          fireDisciplineAlert({
            kind: "block-end",
            label: `Log "${ended.label}"?`,
            message: "That block just ended without an entry. Press L to log what you actually did.",
            durationMs: 14_000,
          });
          if (state.settings.militant) {
            showBrowserNotification(
              `📝 Log "${ended.label}"?`,
              "Block ended with no entry — tap to log what you did.",
              nudgeKey,
            );
          }
        }
      }
    }
    // Block start (we entered a new block).
    if (curId && curId !== prevId && cur) {
      fireBlockEvent(state, client, cur, "blockStart", "start");
    }
    state.lastObservedBlockId = curId;
  }

  // Backfill "start your day" nudge. If the user's configured dayStartHour
  // has passed and the gateway hasn't auto-detected a day-start yet, the user
  // probably either forgot to log in or skipped morning routine — either way
  // a single proactive prompt is more useful than silently dropping today's
  // compliance score. Fired once per day, gated 15 min past dayStartHour so
  // we don't ping people who just logged in 30 seconds before their start.
  // Declared before first use: the backfill check below read it inside its
  // temporal dead zone and threw on every tick while the day wasn't started.
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const dayStartHour = state.settings.dayStartHour ?? 6;
  const backfillKey = `backfill-start:${today}`;
  if (
    state.dayStart == null &&
    nowMin >= dayStartHour * 60 + 15 &&
    !state.firedNotifications[backfillKey]
  ) {
    state.firedNotifications[backfillKey] = true;
    fireDisciplineAlert({
      kind: "block-warning-5",
      label: "Start your day?",
      message: `It's past ${pad2(dayStartHour)}:00 and your day hasn't started. Tap "Start from now" to shift today's blocks, or press L to log what you've already done.`,
      durationMs: 18_000,
    });
    if (state.settings.militant) {
      showBrowserNotification(
        "Start your discipline day",
        `It's past ${pad2(dayStartHour)}:00 — pick up where you are now.`,
        backfillKey,
      );
    }
    if (shouldSendTelegram(state, "blockStart")) {
      void sendTelegram(
        client,
        state,
        `🌅 Day hasn't started yet — past ${pad2(dayStartHour)}:00. Shift from now or log what you already did.`,
      );
    }
  }

  // 5-minute warnings for upcoming blocks.
  const dow = new Date().getDay();
  const todayBlocks = state.blocks.filter((b) => {
    if (!b.enabled) return false;
    if (b.oneOffDate) return b.oneOffDate === today;
    return (b.days ?? []).includes(dow);
  });
  for (const b of todayBlocks) {
    const minsToStart = b.startMinute - nowMin;
    if (minsToStart > 0 && minsToStart <= 5) {
      const warnKey = `warn5:${b.id}:${today}`;
      if (!state.firedNotifications[warnKey]) {
        state.firedNotifications[warnKey] = true;
        const text = formatBlockMessage(state, b, "start");
        // Window alert
        fireDisciplineAlert({
          kind: "block-warning-5",
          label: `${b.label} in ${minsToStart}m`,
          message: text,
          durationMs: 12_000,
        });
        // Telegram if enabled
        if (shouldSendTelegram(state, "blockStart")) {
          void sendTelegram(client, state, `⏰ **${b.label}** starts in ${minsToStart} min`);
        }
        // Browser notification in militant mode
        if (state.settings.militant) {
          showBrowserNotification(`⏰ ${b.label}`, `Starts in ${minsToStart} min`, warnKey);
        }
      }
    }
  }

  // Missed-block detection: block is active but no log for it today.
  if (cur) {
    const missedKey = `missed:${cur.id}:${today}`;
    if (!state.firedNotifications[missedKey]) {
      const blockLogs = state.logs.filter(
        (l) => l.blockId === cur.id && new Date(l.startMs).toISOString().slice(0, 10) === today,
      );
      const nowMs = Date.now();
      const blockActiveMs = (nowMin - cur.startMinute) * 60_000;
      // Fire "missed" alert if block has been active >15 min with no log
      if (blockActiveMs > 15 * 60_000 && blockLogs.length === 0) {
        state.firedNotifications[missedKey] = true;
        fireDisciplineAlert({
          kind: "block-missed",
          label: `No activity: ${cur.label}`,
          message: `This block started ${Math.round(blockActiveMs / 60_000)}m ago with no logged activity.`,
          durationMs: 10_000,
        });
        if (shouldSendTelegram(state, "slip")) {
          void sendTelegram(client, state, formatBlockMessage(state, cur, "start", { reason: "no activity logged" }));
        }
      }
    }
  }
}

function fireBlockEvent(
  state: DisciplineState,
  client: GatewayBrowserClient,
  block: DisciplineBlock,
  toggle: keyof TelegramEventToggles,
  kind: "start" | "end" | "complete" | "abort",
  extra?: { reason?: string; savedMin?: number },
): void {
  const dedupeKey = `${toggle}:${block.id}:${todayShort()}`;
  if (state.firedNotifications[dedupeKey]) return;
  state.firedNotifications[dedupeKey] = true;

  const text = formatBlockMessage(state, block, kind, extra);

  // Clock-anchored alert (always fires — UI concern only).
  const alertKind: DisciplineAlertKind =
    kind === "start" ? "block-start"
    : kind === "end" ? "block-end"
    : kind === "complete" ? "block-end"
    : "block-missed";
  fireDisciplineAlert({
    kind: alertKind,
    label: block.label,
    message: text,
    durationMs: kind === "start" ? 10_000 : 6_000,
  });

  // Telegram fan-out (gated by user prefs + quiet hours).
  if (shouldSendTelegram(state, toggle)) {
    void sendTelegram(client, state, text);
  }
  // Browser notification — gated by militant mode (the existing "hard-lock"
  // toggle) so users who haven't opted in to high-intensity nudging don't get
  // surprise OS popups.
  if (state.settings.militant) {
    const priority = blockPriority(state, block);
    const priTag = priority === "critical" ? " 🔥" : priority === "high" ? " ⚡" : "";
    showBrowserNotification(`${block.label}${priTag}`, text, dedupeKey);
  }
}

function todayShort(): string {
  return new Date().toISOString().slice(0, 10);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Programmatic hook called from controllers/discipline.ts when a block is completed. */
export function notifyBlockCompleted(
  state: DisciplineState,
  client: GatewayBrowserClient,
  block: DisciplineBlock,
  savedMin: number,
): void {
  fireBlockEvent(state, client, block, "blockComplete", "complete", { savedMin });
}

/** Programmatic hook called when a block is aborted with a reason. */
export function notifyBlockAborted(
  state: DisciplineState,
  client: GatewayBrowserClient,
  block: DisciplineBlock,
  reason: string,
): void {
  fireBlockEvent(state, client, block, "abort", "abort", { reason });
}
