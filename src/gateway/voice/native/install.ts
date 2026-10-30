/**
 * Native voice install — makes the on-machine STT/TTS stack ACTUALLY usable,
 * not just "configured". This is what the Quickstart "Voice → On this machine"
 * step and `infinibot voice up --native` drive.
 *
 * What it does (each step streamed as a phase so the wizard can show progress):
 *   1. preflight  — ≥2 GB free under ~/.infinibot, github + huggingface reachable
 *   2. binary     — locate an existing whisper.cpp CLI, else build it from source
 *                   (or download a prebuilt where one exists), into
 *                   ~/.infinibot/voice/whisper/
 *   3. model      — download the chosen ggml model into .../whisper/models/
 *   4. tts        — verify the native TTS engine (kokoro-js) can load; it fetches
 *                   its own ONNX weights on first synth
 *   5. selftest   — `whisper-cli --help` exits cleanly (+ optional synth round-trip)
 *   6. persist    — write absolute paths into voice.json (stt.binary/modelPath)
 *
 * It FAILS LOUD: if the STT binary can't be produced (e.g. no compiler/cmake)
 * the install throws with an actionable message and the wizard step stays
 * incomplete — so a user can never finish "native" with a broken STT (the exact
 * bug this fixes).
 */

import { execFile, execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { STATE_DIR } from "../../../config/paths.js";
import { isNixMode } from "../../../config/paths.js";
import { loadVoiceConfig, saveVoiceConfig, type VoiceConfig } from "../config.js";
import {
  WHISPER_CLI_NAMES,
  WHISPER_DIR,
  WHISPER_MODELS_DIR,
  WHISPER_SRC_DIR,
  whisperBinaryPath,
  whisperModelPath,
} from "./paths.js";
import { downloadVerified, formatProgress, type ProgressFn } from "./download.js";

const pExecFile = promisify(execFile);

// ── Models ───────────────────────────────────────────────────────────────────

export interface WhisperModelSpec {
  id: string;
  url: string;
  sha256?: string;
  approxMb: number;
}

// ggml models hosted on Hugging Face by the whisper.cpp project. base.en is the
// default — small, fast, English-only. sha256 left unpinned (whisper.cpp
// publishes sha1); the file lands verified-by-size and HF's TLS.
export const WHISPER_MODELS: Record<string, WhisperModelSpec> = {
  "ggml-base.en": {
    id: "ggml-base.en",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
    approxMb: 148,
  },
  "ggml-small.en": {
    id: "ggml-small.en",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin",
    approxMb: 488,
  },
  "ggml-tiny.en": {
    id: "ggml-tiny.en",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin",
    approxMb: 78,
  },
};

// ── Phase reporting ───────────────────────────────────────────────────────────

export type InstallPhase =
  | "preflight"
  | "binary"
  | "model"
  | "tts"
  | "selftest"
  | "persist"
  | "done";

export interface InstallEvents {
  /** Free-text log line (terminal / SSE log channel). */
  onLine?: (line: string) => void;
  /** Phase transition with a short status. */
  onPhase?: (phase: InstallPhase, status: string) => void;
  /** Byte-level download progress (model download). */
  onProgress?: ProgressFn;
}

export interface InstallReport {
  ok: boolean;
  binaryPath: string;
  binaryReady: boolean;
  modelPath: string;
  modelReady: boolean;
  /** kokoro-js importable (native TTS engine). */
  ttsReady: boolean;
  selfTestPassed: boolean;
  notes: string[];
}

// ── Preflight ─────────────────────────────────────────────────────────────────

const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

export interface PreflightResult {
  ok: boolean;
  freeBytes: number;
  errors: string[];
}

async function freeBytesUnder(dir: string): Promise<number> {
  try {
    // statfs lands in node 18.15+. Walk up to an existing ancestor first.
    let probe = dir;
    while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
    const st = await (
      fs.promises as unknown as {
        statfs: (p: string) => Promise<{ bavail: bigint | number; bsize: bigint | number }>;
      }
    ).statfs(probe);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return Number.POSITIVE_INFINITY; // can't measure → don't block on it
  }
}

async function reachable(url: string, timeoutMs = 6000): Promise<boolean> {
  for (const method of ["HEAD", "GET"] as const) {
    try {
      const res = await fetch(url, { method, signal: AbortSignal.timeout(timeoutMs) });
      // Any HTTP answer (even 4xx) proves the host is reachable.
      if (res.status > 0) return true;
    } catch {
      /* try next method */
    }
  }
  return false;
}

/** Disk + network preconditions for a native install. */
export async function preflightNativeInstall(events?: InstallEvents): Promise<PreflightResult> {
  events?.onPhase?.("preflight", "checking disk + network");
  const errors: string[] = [];

  const freeBytes = await freeBytesUnder(STATE_DIR);
  if (freeBytes < MIN_FREE_BYTES) {
    errors.push(
      `Not enough free disk space in ${STATE_DIR}: ${(freeBytes / 1e9).toFixed(1)} GB free, need ≥2 GB.`,
    );
  } else {
    events?.onLine?.(`disk: ${(freeBytes / 1e9).toFixed(1)} GB free under ${STATE_DIR}`);
  }

  const [gh, hf] = await Promise.all([
    reachable("https://github.com"),
    reachable("https://huggingface.co"),
  ]);
  if (!gh) errors.push("Cannot reach github.com — check your network/proxy and retry.");
  if (!hf) errors.push("Cannot reach huggingface.co — check your network/proxy and retry.");
  if (gh && hf) events?.onLine?.("network: github + huggingface reachable");

  return { ok: errors.length === 0, freeBytes, errors };
}

// ── whisper.cpp binary acquisition ───────────────────────────────────────────

function commandExists(cmd: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  try {
    const out = execFileSync(probe, [cmd], { stdio: ["ignore", "pipe", "ignore"] });
    return Boolean(out.toString().trim());
  } catch {
    return false;
  }
}

/** Resolve a usable whisper.cpp CLI already on this machine (PATH or brew). */
function findExistingWhisperCli(): string | null {
  const probe = process.platform === "win32" ? "where" : "which";
  for (const name of WHISPER_CLI_NAMES) {
    if (!commandExists(name)) continue;
    try {
      const out = execFileSync(probe, [name], { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim()
        .split(/\r?\n/)[0];
      if (out && fs.existsSync(out)) return out;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** Symlink (or copy on win32) an existing CLI into our managed location. */
function linkBinary(src: string, events?: InstallEvents): void {
  fs.mkdirSync(WHISPER_DIR, { recursive: true });
  const dest = whisperBinaryPath();
  try {
    if (fs.existsSync(dest)) fs.rmSync(dest, { force: true });
    if (process.platform === "win32") {
      fs.copyFileSync(src, dest);
    } else {
      fs.symlinkSync(src, dest);
    }
    events?.onLine?.(`linked existing whisper.cpp CLI: ${src} → ${dest}`);
  } catch {
    // Fall back to a copy if symlink isn't permitted.
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, 0o755);
    events?.onLine?.(`copied existing whisper.cpp CLI: ${src} → ${dest}`);
  }
}

/** Stream a child process line-by-line into events.onLine; resolve on exit 0. */
function runStreamed(
  cmd: string,
  args: string[],
  cwd: string,
  events?: InstallEvents,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: process.env });
    const pump = (buf: Buffer) => {
      for (const line of buf.toString().split(/\r?\n/)) {
        if (line.trim()) events?.onLine?.(line.trimEnd());
      }
    };
    child.stdout?.on("data", pump);
    child.stderr?.on("data", pump);
    child.on("error", reject);
    child.on("close", (code: number) =>
      code === 0
        ? resolve()
        : reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`)),
    );
  });
}

// ── Windows prebuilt binary ───────────────────────────────────────────────────
//
// On Windows, building from source needs Visual Studio Build Tools + CMake — a
// heavy, easy-to-miss prerequisite. whisper.cpp ships prebuilt Windows binaries
// (a zip with whisper-cli.exe + its DLLs) on every GitHub release, so we fetch
// that instead and only fall back to a source build if the download fails. The
// asset/version can be overridden via env for pinning/air-gapped mirrors.

const WHISPER_WIN_VERSION = process.env.INFINIBOT_WHISPER_WIN_VERSION || "v1.7.4";
const WHISPER_WIN_ASSET = process.env.INFINIBOT_WHISPER_WIN_ASSET || "whisper-bin-x64.zip";
const WHISPER_WIN_URL =
  process.env.INFINIBOT_WHISPER_WIN_URL ||
  `https://github.com/ggerganov/whisper.cpp/releases/download/${WHISPER_WIN_VERSION}/${WHISPER_WIN_ASSET}`;

/** Recursively collect files matching a predicate (small trees only). */
function walkFiles(dir: string, pred: (name: string) => boolean, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, pred, out);
    else if (pred(entry.name)) out.push(full);
  }
  return out;
}

/** Unzip via PowerShell's Expand-Archive (always present on Windows 10+). */
function expandArchiveWindows(zip: string, destDir: string, events?: InstallEvents): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });
  events?.onLine?.(`extracting ${path.basename(zip)} …`);
  return runStreamed(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Expand-Archive -Path '${zip.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
    ],
    destDir,
    events,
  );
}

