/**
 * "Checking your computer" for the one-click local voice setup.
 *
 * Works out, without changing anything:
 *   - OS / CPU / RAM / free disk,
 *   - NVIDIA GPU (and whether Docker can hand it to containers),
 *   - Docker: missing | stopped | no-permission | running, plus how to start it
 *     on this machine (systemd system/user unit, Docker Desktop app).
 *
 * Every process call goes through an injectable `exec` so the classification
 * is unit-tested without Docker. Docker is looked up on PATH and in the usual
 * install locations, because the packaged desktop app (launchd / Explorer)
 * often starts with a PATH that doesn't include it.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type HostOs = "linux" | "darwin" | "win32" | "other";
export type DockerState = "missing" | "stopped" | "no-permission" | "running";

export interface ExecResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}
export type Exec = (
  cmd: string,
  args: string[],
  opts?: { timeoutMs?: number },
) => Promise<ExecResult>;

export interface DockerProbe {
  state: DockerState;
  /** Resolved docker CLI (absolute path or "docker"), null when not found. */
  cli: string | null;
  version?: string;
  /** Docker Desktop app install path, when one was found (Win/Mac/Linux). */
  desktopApp: string | null;
  /** Linux: a `docker.service` system unit exists. */
  systemUnit: boolean;
  /** Linux: `docker.service` (rootless) or `docker-desktop.service` user unit. */
  userUnit: "docker" | "docker-desktop" | null;
  /** Linux: the system unit is enabled at boot (containers come back after reboot). */
  enabledAtBoot: boolean | null;
  /** Docker can give containers the NVIDIA GPU (nvidia runtime / Desktop WSL2). */
  gpuRuntime: boolean;
  rootless: boolean;
  /** Raw stderr of the failing probe, for "Show details". */
  detail?: string;
}

export interface GpuInfo {
  nvidia: boolean;
  name?: string;
  vramMb?: number;
}

export interface HostReport {
  os: HostOs;
  osLabel: string;
  arch: string;
  cpus: number;
  ramGb: number;
  diskFreeGb: number | null;
  gpu: GpuInfo;
  docker: DockerProbe;
  checkedAt: number;
}

export interface DetectDeps {
  exec: Exec;
  exists: (p: string) => boolean;
  platform: NodeJS.Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
  homedir: string;
  totalMemBytes: number;
  cpus: number;
  diskFreeBytes: (dir: string) => number | null;
  readOsRelease: () => string | null;
}

export const realExec: Exec = (cmd, args, opts) =>
  new Promise((resolve) => {
    try {
      execFile(
        cmd,
        args,
        { timeout: opts?.timeoutMs ?? 5000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const code = err
            ? typeof (err as { code?: unknown }).code === "number"
              ? (err as { code: number }).code
              : null
            : 0;
          resolve({
            ok: !err,
            code,
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? "") || (err && !stderr ? String((err as Error).message) : ""),
          });
        },
      );
    } catch (e) {
      resolve({ ok: false, code: null, stdout: "", stderr: String(e) });
    }
  });

export function realDetectDeps(stateDir: string): DetectDeps {
  return {
    exec: realExec,
    exists: (p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    },
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    homedir: os.homedir(),
    totalMemBytes: os.totalmem(),
    cpus: os.cpus().length,
    diskFreeBytes: (dir) => {
      try {
        let d = dir;
        while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
        const s = fs.statfsSync(d);
        return Number(s.bavail) * Number(s.bsize);
      } catch {
        return null;
      }
    },
    readOsRelease: () => {
      try {
        return fs.readFileSync("/etc/os-release", "utf8");
      } catch {
        return null;
      }
    },
  };
}

export function hostOs(platform: NodeJS.Platform): HostOs {
  return platform === "linux" || platform === "darwin" || platform === "win32" ? platform : "other";
}

