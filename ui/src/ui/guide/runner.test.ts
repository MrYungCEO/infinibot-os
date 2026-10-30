import { describe, expect, it, vi } from "vitest";

import type { RevealPlan } from "../../../../src/ui-targets/types.js";
import { GuideController, executePlan, routeSatisfied, type GuideEnv } from "./runner";

/** A fake page: a route, a set of visible selectors, and a log of what the runner did. */
function fakeEnv(init: { route?: string; visible?: string[]; onNavigate?: (r: string, v: Set<string>) => void; onFire?: (n: string, v: Set<string>) => void; onClick?: (sel: string, v: Set<string>) => void; allowed?: (tab: string) => boolean } = {}) {
  const visible = new Set(init.visible ?? []);
  let route = init.route ?? "/";
  const calls: string[] = [];
  const elFor = new Map<string, Element>();
  const el = (sel: string) => {
    if (!elFor.has(sel)) elFor.set(sel, { sel, isConnected: true } as unknown as Element);
    return elFor.get(sel)!;
  };
  const env: GuideEnv = {
    currentRoute: () => route,
    navigate: (r) => {
      calls.push(`navigate ${r}`);
      route = r;
      init.onNavigate?.(r, visible);
    },
    query: (sels) => {
      const hit = sels.find((s) => visible.has(s));
      return hit ? el(hit) : null;
    },
    wait: async (sels) => env.query(sels),
    click: (e) => {
      const sel = (e as unknown as { sel: string }).sel;
      calls.push(`click ${sel}`);
      init.onClick?.(sel, visible);
    },
    fire: (n, d) => {
      calls.push(`event ${n} ${JSON.stringify(d ?? {})}`);
      init.onFire?.(n, visible);
    },
    dispatchBus: async (v, a) => {
      calls.push(`bus ${v}.${a}`);
      return { ok: true };
    },
    open: async (s) => {
      calls.push(`open ${s}`);
    },
    revealSidebar: async (t) => {
      calls.push(`sidebar ${t}`);
    },
    reveal: () => undefined,
    isPageAllowed: init.allowed ?? (() => true),
    sleep: async () => undefined,
  };
  return { env, calls, visible, el, get route() { return route; } };
}

const plan = (p: Partial<RevealPlan>): RevealPlan => ({ targetId: "t", title: "T", kind: "control", reveal: [], selectors: [], ...p });

describe("routeSatisfied", () => {
  it("exact path, query subset", () => {
    expect(routeSatisfied("/setup?view=plugins&plugin=solatrix", "/setup?view=plugins")).toBe(true);
    expect(routeSatisfied("/setup?view=plugins", "/setup?view=plugins&plugin=solatrix")).toBe(false);
    expect(routeSatisfied("/solatrix/settings", "/solatrix")).toBe(false); // not a prefix match
    expect(routeSatisfied("/apikeys/", "/apikeys")).toBe(true);
  });
});

