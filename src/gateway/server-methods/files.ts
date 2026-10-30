import * as fs from "fs";
import * as path from "path";
import { homedir } from "os";
import { spawn } from "child_process";
import { GatewayRequestHandlers } from "./types.js";
import { enqueueUploadedPath, getOcrService } from "../../ocr/runtime.js";
import { SIDECAR_DIR } from "../../ocr/store.js";

/** Trash, the auto-OCR sidecars and the Daily Review mirror never show in listings. */
function isHiddenEntry(name: string): boolean {
  return name.startsWith(".trash") || name === SIDECAR_DIR || name === ".daily-review";
}

function ocrBadge(absPath: string) {
  try {
    const e = getOcrService().statusForPaths([absPath]).get(absPath);
    return e
      ? {
          id: e.id,
          status: e.status,
          error: e.error,
          confidence: e.confidence ?? null,
          progress: e.progress,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Per-user files root.
 *
 * Older builds used an author-specific Windows path, which broke for other
 * users with an EPERM error on first save. Resolve order:
 *   1. INFINIBOT_FILES_ROOT env var (operator override)
 *   2. INFINIBOT_STATE_DIR + "/files" (matches how every other state
 *      subsystem in the repo resolves its directory)
 *   3. ~/<state-dir-name>/files
 */
const FILES_ROOT = (() => {
  const override = process.env.INFINIBOT_FILES_ROOT?.trim();
  if (override) return override;
  const stateDir = process.env.INFINIBOT_STATE_DIR?.trim() || path.join(homedir(), ".infinibot");
  return path.join(stateDir, "files");
})();
const TRASH_DIR = path.join(FILES_ROOT, ".trash");
const EXTERNAL_ROOTS_FILE = path.join(FILES_ROOT, ".external-roots.json");

// Ensure root exists
try {
  fs.mkdirSync(FILES_ROOT, { recursive: true });
} catch {}

// ── External Roots Management ──────────────────────────

interface ExternalRoot {
  id: string;
  path: string;
  name: string;
  addedAt: number;
}

function loadExternalRoots(): ExternalRoot[] {
  try {
    if (fs.existsSync(EXTERNAL_ROOTS_FILE)) {
      return JSON.parse(fs.readFileSync(EXTERNAL_ROOTS_FILE, "utf-8"));
    }
  } catch {}
  return [];
}

function saveExternalRoots(roots: ExternalRoot[]) {
  fs.writeFileSync(EXTERNAL_ROOTS_FILE, JSON.stringify(roots, null, 2));
}

function isWithinExternalRoot(absPath: string): ExternalRoot | null {
  const roots = loadExternalRoots();
  for (const root of roots) {
    const normalizedRoot = path.normalize(root.path);
    const normalizedPath = path.normalize(absPath);
    if (normalizedPath === normalizedRoot || normalizedPath.startsWith(normalizedRoot + path.sep)) {
      return root;
    }
  }
  return null;
}

function findRootById(id: string): ExternalRoot | null {
  const roots = loadExternalRoots();
  return roots.find((r) => r.id === id) || null;
}

function dropOcr(absPath: string) {
  try {
    getOcrService().remove("normal", { path: absPath });
  } catch {
    /* OCR bookkeeping must not fail the delete */
  }
}

/** Resolve and validate that a path stays within FILES_ROOT or an external root */
function safePath(relativePath?: string, allowExternal = true): string {
  const rel = (relativePath || "").replace(/\\/g, "/");

  // Check if it's an absolute path (external root reference)
  if (allowExternal && (rel.match(/^[A-Za-z]:/) || rel.startsWith("/"))) {
    const absPath = path.normalize(rel);
    // Must be within an external root
    const externalRoot = isWithinExternalRoot(absPath);
    if (externalRoot) {
      return absPath;
    }
    // Check if it IS an external root exactly
    const roots = loadExternalRoots();
    const matchingRoot = roots.find((r) => path.normalize(r.path) === absPath);
    if (matchingRoot) {
      return absPath;
    }
    throw new Error("Path is not within any registered root");
  }

  // Default: resolve relative to FILES_ROOT
  const resolved = path.resolve(FILES_ROOT, rel);
  if (!resolved.startsWith(FILES_ROOT)) {
    throw new Error("Path traversal outside root is not allowed");
  }
  return resolved;
}

/** Convert absolute path to relative - handles both main and external roots */
function toRelativePath(absPath: string): string {
  const normalizedAbs = path.normalize(absPath);

  // Check external roots first
  const externalRoot = isWithinExternalRoot(normalizedAbs);
  if (externalRoot) {
    // For external roots, return the absolute path so UI knows it's external
    return normalizedAbs.replace(/\\/g, "/");
  }

  // Default: relative to FILES_ROOT
  return path.relative(FILES_ROOT, absPath).replace(/\\/g, "/") || ".";
}

/** Get file extension category */
function getFileType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const codeExts = [
    ".ts",
    ".js",
    ".tsx",
    ".jsx",
    ".py",
    ".rs",
    ".go",
    ".c",
    ".cpp",
    ".h",
    ".java",
    ".rb",
    ".php",
    ".css",
    ".scss",
    ".html",
    ".xml",
    ".json",
    ".yaml",
    ".yml",
    ".toml",
    ".md",
    ".sh",
    ".bat",
    ".ps1",
    ".sql",
  ];
  const imageExts = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp"];
  const docExts = [
    ".pdf",
    ".doc",
    ".docx",
    ".txt",
    ".rtf",
    ".odt",
    ".xls",
    ".xlsx",
    ".csv",
    ".pptx",
  ];
  const archiveExts = [".zip", ".tar", ".gz", ".7z", ".rar", ".bz2"];
  const videoExts = [".mp4", ".mkv", ".avi", ".mov", ".webm"];
  const audioExts = [".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac"];

  if (codeExts.includes(ext)) return "code";
  if (imageExts.includes(ext)) return "image";
  if (docExts.includes(ext)) return "document";
  if (archiveExts.includes(ext)) return "archive";
  if (videoExts.includes(ext)) return "video";
  if (audioExts.includes(ext)) return "audio";
  return "file";
}

/** Convert absolute path to relative from FILES_ROOT (legacy - use toRelativePath for external support) */
function toRelative(absPath: string): string {
  return toRelativePath(absPath);
}

/** Get stat info for a file */
function getStatInfo(fullPath: string) {
  const stat = fs.statSync(fullPath);
  return {
    name: path.basename(fullPath),
    path: toRelative(fullPath),
    isDirectory: stat.isDirectory(),
    isFile: stat.isFile(),
    size: stat.size,
    modified: stat.mtimeMs,
    created: stat.birthtimeMs,
    type: stat.isDirectory() ? "folder" : getFileType(fullPath),
    extension: stat.isFile() ? path.extname(fullPath).toLowerCase() : null,
  };
}

/** Build directory tree recursively */
function buildTree(dirPath: string, currentDepth: number, maxDepth: number, filter?: string): any {
  if (currentDepth > maxDepth) return null;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const children: any[] = [];

  for (const entry of entries) {
    if (isHiddenEntry(entry.name)) continue;
    const fullPath = path.join(dirPath, entry.name);

    if (filter && !entry.name.toLowerCase().includes(filter.toLowerCase())) {
      if (!entry.isDirectory()) continue;
    }

    if (entry.isDirectory()) {
      const subtree = buildTree(fullPath, currentDepth + 1, maxDepth, filter);
      children.push({
        name: entry.name,
        path: toRelative(fullPath),
        isDirectory: true,
        type: "folder",
        children: subtree?.children || [],
      });
    } else {
      children.push({
        name: entry.name,
        path: toRelative(fullPath),
        isDirectory: false,
        type: getFileType(fullPath),
        extension: path.extname(entry.name).toLowerCase(),
      });
    }
  }

  // Sort: folders first, then alphabetically
  children.sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    return a.name.localeCompare(b.name);
  });

  return {
    name: path.basename(dirPath),
    path: toRelative(dirPath),
    isDirectory: true,
    type: "folder",
    children,
  };
}

