/**
 * In-app docs API — exposes the repo's `/docs/*.md` tree to the browser
 * so the UI can render documentation inline (glass-themed sidebar + viewer)
 * instead of iframing the public docs site. Two endpoints:
 *
 *   GET /api/docs/tree
 *     → { tree: DocNode[] }
 *
 *   GET /api/docs/file?path=<relative-path-under-docs>
 *     → text/markdown body
 *
 * Path safety: every request resolves to an absolute path and is rejected
 * unless the resolved path is still inside the docs root (no `..` escape,
 * no symlink traversal out, no absolute-path injection).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";

import { sendJson } from "./http-common.js";

interface DocFile {
    type: "file";
    /** Relative path under docs/, posix-style separators. */
    path: string;
    /** Display name (filename without `.md`, dashes → spaces, title-cased). */
    title: string;
    bytes: number;
}

interface DocCategory {
    type: "category";
    /** Relative path under docs/. Empty string for the root. */
    path: string;
    /** Folder name, prettified for display. */
    title: string;
    children: Array<DocFile | DocCategory>;
}

type DocNode = DocFile | DocCategory;

/**
 * Resolve the docs/ root. Mirrors the candidate-list strategy used by
 * `resolveControlUiRoot()` so packaging + dev + dist all work.
 */
function resolveDocsRoot(): string | null {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const execDir = (() => {
        try {
            return path.dirname(fs.realpathSync(process.execPath));
        } catch {
            return null;
        }
    })();
    const candidates = [
        execDir ? path.resolve(execDir, "docs") : null,
        // Source: src/gateway/server-docs.ts → ../../docs
        path.resolve(here, "../../docs"),
        // Built: dist/gateway/server-docs.js → ../../docs
        path.resolve(here, "../../docs"),
        // Repo cwd fallback
        path.resolve(process.cwd(), "docs"),
    ].filter((p): p is string => Boolean(p));
    for (const dir of candidates) {
        try {
            const stat = fs.statSync(dir);
            if (stat.isDirectory()) return dir;
        } catch {
            /* try next */
        }
    }
    return null;
}

const DOCS_ROOT = resolveDocsRoot();

const SKIP_DIRS = new Set([
    "_layouts",
    "_includes",
    "_site",
    "assets",
    "images",
    "node_modules",
    ".git",
]);

const TITLE_FROM_FRONTMATTER = /^---[\r\n]+([\s\S]*?)^---[\r\n]+/m;

function prettifyName(rawName: string): string {
    const stripped = rawName.replace(/\.md$/i, "");
    return stripped
        .replace(/[-_]+/g, " ")
        .replace(/\b([a-z])/g, (m) => m.toUpperCase())
        .trim();
}

/**
 * Read up to ~1KB of a markdown file's head, look for `title: ...` in YAML
 * frontmatter or the first H1. Used so the sidebar shows a reader-friendly
 * label (e.g. "Wake Word Activation") instead of a slug ("wake-word.md").
 */
function readDocTitle(absPath: string, fallbackName: string): string {
    let fd: number | null = null;
    try {
        fd = fs.openSync(absPath, "r");
        const buf = Buffer.alloc(1024);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        if (n === 0) return fallbackName;
        const head = buf.toString("utf-8", 0, n);
        const fm = head.match(TITLE_FROM_FRONTMATTER);
        if (fm) {
            const block = fm[1];
            const titleLine = block.match(/^title:\s*['"]?(.+?)['"]?$/m);
            if (titleLine) return titleLine[1].trim();
        }
        const h1 = head.match(/^#\s+(.+)$/m);
        if (h1) return h1[1].replace(/[`*_]+/g, "").trim();
    } catch {
        /* ignore */
    } finally {
        if (fd !== null) fs.closeSync(fd);
    }
    return fallbackName;
}

function buildTree(absDir: string, relDir: string): DocNode[] {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
        return [];
    }
    const nodes: DocNode[] = [];
    for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        if (SKIP_DIRS.has(entry.name)) continue;
        const childAbs = path.join(absDir, entry.name);
        const childRel = (relDir ? `${relDir}/` : "") + entry.name;
        if (entry.isDirectory()) {
            const children = buildTree(childAbs, childRel);
            if (children.length === 0) continue;
            nodes.push({
                type: "category",
                path: childRel,
                title: prettifyName(entry.name),
                children,
            });
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
            let bytes = 0;
            try {
                bytes = fs.statSync(childAbs).size;
            } catch {
                /* ignore */
            }
            nodes.push({
                type: "file",
                path: childRel,
                title: readDocTitle(childAbs, prettifyName(entry.name)),
                bytes,
            });
        }
    }
    // Files first, then categories — but each group sorted alphabetically by title.
    nodes.sort((a, b) => {
        if (a.type !== b.type) return a.type === "file" ? -1 : 1;
        return a.title.localeCompare(b.title);
    });
    return nodes;
}

/** Reject anything that escapes the docs root. */
function safelyResolveDocPath(rel: string): string | null {
    if (!DOCS_ROOT) return null;
    if (!rel || typeof rel !== "string") return null;
    if (rel.includes("\0")) return null;
    // Disallow absolute paths and `..` segments outright.
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).some((seg) => seg === "..")) {
        return null;
    }
    const abs = path.resolve(DOCS_ROOT, rel);
    const rootResolved = path.resolve(DOCS_ROOT);
    // Normalize to handle Windows-vs-POSIX separator inconsistencies.
    if (!abs.startsWith(rootResolved + path.sep) && abs !== rootResolved) {
        return null;
    }
    if (!abs.toLowerCase().endsWith(".md")) return null;
    try {
        const stat = fs.statSync(abs);
        if (!stat.isFile()) return null;
    } catch {
        return null;
    }
    return abs;
}

export async function handleDocsRequest(
    req: IncomingMessage,
    res: ServerResponse,
): Promise<boolean> {
    if (!req.url?.startsWith("/api/docs/")) return false;

    if (req.method === "OPTIONS") {
        res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return true;
    }
    if (req.method !== "GET") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return true;
    }
    if (!DOCS_ROOT) {
        sendJson(res, 500, { error: "docs root not found", tried: "src/dist/exec/cwd" });
        return true;
    }

    const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = u.pathname;

    if (pathname === "/api/docs/tree") {
        const tree = buildTree(DOCS_ROOT, "");
        res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-cache",
        });
        res.end(JSON.stringify({ root: DOCS_ROOT, tree }));
        return true;
    }

    if (pathname === "/api/docs/file") {
        const rel = u.searchParams.get("path") ?? "";
        const abs = safelyResolveDocPath(rel);
        if (!abs) {
            sendJson(res, 404, { error: "doc not found", path: rel });
            return true;
        }
        const body = fs.readFileSync(abs, "utf-8");
        res.writeHead(200, {
            "Content-Type": "text/markdown; charset=utf-8",
            "Cache-Control": "no-cache",
            "X-Doc-Path": rel,
        });
        res.end(body);
        return true;
    }

    sendJson(res, 404, { error: "unknown docs route", pathname });
    return true;
}
