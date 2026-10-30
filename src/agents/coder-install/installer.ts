/**
 * Coder install engine: install / update / uninstall a catalog coder into an
 * InfiniBot-managed prefix (see paths.ts for the layout and policy).
 *
 * Safety properties:
 *   - Only catalog ids are accepted; package specs come from the catalog.
 *   - Every child process is spawned with an argv array (no shell) and a
 *     scrubbed env: PATH/HOME/locale/proxy/CA vars only, so a package's install
 *     script never sees the gateway's API keys or tokens.
 *   - npm installs go into a fresh staging prefix and are swapped in only
 *     after the CLI's `--version` runs, so a failed update leaves the working
 *     install untouched. Every rm -rf is checked to be inside the coders root.
 *   - Output is ANSI-stripped and redacted before it is kept for the UI.
 *   - Jobs are plain promises: nothing keeps a timer or child alive after a
 *     job settles, so a hosted Machine can suspend once the install is done.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { resolveBin } from "../coder-backend/bin-detect.js";
import { spawnCli } from "../../process/win-spawn.js";
import {
  CODER_CATALOG,
  getCoderEntry,
  type CoderCatalogEntry,
  type CoderId,
  type CoderInstallMethod,
} from "./catalog.js";
import {
  codersBinDir,
  codersRoot,
  coderInstallPolicy,
  coderManifestPath,
  coderPrefix,
  isInside,
  npmCacheDir,
} from "./paths.js";
import {
  defaultProbe,
  ensureNodeRuntime,
  findNodeRuntime,
  nodeDistArtifact,
  type NodeRuntime,
  type RuntimeProbe,
} from "./node-runtime.js";
import { cleanLogText } from "./redact.js";

// ── Host prerequisites ─────────────────────────────────────────────────────

export interface NpmRunner {
  /** Executable to spawn (node, or an npm launcher). */
  command: string;
  /** argv prefix before the npm subcommand (e.g. [npm-cli.js]). */
  args: string[];
}

export interface HostTools {
  /** npm runnable right now (always `node npm-cli.js`, never npm.cmd). */
  npm: NpmRunner | null;
  uv: string | null;
  pipx: string | null;
  /** Absolute real-node binary used by launcher shims ("" when none yet). */
  node: string;
  nodeVersion: string;
  /**
   * No node + npm on this machine yet, but InfiniBot can download its private
   * Node for this OS (desktop app on a machine without Node.js).
   */
  canFetchNode?: boolean;
}

function runnerOf(rt: NodeRuntime): NpmRunner {
  return { command: rt.node, args: [rt.npmCli] };
}

/**
 * npm as `node npm-cli.js` on a real node: the gateway's own (npm install),
 * InfiniBot's private download, or Node 20+ on PATH. Never the desktop app's
 * Electron executable and never a bare `npm.cmd` (Windows refuses to spawn
 * .cmd files without a shell: EINVAL, which used to surface as "exit -1").
 */
export function detectNpm(probe: RuntimeProbe = defaultProbe()): NpmRunner | null {
  const rt = findNodeRuntime(probe);
  return rt ? runnerOf(rt) : null;
}

export function detectHostTools(probe: RuntimeProbe = defaultProbe()): HostTools {
  const rt = findNodeRuntime(probe);
  return {
    npm: rt ? runnerOf(rt) : null,
    uv: probe.which("uv") ?? null,
    pipx: probe.which("pipx") ?? null,
    node: rt?.node ?? "",
    nodeVersion: rt?.version ?? "",
    canFetchNode: !rt && Boolean(nodeDistArtifact("v0.0.0", probe.platform, probe.arch)),
  };
}

// ── Planner ────────────────────────────────────────────────────────────────

export type InstallPlan =
  | {
      ok: true;
      method: Exclude<CoderInstallMethod, { kind: "manual" }>;
      prefix: string;
      binDir: string;
    }
  | { ok: false; code: "MANUAL" | "MISSING_PREREQ" | "POLICY"; message: string; url?: string };

/**
 * Pick the first install method this host can run. Pure apart from the
 * policy/path lookups, so tests can drive it with fake HostTools.
 */
