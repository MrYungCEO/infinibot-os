/**
 * UI verification screenshot index — the gallery around the Reviewer on the
 * Executive Island.
 *
 * Sources (UI/screen tasks only):
 *   - visual_verify captures: `<stateDir>/verification/<runId>/visual-*`
 *     (report.json gives route / viewport / theme per shot; result.json the
 *     vision assessment)
 *   - screenshots listed in a run's RESULT when the run changed visual files.
 *     Files outside the verification dir are copied into
 *     `<runId>/result-shots/` so the safe file route can serve them.
 *
 * Built lazily on first use (and kicked at boot), refreshed incrementally by
 * directory mtime, and pushed live as `verification.screenshots` when new
 * captures appear.
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { partitionConsoleMessages } from "./console-noise.js";
import { getRecord, listRecords, verificationDir, verificationRunDir, type CompletionRecord } from "./store.js";

export interface ScreenshotEntry {
  id: string;
  path: string;
  url: string;
  thumbUrl: string;
  runId: string;
  label: string;
  agent: string;
  route: string | null;
  viewport: string | null;
  theme: string | null;
  ts: number;
  verdict: "pass" | "fail" | "unknown";
  runState: string | null;
  runVerdict: string | null;
  visualDir: string | null;
  assessment?: { pass: boolean | null; summary: string; issues: string[] } | null;
  consoleErrors?: number;
  baselinePath?: string | null;
  baselineUrl?: string | null;
  source: "visual_verify" | "result";
}

export interface ScreenshotQuery {
  limit?: number;
  cursor?: number;
  verdict?: "pass" | "fail" | "unknown";
  route?: string;
  viewport?: string;
  agent?: string;
  runId?: string;
  q?: string;
  since?: number;
  until?: number;
}

export const SCREENSHOTS_EVENT = "verification.screenshots";

type BroadcastFn = (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
let broadcaster: BroadcastFn | null = null;
export function setScreenshotBroadcaster(fn: BroadcastFn | null): void {
  broadcaster = fn;
}

const IMAGE_RE = /\.(png|jpe?g|webp)$/i;

export function fileUrl(p: string, thumb = false): string {
  return `/api/verification/file?path=${encodeURIComponent(p)}${thumb ? "&thumb=1" : ""}`;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function mtime(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

interface ReportShot {
  route?: string;
  viewport?: string;
  theme?: string;
  path?: string;
  error?: string;
  consoleErrors?: string[];
  pageErrors?: string[];
}

/** Entries for one visual_verify capture dir. */
export function entriesForVisualDir(dir: string, rec: CompletionRecord | undefined, runId: string): ScreenshotEntry[] {
  const report = readJson<{ shots?: ReportShot[] }>(path.join(dir, "report.json"));
  const result = readJson<{
    assessment?: { available?: boolean; pass?: boolean | null; summary?: string; issues?: string[] } | null;
  }>(path.join(dir, "result.json"));
  const a = result?.assessment;
  const assessment = a && a.available !== false ? { pass: a.pass ?? null, summary: a.summary ?? "", issues: (a.issues ?? []).slice(0, 8) } : null;
  const byPath = new Map<string, ReportShot>();
  for (const s of report?.shots ?? []) if (s.path) byPath.set(path.resolve(s.path), s);
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => IMAGE_RE.test(f)).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
  const baselineDir = readJson<{ compareTo?: unknown }>(path.join(dir, "config.json"))?.compareTo;
  return files.map((file) => {
    const shot = byPath.get(path.resolve(file));
    const name = path.basename(file).replace(IMAGE_RE, "");
    // visual_verify names shots <route>__<viewport>__<theme>.png
    const parts = name.split("__");
    const route = shot?.route ?? (parts.length >= 3 ? `/${parts[0].replace(/_/g, "/")}` : null);
    const viewport = shot?.viewport ?? (parts.length >= 3 ? parts[1] : null);
    const theme = shot?.theme ?? (parts.length >= 3 ? parts[2] : null);
    const errs = shot
      ? partitionConsoleMessages(shot.consoleErrors ?? []).errors.length + (shot.pageErrors ?? []).length
      : 0;
    const verdict: ScreenshotEntry["verdict"] =
      assessment?.pass === true && !shot?.error
        ? "pass"
        : assessment?.pass === false || shot?.error
          ? "fail"
          : "unknown";
    const baselinePath =
      typeof baselineDir === "string" && existsSync(path.join(baselineDir, path.basename(file)))
        ? path.join(baselineDir, path.basename(file))
        : null;
    return {
      id: createHash("sha1").update(file).digest("hex").slice(0, 16),
      path: file,
      url: fileUrl(file),
      thumbUrl: fileUrl(file, true),
      runId,
      label: rec?.label ?? (runId === "adhoc" ? "Ad-hoc visual check" : runId),
      agent: rec?.childSessionKey ?? rec?.backend ?? "",
      route,
      viewport,
      theme,
      ts: mtime(file),
      verdict,
      runState: rec?.state ?? null,
      runVerdict: rec?.review?.verdict ?? null,
      visualDir: dir,
      assessment,
      consoleErrors: errs,
      ...(baselinePath && baselinePath.startsWith(verificationDir())
        ? { baselinePath, baselineUrl: fileUrl(baselinePath) }
        : {}),
      source: "visual_verify" as const,
    };
  });
}

