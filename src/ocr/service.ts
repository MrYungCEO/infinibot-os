/**
 * OcrService — the durable auto-OCR queue + context API.
 *
 * The registry row of each file IS its job: status queued/processing/done/
 * failed, attempts, next retry time. The registry is persisted after every
 * transition, so a gateway restart picks up queued work and re-queues the job
 * that was interrupted mid-run (multi-page PDFs resume from their last saved
 * page). One job runs at a time (the GPU vision pass is the bottleneck);
 * enqueueing never waits for extraction.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { extractFile, IMAGE_EXTS, ocrKindForExt, PDF_EXTS } from "./extract.js";
import type { OcrRuntimeConfig } from "./local-only.js";
import {
  NormalLaneStore,
  SecureLaneOcrStore,
  secureScratchDir,
  type OcrLaneStore,
} from "./store.js";
import type { SecureVault } from "../secure-mode/vault.js";
import { defaultMimeFor } from "./handlers.js";
import {
  backgroundPaused,
  onBackgroundPauseChange,
  waitForBackgroundSlot,
} from "./interactive-gate.js";
import type {
  OcrAnalysis,
  OcrEngines,
  OcrEntry,
  OcrLane,
  OcrSidecar,
  OcrSource,
  OcrStatus,
} from "./types.js";

export interface OcrChangeEvent {
  lane: OcrLane;
  id: string;
  status: OcrStatus;
  /** Omitted for the secure lane (names never leave the vault in events). */
  name?: string;
  path?: string | null;
  progress?: OcrEntry["progress"];
  error?: string;
}

export interface OcrServiceDeps {
  stateDir: string;
  engines: OcrEngines;
  cfg: OcrRuntimeConfig;
  secureVault: () => SecureVault | null;
  emit?: (e: OcrChangeEvent) => void;
  /** Normal lane only: mirror a finished sidecar into agent memory (or drop it when sc is null). */
  indexNormal?: (entry: OcrEntry, sc: OcrSidecar | null) => void;
  onDone?: (entry: OcrEntry, sc: OcrSidecar) => void;
  log?: { info: (m: string) => void; warn: (m: string) => void };
  now?: () => number;
  /** Idle poll for due retries (ms). */
  pollMs?: number;
}

/**
 * Entries at or above this priority (chat attachments, explicit reruns of a
 * file someone is looking at) keep running while an interactive local-model
 * turn holds the GPU; everything below (backfill, uploads) pauses.
 */
export const OCR_INTERACTIVE_PRIORITY = 10;

/** Cached "inspect" answers live in sidecar.analyses under this analyzer id. */
export const INSPECT_ANALYZER = "inspect";

export function inspectAnalysisId(question: string, page?: number): string {
  const norm = question.trim().toLowerCase().replace(/\s+/g, " ");
  return `inspect:${page ?? 1}:${createHash("sha1").update(norm).digest("hex").slice(0, 12)}`;
}

export interface OcrRef {
  id?: string;
  path?: string;
  sha256?: string;
  docId?: string;
}

export interface OcrSearchHit {
  id: string;
  lane: OcrLane;
  name: string;
  path: string | null;
  status: OcrStatus;
  score: number;
  snippet: string;
  source: OcrSource;
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function mimeFor(ext: string): string {
  return MIME[ext.toLowerCase()] ?? defaultMimeFor(ext) ?? "application/octet-stream";
}

export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function normalIdForPath(absPath: string): string {
  return `f_${createHash("sha1").update(path.resolve(absPath)).digest("hex").slice(0, 16)}`;
}

function terms(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[^\p{L}\p{N}$@._-]+/u)
    .map((t) => t.replace(/^[._-]+|[._-]+$/g, ""))
    .filter((t) => t.length >= 2)
    .slice(0, 12);
}

function snippetAround(text: string, needle: string, width = 180): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const i = flat.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0) return flat.slice(0, width);
  const start = Math.max(0, i - Math.floor(width / 3));
  return `${start > 0 ? "…" : ""}${flat.slice(start, start + width)}${start + width < flat.length ? "…" : ""}`;
}