export function planInstall(
  entry: CoderCatalogEntry,
  host: Pick<HostTools, "npm" | "uv" | "pipx" | "canFetchNode">,
  env: NodeJS.ProcessEnv = process.env,
): InstallPlan {
  const policy = coderInstallPolicy(env);
  if (!policy.allowed) return { ok: false, code: "POLICY", message: policy.reason };
  const missing: string[] = [];
  let manual: Extract<CoderInstallMethod, { kind: "manual" }> | undefined;
  for (const m of entry.install) {
    if (m.kind === "manual") {
      manual = m;
      continue;
    }
    if (m.kind === "npm" && !host.npm && !host.canFetchNode) {
      missing.push("npm");
      continue;
    }
    if (m.kind === "uv" && !host.uv) {
      missing.push("uv");
      continue;
    }
    if (m.kind === "pipx" && !host.pipx) {
      missing.push("pipx");
      continue;
    }
    if (m.kind === "binary" && !m.platforms[`${process.platform}-${process.arch}`]) {
      // No build for this OS/arch: fall through to the manual entry.
      continue;
    }
    return { ok: true, method: m, prefix: coderPrefix(entry.id, env), binDir: codersBinDir(env) };
  }
  if (manual && missing.length === 0) {
    return { ok: false, code: "MANUAL", message: manual.reason, url: manual.url };
  }
  const need = [...new Set(missing)].join(" or ");
  return {
    ok: false,
    code: "MISSING_PREREQ",
    message:
      need === "npm"
        ? `${entry.name} needs Node.js, which isn't on this computer, and InfiniBot can't download it for this system. Install Node.js 20 or newer from https://nodejs.org, then click Try again.`
        : `${entry.name} installs with ${need}, which is not on this machine. Install uv (https://docs.astral.sh/uv/) and retry.`,
    url: manual?.url ?? entry.homepage,
  };
}

// ── Scrubbed child env ─────────────────────────────────────────────────────

const PASSTHROUGH_ENV = [
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SYSTEMROOT",
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "PATHEXT",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "npm_config_registry",
];

/**
 * Directory of the real node that coders run on, for PATH. Never the desktop
 * app's own directory: its executable is Electron, not node.
 */
function runtimeNodeDir(base: NodeJS.ProcessEnv): string | null {
  try {
    const rt = findNodeRuntime(defaultProbe(base));
    if (rt) return path.dirname(rt.node);
  } catch {
    /* fall through */
  }
  return process.versions.electron ? null : path.dirname(process.execPath);
}

/** Minimal env for install/version/login children: no gateway secrets. */
export function scrubbedEnv(
  extra: Record<string, string> = {},
  base = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of PASSTHROUGH_ENV) if (base[k] !== undefined) env[k] = base[k];
  const nodeDir = runtimeNodeDir(base);
  const sep = process.platform === "win32" ? ";" : ":";
  const sys = process.platform === "win32" ? [] : ["/usr/local/bin", "/usr/bin", "/bin"];
  env.PATH = [
    codersBinDir(base),
    ...(nodeDir ? [nodeDir] : []),
    ...(base.PATH ?? base.Path ?? "").split(sep).filter(Boolean),
    ...sys,
  ]
    .filter((d, i, a) => a.indexOf(d) === i)
    .join(sep);
  return { ...env, ...extra };
}

// ── Process runner ─────────────────────────────────────────────────────────

export interface RunResult {
  code: number | null;
  output: string;
  /** Set when the process never started (ENOENT, EINVAL, EACCES, …). */
  spawnError?: string;
  timedOut?: boolean;
}

export function runProcess(
  command: string,
  args: string[],
  opts: {
    cwd?: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    onLine?: (line: string) => void;
  },
): Promise<RunResult> {
  return new Promise((resolve) => {
    let output = "";
    let child;
    try {
      // spawnCli: a Windows .cmd shim runs via its real target (node.exe +
      // script, or the .exe) instead of failing with EINVAL; no shell.
      child = spawnCli(command, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      resolve({
        code: -1,
        output: `could not start ${path.basename(command)}: ${e.code ? `${e.code} ` : ""}${String(e.message ?? err)}`,
        spawnError: e.code ?? "SPAWN_FAILED",
      });
      return;
    }
    let pending = "";
    const onData = (buf: Buffer) => {
      const text = buf.toString("utf8");
      if (output.length < 256_000) output += text;
      pending += text;
      const lines = pending.split(/\r?\n|\r/);
      pending = lines.pop() ?? "";
      for (const l of lines) if (l.trim()) opts.onLine?.(l);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      opts.onLine?.(`timed out after ${Math.round(opts.timeoutMs / 1000)}s`);
    }, opts.timeoutMs);
    timer.unref?.();
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({
        code: -1,
        output: `${output}could not start ${path.basename(command)}: ${err.code ? `${err.code} ` : ""}${String(err.message)}`,
        spawnError: err.code ?? "SPAWN_FAILED",
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (pending.trim()) opts.onLine?.(pending);
      if (settled) return;
      settled = true;
      resolve({ code, output, timedOut });
    });
  });
}