/**
 * A servable copy of an image: the path itself when it is inside the
 * verification dir, else a copy under `<runId>/result-shots/` (the safe file
 * route only serves the verification dir). Null when it is not a usable image.
 */
export function ingestScreenshot(runId: string, raw: string): string | null {
  if (!path.isAbsolute(raw) || !IMAGE_RE.test(raw) || !existsSync(raw)) return null;
  const root = verificationDir();
  if (path.resolve(raw).startsWith(`${root}${path.sep}`)) return raw;
  const dest = path.join(
    verificationRunDir(runId),
    "result-shots",
    `${createHash("sha1").update(raw).digest("hex").slice(0, 8)}-${path.basename(raw)}`,
  );
  try {
    if (!existsSync(dest)) {
      if (statSync(raw).size > 20 * 1024 * 1024) return null;
      mkdirSync(path.dirname(dest), { recursive: true });
      copyFileSync(raw, dest);
    }
    return dest;
  } catch {
    return null;
  }
}

/** RESULT screenshots of a visual run, copied under the run dir when outside it. */
export function entriesForResultShots(rec: CompletionRecord): ScreenshotEntry[] {
  const visual = (rec.review?.visualFiles?.length ?? 0) > 0;
  const shots = rec.result?.screenshots ?? [];
  if (!visual || shots.length === 0) return [];
  const out: ScreenshotEntry[] = [];
  for (const raw of shots.slice(0, 24)) {
    const file = ingestScreenshot(rec.runId, raw);
    if (!file) continue;
    if (out.some((e) => e.path === file)) continue;
    const name = path.basename(raw).toLowerCase();
    const shotOk = rec.review?.evidence?.find((e) => e.kind === "screenshot" && e.ref === raw);
    out.push({
      id: createHash("sha1").update(file).digest("hex").slice(0, 16),
      path: file,
      url: fileUrl(file),
      thumbUrl: fileUrl(file, true),
      runId: rec.runId,
      label: rec.label,
      agent: rec.childSessionKey ?? rec.backend ?? "",
      route: null,
      viewport: /mobile|phone|390|375|414/.test(name) ? "mobile" : /desktop|1440|1280|1920/.test(name) ? "desktop" : null,
      theme: /light/.test(name) ? "light" : /dark/.test(name) ? "dark" : null,
      ts: mtime(raw),
      verdict: shotOk ? (shotOk.status === "pass" ? (rec.review?.verdict === "VERIFIED" ? "pass" : "unknown") : "fail") : "unknown",
      runState: rec.state,
      runVerdict: rec.review?.verdict ?? null,
      visualDir: null,
      assessment: null,
      source: "result",
    });
  }
  return out;
}

// ── Index ───────────────────────────────────────────────────────────────────

interface RunIndex {
  sig: string;
  entries: ScreenshotEntry[];
}

const runs = new Map<string, RunIndex>();
let lastScan = 0;
let indexRoot: string | null = null;

function runSignature(runDir: string, rec: CompletionRecord | undefined): string {
  let parts = "";
  try {
    for (const d of readdirSync(runDir)) if (d.startsWith("visual-") || d === "result-shots") parts += `${d}:${mtime(path.join(runDir, d))};`;
  } catch {
    /* no dir */
  }
  return `${parts}|${rec?.state ?? ""}|${rec?.review?.verdict ?? ""}|${rec?.result?.screenshots?.length ?? 0}`;
}