/**
 * Download + extract the prebuilt whisper.cpp Windows binary into WHISPER_DIR.
 * Returns the installed CLI path, or null if the prebuilt couldn't be produced
 * (so the caller can fall back to a source build). Never throws — a failed
 * download is an expected, recoverable condition on Windows.
 */
async function downloadPrebuiltWhisperWindows(events?: InstallEvents): Promise<string | null> {
  try {
    events?.onPhase?.("binary", "downloading prebuilt whisper.cpp (Windows)");
    fs.mkdirSync(WHISPER_DIR, { recursive: true });
    const zip = path.join(WHISPER_DIR, WHISPER_WIN_ASSET);
    const extractDir = path.join(WHISPER_DIR, "win-prebuilt");
    fs.rmSync(extractDir, { recursive: true, force: true });
    events?.onLine?.(`fetching ${WHISPER_WIN_URL}`);
    await downloadVerified({ url: WHISPER_WIN_URL, dest: zip, label: WHISPER_WIN_ASSET });
    await expandArchiveWindows(zip, extractDir, events);

    // Find the CLI exe (current releases ship whisper-cli.exe; older ones main.exe).
    const exe =
      walkFiles(extractDir, (n) => /^whisper-cli\.exe$/i.test(n))[0] ||
      walkFiles(extractDir, (n) => /^main\.exe$/i.test(n))[0];
    if (!exe) {
      events?.onLine?.(
        "prebuilt archive had no whisper-cli.exe / main.exe — falling back to source build",
      );
      return null;
    }
    const dest = whisperBinaryPath();
    if (fs.existsSync(dest)) fs.rmSync(dest, { force: true });
    fs.copyFileSync(exe, dest);
    // The CLI needs its sibling DLLs (whisper.dll, ggml*.dll, SDL2.dll, …) next
    // to the exe to load — copy every DLL from the exe's own directory.
    const exeDir = path.dirname(exe);
    for (const dll of walkFiles(exeDir, (n) => /\.dll$/i.test(n))) {
      try {
        fs.copyFileSync(dll, path.join(WHISPER_DIR, path.basename(dll)));
      } catch {
        /* best-effort */
      }
    }
    fs.rmSync(zip, { force: true });
    events?.onLine?.(`installed prebuilt whisper-cli.exe → ${dest}`);
    return dest;
  } catch (err) {
    events?.onLine?.(
      `prebuilt whisper.cpp download failed (${err instanceof Error ? err.message : String(err)}) — falling back to source build`,
    );
    return null;
  }
}

