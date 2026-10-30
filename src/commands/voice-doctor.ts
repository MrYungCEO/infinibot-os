/**
 * `infinibot voice doctor` — end-to-end health check for the voice stack.
 *
 * Checks: config valid, API keys reachable (cloud), models/containers present
 * (native), mic + speaker device hints, and a sample round-trip latency.
 * Prints a pass/fail table and exits non-zero on any hard failure.
 *
 * The check logic is split from the printer so it's unit-testable: pass a
 * `setup` + an injectable `reach` and assert on the returned report.
 */
import type { Command } from "commander";

import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { resolveVoiceUrls } from "../gateway/server-voice-urls.js";
import { loadVoiceSetup } from "../voice/config.js";
import { VoiceSetupSchema, type VoiceSetupConfig } from "../voice/schema.js";
import { runVoiceSmokeTest } from "../voice/smoke-test.js";

export type DoctorStatus = "pass" | "fail" | "warn";

export type DoctorCheck = {
  name: string;
  status: DoctorStatus;
  detail: string;
  ms?: number;
};

export type DoctorReport = {
  checks: DoctorCheck[];
  /** False when any check is "fail". "warn" does not fail the report. */
  ok: boolean;
};

/** Reachability probe: returns ok + latency, injectable for tests. */
export type ReachProbe = (
  url: string,
  opts?: { headers?: Record<string, string>; timeoutMs?: number },
) => Promise<{ ok: boolean; status?: number; ms: number; error?: string }>;

export const defaultReach: ReachProbe = async (url, opts) => {
  const timeoutMs = opts?.timeoutMs ?? 4000;
  const start = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { headers: opts?.headers, signal: ctrl.signal });
    clearTimeout(timer);
    return { ok: res.ok || res.status < 500, status: res.status, ms: Date.now() - start };
  } catch (err) {
    return { ok: false, ms: Date.now() - start, error: (err as Error).message };
  }
};

/** Provider API base for the cloud reachability check. */
function cloudCheckUrl(
  setup: VoiceSetupConfig,
): { url: string; headers: Record<string, string> } | null {
  const c = setup.cloud;
  if (!c?.apiKey) return null;
  if (c.tts === "elevenlabs") {
    return { url: "https://api.elevenlabs.io/v1/voices", headers: { "xi-api-key": c.apiKey } };
  }
  if (c.tts === "edge") {
    // Edge TTS needs no key/endpoint — nothing to reach.
    return null;
  }
  // openai (STT is always openai; TTS openai) → list models with the key.
  return {
    url: "https://api.openai.com/v1/models",
    headers: { Authorization: `Bearer ${c.apiKey}` },
  };
}