// ── Manifest ───────────────────────────────────────────────────────────────

export interface InstallManifest {
  id: CoderId;
  method: "npm" | "uv" | "pipx" | "binary";
  package: string;
  /** Version reported by the package metadata. */
  version: string;
  /** First line of `<bin> --version`. */
  reportedVersion?: string;
  installedAt: string;
  /** Shims written into <root>/bin (names only). */
  shims: string[];
}

export function readManifest(
  id: CoderId,
  env: NodeJS.ProcessEnv = process.env,
): InstallManifest | null {
  try {
    const raw = JSON.parse(fs.readFileSync(coderManifestPath(id, env), "utf8")) as InstallManifest;
    return raw && raw.id === id ? raw : null;
  } catch {
    return null;
  }
}

// ── Shims ──────────────────────────────────────────────────────────────────

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** True when a file is a node script (shebang mentions node). */
function isNodeScript(file: string): boolean {
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(128);
    const n = fs.readSync(fd, buf, 0, 128, 0);
    fs.closeSync(fd);
    const head = buf.subarray(0, n).toString("utf8");
    return head.startsWith("#!") && /\bnode\b/.test(head.split("\n")[0] ?? "");
  } catch {
    return false;
  }
}

/**
 * Build the launcher shim for `target`. Node scripts run on the coder runtime's
 * real node (see node-runtime.ts: never the desktop app's Electron executable;
 * falls back to `node` on PATH if that node is later removed); native binaries
 * are exec'd directly. The node dir is put on PATH whenever there is one
 * because several CLIs spawn `node` themselves.
 */
export function buildShim(target: string, nodePath: string, platform = process.platform): string {
  const nodeScript = isNodeScript(target);
  if (platform === "win32") {
    // Our own .cmd shape: "<node.exe>" "<script>" %* — runProcess/spawnCli
    // read it back and spawn node.exe directly (no cmd.exe, no EINVAL).
    return nodeScript
      ? `@echo off\r\n"${nodePath || "node"}" "${target}" %*\r\n`
      : `@echo off\r\n"${target}" %*\r\n`;
  }
  const lines = [
    "#!/bin/sh",
    "# Managed by InfiniBot (Setup › Coders). Regenerated on install/update.",
  ];
  if (nodePath) {
    lines.push(`NODE_BIN=${shellQuote(nodePath)}`);
    lines.push(`PATH="$(dirname "$NODE_BIN"):$PATH"; export PATH`);
  }
  if (nodeScript) {
    if (nodePath) {
      lines.push(`[ -x "$NODE_BIN" ] || NODE_BIN=node`);
      lines.push(`exec "$NODE_BIN" ${shellQuote(target)} "$@"`);
    } else {
      lines.push(`exec node ${shellQuote(target)} "$@"`);
    }
  } else {
    lines.push(`exec ${shellQuote(target)} "$@"`);
  }
  return `${lines.join("\n")}\n`;
}

function shimName(bin: string): string {
  return process.platform === "win32" ? `${bin}.cmd` : bin;
}

