/**
 * VideoAnalysisService — specialist-agent analyses and "look again"
 * follow-ups for videos processed by the auto-OCR queue.
 *
 * Extraction (probe/keyframes/OCR/transcript) runs in the OCR queue through
 * the "video" handler; this service only runs the agent passes that come
 * after it. Each request is a small durable job (normal lane: JSON under the
 * state dir; secure lane: sealed in the vault). Results are written into the
 * video's sidecar with OcrService.addAnalysis/updateSidecar, which also
 * refreshes search, the agent memory mirror and the KG file node — for the
 * normal lane only. One job runs at a time (the GPU is the bottleneck).
 */
import {
  backgroundPaused,
  onBackgroundPauseChange,
  waitForBackgroundSlot,
} from "../../ocr/interactive-gate.js";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isLocalEndpoint } from "../../ocr/local-only.js";
import type { OcrRef, OcrService } from "../../ocr/service.js";
import { secureScratchDir } from "../../ocr/store.js";
import type { OcrAnalysis, OcrEntry, OcrLane, OcrSidecar } from "../../ocr/types.js";
import type { SecureVault } from "../../secure-mode/vault.js";
import {
  askAnalysis,
  buildAnalysisPrompt,
  buildLookAgainPrompt,
  parseFindings,
  pickAnalysisFrames,
} from "./analyze.js";
import type { FrameStore } from "./frame-store.js";
import { resolvePersona, type AnalystPersona } from "./personas.js";
import { videoBlockOf, type MediaTools } from "./pipeline.js";
import { formatTimecode, lookAroundTimes, timecodesInText } from "./sampling.js";
import {
  VIDEO_ANALYZER,
  VIDEO_EXTS,
  type VideoAnalysisData,
  type VideoBlock,
  type VideoFollowUp,
} from "./types.js";

export interface VideoJob {
  id: string;
  kind: "analysis" | "followup";
  lane: OcrLane;
  fileId: string;
  analysisId: string;
  followUpId?: string;
  agentId: string;
  instructions?: string;
  status: "queued" | "running" | "done" | "failed";
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
  error?: string;
  /**
   * Requested from an agent turn that is waiting on it: keeps running while an
   * interactive local-model turn pauses background GPU work.
   */
  interactive?: boolean;
}

interface JobStore {
  available(): boolean;
  load(): VideoJob[];
  save(jobs: VideoJob[]): void;
}

class NormalJobStore implements JobStore {
  constructor(private readonly file: string) {}
  available() {
    return true;
  }
  load(): VideoJob[] {
    try {
      return (JSON.parse(fs.readFileSync(this.file, "utf8")) as { jobs?: VideoJob[] }).jobs ?? [];
    } catch {
      return [];
    }
  }
  save(jobs: VideoJob[]) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, jobs }));
    fs.renameSync(tmp, this.file);
  }
}

class SecureJobStore implements JobStore {
  constructor(private readonly vault: () => SecureVault | null) {}
  available() {
    try {
      return this.vault() !== null;
    } catch {
      return false;
    }
  }
  load(): VideoJob[] {
    const v = this.vault();
    if (!v) return [];
    return v.readJson<{ jobs?: VideoJob[] }>("video-analysis-jobs", {}).jobs ?? [];
  }
  save(jobs: VideoJob[]) {
    const v = this.vault();
    if (!v) throw new Error("Secure Mode is locked");
    v.writeJson("video-analysis-jobs", { version: 1, jobs });
  }
}

export interface VideoAnalysisDeps {
  stateDir: string;
  ocr: () => OcrService;
  frames: (lane: OcrLane) => FrameStore;
  tools: MediaTools;
  secureVault: () => SecureVault | null;
  /** Agent persona lookup (config agents / templates). */
  persona?: (agentId: string) => AnalystPersona;
  /** Create a template analyst agent on first use; returns the agent id. */
  ensureAgent?: (agentId: string) => Promise<string>;
  log?: { info: (m: string) => void; warn: (m: string) => void };
  now?: () => number;
  pollMs?: number;
  maxAttempts?: number;
}

