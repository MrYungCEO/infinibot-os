/**
 * Asset Analyzer — populates AssetMetadata via Claude vision.
 *
 * Two paths, picked at runtime:
 *
 *   1. **`claude-video` shell-out** — when CLAUDE_VIDEO_BIN points at the
 *      installed CLI from https://github.com/bradautomates/claude-video.
 *      We pipe the asset path + a structured prompt through its `/watch`
 *      entrypoint and parse the JSON it prints. This path covers full
 *      video understanding (frames + audio transcript + Claude analysis)
 *      because that's exactly what claude-video does.
 *
 *   2. **In-tree fallback** — when the CLI isn't configured we run the
 *      analysis ourselves: ffmpeg-extract a few representative frames
 *      from videos (or the file directly for images), base64-encode
 *      them, and POST to Anthropic's messages API with vision + a JSON-
 *      output prompt. Audio assets get a metadata-only sketch (since
 *      whisper isn't always available).
 *
 * Both paths return the same `AnalysisResult` so the caller doesn't
 * care which one ran.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";

import type { AssetMetadata } from "./project-dir.js";

// ── Public types ───────────────────────────────────────────────

export interface AnalysisResult {
  description: string;
  tags: string[];
  mood?: string;
  scene?: string;
  colorPalette?: string[];
  energy?: "low" | "medium" | "high";
  suggestedUses?: string[];
  transcript?: string;
  /** Free-form notes the analyzer thought were worth keeping. */
  notes?: string;
  /** Which path produced the result. Surfaced to the UI for transparency. */
  via: "claude-video" | "anthropic-vision" | "metadata-only";
}

export interface AnalyzeAssetInput {
  /** Absolute path to the asset on disk. */
  filePath: string;
  /** Original AssetMetadata so the analyzer can include filename/kind in its prompt. */
  asset: AssetMetadata;
}

// ── Entry point ───────────────────────────────────────────────

export async function analyzeAsset(input: AnalyzeAssetInput): Promise<AnalysisResult> {
  if (!existsSync(input.filePath)) {
    throw new Error(`Asset file not found on disk: ${input.filePath}`);
  }

  // Try claude-video first when the operator has wired it up. We only
  // bother for video + audio since that's the project's strong suit;
  // pure images go straight to vision (faster, cheaper).
  const claudeVideoBin = resolveClaudeVideoBin();
  const usesClaudeVideo =
    !!claudeVideoBin && (input.asset.kind === "video" || input.asset.kind === "audio");
  if (usesClaudeVideo) {
    try {
      return await runClaudeVideo(claudeVideoBin!, input);
    } catch (err) {
      console.warn(
        "[asset-analyzer] claude-video shell-out failed, falling back:",
        err instanceof Error ? err.message : String(err),
      );
      // Fall through to in-tree analyzer.
    }
  }

  // Fall back to Anthropic vision for everything we can encode as images.
  if (input.asset.kind === "image" || input.asset.kind === "video") {
    return runAnthropicVision(input);
  }

  // Audio without claude-video: emit a minimal metadata-only result so
  // the UI still gets something useful instead of an error.
  return {
    description: `Audio asset "${input.asset.name}" (${formatDuration(input.asset.durationSec)}).`,
    tags: ["audio"],
    via: "metadata-only",
    notes:
      "No transcript — set CLAUDE_VIDEO_BIN to a checkout of bradautomates/claude-video for full audio transcription.",
  };
}

// ── claude-video integration ──────────────────────────────────

/**
 * Locate the claude-video CLI. Operators install the upstream skill via
 * Claude Code's `/plugin install watch@claude-video` (or by cloning the
 * repo). We honor an explicit `CLAUDE_VIDEO_BIN` first, then look for
 * common install locations under `~/.claude/skills/watch/`.
 */