async function writeShim(
  binDir: string,
  bin: string,
  target: string,
  nodePath: string,
): Promise<string> {
  await fsp.mkdir(binDir, { recursive: true });
  const name = shimName(bin);
  const dest = path.join(binDir, name);
  const tmp = `${dest}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, buildShim(target, nodePath), { mode: 0o755 });
  await fsp.rename(tmp, dest);
  return name;
}

// ── Jobs ───────────────────────────────────────────────────────────────────

export type JobAction = "install" | "update" | "uninstall";
export type JobPhase =
  | "queued"
  | "checking"
  | "downloading"
  | "linking"
  | "verifying"
  | "removing"
  | "done"
  | "failed";

export interface CoderJob {
  coderId: CoderId;
  action: JobAction;
  phase: JobPhase;
  startedAt: number;
  finishedAt?: number;
  ok?: boolean;
  /** Plain-language reason plus the next step (shown as-is to beginners). */
  error?: string;
  /** Command that installs it by hand, offered next to Try again. */
  manual?: string;
  version?: string;
  /** Redacted output tail (≤ 200 lines). */
  log: string[];
}

const LOG_LIMIT = 200;
const jobs = new Map<string, CoderJob>();
const running = new Map<string, Promise<CoderJob>>();

/** Jobs are keyed by coders root so tenants (shared override) never collide. */
function jobKey(id: CoderId): string {
  return `${codersRoot()}::${id}`;
}

export function getJob(id: CoderId): CoderJob | undefined {
  return jobs.get(jobKey(id));
}

export function isJobRunning(id: CoderId): boolean {
  return running.has(jobKey(id));
}

export type JobListener = (job: CoderJob) => void;

function pushLog(job: CoderJob, line: string) {
  const clean = cleanLogText(line).trimEnd();
  if (!clean) return;
  for (const l of clean.split("\n")) {
    if (!l.trim()) continue;
    job.log.push(l.slice(0, 400));
  }
  if (job.log.length > LOG_LIMIT) job.log.splice(0, job.log.length - LOG_LIMIT);
}

// ── Disk / quota ───────────────────────────────────────────────────────────

async function dirSizeMb(dir: string): Promise<number> {
  let total = 0;
  const walk = async (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        try {
          total += (await fsp.stat(p)).size;
        } catch {
          /* ignore */
        }
      }
    }
  };
  await walk(dir);
  return total / 1_048_576;
}

/** Total MB used by managed installs (excluding caches). */
export async function managedUsageMb(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let sum = 0;
  for (const e of CODER_CATALOG) {
    const p = coderPrefix(e.id, env);
    if (fs.existsSync(p)) sum += await dirSizeMb(p);
  }
  return Math.round(sum);
}

async function freeMb(dir: string): Promise<number | null> {
  try {
    const s = await fsp.statfs(dir);
    return Math.floor((Number(s.bavail) * Number(s.bsize)) / 1_048_576);
  } catch {
    return null;
  }
}

/**
 * Refuse installs that would run the volume out of space, or exceed
 * INFINIBOT_CODERS_QUOTA_MB (set on hosted tenants to cap the /data share).
 */
export async function checkDisk(
  entry: CoderCatalogEntry,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const root = codersRoot(env);
  await fsp.mkdir(root, { recursive: true });
  const need = Math.ceil(entry.approxSizeMb * 1.5) + 50;
  const free = await freeMb(root);
  if (free !== null && free < need) {
    return `Not enough disk space: ${entry.name} needs about ${need} MB, ${free} MB free.`;
  }
  const quota = Number(env.INFINIBOT_CODERS_QUOTA_MB ?? "");
  if (Number.isFinite(quota) && quota > 0) {
    const used = await managedUsageMb(env);
    const current = fs.existsSync(coderPrefix(entry.id, env))
      ? await dirSizeMb(coderPrefix(entry.id, env))
      : 0;
    if (used - current + entry.approxSizeMb > quota) {
      return `Coder storage quota reached (${used} MB of ${quota} MB used). Uninstall a coder first.`;
    }
  }
  return null;
}

// ── Install ────────────────────────────────────────────────────────────────

const INSTALL_TIMEOUT_MS = 15 * 60_000;
const VERSION_TIMEOUT_MS = 20_000;

async function rmrfInside(root: string, target: string) {
  if (!isInside(root, target)) throw new Error(`refusing to remove ${target}: outside ${root}`);
  await fsp.rm(target, { recursive: true, force: true });
}

function pkgDir(prefix: string, pkg: string): string {
  return process.platform === "win32"
    ? path.join(prefix, "node_modules", pkg)
    : path.join(prefix, "lib", "node_modules", pkg);
}

function npmBinPath(prefix: string, bin: string): string {
  return process.platform === "win32"
    ? path.join(prefix, `${bin}.cmd`)
    : path.join(prefix, "bin", bin);
}

/** Resolve the package's bin entry to an absolute path inside its package dir. */
function npmBinTarget(prefix: string, pkg: string, bin: string): string {
  const dir = pkgDir(prefix, pkg);
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as {
      bin?: string | Record<string, string>;
    };
    const rel = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[bin];
    if (rel) {
      const abs = path.resolve(dir, rel);
      if (isInside(prefix, abs)) return abs;
    }
  } catch {
    /* fall through */
  }
  return fs.realpathSync(npmBinPath(prefix, bin));
}

function readPkgVersion(prefix: string, pkg: string): string {
  try {
    return (
      (
        JSON.parse(fs.readFileSync(path.join(pkgDir(prefix, pkg), "package.json"), "utf8")) as {
          version?: string;
        }
      ).version ?? "unknown"
    );
  } catch {
    return "unknown";
  }
}

/** Run `<shim> --version`; returns the first output line or throws. */
export async function probeVersion(
  binPath: string,
  versionArgs: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const res = await runProcess(binPath, versionArgs, {
    env: env ?? scrubbedEnv(),
    timeoutMs: VERSION_TIMEOUT_MS,
  });
  const first = cleanLogText(res.output)
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !/^warning/i.test(l));
  if (res.code !== 0 || !first) {
    throw new Error(
      `\`${path.basename(binPath)} ${versionArgs.join(" ")}\` failed (exit ${res.code}): ${cleanLogText(res.output).slice(-300)}`,
    );
  }
  return first;
}

