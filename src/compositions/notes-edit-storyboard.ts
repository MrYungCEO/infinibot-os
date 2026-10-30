/**
 * Provider-neutral storyboard shape for notes-edit jobs.
 *
 * This is the local interchange contract used by the notes editor. Media
 * provider plugins may consume it without placing provider-specific types or
 * persistence formats in core.
 *
 * Mapping:
 *   each KEEP span in a clip's EDL  →  one StoryboardScene
 *   the whole multi-clip job        →  one StoryboardProject
 *
 * Drops never appear in the storyboard projection — they are an editing-time
 * concept that's resolved by the cutter before this view is built.
 *
 * These types live here because this is a core composition format rather
 * than a provider SDK contract.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EdlEntry, Manifest } from "./notes-edit.js";

// ── Storyboard interchange types ─────────────────────────────────────

export type Platform = "youtube" | "tiktok" | "shorts" | "instagram" | "custom";
export type ProjectStatus =
  | "draft"
  | "scripting"
  | "splitting"
  | "generating"
  | "complete"
  | "failed";
export type SceneStatus = "pending" | "generating" | "complete" | "failed";
export type ImageBackend = string;
export type TtsProvider = "elevenlabs" | "edge" | "openai";

export type EffectPreset =
  | "none"
  | "ken-burns"
  | "dramatic-push"
  | "parallax"
  | "punch-zoom"
  | "slow-drift"
  | "pull-back"
  | "spin-reveal"
  | "glitch"
  | "atmospheric-mist"
  | "cinematic-grain"
  | "light-leak"
  | "dust-particles";

export interface StoryboardScene {
  id: string;
  projectId: string;
  index: number;
  title: string;
  description: string;
  dialogue?: string;
  voiceover?: string;
  durationSeconds: number;
  imagePrompt: string;
  imageUrl?: string;
  thumbnailUrl?: string;
  audioUrl?: string;
  imageStatus: SceneStatus;
  imageError?: string;
  effectPreset?: EffectPreset;
  overlayPreset?: EffectPreset;
}

export interface CharacterRef {
  id: string;
  name: string;
  description: string;
  referenceImageUrl?: string;
  referenceImageUrls?: string[];
  color?: string;
}

export interface StoryboardProject {
  id: string;
  name: string;
  prompt: string;
  targetDuration: number;
  platform: Platform;
  aspectRatio: string;
  imageStyle: string;
  imageBackend: ImageBackend;
  language: string;
  ttsProvider: TtsProvider;
  ttsVoice: string;
  ttsModel?: string;
  script?: string;
  scenes: StoryboardScene[];
  characters: CharacterRef[];
  status: ProjectStatus;
  error?: string;
  progress: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  totalCreditsUsed?: number;
}

// ── notes-edit ↔ storyboard adapter ───────────────────────────────────

export interface NotesEditClipSnapshot {
  manifest: Manifest;
  entries: EdlEntry[];
}

/**
 * Per-clip projection: one StoryboardScene per KEEP entry in this clip's
 * EDL. Stable scene IDs (slug-XX) so a re-projection is diff-friendly.
 */
export function clipToScenes(
  snap: NotesEditClipSnapshot,
  projectId: string,
  startIndex = 0,
): StoryboardScene[] {
  const slug = snap.manifest.slug;
  const scenes: StoryboardScene[] = [];
  let i = startIndex;
  const keeps = snap.entries.filter((e) => e.action === "keep");
  for (const e of keeps) {
    const dur = +(e.end - e.start).toFixed(3);
    const text = (e.text ?? "").trim();
    scenes.push({
      id: `${slug}-${String(i).padStart(4, "0")}`,
      projectId,
      index: i,
      title: text.slice(0, 60) || `Scene ${i + 1}`,
      description: `[${slug}] ${fmtTimestamp(e.start)}–${fmtTimestamp(e.end)}`,
      voiceover: text,
      durationSeconds: dur,
      imagePrompt: "",
      imageStatus: "complete",
      effectPreset: "ken-burns",
      overlayPreset: "none",
    });
    i++;
  }
  return scenes;
}

/**
 * Multi-clip projection: every job becomes one combined StoryboardProject.
 */
