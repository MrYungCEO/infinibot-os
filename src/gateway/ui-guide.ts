/**
 * UI guide — universal navigation + live highlighting for every agent.
 *
 * `ui_control` actions `navigate`, `highlight`, `clear_highlight`, `guide`,
 * `back`, `open_panel` / `open_modal`, `find_targets` land here. We:
 *
 *   1. resolve the target (registry id, alias, tab id, route or natural
 *      language → one target with a confidence, or candidates when ambiguous),
 *   2. check availability (plugin off, cloud-only, local-only),
 *   3. pick WHICH browser tab gets it — the user the agent is talking to:
 *        explicit tab/connId/instanceId
 *        → the tab bound to this agent's chat session (it sent chat.send)
 *        → that user's most recently active tab (focus / visibility / input)
 *      never a blind broadcast (that duplicated actions across every tab);
 *      `scope: "all"` fans out to every tab of the same user on purpose,
 *   4. send the reveal plan to that tab only (ui-control.ts direct send) and
 *      return what happened so the agent can confirm it to the user.
 *
 * In SaaS/cloud mode every candidate tab must belong to the tenant namespace
 * of the current request scope, so a highlight can never reach another
 * tenant's browser.
 */

import { loadConfig } from "../config/config.js";
import { getScopedUserId } from "../config/paths.js";
import {
  resolveUiTarget,
  searchUiTargets,
  listUiTargets,
  getUiTargetRegistry,
} from "../ui-targets/registry.js";
import {
  buildRevealPlan,
  resolveTarget as resolveInRegistry,
  evaluateAvailability,
} from "../ui-targets/resolve.js";
import type { RevealPlan } from "../ui-targets/types.js";
import { HIGHLIGHT_STYLES } from "../ui-targets/types.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { groupIdFromKey, isGroupChatKey, isGroupMemberKey } from "../shared/group-chat/keys.js";

// ── client activity + session binding ───────────────────────────────────────

type Activity = {
  focused: boolean;
  visible: boolean;
  lastActiveAt: number;
  lastSeenAt: number;
  route?: string;
  title?: string;
};

const activity = new Map<string, Activity>();
/** A chat.send binds its tab to the session for this long (then focus decides). */
const SESSION_BIND_TTL_MS = 30 * 60_000;
/** canonical session key → { connId, at } */
const sessionConn = new Map<string, { connId: string; at: number }>();

function canonicalSession(key: string): string {
  // "main" / "webchat-123" (UI shorthand) and "agent:main:main" (tool side)
  // name the same session; the default agent is "main".
  const raw = key.trim().toLowerCase();
  if (!raw) return raw;
  return raw.startsWith("agent:") && raw.split(":").length >= 3 ? raw : `agent:main:${raw}`;
}

/** Browser → gateway presence ping (`ui.client.activity`). */
export function noteUiClientActivity(
  connId: string,
  p: { focused?: boolean; visible?: boolean; interacted?: boolean; route?: string; title?: string },
): void {
  const now = Date.now();
  const prev = activity.get(connId) ?? {
    focused: false,
    visible: true,
    lastActiveAt: 0,
    lastSeenAt: now,
  };
  const next: Activity = {
    // A pointer/key interaction can only come from the tab the user is in.
    focused: p.interacted ? true : typeof p.focused === "boolean" ? p.focused : prev.focused,
    visible: typeof p.visible === "boolean" ? p.visible : prev.visible,
    lastSeenAt: now,
    lastActiveAt: p.interacted || p.focused ? now : prev.lastActiveAt,
    route: typeof p.route === "string" ? p.route.slice(0, 300) : prev.route,
    title: typeof p.title === "string" ? p.title.slice(0, 200) : prev.title,
  };
  // Only one tab can hold focus: a newly focused tab un-focuses the others.
  if (next.focused) for (const [id, a] of activity) if (id !== connId) a.focused = false;
  activity.set(connId, next);
}

/** Last presence report of one UI tab (route, focus, title) — for tab listings. */
export function getUiClientActivity(connId: string): Readonly<Activity> | undefined {
  return activity.get(connId);
}

/** A UI client made a request naming a chat session → that tab is where this conversation lives. */
export function bindUiSession(sessionKey: string, connId: string): void {
  const k = canonicalSession(sessionKey);
  if (!k) return;
  sessionConn.set(k, { connId, at: Date.now() });
  if (sessionConn.size > 500) {
    const oldest = [...sessionConn.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100);
    for (const [key] of oldest) sessionConn.delete(key);
  }
}