/** Last meaningful npm output line (npm ERR! lines win), for messages. */
function lastNpmLine(output: string): string {
  const lines = cleanLogText(output)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const err = lines.filter((l) => /^npm (ERR!|error)/i.test(l));
  return (err.find((l) => /code|errno|reason/i.test(l) === false) ?? err[0] ?? lines.at(-1) ?? "")
    .replace(/^npm (ERR!|error)\s*/i, "")
    .slice(0, 240);
}

/**
 * Turn a failed npm run into one plain sentence plus the next step, never a
 * bare "exit -1".
 */
export function explainNpmFailure(name: string, res: RunResult): string {
  const out = res.output;
  const retry = "Click Try again.";
  if (res.spawnError) {
    return `InfiniBot couldn't start the installer for ${name} (${res.spawnError}). ${retry}`;
  }
  if (res.timedOut) {
    return `Installing ${name} took too long and was stopped. Check your internet connection, then ${retry.toLowerCase()}`;
  }
  if (
    /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENETUNREACH|network|socket hang up|proxy/i.test(
      out,
    )
  ) {
    return `InfiniBot couldn't reach the download server (registry.npmjs.org) to install ${name}. Check your internet connection or proxy, then ${retry.toLowerCase()}`;
  }
  if (/ENOSPC/i.test(out)) {
    return `This computer ran out of disk space while installing ${name}. Free up some space, then ${retry.toLowerCase()}`;
  }
  if (/EACCES|EPERM|EBUSY/i.test(out)) {
    return `Your system blocked InfiniBot from writing ${name}'s files (permission denied, or a file is in use, often by antivirus). Wait a moment, then ${retry.toLowerCase()}`;
  }
  const line = lastNpmLine(out);
  return `Installing ${name} failed${line ? `: ${line}` : ` (npm exit code ${res.code})`}. ${retry}`;
}

