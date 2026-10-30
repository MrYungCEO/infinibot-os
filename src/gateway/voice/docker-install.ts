/**
 * Docker voice-stack install + lifecycle.
 *
 * The Docker voice mode runs LiveKit (7882), Speaches STT (8002) and Kokoro TTS
 * (8882) from `docker-compose.voice.yaml`. This module makes the Quickstart
 * "Docker" step (and the gateway-start auto-run) ACTUALLY bring the stack up:
 *
 *   1. verify the docker daemon is reachable (else fail loud)
 *   2. ensure ~/.infinibot/.env has LIVEKIT_API_KEY/SECRET (random if missing)
 *   3. `docker compose … pull`  (streamed)
 *   4. `docker compose … up -d` (idempotent — no-op if already running)
 *   5. poll Speaches/Kokoro/LiveKit for up to 30s; report per-service health
 *
 * The gateway OWNS the stack lifecycle: it can start it on boot (ensureDockerVoiceStack)
 * but deliberately leaves containers up on shutdown (other apps may use voice).
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

import { STATE_DIR } from "../../config/paths.js";
import { isNixMode } from "../../config/paths.js";
import { checkDocker, DOCKER_INSTALL_URL } from "./docker-check.js";
import { resolveComposeFile } from "../kokoro-bootstrap.js";

export type DockerInstallPhase = "docker-check" | "env" | "pull" | "up" | "health" | "done";

export interface DockerInstallEvents {
  onLine?: (line: string) => void;
  onPhase?: (phase: DockerInstallPhase, status: string) => void;
}

export interface DockerServiceHealth {
  name: string;
  url: string;
  reachable: boolean;
}

export interface DockerInstallReport {
  ok: boolean;
  services: DockerServiceHealth[];
  notes: string[];
}

const ENV_FILE = path.join(STATE_DIR, ".env");

/** Host-side health URLs for the three voice services (fixed compose ports). */
const HEALTH_TARGETS: Array<{ name: string; url: string }> = [
  { name: "speaches", url: "http://localhost:8002/v1/models" },
  { name: "kokoro", url: "http://localhost:8882/v1/models" },
  { name: "livekit", url: "http://localhost:7882" },
];

function genSecret(bytes = 24): string {
  return randomBytes(bytes).toString("hex");
}

/**
 * Ensure ~/.infinibot/.env carries the LiveKit key/secret the compose file
 * requires (`${LIVEKIT_API_KEY:?…}`). Generates random values when missing and
 * preserves any other keys already in the file. Returns true when it wrote.
 */
export function ensureVoiceEnvFile(events?: DockerInstallEvents): boolean {
  events?.onPhase?.("env", "ensuring LiveKit secrets in ~/.infinibot/.env");
  let lines: string[] = [];
  const have = new Set<string>();
  if (fs.existsSync(ENV_FILE)) {
    lines = fs.readFileSync(ENV_FILE, "utf-8").split(/\r?\n/);
    for (const l of lines) {
      const m = l.match(/^\s*([A-Z0-9_]+)\s*=/);
      if (m) have.add(m[1]);
    }
  }
  const additions: string[] = [];
  if (!have.has("LIVEKIT_API_KEY")) additions.push(`LIVEKIT_API_KEY=${genSecret(8)}`);
  if (!have.has("LIVEKIT_API_SECRET")) additions.push(`LIVEKIT_API_SECRET=${genSecret(24)}`);
  if (additions.length === 0) {
    events?.onLine?.("LiveKit secrets already present");
    return false;
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const body = [...lines.filter((l) => l.trim() !== ""), ...additions].join("\n") + "\n";
  fs.writeFileSync(ENV_FILE, body, { mode: 0o600 });
  events?.onLine?.(`wrote ${additions.length} LiveKit secret(s) to ${ENV_FILE}`);
  return true;
}

function runStreamed(args: string[], cwd: string, events?: DockerInstallEvents): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { cwd, env: process.env });
    const pump = (buf: Buffer) => {
      for (const line of buf.toString().split(/\r?\n/)) {
        if (line.trim()) events?.onLine?.(line.trimEnd());
      }
    };
    child.stdout?.on("data", pump);
    child.stderr?.on("data", pump);
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`docker ${args.join(" ")} exited with code ${code}`)),
    );
  });
}

