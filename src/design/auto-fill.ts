/**
 * Design page — auto-fill for "Load existing folder".
 *
 * Given a folder path, this:
 *   1. Reads the top-level shape (which marker files exist, file counts).
 *   2. Slurps key context files (index.html, README.md, package.json,
 *      brand-spec.md, DESIGN.md, *.css head) with size caps.
 *   3. Scrapes hex colors + font-family from CSS / HTML.
 *   4. Calls the existing pi-ai pipeline with a strict JSON-only prompt
 *      asking for { name, kind, fidelity, brief.*, skillId, systemId,
 *      summary } chosen from the lists we already have on disk.
 *   5. Parses the response and returns suggestions to the UI.
 *
 * The AI is given the catalog of available skills + design systems so it
 * picks an `id` rather than freeform text; the gateway double-checks the
 * id exists before returning.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

// Reuse Discovery Docs' AI wrapper — same pi-ai `completeSimple` path,
// already wired through the agent model-auth resolver.
import { generateDocument } from "../discovery/ai.js";
import { listDesignSkills } from "./skills-registry.js";
import { listDesignSystems } from "./design-systems.js";
import type { DesignBrief } from "./types.js";

const MAX_FILES_SCANNED = 30;
const MAX_FILE_BYTES = 30_000; // per-file cap when slurping for AI context
const MAX_TOTAL_CONTEXT_CHARS = 80_000; // global cap so the prompt doesn't blow up
const CONTEXT_FILENAMES = [
  "index.html",
  "index.htm",
  "README.md",
  "readme.md",
  "Readme.md",
  "brand-spec.md",
  "DESIGN.md",
  "design.md",
  "package.json",
  "deno.json",
  "vite.config.js",
  "vite.config.ts",
];
const CSS_EXTS = new Set(["css", "scss", "sass", "less"]);
const STYLED_EXTS = new Set(["html", "htm", "css", "scss", "sass", "less"]);

export interface AutoFillResult {
  /** Best-guess project name (basename of the folder, then AI refinement). */
  name: string;
  kind: "prototype" | "deck" | "doc" | "image" | "custom";
  brief: DesignBrief;
  /** Skill id chosen from the catalog, or null when nothing matches well. */
  suggestedSkillId: string | null;
  /** Design system id chosen from the catalog, or null. */
  suggestedSystemId: string | null;
  /** One-sentence summary of what the agent thinks the folder is. */
  summary: string;
  /** Hex colors + font families scraped from the folder — surfaced for the UI swatch. */
  detectedTokens: {
    colors: string[];
    fonts: string[];
  };
  /** Filename → contents-snippet map used as AI input (for debugging). */
  scannedFiles: string[];
}

