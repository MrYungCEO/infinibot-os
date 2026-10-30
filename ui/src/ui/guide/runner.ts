/**
 * Guide runner — executes reveal plans from the gateway (navigate → reveal →
 * find element) and sequences multi-step guides. Rendering lives in
 * guide-layer.ts; this module is DOM-agnostic behind {@link GuideEnv} so the
 * sequencing logic is unit-tested in node.
 *
 * A plan never blindly re-navigates: when its element is already visible on
 * the current page (e.g. the user is on /solatrix/settings, which also shows
 * the agent-access card) we highlight in place.
 */

import type { HighlightStyle, OpenableSurface, RevealPlan, RevealStep } from "../../../../src/ui-targets/types.js";

export type GuideAgent = { name: string; via?: string };

export interface GuideEnv {
  currentRoute(): string;
  navigate(route: string): void;
  /** First visible element matching any selector (pierces shadow roots). */
  query(selectors: string[]): Element | null;
  wait(selectors: string[], timeoutMs: number, isCancelled: () => boolean): Promise<Element | null>;
  click(el: Element): void;
  fire(name: string, detail?: Record<string, unknown>): void;
  dispatchBus(view: string, action: string, args?: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
  open(surface: OpenableSurface, args?: Record<string, unknown>): Promise<void>;
  revealSidebar(tab: string): Promise<void>;
  /** Bring an element into view inside its scroller. */
  reveal(el: Element): void;
  isPageAllowed(tab: string): boolean;
  sleep(ms: number): Promise<void>;
}

/** Exact route match: same path, and every query param of `want` present in `current`. */
export function routeSatisfied(current: string, want: string): boolean {
  const [cp, cq] = current.split("?");
  const [wp, wq] = want.split("?");
  const norm = (p: string | undefined) => (p || "/").replace(/\/+$/, "") || "/";
  if (norm(cp) !== norm(wp)) return false;
  if (!wq) return true;
  const have = new URLSearchParams(cq ?? "");
  for (const [k, v] of new URLSearchParams(wq)) if (have.get(k) !== v) return false;
  return true;
}

export type PlanOutcome = {
  ok: boolean;
  element: Element | null;
  usedFallback: boolean;
  /** Element was already on screen — nothing was navigated. */
  inPlace: boolean;
  route: string;
  log: string[];
  error?: string;
};

export type RunOptions = { navigate?: boolean; findElement?: boolean; waitMs?: number; isCancelled?: () => boolean };

export async function executePlan(plan: RevealPlan, env: GuideEnv, opts: RunOptions = {}): Promise<PlanOutcome> {
  const log: string[] = [];
  const cancelled = opts.isCancelled ?? (() => false);
  const findElement = opts.findElement !== false && plan.selectors.length > 0;
  const done = (o: Partial<PlanOutcome>): PlanOutcome => ({
    ok: true,
    element: null,
    usedFallback: false,
    inPlace: false,
    route: env.currentRoute(),
    log,
    ...o,
  });

  if (plan.tab && !env.isPageAllowed(plan.tab)) {
    return done({ ok: false, error: `This user isn't allowed to open "${plan.title}" (page access is limited for their account).` });
  }
  // Already visible here? A control highlights in place (its selectors are
  // specific). Pages/sections still open (their element is a nav entry that
  // is visible from anywhere); a visible section entry only skips routing.
  const here = findElement ? env.query(plan.selectors) : null;
  const placeKind = plan.kind === "page" || plan.kind === "section" || plan.kind === "setup-check";
  if (here && !placeKind) {
    log.push("already on screen");
    env.reveal(here);
    return done({ element: here, inPlace: true });
  }
  const onRoute = !plan.route || routeSatisfied(env.currentRoute(), plan.route) || (here !== null && plan.kind === "section");
  if (opts.navigate !== false && plan.route && !onRoute) {
    env.navigate(plan.route);
    log.push(`route ${plan.route}`);
    await env.sleep(350);
    if (cancelled()) return done({ ok: false, error: "cancelled" });
  }
  for (const step of plan.reveal) {
    if (cancelled()) return done({ ok: false, error: "cancelled" });
    try {
      await runStep(step, env, log, cancelled);
    } catch (e) {
      log.push(`step ${step.kind} failed: ${(e as Error).message ?? e}`);
    }
  }
  if (!findElement) return done({});
  const el = await env.wait(plan.selectors, opts.waitMs ?? 8000, cancelled);
  if (el) {
    env.reveal(el);
    return done({ element: el });
  }
  if (plan.fallbackSelectors?.length) {
    const fb = env.query(plan.fallbackSelectors);
    if (fb) {
      log.push("used fallback");
      return done({ element: fb, usedFallback: true });
    }
  }
  return done({ ok: false, error: `Couldn't find "${plan.title}" on screen${plan.route ? ` at ${plan.route}` : ""}.` });
}

async function runStep(step: RevealStep, env: GuideEnv, log: string[], cancelled: () => boolean): Promise<void> {
  switch (step.kind) {
    case "route":
      if (!routeSatisfied(env.currentRoute(), step.route)) {
        env.navigate(step.route);
        log.push(`route ${step.route}`);
        await env.sleep(300);
      }
      return;
    case "event":
      env.fire(step.name, step.detail);
      log.push(`event ${step.name}`);
      await env.sleep(80);
      return;
    case "click": {
      if (step.unless?.length && env.query(step.unless)) return;
      const el = await env.wait(step.selectors, 5000, cancelled);
      if (!el) {
        log.push(`click target missing (${step.label ?? step.selectors[0]})`);
        return;
      }
      env.click(el);
      log.push(`click ${step.label ?? step.selectors[0]}`);
      await env.sleep(250);
      return;
    }
    case "dispatch": {
      const r = await env.dispatchBus(step.view, step.action, step.args);
      log.push(`dispatch ${step.view}.${step.action}${r.ok ? "" : ` failed: ${r.error}`}`);
      return;
    }
    case "open":
      await env.open(step.surface, step.args);
      log.push(`open ${step.surface}`);
      await env.sleep(200);
      return;
    case "sidebar":
      await env.revealSidebar(step.tab);
      log.push(`sidebar ${step.tab}`);
      return;
    case "wait": {
      const el = await env.wait(step.selectors, step.timeoutMs ?? 6000, cancelled);
      log.push(el ? "waited" : `wait timed out (${step.selectors[0]})`);
      return;
    }
  }
}

// ── highlight + guide state ─────────────────────────────────────────────────

export type Advance = "next" | "click" | "auto";

export type HighlightSpec = {
  plan: RevealPlan;
  text: string;
  title?: string;
  style: HighlightStyle;
  durationMs?: number;
  advance?: Advance;
};

export type ActiveHighlight = HighlightSpec & {
  id: number;
  element: Element | null;
  usedFallback: boolean;
  agent: GuideAgent;
  /** 0-based step index when part of a guide. */
  step?: number;
  total?: number;
  missing?: boolean;
  startedAt: number;
};

export type GuideState = {
  highlight: ActiveHighlight | null;
  guide: { title?: string; steps: HighlightSpec[]; index: number; agent: GuideAgent; finished: boolean; startedAt: number } | null;
};

type Listener = (s: GuideState) => void;

/**
 * The single source of truth for what the overlay shows. One highlight at a
 * time; a guide owns it while running.
 */
export class GuideController {
  state: GuideState = { highlight: null, guide: null };
  private listeners = new Set<Listener>();
  private token = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;

