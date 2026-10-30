/**
 * content_posting — agent tool for Content Studio's video posting queue.
 * Same operations (posting-ops.ts) and checks as the Posting tab.
 *
 * Owner-only switches stay owner-only: an agent can tighten safety (turn
 * "require approval" or dry-run ON) but cannot loosen it, re-bind the page to
 * another device/account, or switch auto-posting on. Those happen in the UI.
 * post_now still goes through the page's approval mode, min interval, daily
 * cap and Droid Swarm's wrong-account guard.
 */

import { Type } from "@sinclair/typebox";

import type { AnyAgentTool } from "../agents/tools/common.js";
import { jsonResult, readStringParam } from "../agents/tools/common.js";
import { stringEnum } from "../agents/schema/typebox.js";

export const CONTENT_POSTING_TOOL_NAME = "content_posting";

const ACTIONS = [
  "status",
  "list_queue",
  "candidates",
  "queue_video",
  "update_video",
  "move",
  "pause",
  "resume",
  "skip",
  "retry",
  "remove",
  "set_frequency",
  "set_template",
  "set_safety",
  "preview_caption",
  "ai_caption",
  "post_now",
  "devices",
  "detect_accounts",
  "history",
  "set_time",
  "verify",
] as const;

const Schema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      "status (binding, schedule, next post, queue), list_queue, candidates (videos this page can queue), " +
      "queue_video, update_video (title/hook/hashtags/caption override/trialReel), move (reorder), pause, resume, skip, " +
      "retry (failed → queued), remove, set_frequency, set_template (template/hashtags/CTA), " +
      "set_safety (turn requireApproval or dryRun ON), preview_caption, ai_caption (draft; apply:true saves it " +
      "as the video's caption), post_now (refuses when the phone is offline or the bound account is not verified), " +
      "devices (Droid Swarm phones with LIVE adb reachability, last seen, how to fix an offline phone, and the " +
      "accounts detected on each), detect_accounts (drives the phone read-only: wakes it, opens the app, reads the " +
      "logged-in account(s), returns home; reports sessionHealth ok|logged_out|challenge|app_missing|error and " +
      "never taps through a Google/login prompt), history.",
  }),
  pageId: Type.Optional(Type.String({ description: "Content page id (content_pages list)." })),
  entryId: Type.Optional(Type.String({ description: "Queue entry id." })),
  mediaId: Type.Optional(
    Type.String({ description: "queue_video: Content Studio media id of a video." }),
  ),
  itemId: Type.Optional(
    Type.String({ description: "queue_video: pipeline item id (its first video)." }),
  ),
  url: Type.Optional(
    Type.String({ description: "queue_video: video URL to download into the studio." }),
  ),
  path: Type.Optional(Type.String({ description: "queue_video: local video file (a render)." })),
  episodeId: Type.Optional(
    Type.String({
      description: "queue_video: series episode row id — fills title/hook/series/episode.",
    }),
  ),
  platform: Type.Optional(
    stringEnum(["instagram", "tiktok", "all"], {
      description: 'Default: every bound platform. detect_accounts also takes "all".',
    }),
  ),
  title: Type.Optional(Type.String()),
  hook: Type.Optional(Type.String()),
  series: Type.Optional(Type.String()),
  episode: Type.Optional(Type.String()),
  hashtags: Type.Optional(
    Type.Array(Type.String(), { description: "Extra hashtags for this video." }),
  ),
  captionOverride: Type.Optional(
    Type.String({
      description: "Exact caption for this video (replaces the template). Empty string clears it.",
    }),
  ),
  trialReel: Type.Optional(
    Type.Boolean({
      description:
        "queue_video / update_video (Instagram only): share as a Trial reel — shown to non-followers first. If the phone's Instagram has no Trial option the post fails with trial_unavailable (never posted as a regular reel); set false and retry to post normally.",
    }),
  ),
  index: Type.Optional(Type.Number({ description: "queue_video/move: 0-based queue position." })),
  postAt: Type.Optional(
    Type.Union([Type.String(), Type.Number(), Type.Null()], {
      description:
        "queue_video / update_video / set_time: post at exactly this time (ISO 8601 with offset, or epoch ms). " +
        "null clears it (back to the page schedule). Only the min interval / daily cap or an offline/busy phone can delay it, with the reason on the entry.",
    }),
  ),
  mode: Type.Optional(stringEnum(["interval", "daily"], { description: "set_frequency." })),
  everyMinutes: Type.Optional(
    Type.Number({ description: "set_frequency interval mode (e.g. 240 = every 4h)." }),
  ),
  everyHours: Type.Optional(
    Type.Number({ description: "set_frequency: convenience for everyMinutes." }),
  ),
  postsPerDay: Type.Optional(Type.Number({ description: "set_frequency daily mode." })),
  windowStart: Type.Optional(Type.String({ description: 'set_frequency: "09:00".' })),
  windowEnd: Type.Optional(Type.String({ description: 'set_frequency: "21:00".' })),
  timezone: Type.Optional(
    Type.String({ description: 'set_frequency: IANA zone, e.g. "America/New_York".' }),
  ),
  jitterMinutes: Type.Optional(Type.Number({ description: "set_frequency: ± minutes." })),
  dailyCap: Type.Optional(Type.Number({ description: "set_frequency: max posts per local day." })),
  template: Type.Optional(
    Type.String({
      description:
        "set_template / preview_caption: caption template with {title} {hook} {hashtags} {cta} {series} {episode} {date} {page} {handle}.",
    }),
  ),
  defaultHashtags: Type.Optional(
    Type.Array(Type.String(), { description: "set_template: page default hashtags." }),
  ),
  cta: Type.Optional(Type.String({ description: "set_template: call to action line." })),
  requireApproval: Type.Optional(
    Type.Boolean({ description: "set_safety: only true is accepted from agents." }),
  ),
  dryRun: Type.Optional(
    Type.Boolean({ description: "set_safety: only true is accepted from agents." }),
  ),
  instructions: Type.Optional(Type.String({ description: "ai_caption: extra guidance." })),
  apply: Type.Optional(
    Type.Boolean({ description: "ai_caption: save the draft as the entry's caption." }),
  ),
  deviceId: Type.Optional(Type.String({ description: "detect_accounts: Droid Swarm device id." })),
  refresh: Type.Optional(
    Type.Boolean({ description: "devices: skip the few-second adb presence cache." }),
  ),
});

