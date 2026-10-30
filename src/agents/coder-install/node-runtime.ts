/**
 * The Node.js + npm that coder installs run on.
 *
 * npm-based coders (Claude Code, Codex, Gemini CLI, …) need a real `node` and
 * npm's `npm-cli.js`. Where that comes from, in order:
 *
 *   1. gateway  The gateway itself runs on Node with npm beside it (npm / web
 *               install). Same as before.
 *   2. managed  A private portable Node that InfiniBot downloaded earlier into
 *               `<coders root>/.node/` (desktop app on a machine without Node).
 *   3. system   A Node 20+ on PATH that has npm-cli.js next to it. npm is run
 *               as `node npm-cli.js`, never through `npm.cmd`, so Windows'
 *               .cmd spawn rule (EINVAL since CVE-2024-27980) never applies.
 *   4. none     → ensureNodeRuntime() downloads the official Node build from
 *               nodejs.org (SHA-256 checked against SHASUMS256.txt) into the
 *               managed dir and uses that.
 *
 * The desktop app runs the gateway on the Electron executable with
 * ELECTRON_RUN_AS_NODE=1. That executable is never used for coders: launcher
 * shims and install children get a scrubbed env without ELECTRON_RUN_AS_NODE,
 * so it would start the desktop GUI instead of node (on an AppImage it also
 * lives in a temporary mount that changes every launch).
 *
 * INFINIBOT_CODERS_NODE=managed skips 1 and 3 (always InfiniBot's own Node);
 * =system skips 2 and 4's download. Default: auto.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { resolveBin } from "../coder-backend/bin-detect.js";
import { codersRoot, isInside } from "./paths.js";

/** Major version of the private Node InfiniBot downloads. */
export const MANAGED_NODE_MAJOR = 22;
/** Used when nodejs.org/dist/index.json can't be read. */
export const MANAGED_NODE_FALLBACK_VERSION = "v22.23.3";
/** Oldest system Node we run coders on (Gemini CLI needs 20). */
export const MIN_SYSTEM_NODE_MAJOR = 20;

export type NodeRuntimeSource = "gateway" | "managed" | "system";

export interface NodeRuntime {
  /** Absolute path of a real node binary (never the Electron app). */
  node: string;
  /** Absolute path of npm's npm-cli.js for that node. */
  npmCli: string;
  source: NodeRuntimeSource;
  version: string;
}

export interface RuntimeProbe {
  platform: NodeJS.Platform;
  arch: string;
  execPath: string;
  /** process.versions: `electron` set means the gateway runs on Electron. */
  versions: Partial<Record<string, string>>;
  env: NodeJS.ProcessEnv;
  exists: (p: string) => boolean;
  /** which-like lookup (the gateway's enriched PATH). */
  which: (bin: string) => string | undefined;
  /** `node --version` of a binary, or null when it doesn't run. */
  nodeVersion: (node: string) => string | null;
  realpath: (p: string) => string;
}

const versionCache = new Map<string, string | null>();

function probeNodeVersion(node: string): string | null {
  if (versionCache.has(node)) return versionCache.get(node) ?? null;
  let v: string | null = null;
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const r = spawnSync(node, ["--version"], {
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true,
      env,
    });
    const out = String(r.stdout ?? "").trim();
    v = r.status === 0 && /^v\d+\.\d+\.\d+/.test(out) ? out : null;
  } catch {
    v = null;
  }
  versionCache.set(node, v);
  return v;
}

export function defaultProbe(env: NodeJS.ProcessEnv = process.env): RuntimeProbe {
  return {
    platform: process.platform,
    arch: process.arch,
    execPath: process.execPath,
    versions: process.versions as Partial<Record<string, string>>,
    env,
    exists: (p) => fs.existsSync(p),
    which: (bin) => resolveBin(bin),
    nodeVersion: probeNodeVersion,
    realpath: (p) => fs.realpathSync(p),
  };
}

function pathFor(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

/** npm-cli.js shipped with a node binary (official layouts for each OS). */
export function npmCliBeside(
  node: string,
  probe: Pick<RuntimeProbe, "platform" | "exists">,
): string | null {
  const p = pathFor(probe.platform);
  const dir = p.dirname(node);
  const candidates = [
    p.join(dir, "node_modules", "npm", "bin", "npm-cli.js"), // Windows zip / installer
    p.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"), // Unix tarball
  ];
  for (const c of candidates) if (probe.exists(c)) return p.normalize(c);
  return null;
}

/** Directory holding the private Node downloads. */
export function managedNodeRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(codersRoot(env), ".node");
}

interface ManagedPointer {
  version: string;
  dir: string;
}

function readPointer(root: string): ManagedPointer | null {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(root, "runtime.json"), "utf8"),
    ) as ManagedPointer;
    return raw && typeof raw.dir === "string" && typeof raw.version === "string" ? raw : null;
  } catch {
    return null;
  }
}

function managedNodeBin(dir: string, platform: NodeJS.Platform): string {
  const p = pathFor(platform);
  return platform === "win32" ? p.join(dir, "node.exe") : p.join(dir, "bin", "node");
}

