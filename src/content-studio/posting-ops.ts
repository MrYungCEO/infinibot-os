/**
 * Content Studio posting operations — the one implementation behind both the
 * `content-studio.posting.*` RPCs (UI) and the `content_posting` agent tool,
 * so an agent and the owner get exactly the same checks and results.
 */

import fs from "node:fs";
import path from "node:path";

import { viewMedia, type MediaView } from "./media-files.js";
import { CAPTION_VARIABLES, mergeHashtags, renderCaption } from "./posting-caption.js";
import { DroidUnavailableError, type DroidDetectResult } from "./posting-droid.js";
import { recordDetection, verdictFor } from "./posting-verify.js";
import { postingBlocker, type NextRun, type PostingRunner } from "./posting-runner.js";
import {
  LIVE_MAX_POSTS_PER_DAY,
  LIVE_MIN_INTERVAL_MINUTES,
  DRY_RUN_MIN_INTERVAL_MINUTES,
  effectiveDailyCap,
  effectiveIntervalMinutes,
} from "./posting-schedule.js";
import {
  POSTING_PLATFORMS,
  isPostingPlatform,
  normalizeHandle,
  type QueueEntry,
  type QueueStatus,
} from "./posting-store.js";
import { ContentStudioError } from "./pipeline-store.js";

type P = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function requirePage(runner: PostingRunner, pageId: unknown): string {
  const id = str(pageId);
  if (!id) throw new ContentStudioError("BAD_REQUEST", "pageId required");
  const page = runner.deps.page(id);
  if (!page) throw new ContentStudioError("NOT_FOUND", `content page not found: ${id}`);
  return id;
}

export type QueueEntryView = QueueEntry & {
  media: MediaView | null;
  caption: string;
  captionSource: "override" | "template";
  captionWarnings: string[];
  /** What the scheduler does next with it, and why (null once done). */
  nextRun: NextRun | null;
};

function entryView(
  runner: PostingRunner,
  e: QueueEntry,
  projected?: number | null,
): QueueEntryView {
  const cfg = runner.posting.getConfig(e.pageId);
  const media = e.mediaId ? runner.deps.studio.store.getMedia(e.mediaId) : null;
  const cap = runner.captionFor(cfg, e, e.scheduledAt ?? Date.now());
  return {
    ...e,
    media: media ? viewMedia(media) : null,
    caption: cap.text,
    captionSource: cap.source,
    captionWarnings: cap.warnings,
    nextRun: runner.nextRun(e, projected),
  };
}

export function postingLimits(dryRun: boolean) {
  return {
    live: { minIntervalMinutes: LIVE_MIN_INTERVAL_MINUTES, maxPostsPerDay: LIVE_MAX_POSTS_PER_DAY },
    dryRun: { minIntervalMinutes: DRY_RUN_MIN_INTERVAL_MINUTES },
    active: dryRun ? "dryRun" : "live",
  };
}

export function getPosting(runner: PostingRunner, p: P) {
  const pageId = requirePage(runner, p.pageId);
  const cfg = runner.posting.getConfig(pageId);
  const preview = runner.preview(pageId, 50);
  const projected = new Map(preview.upcoming.map((u) => [u.entryId, u.at]));
  const queue = runner.posting
    .listQueue(pageId)
    .map((e) => entryView(runner, e, projected.get(e.id) ?? null));
  return {
    pageId,
    config: cfg,
    effective: {
      intervalMinutes: effectiveIntervalMinutes(cfg.schedule, cfg.dryRun),
      dailyCap: effectiveDailyCap(cfg.schedule, cfg.dryRun),
      summary: runner.scheduleSummary(cfg.schedule, cfg.dryRun),
    },
    limits: postingLimits(cfg.dryRun),
    queue,
    preview: { ...preview, upcoming: preview.upcoming.slice(0, 10) },
    history: runner.posting.history(
      pageId,
      typeof p.historyLimit === "number" ? p.historyLimit : 60,
    ),
    // The one backend answer to "will this page auto-post?" — the UI shows
    // this instead of inferring it from the switches.
    autoPosting: {
      enabled: cfg.enabled,
      canEnable: !!cfg.deviceId && cfg.bindings.length > 0,
      blocker: postingBlocker(cfg),
    },
    droidAvailable: runner.deps.droid.available(),
    platforms: POSTING_PLATFORMS,
    captionVariables: CAPTION_VARIABLES,
    now: Date.now(),
  };
}