export async function runVoiceDoctorChecks(opts?: {
  setup?: VoiceSetupConfig | null;
  reach?: ReachProbe;
  runSmoke?: boolean;
}): Promise<DoctorReport> {
  const reach = opts?.reach ?? defaultReach;
  const checks: DoctorCheck[] = [];

  // 1. Config valid.
  const setup = opts?.setup !== undefined ? opts.setup : await loadVoiceSetup();
  if (!setup) {
    checks.push({
      name: "config",
      status: "fail",
      detail: "no voice config — run `infinibot onboard` or the setup UI",
    });
    return { checks, ok: false };
  }
  const parsed = VoiceSetupSchema.safeParse(setup);
  if (!parsed.success) {
    checks.push({
      name: "config",
      status: "fail",
      detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    });
    return { checks, ok: false };
  }
  checks.push({ name: "config", status: "pass", detail: `provider = ${setup.provider}` });

  if (setup.provider === "cloud") {
    // 2a. API key present + reachable.
    if (!setup.cloud?.apiKey) {
      checks.push({ name: "api-key", status: "fail", detail: "cloud provider has no API key" });
    } else {
      checks.push({ name: "api-key", status: "pass", detail: `${setup.cloud.tts} key set` });
      const target = cloudCheckUrl(setup);
      if (target) {
        const r = await reach(target.url, { headers: target.headers });
        checks.push({
          name: "api-reachable",
          status: r.ok ? "pass" : "fail",
          detail: r.ok
            ? `${target.url} → ${r.status}`
            : `unreachable${r.status ? ` (${r.status})` : ""}: ${r.error ?? "auth/network"}`,
          ms: r.ms,
        });
      }
    }
  } else {
    // 2b. Native containers reachable.
    const urls = resolveVoiceUrls();
    const tts = await reach(`${urls.kokoro}/v1/audio/voices`);
    checks.push({
      name: "kokoro-tts",
      status: tts.ok ? "pass" : "fail",
      detail: tts.ok ? `${urls.kokoro} → ${tts.status}` : `unreachable: ${tts.error ?? tts.status}`,
      ms: tts.ms,
    });
    const stt = await reach(`${urls.speaches}/v1/models`);
    checks.push({
      name: "speaches-stt",
      status: stt.ok ? "pass" : "fail",
      detail: stt.ok
        ? `${urls.speaches} → ${stt.status}`
        : `unreachable: ${stt.error ?? stt.status}`,
      ms: stt.ms,
    });
    checks.push({
      name: "stt-model",
      status: setup.native?.sttModel ? "pass" : "warn",
      detail: setup.native?.sttModel ?? "no model pinned (using server default)",
    });
  }

  // 3. Device hints (best-effort; server-side can't open hardware).
  checks.push({
    name: "mic-device",
    status: "warn",
    detail: "verified in-browser during the live smoke test",
  });
  checks.push({
    name: "speaker-device",
    status: "warn",
    detail: "verified in-browser during the live smoke test",
  });

  // 4. Round-trip latency (optional; default on for the CLI).
  if (opts?.runSmoke !== false) {
    const start = Date.now();
    const smoke = await runVoiceSmokeTest({ setup, persist: true });
    checks.push({
      name: "round-trip",
      status: smoke.pass ? "pass" : "fail",
      detail: smoke.pass ? smoke.message : `failed at ${smoke.stage}: ${smoke.message}`,
      ms: Date.now() - start,
    });
  }

  const ok = !checks.some((c) => c.status === "fail");
  return { checks, ok };
}

const STATUS_GLYPH: Record<DoctorStatus, string> = { pass: "✓", fail: "✗", warn: "•" };

export function formatDoctorReport(report: DoctorReport): string {
  const nameW = Math.max(6, ...report.checks.map((c) => c.name.length));
  const lines = report.checks.map((c) => {
    const glyph = STATUS_GLYPH[c.status];
    const ms = c.ms !== undefined ? ` (${c.ms}ms)` : "";
    return `  ${glyph}  ${c.name.padEnd(nameW)}  ${c.detail}${ms}`;
  });
  const header = "Voice doctor";
  const footer = report.ok ? "All checks passed." : "One or more checks failed.";
  return [header, "─".repeat(header.length + 20), ...lines, "", footer].join("\n");
}

/** CLI entrypoint. Returns the report; prints the table and sets exit code. */
export async function voiceDoctorCommand(
  runtime: RuntimeEnv,
  opts: { json?: boolean; noSmoke?: boolean } = {},
): Promise<DoctorReport> {
  const report = await runVoiceDoctorChecks({ runSmoke: !opts.noSmoke });
  if (opts.json) {
    runtime.log(JSON.stringify(report, null, 2));
  } else {
    runtime.log(formatDoctorReport(report));
  }
  if (!report.ok) runtime.exit(1);
  return report;
}

/**
 * Register the standalone `infinibot doctor:voice` command. Mirrors the
 * commander-registration pattern used by the other `commands/*` entries
 * (a thin wrapper that calls the command's runner with `defaultRuntime`).
 */
export function registerVoiceDoctorCommand(program: Command): void {
  program
    .command("doctor:voice")
    .description("Diagnose the voice setup (config, API keys, round-trip)")
    .option("--json", "Output JSON", false)
    .option("--no-smoke", "Skip the round-trip smoke test")
    .action(async (opts: { json?: boolean; smoke?: boolean }) => {
      await voiceDoctorCommand(defaultRuntime, {
        json: opts.json === true,
        // commander stores `--no-smoke` as `smoke === false`.
        noSmoke: opts.smoke === false,
      });
    });
}
