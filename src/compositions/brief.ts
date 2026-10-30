/**
 * Creative brief — `<projectDir>/TASK.md`.
 *
 * The brief is the contract the editor agent reads on every turn. It's
 * stored as Markdown so humans can edit it directly, and parsed back
 * into a structured Brief by `parseBrief()` so the validator + QC
 * checker can reason about it without LLM calls.
 *
 * The Markdown format is intentionally simple: H2 sections with a
 * known set of headers. Anything inside an `Acceptance criteria`
 * section becomes a checklist of strings the QC step compares against.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { projectDir } from "./project-dir.js";
import type { Aspect } from "./timeline.js";

// ── Types ─────────────────────────────────────────────────────

export type Platform = "tiktok" | "reels" | "shorts" | "youtube" | "x" | "linkedin" | "other";

export interface Brief {
  /** One-sentence outcome (deliverable + audience + platform). */
  goal: string;
  format: {
    aspect?: Aspect;
    durationSec: number;
    /** First N seconds reserved for the hook. 0 disables the hook check. */
    hookSec: number;
    platform?: Platform;
    cta?: string;
    captionsBurnedIn?: boolean;
  };
  /** Style / mood references — links, asset paths, "feel like X" prose. */
  references: string[];
  brand: {
    primaryColor?: string;
    secondaryColor?: string;
    /** Filename in <projectDir>/assets/ or absolute URL. */
    logoFile?: string;
    typeStack?: string;
    lowerThirdTemplate?: string;
    endCard?: string;
  };
  constraints: {
    mustInclude: string[];
    mustAvoid: string[];
    language?: string;
  };
  /** Each entry is one acceptance criterion the QC checker walks. */
  acceptance: string[];
  /** Free-form notes appended below the structured sections. */
  notes?: string;
}

// ── Defaults ─────────────────────────────────────────────────

export function emptyBrief(): Brief {
  return {
    goal: "",
    format: {
      aspect: "9:16",
      durationSec: 30,
      hookSec: 3,
      platform: "tiktok",
      cta: "",
      captionsBurnedIn: true,
    },
    references: [],
    brand: {},
    constraints: { mustInclude: [], mustAvoid: [] },
    acceptance: [],
    notes: "",
  };
}

// ── On-disk helpers ──────────────────────────────────────────

export function briefPath(compositionId: string): string {
  return join(projectDir(compositionId), "TASK.md");
}

export function readBriefFile(compositionId: string): Brief | null {
  const p = briefPath(compositionId);
  if (!existsSync(p)) return null;
  try {
    return parseBrief(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

export function writeBriefFile(compositionId: string, brief: Brief): void {
  const p = briefPath(compositionId);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, formatBrief(brief), "utf-8");
}

// ── Markdown ↔ Brief ────────────────────────────────────────

const SECTIONS = {
  goal: "Goal",
  format: "Format",
  references: "References",
  brand: "Brand kit",
  constraints: "Constraints",
  acceptance: "Acceptance criteria",
  notes: "Notes",
};

/** Render a Brief into the canonical Markdown format. */
export function formatBrief(brief: Brief): string {
  const lines: string[] = [];
  lines.push("# Brief");
  lines.push("");

  lines.push(`## ${SECTIONS.goal}`);
  lines.push(brief.goal?.trim() || "_(set the deliverable, audience, and platform in one sentence)_");
  lines.push("");

  lines.push(`## ${SECTIONS.format}`);
  const fmt = brief.format;
  lines.push(`- aspect: ${fmt.aspect ?? "9:16"}`);
  lines.push(`- duration: ${fmt.durationSec}s`);
  lines.push(`- hook window: first ${fmt.hookSec ?? 3}s`);
  if (fmt.platform) lines.push(`- platform: ${fmt.platform}`);
  if (fmt.cta) lines.push(`- CTA: ${fmt.cta}`);
  lines.push(`- captions burned in: ${fmt.captionsBurnedIn ? "yes" : "no"}`);
  lines.push("");

  lines.push(`## ${SECTIONS.references}`);
  if (brief.references.length === 0) {
    lines.push("_(none)_");
  } else {
    for (const r of brief.references) lines.push(`- ${r}`);
  }
  lines.push("");

  lines.push(`## ${SECTIONS.brand}`);
  const b = brief.brand;
  if (b.primaryColor) lines.push(`- primary: ${b.primaryColor}`);
  if (b.secondaryColor) lines.push(`- secondary: ${b.secondaryColor}`);
  if (b.logoFile) lines.push(`- logo: ${b.logoFile}`);
  if (b.typeStack) lines.push(`- type: ${b.typeStack}`);
  if (b.lowerThirdTemplate) lines.push(`- lower third: ${b.lowerThirdTemplate}`);
  if (b.endCard) lines.push(`- end card: ${b.endCard}`);
  if (Object.values(b).every((v) => !v)) lines.push("_(none)_");
  lines.push("");

  lines.push(`## ${SECTIONS.constraints}`);
  if (brief.constraints.language) lines.push(`- language: ${brief.constraints.language}`);
  if (brief.constraints.mustInclude.length > 0) {
    lines.push(`- must include:`);
    for (const i of brief.constraints.mustInclude) lines.push(`  - ${i}`);
  }
  if (brief.constraints.mustAvoid.length > 0) {
    lines.push(`- must avoid:`);
    for (const i of brief.constraints.mustAvoid) lines.push(`  - ${i}`);
  }
  if (
    !brief.constraints.language &&
    brief.constraints.mustInclude.length === 0 &&
    brief.constraints.mustAvoid.length === 0
  ) {
    lines.push("_(none)_");
  }
  lines.push("");

  lines.push(`## ${SECTIONS.acceptance}`);
  if (brief.acceptance.length === 0) {
    lines.push("- [ ] _(add criteria the QC checker should test)_");
  } else {
    for (const c of brief.acceptance) lines.push(`- [ ] ${c}`);
  }
  lines.push("");

  if (brief.notes && brief.notes.trim()) {
    lines.push(`## ${SECTIONS.notes}`);
    lines.push(brief.notes.trim());
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Parse a Markdown TASK.md back into a structured Brief. Tolerant of
 * arbitrary whitespace + extra prose; unknown sections become part of
 * the `notes` field.
 */
export function parseBrief(md: string): Brief {
  const out = emptyBrief();
  out.goal = "";
  out.references = [];
  out.constraints.mustInclude = [];
  out.constraints.mustAvoid = [];
  out.acceptance = [];
  out.notes = "";

  // Walk H2 sections.
  const sections = splitSections(md);
  const extras: string[] = [];

  for (const sec of sections) {
    const head = normalizeHeader(sec.title);
    const body = sec.body.trim();
    switch (head) {
      case "goal":
        out.goal = stripPlaceholder(body);
        break;
      case "format":
        applyFormat(out, body);
        break;
      case "references":
        out.references = bullets(body);
        break;
      case "brand":
      case "brandkit":
        applyBrand(out, body);
        break;
      case "constraints":
        applyConstraints(out, body);
        break;
      case "acceptance":
      case "acceptancecriteria":
        out.acceptance = bullets(body).map((s) => s.replace(/^\[\s*\]\s*/, "").replace(/^\[x\]\s*/i, ""));
        break;
      case "notes":
        out.notes = body;
        break;
      default:
        extras.push(`### ${sec.title}\n${body}`);
        break;
    }
  }

  if (extras.length > 0) {
    out.notes = [out.notes, ...extras].filter((s) => s && s.trim().length > 0).join("\n\n");
  }
  return out;
}

// ── Parser internals ─────────────────────────────────────────

function splitSections(md: string): Array<{ title: string; body: string }> {
  const lines = md.split(/\r?\n/);
  const out: Array<{ title: string; body: string }> = [];
  let cur: { title: string; body: string } | null = null;
  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      if (cur) out.push(cur);
      cur = { title: m[1], body: "" };
    } else if (cur) {
      cur.body += line + "\n";
    }
  }
  if (cur) out.push(cur);
  return out;
}

function normalizeHeader(s: string): string {
  return s.toLowerCase().replace(/[^a-z]/g, "");
}

function stripPlaceholder(s: string): string {
  // The placeholder we render in `formatBrief` is wrapped in italics
  // markdown — strip it when round-tripping so an empty brief stays
  // empty.
  if (/^_.*_$/.test(s.trim())) return "";
  return s.trim();
}

function bullets(body: string): string[] {
  return body
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*+]\s+/, ""))
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^_.*_$/.test(l));
}

