/**
 * Gateway-side UI target registry: navigation-derived targets (generated from
 * the control UI), curated controls, and live sources — installed plugin
 * manifests, guided Learn anchors and setup-status checks — evaluated against
 * this gateway's environment (cloud vs local, which plugins are on).
 *
 * Cached for a few seconds and rebuilt whenever the plugin set changes.
 */

import NAV_TARGETS from "./generated/nav-targets.json" with { type: "json" };
import { assembleTargets } from "./assemble.js";
import { CURATED_TARGETS } from "./curated.js";
import {
  derivePluginTargets,
  deriveLearnTargets,
  deriveSetupCheckTargets,
  type LearnTrackInput,
  type PluginTargetInput,
  type SetupCheckInput,
} from "./derive.js";
import {
  buildRevealPlan,
  resolveTarget,
  searchTargets,
  summarizeTarget,
  evaluateAvailability,
  type SearchOptions,
} from "./resolve.js";
import type { RevealPlan, UiTarget, UiTargetEnv, UiTargetResolution } from "./types.js";

export type UiTargetSources = {
  plugins: Array<PluginTargetInput & { enabled?: boolean; status?: string }>;
  learnTracks: LearnTrackInput[];
  setupChecks: SetupCheckInput[];
  cloud: boolean;
};

const NAV = (NAV_TARGETS as { targets: UiTarget[] }).targets;

/** Tab → path for setup-check routes (nav targets carry every core tab's route). */
function pathForTab(tab: string): string {
  const hit = NAV.find(
    (t) => t.kind === "page" && t.tab === tab && t.route && !t.route.includes("?"),
  );
  return hit?.route ?? `/${tab}`;
}

/**
 * Legacy / redirected routes (`/comms?x=1` from a walkthrough) →
 * the canonical page route (`/channels?view=inbox&x=1`), so plans compare
 * routes correctly and never bounce through a redirect.
 */
export function canonicalizeRoutes(targets: UiTarget[]): UiTarget[] {
  const known = new Set(
    targets.filter((t) => t.kind === "page" && t.route).map((t) => t.route!.split("?")[0]),
  );
  known.add("/");
  const byAlias = new Map<string, UiTarget>();
  for (const t of targets) for (const a of t.aliases ?? []) byAlias.set(a, t);
  return targets.map((t) => {
    if (!t.route) return t;
    const [path, query] = t.route.split("?");
    const clean = (path ?? "/").replace(/\/+$/, "") || "/";
    if (known.has(clean)) return t;
    const page = byAlias.get(`page:${clean.replace(/^\//, "")}`);
    if (!page?.route) return t;
    const [pPath, pQuery] = page.route.split("?");
    const params = new URLSearchParams(pQuery ?? "");
    for (const [k, v] of new URLSearchParams(query ?? "")) params.set(k, v);
    const qs = params.toString();
    return { ...t, route: `${pPath}${qs ? `?${qs}` : ""}` };
  });
}

/** Pure: build the registry from explicit sources (tests, the JSON dump). */
export function buildUiTargets(src: Omit<UiTargetSources, "cloud">): UiTarget[] {
  return canonicalizeRoutes(
    assembleTargets(
      [
        NAV,
        src.plugins.flatMap((p) => derivePluginTargets(p)),
        deriveSetupCheckTargets(src.setupChecks, pathForTab),
        deriveLearnTargets(src.learnTracks),
      ],
      CURATED_TARGETS,
    ),
  );
}

export function envFromSources(src: UiTargetSources): UiTargetEnv {
  return {
    cloud: src.cloud,
    installedPlugins: new Set(src.plugins.map((p) => p.id)),
    enabledPlugins: new Set(
      src.plugins
        .filter((p) => p.enabled !== false && (p.status ?? "loaded") === "loaded")
        .map((p) => p.id),
    ),
  };
}

// ── live gateway sources ────────────────────────────────────────────────────

let sourcesProvider: (() => Promise<UiTargetSources>) | null = null;

/** Tests / alternate hosts can inject sources. */
export function setUiTargetSourcesProvider(fn: (() => Promise<UiTargetSources>) | null): void {
  sourcesProvider = fn;
  cache = null;
}

async function liveSources(): Promise<UiTargetSources> {
  if (sourcesProvider) return sourcesProvider();
  const plugins: UiTargetSources["plugins"] = [];
  let learnTracks: LearnTrackInput[] = [];
  const setupChecks: SetupCheckInput[] = [];
  let cloud = false;
  try {
    const { getActivePluginRegistry } = await import("../plugins/runtime.js");
    for (const r of getActivePluginRegistry()?.plugins ?? []) {
      const rec = r as unknown as PluginTargetInput & {
        enabled?: boolean;
        status?: string;
        manifestVersion?: number;
      };
      if (rec.manifestVersion !== 2) continue;
      plugins.push({
        id: rec.id,
        name: rec.name,
        description: rec.description,
        listing: rec.listing,
        contributes: rec.contributes,
        enabled: rec.enabled,
        status: rec.status,
      });
    }
  } catch {
    /* plugin runtime not loaded (tests) */
  }
  try {
    const { buildGuidedCatalog } = await import("../learn/guided/catalog.js");
    const { learnCatalogPluginInputs } = await import("../gateway/server-methods/plugins.js");
    learnTracks = buildGuidedCatalog(learnCatalogPluginInputs())
      .tracks as unknown as LearnTrackInput[];
  } catch {
    try {
      const { CORE_TRACKS } = await import("../learn/guided/core/index.js");
      learnTracks = CORE_TRACKS as unknown as LearnTrackInput[];
    } catch {
      /* ignore */
    }
  }
  try {
    const reg = await import("../gateway/setup-status/registry.js");
    const { coreSetupChecks } = await import("../gateway/setup-status/core-checks.js");
    cloud = reg.isCloudSetupMode();
    for (const c of coreSetupChecks())
      setupChecks.push({
        id: c.id,
        title: c.title,
        tabs: c.tabs,
        action: c.action,
        localOnly: c.localOnly,
        source: "core",
      });
    setupChecks.push(...setupCheckInputsFromRegistrations(reg.activePluginSetupChecks()));
  } catch {
    /* setup-status not available */
  }
  return { plugins, learnTracks, setupChecks, cloud };
}