function resolveClaudeVideoBin(): string | null {
  const explicit = process.env.CLAUDE_VIDEO_BIN;
  if (explicit && existsSync(explicit)) return explicit;

  const home = homedir();
  const candidates = [
    join(home, ".claude", "skills", "watch", "scripts", "watch.py"),
    join(home, ".claude", "plugins", "claude-video", "watch.py"),
    join(home, ".codex", "skills", "watch", "scripts", "watch.py"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

async function runClaudeVideo(bin: string, input: AnalyzeAssetInput): Promise<AnalysisResult> {
  const prompt =
    "Return STRICT JSON only (no prose, no markdown fences) with these keys: " +
    "description (1-2 sentence summary), tags (array of 4-10 short keywords), " +
    "mood (single word, e.g. 'cinematic'), scene (e.g. 'b-roll', 'establishing'), " +
    "colorPalette (array of 3-5 hex strings), energy ('low'|'medium'|'high'), " +
    'suggestedUses (array of 2-4 short sentences telling an editor when to use this clip), ' +
    "transcript (optional full transcript when audio is present), notes (extra context).";

  const isPython = bin.endsWith(".py");
  const cmd = isPython ? "python" : bin;
  const args = isPython ? [bin, input.filePath, prompt] : [input.filePath, prompt];

  const stdout = await runProcess(cmd, args, { timeoutMs: 5 * 60_000 });
  const json = extractJsonObject(stdout);
  if (!json) {
    throw new Error(`claude-video returned no parseable JSON. First 200 chars: ${stdout.slice(0, 200)}`);
  }
  return { ...normalizeAnalysis(json), via: "claude-video" };
}

// ── Anthropic vision fallback ─────────────────────────────────

async function runAnthropicVision(input: AnalyzeAssetInput): Promise<AnalysisResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      description: `${input.asset.name} (${input.asset.kind}) — analyzer disabled.`,
      tags: [input.asset.kind],
      via: "metadata-only",
      notes:
        "Set ANTHROPIC_API_KEY (or install claude-video via CLAUDE_VIDEO_BIN) to enable AI analysis.",
    };
  }

  // Build the image inputs: 1 frame for an image asset, ~5 evenly-spaced
  // frames for video. Frames > 5 add cost without much new info for the
  // editor's purposes here.
  const frames =
    input.asset.kind === "image"
      ? [{ path: input.filePath, mime: input.asset.mime || "image/png" }]
      : await extractVideoFrames(input.filePath, 5);
  if (frames.length === 0) {
    throw new Error("No frames could be encoded for analysis");
  }

  const content: Array<Record<string, unknown>> = [];
  for (const frame of frames) {
    const b64 = readFileSync(frame.path).toString("base64");
    content.push({
      type: "image",
      source: { type: "base64", media_type: frame.mime, data: b64 },
    });
  }
  content.push({
    type: "text",
    text: buildVisionPrompt(input.asset, frames.length),
  });

  const model = process.env.ANTHROPIC_VISION_MODEL || "claude-sonnet-4-6";
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      messages: [{ role: "user", content }],
    }),
  });

  // Cleanup any frames we extracted into a temp dir.
  if (input.asset.kind === "video") {
    await Promise.all(frames.map((f) => rm(f.path, { force: true }).catch(() => {})));
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Anthropic vision returned ${response.status}: ${text || "(empty body)"}`);
  }
  const body = (await response.json()) as { content?: Array<{ type?: string; text?: string }> };
  const text = body.content?.find((p) => p?.type === "text")?.text ?? "";
  const json = extractJsonObject(text);
  if (!json) {
    throw new Error(`Vision response wasn't parseable JSON. First 200 chars: ${text.slice(0, 200)}`);
  }
  return { ...normalizeAnalysis(json), via: "anthropic-vision" };
}

function buildVisionPrompt(asset: AssetMetadata, frameCount: number): string {
  const intro =
    asset.kind === "video"
      ? `You're shown ${frameCount} evenly-spaced frames sampled from a video clip named "${asset.name}".`
      : `You're shown 1 still image named "${asset.name}".`;
  const dims =
    asset.width && asset.height ? ` (${asset.width}×${asset.height})` : "";
  const dur = asset.durationSec ? ` Duration: ${asset.durationSec.toFixed(1)}s.` : "";

  return [
    `${intro}${dims}.${dur}`,
    "",
    "Produce metadata an editor would attach to this asset to help an AI agent pick the right clip later.",
    "",
    "Return STRICT JSON ONLY — no markdown fences, no preamble, no trailing prose. Shape:",
    "{",
    '  "description": "1-2 sentence summary of what is in the clip",',
    '  "tags": ["short","keywords"],',
    '  "mood": "single-word feel — cinematic | moody | playful | tense | warm | …",',
    '  "scene": "establishing | b-roll | close-up | talking-head | abstract | other",',
    '  "colorPalette": ["#rrggbb", "..."],',
    '  "energy": "low" | "medium" | "high",',
    '  "suggestedUses": ["When to use sentence 1", "When to use sentence 2"],',
    '  "transcript": "(only if you can read on-screen text or hear speech; otherwise omit)",',
    '  "notes": "Anything an editor should know that doesn\'t fit above"',
    "}",
  ].join("\n");
}