export function forgetUiClient(connId: string): void {
  activity.delete(connId);
  for (const [k, v] of sessionConn) if (v.connId === connId) sessionConn.delete(k);
}

export function uiClientActivity(connId: string): Activity | undefined {
  return activity.get(connId);
}

export function resetUiGuideStateForTests(): void {
  activity.clear();
  sessionConn.clear();
}

// ── choosing the tab ────────────────────────────────────────────────────────

export type GuideTargeting = {
  connId?: string;
  instanceId?: string;
  tab?: string;
  /** "active" (default): the one tab the user is talking from / looking at. "all": every tab of that user. */
  scope?: "active" | "all";
  sessionKey?: string;
};

export type PickedTabs = { connIds: string[]; how: string };

type ClientView = Pick<GatewayWsClient, "connId" | "saasNamespace" | "saasEmail"> & {
  instanceId?: string;
};

/**
 * Pure selection logic (exported for tests). `clients` are the connected UI
 * clients already filtered to the caller's tenant.
 */
export function pickGuideTabs(
  clients: ClientView[],
  t: GuideTargeting,
  resolveCodename: (name: string) => string | undefined,
): PickedTabs | { error: string } {
  if (clients.length === 0) {
    return {
      error:
        "No InfiniBot window is open for this user. Ask them to open the InfiniBot web app, then try again.",
    };
  }
  const has = (id: string | undefined) => (id ? clients.some((c) => c.connId === id) : false);
  if (t.connId)
    return has(t.connId)
      ? { connIds: [t.connId], how: "explicit connId" }
      : { error: `tab ${t.connId} is not connected` };
  if (t.tab) {
    const id = resolveCodename(t.tab);
    return id && has(id)
      ? { connIds: [id], how: `tab ${t.tab}` }
      : { error: `no connected tab named ${t.tab}` };
  }
  if (t.instanceId) {
    const hits = clients.filter((c) => c.instanceId === t.instanceId);
    if (hits.length) return { connIds: [rankByActivity(hits)[0]!.connId], how: "instanceId" };
    return { error: `no connected tab with instanceId ${t.instanceId}` };
  }
  if (t.scope === "all") {
    // All tabs of the same person: in cloud, same tenant + same member email.
    const anchor = pickActive(clients, t.sessionKey);
    const email = clients.find((c) => c.connId === anchor.connId)?.saasEmail;
    const mine = email ? clients.filter((c) => !c.saasEmail || c.saasEmail === email) : clients;
    return { connIds: mine.map((c) => c.connId), how: "all tabs of this user" };
  }
  const a = pickActive(clients, t.sessionKey);
  return { connIds: [a.connId], how: a.how };
}

/**
 * The tab bound to `key`, or — for a group member's private session
 * (`agent:<id>:gcmember-<gid>`) — the tab bound to that group's shared chat.
 */
function boundConnFor(key: string): { connId: string; at: number } | undefined {
  const k = canonicalSession(key);
  const direct = sessionConn.get(k);
  if (direct) return direct;
  const gid = groupIdFromKey(k);
  if (!gid || !isGroupMemberKey(k)) return undefined;
  let best: { connId: string; at: number } | undefined;
  for (const [bk, v] of sessionConn) {
    if (isGroupChatKey(bk) && groupIdFromKey(bk) === gid && (!best || v.at > best.at)) best = v;
  }
  return best;
}

function pickActive(clients: ClientView[], sessionKey?: string): { connId: string; how: string } {
  if (sessionKey) {
    const bound = boundConnFor(sessionKey);
    if (
      bound &&
      Date.now() - bound.at < SESSION_BIND_TTL_MS &&
      clients.some((c) => c.connId === bound.connId)
    )
      return { connId: bound.connId, how: "tab bound to this chat session" };
  }
  const ranked = rankByActivity(clients);
  const top = ranked[0]!;
  const a = activity.get(top.connId);
  return {
    connId: top.connId,
    how: a?.focused ? "focused tab" : a ? "most recently active tab" : "only/latest tab",
  };
}

