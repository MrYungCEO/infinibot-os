/**
 * visual_verify — the standard visual verification primitive.
 *
 * Available to every agent (gateway tool registry → MCP), so Claude Code,
 * Codex, OpenCode and Gemini sub-agents all get the same harness. Spawns
 * runner-cli.ts in a child process, then asks a vision model whether the
 * screenshots match the stated expectation.
 *
 * Output: `<stateDir>/verification/<runId>/visual-<ts>/` with one PNG per
 * route × viewport × theme (+ crops) and `report.json`.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../../config/config.js";
import { resolveGatewayPort } from "../../config/paths.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { countRealConsoleErrors, partitionConsoleMessages } from "../console-noise.js";
import { noteRunScreenshots } from "../screenshot-index.js";
import { verificationDir, verificationRunDir } from "../store.js";
import type { VisualAction, VisualCrop, VisualRunConfig, VisualRunReport } from "./runner-cli.js";

const log = createSubsystemLogger("verification.visual");

export interface VisualVerifyInput {
  routes: string[];
  /** Worktree whose `dist/control-ui` to serve. Omit / "live" to use the live gateway UI. */
  worktree?: string | null;
  /** Explicit static dir to serve instead of `<worktree>/dist/control-ui`. */
  distDir?: string | null;
  /** Load an arbitrary URL base instead (e.g. a dev server). */
  baseUrl?: string | null;
  viewports?: Array<{ width: number; height: number; name?: string }>;
  themes?: string[];
  actions?: VisualAction[];
  crops?: VisualCrop[];
  waitFor?: string | null;
  settleMs?: number;
  /** What the change should look like — the vision model grades against it. */
  expectation?: string | null;
  /** Baseline screenshots to compare against (same order as captured shots, or a dir). */
  compareTo?: string[] | string | null;
  runId?: string | null;
  gatewayPort?: number | null;
  timeoutSec?: number;
  fullPage?: boolean;
  /** Skip the vision assessment (screenshots + diagnostics only). */
  skipAssessment?: boolean;
}

export interface VisualAssessment {
  available: boolean;
  pass: boolean | null;
  summary: string;
  issues: string[];
}

export interface VisualVerifyResult {
  ok: boolean;
  outDir: string;
  reportPath: string;
  screenshots: string[];
  crops: string[];
  shots: VisualRunReport["shots"];
  consoleErrors: number;
  /** Benign headless noise (GL driver messages …) that was NOT counted as console errors. */
  benignConsole?: number;
  failedRpcs: number;
  assessment: VisualAssessment | null;
  error?: string;
}

export const DEFAULT_VIEWPORTS = [
  { width: 1440, height: 900, name: "desktop" },
  { width: 390, height: 844, name: "mobile" },
];

function runnerPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const js = path.join(here, "runner-cli.js");
  if (existsSync(js)) return js;
  return path.join(here, "runner-cli.ts");
}

function resolveAuth(): { password?: string; token?: string } {
  try {
    const cfg = loadConfig();
    const auth = (cfg.gateway?.auth ?? {}) as { password?: string; token?: string };
    return {
      password: process.env.INFINIBOT_GATEWAY_PASSWORD || auth.password || undefined,
      token: process.env.INFINIBOT_GATEWAY_TOKEN || auth.token || undefined,
    };
  } catch {
    return {
      password: process.env.INFINIBOT_GATEWAY_PASSWORD,
      token: process.env.INFINIBOT_GATEWAY_TOKEN,
    };
  }
}

function resolvePort(explicit?: number | null): number {
  if (explicit) return explicit;
  try {
    return resolveGatewayPort(loadConfig());
  } catch {
    return Number(process.env.INFINIBOT_GATEWAY_PORT) || 18789;
  }
}

function runChild(
  configPath: string,
  timeoutSec: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const script = runnerPath();
  const args = script.endsWith(".ts")
    ? ["--import", "tsx", script, configPath]
    : [script, configPath];
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 20_000) stderr = stderr.slice(-10_000);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutSec * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: String(err) });
    });
  });
}

const ASSESS_PROMPT = `You are reviewing UI screenshots to verify a visual change.

EXPECTATION (what the change should achieve):
{expectation}

SCREENSHOTS (in order): {list}
{baseline}
DIAGNOSTICS: {diag}

Look at every screenshot. Check the expectation is visibly met, and look for defects: overlapping or clipped elements, broken layout, unreadable text/contrast, blank or error states, horizontal overflow on mobile.
Respond with STRICT JSON only: {"pass": boolean, "summary": "1-2 sentences", "issues": ["..."]}`;

async function assess(
  shots: string[],
  expectation: string,
  baseline: string[],
  diag: string,
): Promise<VisualAssessment> {
  const { judgeText } = await import("../../autonomy/goal-judge.js");
  const images = [...shots.slice(0, 6), ...baseline.slice(0, 2)];
  const prompt = ASSESS_PROMPT.replace("{expectation}", expectation)
    .replace("{list}", shots.map((s) => path.basename(s)).join(", "))
    .replace(
      "{baseline}",
      baseline.length
        ? `BASELINE (before) screenshots are attached after the new ones: ${baseline.map((b) => path.basename(b)).join(", ")}\n`
        : "",
    )
    .replace("{diag}", diag);
  const text = await judgeText({
    system: "You are a meticulous visual QA reviewer. Output strict JSON only.",
    prompt,
    maxTokens: 700,
    imagePaths: images,
  });
  if (!text.trim())
    return { available: false, pass: null, summary: "vision reviewer unavailable", issues: [] };
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  try {
    const o = JSON.parse(text.slice(s, e + 1)) as {
      pass?: unknown;
      summary?: unknown;
      issues?: unknown;
    };
    return {
      available: true,
      pass: o.pass === true,
      summary: typeof o.summary === "string" ? o.summary : "",
      issues: Array.isArray(o.issues) ? o.issues.map(String).slice(0, 12) : [],
    };
  } catch {
    return {
      available: false,
      pass: null,
      summary: `vision reply unparseable: ${text.slice(0, 120)}`,
      issues: [],
    };
  }
}

