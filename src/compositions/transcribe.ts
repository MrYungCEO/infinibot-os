/**
 * Caption transcription pipeline.
 *
 * Spawns a Python subprocess that runs `faster-whisper` over a media file
 * and returns word-level cues. Three reasons we shell out instead of using
 * a Node port:
 *   1. faster-whisper (CTranslate2) is the best speed / quality tradeoff
 *      among open-source Whisper variants — no Node port matches it.
 *   2. Word-level timestamps are first-class output — pycaps relies on
 *      this for its animation patterns.
 *   3. The user's hardware (CUDA / Metal / CPU) gets used naturally
 *      through CTranslate2 without us bundling anything.
 *
 * If the Python toolchain isn't available, the call fails fast with a
 * clear error so the UI can prompt the user to install it.
 */

import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSubsystemLogger } from "../logging/subsystem.js";

import type { CaptionCue, CaptionWord } from "./types.js";

const log = createSubsystemLogger("captions-transcribe");

// ── Public API ────────────────────────────────────────────────────

export interface TranscribeOptions {
  /** Absolute path to a video / audio file the gateway can read. */
  filePath: string;
  /** faster-whisper model size — "tiny" / "base" / "small" / "medium" / "large-v3". */
  model?: string;
  /** Locale hint (BCP-47 like "en", "es"). Auto-detected when omitted. */
  language?: string;
  /** Cap each cue at this many words (preset overrides this in render). */
  maxWordsPerCue?: number;
  /**
   * Optional cancellation signal — when aborted we kill the subprocess.
   * Useful for the gateway to support long-running transcription jobs.
   */
  signal?: AbortSignal;
}

export interface TranscribeResult {
  cues: CaptionCue[];
  language?: string;
  duration?: number;
}

const DEFAULT_MODEL = "small";
const DEFAULT_MAX_WORDS_PER_CUE = 6;

/**
 * Run faster-whisper over a media file and return cues with word-level
 * timing. Throws if Python or the package isn't available.
 */
export async function transcribeMedia(opts: TranscribeOptions): Promise<TranscribeResult> {
  if (!existsSync(opts.filePath)) {
    throw new Error(`Media file not found: ${opts.filePath}`);
  }
  const py = await resolvePython();
  if (!py) {
    throw new Error(
      "Python 3 not found on PATH. Install Python and run: `pip install faster-whisper` to enable auto-captions.",
    );
  }

  const model = opts.model ?? DEFAULT_MODEL;
  const lang = opts.language ?? "auto";
  const maxWords = opts.maxWordsPerCue ?? DEFAULT_MAX_WORDS_PER_CUE;

  // Stage the helper script into a temp dir so we don't need it bundled.
  const dir = mkdtempSync(join(tmpdir(), "infinibot-caps-"));
  const scriptPath = join(dir, "transcribe.py");
  writeFileSync(scriptPath, PY_SCRIPT, "utf-8");

  const args = [
    scriptPath,
    "--input",
    opts.filePath,
    "--model",
    model,
    "--max-words",
    String(maxWords),
  ];
  if (lang !== "auto") args.push("--language", lang);

  log.info(`transcribe: model=${model} lang=${lang} maxWords=${maxWords} file=${opts.filePath}`);

  const stdout = await runCapture(py, args, opts.signal);
  // Clean up the staged script — no need to keep it after the run.
  try {
    unlinkSync(scriptPath);
  } catch {
    /* ignore */
  }

  let parsed: { cues?: unknown; language?: string; duration?: number; error?: string };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    throw new Error(`Transcription returned non-JSON output: ${stdout.slice(0, 200)}`);
  }
  if (parsed.error) throw new Error(parsed.error);
  if (!Array.isArray(parsed.cues)) {
    throw new Error("Transcription returned no cues");
  }

  const cues: CaptionCue[] = (
    parsed.cues as Array<{
      start: number;
      end: number;
      text: string;
      words?: Array<{ start: number; end: number; word: string }>;
    }>
  ).map((c, i) => ({
    id: `cue_${i}`,
    start: Number(c.start) || 0,
    end: Number(c.end) || 0,
    text: String(c.text ?? "").trim(),
    words: Array.isArray(c.words)
      ? c.words.map(
          (w): CaptionWord => ({
            start: Number(w.start) || 0,
            end: Number(w.end) || 0,
            word: String(w.word ?? ""),
          }),
        )
      : undefined,
  }));

  return {
    cues,
    language: typeof parsed.language === "string" ? parsed.language : undefined,
    duration: typeof parsed.duration === "number" ? parsed.duration : undefined,
  };
}

