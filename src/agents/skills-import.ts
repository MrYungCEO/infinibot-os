/**
 * Skill import — turn an uploaded SKILL.md or zip (InfiniBot or Claude-style)
 * into managed skills under `<managedDir>/<slug>/`.
 *
 * Everything user-facing here throws `SkillImportError` with a plain-English
 * message; callers never need to show a stack trace.
 */

import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import YAML from "yaml";

export class SkillImportError extends Error {}

export const SKILL_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
export const SKILL_UNPACKED_MAX_BYTES = 60 * 1024 * 1024;
export const SKILL_MAX_FILES = 500;
const SKILL_FILE_MAX_BYTES = 20 * 1024 * 1024;
const SKILL_MD_MAX_BYTES = 512 * 1024;

export type SkillImportConflictMode = "ask" | "replace" | "keep-both";

export type SkillImportInput = {
  /** Original file name, e.g. "my-skill.zip" or "SKILL.md". */
  fileName: string;
  data: Buffer;
  onConflict?: SkillImportConflictMode;
  managedDir: string;
};

export type ImportedSkill = {
  slug: string;
  name: string;
  description: string;
  filePath: string;
  files: number;
  replaced: boolean;
  renamedFrom?: string;
};

export type SkillImportResult =
  | { status: "imported"; skills: ImportedSkill[]; warnings: string[] }
  | {
      status: "conflict";
      conflicts: Array<{ slug: string; name: string }>;
      message: string;
    };

type StagedFile = { rel: string; data: Buffer; executable: boolean };
type StagedSkill = {
  slug: string;
  name: string;
  description: string;
  skillMd: string;
  files: StagedFile[];
};

