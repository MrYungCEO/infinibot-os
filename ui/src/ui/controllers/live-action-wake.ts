/**
 * Live-Action wake controller.
 *
 * Registers a small set of FIXED, always-on wake phrases — "live action",
 * "hey infinibot", … — that enter Live Action Mode directly, with no tab
 * navigation or agent/codename dependency.
 *
 * Why this exists (the bug it fixes):
 *   Every other wake controller derives its phrase from runtime data —
 *   tab-wake = "hey <tab title>", agent-wake = "hey <agent name>",
 *   window-wake = "hey <gateway codename>". None of those is the phrase a
 *   user *intuitively* says to "go live": "live action" or "hey infinibot".
 *   The global "infini" word is disabled by default. So a user would speak
 *   the obvious phrase and NOTHING matched — the listener was running and
 *   healthy, but no registered phrase covered the natural utterance. This
 *   controller closes that gap with a guaranteed, brand-fixed trigger.
 *
 * Design mirrors window-wake.ts / tab-wake.ts:
 *   - One panel-wake registration per phrase (panelId = `live-action:<n>`).
 *   - The callback runs the SAME action the manual "Live" button uses —
 *     bound once at app boot via bindLiveActionWakeHandler() — so there's
 *     no duplicated open-panel logic.
 *   - A master "always on" toggle persists in localStorage (default ON).
 *     Turning it OFF disables every phrase here; if no other wake source
 *     is enabled, the shared listener idles (mic released) — see
 *     wake-word.ts:updateListenerState.
 */

import {
  registerPanelWakeWord,
  updatePanelWakeWord,
} from "./wake-word.js";

const STORAGE_KEY = "infinibot-live-action-wake";

/**
 * Default trigger phrases. Lowercased; matched leniently by the shared
 * matcher (token-boundary, alias-normalized, cross-chunk stitched — see
 * wake-word.ts). "infini" already aliases the common Whisper
 * mistranscriptions of the brand, so "hey infinibot" is robust.
 */
const DEFAULT_PHRASES = ["live action", "hey infinibot"];

interface PersistedSettings {
  alwaysOn: boolean;
  /** User-customizable phrase list; falls back to DEFAULT_PHRASES. */
  phrases?: string[];
  /** Sensitivity applied to every live-action phrase (0.1–0.9). */
  threshold?: number;
}

type LiveActionHandler = () => void;

interface RegisteredPhrase {
  phrase: string;
  unsubscribe: () => void;
}

const registry = new Map<string, RegisteredPhrase>();
let handler: LiveActionHandler | null = null;
let settings: PersistedSettings = loadSettings();

function loadSettings(): PersistedSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PersistedSettings;
      return {
        alwaysOn: parsed.alwaysOn !== false, // default true
        phrases:
          Array.isArray(parsed.phrases) && parsed.phrases.length
            ? parsed.phrases.map((p) => String(p).toLowerCase().trim()).filter(Boolean)
            : undefined,
        threshold: typeof parsed.threshold === "number" ? parsed.threshold : 0.5,
      };
    }
  } catch {
    /* corrupt storage — fall through to defaults */
  }
  return { alwaysOn: true, threshold: 0.5 };
}

function saveSettings(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* quota / private mode — non-fatal */
  }
}

function desiredPhrases(): string[] {
  const list = settings.phrases && settings.phrases.length ? settings.phrases : DEFAULT_PHRASES;
  // Dedupe + normalize.
  const set = new Set<string>();
  for (const p of list) {
    const clean = p.toLowerCase().trim();
    if (clean) set.add(clean);
  }
  return [...set];
}

function panelIdFor(phrase: string): string {
  return `live-action:${phrase}`;
}

/** Bind the action that runs when a live-action phrase fires. */
export function bindLiveActionWakeHandler(fn: LiveActionHandler): void {
  handler = fn;
  syncLiveActionWake();
}

/**
 * Reconcile the registered phrase set against `desiredPhrases()`. Idempotent
 * — call after bind, on settings change, or any time. No-op until the
 * handler is bound (boot-order safe, same pattern as the sibling
 * controllers).
 */
export function syncLiveActionWake(): void {
  if (!handler) return;
  const want = new Set(desiredPhrases());

  // Add / update.
  for (const phrase of want) {
    const existing = registry.get(phrase);
    if (existing) {
      updatePanelWakeWord(panelIdFor(phrase), { enabled: settings.alwaysOn });
      continue;
    }
    const unsubscribe = registerPanelWakeWord({
      panelId: panelIdFor(phrase),
      enabled: settings.alwaysOn,
      wakeWord: phrase,
      threshold: settings.threshold ?? 0.5,
      callback: () => {
        if (!handler) return;
        try {
          console.log(`[live-action-wake] "${phrase}" → live action`);
          handler();
        } catch (err) {
          console.error("[live-action-wake] handler threw:", err);
        }
      },
    });
    registry.set(phrase, { phrase, unsubscribe });
  }

  // Drop phrases no longer desired.
  for (const [phrase, reg] of registry) {
    if (!want.has(phrase)) {
      try {
        reg.unsubscribe();
      } catch {
        /* ignore */
      }
      registry.delete(phrase);
    }
  }
}

/** Master always-on toggle. OFF disables every live-action phrase. */
export function setLiveActionWakeAlwaysOn(enabled: boolean): void {
  settings.alwaysOn = enabled;
  saveSettings();
  for (const reg of registry.values()) {
    updatePanelWakeWord(panelIdFor(reg.phrase), { enabled });
  }
}

export function isLiveActionWakeAlwaysOn(): boolean {
  return settings.alwaysOn;
}

/** Replace the phrase list (empty array restores defaults). */
export function setLiveActionWakePhrases(phrases: string[]): void {
  const clean = phrases.map((p) => p.toLowerCase().trim()).filter(Boolean);
  settings.phrases = clean.length ? clean : undefined;
  saveSettings();
  syncLiveActionWake();
}

export function getLiveActionWakePhrases(): string[] {
  return desiredPhrases();
}

/** Diagnostic — what's currently active. */
export function listLiveActionWakeRegistrations(): string[] {
  return [...registry.keys()];
}

// ── Devtools helper ───────────────────────────────────────────
if (typeof window !== "undefined") {
  (window as unknown as { infinibotLiveActionWake?: typeof listLiveActionWakeRegistrations })
    .infinibotLiveActionWake = listLiveActionWakeRegistrations;
}
