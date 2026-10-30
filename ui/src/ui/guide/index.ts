/**
 * Browser half of universal navigation + live highlighting.
 *
 * The gateway resolves targets (src/ui-targets) and sends THIS tab a reveal
 * plan through the UIControlBus view `guide`:
 *
 *   navigate  { plan }                          → route + reveal, report final route
 *   highlight { plan, text, style, agent, … }   → reveal, wait for the element, draw the overlay
 *   guide     { steps[], agent, title }         → multi-step walkthrough
 *   clear | back | next | prev | find_targets
 *
 * Also reports this tab's focus/visibility/interaction to the gateway
 * (`ui.client.activity`) so an agent's highlight lands on the tab the user is
 * actually using — never on every open tab.
 */

import { deepQueryAll, isVisible, revealElement } from "../../learn/guided/resolve-target";
import { attachViewController, UIControlBus, type RegistrationHandle } from "../control-bus";
import type { GatewayBrowserClient } from "../gateway";
import { inferBasePathFromPathname, normalizeBasePath } from "../navigation";
import { pluginNavSections } from "../plugin-host";
import type { HighlightStyle, OpenableSurface, RevealPlan } from "../../../../src/ui-targets/types.js";
import { HIGHLIGHT_STYLES, TARGET_ATTR } from "../../../../src/ui-targets/types.js";
import { GuideController, type Advance, type GuideAgent, type GuideEnv, type HighlightSpec, type PlanOutcome } from "./runner";

type HostLike = {
  client?: GatewayBrowserClient | null;
  navSidebarState?: {
    categories: Array<{ id: string; collapsed: boolean; tabs: string[] }>;
    pluginSections?: Record<string, { collapsed?: boolean; hidden?: boolean }>;
  } | null;
  settings?: { navCollapsed?: boolean } & Record<string, unknown>;
  applySettings?: (s: Record<string, unknown>) => void;
  users?: { me?: { implicitAdmin?: boolean; user?: { role?: string; allowedPages: string[] } } } | null;
  requestUpdate?: () => void;
};

// ── DOM environment ─────────────────────────────────────────────────────────

function basePath(): string {
  return normalizeBasePath(inferBasePathFromPathname(window.location.pathname));
}

function currentRoute(): string {
  const base = basePath();
  let p = window.location.pathname;
  if (base && p.startsWith(base)) p = p.slice(base.length) || "/";
  return `${p}${window.location.search}`;
}

function firstVisible(selectors: string[]): Element | null {
  for (const sel of selectors) {
    const hit = deepQueryAll(sel).find(isVisible);
    if (hit) return hit;
  }
  return null;
}

function waitFor(selectors: string[], timeoutMs: number, isCancelled: () => boolean): Promise<Element | null> {
  return new Promise((resolve) => {
    const now = firstVisible(selectors);
    if (now) return resolve(now);
    let done = false;
    const finish = (el: Element | null) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(timer);
      mo.disconnect();
      resolve(el);
    };
    // Poll (shadow roots aren't observable from document) + wake on light-DOM mutations.
    const check = () => {
      if (isCancelled()) return finish(null);
      const el = firstVisible(selectors);
      if (el) finish(el);
    };
    const poll = setInterval(check, 120);
    const timer = setTimeout(() => finish(null), timeoutMs);
    const mo = new MutationObserver(() => check());
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden", "open"] });
  });
}

function isPageAllowed(host: HostLike, tab: string): boolean {
  const me = host.users?.me;
  if (!me || me.implicitAdmin) return true;
  const u = me.user;
  if (!u || u.role === "admin" || u.allowedPages.length === 0) return true;
  return tab === "users" || u.allowedPages.includes(tab);
}

async function openSurface(surface: OpenableSurface, args?: Record<string, unknown>): Promise<void> {
  const w = window as unknown as Record<string, { open?: (a?: unknown) => void } | undefined>;
  switch (surface) {
    case "agent-chat":
      if (firstVisible(['[data-learn-id="quick-chat"]'])) return;
      if (w.agentChat?.open) w.agentChat.open(args ?? {});
      else window.dispatchEvent(new CustomEvent("infinibot:agent-chat", { detail: args ?? {} }));
      return;
    case "approvals":
      if (firstVisible(['[data-learn-id="approvals-panel"]'])) return;
      w.approvalsInbox?.open?.();
      return;
    case "launchpad": {
      if (firstVisible(['.lp-panel[role="dialog"]'])) return;
      const m = await import("../views/launchpad");
      m.openLaunchpad();
      return;
    }
    case "learn":
      window.dispatchEvent(new CustomEvent("infinibot:learn-open"));
      return;
    case "chart": {
      if (firstVisible(['.sol-chart[role="dialog"]'])) return;
      const btn = firstVisible(['[data-cb] [data-cb-item="chart"] button', '[data-cb] [data-cb-item="chart"]']);
      (btn as HTMLElement | null)?.click();
      return;
    }
    case "sidebar-search":
      (firstVisible(["[data-nav-search]"]) as HTMLInputElement | null)?.focus();
      return;
  }
}

