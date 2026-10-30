/**
 * InfiniBar — "needs setup" highlights.
 *
 * One `setup.status` fetch seeds the set of setup checks (core + plugin,
 * evaluated server-side — src/gateway/setup-status/). After that it's
 * event-driven, like nav-badges: the gateway broadcasts `setup.status` with
 * the full result whenever it changes (it recomputes after write RPCs), and a
 * reconnect / plugin-host resync triggers one debounced refetch. No per-item
 * polling.
 *
 * The sidebar reads everything through `navSetupFor(tab)` (entry glow),
 * `navSetupCountFor(tabs)` (group header count) and `setupChecksForPage(tab)`
 * (the page banner). User controls live here too: the Appearance toggle
 * ("Highlight pages that need setup", default on) and per-check
 * dismiss/snooze for optional checks — both in localStorage.
 */

import type { GatewayBrowserClient } from "../gateway";
import { hostForTab, pathForTab, type Tab } from "../navigation";

export type SetupState = "ready" | "needs-setup" | "optional" | "error";

export type SetupAction = {
  label: string;
  /** Page to open (a Tab id; retired ids land on their host). */
  tab?: string;
  /** Host sub-view (`?view=`) on that page. */
  view?: string;
  /** Setup page section to open (Setup listens for `infinibot:setup-section`). */
  section?: string;
  /** Absolute/relative href instead of a tab (external docs etc.). */
  href?: string;
};

export type SetupCheck = {
  id: string;
  /** "core" or the contributing plugin id. */
  source: string;
  /** Short name of what is being set up ("Email account"). */
  title: string;
  /** Pages this check gates. Retired ids light up their host entry. */
  tabs: string[];
  state: SetupState;
  /** One short sentence: what's missing. */
  reason: string;
  action?: SetupAction;
  /** Higher sorts first (the model-credential check is 100). */
  priority?: number;
};

export type NavSetupEntry = {
  state: Exclude<SetupState, "ready">;
  /** Highest-priority visible check (drives the hint text). */
  primary: SetupCheck;
  checks: SetupCheck[];
};

const HIGHLIGHT_KEY = "infinibot-nav-setup-highlight";
const SNOOZE_KEY = "infinibot-nav-setup-snooze";
/** Snooze length for "Remind me later". */
export const SETUP_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

let _checks: SetupCheck[] = [];
let _loaded = false;
let _client: GatewayBrowserClient | null = null;
let _wsUnsub: (() => void) | null = null;
let _onChange: (() => void) | null = null;
let _refetchTimer: ReturnType<typeof setTimeout> | null = null;
let _fetching = false;
let _hostListenerBound = false;

// ── persistence (try/catch: private mode / quota / no storage) ─────────────

function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
  } catch {
    /* best effort */
  }
}

/** Appearance › "Highlight pages that need setup" (default ON). */
export function isSetupHighlightEnabled(): boolean {
  return readStorage(HIGHLIGHT_KEY) !== "off";
}

export function setSetupHighlightEnabled(on: boolean): void {
  writeStorage(HIGHLIGHT_KEY, on ? null : "off");
  _onChange?.();
}

