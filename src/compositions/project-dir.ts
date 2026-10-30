/**
 * Per-composition project directory.
 *
 * Each composition gets its own folder under
 *   ~/.infinibot/compositions/<comp-id>/
 *     ├── assets/                   — uploaded image / video / audio files
 *     ├── notes/                    — agent's working notes
 *     ├── metadata.json             — per-asset rich metadata (the file the
 *     │                               editor agent reads to decide what to
 *     │                               drop where)
 *     └── TASK.md                   — editing brief — both the user and the
 *                                     embedded Claude TUI write to this
 *
 * The directory is the working dir for the embedded Claude Coder TUI in the
 * editor's right pane, so the agent can reach `metadata.json` directly via
 * the Read tool and reason about asset choices in context.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";

// ── Asset metadata model ───────────────────────────────────────────

export type AssetKind = "image" | "video" | "audio" | "other";
export type AssetEnergy = "low" | "medium" | "high";

/**
 * Per-asset metadata. Anything the upload flow can extract on the spot
 * (dimensions, duration, file size) lives at the top level. The richer
 * editor-context fields (tags / mood / palette / transcript / suggested
 * uses) are populated by the agent through `compositions.assets.updateMetadata`
 * — the editor agent reads them back from `metadata.json` and uses them
 * to pick the right asset for the right beat.
 */
export interface AssetMetadata {
  /** On-disk filename (timestamped + uuid prefixed; unique per project). */
  filename: string;
  /** Human-readable name (preserved from upload). */
  name: string;
  /** Public URL — `/media/compositions/<compId>/assets/<filename>`. */
  url: string;
  kind: AssetKind;
  size: number;
  uploadedAt: number;
  mime?: string;

  // Auto-extracted (client-side at upload time, optionally refreshed later).
  width?: number;
  height?: number;
  durationSec?: number;

  // Editor-context fields the agent populates.
  /** Free-form short description: "studio lit talking head, neutral wall". */
  description?: string;
  /** Tags the agent searches against: ["b-roll","cityscape","golden-hour"]. */
  tags?: string[];
  /** Mood: "energetic" | "moody" | "warm" | "cinematic" | "playful" etc. */
  mood?: string;
  /** Scene type: "establishing" | "close-up" | "b-roll" | "talking-head". */
  scene?: string;
  /** Hex colors (top 3-5) — useful for matching transitions. */
  colorPalette?: string[];
  /** Coarse energy bucket. */
  energy?: AssetEnergy;
  /** Where the agent thinks this asset works best. */
  suggestedUses?: string[];
  /** For video / audio — full-length transcript when one's been generated. */
  transcript?: string;
  /** Editor's freeform notes, visible to the agent. */
  notes?: string;
}

export interface ProjectMetadata {
  /** v1 — bumped if we change the file shape. */
  version: 1;
  assets: AssetMetadata[];
  /** Timestamp of the last in-place mutation. */
  updatedAt: number;
}

// ── Path helpers ──────────────────────────────────────────────────

export function compositionsRoot(): string {
  return process.env.INFINIBOT_MEDIA_ROOT
    ? resolve(process.env.INFINIBOT_MEDIA_ROOT, "compositions")
    : resolve(homedir(), ".infinibot", "media", "compositions");
}

export function projectDir(compositionId: string): string {
  return join(compositionsRoot(), compositionId);
}

export function assetsDir(compositionId: string): string {
  return join(projectDir(compositionId), "assets");
}

export function notesDir(compositionId: string): string {
  return join(projectDir(compositionId), "notes");
}

export function metadataPath(compositionId: string): string {
  return join(projectDir(compositionId), "metadata.json");
}

export function taskPath(compositionId: string): string {
  return join(projectDir(compositionId), "TASK.md");
}

/**
 * Public URL for the gateway media handler. Composition-scoped so files
 * from different projects don't collide.
 */
export function assetPublicUrl(compositionId: string, filename: string): string {
  return `/media/compositions/${encodeURIComponent(compositionId)}/assets/${encodeURIComponent(filename)}`;
}

// ── Lifecycle ─────────────────────────────────────────────────────