/**
 * Build whisper.cpp from source (git clone + cmake). Requires git, cmake and a
 * C++ compiler; throws a clear, actionable error if any is missing so the caller
 * surfaces it instead of completing a broken step.
 */
async function buildWhisperFromSource(events?: InstallEvents): Promise<string> {
  const missing: string[] = [];
  if (!commandExists("git")) missing.push("git");
  if (!commandExists("cmake")) missing.push("cmake");
  const hasCompiler =
    commandExists("cc") || commandExists("gcc") || commandExists("clang") || commandExists("c++");
  if (!hasCompiler) missing.push("a C/C++ compiler (gcc/clang)");
  if (missing.length) {
    const hint =
      process.platform === "darwin"
        ? "Install with: xcode-select --install && brew install cmake"
        : process.platform === "win32"
          ? "Install Visual Studio Build Tools + CMake, or pick Cloud/Docker voice."
          : "Install with: sudo apt-get install -y git cmake build-essential  (or your distro's equivalent), then retry.";
    throw new Error(
      `Cannot build whisper.cpp — missing: ${missing.join(", ")}. ${hint} ` +
        `Alternatively choose Cloud or Docker voice in Quickstart.`,
    );
  }

  events?.onPhase?.("binary", "building whisper.cpp from source");
  fs.mkdirSync(WHISPER_DIR, { recursive: true });

  if (!fs.existsSync(path.join(WHISPER_SRC_DIR, ".git"))) {
    fs.rmSync(WHISPER_SRC_DIR, { recursive: true, force: true });
    events?.onLine?.("cloning github.com/ggerganov/whisper.cpp …");
    await runStreamed(
      "git",
      ["clone", "--depth", "1", "https://github.com/ggerganov/whisper.cpp", WHISPER_SRC_DIR],
      WHISPER_DIR,
      events,
    );
  } else {
    events?.onLine?.("whisper.cpp source already present — reusing checkout");
  }

  events?.onLine?.("configuring (cmake) …");
  await runStreamed(
    "cmake",
    ["-B", "build", "-DCMAKE_BUILD_TYPE=Release", "-DWHISPER_BUILD_TESTS=OFF"],
    WHISPER_SRC_DIR,
    events,
  );
  events?.onLine?.("compiling whisper-cli (this can take a few minutes) …");
  await runStreamed(
    "cmake",
    [
      "--build",
      "build",
      "--config",
      "Release",
      "-j",
      String(Math.max(2, os.cpus().length)),
      "--target",
      "whisper-cli",
    ],
    WHISPER_SRC_DIR,
    events,
  );

  // Locate the built binary (cmake puts it under build/bin/ on most platforms).
  const candidates = [
    path.join(WHISPER_SRC_DIR, "build", "bin", "whisper-cli"),
    path.join(WHISPER_SRC_DIR, "build", "bin", "Release", "whisper-cli.exe"),
    path.join(WHISPER_SRC_DIR, "build", "whisper-cli"),
  ];
  const built = candidates.find((c) => fs.existsSync(c));
  if (!built) {
    throw new Error(
      `whisper.cpp build finished but whisper-cli was not found under ${WHISPER_SRC_DIR}/build/. ` +
        `This usually means the compile failed silently — re-run with a clean ${WHISPER_DIR}.`,
    );
  }
  const dest = whisperBinaryPath();
  fs.copyFileSync(built, dest);
  fs.chmodSync(dest, 0o755);
  events?.onLine?.(`installed whisper-cli → ${dest}`);
  return dest;
}

