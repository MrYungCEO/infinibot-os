import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { CODER_CATALOG } from "../agents/coder-install/catalog.js";
import { renderDump, collectStaticSources } from "../../scripts/ui-targets/gen-ui-targets.js";
import NAV from "./generated/nav-targets.json" with { type: "json" };
import { CURATED_CODERS } from "./curated.js";
import { buildUiTargets, envFromSources, setupCheckInputsFromRegistrations } from "./registry.js";
import {
  buildRevealPlan,
  evaluateAvailability,
  findTargetById,
  resolveTarget,
  searchTargets,
} from "./resolve.js";
import type { UiTarget, UiTargetEnv } from "./types.js";

const ROOT = resolve(import.meta.dirname, "../..");
const targets = buildUiTargets(collectStaticSources());
const byId = new Map(targets.map((t) => [t.id, t]));
/** Solatrix on, everything else installed-but-off — the scenario from the bug report. */
const env: UiTargetEnv = {
  cloud: false,
  installedPlugins: new Set(collectStaticSources().plugins.map((p) => p.id)),
  enabledPlugins: new Set(["solatrix"]),
};

describe("ui-targets.json dump", () => {
  it("is up to date (pnpm ui-targets:gen)", () => {
    // Structural compare: the repo formatter may re-wrap the committed JSON.
    expect(JSON.parse(readFileSync(join(ROOT, "src/ui-targets/ui-targets.json"), "utf8"))).toEqual(
      JSON.parse(renderDump()),
    );
  });

  it("has hundreds of targets across every kind", () => {
    expect(targets.length).toBeGreaterThan(600);
    const kinds = new Set(targets.map((t) => t.kind));
    for (const k of ["page", "section", "nav", "control", "plugin", "setup-check", "modal"])
      expect(kinds.has(k as UiTarget["kind"])).toBe(true);
  });
});

describe("registry integrity", () => {
  it("ids and aliases are globally unique", () => {
    const seen = new Map<string, string>();
    for (const t of targets) {
      for (const k of [t.id, ...(t.aliases ?? [])]) {
        expect(seen.get(k), `${k}: ${seen.get(k)} vs ${t.id}`).toBeUndefined();
        seen.set(k, t.id);
      }
    }
  });

  it("every parent exists", () => {
    for (const t of targets)
      if (t.parent) expect(byId.has(t.parent), `${t.id} → parent ${t.parent}`).toBe(true);
  });

  it("every target resolves to a reachable plan (known route or global chrome) with something to show", () => {
    const corePaths = new Set(
      (NAV as { targets: UiTarget[] }).targets
        .filter((t) => t.route)
        .map((t) => t.route!.split("?")[0]),
    );
    const pluginPaths = new Set(
      collectStaticSources().plugins.flatMap((p) =>
        (p.contributes?.pages ?? []).map((pg) => pg.route.split("?")[0]),
      ),
    );
    corePaths.add("/"); // the app root (landing page)
    const bad: string[] = [];
    for (const t of targets) {
      const plan = buildRevealPlan(targets, t);
      if (plan.route) {
        const path = plan.route.split("?")[0]!.replace(/\/+$/, "") || "/";
        if (!corePaths.has(path) && !pluginPaths.has(path))
          bad.push(`${t.id}: route ${plan.route} is not a known page`);
      }
      if (!(plan.selectors.length > 0 || plan.route || plan.reveal.length > 0))
        bad.push(`${t.id} has nothing to navigate to or highlight`);
    }
    expect(bad).toEqual([]);
  });

  it("curated coders mirror the coder install catalog", () => {
    expect(CURATED_CODERS.map((c) => c.id)).toEqual(CODER_CATALOG.map((c) => c.id));
  });
});

// ── data-ib-target attributes in markup ──────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js)$/.test(name) && !/\.test\.|\.bak$|\.orig$/.test(name)) out.push(p);
  }
  return out;
}

describe("data-ib-target attributes", () => {
  const files = [
    ...walk(join(ROOT, "ui/src")),
    ...readdirSync(join(ROOT, "extensions"))
      .map((d) => join(ROOT, "extensions", d, "ui"))
      .filter((d) => {
        try {
          return statSync(d).isDirectory();
        } catch {
          return false;
        }
      })
      .flatMap((d) => walk(d)),
  ];
  const literal: Array<{ id: string; at: string }> = [];
  const templated: Array<{ prefix: string; at: string }> = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/data-ib-target="([^"$]+)"/g))
      literal.push({ id: m[1]!, at: relative(ROOT, f) });
    for (const m of src.matchAll(/data-ib-target=\$\{`([^`$]*)\$\{/g))
      templated.push({ prefix: m[1]!, at: relative(ROOT, f) });
  }

  it("found attributes in the markup", () => {
    expect(literal.length).toBeGreaterThanOrEqual(20);
    expect(templated.length).toBeGreaterThanOrEqual(4);
  });

  it("every literal id is registered", () => {
    for (const { id, at } of literal)
      expect(findTargetById(targets, id), `${id} (${at}) is not in the registry`).not.toBeNull();
  });

  it("every literal id is used at exactly one place (unique in the DOM)", () => {
    const count = new Map<string, string[]>();
    for (const { id, at } of literal) count.set(id, [...(count.get(id) ?? []), at]);
    for (const [id, where] of count)
      expect(where.length, `${id} appears at ${where.join(", ")}`).toBe(1);
  });

  it("templated ids have registered instances", () => {
    for (const { prefix, at } of templated) {
      expect(
        targets.some((t) => t.id.startsWith(prefix)),
        `${prefix}… (${at}) has no registered target`,
      ).toBe(true);
    }
  });
});