export async function configurePosting(runner: PostingRunner, p: P) {
  const pageId = requirePage(runner, p.pageId);
  const before = runner.posting.getConfig(pageId);
  const patch: Record<string, unknown> = {};
  for (const k of [
    "enabled",
    "deviceId",
    "deviceLabel",
    "bindings",
    "schedule",
    "template",
    "defaultHashtags",
    "cta",
    "requireApproval",
    "dryRun",
  ]) {
    if (p[k] !== undefined) patch[k] = p[k];
  }
  const { config, bindingChanged } = runner.posting.updateConfig(pageId, patch);
  const changed = Object.keys(patch);
  if (changed.length) {
    runner.posting.log(
      pageId,
      null,
      "configured",
      null,
      `Settings changed: ${changed.join(", ")}${bindingChanged && before.enabled && !config.enabled ? " — binding changed, auto-posting switched off until re-enabled" : ""}`,
      { changed, actor: str(p.actor) || "operator" },
    );
  }
  if (patch.schedule !== undefined || patch.dryRun !== undefined || bindingChanged) {
    runner.posting.resetScheduled(pageId, "settings changed");
  }
  const released = runner.onConfigChanged(pageId, before, config);
  // Flag a binding that does not match what was detected on the phone (the
  // binding is saved either way; posting refuses until it verifies).
  const warnings: string[] = [];
  let final = config;
  if (bindingChanged && config.deviceId && runner.deps.droid.available()) {
    try {
      const list = await runner.deps.droid.devices();
      const dev = list.devices.find((d) => d.id === config.deviceId);
      for (const b of config.bindings) {
        const det = dev?.detected?.[b.platform] ?? null;
        if (!det) {
          warnings.push(
            `@${b.handle} (${b.platform}) has not been detected on the phone yet — run Detect accounts`,
          );
          continue;
        }
        const v = verdictFor(b, det);
        runner.posting.setBindingVerification(pageId, b.platform, b.handle, {
          verification: v.verification,
          note: v.note,
          at: det.detectedAt,
        });
        if (v.verification !== "verified") warnings.push(`@${b.handle} (${b.platform}): ${v.note}`);
      }
      final = runner.posting.getConfig(pageId);
    } catch {
      /* the device list is advisory here */
    }
  }
  return {
    config: final,
    bindingChanged,
    warnings,
    released,
    summary: runner.scheduleSummary(final.schedule, final.dryRun),
  };
}

/**
 * Phones with LIVE reachability (adb presence, not the stored row), what was
 * detected on each, and — for a phone that is not reachable — how to fix it.
 * refresh:true skips the few-second presence cache.
 */
export async function listDevices(runner: PostingRunner, p: P = {}) {
  const droid = runner.deps.droid;
  if (!droid.available()) {
    return {
      ok: false,
      status: "unavailable",
      reason: new DroidUnavailableError().message,
      devices: [],
    };
  }
  return droid.devices({ refresh: p.refresh === true });
}

/**
 * Drives the phone (read-only) to see which account(s) each app is logged
 * into, stores it, and re-verifies every page bound to that phone + app.
 * platform "all" (or "both") checks Instagram then TikTok.
 */