  constructor(private env: GuideEnv) {}

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(this.state);
      } catch {
        /* ignore */
      }
    }
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Remove everything (Esc / X / clear_highlight). */
  clear(): void {
    this.token++;
    this.clearTimer();
    this.state = { highlight: null, guide: null };
    this.emit();
  }

  async navigate(plan: RevealPlan): Promise<PlanOutcome> {
    const my = ++this.token;
    this.clearTimer();
    this.state = { highlight: null, guide: null };
    this.emit();
    return executePlan(plan, this.env, { findElement: false, isCancelled: () => my !== this.token });
  }

  async highlight(spec: HighlightSpec, agent: GuideAgent, opts: { navigate?: boolean; waitMs?: number } = {}): Promise<PlanOutcome> {
    const my = ++this.token;
    this.clearTimer();
    this.state = { highlight: null, guide: null };
    this.emit();
    const out = await executePlan(spec.plan, this.env, { navigate: opts.navigate, waitMs: opts.waitMs, isCancelled: () => my !== this.token });
    if (my !== this.token) return out;
    this.show(spec, agent, out);
    const ms = spec.durationMs ?? (out.element ? 20_000 : 6_000);
    if (ms > 0) this.timer = setTimeout(() => my === this.token && this.clear(), ms);
    return out;
  }

  async startGuide(steps: HighlightSpec[], agent: GuideAgent, title?: string): Promise<PlanOutcome> {
    this.token++;
    this.clearTimer();
    this.state = { highlight: null, guide: { title, steps, index: 0, agent, finished: false, startedAt: Date.now() } };
    return this.runGuideStep(0);
  }

  private async runGuideStep(index: number): Promise<PlanOutcome> {
    const g = this.state.guide;
    const my = ++this.token;
    this.clearTimer();
    if (!g) return { ok: false, element: null, usedFallback: false, inPlace: false, route: this.env.currentRoute(), log: [], error: "no guide" };
    g.index = index;
    this.state.highlight = null;
    this.emit();
    const spec = g.steps[index]!;
    const out = await executePlan(spec.plan, this.env, { isCancelled: () => my !== this.token });
    if (my !== this.token || !this.state.guide) return out;
    this.show(spec, g.agent, out, index, g.steps.length);
    if ((spec.advance ?? "next") === "auto") {
      this.timer = setTimeout(() => my === this.token && this.next(), spec.durationMs ?? 4500);
    }
    return out;
  }

  private show(spec: HighlightSpec, agent: GuideAgent, out: PlanOutcome, step?: number, total?: number): void {
    this.state.highlight = {
      ...spec,
      id: ++this.seq,
      element: out.element,
      usedFallback: out.usedFallback,
      missing: !out.element,
      agent,
      startedAt: Date.now(),
      ...(step !== undefined ? { step, total } : {}),
    };
    this.emit();
  }

  /** Next step (or finish). Called by the Next button, auto timers and click-advance. */
  next(): void {
    const g = this.state.guide;
    if (!g) {
      this.clear();
      return;
    }
    if (g.index + 1 >= g.steps.length) {
      g.finished = true;
      this.token++;
      this.clearTimer();
      this.state = { highlight: null, guide: { ...g, finished: true } };
      this.emit();
      this.state = { highlight: null, guide: null };
      this.emit();
      return;
    }
    void this.runGuideStep(g.index + 1);
  }

  back(): void {
    const g = this.state.guide;
    if (g && g.index > 0) void this.runGuideStep(g.index - 1);
  }

  /**
   * The user interacted with the page. In click-advance steps, a click on (or
   * inside) the highlighted element moves on once the click's effect lands.
   */
  noteUserClick(path: EventTarget[]): void {
    const h = this.state.highlight;
    const g = this.state.guide;
    if (!h || !g || (h.advance ?? "next") !== "click" || !h.element) return;
    if (!path.includes(h.element)) return;
    const my = this.token;
    this.clearTimer();
    this.timer = setTimeout(() => my === this.token && this.next(), 450);
  }

  /** Re-acquire the element after a re-render replaced it. */
  refreshElement(): void {
    const h = this.state.highlight;
    if (!h || h.usedFallback) return;
    if (h.element && h.element.isConnected) return;
    const el = this.env.query(h.plan.selectors);
    if (el && el !== h.element) {
      h.element = el;
      h.missing = false;
      this.emit();
    }
  }

  snapshot(): Record<string, unknown> {
    const h = this.state.highlight;
    const g = this.state.guide;
    return {
      highlight: h
        ? { target: h.plan.targetId, title: h.plan.title, text: h.text, style: h.style, found: !h.missing, usedFallback: h.usedFallback, step: h.step !== undefined ? h.step + 1 : undefined, total: h.total }
        : null,
      guide: g ? { title: g.title, step: g.index + 1, total: g.steps.length, finished: g.finished, targets: g.steps.map((s) => s.plan.targetId) } : null,
      route: this.env.currentRoute(),
    };
  }
}
