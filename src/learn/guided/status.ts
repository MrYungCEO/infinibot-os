/**
 * Guided Learn — badges, certification ladder and "recommended next".
 * Pure: shared by the gateway (minting) and the control UI (rendering).
 *
 * Certification path (guided tracks):
 *   • Apprentice   — every core `beginner` track flagged `certRequired`
 *   • Practitioner — + every core `intermediate` certRequired track
 *   • Master       — + every core `advanced` certRequired track
 *                    + at least one plugin mastery badge (when any plugin
 *                      track is available)
 * Plugin tracks award a "<Plugin> mastery" badge of their own.
 */

import {
  trackStatus,
  type GuidedProgress,
  type LearnLevel,
  type LearnTrack,
  type TrackStatus,
} from "./types.js";

export type GuidedCertTier = "apprentice" | "practitioner" | "master";

export type EarnedBadge = {
  id: string;
  label: string;
  icon?: string;
  trackId: string;
  pluginId?: string;
  /** Plugin mastery badges count toward Master. */
  mastery: boolean;
};

export type GuidedCertRung = {
  tier: GuidedCertTier;
  required: string[];
  done: string[];
  missing: string[];
  /** Master only: plugin mastery needed and whether it is met. */
  needsPluginMastery: boolean;
  hasPluginMastery: boolean;
  percent: number;
  eligible: boolean;
};

type TrackLike = Pick<
  LearnTrack,
  "id" | "walkthroughs" | "badge" | "pluginId" | "level" | "certRequired"
> & {
  quiz: readonly unknown[];
};

const RANK: Record<LearnLevel, number> = { beginner: 1, intermediate: 2, advanced: 3 };
const TIER_RANK: Record<GuidedCertTier, number> = { apprentice: 1, practitioner: 2, master: 3 };

export function computeTrackStatuses(
  tracks: TrackLike[],
  progress: GuidedProgress | null,
): TrackStatus[] {
  return tracks.map((t) => trackStatus(t, progress));
}

export function computeBadges(tracks: TrackLike[], progress: GuidedProgress | null): EarnedBadge[] {
  const out: EarnedBadge[] = [];
  for (const t of tracks) {
    if (!trackStatus(t, progress).completed) continue;
    out.push({
      id: t.badge.id,
      label: t.badge.label,
      icon: t.badge.icon,
      trackId: t.id,
      ...(t.pluginId ? { pluginId: t.pluginId } : {}),
      mastery: Boolean(t.pluginId),
    });
  }
  return out;
}

export function computeCertLadder(
  tracks: TrackLike[],
  progress: GuidedProgress | null,
): GuidedCertRung[] {
  const core = tracks.filter((t) => !t.pluginId && t.certRequired);
  const pluginTracks = tracks.filter((t) => t.pluginId);
  const completed = new Set(
    tracks.filter((t) => trackStatus(t, progress).completed).map((t) => t.id),
  );
  const hasMastery = pluginTracks.some((t) => completed.has(t.id));
  return (["apprentice", "practitioner", "master"] as GuidedCertTier[]).map((tier) => {
    const required = core.filter((t) => RANK[t.level] <= TIER_RANK[tier]).map((t) => t.id);
    const done = required.filter((id) => completed.has(id));
    const missing = required.filter((id) => !completed.has(id));
    const needsPluginMastery = tier === "master" && pluginTracks.length > 0;
    const units = required.length + (needsPluginMastery ? 1 : 0);
    const got = done.length + (needsPluginMastery && hasMastery ? 1 : 0);
    return {
      tier,
      required,
      done,
      missing,
      needsPluginMastery,
      hasPluginMastery: hasMastery,
      percent: units === 0 ? 0 : Math.round((got / units) * 100),
      eligible: units > 0 && got === units,
    };
  });
}

/**
 * Pick up to `limit` tracks to recommend next.
 *
 * Order: an in-progress track first; then tracks for areas the user has NOT
 * touched yet (by `signals`, most foundational level first) whose
 * prerequisites are done; then anything incomplete. Plugin tracks for a
 * plugin the user just enabled rank with the untouched areas.
 */
export function recommendTracks(
  tracks: (TrackLike & Pick<LearnTrack, "prerequisites" | "signals" | "order">)[],
  progress: GuidedProgress | null,
  touched: string[],
  limit = 3,
  /** Extra score per track id (e.g. the owner's onboarding use cases). */
  boost?: ReadonlyMap<string, number>,
): string[] {
  const statuses = new Map(tracks.map((t) => [t.id, trackStatus(t, progress)] as const));
  const completed = (id: string) => statuses.get(id)?.completed ?? false;
  const incomplete = tracks.filter((t) => !completed(t.id));
  const ready = (t: (typeof tracks)[number]) =>
    (t.prerequisites ?? []).every((p) => completed(p) || !statuses.has(p));
  const used = new Set(touched);
  const score = (t: (typeof tracks)[number]): number => {
    const st = statuses.get(t.id)!;
    let s = 0;
    const started =
      st.percent > 0 ||
      t.walkthroughs.some(
        (w) => progress?.walkthroughs[`${t.id}/${w.id}`]?.status === "in_progress",
      );
    if (started) s += 1000; // finish what you started
    const signals = t.signals ?? [];
    const untouched = signals.length > 0 && signals.every((sig) => !used.has(sig));
    if (untouched) s += 300;
    if (ready(t)) s += 200;
    s += (4 - RANK[t.level]) * 40;
    s -= Math.min(t.order ?? 500, 999) / 10;
    s += boost?.get(t.id) ?? 0;
    return s;
  };
  return [...incomplete]
    .sort((a, b) => score(b) - score(a))
    .slice(0, limit)
    .map((t) => t.id);
}