async function installNpm(
  entry: CoderCatalogEntry,
  method: Extract<CoderInstallMethod, { kind: "npm" }>,
  host: HostTools,
  job: CoderJob,
  env: NodeJS.ProcessEnv,
): Promise<InstallManifest> {
  const root = codersRoot(env);
  const prefix = coderPrefix(entry.id, env);
  job.manual = `npm install -g ${method.package}`;
  let npm = host.npm;
  let nodeBin = host.node;
  if (!npm) {
    // No Node.js on this machine (typical for the desktop app): fetch
    // InfiniBot's private copy once, then install on it.
    job.phase = "downloading";
    pushLog(
      job,
      "Node.js isn't on this computer, so InfiniBot is downloading its own copy (once).",
    );
    const rt = await ensureNodeRuntime({ env, log: (l) => pushLog(job, l) });
    npm = runnerOf(rt);
    nodeBin = rt.node;
  }
  const staging = path.join(root, `.staging-${entry.id}-${Date.now()}`);
  await fsp.mkdir(staging, { recursive: true });
  try {
    job.phase = "downloading";
    const spec = `${method.package}@${method.version}`;
    pushLog(job, `npm install ${spec}`);
    const res = await runProcess(
      npm.command,
      [
        ...npm.args,
        "install",
        "--global",
        "--prefix",
        staging,
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
        method.needsScripts ? "--ignore-scripts=false" : "--ignore-scripts",
        spec,
      ],
      {
        // An empty cwd: npm treats a same-named directory in cwd as a folder spec.
        cwd: staging,
        env: scrubbedEnv(
          {
            npm_config_cache: npmCacheDir(env),
            npm_config_update_notifier: "false",
            npm_config_prefix: staging,
          },
          env,
        ),
        timeoutMs: INSTALL_TIMEOUT_MS,
        onLine: (l) => pushLog(job, l),
      },
    );
    if (res.code !== 0) throw new Error(explainNpmFailure(entry.name, res));

    job.phase = "verifying";
    const version = readPkgVersion(staging, method.package);
    const stagedTarget = npmBinTarget(staging, method.package, entry.bin);
    // Verify the staged CLI runs before touching the live install.
    const probeShim = path.join(staging, shimName(`.probe-${entry.bin}`));
    await fsp.writeFile(probeShim, buildShim(stagedTarget, nodeBin), { mode: 0o755 });
    let reported: string;
    try {
      reported = await probeVersion(probeShim, entry.versionArgs, scrubbedEnv({}, env));
    } catch (err) {
      throw new Error(
        `${entry.name} downloaded but didn't start on this computer (${cleanLogText((err as Error).message).slice(0, 300)}). Click Try again.`,
        { cause: err },
      );
    }
    await fsp.rm(probeShim, { force: true });
    pushLog(job, `${entry.bin} ${entry.versionArgs.join(" ")} → ${reported}`);

    job.phase = "linking";
    const old = readManifest(entry.id, env);
    if (fs.existsSync(prefix)) {
      const trash = path.join(root, `.trash-${entry.id}-${Date.now()}`);
      await fsp.rename(prefix, trash);
      await rmrfInside(root, trash);
    }
    await fsp.rename(staging, prefix);
    const target = npmBinTarget(prefix, method.package, entry.bin);
    const shim = await writeShim(codersBinDir(env), entry.bin, target, nodeBin);
    for (const s of old?.shims ?? []) {
      if (s !== shim) await fsp.rm(path.join(codersBinDir(env), path.basename(s)), { force: true });
    }
    const manifest: InstallManifest = {
      id: entry.id,
      method: "npm",
      package: method.package,
      version,
      reportedVersion: reported,
      installedAt: new Date().toISOString(),
      shims: [shim],
    };
    await fsp.writeFile(coderManifestPath(entry.id, env), JSON.stringify(manifest, null, 2));
    return manifest;
  } finally {
    if (fs.existsSync(staging)) await rmrfInside(root, staging).catch(() => {});
  }
}

async function installPython(
  entry: CoderCatalogEntry,
  method: Extract<CoderInstallMethod, { kind: "uv" | "pipx" }>,
  host: HostTools,
  job: CoderJob,
  env: NodeJS.ProcessEnv,
): Promise<InstallManifest> {
  // Python venvs embed absolute paths, so these install in place (uv/pipx
  // --force replace an existing tool atomically enough for an update).
  const root = codersRoot(env);
  const prefix = coderPrefix(entry.id, env);
  const toolBin = path.join(prefix, "bin");
  await fsp.mkdir(toolBin, { recursive: true });
  job.phase = "downloading";
  const [command, args, extra] =
    method.kind === "uv"
      ? [
          host.uv!,
          ["tool", "install", "--force", method.package],
          {
            UV_TOOL_DIR: path.join(prefix, "tools"),
            UV_TOOL_BIN_DIR: toolBin,
            UV_CACHE_DIR: path.join(root, ".uv-cache"),
            UV_PYTHON_INSTALL_DIR: path.join(prefix, "python"),
          },
        ]
      : [
          host.pipx!,
          ["install", "--force", method.package],
          { PIPX_HOME: path.join(prefix, "pipx"), PIPX_BIN_DIR: toolBin },
        ];
  pushLog(job, `${method.kind} install ${method.package}`);
  const res = await runProcess(command, args as string[], {
    cwd: prefix,
    env: scrubbedEnv(extra as Record<string, string>, env),
    timeoutMs: INSTALL_TIMEOUT_MS,
    onLine: (l) => pushLog(job, l),
  });
  if (res.code !== 0) throw new Error(`${method.kind} install failed (exit ${res.code})`);
  job.phase = "linking";
  const target = path.join(toolBin, entry.bin);
  const shim = await writeShim(codersBinDir(env), entry.bin, target, host.node);
  job.phase = "verifying";
  const reported = await probeVersion(
    path.join(codersBinDir(env), shim),
    entry.versionArgs,
    scrubbedEnv({}, env),
  );
  const manifest: InstallManifest = {
    id: entry.id,
    method: method.kind,
    package: method.package,
    version: reported.match(/\d+\.\d+(?:\.\d+)?/)?.[0] ?? reported,
    reportedVersion: reported,
    installedAt: new Date().toISOString(),
    shims: [shim],
  };
  await fsp.writeFile(coderManifestPath(entry.id, env), JSON.stringify(manifest, null, 2));
  return manifest;
}

