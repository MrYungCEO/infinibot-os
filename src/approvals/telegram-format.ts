/**
 * Pure formatting for Telegram approval messages (HTML parse mode).
 *
 * Kept transport-free so tests can assert the exact text + keyboard and the
 * 4096-char Telegram limit without grammy.
 */

import type { ApprovalRecord, ApprovalRisk } from "../autonomy/approval-registry.js";
import { isTelegramButtonUrl } from "../notifications/links.js";

export const TELEGRAM_TEXT_LIMIT = 4096;
/** Headroom under the hard limit (entity expansion, emoji surrogates). */
const TEXT_BUDGET = 3900;
/** Max approvals listed in one digest message. */
export const DIGEST_MAX_ITEMS = 8;

export type InlineButton = { text: string; callback_data: string };
/** "Open in InfiniBot" link button (https web opener, docs/mobile/DEEP-LINKS.md). */
export type UrlButton = { text: string; url: string };
export type InlineKeyboard = Array<Array<InlineButton | UrlButton>>;

/**
 * Where the "Open" link goes: a URL button when Telegram will take the URL,
 * otherwise (unroutable host / bare IP) a plain text line; nothing without one.
 */
export function openLinkParts(webUrl: string | null | undefined): {
  row: UrlButton[] | null;
  line: string | null;
} {
  if (!webUrl) return { row: null, line: null };
  if (isTelegramButtonUrl(webUrl)) return { row: [{ text: "🔗 Open", url: webUrl }], line: null };
  return { row: null, line: `Open: ${escapeHtml(webUrl)}` };
}

/** callback_data codes — `apv:<code>:<id>` (≤ 64 bytes). */
export const CB = {
  approve: "a",
  approveAlways: "A",
  deny: "d",
  reply: "r",
  view: "v",
  approveWithNote: "n",
  denyWithNote: "m",
} as const;

export function cb(code: string, id: string): string {
  return `apv:${code}:${id}`;
}

export function parseApprovalCallback(data: string): { code: string; id: string } | null {
  const trimmed = data.trim();
  const legacy = /^autopilot:(approve|deny):(.+)$/.exec(trimmed);
  if (legacy) return { code: legacy[1] === "approve" ? CB.approve : CB.deny, id: legacy[2] };
  const m = /^apv:([a-zA-Z]):(.+)$/.exec(trimmed);
  if (!m) return null;
  return { code: m[1], id: m[2] };
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape `raw` and clip so the ESCAPED result fits `budget` chars. */
export function escapeClipped(raw: string, budget: number): string {
  if (budget <= 0) return "";
  let escaped = escapeHtml(raw);
  if (escaped.length <= budget) return escaped;
  let n = Math.min(raw.length, budget);
  // Escaping only grows text; shrink the raw slice until it fits.
  while (n > 0) {
    escaped = `${escapeHtml(raw.slice(0, n))}…`;
    if (escaped.length <= budget) return escaped;
    n = Math.floor(n * 0.9);
  }
  return "…";
}

const RISK_BADGE: Record<ApprovalRisk, string> = {
  low: "🟢 LOW",
  medium: "🟡 MEDIUM",
  high: "🟠 HIGH",
  critical: "🔴 CRITICAL",
};

const SOURCE_LABEL: Record<ApprovalRecord["source"], string> = {
  "subagent-checkpoint": "Sub-agent check-in",
  exec: "Exec command",
  "tool-gate": "Tool gate",
  orchestrator: "Orchestrator",
  autopilot: "Autopilot task",
  custom: "Request",
};

export function formatClock(ts: number, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      ...(timeZone ? { timeZone } : {}),
    }).format(new Date(ts));
  } catch {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
}

