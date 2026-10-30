/**
 * Chat transcript view preferences — layout width + text zoom.
 *
 * Shared by the 1:1 chat (<webchat-view>) and group chats (<ib-group-chat>)
 * so both transcripts read the same. Stored per viewer in localStorage
 * (best-effort: private mode / quota errors fall back to defaults) and
 * broadcast on `window` so every mounted header control stays in sync.
 *
 * Applied as CSS custom properties on the chat root (they pierce shadow
 * roots): `--chat-tz` scales transcript text, `--chat-col-max` caps the
 * transcript/composer column. Text is scaled by font-size, never transform.
 */

export type ChatWidthMode = "full" | "centered";

export type ChatViewPrefs = {
  width: ChatWidthMode;
  /** Text zoom in percent — always one of CHAT_ZOOM_STEPS. */
  zoom: number;
};

export const CHAT_ZOOM_STEPS = [85, 100, 115, 130, 145, 160] as const;
export const CHAT_ZOOM_DEFAULT = 100;
export const CHAT_VIEW_PREFS_KEY = "infinibot.chat.viewPrefs.v1";
export const CHAT_VIEW_PREFS_EVENT = "ib-chat-view-prefs";
/** Prose column cap in Centered mode (scaled with zoom so line length holds). */
export const CHAT_CENTERED_COL_PX = 820;

export const DEFAULT_CHAT_VIEW_PREFS: ChatViewPrefs = { width: "full", zoom: CHAT_ZOOM_DEFAULT };

/** Snap any number to the nearest zoom step. */
export function snapZoom(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return CHAT_ZOOM_DEFAULT;
  let best: number = CHAT_ZOOM_STEPS[0];
  for (const s of CHAT_ZOOM_STEPS) if (Math.abs(s - n) < Math.abs(best - n)) best = s;
  return best;
}

/** Next zoom step in `dir` (+1 larger, -1 smaller); clamps at the ends. */
export function stepZoom(current: number, dir: 1 | -1): number {
  const i = CHAT_ZOOM_STEPS.indexOf(snapZoom(current) as (typeof CHAT_ZOOM_STEPS)[number]);
  const next = Math.min(CHAT_ZOOM_STEPS.length - 1, Math.max(0, i + dir));
  return CHAT_ZOOM_STEPS[next];
}

export function normalizeChatViewPrefs(raw: unknown): ChatViewPrefs {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    width: o.width === "centered" ? "centered" : "full",
    zoom: o.zoom == null ? CHAT_ZOOM_DEFAULT : snapZoom(o.zoom),
  };
}

export function loadChatViewPrefs(): ChatViewPrefs {
  try {
    const raw = globalThis.localStorage?.getItem(CHAT_VIEW_PREFS_KEY);
    return raw ? normalizeChatViewPrefs(JSON.parse(raw)) : { ...DEFAULT_CHAT_VIEW_PREFS };
  } catch {
    return { ...DEFAULT_CHAT_VIEW_PREFS };
  }
}

/** Merge, persist (best-effort) and broadcast. Returns the stored prefs. */
export function saveChatViewPrefs(patch: Partial<ChatViewPrefs>): ChatViewPrefs {
  const next = normalizeChatViewPrefs({ ...loadChatViewPrefs(), ...patch });
  try {
    globalThis.localStorage?.setItem(CHAT_VIEW_PREFS_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable — the setting still applies for this page session.
  }
  try {
    globalThis.dispatchEvent?.(new CustomEvent<ChatViewPrefs>(CHAT_VIEW_PREFS_EVENT, { detail: next }));
  } catch {
    // Non-DOM environment.
  }
  return next;
}

/** Subscribe to pref changes (this tab + other tabs via `storage`). */
export function onChatViewPrefs(cb: (prefs: ChatViewPrefs) => void): () => void {
  const local = (e: Event) => cb(normalizeChatViewPrefs((e as CustomEvent<ChatViewPrefs>).detail));
  const storage = (e: StorageEvent) => {
    if (e.key === CHAT_VIEW_PREFS_KEY) cb(loadChatViewPrefs());
  };
  window.addEventListener(CHAT_VIEW_PREFS_EVENT, local);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(CHAT_VIEW_PREFS_EVENT, local);
    window.removeEventListener("storage", storage);
  };
}

/** CSS custom properties for a chat root. */
export function chatViewStyleVars(prefs: ChatViewPrefs): Record<string, string> {
  const tz = prefs.zoom / 100;
  return {
    "--chat-tz": String(tz),
    "--chat-col-max":
      prefs.width === "centered" ? `${Math.round(CHAT_CENTERED_COL_PX * Math.max(1, tz))}px` : "none",
  };
}

/**
 * Ctrl/Cmd + "+", "-", "0" → zoom action, or null when the key isn't a zoom
 * shortcut. Callers only listen inside the chat, so browser zoom elsewhere
 * is untouched.
 */
export function zoomShortcut(e: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey">): "in" | "out" | "reset" | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  switch (e.key) {
    case "+":
    case "=":
      return "in";
    case "-":
    case "_":
      return "out";
    case "0":
      return "reset";
  }
  if (e.code === "NumpadAdd") return "in";
  if (e.code === "NumpadSubtract") return "out";
  if (e.code === "Numpad0") return "reset";
  return null;
}

/** Apply a shortcut to the stored prefs. Returns the new prefs. */
export function applyZoomShortcut(action: "in" | "out" | "reset"): ChatViewPrefs {
  const cur = loadChatViewPrefs();
  const zoom = action === "reset" ? CHAT_ZOOM_DEFAULT : stepZoom(cur.zoom, action === "in" ? 1 : -1);
  return saveChatViewPrefs({ zoom });
}