/** Plugin setup-check registrations (`{ pluginId, def }`) → derivation input. */
export function setupCheckInputsFromRegistrations(
  regs: ReadonlyArray<{ pluginId: string; def?: unknown }>,
): SetupCheckInput[] {
  const out: SetupCheckInput[] = [];
  for (const r of regs) {
    const d = (r.def ?? {}) as Partial<SetupCheckInput> & { id?: unknown };
    if (typeof d.id !== "string" || !d.id) continue;
    out.push({
      id: d.id,
      title: typeof d.title === "string" ? d.title : d.id,
      tabs: Array.isArray(d.tabs) ? d.tabs : [],
      action: d.action,
      localOnly: d.localOnly,
      source: r.pluginId,
    });
  }
  return out;
}

type Cache = { at: number; sig: string; targets: UiTarget[]; env: UiTargetEnv };
let cache: Cache | null = null;
const CACHE_MS = 5_000;

function signature(src: UiTargetSources): string {
  return JSON.stringify([
    src.cloud,
    src.plugins.map((p) => [p.id, p.enabled, p.status]),
    src.setupChecks.length,
    src.learnTracks.length,
  ]);
}

export async function getUiTargetRegistry(
  opts: { force?: boolean } = {},
): Promise<{ targets: UiTarget[]; env: UiTargetEnv }> {
  if (!opts.force && cache && Date.now() - cache.at < CACHE_MS) return cache;
  const src = await liveSources();
  const sig = signature(src);
  if (!opts.force && cache && cache.sig === sig) {
    cache.at = Date.now();
    return cache;
  }
  cache = { at: Date.now(), sig, targets: buildUiTargets(src), env: envFromSources(src) };
  return cache;
}

// ── public API (gateway RPCs, ui_control, other modules) ────────────────────

export async function listUiTargets(
  filter: { kind?: string; plugin?: string; prefix?: string; available?: boolean } = {},
): Promise<{ targets: Record<string, unknown>[]; env: { cloud: boolean } }> {
  const { targets, env } = await getUiTargetRegistry();
  const list = targets
    .filter((t) => !filter.kind || t.kind === filter.kind)
    .filter(
      (t) =>
        !filter.plugin || t.pluginId === filter.plugin || t.availability?.plugin === filter.plugin,
    )
    .filter((t) => !filter.prefix || t.id.startsWith(filter.prefix))
    .map((t) => summarizeTarget(t, env))
    .filter((t) => filter.available === undefined || t.available === filter.available);
  return { targets: list, env: { cloud: env.cloud } };
}

export async function searchUiTargets(query: string, opts: Omit<SearchOptions, "env"> = {}) {
  const { targets, env } = await getUiTargetRegistry();
  return searchTargets(targets, query, { ...opts, env }).map((m) => ({
    ...summarizeTarget(m.target, env),
    confidence: Number(m.confidence.toFixed(3)),
  }));
}

export type ResolvedUiTarget =
  | {
      ok: true;
      target: UiTarget;
      plan: RevealPlan;
      confidence: number;
      via: "id" | "alias" | "query";
      available: boolean;
      unavailableReason?: string;
      fixTarget?: string;
      alternatives: Record<string, unknown>[];
    }
  | {
      ok: false;
      reason: Extract<UiTargetResolution, { ok: false }>["reason"];
      candidates: Record<string, unknown>[];
    };

export async function resolveUiTarget(input: {
  target?: string;
  query?: string;
}): Promise<ResolvedUiTarget> {
  const { targets, env } = await getUiTargetRegistry();
  const r = resolveTarget(targets, input, { env });
  if (!r.ok) {
    return {
      ok: false,
      reason: r.reason,
      candidates: r.candidates.map((m) => ({
        ...summarizeTarget(m.target, env),
        confidence: Number(m.confidence.toFixed(3)),
      })),
    };
  }
  const a = evaluateAvailability(r.target, env);
  return {
    ok: true,
    target: r.target,
    plan: buildRevealPlan(targets, r.target),
    confidence: Number(r.confidence.toFixed(3)),
    via: r.via,
    available: a.available,
    ...(a.reason ? { unavailableReason: a.reason } : {}),
    ...(a.fixTarget ? { fixTarget: a.fixTarget } : {}),
    alternatives: r.alternatives.map((m) => ({
      id: m.target.id,
      title: m.target.title,
      confidence: Number(m.confidence.toFixed(3)),
    })),
  };
}

export async function getUiTarget(id: string): Promise<UiTarget | null> {
  const { targets } = await getUiTargetRegistry();
  return targets.find((t) => t.id === id || t.aliases?.includes(id)) ?? null;
}

export function resetUiTargetRegistryForTests(): void {
  cache = null;
  sourcesProvider = null;
}
