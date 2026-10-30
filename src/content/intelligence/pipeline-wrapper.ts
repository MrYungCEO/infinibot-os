/**
 * Pipeline wrapper — invokes vendored Python scripts via child_process.spawn.
 *
 * This is the THIN TS layer that replaces the native-TS reimplementation.
 * It does NOT reimplement download/transcribe/score logic in TS.
 * It spawns the proven Python scripts, streams progress, and writes results
 * into the content-intel store.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveReelPipelineSettings } from "../../content-studio/config.js";
import { resolveStateDir } from "../../config/paths.js";
import { isFleetTenantMachine } from "../../saas/fleet-plugins.js";
import { getContentIntelStore } from "./store.js";
import { checkVideoExists } from "./importer.js";
import type { ContentIntelConfig } from "./types.js";
import type { ScoreRow, TranscriptRow } from "./types.js";

const log = createSubsystemLogger("content-intel-pipeline");

/** Why the reel pipeline is off on InfiniBot Cloud (shown in the UI). */
export const REEL_PIPELINE_CLOUD_REFUSAL =
  "Reel download, transcription and scoring run local programs (Python, gallery-dl, Whisper on a GPU), so they are available on self-hosted InfiniBot only.";

// ═══════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════

/** Get the pipeline config, falling back to defaults / env vars. */
export function getPipelineConfig(overrides?: Partial<ContentIntelConfig>): ContentIntelConfig {
  // env → content-studio plugin config → integrations.contentIntel → "" (off).
  const { pipelineDir, venvPath } = resolveReelPipelineSettings();
  const defaults = {
    venvPath,
    pipelineDir,
    cookiesFromBrowser: "firefox",
    downloadDir: "",
    openrouterApiKey: process.env.OPENROUTER_API_KEY ?? "",
    // OpenRouter retired the ":free" deepseek-chat-v3 slug (404) and rate-limits
    // the ":free" llama slug (429). Use the stable paid slugs that return scores;
    // these flow through to score_single.py via --primary-model/--fallback-model.
    primaryModel: process.env.PRIMARY_MODEL ?? "deepseek/deepseek-chat-v3-0324",
    fallbackModel: process.env.FALLBACK_MODEL ?? "meta-llama/llama-3.3-70b-instruct",
  };

  return { ...defaults, ...overrides };
}

/** Path to the pipeline scripts directory. */
function scriptsDir(): string {
  return join(dirname(new URL(import.meta.url).pathname), "pipeline");
}

/**
 * Resolve a usable Python interpreter.
 *
 * The vendored `pipeline/` scripts are self-contained (they only need
 * `requests` + `python-dotenv`, both commonly present in the system Python),
 * so we do NOT hard-depend on the external reel-pipeline venv. Prefer that
 * venv when it actually exists, otherwise fall back to a system `python3`.
 *
 * This is the fix for the "scoring silently fails" failure mode: previously we
 * blindly returned `<venv>/bin/python3`, so on any machine where that external
 * venv was absent (fresh checkout, CI, the venv deleted), every spawn threw
 * ENOENT and scoring failed with a cryptic error even though a perfectly good
 * `python3` was on PATH.
 */