export function isVideoEntry(entry: Pick<OcrEntry, "ext" | "mime">): boolean {
  return (
    (VIDEO_EXTS as readonly string[]).includes(entry.ext.toLowerCase()) ||
    (entry.mime ?? "").startsWith("video/")
  );
}

export function analysisDataOf(a: OcrAnalysis | undefined | null): VideoAnalysisData | null {
  const d = a?.data as VideoAnalysisData | undefined;
  return d && d.kind === "video-analysis" ? d : null;
}

export function videoAnalysesOf(sc: OcrSidecar | null | undefined): OcrAnalysis[] {
  return (sc?.analyses ?? []).filter((a) => a.analyzer === VIDEO_ANALYZER);
}

/** Merge one analysis into a sidecar's analyses[] (replace by id, keep others, stable order). */
export function mergeAnalysis(list: OcrAnalysis[] | undefined, next: OcrAnalysis): OcrAnalysis[] {
  const cur = list ?? [];
  const i = cur.findIndex((a) => a.id === next.id);
  if (i < 0) return [...cur, next];
  const out = [...cur];
  out[i] = next;
  return out;
}

const shortId = () => randomBytes(4).toString("hex");

export class VideoAnalysisService {
  private readonly jobs: Record<OcrLane, JobStore>;
  private readonly now: () => number;
  private running: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private draining: Promise<void> | null = null;
  private unsubscribePause: (() => void) | null = null;

  constructor(private readonly deps: VideoAnalysisDeps) {
    this.now = deps.now ?? Date.now;
    this.jobs = {
      normal: new NormalJobStore(path.join(deps.stateDir, "video-analysis", "jobs.json")),
      secure: new SecureJobStore(deps.secureVault),
    };
  }

  private log(lane: OcrLane, msg: string, secureMsg?: string) {
    // Secure lane: never log file names, questions or findings.
    this.deps.log?.info(
      lane === "secure" ? (secureMsg ?? "video-analysis: secure job update") : msg,
    );
  }