describe("executePlan — reveal chains", () => {
  it("plugin settings control: route → plugins-open event → wait → element", async () => {
    const f = fakeEnv({
      route: "/dashboard",
      onFire: (n, v) => n === "infinibot:plugins-open" && (v.add('[data-plugin-detail="solatrix"]'), v.add('[data-settings-section="solatrix:agent-access"]'), v.add("[data-modes]")),
    });
    const o = await executePlan(
      plan({
        route: "/setup?view=plugins&plugin=solatrix&ptab=settings",
        reveal: [
          { kind: "event", name: "infinibot:plugins-open", detail: { plugin: "solatrix", section: "settings" } },
          { kind: "wait", selectors: ['[data-plugin-detail="solatrix"]'] },
        ],
        selectors: ["[data-modes]"],
      }),
      f.env,
    );
    expect(o).toMatchObject({ ok: true, inPlace: false, usedFallback: false });
    expect(f.calls[0]).toBe("navigate /setup?view=plugins&plugin=solatrix&ptab=settings");
    expect(f.calls[1]).toContain("event infinibot:plugins-open");
  });

  it("a control already on screen is highlighted in place — no navigation", async () => {
    const f = fakeEnv({ route: "/solatrix/settings", visible: ["[data-modes]"] });
    const o = await executePlan(plan({ route: "/setup?view=plugins&plugin=solatrix&ptab=settings", selectors: ["[data-modes]"] }), f.env);
    expect(o.inPlace).toBe(true);
    expect(f.calls).toEqual([]);
  });

  it("a page whose sidebar entry is visible still navigates", async () => {
    const f = fakeEnv({ route: "/dashboard", visible: ['.nav-item[data-tab-pill="apikeys"]'] });
    const o = await executePlan(plan({ kind: "page", route: "/apikeys", selectors: ['.nav-item[data-tab-pill="apikeys"]'], reveal: [{ kind: "sidebar", tab: "apikeys" }] }), f.env);
    expect(o.ok).toBe(true);
    expect(f.calls).toEqual(["navigate /apikeys", "sidebar apikeys"]);
  });

  it("host sub-tab route", async () => {
    const f = fakeEnv({ route: "/setup", onNavigate: (_r, v) => v.add("tab") });
    await executePlan(plan({ kind: "page", route: "/setup?view=plugins", selectors: ["tab"] }), f.env);
    expect(f.route).toBe("/setup?view=plugins");
  });

  it("setup section on the setup page: no re-route, section event still fires", async () => {
    const f = fakeEnv({ route: "/setup", visible: ["nav-voice"] });
    await executePlan(plan({ kind: "section", route: "/setup", selectors: ["nav-voice"], reveal: [{ kind: "event", name: "infinibot:setup-section", detail: { section: "voice" } }] }), f.env);
    expect(f.calls).toEqual(['event infinibot:setup-section {"section":"voice"}']);
  });

  it("modal: click-to-open skipped when the dialog is already open", async () => {
    const f = fakeEnv({ route: "/apikeys", visible: [".dialog", "add-btn", "key"] });
    const p = plan({ route: "/apikeys", reveal: [{ kind: "click", selectors: ["add-btn"], unless: [".dialog"] }], selectors: ["key-missing", "key"] });
    // element visible → in place anyway; force the reveal path with a hidden element
    f.visible.delete("key");
    const o = await executePlan(p, f.env);
    expect(f.calls.some((c) => c.startsWith("click"))).toBe(false);
    expect(o.ok).toBe(false);
  });

  it("modal: opens via its surface", async () => {
    const f = fakeEnv({ onClick: () => undefined });
    await executePlan(plan({ kind: "modal", reveal: [{ kind: "open", surface: "agent-chat" }], selectors: ["x"] }), f.env);
    expect(f.calls).toContain("open agent-chat");
  });

  it("falls back to the ⋯ menu when the topbar control is hidden", async () => {
    const f = fakeEnv({ visible: ["more"] });
    const o = await executePlan(plan({ selectors: ["cb-chart"], fallbackSelectors: ["more"] }), f.env);
    expect(o).toMatchObject({ ok: true, usedFallback: true });
  });

  it("missing element → ok:false with a readable error", async () => {
    const f = fakeEnv();
    const o = await executePlan(plan({ title: "Mode", route: "/x", selectors: ["nope"] }), f.env);
    expect(o.ok).toBe(false);
    expect(o.error).toContain("Mode");
  });

  it("respects the user's page allowlist", async () => {
    const f = fakeEnv({ allowed: (t) => t !== "apikeys" });
    const o = await executePlan(plan({ tab: "apikeys", route: "/apikeys" }), f.env);
    expect(o.ok).toBe(false);
    expect(f.calls).toEqual([]);
  });

  it("navigate without an element to find", async () => {
    const f = fakeEnv({ route: "/" });
    const o = await executePlan(plan({ kind: "page", route: "/mesh", selectors: ["s"] }), f.env, { findElement: false });
    expect(o.ok).toBe(true);
    expect(f.route).toBe("/mesh");
  });
});

