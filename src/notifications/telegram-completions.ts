/**
 * Telegram Agent Completion Notifications
 *
 * Subscribes to the agent lifecycle bus and mirrors start/end/error events
 * to Telegram. Parallel to the in-app glass-notification stack and mobile
 * Expo push — three independent subscribers, same bus.
 *
 * Credentials: the Discipline plugin's telegramEnabled + telegramChatId
 * (via the day-planner seam — nothing is sent while the plugin is off),
 * and the existing bot token from loadConfig() / TELEGRAM_BOT_TOKEN.
 * No new credential prompts or config keys.
 *
 * Optional per-notification flags are read from infinibot.json at runtime:
 *   telegram.notify_agent_completion.enabled           (default: true)
 *   telegram.notify_agent_completion.on_start          (default: false)
 *   telegram.notify_agent_completion.on_end            (default: true)
 *   telegram.notify_agent_completion.on_error          (default: true)
 *   telegram.notify_agent_completion.min_duration_seconds (default: 0)
 */

import { isSecureSessionKey } from "../secure-mode/session-key.js";
import { onAgentEvent, type AgentEventPayload } from "../infra/agent-events.js";
import { dayPlannerTelegramTarget } from "../infra/day-planner-seam.js";
import { loadConfig } from "../config/io.js";
import { getProgress } from "../agents/subagent-progress.js";
import { resolveSessionAgentId } from "../agents/agent-scope.js";
import { resolveAgentTelegramToken } from "../agents/agent-integration-config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { buildDeepLink } from "./links.js";
import { gatewayWebUrl } from "./public-base.js";

const log = createSubsystemLogger("telegram-completions");

// ── Deduplication ─────────────────────────────────────────────────────────────

const DEDUP_TTL_MS = 10 * 60_000; // 10 minutes
/** runId:phase → sent timestamp */
const sentCache = new Map<string, number>();

export function cleanDedupCache(): void {
  const now = Date.now();
  for (const [key, ts] of sentCache) {
    if (now - ts > DEDUP_TTL_MS) sentCache.delete(key);
  }
}

export function alreadySent(runId: string, phase: string): boolean {
  const key = `${runId}:${phase}`;
  if (sentCache.has(key)) return true;
  sentCache.set(key, Date.now());
  return false;
}

/** Exposed for testing — reset dedup state. */
export function resetDedupForTests(): void {
  sentCache.clear();
}

// ── Start-time cache (for duration on "end" events) ──────────────────────────

const runStartCache = new Map<string, number>();

// ── Config ────────────────────────────────────────────────────────────────────

interface CompletionConfig {
  enabled: boolean;
  on_start: boolean;
  on_end: boolean;
  on_error: boolean;
  min_duration_seconds: number;
}

const DEFAULTS: CompletionConfig = {
  enabled: true,
  on_start: false,
  on_end: true,
  on_error: true,
  min_duration_seconds: 0,
};

function readCompletionConfig(): CompletionConfig {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (loadConfig() as any)?.telegram?.notify_agent_completion;
    if (!raw || typeof raw !== "object") return DEFAULTS;
    return {
      enabled: raw.enabled !== false,
      on_start: raw.on_start === true,
      on_end: raw.on_end !== false,
      on_error: raw.on_error !== false,
      min_duration_seconds:
        typeof raw.min_duration_seconds === "number" ? raw.min_duration_seconds : 0,
    };
  } catch {
    return DEFAULTS;
  }
}

// ── Formatting ────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function resolveLabel(runId: string, sessionKey?: string, dataLabel?: unknown): string {
  if (typeof dataLabel === "string" && dataLabel.trim()) return dataLabel.trim();
  const prog = getProgress(runId);
  if (prog?.label) return prog.label;
  if (prog?.task) return prog.task.slice(0, 50);
  if (sessionKey) return sessionKey.split(":").pop() ?? sessionKey;
  return runId.slice(0, 8);
}

/** Markdown link line to the web opener ("" without a public base). */
function openLink(webUrl: string | null | undefined): string {
  if (!webUrl) return "";
  // Parens would end the markdown link target early.
  return `\n[Open in InfiniBot](${webUrl.replace(/\(/g, "%28").replace(/\)/g, "%29")})`;
}

