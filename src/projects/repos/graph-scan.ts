/**
 * Project repos — repository scan for the Knowledge Graph "Repos" mode.
 *
 * Walks a repo checkout (skipping node_modules/.git/dist/build caches and
 * anything secure-lane), then builds a capped, lazily expandable tree:
 *
 *   dir/file nodes  — language + kind for colouring, size, recent-commit heat
 *   contains edges  — parent dir → child
 *   import edges    — TS/JS relative imports + Python module imports, when
 *                     both ends are visible (or rolled up to the nearest
 *                     visible collapsed directory)
 *
 * Directories are expanded breadth-first until the node budget is spent;
 * the rest stay collapsed as aggregate nodes the UI can expand on demand
 * (`expand: ["src/gateway", ...]`). Results are cached per
 * (root, HEAD, options) and invalidated by a light watcher on the visible
 * directories plus .git/HEAD and .git/index.
 */

import fs from "node:fs";
import path from "node:path";
import { secureScratchDir } from "../../ocr/store.js";
import { inspectRepo, runGit, type RepoInfo } from "./git-info.js";

export type RepoNodeKind = "dir" | "file" | "more";

export interface RepoGraphNode {
  /** Repo-relative path ("" for the root). "more" nodes: `<dir>/…more`. */
  id: string;
  kind: RepoNodeKind;
  name: string;
  parent: string | null;
  depth: number;
  /** Language / file family for colouring (ts, js, py, md, json, css, …). */
  lang?: string;
  ext?: string;
  size?: number;
  /** Commits touching this path in the heat window. */
  commits?: number;
  /** 0..1 relative to the hottest file. */
  heat?: number;
  /** dir/more: files below it (whole subtree). */
  fileCount?: number;
  /** dir: whether its children are part of this payload. */
  expanded?: boolean;
}

export interface RepoGraphEdge {
  source: string;
  target: string;
  kind: "contains" | "import";
  weight?: number;
}

export interface RepoGraph {
  root: string;
  repo: RepoInfo;
  head: string | null;
  nodes: RepoGraphNode[];
  edges: RepoGraphEdge[];
  stats: {
    files: number;
    dirs: number;
    visibleNodes: number;
    importEdges: number;
    truncatedWalk: boolean;
    collapsedDirs: number;
    heatWindowDays: number;
    scanMs: number;
  };
  scannedAt: number;
  cached?: boolean;
}

export const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".vite",
  "coverage",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".venv",
  "venv",
  ".tox",
  "target",
  ".gradle",
  ".idea",
  ".expo",
  "Pods",
  ".svelte-kit",
  ".DS_Store",
]);

const LANG_BY_EXT: Record<string, string> = {
  ts: "ts",
  tsx: "ts",
  mts: "ts",
  cts: "ts",
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  py: "py",
  md: "md",
  mdx: "md",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "css",
  less: "css",
  html: "html",
  htm: "html",
  yml: "config",
  yaml: "config",
  toml: "config",
  ini: "config",
  env: "config",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  go: "go",
  rs: "rust",
  swift: "swift",
  kt: "kotlin",
  kts: "kotlin",
  java: "java",
  rb: "ruby",
  php: "php",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  sql: "sql",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  ico: "image",
  mp4: "media",
  mov: "media",
  webm: "media",
  mp3: "media",
  wav: "media",
  pdf: "doc",
  txt: "doc",
};

export function langOf(fileName: string): { lang: string; ext: string } {
  const lower = fileName.toLowerCase();
  if (lower === "dockerfile") return { lang: "config", ext: "dockerfile" };
  if (lower === "makefile") return { lang: "shell", ext: "makefile" };
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  return { lang: LANG_BY_EXT[ext] ?? "other", ext };
}

/** Files that must never show up in a repo graph (secure lane). */
export function isSecureExcluded(absPath: string, extraRoots: string[] = []): boolean {
  if (absPath.endsWith(".ibsec")) return true;
  const roots = [secureScratchDir(), ...extraRoots];
  return roots.some((r) => r && (absPath === r || absPath.startsWith(r + path.sep)));
}

interface WalkFile {
  rel: string;
  size: number;
}