export async function runVisualVerify(input: VisualVerifyInput): Promise<VisualVerifyResult> {
  const routes = (input.routes ?? []).filter((r) => typeof r === "string" && r.trim());
  if (routes.length === 0) throw new Error("visual_verify: at least one route is required");
  const runKey = input.runId || process.env.INFINIBOT_SUBAGENT_RUN_ID || "adhoc";
  const outDir = path.join(verificationRunDir(runKey), `visual-${Date.now().toString(36)}`);
  mkdirSync(outDir, { recursive: true });
  const port = resolvePort(input.gatewayPort);
  const auth = resolveAuth();

  let serveDir: string | null = null;
  const live = !input.worktree || input.worktree === "live";
  if (input.distDir) serveDir = input.distDir;
  else if (!live) serveDir = path.join(input.worktree!, "dist", "control-ui");
  if (serveDir && !existsSync(path.join(serveDir, "index.html"))) {
    throw new Error(
      `visual_verify: ${serveDir}/index.html not found — build the UI first (pnpm -C ui build in the worktree)`,
    );
  }

  const config: VisualRunConfig = {
    outDir,
    routes,
    viewports: input.viewports?.length ? input.viewports : DEFAULT_VIEWPORTS,
    themes: input.themes?.length ? input.themes : ["dark"],
    serveDir,
    baseUrl: serveDir ? null : input.baseUrl || `http://127.0.0.1:${port}`,
    gatewayUrl: `ws://127.0.0.1:${port}`,
    gatewayHttp: `http://127.0.0.1:${port}`,
    password: auth.password,
    token: auth.token,
    actions: input.actions,
    crops: input.crops,
    waitFor: input.waitFor ?? null,
    settleMs: input.settleMs,
    fullPage: input.fullPage,
  };
  const configPath = path.join(outDir, "config.json");
  // Never persist the credential to disk in the readable config copy.
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const budget =
    input.timeoutSec ??
    Math.min(600, 60 + routes.length * config.viewports.length * config.themes.length * 30);
  const child = await runChild(configPath, budget);
  try {
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          ...config,
          password: config.password ? "[redacted]" : "",
          token: config.token ? "[redacted]" : "",
        },
        null,
        2,
      ),
    );
  } catch {
    /* ignore */
  }
  const reportPath = path.join(outDir, "report.json");
  let report: VisualRunReport | null = null;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8")) as VisualRunReport;
  } catch {
    report = null;
  }
  if (!report) {
    log.warn("visual runner produced no report", {
      code: child.code,
      stderr: child.stderr.slice(-400),
    });
    return {
      ok: false,
      outDir,
      reportPath,
      screenshots: [],
      crops: [],
      shots: [],
      consoleErrors: 0,
      failedRpcs: 0,
      assessment: null,
      error: `visual runner failed (exit ${child.code}): ${child.stderr.slice(-600) || "no output"}`,
    };
  }
  const screenshots = report.shots.filter((s) => existsSync(s.path)).map((s) => s.path);
  const crops = report.shots.flatMap((s) => s.crops.map((c) => c.path));
  // Re-partition too: a runner from an older build may still mix in GL noise.
  const { errors: consoleErrors, benign: benignConsole } = countRealConsoleErrors(report.shots);
  const failedRpcs = report.shots.reduce((n, s) => n + s.failedRpcs.length, 0);

  let baseline: string[] = [];
  if (typeof input.compareTo === "string" && existsSync(input.compareTo)) {
    const { readdirSync } = await import("node:fs");
    baseline = readdirSync(input.compareTo)
      .filter((f) => /\.png$/i.test(f))
      .map((f) => path.join(input.compareTo as string, f));
  } else if (Array.isArray(input.compareTo)) {
    baseline = input.compareTo.filter((f) => existsSync(f));
  }

  let assessment: VisualAssessment | null = null;
  if (!input.skipAssessment && screenshots.length > 0) {
    const diag = report.shots
      .map(
        (s) =>
          `${s.route}@${s.viewport}/${s.theme}: ${s.error ? `ERROR ${s.error}; ` : ""}${partitionConsoleMessages(s.consoleErrors).errors.length} console errors, ${s.pageErrors.length} page exceptions, ${s.failedRpcs.length} failed RPCs${
            s.failedRpcs.length
              ? ` (${s.failedRpcs
                  .slice(0, 3)
                  .map((r) => `${r.method}: ${r.error}`)
                  .join("; ")})`
              : ""
          }`,
      )
      .join("\n");
    assessment = await assess(
      [...crops, ...screenshots],
      input.expectation?.trim() || "The page renders correctly with no layout defects.",
      baseline,
      diag,
    ).catch((err) => ({ available: false, pass: null, summary: String(err), issues: [] }));
  }
  const result: VisualVerifyResult = {
    ok: report.ok && screenshots.length > 0 && assessment?.pass !== false,
    outDir,
    reportPath,
    screenshots,
    crops,
    shots: report.shots,
    consoleErrors,
    benignConsole,
    failedRpcs,
    assessment,
    error: report.error,
  };
  try {
    writeFileSync(path.join(outDir, "result.json"), JSON.stringify(result, null, 2));
  } catch {
    /* ignore */
  }
  // Live: the Executive Island gallery picks up the new capture.
  try {
    noteRunScreenshots(runKey);
  } catch {
    /* gallery is best effort */
  }
  return result;
}

export { verificationDir };
