/**
 * Per-funnel workspace — `<state>/funnels/<funnelId>/`.
 *
 * Each funnel gets a workspace directory mirroring the per-composition
 * pattern from the video editor. Inside lives:
 *
 *   • `page.json`       — public lead-capture page config (fields, theme,
 *                          headline, CTA). Drives the rendered HTML at
 *                          `/p/funnels/<slug>`.
 *   • `assets/`         — uploaded images / PDFs / videos for the page
 *                          and outbound emails.
 *   • `templates/`      — email + SMS templates with merge variables
 *                          (`{{lead.name}}`, `{{stage.name}}`, etc.).
 *   • `sop/`            — markdown SOPs the agent reads when running
 *                          autonomous tasks against this funnel.
 *   • `submissions.jsonl` — append-only log of every public submission
 *                          (raw payload + the lead id we created from it),
 *                          for audit + replay.
 *
 * Atomic writes for `page.json` follow the same pattern as the
 * compositions metadata writer to avoid `.tmp.*` litter.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { resolveStateDir } from "../config/paths.js";

// ── Types ─────────────────────────────────────────────────────

export type PageFieldKind =
  | "text"
  | "email"
  | "phone"
  | "textarea"
  | "select"
  | "checkbox"
  | "hidden";

export interface PageField {
  /** The lead property the field maps to (`email`, `name`, `company`, custom). */
  id: string;
  label: string;
  kind: PageFieldKind;
  required?: boolean;
  placeholder?: string;
  /** For `select` — the dropdown options. */
  options?: Array<{ label: string; value: string }>;
  /** For `hidden` — the value submitted alongside the form. */
  defaultValue?: string;
}

export interface PageConfig {
  /** Unique slug used in the public URL (`/p/funnels/<slug>`). */
  slug: string;
  /** Whether the page is reachable publicly. */
  published: boolean;
  /** Browser title + OG title. */
  title: string;
  /** Pre-form headline (rendered as h1). */
  headline: string;
  /** Subheadline / lead paragraph. */
  subheadline: string;
  /** Optional list of feature bullets shown above the form. */
  bullets: string[];
  /** Submit button label. */
  cta: string;
  /** Where to redirect after a successful submission. Empty → inline thank-you. */
  thankYouUrl: string;
  /** Inline thank-you headline shown when `thankYouUrl` is empty. */
  thankYouHeadline: string;
  thankYouBody: string;
  /** Form fields. The `email` field is auto-included if missing. */
  fields: PageField[];
  /** Branding overrides for this page. */
  theme: {
    primaryColor: string;
    bgColor: string;
    textColor: string;
    fontStack: string;
    /** Filename inside `assets/` for the logo image. */
    logoAsset: string | null;
  };
  /** Honeypot — bots fill this; we silently drop them. */
  honeypotField?: string;
  /**
   * Optional autoresponder fired async on every accepted submission.
   * Subject + body support `{{name}}`, `{{email}}`, `{{company}}`, and
   * `{{<customField>}}` merge tags. Provider selection happens in
   * `src/services/email/dispatcher.ts`. Set `transactionalId` to use
   * Loops; otherwise the body is sent through Resend.
   */
  autoresponder?: {
    enabled: boolean;
    subject: string;
    body: string;
    html?: string;
    fromEmail?: string;
    replyTo?: string;
    transactionalId?: string;
  };
  /** Extra metadata (campaign id, AB test variant, etc.). */
  meta: Record<string, unknown>;
  /** Last update timestamp. */
  updatedAt: number;
}

// ── Defaults ─────────────────────────────────────────────────

export function defaultPageConfig(funnelName: string): PageConfig {
  const slug = slugify(funnelName);
  return {
    slug,
    published: false,
    title: funnelName,
    headline: funnelName,
    subheadline: "Tell us about yourself and we'll be in touch.",
    bullets: [],
    cta: "Get in touch",
    thankYouUrl: "",
    thankYouHeadline: "Thanks!",
    thankYouBody: "We received your submission and will reach out shortly.",
    fields: [
      { id: "name", label: "Name", kind: "text", required: true, placeholder: "Your name" },
      {
        id: "email",
        label: "Email",
        kind: "email",
        required: true,
        placeholder: "you@company.com",
      },
      { id: "company", label: "Company", kind: "text", required: false, placeholder: "Acme Inc." },
    ],
    theme: {
      primaryColor: "#fbbf24",
      bgColor: "#0a0a0f",
      textColor: "#e4e4e7",
      fontStack: "system-ui, -apple-system, 'Segoe UI', sans-serif",
      logoAsset: null,
    },
    honeypotField: "company_url",
    meta: {},
    updatedAt: Date.now(),
  };
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "funnel"
  );
}