export async function autoFillFromFolder(
  stateDir: string,
  folder: string,
  model: string,
): Promise<AutoFillResult> {
  if (!existsSync(folder)) throw new Error(`folder not found: ${folder}`);
  const stat = statSync(folder);
  if (!stat.isDirectory()) throw new Error(`not a directory: ${folder}`);

  // ── 1. Slurp context files ───────────────────────────────
  const scannedFiles: Array<{ path: string; body: string }> = [];
  let totalChars = 0;
  // Top-level marker files first.
  for (const fname of CONTEXT_FILENAMES) {
    const p = join(folder, fname);
    if (!existsSync(p)) continue;
    const body = readCapped(p, MAX_FILE_BYTES);
    if (!body) continue;
    scannedFiles.push({ path: fname, body });
    totalChars += body.length;
    if (totalChars >= MAX_TOTAL_CONTEXT_CHARS) break;
  }
  // Walk one level deep for styled files (CSS / additional HTML).
  if (totalChars < MAX_TOTAL_CONTEXT_CHARS) {
    const peeked = peekStyledFiles(folder);
    for (const rel of peeked) {
      if (scannedFiles.some((s) => s.path === rel)) continue;
      const body = readCapped(join(folder, rel), MAX_FILE_BYTES);
      if (!body) continue;
      scannedFiles.push({ path: rel, body });
      totalChars += body.length;
      if (totalChars >= MAX_TOTAL_CONTEXT_CHARS) break;
    }
  }

  // ── 2. Scrape tokens (colors + fonts) ───────────────────
  const tokens = scrapeTokens(scannedFiles);

  // ── 3. Build catalog snippet for the AI ─────────────────
  const skills = listDesignSkills(stateDir);
  const systems = listDesignSystems(stateDir);

  // ── 4. Call AI ──────────────────────────────────────────
  const systemPrompt = `You are a structured-extraction model. The user pasted contents from a design folder.
Your job: emit ONE valid JSON object (no prose, no markdown fences) matching this schema exactly:

{
  "name": "Short project name guessed from the folder",
  "kind": "prototype" | "deck" | "doc" | "image" | "custom",
  "brief": {
    "surface": "What format/surface — e.g. 'Landing page', '10-slide deck'",
    "audience": "Who this is for — best-guess from copy",
    "tone": "One short tone descriptor — e.g. 'Editorial / restrained'",
    "brandContext": "Brand notes worth carrying forward (1-3 sentences)",
    "scale": "Brief scale note — e.g. 'Hero + 3 sections + footer'",
    "constraints": "Hard constraints you can infer — e.g. 'Single HTML file'",
    "fidelity": "wireframe" | "polished" | "high-fidelity"
  },
  "suggestedSkillId": "<id from the SKILLS list below, or null>",
  "suggestedSystemId": "<id from the SYSTEMS list below, or null>",
  "summary": "One sentence: what is this folder?"
}

Rules:
- Output ONLY the JSON. No text before or after.
- Pick suggestedSkillId from the catalog by best-fit. If nothing fits well, return null.
- Pick suggestedSystemId from the catalog by best fit on color + typography tokens. If unsure, null.
- Be conservative: if the folder is empty or unclear, default kind="prototype", fidelity="polished", and leave brief fields short.

AVAILABLE SKILLS (id · name · description):
${skills.map((s) => `- ${s.id} · ${s.name} · ${s.description.replace(/\n+/g, " ").slice(0, 200)}`).join("\n")}

AVAILABLE DESIGN SYSTEMS (id · name · description):
${systems.map((s) => `- ${s.id} · ${s.name} · ${s.description.replace(/\n+/g, " ").slice(0, 200)}`).join("\n")}
`;

  const userPrompt = [
    `Folder basename: ${baseNameOf(folder)}`,
    `Detected colors: ${tokens.colors.slice(0, 16).join(", ") || "(none)"}`,
    `Detected fonts:  ${tokens.fonts.slice(0, 8).join(", ") || "(none)"}`,
    "",
    "── FILES ──",
    ...scannedFiles.map((f) => `\n### ${f.path}\n${f.body}`),
  ].join("\n");

  let parsed: AutoFillResult;
  try {
    const res = await generateDocument({
      model,
      systemPrompt,
      userPrompt,
      temperature: 0,
      maxTokens: 2000,
      timeoutMs: 60_000,
    });
    const json = extractJson(res.text);
    if (!json) throw new Error("AI returned no parseable JSON");
    parsed = normalizeResult(json, folder, skills, systems);
  } catch (err) {
    // AI unavailable — return a sensible default so the user can still proceed.
    console.warn("[design/auto-fill] AI fill failed:", err);
    parsed = {
      name: baseNameOf(folder),
      kind: "prototype",
      brief: { surface: "", audience: "", tone: "", fidelity: "polished" },
      suggestedSkillId: null,
      suggestedSystemId: null,
      summary: "Could not auto-fill — provide the brief manually.",
      detectedTokens: tokens,
      scannedFiles: scannedFiles.map((s) => s.path),
    };
    return parsed;
  }

  parsed.detectedTokens = tokens;
  parsed.scannedFiles = scannedFiles.map((s) => s.path);
  return parsed;
}

// ── Helpers ────────────────────────────────────────────────

function readCapped(path: string, cap: number): string {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return "";
    const body = readFileSync(path, "utf-8");
    if (body.length <= cap) return body;
    return body.slice(0, cap) + "\n[…truncated…]";
  } catch {
    return "";
  }
}