async function revealSidebar(host: HostLike, tab: string): Promise<void> {
  const sel = [`.nav-item[data-tab-pill="${tab}"]`];
  if (firstVisible(sel)) return;
  const state = host.navSidebarState;
  const { saveNavSidebarState, togglePluginSectionCollapsed, isPluginSectionCollapsed } = await import("../controllers/nav-sidebar");
  let changed = false;
  if (state) {
    let next = state as unknown as import("../controllers/nav-sidebar").NavSidebarState;
    const cat = next.categories.find((c) => (c.tabs as string[]).includes(tab));
    if (cat?.collapsed) {
      next = { ...next, categories: next.categories.map((c) => (c.id === cat.id ? { ...c, collapsed: false } : c)) };
      changed = true;
    }
    const section = pluginNavSections().find((s) => s.items.some((it) => it.tab === tab));
    if (section && isPluginSectionCollapsed(next, section.pluginId, section.collapsedByDefault)) {
      next = togglePluginSectionCollapsed(next, section.pluginId, section.collapsedByDefault);
      changed = true;
    }
    if (changed) {
      saveNavSidebarState(next);
      (host as { navSidebarState: unknown }).navSidebarState = next;
      host.requestUpdate?.();
    }
  }
  // A sidebar the user collapsed away entirely (narrow layouts hide it): expand it.
  if (!firstVisible(["aside.nav.enhanced"]) && host.settings?.navCollapsed && host.applySettings) {
    host.applySettings({ ...host.settings, navCollapsed: false });
    changed = true;
  }
  if (changed) await new Promise((r) => setTimeout(r, 220));
  // Phone layout: the sidebar is a horizontal strip — scroll the entry into it.
  const any = deepQueryAll(sel[0]!).find((e) => e.isConnected && e.getBoundingClientRect().height > 0);
  if (any) {
    scrollIntoAxis(any, "x");
    revealElement(any);
  }
}

/**
 * Scroll `el` into view along one axis inside its nearest scrollable
 * ancestor (never scrollIntoView: it also scrolls the overflow-hidden shell).
 */
function scrollIntoAxis(el: Element, axis: "x" | "y"): void {
  const r = el.getBoundingClientRect();
  let node: Element | null = el;
  while (node) {
    const parent: Element | null = node.parentElement ?? ((node.getRootNode() as ShadowRoot).host as Element | undefined) ?? null;
    if (!parent) return;
    const cs = getComputedStyle(parent);
    const overflow = axis === "x" ? cs.overflowX : cs.overflowY;
    const scrollable = axis === "x" ? parent.scrollWidth > parent.clientWidth + 4 : parent.scrollHeight > parent.clientHeight + 4;
    if (/(auto|scroll)/.test(overflow) && scrollable) {
      const pr = parent.getBoundingClientRect();
      if (axis === "x") {
        const ratio = pr.width > 0 ? parent.clientWidth / pr.width : 1;
        if (r.left < pr.left + 8 || r.right > pr.right - 8) parent.scrollLeft += (r.left - pr.left - pr.width / 3) * ratio;
      } else {
        const ratio = pr.height > 0 ? parent.clientHeight / pr.height : 1;
        if (r.top < pr.top + 8 || r.bottom > pr.bottom - 8) parent.scrollTop += (r.top - pr.top - pr.height / 3) * ratio;
      }
      return;
    }
    node = parent;
  }
}