export function buildMessage(
  phase: string,
  label: string,
  data: Record<string, unknown>,
  startedAt?: number,
  webUrl?: string | null,
): string {
  if (phase === "end") {
    const endedAt = typeof data.endedAt === "number" ? data.endedAt : Date.now();
    const durationMs = startedAt ? endedAt - startedAt : undefined;
    const durationStr =
      durationMs != null ? ` — completed in ${formatDuration(durationMs)}` : " — completed";
    const summary = typeof data.summary === "string" && data.summary ? `\n${data.summary}` : "";
    return `✅ **${label}**${durationStr}${summary}${openLink(webUrl)}`;
  }
  if (phase === "error") {
    const raw = typeof data.error === "string" ? data.error : "Unknown error";
    const errorText = raw.length > 500 ? `${raw.slice(0, 497)}…` : raw;
    return `❌ **${label}** — failed\n\`\`\`\n${errorText}\n\`\`\`${openLink(webUrl)}`;
  }
  // "start"
  return `🔄 **${label}** — started${openLink(webUrl)}`;
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

async function handleEvent(evt: AgentEventPayload, phase: string): Promise<void> {
  const data = evt.data ?? {};

  // Cache start time regardless of whether we send a "start" notification.
  if (phase === "start") {
    const ts = typeof data.startedAt === "number" ? data.startedAt : evt.ts;
    runStartCache.set(evt.runId, ts);
  }

  const cfg = readCompletionConfig();
  if (!cfg.enabled) return;
  if (phase === "start" && !cfg.on_start) return;
  if (phase === "end" && !cfg.on_end) return;
  if (phase === "error" && !cfg.on_error) return;

  // Duration gate — only for "end" events
  if (phase === "end" && cfg.min_duration_seconds > 0) {
    const startedAt = runStartCache.get(evt.runId);
    const endedAt = typeof data.endedAt === "number" ? data.endedAt : Date.now();
    if (startedAt && (endedAt - startedAt) / 1000 < cfg.min_duration_seconds) {
      if (phase === "end" || phase === "error") runStartCache.delete(evt.runId);
      return;
    }
  }

  // Credential check
  let telegramEnabled: boolean;
  let chatId: string;
  // Target comes from the Discipline plugin's settings (day-planner seam);
  // plugin off → no target → nothing is sent.
  // Secure Mode: nothing about a secure run leaves the machine.
  if (isSecureSessionKey(evt.sessionKey)) return;
  const target = dayPlannerTelegramTarget();
  if (!target) return;
  telegramEnabled = target.enabled;
  chatId = target.chatId?.trim() ?? "";
  if (!telegramEnabled || !chatId) return;

  const startedAt = runStartCache.get(evt.runId);
  const label = resolveLabel(evt.runId, evt.sessionKey, data.label);
  let webUrl: string | null = null;
  try {
    webUrl = gatewayWebUrl(
      evt.sessionKey
        ? buildDeepLink({ kind: "session", sessionKey: evt.sessionKey })
        : buildDeepLink({ kind: "run", runId: evt.runId }),
    );
  } catch {
    webUrl = null;
  }
  let text = buildMessage(phase, label, data, startedAt, webUrl);

  // Coder runs that left verification evidence get their screenshots as a
  // reply-threaded album (see verification/telegram-evidence.ts).
  const terminal = phase === "end" || phase === "error";
  const evidence = terminal ? await import("../verification/telegram-evidence.js") : null;
  const plan = evidence?.hasVerificationEvidence(evt.runId)
    ? await evidence.planVerificationEvidence(evt.runId, [evt.sessionKey])
    : null;
  if (evidence && plan) text += `\n${evidence.evidenceSummaryLine(plan)}`;

  // Attribute the notification to the originating agent: use that agent's own
  // bot token when configured, otherwise fall back to the global token (resolved
  // inside send.js when we pass no token).
  let token = "";
  try {
    const cfg = loadConfig();
    const agentId = resolveSessionAgentId({ sessionKey: evt.sessionKey, config: cfg });
    token = resolveAgentTelegramToken(cfg, agentId).token;
  } catch {
    // Config unreadable — fall back to send.js global resolution.
  }

  // Lazy import — avoids loading telegram deps when feature is disabled.
  const { sendMessageTelegram } = await import("../telegram/send.js");
  const sent = await sendMessageTelegram(chatId, text, token ? { token } : undefined);
  log.info("sent", { runId: evt.runId, phase, label });
  if (evidence && plan?.picked.length) {
    void evidence.attachVerificationEvidence(evt.runId, sent?.messageId, {
      chatId,
      token,
      state: phase === "error" ? "failed" : null,
      sessionKeys: [evt.sessionKey],
      selection: plan,
    });
  }

  // Clean up start cache on terminal events
  if (phase === "end" || phase === "error") runStartCache.delete(evt.runId);
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

let _stopFn: (() => void) | null = null;

export function startTelegramCompletions(): () => void {
  if (_stopFn) return _stopFn;

  const unsub = onAgentEvent((evt) => {
    if (evt.stream !== "lifecycle") return;
    const phase = evt.data?.phase as string | undefined;
    if (phase !== "start" && phase !== "end" && phase !== "error") return;
    if (alreadySent(evt.runId, phase)) return;

    void handleEvent(evt, phase).catch((err) => log.warn("dispatch error", { error: String(err) }));
  });

  const cleanInterval = setInterval(cleanDedupCache, 60_000);

  _stopFn = () => {
    unsub();
    clearInterval(cleanInterval);
    _stopFn = null;
  };

  log.info("telegram completions dispatcher started");
  return _stopFn;
}

export function stopTelegramCompletions(): void {
  _stopFn?.();
}