// ── natural-language resolution ──────────────────────────────────────────────

describe("natural-language resolution", () => {
  const cases: Array<[string, string]> = [
    ["enable solatrix agent access", "plugin:solatrix/settings/agent-access"],
    ["where do I turn on solatrix trading", "plugin:solatrix/settings/agent-access"],
    ["navigate to where solatrix is enabled", "plugin:solatrix/enable"],
    ["turn on solatrix", "plugin:solatrix/enable"],
    ["set agent access to read-only", "control:solatrix/agent-access/mode/read"],
    ["kill switch", "control:solatrix/agent-access/freeze"],
    ["where are api keys", "page:apikeys"],
    ["add an api key", "control:apikeys/add"],
    ["open coders", "page:setup/coders"],
    ["install claude code", "control:coders/claude-code"],
    ["show the chart source switch", "control:chart/source"],
    ["open the chat with an agent", "modal:chat"],
    ["approvals", "modal:approvals"],
    ["where do I connect whatsapp", "control:channels/whatsapp"],
    ["knowledge graph", "page:memory/graph"],
    ["plugins", "page:plugins"],
    ["open the launchpad", "modal:launchpad"],
    ["take me to the terminal", "page:terminals"],
    ["open config", "page:setup/config"],
    ["search plugins", "control:plugins/search"],
    ["sidebar", "nav:sidebar"],
  ];
  for (const [q, want] of cases) {
    it(`"${q}" → ${want}`, () => {
      const r = resolveTarget(targets, { query: q }, { env });
      expect(
        r.ok ? r.target.id : `${r.reason}: ${r.candidates.map((c) => c.target.id).join(", ")}`,
      ).toBe(want);
      if (r.ok) expect(r.confidence).toBeGreaterThan(0.6);
    });
  }

  it("ids, aliases and bare tab ids resolve exactly", () => {
    // Plugins left Setup on 2026-10-16: the old sub-tab id is an alias of page:plugins.
    const legacy = resolveTarget(targets, { target: "page:setup/plugins" });
    expect(legacy).toMatchObject({ ok: true, via: "alias" });
    expect(legacy.ok && legacy.target.id).toBe("page:plugins");
    const r = resolveTarget(targets, { target: "apikeys" });
    expect(r.ok && r.target.id).toBe("page:apikeys");
    expect(
      resolveTarget(targets, { target: "plugin:solatrix/settings/agent-access" }),
    ).toMatchObject({ ok: true, via: "id", confidence: 1 });
  });

  it("ambiguous queries return candidates instead of guessing", () => {
    const r = resolveTarget(targets, { query: "settings" }, { env });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("ambiguous");
      expect(r.candidates.length).toBeGreaterThan(1);
    }
  });

  it("nonsense is not-found with (possibly empty) candidates", () => {
    const r = resolveTarget(targets, { query: "zzqx flurb" }, { env });
    expect(r.ok).toBe(false);
  });

  it("search ranks and caps", () => {
    const hits = searchTargets(targets, "api key", { limit: 5, env });
    expect(hits.length).toBeLessThanOrEqual(5);
    expect(hits[0]!.confidence).toBeGreaterThanOrEqual(hits[hits.length - 1]!.confidence);
  });
});

// ── availability ─────────────────────────────────────────────────────────────

describe("availability rules", () => {
  it("plugin targets are unavailable while the plugin is off, with a fix target", () => {
    const t = byId.get("page:infinitrade")!;
    const a = evaluateAvailability(t, env);
    expect(a).toMatchObject({ available: false, fixTarget: "plugin:infinitrade/enable" });
    expect(
      evaluateAvailability(byId.get("plugin:solatrix/settings/agent-access")!, env).available,
    ).toBe(true);
  });

  it("the on/off switch of a disabled plugin is always reachable", () => {
    expect(evaluateAvailability(byId.get("plugin:infinitrade/enable")!, env).available).toBe(true);
  });

  it("local-only targets are unavailable on cloud", () => {
    const cloud = { ...env, cloud: true };
    expect(evaluateAvailability(byId.get("page:setup/coders")!, cloud)).toMatchObject({
      available: false,
    });
    expect(evaluateAvailability(byId.get("section:setup/docker")!, cloud).available).toBe(false);
    expect(evaluateAvailability(byId.get("page:apikeys")!, cloud).available).toBe(true);
  });

  it("uninstalled plugin points at Home › Plugins", () => {
    const e = { ...env, installedPlugins: new Set<string>() };
    expect(
      evaluateAvailability(byId.get("page:solatrix")!, { ...e, enabledPlugins: new Set() }),
    ).toMatchObject({ available: false, fixTarget: "page:plugins" });
  });

  it("envFromSources treats loaded+enabled as on", () => {
    const e = envFromSources({
      cloud: true,
      learnTracks: [],
      setupChecks: [],
      plugins: [
        { id: "a", enabled: true, status: "loaded" },
        { id: "b", enabled: false, status: "disabled" },
      ],
    });
    expect([...e.enabledPlugins!]).toEqual(["a"]);
    expect(e.cloud).toBe(true);
  });
});