/** checkId → epoch ms until which it's hidden (0 = dismissed for good). */
function readSnoozes(): Record<string, number> {
  const raw = readStorage(SNOOZE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeSnoozes(map: Record<string, number>): void {
  writeStorage(SNOOZE_KEY, Object.keys(map).length ? JSON.stringify(map) : null);
}

export function isSetupCheckSnoozed(id: string, now = Date.now()): boolean {
  const until = readSnoozes()[id];
  if (until === undefined) return false;
  return until === 0 || until > now;
}

/**
 * Hide an OPTIONAL check: `forMs` omitted = dismiss for good, otherwise snooze.
 * Required checks (needs-setup / error) can't be hidden — they gate the page.
 */
export function snoozeSetupCheck(id: string, forMs?: number, now = Date.now()): boolean {
  const check = _checks.find((c) => c.id === id);
  if (check && check.state !== "optional") return false;
  const map = readSnoozes();
  map[id] = forMs === undefined ? 0 : now + Math.max(0, forMs);
  writeSnoozes(map);
  _onChange?.();
  return true;
}

export function clearSetupSnoozes(): void {
  writeSnoozes({});
  _onChange?.();
}

// ── state ──────────────────────────────────────────────────────────────────

const RANK: Record<SetupState, number> = { error: 3, "needs-setup": 2, optional: 1, ready: 0 };

function normalizeCheck(raw: unknown): SetupCheck | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const state = r.state;
  if (typeof r.id !== "string" || !r.id) return null;
  if (state !== "ready" && state !== "needs-setup" && state !== "optional" && state !== "error") return null;
  const tabs = Array.isArray(r.tabs) ? r.tabs.filter((t): t is string => typeof t === "string" && t.length > 0) : [];
  const a = r.action && typeof r.action === "object" ? (r.action as Record<string, unknown>) : null;
  const action: SetupAction | undefined =
    a && typeof a.label === "string"
      ? {
          label: a.label,
          ...(typeof a.tab === "string" ? { tab: a.tab } : {}),
          ...(typeof a.view === "string" ? { view: a.view } : {}),
          ...(typeof a.section === "string" ? { section: a.section } : {}),
          ...(typeof a.href === "string" ? { href: a.href } : {}),
        }
      : undefined;
  return {
    id: r.id,
    source: typeof r.source === "string" ? r.source : "core",
    title: typeof r.title === "string" ? r.title : r.id,
    tabs,
    state,
    reason: typeof r.reason === "string" ? r.reason : "",
    ...(action ? { action } : {}),
    ...(typeof r.priority === "number" ? { priority: r.priority } : {}),
  };
}

/** Replace the check set (from the RPC or a `setup.status` event). */
export function applySetupStatus(payload: unknown): void {
  const list = (payload as { checks?: unknown })?.checks;
  if (!Array.isArray(list)) return;
  const next = list.map(normalizeCheck).filter((c): c is SetupCheck => c !== null);
  const sig = (cs: SetupCheck[]) =>
    JSON.stringify(cs.map((c) => [c.id, c.state, c.reason, c.tabs, c.action]));
  const changed = !_loaded || sig(next) !== sig(_checks);
  _checks = next;
  _loaded = true;
  if (changed) _onChange?.();
}

export function setupChecks(): readonly SetupCheck[] {
  return _checks;
}

function visible(check: SetupCheck, now: number): boolean {
  if (check.state === "ready") return false;
  if (check.state === "optional" && isSetupCheckSnoozed(check.id, now)) return false;
  return true;
}

function sortChecks(a: SetupCheck, b: SetupCheck): number {
  return RANK[b.state] - RANK[a.state] || (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id);
}

function entryFrom(checks: SetupCheck[]): NavSetupEntry | null {
  if (checks.length === 0) return null;
  const sorted = [...checks].sort(sortChecks);
  const primary = sorted[0];
  return { state: primary.state as NavSetupEntry["state"], primary, checks: sorted };
}

/**
 * The glow for one sidebar entry: every visible check gating the entry or a
 * page it hosts (merged sub-tabs light up their host). Null when the
 * highlight toggle is off or nothing is outstanding.
 */
export function navSetupFor(tab: string, now = Date.now()): NavSetupEntry | null {
  if (!isSetupHighlightEnabled()) return null;
  const host = hostForTab(tab as Tab);
  return entryFrom(
    _checks.filter((c) => visible(c, now) && c.tabs.some((t) => t === tab || hostForTab(t as Tab) === host)),
  );
}

/** Group-header count: entries in `tabs` needing setup (optional ones excluded). */
export function navSetupCountFor(tabs: readonly string[], now = Date.now()): number {
  if (!isSetupHighlightEnabled()) return 0;
  let n = 0;
  for (const tab of tabs) {
    const e = navSetupFor(tab, now);
    if (e && e.state !== "optional") n += 1;
  }
  return n;
}

/**
 * Checks to explain on a page's banner. Independent of the highlight toggle —
 * the banner only appears on the page itself, where it's always relevant.
 */
export function setupChecksForPage(tab: string, now = Date.now()): SetupCheck[] {
  const host = hostForTab(tab as Tab);
  return _checks
    .filter((c) => visible(c, now) && c.tabs.some((t) => t === tab || hostForTab(t as Tab) === host))
    .sort(sortChecks);
}

/** "Needs setup: <reason>" (the tooltip / aria description). */
export function setupHint(entry: Pick<NavSetupEntry, "state" | "primary" | "checks">): string {
  const lead = entry.state === "error" ? "Setup problem" : entry.state === "optional" ? "Optional setup" : "Needs setup";
  const more = entry.checks.length > 1 ? ` (+${entry.checks.length - 1} more)` : "";
  return `${lead}: ${entry.primary.reason}${more}`;
}

/** Where an action button goes. */
export function setupActionHref(action: SetupAction, basePath = ""): string {
  if (action.href) return action.href;
  const path = pathForTab((action.tab ?? "setup") as Tab, basePath);
  return action.view ? `${path}?view=${encodeURIComponent(action.view)}` : path;
}

// ── wiring ─────────────────────────────────────────────────────────────────

/** Gateway events that can change a setup answer without a `setup.status` push. */
function isRelevantEvent(name: string): boolean {
  return (
    name === "hello" ||
    name.startsWith("plugins") ||
    name.startsWith("plugin:") ||
    name.startsWith("coders:") ||
    name.startsWith("config") ||
    name.startsWith("channels") ||
    name.startsWith("email") ||
    name.startsWith("auth")
  );
}

export function scheduleSetupRefetch(delayMs = 600): void {
  if (_refetchTimer) clearTimeout(_refetchTimer);
  _refetchTimer = setTimeout(() => {
    _refetchTimer = null;
    void fetchSetupStatus();
  }, delayMs);
}

export async function fetchSetupStatus(): Promise<void> {
  if (!_client || _fetching) return;
  _fetching = true;
  try {
    applySetupStatus(await _client.request("setup.status", {}));
  } catch {
    // Older gateway without setup.status, or a transient failure: keep what we
    // have (nothing glows rather than something glowing wrongly).
  } finally {
    _fetching = false;
  }
}

/**
 * Idempotent: same client = no-op; a new client (reconnect) re-subscribes and
 * refetches. `onChange` is the sidebar's re-render hook.
 */
export function initNavSetupStatus(client: GatewayBrowserClient | null, onChange: () => void): void {
  _onChange = onChange;
  if (!_hostListenerBound && typeof window !== "undefined" && typeof window.addEventListener === "function") {
    _hostListenerBound = true;
    // Plugin enable/disable resyncs the plugin host → its checks come and go.
    window.addEventListener("infinibot-plugin-host", () => scheduleSetupRefetch(300));
  }
  if (!client) return;
  if (_client === client && _wsUnsub) return;
  _wsUnsub?.();
  _client = client;
  _wsUnsub = client.subscribe((evt) => {
    const name = evt.event ?? (evt as { type?: string }).type;
    if (typeof name !== "string") return;
    if (name === "setup.status") {
      applySetupStatus((evt as { payload?: unknown }).payload);
      return;
    }
    if (isRelevantEvent(name)) scheduleSetupRefetch();
  });
  void fetchSetupStatus();
}

/**
 * Called from the gateway client's onHello (app-gateway.ts): every connect /
 * reconnect refetches, which covers the first render racing the socket and
 * gateway restarts (plugin toggles, config saves).
 */
export function onSetupGatewayHello(client: GatewayBrowserClient | null): void {
  if (client && client !== _client) {
    initNavSetupStatus(client, _onChange ?? (() => {}));
    return;
  }
  scheduleSetupRefetch(250);
}

export function resetNavSetupStatusForTests(): void {
  _wsUnsub?.();
  _wsUnsub = null;
  _client = null;
  _checks = [];
  _loaded = false;
  _onChange = null;
  if (_refetchTimer) clearTimeout(_refetchTimer);
  _refetchTimer = null;
}
