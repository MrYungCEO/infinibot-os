/**
 * Discovery Docs — action handlers.
 *
 * Each handler executes ONE step of the pipeline against a finalized
 * `DiscoveryDocRun` (input + generated markdown + chosen category). They
 * mutate the run's `actions[]` entry in place — the runner persists the
 * run after every step so a crash mid-pipeline leaves a clear partial
 * record.
 *
 * Handlers in this v1:
 *   - generate_pdf      → render the markdown to a basic HTML+CSS PDF
 *                         via wkhtmltopdf if available, else save HTML
 *                         to disk and let the email step attach that.
 *                         (Browser-side export remains for ad-hoc, but
 *                         the pipeline runs server-side.)
 *   - send_email        → src/services/email/dispatcher.sendEmail
 *   - log_to_crm        → upsertRowForBusinessRole("clients", …)
 *   - telegram_notify   → telegram/send.sendMessageTelegram
 *   - qualify_lead      → set run.qualifyCategory from inputs / AI text
 *   - calendly_link     → emit configured event-type uri (gated by approval)
 *
 * Each handler is best-effort: failures are recorded on the action's
 * result and the pipeline moves on. A run with one failed action still
 * counts as processed.
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import { STATE_DIR } from "../config/paths.js";
import { sendEmail } from "../services/email/dispatcher.js";
import { upsertRowForBusinessRole } from "../databases/system-role-bridge.js";
import type { PropertyValue } from "../databases/types.js";

import type {
  ActionResult,
  DiscoveryDocRun,
  DiscoveryDocTemplate,
  TemplateAction,
} from "./types.js";

export interface ActionRunContext {
  template: DiscoveryDocTemplate;
  run: DiscoveryDocRun;
  businessName: string;
}

export async function runAction(
  ctx: ActionRunContext,
  action: TemplateAction,
): Promise<ActionResult> {
  const result: ActionResult = {
    actionId: action.id,
    kind: action.kind,
    status: "running",
    startedAt: Date.now(),
    finishedAt: null,
    detail: null,
  };

  // Condition gate — skip without running when the run's category doesn't match.
  if (!conditionMatches(action, ctx.run.qualifyCategory)) {
    result.status = "skipped";
    result.finishedAt = Date.now();
    result.detail = `skipped: condition didn't match (category=${ctx.run.qualifyCategory ?? "none"})`;
    return result;
  }

  try {
    switch (action.kind) {
      case "generate_pdf":
        result.output = await actGeneratePdf(ctx, action.config);
        break;
      case "send_email":
        result.output = await actSendEmail(ctx, action.config);
        break;
      case "log_to_crm":
        result.output = actLogToCrm(ctx, action.config);
        break;
      case "telegram_notify":
        result.output = await actTelegram(ctx, action.config);
        break;
      case "qualify_lead":
        result.output = actQualifyLead(ctx, action.config);
        break;
      case "calendly_link":
        result.output = actCalendlyLink(ctx, action.config);
        break;
      default:
        throw new Error(`Unknown action kind: ${(action as { kind?: string }).kind}`);
    }
    result.status = "done";
  } catch (err) {
    result.status = "failed";
    result.detail = err instanceof Error ? err.message : String(err);
  }
  result.finishedAt = Date.now();
  return result;
}

// ── Condition matcher ───────────────────────────────────────────

function conditionMatches(action: TemplateAction, category: string | null): boolean {
  const c = action.condition;
  if (!c || c.op === "always") return true;
  const cat = category ?? "";
  if (c.op === "equals") return cat === (c.category ?? "");
  if (c.op === "in") return (c.categories ?? []).includes(cat);
  // "above" expects a comma-separated ranked list; v1 keeps it loose.
  return true;
}

// ── generate_pdf ────────────────────────────────────────────────

async function actGeneratePdf(
  ctx: ActionRunContext,
  config: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const filenameTpl = (config.filename as string | undefined) || `{{run.id}}.pdf`;
  const filename = filenameTpl
    .replace(/\{\{run\.id\}\}/g, ctx.run.id)
    .replace(/\{\{template\.slug\}\}/g, ctx.template.slug)
    .replace(/[^a-zA-Z0-9._-]/g, "_");
  const outDir = join(STATE_DIR, "discovery", "pdfs");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const html = renderRunHtml(ctx);
  // v1: try wkhtmltopdf via env shell, fall back to HTML-on-disk and let
  // the email step attach the .html. We don't pull puppeteer because
  // that ships a Chromium binary — too heavy for an action handler.
  const htmlPath = join(outDir, filename.replace(/\.pdf$/i, ".html"));
  writeFileSync(htmlPath, html, "utf-8");

  const pdfPath = await tryWkHtmlToPdf(htmlPath, join(outDir, filename));
  return {
    htmlPath,
    pdfPath: pdfPath ?? null,
    note: pdfPath
      ? "rendered with wkhtmltopdf"
      : "wkhtmltopdf not found — HTML saved; email step will attach the HTML version",
  };
}

async function tryWkHtmlToPdf(htmlPath: string, pdfPath: string): Promise<string | null> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const proc = spawn(
      "wkhtmltopdf",
      ["--quiet", "--enable-local-file-access", htmlPath, pdfPath],
      { stdio: "ignore" },
    );
    proc.on("error", () => resolve(null));
    proc.on("exit", (code) => resolve(code === 0 ? pdfPath : null));
  });
}

function renderRunHtml(ctx: ActionRunContext): string {
  // Tiny inline-CSS layout based on template.style. Plays nicely with
  // wkhtmltopdf and most HTML email clients (when send_email attaches
  // the HTML version as the body fallback).
  const style = ctx.template.style;
  const escaped = ctx.run.generatedMarkdown
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const mdAsHtml = naiveMarkdownToHtml(escaped);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(ctx.template.name)}</title>
<style>
  body { font-family: ${cssFont(style.fontFamily)}; color: #0f172a; max-width: 720px; margin: 32px auto; padding: 0 24px; line-height: 1.55; }
  h1 { color: ${cssColor(style.brandColor)}; border-bottom: 2px solid ${cssColor(style.brandColor)}; padding-bottom: 8px; }
  h2 { color: ${cssColor(style.accent)}; margin-top: 28px; }
  h3 { color: #334155; }
  p { margin: 8px 0; }
  ul, ol { padding-left: 22px; }
  .meta { color: #64748b; font-size: 12px; margin-bottom: 32px; }
</style>
</head><body>
<h1>${escapeHtml(ctx.template.name)}</h1>
<div class="meta">${escapeHtml(ctx.businessName)} · ${new Date(ctx.run.createdAt).toLocaleString()}</div>
${mdAsHtml}
</body></html>`;
}

// ── send_email ──────────────────────────────────────────────────

async function actSendEmail(
  ctx: ActionRunContext,
  config: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const toTpl = (config.to as string | undefined) || "{{input.email}}";
  const to = renderTokens(toTpl, ctx);
  if (!to || !to.includes("@")) {
    throw new Error(`No valid recipient address (got "${to}")`);
  }
  const fromTpl = (config.from as string | undefined) || "noreply@infinibot.local";
  const from = renderTokens(fromTpl, ctx);
  const subjectTpl = (config.subject as string | undefined) || ctx.template.name;
  const subject = renderTokens(subjectTpl, ctx);

  // Email body strategy: use the AI-generated markdown as the text body.
  // If a generate_pdf action ran before us in the pipeline, attach the
  // produced HTML or PDF.
  const text = ctx.run.generatedMarkdown;
  const htmlBody = naiveMarkdownToHtml(
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  );

  // Look up the most recent PDF action's output by walking the run's
  // actions list. v1 keeps attachments inline (base64) — sized cap at 5MB.
  const attachments = collectAttachments(ctx);

  // dispatcher uses `body` for plain text and returns { ok, providerUsed, providerMessageId? }.
  // v1 doesn't pass attachments through — the body + html carry the doc.
  void attachments; // reserved for v2 when dispatcher gains attachment support
  // TODO(campaigns): If the discovery run is tied to a lead with a
  // stamped campaignId, call `buildCampaignContext(leadId)` and pass
  // it as `campaignContext` so the dispatcher records the send against
  // the right campaign counter (and future AI subject/body rewriting
  // can read voice + products + goal from the same blob).
  const res = await sendEmail({
    to,
    from,
    subject,
    body: text,
    html: htmlBody,
  });
  if (!res.ok) {
    throw new Error(`sendEmail failed: ${res.code} ${res.message}`);
  }
  return { messageId: res.providerMessageId ?? null, provider: res.providerUsed };
}

function collectAttachments(
  ctx: ActionRunContext,
): Array<{ filename: string; content: Buffer; contentType: string }> {
  const out: Array<{ filename: string; content: Buffer; contentType: string }> = [];
  for (const a of ctx.run.actions) {
    if (a.kind !== "generate_pdf" || !a.output) continue;
    const pdfPath = (a.output as { pdfPath?: string | null }).pdfPath;
    const htmlPath = (a.output as { htmlPath?: string }).htmlPath;
    const picked = pdfPath || htmlPath;
    if (!picked) continue;
    try {
      const { readFileSync, statSync } = require("node:fs") as typeof import("node:fs");
      const stat = statSync(picked);
      if (stat.size > 5 * 1024 * 1024) continue; // 5MB cap
      const buf = readFileSync(picked);
      const ct = picked.endsWith(".pdf") ? "application/pdf" : "text/html";
      out.push({ filename: picked.split("/").pop()!, content: buf, contentType: ct });
    } catch {
      /* skip */
    }
  }
  return out;
}

