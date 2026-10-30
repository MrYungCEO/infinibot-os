/**
 * Telegram bot token shape checks for the guided setup. Pure (no I/O), shared
 * by the gateway and the control UI.
 *
 * A token from @BotFather looks like `123456789:AAH...` — the bot's numeric id,
 * a colon, then about 35 letters, digits, `_` or `-` (about 46 characters in all).
 */

export type TelegramTokenProblem = "empty" | "no-colon" | "bad-id" | "too-short" | "bad-chars";

export type TelegramTokenCheck =
  | { ok: true; token: string; botId: string }
  | { ok: false; problem: TelegramTokenProblem; message: string };

const TOKEN_RE = /^(\d{5,16}):([A-Za-z0-9_-]{30,64})$/;

/** Strip the things people paste along with a token (quotes, spaces, a `bot` prefix, a URL). */
export function cleanTelegramToken(raw: string): string {
  let s = String(raw ?? "").trim();
  s = s.replace(/^["'`]+|["'`]+$/g, "").trim();
  // A token inside a longer paste (BotFather's whole message, an API URL).
  const END = "(?=$|[\\s/\"'`).,\\]])";
  const inText = new RegExp(`(?:^|[^0-9])(\\d{5,16}:[A-Za-z0-9_-]{30,64})${END}`).exec(s);
  if (inText) return inText[1];
  return s.replace(/\s+/g, "");
}

export function checkTelegramTokenFormat(raw: string): TelegramTokenCheck {
  const token = cleanTelegramToken(raw);
  if (!token) {
    return { ok: false, problem: "empty", message: "Paste the token BotFather gave you." };
  }
  const match = TOKEN_RE.exec(token);
  if (match) return { ok: true, token, botId: match[1] };
  if (!token.includes(":")) {
    return {
      ok: false,
      problem: "no-colon",
      message:
        "That doesn't look like a bot token. It has numbers, a colon, then a long mix of letters, like 123456789:AAH…",
    };
  }
  const [id, secret = ""] = token.split(":");
  if (!/^\d{5,16}$/.test(id)) {
    return {
      ok: false,
      problem: "bad-id",
      message: "The part before the colon should be only numbers. Copy the whole token again.",
    };
  }
  if (!/^[A-Za-z0-9_-]*$/.test(secret)) {
    return {
      ok: false,
      problem: "bad-chars",
      message: "The token has characters that don't belong. Copy it again from BotFather.",
    };
  }
  return {
    ok: false,
    problem: "too-short",
    message: "The token looks cut off. Copy the whole line from BotFather (about 46 characters).",
  };
}

/** Safe to show and log: bot id plus the last 4 characters. */
export function maskTelegramToken(token: string): string {
  const t = String(token ?? "").trim();
  if (!t) return "";
  const [id, secret = ""] = t.split(":");
  const tail = secret.length >= 8 ? secret.slice(-4) : "";
  return `${id}:••••••${tail}`;
}
