/**
 * Chat follows navigation.
 *
 * When the agent moves the UI to another page while you're chatting
 * (ui_control / autopilot navigate / a link in a chat reply), the chat comes
 * with you: the app-wide chat dock (<agent-chat-modal>) opens on the
 * destination bound to the SAME session key, so the streaming reply keeps
 * flowing. Group chats open the group; Secure Mode sessions stay secure (the
 * key itself carries the lane). On phones a floating "Back to chat" pill is
 * shown instead of the dock.
 *
 * Manual nav clicks don't open the dock unless the user turned on
 * "Keep chat open when I navigate" (Appearance → Chat & navigation).
 *
 * Which session? The run that called ui_control announces itself through the
 * gateway's `agent` tool events (sessionKey + tool name), so the strongest
 * signal is "the session whose ui_control call just started". Fallbacks: the
 * session the source page was showing (/webchat/<key>), then the session
 * with the most recent live reply.
 *
 * The decision logic is pure (`resolveFollowSession`, `planFollow`) so it
 * runs under node vitest; the wiring below only touches window/localStorage.
 */

import {
  GROUP_CHAT_PREFIX,
  groupIdFromKey,
  isGroupChatKey,
  isGroupMemberKey,
} from "../../../../src/shared/group-chat/keys.js";

/* ── Preferences ─────────────────────────────────────────────────────── */

export type ChatFollowPrefs = {
  /** Agent-driven navigation opens the chat on the destination. */
  agent: boolean;
  /** Manual nav clicks keep the chat open too. */
  manual: boolean;
};

export const CHAT_FOLLOW_PREFS_KEY = "ib.chatFollow.prefs";
export const CHAT_FOLLOW_PREFS_EVENT = "ib:chat-follow-prefs";
export const DEFAULT_CHAT_FOLLOW_PREFS: ChatFollowPrefs = { agent: true, manual: false };

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function storage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function parseChatFollowPrefs(raw: string | null | undefined): ChatFollowPrefs {
  if (!raw) return { ...DEFAULT_CHAT_FOLLOW_PREFS };
  try {
    const v = JSON.parse(raw) as Partial<ChatFollowPrefs> | null;
    return {
      agent: typeof v?.agent === "boolean" ? v.agent : DEFAULT_CHAT_FOLLOW_PREFS.agent,
      manual: typeof v?.manual === "boolean" ? v.manual : DEFAULT_CHAT_FOLLOW_PREFS.manual,
    };
  } catch {
    return { ...DEFAULT_CHAT_FOLLOW_PREFS };
  }
}

export function loadChatFollowPrefs(store: StorageLike | null = storage()): ChatFollowPrefs {
  return parseChatFollowPrefs(store?.getItem(CHAT_FOLLOW_PREFS_KEY));
}

export function saveChatFollowPrefs(
  patch: Partial<ChatFollowPrefs>,
  store: StorageLike | null = storage(),
): ChatFollowPrefs {
  const next = { ...loadChatFollowPrefs(store), ...patch };
  try {
    store?.setItem(CHAT_FOLLOW_PREFS_KEY, JSON.stringify(next));
  } catch {
    /* private mode — keep it for this page */
  }
  try {
    window.dispatchEvent(new CustomEvent(CHAT_FOLLOW_PREFS_EVENT, { detail: next }));
  } catch {
    /* no window (tests) */
  }
  return next;
}

/* ── Pure decision logic ─────────────────────────────────────────────── */

/** Pages that ARE a chat: navigating to them never opens the dock. */
export const CHAT_PAGE_TABS: ReadonlySet<string> = new Set(["webchat"]);
/** Pages you chat from (the source of a follow). */
export const CHAT_SOURCE_TABS: ReadonlySet<string> = new Set(["webchat", "chat", "grid", "voice"]);

/** Tool names whose calls move the UI. */
export const NAV_TOOL_NAMES: ReadonlySet<string> = new Set(["ui_control", "ui", "show_panel"]);

