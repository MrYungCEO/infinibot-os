/**
 * Resolve screenshot evidence the way the agent meant it.
 *
 * Screenshots that visual_verify itself produced were rejected as "not an
 * absolute path" / "file does not exist" because agents reference them as
 *   - bare capture ids:   "visual_verify runs visual-muk599y8, visual-muk5espa"
 *   - capture dirs:       "/home/…/verification/<runId>/visual-muk63ue7/"
 *   - globs / braces:     "/tmp/pp-vv-state/verification/plugin-platform-*",
 *                         "/tmp/x/new-{collapsed,end}/a.png"
 *   - names relative to a dir named earlier in the same ref:
 *                         "/tmp/shots/01-off.png, 02-three-sections.png"
 *
 * Every form is resolved to concrete image files. Capture ids are looked up
 * by run id first (`<stateDir>/verification/<runId>/visual-…`), then in the
 * capture dirs seen in the agent's transcript, then across all runs.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { expandEvidenceGlob, extractPathRefs, resolveEvidencePath } from "./evidence-files.js";
import { verificationDir, verificationRunDir } from "./store.js";

const IMAGE_RE = /\.(png|jpe?g|webp)$/i;
const VISUAL_ID_RE = /\bvisual-[a-z0-9]{5,}\b/gi;

export interface ScreenshotResolveContext {
  runId?: string | null;
  /** Run tree root — base for relative paths. */
  top?: string | null;
  /** visual_verify capture dirs seen in the agent's transcript. */
  visualDirs?: string[];
}

export interface ResolvedScreenshots {
  /** Concrete image files (absolute). */
  files: string[];
  /** How each input token was resolved (for the evidence detail). */
  notes: string[];
  /** Tokens that could not be resolved to any image. */
  unresolved: string[];
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Images in a capture dir (one level deep; visual_verify writes them flat). */
export function imagesInDir(dir: string, max = 24): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => IMAGE_RE.test(f) && !f.startsWith("."))
      .sort()
      .slice(0, max)
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/** Find a visual_verify capture dir by id (`visual-xxxx`). */
export function findVisualDir(id: string, ctx: ScreenshotResolveContext): string | null {
  if (ctx.runId) {
    const own = path.join(verificationRunDir(ctx.runId), id);
    if (isDir(own)) return own;
  }
  for (const d of ctx.visualDirs ?? []) if (path.basename(d) === id && isDir(d)) return d;
  try {
    for (const run of readdirSync(verificationDir())) {
      const p = path.join(verificationDir(), run, id);
      if (isDir(p)) return p;
    }
  } catch {
    /* no verification dir yet */
  }
  return null;
}

export function resolveScreenshotRef(
  ref: string,
  ctx: ScreenshotResolveContext = {},
): ResolvedScreenshots {
  const files: string[] = [];
  const notes: string[] = [];
  const unresolved: string[] = [];
  const add = (f: string) => {
    if (!files.includes(f)) files.push(f);
  };
  let lastDir: string | null = null;

  for (const raw of extractPathRefs(ref)) {
    const isAbs = raw.startsWith("/") || raw.startsWith("~/");
    let abs = resolveEvidencePath(raw, isAbs ? null : (lastDir ?? ctx.top ?? null));
    // Relative image name not under the last dir: try the run tree.
    if (!isAbs && !existsSync(abs) && ctx.top) abs = resolveEvidencePath(raw, ctx.top);
    const hits = expandEvidenceGlob(abs);
    if (hits.length === 0) {
      unresolved.push(raw);
      continue;
    }
    let found = 0;
    for (const h of hits) {
      if (isDir(h)) {
        const imgs = imagesInDir(h);
        // A dir of capture dirs (…/verification/<runId>/) → their images.
        const nested = imgs.length
          ? imgs
          : readdirSafe(h)
              .filter((d) => d.startsWith("visual-"))
              .flatMap((d) => imagesInDir(path.join(h, d)));
        nested.forEach(add);
        found += nested.length;
        if (nested.length) notes.push(`${raw}: directory with ${nested.length} image(s)`);
        lastDir = h;
      } else if (existsSync(h)) {
        if (IMAGE_RE.test(h)) {
          add(h);
          found++;
        }
        lastDir = path.dirname(h);
      }
    }
    if (!found) unresolved.push(raw);
  }

  // Bare image names ("…/01-off.png, 02-three.png") → the last dir named, then the run tree.
  for (const m of ref.matchAll(/(?:^|[\s,;(+'"`])([\w.@-]+\.(?:png|jpe?g|webp))(?=$|[\s,;:)'"`])/gi)) {
    const name = m[1];
    if (files.some((f) => path.basename(f) === name)) continue;
    const bases = [lastDir, ctx.top ?? null].filter((b): b is string => Boolean(b));
    const hit = bases.map((b) => path.join(b, name)).find((f) => existsSync(f));
    if (hit) {
      add(hit);
      notes.push(`${name}: resolved next to ${path.dirname(hit)}`);
    } else unresolved.push(name);
  }

  // Bare visual_verify capture ids.
  for (const m of ref.matchAll(VISUAL_ID_RE)) {
    const id = m[0].toLowerCase();
    if (files.some((f) => f.includes(`/${id}/`))) continue;
    const dir = findVisualDir(id, ctx);
    if (!dir) {
      unresolved.push(id);
      continue;
    }
    const imgs = imagesInDir(dir);
    imgs.forEach(add);
    notes.push(`${id}: resolved to ${dir} (${imgs.length} image(s))`);
    if (!imgs.length) unresolved.push(id);
  }
  return { files, notes, unresolved: unresolved.filter((u) => !files.some((f) => f.includes(u))) };
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export interface RunVisualCapture {
  dir: string;
  screenshots: string[];
  createdAt: number;
}

/**
 * visual_verify captures that belong to a run: `<stateDir>/verification/<runId>/visual-*`
 * plus capture dirs the agent's transcript mentions, newer than `since`.
 */
export function runVisualCaptures(
  runId: string,
  opts: { visualDirs?: string[]; since?: number } = {},
): RunVisualCapture[] {
  const dirs = new Set<string>();
  const own = verificationRunDir(runId);
  for (const d of readdirSafe(own)) if (d.startsWith("visual-")) dirs.add(path.join(own, d));
  for (const d of opts.visualDirs ?? []) if (isDir(d)) dirs.add(d);
  const out: RunVisualCapture[] = [];
  for (const dir of dirs) {
    let createdAt = 0;
    try {
      createdAt = statSync(dir).mtimeMs;
    } catch {
      continue;
    }
    if (opts.since && createdAt + 2000 < opts.since) continue;
    const screenshots = imagesInDir(dir);
    if (screenshots.length) out.push({ dir, screenshots, createdAt });
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}