async function probe(url: string, timeoutMs = 2500): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status > 0;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Full Docker voice-stack install. Throws (fail-loud) when docker is
 * unavailable or the compose file can't be found; returns a report with
 * per-service health otherwise (ok = all three reachable).
 */
export async function installDockerVoiceStack(
  events?: DockerInstallEvents,
): Promise<DockerInstallReport> {
  const notes: string[] = [];

  if (isNixMode) {
    throw new Error(
      "Docker voice auto-install is disabled under Nix — manage the stack externally.",
    );
  }

  events?.onPhase?.("docker-check", "checking docker daemon");
  const docker = await checkDocker({ force: true });
  if (!docker.available) {
    const detail =
      docker.error ?? (docker.cliPresent ? "docker daemon not running" : "docker CLI not found");
    throw new Error(
      `Docker not running — ${detail}. Start Docker Desktop / dockerd (or install Docker: ${DOCKER_INSTALL_URL}), ` +
        `or pick the on-machine (native) voice mode.`,
    );
  }
  events?.onLine?.(`docker ${docker.version ?? ""} reachable`);

  const composeFile = resolveComposeFile();
  if (!composeFile) {
    throw new Error("Cannot find docker-compose.voice.yaml — is the InfiniBot repo intact?");
  }
  const cwd = path.dirname(composeFile);

  // .env must exist BEFORE pull/up (livekit command interpolates the secrets).
  ensureVoiceEnvFile(events);

  const baseArgs = ["compose", "-f", composeFile, "--env-file", ENV_FILE];

  events?.onPhase?.("pull", "pulling voice images (livekit, speaches, kokoro)");
  await runStreamed([...baseArgs, "pull"], cwd, events);

  events?.onPhase?.("up", "starting containers (docker compose up -d)");
  await runStreamed([...baseArgs, "up", "-d"], cwd, events);

  events?.onPhase?.("health", "waiting for services to answer (up to 30s)");
  const deadline = Date.now() + 30_000;
  const services: DockerServiceHealth[] = HEALTH_TARGETS.map((t) => ({ ...t, reachable: false }));
  while (Date.now() < deadline) {
    await Promise.all(
      services.map(async (s) => {
        if (!s.reachable) s.reachable = await probe(s.url);
      }),
    );
    const up = services.filter((s) => s.reachable).map((s) => s.name);
    events?.onLine?.(`reachable: ${up.length ? up.join(", ") : "none yet"}`);
    if (services.every((s) => s.reachable)) break;
    await sleep(2000);
  }

  for (const s of services) {
    if (!s.reachable) {
      notes.push(
        `${s.name} not reachable at ${s.url} within 30s` +
          (s.name === "speaches" ? " (the Speaches image is CUDA-only — needs an NVIDIA GPU)" : ""),
      );
    }
  }

  const ok = services.every((s) => s.reachable);
  events?.onPhase?.("done", ok ? "voice stack up" : "voice stack partially up");
  return { ok, services, notes };
}

/**
 * Gateway-start auto-run for Docker voice mode: idempotently `up -d` the stack.
 * Best-effort — logs and resolves false on failure so the gateway keeps booting.
 */
export async function ensureDockerVoiceStack(): Promise<boolean> {
  try {
    if (isNixMode) return false;
    const docker = await checkDocker();
    if (!docker.available) {
      console.warn("[voice-docker] docker unavailable — skipping voice stack auto-start");
      return false;
    }
    const composeFile = resolveComposeFile();
    if (!composeFile) return false;
    ensureVoiceEnvFile();
    // Detached, fire-and-forget: up -d is a no-op when already running.
    const child = spawn(
      "docker",
      ["compose", "-f", composeFile, "--env-file", ENV_FILE, "up", "-d"],
      { cwd: path.dirname(composeFile), detached: true, stdio: "ignore", env: process.env },
    );
    child.on("error", (err) =>
      console.warn(
        `[voice-docker] compose up failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    child.unref();
    return true;
  } catch (err) {
    console.warn(
      `[voice-docker] ensureDockerVoiceStack error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