/** Friendly OS name ("Ubuntu 24.04", "macOS", "Windows"). */
export function osLabel(osId: HostOs, osRelease: string | null): string {
  if (osId === "darwin") return "macOS";
  if (osId === "win32") return "Windows";
  if (osId === "linux") {
    const m = osRelease?.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
    return m?.[1]?.trim() || "Linux";
  }
  return "this computer";
}

/** Where Docker's CLI lives besides PATH, per OS. */
export function dockerCliCandidates(osId: HostOs, home: string, env: NodeJS.ProcessEnv): string[] {
  if (osId === "darwin") {
    return [
      "/usr/local/bin/docker",
      "/opt/homebrew/bin/docker",
      path.join(home, ".docker", "bin", "docker"),
      "/Applications/Docker.app/Contents/Resources/bin/docker",
    ];
  }
  if (osId === "win32") {
    const pf = env.ProgramFiles || "C:\\Program Files";
    return [path.win32.join(pf, "Docker", "Docker", "resources", "bin", "docker.exe")];
  }
  return ["/usr/bin/docker", "/usr/local/bin/docker", path.join(home, "bin", "docker")];
}

/** Docker Desktop's app path, per OS. */
export function dockerDesktopCandidates(
  osId: HostOs,
  home: string,
  env: NodeJS.ProcessEnv,
): string[] {
  if (osId === "darwin")
    return ["/Applications/Docker.app", path.join(home, "Applications", "Docker.app")];
  if (osId === "win32") {
    const pf = env.ProgramFiles || "C:\\Program Files";
    return [path.win32.join(pf, "Docker", "Docker", "Docker Desktop.exe")];
  }
  if (osId === "linux") return ["/opt/docker-desktop/bin/com.docker.backend"];
  return [];
}

/**
 * Classify a failed `docker info`: the daemon socket refused us (permission),
 * or nothing is listening (stopped). Everything unknown counts as stopped.
 */
export function classifyDockerInfoError(stderr: string): "stopped" | "no-permission" {
  const s = stderr.toLowerCase();
  if (/permission denied/.test(s) && /(docker\.sock|docker_engine|daemon socket|connect)/.test(s)) {
    return "no-permission";
  }
  if (/access is denied/.test(s) && /docker_engine/.test(s)) return "no-permission";
  return "stopped";
}

async function resolveDockerCli(
  deps: DetectDeps,
  osId: HostOs,
): Promise<{ cli: string; version: string } | null> {
  const tryCli = async (cli: string) => {
    const r = await deps.exec(cli, ["--version"], { timeoutMs: 4000 });
    return r.ok ? r.stdout.trim().replace(/^Docker version\s*/i, "") : null;
  };
  const onPath = await tryCli("docker");
  if (onPath !== null) return { cli: "docker", version: onPath };
  for (const c of dockerCliCandidates(osId, deps.homedir, deps.env)) {
    if (!deps.exists(c)) continue;
    const v = await tryCli(c);
    if (v !== null) return { cli: c, version: v };
  }
  return null;
}

