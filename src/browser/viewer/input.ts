/**
 * Viewer input → CDP Input.* commands.
 *
 * The client sends pointer positions normalized to the frame (0..1), so the
 * panel can be any size; they are scaled to the page's CSS viewport here.
 * Everything is validated: this is the only path from a browser tab of the
 * control UI into the tenant's signed-in Chrome.
 */

export type ViewerViewport = { width: number; height: number };

export type CdpCommand = { method: string; params: Record<string, unknown> };

const BUTTONS = ["left", "middle", "right"] as const;
/** CDP `buttons` bitmask per button index (left=1, right=2, middle=4). */
const BUTTON_MASK = [1, 4, 2];

const MAX_TEXT = 100_000;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** Alt=1, Ctrl=2, Meta=4, Shift=8 — the CDP modifier bitmask. */
function modifiers(v: unknown): number {
  const n = num(v);
  return n === null ? 0 : Math.trunc(n) & 15;
}

function point(ev: Record<string, unknown>, vp: ViewerViewport): { x: number; y: number } | null {
  const x = num(ev.x);
  const y = num(ev.y);
  if (x === null || y === null) return null;
  return { x: Math.round(clamp01(x) * vp.width), y: Math.round(clamp01(y) * vp.height) };
}

/**
 * Translate one viewer input event. Returns the CDP commands to send, or an
 * error string for a malformed event.
 */
export function viewerInputToCdp(
  raw: unknown,
  vp: ViewerViewport,
): { ok: true; commands: CdpCommand[] } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "input event required" };
  const ev = raw as Record<string, unknown>;
  const mods = modifiers(ev.modifiers);

  switch (ev.kind) {
    case "mouse": {
      const p = point(ev, vp);
      if (!p) return { ok: false, error: "mouse event needs x and y" };
      const type =
        ev.type === "down" ? "mousePressed" : ev.type === "up" ? "mouseReleased" : "mouseMoved";
      const idx = num(ev.button);
      const button = idx !== null && idx >= 0 && idx <= 2 ? Math.trunc(idx) : 0;
      const pressed = type !== "mouseMoved" || ev.pressed === true;
      const clickCount = Math.min(3, Math.max(1, Math.trunc(num(ev.clickCount) ?? 1)));
      return {
        ok: true,
        commands: [
          {
            method: "Input.dispatchMouseEvent",
            params: {
              type,
              ...p,
              modifiers: mods,
              button: pressed ? BUTTONS[button] : "none",
              buttons: type === "mouseReleased" || !pressed ? 0 : BUTTON_MASK[button],
              ...(type === "mouseMoved" ? {} : { clickCount }),
            },
          },
        ],
      };
    }
    case "wheel": {
      const p = point(ev, vp);
      if (!p) return { ok: false, error: "wheel event needs x and y" };
      const cap = (v: unknown) => Math.min(4000, Math.max(-4000, num(v) ?? 0));
      return {
        ok: true,
        commands: [
          {
            method: "Input.dispatchMouseEvent",
            params: {
              type: "mouseWheel",
              ...p,
              modifiers: mods,
              deltaX: cap(ev.deltaX),
              deltaY: cap(ev.deltaY),
            },
          },
        ],
      };
    }
    case "key": {
      const key = typeof ev.key === "string" ? ev.key.slice(0, 32) : "";
      const code = typeof ev.code === "string" ? ev.code.slice(0, 32) : "";
      if (!key) return { ok: false, error: "key event needs key" };
      const keyCode = Math.trunc(num(ev.keyCode) ?? 0) & 0xffff;
      const base = {
        key,
        code,
        modifiers: mods,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
      };
      if (ev.type === "up") {
        return {
          ok: true,
          commands: [{ method: "Input.dispatchKeyEvent", params: { type: "keyUp", ...base } }],
        };
      }
      // A key that produces text and isn't a shortcut is a "keyDown" carrying
      // the text; everything else (arrows, Ctrl+A, …) is a raw key down.
      const shortcut = (mods & (2 | 4)) !== 0;
      const text = key === "Enter" ? "\r" : Array.from(key).length === 1 && !shortcut ? key : "";
      return {
        ok: true,
        commands: [
          {
            method: "Input.dispatchKeyEvent",
            params: text
              ? { type: "keyDown", ...base, text, unmodifiedText: text }
              : { type: "rawKeyDown", ...base },
          },
        ],
      };
    }
    case "text": {
      // Paste, IME composition and phone keyboards: no key codes, just text.
      const text = typeof ev.text === "string" ? ev.text : "";
      if (!text) return { ok: false, error: "text event needs text" };
      if (text.length > MAX_TEXT) return { ok: false, error: "text too long" };
      return { ok: true, commands: [{ method: "Input.insertText", params: { text } }] };
    }
    default:
      return { ok: false, error: "unknown input kind" };
  }
}

/**
 * What the address bar accepts: an http(s) URL, a bare host ("github.com"), or
 * words to search for. Other schemes (file:, chrome:, javascript:, data:) are
 * refused — the browser runs on the tenant Machine, next to its files.
 */
export function normalizeViewerUrl(
  input: string,
): { ok: true; url: string } | { ok: false; error: string } {
  const text = input.trim();
  if (!text) return { ok: false, error: "Enter an address" };
  if (text === "about:blank") return { ok: true, url: text };
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1]?.toLowerCase();
  if (scheme && scheme !== "http" && scheme !== "https" && !/^[^/\s]+:\d+/.test(text)) {
    return { ok: false, error: `"${scheme}:" addresses can't be opened here` };
  }
  if (scheme === "http" || scheme === "https") {
    try {
      return { ok: true, url: new URL(text).toString() };
    } catch {
      return { ok: false, error: "That address isn't valid" };
    }
  }
  const looksLikeHost =
    !/\s/.test(text) && /^(localhost|[^/\s]+\.[^/\s.]{2,})(:\d+)?(\/.*)?$/i.test(text);
  if (looksLikeHost) {
    try {
      const proto = /^(localhost|127\.)/i.test(text) ? "http" : "https";
      return { ok: true, url: new URL(`${proto}://${text}`).toString() };
    } catch {
      // fall through to search
    }
  }
  return { ok: true, url: `https://duckduckgo.com/?q=${encodeURIComponent(text)}` };
}