export class OcrService {
  readonly stores: Record<OcrLane, OcrLaneStore>;
  private running: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private kicking = false;
  private textCache = new Map<string, string>();
  private waiters = new Map<string, Set<() => void>>();
  private readonly now: () => number;
  private unsubscribePause: (() => void) | null = null;
  /** Engines whose vision calls wait while an interactive turn holds the GPU. */
  private readonly backgroundEngines: OcrEngines;
  /** Engines for work a chat turn is waiting on (attachments): no background lease. */
  private readonly interactiveEngines: OcrEngines;

  constructor(private readonly deps: OcrServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.stores = {
      normal: new NormalLaneStore(path.join(deps.stateDir, "ocr")),
      secure: new SecureLaneOcrStore(deps.secureVault),
    };
    const vl = deps.engines.vl;
    this.backgroundEngines = vl
      ? {
          ...deps.engines,
          vl: {
            model: () => vl.model(),
            ask: async (params) => {
              await waitForBackgroundSlot();
              return vl.ask(params);
            },
          },
        }
      : deps.engines;
    this.interactiveEngines = vl
      ? {
          ...deps.engines,
          vl: {
            model: () => vl.model(),
            ask: (params) => vl.ask({ ...params, interactive: true }),
          },
        }
      : deps.engines;
  }

  get cfg() {
    return this.deps.cfg;
  }

  get engines() {
    return this.deps.engines;
  }

