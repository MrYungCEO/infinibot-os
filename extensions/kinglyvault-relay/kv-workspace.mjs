// KinglyVault Connect — the member's InfiniBot work shown inside KinglyVault
// (Agent C actions: outputs.*, tasks.*, files.*, approvals.*).
//
// Everything here is read-mostly and fenced:
//  - Outputs live in <relay workspaces>/outputs/<id>/ (one folder per thing an
//    agent made for KV: a site, a doc, images, a carousel, workflow files).
//    Reads never leave that folder (realpath-checked, no symlink escapes).
//  - files.list / files.read only see the folders this InfiniBot allows for
//    KinglyVault (policy.json allowedWorkdirs + the relay workspace). Dotfiles
//    and key/credential files are never listed or read.
//  - Big files come back in FILE_CHUNK_BYTES chunks so a relay result stays
//    under KV's per-action cap; files over MAX_FILE_BYTES are refused.
//
// The relay client (relay-client.mjs) verifies the signed envelope + scope
// before any of this runs.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Raw bytes per chunk (base64 ≈ 512 KB, under KV's 600 000-char result cap). Mirrors KV FILE_CHUNK_BYTES. */
export const FILE_CHUNK_BYTES = 384 * 1024;
/** Largest file KV may pull for a preview. */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Largest single-file site after inlining its local CSS / JS / images. */
const MAX_INLINE_BYTES = 3 * 1024 * 1024;
const MAX_LIST = 500;
/** JSON budget for list results (KV caps a relay result at 60 000 chars). */
export const LIST_BUDGET_CHARS = 48_000;

/** Keeps items (in order) while their JSON fits `budget`. */
export function fitList(items, budget = LIST_BUDGET_CHARS) {
  const out = [];
  let used = 2;
  for (const it of items) {
    const n = JSON.stringify(it).length + 1;
    if (used + n > budget) return { items: out, truncated: true };
    used += n;
    out.push(it);
  }
  return { items: out, truncated: false };
}

export const OUTPUT_KINDS = ['site', 'doc', 'image', 'carousel', 'workflow', 'file'];
export const BUILD_TOOLS = ['form', 'chatbot', 'agent', 'linktree', 'carousel', 'website'];
export const TASK_STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'blocked', 'done'];

const MIME = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
};

export function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

const isText = (mime) => mime.startsWith('text/') || mime === 'application/json' || mime === 'image/svg+xml';
const isImage = (mime) => mime.startsWith('image/');

/** Never listed or read through KV, even inside an allowed folder. */
export function isSecretName(name) {
  const n = String(name).toLowerCase();
  return n.startsWith('.') || /\.(pem|key|p12|pfx|keystore|kdbx)$/.test(n) || /^(id_rsa|id_ed25519|id_ecdsa)(\.|$)/.test(n) || /credential|secret|token/.test(n) && /\.(json|txt|env|ya?ml)$/.test(n);
}

function realOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** True when `child` (a realpath) is `root` or inside it. */
export function within(root, child) {
  if (!root || !child) return false;
  const rel = path.relative(root, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/** A relative file name inside an output: no absolute paths, no .., no NUL. */
function relOk(f) {
  return typeof f === 'string' && !!f && !f.startsWith('/') && !f.includes('\\') && !f.includes('\0') && !/(^|\/)\.\.(\/|$)/.test(f);
}

const OUTPUT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/;

export function newOutputId(now = Date.now()) {
  return `out-${now.toString(36)}-${randomBytes(4).toString('hex')}`;
}

/**
 * The workspace API. `outputsRoot` holds one folder per output; `roots()`
 * returns the allow-listed folders for files.*; `runArtifacts(runId)` returns
 * the run artifacts dir of a KV-started run (or null).
 */
export function createWorkspace({ outputsRoot, roots, now = () => Date.now() }) {
  const ensureRoot = () => fs.mkdirSync(outputsRoot, { recursive: true, mode: 0o700 });

  function outputDir(id) {
    if (!OUTPUT_ID.test(String(id))) throw new Error('Unknown output.');
    ensureRoot();
    const base = realOrNull(outputsRoot);
    const dir = realOrNull(path.join(outputsRoot, id));
    if (!base || !dir || !within(base, dir) || dir === base) throw new Error('Unknown output.');
    return dir;
  }

  function readManifest(dir) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, 'output.json'), 'utf8'));
      return m && typeof m === 'object' ? m : {};
    } catch {
      return {};
    }
  }

  function writeManifest(dir, m) {
    const tmp = path.join(dir, `.output.json.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, path.join(dir, 'output.json'));
  }

  /** Files of an output (relative paths), skipping the manifest, dotfiles and secrets. */
  function walk(dir, { max = 200 } = {}) {
    const out = [];
    const stack = [''];
    while (stack.length && out.length < max) {
      const rel = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (isSecretName(e.name) || (rel === '' && e.name === 'output.json')) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (r.split('/').length < 4) stack.push(r);
        } else if (e.isFile()) {
          let size = 0;
          try {
            size = fs.statSync(path.join(dir, r)).size;
          } catch {
            continue;
          }
          out.push({ path: r, size, mime: mimeOf(r) });
          if (out.length >= max) break;
        }
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  }

  /** Best guess of what an output is, from its manifest and files. */
  function describe(id, dir) {
    const m = readManifest(dir);
    const files = walk(dir);
    const names = files.map((f) => f.path);
    const slides = files.filter((f) => /^slides\//.test(f.path) && isImage(f.mime));
    const pick = (re) => names.find((n) => re.test(n));
    let entry = typeof m.entry === 'string' && names.includes(m.entry) ? m.entry : null;
    let kind = OUTPUT_KINDS.includes(m.kind) ? m.kind : null;
    if (!entry) entry = pick(/^index\.html?$/i) || pick(/\.html?$/i) || pick(/\.(md|markdown)$/i) || pick(/\.(png|jpe?g|webp|gif|svg)$/i) || pick(/\.json$/i) || names[0] || null;
    if (!kind) {
      if (slides.length > 1) kind = 'carousel';
      else if (entry && /\.html?$/i.test(entry)) kind = 'site';
      else if (entry && /\.(md|markdown|txt|pdf)$/i.test(entry)) kind = 'doc';
      else if (entry && isImage(mimeOf(entry))) kind = 'image';
      else if (entry && /\.json$/i.test(entry)) kind = 'workflow';
      else kind = 'file';
    }
    let mtime = 0;
    try {
      mtime = fs.statSync(dir).mtimeMs;
    } catch {
      /* gone */
    }
    for (const f of files.slice(0, 50)) {
      try {
        mtime = Math.max(mtime, fs.statSync(path.join(dir, f.path)).mtimeMs);
      } catch {
        /* raced */
      }
    }
    const building = m.status === 'building';
    return {
      id,
      kind,
      title: typeof m.title === 'string' && m.title ? m.title.slice(0, 120) : id,
      tool: typeof m.tool === 'string' ? m.tool : null,
      source: typeof m.source === 'string' ? m.source : 'infinibot',
      runId: typeof m.runId === 'string' ? m.runId : null,
      // "building" until the agent has written something to show.
      status: building && !files.length ? 'building' : m.status === 'failed' ? 'failed' : 'ready',
      entry,
      slides: slides.map((f) => f.path).slice(0, 30),
      fileCount: files.length,
      createdAt: typeof m.createdAt === 'string' ? m.createdAt : new Date(mtime || now()).toISOString(),
      updatedAt: new Date(mtime || now()).toISOString(),
      files,
    };
  }

  function list({ kind, limit = 50 } = {}) {
    ensureRoot();
    let ids = [];
    try {
      ids = fs.readdirSync(outputsRoot, { withFileTypes: true }).filter((e) => e.isDirectory() && OUTPUT_ID.test(e.name)).map((e) => e.name);
    } catch {
      ids = [];
    }
    const items = [];
    for (const id of ids) {
      try {
        const d = describe(id, outputDir(id));
        if (kind && d.kind !== kind) continue;
        const { files, ...summary } = d;
        items.push(summary);
      } catch {
        /* unreadable: skip */
      }
    }
    items.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return { outputs: items.slice(0, Math.min(Math.max(limit, 1), 100)), total: items.length };
  }

  function get(id) {
    return { output: describe(id, outputDir(id)) };
  }

  /** Inlines local stylesheets, scripts and images of an HTML file (same output only). */
  function inlineHtml(dir, file, html) {
    const base = path.posix.dirname(file);
    let budget = MAX_INLINE_BYTES;
    const local = (ref) => {
      if (!ref || /^(?:[a-z]+:|\/\/|#|\/)/i.test(ref)) return null;
      const clean = ref.split(/[?#]/)[0];
      const rel = path.posix.normalize(path.posix.join(base === '.' ? '' : base, decodeURI(clean)));
      if (!relOk(rel)) return null;
      const abs = realOrNull(path.join(dir, rel));
      if (!abs || !within(dir, abs) || isSecretName(path.basename(abs))) return null;
      try {
        const buf = fs.readFileSync(abs);
        if (buf.length > budget) return null;
        budget -= buf.length;
        return { buf, mime: mimeOf(abs) };
      } catch {
        return null;
      }
    };
    let out = html.replace(/<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi, (tag) => {
      const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
      const f = local(href);
      return f ? `<style>${f.buf.toString('utf8').replace(/<\/style/gi, '<\\/style')}</style>` : tag;
    });
    out = out.replace(/<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (tag, a, src, b) => {
      const f = local(src);
      return f ? `<script${a}${b}>${f.buf.toString('utf8').replace(/<\/script/gi, '<\\/script')}</script>` : tag;
    });
    out = out.replace(/(<(?:img|source|video)\b[^>]*\b(?:src|poster)=["'])([^"']+)(["'])/gi, (all, pre, src, post) => {
      const f = local(src);
      return f ? `${pre}data:${f.mime};base64,${f.buf.toString('base64')}${post}` : all;
    });
    return out;
  }

  /** One chunk of a file in an output. `inline` turns an HTML entry into one self-contained page. */
  function fetchFile(id, { file, offset = 0, inline = false } = {}) {
    const dir = outputDir(id);
    const d = describe(id, dir);
    const rel = file || d.entry;
    if (!rel || !relOk(rel)) throw new Error('This output has nothing to show yet.');
    const abs = realOrNull(path.join(dir, rel));
    if (!abs || !within(dir, abs) || isSecretName(path.basename(abs))) throw new Error('No such file in this output.');
    return chunkOf(abs, rel, { offset, transform: inline && /\.html?$/i.test(rel) ? (buf) => Buffer.from(inlineHtml(dir, rel, buf.toString('utf8')), 'utf8') : null });
  }

  /** Allow-listed folders as realpaths. */
  function rootList() {
    const seen = new Set();
    const out = [];
    for (const r of roots()) {
      const real = realOrNull(r);
      if (!real || seen.has(real)) continue;
      seen.add(real);
      out.push(real);
    }
    return out;
  }

  function resolveAllowed(p) {
    const real = realOrNull(path.resolve(String(p)));
    if (!real) throw new Error('That path does not exist.');
    const root = rootList().find((r) => within(r, real));
    if (!root) throw new Error('That folder is not shared with KinglyVault. Allow it on your InfiniBot first.');
    // Every component under the root must be shareable (no .git/, .env, keys).
    const parts = path.relative(root, real).split(path.sep).filter(Boolean);
    if (parts.some((x) => isSecretName(x))) throw new Error('That file is private and is never shared with KinglyVault.');
    return { real, root };
  }

  function listFiles(p) {
    const rs = rootList();
    if (!p) return { path: null, parent: null, roots: rs, entries: rs.map((r) => ({ name: path.basename(r) || r, path: r, type: 'dir' })) };
    const { real, root } = resolveAllowed(p);
    const st = fs.statSync(real);
    if (!st.isDirectory()) throw new Error('That is a file, not a folder.');
    const entries = [];
    for (const e of fs.readdirSync(real, { withFileTypes: true })) {
      if (isSecretName(e.name)) continue;
      const full = path.join(real, e.name);
      if (e.isDirectory()) entries.push({ name: e.name, path: full, type: 'dir' });
      else if (e.isFile()) {
        let size = 0;
        let mtime = null;
        try {
          const s = fs.statSync(full);
          size = s.size;
          mtime = new Date(s.mtimeMs).toISOString();
        } catch {
          continue;
        }
        entries.push({ name: e.name, path: full, type: 'file', size, mime: mimeOf(e.name), modifiedAt: mtime });
      }
      if (entries.length >= MAX_LIST) break;
    }
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === 'dir' ? -1 : 1));
    const fit = fitList(entries);
    return { path: real, parent: real === root ? null : path.dirname(real), roots: rs, entries: fit.items, truncated: fit.truncated || entries.length >= MAX_LIST };
  }

  function readFile(p, { offset = 0 } = {}) {
    const { real } = resolveAllowed(p);
    if (!fs.statSync(real).isFile()) throw new Error('That is a folder, not a file.');
    return chunkOf(real, path.basename(real), { offset });
  }

  /** New, empty output folder for a "Build with my InfiniBot" run. */
  function createBuild({ tool, title, spec }) {
    ensureRoot();
    const id = newOutputId(now());
    const dir = path.join(outputsRoot, id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const kind = tool === 'carousel' ? 'carousel' : tool === 'agent' ? 'doc' : 'site';
    const manifest = { id, kind, tool, title, spec, source: 'kinglyvault', status: 'building', createdAt: new Date(now()).toISOString() };
    writeManifest(dir, manifest);
    return { id, dir, manifest };
  }

  function updateManifest(id, patch) {
    const dir = outputDir(id);
    writeManifest(dir, { ...readManifest(dir), ...patch });
  }

  return { list, get, fetchFile, listFiles, readFile, createBuild, updateManifest, outputDir };
}

/** A chunk of a file: utf8 when a whole text file fits one chunk, else base64. */
export function chunkOf(abs, name, { offset = 0, transform = null } = {}) {
  const st = fs.statSync(abs);
  if (st.size > MAX_FILE_BYTES) throw new Error(`That file is too big to preview in KinglyVault (${Math.round(st.size / 1048576)} MB, limit ${MAX_FILE_BYTES / 1048576} MB).`);
  let buf = fs.readFileSync(abs);
  if (transform) buf = transform(buf);
  const mime = mimeOf(name);
  const size = buf.length;
  const start = Math.min(Math.max(0, Math.floor(offset) || 0), size);
  const end = Math.min(size, start + FILE_CHUNK_BYTES);
  const slice = buf.subarray(start, end);
  const whole = start === 0 && end === size;
  return {
    name,
    mime,
    size,
    offset: start,
    nextOffset: end < size ? end : null,
    encoding: whole && isText(mime) ? 'utf8' : 'base64',
    data: whole && isText(mime) ? slice.toString('utf8') : slice.toString('base64'),
  };
}

// ── "Build with my InfiniBot" (outputs.build) ─────────────────────────

const TOOL_BRIEF = {
  website: 'a complete, responsive single-page website',
  linktree: 'a link-in-bio page (avatar, name, short bio, a stack of large link buttons)',
  form: 'a working web form page; submit with fetch() to the webhook URL in the spec when there is one, else show a thank-you state',
  chatbot: 'a chatbot web page (chat window, message list, input) that posts to the webhook URL in the spec when there is one',
  carousel: 'a social carousel (one slide per <section class="slide">, 1080×1350 each)',
  agent: 'an AI agent definition: role, goals, system prompt, tools it needs, step-by-step workflow and example conversations',
};

/** The task text handed to the member's agent for one build. */
export function buildTaskText({ tool, title, spec, dir }) {
  const what = TOOL_BRIEF[tool] || 'the requested deliverable';
  const lines = [
    `Build ${what} for KinglyVault, titled "${title}".`,
    '',
    `Write every file into this folder (it already exists): ${dir}`,
    'Do not write anywhere else. Do not publish, deploy, post or send anything.',
    '',
  ];
  if (tool === 'agent') {
    lines.push('Write agent.md (Markdown). If the agent needs an automation, also write workflow.json (n8n-style JSON).');
  } else {
    lines.push(
      'Write index.html as ONE self-contained file: inline CSS and JS, no build step, no external scripts.',
      'Images: write them into the folder and reference them with relative paths (they are inlined for the preview), or use inline SVG.',
      'Design: dark background (#07060c), gold accents (#d4af37), clean modern type, mobile-first, no horizontal scroll.',
    );
    if (tool === 'carousel') lines.push('If you can render images, ALSO write each slide as slides/01.png, slides/02.png … (1080×1350).');
  }
  lines.push('', 'When done, reply with one short sentence saying what you made.', '', '--- Spec from the member ---', spec);
  return lines.join('\n');
}

// ── tasks + approvals: trimmed views of the gateway's own records ─────

export function taskView(t) {
  return {
    id: String(t.id),
    title: String(t.title || '').slice(0, 300),
    status: String(t.status || 'todo'),
    priority: t.priority ? String(t.priority) : null,
    dueDate: t.dueDate ? String(t.dueDate).slice(0, 10) : null,
    projectId: t.projectId || null,
    assignee: t.assignee ? String(t.assignee).slice(0, 80) : null,
    description: t.description ? String(t.description).slice(0, 160) : '',
    updatedAt: typeof t.updatedAt === 'number' ? new Date(t.updatedAt).toISOString() : t.updatedAt || null,
  };
}

export function approvalView(r) {
  return {
    id: String(r.id),
    title: String(r.title || 'Approval required').slice(0, 200),
    summary: String(r.summary || '').slice(0, 400),
    details: String(r.details || '').slice(0, 1000),
    risk: r.risk || 'medium',
    requester: r.requester?.label || r.requester?.agentId || r.source || 'InfiniBot',
    agentId: r.requester?.agentId || null,
    source: r.source || null,
    // KV only offers approve / deny; other options stay on the InfiniBot side.
    canApprove: !Array.isArray(r.options) || r.options.includes('approve'),
    restricted: !!r.resolverPolicy,
    createdAt: typeof r.createdAt === 'number' ? new Date(r.createdAt).toISOString() : null,
    expiresAt: typeof r.expiresAt === 'number' ? new Date(r.expiresAt).toISOString() : null,
  };
}
