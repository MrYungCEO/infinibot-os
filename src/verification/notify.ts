/**
 * Completion notifications — every terminal state is delivered to:
 *
 *   1. the event inbox (store.ts) — ALWAYS, written first; MCP clients and
 *      CLI orchestrators read it via subagents_wait / subagents_events;
 *   2. connected UIs — `verification.completion` WS broadcast (Reviews page,
 *      agent focus modal, proactive overlay);
 *   3. MCP push — the MCP server relays the same WS event as an MCP
 *      notification to the connected client (see src/mcp/server.ts);
 *   4. Telegram — verdict + summary + evidence, with Continue / Retry /
 *      Accept / Reject buttons for anything that is not VERIFIED.
 *      INFINIBOT_VERIFY_TELEGRAM=all|problems|off (default: problems).
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { buildDeepLink, isTelegramButtonUrl } from "../notifications/links.js";
import type { CompletionEvent, CompletionRecord } from "./store.js";
import { getRecord, updateRecord } from "./store.js";

const log = createSubsystemLogger("verification.notify");

type BroadcastFn = (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
let broadcaster: BroadcastFn | null = null;

export function setVerificationBroadcaster(fn: BroadcastFn | null): void {
  broadcaster = fn;
}

export const VERIFICATION_EVENT = "verification.completion";

export interface CompletionBroadcast {
  event: CompletionEvent;
  runId: string;
  requesterSessionKey: string;
  childSessionKey: string;
  label: string;
  state: string;
  verdict: string | null;
  summary: string;
  reasons: string[];
  screenshots: string[];
  attempts: number;
  backend: string | null;
}

export function toBroadcast(rec: CompletionRecord, event: CompletionEvent): CompletionBroadcast {
  return {
    event,
    runId: rec.runId,
    requesterSessionKey: rec.requesterSessionKey,
    childSessionKey: rec.childSessionKey,
    label: rec.label,
    state: rec.state,
    verdict: rec.review?.verdict ?? null,
    summary: rec.result?.summary ?? event.summary ?? "",
    reasons: rec.review?.reasons ?? event.reasons ?? [],
    screenshots: rec.review?.screenshots ?? [],
    attempts: rec.attempts.length,
    backend: rec.backend,
  };
}

export function broadcastCompletion(rec: CompletionRecord, event: CompletionEvent): void {
  if (!broadcaster) return;
  try {
    broadcaster(VERIFICATION_EVENT, toBroadcast(rec, event));
    updateRecord(rec.runId, (r) => {
      r.delivered = { ...r.delivered, ui: Date.now() };
    });
  } catch {
    /* best effort */
  }
}

const STATE_ICON: Record<string, string> = {
  verified: "✅",
  unverified: "🟡",
  failed: "❌",
  stalled: "⏸",
  blocked: "⛔",
  needs_input: "❓",
  needs_owner: "🙋",
  accepted: "✅",
  rejected: "✖️",
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** `infinibot://runs/<runId>` — the Oversight / Reviews entry for a run. */
export function runDeepLink(rec: Pick<CompletionRecord, "runId">): string {
  return buildDeepLink({ kind: "run", runId: rec.runId });
}

type TelegramButton = { text: string; callback_data?: string; url?: string };

export function formatTelegram(
  rec: CompletionRecord,
  opts: { webUrl?: string | null; evidenceLine?: string | null } = {},
): {
  text: string;
  buttons?: TelegramButton[][];
} {
  const icon = STATE_ICON[rec.state] ?? "•";
  const lines = [
    `${icon} <b>${escapeHtml(rec.label.slice(0, 120))}</b>`,
    `Verdict: <b>${rec.review?.verdict ?? rec.state.toUpperCase()}</b> · state ${rec.state} · ${rec.attempts.length} attempt(s)${rec.backend ? ` · ${rec.backend}` : ""}`,
  ];
  if (rec.result?.summary) lines.push("", escapeHtml(rec.result.summary.slice(0, 700)));
  const reasons = rec.review?.reasons ?? [];
  if (reasons.length) {
    lines.push("", "<b>Why:</b>");
    for (const r of reasons.slice(0, 5)) lines.push(`• ${escapeHtml(r.slice(0, 220))}`);
  }
  const passed = (rec.review?.evidence ?? []).filter((e) => e.status === "pass").slice(0, 4);
  if (passed.length) {
    lines.push("", "<b>Evidence:</b>");
    for (const e of passed)
      lines.push(`• ${e.kind}: <code>${escapeHtml(e.ref.slice(0, 120))}</code>`);
  }
  if (opts.evidenceLine) lines.push("", escapeHtml(opts.evidenceLine));
  else if (rec.review?.screenshots?.length)
    lines.push(`📸 ${rec.review.screenshots.length} screenshot(s) in the Reviews page`);
  lines.push("", `<code>${escapeHtml(rec.runId)}</code>`);
  const webUrl = opts.webUrl ?? null;
  const urlButton = isTelegramButtonUrl(webUrl);
  if (webUrl && !urlButton) lines.push(`Open: ${escapeHtml(webUrl)}`);
  const needsButtons =
    rec.state !== "verified" && rec.state !== "accepted" && rec.state !== "rejected";
  const buttons: TelegramButton[][] | undefined = needsButtons
    ? [
        [
          { text: "▶ Continue", callback_data: `vc:continue:${rec.token}` },
          { text: "↻ Retry", callback_data: `vc:retry:${rec.token}` },
        ],
        [
          { text: "✓ Accept", callback_data: `vc:accept:${rec.token}` },
          { text: "✗ Reject", callback_data: `vc:reject:${rec.token}` },
        ],
      ]
    : undefined;
  if (urlButton) {
    const openRow = [{ text: "🔗 Open", url: webUrl }];
    return { text: lines.join("\n"), buttons: [...(buttons ?? []), openRow] };
  }
  return { text: lines.join("\n"), buttons };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(null);
      },
    );
  });
}

