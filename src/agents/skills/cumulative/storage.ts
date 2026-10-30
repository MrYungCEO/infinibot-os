/**
 * Reads + writes for learned SKILL.md files.
 *
 * Each learned skill lives at:
 *
 *   <workspace>/skills/_learned/<slug>/SKILL.md
 *
 * which is a directory shape the existing `loadSkillsFromDir` watcher
 * already understands — no separate registration path needed. We persist
 * a parallel usage sidecar under `${CONFIG_DIR}/cumulative-skills/usage/`
 * so the workspace dir stays clean of mutable state (the SKILL.md itself
 * is checked-in-able; the usage data is per-machine).
 */
import fs from "node:fs";
import path from "node:path";

import { createSubsystemLogger } from "../../../logging/subsystem.js";

import type {
  CumulativeSkillsConfig,
  LearnedSkillFrontmatter,
  ReflectionDraft,
  UsageRecord,
} from "./types.js";
import { computeFingerprint } from "./quality-gate.js";

const log = createSubsystemLogger("cumulative-skills/storage");

/**
 * Frontmatter regex shared with the gate's dedupe scan. Captures everything
 * between the leading `---` delimiters as raw YAML-ish lines.
 */
export const LEARNED_FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;

export interface ParsedLearnedSkill {
  frontmatter: LearnedSkillFrontmatter;
  body: string;
}

/** Public entry: persist a draft as a learned SKILL.md + usage sidecar. */
export function persistLearnedSkill(
  config: CumulativeSkillsConfig,
  draft: ReflectionDraft,
  sourceTrajectoryId: string,
): { skillDir: string; skillFile: string; frontmatter: LearnedSkillFrontmatter } {
  fs.mkdirSync(config.skillsLearnedDir, { recursive: true });
  fs.mkdirSync(config.usageDir, { recursive: true });
  const skillDir = path.join(config.skillsLearnedDir, draft.name);
  fs.mkdirSync(skillDir, { recursive: true });

  const now = new Date().toISOString();
  const fingerprint = computeFingerprint(draft.body);
  const frontmatter: LearnedSkillFrontmatter = {
    name: draft.name,
    description: draft.description,
    createdAt: now,
    updatedAt: now,
    sourceTrajectoryId,
    fingerprint,
    origin: "learned",
    emoji: draft.emoji,
  };
  const skillFile = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(skillFile, serializeSkillFile(frontmatter, draft.body), "utf8");
  log.info(`learned new skill "${draft.name}" → ${skillFile}`);
  // Seed an empty usage record.
  writeUsage(config, {
    skillKey: draft.name,
    invocations: 0,
    successes: 0,
    failures: 0,
    recentTrajectoryIds: [],
  });
  return { skillDir, skillFile, frontmatter };
}

/** Read a SKILL.md and return its frontmatter + body. Returns null when the file isn't a learned skill. */
export function parseLearnedSkillFile(file: string): ParsedLearnedSkill | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const match = LEARNED_FRONTMATTER_RE.exec(raw);
  if (!match) return null;
  const frontmatterText = (match[1] ?? "").trim();
  const body = (match[2] ?? "").trim();
  const parsed = parseFrontmatter(frontmatterText);
  if (parsed.origin !== "learned") return null; // not a learned-by-us skill
  return { frontmatter: parsed as unknown as LearnedSkillFrontmatter, body };
}

/** Parse the YAML-ish key:value frontmatter into an object. */
function parseFrontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([a-zA-Z0-9_]+):\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    out[m[1] as string] = stripQuotes(m[2] as string);
  }
  return out;
}

function stripQuotes(v: string): string {
  if (v.length < 2) return v;
  const first = v[0];
  const last = v[v.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return v.slice(1, -1);
  }
  return v;
}

/** Compose the on-disk SKILL.md text. */
function serializeSkillFile(frontmatter: LearnedSkillFrontmatter, body: string): string {
  const fields: Array<[string, string | undefined]> = [
    ["name", frontmatter.name],
    ["description", quoteIfNeeded(frontmatter.description)],
    ["origin", frontmatter.origin],
    ["createdAt", frontmatter.createdAt],
    ["updatedAt", frontmatter.updatedAt],
    ["sourceTrajectoryId", frontmatter.sourceTrajectoryId],
    ["fingerprint", frontmatter.fingerprint],
    ["emoji", frontmatter.emoji],
  ];
  const lines = ["---"];
  for (const [k, v] of fields) {
    if (v == null || v === "") continue;
    lines.push(`${k}: ${v}`);
  }
  lines.push("---", "", body.trim(), "");
  return lines.join("\n");
}