export async function detectAccounts(runner: PostingRunner, p: P) {
  const deviceId = str(p.deviceId);
  const raw = str(p.platform).toLowerCase() || "instagram";
  if (!deviceId) throw new ContentStudioError("BAD_REQUEST", "deviceId required");
  const platforms = raw === "all" || raw === "both" ? [...POSTING_PLATFORMS] : [raw];
  for (const platform of platforms) {
    if (!isPostingPlatform(platform))
      throw new ContentStudioError(
        "BAD_REQUEST",
        `platform must be one of ${POSTING_PLATFORMS.join(", ")} (or "all")`,
      );
  }
  const droid = runner.deps.droid;
  if (!droid.available()) throw new DroidUnavailableError();
  const actor = str(p.actor) || "content-studio:posting";
  const results: Array<DroidDetectResult & { platform: string; bindingsUpdated: number }> = [];
  for (const platform of platforms) {
    const res = await droid.detect({ deviceId, platform, actor });
    const bindingsUpdated = recordDetection(runner.posting, deviceId, platform, res.detection);
    results.push({ ...res, platform, bindingsUpdated });
    if (res.status === "offline" || res.status === "unavailable") break; // same answer for the next app
  }
  if (results.length === 1) return results[0];
  return {
    ok: results.every((r) => r.ok),
    status: results.find((r) => r.status !== "ok")?.status ?? "ok",
    reason:
      results
        .map((r) => (r.reason ? `${r.platform}: ${r.reason}` : null))
        .filter(Boolean)
        .join("; ") || null,
    results,
  };
}

/** Videos the page can queue: its pipeline items' videos + the recent library. */
export function listCandidates(runner: PostingRunner, p: P) {
  const pageId = requirePage(runner, p.pageId);
  const { store } = runner.deps.studio;
  const queued = new Set(
    runner.posting
      .listQueue(pageId)
      .filter((e) => e.status !== "skipped")
      .map((e) => e.mediaId),
  );
  const items = store
    .listItems()
    .filter((it) => it.contentPageId === pageId)
    .flatMap((it) =>
      store
        .listMediaFor("item", it.id)
        .filter((m) => m.kind === "video")
        .map((m) => ({
          source: "item" as const,
          itemId: it.id,
          title: it.title,
          hook: it.summary,
          tags: it.tags,
          media: viewMedia(m),
          queued: queued.has(m.id),
        })),
    );
  const seen = new Set(items.map((i) => i.media.id));
  const library = store
    .listMedia(300)
    .filter((m) => m.kind === "video" && !seen.has(m.id))
    .slice(0, 60)
    .map((m) => ({
      source: "library" as const,
      itemId: null,
      title: m.caption || m.filename,
      hook: "",
      tags: [] as string[],
      media: viewMedia(m),
      queued: queued.has(m.id),
    }));
  return { candidates: [...items, ...library] };
}

async function seriesEpisode(pageId: string, episodeId: string) {
  const { getContentSeriesService } = await import("../content/series.js");
  const dir = process.env.INFINIBOT_STATE_DIR || process.env.MOLTBOT_STATE_DIR || "state";
  return (
    getContentSeriesService(dir)
      .listSeries(pageId)
      .episodes.find((e) => e.id === episodeId) ?? null
  );
}

type ExternalSource = {
  kind: string;
  id: string;
  buffer: Buffer;
  filename: string;
  contentType?: string;
};

/**
 * `p.external = { kind, id, buffer, filename, contentType? }` — only usable
 * in-process: `buffer` must be a real Uint8Array, which JSON cannot carry, so
 * an RPC client can never reach this path (or make the gateway read a file).
 */
function externalSource(p: P): ExternalSource | null {
  const x = p.external;
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  if (!(r.buffer instanceof Uint8Array)) return null;
  const kind = str(r.kind)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 40);
  const id = str(r.id).slice(0, 80);
  if (!kind || !id)
    throw new ContentStudioError("BAD_REQUEST", "external.kind and external.id required");
  if (r.buffer.byteLength === 0)
    throw new ContentStudioError("BAD_REQUEST", "external video is empty");
  const filename = str(r.filename).replace(/[/\\]/g, "_").slice(0, 120) || `${kind}-${id}.mp4`;
  return {
    kind,
    id,
    buffer: Buffer.isBuffer(r.buffer) ? r.buffer : Buffer.from(r.buffer),
    filename,
    contentType: str(r.contentType) || undefined,
  };
}

