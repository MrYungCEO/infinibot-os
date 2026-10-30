import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerExtractionHandler } from "../../ocr/handlers.js";
import { beginInteractiveTurn, resetInteractiveGateForTests } from "../../ocr/interactive-gate.js";
import { resolveOcrConfig } from "../../ocr/local-only.js";
import { OcrService } from "../../ocr/service.js";
import type { OcrAnalysis, OcrEngines } from "../../ocr/types.js";
import { SecureVault } from "../../secure-mode/vault.js";
import { extractJson, parseFindings, pickAnalysisFrames, transcriptExcerpt } from "./analyze.js";
import * as ff from "./ffmpeg.js";
import { NormalFrameStore, SecureFrameStore, frameKeyFor, type FrameStore } from "./frame-store.js";
import { personaPromptFor, resolvePersona } from "./personas.js";
import { cleanEntities, processVideo, videoBlockOf, type MediaTools } from "./pipeline.js";
import {
  formatTimecode,
  frameBudget,
  lookAroundTimes,
  parseSceneLog,
  parseTimecode,
  planChunks,
  selectKeyframes,
  timecodesInText,
} from "./sampling.js";
import { analysisDataOf, mergeAnalysis, VideoAnalysisService, videoAnalysesOf } from "./service.js";
import {
  createLocalTranscriber,
  normalizeSegments,
  resolveSttConfig,
  type Transcriber,
} from "./transcribe.js";
import { VIDEO_ANALYZER, VIDEO_EXTS, type VideoAnalysisData } from "./types.js";