export function createDomGuideEnv(host: HostLike): GuideEnv {
  return {
    currentRoute,
    navigate(route) {
      window.history.pushState({}, "", `${basePath()}${route}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    },
    query: firstVisible,
    wait: waitFor,
    click(el) {
      (el as HTMLElement).click?.();
    },
    fire(name, detail) {
      window.dispatchEvent(new CustomEvent(name, { detail: detail ?? {} }));
    },
    async dispatchBus(view, action, args) {
      const r = await UIControlBus.dispatchTo(view, { type: action, ...(args ?? {}) });
      return { ok: r.ok, error: r.error };
    },
    open: openSurface,
    revealSidebar: (tab) => revealSidebar(host, tab),
    reveal: revealElement,
    isPageAllowed: (tab) => isPageAllowed(host, tab),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

// ── controller + overlay ────────────────────────────────────────────────────

let controller: GuideController | null = null;
let handle: RegistrationHandle | null = null;
let layerReady: Promise<void> | null = null;

function ensureLayer(c: GuideController): Promise<void> {
  if (layerReady) return layerReady;
  layerReady = import("./guide-layer").then(() => {
    let el = document.querySelector("ib-guide-layer");
    if (!el) {
      el = document.createElement("ib-guide-layer");
      // Outside the zoomed <body>: fixed coords == getBoundingClientRect().
      document.documentElement.appendChild(el);
    }
    (el as unknown as { attach(c: GuideController): void }).attach(c);
  });
  return layerReady;
}

export function guideController(): GuideController | null {
  return controller;
}

function planOf(v: unknown): RevealPlan | null {
  const p = v as RevealPlan | undefined;
  return p && typeof p === "object" && typeof p.targetId === "string" && Array.isArray(p.selectors) && Array.isArray(p.reveal) ? p : null;
}

function agentOf(v: unknown): GuideAgent {
  const a = (v ?? {}) as { name?: unknown; via?: unknown };
  return { name: typeof a.name === "string" && a.name.trim() ? a.name.trim().slice(0, 40) : "InfiniBot", ...(typeof a.via === "string" ? { via: a.via } : {}) };
}

function styleOf(v: unknown): HighlightStyle {
  return typeof v === "string" && (HIGHLIGHT_STYLES as readonly string[]).includes(v) ? (v as HighlightStyle) : "pulse";
}

function outcome(o: PlanOutcome, extra: Record<string, unknown> = {}) {
  return {
    ok: o.ok,
    ...(o.error ? { error: o.error } : {}),
    result: {
      found: Boolean(o.element),
      usedFallback: o.usedFallback,
      inPlace: o.inPlace,
      route: o.route,
      steps: o.log,
      ...extra,
    },
  };
}

/** Visible `data-ib-target` ids on this screen (live discovery). */
function visibleTargets(): Array<{ id: string; label: string }> {
  const out: Array<{ id: string; label: string }> = [];
  const seen = new Set<string>();
  for (const el of deepQueryAll(`[${TARGET_ATTR}]`)) {
    const id = el.getAttribute(TARGET_ATTR) ?? "";
    if (!id || seen.has(id) || !isVisible(el)) continue;
    seen.add(id);
    out.push({ id, label: (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60) });
  }
  return out;
}

export function installGuide(host: HostLike): void {
  if (typeof window === "undefined") return;
  if (!controller) {
    controller = new GuideController(createDomGuideEnv(host));
    const c = controller;
    window.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape" && (c.state.highlight || c.state.guide)) c.clear();
      },
      true,
    );
    window.addEventListener("pointerdown", (e) => c.noteUserClick(e.composedPath()), true);
    // Debug/QA hook (headless verification + console).
    (window as unknown as { __ibGuide?: GuideController }).__ibGuide = c;
  }
  const c = controller;
  handle?.unregister();
  handle = attachViewController({
    viewName: "guide",
    description:
      "Universal navigation + live highlighting driven by the gateway's UI target registry. Agents should call ui_control actions navigate/highlight/guide (the gateway resolves targets and sends plans here) rather than dispatching to this view directly.",
    getState: () => c.snapshot(),
    describeActions: () => [
      { type: "navigate", args: { plan: "RevealPlan from the gateway" }, doc: "Route + reveal a target." },
      { type: "highlight", args: { plan: "RevealPlan", text: "callout", style: "pulse|spotlight|outline|arrow", durationMs: "ms (0 = until dismissed)" }, doc: "Reveal + highlight." },
      { type: "guide", args: { steps: "[{ plan, text, style, advance }]" }, doc: "Multi-step walkthrough." },
      { type: "clear", doc: "Remove highlights / stop the guide." },
      { type: "next", doc: "Advance the running guide." },
      { type: "prev", doc: "Previous guide step." },
      { type: "back", doc: "Browser back." },
      { type: "find_targets", doc: "Visible data-ib-target ids on this screen." },
    ],
    dispatch: async (action) => {
      const a = action as Record<string, unknown>;
      switch (a.type) {
        case "navigate": {
          const plan = planOf(a.plan);
          if (!plan) return { ok: false, error: "plan required" };
          const o = await c.navigate(plan);
          if (a.highlight === true && plan.selectors.length) {
            await ensureLayer(c);
            const h = await c.highlight({ plan, text: typeof a.text === "string" ? a.text : "", style: "pulse" }, agentOf(a.agent), { navigate: false });
            return outcome(h, { navigated: o.log });
          }
          return outcome(o);
        }
        case "highlight": {
          const plan = planOf(a.plan);
          if (!plan) return { ok: false, error: "plan required" };
          await ensureLayer(c);
          const spec: HighlightSpec = {
            plan,
            text: typeof a.text === "string" ? a.text : "",
            style: styleOf(a.style),
            ...(typeof a.durationMs === "number" ? { durationMs: a.durationMs } : {}),
          };
          const o = await c.highlight(spec, agentOf(a.agent), {
            navigate: a.navigate !== false,
            ...(typeof a.waitMs === "number" ? { waitMs: a.waitMs } : {}),
          });
          return outcome(o);
        }
        case "guide": {
          const raw = Array.isArray(a.steps) ? (a.steps as Array<Record<string, unknown>>) : [];
          const steps: HighlightSpec[] = [];
          for (const s of raw) {
            const plan = planOf(s.plan);
            if (!plan) return { ok: false, error: "every step needs a plan" };
            const adv = s.advance === "click" || s.advance === "auto" ? (s.advance as Advance) : "next";
            steps.push({
              plan,
              text: typeof s.text === "string" ? s.text : "",
              ...(typeof s.title === "string" ? { title: s.title } : {}),
              style: styleOf(s.style),
              advance: adv,
              ...(typeof s.durationMs === "number" ? { durationMs: s.durationMs } : {}),
            });
          }
          if (!steps.length) return { ok: false, error: "steps required" };
          await ensureLayer(c);
          const o = await c.startGuide(steps, agentOf(a.agent), typeof a.title === "string" ? a.title : undefined);
          return outcome(o, { started: true, step: 1, total: steps.length });
        }
        case "clear":
          c.clear();
          return { ok: true, result: { cleared: true } };
        case "next":
          c.next();
          return { ok: true, result: c.snapshot() };
        case "prev":
          c.back();
          return { ok: true, result: c.snapshot() };
        case "back":
          c.clear();
          window.history.back();
          await new Promise((r) => setTimeout(r, 300));
          return { ok: true, result: { route: currentRoute() } };
        case "find_targets":
          return { ok: true, result: { route: currentRoute(), targets: visibleTargets() } };
      }
      return { ok: false, error: `unknown action: ${String(a.type)}` };
    },
  });
  startActivityReporting(host);
}

// ── activity reporting (which tab is the user on?) ──────────────────────────

let activityStarted = false;

function startActivityReporting(host: HostLike): void {
  if (activityStarted) return;
  activityStarted = true;
  let lastInteractSent = 0;
  const send = (interacted: boolean) => {
    const client = host.client;
    if (!client) return;
    void client
      .request("ui.client.activity", {
        focused: document.hasFocus(),
        visible: document.visibilityState === "visible",
        interacted,
        route: currentRoute(),
        title: document.title,
      })
      .catch(() => {
        /* older gateway without the method */
      });
  };
  window.addEventListener("focus", () => send(true));
  window.addEventListener("blur", () => send(false));
  document.addEventListener("visibilitychange", () => send(false));
  window.addEventListener("popstate", () => send(false));
  const interact = () => {
    const now = Date.now();
    if (now - lastInteractSent < 10_000) return;
    lastInteractSent = now;
    send(true);
  };
  window.addEventListener("pointerdown", interact, true);
  window.addEventListener("keydown", interact, true);
  // Initial report once connected.
  setTimeout(() => send(document.hasFocus()), 500);
  // In-app navigation uses pushState (no event): report route/title changes
  // so cross-node window listings show where each window is.
  let lastPlace = "";
  window.setInterval(() => {
    const place = `${currentRoute()}|${document.title}`;
    if (place === lastPlace) return;
    lastPlace = place;
    send(false);
  }, 3_000);
}

/** Call after the gateway (re)connects so the new connection has presence. */
export function reportGuideActivityNow(host: HostLike): void {
  const client = host.client;
  if (!client) return;
  void client
    .request("ui.client.activity", { focused: document.hasFocus(), visible: document.visibilityState === "visible", interacted: document.hasFocus(), route: currentRoute(), title: document.title })
    .catch(() => {});
}