function quoteIfNeeded(value: string): string {
  if (!value) return "";
  // YAML reserves ":#-?[]&*!|>%@'`,". Quote when the description
  // contains any of them or starts with whitespace.
  return /[:#\-?[\]&*!|>%@`,"']|^\s/.test(value)
    ? `"${value.replace(/"/g, '\\"')}"`
    : value;
}

/** Update an existing SKILL.md body in-place after a self-improve pass. */
export function rewriteLearnedSkillBody(
  config: CumulativeSkillsConfig,
  skillKey: string,
  newBody: string,
): boolean {
  const skillFile = path.join(config.skillsLearnedDir, skillKey, "SKILL.md");
  const parsed = parseLearnedSkillFile(skillFile);
  if (!parsed) {
    log.warn(`rewrite skipped — could not parse ${skillFile}`);
    return false;
  }
  const updated: LearnedSkillFrontmatter = {
    ...parsed.frontmatter,
    updatedAt: new Date().toISOString(),
    fingerprint: computeFingerprint(newBody),
  };
  fs.writeFileSync(skillFile, serializeSkillFile(updated, newBody), "utf8");
  log.info(`rewrote learned skill "${skillKey}" body (new fingerprint ${updated.fingerprint}).`);
  return true;
}

// ── Usage records ───────────────────────────────────────────────────────

function usageFileFor(config: CumulativeSkillsConfig, skillKey: string): string {
  fs.mkdirSync(config.usageDir, { recursive: true });
  // Match the dir-name shape — matches the slug exactly.
  return path.join(config.usageDir, `${skillKey}.json`);
}

export function readUsage(
  config: CumulativeSkillsConfig,
  skillKey: string,
): UsageRecord {
  const file = usageFileFor(config, skillKey);
  if (!fs.existsSync(file)) {
    return {
      skillKey,
      invocations: 0,
      successes: 0,
      failures: 0,
      recentTrajectoryIds: [],
    };
  }
  try {
    const text = fs.readFileSync(file, "utf8");
    return JSON.parse(text) as UsageRecord;
  } catch (err) {
    log.warn(`usage read failed for ${skillKey}: ${(err as Error)?.message ?? err}`);
    return {
      skillKey,
      invocations: 0,
      successes: 0,
      failures: 0,
      recentTrajectoryIds: [],
    };
  }
}

export function writeUsage(config: CumulativeSkillsConfig, record: UsageRecord): void {
  const file = usageFileFor(config, record.skillKey);
  try {
    fs.writeFileSync(file, JSON.stringify(record, null, 2), "utf8");
  } catch (err) {
    log.warn(`usage write failed for ${record.skillKey}: ${(err as Error)?.message ?? err}`);
  }
}

/** Increment the invocation counter when an agent picks up a learned skill. */
export function incrementUsage(
  config: CumulativeSkillsConfig,
  skillKey: string,
  outcome: "success" | "failure",
  trajectoryId?: string,
): UsageRecord {
  const record = readUsage(config, skillKey);
  record.invocations += 1;
  if (outcome === "success") record.successes += 1;
  else record.failures += 1;
  record.lastInvokedAt = new Date().toISOString();
  if (trajectoryId) {
    record.recentTrajectoryIds = [trajectoryId, ...record.recentTrajectoryIds]
      .slice(0, config.recentTrajectoryWindow);
  }
  writeUsage(config, record);
  return record;
}

/** List every learned skill currently on disk + its usage record. */
export function listLearnedSkills(
  config: CumulativeSkillsConfig,
): Array<{ frontmatter: LearnedSkillFrontmatter; body: string; usage: UsageRecord }> {
  if (!fs.existsSync(config.skillsLearnedDir)) return [];
  const out: Array<{
    frontmatter: LearnedSkillFrontmatter;
    body: string;
    usage: UsageRecord;
  }> = [];
  for (const entry of fs.readdirSync(config.skillsLearnedDir)) {
    const skillFile = path.join(config.skillsLearnedDir, entry, "SKILL.md");
    const parsed = parseLearnedSkillFile(skillFile);
    if (!parsed) continue;
    const usage = readUsage(config, parsed.frontmatter.name);
    out.push({ ...parsed, usage });
  }
  return out;
}
