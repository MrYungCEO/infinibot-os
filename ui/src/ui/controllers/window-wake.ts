/**
 * Window-name wake controller.
 *
 * Registers a single wake phrase `hey <self-codename>` on the current tab.
 * Saying it enters Live Action Mode on this window and opens the voice
 * side panel — the user's "fast switch to talking to *this* window" gesture.
 *
 * Cross-tab routing is handled by wake-coordinator.ts: when the leader's
 * mic catches "hey alpha" and Alpha is a peer (not self), the coordinator
 * broadcasts a wake-fire to Alpha; Alpha's local matcher then finds the
 * phrase registered here and runs the handler.
 *
 * Why this lives in its own controller:
 *   - The action is tied to app shell concerns (live-action mode flag,
 *     voice-panel state) — separating it from wake-word.ts keeps that
 *     module free of UI dependencies.
 *   - Codename arrives asynchronously (gateway round-trip) — we need a
 *     setter the gateway hook can call, and the previous phrase must be
 *     unregistered when the codename changes.
 */

import { registerPanelWakeWord, updatePanelWakeWord } from "./wake-word.js";

type WindowWakeHandler = (codename: string) => void;

const PANEL_ID = "window-wake:self";

let handler: WindowWakeHandler | null = null;
let currentCodename = "";
let unsubscribe: (() => void) | null = null;

function activePhrase(codename: string): string {
  return `hey ${codename.toLowerCase().trim()}`;
}

function reconcile(): void {
  const want = currentCodename.trim();
  if (!want || !handler) {
    if (unsubscribe) {
      try { unsubscribe(); } catch { /* ignore */ }
      unsubscribe = null;
    }
    return;
  }
  const phrase = activePhrase(want);
  if (unsubscribe) {
    // Codename changed (e.g. assistant rename, or gateway reassigned).
    // Update the registered wakeWord in-place instead of churning a new
    // panel id, so the wake-coordinator's phrase-change debounce sees a
    // clean swap rather than a remove + add.
    updatePanelWakeWord(PANEL_ID, { wakeWord: phrase, enabled: true });
    return;
  }
  unsubscribe = registerPanelWakeWord({
    panelId: PANEL_ID,
    enabled: true,
    wakeWord: phrase,
    callback: () => {
      if (!handler) return;
      try {
        handler(currentCodename);
      } catch (err) {
        console.error("[window-wake] handler threw:", err);
      }
    },
  });
}

/** Bind the action that runs when "hey <self-codename>" fires on this tab. */
export function bindWindowWakeHandler(fn: WindowWakeHandler): void {
  handler = fn;
  reconcile();
}

/**
 * Set or update this window's codename. Called from app-gateway when the
 * `ui.my_codename` gateway response lands. Empty string tears down the
 * registration.
 */
export function setWindowWakeCodename(codename: string): void {
  const next = (codename || "").trim();
  if (next === currentCodename) return;
  currentCodename = next;
  reconcile();
}

export function getWindowWakeCodename(): string {
  return currentCodename;
}