/** Recursively collect all files for search */
function collectFiles(dirPath: string, results: string[], maxResults: number) {
  if (results.length >= maxResults) return;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= maxResults) return;
      if (isHiddenEntry(entry.name)) continue;
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        collectFiles(fullPath, results, maxResults);
      } else {
        results.push(fullPath);
      }
    }
  } catch {}
}

/** Copy directory recursively */
function copyDirSync(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/** Get recently modified files */
function getRecentFiles(dirPath: string, count: number): any[] {
  const allFiles: { path: string; modified: number }[] = [];
  const collected: string[] = [];
  collectFiles(dirPath, collected, 5000);
  for (const f of collected) {
    try {
      const stat = fs.statSync(f);
      allFiles.push({ path: f, modified: stat.mtimeMs });
    } catch {}
  }
  allFiles.sort((a, b) => b.modified - a.modified);
  return allFiles.slice(0, count).map((f) => getStatInfo(f.path));
}

export const filesHandlers: GatewayRequestHandlers = {
  "files.list": async ({ params, respond }) => {
    try {
      const dirPath = safePath(params.path as string | undefined);
      const recursive = params.recursive === true;
      const filter = params.filter as string | undefined;

      if (!fs.existsSync(dirPath)) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Directory not found" });
        return;
      }

      if (recursive) {
        const tree = buildTree(dirPath, 0, 10, filter);
        respond(true, tree);
        return;
      }

      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const items = entries
        .filter((e) => !isHiddenEntry(e.name))
        .filter((e) => !filter || e.name.toLowerCase().includes(filter.toLowerCase()))
        .map((entry) => {
          const fullPath = path.join(dirPath, entry.name);
          try {
            return getStatInfo(fullPath);
          } catch {
            return {
              name: entry.name,
              path: toRelative(fullPath),
              isDirectory: entry.isDirectory(),
              isFile: entry.isFile(),
              size: 0,
              modified: 0,
              created: 0,
              type: entry.isDirectory() ? "folder" : getFileType(fullPath),
              extension: entry.isFile() ? path.extname(entry.name).toLowerCase() : null,
            };
          }
        });

      // Sort: folders first, then alphabetically
      items.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });

      // Auto-OCR status badges (normal lane only).
      for (const item of items as Array<Record<string, unknown>>) {
        if (item.isDirectory) continue;
        const badge = ocrBadge(path.join(dirPath, String(item.name)));
        if (badge) item.ocr = badge;
      }

      respond(true, { path: toRelative(dirPath), items });
    } catch (e: any) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: e.message });
    }
  },

  "files.read": async ({ params, respond }) => {
    try {
      const filePath = safePath(params.path as string);
      if (!fs.existsSync(filePath)) {
        respond(false, undefined, { code: "NOT_FOUND", message: "File not found" });
        return;
      }
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "Cannot read a directory" });
        return;
      }
      // Limit read size to 5MB
      if (stat.size > 5 * 1024 * 1024) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "File too large (>5MB)" });
        return;
      }
      const encoding = (params.encoding as BufferEncoding) || "utf-8";
      const content = fs.readFileSync(filePath, encoding);
      respond(true, {
        path: toRelative(filePath),
        content,
        size: stat.size,
        encoding,
      });
    } catch (e: any) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: e.message });
    }
  },

  "files.write": async ({ params, respond }) => {
    try {
      const filePath = safePath(params.path as string);
      const content = params.content as string;
      const encoding = (params.encoding as BufferEncoding) || "utf-8";

      // Ensure parent directory exists
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, encoding);

      const stat = fs.statSync(filePath);
      respond(true, {
        path: toRelative(filePath),
        size: stat.size,
        modified: stat.mtimeMs,
      });
    } catch (e: any) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: e.message });
    }
  },

  "files.mkdir": async ({ params, respond }) => {
    try {
      const dirPath = safePath(params.path as string);
      const recursive = params.recursive !== false; // default true
      fs.mkdirSync(dirPath, { recursive });
      respond(true, { path: toRelative(dirPath), created: true });
    } catch (e: any) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: e.message });
    }
  },

  "files.delete": async ({ params, respond }) => {
    try {
      const filePath = safePath(params.path as string);
      if (!fs.existsSync(filePath)) {
        respond(false, undefined, { code: "NOT_FOUND", message: "File not found" });
        return;
      }

      const useTrash = params.trash !== false; // default true

      if (useTrash) {
        // Move to .trash/ instead of deleting
        fs.mkdirSync(TRASH_DIR, { recursive: true });
        const trashName = `${Date.now()}_${path.basename(filePath)}`;
        const trashPath = path.join(TRASH_DIR, trashName);
        const wasFile = fs.statSync(filePath).isFile();
        fs.renameSync(filePath, trashPath);
        if (wasFile) dropOcr(filePath);
        respond(true, {
          path: toRelative(filePath),
          trashed: true,
          trashPath: toRelative(trashPath),
        });
      } else {
        const wasFile = fs.statSync(filePath).isFile();
        fs.rmSync(filePath, { recursive: true, force: true });
        if (wasFile) dropOcr(filePath);
        respond(true, { path: toRelative(filePath), deleted: true });
      }
    } catch (e: any) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: e.message });
    }
  },

  "files.rename": async ({ params, respond }) => {
    try {
      const oldPath = safePath(params.oldPath as string);
      const newPath = safePath(params.newPath as string);

      if (!fs.existsSync(oldPath)) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Source not found" });
        return;
      }

      // Ensure parent of destination exists
      fs.mkdirSync(path.dirname(newPath), { recursive: true });
      const wasFile = fs.statSync(oldPath).isFile();
      fs.renameSync(oldPath, newPath);
      if (wasFile) {
        try {
          getOcrService().moved(oldPath, newPath);
        } catch {
          /* OCR bookkeeping must not fail the rename */
        }
      }

      respond(true, {
        oldPath: toRelative(oldPath),
        newPath: toRelative(newPath),
      });
    } catch (e: any) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: e.message });
    }
  },

  "files.copy": async ({ params, respond }) => {
    try {
      const srcPath = safePath(params.src as string);
      const destPath = safePath(params.dest as string);

      if (!fs.existsSync(srcPath)) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Source not found" });
        return;
      }

      const stat = fs.statSync(srcPath);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });

      if (stat.isDirectory()) {
        copyDirSync(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }

      respond(true, {
        src: toRelative(srcPath),
        dest: toRelative(destPath),
      });
    } catch (e: any) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: e.message });
    }
  },

  "files.stat": async ({ params, respond }) => {
    try {
      const filePath = safePath(params.path as string);
      if (!fs.existsSync(filePath)) {
        respond(false, undefined, { code: "NOT_FOUND", message: "File not found" });
        return;
      }
      respond(true, getStatInfo(filePath));
    } catch (e: any) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: e.message });
    }
  },

  "files.search": async ({ params, respond }) => {
    try {
      const query = params.query as string;
      const searchPath = safePath(params.path as string | undefined);
      const useRegex = params.regex === true;
      const searchContent = params.content === true;

      if (!query) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "Query is required" });
        return;
      }

      const allFiles: string[] = [];
      collectFiles(searchPath, allFiles, 10000);
      // Optional result cap (default 100; the Files page "All files" scope asks for more).
      const limit = Math.min(Math.max(Math.floor(Number(params.limit)) || 100, 1), 2000);

      const results: any[] = [];
      const regex = useRegex ? new RegExp(query, "i") : null;
      const queryLower = query.toLowerCase();

      for (const filePath of allFiles) {
        if (results.length >= limit) break;

        const name = path.basename(filePath);
        const nameMatch = regex ? regex.test(name) : name.toLowerCase().includes(queryLower);

        if (nameMatch) {
          results.push({ ...getStatInfo(filePath), matchType: "name" });
          continue;
        }

        if (searchContent) {
          try {
            const stat = fs.statSync(filePath);
            // Only search text files under 1MB
            if (stat.size < 1024 * 1024) {
              const content = fs.readFileSync(filePath, "utf-8");
              const contentMatch = regex
                ? regex.test(content)
                : content.toLowerCase().includes(queryLower);
              if (contentMatch) {
                // Find matching line
                const lines = content.split("\n");
                const matchLine = lines.findIndex((line) =>
                  regex ? regex.test(line) : line.toLowerCase().includes(queryLower),
                );
                results.push({
                  ...getStatInfo(filePath),
                  matchType: "content",
                  matchLine: matchLine >= 0 ? matchLine + 1 : null,
                  matchPreview: matchLine >= 0 ? lines[matchLine].trim().slice(0, 200) : null,
                });
              }
            }
          } catch {}
        }
      }

      respond(true, { query, results, total: results.length });
    } catch (e: any) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: e.message });
    }
  },

  "files.tree": async ({ params, respond }) => {
    try {
      const dirPath = safePath(params.path as string | undefined);
      const depth = Math.min((params.depth as number) || 3, 10);
      const filter = params.filter as string | undefined;

      if (!fs.existsSync(dirPath)) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Directory not found" });
        return;
      }

      const tree = buildTree(dirPath, 0, depth, filter);
      respond(true, tree);
    } catch (e: any) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: e.message });
    }
  },

  "files.upload": async ({ params, respond }) => {
    try {
      const filePath = safePath(params.path as string);
      const base64Content = params.content as string;

      if (!base64Content) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "Content is required" });
        return;
      }

      const clean = base64Content.replace(/^data:[^,]*,/, "").trim();
      if (!clean || clean.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(clean)) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "File content is not valid base64",
        });
        return;
      }
      const estimatedBytes = Math.floor((clean.length * 3) / 4);
      if (estimatedBytes > 30 * 1024 * 1024) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "File is larger than the 30 MB upload limit",
        });
        return;
      }

      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const buffer = Buffer.from(clean, "base64");
      fs.writeFileSync(filePath, buffer);

      const stat = fs.statSync(filePath);
      // Queue local auto-OCR; extraction runs in the background worker.
      const ocr = enqueueUploadedPath(filePath, {
        kind: "files",
        projectId: typeof params.projectId === "string" ? params.projectId : undefined,
        sessionKey: typeof params.sessionKey === "string" ? params.sessionKey : undefined,
      });
      respond(true, {
        path: toRelative(filePath),
        size: stat.size,
        modified: stat.mtimeMs,
        ...(ocr ? { ocr: { id: ocr.id, status: ocr.status } } : {}),
      });
    } catch (e: any) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: e.message });
    }
  },

  /**
   * files.thumb { path, size? } → { mime: "image/webp", content } — a small
   * in-memory preview for the Files grid (nothing is cached on disk).
   */
  "files.thumb": async ({ params, respond }) => {
    try {
      const filePath = safePath(params.path as string);
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        respond(false, undefined, { code: "NOT_FOUND", message: "File not found" });
        return;
      }
      if (fs.statSync(filePath).size > 60 * 1024 * 1024) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "File too large" });
        return;
      }
      const size = Math.min(Math.max(Math.floor(Number(params.size)) || 360, 64), 1024);
      const sharp = (await import("sharp")).default;
      const out = await sharp(filePath, { failOn: "none" })
        .rotate()
        .resize(size, size, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 78 })
        .toBuffer();
      respond(true, { mime: "image/webp", content: out.toString("base64"), size: out.length });
    } catch (e: any) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: e.message });
    }
  },

  "files.download": async ({ params, respond }) => {
    try {
      const filePath = safePath(params.path as string);
      if (!fs.existsSync(filePath)) {
        respond(false, undefined, { code: "NOT_FOUND", message: "File not found" });
        return;
      }
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "Cannot download a directory",
        });
        return;
      }
      if (stat.size > 50 * 1024 * 1024) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "File too large (>50MB)" });
        return;
      }
      const buffer = fs.readFileSync(filePath);
      const base64 = buffer.toString("base64");
      respond(true, {
        path: toRelative(filePath),
        content: base64,
        size: stat.size,
        name: path.basename(filePath),
        type: getFileType(filePath),
      });
    } catch (e: any) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: e.message });
    }
  },

  "files.watch": async ({ params, respond }) => {
    // Simple implementation — returns current state, UI can poll
    try {
      const dirPath = safePath(params.path as string | undefined);
      if (!fs.existsSync(dirPath)) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Directory not found" });
        return;
      }
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const items = entries
        .filter((e) => !isHiddenEntry(e.name))
        .map((entry) => {
          const fullPath = path.join(dirPath, entry.name);
          try {
            return getStatInfo(fullPath);
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      respond(true, { path: toRelative(dirPath), items, timestamp: Date.now() });
    } catch (e: any) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: e.message });
    }
  },

  "files.recent": async ({ params, respond }) => {
    try {
      const count = Math.min((params.count as number) || 20, 100);
      const searchPath = safePath(params.path as string | undefined);
      const recent = getRecentFiles(searchPath, count);
      respond(true, { files: recent, count: recent.length });
    } catch (e: any) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: e.message });
    }
  },

  "files.disk": async ({ params, respond }) => {
    try {
      // Calculate directory size
      const searchPath = safePath(params.path as string | undefined);
      let totalSize = 0;
      let fileCount = 0;
      let dirCount = 0;

      const walk = (dir: string) => {
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              dirCount++;
              walk(fullPath);
            } else {
              try {
                const stat = fs.statSync(fullPath);
                totalSize += stat.size;
                fileCount++;
              } catch {}
            }
          }
        } catch {}
      };

      walk(searchPath);

      respond(true, {
        path: toRelative(searchPath),
        totalSize,
        fileCount,
        dirCount,
        humanSize: formatSize(totalSize),
      });
    } catch (e: any) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: e.message });
    }
  },

  // ── External Roots Management ──────────────────────────

  "files.roots.list": async ({ respond }) => {
    try {
      const roots = loadExternalRoots();
      respond(true, {
        roots,
        mainRoot: { id: "main", path: FILES_ROOT, name: "infinibot" },
      });
    } catch (e: any) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: e.message });
    }
  },

  "files.roots.add": async ({ params, respond }) => {
    try {
      const folderPath = params.path as string;
      const name = (params.name as string) || path.basename(folderPath);

      if (!folderPath) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "Path is required" });
        return;
      }

      const normalizedPath = path.normalize(folderPath);

      // Verify the path exists and is a directory
      if (!fs.existsSync(normalizedPath)) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Directory not found" });
        return;
      }

      const stat = fs.statSync(normalizedPath);
      if (!stat.isDirectory()) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "Path is not a directory" });
        return;
      }

      const roots = loadExternalRoots();

      // Check for duplicates
      if (roots.some((r) => path.normalize(r.path) === normalizedPath)) {
        respond(false, undefined, {
          code: "ALREADY_EXISTS",
          message: "This folder is already added",
        });
        return;
      }

      const newRoot: ExternalRoot = {
        id: `ext_${Date.now()}`,
        path: normalizedPath,
        name,
        addedAt: Date.now(),
      };

      roots.push(newRoot);
      saveExternalRoots(roots);

      respond(true, { root: newRoot, roots });
    } catch (e: any) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: e.message });
    }
  },

  "files.roots.remove": async ({ params, respond }) => {
    try {
      const rootId = params.id as string;

      if (!rootId) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "Root ID is required" });
        return;
      }

      if (rootId === "main") {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "Cannot remove main root" });
        return;
      }

      const roots = loadExternalRoots();
      const newRoots = roots.filter((r) => r.id !== rootId);

      if (newRoots.length === roots.length) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Root not found" });
        return;
      }

      saveExternalRoots(newRoots);
      respond(true, { removed: rootId, roots: newRoots });
    } catch (e: any) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: e.message });
    }
  },

  "files.roots.rename": async ({ params, respond }) => {
    try {
      const rootId = params.id as string;
      const newName = params.name as string;

      if (!rootId || !newName) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "Root ID and name are required",
        });
        return;
      }

      const roots = loadExternalRoots();
      const root = roots.find((r) => r.id === rootId);

      if (!root) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Root not found" });
        return;
      }

      root.name = newName;
      saveExternalRoots(roots);
      respond(true, { root, roots });
    } catch (e: any) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: e.message });
    }
  },

  "files.selectFolder": async ({ params, respond }) => {
    try {
      const title = (params.title as string) || "Select Folder";
      const initialDir = (params.initialDir as string) || "";

      // Create a temporary PowerShell script file
      const tempScript = path.join(FILES_ROOT, ".folder-picker.ps1");
      const scriptContent = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "${title.replace(/"/g, '""')}"
