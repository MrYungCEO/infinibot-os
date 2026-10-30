/**
 * Assistant-name wake controller.
 *
 * Registers `hey <assistant name>` so the user can address the assistant by
 * the name they gave it — "hey Tab", "hey Nova", "hey Jarvis" — and have the
 * voice terminal go LIVE (Live Action Mode / open mic), exactly as the
 * manual "Live" button does.
 *
 * Why this exists (the bug it fixes):
 *   The wake system had a controller for every identity EXCEPT the most
 *   obvious one. tab-wake = "hey <tab title>", agent-wake = "hey <agent
 *   name>", window-wake = "hey <gateway codename>", live-action-wake =
 *   fixed brand phrases ("hey infinibot" / "live action"). compound-wake
 *   only matches the assistant name inside user-defined TARGET+ACTION
 *   phrases. Nothing registered a bare "hey <assistant name>". So a user
 *   whose assistant is named "Tab" would say the single most natural
 *   phrase — "Hey Tab" — and NOTHING matched: the listener was healthy,
 *   but no registered phrase covered the utterance. This controller closes
 *   that gap and binds the SAME enableLiveActionMode action the manual Live
 *   button uses.
 *
 * STT robustness:
 *   Short, non-dictionary names are exactly what Whisper mis-transcribes —
 *   "tab" comes back as "tap" / "tad" / "tan" / "tav". We register a few
 *   near-homophone variants for known-confusable names so those still fire.
 *   The variants are scoped to THIS controller's own panel registrations —
 *   we deliberately do NOT add them to the global TOKEN_ALIAS table in
 *   wake-word.ts, because that would rewrite those tokens for every other
 *   registered phrase too.
 *
 * Design mirrors live-action-wake.ts / tab-wake.ts:
 *   - One panel-wake registration per phrase (panelId = `assistant:<phrase>`).
 *   - The callback runs the bound handler (enableLiveActionMode) — no
 *     duplicated open-panel logic.
 *   - A master "always on" toggle persists in localStorage (default ON).
 *   - setAssistantWakeName() is called whenever the identity loads/changes
 *     so the phrase set always tracks the current assistant name.
 */

import {
  registerPanelWakeWord,
  updatePanelWakeWord,
} from "./wake-word.js";

const STORAGE_KEY = "infinibot-assistant-wake";

interface PersistedSettings {
  alwaysOn: boolean;
  /** Sensitivity applied to every assistant phrase (0.1–0.9). */
  threshold?: number;
}

type AssistantWakeHandler = () => void;

interface RegisteredPhrase {
  phrase: string;
  unsubscribe: () => void;
}

/**
 * Near-homophone variants for known-confusable short names. Keyed by the
 * lowercased assistant name. Whisper consistently swaps the trailing
 * consonant on these. Each listed variant (plus the name itself) gets its
 * own "hey <variant>" registration.
 */
const NAME_HOMOPHONES: Record<string, string[]> = {
  tab: ["tap", "tad", "tav", "tan", "tabs"],
};

/**
 * Names we never register a bare "hey <name>" for — too generic / already
 * covered elsewhere, or so common in ordinary speech they'd false-fire.
 */
const SKIP_NAMES = new Set(["", "assistant", "infinibot", "infini", "ai", "bot"]);

const registry = new Map<string, RegisteredPhrase>();
let handler: AssistantWakeHandler | null = null;
let currentName = "";
let settings: PersistedSettings = loadSettings();

function loadSettings(): PersistedSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PersistedSettings;
      return {
        alwaysOn: parsed.alwaysOn !== false, // default true
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

/**
 * The set of "hey <variant>" phrases the listener should match for the
 * current assistant name. Empty when the name is generic/blank.
 */
function desiredPhrases(): string[] {
  const name = currentName.toLowerCase().trim();
  if (SKIP_NAMES.has(name)) return [];
  const variants = new Set<string>([name, ...(NAME_HOMOPHONES[name] ?? [])]);
  const out = new Set<string>();
  for (const v of variants) {
    const clean = v.toLowerCase().trim();
    if (clean) out.add(`hey ${clean}`);
  }
  return [...out];
}

function panelIdFor(phrase: string): string {
  return `assistant:${phrase}`;
}

/** Bind the action that runs when an assistant-name phrase fires. */
export function bindAssistantWakeHandler(fn: AssistantWakeHandler): void {
  handler = fn;
  syncAssistantWake();
}

/**
 * Point the controller at the current assistant name. Idempotent — a no-op
 * when the name is unchanged. Re-registers the phrase set otherwise.
 */
export function setAssistantWakeName(name: string | null | undefined): void {
  const next = (name ?? "").toString();
  if (next === currentName) return;
  currentName = next;
  syncAssistantWake();
}

/**
 * Reconcile the registered phrase set against `desiredPhrases()`. Idempotent.
 * No-op until the handler is bound (boot-order safe, same pattern as the
 * sibling controllers).
 */
export function syncAssistantWake(): void {
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
          console.log(`[assistant-wake] "${phrase}" → live action`);
          handler();
        } catch (err) {
          console.error("[assistant-wake] handler threw:", err);
        }
      },
    });
    registry.set(phrase, { phrase, unsubscribe });
  }

  // Drop phrases no longer desired (e.g. after a rename).
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

/** Master always-on toggle. OFF disables every assistant-name phrase. */
export function setAssistantWakeAlwaysOn(enabled: boolean): void {
  settings.alwaysOn = enabled;
  saveSettings();
  for (const reg of registry.values()) {
    updatePanelWakeWord(panelIdFor(reg.phrase), { enabled });
  }
}

export function isAssistantWakeAlwaysOn(): boolean {
  return settings.alwaysOn;
}

/** Diagnostic — what's currently active. */
export function listAssistantWakeRegistrations(): string[] {
  return [...registry.keys()];
}

// ── Devtools helper ───────────────────────────────────────────
if (typeof window !== "undefined") {
  (window as unknown as { infinibotAssistantWake?: typeof listAssistantWakeRegistrations })
    .infinibotAssistantWake = listAssistantWakeRegistrations;
}