/**
 * Every place a video can be posted to: one target per (content page, bound
 * platform account). Display + capability info only — never credentials.
 * This is what an external queue (FlyPic) shows in its account picker.
 */
export function listTargets(runner: PostingRunner) {
  const out: Array<{
    id: string;
    pageId: string;
    pageName: string;
    platform: string;
    handle: string;
    deviceId: string | null;
    deviceLabel: string | null;
    verification: string;
    autoPosting: boolean;
    blocker: string | null;
    dryRun: boolean;
    requireApproval: boolean;
    scheduleSummary: string;
    pending: number;
    nextSlotAt: number | null;
    capabilities: {
      video: boolean;
      image: boolean;
      trialReel: boolean;
      designatedTime: boolean;
      nextSlot: boolean;
      frontOfQueue: boolean;
    };
  }> = [];
  for (const cfg of runner.posting.listConfigs()) {
    const page = runner.deps.page(cfg.pageId);
    if (!page || !cfg.deviceId) continue;
    const preview = (() => {
      try {
        return runner.preview(cfg.pageId, 50);
      } catch {
        return null;
      }
    })();
    const queue = runner.posting.listQueue(cfg.pageId, { includeDone: false });
    for (const b of cfg.bindings) {
      out.push({
        id: `${cfg.pageId}:${b.platform}`,
        pageId: cfg.pageId,
        pageName: page.name,
        platform: b.platform,
        handle: b.handle,
        deviceId: cfg.deviceId,
        deviceLabel: cfg.deviceLabel,
        verification: b.verification,
        autoPosting: cfg.enabled,
        blocker: postingBlocker(cfg)?.text ?? null,
        dryRun: cfg.dryRun,
        requireApproval: cfg.requireApproval,
        scheduleSummary: runner.scheduleSummary(cfg.schedule, cfg.dryRun),
        pending: queue.filter((e) => e.platform === b.platform && e.status !== "failed").length,
        nextSlotAt: preview?.upcoming.find((u) => u.platform === b.platform)?.at ?? null,
        capabilities: {
          video: true,
          image: false,
          trialReel: b.platform === "instagram",
          designatedTime: true,
          nextSlot: true,
          frontOfQueue: true,
        },
      });
    }
  }
  return { targets: out, droidAvailable: runner.deps.droid.available() };
}

/** Compact status of entries by id and/or external source ids. */
export function lookupEntries(runner: PostingRunner, p: P) {
  const sourceIds = Array.isArray(p.sourceIds) ? p.sourceIds.map(String) : [];
  const entryIds = Array.isArray(p.entryIds) ? p.entryIds.map(String).slice(0, 500) : [];
  const found = new Map<string, QueueEntry>();
  if (str(p.sourceKind) && sourceIds.length) {
    for (const e of runner.posting.findBySource(str(p.sourceKind), sourceIds)) found.set(e.id, e);
  }
  for (const id of entryIds) {
    const e = runner.posting.getEntry(id);
    if (e) found.set(e.id, e);
  }
  return {
    entries: [...found.values()].map((e) => ({
      id: e.id,
      pageId: e.pageId,
      platform: e.platform,
      status: e.status,
      sourceKind: e.sourceKind,
      sourceId: e.sourceId,
      scheduledAt: e.scheduledAt,
      designatedAt: e.designatedAt,
      postedAt: e.postedAt,
      postUrl: e.postUrl,
      permalink: e.permalink,
      verifyStatus: e.verifyStatus,
      lastError: e.lastError,
      dryRun: e.dryRun,
      trialReel: e.trialReel,
      attempts: e.attempts,
      updatedAt: e.updatedAt,
    })),
  };
}