async function extractVideoFrames(
  filePath: string,
  count: number,
): Promise<Array<{ path: string; mime: string }>> {
  const out = mkdtempPath("moltbot-frames-");
  mkdirSync(out, { recursive: true });

  // We don't know duration here (the AssetMetadata might have it but we
  // can't depend on it), so use ffmpeg's "thumbnail" filter to pick the
  // most representative frames in one pass.
  const pattern = join(out, "frame-%03d.jpg");
  await runProcess(
    "ffmpeg",
    [
      "-y",
      "-i", filePath,
      "-vf", `select='not(mod(n\\,trunc(n_frames/${count + 1})))',scale=1024:-2`,
      "-vsync", "vfr",
      "-frames:v", String(count),
      "-q:v", "3",
      pattern,
    ],
    { timeoutMs: 90_000, swallowStderr: true },
  );

  const result: Array<{ path: string; mime: string }> = [];
  for (let i = 1; i <= count; i++) {
    const p = join(out, `frame-${String(i).padStart(3, "0")}.jpg`);
    if (existsSync(p)) result.push({ path: p, mime: "image/jpeg" });
  }
  return result;
}

// ── helpers ───────────────────────────────────────────────────

function mkdtempPath(prefix: string): string {
  return resolve(tmpdir(), prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
}

function formatDuration(s: number | undefined): string {
  if (!s || !Number.isFinite(s)) return "duration unknown";
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}m ${r}s`;
}

function runProcess(
  cmd: string,
  args: string[],
  opts: { timeoutMs: number; swallowStderr?: boolean },
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      rejectPromise(new Error(`${cmd} timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);
    proc.stdout?.on("data", (b: Buffer) => { stdout += b.toString(); });
    proc.stderr?.on("data", (b: Buffer) => { stderr += b.toString(); });
    proc.on("error", (err) => { clearTimeout(timer); rejectPromise(err); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise(stdout);
      } else {
        const detail = opts.swallowStderr ? stderr.split("\n").slice(-3).join("\n") : stderr;
        rejectPromise(new Error(`${cmd} exited ${code}: ${detail.trim() || "(no stderr)"}`));
      }
    });
  });
}

/**
 * Pull the first balanced JSON object out of arbitrary text. Handles
 * both ```json fences and bare JSON. Returns null when nothing parseable
 * is found.
 */
function extractJsonObject(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  // Strip code fences first.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  // Find the first '{' and walk to its matching '}'.
  const start = body.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const slice = body.slice(start, i + 1);
        try { return JSON.parse(slice); } catch { return null; }
      }
    }
  }
  return null;
}

function normalizeAnalysis(raw: Record<string, unknown>): Omit<AnalysisResult, "via"> {
  const description = typeof raw.description === "string" ? raw.description : "";
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((t): t is string => typeof t === "string").slice(0, 12)
    : [];
  const mood = typeof raw.mood === "string" ? raw.mood : undefined;
  const scene = typeof raw.scene === "string" ? raw.scene : undefined;
  const colorPalette = Array.isArray(raw.colorPalette)
    ? raw.colorPalette.filter((c): c is string => typeof c === "string" && /^#?[0-9a-f]{6}$/i.test(c))
    : undefined;
  const energyRaw = typeof raw.energy === "string" ? raw.energy.toLowerCase() : "";
  const energy: AnalysisResult["energy"] =
    energyRaw === "low" || energyRaw === "medium" || energyRaw === "high" ? energyRaw : undefined;
  const suggestedUses = Array.isArray(raw.suggestedUses)
    ? raw.suggestedUses.filter((s): s is string => typeof s === "string").slice(0, 6)
    : undefined;
  const transcript = typeof raw.transcript === "string" ? raw.transcript : undefined;
  const notes = typeof raw.notes === "string" ? raw.notes : undefined;
  return { description, tags, mood, scene, colorPalette, energy, suggestedUses, transcript, notes };
}

// Avoid an unused-import warning when the editor strips the `dirname` import.
void dirname;
void extname;
