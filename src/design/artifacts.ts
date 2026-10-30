/**
 * Design page — artifact indexer.
 *
 * After each agent turn we scan the project workspace for files and
 * upsert them into the artifacts table. Cheap because workspaces are
 * small and we don't expect more than a few hundred files. No FS watcher
 * — re-scan on demand from the gateway RPC + at the end of each agent turn.
 *
 * The "preview" artifact (the one shown in the iframe pane) is
 * auto-promoted in this order:
 *   1. index.html at the workspace root.
 *   2. The most recently updated .html file anywhere in the workspace.
 *   3. The most recently updated .pdf / image file as a fallback.
 */

import { existsSync, readdirSync, statSync } from "fs";
import { join, extname, relative } from "path";
import { randomUUID } from "crypto";

import type { DesignArtifact, ArtifactKind } from "./types.js";
import { getDesignStore } from "./store.js";

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".cache",
  "dist",
  "build",
  ".next",
  ".turbo",
  "out",
  "tmp",
]);
const MAX_FILES = 500;

export function rescanArtifacts(
  stateDir: string,
  projectId: string,
  workspaceDir: string,
): DesignArtifact[] {
  const store = getDesignStore(stateDir);
  const existing = store.listArtifacts(projectId);
  const existingByPath = new Map(existing.map((a) => [a.relativePath, a]));

  const found: Array<{ relativePath: string; absPath: string; stat: import("fs").Stats }> = [];
  walk(workspaceDir, workspaceDir, found, 0);

  const seenPaths = new Set<string>();
  let bestPreview: { artifactId: string; score: number; mtime: number } | null = null;

  for (const f of found) {
    seenPaths.add(f.relativePath);
    const name = f.relativePath.split(/[\\/]/).pop()!;
    const ext = extname(name).slice(1).toLowerCase();
    const kind = pickKind(ext);
    const mime = pickMime(ext);
    const existingRow = existingByPath.get(f.relativePath);
    const artifact: DesignArtifact = {
      id: existingRow?.id ?? randomUUID(),
      projectId,
      relativePath: f.relativePath,
      name,
      kind,
      size: f.stat.size,
      mime,
      isPreview: false,
      createdAt: existingRow?.createdAt ?? f.stat.birthtimeMs ?? f.stat.mtimeMs,
      updatedAt: f.stat.mtimeMs,
    };
    store.upsertArtifact(artifact);
    // Score for preview promotion.
    const score = previewScore(f.relativePath, ext);
    if (
      score > 0 &&
      (!bestPreview ||
        score > bestPreview.score ||
        (score === bestPreview.score && f.stat.mtimeMs > bestPreview.mtime))
    ) {
      bestPreview = { artifactId: artifact.id, score, mtime: f.stat.mtimeMs };
    }
  }

  // Drop rows whose files vanished.
  for (const e of existing) {
    if (!seenPaths.has(e.relativePath)) {
      store.dropArtifactByPath(projectId, e.relativePath);
    }
  }

  if (bestPreview) {
    store.setPreviewArtifact(projectId, bestPreview.artifactId);
  }

  return store.listArtifacts(projectId);
}

function walk(
  rootDir: string,
  dir: string,
  out: Array<{ relativePath: string; absPath: string; stat: import("fs").Stats }>,
  depth: number,
): void {
  if (out.length >= MAX_FILES) return;
  if (depth > 6) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith(".") && entry !== ".env.example") continue;
    if (IGNORE_DIRS.has(entry)) continue;
    const abs = join(dir, entry);
    let s: import("fs").Stats;
    try {
      s = statSync(abs);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      walk(rootDir, abs, out, depth + 1);
    } else if (s.isFile()) {
      const rel = relative(rootDir, abs).split(/[\\/]/).join("/");
      out.push({ relativePath: rel, absPath: abs, stat: s });
      if (out.length >= MAX_FILES) return;
    }
  }
}

function pickKind(ext: string): ArtifactKind {
  switch (ext) {
    case "html":
    case "htm":
      return "html";
    case "css":
      return "css";
    case "js":
    case "mjs":
    case "cjs":
      return "js";
    case "json":
      return "json";
    case "md":
      return "md";
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
    case "svg":
      return "image";
    case "pdf":
      return "pdf";
    case "zip":
      return "zip";
    case "pptx":
      return "pptx";
    default:
      return "other";
  }
}

function pickMime(ext: string): string {
  switch (ext) {
    case "html":
    case "htm":
      return "text/html";
    case "css":
      return "text/css";
    case "js":
    case "mjs":
    case "cjs":
      return "text/javascript";
    case "json":
      return "application/json";
    case "md":
      return "text/markdown";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "pdf":
      return "application/pdf";
    case "zip":
      return "application/zip";
    case "pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    default:
      return "application/octet-stream";
  }
}

function previewScore(relPath: string, ext: string): number {
  const lower = relPath.toLowerCase();
  if (lower === "index.html") return 100;
  if (lower === "index.htm") return 90;
  if (ext === "html" || ext === "htm") return 70;
  if (ext === "pdf") return 40;
  if (["png", "jpg", "jpeg", "webp", "svg"].includes(ext)) return 30;
  return 0;
}

/** Used by the gateway HTTP handler to safely resolve an absolute path from a relativePath. */
export function resolveArtifactPath(workspaceDir: string, relativePath: string): string | null {
  if (!workspaceDir || !relativePath) return null;
  // Strict: no .. traversal, no absolute paths.
  if (relativePath.startsWith("/") || relativePath.includes("..")) return null;
  const abs = join(workspaceDir, relativePath);
  if (!abs.startsWith(workspaceDir)) return null;
  if (!existsSync(abs)) return null;
  return abs;
}
