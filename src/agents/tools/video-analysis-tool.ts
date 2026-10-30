import { Type } from "@sinclair/typebox";
import { listAnalystOptions } from "../../media/video-analysis/personas.js";
import { videoBlockOf } from "../../media/video-analysis/pipeline.js";
import { getVideoAnalysisService } from "../../media/video-analysis/runtime.js";
import { formatTimecode, parseTimecode } from "../../media/video-analysis/sampling.js";
import {
  analysisDataOf,
  isVideoEntry,
  videoAnalysesOf,
} from "../../media/video-analysis/service.js";
import { getOcrService, laneForSession, resolveFilesRoot } from "../../ocr/runtime.js";
import type { OcrAnalysis } from "../../ocr/types.js";
import { getSecureModeRuntime } from "../../secure-mode/runtime.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
import { BATCH_MAX_FILES, capToolPayload, compactFileDigest, readIdList } from "./file-digest.js";

const VideoAnalysisSchema = Type.Object({
  action: Type.Union([
    Type.Literal("list"),
    Type.Literal("get"),
    Type.Literal("analyze"),
    Type.Literal("ask"),
    Type.Literal("analysts"),
  ]),
  id: Type.Optional(
    Type.String({ description: "video file id (f_… / s_…) from list or file_context" }),
  ),
  ids: Type.Optional(
    Type.Array(Type.String(), {
      description: `get: several video ids at once (up to ${BATCH_MAX_FILES}) — compact saved summaries in ONE call`,
    }),
  ),
  path: Type.Optional(
    Type.String({ description: "Files-page path (relative to the files root) or absolute" }),
  ),
  detail: Type.Optional(
    Type.Boolean({ description: "get: full saved observations + longer transcript" }),
  ),
  refresh: Type.Optional(
    Type.Boolean({
      description:
        "analyze/ask: run the vision model again even though a saved analysis/answer exists (slow)",
    }),
  ),
  agentIds: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'analyze: analyst agent ids, e.g. ["archaeologist", "security-analyst"] (see action "analysts")',
    }),
  ),
  instructions: Type.Optional(
    Type.String({ description: "analyze: extra focus for the analysts" }),
  ),
  question: Type.Optional(
    Type.String({
      description:
        'ask: follow-up question; timecodes like "01:23" make the agent look again at those frames',
    }),
  ),
  times: Type.Optional(
    Type.Array(Type.String(), { description: 'ask: timestamps to look at ("01:23", "83s")' }),
  ),
  analysisId: Type.Optional(
    Type.String({ description: "ask: which analysis to follow up (default: latest done)" }),
  ),
  agentId: Type.Optional(
    Type.String({ description: "ask: follow up that agent's latest analysis" }),
  ),
  waitSeconds: Type.Optional(
    Type.Number({
      description:
        "analyze/ask: wait up to N seconds for the result (default 240, 0 = return at once)",
    }),
  ),
  maxChars: Type.Optional(
    Type.Number({ description: "get: cap on transcript text (default 12000)" }),
  ),
});

function compactAnalysis(a: OcrAnalysis, detail = false) {
  const d = analysisDataOf(a);
  const cut = (t: string | undefined, n: number) => (t && t.length > n ? `${t.slice(0, n)}…` : t);
  return {
    analysisId: a.id,
    agentId: a.agentId,
    agent: d?.agentName,
    status: d?.status,
    error: d?.error,
    model: a.model,
    createdAt: new Date(a.createdAt).toISOString(),
    summary: a.summary,
    confidence: d?.confidence ?? null,
    moments: (d?.moments ?? []).map(
      (m) => `[${formatTimecode(m.t)}] ${m.label}${detail && m.detail ? ` — ${m.detail}` : ""}`,
    ),
    entities: (d?.entities ?? []).map(
      (e) => `${e.name}${e.t != null ? ` @${formatTimecode(e.t)}` : ""}`,
    ),
    openQuestions: d?.openQuestions ?? [],
    ...(detail
      ? {
          observations: (d?.observations ?? []).map(
            (o) => `${o.t != null ? `[${formatTimecode(o.t)}] ` : ""}${o.text}`,
          ),
        }
      : {}),
    followUps: (d?.followUps ?? []).map((f) => ({
      id: f.id,
      question: cut(f.question, 200),
      lookedAt: f.times.map(formatTimecode),
      status: f.status,
      answer: detail ? f.answer : cut(f.answer, 500),
      error: f.error,
    })),
  };
}

