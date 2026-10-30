/**
 * Design page — skill registry.
 *
 * Scans for design-oriented `SKILL.md` folders in two places:
 *   1. Bundled seed at `src/design/seed-skills/` (ships with the repo).
 *   2. User dir at `${stateDir}/design-skills/` — drop a folder here, restart
 *      the gateway, it appears in the picker. Same convention open-design uses.
 *
 * Each skill is a folder with a single `SKILL.md`. The YAML frontmatter
 * supports the standard fields (name, description) plus an extended `od:`
 * namespace from open-design (mode, platform, scenario, preview, fidelity,
 * default_for, featured, speaker_notes, animations, example_prompt). Unknown
 * fields are tolerated.
 *
 * Side files (assets/, references/) are NOT loaded into memory here — the
 * agent reads them off disk when it actually runs the skill. We only return
 * the folder path so the prompt composer can point the agent at it.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";

import type { DesignSkill, ProjectFidelity } from "./types.js";

const MAX_DESCRIPTION_CHARS = 300;

let _cache: { skills: DesignSkill[]; loadedAt: number } | null = null;
const CACHE_TTL_MS = 60_000;

export function listDesignSkills(stateDir: string): DesignSkill[] {
  if (_cache && Date.now() - _cache.loadedAt < CACHE_TTL_MS) return _cache.skills;
  const out: DesignSkill[] = [];
  // Seed dir first so user overrides on the same slug win when both exist.
  const seedDir = resolveSeedDir();
  if (seedDir && existsSync(seedDir)) collectFrom(seedDir, out);
  const userDir = join(stateDir, "design-skills");
  if (existsSync(userDir)) collectFrom(userDir, out, /* allowOverride */ true);
  // Stable sort: featured first, then alphabetical by name.
  out.sort((a, b) => {
    const fa = a.od.featured ? 0 : 1;
    const fb = b.od.featured ? 0 : 1;
    if (fa !== fb) return fa - fb;
    return a.name.localeCompare(b.name);
  });
  _cache = { skills: out, loadedAt: Date.now() };
  return out;
}

export function getDesignSkill(stateDir: string, id: string): DesignSkill | null {
  return listDesignSkills(stateDir).find((s) => s.id === id) ?? null;
}

export function invalidateSkillCache(): void {
  _cache = null;
}

function resolveSeedDir(): string | null {
  try {
    const here =
      typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
    return join(here, "seed-skills");
  } catch {
    return null;
  }
}

function collectFrom(rootDir: string, out: DesignSkill[], allowOverride = false): void {
  let entries: string[];
  try {
    entries = readdirSync(rootDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const dir = join(rootDir, entry);
    let stat;
    try {
      stat = statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const skillFile = join(dir, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    let skill: DesignSkill;
    try {
      skill = parseSkill(dir, skillFile);
    } catch (err) {
      console.warn(`[design-skills] failed to parse ${skillFile}:`, err);
      continue;
    }
    const existingIdx = out.findIndex((s) => s.id === skill.id);
    if (existingIdx >= 0) {
      if (allowOverride) out[existingIdx] = skill;
      continue;
    }
    out.push(skill);
  }
}

function parseSkill(dir: string, skillFile: string): DesignSkill {
  const raw = readFileSync(skillFile, "utf-8");
  const { frontmatter, body } = splitFrontmatter(raw);
  const slug = dir.split(/[\\/]/).pop()!;
  const name = (frontmatter.name as string | undefined) || slug;
  const description =
    (frontmatter.description as string | undefined) ??
    body
      .split("\n")
      .find((l) => l.trim())
      ?.slice(0, MAX_DESCRIPTION_CHARS) ??
    "";
  const od = (frontmatter.od as Record<string, unknown>) ?? {};
  return {
    id: slug,
    name,
    description,
    rootDir: resolve(dir),
    od: {
      mode: pickEnum(od.mode, ["prototype", "deck", "template"] as const),
      platform: pickEnum(od.platform, ["desktop", "mobile", "all"] as const),
      scenario: typeof od.scenario === "string" ? od.scenario : undefined,
      previewType:
        typeof (od["preview.type"] ?? od.previewType) === "string"
          ? String(od["preview.type"] ?? od.previewType)
          : undefined,
      fidelity: pickEnum(od.fidelity, ["wireframe", "polished", "high-fidelity"] as const) as
        | ProjectFidelity
        | undefined,
      defaultFor:
        typeof (od["default_for"] ?? od.defaultFor) === "string"
          ? String(od["default_for"] ?? od.defaultFor)
          : undefined,
      featured: od.featured === true || od.featured === "true",
      speakerNotes: od["speaker_notes"] === true || od.speakerNotes === true,
      animations: od.animations === true,
      examplePrompt:
        typeof (od["example_prompt"] ?? od.examplePrompt) === "string"
          ? String(od["example_prompt"] ?? od.examplePrompt)
          : undefined,
      designSystemRequires: Boolean(
        (od["design_system"] as Record<string, unknown> | undefined)?.requires ??
        (od.designSystem as Record<string, unknown> | undefined)?.requires,
      ),
    },
  };
}

function pickEnum<T extends readonly string[]>(v: unknown, allowed: T): T[number] | undefined {
  if (typeof v !== "string") return undefined;
  return (allowed as readonly string[]).includes(v) ? (v as T[number]) : undefined;
}

/**
 * Minimal YAML-ish frontmatter parser. Handles top-level scalars + one level
 * of nesting (open-design's `od:` block). Avoids pulling a full YAML dep —
 * frontmatter blocks are small and this covers every shape we ship.
 */
export function splitFrontmatter(raw: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  if (!raw.startsWith("---")) return { frontmatter: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return { frontmatter: {}, body: raw };
  const block = raw.slice(4, end).trim();
  const body = raw.slice(end + 4).replace(/^\n/, "");
  const frontmatter = parseYamlLite(block);
  return { frontmatter, body };
}

function parseYamlLite(block: string): Record<string, unknown> {
  const lines = block.split("\n");
  const out: Record<string, unknown> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) {
      i++;
      continue;
    }
    const m = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1].trim();
    const rest = m[2].trim();
    if (rest === "") {
      // nested block
      const child: Record<string, unknown> = {};
      i++;
      while (i < lines.length && /^\s+/.test(lines[i])) {
        const inner = /^\s+([A-Za-z0-9_.-]+):\s*(.*)$/.exec(lines[i]);
        if (inner) child[inner[1]] = coerce(inner[2].trim());
        i++;
      }
      out[key] = child;
    } else {
      out[key] = coerce(rest);
      i++;
    }
  }
  return out;
}

function coerce(s: string): unknown {
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null") return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^".*"$/.test(s) || /^'.*'$/.test(s)) return s.slice(1, -1);
  if (s.startsWith("[") && s.endsWith("]")) {
    return s
      .slice(1, -1)
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  }
  return s;
}
