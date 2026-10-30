/**
 * One-time start codes for the guided Telegram setup.
 *
 * The wizard shows a link `https://t.me/<bot>?start=<code>`. Opening it and
 * pressing Start sends the bot `/start <code>`. Only a message carrying the code
 * of a waiting setup session is accepted as "this is the owner", so somebody
 * else who happens to message the bot during setup can't claim it.
 */
import { randomInt, timingSafeEqual } from "node:crypto";

/** No 0/O, 1/I/L: the code may be typed by hand on a phone. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const START_CODE_LENGTH = 8;

export function generateStartCode(length = START_CODE_LENGTH): string {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export type CaptureMode = "dm" | "group";

export interface CapturedChat {
  /** `from.id`; absent for channel posts. */
  userId: number | null;
  chatId: number;
  chatType: "private" | "group" | "supergroup" | "channel";
  chatTitle: string | null;
  username: string | null;
  firstName: string | null;
}

export type StartCodeMiss =
  | "not-a-message"
  | "from-bot"
  | "too-old"
  | "wrong-chat-type"
  | "no-code"
  | "wrong-sender";

export type StartCodeMatch =
  | { match: true; found: CapturedChat }
  | { match: false; reason: StartCodeMiss };

export interface StartCodeExpectation {
  code: string;
  mode: CaptureMode;
  /** Unix seconds; messages sent before the capture started are ignored. */
  notBefore?: number;
  /** Group mode: when the owner is already known, only they can add a group. */
  ownerUserId?: number | null;
}

type TgChat = { id?: number; type?: string; title?: string; username?: string };
type TgUser = { id?: number; is_bot?: boolean; username?: string; first_name?: string };
type TgMessage = { text?: string; caption?: string; date?: number; chat?: TgChat; from?: TgUser };

function sameCode(a: string, b: string): boolean {
  const x = Buffer.from(a.toUpperCase());
  const y = Buffer.from(b.toUpperCase());
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Does `text` carry `code`? `/start CODE`, `/start@bot CODE`, or the code as a word. */
export function textCarriesCode(text: string | undefined, code: string): boolean {
  if (!text || !code) return false;
  for (const word of text.trim().split(/\s+/).slice(0, 12)) {
    if (sameCode(word, code)) return true;
  }
  return false;
}

/** Check one Bot API update against a waiting capture. */
export function matchStartCode(update: unknown, expect: StartCodeExpectation): StartCodeMatch {
  const u = (update ?? {}) as { message?: TgMessage; channel_post?: TgMessage };
  const msg = u.message ?? u.channel_post;
  if (!msg || typeof msg !== "object" || typeof msg.chat?.id !== "number") {
    return { match: false, reason: "not-a-message" };
  }
  if (msg.from?.is_bot) return { match: false, reason: "from-bot" };
  if (
    typeof expect.notBefore === "number" &&
    typeof msg.date === "number" &&
    msg.date < expect.notBefore
  ) {
    return { match: false, reason: "too-old" };
  }
  const type = msg.chat.type;
  const isPrivate = type === "private";
  const isShared = type === "group" || type === "supergroup" || type === "channel";
  if (expect.mode === "dm" ? !isPrivate : !isShared) {
    return { match: false, reason: "wrong-chat-type" };
  }
  if (!textCarriesCode(msg.text ?? msg.caption, expect.code)) {
    return { match: false, reason: "no-code" };
  }
  const userId = typeof msg.from?.id === "number" ? msg.from.id : null;
  if (isPrivate && userId === null) return { match: false, reason: "not-a-message" };
  if (
    expect.mode === "group" &&
    typeof expect.ownerUserId === "number" &&
    userId !== null &&
    userId !== expect.ownerUserId
  ) {
    return { match: false, reason: "wrong-sender" };
  }
  return {
    match: true,
    found: {
      userId,
      chatId: msg.chat.id,
      chatType: type as CapturedChat["chatType"],
      chatTitle: msg.chat.title ?? null,
      username: msg.from?.username ?? msg.chat.username ?? null,
      firstName: msg.from?.first_name ?? null,
    },
  };
}