/**
 * video_analysis — specialist-agent analysis of uploaded videos (local only).
 * Lane-bound like file_context: a Secure Mode session sees only secure-lane
 * videos, a normal session only normal ones.
 */
export function createVideoAnalysisTool(options: { agentSessionKey?: string } = {}): AnyAgentTool {
  return {
    label: "Video Analysis",
    name: "video_analysis",
    description:
      "Uploaded videos are already processed locally (keyframes, transcript with timestamps, on-screen OCR, description) and analyses are SAVED, so reading them is instant. " +
      '"list" recent videos with their saved summaries; "get" with ids[] returns compact saved summaries for many videos in ONE call (prefer this over one call per video); "get" with one id returns its transcript, keyframes and saved analyses. ' +
      '"analyze" (specialist analysts, e.g. archaeologist) and "ask" (follow-up; timecodes like 01:23 make the analyst look again at those frames) run the GPU vision model and are slow (30 s+) — only use them when the saved analysis does not answer; an existing analysis/answer is returned instead unless refresh:true. ' +
      '"analysts" lists who can analyze. Saved analyses are also searchable through file_context.',
    parameters: VideoAnalysisSchema,
    execute: async (_toolCallId, params) => {
      const action = readStringParam(params, "action", { required: true });
      const lane = laneForSession(options.agentSessionKey);
      if (lane === "secure" && !getSecureModeRuntime().isUnlocked()) {
        return jsonResult({ error: "Secure Mode is locked; secure videos are unavailable." });
      }
      const ocr = getOcrService();
      const svc = getVideoAnalysisService();
      const rawPath = readStringParam(params, "path");
      const ref = {
        id: readStringParam(params, "id"),
        path: rawPath
          ? rawPath.startsWith("/")
            ? rawPath
            : `${resolveFilesRoot()}/${rawPath.replace(/^\.?\//, "")}`
          : undefined,
      };
      const waitMs =
        Math.max(0, Math.min(600, readNumberParam(params, "waitSeconds") ?? 240)) * 1000;
      try {
        if (action === "analysts") return jsonResult({ analysts: listAnalystOptions() });
        if (action === "list") {
          const videos = ocr
            .list(lane, { limit: 200 })
            .filter(isVideoEntry)
            .slice(0, 30)
            .map((e) => ({
              id: e.id,
              name: e.name,
              path: e.path,
              status: e.status,
              progress: e.progress,
              summary: e.summary,
              analyses: videoAnalysesOf(ocr.getContext(lane, { id: e.id })?.sidecar).map((a) => ({
                analysisId: a.id,
                agentId: a.agentId,
                status: analysisDataOf(a)?.status,
              })),
            }));
          return jsonResult(capToolPayload({ lane, videos }));
        }
        const ids = readIdList(params.ids);
        if (action === "get" && ids.length > 0) {
          const budget = Math.max(300, Math.floor(20_000 / ids.length));
          const videos = ids.map((id) => {
            const c = ocr.getContext(lane, { id });
            if (!c) return { id, found: false };
            const sc = c.sidecar;
            return {
              ...compactFileDigest(c.entry, sc, budget),
              ...(isVideoEntry(c.entry)
                ? { analyses: videoAnalysesOf(sc).map((a) => compactAnalysis(a, false)) }
                : {}),
            };
          });
          return jsonResult(
            capToolPayload({
              lane,
              count: videos.length,
              videos,
              note: "Saved analyses (no model re-run). get with one id for keyframes + transcript.",
            }),
          );
        }
        if (!ref.id && !ref.path) return jsonResult({ error: "id or path is required" });
        const ctx = ocr.getContext(lane, ref);
        if (!ctx || !isVideoEntry(ctx.entry)) return jsonResult({ found: false });
        const fileId = ctx.entry.id;
        if (action === "get") {
          const v = videoBlockOf(ctx.sidecar);
          const detail = params.detail === true;
          const max = Math.max(
            1000,
            readNumberParam(params, "maxChars") ?? (detail ? 12_000 : 4000),
          );
          const text = ctx.sidecar?.markdown ?? "";
          return jsonResult(
            capToolPayload({
              found: true,
              id: fileId,
              name: ctx.entry.name,
              status: ctx.entry.status,
              progress: ctx.entry.progress,
              meta: v?.meta,
              description: detail
                ? (ctx.sidecar?.description ?? null)
                : (ctx.sidecar?.description ?? "").slice(0, 600) || null,
              keyframes: (v?.keyframes ?? []).map((k) => ({
                at: formatTimecode(k.t),
                t: k.t,
                onScreen: k.ocr?.text,
              })),
              text: text.length > max ? `${text.slice(0, max)}\n[… truncated]` : text,
              analyses: videoAnalysesOf(ctx.sidecar).map((a) => compactAnalysis(a, detail)),
            }),
          );
        }
        if (action === "analyze") {
          const agentIds = Array.isArray(params.agentIds)
            ? (params.agentIds as unknown[]).map(String)
            : [readStringParam(params, "agentId") ?? "archaeologist"];
          const queued = await svc.requestAnalysis({
            lane,
            ref: { id: fileId },
            agentIds,
            instructions: readStringParam(params, "instructions"),
            interactive: true,
            refresh: params.refresh === true,
          });
          if (!waitMs && queued.every((q) => !q.reused)) return jsonResult({ queued });
          const deadline = Date.now() + waitMs;
          const results = [];
          for (const q of queued) {
            const a = await svc.wait({
              lane,
              fileId,
              analysisId: q.analysisId,
              timeoutMs: Math.max(0, deadline - Date.now()),
            });
            const r = a ? compactAnalysis(a, true) : { analysisId: q.analysisId, status: "queued" };
            results.push(q.reused ? { ...r, saved: true } : r);
          }
          return jsonResult(
            capToolPayload({
              id: fileId,
              analyses: results,
              ...(queued.some((q) => q.reused)
                ? { note: "saved analysis returned (pass refresh:true to re-run the analyst)" }
                : {}),
            }),
          );
        }
        if (action === "ask") {
          const question = readStringParam(params, "question", { required: true });
          const rawTimes = Array.isArray(params.times)
            ? (params.times as unknown[]).map(String)
            : [];
          const times = rawTimes.map(parseTimecode).filter((t): t is number => t !== null);
          const r = svc.requestFollowUp({
            lane,
            ref: { id: fileId },
            analysisId: readStringParam(params, "analysisId"),
            agentId: readStringParam(params, "agentId"),
            question,
            times,
            interactive: true,
            refresh: params.refresh === true,
          });
          if (!waitMs && !r.reused) return jsonResult({ queued: r });
          const a = await svc.wait({
            lane,
            fileId,
            analysisId: r.analysisId,
            followUpId: r.followUpId,
            timeoutMs: waitMs,
          });
          const f = analysisDataOf(a)?.followUps?.find((x) => x.id === r.followUpId);
          return jsonResult(
            capToolPayload({
              analysisId: r.analysisId,
              lookedAt: r.times.map(formatTimecode),
              status: f?.status ?? "queued",
              answer: f?.answer,
              error: f?.error,
              frames: f?.frames.map((x) => formatTimecode(x.t)),
              ...(r.reused ? { saved: true } : {}),
            }),
          );
        }
        return jsonResult({ error: `unknown action ${action}` });
      } catch (err) {
        return jsonResult({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}