function rankByActivity<T extends ClientView>(clients: T[]): T[] {
  const score = (c: ClientView) => {
    const a = activity.get(c.connId);
    if (!a) return 0;
    return (a.focused ? 4e12 : 0) + (a.visible ? 2e12 : 0) + a.lastActiveAt;
  };
  // Stable: newer connections (later in the set) win ties.
  return clients
    .map((c, i) => ({ c, i }))
    .sort((x, y) => score(y.c) - score(x.c) || y.i - x.i)
    .map((x) => x.c);
}

// ── actions ─────────────────────────────────────────────────────────────────

export const GUIDE_ACTIONS = [
  "navigate",
  "highlight",
  "guide",
  "back",
  "open_panel",
  "open_modal",
  "find_targets",
  "list_targets",
] as const;
export type GuideAction = (typeof GUIDE_ACTIONS)[number] | "clear_highlight";

const GUIDE_ACTION_SET = new Set<string>([...GUIDE_ACTIONS, "clear_highlight"]);
export function isGuideAction(a: unknown): a is GuideAction {
  return typeof a === "string" && GUIDE_ACTION_SET.has(a);
}

export type GuideDeps = {
  uiClients: () => ClientView[];
  resolveCodename: (name: string) => string | undefined;
  dispatch: (
    view: string,
    action: string,
    args: Record<string, unknown>,
    connId: string,
    timeoutMs?: number,
  ) => Promise<{ ok: boolean; payload?: unknown; error?: string }>;
  codenameOf: (connId: string) => string | undefined;
};

export type GuideParams = {
  action: GuideAction;
  args?: Record<string, unknown>;
  target?: string;
  query?: string;
  connId?: string;
  instanceId?: string;
  tab?: string;
  scope?: string;
  sessionKey?: string;
  timeoutMs?: number;
  agentName?: string;
};

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Who is guiding (shown in the callout). */
export function agentLabelForSession(
  sessionKey?: string,
  override?: string,
): { name: string; via?: string } {
  if (override) return { name: override.slice(0, 40) };
  let name = "InfiniBot";
  let via: string | undefined;
  const key = (sessionKey ?? "").toLowerCase();
  const agentId = key.startsWith("agent:") ? key.split(":")[1] : undefined;
  try {
    const cfg = loadConfig() as {
      agents?: { list?: Array<{ id?: string; name?: string; identity?: { name?: string } }> };
      ui?: { assistant?: { name?: string } };
    };
    const entry = cfg.agents?.list?.find((a) => a.id === (agentId ?? "main"));
    name =
      entry?.identity?.name ||
      entry?.name ||
      cfg.ui?.assistant?.name ||
      (agentId && agentId !== "main" ? agentId : name);
  } catch {
    /* config unavailable */
  }
  if (key.includes(":mcp")) via = "MCP";
  else if (key.includes(":subagent:")) via = "sub-agent";
  else if (key.includes("telegram")) via = "Telegram";
  else if (key.includes("voice")) via = "voice";
  return { name, via };
}

type PlanResult =
  | { ok: true; plan: RevealPlan; resolved: Record<string, unknown> }
  | { ok: false; result: Record<string, unknown> };