export function jobsToProject(
  snaps: NotesEditClipSnapshot[],
  opts: {
    projectId?: string;
    name?: string;
    platform?: Platform;
    aspectRatio?: string;
  } = {},
): StoryboardProject {
  const id = opts.projectId ?? `notes-edit-${snaps.map((s) => s.manifest.slug).join("+")}`;
  let cursor = 0;
  const scenes: StoryboardScene[] = [];
  for (const s of snaps) {
    const batch = clipToScenes(s, id, cursor);
    scenes.push(...batch);
    cursor += batch.length;
  }
  const totalDur = scenes.reduce((a, s) => a + s.durationSeconds, 0);
  const now = Date.now();
  return {
    id,
    name: opts.name ?? `notes-edit · ${snaps.map((s) => s.manifest.slug).join(" + ")}`,
    prompt: "Auto-cut of spoken editor notes",
    targetDuration: Math.round(totalDur),
    platform: opts.platform ?? "custom",
    aspectRatio: opts.aspectRatio ?? "16:9",
    imageStyle: "source-footage",
    imageBackend: "source-footage",
    language: snaps[0]?.manifest.params.language ?? "en",
    ttsProvider: "openai",
    ttsVoice: "alloy",
    script: scenes
      .map((s, i) => `[${String(i + 1).padStart(2, "0")}] ${s.voiceover ?? s.title}`)
      .join("\n"),
    scenes,
    characters: [],
    status: "complete",
    progress: 1,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  };
}

/**
 * Apply a storyboard update back to the source EDLs. Only durationSeconds
 * changes (trim) and scene deletions are propagated — title/description/
 * effect edits don't have a corresponding field on the EDL yet.
 *
 * The storyboard scene's id encodes its source slug; we use that to route the
 * edit back to the right manifest.
 */
export function applyProjectEditsToEdls(
  project: StoryboardProject,
  snaps: NotesEditClipSnapshot[],
): { slug: string; entries: EdlEntry[] }[] {
  // Build a quick lookup of remaining scenes by source slug.
  const bySlug = new Map<string, StoryboardScene[]>();
  for (const s of project.scenes) {
    const slug = s.id.replace(/-\d+$/, "");
    const arr = bySlug.get(slug) ?? [];
    arr.push(s);
    bySlug.set(slug, arr);
  }

  const out: { slug: string; entries: EdlEntry[] }[] = [];
  for (const snap of snaps) {
    const entries = snap.entries.map((e) => ({ ...e }));
    const keeps = entries.filter((e) => e.action === "keep");
    const remaining = bySlug.get(snap.manifest.slug) ?? [];

    // 1. Deletions: any keep whose corresponding scene is gone → flip to drop.
    for (let i = 0; i < keeps.length; i++) {
      if (i >= remaining.length) {
        keeps[i].action = "drop";
        keeps[i].reason = "manual";
      }
    }
    // 2. Trims: durationSeconds change → adjust e.end (keep start anchored).
    for (let i = 0; i < Math.min(keeps.length, remaining.length); i++) {
      const want = remaining[i].durationSeconds;
      const have = keeps[i].end - keeps[i].start;
      if (Math.abs(want - have) > 0.01) {
        keeps[i].end = +(keeps[i].start + want).toFixed(3);
      }
    }
    out.push({ slug: snap.manifest.slug, entries });
  }
  return out;
}

// ── Persistence ───────────────────────────────────────────────────────

export interface WriteResult {
  path: string;
  bytes: number;
}

/**
 * Write project.storyboard.json beside manifest.json so provider plugins and
 * other downstream consumers can use the composition without core coupling.
 */
export function writeProjectJson(workspaceDir: string, project: StoryboardProject): WriteResult {
  const path = join(workspaceDir, "project.storyboard.json");
  const body = JSON.stringify(project, null, 2);
  writeFileSync(path, body, "utf-8");
  return { path, bytes: body.length };
}

export function readProjectJson(workspaceDir: string): StoryboardProject | null {
  const path = join(workspaceDir, "project.storyboard.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as StoryboardProject;
}

// ── helpers ───────────────────────────────────────────────────────────

function fmtTimestamp(t: number): string {
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(2).padStart(5, "0");
  return `${m}:${s}`;
}