function runtimeMode(env: NodeJS.ProcessEnv): "auto" | "managed" | "system" {
  const v = env.INFINIBOT_CODERS_NODE?.trim().toLowerCase();
  return v === "managed" || v === "system" ? v : "auto";
}

function majorOf(version: string): number {
  return Number(/^v?(\d+)/.exec(version)?.[1] ?? 0);
}

/**
 * Find a usable node + npm without downloading anything. Pure apart from the
 * probe, so tests can play Windows, Electron and no-Node machines.
 */
export function findNodeRuntime(probe: RuntimeProbe = defaultProbe()): NodeRuntime | null {
  const onElectron = Boolean(probe.versions.electron);
  const mode = runtimeMode(probe.env);
  // 1. The gateway's own node (npm / web install).
  if (!onElectron && mode !== "managed") {
    const cli = npmCliBeside(probe.execPath, probe);
    if (cli) {
      return {
        node: probe.execPath,
        npmCli: cli,
        source: "gateway",
        version: probe.versions.node ? `v${probe.versions.node}` : "",
      };
    }
  }
  // 2. A private Node downloaded earlier.
  const root = managedNodeRoot(probe.env);
  const ptr = mode === "system" ? null : readPointer(root);
  if (ptr) {
    const dir = path.join(root, path.basename(ptr.dir));
    const node = managedNodeBin(dir, probe.platform);
    const cli = probe.exists(node) ? npmCliBeside(node, probe) : null;
    if (cli) return { node, npmCli: cli, source: "managed", version: ptr.version };
  }
  // 3. Node 20+ on PATH with npm next to it.
  const candidates: string[] = [];
  const onPath = mode === "managed" ? undefined : probe.which("node");
  if (onPath) candidates.push(onPath);
  // Unix: /usr/bin/npm is a symlink to …/lib/node_modules/npm/bin/npm-cli.js.
  for (const node of candidates) {
    if (node === probe.execPath && onElectron) continue;
    const version = probe.nodeVersion(node);
    if (!version || majorOf(version) < MIN_SYSTEM_NODE_MAJOR) continue;
    let cli = npmCliBeside(node, probe);
    if (!cli) {
      const npm = probe.which("npm");
      if (npm) {
        try {
          const real = probe.realpath(npm);
          if (/npm-cli\.js$/.test(real)) cli = real;
        } catch {
          /* dangling */
        }
      }
    }
    if (cli) return { node, npmCli: cli, source: "system", version };
  }
  return null;
}

// ── Download ───────────────────────────────────────────────────────────────

/** nodejs.org artifact for this OS/arch, or null when there is no build. */
export function nodeDistArtifact(
  version: string,
  platform: NodeJS.Platform,
  arch: string,
): { file: string; kind: "tar.gz" | "zip"; indexKey: string } | null {
  const a = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : null;
  if (!a) return null;
  if (platform === "win32") {
    return { file: `node-${version}-win-${a}.zip`, kind: "zip", indexKey: `win-${a}-zip` };
  }
  if (platform === "darwin") {
    return { file: `node-${version}-darwin-${a}.tar.gz`, kind: "tar.gz", indexKey: `osx-${a}-tar` };
  }
  if (platform === "linux") {
    return { file: `node-${version}-linux-${a}.tar.gz`, kind: "tar.gz", indexKey: `linux-${a}` };
  }
  return null;
}

function distBase(env: NodeJS.ProcessEnv): string {
  return (env.INFINIBOT_NODE_DIST_URL?.trim() || "https://nodejs.org/dist").replace(/\/+$/, "");
}

async function fetchOk(url: string, timeoutMs: number): Promise<Response> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return res;
}

/** Newest Node MANAGED_NODE_MAJOR.x that has a build for this platform. */
export async function pickNodeVersion(env: NodeJS.ProcessEnv, indexKey: string): Promise<string> {
  try {
    const res = await fetchOk(`${distBase(env)}/index.json`, 20_000);
    const list = (await res.json()) as Array<{ version: string; files?: string[] }>;
    const hit = list.find(
      (r) => majorOf(r.version) === MANAGED_NODE_MAJOR && (r.files ?? []).includes(indexKey),
    );
    if (hit) return hit.version;
  } catch {
    /* fall back to the pinned version */
  }
  return MANAGED_NODE_FALLBACK_VERSION;
}

/** Extract a zip (Windows Node build) into dest, dropping its top folder. */
async function extractZip(file: string, dest: string): Promise<void> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(await fsp.readFile(file));
  const entries = Object.values(zip.files);
  for (const e of entries) {
    const rel = e.name.split("/").slice(1).join("/");
    if (!rel) continue;
    const out = path.join(dest, ...rel.split("/"));
    if (!isInside(dest, out)) throw new Error(`unsafe path in archive: ${e.name}`);
    if (e.dir) {
      await fsp.mkdir(out, { recursive: true });
      continue;
    }
    await fsp.mkdir(path.dirname(out), { recursive: true });
    await fsp.writeFile(out, await e.async("nodebuffer"), {
      mode: (e.unixPermissions as number | null) ?? 0o644,
    });
  }
}

