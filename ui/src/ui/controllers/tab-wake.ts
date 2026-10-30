/**
 * Tab-name wake-word controller.
 *
 * For every navigable tab in NAV_CATALOG_GROUPS (sidebar + retired/hidden
 * pages), register a wake word
 * `hey <tab title>` so the user can say "hey projects" / "hey clients" /
 * "hey notes" and the UI navigates to that tab. Reuses the panel-config
 * path in controllers/wake-word.ts — one registration per tab, scoped by
 * panelId = `tab:<tab id>`.
 *
 * Why this is separate from agent-wake:
 *   - Tabs are a stable, finite enum (NAV_CATALOG_GROUPS in navigation.ts) and
 *     they don't move/rename at runtime the way agents can.
 *   - The callback navigates (host.setTab) rather than opening a voice
 *     panel — different action altogether.
 *
 * Lifecycle:
 *   - syncTabWakeWords() is the single entry point. Call it once at app
 *     boot. The set of tabs doesn't change, so a single sync is enough;
 *     callers may call again with no harm (idempotent).
 *   - Master "always on" toggle lives in localStorage so it survives
 *     reloads. When ON, every tab's wake word is enabled and the
 *     listener keeps running in the background; when OFF, all tab
 *     wake words are disabled.
 *   - Per-tab phrase overrides + per-tab disable flags also persist in
 *     localStorage so the user can dial in a custom phrase or silence
 *     tabs they don't want voice-navigable.
 */

import {
  registerPanelWakeWord,
  updatePanelWakeWord,
  type PanelWakeConfig,
} from "./wake-word.js";
import { NAV_CATALOG_GROUPS, titleForTab, type Tab } from "../navigation.js";

const STORAGE_KEY = "infinibot-tab-wake";

interface PersistedSettings {
  alwaysOn: boolean;
  /** Per-tab overrides for the auto-derived "hey <title>" trigger. */
  overrides?: Partial<Record<Tab, string>>;
  /** Per-tab disable flags. Listed tabs do not register a wake word. */
  disabled?: Partial<Record<Tab, boolean>>;
  threshold?: number;
}

type SwitchTab = (tab: Tab) => void;

interface RegisteredTab {
  tab: Tab;
  title: string;
  wakeWord: string;
  unsubscribe: () => void;
}

const registry = new Map<Tab, RegisteredTab>();
let switchHandler: SwitchTab | null = null;
let settings: PersistedSettings = loadSettings();

function loadSettings(): PersistedSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PersistedSettings;
      return {
        alwaysOn: parsed.alwaysOn !== false, // default true
        overrides: parsed.overrides ?? {},
        disabled: parsed.disabled ?? {},
        threshold: typeof parsed.threshold === "number" ? parsed.threshold : 0.5,
      };
    }
  } catch {
    /* corrupt storage — fall through to defaults */
  }
  return { alwaysOn: true, overrides: {}, disabled: {}, threshold: 0.5 };
}

function saveSettings(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* quota / private mode — non-fatal */
  }
}

function panelIdFor(tab: Tab): string {
  return `tab:${tab}`;
}

/**
 * Compute the wake phrase the listener should match for this tab.
 * Format is "hey <title>" lowercased — keeps it consistent with the
 * agent-wake pattern ("hey <agent name>"). Per-tab override wins when set.
 */
function wakeWordFor(tab: Tab): string {
  const override = settings.overrides?.[tab]?.trim();
  if (override) return override.toLowerCase();
  const title = (titleForTab(tab) ?? "").trim();
  if (!title) return "";
  return `hey ${title.toLowerCase()}`;
}

/** Bind the tab-switch handler once at app boot. */
export function setTabWakeSwitchHandler(handler: SwitchTab): void {
  switchHandler = handler;
}

/** Master always-on toggle. */
export function setTabWakeAlwaysOn(enabled: boolean): void {
  settings.alwaysOn = enabled;
  saveSettings();
  for (const reg of registry.values()) {
    updatePanelWakeWord(panelIdFor(reg.tab), { enabled });
  }
}

export function isTabWakeAlwaysOn(): boolean {
  return settings.alwaysOn;
}

/** Override the wake phrase for one tab (or clear via empty string). */
export function setTabWakeOverride(tab: Tab, phrase: string): void {
  settings.overrides = settings.overrides ?? {};
  const clean = phrase.trim().toLowerCase();
  if (clean) settings.overrides[tab] = clean;
  else delete settings.overrides[tab];
  saveSettings();
  // Re-register so the new phrase takes effect immediately.
  const reg = registry.get(tab);
  if (reg) {
    try { reg.unsubscribe(); } catch { /* ignore */ }
    registry.delete(tab);
  }
  syncTabWakeWords();
}

/** Disable/enable wake-up for a specific tab. */
export function setTabWakeDisabled(tab: Tab, disabled: boolean): void {
  settings.disabled = settings.disabled ?? {};
  if (disabled) settings.disabled[tab] = true;
  else delete settings.disabled[tab];
  saveSettings();
  syncTabWakeWords();
}

/**
 * Reconcile the wake-word registry against the full set of tabs. Single
 * registration pass — tabs don't change at runtime.
 */
export function syncTabWakeWords(): void {
  if (!switchHandler) {
    // Boot order: app may call sync before the navigation handler is
    // bound. Drop quietly — call again after setTabWakeSwitchHandler.
    return;
  }
  const seen = new Set<Tab>();
  for (const grp of NAV_CATALOG_GROUPS) {
    for (const tab of grp.tabs as readonly Tab[]) {
      seen.add(tab);
      const disabled = settings.disabled?.[tab] === true;
      if (disabled) {
        // Drop registration if previously present.
        const existing = registry.get(tab);
        if (existing) {
          try { existing.unsubscribe(); } catch { /* ignore */ }
          registry.delete(tab);
        }
        continue;
      }
      const word = wakeWordFor(tab);
      if (!word) continue;
      const existing = registry.get(tab);
      if (existing) {
        if (existing.wakeWord !== word) {
          existing.wakeWord = word;
          updatePanelWakeWord(panelIdFor(tab), { wakeWord: word });
        }
        updatePanelWakeWord(panelIdFor(tab), { enabled: settings.alwaysOn });
        continue;
      }
      const cfg: PanelWakeConfig = {
        panelId: panelIdFor(tab),
        enabled: settings.alwaysOn,
        wakeWord: word,
        threshold: settings.threshold ?? 0.5,
        callback: () => {
          const handler = switchHandler;
          if (!handler) return;
          try {
            console.log(`[tab-wake] "${word}" → switching to ${tab}`);
            handler(tab);
          } catch (err) {
            console.error("[tab-wake] switch handler threw:", err);
          }
        },
      };
      const unsubscribe = registerPanelWakeWord(cfg);
      registry.set(tab, {
        tab,
        title: titleForTab(tab) ?? tab,
        wakeWord: word,
        unsubscribe,
      });
    }
  }
  // Drop any tab that's no longer in NAV_CATALOG_GROUPS (defensive — shouldn't
  // happen at runtime).
  for (const [tab, reg] of registry) {
    if (!seen.has(tab)) {
      try { reg.unsubscribe(); } catch { /* ignore */ }
      registry.delete(tab);
    }
  }
}

/** Diagnostic — what's currently active. Used by settings UI / devtools. */
export function listTabWakeRegistrations(): Array<{
  tab: Tab;
  title: string;
  wakeWord: string;
}> {
  return [...registry.values()].map((r) => ({
    tab: r.tab,
    title: r.title,
    wakeWord: r.wakeWord,
  }));
}
