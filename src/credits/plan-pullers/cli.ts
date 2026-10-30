/**
 * CLI-based plan / usage / auth detection.
 *
 * The HTTP pullers (anthropic/openai admin APIs) only work for users who have
 * pasted a provider **API key** into our config. But most InfiniBot installs
 * authenticate the coding CLIs via OAuth / subscription login (`claude`,
 * `codex login`, `opencode auth login`, `gemini`) and have **no** API key in
 * our config at all. For those users the only source of plan + auth truth is
 * the CLI itself or the local credential cache it writes.
 *
 * This module shells out to each CLI (or reads its auth file) to detect:
 *   - whether the CLI is installed,
 *   - whether it is authenticated (logged-in vs auth-required),
 *   - the subscription plan / tier, and
 *   - real token + cost usage where the CLI exposes it.
 *
 * Provider → CLI mapping and capability (researched live, 2026-06-18):
 *
 *   provider   CLI        command / source                       gives usage?
 *   ────────   ────────   ────────────────────────────────────   ───────────
 *   anthropic  claude     ~/.claude/.credentials.json            no (plan+auth only)
 *                         (claudeAiOauth.subscriptionType /
 *                          rateLimitTier / expiresAt)
 *   openai     codex      id_token JWT in ~/.codex/auth.json      no (plan+auth only)
 *                         + `codex login status`
 *   opencode   opencode   `opencode stats --days 30`             YES (cost + tokens)
 *   google     gemini     ~/.gemini/oauth_creds.json             no (auth only)
 *
 * `claude /status`, `codex` and `gemini` expose NO machine-readable usage
 * subcommand non-interactively (verified), so for those we read the credential
 * cache for plan/auth and leave the numbers to the local-ledger estimate.
 *
 * NEVER throws — every probe returns a `CliPlanProbe` describing what it found.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveBin, enrichedPathEnv } from "../../agents/coder-backend/bin-detect.js";
import type { ProviderPlanConfig } from "../plan-config.js";
import { getPlanDef } from "../plans/index.js";
import { currentMonthPeriod, estimatedUsage, localMonthUsage, round2 } from "./estimate.js";
import type { ProviderPlanUsage } from "./types.js";
import { resolveCliInvocation } from "../../process/win-spawn.js";

const log = createSubsystemLogger("credits").child("puller.cli");

export type CliAuthState = "ok" | "auth-required" | "not-installed" | "unknown";

export interface CliPlanProbe {
  /** CLI binary name probed (claude / codex / opencode / gemini). */
  cli: string;
  installed: boolean;
  authState: CliAuthState;
  /** Detected plan/tier id, aligned to the plan registry (max, pro, plus, …). */
  plan?: string;
  /** Real spend this period, if the CLI exposes it (opencode only). */
  usedUsd?: number;
  /** Real tokens this period, if the CLI exposes it (opencode only). */
  usedTokens?: number;
  /** Window the usage covers, e.g. "last 30d" or "all-time". */
  periodLabel?: string;
  message: string;
  durationMs: number;
}

