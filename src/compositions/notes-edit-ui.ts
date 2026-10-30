/**
 * notes-edit UI — multi-clip timeline editor.
 *
 *   bun src/compositions/notes-edit-ui.ts <slug...> [--workspace DIR] [--port N]
 *
 * Loads one or more jobs side-by-side, plays each clip's proxy in cut-mode
 * (skipping dropped spans live), lets the user click spans to flip
 * keep/drop, drag span edges to fine-trim, and renders a combined cut
 * across all clips with one button.
 *
 * Endpoints:
 *   GET  /                       — editor page (lists known slugs)
 *   GET  /api/jobs               — manifests + EDLs for every loaded slug
 *   PUT  /api/edl/:slug          — overwrite that job's edl.json
 *   POST /api/preview/:slug      — re-render its cut.proxy.mp4
 *   POST /api/combine            — concat all current cut.proxy.mp4 → combined.proxy.mp4
 *   GET  /proxy/:slug.mp4        — proxy with Range support
 *   GET  /cut/:slug.mp4          — that job's cut proxy
 *   GET  /combined.mp4           — combined output
 */

import { spawn } from "node:child_process";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import type { EdlEntry, Manifest } from "./notes-edit.js";
import {
  jobsToProject,
  applyProjectEditsToEdls,
  type StoryboardProject,
} from "./notes-edit-storyboard.js";

const DEFAULT_PORT = 4789;
const DEFAULT_WORKSPACE =
  process.env.NOTES_EDIT_WORKSPACE ??
  (process.env.INFINIBOT_STATE_DIR
    ? `${process.env.INFINIBOT_STATE_DIR}/video/.notes-edit`
    : `${process.env.HOME}/Infini/.notes-edit`);

interface Args {
  slugs: string[];
  workspace: string;
  port: number;
}

function parseArgs(argv: string[]): Args {
  const slugs: string[] = [];
  let workspace = DEFAULT_WORKSPACE;
  let port = DEFAULT_PORT;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--workspace") workspace = argv[++i];
    else if (a === "--port") port = Number(argv[++i]);
    else if (!a.startsWith("--")) slugs.push(a);
  }
  if (!slugs.length) {
    throw new Error("Usage: notes-edit-ui <slug...> [--workspace DIR] [--port N]");
  }
  return { slugs, workspace: resolve(workspace), port };
}

function jobDir(workspace: string, slug: string): string {
  return join(workspace, "jobs", slug);
}

function readJob(workspace: string, slug: string) {
  const dir = jobDir(workspace, slug);
  const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf-8")) as Manifest;
  const edlPath = join(dir, "edl.json");
  const edl = existsSync(edlPath)
    ? (JSON.parse(readFileSync(edlPath, "utf-8")) as { auto?: boolean; entries: EdlEntry[] })
    : { entries: [] };
  const cutProxyExists = existsSync(join(dir, "cut.proxy.mp4"));
  return {
    slug: m.slug,
    inputName: m.input.split("/").pop(),
    durationSec: m.durationSec ?? 0,
    edl,
    cutProxyExists,
  };
}

function writeEdl(workspace: string, slug: string, entries: EdlEntry[]): void {
  const p = join(jobDir(workspace, slug), "edl.json");
  writeFileSync(p, JSON.stringify({ auto: false, entries }, null, 2));
}

// ── range file serving ───────────────────────────────────────────────

function serveFileRange(req: IncomingMessage, res: ServerResponse, path: string, type: string) {
  if (!existsSync(path)) {
    res.writeHead(404).end("not found");
    return;
  }
  const stat = statSync(path);
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, {
      "content-type": type,
      "content-length": String(stat.size),
      "accept-ranges": "bytes",
    });
    createReadStream(path).pipe(res);
    return;
  }
  const m = /bytes=(\d+)-(\d*)/.exec(range);
  const start = m ? parseInt(m[1], 10) : 0;
  const end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
  res.writeHead(206, {
    "content-type": type,
    "content-range": `bytes ${start}-${end}/${stat.size}`,
    "content-length": String(end - start + 1),
    "accept-ranges": "bytes",
  });
  createReadStream(path, { start, end }).pipe(res);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

// ── jobs / ops ───────────────────────────────────────────────────────

function runPreview(workspace: string, slug: string): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  return new Promise((resolveP, reject) => {
    const proc = spawn(
      "bun",
      [join(here, "notes-edit.ts"), "preview", slug, "--workspace", workspace],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 ? resolveP() : reject(new Error(`preview ${slug} exit ${code}`)),
    );
  });
}

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolveP, reject) => {
    const proc = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    proc.stderr.on("data", (c) => (err += c.toString()));
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 ? resolveP() : reject(new Error(`ffmpeg ${code}: ${err.slice(-500)}`)),
    );
  });
}

/**
 * Grab a single JPEG frame from a clip at the given source-time and cache
 * it on disk. Used for storyboard scene thumbnails.
 */