describe("GuideController — sequencing", () => {
  const steps = (n: number, advance: "next" | "click" | "auto" = "next") =>
    Array.from({ length: n }, (_, i) => ({ plan: plan({ targetId: `s${i}`, selectors: [`sel${i}`] }), text: `step ${i}`, style: "pulse" as const, advance }));

  it("runs steps in order; Next advances; last Next finishes and clears", async () => {
    const f = fakeEnv({ visible: ["sel0", "sel1", "sel2"] });
    const c = new GuideController(f.env);
    await c.startGuide(steps(3), { name: "ASH" }, "Tour");
    expect(c.snapshot()).toMatchObject({ guide: { step: 1, total: 3 }, highlight: { target: "s0", step: 1, total: 3 } });
    c.next();
    await vi.waitFor(() => expect(c.snapshot()).toMatchObject({ highlight: { target: "s1" } }));
    c.back();
    await vi.waitFor(() => expect(c.snapshot()).toMatchObject({ highlight: { target: "s0" } }));
    c.next();
    await vi.waitFor(() => expect(c.snapshot()).toMatchObject({ highlight: { target: "s1" } }));
    c.next();
    await vi.waitFor(() => expect(c.snapshot()).toMatchObject({ highlight: { target: "s2" } }));
    const seen: Array<boolean | undefined> = [];
    c.subscribe((s) => seen.push(s.guide?.finished));
    c.next();
    expect(seen).toContain(true); // "finished" is observable before clearing
    expect(c.snapshot()).toMatchObject({ highlight: null, guide: null });
  });

  it("click-advance moves on when the user clicks the highlighted element (and not elsewhere)", async () => {
    vi.useFakeTimers();
    try {
      const f = fakeEnv({ visible: ["sel0", "sel1"] });
      const c = new GuideController(f.env);
      await c.startGuide(steps(2, "click"), { name: "ASH" });
      const target = c.state.highlight!.element!;
      c.noteUserClick([{} as EventTarget]); // elsewhere
      vi.advanceTimersByTime(1000);
      expect(c.snapshot()).toMatchObject({ highlight: { target: "s0" } });
      c.noteUserClick([target as unknown as EventTarget]);
      vi.advanceTimersByTime(500);
      await vi.waitFor(() => expect(c.snapshot()).toMatchObject({ highlight: { target: "s1" } }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("auto-advance after durationMs", async () => {
    vi.useFakeTimers();
    try {
      const f = fakeEnv({ visible: ["sel0", "sel1"] });
      const c = new GuideController(f.env);
      const s = steps(2, "auto").map((x) => ({ ...x, durationMs: 1000 }));
      await c.startGuide(s, { name: "ASH" });
      vi.advanceTimersByTime(1100);
      await vi.waitFor(() => expect(c.snapshot()).toMatchObject({ highlight: { target: "s1" } }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("a new highlight replaces the running guide; clear() removes everything", async () => {
    const f = fakeEnv({ visible: ["sel0", "x"] });
    const c = new GuideController(f.env);
    await c.startGuide(steps(2), { name: "ASH" });
    await c.highlight({ plan: plan({ targetId: "x", selectors: ["x"] }), text: "here", style: "spotlight", durationMs: 0 }, { name: "ASH" });
    expect(c.snapshot()).toMatchObject({ guide: null, highlight: { target: "x", style: "spotlight" } });
    c.clear();
    expect(c.snapshot()).toMatchObject({ guide: null, highlight: null });
  });

  it("highlight auto-dismisses after durationMs", async () => {
    vi.useFakeTimers();
    try {
      const f = fakeEnv({ visible: ["x"] });
      const c = new GuideController(f.env);
      await c.highlight({ plan: plan({ targetId: "x", selectors: ["x"] }), text: "", style: "pulse", durationMs: 2000 }, { name: "ASH" });
      expect(c.snapshot().highlight).not.toBeNull();
      vi.advanceTimersByTime(2100);
      expect(c.snapshot().highlight).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-acquires the element after a re-render replaced it", async () => {
    const f = fakeEnv({ visible: ["x"] });
    const c = new GuideController(f.env);
    await c.highlight({ plan: plan({ targetId: "x", selectors: ["x"] }), text: "", style: "pulse", durationMs: 0 }, { name: "ASH" });
    const first = c.state.highlight!.element as unknown as { isConnected: boolean };
    first.isConnected = false;
    const fresh = { sel: "x", isConnected: true } as unknown as Element;
    f.env.query = () => fresh;
    c.refreshElement();
    expect(c.state.highlight!.element).toBe(fresh);
  });
});