/**
 * Ensure a usable whisper.cpp CLI exists at whisperBinaryPath(). Strategy:
 *   already present → reuse · on PATH/brew → link · otherwise → build from source.
 * Throws (fail-loud) when no binary can be produced.
 */
export async function ensureWhisperBinary(events?: InstallEvents): Promise<string> {
  const dest = whisperBinaryPath();
  if (fs.existsSync(dest)) {
    events?.onPhase?.("binary", "already installed");
    events?.onLine?.(`whisper-cli present at ${dest}`);
    return dest;
  }
  if (isNixMode) {
    throw new Error(
      "Native voice auto-install is disabled under Nix. Provide whisper.cpp via your Nix env, " +
        `then symlink its CLI to ${dest}, or use Cloud/Docker voice.`,
    );
  }

  events?.onPhase?.("binary", "locating whisper.cpp");
  const existing = findExistingWhisperCli();
  if (existing) {
    linkBinary(existing, events);
    return dest;
  }
  // Windows: prefer the prebuilt release binary so users don't need Visual
  // Studio Build Tools + CMake. Fall back to a source build if it can't be
  // fetched (offline, mirror down, asset renamed).
  if (process.platform === "win32") {
    const prebuilt = await downloadPrebuiltWhisperWindows(events);
    if (prebuilt) return prebuilt;
  }
  return buildWhisperFromSource(events);
}