/**
 * Create the project directory and seed the metadata + TASK.md scaffolds.
 * Idempotent — safe to call on every composition open.
 */
export function ensureProjectDir(
  compositionId: string,
  compositionName: string,
): void {
  const root = projectDir(compositionId);
  for (const dir of [root, assetsDir(compositionId), notesDir(compositionId)]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  const meta = metadataPath(compositionId);
  if (!existsSync(meta)) {
    writeProjectMetadata(compositionId, {
      version: 1,
      assets: [],
      updatedAt: Date.now(),
    });
  }
  const task = taskPath(compositionId);
  if (!existsSync(task)) {
    writeFileSync(
      task,
      `# ${compositionName} — editing brief

This file is the shared brief between the operator and the embedded Claude
Coder agent. The agent reads it on every prompt to ground its edits.

## Goal


## Style references


## Constraints


## Assets

Asset metadata lives in \`metadata.json\`. Read it before suggesting where
to place clips — every asset has \`description\`, \`tags\`, \`mood\`,
\`scene\`, \`colorPalette\`, \`energy\`, and \`suggestedUses\` fields that
help match an asset to a moment in the timeline.
`,
      "utf-8",
    );
  }
}

/** Delete the entire project dir — called from compositions.delete. */
export function removeProjectDir(compositionId: string): void {
  const root = projectDir(compositionId);
  if (!existsSync(root)) return;
  rmrf(root);
}

function rmrf(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) rmrf(p);
    else {
      try { unlinkSync(p); } catch { /* ignore */ }
    }
  }
  try {
    // Use a tiny shim — node:fs doesn't expose rmdirSync everywhere.
    require("node:fs").rmdirSync(dir);
  } catch {
    /* swallow */
  }
}

// ── Metadata read / write ─────────────────────────────────────────

export function readProjectMetadata(compositionId: string): ProjectMetadata {
  const p = metadataPath(compositionId);
  // Sweep stale tmp files before reading. These accumulate when a
  // previous writer crashed between writeFileSync(tmp) and renameSync —
  // a Windows-on-network-FS race we kept seeing. Sweeping on read keeps
  // the project dir tidy without changing user-facing behavior.
  cleanupStaleTmpFiles(p);
  if (!existsSync(p)) {
    return { version: 1, assets: [], updatedAt: Date.now() };
  }
  try {
    const raw = readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw) as ProjectMetadata;
    if (typeof parsed === "object" && Array.isArray(parsed?.assets)) {
      return parsed;
    }
  } catch {
    /* corrupt — fall through to empty */
  }
  return { version: 1, assets: [], updatedAt: Date.now() };
}

/** Per-composition serialization queue so concurrent writers don't race. */
const writeQueues = new Map<string, Promise<void>>();

