/**
 * Guided Learn — the catalog a user sees: core tracks + tracks contributed by
 * enabled plugins (`contributes.learn`). A plugin's tracks disappear the
 * moment it is disabled, fails to load, or the owner switches the individual
 * `learn:<trackId>` contribution off.
 */

import { CORE_TRACKS, CORE_MISSIONS } from "./core/index.js";
import type { LearnMissionRef, LearnTrack, PluginLearnContribution } from "./types.js";

export type CatalogPluginInput = {
  id: string;
  name?: string;
  enabled: boolean;
  status: string;
  learn?: PluginLearnContribution;
  /** Contribution keys the owner switched off (`learn:<trackId>`). */
  disabledContributions?: string[];
  monogram?: string;
  icon?: string;
  accent?: { dark?: string; light?: string };
};

export type CatalogPlugin = {
  id: string;
  name: string;
  monogram?: string;
  icon?: string;
  accent?: { dark?: string; light?: string };
  trackIds: string[];
};

export type GuidedCatalog = {
  tracks: LearnTrack[];
  plugins: CatalogPlugin[];
  missions: LearnMissionRef[];
};

export function isPluginLive(p: Pick<CatalogPluginInput, "enabled" | "status">): boolean {
  return p.enabled && p.status === "loaded";
}

export function buildGuidedCatalog(
  plugins: CatalogPluginInput[],
  core: { tracks: LearnTrack[]; missions: LearnMissionRef[] } = {
    tracks: CORE_TRACKS,
    missions: CORE_MISSIONS,
  },
): GuidedCatalog {
  const tracks: LearnTrack[] = [...core.tracks];
  const missions: LearnMissionRef[] = [...core.missions];
  const outPlugins: CatalogPlugin[] = [];
  const seen = new Set(tracks.map((t) => t.id));
  for (const p of plugins) {
    if (!isPluginLive(p) || !p.learn) continue;
    const off = new Set(p.disabledContributions ?? []);
    const mine: LearnTrack[] = [];
    for (const t of p.learn.tracks) {
      if (off.has(`learn:${t.id}`) || seen.has(t.id)) continue;
      seen.add(t.id);
      mine.push({ ...t, pluginId: p.id });
    }
    if (mine.length === 0) continue;
    tracks.push(...mine);
    for (const m of p.learn.missions) {
      if (mine.some((t) => m.walkthrough.startsWith(`${t.id}/`))) missions.push(m);
    }
    outPlugins.push({
      id: p.id,
      name: p.name ?? p.id,
      ...(p.monogram ? { monogram: p.monogram } : {}),
      ...(p.icon ? { icon: p.icon } : {}),
      ...(p.accent ? { accent: p.accent } : {}),
      trackIds: mine.map((t) => t.id),
    });
  }
  tracks.sort(
    (a, b) =>
      (a.pluginId ? 1 : 0) - (b.pluginId ? 1 : 0) ||
      (a.order ?? 500) - (b.order ?? 500) ||
      a.title.localeCompare(b.title),
  );
  return { tracks, plugins: outPlugins, missions };
}

export function findWalkthrough(
  catalog: Pick<GuidedCatalog, "tracks">,
  trackId: string,
  walkthroughId: string,
) {
  const track = catalog.tracks.find((t) => t.id === trackId);
  const walkthrough = track?.walkthroughs.find((w) => w.id === walkthroughId);
  return track && walkthrough ? { track, walkthrough } : null;
}