async function extractTarGz(file: string, dest: string): Promise<void> {
  const tar = await import("tar");
  await tar.x({ file, cwd: dest, strip: 1, preservePaths: false });
}

export interface EnsureRuntimeOpts {
  env?: NodeJS.ProcessEnv;
  probe?: RuntimeProbe;
  log?: (line: string) => void;
  /** Called when a download starts (installer job phase). */
  onDownload?: () => void;
}

let inflight: Promise<NodeRuntime> | null = null;

/**
 * A usable node + npm, downloading InfiniBot's private Node first when the
 * machine has none. Throws a plain-language Error when that isn't possible.
 */
export async function ensureNodeRuntime(opts: EnsureRuntimeOpts = {}): Promise<NodeRuntime> {
  const env = opts.env ?? process.env;
  const probe = opts.probe ?? defaultProbe(env);
  const found = findNodeRuntime(probe);
  if (found) return found;
  if (runtimeMode(env) === "system") {
    throw new Error(
      "Node.js 20 or newer wasn't found on this computer. Install it from https://nodejs.org, then click Try again.",
    );
  }
  if (!inflight) {
    inflight = downloadManagedNode(env, probe, opts).finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

async function downloadManagedNode(
  env: NodeJS.ProcessEnv,
  probe: RuntimeProbe,
  opts: EnsureRuntimeOpts,
): Promise<NodeRuntime> {
  const log = opts.log ?? (() => {});
  const probeArtifact = nodeDistArtifact("v0.0.0", probe.platform, probe.arch);
  if (!probeArtifact) {
    throw new Error(
      `InfiniBot can't set up Node.js on this computer (${probe.platform}-${probe.arch}) by itself. Install Node.js 20 or newer from https://nodejs.org, then click Try again.`,
    );
  }
  opts.onDownload?.();
  const version = await pickNodeVersion(env, probeArtifact.indexKey);
  const art = nodeDistArtifact(version, probe.platform, probe.arch)!;
  const base = `${distBase(env)}/${version}`;
  const root = managedNodeRoot(env);
  await fsp.mkdir(root, { recursive: true });
  const work = path.join(root, `.dl-${Date.now()}`);
  await fsp.mkdir(work, { recursive: true });
  try {
    log(`Downloading Node.js ${version} (needed once, about 30 MB)`);
    let sums: string;
    let body: Buffer;
    try {
      sums = await (await fetchOk(`${base}/SHASUMS256.txt`, 30_000)).text();
      body = Buffer.from(await (await fetchOk(`${base}/${art.file}`, 10 * 60_000)).arrayBuffer());
    } catch (err) {
      throw new Error(
        `InfiniBot couldn't download Node.js, which it needs to set this up (${(err as Error).message}). Check your internet connection and click Try again. Or install Node.js 20 or newer from https://nodejs.org and try again.`,
        { cause: err },
      );
    }
    const want = sums
      .split("\n")
      .map((l) => l.trim().split(/\s+/))
      .find((parts) => parts[1] === art.file)?.[0];
    const got = createHash("sha256").update(body).digest("hex");
    if (!want || want !== got) {
      throw new Error(
        `The Node.js download didn't match its published checksum, so InfiniBot didn't use it. Click Try again.`,
      );
    }
    const archive = path.join(work, art.file);
    await fsp.writeFile(archive, body);
    const staging = path.join(work, "x");
    await fsp.mkdir(staging, { recursive: true });
    log(`Unpacking Node.js ${version}`);
    if (art.kind === "zip") await extractZip(archive, staging);
    else await extractTarGz(archive, staging);
    const dirName = art.file.replace(/\.(zip|tar\.gz)$/, "");
    const final = path.join(root, dirName);
    const node = managedNodeBin(final, probe.platform);
    const stagedNode = managedNodeBin(staging, probe.platform);
    const v = probe.nodeVersion(stagedNode);
    if (!v) {
      throw new Error(
        `The downloaded Node.js didn't start on this computer. Install Node.js 20 or newer from https://nodejs.org and click Try again.`,
      );
    }
    if (fs.existsSync(final)) {
      if (!isInside(root, final)) throw new Error(`refusing to replace ${final}`);
      await fsp.rm(final, { recursive: true, force: true });
    }
    await fsp.rename(staging, final);
    versionCache.delete(node);
    await fsp.writeFile(
      path.join(root, "runtime.json"),
      JSON.stringify({ version, dir: dirName } satisfies ManagedPointer, null, 2),
    );
    const cli = npmCliBeside(node, { platform: probe.platform, exists: (p) => fs.existsSync(p) });
    if (!cli) throw new Error("The downloaded Node.js has no npm in it. Click Try again.");
    log(`Node.js ${v} ready`);
    return { node, npmCli: cli, source: "managed", version };
  } finally {
    if (isInside(root, work)) await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/** Test helper. */
export function _resetNodeRuntime(): void {
  versionCache.clear();
  inflight = null;
}