// ── Model download ────────────────────────────────────────────────────────────

export async function installWhisperModel(
  model = "ggml-base.en",
  events?: InstallEvents,
): Promise<{ modelPath: string; verified: boolean }> {
  const spec = WHISPER_MODELS[model] ?? WHISPER_MODELS["ggml-base.en"];
  const dest = whisperModelPath(spec.id);
  fs.mkdirSync(WHISPER_MODELS_DIR, { recursive: true });
  events?.onPhase?.("model", `downloading ${spec.id} (~${spec.approxMb} MB)`);

  let lastPct = -1;
  const progress: ProgressFn = (recv, total) => {
    events?.onProgress?.(recv, total);
    const pct = total ? Math.floor((recv / total) * 100) : -1;
    if (pct !== lastPct && pct % 5 === 0) {
      lastPct = pct;
      events?.onLine?.(formatProgress(`whisper ${spec.id}`, recv, total));
    }
  };
  await downloadVerified({ url: spec.url, dest, sha256: spec.sha256, label: spec.id }, progress);
  return { modelPath: dest, verified: Boolean(spec.sha256) };
}

// ── TTS (kokoro-js) verification ─────────────────────────────────────────────

/**
 * Verify the native TTS engine (kokoro-js) is importable. kokoro-js downloads
 * its ONNX weights itself on the first synth, so "ready" here means the package
 * resolves; the weights are pulled lazily (and cached) at runtime.
 */
export async function ensureNativeTts(
  events?: InstallEvents,
): Promise<{ ready: boolean; note: string }> {
  events?.onPhase?.("tts", "checking native TTS engine (kokoro-js)");
  try {
    await import(/* @vite-ignore */ "kokoro-js" as any);
    events?.onLine?.("kokoro-js resolved — native TTS available (weights download on first use)");
    return { ready: true, note: "kokoro-js available" };
  } catch {
    const note =
      "kokoro-js is not installed — native TTS will be unavailable. Install it with " +
      "`npm i kokoro-js` in the InfiniBot install, or use Cloud/Docker TTS.";
    events?.onLine?.(note);
    return { ready: false, note };
  }
}

// ── Self-test ────────────────────────────────────────────────────────────────

/** `whisper-cli --help` must exit cleanly for the binary to be considered good. */
export async function selfTestWhisper(events?: InstallEvents): Promise<boolean> {
  events?.onPhase?.("selftest", "verifying whisper-cli runs");
  const bin = whisperBinaryPath();
  try {
    const { stdout, stderr } = await pExecFile(bin, ["--help"], { timeout: 15_000 });
    const out = `${stdout}\n${stderr}`.toLowerCase();
    const ok = out.includes("usage") || out.includes("whisper") || out.includes("model");
    events?.onLine?.(ok ? "whisper-cli --help OK" : "whisper-cli ran but output looked wrong");
    return ok;
  } catch (err) {
    // whisper-cli with --help can exit non-zero on some builds while still
    // printing usage; treat a usage-bearing stdout as success.
    const e = err as { stdout?: string; stderr?: string };
    const out = `${e.stdout ?? ""}\n${e.stderr ?? ""}`.toLowerCase();
    const ok = out.includes("usage") || out.includes("model");
    if (!ok) events?.onLine?.(`whisper-cli self-test failed: ${(err as Error).message}`);
    return ok;
  }
}