// ── Subprocess helpers ────────────────────────────────────────────

async function resolvePython(): Promise<string | null> {
  const candidates =
    process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"];
  for (const c of candidates) {
    try {
      await new Promise<void>((resolve, reject) => {
        const p = spawn(c, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
        p.on("error", reject);
        p.on("close", (code) => (code === 0 ? resolve() : reject(new Error("non-zero"))));
      });
      return c;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function runCapture(bin: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf-8");
    });
    proc.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf-8");
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        // faster-whisper not installed → ModuleNotFoundError on stderr.
        const hint = /No module named 'faster_whisper'/.test(stderr)
          ? " — install with: pip install faster-whisper"
          : "";
        reject(
          new Error(`transcribe.py exit ${code}${hint}: ${stderr.split("\n").slice(-6).join(" ")}`),
        );
      }
    });
    if (signal) {
      const onAbort = () => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

// ── Embedded Python script ────────────────────────────────────────
//
// Self-contained — no relative imports, prints a single JSON object on
// stdout. Errors land in JSON `error` so we don't have to parse stderr.

const PY_SCRIPT = `#!/usr/bin/env python3
"""
infinibot transcribe — spawns faster-whisper, returns word-level cues as JSON.

Usage:
  python transcribe.py --input <file> [--model small] [--language en] [--max-words 6]
"""
import argparse
import json
import sys

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--model", default="small")
    ap.add_argument("--language", default=None)
    ap.add_argument("--max-words", type=int, default=6)
    args = ap.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError as e:
        print(json.dumps({"error": "faster_whisper not installed: " + str(e)}))
        return 0

    try:
        # Try GPU first, fall back to CPU.
        try:
            model = WhisperModel(args.model, device="auto", compute_type="auto")
        except Exception:
            model = WhisperModel(args.model, device="cpu", compute_type="int8")
        segments, info = model.transcribe(
            args.input,
            language=args.language,
            word_timestamps=True,
            vad_filter=True,
        )
    except Exception as e:
        print(json.dumps({"error": "transcribe failed: " + str(e)}))
        return 0

    cues = []
    for seg in segments:
        words = [
            {"start": float(w.start or 0), "end": float(w.end or 0), "word": (w.word or "").strip()}
            for w in (seg.words or [])
            if w.word and (w.word.strip())
        ]
        # Optionally split a long segment into shorter cues so screens
        # stay readable. faster-whisper's segments can be 10s+ on long
        # speech — pycaps prefers ~3-6 word phrases for animation density.
        chunks = []
        if words and args.max_words > 0:
            chunk = []
            for w in words:
                chunk.append(w)
                if len(chunk) >= args.max_words:
                    chunks.append(chunk); chunk = []
            if chunk: chunks.append(chunk)
        else:
            chunks = [words] if words else [[]]
        if not chunks or not chunks[0]:
            cues.append({
                "start": float(seg.start or 0),
                "end": float(seg.end or 0),
                "text": (seg.text or "").strip(),
                "words": [],
            })
            continue
        for chunk in chunks:
            if not chunk: continue
            cues.append({
                "start": chunk[0]["start"],
                "end": chunk[-1]["end"],
                "text": " ".join(w["word"] for w in chunk).strip(),
                "words": chunk,
            })

    out = {
        "cues": cues,
        "language": getattr(info, "language", None),
        "duration": getattr(info, "duration", None),
    }
    print(json.dumps(out))
    return 0

if __name__ == "__main__":
    sys.exit(main() or 0)
`;