export function createContentPostingTool(ctx?: { agentId?: string }): AnyAgentTool {
  const actor = `agent:${ctx?.agentId ?? "unknown"}`;
  return {
    label: "Content Posting",
    name: CONTENT_POSTING_TOOL_NAME,
    description:
      "Manage a Content Studio page's video posting queue: the page is bound (by the owner) to one Droid Swarm " +
      "phone and its logged-in Instagram/TikTok account. Queue videos (from the page's pipeline items, media, a " +
      "URL or a local render), order/pause/skip/retry them, set the posting frequency (every N hours or X/day " +
      "inside a time window, timezone, jitter, daily cap), set the caption template, preview or AI-draft captions, " +
      "and post now; set_time pins a video to an exact time (postAt). Every entry carries nextRun {at, tone, reason} " +
      "(why it is delayed / held / late). Posting always verifies the active account on the phone and refuses the wrong account; " +
      "after a live post the entry goes verifying → verified (with permalink, the reel's public link) | unverified (reason; " +
      "action verify re-checks). " +
      "pages in approval mode wait for the owner's approval; dry-run pages stop before the final Share tap.",
    parameters: Schema,
    execute: async (_toolCallId, args) => {
      const p: Record<string, unknown> = { ...(args as Record<string, unknown>), actor };
      const action = readStringParam(p, "action", { required: true });
      const ops = await import("./posting-ops.js");
      const { ensurePagesStore, getPostingRunner } = await import("./posting-service.js");
      try {
        await ensurePagesStore();
        const runner = getPostingRunner();
        switch (action) {
          case "status": {
            const s = ops.getPosting(runner, { ...p, historyLimit: 10 });
            return jsonResult({
              pageId: s.pageId,
              binding: {
                deviceId: s.config.deviceId,
                device: s.config.deviceLabel,
                accounts: s.config.bindings,
              },
              enabled: s.config.enabled,
              autoPosting: s.autoPosting,
              requireApproval: s.config.requireApproval,
              dryRun: s.config.dryRun,
              schedule: s.config.schedule,
              effective: s.effective,
              next: s.preview.next,
              held: s.preview.held,
              upcoming: s.preview.upcoming.slice(0, 5),
              queue: s.queue.map((e) => ({
                id: e.id,
                title: e.title,
                platform: e.platform,
                status: e.status,
                scheduledAt: e.scheduledAt,
                designatedAt: e.designatedAt,
                nextRun: e.nextRun,
                lastError: e.lastError,
                verifyStatus: e.verifyStatus,
                permalink: e.permalink,
              })),
              droidSwarmAvailable: s.droidAvailable,
              recent: s.history,
            });
          }
          case "list_queue":
            return jsonResult({ queue: ops.getPosting(runner, p).queue });
          case "candidates":
            return jsonResult(ops.listCandidates(runner, p));
          case "queue_video":
            return jsonResult(await ops.enqueueVideo(runner, p, { allowPath: true }));
          case "update_video":
            return jsonResult(ops.updateEntry(runner, p));
          case "move":
            return jsonResult(ops.reorderQueue(runner, { ...p, toIndex: p.index }));
          case "pause":
          case "resume":
          case "skip":
          case "retry":
          case "remove":
            return jsonResult(await ops.entryAction(runner, { ...p, op: action }));
          case "set_time":
            return jsonResult(
              ops.updateEntry(runner, { entryId: p.entryId, postAt: p.postAt ?? null }),
            );
          case "verify":
            return jsonResult(await ops.entryAction(runner, { ...p, op: "verify" }));
          case "set_frequency": {
            const schedule: Record<string, unknown> = {};
            for (const k of [
              "mode",
              "everyMinutes",
              "postsPerDay",
              "windowStart",
              "windowEnd",
              "timezone",
              "jitterMinutes",
              "dailyCap",
            ]) {
              if (p[k] !== undefined) schedule[k] = p[k];
            }
            if (typeof p.everyHours === "number") {
              schedule.everyMinutes = Math.round(p.everyHours * 60);
              schedule.mode ??= "interval";
            }
            if (!Object.keys(schedule).length)
              return jsonResult({ error: "give at least one frequency field" });
            return jsonResult(
              await ops.configurePosting(runner, { pageId: p.pageId, schedule, actor }),
            );
          }
          case "set_template": {
            const patch: Record<string, unknown> = { pageId: p.pageId, actor };
            for (const k of ["template", "defaultHashtags", "cta"])
              if (p[k] !== undefined) patch[k] = p[k];
            const res = await ops.configurePosting(runner, patch);
            return jsonResult({
              ...res,
              preview: ops.previewCaption(runner, { pageId: p.pageId }),
            });
          }
          case "set_safety": {
            if (p.requireApproval === false || p.dryRun === false) {
              return jsonResult({
                error:
                  "agents can only turn requireApproval / dryRun ON; switching to auto-post or live posting is the owner's call in Content Studio › Posting",
              });
            }
            const patch: Record<string, unknown> = { pageId: p.pageId, actor };
            if (p.requireApproval === true) patch.requireApproval = true;
            if (p.dryRun === true) patch.dryRun = true;
            return jsonResult(await ops.configurePosting(runner, patch));
          }
          case "preview_caption":
            return jsonResult(ops.previewCaption(runner, p));
          case "ai_caption":
            return jsonResult(await ops.aiCaption(runner, p));
          case "post_now":
            return jsonResult(await ops.postNow(runner, p));
          case "devices":
            return jsonResult(await ops.listDevices(runner, p));
          case "detect_accounts":
            return jsonResult(await ops.detectAccounts(runner, p));
          case "history":
            return jsonResult(ops.postingHistory(runner, p));
          default:
            return jsonResult({ error: `unknown action ${action}` });
        }
      } catch (err) {
        return jsonResult({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}