  // ── lifecycle ────────────────────────────────────────────────────────

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    // Crash recovery: a job left "processing" by a dead process goes back to the queue.
    for (const lane of ["normal", "secure"] as const) this.recover(lane);
    const tick = () => {
      if (this.stopped) return;
      void this.drain().finally(() => {
        if (!this.stopped) this.timer = setTimeout(tick, this.deps.pollMs ?? 5_000);
      });
    };
    this.timer = setTimeout(tick, 50);
    this.timer.unref?.();
    this.unsubscribePause = onBackgroundPauseChange((paused) => {
      this.deps.log?.info(
        paused
          ? "ocr: background queue paused (interactive local-model turn)"
          : "ocr: background queue resumed",
      );
      if (!paused) this.kick();
    });
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.unsubscribePause?.();
    this.unsubscribePause = null;
  }

  private recover(lane: OcrLane) {
    const store = this.stores[lane];
    if (!store.available()) return;
    try {
      const reg = store.loadRegistry();
      let changed = false;
      for (const e of Object.values(reg)) {
        if (e.status === "processing" && e.id !== this.running) {
          e.status = "queued";
          e.nextAttemptAt = 0;
          changed = true;
        }
      }
      if (changed) store.saveRegistry(reg);
    } catch (err) {
      this.deps.log?.warn(`ocr: recover ${lane} failed: ${String(err)}`);
    }
  }

  /** Wake the worker now (after an enqueue). Never blocks the caller. */
  kick() {
    if (this.stopped || this.kicking) return;
    this.kicking = true;
    setImmediate(() => {
      this.kicking = false;
      void this.drain();
    });
  }

  private draining: Promise<void> | null = null;

  /** Run due jobs until none are left. Safe to call concurrently. */
  drain(): Promise<void> {
    this.draining ??= (async () => {
      try {
        for (let i = 0; i < 1000; i++) {
          const ran = await this.processNext();
          if (!ran) break;
        }
      } finally {
        this.draining = null;
      }
    })();
    return this.draining;
  }

  private nextDue(): { lane: OcrLane; entry: OcrEntry } | null {
    const now = this.now();
    // Interactive local-model turn running: only interactive-priority work.
    const minPriority = backgroundPaused() ? OCR_INTERACTIVE_PRIORITY : -Infinity;
    let best: { lane: OcrLane; entry: OcrEntry } | null = null;
    for (const lane of ["secure", "normal"] as const) {
      const store = this.stores[lane];
      if (!store.available()) continue;
      let reg: Record<string, OcrEntry>;
      try {
        reg = store.loadRegistry();
      } catch {
        continue;
      }
      for (const e of Object.values(reg)) {
        const stale = e.status === "processing" && e.id !== this.running;
        if (!(e.status === "queued" || stale) || e.nextAttemptAt > now) continue;
        if (e.priority < minPriority) continue;
        if (
          !best ||
          e.priority > best.entry.priority ||
          (e.priority === best.entry.priority && e.createdAt < best.entry.createdAt)
        ) {
          best = { lane, entry: e };
        }
      }
    }
    return best;
  }

  private patch(lane: OcrLane, id: string, fn: (e: OcrEntry) => OcrEntry | void): OcrEntry | null {
    const store = this.stores[lane];
    const reg = store.loadRegistry();
    const cur = reg[id];
    if (!cur) return null;
    const next = fn(cur) ?? cur;
    next.updatedAt = this.now();
    reg[id] = next;
    store.saveRegistry(reg);
    return next;
  }

  private emit(entry: OcrEntry) {
    const secure = entry.lane === "secure";
    this.deps.emit?.({
      lane: entry.lane,
      id: entry.id,
      status: entry.status,
      ...(secure ? {} : { name: entry.name, path: entry.path, error: entry.error }),
      progress: entry.progress,
    });
    const ws = this.waiters.get(`${entry.lane}:${entry.id}`);
    if (ws) for (const w of Array.from(ws)) w();
  }

  /** Process one due job. Returns false when nothing was due. */
  async processNext(): Promise<boolean> {
    if (this.running) return false;
    const due = this.nextDue();
    if (!due) return false;
    const { lane } = due;
    const store = this.stores[lane];
    this.running = due.entry.id;
    let entry = this.patch(lane, due.entry.id, (e) => {
      e.status = "processing";
      e.attempts += 1;
      e.error = undefined;
      e.progress = { done: 0, total: 0, stage: "starting" };
    })!;
    this.emit(entry);
    let mat: { path: string; cleanup: () => void } | null = null;
    try {
      mat = await store.materialize(entry);
      const prior = store.readSidecar(entry);
      const sc = await extractFile({
        entry,
        filePath: mat.path,
        engines:
          entry.priority >= OCR_INTERACTIVE_PRIORITY
            ? this.interactiveEngines
            : this.backgroundEngines,
        cfg: this.deps.cfg,
        prior: prior && !prior.complete ? prior : null,
        now: this.now,
        tmpDir: lane === "secure" ? secureScratchDir() : undefined,
        onProgress: (partial, progress) => {
          try {
            const withPath = store.writeSidecar(entry, partial);
            this.textCache.delete(`${lane}:${entry.id}`);
            entry =
              this.patch(lane, entry.id, (e) => {
                e.progress = progress;
                if (withPath.sidecarPath) e.sidecarPath = withPath.sidecarPath;
                e.chars = partial.markdown.length;
                e.confidence = partial.confidence;
              }) ?? entry;
            this.emit(entry);
          } catch (err) {
            this.deps.log?.warn(`ocr: progress save failed for ${entry.id}: ${String(err)}`);
          }
        },
      });
      const withPath = store.writeSidecar(entry, sc);
      this.textCache.delete(`${lane}:${entry.id}`);
      entry = this.patch(lane, entry.id, (e) => {
        e.status = "done";
        e.error = undefined;
        e.progress = undefined;
        e.nextAttemptAt = 0;
        if (withPath.sidecarPath) e.sidecarPath = withPath.sidecarPath;
        e.summary = (
          sc.description?.match(/##\s*Summary\s*\n([\s\S]*?)(?:\n##|$)/i)?.[1] ?? sc.markdown
        )
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 240);
        e.chars = sc.markdown.length;
        e.pages = sc.pageCount;
        e.confidence = sc.confidence;
        e.vlModel = sc.engines.vl;
      })!;
      if (lane === "normal") this.safeIndex(entry, sc);
      try {
        this.deps.onDone?.(entry, sc);
      } catch (err) {
        this.deps.log?.warn(`ocr: onDone hook failed: ${String(err)}`);
      }
      this.deps.log?.info(
        `ocr: done ${lane === "secure" ? entry.id : entry.name} (${sc.pageCount}p, ${sc.markdown.length} chars, conf ${sc.confidence ?? "-"}, vl ${sc.engines.vl ?? "none"})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const max = this.deps.cfg.maxAttempts;
      entry =
        this.patch(lane, entry.id, (e) => {
          e.error = msg.slice(0, 500);
          e.progress = undefined;
          if (e.attempts >= max) {
            e.status = "failed";
          } else {
            e.status = "queued";
            e.nextAttemptAt = this.now() + this.deps.cfg.retryBaseMs * 2 ** (e.attempts - 1);
          }
        }) ?? entry;
      this.deps.log?.warn(
        `ocr: ${entry.status === "failed" ? "failed" : "retry"} ${lane === "secure" ? entry.id : entry.name} (attempt ${entry.attempts}/${max}): ${msg}`,
      );
    } finally {
      mat?.cleanup();
      this.running = null;
    }
    this.emit(entry);
    return true;
  }

  private safeIndex(entry: OcrEntry, sc: OcrSidecar | null) {
    if (entry.lane !== "normal") return; // secure results never reach the normal agent index
    try {
      this.deps.indexNormal?.(entry, sc);
    } catch (err) {
      this.deps.log?.warn(`ocr: memory index failed for ${entry.id}: ${String(err)}`);
    }
  }

  // ── enqueue ──────────────────────────────────────────────────────────

  /** Normal lane: register a file already on disk and queue it. */
  enqueuePath(params: {
    absPath: string;
    source: OcrSource;
    priority?: number;
    force?: boolean;
  }): OcrEntry | null {
    const abs = path.resolve(params.absPath);
    const ext = path.extname(abs).toLowerCase();
    if (!ocrKindForExt(ext)) return null;
    const stat = fs.statSync(abs);
    const data = fs.readFileSync(abs);
    const digest = sha256(data);
    const store = this.stores.normal;
    const reg = store.loadRegistry();
    const id = normalIdForPath(abs);
    const now = this.now();
    const prev = reg[id];
    if (prev && prev.sha256 === digest && !params.force && prev.status !== "failed") {
      // Same bytes at the same path: keep results, refresh provenance.
      prev.source = { ...prev.source, ...params.source };
      prev.updatedAt = now;
      store.saveRegistry(reg);
      return prev;
    }
    const entry: OcrEntry = {
      id,
      lane: "normal",
      name: path.basename(abs),
      path: abs,
      ext,
      mime: mimeFor(ext),
      size: stat.size,
      sha256: digest,
      status: "queued",
      attempts: 0,
      nextAttemptAt: 0,
      priority: params.priority ?? 0,
      source: params.source,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    };
    if (prev) store.removeSidecar(prev);
    // Same bytes already processed elsewhere in this lane → reuse instantly.
    const twin = params.force
      ? undefined
      : Object.values(reg).find((e) => e.id !== id && e.sha256 === digest && e.status === "done");
    reg[id] = entry;
    store.saveRegistry(reg);
    if (twin) {
      const sc = store.readSidecar(twin);
      if (sc?.complete) {
        const copy: OcrSidecar = {
          ...sc,
          id,
          name: entry.name,
          source: entry.source,
          updatedAt: now,
        };
        const withPath = store.writeSidecar(entry, copy);
        const done = this.patch("normal", id, (e) => {
          Object.assign(e, {
            status: "done",
            sidecarPath: withPath.sidecarPath,
            summary: twin.summary,
            chars: twin.chars,
            pages: twin.pages,
            confidence: twin.confidence,
            vlModel: twin.vlModel,
          });
        })!;
        this.safeIndex(done, copy);
        this.emit(done);
        return done;
      }
    }
    this.emit(entry);
    this.kick();
    return entry;
  }

  /** Secure lane: seal the bytes in the vault and queue them. Throws while locked. */
  enqueueSecure(params: {
    name: string;
    data: Buffer;
    source: OcrSource;
    priority?: number;
  }): OcrEntry {
    const store = this.stores.secure as SecureLaneOcrStore;
    if (!store.available()) throw new Error("Secure Mode is locked");
    const ext = path.extname(params.name).toLowerCase();
    const digest = sha256(params.data);
    const reg = store.loadRegistry();
    const existing = Object.values(reg).find((e) => e.sha256 === digest && e.name === params.name);
    if (existing && existing.status !== "failed") return existing;
    const id = `s_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = this.now();
    const supported = Boolean(ocrKindForExt(ext));
    const entry: OcrEntry = {
      id,
      lane: "secure",
      name: params.name,
      path: null,
      ext,
      mime: mimeFor(ext),
      size: params.data.length,
      sha256: digest,
      status: supported ? "queued" : "done",
      attempts: 0,
      nextAttemptAt: 0,
      priority: params.priority ?? 0,
      source: params.source,
      createdAt: now,
      updatedAt: now,
      ...(supported ? {} : { summary: "", chars: 0, pages: 0, confidence: null }),
    };
    store.putBytes(id, params.data);
    reg[id] = entry;
    store.saveRegistry(reg);
    this.emit(entry);
    if (supported) this.kick();
    return entry;
  }

  // ── lookup ───────────────────────────────────────────────────────────

  laneAvailable(lane: OcrLane) {
    return this.stores[lane].available();
  }

  private requireLane(lane: OcrLane) {
    const store = this.stores[lane];
    if (!store.available()) throw new Error("Secure Mode is locked");
    return store;
  }

  find(lane: OcrLane, ref: OcrRef): OcrEntry | null {
    const reg = this.requireLane(lane).loadRegistry();
    if (ref.id && reg[ref.id]) return reg[ref.id];
    if (ref.path && lane === "normal") {
      const id = normalIdForPath(ref.path);
      if (reg[id]) return reg[id];
    }
    const all = Object.values(reg);
    if (ref.sha256) {
      const hit = all
        .filter((e) => e.sha256 === ref.sha256)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (hit) return hit;
    }
    if (ref.docId) return all.find((e) => e.source.docId === ref.docId) ?? null;
    return null;
  }

  getContext(lane: OcrLane, ref: OcrRef): { entry: OcrEntry; sidecar: OcrSidecar | null } | null {
    const entry = this.find(lane, ref);
    if (!entry) return null;
    return { entry, sidecar: this.stores[lane].readSidecar(entry) };
  }

  list(
    lane: OcrLane,
    opts: { status?: OcrStatus; limit?: number; projectId?: string; sessionKey?: string } = {},
  ) {
    const reg = this.requireLane(lane).loadRegistry();
    return Object.values(reg)
      .filter((e) => !opts.status || e.status === opts.status)
      .filter((e) => !opts.projectId || e.source.projectId === opts.projectId)
      .filter((e) => !opts.sessionKey || e.source.sessionKey === opts.sessionKey)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, Math.max(1, Math.min(opts.limit ?? 200, 2000)));
  }

  /** Status of many normal-lane paths at once (Files page badges). */
  statusForPaths(paths: string[]): Map<string, OcrEntry> {
    const reg = this.stores.normal.loadRegistry();
    const out = new Map<string, OcrEntry>();
    for (const p of paths) {
      const e = reg[normalIdForPath(p)];
      if (e) out.set(p, e);
    }
    return out;
  }

  private searchText(lane: OcrLane, e: OcrEntry): string {
    const key = `${lane}:${e.id}`;
    const hit = this.textCache.get(key);
    if (hit !== undefined) return hit;
    const sc = this.stores[lane].readSidecar(e);
    const analyses = (sc?.analyses ?? [])
      .map((a) =>
        [
          a.summary,
          ...(a.findings ?? []).map((f) => `${f.title} ${f.detail ?? ""}`),
          ...(a.frames ?? []).map((f) => `${f.text ?? ""} ${f.description ?? ""}`),
        ].join("\n"),
      )
      .join("\n");
    const text = [
      e.name,
      sc?.description ?? "",
      sc?.markdown ?? "",
      (sc?.entities ?? []).join("\n"),
      analyses,
    ].join("\n");
    if (lane === "normal") this.textCache.set(key, text); // secure plaintext is never cached
    return text;
  }

  search(lane: OcrLane, query: string, limit = 10): OcrSearchHit[] {
    const ts = terms(query);
    if (!ts.length) return [];
    const phrase = query.trim().toLowerCase();
    const hits: OcrSearchHit[] = [];
    for (const e of this.list(lane, { limit: 2000 })) {
      const text = this.searchText(lane, e);
      const lower = text.toLowerCase();
      const name = e.name.toLowerCase();
      let score = 0;
      let matched = 0;
      let first = "";
      for (const t of ts) {
        let n = 0;
        let i = lower.indexOf(t);
        if (i >= 0 && !first) first = t;
        while (i >= 0 && n < 50) {
          n++;
          i = lower.indexOf(t, i + t.length);
        }
        if (n) {
          matched++;
          score += 1 + Math.log(n);
        }
        if (name.includes(t)) score += 2;
      }
      if (!matched || matched < Math.ceil(ts.length * 0.6)) continue;
      if (phrase.length > 3 && lower.includes(phrase)) score += 3;
      hits.push({
        id: e.id,
        lane,
        name: e.name,
        path: e.path,
        status: e.status,
        score: Math.round(score * 100) / 100,
        snippet: snippetAround(
          text.slice(e.name.length + 1),
          lower.includes(phrase) ? phrase : first,
        ),
        source: e.source,
      });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(limit, 50)));
  }

  // ── mutations ────────────────────────────────────────────────────────

  rerun(lane: OcrLane, ref: OcrRef): OcrEntry | null {
    const entry = this.find(lane, ref);
    if (!entry) return null;
    const store = this.stores[lane];
    store.removeSidecar(entry);
    this.textCache.delete(`${lane}:${entry.id}`);
    const next = this.patch(lane, entry.id, (e) => {
      e.status = "queued";
      e.attempts = 0;
      e.nextAttemptAt = 0;
      e.error = undefined;
      e.priority = Math.max(e.priority, 5);
      e.summary = undefined;
    })!;
    this.emit(next);
    this.kick();
    return next;
  }

  remove(lane: OcrLane, ref: OcrRef): boolean {
    const store = this.requireLane(lane);
    const entry = this.find(lane, ref);
    if (!entry) return false;
    store.removeSidecar(entry);
    if (lane === "secure") (store as SecureLaneOcrStore).removeBytes(entry.id);
    const reg = store.loadRegistry();
    delete reg[entry.id];
    store.saveRegistry(reg);
    this.textCache.delete(`${lane}:${entry.id}`);
    if (lane === "normal") this.safeIndex(entry, null);
    return true;
  }

  /** A normal-lane file was renamed/moved: carry its results to the new path. */
  moved(oldAbs: string, newAbs: string) {
    const store = this.stores.normal;
    const reg = store.loadRegistry();
    const prev = reg[normalIdForPath(oldAbs)];
    if (!prev) return;
    const sc = store.readSidecar(prev);
    store.removeSidecar(prev);
    delete reg[prev.id];
    const id = normalIdForPath(newAbs);
    let entry: OcrEntry = {
      ...prev,
      id,
      path: path.resolve(newAbs),
      name: path.basename(newAbs),
      sidecarPath: undefined,
    };
    if (sc) entry = store.writeSidecar(entry, { ...sc, id, name: entry.name });
    reg[id] = entry;
    store.saveRegistry(reg);
    this.textCache.delete(`normal:${prev.id}`);
    this.safeIndex(prev, null);
    if (sc && entry.status === "done") this.safeIndex(entry, { ...sc, id, name: entry.name });
  }

  /**
   * Mutate a file's sidecar in place (no re-queue). Used by analyzers that
   * run after extraction (video, specialist agents). Secure lane → vault.
   * Returns the saved sidecar, or null when the file/sidecar is unknown.
   */
  updateSidecar(
    lane: OcrLane,
    ref: OcrRef,
    fn: (sc: OcrSidecar) => OcrSidecar | void,
  ): OcrSidecar | null {
    const store = this.requireLane(lane);
    const entry = this.find(lane, ref);
    if (!entry) return null;
    const cur = store.readSidecar(entry);
    if (!cur) return null;
    const next = fn(cur) ?? cur;
    next.updatedAt = this.now();
    const withPath = store.writeSidecar(entry, next);
    this.textCache.delete(`${lane}:${entry.id}`);
    const updated = this.patch(lane, entry.id, (e) => {
      if (withPath.sidecarPath) e.sidecarPath = withPath.sidecarPath;
    });
    if (lane === "normal" && updated?.status === "done") this.safeIndex(updated, next);
    if (updated) {
      this.emit(updated);
      try {
        this.deps.onDone?.(updated, next);
      } catch {
        /* hooks are best effort */
      }
    }
    return next;
  }

  /** Append or replace (by id) one analyzer result on a file's sidecar. */
  addAnalysis(lane: OcrLane, ref: OcrRef, analysis: OcrAnalysis): OcrSidecar | null {
    return this.updateSidecar(lane, ref, (sc) => {
      const list = (sc.analyses ?? []).filter((a) => a.id !== analysis.id);
      list.push(analysis);
      sc.analyses = list;
    });
  }

  readBytes(lane: OcrLane, ref: OcrRef): { entry: OcrEntry; data: Buffer } | null {
    const entry = this.find(lane, ref);
    if (!entry) return null;
    const data = this.stores[lane].readBytes(entry);
    return data ? { entry, data } : null;
  }

  /** Wait until a file has text (OCR tier done) or finished/failed. */
  async waitForText(lane: OcrLane, id: string, timeoutMs: number): Promise<OcrSidecar | null> {
    const key = `${lane}:${id}`;
    const check = () => {
      const e = this.stores[lane].loadRegistry()[id];
      if (!e) return { done: true, sc: null };
      const sc = this.stores[lane].readSidecar(e);
      if (e.status === "done" || e.status === "failed") return { done: true, sc };
      if (sc && sc.markdown.trim() && sc.stage) return { done: true, sc };
      return { done: false, sc };
    };
    const first = check();
    if (first.done || timeoutMs <= 0) return first.sc;
    return await new Promise<OcrSidecar | null>((resolve) => {
      let set = this.waiters.get(key);
      if (!set) this.waiters.set(key, (set = new Set()));
      const finish = (sc: OcrSidecar | null) => {
        clearTimeout(t);
        set!.delete(onEvt);
        if (!set!.size) this.waiters.delete(key);
        resolve(sc);
      };
      const onEvt = () => {
        const r = check();
        if (r.done) finish(r.sc);
      };
      const t = setTimeout(() => finish(check().sc), timeoutMs);
      set.add(onEvt);
    });
  }

  /** Ask the local vision model about a file (image, or a PDF page). */
  async inspect(
    lane: OcrLane,
    ref: OcrRef,
    question: string,
    opts: { page?: number; refresh?: boolean } = {},
  ): Promise<{
    id: string;
    name: string;
    answer: string;
    model: string | null | undefined;
    cached?: boolean;
    askedAt?: string;
  }> {
    const entry = this.find(lane, ref);
    if (!entry) throw new Error("file not found in the OCR index");
    const store = this.stores[lane];
    // Same question about the same page already answered → the saved answer,
    // instantly (no GPU). `refresh` looks again.
    const cacheId = inspectAnalysisId(question, opts.page);
    if (!opts.refresh) {
      const hit = store.readSidecar(entry)?.analyses?.find((a) => a.id === cacheId);
      if (hit) {
        return {
          id: entry.id,
          name: entry.name,
          answer: hit.summary,
          model: hit.model,
          cached: true,
          askedAt: new Date(hit.createdAt).toISOString(),
        };
      }
    }
    const vl = this.deps.engines.vl;
    if (!vl) throw new Error("no local vision model configured (Ollama on 127.0.0.1 required)");
    const mat = await store.materialize(entry);
    const scratchBase =
      lane === "secure" ? secureScratchDir() : path.join(this.deps.stateDir, "ocr", "tmp");
    fs.mkdirSync(scratchBase, { recursive: true, mode: 0o700 });
    const tmp = fs.mkdtempSync(path.join(scratchBase, "inspect-"));
    try {
      const ext = entry.ext.toLowerCase();
      let img: string;
      if (PDF_EXTS.has(ext)) {
        img = await this.deps.engines.pdfRenderPage(
          mat.path,
          Math.max(1, opts.page ?? 1),
          tmp,
          150,
        );
      } else if (IMAGE_EXTS.has(ext)) {
        img =
          ext === ".png" || ext === ".jpg" || ext === ".jpeg"
            ? mat.path
            : await this.deps.engines.toPng(mat.path, tmp);
      } else {
        throw new Error("visual inspection needs an image or PDF");
      }
      const sc = store.readSidecar(entry);
      const hint = sc?.markdown
        ? `\n\nOCR text of this file for reference (may contain errors):\n${sc.markdown.slice(0, 3000)}`
        : "";
      const r = await vl.ask({
        images: [img],
        prompt: `${question.trim()}\n\nAnswer from what is visible in the image. Be concise and precise.${hint}`,
        // Someone (usually a chat turn) is waiting on this answer.
        interactive: true,
      });
      try {
        this.addAnalysis(
          lane,
          { id: entry.id },
          {
            id: cacheId,
            analyzer: INSPECT_ANALYZER,
            model: r.model,
            createdAt: this.now(),
            summary: r.text,
            data: { question: question.trim().slice(0, 500), page: opts.page ?? 1 },
          },
        );
      } catch (err) {
        this.deps.log?.warn(`ocr: could not cache inspect answer: ${String(err)}`);
      }
      return { id: entry.id, name: entry.name, answer: r.text, model: r.model };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      mat.cleanup();
    }
  }

  async status() {
    const counts = (lane: OcrLane) => {
      const out: Record<OcrStatus, number> = { queued: 0, processing: 0, done: 0, failed: 0 };
      if (!this.stores[lane].available()) return null;
      try {
        for (const e of Object.values(this.stores[lane].loadRegistry())) out[e.status]++;
      } catch {
        return null;
      }
      return out;
    };
    return {
      enabled: this.deps.cfg.enabled,
      localOnly: true,
      ocrEngine: await this.deps.engines.ocrEngineName(),
      vlModel: this.deps.engines.vl ? await this.deps.engines.vl.model().catch(() => null) : null,
      vlMode: this.deps.cfg.vlMode,
      ollamaUrl: this.deps.cfg.ollamaUrl,
      ollamaRefused: this.deps.cfg.ollamaRefused ?? null,
      running: this.running ? true : false,
      pausedForInteractive: backgroundPaused(),
      lanes: { normal: counts("normal"), secure: counts("secure") },
    };
  }
}

