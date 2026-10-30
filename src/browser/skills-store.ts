/**
 * Browser-skill persistence: named JS snippets the agent saves after it
 * figures out how to scrape/automate a particular site, so next time it
 * skips straight to `skill.call` instead of re-deriving the approach.
 *
 * Layout:
 *   skills/browser/<slug>.js   — function body; receives `args`, runs in
 *                                 the page (browser) context via page.evaluate
 *   JSDoc header parsed for { description, args }:
 *     /** @description ... *\/
 *     /** @args { selector?: string } *\/
 *
 * No framework, no subdirs. A skill is one file. Overwritten by name.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

export interface SkillEntry {
    name: string;
    description: string;
    argsSignature: string;
    code: string;
    sizeBytes: number;
    updatedAt: string;
}

const SKILL_EXT = ".js";

function resolveSkillsRoot(): string {
    // Anchor on the workspace root (where `skills/` already lives alongside
    // the existing SKILL.md tree). Env override for deployments that keep
    // data outside the source tree.
    const override = process.env.MOLTBOT_BROWSER_SKILLS_DIR?.trim();
    if (override) return path.resolve(override);
    return path.resolve(process.cwd(), "skills", "browser");
}

function slugify(name: string): string {
    return name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
}

function parseHeader(code: string): { description: string; argsSignature: string } {
    const headerMatch = code.match(/^\s*\/\*\*([\s\S]*?)\*\//);
    if (!headerMatch) return { description: "", argsSignature: "" };
    const header = headerMatch[1] ?? "";
    const descMatch = header.match(/@description\s+([^\n@]+)/);
    const argsMatch = header.match(/@args\s+([^\n@]+)/);
    return {
        description: descMatch?.[1]?.trim() ?? "",
        argsSignature: argsMatch?.[1]?.trim() ?? "",
    };
}

function buildHeader(description: string, argsSignature: string): string {
    const desc = description.replace(/\r?\n/g, " ").trim();
    const args = argsSignature.replace(/\r?\n/g, " ").trim();
    return [
        "/**",
        desc ? ` * @description ${desc}` : " * @description",
        args ? ` * @args ${args}` : null,
        " */",
    ]
        .filter((line): line is string => line !== null)
        .join("\n");
}

async function ensureDir(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
}

export async function listSkills(): Promise<SkillEntry[]> {
    const root = resolveSkillsRoot();
    try {
        const files = await fs.readdir(root);
        const out: SkillEntry[] = [];
        for (const file of files) {
            if (!file.endsWith(SKILL_EXT)) continue;
            const full = path.join(root, file);
            const stat = await fs.stat(full);
            if (!stat.isFile()) continue;
            const code = await fs.readFile(full, "utf8");
            const { description, argsSignature } = parseHeader(code);
            out.push({
                name: file.slice(0, -SKILL_EXT.length),
                description,
                argsSignature,
                code,
                sizeBytes: stat.size,
                updatedAt: stat.mtime.toISOString(),
            });
        }
        out.sort((a, b) => a.name.localeCompare(b.name));
        return out;
    } catch (err: any) {
        if (err?.code === "ENOENT") return [];
        throw err;
    }
}

export async function getSkill(name: string): Promise<SkillEntry | null> {
    const slug = slugify(name);
    if (!slug) return null;
    const root = resolveSkillsRoot();
    const full = path.join(root, slug + SKILL_EXT);
    try {
        const [code, stat] = await Promise.all([
            fs.readFile(full, "utf8"),
            fs.stat(full),
        ]);
        const { description, argsSignature } = parseHeader(code);
        return {
            name: slug,
            description,
            argsSignature,
            code,
            sizeBytes: stat.size,
            updatedAt: stat.mtime.toISOString(),
        };
    } catch (err: any) {
        if (err?.code === "ENOENT") return null;
        throw err;
    }
}

export async function saveSkill(params: {
    name: string;
    code: string;
    description?: string;
    argsSignature?: string;
}): Promise<SkillEntry> {
    const slug = slugify(params.name);
    if (!slug) throw new Error("name must contain at least one alphanumeric character");
    const root = resolveSkillsRoot();
    await ensureDir(root);
    const full = path.join(root, slug + SKILL_EXT);

    // Drop any existing header in the provided code so we don't double up.
    const bodyOnly = params.code.replace(/^\s*\/\*\*[\s\S]*?\*\/\s*/, "");
    const header = buildHeader(params.description ?? "", params.argsSignature ?? "");
    const content = `${header}\n${bodyOnly.trim()}\n`;
    await fs.writeFile(full, content, "utf8");
    const stat = await fs.stat(full);
    return {
        name: slug,
        description: params.description ?? "",
        argsSignature: params.argsSignature ?? "",
        code: content,
        sizeBytes: stat.size,
        updatedAt: stat.mtime.toISOString(),
    };
}

export function getSkillBodyForEvaluate(entry: SkillEntry): string {
    // The body is what gets wrapped by `(async (args) => { <body> })(args)`
    // when invoked via page.evaluate. Strip the JSDoc header — it's metadata
    // only and `return` inside a comment is fine, but keeps the evaluated
    // source smaller.
    return entry.code.replace(/^\s*\/\*\*[\s\S]*?\*\/\s*/, "");
}