/** Resolve target / query / route / tab / selector → plan (or a structured refusal). */
async function planFor(input: {
  target?: string;
  query?: string;
  route?: string;
  tab?: string;
  selector?: string;
  kinds?: string[];
  force?: boolean;
}): Promise<PlanResult> {
  if (input.route && input.route.startsWith("/")) {
    return {
      ok: true,
      plan: {
        targetId: `route:${input.route}`,
        title: input.route,
        kind: "page",
        route: input.route,
        reveal: [],
        selectors: input.selector ? [input.selector] : [],
      },
      resolved: { id: `route:${input.route}`, via: "route" },
    };
  }
  if (input.selector && !input.target && !input.query) {
    return {
      ok: true,
      plan: {
        targetId: `selector:${input.selector}`,
        title: input.selector,
        kind: "control",
        reveal: [],
        selectors: [input.selector],
      },
      resolved: { id: `selector:${input.selector}`, via: "selector" },
    };
  }
  let r;
  if (input.kinds) {
    const { targets, env } = await getUiTargetRegistry();
    const scoped = targets.filter((t) => input.kinds!.includes(t.kind));
    const rr = resolveInRegistry(
      scoped,
      { target: input.target ?? input.tab, query: input.query },
      { env },
    );
    if (!rr.ok) {
      r = {
        ok: false as const,
        reason: rr.reason,
        candidates: rr.candidates.map((m) => ({
          id: m.target.id,
          title: m.target.title,
          confidence: Number(m.confidence.toFixed(3)),
        })),
      };
    } else {
      const a = evaluateAvailability(rr.target, env);
      r = {
        ok: true as const,
        target: rr.target,
        plan: buildRevealPlan(targets, rr.target),
        confidence: rr.confidence,
        via: rr.via,
        available: a.available,
        unavailableReason: a.reason,
        fixTarget: a.fixTarget,
        alternatives: [],
      };
    }
  } else {
    r = await resolveUiTarget({ target: input.target ?? input.tab, query: input.query });
  }
  if (!r.ok) {
    return {
      ok: false,
      result: {
        ok: false,
        code:
          r.reason === "ambiguous"
            ? "AMBIGUOUS_TARGET"
            : r.reason === "empty"
              ? "INVALID_PARAMS"
              : "TARGET_NOT_FOUND",
        error:
          r.reason === "ambiguous"
            ? "More than one place matches — ask the user which one they mean (or pick one) and call again with target=<id>."
            : r.reason === "empty"
              ? "Pass target (a registry id like 'plugin:solatrix/settings/agent-access'), query (the user's words), route ('/plugins?plugin=solatrix') or tab."
              : "No UI place matches. Try find_targets with other words, or pick from candidates.",
        candidates: r.candidates,
      },
    };
  }
  if (!r.available && !input.force) {
    return {
      ok: false,
      result: {
        ok: false,
        code: "TARGET_UNAVAILABLE",
        error: r.unavailableReason,
        target: { id: r.target.id, title: r.target.title },
        ...(r.fixTarget
          ? {
              fixTarget: r.fixTarget,
              hint: `Navigate/highlight ${r.fixTarget} first (e.g. a guide: step 1 ${r.fixTarget}, step 2 ${r.target.id}).`,
            }
          : {}),
      },
    };
  }
  const plan = { ...r.plan };
  if (input.selector) plan.selectors = [input.selector, ...plan.selectors];
  return {
    ok: true,
    plan,
    resolved: {
      id: r.target.id,
      title: r.target.title,
      kind: r.target.kind,
      confidence: r.confidence,
      via: r.via,
      ...(r.target.description ? { description: r.target.description } : {}),
      ...(r.alternatives?.length ? { alternatives: r.alternatives } : {}),
    },
  };
}

function styleOf(v: unknown): string {
  const s = str(v);
  return s && (HIGHLIGHT_STYLES as readonly string[]).includes(s) ? s : "pulse";
}

/**
 * Run a guide action. `params` is the ui_control call (args may carry the
 * same fields as top-level params — both shapes are accepted).
 */
