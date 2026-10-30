/**
 * EAS Build runner — drive `eas build` from the dashboard.
 *
 * Why this exists: most users don't want to drop into a terminal to ship
 * their personal IPA. The dashboard's `/mobile` page kicks the build,
 * polls for progress, and surfaces the resulting download URL when
 * Expo's hosted service is done compiling.
 *
 * Two modes:
 *   • **`build`** — the headline action. Wraps `eas build --profile X
 *     --platform ios --non-interactive`. We append `--no-wait` so the
 *     CLI exits as soon as the job is queued; the dashboard then polls
 *     `eas build:list` to track status without holding a child process
 *     for ~20 minutes.
 *   • **`credentials`** — `eas credentials` is interactive by design
 *     (Apple ID prompts), so we don't try to script it. Instead we open
 *     a terminal-stream session the dashboard can attach to and let the
 *     user answer prompts as they would in a normal shell.
 *
 * The user must:
 *   1. Be logged into Expo (`eas login` once)
 *   2. Have an Apple Developer account ($99/yr) for iOS builds
 *   3. Have run `eas credentials` at least once for the project
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { resolveDefaultProjectDir } from "./expo-runner.js";

// ── Types ─────────────────────────────────────────────────────

export type EasBuildPlatform = "ios" | "android" | "all";
export type EasBuildProfile = "development" | "preview" | "production";

export interface EasBuildJob {
  id: string;
  platform: EasBuildPlatform;
  profile: EasBuildProfile;
  status: "new" | "queued" | "in-progress" | "finished" | "errored" | "canceled" | "unknown";
  /** Public Expo URL where the user downloads the IPA / APK when done. */
  artifactUrl?: string;
  /** Human-readable build URL on expo.dev. */
  buildUrl?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  /** Raw record from `eas build:list --json` for debugging. */
  raw?: Record<string, unknown>;
}

export interface EasDevice {
  id: string;
  name?: string;
  udid: string;
  platform?: string;
  appleTeamId?: string;
  status?: string;
  raw?: Record<string, unknown>;
}

export interface RunBuildOptions {
  projectDir?: string;
  platform: EasBuildPlatform;
  profile: EasBuildProfile;
  /**
   * Pass through `--clear-cache` — useful when a build is failing on
   * stale Metro / native artifacts in EAS's cache.
   */
  clearCache?: boolean;
  /**
   * Auto-submit to TestFlight / Play Internal after build completes.
   * Requires `eas submit` configuration in `eas.json`.
   */
  autoSubmit?: boolean;
  /**
   * Refresh Expo-managed ad hoc provisioning before non-interactive iOS
   * internal builds. Required when a newly registered device UDID should be
   * included in the installable IPA.
   */
  refreshAdHocProvisioningProfile?: boolean;
}

export interface RunBuildResult {
  ok: boolean;
  /** EAS job id when the queue accepted us. */
  jobId?: string;
  buildUrl?: string;
  /** Stdout lines for the dashboard to surface. */
  log: string[];
  error?: string;
}

// ── Public API ───────────────────────────────────────────────

function defaultProjectDir(): string {
  return resolveDefaultProjectDir();
}

/**
 * Kick an EAS build. The CLI exits as soon as the job is queued; use
 * `listBuilds()` to poll the resulting status.
 */
export async function startEasBuild(opts: RunBuildOptions): Promise<RunBuildResult> {
  const dir = resolve(opts.projectDir ?? defaultProjectDir());
  if (!existsSync(dir)) {
    return { ok: false, log: [], error: `Expo project not found at ${dir}` };
  }

  const args = [
    "eas-cli",
    "build",
    "--profile",
    opts.profile,
    "--platform",
    opts.platform,
    "--non-interactive",
    "--no-wait",
    "--json",
  ];
  if (opts.clearCache) args.push("--clear-cache");
  if (opts.autoSubmit) args.push("--auto-submit");
  if (opts.refreshAdHocProvisioningProfile && opts.platform === "ios") {
    args.push("--refresh-ad-hoc-provisioning-profile");
  }

  const { stdout, stderr, code } = await runOnce("npx", args, { cwd: dir });

  const log: string[] = [];
  if (stdout) log.push(...stdout.split(/\r?\n/).filter((l) => l.trim()));
  if (stderr) log.push(...stderr.split(/\r?\n/).filter((l) => l.trim()));

  if (code !== 0) {
    // EAS prints the friendly error on stderr; surface the last line.
    const lastErr =
      stderr
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .slice(-1)[0] ?? "build failed";
    return { ok: false, log, error: lastErr };
  }

  // Parse the JSON envelope. `eas build --json --no-wait` prints either
  // a single object or an array; we accept both.
  let jobId: string | undefined;
  let buildUrl: string | undefined;
  try {
    const raw = stdout.trim();
    const jsonStart =
      raw.indexOf("{") >= 0 && (raw.indexOf("[") < 0 || raw.indexOf("{") < raw.indexOf("["))
        ? raw.indexOf("{")
        : raw.indexOf("[");
    const parsed = JSON.parse(jsonStart >= 0 ? raw.slice(jsonStart) : raw);
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    jobId = first?.id ?? first?.buildId;
    buildUrl = first?.buildUrl ?? first?.url;
  } catch {
    /* fall through with raw log */
  }

  return { ok: true, jobId, buildUrl, log };
}

/**
 * List the most recent EAS builds for this project. Used by the
 * dashboard's polling loop to render progress + the download link.
 */