async function ensureThumb(
  workspace: string,
  slug: string,
  sceneIdx: number,
  atSec: number,
): Promise<string> {
  const dir = join(jobDir(workspace, slug), "thumbs");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${String(sceneIdx).padStart(4, "0")}.jpg`);
  if (existsSync(out)) return out;
  const proxy = join(jobDir(workspace, slug), "proxy.mp4");
  await ffmpeg([
    "-y",
    "-ss",
    String(Math.max(0, atSec)),
    "-i",
    proxy,
    "-frames:v",
    "1",
    "-vf",
    "scale=240:-2",
    "-q:v",
    "5",
    out,
  ]);
  return out;
}

async function combineCuts(workspace: string, slugs: string[], out: string): Promise<void> {
  const parts = slugs
    .map((s) => join(jobDir(workspace, s), "cut.proxy.mp4"))
    .filter((p) => existsSync(p));
  if (!parts.length) throw new Error("No cut.proxy.mp4 files to combine — run preview first");
  const work = mkdtempSync(join(tmpdir(), "notes-combine-"));
  const list = join(work, "concat.txt");
  writeFileSync(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
  await ffmpeg(["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", out]);
}

/**
 * Stitch every clip's raw proxy.mp4 into one combined.raw.mp4 so the editor
 * has a single video source whose time domain is global. Re-encodes on
 * mismatched timebases (concat demuxer is finicky); proxies are small.
 */
async function combineRawProxies(workspace: string, slugs: string[], out: string): Promise<void> {
  const parts = slugs.map((s) => join(jobDir(workspace, s), "proxy.mp4"));
  for (const p of parts) {
    if (!existsSync(p)) throw new Error(`Missing proxy: ${p} (run notes-edit preview/run first)`);
  }
  if (existsSync(out)) {
    // Skip rebuild if newer than every input.
    const outM = statSync(out).mtimeMs;
    if (parts.every((p) => statSync(p).mtimeMs <= outM)) return;
  }
  const work = mkdtempSync(join(tmpdir(), "notes-rawcombine-"));
  const list = join(work, "concat.txt");
  writeFileSync(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
  // Re-encode lightly — proxies are already small, this normalizes timebase.
  await ffmpeg([
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    list,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "28",
    "-c:a",
    "aac",
    "-b:a",
    "96k",
    "-movflags",
    "+faststart",
    out,
  ]);
}

// ── server ───────────────────────────────────────────────────────────

function startServer(args: Args) {
  for (const slug of args.slugs) {
    if (!existsSync(join(jobDir(args.workspace, slug), "manifest.json"))) {
      throw new Error(`Job '${slug}' not found at ${jobDir(args.workspace, slug)}`);
    }
  }
  const combinedOut = join(args.workspace, "combined.proxy.mp4");
  const combinedRawOut = join(args.workspace, "combined.raw.proxy.mp4");

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://localhost:${args.port}`);
      const p = url.pathname;

      if (req.method === "GET" && p === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(renderHtml(args.slugs));
        return;
      }
      if (req.method === "GET" && p === "/api/jobs") {
        const jobs = args.slugs.map((s) => readJob(args.workspace, s));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jobs }));
        return;
      }
      const edlMatch = /^\/api\/edl\/(.+)$/.exec(p);
      if (req.method === "PUT" && edlMatch) {
        const slug = decodeURIComponent(edlMatch[1]);
        if (!args.slugs.includes(slug)) {
          res.writeHead(404).end("unknown slug");
          return;
        }
        const body = await readBody(req);
        const parsed = JSON.parse(body) as { entries: EdlEntry[] };
        writeEdl(args.workspace, slug, parsed.entries);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, wrote: parsed.entries.length }));
        return;
      }
      const prevMatch = /^\/api\/preview\/(.+)$/.exec(p);
      if (req.method === "POST" && prevMatch) {
        const slug = decodeURIComponent(prevMatch[1]);
        if (!args.slugs.includes(slug)) {
          res.writeHead(404).end("unknown slug");
          return;
        }
        await runPreview(args.workspace, slug);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ ok: true, output: join(jobDir(args.workspace, slug), "cut.proxy.mp4") }),
        );
        return;
      }
      // ── Provider-neutral storyboard compatibility API ────────────
      if (req.method === "GET" && p === "/api/storyboard/projects") {
        const snaps = args.slugs.map((s) => ({
          manifest: JSON.parse(
            readFileSync(join(jobDir(args.workspace, s), "manifest.json"), "utf-8"),
          ) as Manifest,
          entries: (
            JSON.parse(readFileSync(join(jobDir(args.workspace, s), "edl.json"), "utf-8")) as {
              entries: EdlEntry[];
            }
          ).entries,
        }));
        const combined = jobsToProject(snaps, {
          projectId: `notes-edit-merged-${args.slugs.join("+")}`,
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ projects: [combined] }));
        return;
      }
      if (req.method === "PUT" && p === "/api/storyboard/projects") {
        const body = JSON.parse(await readBody(req)) as { project: StoryboardProject };
        const snaps = args.slugs.map((s) => ({
          manifest: JSON.parse(
            readFileSync(join(jobDir(args.workspace, s), "manifest.json"), "utf-8"),
          ) as Manifest,
          entries: (
            JSON.parse(readFileSync(join(jobDir(args.workspace, s), "edl.json"), "utf-8")) as {
              entries: EdlEntry[];
            }
          ).entries,
        }));
        const updates = applyProjectEditsToEdls(body.project, snaps);
        for (const u of updates) writeEdl(args.workspace, u.slug, u.entries);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, updated: updates.map((u) => u.slug) }));
        return;
      }

      if (req.method === "POST" && p === "/api/combine") {
        await combineCuts(args.workspace, args.slugs, combinedOut);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, output: combinedOut }));
        return;
      }

      const thumbMatch = /^\/thumb\/(.+)\/(\d+)\.jpg$/.exec(p);
      if (req.method === "GET" && thumbMatch) {
        const slug = decodeURIComponent(thumbMatch[1]);
        const idx = parseInt(thumbMatch[2], 10);
        const at = parseFloat(url.searchParams.get("t") ?? "0");
        try {
          const path = await ensureThumb(args.workspace, slug, idx, at);
          serveFileRange(req, res, path, "image/jpeg");
        } catch (err) {
          res.writeHead(500).end(String(err));
        }
        return;
      }
      const proxyMatch = /^\/proxy\/(.+)\.mp4$/.exec(p);
      if (req.method === "GET" && proxyMatch) {
        const slug = decodeURIComponent(proxyMatch[1]);
        serveFileRange(req, res, join(jobDir(args.workspace, slug), "proxy.mp4"), "video/mp4");
        return;
      }
      const cutMatch = /^\/cut\/(.+)\.mp4$/.exec(p);
      if (req.method === "GET" && cutMatch) {
        const slug = decodeURIComponent(cutMatch[1]);
        serveFileRange(req, res, join(jobDir(args.workspace, slug), "cut.proxy.mp4"), "video/mp4");
        return;
      }
      if (req.method === "GET" && p === "/combined.mp4") {
        serveFileRange(req, res, combinedOut, "video/mp4");
        return;
      }
      if (req.method === "GET" && p === "/raw.mp4") {
        // Build (or refresh) the merged raw proxy on demand, then serve.
        await combineRawProxies(args.workspace, args.slugs, combinedRawOut);
        serveFileRange(req, res, combinedRawOut, "video/mp4");
        return;
      }

      res.writeHead(404).end("not found");
    } catch (err) {
      const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(msg);
    }
  });

  server.listen(args.port, () => {
    console.log(`notes-edit UI: http://localhost:${args.port}  (jobs: ${args.slugs.join(", ")})`);
  });
}