const BINARY_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return res.text();
}

/**
 * Prebuilt vendor binary (e.g. Grok Build): resolve the channel's version,
 * download the artifact into staging, prove it runs, then swap it into the
 * coder's prefix. Tries each base URL in turn (primary, then fallbacks).
 */
async function installBinary(
  entry: CoderCatalogEntry,
  method: Extract<CoderInstallMethod, { kind: "binary" }>,
  host: HostTools,
  job: CoderJob,
  env: NodeJS.ProcessEnv,
): Promise<InstallManifest> {
  const root = codersRoot(env);
  const prefix = coderPrefix(entry.id, env);
  const platform = method.platforms[`${process.platform}-${process.arch}`];
  if (!platform)
    throw new Error(`${entry.name} has no build for ${process.platform}-${process.arch}.`);
  const primaryBase = method.channelUrl.slice(0, method.channelUrl.lastIndexOf("/"));
  const channel = method.channelUrl.slice(method.channelUrl.lastIndexOf("/") + 1);
  const bases = [primaryBase, ...(method.fallbackBaseUrls ?? [])];

  job.phase = "downloading";
  let version = "";
  let base = "";
  for (const candidate of bases) {
    try {
      version = (await fetchText(`${candidate}/${channel}`)).trim().split(/\s+/)[0] ?? "";
      if (/^\d+\.\d+\.\d+(-[A-Za-z0-9._]+)?$/.test(version)) {
        base = candidate;
        break;
      }
    } catch (err) {
      pushLog(job, `${candidate}: ${(err as Error).message}`);
    }
  }
  if (!base) throw new Error(`Could not read the latest ${entry.name} version.`);
  const artifactPath = method.artifactUrl
    .slice(primaryBase.length)
    .replaceAll("{version}", version)
    .replaceAll("{platform}", platform);
  const url = `${base}${artifactPath}`;
  pushLog(job, `downloading ${entry.name} ${version} (${platform})`);

  const staging = path.join(root, `.staging-${entry.id}-${Date.now()}`);
  await fsp.mkdir(path.join(staging, "bin"), { recursive: true });
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(BINARY_DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok || !res.body) throw new Error(`GET ${url} → HTTP ${res.status}`);
    const exe = process.platform === "win32" ? `${entry.bin}.exe` : entry.bin;
    const stagedBin = path.join(staging, "bin", exe);
    await fsp.writeFile(stagedBin, Buffer.from(await res.arrayBuffer()), { mode: 0o755 });

    job.phase = "verifying";
    const reported = await probeVersion(stagedBin, entry.versionArgs, scrubbedEnv({}, env));
    pushLog(job, `${entry.bin} ${entry.versionArgs.join(" ")} → ${reported}`);

    job.phase = "linking";
    if (fs.existsSync(prefix)) {
      const trash = path.join(root, `.trash-${entry.id}-${Date.now()}`);
      await fsp.rename(prefix, trash);
      await rmrfInside(root, trash);
    }
    await fsp.rename(staging, prefix);
    const shim = await writeShim(
      codersBinDir(env),
      entry.bin,
      path.join(prefix, "bin", exe),
      host.node,
    );
    const manifest: InstallManifest = {
      id: entry.id,
      method: "binary",
      package: url,
      version,
      reportedVersion: reported,
      installedAt: new Date().toISOString(),
      shims: [shim],
    };
    await fsp.writeFile(coderManifestPath(entry.id, env), JSON.stringify(manifest, null, 2));
    return manifest;
  } finally {
    if (fs.existsSync(staging)) await rmrfInside(root, staging).catch(() => {});
  }
}

async function uninstallCoder(entry: CoderCatalogEntry, job: CoderJob, env: NodeJS.ProcessEnv) {
  const root = codersRoot(env);
  const prefix = coderPrefix(entry.id, env);
  const manifest = readManifest(entry.id, env);
  job.phase = "removing";
  const binDir = codersBinDir(env);
  for (const s of manifest?.shims ?? [shimName(entry.bin)]) {
    const p = path.join(binDir, path.basename(s));
    // Only remove a shim we wrote (it points into this coder's prefix).
    try {
      const body = await fsp.readFile(p, "utf8");
      if (body.includes(prefix)) await fsp.rm(p, { force: true });
    } catch {
      /* already gone */
    }
  }
  if (fs.existsSync(prefix)) await rmrfInside(root, prefix);
  pushLog(job, `removed ${entry.name}`);
}