function telegramMode(): "all" | "problems" | "off" {
  const raw = (process.env.INFINIBOT_VERIFY_TELEGRAM ?? "").trim().toLowerCase();
  return raw === "all" || raw === "off" ? raw : "problems";
}

export async function sendTelegramCompletion(rec: CompletionRecord): Promise<boolean> {
  const mode = telegramMode();
  if (mode === "off") return false;
  if (mode === "problems" && (rec.state === "verified" || rec.state === "accepted")) return false;
  try {
    const { loadConfig } = await import("../config/config.js");
    const cfg = loadConfig();
    // Same owner chat as reports / scheduled tasks: defaultChatId, not allowFrom[0].
    const { resolveOwnerTelegramChatId } = await import("../telegram/owner-chat.js");
    const chatId = resolveOwnerTelegramChatId(cfg.channels?.telegram);
    if (!chatId || process.env.INFINIBOT_SKIP_CHANNELS === "1") return false;
    const { sendMessageTelegram } = await import("../telegram/send.js");
    const { gatewayWebUrl } = await import("../notifications/public-base.js");
    const evidence = await import("./telegram-evidence.js");
    // Bounded: a slow disk must never hold the verdict message back.
    const plan = await withTimeout(evidence.planVerificationEvidence(rec.runId), 4000);
    const { text, buttons } = formatTelegram(rec, {
      webUrl: gatewayWebUrl(runDeepLink(rec), cfg),
      evidenceLine: plan ? evidence.evidenceSummaryLine(plan) : null,
    });
    const sent = await sendMessageTelegram(chatId, text, {
      textMode: "html",
      buttons,
      silent: rec.state === "verified",
    });
    updateRecord(rec.runId, (r) => {
      r.delivered = { ...r.delivered, telegram: Date.now() };
    });
    // Screenshots follow as a reply-threaded album, fire-and-forget: an image
    // failure never fails (or delays) the verdict itself.
    if (plan?.picked.length) {
      void evidence.attachVerificationEvidence(rec.runId, sent.messageId, {
        chatId,
        state: rec.state,
        selection: plan,
        silent: rec.state === "verified",
      });
    }
    return true;
  } catch (err) {
    log.warn("telegram completion notification failed", {
      runId: rec.runId,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

const PUSH_VERDICT: Record<
  string,
  {
    category: "agent.completed" | "agent.error" | "agent.input_required";
    severity: "success" | "warn" | "error";
    word: string;
  }
> = {
  verified: { category: "agent.completed", severity: "success", word: "Verified" },
  accepted: { category: "agent.completed", severity: "success", word: "Accepted" },
  unverified: { category: "agent.input_required", severity: "warn", word: "Unverified" },
  needs_input: { category: "agent.input_required", severity: "warn", word: "Needs input" },
  needs_owner: { category: "agent.input_required", severity: "warn", word: "Needs you" },
  stalled: { category: "agent.input_required", severity: "warn", word: "Stalled" },
  blocked: { category: "agent.input_required", severity: "warn", word: "Blocked" },
  failed: { category: "agent.error", severity: "error", word: "Failed" },
  rejected: { category: "agent.error", severity: "error", word: "Rejected" },
};

/**
 * Push (Expo + in-app notification) for a terminal verdict, deep-linked to the
 * run. Once per terminal transition: `delivered.push` is stamped with the
 * record's terminalAt, so a replay of the same terminal event (restart,
 * re-delivery) is a no-op while an operator reopen → new verdict pushes again.
 */
export async function pushCompletion(rec: CompletionRecord): Promise<boolean> {
  const stamp = rec.terminalAt ?? 0;
  const delivered = (getRecord(rec.runId) ?? rec).delivered;
  if (delivered?.push && delivered.push >= stamp) return false;
  const meta = PUSH_VERDICT[rec.state];
  if (!meta) return false;
  updateRecord(rec.runId, (r) => {
    r.delivered = { ...r.delivered, push: stamp || Date.now() };
  });
  try {
    const { emitNotification } = await import("../notifications/emit.js");
    const label = rec.label.slice(0, 120) || "Run";
    const summary = (rec.result?.summary ?? rec.review?.reasons?.[0] ?? "").slice(0, 240);
    await emitNotification({
      category: meta.category,
      severity: meta.severity,
      title: `${meta.word}: ${label}`,
      body:
        summary ||
        `${rec.review?.verdict ?? rec.state.toUpperCase()} · ${rec.attempts.length} attempt(s)`,
      source: "verification",
      sourceId: rec.runId,
      deepLink: runDeepLink(rec),
      displayTitle: `${meta.word}: ${label}`,
      summary: summary || undefined,
      data: {
        runId: rec.runId,
        state: rec.state,
        verdict: rec.review?.verdict ?? null,
        sessionKey: rec.childSessionKey,
        goalId: rec.goalId ?? null,
      },
    });
    return true;
  } catch (err) {
    log.warn("verification push failed", {
      runId: rec.runId,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Fan a terminal event out to every push channel. Inbox delivery already happened. */
export async function deliverTerminal(
  rec: CompletionRecord,
  event: CompletionEvent,
): Promise<void> {
  broadcastCompletion(rec, event);
  await pushCompletion(rec);
  await sendTelegramCompletion(rec);
}