// ── HTML ─────────────────────────────────────────────────────────────

function renderHtml(slugs: string[]): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>notes-edit · merged (${slugs.join(" + ")})</title>
<style>
  :root { color-scheme: dark; --bg:#0a0a0a; --pane:#171717; --pane2:#0f0f0f; --border:#262626; --muted:#737373; --text:#fafafa; --accent:#f59e0b; --accent2:#fbbf24; --keep:#10b981; --drop:#ef4444; --warn:#fbbf24; }
  * { box-sizing: border-box; }
  body { margin:0; font: 13px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,Inter,system-ui,sans-serif; background:var(--bg); color:var(--text); overflow:hidden; }
  .topbar { display:flex; align-items:center; gap:14px; padding:8px 16px; background:var(--pane); border-bottom:1px solid var(--border); }
  .topbar .logo { font-size:13px; font-weight:600; letter-spacing:.3px; color:var(--muted); }
  .bigcut { display:flex; align-items:baseline; gap:10px; }
  .bigcut .lbl { font-size:10px; letter-spacing:1.5px; color:var(--accent); text-transform:uppercase; font-weight:700; }
  .bigcut .val { font: 700 32px/1 ui-monospace,Menlo,monospace; color:var(--accent2); letter-spacing:-.5px; text-shadow:0 0 12px rgba(245,158,11,.3); }
  .bigcut .sub { display:flex; flex-direction:column; gap:1px; color:var(--muted); font-size:11px; }
  .bigcut .sub .raw { color:#525252; font: 11px ui-monospace,Menlo,monospace; }
  .bigcut .sub .save { color:var(--accent); font-weight:700; }
  .clipchips { display:flex; gap:4px; }
  .chip { padding:4px 9px; background:#1a2030; border:1px solid var(--border); border-radius:5px; cursor:pointer; color:var(--muted); font-size:11px; font-weight:500; }
  .chip.active { background:var(--accent); color:#fff; border-color:var(--accent); }
  .chip.dirty::after { content:"●"; color:var(--warn); margin-left:5px; }
  .spacer { flex:1; }
  .btn { background:#171717; color:var(--text); border:1px solid var(--border); padding:7px 13px; border-radius:6px; cursor:pointer; font:inherit; font-weight:500; }
  .btn:hover { background:#262626; border-color:#404040; }
  .btn.primary { background:var(--accent); border-color:var(--accent); color:#0a0a0a; font-weight:700; }
  .btn.primary:hover { background:var(--accent2); }
  .btn.success { background:#16a34a; border-color:#22c55e; color:#fff; font-weight:700; }
  .btn[disabled] { opacity:.4; cursor:not-allowed; }
  .speed-group { display:inline-flex; gap:2px; background:#171717; padding:2px; border-radius:6px; border:1px solid var(--border); }
  .speed-group button { padding:5px 9px; background:transparent; color:var(--muted); border:0; cursor:pointer; border-radius:4px; font:inherit; }
  .speed-group button.active { background:var(--accent); color:#0a0a0a; font-weight:700; }

  main { display:grid; grid-template-columns: 1fr 320px; grid-template-rows: 1fr; height:calc(100vh - 49px); }
  main.panel-hidden { grid-template-columns: 1fr 0; }
  main.panel-hidden aside { display:none; }
  .stage { display:grid; grid-template-rows: 1fr auto; min-height:0; background:#000; }
  .video-host { position:relative; background:#000; min-height:0; display:grid; place-items:center; }
  video { width:100%; height:100%; max-height:100%; object-fit:contain; background:#000; }
  .badge-mode { position:absolute; top:12px; left:14px; padding:5px 10px; background:rgba(0,0,0,.65); border-radius:4px; font-size:11px; letter-spacing:.5px; text-transform:uppercase; color:#cbd5e1; }
  .badge-time { position:absolute; bottom:12px; right:14px; padding:5px 10px; background:rgba(0,0,0,.65); border-radius:4px; font: 11px ui-monospace,Menlo,monospace; color:#fff; }

  .timeline { padding:10px 14px 14px; background:var(--pane); border-top:1px solid var(--border); }
  .ruler { display:flex; justify-content:space-between; font-size:11px; color:var(--muted); margin-bottom:4px; }
  .strip { position:relative; height:96px; background:#050505; border-radius:10px; overflow:hidden; cursor:pointer; border:1px solid var(--border); display:flex; align-items:stretch; gap:2px; padding:2px; }
  .clipdiv { position:absolute; top:-4px; bottom:-4px; width:1px; background:var(--accent); opacity:.6; z-index:6; pointer-events:none; box-shadow:0 0 6px rgba(245,158,11,.6); }
  .clipdiv::after { content:attr(data-label); position:absolute; top:-14px; left:4px; font:10px ui-monospace,Menlo,monospace; color:var(--accent); white-space:nowrap; }
  .seg { position:relative; background-size:cover; background-position:center; background-color:#0a0a0a; flex-shrink:0; min-width:6px; border-radius:6px; overflow:visible; transition:filter .15s, transform .12s, flex-grow .2s; }
  .seg::before { content:""; position:absolute; inset:0; border-radius:6px; background:linear-gradient(180deg, rgba(0,0,0,.05) 0%, rgba(0,0,0,.15) 60%, rgba(0,0,0,.75) 100%); transition:background .15s; }
  .seg.keep { box-shadow:inset 0 0 0 1px rgba(245,158,11,.30); }
  .seg.keep.past { box-shadow:inset 0 0 0 1px rgba(245,158,11,.55); }
  .seg.keep.active { box-shadow:inset 0 0 0 2px var(--accent), 0 0 14px rgba(245,158,11,.55); z-index:4; transform:translateY(-1px); }
  .seg.drop { background-color:#1a0a0a; min-width:10px; max-width:18px; flex-shrink:1; }
  .seg.drop::before { background:repeating-linear-gradient(45deg, rgba(239,68,68,.25) 0 4px, rgba(239,68,68,.5) 4px 8px); }
  .seg.drop .num, .seg.drop .dur, .seg.drop .text-mini { display:none; }
  .seg.drop .reason-icon { position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); color:#fca5a5; font:700 11px sans-serif; }
  .seg:hover { filter:brightness(1.15); z-index:3; }
  .seg .num { position:absolute; left:6px; top:6px; font:700 11px ui-monospace,Menlo,monospace; color:var(--accent2); background:rgba(0,0,0,.7); padding:1px 5px; border-radius:3px; z-index:2; }
  .seg .dur { position:absolute; right:6px; top:6px; font:600 10px ui-monospace,Menlo,monospace; color:#fff; background:rgba(0,0,0,.7); padding:1px 5px; border-radius:3px; z-index:2; }
  .seg .text-mini { position:absolute; left:6px; right:6px; bottom:6px; color:#fafafa; font:500 10px/1.2 system-ui; max-height:24px; overflow:hidden; text-overflow:ellipsis; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; z-index:2; text-shadow:0 1px 2px rgba(0,0,0,.9); }
  .handle { position:absolute; top:-2px; bottom:-2px; width:8px; cursor:ew-resize; background:transparent; z-index:5; }
  .handle.l { left:-4px; }
  .handle.r { right:-4px; }
  .seg:hover .handle::before, .handle.dragging::before { content:""; position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); width:3px; height:70%; background:var(--accent2); border-radius:2px; box-shadow:0 0 6px var(--accent); }
  body.dragging, body.dragging * { cursor:ew-resize !important; user-select:none; }
  .play-marker { position:absolute; top:-4px; bottom:-4px; width:2px; background:var(--accent2); pointer-events:none; box-shadow:0 0 10px var(--accent), 0 0 18px rgba(245,158,11,.55); z-index:7; }
  .stats { display:flex; gap:18px; font-size:11px; color:var(--muted); margin-top:8px; }
  .stats b { color:var(--text); font-weight:600; }

  aside { background:var(--pane); border-left:1px solid var(--border); display:grid; grid-template-rows:auto auto 1fr auto; min-height:0; }
  .side-head { padding:10px 14px; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center; }
  .side-head h2 { font-size:13px; margin:0; font-weight:600; }
  .side-head .hint { font-size:10px; color:var(--muted); }
  .filterbar { padding:8px 14px; border-bottom:1px solid var(--border); display:flex; gap:6px; flex-wrap:wrap; background:#0f0f0f; }
  .filterbar button { font-size:11px; padding:4px 9px; background:#171717; border:1px solid var(--border); color:var(--muted); border-radius:4px; cursor:pointer; }
  .filterbar button.on { background:var(--accent); color:#0a0a0a; border-color:var(--accent); font-weight:700; }
  .span-list { overflow:auto; padding:8px; display:flex; flex-direction:column; gap:6px; }
  .card { position:relative; display:grid; grid-template-columns:96px 1fr; gap:10px; padding:6px; background:#0f0f0f; border:1px solid var(--border); border-radius:8px; cursor:pointer; transition:border-color .12s, background .12s; align-items:center; }
  .card:hover { background:#1a1a1a; border-color:rgba(245,158,11,.45); }
  .card.active { background:#1f1407; border-color:var(--accent); box-shadow:0 0 0 1px var(--accent), 0 0 12px rgba(245,158,11,.25); }
  .card .thumb { position:relative; width:96px; height:54px; background-size:cover; background-position:center; background-color:#000; border-radius:5px; overflow:hidden; }
  .card.drop .thumb { background:repeating-linear-gradient(45deg, rgba(239,68,68,.2) 0 6px, rgba(239,68,68,.4) 6px 12px) #1a0a0a; }
  .card .thumb .num { position:absolute; top:2px; left:3px; background:rgba(0,0,0,.75); color:var(--accent2); font:700 9px ui-monospace,Menlo,monospace; padding:1px 4px; border-radius:3px; }
  .card .thumb .dur { position:absolute; bottom:2px; right:3px; background:rgba(0,0,0,.75); color:#fff; font:600 9px ui-monospace,Menlo,monospace; padding:1px 4px; border-radius:3px; }
  .card .body { min-width:0; }
  .card .text { color:#fafafa; font-size:12px; line-height:1.3; overflow:hidden; text-overflow:ellipsis; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; margin-bottom:2px; }
  .card.drop .text { text-decoration:line-through; color:#737373; }
  .card .meta { display:flex; gap:6px; align-items:center; font-size:10px; color:var(--muted); }
  .card .source { font:600 10px ui-monospace,Menlo,monospace; color:#a3a3a3; }
  .card .pill { font-size:9px; padding:1px 5px; border-radius:3px; font-weight:700; }
  .pill.keep { background:var(--accent); color:#0a0a0a; }
  .pill.drop { background:#7f1d1d; color:#fca5a5; }
  .status { padding:8px 14px; border-top:1px solid var(--border); font-size:11px; color:var(--muted); background:#0d1118; min-height:30px; }
  .status.ok { color:#34d399; }
  .status.err { color:#fca5a5; }
  .kbd { display:inline-block; padding:1px 5px; border-radius:3px; background:#1a2030; border:1px solid var(--border); font: 10px ui-monospace,Menlo,monospace; color:var(--muted); margin:0 2px; }
  .empty { padding:30px; text-align:center; color:var(--muted); }
</style>
</head>
<body>
<div class="topbar">
  <span class="logo">📼 notes-edit</span>
  <span class="bigcut">
    <span class="lbl">Cut</span>
    <span class="val" id="cutBig">0:00.00</span>
    <span class="sub">
      <span class="raw">raw <span id="rawSmall">0:00.00</span></span>
      <span class="save" id="saveTxt">— saved</span>
    </span>
  </span>
  <span style="color:var(--muted);font-size:11px" id="chipsHint">— ${slugs.length} source clip${slugs.length === 1 ? "" : "s"} merged into one timeline</span>
  <span class="spacer"></span>
  <span class="speed-group" id="speed">
    <button data-s="0.5">0.5×</button>
    <button data-s="1" class="active">1×</button>
    <button data-s="1.5">1.5×</button>
    <button data-s="2">2×</button>
    <button data-s="4">4×</button>
  </span>
  <span style="color:var(--muted);font-size:11px">
    <span class="kbd">Space</span> play
    <span class="kbd">K</span> flip
    <span class="kbd">J</span>/<span class="kbd">L</span> ±2s
    <span class="kbd">U</span> undo
  </span>
  <button class="btn" id="panelBtn" title="Toggle scene list">☰ Scenes</button>
  <button class="btn" id="modeBtn" title="Toggle cut vs raw playback">CUT</button>
  <button class="btn" id="previewBtn">↻ Re-preview clip</button>
  <button class="btn primary" id="saveBtn">Save</button>
  <button class="btn success" id="combineBtn" title="Concat all per-clip previews into combined.proxy.mp4">⏵ Combine all</button>
</div>
<main>
  <section class="stage">
    <div class="video-host">
      <video id="vid" preload="auto" controls></video>
      <div class="badge-mode" id="badgeMode">CUT MODE</div>
      <div class="badge-time" id="badgeTime">00:00.00 / 00:00.00</div>
    </div>
    <div class="timeline">
      <div class="ruler">
        <span>0:00</span>
        <span style="margin:0 auto; color:var(--accent); font-weight:600">CUT TIMELINE — drops collapsed</span>
        <span id="rulerEnd">—</span>
      </div>
      <div class="strip" id="strip"></div>
      <div class="stats">
        <span><b id="keepN">0</b> keeps · <b id="dropN">0</b> drops across <b id="nClips">${slugs.length}</b> clips</span>
        <span style="margin-left:auto; color:var(--muted)">click strip → seek · click row → flip · shift+click row → seek in raw · 1/2/3 = next clip</span>
      </div>
    </div>
  </section>
  <aside>
    <div class="side-head">
      <h2 id="sideTitle">Spans</h2>
      <span class="hint" id="sideHint">—</span>
    </div>
    <div class="filterbar" id="filters">
      <button data-f="all" class="on">All</button>
      <button data-f="keep">Keeps</button>
      <button data-f="drop">Drops</button>
      <button data-f="filler">Fillers</button>
      <button data-f="silence">Silence</button>
      <button data-f="repeat">Repeats</button>
    </div>
    <div class="span-list" id="rows"></div>
    <div class="status" id="status">ready</div>
  </aside>
</main>
<script>
const vid = document.getElementById('vid');
const stripEl = document.getElementById('strip');
const rowsEl = document.getElementById('rows');
const statusEl = document.getElementById('status');
const badgeMode = document.getElementById('badgeMode');
const badgeTime = document.getElementById('badgeTime');
const modeBtn = document.getElementById('modeBtn');

let jobs = [];                  // [{slug, inputName, durationSec, edl, dirty, offset}]
let mode = 'cut';               // 'cut' | 'raw'
let filter = 'all';
let undoStack = [];
let mergedSpans = [];           // [{ci, i, globalStart, globalEnd, e}]
let totalRaw = 0;

function fmt(t) {
  if (!isFinite(t) || t < 0) return '0:00.00';
  const m = Math.floor(t/60), s = t - m*60;
  return m + ':' + s.toFixed(2).padStart(5,'0');
}
function fmtBig(t) {
  if (!isFinite(t) || t < 0) return '0:00';
  const h = Math.floor(t/3600), m = Math.floor((t%3600)/60), s = Math.floor(t%60);
  return (h ? h+':'+String(m).padStart(2,'0') : m) + ':' + String(s).padStart(2,'0');
}
function setStatus(msg, cls) {
  statusEl.className = 'status' + (cls?' '+cls:'');
  statusEl.textContent = msg;
}

async function load() {
  const j = await fetch('/api/jobs').then(r=>r.json());
  jobs = j.jobs.map(x => ({...x, dirty:false, offset:0}));
  recomputeOffsets();
  setStatus('stitching raw proxies into one timeline…');
  vid.src = '/raw.mp4';
  vid.addEventListener('loadedmetadata', () => setStatus('ready · merged timeline loaded', 'ok'), { once: true });
  vid.addEventListener('error', () => setStatus('failed to load /raw.mp4 — check server log', 'err'), { once: true });
  vid.load();
  renderTimeline();
}

function recomputeOffsets() {
  let acc = 0;
  totalRaw = 0;
  for (const j of jobs) {
    j.offset = acc;
    acc += j.durationSec || 0;
    totalRaw += j.durationSec || 0;
  }
  mergedSpans = [];
  jobs.forEach((j, ci) => {
    j.edl.entries.forEach((e, i) => {
      mergedSpans.push({
        ci, i, e,
        globalStart: j.offset + e.start,
        globalEnd:   j.offset + e.end,
      });
    });
  });
  mergedSpans.sort((a,b) => a.globalStart - b.globalStart);
}

function renderChips() { /* no-op in merged mode */ }

function globalTime() { return vid.currentTime; }
function seekToGlobal(gt) { vid.currentTime = Math.max(0, Math.min(gt, totalRaw - 0.05)); }

function renderTimeline() {
  document.getElementById('rulerEnd').textContent = fmtBig(totalCutDur());
  // strip — flex-grow layout: keeps scale to their duration as a share of CUT
  // time (so the cut is the dominant timeline); drops collapse to thin
  // indicators between scenes.
  const sceneNumByCi = {};
  mergedSpans.forEach(ms => {
    if (ms.e.action !== 'keep') return;
    sceneNumByCi[ms.ci] = (sceneNumByCi[ms.ci] || 0);
    ms._sceneIdx = sceneNumByCi[ms.ci]++;
  });
  const cutDur = mergedSpans.filter(ms=>ms.e.action==='keep')
    .reduce((a,ms)=>a+(ms.globalEnd-ms.globalStart),0) || 1;
  const reasonGlyph = { filler: 'um', silence: '·', repeat: '↻', manual: '×' };
  let html = mergedSpans.map((ms,gi) => {
    const isKeep = ms.e.action === 'keep';
    // flex-grow proportional to share of CUT duration; drops grow 0 so they
    // stay at the min-width (~12px), giving keeps the visual hero treatment.
    const grow = isKeep ? ((ms.e.end - ms.e.start) / cutDur * 100).toFixed(3) : '0';
    const mid = (ms.e.start + (ms.e.end - ms.e.start)/2).toFixed(2);
    const thumb = isKeep
      ? 'background-image:url(/thumb/' + jobs[ms.ci].slug + '/' + ms._sceneIdx + '.jpg?t=' + mid + ')'
      : '';
    const num = isKeep ? '#' + (ms._sceneIdx+1) : '';
    const dur = (ms.e.end - ms.e.start).toFixed(1) + 's';
    const textMini = isKeep && ms.e.text ? '<span class="text-mini">' + ms.e.text.replace(/</g,'&lt;') + '</span>' : '';
    const dropIcon = !isKeep ? '<span class="reason-icon">' + (reasonGlyph[ms.e.reason]||'·') + '</span>' : '';
    return '<div class="seg ' + (isKeep?'keep':'drop') + '" data-gi="' + gi +
      '" style="flex-grow:' + grow + ';' + thumb + '" title="[' +
      jobs[ms.ci].slug + '] ' + fmt(ms.e.start) + '-' + fmt(ms.e.end) + ' · ' + ms.e.action +
      (ms.e.reason ? ' · ' + ms.e.reason : '') +
      (ms.e.text ? ' · ' + ms.e.text.replace(/"/g,'&quot;').slice(0,80) : '') +
      '">' +
      (num ? '<span class="num">' + num + '</span>' : '') +
      (isKeep ? '<span class="dur">' + dur + '</span>' : '') +
      textMini + dropIcon +
      '<span class="handle l" data-gi="' + gi + '" data-side="l"></span>' +
      '<span class="handle r" data-gi="' + gi + '" data-side="r"></span></div>';
  }).join('');
  stripEl.innerHTML = html + '<div class="play-marker" id="marker" style="left:0%"></div>';
  stripEl.querySelectorAll('.seg').forEach(el => {
    el.onclick = (ev) => {
      if (ev.target.classList.contains('handle')) return; // drag, not seek
      ev.stopPropagation();
      const ms = mergedSpans[+el.dataset.gi];
      mode = 'raw';
      modeBtn.textContent = 'RAW';
      badgeMode.textContent = 'RAW MODE';
      seekToGlobal(ms.globalStart + 0.05);
      setTimeout(()=>vid.play(), 60);
    };
  });
  // Drag-to-trim — each handle resizes its edge, clamped to neighbors.
  stripEl.querySelectorAll('.handle').forEach(h => {
    h.addEventListener('pointerdown', startHandleDrag);
  });
  // Click on bg seeks by CUT-time fraction (strip is cut-scaled)
  stripEl.onclick = (ev) => {
    if (ev.target.closest('.seg')) return;
    const rect = stripEl.getBoundingClientRect();
    const frac = (ev.clientX - rect.left) / rect.width;
    seekToCutFraction(frac);
  };

  // rows — merged
  const filtered = mergedSpans.map((ms,gi)=>({ms,gi})).filter(({ms}) => {
    const e = ms.e;
    if (filter==='all') return true;
    if (filter==='keep') return e.action==='keep';
    if (filter==='drop') return e.action==='drop';
    return e.reason === filter;
  });
  if (!filtered.length) {
    rowsEl.innerHTML = '<div class="empty">No spans match this filter.</div>';
  } else {
    rowsEl.innerHTML = filtered.map(({ms,gi}) => {
      const e = ms.e;
      const text = (e.text||'').replace(/</g,'&lt;');
      const mid = (e.start + (e.end - e.start)/2).toFixed(2);
      const thumb = e.action === 'keep'
        ? 'background-image:url(/thumb/' + jobs[ms.ci].slug + '/' + ms._sceneIdx + '.jpg?t=' + mid + ')'
        : '';
      const num = e.action === 'keep' ? '#' + (ms._sceneIdx+1) : '✕';
      const dur = (e.end - e.start).toFixed(1) + 's';
      return '<div class="card ' + (e.action==='keep'?'keep':'drop') + '" data-gi="' + gi + '">' +
        '<div class="thumb" style="' + thumb + '">' +
          '<span class="num">' + num + '</span>' +
          '<span class="dur">' + dur + '</span>' +
        '</div>' +
        '<div class="body">' +
          '<div class="text">' + (text || (e.reason ? '[' + e.reason + ']' : '(no transcript)')) + '</div>' +
          '<div class="meta">' +
            '<span class="source">' + jobs[ms.ci].slug.replace('clip-','c') + ' ' + fmt(e.start) + '</span>' +
            '<span class="pill ' + e.action + '">' + (e.action==='keep'?'KEEP':'DROP') + '</span>' +
          '</div>' +
        '</div>' +
        '</div>';
    }).join('');
    rowsEl.querySelectorAll('.card').forEach(el => {
      el.onclick = (ev) => {
        const gi = +el.dataset.gi;
        if (ev.shiftKey) {
          mode='raw'; modeBtn.textContent='RAW'; badgeMode.textContent='RAW MODE';
          seekToGlobal(mergedSpans[gi].globalStart + 0.05);
          setTimeout(()=>vid.play(), 60);
        } else {
          flipSpan(gi);
        }
      };
    });
  }
  // stats — cut prominent, raw small
  const keepDur = mergedSpans.filter(ms=>ms.e.action==='keep')
    .reduce((a,ms)=>a+(ms.globalEnd-ms.globalStart),0);
  const keepN = mergedSpans.filter(ms=>ms.e.action==='keep').length;
  const dropN = mergedSpans.length - keepN;
  const savePct = totalRaw ? Math.round((1 - keepDur/totalRaw)*100) : 0;
  document.getElementById('cutBig').textContent = fmtBig(keepDur);
  document.getElementById('rawSmall').textContent = fmtBig(totalRaw);
  document.getElementById('saveTxt').textContent = '−' + savePct + '% saved';
  document.getElementById('keepN').textContent = keepN;
  document.getElementById('dropN').textContent = dropN;
}

function findGlobalIdx(gt) {
  // Binary-search would be nice; linear is fine at this scale.
  return mergedSpans.findIndex(ms => gt >= ms.globalStart && gt < ms.globalEnd);
}

function flipSpan(gi) {
  const ms = mergedSpans[gi];
  undoStack.push({ci: ms.ci, i: ms.i, prev: ms.e.action});
  if (undoStack.length > 100) undoStack.shift();
  ms.e.action = ms.e.action === 'keep' ? 'drop' : 'keep';
  jobs[ms.ci].dirty = true;
  renderChips();
  renderTimeline();
}

// ── Drag-to-trim ─────────────────────────────────────────────────────
function startHandleDrag(ev) {
  ev.preventDefault();
  ev.stopPropagation();
  const handle = ev.currentTarget;
  const gi = +handle.dataset.gi;
  const side = handle.dataset.side;                  // 'l' | 'r'
  const ms = mergedSpans[gi];
  const rect = stripEl.getBoundingClientRect();
  const job = jobs[ms.ci];
  const original = side === 'l' ? ms.e.start : ms.e.end;
  // Clamp range: keep adjacent neighbors intact (within same clip).
  const prev = mergedSpans[gi-1];
  const next = mergedSpans[gi+1];
  const minLocal = side === 'l'
    ? (prev && prev.ci === ms.ci ? prev.e.end + 0.02 : 0)
    : ms.e.start + 0.05;
  const maxLocal = side === 'l'
    ? ms.e.end - 0.05
    : (next && next.ci === ms.ci ? next.e.start - 0.02 : (job.durationSec || ms.e.end + 60));

  document.body.classList.add('dragging');
  handle.classList.add('dragging');

  function pxToLocal(clientX) {
    const frac = (clientX - rect.left) / rect.width;
    const globalT = Math.max(0, Math.min(frac * totalRaw, totalRaw));
    return globalT - job.offset;
  }
  function onMove(e) {
    const want = pxToLocal(e.clientX);
    const clamped = Math.max(minLocal, Math.min(maxLocal, want));
    if (side === 'l') ms.e.start = clamped;
    else ms.e.end = clamped;
    // recompute global bounds of just this span
    ms.globalStart = job.offset + ms.e.start;
    ms.globalEnd   = job.offset + ms.e.end;
    // live restyle without full re-render
    const seg = stripEl.querySelector('.seg[data-gi="'+gi+'"]');
    if (seg) {
      seg.style.left = (ms.globalStart/totalRaw*100) + '%';
      seg.style.width = ((ms.globalEnd-ms.globalStart)/totalRaw*100) + '%';
    }
    // update tiny live readout in badge
    badgeTime.textContent = 'trim ' + ms.e.action + ' · ' + fmt(ms.e.start) + ' → ' + fmt(ms.e.end);
  }
  function onUp() {
    document.body.classList.remove('dragging');
    handle.classList.remove('dragging');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (Math.abs((side==='l'?ms.e.start:ms.e.end) - original) > 0.001) {
      undoStack.push({ci: ms.ci, i: ms.i, prev: {[side==='l'?'start':'end']: original}, kind:'trim'});
      if (undoStack.length > 100) undoStack.shift();
      job.dirty = true;
      renderTimeline();
    }
  }
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function undo() {
  const u = undoStack.pop();
  if (!u) return;
  const e = jobs[u.ci].edl.entries[u.i];
  if (u.kind === 'trim') {
    if (u.prev.start != null) e.start = u.prev.start;
    if (u.prev.end != null) e.end = u.prev.end;
  } else {
    e.action = u.prev;
  }
  jobs[u.ci].dirty = true;
  recomputeOffsets();
  renderTimeline();
}

function cumulativeCutBefore(gt) {
  let acc = 0;
  for (const ms of mergedSpans) {
    if (ms.e.action !== 'keep') continue;
    if (ms.globalEnd <= gt) acc += ms.globalEnd - ms.globalStart;
    else if (ms.globalStart < gt) { acc += gt - ms.globalStart; break; }
    else break;
  }
  return acc;
}
function totalCutDur() {
  let acc = 0;
  for (const ms of mergedSpans) if (ms.e.action === 'keep') acc += ms.globalEnd - ms.globalStart;
  return acc;
}
// Click→seek mapped from CUT-time strip fraction (0..1) back to global time
function seekToCutFraction(frac) {
  const target = frac * totalCutDur();
  let acc = 0;
  for (const ms of mergedSpans) {
    if (ms.e.action !== 'keep') continue;
    const d = ms.globalEnd - ms.globalStart;
    if (acc + d >= target) { seekToGlobal(ms.globalStart + (target - acc)); return; }
    acc += d;
  }
}

let lastActiveGi = -1;
function tick() {
  const gt = globalTime();
  const marker = document.getElementById('marker');
  if (marker) {
    // Strip is CUT-scaled, so playhead position = cumulative cut / total cut.
    const td = totalCutDur();
    const cumFrac = td ? (cumulativeCutBefore(gt) / td) * 100 : 0;
    marker.style.left = cumFrac + '%';
  }

  if (mode === 'cut') {
    badgeTime.textContent = 'cut ' + fmt(cumulativeCutBefore(gt)) + ' / ' + fmtBig(totalCutDur());
  } else {
    badgeTime.textContent = 'raw ' + fmt(gt) + ' / ' + fmtBig(totalRaw);
  }

  const gi = findGlobalIdx(gt);

  // Skip drops fast — before the human notices.
  if (mode === 'cut' && gi >= 0 && mergedSpans[gi].e.action === 'drop' && !vid.paused) {
    const nextKeep = mergedSpans.slice(gi+1).find(ms => ms.e.action === 'keep');
    if (nextKeep) {
      vid.currentTime = nextKeep.globalStart + 0.01;
    } else {
      vid.pause();
    }
  }

  if (gi !== lastActiveGi) {
    stripEl.querySelectorAll('.seg.active').forEach(el=>el.classList.remove('active'));
    rowsEl.querySelectorAll('.card.active').forEach(el=>el.classList.remove('active'));
    // Mark past segments with an amber trail behind the playhead.
    stripEl.querySelectorAll('.seg').forEach((el) => {
      const i = +el.dataset.gi;
      if (i < gi) el.classList.add('past'); else el.classList.remove('past');
    });
    if (gi >= 0) {
      const seg = stripEl.querySelector('.seg[data-gi="'+gi+'"]');
      if (seg) seg.classList.add('active');
      const row = rowsEl.querySelector('.card[data-gi="'+gi+'"]');
      if (row) {
        row.classList.add('active');
        const rRect = row.getBoundingClientRect();
        const lRect = rowsEl.getBoundingClientRect();
        if (rRect.top < lRect.top || rRect.bottom > lRect.bottom) {
          row.scrollIntoView({block:'nearest'});
        }
      }
    }
    lastActiveGi = gi;
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// rAF loop above handles everything; this listener is intentionally empty.
vid.addEventListener('timeupdate', () => { /* no-op */ });
/* legacy block kept disabled below
const _legacy = () => {
  const gt = globalTime();
  const marker = document.getElementById('marker');
  if (marker && totalRaw) marker.style.left = (gt/totalRaw*100) + '%';
  badgeTime.textContent = fmtBig(gt) + ' / ' + fmtBig(totalRaw);

  stripEl.querySelectorAll('.seg.active').forEach(el=>el.classList.remove('active'));
  rowsEl.querySelectorAll('.card.active').forEach(el=>el.classList.remove('active'));
  const gi = findGlobalIdx(gt);
  if (gi >= 0) {
    const seg = stripEl.querySelector('.seg[data-gi="'+gi+'"]');
    if (seg) seg.classList.add('active');
    const row = rowsEl.querySelector('.row[data-gi="'+gi+'"]');
    if (row) {
      row.classList.add('active');
      const rRect = row.getBoundingClientRect();
      const lRect = rowsEl.getBoundingClientRect();
      if (rRect.top < lRect.top || rRect.bottom > lRect.bottom) {
        row.scrollIntoView({block:'nearest'});
      }
    }
  }

  if (mode === 'cut' && gi >= 0 && mergedSpans[gi].e.action === 'drop') {
    const nextKeep = mergedSpans.slice(gi+1).find(ms => ms.e.action === 'keep' && ms.globalStart > gt);
    if (nextKeep) {
      seekToGlobal(nextKeep.globalStart + 0.02);
    } else {
      vid.pause();
    }
  }
};
*/


// Speed.
document.getElementById('speed').onclick = (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  document.querySelectorAll('#speed button').forEach(x=>x.classList.remove('active'));
  b.classList.add('active');
  vid.playbackRate = parseFloat(b.dataset.s);
};

document.getElementById('panelBtn').onclick = () => {
  document.querySelector('main').classList.toggle('panel-hidden');
};

modeBtn.onclick = () => {
  mode = mode === 'cut' ? 'raw' : 'cut';
  modeBtn.textContent = mode === 'cut' ? 'CUT' : 'RAW';
  badgeMode.textContent = mode === 'cut' ? 'CUT MODE' : 'RAW MODE';
};

// Filters.
document.getElementById('filters').onclick = (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  filter = b.dataset.f;
  document.querySelectorAll('#filters button').forEach(x=>x.classList.remove('on'));
  b.classList.add('on');
  renderTimeline();
};

document.getElementById('saveBtn').onclick = async () => {
  let saved = 0;
  for (const j of jobs) {
    if (!j.dirty) continue;
    const r = await fetch('/api/edl/' + encodeURIComponent(j.slug), {
      method:'PUT', headers:{'content-type':'application/json'},
      body: JSON.stringify({entries: j.edl.entries}),
    }).then(r=>r.json());
    if (r.ok) { j.dirty = false; saved++; }
  }
  renderChips();
  setStatus('saved ' + saved + ' edl' + (saved===1?'':'s'), 'ok');
};

document.getElementById('previewBtn').onclick = async () => {
  // Re-preview every dirty clip, then rebuild combined.proxy.mp4 and play it.
  const dirty = jobs.filter(j => j.dirty);
  const targets = dirty.length ? dirty : jobs;
  setStatus('rendering ' + targets.length + ' preview' + (targets.length===1?'':'s') + '…');
  try {
    for (const j of targets) {
      await fetch('/api/preview/' + encodeURIComponent(j.slug), {method:'POST'}).then(r=>r.json());
    }
    const c = await fetch('/api/combine', {method:'POST'}).then(r=>r.json());
    setStatus('combined preview: ' + c.output, 'ok');
    vid.src = '/combined.mp4?cb=' + Date.now();
    mode = 'raw'; modeBtn.textContent='RAW'; badgeMode.textContent='COMBINED PREVIEW (CUT)';
    vid.load(); vid.play();
  } catch (err) {
    setStatus('preview failed: ' + err.message, 'err');
  }
};

document.getElementById('combineBtn').onclick = async () => {
  setStatus('combining all per-clip previews…');
  try {
    const r = await fetch('/api/combine', {method:'POST'}).then(r=>r.json());
    setStatus('combined: ' + r.output, 'ok');
    vid.src = '/combined.mp4?cb=' + Date.now();
    badgeMode.textContent = 'COMBINED PREVIEW';
    vid.load(); vid.play();
  } catch (err) {
    setStatus('combine failed: ' + err.message, 'err');
  }
};

document.addEventListener('keydown', (ev) => {
  if (['INPUT','TEXTAREA','SELECT'].includes(ev.target.tagName)) return;
  if (ev.key === ' ') { ev.preventDefault(); vid.paused ? vid.play() : vid.pause(); }
  if (ev.key.toLowerCase() === 'j') vid.currentTime -= ev.shiftKey ? 10 : 2;
  if (ev.key.toLowerCase() === 'l') vid.currentTime += ev.shiftKey ? 10 : 2;
  if (ev.key.toLowerCase() === 'k') {
    const gi = findGlobalIdx(globalTime());
    if (gi >= 0) flipSpan(gi);
  }
  if (ev.key.toLowerCase() === 'u') undo();
  if (ev.key >= '1' && ev.key <= '9') {
    const i = parseInt(ev.key,10) - 1;
    if (i < jobs.length) seekToGlobal(jobs[i].offset + 0.05);
  }
});

load();
</script>
</body>
</html>`;
}

// ── entry ────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
startServer(args);
