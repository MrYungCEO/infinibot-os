/**
 * Local-only enforcement for the OCR pipeline.
 *
 * OCR and vision passes never leave this machine: the vision endpoint must be
 * loopback (Ollama on 127.0.0.1 by default) and the OCR engine is an offline
 * ONNX model run from a local Python venv. A non-loopback endpoint is refused
 * outright — there is no "allow cloud" switch.
 */
import os from "node:os";
import path from "node:path";
import { isLoopbackHost } from "../secure-mode/policy.js";

export class OcrLocalOnlyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OcrLocalOnlyError";
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/** Throw unless `url` points at this machine (loopback http/https only). */
export function assertLocalEndpoint(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new OcrLocalOnlyError(`OCR endpoint "${url}" is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new OcrLocalOnlyError(`OCR endpoint "${url}" must be http(s) on loopback`);
  }
  const host = hostOf(url);
  if (!host || !isLoopbackHost(host)) {
    throw new OcrLocalOnlyError(
      `OCR is local-only: refusing vision endpoint ${host ?? url}. Use Ollama on 127.0.0.1.`,
    );
  }
  return parsed.origin;
}

export function isLocalEndpoint(url: string): boolean {
  try {
    assertLocalEndpoint(url);
    return true;
  } catch {
    return false;
  }
}

function normalizeOllamaHost(raw: string): string {
  const v = raw.trim();
  if (!v) return v;
  if (/^https?:\/\//i.test(v)) return v.replace(/\/+$/, "");
  // OLLAMA_HOST is often "0.0.0.0:11434" or "127.0.0.1:11434".
  const hostPort = v.replace(/^0\.0\.0\.0/, "127.0.0.1");
  return `http://${hostPort}`.replace(/\/+$/, "");
}

export interface OcrRuntimeConfig {
  enabled: boolean;
  /** Ollama origin (validated loopback) or null when the configured one was refused. */
  ollamaUrl: string | null;
  ollamaRefused?: string;
  /** Forced vision model; null = auto-pick an installed vision-capable model. */
  vlModel: string | null;
  /** "auto" = images + low-confidence pages, "always", "off". */
  vlMode: "auto" | "always" | "off";
  /** Python interpreter of the OCR venv. */
  python: string;
  /** Pages below this mean confidence also get a VL reading. */
  lowConfidence: number;
  /** Max pages per PDF (large PDFs beyond this are truncated with a warning). */
  maxPages: number;
  /** Max VL page readings per document. */
  maxVlPages: number;
  maxAttempts: number;
  retryBaseMs: number;
}

export function resolveOcrConfig(env: NodeJS.ProcessEnv = process.env): OcrRuntimeConfig {
  const rawUrl = normalizeOllamaHost(
    env.INFINIBOT_OCR_OLLAMA_URL || env.OLLAMA_HOST || "http://127.0.0.1:11434",
  );
  let ollamaUrl: string | null = null;
  let ollamaRefused: string | undefined;
  try {
    ollamaUrl = assertLocalEndpoint(rawUrl);
  } catch (err) {
    ollamaRefused = (err as Error).message;
  }
  const vlModeRaw = (env.INFINIBOT_OCR_VL_MODE || "auto").trim().toLowerCase();
  const vlMode = vlModeRaw === "always" || vlModeRaw === "off" ? vlModeRaw : "auto";
  const num = (v: string | undefined, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    enabled: env.INFINIBOT_OCR_DISABLED !== "1",
    ollamaUrl,
    ollamaRefused,
    vlModel: env.INFINIBOT_OCR_VL_MODEL?.trim() || null,
    vlMode,
    python:
      env.INFINIBOT_OCR_PYTHON?.trim() ||
      path.join(os.homedir(), ".infinibot", "tools", "ocr-venv", "bin", "python"),
    lowConfidence: num(env.INFINIBOT_OCR_LOW_CONFIDENCE, 0.85),
    maxPages: num(env.INFINIBOT_OCR_MAX_PAGES, 300),
    maxVlPages: num(env.INFINIBOT_OCR_MAX_VL_PAGES, 3),
    maxAttempts: num(env.INFINIBOT_OCR_MAX_ATTEMPTS, 4),
    retryBaseMs: num(env.INFINIBOT_OCR_RETRY_BASE_MS, 5_000),
  };
}

/**
 * Env for OCR subprocesses: strips proxy settings and forces HF/torch hubs
 * offline so nothing a library does on import can phone home.
 */
export function offlineSubprocessEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "XDG_RUNTIME_DIR"]) {
    if (base[k]) env[k] = base[k];
  }
  env.HF_HUB_OFFLINE = "1";
  env.TRANSFORMERS_OFFLINE = "1";
  env.NO_PROXY = "*";
  env.PYTHONNOUSERSITE = "1";
  env.OMP_NUM_THREADS = base.OMP_NUM_THREADS || "4";
  return env;
}