function applyFormat(out: Brief, body: string): void {
  for (const line of bullets(body)) {
    const [keyRaw, ...rest] = line.split(":");
    const key = keyRaw.trim().toLowerCase();
    const val = rest.join(":").trim();
    if (!val) continue;
    if (key === "aspect") {
      const a = val.trim() as Aspect;
      if (["16:9", "9:16", "1:1", "4:5"].includes(a)) out.format.aspect = a;
    } else if (key === "duration") {
      const m = val.match(/([\d.]+)/);
      if (m) out.format.durationSec = parseFloat(m[1]);
    } else if (key.includes("hook")) {
      const m = val.match(/([\d.]+)/);
      if (m) out.format.hookSec = parseFloat(m[1]);
    } else if (key === "platform") {
      const p = val.toLowerCase();
      if (p === "tiktok" || p === "reels" || p === "shorts" || p === "youtube" || p === "x" || p === "linkedin" || p === "other") {
        out.format.platform = p;
      }
    } else if (key === "cta") {
      out.format.cta = val;
    } else if (/captions?.*burn/.test(key)) {
      out.format.captionsBurnedIn = /^(yes|true|on|1)$/i.test(val);
    }
  }
}

function applyBrand(out: Brief, body: string): void {
  for (const line of bullets(body)) {
    const [keyRaw, ...rest] = line.split(":");
    const key = keyRaw.trim().toLowerCase();
    const val = rest.join(":").trim();
    if (!val) continue;
    if (key === "primary") out.brand.primaryColor = val;
    else if (key === "secondary") out.brand.secondaryColor = val;
    else if (key === "logo") out.brand.logoFile = val;
    else if (key === "type") out.brand.typeStack = val;
    else if (/lower.*third/.test(key)) out.brand.lowerThirdTemplate = val;
    else if (/end.*card/.test(key)) out.brand.endCard = val;
  }
}

function applyConstraints(out: Brief, body: string): void {
  let mode: "include" | "avoid" | null = null;
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const headerMatch = trimmed.match(/^[-*+]\s+(must include|must avoid|language)\s*:\s*(.*)$/i);
    if (headerMatch) {
      const head = headerMatch[1].toLowerCase();
      const rest = headerMatch[2].trim();
      if (head.startsWith("language")) {
        out.constraints.language = rest;
        mode = null;
      } else if (head === "must include") {
        mode = "include";
        if (rest) out.constraints.mustInclude.push(rest);
      } else if (head === "must avoid") {
        mode = "avoid";
        if (rest) out.constraints.mustAvoid.push(rest);
      }
      continue;
    }
    const subBullet = trimmed.match(/^[-*+]\s+(.+)$/);
    if (subBullet && mode) {
      const text = subBullet[1].trim();
      if (text && !/^_.*_$/.test(text)) {
        if (mode === "include") out.constraints.mustInclude.push(text);
        else out.constraints.mustAvoid.push(text);
      }
    }
  }
}