function indexRun(runId: string): { changed: boolean; added: ScreenshotEntry[] } {
  const runDir = verificationRunDir(runId);
  const rec = getRecord(runId);
  const sig = runSignature(runDir, rec);
  const prev = runs.get(runId);
  if (prev && prev.sig === sig) return { changed: false, added: [] };
  const entries: ScreenshotEntry[] = [];
  try {
    for (const d of readdirSync(runDir)) {
      if (d.startsWith("visual-")) entries.push(...entriesForVisualDir(path.join(runDir, d), rec, runId));
    }
  } catch {
    /* no capture dirs */
  }
  if (rec) {
    for (const e of entriesForResultShots(rec)) if (!entries.some((x) => x.path === e.path)) entries.push(e);
  }
  const before = new Set((prev?.entries ?? []).map((e) => e.id));
  runs.set(runId, { sig: runSignature(runDir, rec), entries });
  return { changed: true, added: entries.filter((e) => !before.has(e.id)) };
}

/** Scan run dirs + visual records; cheap when nothing changed. */
export function refreshScreenshotIndex(opts: { force?: boolean; broadcast?: boolean } = {}): ScreenshotEntry[] {
  const root = verificationDir();
  if (indexRoot !== root) {
    runs.clear();
    indexRoot = root;
  }
  if (!opts.force && Date.now() - lastScan < 5000) return [];
  lastScan = Date.now();
  const ids = new Set<string>();
  try {
    for (const d of readdirSync(root, { withFileTypes: true })) if (d.isDirectory() && !d.name.startsWith(".")) ids.add(d.name);
  } catch {
    /* fresh install */
  }
  for (const r of listRecords({ limit: 2000 }))
    if ((r.review?.visualFiles?.length ?? 0) > 0 && (r.result?.screenshots?.length ?? 0) > 0) ids.add(r.runId);
  const added: ScreenshotEntry[] = [];
  for (const id of ids) {
    const res = indexRun(id);
    if (res.added.length) added.push(...res.added);
  }
  if (opts.broadcast && added.length && broadcaster && runs.size) {
    try {
      broadcaster(SCREENSHOTS_EVENT, { items: added.slice(0, 50) }, { dropIfSlow: true });
    } catch {
      /* best effort */
    }
  }
  return added;
}

/** Re-index one run now (visual_verify finished / run settled) and push new shots. */
export function noteRunScreenshots(runId: string): ScreenshotEntry[] {
  if (indexRoot !== verificationDir()) refreshScreenshotIndex({ force: true });
  const { added } = indexRun(runId);
  if (added.length && broadcaster) {
    try {
      broadcaster(SCREENSHOTS_EVENT, { items: added.slice(0, 50) }, { dropIfSlow: true });
    } catch {
      /* best effort */
    }
  }
  return added;
}

export function listScreenshots(q: ScreenshotQuery = {}): {
  items: ScreenshotEntry[];
  total: number;
  nextCursor: number | null;
  facets: { routes: string[]; viewports: string[]; agents: string[] };
} {
  refreshScreenshotIndex({ broadcast: true });
  const all: ScreenshotEntry[] = [];
  for (const r of runs.values()) all.push(...r.entries);
  const lc = (s: string | null | undefined) => (s ?? "").toLowerCase();
  const needle = lc(q.q);
  const filtered = all.filter((e) => {
    if (q.verdict && e.verdict !== q.verdict) return false;
    if (q.runId && e.runId !== q.runId) return false;
    if (q.route && !lc(e.route).includes(lc(q.route))) return false;
    if (q.viewport && lc(e.viewport) !== lc(q.viewport)) return false;
    if (q.agent && !lc(`${e.agent} ${e.label}`).includes(lc(q.agent))) return false;
    if (q.since && e.ts < q.since) return false;
    if (q.until && e.ts > q.until) return false;
    if (
      needle &&
      !lc(`${e.label} ${e.route} ${e.runId} ${e.assessment?.summary ?? ""} ${e.viewport} ${e.theme}`).includes(needle)
    )
      return false;
    return true;
  });
  filtered.sort((a, b) => b.ts - a.ts);
  const start = Math.max(0, q.cursor ?? 0);
  const limit = Math.min(200, Math.max(1, q.limit ?? 60));
  const items = filtered.slice(start, start + limit);
  const uniq = (xs: Array<string | null>) => [...new Set(xs.filter((x): x is string => Boolean(x)))].sort().slice(0, 100);
  return {
    items,
    total: filtered.length,
    nextCursor: start + limit < filtered.length ? start + limit : null,
    facets: {
      routes: uniq(all.map((e) => e.route)),
      viewports: uniq(all.map((e) => e.viewport)),
      agents: uniq(all.map((e) => e.label)),
    },
  };
}

export function resetScreenshotIndexForTests(): void {
  runs.clear();
  lastScan = 0;
  indexRoot = null;
  broadcaster = null;
}