export function slugifySkillName(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function splitFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } | null {
  const text = raw.replace(/^﻿/, "");
  const m = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/);
  if (!m) return null;
  let parsed: unknown;
  try {
    parsed = YAML.parse(m[1]);
  } catch {
    throw new SkillImportError(
      "The header at the top of SKILL.md isn't valid. Check the lines between the two --- markers (a missing space after a colon is the usual cause).",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SkillImportError(
      "The header at the top of SKILL.md is empty. It needs at least a name and a description.",
    );
  }
  return { meta: parsed as Record<string, unknown>, body: m[2] ?? "" };
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function stageSkill(skillMdRaw: string, files: StagedFile[], fallbackName?: string): StagedSkill {
  const split = splitFrontmatter(skillMdRaw);
  if (!split) {
    throw new SkillImportError(
      "SKILL.md needs a header at the very top, like:\n---\nname: my-skill\ndescription: What this skill does and when to use it\n---\nThen the instructions below it.",
    );
  }
  const rawName = typeof split.meta.name === "string" ? split.meta.name.trim() : "";
  const description =
    typeof split.meta.description === "string" ? split.meta.description.trim() : "";
  const name = rawName || fallbackName || "";
  if (!name) {
    throw new SkillImportError("SKILL.md is missing a name in its header.");
  }
  if (!description) {
    throw new SkillImportError(
      "SKILL.md is missing a description in its header. The description tells the agent when to use the skill.",
    );
  }
  const slug = slugifySkillName(name);
  if (!slug) {
    throw new SkillImportError(
      `The skill name "${name}" has no letters or numbers, so it can't be used as a name.`,
    );
  }
  if (!split.body.trim()) {
    throw new SkillImportError("SKILL.md has a header but no instructions below it.");
  }
  // The loader keys skills by directory name and requires name === dir name.
  const meta = { ...split.meta, name: slug };
  const skillMd = `---\n${YAML.stringify(meta, { lineWidth: 0 }).trimEnd()}\n---\n${split.body.replace(/^\r?\n/, "")}`;
  return { slug, name, description, skillMd, files };
}

/** Normalise a zip entry path; null = unsafe (traversal / absolute / drive). */
function safeRel(entryName: string): string | null {
  const unified = entryName.replace(/\\/g, "/");
  if (unified.startsWith("/") || /^[a-zA-Z]:/.test(unified) || unified.includes("\0")) return null;
  const parts = unified.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..")) return null;
  return parts.join("/");
}

async function readZip(
  buf: Buffer,
): Promise<{ files: Map<string, StagedFile>; skipped: string[] }> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    throw new SkillImportError(
      "That file looks like a zip but can't be opened. It may be damaged or only partly downloaded.",
    );
  }
  const files = new Map<string, StagedFile>();
  const skipped: string[] = [];
  let total = 0;
  const entries = Object.values(zip.files).filter((e) => !e.dir);
  if (entries.length > SKILL_MAX_FILES) {
    throw new SkillImportError(
      `That zip has ${entries.length} files; the limit is ${SKILL_MAX_FILES}. Remove build output or dependencies (like node_modules) and try again.`,
    );
  }
  for (const entry of entries) {
    // JSZip silently strips "../" from entry.name; check the raw name instead.
    const rawName =
      (entry as unknown as { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name;
    const rel = safeRel(rawName);
    if (rel === null) {
      throw new SkillImportError(
        `The zip contains an unsafe path ("${rawName.slice(0, 80)}") that would write outside the skill folder. It was not imported.`,
      );
    }
    if (!rel) continue;
    // Ignore OS / VCS junk quietly.
    if (
      /(^|\/)(__MACOSX|\.git|\.DS_Store|node_modules)(\/|$)/.test(rel) ||
      rel.endsWith("Thumbs.db")
    ) {
      continue;
    }
    const perm = (entry as unknown as { unixPermissions?: number | string | null }).unixPermissions;
    const mode = typeof perm === "number" ? perm : typeof perm === "string" ? parseInt(perm, 8) : 0;
    if ((mode & 0o170000) === 0o120000) {
      skipped.push(rel);
      continue; // symlink: never materialise
    }
    const declared = (entry as unknown as { _data?: { uncompressedSize?: number } })._data
      ?.uncompressedSize;
    if (typeof declared === "number" && declared > SKILL_FILE_MAX_BYTES) {
      throw new SkillImportError(
        `"${rel}" is larger than ${Math.round(SKILL_FILE_MAX_BYTES / 1024 / 1024)} MB, which is too big for a skill file.`,
      );
    }
    if (typeof declared === "number" && total + declared > SKILL_UNPACKED_MAX_BYTES) {
      throw new SkillImportError(
        `That zip expands to more than ${Math.round(SKILL_UNPACKED_MAX_BYTES / 1024 / 1024)} MB, which is over the limit for a skill.`,
      );
    }
    const data = Buffer.from(await entry.async("uint8array"));
    total += data.length;
    if (total > SKILL_UNPACKED_MAX_BYTES || data.length > SKILL_FILE_MAX_BYTES) {
      throw new SkillImportError(
        `That zip expands to more than ${Math.round(SKILL_UNPACKED_MAX_BYTES / 1024 / 1024)} MB, which is over the limit for a skill.`,
      );
    }
    files.set(rel, { rel, data, executable: (mode & 0o111) !== 0 });
  }
  return { files, skipped };
}

function groupSkillsFromZip(files: Map<string, StagedFile>): StagedSkill[] {
  const roots: string[] = []; // directories ("" = zip root) that hold a SKILL.md
  for (const rel of files.keys()) {
    const base = path.posix.basename(rel);
    if (base.toLowerCase() === "skill.md")
      roots.push(path.posix.dirname(rel) === "." ? "" : path.posix.dirname(rel));
  }
  if (roots.length === 0) {
    throw new SkillImportError(
      "No SKILL.md was found in that zip. A skill needs a SKILL.md file (either at the top of the zip or inside a single folder).",
    );
  }
  // Keep only outermost roots (a SKILL.md nested inside another skill is an asset).
  const outer = roots
    .filter((r) => !roots.some((o) => o !== r && (o === "" || r.startsWith(`${o}/`))))
    .sort();
  const out: StagedSkill[] = [];
  for (const root of outer) {
    const prefix = root ? `${root}/` : "";
    const skillFile = [...files.keys()].find(
      (k) => k.startsWith(prefix) && k.slice(prefix.length).toLowerCase() === "skill.md",
    )!;
    const mdBuf = files.get(skillFile)!.data;
    if (mdBuf.length > SKILL_MD_MAX_BYTES) {
      throw new SkillImportError(
        "SKILL.md is unusually large (over 512 KB). Is it the right file?",
      );
    }
    const staged: StagedFile[] = [];
    for (const [rel, f] of files) {
      if (!rel.startsWith(prefix) || rel === skillFile) continue;
      staged.push({ ...f, rel: rel.slice(prefix.length) });
    }
    const fallback = root ? path.posix.basename(root) : undefined;
    out.push(stageSkill(mdBuf.toString("utf-8"), staged, fallback));
  }
  const seen = new Set<string>();
  for (const s of out) {
    if (seen.has(s.slug)) {
      throw new SkillImportError(
        `The zip contains two skills that both end up named "${s.slug}". Rename one and try again.`,
      );
    }
    seen.add(s.slug);
  }
  return out;
}

function isZip(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 3 || buf[2] === 5);
}

function uniqueSlug(managedDir: string, slug: string): string {
  for (let i = 2; i < 1000; i++) {
    const candidate = `${slug.slice(0, 58)}-${i}`;
    if (!fs.existsSync(path.join(managedDir, candidate))) return candidate;
  }
  throw new SkillImportError("Too many copies of this skill already exist.");
}