/**
 * Queues a video. Source (first that is given): mediaId | itemId (its first
 * video) | url (downloaded into the studio library) | path (agent tool only:
 * a local render). episodeId adds title/hook/series/episode from the page's
 * Series database. Explicit fields win over derived ones.
 */
export async function enqueueVideo(
  runner: PostingRunner,
  p: P,
  opts: { allowPath?: boolean } = {},
) {
  const pageId = requirePage(runner, p.pageId);
  const { studio } = runner.deps;
  const cfg = runner.posting.getConfig(pageId);
  const platformsIn = Array.isArray(p.platforms)
    ? p.platforms.map((x) => String(x).toLowerCase())
    : str(p.platform)
      ? [str(p.platform).toLowerCase()]
      : cfg.bindings.length
        ? cfg.bindings.map((b) => b.platform)
        : ["instagram"];
  const platforms = [...new Set(platformsIn)];
  for (const pl of platforms) {
    if (!isPostingPlatform(pl))
      throw new ContentStudioError(
        "BAD_REQUEST",
        `platform must be one of ${POSTING_PLATFORMS.join(", ")}`,
      );
  }

  const derived: {
    title?: string;
    hook?: string;
    series?: string;
    episode?: string;
    hashtags?: string[];
    sourceKind?: string;
    sourceId?: string;
  } = {};
  // In-process only (a plugin such as Droid Swarm's FlyPic link): the video
  // bytes arrive as a Buffer, which no JSON RPC client can send, together
  // with the external source that owns them. Re-delivery of the same source
  // returns the entry already queued for it instead of a second one.
  const external = externalSource(p);
  if (external) {
    const existing = runner.posting.findBySource(external.kind, [external.id]);
    if (existing.length) {
      return { entries: existing.map((e) => entryView(runner, e)), deduped: true };
    }
  }
  let mediaId = str(p.mediaId);
  if (external) {
    const m = await studio.media.saveBuffer({
      buffer: external.buffer,
      filename: external.filename,
      contentType: external.contentType,
      source: external.kind === "flypic" ? "flypic" : "agent",
      caption: str(p.title),
    });
    if (m.kind !== "video")
      throw new ContentStudioError(
        "BAD_REQUEST",
        `${external.filename} is a ${m.kind}, not a video`,
      );
    mediaId = m.id;
    Object.assign(derived, {
      title: str(p.title) || m.filename.replace(/\.[a-z0-9]+$/i, ""),
      sourceKind: external.kind,
      sourceId: external.id,
    });
  } else if (mediaId) {
    const m = studio.store.getMedia(mediaId);
    if (!m) throw new ContentStudioError("NOT_FOUND", `media not found: ${mediaId}`);
    if (m.kind !== "video")
      throw new ContentStudioError("BAD_REQUEST", `media ${mediaId} is a ${m.kind}, not a video`);
    derived.title = m.caption || m.filename.replace(/\.[a-z0-9]+$/i, "");
    derived.sourceKind = "media";
    derived.sourceId = mediaId;
  } else if (str(p.itemId)) {
    const item = studio.store.requireItem(str(p.itemId));
    const video = studio.store.listMediaFor("item", item.id).find((m) => m.kind === "video");
    if (!video)
      throw new ContentStudioError(
        "BAD_REQUEST",
        `pipeline item "${item.title}" has no video attached`,
      );
    mediaId = video.id;
    Object.assign(derived, {
      title: item.title,
      hook: item.summary,
      hashtags: item.tags,
      sourceKind: "item",
      sourceId: item.id,
    });
  } else if (str(p.url)) {
    const m = await studio.media.importUrl({
      url: str(p.url),
      caption: str(p.title),
      source: "url",
    });
    if (m.kind !== "video")
      throw new ContentStudioError("BAD_REQUEST", `that URL is a ${m.kind}, not a video`);
    mediaId = m.id;
    Object.assign(derived, {
      title: str(p.title) || m.filename,
      sourceKind: "url",
      sourceId: str(p.url).slice(0, 80),
    });
  } else if (str(p.path) && opts.allowPath) {
    const file = path.resolve(str(p.path));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile())
      throw new ContentStudioError("BAD_REQUEST", `no such file: ${file}`);
    const m = await studio.media.saveBuffer({
      buffer: fs.readFileSync(file),
      filename: path.basename(file),
      source: "agent",
      caption: str(p.title),
    });
    if (m.kind !== "video")
      throw new ContentStudioError(
        "BAD_REQUEST",
        `${path.basename(file)} is a ${m.kind}, not a video`,
      );
    mediaId = m.id;
    Object.assign(derived, {
      title: str(p.title) || path.basename(file),
      sourceKind: "path",
      sourceId: path.basename(file),
    });
  } else {
    throw new ContentStudioError(
      "BAD_REQUEST",
      "give a video: mediaId, itemId or url" + (opts.allowPath ? " (or path)" : ""),
    );
  }
  if (str(p.episodeId) && !external) {
    const ep = await seriesEpisode(pageId, str(p.episodeId));
    if (!ep)
      throw new ContentStudioError("NOT_FOUND", `series episode not found: ${str(p.episodeId)}`);
    Object.assign(derived, {
      title: ep.title || derived.title,
      hook: ep.hook || derived.hook,
      series: ep.seriesName,
      episode: ep.episode !== null ? String(ep.episode) : "",
      sourceKind: "episode",
      sourceId: ep.id,
    });
  }
  if (external && platforms.length !== 1) {
    // One external item = one entry (its dedupe key is the source id).
    throw new ContentStudioError("BAD_REQUEST", "an external item targets exactly one platform");
  }
  const entries: QueueEntry[] = [];
  for (const platform of platforms) {
    entries.push(
      runner.posting.enqueue(pageId, {
        platform,
        mediaId,
        title: p.title !== undefined ? p.title : derived.title,
        hook: p.hook !== undefined ? p.hook : derived.hook,
        series: p.series !== undefined ? p.series : derived.series,
        episode: p.episode !== undefined ? p.episode : derived.episode,
        hashtags: mergeHashtags(derived.hashtags ?? [], p.hashtags ?? []),
        captionOverride: p.captionOverride,
        trialReel: p.trialReel,
        sourceKind: derived.sourceKind,
        sourceId: derived.sourceId,
        index: p.index,
      }),
    );
  }
  const timed =
    p.postAt !== undefined && p.postAt !== null && p.postAt !== ""
      ? entries.map((e) => runner.posting.setDesignatedAt(e.id, p.postAt))
      : entries;
  return { entries: timed.map((e) => entryView(runner, e)) };
}

