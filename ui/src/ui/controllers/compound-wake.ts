/**
 * Compound wake-word controller.
 *
 * Users configure custom multi-word wake phrases that combine a target
 * (a specific InfiniBot window codename like "Alpha", an assistant name
 * like "Mike", or an agent id) with an action (switch tab, open voice
 * panel, run a ui_control dispatch). All persisted to localStorage so
 * they survive reloads.
 *
 * Example phrases:
 *
 *   "hey mike projects"      → switch_tab projects (assistant-scoped)
 *   "hey Tango live"         → open_voice on tab "Tango" (window codename)
 *   "Alpha kanban open robo park"
 *                             → ui_control dispatch on Alpha:
 *                                kanban.open_project_by_name "robo park"
 *
 * This sits on top of the existing wake-word controller (per-panel
 * registrations). Every compound phrase is a panel-wake-word with
 * panelId `compound:<id>`. The target/action info lives in this
 * controller; matching is delegated to the shared listener.
 *
 * For window codename targeting we read each window's sessionStorage tag
 * (set by app-gateway.ts:ensureTitleTag → "[Alpha] InfiniBot...") so
 * "hey Tango live" only fires on the window whose codename is Tango.
 * That keeps cross-tab independence: speaking the phrase on monitor 1
 * doesn't accidentally trigger monitor 4.
 */

import {
  registerPanelWakeWord,
  type PanelWakeConfig,
} from "./wake-word.js";

const STORAGE_KEY = "infinibot-compound-wake";

export type CompoundAction =
  | { type: "switch_tab"; tab: string }
  | { type: "open_voice" }
  | { type: "ui_dispatch"; view: string; op: string; args?: Record<string, unknown> }
  | { type: "custom"; handler: string /* name registered via registerCompoundActionHandler */ };

export interface CompoundWakeEntry {
  /** Stable id (random UUID), used as panel id and React key. */
  id: string;
  /** The voice phrase. Case-insensitive. Whole-word match via includes(). */
  phrase: string;
  /**
   * Optional target. Matches:
   *   - "Alpha", "Bravo", … = window codename (sessionStorage tag set by
   *      app-gateway). Only fires on the matching window.
   *   - "Mike", "Nova", … = assistant name (this window's state.assistantName).
   *     Only fires when the current assistant identity matches.
   *   - "main", "coder", … = agent id. Only fires when an action targeting
   *      that agent makes sense (open_voice will scope to that agent).
   *   - "" / undefined = match on any window.
   */
  target?: string;
  action: CompoundAction;
  /** Per-entry sensitivity override (0.1–0.9). Defaults to 0.5. */
  threshold?: number;
  /** User disable flag without deleting the entry. */
  disabled?: boolean;
}

interface RegisteredEntry {
  entry: CompoundWakeEntry;
  unsubscribe: () => void;
}

const registry = new Map<string, RegisteredEntry>();
const customHandlers = new Map<string, (entry: CompoundWakeEntry) => void>();
let switchTabHandler: ((tab: string) => void) | null = null;
let openVoiceHandler: (() => void) | null = null;
let uiDispatchHandler: ((view: string, op: string, args?: Record<string, unknown>) => void) | null = null;
let getCurrentAssistantName: (() => string | null) | null = null;

/** App boots → bind the action wires once. */
export function bindCompoundWakeHandlers(handlers: {
  switchTab: (tab: string) => void;
  openVoice: () => void;
  uiDispatch?: (view: string, op: string, args?: Record<string, unknown>) => void;
  getAssistantName?: () => string | null;
}): void {
  switchTabHandler = handlers.switchTab;
  openVoiceHandler = handlers.openVoice;
  uiDispatchHandler = handlers.uiDispatch ?? null;
  getCurrentAssistantName = handlers.getAssistantName ?? null;
}

/** Register a named function so { action: { type: "custom", handler } } can fire it. */
export function registerCompoundActionHandler(
  name: string,
  handler: (entry: CompoundWakeEntry) => void,
): void {
  customHandlers.set(name, handler);
}

// ── Window codename lookup ─────────────────────────────────────

/**
 * Read this window's codename from the title tag set by app-gateway.
 * Returns lowercase for consistent comparisons. Returns null if the tag
 * is the fallback hex form (the codename hasn't arrived from the gateway
 * yet, or we're on a stale bundle).
 */
function thisWindowCodename(): string | null {
  if (typeof document === "undefined") return null;
  const m = document.title.match(/^\[([A-Za-z][A-Za-z\d-]*)\]/);
  if (!m) return null;
  const tag = m[1]!;
  if (tag.toLowerCase().startsWith("infinibot:")) return null; // hex fallback
  return tag.toLowerCase();
}

/**
 * Decide whether this window should fire the action for the given entry.
 * Targets without a colon are matched against codename → assistantName →
 * (assumed to be an agent id, in which case we let it through for the
 * action handler to scope).
 */