/** How long a ui_control call / live reply counts as "the one driving this". */
export const TOOL_SIGNAL_TTL_MS = 90_000;
export const ACTIVITY_SIGNAL_TTL_MS = 120_000;
/** Manual follow: the chat you were in must have been active this recently. */
export const MANUAL_ACTIVITY_TTL_MS = 15 * 60_000;

export type FollowSignals = {
  /** Last nav-tool call: its run's session key + when it started. */
  tool?: { key: string; at: number } | null;
  /** Last session with live reply activity (chat delta/final) + when. */
  activity?: { key: string; at: number } | null;
  /** groupId → the group's shared key, learned from events / URLs. */
  groups?: ReadonlyMap<string, string>;
};

/**
 * Map any key to the one a chat surface shows: a group member's private
 * session → its group's shared transcript; sub-agent/thread keys stay as-is.
 */
export function chatKeyForSession(key: string, groups?: ReadonlyMap<string, string>): string {
  if (isGroupMemberKey(key)) {
    const gid = groupIdFromKey(key);
    if (!gid) return key;
    return groups?.get(gid) ?? `agent:main:${GROUP_CHAT_PREFIX}${gid}`;
  }
  return key;
}

/** The session key a /webchat/<key> path shows (null for anything else). */
export function sessionKeyFromChatPath(pathname: string | null | undefined): string | null {
  if (!pathname) return null;
  const m = /\/webchat\/([^/?#]+)\/?$/.exec(pathname);
  if (!m?.[1]) return null;
  let key = m[1];
  try {
    key = decodeURIComponent(key);
  } catch {
    /* keep raw */
  }
  return /^agent:[^:]+:.+/.test(key) ? key : null;
}

export function resolveFollowSession(args: {
  now: number;
  agentDriven: boolean;
  /** Key the source page was showing (/webchat/<key>), if any. */
  sourceKey?: string | null;
  /** Key given by the trigger itself (e.g. a link clicked inside a chat). */
  explicitKey?: string | null;
  signals: FollowSignals;
}): string | null {
  const { now, signals } = args;
  const norm = (k: string | null | undefined) => (k ? chatKeyForSession(k, signals.groups) : null);
  if (args.explicitKey) return norm(args.explicitKey);
  if (args.agentDriven) {
    const tool = signals.tool;
    if (tool && now - tool.at <= TOOL_SIGNAL_TTL_MS) return norm(tool.key);
    if (args.sourceKey) return norm(args.sourceKey);
    const act = signals.activity;
    if (act && now - act.at <= ACTIVITY_SIGNAL_TTL_MS) return norm(act.key);
    return null;
  }
  if (args.sourceKey) return norm(args.sourceKey);
  const act = signals.activity;
  if (act && now - act.at <= MANUAL_ACTIVITY_TTL_MS) return norm(act.key);
  return null;
}

export type FollowPlan =
  | { kind: "none"; reason: string }
  | { kind: "sidebar"; key: string }
  | { kind: "pill"; key: string; returnTab: string };

export function planFollow(args: {
  prevTab: string;
  nextTab: string;
  agentDriven: boolean;
  prefs: ChatFollowPrefs;
  isPhone: boolean;
  key: string | null;
}): FollowPlan {
  const { prevTab, nextTab, agentDriven, prefs } = args;
  if (prevTab === nextTab) return { kind: "none", reason: "same page" };
  if (CHAT_PAGE_TABS.has(nextTab)) return { kind: "none", reason: "destination is the chat page" };
  if (agentDriven ? !prefs.agent : !prefs.manual) return { kind: "none", reason: "preference off" };
  // A manual click only carries a chat along when you were chatting.
  if (!agentDriven && !CHAT_SOURCE_TABS.has(prevTab)) return { kind: "none", reason: "not leaving a chat" };
  if (!args.key) return { kind: "none", reason: "no chat session" };
  if (args.isPhone) {
    return { kind: "pill", key: args.key, returnTab: prevTab === "voice" ? "voice" : "webchat" };
  }
  return { kind: "sidebar", key: args.key };
}

/* ── Runtime wiring ──────────────────────────────────────────────────── */

export const CHAT_FOLLOW_PILL_EVENT = "ib:chat-follow-pill";
export type ChatFollowPillDetail = { key: string; returnTab: string } | null;

const signals: { tool: { key: string; at: number } | null; activity: { key: string; at: number } | null; groups: Map<string, string> } = {
  tool: null,
  activity: null,
  groups: new Map(),
};

/** Nested agent-dispatch depth + a short grace window for async setTab calls. */
let intentDepth = 0;
let intentUntil = 0;
let intentKey: string | null = null;
const INTENT_GRACE_MS = 1500;

function now(): number {
  return Date.now();
}

/** Mark the start of an agent-driven UI action (control bus / autopilot / chat link). */
export function beginAgentNav(opts: { sessionKey?: string | null } = {}): void {
  intentDepth++;
  if (opts.sessionKey) intentKey = opts.sessionKey;
}

export function endAgentNav(): void {
  intentDepth = Math.max(0, intentDepth - 1);
  intentUntil = now() + INTENT_GRACE_MS;
  if (intentDepth === 0) {
    const key = intentKey;
    setTimeout(() => {
      if (intentDepth === 0 && intentKey === key) intentKey = null;
    }, INTENT_GRACE_MS);
  }
}

/** Run `fn` as an agent-driven action. */
export async function withAgentNav<T>(fn: () => T | Promise<T>, opts: { sessionKey?: string | null } = {}): Promise<T> {
  beginAgentNav(opts);
  try {
    return await fn();
  } finally {
    endAgentNav();
  }
}

export function isAgentNavActive(at = now()): boolean {
  return intentDepth > 0 || at <= intentUntil;
}

function learnGroup(key: string | null | undefined): void {
  if (!key || !isGroupChatKey(key)) return;
  const gid = groupIdFromKey(key);
  if (gid) signals.groups.set(gid, key);
}

/** Feed one gateway event frame (wired from the app's client subscription). */
export function noteGatewayEvent(evt: { event?: string; payload?: unknown }): void {
  const p = (evt.payload ?? {}) as { sessionKey?: unknown; stream?: unknown; state?: unknown; data?: Record<string, unknown> };
  const key = typeof p.sessionKey === "string" ? p.sessionKey : null;
  if (!key) return;
  learnGroup(key);
  if (evt.event === "agent" && (p.stream === "tool" || p.stream === "tool_status")) {
    const name = typeof p.data?.name === "string" ? p.data.name : "";
    const phase = typeof p.data?.phase === "string" ? p.data.phase : "start";
    if (NAV_TOOL_NAMES.has(name) && phase === "start") signals.tool = { key, at: now() };
    return;
  }
  if (evt.event === "chat" && (p.state === "delta" || p.state === "final")) {
    signals.activity = { key, at: now() };
  }
}

/** A chat surface sent a message in `key` (counts as activity). */
export function noteChatSend(key: string | null | undefined): void {
  if (!key) return;
  learnGroup(key);
  signals.activity = { key, at: now() };
}

function isPhoneViewport(): boolean {
  try {
    return window.matchMedia("(max-width: 600px)").matches;
  } catch {
    return false;
  }
}

/** Open the app-wide chat dock on `key` (keeps it if it's already there). */
export function openChatDockOn(key: string): void {
  window.dispatchEvent(
    new CustomEvent("infinibot:agent-chat", { detail: { action: "open", sessionKey: key, follow: true } }),
  );
}

export function showBackToChatPill(detail: ChatFollowPillDetail): void {
  window.dispatchEvent(new CustomEvent(CHAT_FOLLOW_PILL_EVENT, { detail }));
}

export type TabChange = {
  prevTab: string;
  nextTab: string;
  /** location.pathname before the navigation (source chat key lives there). */
  prevPath?: string | null;
};

/** Called after every app tab change (app.setTab / popstate). */
export function onAppTabChanged(change: TabChange): FollowPlan {
  const at = now();
  const agentDriven = isAgentNavActive(at);
  const explicitKey = agentDriven ? intentKey : null;
  const sourceKey = sessionKeyFromChatPath(change.prevPath ?? null);
  learnGroup(sourceKey);
  const key = resolveFollowSession({ now: at, agentDriven, sourceKey, explicitKey, signals });
  const plan = planFollow({
    prevTab: change.prevTab,
    nextTab: change.nextTab,
    agentDriven,
    prefs: loadChatFollowPrefs(),
    isPhone: isPhoneViewport(),
    key,
  });
  // Arriving back on the chat page clears a stale pill.
  if (CHAT_PAGE_TABS.has(change.nextTab) || change.nextTab === "voice") showBackToChatPill(null);
  if (plan.kind === "sidebar") {
    // Let the destination render first so the dock lands on top of it.
    queueMicrotask(() => openChatDockOn(plan.key));
  } else if (plan.kind === "pill") {
    showBackToChatPill({ key: plan.key, returnTab: plan.returnTab });
  }
  return plan;
}

/* ── Links inside chat replies ───────────────────────────────────────── */

/** Chat surfaces whose reply links navigate in-app (and carry the chat along). */
const CHAT_SURFACE_TAGS = new Set(["WEBCHAT-VIEW", "IB-GROUP-CHAT", "AGENT-CHAT-MODAL", "VOICE-SESSION-VIEW", "VOICE-HUD-PANELS"]);

/** In-app route for a link href (same origin, or infinibot://), else null. */
export function inAppRouteForHref(href: string, origin: string): string | null {
  if (!href) return null;
  if (/^infinibot:\/\//i.test(href)) return href;
  try {
    const u = new URL(href, origin);
    if (u.origin !== origin) return null;
    if (/\.(png|jpe?g|gif|webp|svg|pdf|mp4|webm|mov|zip|json|txt|md|csv)$/i.test(u.pathname)) return null;
    if (/^\/(api|m|files|media|assets|plugins-assets)\//i.test(u.pathname)) return null;
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return null;
  }
}

let installed = false;

/**
 * Install the global listeners once: chat-reply link interception. `resolveLink`
 * turns an href into a navigation the app performs (returns false to let the
 * browser handle it).
 */
export function installChatFollow(opts: {
  navigate: (route: string) => boolean;
  currentChatKey?: () => string | null;
}): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener(
    "click",
    (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const path = e.composedPath();
      const anchor = path.find((n): n is HTMLAnchorElement => (n as Element)?.tagName === "A") ?? null;
      if (!anchor) return;
      const surface = path.find((n) => CHAT_SURFACE_TAGS.has((n as Element)?.tagName ?? "")) as Element | undefined;
      if (!surface) return;
      if (anchor.hasAttribute("download") || anchor.dataset.noFollow !== undefined) return;
      const route = inAppRouteForHref(anchor.getAttribute("href") ?? "", window.location.origin);
      if (!route) return;
      const sourceKey =
        (surface.tagName === "IB-GROUP-CHAT" ? (surface as unknown as { sessionKey?: string }).sessionKey : null) ||
        (surface.tagName === "AGENT-CHAT-MODAL"
          ? (surface as unknown as { currentSessionKey?: string }).currentSessionKey
          : null) ||
        sessionKeyFromChatPath(window.location.pathname) ||
        opts.currentChatKey?.() ||
        null;
      e.preventDefault();
      e.stopPropagation();
      beginAgentNav({ sessionKey: sourceKey });
      try {
        if (!opts.navigate(route)) window.open(anchor.href, "_blank", "noopener");
      } finally {
        endAgentNav();
      }
    },
    true,
  );
}

/** Test hook: reset module state. */
export function __resetChatFollowForTests(): void {
  signals.tool = null;
  signals.activity = null;
  signals.groups.clear();
  intentDepth = 0;
  intentUntil = 0;
  intentKey = null;
}

/** Test hook: read the live signals. */
export function __chatFollowSignals(): FollowSignals {
  return { tool: signals.tool, activity: signals.activity, groups: new Map(signals.groups) };
}
