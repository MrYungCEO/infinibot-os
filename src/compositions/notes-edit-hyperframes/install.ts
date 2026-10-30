/**
 * Install a notes-edit job as a Hyperframes Studio project.
 *
 * Output layout (under the Hyperframes studio's `data/projects/<slug>/`):
 *   index.html        — generated composition (one <video muted> + one
 *                       <audio> per source clip's cut, registers
 *                       window.__timelines["root"])
 *   build.mjs         — generator copied alongside so the project is
 *                       self-regenerable
 *   <slug>-cut.mp4    — symlink to each clip's cut.proxy.mp4
 *   merged-audio.m4a  — concat of every clip's audio (used as audio-src
 *                       fallback by the studio's audio shim)
 *
 * Defaults
 *   workspace:        ${HOME}/Infini/.notes-edit
 *   studioProjectsDir ${HYPERFRAMES_DIR}/packages/studio/data/projects
 *                     (set HYPERFRAMES_DIR or pass studioProjectsDir)
 *
 * The project id is fixed at "notes-edit" so the studio URL is stable:
 *   http://localhost:5190/#projectId=notes-edit
 */

import { spawnSync, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface InstallOptions {
  workspace?: string;
  studioProjectsDir?: string;
  projectId?: string;
  /** When true, regenerate merged-audio.m4a even if it already exists. */
  rebuildAudio?: boolean;
}

export interface InstallResult {
  projectDir: string;
  projectId: string;
  studioUrl: string;
  sourceClipCount: number;
  cutDurationSec: number;
}

const DEFAULT_WORKSPACE =
  process.env.NOTES_EDIT_WORKSPACE ?? join(homedir(), "Infini", ".notes-edit");
const DEFAULT_HYPERFRAMES_DIR = process.env.HYPERFRAMES_DIR?.trim() || null;
const STUDIO_DEFAULT_URL_BASE = process.env.HYPERFRAMES_STUDIO_URL ?? "http://localhost:5190";

const HERE = dirname(fileURLToPath(import.meta.url));

export async function installHyperframesProject(opts: InstallOptions = {}): Promise<InstallResult> {
  const workspace = resolve(opts.workspace ?? DEFAULT_WORKSPACE);
  const studioProjectsDir =
    opts.studioProjectsDir ??
    (DEFAULT_HYPERFRAMES_DIR
      ? join(DEFAULT_HYPERFRAMES_DIR, "packages/studio/data/projects")
      : null);
  if (!studioProjectsDir) {
    throw new Error("Set HYPERFRAMES_DIR or pass studioProjectsDir");
  }
  const projectId = opts.projectId ?? "notes-edit";
  const projectDir = join(studioProjectsDir, projectId);
  mkdirSync(projectDir, { recursive: true });

  // Discover source clips from the workspace.
  const jobsDir = join(workspace, "jobs");
  if (!existsSync(jobsDir)) {
    throw new Error(`notes-edit workspace not found: ${jobsDir}`);
  }
  const slugs = readdirSync(jobsDir)
    .filter((s) => existsSync(join(jobsDir, s, "manifest.json")))
    .sort();
  if (!slugs.length) throw new Error("No jobs in workspace");

  // Symlink each clip's cut.proxy.mp4 into the project as <slug>-cut.mp4.
  const cutPaths: string[] = [];
  for (const slug of slugs) {
    const src = join(jobsDir, slug, "proxy.mp4");
    if (!existsSync(src)) {
      console.warn(`Skipping ${slug}: proxy.mp4 missing (run notes-edit step ${slug} proxy)`);
      continue;
    }
    const dst = join(projectDir, `${slug}-source.mp4`);
    if (existsSync(dst)) unlinkSync(dst);
    symlinkSync(src, dst);
    cutPaths.push(src);
  }
  if (!cutPaths.length) {
    throw new Error("No cut.proxy.mp4 files found — run the preview step first");
  }

  // Concat audio for the shim.
  const mergedAudio = join(projectDir, "merged-audio.m4a");
  if (opts.rebuildAudio || !existsSync(mergedAudio)) {
    await concatAudio(cutPaths, mergedAudio);
  }

  // Copy the build script alongside the project so it's self-regenerable.
  copyFileSync(join(HERE, "build.mjs"), join(projectDir, "build.mjs"));

  // Run the generator to write index.html.
  const r = spawnSync("node", [join(projectDir, "build.mjs")], {
    cwd: projectDir,
    env: { ...process.env, NOTES_EDIT_WORKSPACE: workspace },
    encoding: "utf-8",
  });
  if (r.status !== 0) {
    throw new Error(`build.mjs failed: ${r.stderr || r.stdout}`);
  }

  // Read the cut duration from the rendered index.html. The generator
  // prints `<X> source clips, <Y>s total cut`.
  const m = /([\d.]+)s total cut/.exec(r.stdout);
  const cutDurationSec = m ? parseFloat(m[1]) : 0;

  return {
    projectDir,
    projectId,
    studioUrl: `${STUDIO_DEFAULT_URL_BASE}/#projectId=${projectId}`,
    sourceClipCount: cutPaths.length,
    cutDurationSec,
  };
}

async function concatAudio(parts: string[], out: string): Promise<void> {
  const work = join(tmpdir(), `notes-hf-audio-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  const list = join(work, "concat.txt");
  writeFileSync(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
  await new Promise<void>((resolveP, reject) => {
    const proc = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        list,
        "-vn",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        out,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let err = "";
    proc.stderr.on("data", (c) => (err += c.toString()));
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 ? resolveP() : reject(new Error(`ffmpeg ${code}: ${err.slice(-400)}`)),
    );
  });
}

// ── CLI ──────────────────────────────────────────────────────────────
//
//   bun src/compositions/notes-edit-hyperframes/install.ts \
//     [--workspace DIR] [--studio-projects-dir DIR] [--project-id ID]
//     [--rebuild-audio]
//
const isDirect = import.meta.url === `file://${process.argv[1]}`;
if (isDirect) {
  const argv = process.argv.slice(2);
  const opts: InstallOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--workspace") opts.workspace = argv[++i];
    else if (a === "--studio-projects-dir") opts.studioProjectsDir = argv[++i];
    else if (a === "--project-id") opts.projectId = argv[++i];
    else if (a === "--rebuild-audio") opts.rebuildAudio = true;
  }
  installHyperframesProject(opts)
    .then((r) => {
      console.log(`Installed '${r.projectId}' → ${r.projectDir}`);
      console.log(`  ${r.sourceClipCount} source clips, ${r.cutDurationSec.toFixed(2)}s cut`);
      console.log(`  Open: ${r.studioUrl}`);
    })
    .catch((err) => {
      console.error(err.stack ?? err.message ?? err);
      process.exit(1);
    });
}