function tmpDir(tag: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ib-video-${tag}-`));
}

function walk(d: string): string[] {
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

// ── pure planning ────────────────────────────────────────────────────────

describe("chunking", () => {
  it("splits long videos into fixed chunks and folds a short tail into the last one", () => {
    expect(planChunks(95, 30).map((c) => [c.start, c.end])).toEqual([
      [0, 30],
      [30, 60],
      [60, 95], // 5 s tail < 25% of 30 → merged
    ]);
    expect(planChunks(100, 30)).toHaveLength(4); // 10 s tail stays its own chunk
    expect(
      planChunks(125, 30)
        .map((c) => [c.start, c.end])
        .at(-1),
    ).toEqual([90, 125]);
    expect(planChunks(20, 300)).toEqual([{ index: 0, start: 0, end: 20, done: false }]);
    expect(planChunks(3600, 300)).toHaveLength(12);
    expect(planChunks(0, 300)).toHaveLength(1);
  });

  it("caps the frame budget and keeps short clips useful", () => {
    expect(frameBudget(10, 48)).toBe(6);
    expect(frameBudget(120, 48)).toBe(24);
    expect(frameBudget(7200, 48)).toBe(48);
  });
});

describe("adaptive keyframe sampling", () => {
  it("prefers strong scene changes, honours min gap, fills coverage gaps, respects the budget", () => {
    const picks = selectKeyframes({
      candidates: [
        { t: 10, score: 0.9 },
        { t: 10.5, score: 0.8 }, // too close to 10
        { t: 30, score: 0.4 },
        { t: 31, score: 0.35 }, // too close to 30
      ],
      start: 0,
      end: 60,
      budget: 8,
      minGapSec: 2,
      maxGapSec: 15,
    });
    const ts = picks.map((p) => p.t);
    expect(ts).toContain(0.5);
    expect(ts).toContain(10);
    expect(ts).toContain(30);
    expect(ts).not.toContain(10.5);
    expect(ts).not.toContain(31);
    for (let i = 1; i < ts.length; i++) expect(ts[i] - ts[i - 1]).toBeGreaterThanOrEqual(2);
    const gaps = [...ts, 60].map((t, i, a) => (i ? t - a[i - 1] : 0));
    expect(Math.max(...gaps)).toBeLessThanOrEqual(15);
    expect(picks.length).toBeLessThanOrEqual(8);
  });

  it("never exceeds the budget even with hundreds of candidates", () => {
    const candidates = Array.from({ length: 400 }, (_, i) => ({
      t: i * 0.5,
      score: Math.random(),
    }));
    const picks = selectKeyframes({
      candidates,
      start: 0,
      end: 200,
      budget: 12,
      minGapSec: 2,
      maxGapSec: 20,
    });
    expect(picks.length).toBe(12);
  });

  it("parses ffmpeg showinfo/metadata output with chunk offsets", () => {
    const log = [
      "[Parsed_metadata_2 @ 0x1] frame:0    pts:100  pts_time:4.0",
      "[Parsed_metadata_2 @ 0x1] lavfi.scene_score=0.812",
      "[Parsed_showinfo_3 @ 0x2] n:   0 pts:    100 pts_time:4       duration:1",
      "[Parsed_metadata_2 @ 0x1] lavfi.scene_score=0.333",
      "[Parsed_showinfo_3 @ 0x2] n:   1 pts:    200 pts_time:8.04    duration:1",
    ].join("\n");
    expect(parseSceneLog(log, 300)).toEqual([
      { t: 304, score: 0.812 },
      { t: 308.04, score: 0.333 },
    ]);
  });

  it("timecodes", () => {
    expect(formatTimecode(83.4)).toBe("01:23");
    expect(formatTimecode(3725)).toBe("1:02:05");
    expect(parseTimecode("01:23")).toBe(83);
    expect(parseTimecode("1:02:05")).toBe(3725);
    expect(parseTimecode("83s")).toBe(83);
    expect(parseTimecode("hello")).toBeNull();
    expect(timecodesInText("look at 01:23 and again at 1:40, maybe 12s")).toEqual([83, 100, 12]);
    expect(lookAroundTimes(83, 120)).toEqual([81.5, 83, 84.5]);
    expect(lookAroundTimes(0, 120)).toEqual([0, 1.5]);
  });
});

describe("entity cleanup", () => {
  it("drops headings and sentences, keeps the label before a colon, dedupes", () => {
    expect(
      cleanEntities([
        "Artifacts:",
        "Excavation Site: A cross-section of an archaeological dig, labeled SECTION 2",
        "A glass display case with a sign that reads STORE | FIND NO. A-117 next to many other objects",
        "**Roman coin**",
        "roman coin",
        "Trowel",
      ]),
    ).toEqual(["Excavation Site", "Roman coin", "Trowel"]);
  });
});

describe("findings parsing", () => {
  it("parses fenced JSON with trailing commas and mm:ss times", () => {
    const text =
      'Here you go:\n```json\n{"summary":"A dig.","observations":[{"t":"00:10","text":"Dark layer"}],"entities":[{"name":"Bronze coin","type":"artifact","t":"01:23","confidence":0.8},],"moments":[{"t":"01:23","label":"Coin","detail":"Probus"}],"confidence":85,"open_questions":["Mint mark?"]}\n```';
    const f = parseFindings(text, 120);
    expect(f.summary).toBe("A dig.");
    expect(f.observations[0]).toEqual({ t: 10, text: "Dark layer" });
    expect(f.entities[0]).toMatchObject({ name: "Bronze coin", t: 83, confidence: 0.8 });
    expect(f.moments[0]).toMatchObject({ t: 83, label: "Coin" });
    expect(f.confidence).toBe(0.85);
    expect(f.openQuestions).toEqual(["Mint mark?"]);
  });

  it("falls back to the raw text as summary when there is no JSON", () => {
    const f = parseFindings("I could not read the frames.", 60);
    expect(f.summary).toBe("I could not read the frames.");
    expect(f.moments).toEqual([]);
    expect(extractJson("no json")).toBeNull();
  });

  it("picks at most 8 frames, mixing coverage and strong scene changes", () => {
    const kfs = Array.from({ length: 30 }, (_, i) => ({
      id: `k${i}`,
      t: i * 4,
      score: i === 17 ? 0.99 : 0.1,
    }));
    const picked = pickAnalysisFrames(kfs);
    expect(picked).toHaveLength(8);
    expect(picked.map((k) => k.id)).toContain("k17");
    expect(
      transcriptExcerpt(
        Array.from({ length: 500 }, (_, i) => ({ start: i, end: i + 1, text: "word ".repeat(10) })),
        2000,
      ).length,
    ).toBeLessThan(2100);
  });

  it("personas: templates resolve without config, custom personas get a focus prompt", () => {
    const p = resolvePersona("archaeologist", {} as any);
    expect(p.systemPrompt).toMatch(/stratigraphy/i);
    expect(p.systemPrompt).toMatch(/dating/i);
    expect(personaPromptFor("Geologist", "rock types; faults")).toMatch(/- rock types\n- faults/);
  });
});

// ── real ffmpeg frame sampling ───────────────────────────────────────────

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasFfmpeg)("ffmpeg frame sampling (real binaries)", () => {
  let dir: string;
  let video: string;
  const bins = ff.resolveBins({});
  beforeAll(() => {
    dir = tmpDir("ff");
    video = path.join(dir, "scenes.mp4");
    // Hard cuts: black (0-4s) → white (4-8s) → testsrc (8-12s).
    execFileSync("ffmpeg", [
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=320x240:d=4:r=10",
      "-f",
      "lavfi",
      "-i",
      "color=c=white:s=320x240:d=4:r=10",
      "-f",
      "lavfi",
      "-i",
      "testsrc=s=320x240:d=4:r=10",
      "-filter_complex",
      "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
      "-map",
      "[v]",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      video,
    ]);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("probes, finds the scene cuts, extracts small JPEG keyframes and a contact sheet", async () => {
    const meta = await ff.probe(bins, video);
    expect(meta.duration).toBeGreaterThan(11.5);
    expect(meta.width).toBe(320);
    expect(meta.hasAudio).toBe(false);
    const scenes = await ff.detectScenes(bins, video, 0, meta.duration);
    expect(scenes.some((s) => Math.abs(s.t - 4) < 0.3)).toBe(true);
    expect(scenes.some((s) => Math.abs(s.t - 8) < 0.3)).toBe(true);
    const picks = selectKeyframes({
      candidates: scenes,
      start: 0,
      end: meta.duration,
      budget: 6,
      minGapSec: 2,
      maxGapSec: 20,
    });
    const frames = [];
    for (const p of picks) {
      const out = path.join(dir, `f${p.t}.jpg`);
      await ff.extractFrame(bins, video, p.t, out);
      const buf = fs.readFileSync(out);
      expect(buf.subarray(0, 2).toString("hex")).toBe("ffd8"); // JPEG
      expect(buf.length).toBeLessThan(60_000);
      frames.push({ path: out, t: p.t });
    }
    const sheet = await ff.contactSheet(bins, frames, path.join(dir, "sheet.jpg"));
    expect(sheet.cols).toBe(Math.min(4, frames.length));
    expect(fs.statSync(sheet.path).size).toBeGreaterThan(1000);
    // Seek within a chunk keeps absolute timestamps.
    const late = await ff.detectScenes(bins, video, 6, 6);
    expect(late.some((s) => Math.abs(s.t - 8) < 0.3)).toBe(true);
    expect(late.every((s) => s.t >= 6)).toBe(true);
  });
});

// ── pipeline + service with fakes ────────────────────────────────────────

function fakeTools(durationOf: (f: string) => number, calls: string[] = []): MediaTools {
  return {
    async probe(f) {
      calls.push("probe");
      return {
        duration: durationOf(f),
        width: 1280,
        height: 720,
        fps: 25,
        vcodec: "h264",
        acodec: "aac",
        hasAudio: true,
        bitrate: 1_000_000,
        format: "mp4",
        rotation: 0,
        creationTime: null,
      };
    },
    async detectScenes(_f, start, len) {
      calls.push(`scenes:${start}`);
      return [{ t: start + len / 2, score: 0.9 }];
    },
    async extractFrame(_f, t, out) {
      calls.push(`frame:${t}`);
      fs.writeFileSync(out, Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(`JPEG@${t}`)]));
      return out;
    },
    async contactSheet(frames, out) {
      fs.writeFileSync(out, `SHEET:${frames.length}`);
      return { path: out, cols: 4, rows: Math.ceil(frames.length / 4) };
    },
    async extractAudio(_f, start, _len, out) {
      fs.writeFileSync(out, `WAV@${start}`);
      return out;
    },
    async makeProxy(_f, out) {
      fs.writeFileSync(out, "PROXY-MP4");
      return out;
    },
  };
}

function fakeTranscriber(failAtOffset?: {
  offset: number;
  times: number;
}): Transcriber & { calls: number[] } {
  const calls: number[] = [];
  let fails = failAtOffset?.times ?? 0;
  return {
    calls,
    async available() {
      return "fake-stt";
    },
    async transcribe(_wav, offset) {
      calls.push(offset);
      if (failAtOffset && offset === failAtOffset.offset && fails > 0) {
        fails--;
        throw new Error("stt crashed");
      }
      return {
        segments: [{ start: offset + 1, end: offset + 4, text: `spoken at ${offset}` }],
        language: "en",
        engine: "fake",
        model: "fake-whisper",
      };
    },
  };
}

function fakeEngines(vlLog: string[] = []): OcrEngines {
  return {
    async ocrEngineName() {
      return "fake-ocr";
    },
    async ocrImages(paths) {
      return paths.map((p) => ({
        width: 640,
        height: 360,
        lines: [
          {
            text: `CAPTION ${path.basename(p)}`,
            confidence: 0.95,
            box: [0, 0, 100, 20] as [number, number, number, number],
          },
        ],
      }));
    },
    async toPng(i) {
      return i;
    },
    async pdfPageCount() {
      return 0;
    },
    async pdfPageText() {
      return "";
    },
    async pdfRenderPage() {
      return "";
    },
    async nativeText() {
      return null;
    },
    vl: {
      async model() {
        return "qwen-vl-fake";
      },
      async ask({ prompt, images }) {
        vlLog.push(prompt);
        if (prompt.includes("FOLLOW-UP")) {
          return {
            text: `Looking at ${images.length} frames: a bronze coin with a laureate bust.`,
            model: "qwen-vl-fake",
          };
        }
        if (prompt.includes("TASK: Analyze")) {
          const who = /You are ([A-Z ]+)/.exec(prompt)?.[1]?.trim() ?? "?";
          return {
            text: JSON.stringify({
              summary: `${who} summary`,
              observations: [{ t: "00:10", text: `${who} saw a trench` }],
              entities: [
                {
                  name: who === "ARCHAEOLOGIST" ? "Bronze coin" : "Person in hi-vis",
                  type: "artifact",
                  t: "01:23",
                  confidence: 0.7,
                },
              ],
              moments: [{ t: "01:23", label: "Key moment", detail: "detail" }],
              confidence: 0.8,
              open_questions: ["What layer?"],
            }),
            model: "qwen-vl-fake",
          };
        }
        return {
          text: "## Summary\nA video.\n## Key entities\n- trench\n- coin",
          model: "qwen-vl-fake",
        };
      },
    },
  };
}

describe("video pipeline (chunked, resumable)", () => {
  let unregister: () => void;
  let state: string;
  let frames: Record<"normal" | "secure", FrameStore>;
  let tools: MediaTools;
  let toolCalls: string[];
  let transcriber: ReturnType<typeof fakeTranscriber>;
  let vault: SecureVault;
  let ramDir: string;

  beforeEach(() => {
    state = tmpDir("state");
    ramDir = tmpDir("ram");
    process.env.INFINIBOT_SECURE_RAM_DIR = ramDir;
    vault = new SecureVault(randomBytes(32), path.join(state, "secure", "vault"));
    frames = {
      normal: new NormalFrameStore(path.join(state, "video-analysis", "frames")),
      secure: new SecureFrameStore(() => vault),
    };
    toolCalls = [];
    tools = fakeTools(() => 95, toolCalls);
    transcriber = fakeTranscriber();
    unregister = registerExtractionHandler({
      id: "video",
      exts: [...VIDEO_EXTS],
      mimes: [/^video\//],
      extract: (params, helpers) =>
        processVideo(params, helpers, {
          tools,
          transcriber,
          frames: (lane) => frames[lane],
          limits: { chunkSec: 30, maxFrames: 12 },
        }),
    });
  });
  afterEach(() => {
    resetInteractiveGateForTests();
    unregister();
    delete process.env.INFINIBOT_SECURE_RAM_DIR;
    fs.rmSync(state, { recursive: true, force: true });
    fs.rmSync(ramDir, { recursive: true, force: true });
  });

  function makeOcr(extra: Partial<ConstructorParameters<typeof OcrService>[0]> = {}) {
    return new OcrService({
      stateDir: state,
      engines: fakeEngines(),
      cfg: { ...resolveOcrConfig({}), retryBaseMs: 1, maxAttempts: 4 },
      secureVault: () => vault,
      ...extra,
    });
  }

  function putVideo(name = "dig.mp4") {
    const dir = path.join(state, "files");
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, name);
    fs.writeFileSync(p, `fake-video-${name}-${randomBytes(4).toString("hex")}`);
    return p;
  }

  it("processes every chunk: keyframes (capped), OCR, timestamped transcript, contact sheet, proxy", async () => {
    const ocr = makeOcr();
    const entry = ocr.enqueuePath({ absPath: putVideo(), source: { kind: "files" } })!;
    await ocr.processNext();
    const ctx = ocr.getContext("normal", { id: entry.id })!;
    expect(ctx.entry.status).toBe("done");
    const v = videoBlockOf(ctx.sidecar)!;
    expect(v.chunks.map((c) => [c.start, c.end, c.done])).toEqual([
      [0, 30, true],
      [30, 60, true],
      [60, 95, true],
    ]);
    expect(v.keyframes.length).toBeGreaterThan(3);
    expect(v.keyframes.length).toBeLessThanOrEqual(12);
    expect(v.keyframes.every((k) => k.ocr?.text.startsWith("CAPTION"))).toBe(true);
    expect(v.transcript.segments.map((s) => s.start)).toEqual([1, 31, 61]);
    expect(ctx.sidecar!.markdown).toContain("[00:31] spoken at 30");
    expect(ctx.sidecar!.markdown).toContain("On-screen text");
    expect(v.contactSheet?.id).toBe("sheet.jpg");
    expect(v.proxy?.id).toBe("proxy.mp4");
    expect(ctx.sidecar!.description).toContain("A video.");
    expect(ctx.sidecar!.entities).toEqual(["trench", "coin"]);
    const key = frameKeyFor(entry.sha256);
    expect(frames.normal.has(key, "k0001.jpg")).toBe(true);
    expect(frames.normal.has(key, "proxy.mp4")).toBe(true);
    // Scratch is gone.
    expect(fs.readdirSync(os.tmpdir()).filter((n) => /^ib-video-[A-Za-z0-9]{6}$/.test(n))).toEqual(
      [],
    );
  });

  it("resumes at the first unfinished chunk after a failure (no re-sampling of done chunks)", async () => {
    transcriber = fakeTranscriber({ offset: 60, times: 1 });
    const saves: number[] = [];
    const ocr = makeOcr({ emit: (e) => e.progress && saves.push(e.progress.done) });
    const entry = ocr.enqueuePath({ absPath: putVideo(), source: { kind: "files" } })!;
    await ocr.processNext(); // chunk 3 transcription fails → queued for retry
    let e = ocr.find("normal", { id: entry.id })!;
    expect(e.status).toBe("queued");
    const partial = videoBlockOf(ocr.getContext("normal", { id: entry.id })!.sidecar)!;
    expect(partial.chunks.map((c) => c.done)).toEqual([true, true, false]);
    const scenesBefore = toolCalls.filter((c) => c.startsWith("scenes:")).length;
    expect(scenesBefore).toBe(3);
    await new Promise((r) => setTimeout(r, 5));
    await ocr.processNext();
    e = ocr.find("normal", { id: entry.id })!;
    expect(e.status).toBe("done");
    const after = toolCalls.filter((c) => c.startsWith("scenes:"));
    expect(after.slice(3)).toEqual(["scenes:60"]); // only the unfinished chunk re-ran
    expect(toolCalls.filter((c) => c === "probe")).toHaveLength(1);
    expect(transcriber.calls).toEqual([0, 30, 60, 60]);
    expect(saves.length).toBeGreaterThan(2);
  });

  it("several agents analyze the same video; analyses[] merge; follow-up looks again at 01:23", async () => {
    const vlLog: string[] = [];
    const ocr = makeOcr({ engines: fakeEngines(vlLog) });
    const entry = ocr.enqueuePath({ absPath: putVideo(), source: { kind: "files" } })!;
    await ocr.processNext();
    const va = new VideoAnalysisService({
      stateDir: state,
      ocr: () => ocr,
      frames: (lane) => frames[lane],
      tools,
      secureVault: () => vault,
      persona: (id) =>
        resolvePersona(id, {
          agents: {
            list: [
              {
                id: "security-analyst",
                name: "SECURITY ANALYST",
                systemPrompt: "You are SECURITY ANALYST — CCTV.",
              },
            ],
          },
        } as any),
    });
    const q = await va.requestAnalysis({
      lane: "normal",
      ref: { id: entry.id },
      agentIds: ["archaeologist", "security-analyst"],
    });
    expect(q).toHaveLength(2);
    // Queued placeholders are visible immediately.
    let sc = ocr.getContext("normal", { id: entry.id })!.sidecar!;
    expect(videoAnalysesOf(sc).map((a) => analysisDataOf(a)!.status)).toEqual(["queued", "queued"]);
    await va.processNext();
    await va.processNext();
    sc = ocr.getContext("normal", { id: entry.id })!.sidecar!;
    const list = videoAnalysesOf(sc);
    expect(list.map((a) => a.agentId)).toEqual(["archaeologist", "security-analyst"]);
    const arch = list[0];
    const d = analysisDataOf(arch)!;
    expect(d.status).toBe("done");
    expect(arch.analyzer).toBe(VIDEO_ANALYZER);
    expect(arch.model).toBe("qwen-vl-fake");
    expect(arch.summary).toBe("ARCHAEOLOGIST summary");
    expect(d.entities?.[0]).toMatchObject({ name: "Bronze coin", t: 83 });
    expect(d.moments?.[0]).toMatchObject({ t: 83, label: "Key moment" });
    expect(d.moments?.[0].frameId).toMatch(/^m-.*-83000\.jpg$/);
    expect(frames.normal.has(frameKeyFor(entry.sha256), d.moments![0].frameId!)).toBe(true);
    expect(d.confidence).toBe(0.8);
    expect(d.openQuestions).toEqual(["What layer?"]);
    expect(analysisDataOf(list[1])!.entities?.[0].name).toBe("Person in hi-vis");
    // Persona reached the prompt.
    expect(vlLog.some((p) => /stratigraphy/i.test(p) && p.includes("TASK: Analyze"))).toBe(true);
    // Analyses are searchable through the OCR index.
    expect(ocr.search("normal", "Bronze coin").map((h) => h.id)).toEqual([entry.id]);

    // Follow-up: "look at 01:23" extracts frames around 83 s.
    const fu = va.requestFollowUp({
      lane: "normal",
      ref: { id: entry.id },
      agentId: "archaeologist",
      question: "Look at 01:23 — what is the object?",
    });
    expect(fu.times).toEqual([83]);
    toolCalls.length = 0;
    await va.processNext();
    expect(toolCalls).toEqual(["frame:81.5", "frame:83", "frame:84.5"]);
    sc = ocr.getContext("normal", { id: entry.id })!.sidecar!;
    const f = analysisDataOf(videoAnalysesOf(sc)[0])!.followUps![0];
    expect(f.status).toBe("done");
    expect(f.answer).toContain("3 frames");
    expect(f.frames.map((x) => x.t)).toEqual([81.5, 83, 84.5]);
    expect(vlLog.at(-1)).toContain("QUESTION: Look at 01:23");
    // Asking the same follow-up again returns the saved answer (no new job).
    const vlCalls = vlLog.length;
    const again = va.requestFollowUp({
      lane: "normal",
      ref: { id: entry.id },
      agentId: "archaeologist",
      question: "look at 01:23 —  what is the object?",
    });
    expect(again).toMatchObject({ followUpId: fu.followUpId, reused: true });
    expect(await va.processNext()).toBe(false);
    expect(vlLog.length).toBe(vlCalls);
    // The same analyst again → the saved analysis (vision never re-runs) ...
    const reused = await va.requestAnalysis({
      lane: "normal",
      ref: { id: entry.id },
      agentIds: ["archaeologist"],
    });
    expect(reused).toEqual([{ analysisId: arch.id, agentId: "archaeologist", reused: true }]);
    expect(videoAnalysesOf(ocr.getContext("normal", { id: entry.id })!.sidecar).length).toBe(2);
    // ... unless refresh: a second run adds a new entry rather than replacing.
    await va.requestAnalysis({
      lane: "normal",
      ref: { id: entry.id },
      agentIds: ["archaeologist"],
      refresh: true,
    });
    expect(videoAnalysesOf(ocr.getContext("normal", { id: entry.id })!.sidecar).length).toBe(3);
  });

  it("an interactive local-model turn pauses background analyses but not the ones it asked for", async () => {
    const ocr = makeOcr();
    const entry = ocr.enqueuePath({ absPath: putVideo(), source: { kind: "files" } })!;
    await ocr.processNext();
    const va = new VideoAnalysisService({
      stateDir: state,
      ocr: () => ocr,
      frames: (lane) => frames[lane],
      tools,
      secureVault: () => vault,
    });
    await va.requestAnalysis({
      lane: "normal",
      ref: { id: entry.id },
      agentIds: ["archaeologist"],
    });
    const release = beginInteractiveTurn({ runId: "turn-1" });
    try {
      expect(await va.processNext()).toBe(false); // background job waits
      const mine = await va.requestAnalysis({
        lane: "normal",
        ref: { id: entry.id },
        agentIds: ["security-analyst"],
        interactive: true,
      });
      expect(await va.processNext()).toBe(true); // the turn's own job runs
      const sc = ocr.getContext("normal", { id: entry.id })!.sidecar!;
      const byId = new Map(videoAnalysesOf(sc).map((a) => [a.id, analysisDataOf(a)!.status]));
      expect(byId.get(mine[0].analysisId)).toBe("done");
      expect([...byId.values()].filter((s) => s === "queued")).toHaveLength(1);
    } finally {
      release();
    }
    expect(await va.processNext()).toBe(true); // resumed
  });

  it("mergeAnalysis replaces by id and keeps other analyzers", () => {
    const base = (id: string, summary: string): OcrAnalysis => ({
      id,
      analyzer: VIDEO_ANALYZER,
      createdAt: 1,
      summary,
    });
    const ocrBase: OcrAnalysis = { id: "ocr:text", analyzer: "ocr", createdAt: 0, summary: "x" };
    let list = mergeAnalysis([ocrBase], base("agent:a:1", "first"));
    list = mergeAnalysis(list, base("agent:b:1", "b"));
    list = mergeAnalysis(list, base("agent:a:1", "updated"));
    expect(list.map((a) => `${a.id}=${a.summary}`)).toEqual([
      "ocr:text=x",
      "agent:a:1=updated",
      "agent:b:1=b",
    ]);
  });

  it("secure lane: video, frames, transcript and analyses stay in the vault; nothing reaches the normal index", async () => {
    const mirrored: string[] = [];
    const ocr = makeOcr({ indexNormal: (e) => mirrored.push(e.id) });
    const entry = ocr.enqueueSecure({
      name: "secret-site.mp4",
      data: Buffer.from("SECRET-VIDEO-BYTES"),
      source: { kind: "secure-files" },
    });
    expect(entry.lane).toBe("secure");
    await ocr.processNext();
    expect(ocr.find("secure", { id: entry.id })!.status).toBe("done");
    const va = new VideoAnalysisService({
      stateDir: state,
      ocr: () => ocr,
      frames: (lane) => frames[lane],
      tools,
      secureVault: () => vault,
      persona: (id) => resolvePersona(id, {} as any),
    });
    await va.requestAnalysis({
      lane: "secure",
      ref: { id: entry.id },
      agentIds: ["archaeologist"],
    });
    await va.processNext();
    const sc = ocr.getContext("secure", { id: entry.id })!.sidecar!;
    expect(analysisDataOf(videoAnalysesOf(sc)[0])!.status).toBe("done");
    expect(ocr.search("secure", "Bronze coin").map((h) => h.id)).toEqual([entry.id]);

    // Normal lane: no entry, no search hit, no memory mirror, no frames on disk.
    expect(ocr.search("normal", "Bronze coin")).toEqual([]);
    expect(ocr.search("normal", "spoken")).toEqual([]);
    expect(ocr.list("normal")).toEqual([]);
    expect(mirrored).toEqual([]);
    expect(walk(path.join(state, "video-analysis", "frames"))).toEqual([]);
    // Job records for the secure lane are sealed too.
    expect(fs.existsSync(path.join(state, "video-analysis", "jobs.json"))).toBe(false);
    // Frames are sealed in the vault (no JPEG magic / plaintext on disk anywhere).
    const key = frameKeyFor(entry.sha256);
    expect(frames.secure.has(key, "k0001.jpg")).toBe(true);
    for (const f of walk(state)) {
      const raw = fs.readFileSync(f);
      expect(raw.includes(Buffer.from("SECRET-VIDEO-BYTES")), f).toBe(false);
      expect(raw.includes(Buffer.from("JPEG@")), f).toBe(false);
      expect(raw.includes(Buffer.from("spoken at")), f).toBe(false);
      expect(raw.includes(Buffer.from("Bronze coin")), f).toBe(false);
    }
    // tmpfs scratch was cleaned up.
    expect(walk(ramDir)).toEqual([]);
  });

  it("local-only: refuses analysis when the vision endpoint is not loopback", async () => {
    const ocr = makeOcr();
    const entry = ocr.enqueuePath({ absPath: putVideo(), source: { kind: "files" } })!;
    await ocr.processNext();
    const remote = makeOcr({
      cfg: { ...resolveOcrConfig({}), ollamaUrl: "https://api.example.com" },
    });
    const va = new VideoAnalysisService({
      stateDir: state,
      ocr: () => remote,
      frames: (lane) => frames[lane],
      tools,
      secureVault: () => vault,
      persona: (id) => resolvePersona(id, {} as any),
      maxAttempts: 1,
    });
    await va.requestAnalysis({
      lane: "normal",
      ref: { id: entry.id },
      agentIds: ["archaeologist"],
    });
    await va.processNext();
    const d = analysisDataOf(
      videoAnalysesOf(remote.getContext("normal", { id: entry.id })!.sidecar)[0],
    )!;
    expect(d.status).toBe("failed");
    expect(d.error).toMatch(/local-only/);
  });
});

describe("secure scratch wipe on lock", () => {
  it("removes decrypted video scratch dirs and leaves unrelated files", async () => {
    const { wipeSecureScratch } = await import("./runtime.js");
    const dir = tmpDir("scratch");
    for (const d of ["va-abc", "ib-video-xyz", "j-123"]) {
      fs.mkdirSync(path.join(dir, d));
      fs.writeFileSync(path.join(dir, d, "k0001.jpg"), "frame");
    }
    fs.writeFileSync(path.join(dir, "keep.txt"), "x");
    expect(wipeSecureScratch(dir)).toBe(3);
    expect(fs.readdirSync(dir)).toEqual(["keep.txt"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("local-only speech-to-text", () => {
  it("refuses non-loopback STT endpoints and never calls them", async () => {
    for (const bad of [
      "https://api.openai.com",
      "http://192.168.1.5:8002",
      "http://speech.example.com",
    ]) {
      const cfg = resolveSttConfig({
        INFINIBOT_VIDEO_STT_URL: bad,
        INFINIBOT_VIDEO_WHISPER_MODEL: "",
      });
      expect(cfg.url).toBeNull();
      expect(cfg.urlRefused).toMatch(/local-only/);
    }
    const ok = resolveSttConfig({ INFINIBOT_VIDEO_STT_URL: "http://127.0.0.1:8002" });
    expect(ok.url).toBe("http://127.0.0.1:8002");
    const calls: string[] = [];
    const t = createLocalTranscriber(
      {
        ...resolveSttConfig({ INFINIBOT_VIDEO_STT_URL: "https://api.openai.com" }),
        whisperModel: null,
        python: "/nonexistent",
      },
      (async (u: string) => {
        calls.push(String(u));
        throw new Error("network");
      }) as unknown as typeof fetch,
    );
    await t.available();
    expect(calls).toEqual([]);
  });

  it("normalises segments: offsets, filler removal, repetition collapse", () => {
    expect(
      normalizeSegments(
        [
          { start: 0, end: 2, text: " Hello  there " },
          { start: 2, end: 3, text: "[Music]" },
          { start: 3, end: 4, text: "again" },
          { start: 4.2, end: 5, text: "again" },
        ],
        60,
      ),
    ).toEqual([
      { start: 60, end: 62, text: "Hello there" },
      { start: 63, end: 65, text: "again" },
    ]);
  });
});

// Keep the type import used.
export type _VAData = VideoAnalysisData;