/**
 * Start an install/update/uninstall job. Returns immediately with the job; the
 * job object is updated in place and `listener` is called on each change.
 * One job per coder at a time.
 */
export function startJob(
  id: CoderId,
  action: JobAction,
  opts: { listener?: JobListener; host?: HostTools; env?: NodeJS.ProcessEnv } = {},
):
  | { ok: true; job: CoderJob; done: Promise<CoderJob> }
  | { ok: false; code: string; message: string; url?: string } {
  const entry = getCoderEntry(id);
  if (!entry) return { ok: false, code: "NOT_FOUND", message: `Unknown coder: ${String(id)}` };
  const env = opts.env ?? process.env;
  const key = jobKey(entry.id);
  if (running.has(key)) {
    return {
      ok: false,
      code: "BUSY",
      message: `${entry.name} already has an install in progress.`,
    };
  }
  const host = opts.host ?? detectHostTools();
  let plan: InstallPlan | null = null;
  if (action !== "uninstall") {
    plan = planInstall(entry, host, env);
    if (!plan.ok) return { ok: false, code: plan.code, message: plan.message, url: plan.url };
  } else {
    const policy = coderInstallPolicy(env);
    if (!policy.allowed) return { ok: false, code: "POLICY", message: policy.reason };
  }

  const job: CoderJob = {
    coderId: entry.id,
    action,
    phase: "queued",
    startedAt: Date.now(),
    log: [],
  };
  jobs.set(key, job);
  const notify = () => {
    try {
      opts.listener?.({ ...job, log: job.log.slice(-20) });
    } catch {
      /* listener errors never fail a job */
    }
  };

  const done = (async (): Promise<CoderJob> => {
    try {
      job.phase = "checking";
      notify();
      if (action === "uninstall") {
        await uninstallCoder(entry, job, env);
      } else {
        const diskErr = await checkDisk(entry, env);
        if (diskErr) throw new Error(diskErr);
        const tick = setInterval(notify, 1500);
        tick.unref?.();
        try {
          const method = (plan as Extract<InstallPlan, { ok: true }>).method;
          const manifest =
            method.kind === "npm"
              ? await installNpm(entry, method, host, job, env)
              : method.kind === "binary"
                ? await installBinary(entry, method, host, job, env)
                : await installPython(entry, method, host, job, env);
          job.version = manifest.version;
        } finally {
          clearInterval(tick);
        }
      }
      job.phase = "done";
      job.ok = true;
    } catch (err) {
      job.phase = "failed";
      job.ok = false;
      job.error = cleanLogText(err instanceof Error ? err.message : String(err)).slice(0, 600);
      pushLog(job, job.error);
    } finally {
      job.finishedAt = Date.now();
      running.delete(key);
      notify();
    }
    return job;
  })();
  running.set(key, done);
  return { ok: true, job, done };
}

/** Test helper. */
export function _resetJobs(): void {
  jobs.clear();
  running.clear();
}

/** Path of the managed shim for a coder when installed via InfiniBot. */
export function managedBinPath(
  entry: CoderCatalogEntry,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const m = readManifest(entry.id, env);
  if (!m) return null;
  const p = path.join(codersBinDir(env), m.shims[0] ?? shimName(entry.bin));
  return fs.existsSync(p) ? p : null;
}

/** `npm view <pkg> version` for the update badge (scrubbed env, 15s cap). */
export async function latestNpmVersion(
  pkg: string,
  host: HostTools = detectHostTools(),
): Promise<string | null> {
  if (!host.npm) return null;
  return new Promise((resolve) => {
    execFile(
      host.npm!.command,
      [...host.npm!.args, "view", `${pkg}@latest`, "version"],
      {
        env: scrubbedEnv({ npm_config_cache: npmCacheDir(), npm_config_update_notifier: "false" }),
        timeout: 15_000,
        cwd: codersRoot(),
      },
      (err, stdout) =>
        resolve(err ? null : String(stdout).trim().split("\n").pop()?.trim() || null),
    );
  });
}