/** The text block agents receive for chat attachments. */
export function attachmentContextBlock(
  items: Array<{ entry: OcrEntry; sidecar: OcrSidecar | null }>,
  maxCharsEach = 4000,
): string {
  if (!items.length) return "";
  const parts = items.map(({ entry, sidecar }, i) => {
    const head = `[Attachment ${i + 1}: ${entry.name} · file id ${entry.id}${
      sidecar?.confidence != null ? ` · OCR confidence ${sidecar.confidence}` : ""
    }]`;
    if (!sidecar || !sidecar.markdown.trim()) {
      return `${head}\nLocal OCR is ${entry.status === "failed" ? `failed (${entry.error ?? "error"})` : "still running"}; call file_context with action "get" and id "${entry.id}" shortly.`;
    }
    const text = sidecar.markdown.trim();
    const cut =
      text.length > maxCharsEach
        ? `${text.slice(0, maxCharsEach)}\n[… ${text.length - maxCharsEach} more chars: file_context get]`
        : text;
    const desc = sidecar.description
      ? `\nDescription:\n${sidecar.description.trim().slice(0, 1500)}`
      : "";
    return `${head}\nText (local OCR):\n${cut}${desc}`;
  });
  return [
    '<attachment_context source="local-ocr">',
    ...parts,
    'For more detail use the file_context tool: action "get" for full text, "inspect" with a question to have the local vision model look at the image.',
    "</attachment_context>",
  ].join("\n\n");
}