  // ── lifecycle ────────────────────────────────────────────────────────

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    for (const lane of ["normal", "secure"] as const) this.recover(lane);
    const tick = () => {
      if (this.stopped) return;
      void this.drain().finally(() => {
        if (!this.stopped) {
          this.timer = setTimeout(tick, this.deps.pollMs ?? 4000);
          this.timer.unref?.();
        }
      });
    };
    this.timer = setTimeout(tick, 100);
    this.timer.unref?.();
    this.unsubscribePause = onBackgroundPauseChange((paused) => {
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

  kick() {
    if (this.stopped) return;
    setImmediate(() => void this.drain());
  }

  private recover(lane: OcrLane) {
    const store = this.jobs[lane];
    if (!store.available()) return;
    try {
      const jobs = store.load();
      let changed = false;
      for (const j of jobs) {
        if (j.status === "running") {
          j.status = "queued";
          j.nextAttemptAt = 0;
          changed = true;
        }
      }
      // Forget finished jobs older than a day.
      const keep = jobs.filter(
        (j) =>
          !(j.status === "done" || j.status === "failed") || this.now() - j.createdAt < 86_400_000,
      );
      if (changed || keep.length !== jobs.length) store.save(keep);
    } catch (err) {
      this.deps.log?.warn(`video-analysis: recover ${lane} failed: ${String(err)}`);
    }
  }

  drain(): Promise<void> {
    this.draining ??= (async () => {
      try {
        for (let i = 0; i < 200; i++) if (!(await this.processNext())) break;
      } finally {
        this.draining = null;
      }
    })();
    return this.draining;
  }

  private patchJob(lane: OcrLane, id: string, fn: (j: VideoJob) => void) {
    const store = this.jobs[lane];
    const jobs = store.load();
    const j = jobs.find((x) => x.id === id);
    if (!j) return null;
    fn(j);
    store.save(jobs);
    return j;
  }

  private nextDue(): VideoJob | null {
    const now = this.now();
    // An interactive local-model turn holds the GPU: only the jobs it asked for.
    const interactiveOnly = backgroundPaused();
    let best: VideoJob | null = null;
    for (const lane of ["secure", "normal"] as const) {
      const store = this.jobs[lane];
      if (!store.available()) continue;
      for (const j of store.load()) {
        if (j.status !== "queued" || j.nextAttemptAt > now) continue;
        if (interactiveOnly && !j.interactive) continue;
        // Follow-ups jump ahead of full analyses (someone is waiting on them).
        const rank = (x: VideoJob) => (x.kind === "followup" ? 0 : 1);
        if (
          !best ||
          rank(j) < rank(best) ||
          (rank(j) === rank(best) && j.createdAt < best.createdAt)
        ) {
          best = j;
        }
      }
    }
    return best;
  }

  /** Run one due job. Returns false when nothing was due. */
  async processNext(): Promise<boolean> {
    if (this.running) return false;
    const job = this.nextDue();
    if (!job) return false;
    this.running = job.id;
    try {
      const ocr = this.deps.ocr();
      const ctx = ocr.laneAvailable(job.lane) ? ocr.getContext(job.lane, { id: job.fileId }) : null;
      if (!ctx) {
        this.patchJob(job.lane, job.id, (j) => {
          j.status = "failed";
          j.error = "video no longer exists";
        });
        return true;
      }
      if (ctx.entry.status !== "done" || !videoBlockOf(ctx.sidecar)) {
        if (ctx.entry.status === "failed") {
          await this.failJob(job, `video processing failed: ${ctx.entry.error ?? "error"}`, true);
        } else {
          // Extraction still running — check again shortly.
          this.patchJob(job.lane, job.id, (j) => {
            j.nextAttemptAt = this.now() + 3000;
          });
        }
        return true;
      }
      this.patchJob(job.lane, job.id, (j) => {
        j.status = "running";
        j.attempts += 1;
      });
      if (job.kind === "analysis") await this.runAnalysis(job, ctx.entry, ctx.sidecar!);
      else await this.runFollowUp(job, ctx.entry, ctx.sidecar!);
      this.patchJob(job.lane, job.id, (j) => {
        j.status = "done";
        j.error = undefined;
      });
    } catch (err) {
      await this.failJob(job, err instanceof Error ? err.message : String(err), false);
    } finally {
      this.running = null;
    }
    return true;
  }

  private async failJob(job: VideoJob, message: string, final: boolean) {
    const max = this.deps.maxAttempts ?? 2;
    const cur = this.jobs[job.lane].load().find((j) => j.id === job.id);
    const giveUp = final || (cur?.attempts ?? 1) >= max;
    this.patchJob(job.lane, job.id, (j) => {
      j.error = message.slice(0, 500);
      j.status = giveUp ? "failed" : "queued";
      j.nextAttemptAt = giveUp ? 0 : this.now() + 15_000;
    });
    this.log(
      job.lane,
      `video-analysis: ${giveUp ? "failed" : "retry"} ${job.kind} ${job.analysisId}: ${message}`,
    );
    if (!giveUp) return;
    try {
      this.deps.ocr().updateSidecar(job.lane, { id: job.fileId }, (sc) => {
        const a = sc.analyses?.find((x) => x.id === job.analysisId);
        const d = analysisDataOf(a);
        if (!a || !d) return;
        if (job.kind === "analysis") {
          d.status = "failed";
          d.error = message.slice(0, 500);
          a.summary = a.summary || `Analysis failed: ${message.slice(0, 200)}`;
        } else {
          const f = d.followUps?.find((x) => x.id === job.followUpId);
          if (f) {
            f.status = "failed";
            f.error = message.slice(0, 500);
          }
        }
      });
    } catch {
      /* lane locked — the job record keeps the error */
    }
  }

  // ── local-only guard ─────────────────────────────────────────────────

  /**
   * The vision model must be the loopback client; refuse anything else.
   * Background jobs wait for interactive local-model turns before each call.
   */
  private requireLocalVision(job?: VideoJob) {
    const vl = this.requireLoopbackVision();
    if (!job) return vl;
    if (job.interactive) {
      // The asking chat turn holds the runtime: no background lease.
      return {
        model: () => vl.model(),
        ask: (params: Parameters<typeof vl.ask>[0]) => vl.ask({ ...params, interactive: true }),
      };
    }
    return {
      model: () => vl.model(),
      ask: async (params: Parameters<typeof vl.ask>[0]) => {
        await waitForBackgroundSlot();
        return vl.ask(params);
      },
    };
  }

  private requireLoopbackVision() {
    const ocr = this.deps.ocr();
    const url = ocr.cfg.ollamaUrl;
    if (!url || !isLocalEndpoint(url)) {
      throw new Error("video analysis is local-only: no loopback vision endpoint configured");
    }
    const vl = ocr.engines.vl;
    if (!vl) throw new Error("no local vision model configured (Ollama on 127.0.0.1 required)");
    return vl;
  }

  private scratch(lane: OcrLane): string {
    const base =
      lane === "secure"
        ? secureScratchDir()
        : path.join(this.deps.stateDir, "video-analysis", "tmp");
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    return fs.mkdtempSync(path.join(base, "va-"));
  }

  private persona(agentId: string): AnalystPersona {
    return (this.deps.persona ?? resolvePersona)(agentId);
  }

  // ── job bodies ───────────────────────────────────────────────────────

  private async runAnalysis(job: VideoJob, entry: OcrEntry, sc: OcrSidecar) {
    const vl = this.requireLocalVision(job);
    const video = videoBlockOf(sc)!;
    const store = this.deps.frames(job.lane);
    const persona = this.persona(job.agentId);
    const model = await vl.model().catch(() => null);
    if (!model) throw new Error("no local vision model installed in Ollama");
    this.ensurePlaceholder(job, persona);
    this.setAnalysis(job, (a, d) => {
      d.status = "running";
      d.startedAt = this.now();
      d.agentName = persona.name;
      a.model = model;
    });
    const tmp = this.scratch(job.lane);
    try {
      const frames = pickAnalysisFrames(video.keyframes);
      const images: string[] = [];
      const sheet = video.contactSheet ? store.get(video.frameKey, video.contactSheet.id) : null;
      if (sheet) {
        const p = path.join(tmp, "sheet.jpg");
        fs.writeFileSync(p, sheet, { mode: 0o600 });
        images.push(p);
      }
      const used: typeof frames = [];
      for (const k of frames) {
        const buf = store.get(video.frameKey, k.id);
        if (!buf) continue;
        const p = path.join(tmp, k.id);
        fs.writeFileSync(p, buf, { mode: 0o600 });
        images.push(p);
        used.push(k);
      }
      if (!images.length) throw new Error("no keyframes available for this video");
      const prompt = buildAnalysisPrompt({
        persona,
        fileName: entry.name,
        video,
        frames: used,
        hasSheet: Boolean(sheet),
        instructions: job.instructions,
      });
      const r = await askAnalysis({ vl, prompt, images });
      const findings = parseFindings(r.text, video.meta.duration);
      // Thumbnails for notable moments, captured at their exact timecodes.
      const moments = await this.captureFrames(
        job.lane,
        entry,
        video,
        findings.moments.slice(0, 12).map((m) => m.t),
        `m-${job.analysisId.split(":").pop()}`,
        tmp,
      );
      findings.moments = findings.moments.map((m) => ({
        ...m,
        frameId: moments.find((x) => x.t === m.t)?.frameId,
      }));
      this.setAnalysis(job, (a, d) => {
        Object.assign(d, findings, {
          status: "done",
          finishedAt: this.now(),
          framesUsed: used.map((k) => k.id),
          error: undefined,
        });
        a.model = r.model;
        a.summary = findings.summary || "(no summary)";
        // Short noun titles first (they become KG topics); observations go to
        // frames (still searchable, not topics).
        a.findings = [
          ...findings.entities.map((e) => ({
            title: e.name,
            detail: [e.type, e.confidence != null ? `confidence ${e.confidence}` : ""]
              .filter(Boolean)
              .join(", "),
            at: e.t,
          })),
          ...findings.moments.map((m) => ({ title: m.label, detail: m.detail, at: m.t })),
        ];
        a.frames = [
          ...findings.moments.map((m) => ({
            t: m.t,
            description: `${m.label}${m.detail ? ` — ${m.detail}` : ""}`,
          })),
          ...findings.observations.map((o) => ({ t: o.t ?? 0, text: o.text })),
        ];
      });
      this.log(
        job.lane,
        `video-analysis: ${persona.name} finished ${entry.name} (${findings.moments.length} moments, ${findings.entities.length} entities)`,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  private async runFollowUp(job: VideoJob, entry: OcrEntry, sc: OcrSidecar) {
    const vl = this.requireLocalVision(job);
    const video = videoBlockOf(sc)!;
    const a = sc.analyses?.find((x) => x.id === job.analysisId);
    const d = analysisDataOf(a);
    const fu = d?.followUps?.find((f) => f.id === job.followUpId);
    if (!a || !d || !fu) throw new Error("follow-up no longer exists");
    const persona = this.persona(job.agentId);
    this.setFollowUp(job, (f) => {
      f.status = "running";
    });
    const tmp = this.scratch(job.lane);
    try {
      const store = this.deps.frames(job.lane);
      let images: string[] = [];
      let shown: Array<{ t: number; frameId: string }> = [];
      if (fu.times.length) {
        const times = [...new Set(fu.times.flatMap((t) => lookAroundTimes(t, video.meta.duration)))]
          .sort((x, y) => x - y)
          .slice(0, 6);
        shown = await this.captureFrames(job.lane, entry, video, times, `f-${fu.id}`, tmp);
        images = shown.map((s) => path.join(tmp, s.frameId));
      } else if (video.contactSheet) {
        const buf = store.get(video.frameKey, video.contactSheet.id);
        if (buf) {
          const p = path.join(tmp, "sheet.jpg");
          fs.writeFileSync(p, buf, { mode: 0o600 });
          images = [p];
        }
      }
      if (!images.length) throw new Error("could not extract frames for the follow-up");
      const prompt = buildLookAgainPrompt({
        persona,
        fileName: entry.name,
        question: fu.question,
        frames: shown.length ? shown : [{ t: 0 }],
        video,
        priorSummary: a.summary,
      });
      const r = await vl.ask({ images, prompt, timeoutMs: 600_000 });
      this.setFollowUp(job, (f) => {
        f.status = "done";
        f.answer = r.text.trim();
        f.model = r.model;
        f.frames = shown;
        f.error = undefined;
      });
      this.log(job.lane, `video-analysis: follow-up answered for ${entry.name}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** Extract frames at `times` from the (materialized) video into the frame store. */
  private async captureFrames(
    lane: OcrLane,
    entry: OcrEntry,
    video: VideoBlock,
    times: number[],
    prefix: string,
    tmp: string,
  ): Promise<Array<{ t: number; frameId: string }>> {
    if (!times.length) return [];
    const ocr = this.deps.ocr();
    const store = this.deps.frames(lane);
    const mat = await ocr.stores[lane].materialize(entry);
    const out: Array<{ t: number; frameId: string }> = [];
    try {
      for (const t of times) {
        const frameId = `${prefix}-${Math.round(t * 1000)}.jpg`;
        const p = path.join(tmp, frameId);
        try {
          await this.deps.tools.extractFrame(mat.path, t, p, 640);
          store.put(video.frameKey, frameId, fs.readFileSync(p));
          out.push({ t, frameId });
        } catch {
          /* a frame past the end etc. — skip */
        }
      }
    } finally {
      mat.cleanup();
    }
    return out;
  }

  private ensurePlaceholder(job: VideoJob, persona: AnalystPersona) {
    this.deps.ocr().updateSidecar(job.lane, { id: job.fileId }, (sc) => {
      if (sc.analyses?.some((a) => a.id === job.analysisId)) return;
      const data: VideoAnalysisData = {
        kind: "video-analysis",
        status: "queued",
        agentName: persona.name,
        followUps: [],
      };
      sc.analyses = mergeAnalysis(sc.analyses, {
        id: job.analysisId,
        analyzer: VIDEO_ANALYZER,
        agentId: job.agentId,
        model: null,
        createdAt: job.createdAt,
        summary: "",
        data: data as unknown as Record<string, unknown>,
      });
    });
  }

  private setAnalysis(job: VideoJob, fn: (a: OcrAnalysis, d: VideoAnalysisData) => void) {
    this.deps.ocr().updateSidecar(job.lane, { id: job.fileId }, (sc) => {
      const a = sc.analyses?.find((x) => x.id === job.analysisId);
      const d = analysisDataOf(a);
      if (a && d) fn(a, d);
    });
  }

  private setFollowUp(job: VideoJob, fn: (f: VideoFollowUp) => void) {
    this.setAnalysis(job, (_a, d) => {
      const f = d.followUps?.find((x) => x.id === job.followUpId);
      if (f) fn(f);
    });
  }

  // ── requests ─────────────────────────────────────────────────────────

  private requireVideo(lane: OcrLane, ref: OcrRef) {
    const ocr = this.deps.ocr();
    const ctx = ocr.getContext(lane, ref);
    if (!ctx) throw new Error("video not found (upload it first, or wait for it to be registered)");
    if (!isVideoEntry(ctx.entry)) throw new Error("not a video file");
    return ctx;
  }

  private pushJob(job: VideoJob) {
    const store = this.jobs[job.lane];
    if (!store.available()) throw new Error("Secure Mode is locked");
    const jobs = store.load();
    jobs.push(job);
    store.save(jobs);
  }

  /** Queue one analysis per agent. Returns the analysis ids. */
  async requestAnalysis(params: {
    lane: OcrLane;
    ref: OcrRef;
    agentIds: string[];
    instructions?: string;
    /** Agent tool waiting on the result (runs even while background work is paused). */
    interactive?: boolean;
    /**
     * Re-run even when this analyst already analyzed the video. Without it an
     * existing done/queued/running analysis by the same analyst is returned
     * (`reused: true`) — vision never re-runs for something already analyzed.
     */
    refresh?: boolean;
  }): Promise<Array<{ analysisId: string; agentId: string; reused?: boolean }>> {
    const ids = [...new Set(params.agentIds.map((a) => a.trim()).filter(Boolean))].slice(0, 6);
    if (!ids.length) throw new Error("pick at least one analyst agent");
    const { entry, sidecar } = this.requireVideo(params.lane, params.ref);
    const ocr = this.deps.ocr();
    const out: Array<{ analysisId: string; agentId: string; reused?: boolean }> = [];
    const existing = videoAnalysesOf(sidecar);
    for (const raw of ids) {
      const agentId = this.deps.ensureAgent ? await this.deps.ensureAgent(raw) : raw;
      if (!params.refresh && !params.instructions?.trim()) {
        const prior = [...existing]
          .reverse()
          .find((x) => x.agentId === agentId && analysisDataOf(x)?.status !== "failed");
        if (prior) {
          out.push({ analysisId: prior.id, agentId, reused: true });
          continue;
        }
      }
      const persona = this.persona(agentId);
      const analysisId = `agent:${agentId}:${this.now().toString(36)}${shortId().slice(0, 3)}`;
      const data: VideoAnalysisData = {
        kind: "video-analysis",
        status: "queued",
        agentName: persona.name,
        followUps: [],
      };
      const analysis: OcrAnalysis = {
        id: analysisId,
        analyzer: VIDEO_ANALYZER,
        agentId,
        model: null,
        createdAt: this.now(),
        summary: "",
        data: data as unknown as Record<string, unknown>,
      };
      // Sidecar not written yet (still extracting): the job adds the placeholder when it runs.
      if (entry.status === "done") ocr.addAnalysis(params.lane, { id: entry.id }, analysis);
      this.pushJob({
        id: `vj_${shortId()}${shortId()}`,
        kind: "analysis",
        lane: params.lane,
        fileId: entry.id,
        analysisId,
        agentId,
        instructions: params.instructions?.slice(0, 1000),
        status: "queued",
        attempts: 0,
        nextAttemptAt: 0,
        createdAt: this.now(),
        ...(params.interactive ? { interactive: true } : {}),
      });
      out.push({ analysisId, agentId });
    }
    if (out.some((o) => !o.reused)) this.kick();
    return out;
  }

  /** Ask an analysis's agent a follow-up; it looks again at the mentioned timestamps. */
  requestFollowUp(params: {
    lane: OcrLane;
    ref: OcrRef;
    analysisId?: string;
    agentId?: string;
    question: string;
    times?: number[];
    interactive?: boolean;
    /** Ask again even when the same question about the same moments was answered. */
    refresh?: boolean;
  }): { analysisId: string; followUpId: string; times: number[]; reused?: boolean } {
    const question = params.question.trim().slice(0, 2000);
    if (!question) throw new Error("question required");
    const { entry, sidecar } = this.requireVideo(params.lane, params.ref);
    const list = videoAnalysesOf(sidecar);
    const a =
      (params.analysisId && list.find((x) => x.id === params.analysisId)) ||
      (params.agentId && [...list].reverse().find((x) => x.agentId === params.agentId)) ||
      [...list].reverse().find((x) => analysisDataOf(x)?.status === "done");
    if (!a) throw new Error("no analysis on this video yet — run an analyst first");
    const times = (params.times?.length ? params.times : timecodesInText(question))
      .filter((t) => Number.isFinite(t) && t >= 0)
      .slice(0, 4);
    if (!params.refresh) {
      const norm = (q: string) => q.trim().toLowerCase().replace(/\s+/g, " ");
      const key = times.join(",");
      const prior = (analysisDataOf(a)?.followUps ?? []).find(
        (f) =>
          f.status !== "failed" && norm(f.question) === norm(question) && f.times.join(",") === key,
      );
      if (prior) return { analysisId: a.id, followUpId: prior.id, times, reused: true };
    }
    const fu: VideoFollowUp = {
      id: shortId(),
      question,
      times,
      status: "queued",
      frames: [],
      createdAt: this.now(),
    };
    this.deps.ocr().updateSidecar(params.lane, { id: entry.id }, (sc) => {
      const cur = sc.analyses?.find((x) => x.id === a.id);
      const d = analysisDataOf(cur);
      if (d) d.followUps = [...(d.followUps ?? []), fu];
    });
    this.pushJob({
      id: `vj_${shortId()}${shortId()}`,
      kind: "followup",
      lane: params.lane,
      fileId: entry.id,
      analysisId: a.id,
      followUpId: fu.id,
      agentId: a.agentId ?? "main",
      status: "queued",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.now(),
      ...(params.interactive ? { interactive: true } : {}),
    });
    this.kick();
    return { analysisId: a.id, followUpId: fu.id, times };
  }

  /** Wait (bounded) for an analysis or follow-up to finish. */
  async wait(params: {
    lane: OcrLane;
    fileId: string;
    analysisId: string;
    followUpId?: string;
    timeoutMs: number;
  }): Promise<OcrAnalysis | null> {
    const deadline = this.now() + params.timeoutMs;
    for (;;) {
      const sc = this.deps.ocr().getContext(params.lane, { id: params.fileId })?.sidecar;
      const a = sc?.analyses?.find((x) => x.id === params.analysisId) ?? null;
      const d = analysisDataOf(a);
      const status = params.followUpId
        ? d?.followUps?.find((f) => f.id === params.followUpId)?.status
        : d?.status;
      if (status === "done" || status === "failed") return a;
      if (this.now() >= deadline) return a;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  jobsFor(lane: OcrLane, fileId: string): VideoJob[] {
    const store = this.jobs[lane];
    if (!store.available()) return [];
    return store.load().filter((j) => j.fileId === fileId && j.status !== "done");
  }

  /** Drop frame folders / vault frames whose video is gone. */
  sweepOrphans(lane: OcrLane, listKeys: () => string[], remove: (k: string) => void) {
    try {
      const ocr = this.deps.ocr();
      if (!ocr.laneAvailable(lane)) return;
      const live = new Set(ocr.list(lane, { limit: 2000 }).map((e) => e.sha256.slice(0, 24)));
      for (const k of listKeys()) if (!live.has(k)) remove(k);
    } catch (err) {
      this.deps.log?.warn(`video-analysis: orphan sweep failed: ${String(err)}`);
    }
  }
}

export function describeFollowUp(f: VideoFollowUp): string {
  return `${f.times.map(formatTimecode).join(", ") || "whole video"}: ${f.question}`;
}