export function writeProjectMetadata(
  compositionId: string,
  meta: ProjectMetadata,
): void {
  const p = metadataPath(compositionId);
  meta.updatedAt = Date.now();
  // Atomic write: stream to a per-process tmp file, then rename(). On
  // POSIX rename is atomic; on Windows it's atomic when the destination
  // is on the same volume (which it always is here). Cleanup on every
  // failure path so we don't leak `.tmp.*` litter.
  const tmp = `${p}.tmp.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(16).slice(2, 8)}`;
  const body = JSON.stringify(meta, null, 2);
  try {
    writeFileSync(tmp, body, "utf-8");
    try {
      renameSync(tmp, p);
    } catch (renameErr) {
      // Rename failed — most often because another process briefly held
      // the destination file open (anti-virus, indexer, second writer).
      // Fall back to a plain write to keep state consistent, and clean
      // the tmp so it doesn't show up next read.
      try { unlinkSync(tmp); } catch { /* ignore */ }
      writeFileSync(p, body, "utf-8");
      void renameErr;
    }
  } catch (err) {
    // If even the initial tmp write failed, surface a clean error rather
    // than leaving the caller with a half-applied state.
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Async-safe variant for callers that want to serialize writes per
 * composition. The synchronous `writeProjectMetadata` above is still the
 * default; call this when a handler needs to wait for prior writes to
 * settle before reading-then-writing (avoids lost-update bugs).
 */
export function queueWriteProjectMetadata(
  compositionId: string,
  mutate: (meta: ProjectMetadata) => ProjectMetadata,
): Promise<void> {
  const prev = writeQueues.get(compositionId) ?? Promise.resolve();
  const next = prev.then(async () => {
    const cur = readProjectMetadata(compositionId);
    const updated = mutate(cur);
    writeProjectMetadata(compositionId, updated);
  }).catch((e) => {
    // Don't poison the queue — log and continue so the next write isn't blocked.
    console.warn(`[compositions] queued write for ${compositionId} failed:`, e);
  });
  writeQueues.set(compositionId, next);
  return next;
}

/**
 * Remove orphan `metadata.json.tmp.*` files. Considers a tmp file stale
 * when it's older than 60 seconds (any active writer would have renamed
 * it by then). Failures are swallowed — a stale tmp is annoying but
 * never fatal.
 */
function cleanupStaleTmpFiles(metadataFilePath: string): void {
  try {
    const dir = metadataFilePath.slice(0, metadataFilePath.lastIndexOf(/[\\/]/.exec(metadataFilePath)?.[0] ?? "/"));
    const base = metadataFilePath.split(/[\\/]/).pop() ?? "metadata.json";
    if (!existsSync(dir)) return;
    const cutoff = Date.now() - 60_000;
    for (const entry of readdirSync(dir)) {
      if (!entry.startsWith(`${base}.tmp.`)) continue;
      const full = join(dir, entry);
      try {
        const st = statSync(full);
        if (st.mtimeMs < cutoff) unlinkSync(full);
      } catch {
        /* ignore — file may have been cleaned by another reader */
      }
    }
  } catch {
    /* directory walk failed; nothing to do */
  }
}

// ── Mutators (all called by gateway RPCs) ─────────────────────────

export function listAssets(compositionId: string): AssetMetadata[] {
  return readProjectMetadata(compositionId).assets;
}

export function findAsset(
  compositionId: string,
  filename: string,
): AssetMetadata | null {
  return readProjectMetadata(compositionId).assets.find((a) => a.filename === filename) ?? null;
}

export function addAsset(
  compositionId: string,
  asset: AssetMetadata,
): AssetMetadata {
  const meta = readProjectMetadata(compositionId);
  meta.assets.unshift(asset);
  writeProjectMetadata(compositionId, meta);
  return asset;
}

export function updateAssetMetadata(
  compositionId: string,
  filename: string,
  patch: Partial<AssetMetadata>,
): AssetMetadata | null {
  const meta = readProjectMetadata(compositionId);
  const idx = meta.assets.findIndex((a) => a.filename === filename);
  if (idx < 0) return null;
  meta.assets[idx] = { ...meta.assets[idx]!, ...patch, filename };
  writeProjectMetadata(compositionId, meta);
  return meta.assets[idx]!;
}

export function removeAsset(
  compositionId: string,
  filename: string,
): boolean {
  const meta = readProjectMetadata(compositionId);
  const before = meta.assets.length;
  meta.assets = meta.assets.filter((a) => a.filename !== filename);
  writeProjectMetadata(compositionId, meta);
  // Also unlink the underlying file.
  const filePath = join(assetsDir(compositionId), filename);
  if (existsSync(filePath)) {
    try { unlinkSync(filePath); } catch { /* swallow */ }
  }
  return meta.assets.length < before;
}

/**
 * Best-effort metadata refresh — reads the file's current size + extension
 * and stamps it. We deliberately don't run ffprobe here (kept lightweight);
 * full duration / dimensions are filled in client-side at upload time.
 */
export function refreshAssetFromDisk(
  compositionId: string,
  filename: string,
): AssetMetadata | null {
  const filePath = join(assetsDir(compositionId), filename);
  if (!existsSync(filePath)) return null;
  const stat = statSync(filePath);
  return updateAssetMetadata(compositionId, filename, {
    size: stat.size,
    uploadedAt: stat.mtimeMs,
  });
}