function resolvePythonBin(venvPath: string): string {
  // 1) Prefer the configured venv interpreter if it resolves to a real file.
  if (venvPath.trim()) {
    for (const name of ["python3", "python"]) {
      const candidate = join(venvPath, "bin", name);
      if (existsSync(candidate)) return candidate;
    }
  }
  // 2) Fall back to well-known system interpreters.
  for (const candidate of [
    "/usr/bin/python3",
    "/usr/local/bin/python3",
    "/opt/homebrew/bin/python3",
    "/usr/bin/python",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  // 3) Last resort — let spawn resolve via PATH.
  return "python3";
}

/** @deprecated kept for back-compat; use {@link resolvePythonBin}. */
function pythonBin(venvPath: string): string {
  return resolvePythonBin(venvPath);
}

// ═══════════════════════════════════════════════════════════════════
// READINESS DIAGNOSTIC
// ═══════════════════════════════════════════════════════════════════

export interface PipelineReadiness {
  /** Resolved interpreter path the wrapper will actually spawn. */
  pythonBin: string;
  /** Interpreter exists and runs (`python -c` returned without spawn error). */
  pythonOk: boolean;
  /** The vendored score_single.py script is present on disk. */
  scriptsOk: boolean;
  /** Required Python deps (`requests`, `dotenv`) import successfully. */
  depsOk: boolean;
  /** An OpenRouter API key is configured. */
  hasApiKey: boolean;
  /** All of the above — scoring can run end-to-end. */
  ready: boolean;
  /** Human-readable, actionable one-liner explaining the first blocker. */
  detail: string;
}

/**
 * Probe everything scoring needs (interpreter, vendored script, Python deps,
 * API key) in one cheap synchronous call. Surfaced by the
 * `content.intel.capabilities` RPC so the dashboard can show *why* scoring is
 * unavailable instead of a generic "scores may fail".
 */
export function checkPipelineReadiness(config?: Partial<ContentIntelConfig>): PipelineReadiness {
  if (isFleetTenantMachine()) {
    return {
      pythonBin: "",
      pythonOk: false,
      scriptsOk: false,
      depsOk: false,
      hasApiKey: false,
      ready: false,
      detail: REEL_PIPELINE_CLOUD_REFUSAL,
    };
  }
  const cfg = getPipelineConfig(config);
  const bin = resolvePythonBin(cfg.venvPath);
  const script = join(scriptsDir(), "score_single.py");
  const scriptsOk = existsSync(script);
  const hasApiKey = Boolean(cfg.openrouterApiKey);

  let pythonOk = false;
  let depsOk = false;
  let probeErr = "";
  try {
    const probe = spawnSync(bin, ["-c", "import requests, dotenv; print('ok')"], {
      encoding: "utf-8",
      timeout: 10_000,
    });
    if (probe.error) {
      probeErr = probe.error.message;
    } else {
      // Interpreter ran (no ENOENT) → python is usable.
      pythonOk = true;
      depsOk = probe.status === 0 && /\bok\b/.test(probe.stdout ?? "");
      // Last line only ("ModuleNotFoundError: No module named 'dotenv'"), not
      // the whole traceback — this string is shown in the UI.
      if (!depsOk) {
        const lines = (probe.stderr || probe.stdout || "").trim().split("\n");
        probeErr = (lines[lines.length - 1] ?? "").trim().slice(0, 200);
      }
    }
  } catch (e) {
    probeErr = e instanceof Error ? e.message : String(e);
  }

  const ready = pythonOk && scriptsOk && depsOk && hasApiKey;

  let detail = "Scoring ready.";
  if (!pythonOk) {
    detail = `Python interpreter not runnable (${bin}). ${probeErr}`.trim();
  } else if (!scriptsOk) {
    detail = `Vendored scoring script missing: ${script}`;
  } else if (!depsOk) {
    detail =
      `Scoring needs Python packages 'requests' + 'python-dotenv' (pip install requests python-dotenv). ${probeErr}`.trim();
  } else if (!hasApiKey) {
    detail = "No OPENROUTER_API_KEY configured — set it in the gateway environment.";
  }

  return { pythonBin: bin, pythonOk, scriptsOk, depsOk, hasApiKey, ready, detail };
}

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export interface DownloadResult {
  shortcode: string;
  success: boolean;
  videoPath: string | null;
  error?: string;
}

export interface TranscribeResult {
  shortcode: string;
  text: string;
  engine: string;
  success: boolean;
  error?: string;
}

export interface ScoreResult {
  shortcode: string;
  hook: number | null;
  value: number | null;
  viral: number | null;
  overall: number | null;
  tier: string;
  reason: string;
  idea_vs_execution: string | null;
  model: string;
  success: boolean;
  error?: string;
}

export interface PipelineProgress {
  (msg: string, meta?: Record<string, unknown>): void;
}

export interface SyncResult {
  downloaded: number;
  transcribed: number;
  scored: number;
  skipped: number;
  errors: string[];
  totalReels: number;
}

// ═══════════════════════════════════════════════════════════════════
// SPAWN HELPERS
// ═══════════════════════════════════════════════════════════════════

/**
 * Spawn a Python script and return stdout, stderr, and exit code.
 * Uses the venv's Python binary.
 */
function runPython(
  script: string,
  args: string[],
  venvPath: string,
  timeoutMs = 300_000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // InfiniBot Cloud: never run the local reel pipeline on a workspace Machine
  // (the host also refuses its RPCs: src/saas/fleet-plugins.ts selfHostOnly).
  if (isFleetTenantMachine()) return Promise.reject(new Error(REEL_PIPELINE_CLOUD_REFUSAL));
  return new Promise((resolve, reject) => {
    const python = pythonBin(venvPath);
    const child = spawn(python, [script, ...args], {
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });

    child.on("error", (err) => {
      reject(err);
    });
  });
}

// ═══════════════════════════════════════════════════════════════════
// DOWNLOAD
// ═══════════════════════════════════════════════════════════════════

/**
 * Download a single reel by shortcode using gallery-dl.
 *
 * Spawns: download_single.py <shortcode> --cookies-from-browser firefox
 *
 * If the shortcode already has a video file (checked via store + pipeline output),
 * this is a no-op.
 */
export async function downloadReel(
  shortcode: string,
  config?: Partial<ContentIntelConfig>,
): Promise<DownloadResult> {
  if (isFleetTenantMachine()) {
    return { shortcode, success: false, videoPath: null, error: REEL_PIPELINE_CLOUD_REFUSAL };
  }
  const cfg = getPipelineConfig(config);
  const script = join(scriptsDir(), "download_single.py");

  if (!cfg.pipelineDir) {
    return {
      shortcode,
      success: false,
      videoPath: null,
      error:
        "Content-intelligence pipeline is disabled; set Plugins › Content Studio › Reel pipeline directory (or INFINIBOT_CONTENT_INTEL_PIPELINE_DIR)",
    };
  }

  if (!existsSync(script)) {
    return { shortcode, success: false, videoPath: null, error: `Script not found: ${script}` };
  }

  // Check if already downloaded
  if (checkVideoExists(shortcode)) {
    return { shortcode, success: true, videoPath: `shortcode:${shortcode}` };
  }

  log.info("downloading reel", { shortcode });

  const args = [
    `https://www.instagram.com/reel/${shortcode}/`,
    "--output-dir",
    cfg.downloadDir || join(cfg.pipelineDir, "output"),
    "--cookies-from-browser",
    cfg.cookiesFromBrowser || "firefox",
  ];

  try {
    const { stdout, stderr, exitCode } = await runPython(script, args, cfg.venvPath, 120_000);

    if (exitCode !== 0) {
      log.warn("download failed", { shortcode, exitCode, stderr: stderr.slice(0, 500) });
      return { shortcode, success: false, videoPath: null, error: stderr.slice(0, 500) };
    }

    log.info("download complete", { shortcode });
    // Update store flag immediately
    const store = getContentIntelStore();
    store.setHasVideo(shortcode, true);

    return { shortcode, success: true, videoPath: `shortcode:${shortcode}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("download exception", { shortcode, error: msg });
    return { shortcode, success: false, videoPath: null, error: msg };
  }
}

// ═══════════════════════════════════════════════════════════════════
// TRANSCRIBE
// ═══════════════════════════════════════════════════════════════════

/**
 * Transcribe a single reel's video using faster-whisper.
 *
 * Spawns: transcribe_single.py <video_path> [--model large-v3] [--device auto]
 *
 * Expects the video to already exist in the pipeline output dir.
 * Writes the transcript into the store.
 */
export async function transcribeReel(
  shortcode: string,
  videoPath?: string,
  config?: Partial<ContentIntelConfig>,
): Promise<TranscribeResult> {
  if (isFleetTenantMachine()) {
    return { shortcode, text: "", engine: "", success: false, error: REEL_PIPELINE_CLOUD_REFUSAL };
  }
  const cfg = getPipelineConfig(config);
  const script = join(scriptsDir(), "transcribe_single.py");

  if (!existsSync(script)) {
    return {
      shortcode,
      text: "",
      engine: "",
      success: false,
      error: `Script not found: ${script}`,
    };
  }

  // Check if already transcribed
  const store = getContentIntelStore();
  const existing = store.getTranscript(shortcode);
  if (existing?.text) {
    return { shortcode, text: existing.text, engine: existing.engine, success: true };
  }

  // Find the video file — need to scan pipeline output
  const resolvedPath = videoPath ?? findVideoPath(shortcode, cfg);
  if (!resolvedPath || !existsSync(resolvedPath)) {
    return { shortcode, text: "", engine: "", success: false, error: "Video file not found" };
  }

  log.info("transcribing reel", { shortcode, videoPath: resolvedPath });

  const args = [resolvedPath, "--model", "large-v3", "--device", "auto", "--compute-type", "auto"];

  try {
    const { stdout, stderr, exitCode } = await runPython(script, args, cfg.venvPath, 600_000);

    if (exitCode !== 0) {
      log.warn("transcription failed", { shortcode, exitCode, stderr: stderr.slice(0, 500) });
      return { shortcode, text: "", engine: "", success: false, error: stderr.slice(0, 500) };
    }

    const transcriptText = stdout.trim();
    if (!transcriptText) {
      return { shortcode, text: "", engine: "", success: false, error: "Empty transcript" };
    }

    // Write to store
    const row: TranscriptRow = {
      shortcode,
      text: transcriptText,
      engine: "whisper-large-v3",
      lang: null,
      created_at: Date.now(),
    };
    store.upsertTranscript(row);
    store.setHasTranscript(shortcode, true);

    log.info("transcription complete", { shortcode, chars: transcriptText.length });
    return { shortcode, text: transcriptText, engine: row.engine, success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("transcription exception", { shortcode, error: msg });
    return { shortcode, text: "", engine: "", success: false, error: msg };
  }
}

// ═══════════════════════════════════════════════════════════════════
// SCORE
// ═══════════════════════════════════════════════════════════════════

/**
 * Score a single reel by calling the vendored score_single.py script.
 *
 * The script reads transcript + metrics, calls OpenRouter, and returns a
 * structured JSON score. We store the result in the content-intel DB.
 *
 * Resumable: skips reels that already have a score in the store.
 */
export async function scoreReel(
  shortcode: string,
  config?: Partial<ContentIntelConfig>,
): Promise<ScoreResult> {
  if (isFleetTenantMachine()) {
    return {
      shortcode,
      hook: null,
      value: null,
      viral: null,
      overall: null,
      tier: "C",
      reason: "",
      idea_vs_execution: null,
      model: "",
      success: false,
      error: REEL_PIPELINE_CLOUD_REFUSAL,
    };
  }
  const cfg = getPipelineConfig(config);
  const script = join(scriptsDir(), "score_single.py");

  if (!existsSync(script)) {
    return {
      shortcode,
      hook: null,
      value: null,
      viral: null,
      overall: null,
      tier: "C",
      reason: "",
      idea_vs_execution: null,
      model: "",
      success: false,
      error: `Script not found: ${script}`,
    };
  }

  // Check if already scored
  const store = getContentIntelStore();
  const existingScore = store.getScore(shortcode);
  if (existingScore) {
    return {
      shortcode,
      hook: existingScore.hook,
      value: existingScore.value,
      viral: existingScore.viral,
      overall: existingScore.overall,
      tier: existingScore.tier,
      reason: existingScore.reason,
      idea_vs_execution: existingScore.idea_vs_execution,
      model: existingScore.model,
      success: true,
    };
  }

  // Load transcript for the score script
  const transcriptRow = store.getTranscript(shortcode);
  const transcript = transcriptRow?.text ?? "[transcript unavailable]";

  // Write metrics to temp file for the script
  const reel = store.getReel(shortcode);
  const metrics = store.getLatestMetrics(shortcode);

  const metricsData = {
    views: metrics?.views ?? 0,
    likes: metrics?.likes ?? 0,
    comments: metrics?.comments ?? 0,
    reach: metrics?.reach ?? 0,
    shares: metrics?.shares ?? 0,
    saves: metrics?.saves ?? 0,
    follows: metrics?.follows ?? 0,
  };

  // Write transcript to temp file for the script
  const tmpDir = join(resolveStateDir(), "content-intel-tmp");
  mkdirSync(tmpDir, { recursive: true });

  const transcriptFile = join(tmpDir, `${shortcode}.txt`);
  const metricsFile = join(tmpDir, `${shortcode}_metrics.json`);
  writeFileSync(transcriptFile, transcript, "utf-8");
  writeFileSync(metricsFile, JSON.stringify(metricsData), "utf-8");

  log.info("scoring reel", { shortcode, views: metricsData.views, likes: metricsData.likes });

  const args = [
    "--shortcode",
    shortcode,
    "--transcript-file",
    transcriptFile,
    "--metrics-file",
    metricsFile,
    "--caption",
    reel?.description ?? "",
  ];

  // Flow the configured model slugs through to the Python scorer. Without these
  // score_single.py falls back to config.py defaults, ignoring the gateway
  // pipeline config entirely (the original cause of every reel scoring against a
  // dead ":free" slug).
  if (cfg.primaryModel) args.push("--primary-model", cfg.primaryModel);
  if (cfg.fallbackModel) args.push("--fallback-model", cfg.fallbackModel);

  // Set API key env for the subprocess
  const openrouterKey = cfg.openrouterApiKey || process.env.OPENROUTER_API_KEY || "";
  if (!openrouterKey) {
    return {
      shortcode,
      hook: null,
      value: null,
      viral: null,
      overall: null,
      tier: "C",
      reason: "",
      idea_vs_execution: null,
      model: "",
      success: false,
      error: "OPENROUTER_API_KEY not set",
    };
  }

  try {
    const { stdout, stderr, exitCode } = await runPython(
      script,
      args,
      cfg.venvPath,
      120_000, // 2 min timeout
    );

    if (exitCode !== 0) {
      log.warn("scoring failed", { shortcode, exitCode, stderr: stderr.slice(0, 500) });
      return {
        shortcode,
        hook: null,
        value: null,
        viral: null,
        overall: null,
        tier: "C",
        reason: "",
        idea_vs_execution: null,
        model: "",
        success: false,
        error: stderr.slice(0, 500),
      };
    }

    // Parse the JSON result from stdout
    const result = JSON.parse(stdout.trim()) as Record<string, unknown>;
    if (result.error) {
      log.warn("scoring error", { shortcode, error: result.error });
      return {
        shortcode,
        hook: null,
        value: null,
        viral: null,
        overall: null,
        tier: "C",
        reason: "",
        idea_vs_execution: null,
        model: "",
        success: false,
        error: String(result.error),
      };
    }

    const scoreRow: ScoreRow = {
      shortcode,
      hook: result.hook != null ? Number(result.hook) : null,
      value: result.value != null ? Number(result.value) : null,
      viral: result.viral != null ? Number(result.viral) : null,
      overall: result.overall != null ? Number(result.overall) : null,
      tier: String(result.tier ?? "C"),
      reason: String(result.reason ?? ""),
      idea_vs_execution: result.idea_vs_execution != null ? String(result.idea_vs_execution) : null,
      scored_by: "pipeline",
      model: String(result.model ?? "unknown"),
      created_at: Date.now(),
    };

    store.upsertScore(scoreRow);
    store.setHasScore(shortcode, true);

    log.info("scoring complete", { shortcode, overall: scoreRow.overall, tier: scoreRow.tier });
    return {
      shortcode,
      hook: scoreRow.hook,
      value: scoreRow.value,
      viral: scoreRow.viral,
      overall: scoreRow.overall,
      tier: scoreRow.tier,
      reason: scoreRow.reason,
      idea_vs_execution: scoreRow.idea_vs_execution,
      model: scoreRow.model,
      success: true,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("scoring exception", { shortcode, error: msg });
    return {
      shortcode,
      hook: null,
      value: null,
      viral: null,
      overall: null,
      tier: "C",
      reason: "",
      idea_vs_execution: null,
      model: "",
      success: false,
      error: msg,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════
// INCREMENTAL GAP FILLING
// ═══════════════════════════════════════════════════════════════════

/**
 * Run the incremental pipeline: download → transcribe → score, but only
 * for reels missing each artifact. Skips everything already complete.
 *
 * This is the main "sync" / "run pipeline" action called from the UI/RPC.
 */
export async function syncGaps(opts?: {
  limit?: number;
  config?: Partial<ContentIntelConfig>;
  progress?: PipelineProgress;
  signal?: AbortSignal;
}): Promise<SyncResult> {
  const store = getContentIntelStore();
  const progress = opts?.progress ?? (() => {});
  const limit = opts?.limit ?? 100;

  const result: SyncResult = {
    downloaded: 0,
    transcribed: 0,
    scored: 0,
    skipped: 0,
    errors: [],
    totalReels: store.countReels(),
  };

  // Log starting state
  const state = store.countByState();
  progress("pipeline sync starting", state);

  // ── Step 1: Download missing videos ──────────────────────────────
  const toDownload = store.listReelsMissingVideo(limit);
  progress("download step", { missing: toDownload.length });

  for (const reel of toDownload) {
    if (opts?.signal?.aborted) break;
    progress("downloading", { shortcode: reel.shortcode });

    const dl = await downloadReel(reel.shortcode, opts?.config);
    if (dl.success) {
      result.downloaded++;
    } else if (dl.error) {
      result.errors.push(`download ${reel.shortcode}: ${dl.error}`);
    }
  }

  // ── Step 2: Transcribe missing transcripts ──────────────────────
  const toTranscribe = store.listReelsMissingTranscript(limit);
  progress("transcribe step", { missing: toTranscribe.length });

  for (const reel of toTranscribe) {
    if (opts?.signal?.aborted) break;
    progress("transcribing", { shortcode: reel.shortcode });

    const tr = await transcribeReel(reel.shortcode, undefined, opts?.config);
    if (tr.success) {
      result.transcribed++;
    } else if (tr.error && !tr.error.includes("Video file not found")) {
      result.errors.push(`transcribe ${reel.shortcode}: ${tr.error}`);
    }
  }

  // ── Step 3: Score missing scores ────────────────────────────────
  const toScore = store.listReelsMissingScore(limit);
  progress("score step", { missing: toScore.length });

  for (const reel of toScore) {
    if (opts?.signal?.aborted) break;
    progress("scoring", { shortcode: reel.shortcode });

    const sr = await scoreReel(reel.shortcode, opts?.config);
    if (sr.success) {
      result.scored++;
    } else if (sr.error) {
      result.errors.push(`score ${reel.shortcode}: ${sr.error}`);
    }
  }

  result.totalReels = store.countReels();
  progress("pipeline sync complete", result as unknown as Record<string, unknown>);
  return result;
}

// ═══════════════════════════════════════════════════════════════════
// VIDEO PATH HELPERS
// ═══════════════════════════════════════════════════════════════════

/**
 * Find the video file path for a shortcode by scanning the pipeline
 * output directory's JSON sidecars.
 */
export function resolveReelVideoPath(shortcode: string): string | null {
  return findVideoPath(shortcode, getPipelineConfig());
}

function findVideoPath(shortcode: string, config: ContentIntelConfig): string | null {
  const pipelineDir = config.pipelineDir;
  if (!pipelineDir) return null;
  const outputDir = join(pipelineDir, "output");
  if (!existsSync(outputDir)) return null;

  // gallery-dl structure: output/instagram/<username>/
  try {
    const entries = readdirSync(outputDir);
    for (const entry of entries) {
      const instagramDir = join(outputDir, entry, "instagram");
      if (!existsSync(instagramDir)) continue;
      const accounts = readdirSync(instagramDir);
      for (const acct of accounts) {
        const acctPath = join(instagramDir, acct);
        const files = readdirSync(acctPath);
        for (const file of files) {
          if (!file.endsWith(".mp4.json")) continue;
          try {
            const text = readFileSync(join(acctPath, file), "utf-8");
            const data = JSON.parse(text);
            const list = Array.isArray(data) ? data : [data];
            const sc = list[0]?.shortcode ?? list[0]?.post_shortcode ?? "";
            if (sc === shortcode) {
              const mp4 = file.replace(/\.mp4\.json$/, ".mp4");
              const mp4Path = join(acctPath, mp4);
              if (existsSync(mp4Path)) return mp4Path;
            }
          } catch {
            // skip unparseable
          }
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}