// ── Persist absolute paths into voice.json ───────────────────────────────────

function persistNativePaths(model: string, modelPath: string, events?: InstallEvents): void {
  events?.onPhase?.("persist", "writing paths to voice.json");
  const cfg: VoiceConfig = loadVoiceConfig() ?? {
    mode: "native",
    stt: { provider: "native", model },
    tts: { provider: "native", voice: "am_puck" },
  };
  cfg.mode = "native";
  cfg.stt = {
    ...cfg.stt,
    provider: "native",
    model,
    binary: whisperBinaryPath(),
    modelPath,
  };
  cfg.tts = { ...cfg.tts, provider: "native", voice: cfg.tts.voice ?? "am_puck" };
  saveVoiceConfig(cfg);
  events?.onLine?.(`voice.json updated: stt.binary=${whisperBinaryPath()}`);
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export interface InstallNativeVoiceOptions {
  model?: string;
  /** Skip preflight (caller already ran it). */
  skipPreflight?: boolean;
}

/**
 * Full native voice install. Throws on any hard failure (preflight, binary,
 * model, self-test) so the wizard step stays incomplete on a broken stack.
 * TTS (kokoro-js) being unavailable is a soft warning — STT is the hard gate
 * (it was the user-facing failure) and cloud TTS fallback exists.
 */
export async function installNativeVoice(
  opts: InstallNativeVoiceOptions = {},
  events?: InstallEvents,
): Promise<InstallReport> {
  const model = opts.model || "ggml-base.en";
  const notes: string[] = [];

  if (!opts.skipPreflight) {
    const pre = await preflightNativeInstall(events);
    if (!pre.ok) throw new Error(pre.errors.join(" "));
  }

  await ensureWhisperBinary(events); // throws if it can't produce a binary
  const { modelPath, verified } = await installWhisperModel(model, events);
  if (!verified) notes.push(`${model} downloaded without a pinned sha256 (HF TLS only)`);

  const tts = await ensureNativeTts(events);
  if (!tts.ready) notes.push(tts.note);

  const selfTestPassed = await selfTestWhisper(events);
  if (!selfTestPassed) {
    throw new Error(
      `whisper-cli self-test failed — the binary at ${whisperBinaryPath()} does not run. ` +
        `Clear ${WHISPER_DIR} and retry, or use Cloud/Docker voice.`,
    );
  }

  persistNativePaths(model, modelPath, events);
  events?.onPhase?.("done", "native voice ready");

  return {
    ok: true,
    binaryPath: whisperBinaryPath(),
    binaryReady: fs.existsSync(whisperBinaryPath()),
    modelPath,
    modelReady: fs.existsSync(modelPath),
    ttsReady: tts.ready,
    selfTestPassed,
    notes,
  };
}

// ── Back-compat shim ─────────────────────────────────────────────────────────

export interface LegacyInstallReport {
  modelPath: string;
  modelVerified: boolean;
  binaryPresent: boolean;
  notes: string[];
}

/**
 * Back-compat wrapper for the original model-only installer (still called by
 * `infinibot voice up`). Now also acquires the binary + self-tests so the CLI
 * path installs a working stack too. Never throws for a missing kokoro-js.
 */
export async function installNativeWhisper(
  model = "ggml-base.en",
  onLine?: (line: string) => void,
  onProgress?: ProgressFn,
): Promise<LegacyInstallReport> {
  const report = await installNativeVoice(
    { model },
    {
      onLine,
      onProgress,
      onPhase: (phase, status) => onLine?.(`[${phase}] ${status}`),
    },
  );
  return {
    modelPath: report.modelPath,
    modelVerified: report.notes.every((n) => !n.includes("without a pinned sha256")),
    binaryPresent: report.binaryReady,
    notes: report.notes,
  };
}