export function updateEntry(runner: PostingRunner, p: P) {
  const e = runner.posting.updateEntry(p.entryId, p);
  // postAt: ISO / epoch ms = post at exactly that time; null = follow the page schedule.
  const next = p.postAt !== undefined ? runner.posting.setDesignatedAt(e.id, p.postAt) : e;
  return { entry: entryView(runner, next) };
}

export function reorderQueue(runner: PostingRunner, p: P) {
  const pageId = requirePage(runner, p.pageId);
  if (p.entryId !== undefined && p.toIndex !== undefined) {
    return { queue: runner.posting.move(p.entryId, p.toIndex).map((e) => entryView(runner, e)) };
  }
  return { queue: runner.posting.reorder(pageId, p.order).map((e) => entryView(runner, e)) };
}

/** pause | resume | skip | unskip | retry | remove | verify (re-check a posted video) */
export async function entryAction(runner: PostingRunner, p: P) {
  const op = str(p.op);
  const e = runner.posting.requireEntry(p.entryId);
  if (op === "verify") {
    try {
      return { entry: entryView(runner, await runner.verifyNow(e.id)) };
    } catch (err) {
      throw new ContentStudioError("CONFLICT", err instanceof Error ? err.message : String(err));
    }
  }
  const to: Record<string, QueueStatus> = {
    pause: "paused",
    resume: "queued",
    skip: "skipped",
    unskip: "queued",
    retry: "queued",
  };
  if (op === "remove") return runner.posting.remove(e.id);
  if (!to[op])
    throw new ContentStudioError(
      "BAD_REQUEST",
      "op must be pause, resume, skip, unskip, retry, remove or verify",
    );
  if (op === "resume" && e.status !== "paused")
    throw new ContentStudioError("CONFLICT", `entry is ${e.status}, not paused`);
  if (op === "retry" && e.status !== "failed")
    throw new ContentStudioError(
      "CONFLICT",
      `only failed entries can be retried (entry is ${e.status})`,
    );
  const fields =
    op === "retry"
      ? { attempts: 0, lastError: null, scheduledAt: null, approvalId: null }
      : op === "pause" || op === "skip"
        ? { scheduledAt: null, approvalId: null }
        : { scheduledAt: null };
  const next = runner.posting.transition(e.id, to[op]!, fields, {
    event: op,
    message: `${op[0]!.toUpperCase()}${op.slice(1)} by ${str(p.actor) || "operator"}`,
  });
  return { entry: entryView(runner, next) };
}