export async function handleGuideAction(
  params: GuideParams,
  deps: GuideDeps,
): Promise<Record<string, unknown>> {
  const a = params.args ?? {};
  const pick = (k: string) => (params as Record<string, unknown>)[k] ?? a[k];
  const target = str(pick("target"));
  const query = str(pick("query"));
  const route = str(pick("route"));
  const tabId = str(a.tabId) ?? str(a.page);
  const selector = str(pick("selector"));
  const force = pick("force") === true;
  const timeoutMs = num(params.timeoutMs) ?? num(a.timeoutMs);

  // Registry-only actions (no browser needed).
  if (params.action === "find_targets") {
    const q = query ?? target ?? str(a.text) ?? "";
    if (!q)
      return {
        ok: false,
        error: "query required (the user's words, e.g. 'where do I add an API key')",
      };
    return { ok: true, query: q, targets: await searchUiTargets(q, { limit: num(a.limit) ?? 8 }) };
  }
  if (params.action === "list_targets") {
    const res = await listUiTargets({
      kind: str(a.kind),
      plugin: str(a.plugin),
      prefix: str(a.prefix),
    });
    const limit = num(a.limit) ?? 400;
    return {
      ok: true,
      total: res.targets.length,
      cloud: res.env.cloud,
      targets: res.targets.slice(0, limit),
    };
  }

  // Pick the tab(s) first so "no browser" is reported before resolution noise.
  const picked = pickGuideTabs(
    deps.uiClients(),
    {
      connId: params.connId,
      instanceId: params.instanceId,
      tab: params.tab,
      scope: str(pick("scope")) === "all" ? "all" : "active",
      sessionKey: params.sessionKey,
    },
    deps.resolveCodename,
  );
  if ("error" in picked) return { ok: false, code: "NO_UI_CLIENT", error: picked.error };
  const agent = agentLabelForSession(params.sessionKey, params.agentName ?? str(a.agentName));

  const send = async (op: string, payload: Record<string, unknown>) => {
    const results = await Promise.all(
      picked.connIds.map(async (connId) => {
        const r = await deps.dispatch(
          "guide",
          op,
          payload,
          connId,
          timeoutMs ??
            (op === "guide" || op === "highlight" || op === "navigate" ? 25_000 : 10_000),
        );
        return { connId, tab: deps.codenameOf(connId), ...r };
      }),
    );
    const first = results[0]!;
    return {
      ok: results.every((r) => r.ok),
      delivered: { how: picked.how, tabs: results.map((r) => r.tab ?? r.connId) },
      ...(results.length === 1
        ? { result: first.payload, ...(first.error ? { error: first.error } : {}) }
        : {
            results: results.map((r) => ({
              tab: r.tab,
              ok: r.ok,
              result: r.payload,
              error: r.error,
            })),
          }),
    };
  };

  switch (params.action) {
    case "back":
      return send("back", {});
    case "clear_highlight":
      return send("clear", { all: pick("all") === true });
    case "navigate":
    case "open_panel":
    case "open_modal": {
      const kinds = params.action === "navigate" ? undefined : ["modal"];
      const p = await planFor({ target, query, route, tab: tabId, kinds, force });
      if (!p.ok) return p.result;
      const out = await send("navigate", {
        plan: p.plan,
        agent,
        highlight: pick("highlight") === true,
        text: str(pick("text")),
      });
      return {
        ...out,
        resolved: p.resolved,
        confirm: `Opened ${p.resolved.title ?? p.plan.title}.`,
      };
    }
    case "highlight": {
      const p = await planFor({ target, query, route, tab: tabId, selector, force });
      if (!p.ok) return p.result;
      const out = await send("highlight", {
        plan: p.plan,
        agent,
        text: str(pick("text")) ?? str(a.label) ?? str(a.callout) ?? "",
        style: styleOf(pick("style")),
        durationMs: num(pick("durationMs")) ?? num(a.duration),
        navigate: pick("navigate") !== false,
        waitMs: num(a.waitMs),
      });
      return { ...out, resolved: p.resolved };
    }
    case "guide": {
      const raw = Array.isArray(pick("steps")) ? (pick("steps") as unknown[]) : [];
      if (raw.length === 0)
        return {
          ok: false,
          code: "INVALID_PARAMS",
          error:
            "steps required: [{ target | query | route, text, style?, advance?: 'click'|'next'|'auto' }]",
        };
      if (raw.length > 12)
        return { ok: false, code: "INVALID_PARAMS", error: "at most 12 steps per guide" };
      const steps: Record<string, unknown>[] = [];
      for (const [i, s] of raw.entries()) {
        const step = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
        const p = await planFor({
          target: str(step.target),
          query: str(step.query),
          route: str(step.route),
          tab: str(step.tab),
          selector: str(step.selector),
          force: step.force === true || force,
        });
        if (!p.ok) return { ...p.result, step: i + 1 };
        const advance = str(step.advance);
        steps.push({
          plan: p.plan,
          resolved: p.resolved,
          text: str(step.text) ?? str(step.label) ?? "",
          title: str(step.title),
          style: styleOf(step.style),
          advance:
            advance === "click" || advance === "auto" || advance === "next" ? advance : "next",
          durationMs: num(step.durationMs),
        });
      }
      const out = await send("guide", { steps, agent, title: str(pick("title")) });
      return {
        ...out,
        steps: steps.map((s, i) => ({
          step: i + 1,
          target: (s.resolved as Record<string, unknown>).id,
          advance: s.advance,
        })),
      };
    }
    default:
      return { ok: false, error: `unknown guide action ${params.action as string}` };
  }
}

/** Filter UI clients to the caller's tenant (cloud). */
export function scopeClientsToTenant<T extends { saasNamespace?: string }>(clients: T[]): T[] {
  const ns = getScopedUserId();
  return ns ? clients.filter((c) => c.saasNamespace === ns) : clients;
}