/** Probe Docker end to end. Never throws. */
export async function probeDocker(deps: DetectDeps): Promise<DockerProbe> {
  const osId = hostOs(deps.platform);
  const desktopApp =
    dockerDesktopCandidates(osId, deps.homedir, deps.env).find((p) => deps.exists(p)) ?? null;

  let systemUnit = false;
  let userUnit: DockerProbe["userUnit"] = null;
  let enabledAtBoot: boolean | null = null;
  if (osId === "linux") {
    const sys = await deps.exec("systemctl", ["cat", "docker.service"], { timeoutMs: 3000 });
    systemUnit = sys.ok;
    if (systemUnit) {
      const en = await deps.exec("systemctl", ["is-enabled", "docker.service"], {
        timeoutMs: 3000,
      });
      enabledAtBoot = en.stdout.trim() === "enabled";
    }
    const userDocker = await deps.exec("systemctl", ["--user", "cat", "docker.service"], {
      timeoutMs: 3000,
    });
    if (userDocker.ok) userUnit = "docker";
    else {
      const dd = await deps.exec("systemctl", ["--user", "cat", "docker-desktop.service"], {
        timeoutMs: 3000,
      });
      if (dd.ok) userUnit = "docker-desktop";
    }
  }

  const base = {
    desktopApp,
    systemUnit,
    userUnit,
    enabledAtBoot,
    gpuRuntime: false,
    rootless: false,
  };
  const cli = await resolveDockerCli(deps, osId);
  if (!cli) {
    // Docker Desktop installed but its CLI not linked yet still counts as installed.
    return {
      ...base,
      state: desktopApp || userUnit === "docker-desktop" ? "stopped" : "missing",
      cli: null,
    };
  }

  const info = await deps.exec(cli.cli, ["info", "--format", "{{json .}}"], { timeoutMs: 8000 });
  let parsed: Record<string, unknown> | null = null;
  if (info.ok) {
    try {
      parsed = JSON.parse(info.stdout.trim()) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
  }
  // `docker info` can exit 0 with a ServerErrors array when only the client works.
  const serverErrors = Array.isArray(parsed?.ServerErrors)
    ? (parsed!.ServerErrors as string[]).join("\n")
    : "";
  if (!info.ok || !parsed || serverErrors || !parsed.ServerVersion) {
    const detail = (serverErrors || info.stderr || info.stdout).trim();
    return {
      ...base,
      state: classifyDockerInfoError(detail),
      cli: cli.cli,
      version: cli.version,
      detail,
    };
  }

  const runtimes =
    parsed.Runtimes && typeof parsed.Runtimes === "object"
      ? Object.keys(parsed.Runtimes as object)
      : [];
  const security = Array.isArray(parsed.SecurityOptions)
    ? (parsed.SecurityOptions as string[]).join(" ")
    : "";
  const opSys = String(parsed.OperatingSystem ?? "");
  const cdi = Array.isArray(parsed.CDISpecDirs) && (parsed.CDISpecDirs as unknown[]).length > 0;
  // Docker Desktop (Windows WSL2) passes NVIDIA GPUs through without an "nvidia" runtime.
  const gpuRuntime =
    runtimes.includes("nvidia") || (osId === "win32" && /docker desktop/i.test(opSys));
  return {
    ...base,
    state: "running",
    cli: cli.cli,
    version: String(parsed.ServerVersion ?? cli.version),
    gpuRuntime: gpuRuntime || (cdi && runtimes.includes("nvidia")),
    rootless: /rootless/i.test(security),
  };
}

/** NVIDIA GPU via nvidia-smi (macOS never has one). */
export async function probeGpu(deps: DetectDeps): Promise<GpuInfo> {
  if (hostOs(deps.platform) === "darwin") return { nvidia: false };
  const r = await deps.exec(
    "nvidia-smi",
    ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
    { timeoutMs: 5000 },
  );
  if (!r.ok) return { nvidia: false };
  const first = r.stdout.trim().split(/\r?\n/)[0] ?? "";
  if (!first) return { nvidia: false };
  const [name, mem] = first.split(",").map((s) => s.trim());
  const vram = Number.parseInt(mem ?? "", 10);
  return {
    nvidia: true,
    name: name || "NVIDIA GPU",
    vramMb: Number.isFinite(vram) ? vram : undefined,
  };
}

export async function detectHost(deps: DetectDeps, stateDir: string): Promise<HostReport> {
  const osId = hostOs(deps.platform);
  const [gpu, docker] = await Promise.all([probeGpu(deps), probeDocker(deps)]);
  const free = deps.diskFreeBytes(stateDir);
  return {
    os: osId,
    osLabel: osLabel(osId, osId === "linux" ? deps.readOsRelease() : null),
    arch: deps.arch,
    cpus: deps.cpus,
    ramGb: Math.round((deps.totalMemBytes / 1024 ** 3) * 10) / 10,
    diskFreeGb: free === null ? null : Math.round((free / 1024 ** 3) * 10) / 10,
    gpu,
    docker,
    checkedAt: Date.now(),
  };
}