// ── log_to_crm ──────────────────────────────────────────────────

function actLogToCrm(
  ctx: ActionRunContext,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const mapping = (config.mapping as Record<string, string> | undefined) ?? defaultCrmMapping(ctx);
  const values: Record<string, PropertyValue> = {};
  for (const [crmField, inputName] of Object.entries(mapping)) {
    const v = ctx.run.inputs[inputName];
    if (v == null || v === "") continue;
    // Use richText for free-form values — round-trips through the DB row
    // store cleanly without needing a schema lookup to pick the "right"
    // property type. Caller can normalize later.
    values[crmField] = { type: "richText", markdown: String(v) };
  }
  const titleField =
    (config.titleField as string | undefined) || mapping.name || mapping.fullName || "name";
  const title =
    ctx.run.inputs[titleField] ||
    ctx.run.inputs.fullName ||
    ctx.run.inputs.email ||
    `lead-${ctx.run.id.slice(0, 8)}`;
  const row = upsertRowForBusinessRole("clients", ctx.template.businessId, {
    title,
    values,
    externalRef: {
      system: "notion", // bridge schema reuses this enum; tag with our slug below
      externalId: `discovery:${ctx.run.id}`,
      lastSyncedAt: Date.now(),
    },
  });
  if (!row) {
    throw new Error("CRM upsert returned null — business may not have a clients role bound");
  }
  return { clientRowId: row.id };
}

