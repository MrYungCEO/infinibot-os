import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { DailyReviewConfig } from "./types.js";

// ── Local-calendar day helpers ────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, "0");

/** Local YYYY-MM-DD for an epoch-ms timestamp. */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function isDayKey(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** Local midnight (epoch ms) of a YYYY-MM-DD day. */
export function dayStart(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y!, m! - 1, d!).getTime();
}

export function dayEnd(key: string): number {
  return dayStart(addDays(key, 1));
}

export function addDays(key: string, n: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return dayKey(new Date(y!, m! - 1, d! + n, 12).getTime());
}

export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let k = from; k <= to && out.length < 4000; k = addDays(k, 1)) out.push(k);
  return out;
}

export function today(now = Date.now()): string {
  return dayKey(now);
}

// ── Secret redaction ──────────────────────────────────────────────────────────

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/g, // Telegram bot token
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g, // JWT
  /\bnf[pc]_[A-Za-z0-9]{20,}/g, // Netlify PAT
  /\bFlyV1\s+[A-Za-z0-9+/=,_-]{20,}/g,
  /\bfo1_[A-Za-z0-9_-]{20,}/g,
  /\bwhsec_[A-Za-z0-9+/=]{16,}/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"'<>]+/gi,
  /((?:api[_-]?key|token|secret|password|passwd|authorization)["']?\s*[:=]\s*["']?)[^\s"',;]{8,}/gi,
];

/** Strip anything that looks like a credential. Never store raw secrets. */
export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m, keep?: string) =>
      typeof keep === "string" && keep && m.startsWith(keep) ? `${keep}[redacted]` : "[redacted]",
    );
  }
  return out;
}

/** Redact + collapse whitespace + cap. */
export function clean(text: unknown, max = 160): string {
  if (typeof text !== "string") return "";
  const s = redact(text).replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ── Paths & config ────────────────────────────────────────────────────────────

export function stateDir(): string {
  return resolveStateDir();
}

export function analyticsDir(base = stateDir()): string {
  return path.join(base, "analytics");
}

export function dailyDir(base = stateDir()): string {
  return path.join(analyticsDir(base), "daily");
}

export function cacheDir(base = stateDir()): string {
  return path.join(analyticsDir(base), "cache");
}

/** Mirror readable through the already-live `files.read` RPC (pre-restart UI). */
export function filesMirrorDir(base = stateDir()): string {
  const override = process.env.INFINIBOT_FILES_ROOT?.trim();
  return path.join(override || path.join(base, "files"), ".daily-review");
}

export const DEFAULT_CONFIG: DailyReviewConfig = {
  telegram: { enabled: false, time: "21:30", target: "", channel: "telegram" },
  summary: { autoTime: "21:15", model: "haiku" },
  git: {
    roots: [path.join(os.homedir(), "Desktop"), path.join(os.homedir(), "Desktop", "Development")],
    extraRepos: [],
    exclude: [],
  },
};

export function configPath(base = stateDir()): string {
  return path.join(analyticsDir(base), "daily-review.config.json");
}

export function loadConfig(base = stateDir()): DailyReviewConfig {
  const raw = readJson<Partial<DailyReviewConfig>>(configPath(base)) ?? {};
  return {
    telegram: { ...DEFAULT_CONFIG.telegram, ...(raw.telegram ?? {}) },
    summary: { ...DEFAULT_CONFIG.summary, ...(raw.summary ?? {}) },
    git: { ...DEFAULT_CONFIG.git, ...(raw.git ?? {}) },
    backfillFrom: raw.backfillFrom,
  };
}

export function saveConfig(cfg: DailyReviewConfig, base = stateDir()): void {
  writeJsonAtomic(configPath(base), cfg);
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function writeJsonAtomic(file: string, value: unknown, pretty = false): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, pretty ? 2 : undefined));
  fs.renameSync(tmp, file);
}

export function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