function peekStyledFiles(folder: string): string[] {
  const out: string[] = [];
  try {
    const entries = readdirSync(folder);
    for (const e of entries) {
      if (out.length >= MAX_FILES_SCANNED) break;
      if (e.startsWith(".")) continue;
      const full = join(folder, e);
      const s = statSync(full);
      if (s.isFile()) {
        const ext = e.split(".").pop()?.toLowerCase() ?? "";
        if (STYLED_EXTS.has(ext) && !CONTEXT_FILENAMES.includes(e)) {
          out.push(e);
        }
      } else if (s.isDirectory()) {
        // One sub-level for "styles/" / "css/" / "src/" — common conventions.
        try {
          for (const sub of readdirSync(full)) {
            if (out.length >= MAX_FILES_SCANNED) break;
            const sExt = sub.split(".").pop()?.toLowerCase() ?? "";
            if (CSS_EXTS.has(sExt)) out.push(`${e}/${sub}`);
          }
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

function scrapeTokens(scanned: Array<{ path: string; body: string }>): {
  colors: string[];
  fonts: string[];
} {
  const colorSet = new Set<string>();
  const fontSet = new Set<string>();
  for (const file of scanned) {
    if (!file.body) continue;
    // Hex colors
    const hexMatches = file.body.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    for (const m of hexMatches) colorSet.add(m.toLowerCase());
    // rgb()/rgba() colors
    const rgbMatches = file.body.match(/rgba?\([^)]+\)/g) ?? [];
    for (const m of rgbMatches) colorSet.add(m.toLowerCase());
    // font-family: ...
    const fontMatches = file.body.matchAll(/font-family\s*:\s*([^;}\n]+)/gi);
    for (const m of fontMatches) {
      const cleaned = m[1]
        .split(",")[0]
        .trim()
        .replace(/^["']|["']$/g, "");
      if (cleaned && cleaned.length < 80) fontSet.add(cleaned);
    }
  }
  return {
    colors: Array.from(colorSet).slice(0, 32),
    fonts: Array.from(fontSet).slice(0, 16),
  };
}

function baseNameOf(folder: string): string {
  return folder.split(/[\\/]/).filter(Boolean).pop() ?? "Loaded folder";
}

function extractJson(text: string): unknown | null {
  // Sometimes the model wraps in ```json fences despite instructions.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenced ? fenced[1] : text;
  // Walk to the first { and balance braces — handles models that prepend a stray sentence.
  const start = candidate.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const slice = candidate.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function normalizeResult(
  raw: unknown,
  folder: string,
  skills: Array<{ id: string }>,
  systems: Array<{ id: string }>,
): AutoFillResult {
  const j = (raw ?? {}) as Record<string, unknown>;
  const brief = ((j.brief as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;
  const skillId = typeof j.suggestedSkillId === "string" ? j.suggestedSkillId : null;
  const systemId = typeof j.suggestedSystemId === "string" ? j.suggestedSystemId : null;
  // Drop ids that don't exist in our catalogs — defensive against AI hallucinations.
  const validSkillId = skillId && skills.some((s) => s.id === skillId) ? skillId : null;
  const validSystemId = systemId && systems.some((s) => s.id === systemId) ? systemId : null;
  return {
    name: stringField(j.name) || baseNameOf(folder),
    kind: pickEnum(j.kind, ["prototype", "deck", "doc", "image", "custom"] as const) ?? "prototype",
    brief: {
      surface: stringField(brief.surface),
      audience: stringField(brief.audience),
      tone: stringField(brief.tone),
      brandContext: stringField(brief.brandContext) || undefined,
      scale: stringField(brief.scale) || undefined,
      constraints: stringField(brief.constraints) || undefined,
      fidelity:
        pickEnum(brief.fidelity, ["wireframe", "polished", "high-fidelity"] as const) ?? "polished",
    },
    suggestedSkillId: validSkillId,
    suggestedSystemId: validSystemId,
    summary: stringField(j.summary) || "Folder scanned.",
    detectedTokens: { colors: [], fonts: [] },
    scannedFiles: [],
  };
}

function stringField(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function pickEnum<T extends readonly string[]>(v: unknown, allowed: T): T[number] | null {
  if (typeof v !== "string") return null;
  return (allowed as readonly string[]).includes(v) ? (v as T[number]) : null;
}