export async function postNow(runner: PostingRunner, p: P) {
  const e = runner.posting.requireEntry(p.entryId);
  const report = await runner.postNow(e.id);
  return { report, entry: entryView(runner, runner.posting.requireEntry(e.id)) };
}

/** Live caption preview — optionally with an unsaved template / fields. */
export function previewCaption(runner: PostingRunner, p: P) {
  const pageId = requirePage(runner, p.pageId);
  const cfg = runner.posting.getConfig(pageId);
  const entry = str(p.entryId) ? runner.posting.requireEntry(str(p.entryId)) : null;
  const platform = (entry?.platform ?? str(p.platform)) || cfg.bindings[0]?.platform || "instagram";
  const binding = cfg.bindings.find((b) => b.platform === platform);
  const page = runner.deps.page(pageId);
  const sample = {
    title: str(p.title) || entry?.title || "How we 3x'd our reach in 30 days",
    hook: str(p.hook) || entry?.hook || "Nobody tells you this about short-form…",
    series: str(p.series) || entry?.series || "Growth Diaries",
    episode: str(p.episode) || entry?.episode || "4",
  };
  const template = typeof p.template === "string" ? p.template : cfg.template;
  const rendered = renderCaption(
    template,
    {
      ...sample,
      hashtags: mergeHashtags(p.defaultHashtags ?? cfg.defaultHashtags, entry?.hashtags ?? []),
      cta: typeof p.cta === "string" ? p.cta : cfg.cta,
      date: entry?.scheduledAt ?? Date.now(),
      timezone: cfg.schedule.timezone,
      page: page?.name ?? "",
      handle: binding ? normalizeHandle(binding.handle) : "",
    },
    platform,
  );
  return { ...rendered, platform, sample: !entry };
}

export async function aiCaption(runner: PostingRunner, p: P) {
  const pageId = requirePage(runner, p.pageId);
  const entryId = str(p.entryId) || null;
  const out = await runner.draftCaption(pageId, entryId, str(p.instructions));
  let applied = false;
  if (p.apply === true && entryId) {
    runner.posting.updateEntry(entryId, { captionOverride: out.draft });
    runner.posting.log(pageId, entryId, "caption_ai", null, "AI caption applied as override", {
      actor: str(p.actor) || "operator",
    });
    applied = true;
  }
  return { ...out, applied };
}

export function postingHistory(runner: PostingRunner, p: P) {
  const pageId = requirePage(runner, p.pageId);
  return { history: runner.posting.history(pageId, typeof p.limit === "number" ? p.limit : 100) };
}

export async function tickNow(runner: PostingRunner) {
  return { reports: await runner.tick() };
}