/** Run a CLI with the enriched PATH; capture stdout. Never throws. */
function runCli(
  bin: string,
  args: string[],
  timeoutMs = 15_000,
): { ok: boolean; stdout: string; stderr: string } {
  // Windows .cmd shims (codex.cmd, gemini.cmd) → real target, or execFileSync
  // throws EINVAL (CVE-2024-27980).
  const inv = resolveCliInvocation(resolveBin(bin) ?? bin, args);
  try {
    const stdout = execFileSync(inv.command, inv.args, {
      ...(inv.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
      env: enrichedPathEnv(),
      maxBuffer: 4 * 1024 * 1024,
    }).toString();
    return { ok: true, stdout, stderr: "" };
  } catch (e: unknown) {
    const err = e as { stdout?: Buffer; stderr?: Buffer };
    return {
      ok: false,
      stdout: err.stdout?.toString?.() ?? "",
      stderr: err.stderr?.toString?.() ?? String(e),
    };
  }
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Decode a JWT payload without verifying the signature (claims-only). */
function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  try {
    const part = token.split(".")[1];
    if (!part) return undefined;
    const pad = part + "=".repeat((4 - (part.length % 4)) % 4);
    const json = Buffer.from(pad.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Parse a human-formatted number from `opencode stats`:
 *   "$29.21" → 29.21 ; "270.0M" → 270000000 ; "1.8M" → 1800000 ; "4,752" → 4752
 */
export function parseHumanNumber(raw: string): number | undefined {
  const m = raw
    .trim()
    .replace(/\$/g, "")
    .replace(/,/g, "")
    .match(/^([0-9]*\.?[0-9]+)\s*([KMBT])?$/i);
  if (!m) return undefined;
  let n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const suffix = m[2]?.toUpperCase();
  if (suffix === "K") n *= 1e3;
  else if (suffix === "M") n *= 1e6;
  else if (suffix === "B") n *= 1e9;
  else if (suffix === "T") n *= 1e12;
  return n;
}

/** Pull a `│Label   value │` row out of an `opencode stats` box. */
function statsRow(stdout: string, label: string): string | undefined {
  // Lines look like: "│Total Cost                       $29.21 │"
  const re = new RegExp(
    `${label.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s+([\\$0-9.,KMBT]+)`,
    "i",
  );
  const m = stdout.match(re);
  return m?.[1];
}

const isInstalled = (bin: string): boolean => Boolean(resolveBin(bin));

// ── anthropic ← claude ──────────────────────────────────────────────
export function probeClaudeCli(): CliPlanProbe {
  const t0 = Date.now();
  const cli = "claude";
  if (!isInstalled(cli)) {
    return {
      cli,
      installed: false,
      authState: "not-installed",
      message: "Claude Code CLI not installed.",
      durationMs: Date.now() - t0,
    };
  }
  const creds = readJsonFile(join(homedir(), ".claude", ".credentials.json"));
  const oauth = creds?.claudeAiOauth as
    | {
        subscriptionType?: string;
        rateLimitTier?: string;
        expiresAt?: number;
        accessToken?: string;
      }
    | undefined;
  if (!oauth?.accessToken) {
    return {
      cli,
      installed: true,
      authState: "auth-required",
      message:
        "Claude Code installed but not logged in (no OAuth credentials). Run `claude` to log in.",
      durationMs: Date.now() - t0,
    };
  }
  // subscriptionType maps directly onto anthropic plan ids: "max" | "pro".
  const plan = oauth.subscriptionType?.toLowerCase();
  const tier = oauth.rateLimitTier ? ` (${oauth.rateLimitTier})` : "";
  const expired = typeof oauth.expiresAt === "number" && oauth.expiresAt < Date.now();
  return {
    cli,
    installed: true,
    authState: "ok",
    plan: plan === "max" || plan === "pro" ? plan : undefined,
    periodLabel: "calendar month",
    message: `Claude subscription: ${oauth.subscriptionType ?? "unknown"}${tier}. Auth: OAuth${
      expired ? " (token expired — auto-refreshes on next use)" : " valid"
    }. Usage estimated from local ledger (no plan-usage API for subscriptions).`,
    durationMs: Date.now() - t0,
  };
}

// ── openai ← codex ──────────────────────────────────────────────────
export function probeCodexCli(): CliPlanProbe {
  const t0 = Date.now();
  const cli = "codex";
  if (!isInstalled(cli)) {
    return {
      cli,
      installed: false,
      authState: "not-installed",
      message: "Codex CLI not installed.",
      durationMs: Date.now() - t0,
    };
  }
  const auth = readJsonFile(join(homedir(), ".codex", "auth.json"));
  const tokens = auth?.tokens as { id_token?: string } | undefined;
  const apiKey = (auth?.OPENAI_API_KEY as string | undefined)?.trim();
  const authMode = (auth?.auth_mode as string | undefined)?.toLowerCase();
  // Confirm session validity via the CLI (cheap, ~instant). Note: codex prints
  // "Logged in using …" to STDERR, not stdout — match both streams.
  const status = runCli(cli, ["login", "status"], 12_000);
  const statusText = `${status.stdout}\n${status.stderr}`;
  // Primary signal is the local auth cache (auth_mode + token/key); the CLI
  // output is corroborating only.
  const loggedIn =
    Boolean(authMode && (tokens?.id_token || apiKey)) || /logged in/i.test(statusText);

  let plan: string | undefined;
  if (tokens?.id_token) {
    const claims = decodeJwtPayload(tokens.id_token);
    const authClaims = claims?.["https://api.openai.com/auth"] as
      | { chatgpt_plan_type?: string }
      | undefined;
    const planType = authClaims?.chatgpt_plan_type?.toLowerCase();
    // chatgpt_plan_type maps onto openai plan ids: "plus" | "pro" | "team" | "enterprise".
    if (planType && ["plus", "pro", "team", "enterprise"].includes(planType)) plan = planType;
  }

  if (!loggedIn && !apiKey) {
    return {
      cli,
      installed: true,
      authState: "auth-required",
      message: "Codex installed but not logged in. Run `codex login`.",
      durationMs: Date.now() - t0,
    };
  }
  const via = apiKey ? "API key" : "ChatGPT subscription";
  return {
    cli,
    installed: true,
    authState: "ok",
    plan: apiKey ? "api" : plan,
    periodLabel: "calendar month",
    message: `Codex auth: ${via}${plan ? `, plan ${plan}` : ""}. Usage estimated from local ledger (Codex CLI exposes no usage API).`,
    durationMs: Date.now() - t0,
  };
}

// ── opencode ← opencode ─────────────────────────────────────────────
export function probeOpencodeCli(): CliPlanProbe {
  const t0 = Date.now();
  const cli = "opencode";
  if (!isInstalled(cli)) {
    return {
      cli,
      installed: false,
      authState: "not-installed",
      message: "OpenCode CLI not installed.",
      durationMs: Date.now() - t0,
    };
  }
  // `opencode stats` prints a TUI box; scope to ~a month with --days.
  const res = runCli(cli, ["stats", "--days", "30"], 30_000);
  if (!res.ok || !/COST\s*&\s*TOKENS|Total Cost/i.test(res.stdout)) {
    return {
      cli,
      installed: true,
      authState: "unknown",
      message: `OpenCode 'stats' returned no parseable output (${res.stderr.slice(0, 120) || "empty"}).`,
      durationMs: Date.now() - t0,
    };
  }
  const usedUsd = parseHumanNumber(statsRow(res.stdout, "Total Cost") ?? "");
  const input = parseHumanNumber(statsRow(res.stdout, "Input") ?? "") ?? 0;
  const output = parseHumanNumber(statsRow(res.stdout, "Output") ?? "") ?? 0;
  const cacheRead = parseHumanNumber(statsRow(res.stdout, "Cache Read") ?? "") ?? 0;
  const cacheWrite = parseHumanNumber(statsRow(res.stdout, "Cache Write") ?? "") ?? 0;
  const usedTokens = input + output + cacheRead + cacheWrite || undefined;
  return {
    cli,
    installed: true,
    authState: "ok",
    usedUsd,
    usedTokens,
    periodLabel: "last 30d",
    message: `OpenCode stats (last 30d): $${usedUsd?.toFixed(2) ?? "?"}, ${
      usedTokens ? Math.round(usedTokens / 1e6) + "M" : "?"
    } tokens.`,
    durationMs: Date.now() - t0,
  };
}

// ── google ← gemini ─────────────────────────────────────────────────
export function probeGeminiCli(): CliPlanProbe {
  const t0 = Date.now();
  const cli = "gemini";
  if (!isInstalled(cli)) {
    return {
      cli,
      installed: false,
      authState: "not-installed",
      message: "Gemini CLI not installed.",
      durationMs: Date.now() - t0,
    };
  }
  const oauth = readJsonFile(join(homedir(), ".gemini", "oauth_creds.json"));
  const accounts = readJsonFile(join(homedir(), ".gemini", "google_accounts.json"));
  const active = (accounts?.active as string | undefined) ?? undefined;
  if (!oauth?.access_token && !oauth?.refresh_token) {
    return {
      cli,
      installed: true,
      authState: "auth-required",
      message: "Gemini CLI installed but not authenticated.",
      durationMs: Date.now() - t0,
    };
  }
  return {
    cli,
    installed: true,
    authState: "ok",
    periodLabel: "calendar month",
    message: `Gemini CLI authenticated${active ? ` as ${active}` : ""}. No usage/quota API — estimated from local ledger.`,
    durationMs: Date.now() - t0,
  };
}

const PROBES: Record<string, () => CliPlanProbe> = {
  anthropic: probeClaudeCli,
  openai: probeCodexCli,
  opencode: probeOpencodeCli,
  google: probeGeminiCli,
};

/**
 * Turn a CLI probe into a `ProviderPlanUsage` row for the credits store.
 *
 * Three cases:
 *   - not installed / auth-required → estimated numbers (local ledger) +
 *     a `missing-credentials` status so the UI shows "not installed / auth
 *     required" while keeping the last-known number.
 *   - CLI exposes real usage (opencode) → `source:"api"` with real cost/tokens.
 *   - CLI gives plan + auth only (claude/codex/gemini) → estimated numbers, but
 *     the detected plan id is used to pick the correct budget denominator and
 *     is surfaced in the message.
 */
export function cliBackedUsage(cfg: ProviderPlanConfig, probe: CliPlanProbe): ProviderPlanUsage {
  // Plan the CLI reports (may be undefined). Always surfaced as `detectedPlan`
  // so the UI can suggest it, but it only DRIVES the effective plan in auto mode.
  const detectedPlan = probe.plan;
  // In auto mode (the default) the CLI-detected plan wins so the budget
  // denominator self-configures. When the user has pinned a plan (auto:false)
  // we MUST keep their choice and never let detection silently override it.
  const manual = cfg.auto === false;
  const effectivePlan = manual ? cfg.plan : (detectedPlan ?? cfg.plan);
  const planDef = getPlanDef(cfg.provider, effectivePlan);

  if (!probe.installed) {
    const est = estimatedUsage(cfg, "unsupported", probe.message);
    return { ...est, plan: effectivePlan, detectedPlan };
  }
  if (probe.authState === "auth-required") {
    const est = estimatedUsage(cfg, "missing-credentials", probe.message);
    return { ...est, plan: effectivePlan, detectedPlan };
  }

  const { start, end } = currentMonthPeriod();
  const limitUsd = cfg.monthlyBudgetUsd ?? planDef?.monthlyPriceUsd ?? planDef?.includedUsd;
  const limitTokens = cfg.monthlyTokenCap ?? planDef?.includedTokens;

  // Real usage path (opencode `stats`).
  if (typeof probe.usedUsd === "number") {
    const usedUsd = round2(probe.usedUsd);
    return {
      provider: cfg.provider,
      plan: effectivePlan,
      detectedPlan,
      periodStart: start,
      periodEnd: end,
      usedUsd,
      usedTokens: probe.usedTokens,
      limitUsd,
      limitTokens,
      remainingUsd: limitUsd !== undefined ? round2(Math.max(0, limitUsd - usedUsd)) : undefined,
      remainingTokens:
        limitTokens !== undefined && probe.usedTokens !== undefined
          ? Math.max(0, limitTokens - probe.usedTokens)
          : undefined,
      source: "api",
      status: "ok",
      message: probe.message,
      fetchedAt: Date.now(),
    };
  }

  // Plan+auth only: keep ledger-estimated numbers, adopt detected plan + message.
  const local = localMonthUsage(cfg.provider);
  return {
    provider: cfg.provider,
    plan: effectivePlan,
    detectedPlan,
    periodStart: start,
    periodEnd: end,
    usedUsd: round2(local.usd),
    usedTokens: local.tokens,
    limitUsd,
    limitTokens,
    remainingUsd: limitUsd !== undefined ? round2(Math.max(0, limitUsd - local.usd)) : undefined,
    remainingTokens:
      limitTokens !== undefined ? Math.max(0, limitTokens - local.tokens) : undefined,
    source: "estimated",
    status: "ok",
    message: probe.message,
    fetchedAt: Date.now(),
  };
}

/** Probe the CLI backing a credits provider. Returns undefined if none maps. */
export function probeCliForProvider(provider: string): CliPlanProbe | undefined {
  const probe = PROBES[provider];
  if (!probe) return undefined;
  try {
    const out = probe();
    log.debug("cli probe", {
      provider,
      cli: out.cli,
      installed: out.installed,
      auth: out.authState,
      plan: out.plan,
      usedUsd: out.usedUsd,
      ms: out.durationMs,
    });
    return out;
  } catch (e) {
    log.warn("cli probe threw", { provider, err: String(e) });
    return {
      cli: provider,
      installed: false,
      authState: "unknown",
      message: `CLI probe error: ${String(e)}`,
      durationMs: 0,
    };
  }
}