function formatIn(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 1) return "<1m";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h${m}m` : `${h}h`;
}

function requesterLine(rec: ApprovalRecord): string {
  const parts = [SOURCE_LABEL[rec.source] ?? rec.source];
  if (rec.requester.label) parts.push(rec.requester.label);
  else if (rec.requester.agentId) parts.push(`agent ${rec.requester.agentId}`);
  if (rec.requester.runId) parts.push(`run ${rec.requester.runId.slice(0, 12)}`);
  return parts.join(" · ");
}

/** The keyboard for a single pending card. */
export function buildCardKeyboard(
  rec: ApprovalRecord,
  opts: { webUrl?: string | null } = {},
): InlineKeyboard {
  const isCheckpoint = rec.source === "subagent-checkpoint";
  const row1: InlineButton[] = [];
  if (rec.options.includes("approve-always")) {
    row1.push({ text: "✅ Allow once", callback_data: cb(CB.approve, rec.id) });
    row1.push({ text: "♾️ Always", callback_data: cb(CB.approveAlways, rec.id) });
  } else {
    row1.push({ text: "✅ Approve", callback_data: cb(CB.approve, rec.id) });
  }
  row1.push({ text: isCheckpoint ? "🛑 Stop" : "❌ Deny", callback_data: cb(CB.deny, rec.id) });
  const replyLabel = rec.options.includes("redirect") ? "↪️ Redirect…" : "✍️ Reply…";
  const keyboard: InlineKeyboard = [
    row1,
    [{ text: replyLabel, callback_data: cb(CB.reply, rec.id) }],
  ];
  const open = openLinkParts(opts.webUrl);
  if (open.row) keyboard.push(open.row);
  return keyboard;
}

/** Full card for one pending approval. */
export function formatApprovalCard(
  rec: ApprovalRecord,
  opts: { now: number; timeZone?: string; webUrl?: string | null },
): string {
  const head = [
    `🔐 <b>Approval needed</b> · ${RISK_BADGE[rec.risk]}`,
    `<b>${escapeClipped(rec.title, 200)}</b>`,
    `<i>${escapeClipped(requesterLine(rec), 300)}</i>`,
  ];
  if (rec.summary) head.push("", escapeClipped(rec.summary, 1200));
  const foot = [
    "",
    `⏳ Expires ${formatClock(rec.expiresAt, opts.timeZone)} (in ${formatIn(rec.expiresAt - opts.now)}) — no answer = deny`,
    `<code>${escapeHtml(rec.id)}</code>`,
  ];
  const openLine = openLinkParts(opts.webUrl).line;
  if (openLine) foot.push(openLine);
  const fixed = head.join("\n").length + foot.join("\n").length + 32;
  const lines = [...head];
  if (rec.details) {
    const budget = Math.min(2600, TEXT_BUDGET - fixed);
    lines.push("", `<pre>${escapeClipped(rec.details, budget)}</pre>`);
  }
  lines.push(...foot);
  return clampText(lines.join("\n"));
}

function statusHeadline(rec: ApprovalRecord, timeZone?: string, operatorLabel?: string): string {
  const at = formatClock(rec.decidedAt ?? Date.now(), timeZone);
  if (rec.decidedVia === "system") {
    if (rec.reason === "gateway_restart") {
      return `⚠️ <b>Closed</b> — gateway restarted before a decision (denied) · ${at}`;
    }
    return `⌛ <b>Expired</b> — denied automatically at ${at}`;
  }
  const verb =
    rec.status === "approved"
      ? rec.action === "approve-always"
        ? "✅ <b>Approved (always)</b>"
        : "✅ <b>Approved</b>"
      : rec.status === "redirected"
        ? "↪️ <b>Redirected</b>"
        : rec.source === "subagent-checkpoint"
          ? "🛑 <b>Stopped</b>"
          : "❌ <b>Denied</b>";
  const who =
    rec.decidedVia === "telegram"
      ? `by you${operatorLabel ?? (rec.decidedBy ? ` (${escapeHtml(rec.decidedBy)})` : "")}`
      : `by ${escapeHtml(rec.decidedBy ?? "operator")} via ${rec.decidedVia === "ui" ? "web UI" : (rec.decidedVia ?? "?")}`;
  return `${verb} ${who} at ${at}`;
}

/** Card after resolution / expiry (buttons removed by the caller). */
export function formatResolvedCard(rec: ApprovalRecord, opts: { timeZone?: string }): string {
  const lines = [
    statusHeadline(rec, opts.timeZone),
    `<b>${escapeClipped(rec.title, 200)}</b>`,
    `<i>${escapeClipped(requesterLine(rec), 300)}</i>`,
  ];
  if (rec.note) lines.push("", `📝 ${escapeClipped(rec.note, 1500)}`);
  lines.push(`<code>${escapeHtml(rec.id)}</code>`);
  return clampText(lines.join("\n"));
}

function digestLine(rec: ApprovalRecord, n: number, opts: { now: number; timeZone?: string }) {
  if (rec.status === "pending") {
    return [
      `<b>${n}.</b> ${RISK_BADGE[rec.risk]} · <b>${escapeClipped(rec.title, 120)}</b>`,
      `    <i>${escapeClipped(requesterLine(rec), 120)}</i> · ⏳ ${formatClock(rec.expiresAt, opts.timeZone)}`,
    ].join("\n");
  }
  const mark =
    rec.status === "approved"
      ? "✅"
      : rec.status === "redirected"
        ? "↪️"
        : rec.decidedVia === "system"
          ? "⌛"
          : "❌";
  return `<b>${n}.</b> ${mark} <s>${escapeClipped(rec.title, 120)}</s> — ${rec.decidedVia === "system" ? "expired" : rec.status}`;
}

/** One message listing several approvals, per-item buttons. */
export function formatDigest(
  records: ApprovalRecord[],
  opts: { now: number; timeZone?: string; webUrl?: string | null },
): { text: string; keyboard: InlineKeyboard } {
  const items = records.slice(0, DIGEST_MAX_ITEMS);
  const pending = items.filter((r) => r.status === "pending").length;
  const header =
    pending > 0
      ? `🔐 <b>${pending} approval${pending === 1 ? "" : "s"} waiting</b>${items.length > pending ? ` (${items.length - pending} resolved)` : ""}`
      : `🔐 <b>${items.length} approvals — all resolved</b>`;
  const body = items.map((r, i) => digestLine(r, i + 1, opts)).join("\n");
  const footer =
    pending > 0 ? "\n\n✅ approve · ❌ deny · ✍️ reply with a note · 🔍 full details" : "";
  const keyboard: InlineKeyboard = [];
  items.forEach((r, i) => {
    if (r.status !== "pending") return;
    const n = i + 1;
    keyboard.push([
      { text: `✅ ${n}`, callback_data: cb(CB.approve, r.id) },
      { text: `❌ ${n}`, callback_data: cb(CB.deny, r.id) },
      { text: `✍️ ${n}`, callback_data: cb(CB.reply, r.id) },
      { text: `🔍 ${n}`, callback_data: cb(CB.view, r.id) },
    ]);
  });
  const open = pending > 0 ? openLinkParts(opts.webUrl) : { row: null, line: null };
  if (open.row) keyboard.push(open.row);
  const openLine = open.line ? `\n${open.line}` : "";
  return { text: clampText(`${header}\n\n${body}${footer}${openLine}`), keyboard };
}

export function formatReplyPrompt(rec: ApprovalRecord): string {
  const redirect = rec.options.includes("redirect");
  return clampText(
    [
      redirect
        ? `↪️ <b>Redirect</b>: ${escapeClipped(rec.title, 200)}`
        : `✍️ <b>Note for</b>: ${escapeClipped(rec.title, 200)}`,
      redirect
        ? "Reply with the revised instructions — the agent will follow them instead of its plan."
        : "Reply with your note. You'll then choose Approve or Deny.",
      "Send /cancel to abort.",
    ].join("\n"),
  );
}

export function formatNoteCaptured(
  rec: ApprovalRecord,
  note: string,
): {
  text: string;
  keyboard: InlineKeyboard;
} {
  return {
    text: clampText(
      [
        `📝 <b>Note captured</b> for ${escapeClipped(rec.title, 200)}:`,
        `<i>${escapeClipped(note, 2000)}</i>`,
        "",
        "Apply it with:",
      ].join("\n"),
    ),
    keyboard: [
      [
        { text: "✅ Approve with note", callback_data: cb(CB.approveWithNote, rec.id) },
        { text: "❌ Deny with note", callback_data: cb(CB.denyWithNote, rec.id) },
      ],
    ],
  };
}

/** Last-resort guard: never exceed Telegram's message limit. */
export function clampText(text: string): string {
  if (text.length <= TELEGRAM_TEXT_LIMIT) return text;
  // Strip tags when cutting so we never leave an unclosed <pre>/<b>.
  const plain = text.replace(/<[^>]+>/g, "");
  return `${plain.slice(0, TELEGRAM_TEXT_LIMIT - 2)}…`;
}