interface WalkDir {
  rel: string;
  dirs: string[];
  files: WalkFile[];
  fileCount: number; // whole subtree, filled after the walk
}

const WALK_LIMIT = 60_000;

function walkRepo(
  root: string,
  secureRoots: string[],
): { dirs: Map<string, WalkDir>; files: number; truncated: boolean } {
  const dirs = new Map<string, WalkDir>();
  let files = 0;
  let seen = 0;
  let truncated = false;
  const queue: string[] = [""];
  while (queue.length) {
    const rel = queue.shift() as string;
    const abs = rel ? path.join(root, rel) : root;
    const entry: WalkDir = { rel, dirs: [], files: [], fileCount: 0 };
    dirs.set(rel, entry);
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      if (++seen > WALK_LIMIT) {
        truncated = true;
        break;
      }
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      const childAbs = path.join(abs, d.name);
      if (isSecureExcluded(childAbs, secureRoots)) continue;
      if (d.isDirectory()) {
        if (IGNORED_DIRS.has(d.name)) continue;
        entry.dirs.push(childRel);
        queue.push(childRel);
      } else if (d.isFile()) {
        if (d.name === ".DS_Store") continue;
        let size = 0;
        try {
          size = fs.statSync(childAbs).size;
        } catch {
          /* ignore */
        }
        entry.files.push({ rel: childRel, size });
        files++;
      }
    }
    if (truncated) break;
  }
  // Subtree file counts (deepest first).
  const ordered = [...dirs.values()].sort(
    (a, b) => b.rel.split("/").length - a.rel.split("/").length,
  );
  for (const d of ordered) {
    d.fileCount = d.files.length + d.dirs.reduce((n, c) => n + (dirs.get(c)?.fileCount ?? 0), 0);
  }
  return { dirs, files, truncated };
}

const HEAT_DAYS = 90;

async function commitHeat(root: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const res = await runGit(
    root,
    ["log", `--since=${HEAT_DAYS}.days`, "-n", "600", "--name-only", "--format=", "--no-renames"],
    { timeoutMs: 8000, maxBuffer: 16 * 1024 * 1024 },
  );
  if (!res.ok) return out;
  for (const line of res.stdout.split("\n")) {
    const f = line.trim();
    if (f) out.set(f, (out.get(f) ?? 0) + 1);
  }
  return out;
}

// ── Import extraction ─────────────────────────────────────────────────