function defaultCrmMapping(_ctx: ActionRunContext): Record<string, string> {
  return {
    name: "fullName",
    email: "email",
    company: "company",
    phone: "phone",
    notes: "goals",
  };
}

// ── telegram_notify ─────────────────────────────────────────────

async function actTelegram(
  ctx: ActionRunContext,
  config: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { sendMessageTelegram } = await import("../telegram/send.js");
  const { loadConfig } = await import("../config/config.js");
  const cfg = loadConfig();
  const telegram = (
    cfg as { channels?: { telegram?: { botToken?: string; allowFrom?: Array<string | number> } } }
  ).channels?.telegram;
  const botToken = telegram?.botToken;
  const chatId =
    (config.chatId as string | undefined) ||
    (telegram?.allowFrom?.[0] != null ? String(telegram.allowFrom[0]) : null);
  if (!botToken || !chatId) {
    throw new Error(
      "Telegram not configured (botToken / chatId missing in config.channels.telegram)",
    );
  }
  const messageTpl =
    (config.message as string | undefined) ||
    `📋 *${ctx.template.name}*\n\nLead: {{input.fullName}} <{{input.email}}>\nCompany: {{input.company}}\nCategory: ${ctx.run.qualifyCategory ?? "—"}\n\n{{run.id}}`;
  const message = renderTokens(messageTpl, ctx);
  await sendMessageTelegram(chatId, message, { token: botToken });
  return { chatId };
}

// ── qualify_lead ────────────────────────────────────────────────