function writeSkill(managedDir: string, skill: StagedSkill, replaceExisting: boolean): number {
  const finalDir = path.join(managedDir, skill.slug);
  const tmpDir = path.join(managedDir, `.import-${skill.slug}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    fs.writeFileSync(path.join(tmpDir, "SKILL.md"), skill.skillMd, "utf-8");
    for (const f of skill.files) {
      const dest = path.resolve(tmpDir, f.rel);
      if (!dest.startsWith(tmpDir + path.sep)) {
        throw new SkillImportError("Unsafe file path in the skill; import stopped.");
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, f.data, { mode: f.executable ? 0o755 : 0o644 });
    }
    if (replaceExisting && fs.existsSync(finalDir)) {
      const backup = `${tmpDir}.old`;
      fs.renameSync(finalDir, backup);
      try {
        fs.renameSync(tmpDir, finalDir);
      } catch (err) {
        fs.renameSync(backup, finalDir);
        throw err;
      }
      fs.rmSync(backup, { recursive: true, force: true });
    } else {
      fs.renameSync(tmpDir, finalDir);
    }
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }
  return skill.files.length + 1;
}

export async function importSkillUpload(input: SkillImportInput): Promise<SkillImportResult> {
  const { data, managedDir } = input;
  const mode = input.onConflict ?? "ask";
  const warnings: string[] = [];
  if (!data.length) throw new SkillImportError("That file is empty.");
  if (data.length > SKILL_UPLOAD_MAX_BYTES) {
    throw new SkillImportError(
      `That file is ${(data.length / 1024 / 1024).toFixed(1)} MB; the upload limit is ${Math.round(SKILL_UPLOAD_MAX_BYTES / 1024 / 1024)} MB.`,
    );
  }

  let staged: StagedSkill[];
  if (isZip(data)) {
    const { files, skipped } = await readZip(data);
    if (skipped.length) warnings.push(`Skipped ${skipped.length} shortcut file(s) for safety.`);
    staged = groupSkillsFromZip(files);
  } else {
    const lower = input.fileName.toLowerCase();
    if (looksBinary(data)) {
      throw new SkillImportError(
        "That file isn't text or a zip. Upload a SKILL.md file or a .zip containing one.",
      );
    }
    if (data.length > SKILL_MD_MAX_BYTES) {
      throw new SkillImportError(
        "SKILL.md is unusually large (over 512 KB). Is it the right file?",
      );
    }
    const text = data.toString("utf-8");
    if (/^\s*[{[]/.test(text) && !text.trimStart().startsWith("---")) {
      throw new SkillImportError(
        "That looks like a JSON file, not a skill. Skills are SKILL.md files or zips; workflow JSON goes on the Workflows page.",
      );
    }
    const stem = path.basename(lower).replace(/\.(md|markdown|txt)$/, "");
    const fallback = stem && stem !== "skill" ? stem : undefined;
    staged = [stageSkill(text, [], fallback)];
  }

  fs.mkdirSync(managedDir, { recursive: true });
  const conflicts = staged.filter((s) => fs.existsSync(path.join(managedDir, s.slug)));
  if (conflicts.length && mode === "ask") {
    return {
      status: "conflict",
      conflicts: conflicts.map((c) => ({ slug: c.slug, name: c.name })),
      message: `You already have ${conflicts.length === 1 ? `a skill named "${conflicts[0].slug}"` : `${conflicts.length} skills with these names`}. Replace ${conflicts.length === 1 ? "it" : "them"} or keep both?`,
    };
  }

  const imported: ImportedSkill[] = [];
  for (const skill of staged) {
    const exists = fs.existsSync(path.join(managedDir, skill.slug));
    let target = skill;
    let renamedFrom: string | undefined;
    let replaced = false;
    if (exists && mode === "keep-both") {
      const slug = uniqueSlug(managedDir, skill.slug);
      const split = splitFrontmatter(skill.skillMd)!;
      target = {
        ...skill,
        slug,
        skillMd: `---\n${YAML.stringify({ ...split.meta, name: slug }, { lineWidth: 0 }).trimEnd()}\n---\n${split.body}`,
      };
      renamedFrom = skill.slug;
    } else if (exists) {
      replaced = true;
    }
    const count = writeSkill(managedDir, target, replaced);
    imported.push({
      slug: target.slug,
      name: target.name,
      description: target.description,
      filePath: path.join(managedDir, target.slug, "SKILL.md"),
      files: count,
      replaced,
      renamedFrom,
    });
  }
  return { status: "imported", skills: imported, warnings };
}
