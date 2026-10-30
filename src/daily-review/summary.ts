/**
 * End-of-day summary: 3-6 bullets (what shipped, what's blocked, tomorrow's
 * top 3) written by a small model from the *compact* rollup (capped context),
 * saved with the day, and optionally delivered to Telegram.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compactDay } from "./compact.js";
import type { DailyReviewConfig, DayRollup, DaySummary } from "./types.js";
import { analyticsDir, clean } from "./util.js";

const PROMPT_CAP = 5000;

export function buildSummaryPrompt(day: DayRollup): string {
  return [
    "You write the owner's end-of-day work summary for their AI operating system (InfiniBot).",
    "From the day data below, write 3 to 6 short bullets in plain English:",
    "1-3 bullets on what shipped (be concrete: product + what changed), 1 bullet on what is blocked or needs the owner,",
    "and a final bullet that starts with 'Tomorrow:' listing the top 3 next moves.",
    "No emoji, no markdown headings, no preamble. Each bullet under 160 characters.",
    'Reply with JSON only: {"bullets":["...","..."]}',
    "",
    "DAY DATA:",
    compactDay(day, PROMPT_CAP),
  ].join("\n");
}

export function parseBullets(text: string): string[] | null {
  const m = /\{[\s\S]*"bullets"[\s\S]*\}/.exec(text);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as { bullets?: unknown };
    if (!Array.isArray(o.bullets)) return null;
    const bullets = o.bullets
      .filter((b): b is string => typeof b === "string" && b.trim().length > 0)
      .map((b) => clean(b.replace(/^[-*•]\s*/, ""), 220))
      .slice(0, 6);
    return bullets.length >= 2 ? bullets : null;
  } catch {
    return null;
  }
}

/** Deterministic fallback when no model is reachable. */
export function fallbackBullets(day: DayRollup): string[] {
  const t = day.totals;
  const out: string[] = [];
  const shipped = day.accomplishments.filter((a) => a.kind !== "merge").slice(0, 3);
  if (shipped.length)
    out.push(`Shipped: ${shipped.map((a) => `${a.project}: ${a.title}`).join("; ")}`.slice(0, 220));
  out.push(
    `${t.verified} verified tasks, ${t.deploys} deploys and ${t.commits} commits across ${t.reposTouched} repos; ${Math.round(t.agentMinutes / 60)} agent-hours.`,
  );
  if (t.failed || t.needsYou || t.incidents) {
    out.push(
      `Attention: ${t.failed} failed, ${t.needsYou + t.unverified} waiting on review, ${t.incidents} gateway incidents.`,
    );
  }
  const next = [
    ...day.needsYou.slice(0, 2).map((n) => n.title),
    ...day.inProgress.slice(0, 3).map((n) => n.title),
  ].slice(0, 3);
  if (next.length) out.push(`Tomorrow: ${next.join("; ")}`.slice(0, 220));
  return out;
}

function runClaude(prompt: string, model: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const cwd = analyticsDir();
    fs.mkdirSync(cwd, { recursive: true });
    const child = spawn(
      "claude",
      [
        "--print",
        "--model",
        model,
        "--output-format",
        "text",
        "--strict-mcp-config",
        "--max-turns",
        "1",
      ],
      { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env },
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("summary model timed out"));
    }, timeoutMs);
    child.stdout.on("data", (b) => {
      if (out.length < 64_000) out += String(b);
    });
    child.stderr.on("data", (b) => {
      if (err.length < 4000) err += String(b);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`claude exited ${code}: ${clean(err, 200)}`));
    });
    child.stdin.end(prompt);
  });
}

export async function generateSummary(day: DayRollup, cfg: DailyReviewConfig): Promise<DaySummary> {
  try {
    const text = await runClaude(buildSummaryPrompt(day), cfg.summary.model || "haiku");
    const bullets = parseBullets(text);
    if (bullets)
      return { bullets, generatedAt: Date.now(), by: `claude ${cfg.summary.model || "haiku"}` };
  } catch {
    /* fall back */
  }
  return { bullets: fallbackBullets(day), generatedAt: Date.now(), by: "rule-based fallback" };
}

// ── Telegram delivery through the InfiniBot CLI (`message send`) ─────────────

export function telegramText(day: DayRollup): string {
  const t = day.totals;
  const when = new Date(`${day.date}T12:00:00`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const lines = [
    `Daily review, ${when}: ${day.score.value}/100 (${day.score.grade})`,
    "",
    ...(day.summary?.bullets ?? fallbackBullets(day)).map((b) => `- ${b}`),
    "",
    `${t.verified} verified · ${t.deploys} deploys · ${t.commits} commits · ${Math.round(t.agentMinutes / 60)} agent-h · $${Math.round(t.costUsd)}`,
  ];
  return lines.join("\n").slice(0, 3800);
}

function cliEntry(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "dist", "entry.js");
}

function runSend(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliEntry(), "message", "send", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let out = "";
    child.stdout.on("data", (b) => (out += String(b)));
    child.stderr.on("data", (b) => (out += String(b)));
    const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out: out.slice(-2000) });
    });
  });
}

/** Send text (and optional media) with retry on Telegram 429s. */
export async function sendTelegram(
  cfg: DailyReviewConfig,
  message: string,
  media?: string,
): Promise<{ ok: boolean; detail: string }> {
  const args = [
    "--channel",
    cfg.telegram.channel || "telegram",
    "-t",
    cfg.telegram.target,
    "-m",
    message,
    "--json",
  ];
  if (media) args.push("--media", media);
  let last = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await runSend(args);
    // The CLI can exit non-zero after a successful send: trust the payload.
    if (r.code === 0 || /"ok":\s*true/.test(r.out)) {
      return { ok: true, detail: clean(/"messageId":\s*"?(\d+)/.exec(r.out)?.[1] ?? r.out, 300) };
    }
    last = clean(r.out, 300);
    const retryAfter = /retry after (\d+)/i.exec(r.out)?.[1];
    if (!/429|too many requests|retry after/i.test(r.out)) break;
    await new Promise((res) =>
      setTimeout(res, (Number(retryAfter) || 2 ** attempt * 3) * 1000 + 500),
    );
  }
  return { ok: false, detail: last };
}