export async function listEasBuilds(
  opts: { projectDir?: string; limit?: number } = {},
): Promise<EasBuildJob[]> {
  const dir = resolve(opts.projectDir ?? defaultProjectDir());
  if (!existsSync(dir)) return [];
  const limit = opts.limit ?? 10;
  const args = ["eas-cli", "build:list", "--non-interactive", "--json", "--limit", String(limit)];
  const { stdout, code } = await runOnce("npx", args, { cwd: dir });
  if (code !== 0) return [];
  try {
    const arr = JSON.parse(stdout) as Array<Record<string, unknown>>;
    return arr.map(toBuildJob);
  } catch {
    return [];
  }
}

/** List Apple devices registered with EAS for ad hoc/internal iOS installs. */
export async function listEasDevices(
  opts: { projectDir?: string; appleTeamId?: string; limit?: number } = {},
): Promise<EasDevice[]> {
  const dir = resolve(opts.projectDir ?? defaultProjectDir());
  if (!existsSync(dir)) return [];
  const args = [
    "eas-cli",
    "device:list",
    "--non-interactive",
    "--json",
    "--limit",
    String(opts.limit ?? 100),
  ];
  if (opts.appleTeamId) args.push("--apple-team-id", opts.appleTeamId);
  const { stdout, stderr, code } = await runOnce("npx", args, { cwd: dir });
  if (code !== 0) {
    const onlyTeamId = parseOnlyAppleTeamId(stderr || stdout);
    if (onlyTeamId && !opts.appleTeamId) {
      return listEasDevices({ ...opts, appleTeamId: onlyTeamId });
    }
    return [];
  }
  try {
    const arr = JSON.parse(stdout) as Array<Record<string, unknown>>;
    return arr.map(toEasDevice).filter((d) => d.udid);
  } catch {
    return [];
  }
}

/** Cancel an in-flight EAS build. */
export async function cancelEasBuild(
  jobId: string,
  projectDir?: string,
): Promise<{ ok: boolean; error?: string }> {
  const dir = resolve(projectDir ?? defaultProjectDir());
  const { code, stderr } = await runOnce(
    "npx",
    ["eas-cli", "build:cancel", jobId, "--non-interactive"],
    { cwd: dir },
  );
  return { ok: code === 0, error: code === 0 ? undefined : stderr.trim() };
}

/** Quick check that the user has EAS auth set up. Returns the username when logged in. */
export async function whoami(
  projectDir?: string,
): Promise<{ loggedIn: boolean; username?: string; error?: string }> {
  const dir = resolve(projectDir ?? defaultProjectDir());
  const { stdout, code, stderr } = await runOnce(
    "npx",
    ["eas-cli", "whoami", "--non-interactive"],
    { cwd: dir },
  );
  if (code === 0) {
    const username = stdout.trim().split(/\r?\n/).pop() ?? "";
    return { loggedIn: !!username, username };
  }
  // Most common: "Not logged in".
  return { loggedIn: false, error: stderr.trim() || stdout.trim() };
}

// ── Helpers ───────────────────────────────────────────────────

function toBuildJob(raw: Record<string, unknown>): EasBuildJob {
  const status = String(raw.status ?? "unknown").toLowerCase();
  const platform = (String(raw.platform ?? "ios").toLowerCase() as EasBuildPlatform) || "ios";
  return {
    id: String(raw.id ?? raw.buildId ?? ""),
    platform,
    profile: (String(raw.buildProfile ?? raw.profile ?? "preview") as EasBuildProfile) || "preview",
    status: (status as EasBuildJob["status"]) || "unknown",
    artifactUrl:
      typeof raw.artifacts === "object" && raw.artifacts != null
        ? (raw.artifacts as { buildUrl?: string }).buildUrl
        : typeof raw.artifactUrl === "string"
          ? raw.artifactUrl
          : undefined,
    buildUrl: typeof raw.buildUrl === "string" ? raw.buildUrl : undefined,
    startedAt: typeof raw.createdAt === "string" ? raw.createdAt : undefined,
    completedAt: typeof raw.completedAt === "string" ? raw.completedAt : undefined,
    error: typeof raw.error === "string" ? raw.error : undefined,
    raw,
  };
}

function toEasDevice(raw: Record<string, unknown>): EasDevice {
  const udid = String(raw.identifier ?? raw.udid ?? raw.deviceIdentifier ?? raw.id ?? "");
  return {
    id: String(raw.id ?? udid),
    name: typeof raw.name === "string" ? raw.name : undefined,
    udid,
    platform: typeof raw.platform === "string" ? raw.platform : undefined,
    appleTeamId:
      typeof raw.appleTeamId === "string"
        ? raw.appleTeamId
        : typeof (raw.appleTeam as { id?: unknown } | undefined)?.id === "string"
          ? String((raw.appleTeam as { id: string }).id)
          : undefined,
    status: typeof raw.status === "string" ? raw.status : undefined,
    raw,
  };
}

function parseOnlyAppleTeamId(output: string): string | undefined {
  const matches = [...output.matchAll(/\(([A-Z0-9]{10})\)/g)].map((m) => m[1]);
  return matches.length === 1 ? matches[0] : undefined;
}

function runOnce(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number },
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise) => {
    const proc = spawn(cmd, args, {
      cwd: opts.cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "1" },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolvePromise({ stdout, stderr: stderr + "\n[timeout]", code: 124 });
    }, opts.timeoutMs ?? 120_000);
    proc.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString();
    });
    proc.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString();
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, code: code ?? -1 });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr: stderr + "\n" + err.message, code: -1 });
    });
  });
}