const JS_IMPORT_RE =
  /(?:import|export)\s+(?:[^'"`;]*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;
const PY_FROM_RE = /^\s*from\s+(\.*[\w.]*)\s+import\s+\(?\s*([\w \t,]+)/gm;
const PY_IMPORT_RE = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm;

export function extractImports(source: string, lang: string): string[] {
  const out: string[] = [];
  if (lang === "ts" || lang === "js") {
    for (const m of source.matchAll(JS_IMPORT_RE)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (spec) out.push(spec);
    }
  } else if (lang === "py") {
    for (const m of source.matchAll(PY_FROM_RE)) {
      const mod = m[1];
      // `from . import helpers` → the submodule ".helpers"; for
      // `from pkg import name` the name may be a submodule too.
      const names = m[2]
        .split(",")
        .map((n) => n.trim().split(/\s+/)[0])
        .filter(Boolean);
      if (/^\.+$/.test(mod)) for (const n of names) out.push(mod + n);
      else {
        out.push(mod);
        for (const n of names) out.push(`${mod}.${n}`);
      }
    }
    for (const m of source.matchAll(PY_IMPORT_RE)) {
      for (const part of m[1].split(",")) out.push(part.trim());
    }
  }
  return out;
}

const JS_EXT_CANDIDATES = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  "/index.ts",
  "/index.tsx",
  "/index.js",
];

/** Resolve an import specifier to a repo-relative file path, or null. */
export function resolveImport(
  fromRel: string,
  spec: string,
  lang: string,
  fileSet: Set<string>,
): string | null {
  if (lang === "ts" || lang === "js") {
    if (!spec.startsWith(".")) return null;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
    if (base.startsWith("..")) return null;
    // TS ESM style: "./x.js" points at "./x.ts".
    const stripped = base.replace(/\.(m|c)?js$/, "");
    for (const b of stripped === base ? [base] : [base, stripped]) {
      for (const ext of JS_EXT_CANDIDATES) {
        const cand = b + ext;
        if (fileSet.has(cand)) return cand;
      }
    }
    return null;
  }
  if (lang === "py") {
    let modPath: string;
    if (spec.startsWith(".")) {
      const dots = spec.match(/^\.+/)?.[0].length ?? 0;
      let dir = path.posix.dirname(fromRel);
      for (let i = 1; i < dots; i++) dir = path.posix.dirname(dir);
      const rest = spec.slice(dots).replace(/\./g, "/");
      modPath = rest ? path.posix.join(dir === "." ? "" : dir, rest) : dir;
    } else {
      modPath = spec.replace(/\./g, "/");
    }
    for (const cand of [`${modPath}.py`, `${modPath}/__init__.py`]) {
      const c = cand.replace(/^\.\//, "");
      if (fileSet.has(c)) return c;
    }
    // Absolute import rooted at a top-level package dir (src/ layouts).
    if (!spec.startsWith(".")) {
      for (const prefix of ["src/", "lib/", "app/"]) {
        for (const cand of [`${prefix}${modPath}.py`, `${prefix}${modPath}/__init__.py`]) {
          if (fileSet.has(cand)) return cand;
        }
      }
    }
    return null;
  }
  return null;
}

// ── Graph build ───────────────────────────────────────────────────────

export interface ScanOptions {
  /** Max visible nodes (dirs + files). Default 900, clamp 100..3000. */
  maxNodes?: number;
  /** Dirs (repo-relative) to force-expand, e.g. after a click. */
  expand?: string[];
  /** Extra absolute roots that are secure-lane and must be skipped. */
  secureRoots?: string[];
  /** Skip the cache. */
  fresh?: boolean;
}

const MAX_FILES_PER_DIR = 120;
const MAX_IMPORT_BYTES = 256 * 1024;
const MAX_IMPORT_EDGES = 5000;

export function buildRepoGraph(input: {
  root: string;
  dirs: Map<string, WalkDir>;
  heat: Map<string, number>;
  maxNodes: number;
  expand: string[];
  readFile?: (abs: string) => string | null;
}): { nodes: RepoGraphNode[]; edges: RepoGraphEdge[]; collapsedDirs: number; importEdges: number } {
  const { root, dirs, heat, maxNodes } = input;
  const readFile =
    input.readFile ??
    ((abs: string) => {
      try {
        return fs.readFileSync(abs, "utf8");
      } catch {
        return null;
      }
    });

  // Directories that must be open: each requested dir and all its ancestors.
  const forced = new Set<string>([""]);
  for (const raw of input.expand) {
    let rel = raw.replace(/^\/+|\/+$/g, "");
    while (rel) {
      forced.add(rel);
      rel = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    }
  }

  const maxHeat = Math.max(1, ...heat.values());
  const dirHeat = new Map<string, number>();
  for (const [file, n] of heat) {
    let rel = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
    for (;;) {
      dirHeat.set(rel, (dirHeat.get(rel) ?? 0) + n);
      if (!rel) break;
      rel = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    }
  }
  const maxDirHeat = Math.max(1, ...[...dirHeat.entries()].filter(([k]) => k).map(([, v]) => v));

  const nodes: RepoGraphNode[] = [];
  const edges: RepoGraphEdge[] = [];
  const visible = new Set<string>();
  const nameOf = (rel: string) => (rel ? rel.slice(rel.lastIndexOf("/") + 1) : path.basename(root));
  const depthOf = (rel: string) => (rel ? rel.split("/").length : 0);

  const addDir = (rel: string, parent: string | null) => {
    const d = dirs.get(rel);
    const h = dirHeat.get(rel) ?? 0;
    nodes.push({
      id: rel,
      kind: "dir",
      name: nameOf(rel),
      parent,
      depth: depthOf(rel),
      fileCount: d?.fileCount ?? 0,
      commits: h || undefined,
      heat: rel ? Math.min(1, h / maxDirHeat) : 1,
      expanded: false,
    });
    visible.add(rel);
    if (parent !== null) edges.push({ source: parent, target: rel, kind: "contains" });
  };

  addDir("", null);
  // BFS expansion under the node budget. Forced dirs always open.
  const queue: string[] = [""];
  let collapsedDirs = 0;
  while (queue.length) {
    const rel = queue.shift() as string;
    const d = dirs.get(rel);
    if (!d) continue;
    const node = nodes.find((n) => n.id === rel && n.kind === "dir");
    const childDirs = [...d.dirs].sort(
      (a, b) => (dirHeat.get(b) ?? 0) - (dirHeat.get(a) ?? 0) || a.localeCompare(b),
    );
    const filesSorted = [...d.files].sort(
      (a, b) => (heat.get(b.rel) ?? 0) - (heat.get(a.rel) ?? 0) || a.rel.localeCompare(b.rel),
    );
    const fileSlots = Math.min(filesSorted.length, MAX_FILES_PER_DIR);
    const cost = childDirs.length + fileSlots + (filesSorted.length > fileSlots ? 1 : 0);
    if (!forced.has(rel) && nodes.length + cost > maxNodes) {
      collapsedDirs++;
      continue;
    }
    if (node) node.expanded = true;
    for (const c of childDirs) {
      addDir(c, rel);
      queue.push(c);
    }
    for (const f of filesSorted.slice(0, fileSlots)) {
      const fname = nameOf(f.rel);
      const { lang, ext } = langOf(fname);
      const commits = heat.get(f.rel) ?? 0;
      nodes.push({
        id: f.rel,
        kind: "file",
        name: fname,
        parent: rel,
        depth: depthOf(f.rel),
        lang,
        ext,
        size: f.size,
        commits: commits || undefined,
        heat: commits / maxHeat,
      });
      visible.add(f.rel);
      edges.push({ source: rel, target: f.rel, kind: "contains" });
    }
    if (filesSorted.length > fileSlots) {
      const id = `${rel ? `${rel}/` : ""}…more`;
      nodes.push({
        id,
        kind: "more",
        name: `+${filesSorted.length - fileSlots} more files`,
        parent: rel,
        depth: depthOf(rel) + 1,
        fileCount: filesSorted.length - fileSlots,
      });
      edges.push({ source: rel, target: id, kind: "contains" });
    }
  }
  // Collapsed dirs = visible dirs that were not expanded.
  collapsedDirs = nodes.filter(
    (n) => n.kind === "dir" && !n.expanded && (n.fileCount ?? 0) > 0,
  ).length;

  // Import edges between visible files (targets roll up to the nearest
  // visible ancestor directory when they sit inside a collapsed dir).
  const allFiles = new Set<string>();
  for (const d of dirs.values()) for (const f of d.files) allFiles.add(f.rel);
  const nearestVisible = (rel: string): string | null => {
    let cur = rel;
    while (cur) {
      if (visible.has(cur)) return cur;
      cur = cur.includes("/") ? cur.slice(0, cur.lastIndexOf("/")) : "";
    }
    return null;
  };
  const importKey = new Map<string, RepoGraphEdge>();
  for (const n of nodes) {
    if (importKey.size >= MAX_IMPORT_EDGES) break;
    if (n.kind !== "file" || (n.lang !== "ts" && n.lang !== "js" && n.lang !== "py")) continue;
    if ((n.size ?? 0) > MAX_IMPORT_BYTES) continue;
    const src = readFile(path.join(root, n.id));
    if (!src) continue;
    for (const spec of extractImports(src, n.lang)) {
      const target = resolveImport(n.id, spec, n.lang, allFiles);
      if (!target || target === n.id) continue;
      const shown = nearestVisible(target);
      if (!shown || shown === n.id || shown === n.parent) continue;
      const key = `${n.id}→${shown}`;
      const existing = importKey.get(key);
      if (existing) existing.weight = (existing.weight ?? 1) + 1;
      else importKey.set(key, { source: n.id, target: shown, kind: "import", weight: 1 });
    }
  }
  edges.push(...importKey.values());
  return { nodes, edges, collapsedDirs, importEdges: importKey.size };
}

// ── Cache + watcher ───────────────────────────────────────────────────

const GRAPH_TTL_MS = 10 * 60_000;
const graphCache = new Map<string, { at: number; graph: RepoGraph }>();
const watchers = new Map<
  string,
  { watchers: fs.FSWatcher[]; lastUsed: number; timer?: NodeJS.Timeout }
>();
let changeListener: ((root: string) => void) | null = null;

/** Gateway wires this to broadcast `projects.repo.changed`. */
export function onRepoGraphChanged(fn: ((root: string) => void) | null): void {
  changeListener = fn;
}

export function invalidateRepoGraph(root: string): void {
  for (const key of Array.from(graphCache.keys())) {
    if (key.startsWith(`${root}\u0000`)) graphCache.delete(key);
  }
}

const MAX_WATCHED_DIRS = 300;

function watchRepo(root: string, graph: RepoGraph): void {
  const existing = watchers.get(root);
  if (existing) {
    existing.lastUsed = Date.now();
    return;
  }
  const list: fs.FSWatcher[] = [];
  const fire = () => {
    const w = watchers.get(root);
    if (!w) return;
    if (w.timer) clearTimeout(w.timer);
    w.timer = setTimeout(() => {
      invalidateRepoGraph(root);
      changeListener?.(root);
    }, 1500);
  };
  const tryWatch = (p: string) => {
    try {
      const w = fs.watch(p, { persistent: false }, fire);
      w.on("error", () => {
        /* dir vanished */
      });
      list.push(w);
    } catch {
      /* ignore */
    }
  };
  // .git may be a file (linked worktree) — watch the real git dir's HEAD.
  const gitDir = path.join(root, ".git");
  try {
    if (fs.statSync(gitDir).isDirectory()) {
      tryWatch(path.join(gitDir, "HEAD"));
      tryWatch(path.join(gitDir, "index"));
    }
  } catch {
    /* ignore */
  }
  const dirNodes = graph.nodes.filter((n) => n.kind === "dir" && n.expanded);
  for (const n of dirNodes.slice(0, MAX_WATCHED_DIRS)) tryWatch(path.join(root, n.id));
  watchers.set(root, { watchers: list, lastUsed: Date.now() });
}

/** Close watchers for repos nobody looked at for a while. */
export function sweepRepoWatchers(maxIdleMs = 15 * 60_000): void {
  const now = Date.now();
  for (const [root, w] of watchers) {
    if (now - w.lastUsed < maxIdleMs) continue;
    for (const x of w.watchers) x.close();
    if (w.timer) clearTimeout(w.timer);
    watchers.delete(root);
  }
}

export function closeAllRepoWatchers(): void {
  for (const [root, w] of watchers) {
    for (const x of w.watchers) x.close();
    if (w.timer) clearTimeout(w.timer);
    watchers.delete(root);
  }
}

export async function scanRepoGraph(rawRoot: string, opts: ScanOptions = {}): Promise<RepoGraph> {
  const repo = await inspectRepo(rawRoot);
  if (!repo.isRepo || !repo.root) throw new Error(repo.error || "not a git repository");
  const root = repo.root;
  const maxNodes = Math.min(Math.max(opts.maxNodes ?? 900, 100), 3000);
  const expand = (opts.expand ?? []).filter((x) => typeof x === "string").slice(0, 50);
  const headRes = await runGit(root, ["rev-parse", "HEAD"]);
  const head = headRes.ok ? headRes.stdout.trim() : null;
  const key = `${root}\u0000${head}\u0000${maxNodes}\u0000${[...expand].sort().join("|")}`;
  const hit = graphCache.get(key);
  if (!opts.fresh && hit && Date.now() - hit.at < GRAPH_TTL_MS) {
    watchRepo(root, hit.graph);
    return { ...hit.graph, repo, cached: true };
  }
  const t0 = Date.now();
  const walk = walkRepo(root, opts.secureRoots ?? []);
  const heat = await commitHeat(root);
  const built = buildRepoGraph({ root, dirs: walk.dirs, heat, maxNodes, expand });
  const graph: RepoGraph = {
    root,
    repo,
    head,
    nodes: built.nodes,
    edges: built.edges,
    stats: {
      files: walk.files,
      dirs: walk.dirs.size,
      visibleNodes: built.nodes.length,
      importEdges: built.importEdges,
      truncatedWalk: walk.truncated,
      collapsedDirs: built.collapsedDirs,
      heatWindowDays: HEAT_DAYS,
      scanMs: Date.now() - t0,
    },
    scannedAt: Date.now(),
  };
  graphCache.set(key, { at: Date.now(), graph });
  if (graphCache.size > 40) {
    const oldest = graphCache.keys().next().value;
    if (oldest) graphCache.delete(oldest);
  }
  watchRepo(root, graph);
  return graph;
}

// ── File read (click-to-open) ─────────────────────────────────────────

/** Files whose contents never leave the gateway (they still appear as nodes). */
export function isSecretFileName(name: string): boolean {
  const n = name.toLowerCase();
  if (/^\.env(\..+)?$/.test(n)) return !/\.(example|sample|template|dist)$/.test(n);
  if (/\.(pem|key|p12|pfx|keystore|jks)$/.test(n)) return true;
  return [
    "id_rsa",
    "id_ed25519",
    "id_ecdsa",
    ".npmrc",
    ".netrc",
    ".pypirc",
    "credentials.json",
  ].includes(n);
}

const MAX_READ_BYTES = 512 * 1024;

export interface RepoFileRead {
  root: string;
  path: string;
  absPath: string;
  size: number;
  lang: string;
  ext: string;
  binary: boolean;
  truncated: boolean;
  content?: string;
  lastCommit?: { sha: string; subject: string; at: number; author?: string };
}

/** Read one file inside a repo; refuses traversal, ignored dirs and secure paths. */
export async function readRepoFile(
  rawRoot: string,
  rel: string,
  opts: { secureRoots?: string[] } = {},
): Promise<RepoFileRead> {
  const repo = await inspectRepo(rawRoot);
  if (!repo.isRepo || !repo.root) throw new Error(repo.error || "not a git repository");
  const root = repo.root;
  const clean = path.posix.normalize(String(rel ?? "").replace(/\\/g, "/")).replace(/^\/+/, "");
  if (!clean || clean.startsWith("..")) throw new Error("invalid path");
  if (clean.split("/").some((seg) => seg === ".git")) throw new Error("refusing .git internals");
  if (isSecretFileName(path.posix.basename(clean))) {
    throw new Error("refusing to show a secrets file (.env / key material)");
  }
  const abs = path.join(root, clean);
  const realRoot = fs.realpathSync(root);
  const realAbs = fs.realpathSync(abs);
  if (realAbs !== realRoot && !realAbs.startsWith(realRoot + path.sep)) {
    throw new Error("path escapes the repo");
  }
  if (isSecureExcluded(realAbs, opts.secureRoots ?? [])) throw new Error("secure-lane file");
  const st = fs.statSync(realAbs);
  if (!st.isFile()) throw new Error("not a file");
  const { lang, ext } = langOf(path.basename(clean));
  const fd = fs.openSync(realAbs, "r");
  let buf: Buffer;
  try {
    const len = Math.min(st.size, MAX_READ_BYTES);
    buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
  } finally {
    fs.closeSync(fd);
  }
  const binary = buf.subarray(0, 8000).includes(0);
  const log = await runGit(root, ["log", "-1", "--format=%H%x1f%s%x1f%ct%x1f%an", "--", clean]);
  let lastCommit: RepoFileRead["lastCommit"];
  if (log.ok && log.stdout.trim()) {
    const [sha, subject, ct, author] = log.stdout.trim().split("\x1f");
    lastCommit = { sha, subject: subject ?? "", at: Number(ct) * 1000, author };
  }
  return {
    root,
    path: clean,
    absPath: realAbs,
    size: st.size,
    lang,
    ext,
    binary,
    truncated: st.size > MAX_READ_BYTES,
    content: binary ? undefined : buf.toString("utf8"),
    lastCommit,
  };
}