// ── reveal chains ────────────────────────────────────────────────────────────

describe("reveal plans", () => {
  const plan = (id: string) => buildRevealPlan(targets, byId.get(id)!);

  it("host sub-tab: route with ?view=", () => {
    const p = plan("page:setup/config");
    expect(p.route).toBe("/setup?view=config");
    expect(p.selectors[0]).toContain('data-host-view="config"');
  });

  it("Plugins is its own page; the old Setup sub-tab id still resolves to it", () => {
    const p = plan("page:plugins");
    expect(p.route).toBe("/plugins");
    expect(byId.get("page:plugins")!.aliases).toContain("page:setup/plugins");
  });

  it("plugin page: its route, highlighting the sidebar entry", () => {
    const p = plan("page:solatrix/settings");
    expect(p.route).toBe("/solatrix/settings");
    expect(p.selectors).toEqual(['.nav-item[data-tab-pill="solatrix-settings"]']);
    expect(p.reveal).toContainEqual({ kind: "sidebar", tab: "solatrix-settings" });
  });

  it("settings section → control inherits the plugin-detail reveal chain", () => {
    const p = plan("control:solatrix/agent-access/mode");
    expect(p.route).toBe("/plugins?plugin=solatrix&ptab=settings");
    expect(p.reveal[0]).toMatchObject({
      kind: "event",
      name: "infinibot:plugins-open",
      detail: { plugin: "solatrix", section: "settings" },
    });
    expect(
      p.reveal.some(
        (s) =>
          s.kind === "wait" && s.selectors[0] === '[data-settings-section="solatrix:agent-access"]',
      ),
    ).toBe(true);
    expect(p.selectors[0]).toBe('[data-ib-target="control:solatrix/agent-access/mode"]');
  });

  it("setup section: route + setup-section event", () => {
    const p = plan("section:setup/voice");
    expect(p.route).toBe("/setup");
    expect(p.reveal).toContainEqual({
      kind: "event",
      name: "infinibot:setup-section",
      detail: { section: "voice" },
    });
  });

  it("modal: opens through its surface, no route", () => {
    const p = plan("control:chat/agent-switcher");
    expect(p.route).toBeUndefined();
    expect(p.reveal).toContainEqual({ kind: "open", surface: "agent-chat" });
  });

  it("dialog control: click-to-open is guarded by `unless`", () => {
    const p = plan("control:apikeys/dialog/key");
    const click = p.reveal.find((s) => s.kind === "click");
    expect(click && click.kind === "click" && click.unless?.length).toBeTruthy();
  });

  it("topbar controls that can overflow fall back to the ⋯ menu", () => {
    const p = plan("control:topbar/chart");
    expect(p.fallbackSelectors?.[0]).toContain("cb-more");
  });

  it("setup checks route to the fix page", () => {
    expect(plan("setup-check:models").route).toBe("/apikeys");
    expect(plan("setup-check:coders").route).toBe("/setup?view=coders");
  });
});

describe("live-source robustness", () => {
  it("plugin setup-check registrations ({ pluginId, def }) map to setup-check targets", () => {
    const inputs = setupCheckInputsFromRegistrations([
      {
        pluginId: "solatrix",
        def: {
          id: "solatrix.rpc",
          title: "Solana RPC",
          tabs: ["solatrix-settings"],
          action: { label: "Add RPC", tab: "solatrix-settings" },
        },
      },
      { pluginId: "broken", def: { title: "no id" } },
      { pluginId: "broken2" },
    ]);
    expect(inputs).toHaveLength(1);
    const t = buildUiTargets({ plugins: [], learnTracks: [], setupChecks: inputs }).find(
      (x) => x.id === "setup-check:solatrix.rpc",
    );
    expect(t).toMatchObject({ availability: { plugin: "solatrix" }, pluginId: "solatrix" });
  });

  it("malformed manifests / learn tracks don't throw", () => {
    expect(() =>
      buildUiTargets({
        plugins: [
          {
            id: "x",
            contributes: {
              pages: [{} as never, { tab: "x", route: "/x" }],
              settings: [{} as never],
              topbarSlots: [{} as never],
            },
          },
        ],
        learnTracks: [
          {
            id: "t",
            title: "T",
            walkthroughs: [
              {
                id: "w",
                title: "W",
                steps: [{ id: "s", title: "S", body: "", target: [null as never, "learn:ok"] }],
              },
            ],
          },
          {} as never,
        ],
        setupChecks: [{} as never],
      }),
    ).not.toThrow();
  });
});