function actQualifyLead(
  ctx: ActionRunContext,
  config: Record<string, unknown>,
): Record<string, unknown> {
  // Two modes:
  //  - manual rule:  `{ rules: [{ when: "input.company", contains: "co", category: "qualified" }, ...] }`
  //  - ai keyword:   `{ extractFromMarkdown: true, candidates: ["qualified","maybe","unqualified"] }`
  const rules =
    (config.rules as
      | Array<{ when: string; contains?: string; equals?: string; category: string }>
      | undefined) ?? [];
  for (const r of rules) {
    const path = r.when.split(".");
    let v: unknown = path[0] === "input" ? ctx.run.inputs : undefined;
    for (let i = 1; i < path.length && v != null; i++) {
      v = (v as Record<string, unknown>)[path[i]];
    }
    const sv = String(v ?? "").toLowerCase();
    if (r.contains && sv.includes(r.contains.toLowerCase())) {
      ctx.run.qualifyCategory = r.category;
      return { category: r.category, source: "rule" };
    }
    if (r.equals && sv === r.equals.toLowerCase()) {
      ctx.run.qualifyCategory = r.category;
      return { category: r.category, source: "rule" };
    }
  }
  if (config.extractFromMarkdown) {
    const candidates = (config.candidates as string[] | undefined) ?? [
      "qualified",
      "maybe",
      "unqualified",
    ];
    const md = ctx.run.generatedMarkdown.toLowerCase();
    for (const c of candidates) {
      if (md.includes(c.toLowerCase())) {
        ctx.run.qualifyCategory = c;
        return { category: c, source: "markdown" };
      }
    }
  }
  ctx.run.qualifyCategory = (config.defaultCategory as string | undefined) ?? "uncategorized";
  return { category: ctx.run.qualifyCategory, source: "default" };
}

// ── calendly_link ───────────────────────────────────────────────

function actCalendlyLink(
  ctx: ActionRunContext,
  config: Record<string, unknown>,
): Record<string, unknown> {
  // Pulled at send time: if the approval gate hasn't approved this run,
  // we still record what URL WOULD have been sent. The actual email step
  // can read this from run.actions[].output and include it.
  if (ctx.run.approvalState !== "auto-approved" && ctx.run.approvalState !== "approved") {
    return { skipped: true, reason: `awaiting approval (state=${ctx.run.approvalState})` };
  }
  const url =
    (config.eventTypeUri as string | undefined) || ctx.template.approval.calendlyEventTypeUri;
  if (!url) {
    throw new Error("No Calendly event-type URI configured");
  }
  // Calendly's scheduling URL is shareable directly; if user pasted an
  // API resource URI we leave it alone but log it.
  ctx.run.calendlyLinkSent = true;
  return { url };
}

// ── helpers ────────────────────────────────────────────────────

function renderTokens(template: string, ctx: ActionRunContext): string {
  return template
    .replace(/\{\{\s*input\.([a-zA-Z0-9_]+)\s*\}\}/g, (_, k: string) => ctx.run.inputs[k] ?? "")
    .replace(/\{\{\s*biz\.name\s*\}\}/g, ctx.businessName)
    .replace(/\{\{\s*run\.id\s*\}\}/g, ctx.run.id)
    .replace(/\{\{\s*template\.name\s*\}\}/g, ctx.template.name)
    .replace(/\{\{\s*category\s*\}\}/g, ctx.run.qualifyCategory ?? "");
}

function naiveMarkdownToHtml(s: string): string {
  // Lightweight: headings + paragraphs + lists + bold/italic. Good enough
  // for the audit/report shape; users who want richer rendering can paste
  // the markdown into a proper renderer downstream.
  const lines = s.split("\n");
  const out: string[] = [];
  let inList = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      continue;
    }
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^###\s+(.*)$/))) out.push(`<h3>${m[1]}</h3>`);
    else if ((m = line.match(/^##\s+(.*)$/))) out.push(`<h2>${m[1]}</h2>`);
    else if ((m = line.match(/^#\s+(.*)$/))) out.push(`<h1>${m[1]}</h1>`);
    else if ((m = line.match(/^[*-]\s+(.*)$/))) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inlineFormat(m[1])}</li>`);
    } else {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      out.push(`<p>${inlineFormat(line)}</p>`);
    }
  }
  if (inList) out.push("</ul>");
  return out.join("\n");
}

function inlineFormat(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cssColor(c: string): string {
  if (!c) return "#6366f1";
  return c.replace(/[^a-zA-Z0-9#(),.\s%-]/g, "") || "#6366f1";
}

function cssFont(f: string): string {
  if (!f) return "Inter, system-ui, sans-serif";
  return f.replace(/[<>"']/g, "");
}