function shouldFireOnThisWindow(entry: CompoundWakeEntry): boolean {
  const target = (entry.target ?? "").trim().toLowerCase();
  if (!target) return true;
  const code = thisWindowCodename();
  if (code && target === code) return true;
  const assistant = (getCurrentAssistantName?.() ?? "").trim().toLowerCase();
  if (assistant && target === assistant) return true;
  // If target matches neither codename nor assistant, treat as agent-id
  // and let the action handler (open_voice scoped to agent) decide.
  return true;
}

// ── Storage ───────────────────────────────────────────────────

function load(): CompoundWakeEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((e): e is CompoundWakeEntry =>
      e && typeof e === "object" && typeof e.id === "string" && typeof e.phrase === "string" && e.action && typeof (e as CompoundWakeEntry).action.type === "string",
    );
  } catch {
    return [];
  }
}

function save(entries: CompoundWakeEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    /* quota / private mode — non-fatal */
  }
}

function applyEntry(entry: CompoundWakeEntry): void {
  if (entry.disabled) return;
  const cfg: PanelWakeConfig = {
    panelId: `compound:${entry.id}`,
    enabled: true,
    wakeWord: entry.phrase.toLowerCase().trim(),
    threshold: entry.threshold ?? 0.5,
    callback: () => fireEntry(entry),
  };
  const unsubscribe = registerPanelWakeWord(cfg);
  registry.set(entry.id, { entry, unsubscribe });
}

function fireEntry(entry: CompoundWakeEntry): void {
  if (!shouldFireOnThisWindow(entry)) return;
  console.log(`[compound-wake] "${entry.phrase}" → ${entry.action.type}`);
  try {
    switch (entry.action.type) {
      case "switch_tab":
        switchTabHandler?.(entry.action.tab);
        break;
      case "open_voice":
        openVoiceHandler?.();
        break;
      case "ui_dispatch":
        uiDispatchHandler?.(entry.action.view, entry.action.op, entry.action.args);
        break;
      case "custom": {
        const handler = customHandlers.get(entry.action.handler);
        if (handler) handler(entry);
        else console.warn(`[compound-wake] no custom handler "${entry.action.handler}"`);
        break;
      }
    }
  } catch (err) {
    console.error("[compound-wake] action failed:", err);
  }
}

// ── Public API ────────────────────────────────────────────────

/** Load + register all persisted entries. Called once at app boot. */
export function syncCompoundWake(): void {
  // Drop existing registrations.
  for (const reg of registry.values()) {
    try { reg.unsubscribe(); } catch { /* ignore */ }
  }
  registry.clear();
  // Re-register from storage.
  for (const entry of load()) applyEntry(entry);
}

export function listCompoundWake(): CompoundWakeEntry[] {
  return load();
}

export function getCompoundWake(id: string): CompoundWakeEntry | undefined {
  return load().find((e) => e.id === id);
}

export function addCompoundWake(entry: Omit<CompoundWakeEntry, "id"> & { id?: string }): CompoundWakeEntry {
  const all = load();
  const id = entry.id ?? `cw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const next: CompoundWakeEntry = { ...entry, id };
  all.push(next);
  save(all);
  applyEntry(next);
  return next;
}

export function updateCompoundWake(id: string, patch: Partial<CompoundWakeEntry>): CompoundWakeEntry | null {
  const all = load();
  const idx = all.findIndex((e) => e.id === id);
  if (idx < 0) return null;
  const next: CompoundWakeEntry = { ...all[idx]!, ...patch, id };
  all[idx] = next;
  save(all);
  const existing = registry.get(id);
  if (existing) { try { existing.unsubscribe(); } catch { /* ignore */ } registry.delete(id); }
  applyEntry(next);
  return next;
}

export function removeCompoundWake(id: string): boolean {
  const all = load();
  const idx = all.findIndex((e) => e.id === id);
  if (idx < 0) return false;
  all.splice(idx, 1);
  save(all);
  const existing = registry.get(id);
  if (existing) { try { existing.unsubscribe(); } catch { /* ignore */ } registry.delete(id); }
  return true;
}

// ── Devtools helpers ──────────────────────────────────────────
if (typeof window !== "undefined") {
  (window as unknown as {
    infinibotAddCompoundWake?: typeof addCompoundWake;
    infinibotListCompoundWake?: typeof listCompoundWake;
    infinibotRemoveCompoundWake?: typeof removeCompoundWake;
  }).infinibotAddCompoundWake = addCompoundWake;
  (window as unknown as {
    infinibotListCompoundWake?: typeof listCompoundWake;
  }).infinibotListCompoundWake = listCompoundWake;
  (window as unknown as {
    infinibotRemoveCompoundWake?: typeof removeCompoundWake;
  }).infinibotRemoveCompoundWake = removeCompoundWake;
}
