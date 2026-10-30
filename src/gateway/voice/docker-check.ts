/**
 * Docker availability preflight for the native voice stack (Kokoro TTS runs in
 * a Docker container). Shared by:
 *   - kokoro-bootstrap.ts (boot-time warning when Kokoro is selected)
 *   - the `/api/voice/docker-check` endpoint (wizard Native step)
 *
 * `docker --version` confirms the CLI is installed; `docker info` confirms the
 * daemon is actually running. Both run with a short timeout so a hung Docker
 * never stalls the gateway.
 */

import { execFile } from "node:child_process";

export interface DockerStatus {
  /** docker CLI present AND daemon reachable. */
  available: boolean;
  /** docker CLI present (may still have a stopped daemon). */
  cliPresent: boolean;
  /** docker daemon answered `docker info`. */
  daemonRunning: boolean;
  version?: string;
  error?: string;
}

function run(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
        resolve({ ok: !err, stdout: (stdout ?? "").toString().trim() });
      });
    } catch {
      resolve({ ok: false, stdout: "" });
    }
  });
}

let cached: { at: number; status: DockerStatus } | null = null;
const CACHE_TTL_MS = 15_000;

/** Probe Docker availability (CLI + daemon). Result is cached briefly so
 *  repeated UI polls don't spawn a process each time. Pass `force` to refresh. */
export async function checkDocker(opts?: {
  timeoutMs?: number;
  force?: boolean;
}): Promise<DockerStatus> {
  const now = Date.now();
  if (!opts?.force && cached && now - cached.at < CACHE_TTL_MS) return cached.status;

  const timeout = opts?.timeoutMs ?? 2000;
  const ver = await run("docker", ["--version"], timeout);
  if (!ver.ok) {
    const status: DockerStatus = {
      available: false,
      cliPresent: false,
      daemonRunning: false,
      error: "docker CLI not found on PATH",
    };
    cached = { at: now, status };
    return status;
  }

  const info = await run("docker", ["info", "--format", "{{.ServerVersion}}"], timeout);
  const status: DockerStatus = {
    available: info.ok,
    cliPresent: true,
    daemonRunning: info.ok,
    version: ver.stdout.replace(/^Docker version\s*/i, "") || undefined,
    error: info.ok ? undefined : "docker daemon not reachable (is Docker running?)",
  };
  cached = { at: now, status };
  return status;
}

export const DOCKER_INSTALL_URL = "https://docs.docker.com/get-docker/";