// ── Path helpers ─────────────────────────────────────────────

export function funnelsRoot(): string {
  return resolve(resolveStateDir(), "funnels");
}

export function funnelDir(funnelId: string): string {
  return join(funnelsRoot(), funnelId);
}

export function funnelAssetsDir(funnelId: string): string {
  return join(funnelDir(funnelId), "assets");
}

export function funnelTemplatesDir(funnelId: string): string {
  return join(funnelDir(funnelId), "templates");
}

export function funnelSopDir(funnelId: string): string {
  return join(funnelDir(funnelId), "sop");
}

export function pageConfigPath(funnelId: string): string {
  return join(funnelDir(funnelId), "page.json");
}

export function submissionsLogPath(funnelId: string): string {
  return join(funnelDir(funnelId), "submissions.jsonl");
}

/** Create the per-funnel workspace skeleton. Idempotent. */
export function ensureFunnelWorkspace(funnelId: string, funnelName: string): void {
  const dirs = [
    funnelDir(funnelId),
    funnelAssetsDir(funnelId),
    funnelTemplatesDir(funnelId),
    funnelSopDir(funnelId),
  ];
  for (const d of dirs) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
  // Seed a default page config if none exists yet.
  if (!existsSync(pageConfigPath(funnelId))) {
    writePageConfig(funnelId, defaultPageConfig(funnelName));
  }
}

// ── page.json I/O ────────────────────────────────────────────

export function readPageConfig(funnelId: string): PageConfig | null {
  const p = pageConfigPath(funnelId);
  // Sweep stale tmp files left by a crashed writer (same pattern as
  // compositions/project-dir cleanupStaleTmpFiles).
  cleanupTmpFiles(p);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as PageConfig;
  } catch {
    return null;
  }
}

export function writePageConfig(funnelId: string, cfg: PageConfig): void {
  const p = pageConfigPath(funnelId);
  mkdirSync(dirname(p), { recursive: true });
  cfg.updatedAt = Date.now();
  // Atomic write: tmp file + rename.
  const tmp = `${p}.tmp.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(16).slice(2, 8)}`;
  const body = JSON.stringify(cfg, null, 2);
  try {
    writeFileSync(tmp, body, "utf-8");
    try {
      renameSync(tmp, p);
    } catch {
      // Rename failed (Windows AV / indexer / second writer). Fall back
      // to a plain write and clean the tmp.
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      writeFileSync(p, body, "utf-8");
    }
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

function cleanupTmpFiles(filePath: string): void {
  try {
    const dir = dirname(filePath);
    const base = filePath.split(/[\\/]/).pop() ?? "page.json";
    if (!existsSync(dir)) return;
    const cutoff = Date.now() - 60_000;
    for (const entry of readdirSync(dir)) {
      if (!entry.startsWith(`${base}.tmp.`)) continue;
      const full = join(dir, entry);
      try {
        const st = statSync(full);
        if (st.mtimeMs < cutoff) unlinkSync(full);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

// ── Submissions log ──────────────────────────────────────────

export interface SubmissionLogEntry {
  ts: number;
  ip?: string;
  userAgent?: string;
  payload: Record<string, unknown>;
  /** Lead id we created from this submission, when known. */
  leadId?: string;
  /** Honeypot trip — payload was discarded. */
  rejected?: "honeypot" | "rate_limit" | "validation" | "internal_error";
  error?: string;
}

export function appendSubmission(funnelId: string, entry: SubmissionLogEntry): void {
  const p = submissionsLogPath(funnelId);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(entry) + "\n", "utf-8");
}

export function readSubmissions(funnelId: string, limit = 100): SubmissionLogEntry[] {
  const p = submissionsLogPath(funnelId);
  if (!existsSync(p)) return [];
  try {
    const lines = readFileSync(p, "utf-8")
      .split(/\r?\n/)
      .filter((l) => l.trim());
    return lines
      .slice(-limit)
      .reverse()
      .map((l) => JSON.parse(l) as SubmissionLogEntry);
  } catch {
    return [];
  }
}