$dialog.RootFolder = [System.Environment+SpecialFolder]::Desktop
$dialog.ShowNewFolderButton = $true
${initialDir ? `$dialog.SelectedPath = "${initialDir.replace(/\\/g, "\\\\").replace(/"/g, '""')}"` : ""}
$form = New-Object System.Windows.Forms.Form
$form.TopMost = $true
$result = $dialog.ShowDialog($form)
$form.Dispose()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    Write-Output $dialog.SelectedPath
} else {
    Write-Output "::CANCELLED::"
}
`;
      fs.writeFileSync(tempScript, scriptContent, "utf-8");

      const ps = spawn(
        "powershell.exe",
        ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", tempScript],
        {
          windowsHide: false,
          detached: false,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      let stdout = "";
      let stderr = "";

      ps.stdout.on("data", (data) => {
        stdout += data.toString();
      });
      ps.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      ps.on("close", (code) => {
        // Clean up temp script
        try {
          fs.unlinkSync(tempScript);
        } catch {}

        const selectedPath = stdout.trim();

        if (selectedPath === "::CANCELLED::" || !selectedPath) {
          respond(true, { cancelled: true, path: null });
          return;
        }

        // Check if path exists
        if (fs.existsSync(selectedPath)) {
          respond(true, { cancelled: false, path: selectedPath });
        } else {
          respond(false, undefined, {
            code: "INVALID_PATH",
            message: "Selected path does not exist",
          });
        }
      });

      ps.on("error", (err) => {
        try {
          fs.unlinkSync(tempScript);
        } catch {}
        respond(false, undefined, { code: "SPAWN_ERROR", message: err.message });
      });
    } catch (e: any) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: e.message });
    }
  },

  "files.tree.all": async ({ params, respond }) => {
    try {
      const depth = Math.min((params.depth as number) || 3, 10);
      const roots = loadExternalRoots();

      // Build main root tree
      const mainTree = buildTree(FILES_ROOT, 0, depth, undefined);

      // Build external root trees
      const externalTrees = roots.map((root) => {
        try {
          const tree = buildTree(root.path, 0, depth, undefined);
          return {
            ...tree,
            id: root.id,
            name: root.name,
            path: root.path.replace(/\\/g, "/"),
            isExternalRoot: true,
          };
        } catch {
          return {
            id: root.id,
            name: root.name,
            path: root.path.replace(/\\/g, "/"),
            isDirectory: true,
            isExternalRoot: true,
            type: "folder",
            children: [],
            error: "Unable to read directory",
          };
        }
      });

      respond(true, {
        mainRoot: { ...mainTree, id: "main", isExternalRoot: false },
        externalRoots: externalTrees,
      });
    } catch (e: any) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: e.message });
    }
  },
};

function formatSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}
