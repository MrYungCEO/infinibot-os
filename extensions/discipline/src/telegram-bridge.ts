/**
 * Server-side Discipline Telegram Bridge
 *
 * Polls block transitions every 60 s and sends Telegram messages using
 * the host's sendMessageTelegram() (api.runtime.channel.telegram — no new
 * credentials needed; reads loadConfig() / TELEGRAM_BOT_TOKEN).
 *
 * Chat ID is read from discipline settings (telegramChatId field) which
 * is now persisted server-side after the settings table extension.
 *
 * Idempotent: started by the plugin's service, stopped when it stops (or the
 * plugin is turned off). Gateway restart resets the in-memory
 * firedKeys set — safe because fired keys are per-day and duplicate
 * telegram sends for the same block start/end are harmless.
 */

import { getDisciplineStore } from "./store.js";

export type SendTelegram = (to: string, text: string) => Promise<unknown>;

export type TelegramBridgeDeps = {
  stateDir: () => string;
  sendMessageTelegram: SendTelegram;
  log: { info: (m: string) => void; warn: (m: string) => void };
  /**
   * https web opener for the Discipline screen (host linkPair; null without a
   * public base) — appended as an "Open in InfiniBot" link.
   */
  openUrl?: () => string | null;
};

/** Deep link every Discipline Telegram message opens (docs/mobile/DEEP-LINKS.md). */
export const DISCIPLINE_DEEP_LINK = "infinibot://discipline";

let log: TelegramBridgeDeps["log"] = { info: () => {}, warn: () => {} };
let send: SendTelegram | null = null;
let openUrl: (() => string | null) | null = null;

/** Markdown "Open" line for the bridge's messages ("" without a web URL). */
export function withOpenLink(text: string, url: string | null | undefined): string {
  if (!url) return text;
  return `${text}\n[Open in InfiniBot](${url.replace(/\(/g, "%28").replace(/\)/g, "%29")})`;
}

interface BridgeState {
  lastBlockId: string | null;
  lastDate: string;
  firedKeys: Set<string>;
  lastSentAt: number;
  lastSendOk: boolean;
}

let stopTimer: (() => void) | null = null;
let bridgeState: BridgeState = {
  lastBlockId: null,
  lastDate: todayIso(),
  firedKeys: new Set(),
  lastSentAt: 0,
  lastSendOk: true,
};

export function startTelegramBridge(deps: TelegramBridgeDeps): () => void {
  if (stopTimer) return stopTimer;
  log = deps.log;
  send = deps.sendMessageTelegram;
  openUrl = deps.openUrl ?? null;

  const interval = setInterval(() => {
    void tick(deps.stateDir(), bridgeState).catch((e) =>
      log.warn(`discipline telegram bridge tick error: ${String(e)}`),
    );
  }, 60_000);
  interval.unref?.();

  stopTimer = () => {
    clearInterval(interval);
    stopTimer = null;
  };

  log.info("discipline telegram bridge started");
  return stopTimer;
}

export function stopTelegramBridge(): void {
  stopTimer?.();
}

/** Exposed for UI status queries: returns last send result. */
export function getTelegramBridgeStatus(): { lastSentAt: number; lastSendOk: boolean } {
  return { lastSentAt: bridgeState.lastSentAt, lastSendOk: bridgeState.lastSendOk };
}

async function tick(stateDir: string, state: BridgeState): Promise<void> {
  let store: ReturnType<typeof getDisciplineStore>;
  try {
    store = getDisciplineStore(stateDir);
  } catch {
    return; // Store not yet initialized — skip tick
  }

  const settings = store.getSettings();
  if (!settings.telegramEnabled || !settings.telegramChatId?.trim()) return;

  const today = todayIso();
  if (state.lastDate !== today) {
    state.firedKeys.clear();
    state.lastDate = today;
    state.lastBlockId = null;
  }

  const nowMin = nowMinutes();
  const dow = new Date().getDay();
  const blocks = store.getBlocks().filter((b) => {
    if (!b.enabled) return false;
    if (b.oneOffDate) return b.oneOffDate === today;
    return (b.days ?? []).includes(dow);
  });

  const active = blocks.find((b) => nowMin >= b.startMinute && nowMin < b.endMinute);
  const activeId = active?.id ?? null;

  // Block transitions
  if (activeId !== state.lastBlockId) {
    if (state.lastBlockId && state.lastBlockId !== activeId) {
      const ended = blocks.find((b) => b.id === state.lastBlockId);
      if (ended && settings.telegramEvents?.blockEnd) {
        await maybeSend(
          state,
          settings.telegramChatId,
          `end:${ended.id}:${today}`,
          formatMsg(ended, "end"),
        );
      }
    }
    if (active && settings.telegramEvents?.blockStart) {
      await maybeSend(
        state,
        settings.telegramChatId,
        `start:${active.id}:${today}`,
        formatMsg(active, "start"),
      );
    }
    state.lastBlockId = activeId;
  }

  // 5-minute warnings
  for (const b of blocks) {
    const minsToStart = b.startMinute - nowMin;
    if (minsToStart > 0 && minsToStart <= 5 && settings.telegramEvents?.blockStart) {
      await maybeSend(
        state,
        settings.telegramChatId,
        `warn5:${b.id}:${today}`,
        `⏰ **${b.label}** starts in ${minsToStart} min`,
      );
    }
  }

  // Quiet hours check (skip if outside allowed window)
  if (isQuietHours(settings.quietHoursStart, settings.quietHoursEnd)) return;
}

async function maybeSend(
  state: BridgeState,
  chatId: string,
  key: string,
  text: string,
): Promise<void> {
  if (state.firedKeys.has(key)) return;
  state.firedKeys.add(key);
  try {
    if (!send) throw new Error("telegram sender not wired");
    let url: string | null = null;
    try {
      url = openUrl?.() ?? null;
    } catch {
      url = null;
    }
    await send(chatId.trim(), withOpenLink(text, url));
    state.lastSentAt = Date.now();
    state.lastSendOk = true;
    log.info(`discipline telegram sent ${key}`);
  } catch (e) {
    state.lastSendOk = false;
    log.warn(`discipline telegram send ${key} failed: ${String(e)}`);
    // Remove from firedKeys so a retry can happen on next tick
    state.firedKeys.delete(key);
  }
}

function formatMsg(
  block: { label: string; startMinute: number; endMinute: number; intent?: string },
  kind: "start" | "end",
): string {
  const fmt = (m: number) =>
    `${Math.floor(m / 60)
      .toString()
      .padStart(2, "0")}:${(m % 60).toString().padStart(2, "0")}`;
  const window = `${fmt(block.startMinute)}–${fmt(block.endMinute)}`;
  if (kind === "start") {
    const parts = [`🔔 **${block.label}** is up`, `⏱ ${window}`];
    if (block.intent) parts.push(`💭 ${block.intent}`);
    return parts.join("\n");
  }
  return `✅ **${block.label}** window closed\n⏱ ${window}`;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function nowMinutes(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function isQuietHours(start: number, end: number): boolean {
  if (start === end) return false;
  const h = new Date().getHours() + new Date().getMinutes() / 60;
  return start < end ? h >= start && h < end : h >= start || h < end;
}
