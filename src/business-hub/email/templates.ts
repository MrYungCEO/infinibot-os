/**
 * Business hub email — templates: CRUD, `{{var|default}}` rendering (HTML
 * escaped in bodies), lint (unknown variables, missing unsubscribe link,
 * missing postal address) and the compliant footer that is appended when a
 * template has no unsubscribe link of its own.
 */

import type { Contact } from "../contacts.js";
import { getContact } from "../contacts.js";
import type { HubDb } from "../db.js";
import { hubId, str } from "../util.js";
import { getEmailSettings } from "./config.js";
import { coerceString } from "../../shared/text/coerce.js";

export type EmailTemplate = {
  id: string;
  name: string;
  subject: string;
  html: string;
  text: string;
  createdAt: number;
  updatedAt: number;
};

export const TEMPLATE_VARS = [
  "first_name",
  "last_name",
  "name",
  "email",
  "company",
  "title",
  "city",
  "unsubscribe_url",
  "sender_name",
  "sender_email",
  "physical_address",
  "company_name",
] as const;

type Row = Record<string, unknown>;

function rowToTemplate(r: Row): EmailTemplate {
  return {
    id: r.id as string,
    name: r.name as string,
    subject: r.subject as string,
    html: (r.html as string) ?? "",
    text: (r.text as string) ?? "",
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export function listTemplates(db: HubDb): EmailTemplate[] {
  return (db.prepare("SELECT * FROM email_templates ORDER BY updated_at DESC").all() as Row[]).map(
    rowToTemplate,
  );
}

export function getTemplate(db: HubDb, id: string): EmailTemplate | null {
  const r = db.prepare("SELECT * FROM email_templates WHERE id = ?").get(id) as Row | undefined;
  return r ? rowToTemplate(r) : null;
}

export function saveTemplate(
  db: HubDb,
  input: { id?: string; name?: string; subject?: string; html?: string; text?: string },
): { template: EmailTemplate; lint: TemplateLint } {
  const now = Date.now();
  const cur = input.id ? getTemplate(db, input.id) : null;
  if (input.id && !cur) throw new Error(`template not found: ${input.id}`);
  const name = (str(input.name) ?? cur?.name ?? "").slice(0, 200);
  const subject = (input.subject ?? cur?.subject ?? "").trim().slice(0, 500);
  const html = (input.html ?? cur?.html ?? "").slice(0, 500_000);
  const text = (input.text ?? cur?.text ?? "").slice(0, 200_000);
  if (!name) throw new Error("name required");
  if (!subject) throw new Error("subject required");
  if (!html.trim() && !text.trim()) throw new Error("html or text body required");
  let id = cur?.id;
  if (cur) {
    db.prepare(
      "UPDATE email_templates SET name=?, subject=?, html=?, text=?, updated_at=? WHERE id=?",
    ).run(name, subject, html, text, now, cur.id);
  } else {
    id = hubId("tpl");
    db.prepare(
      "INSERT INTO email_templates(id,name,subject,html,text,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    ).run(id, name, subject, html, text, now, now);
  }
  const template = getTemplate(db, id!)!;
  return { template, lint: lintTemplate(db, template) };
}

export function deleteTemplate(db: HubDb, id: string): void {
  const used = db
    .prepare(
      `SELECT ec.name FROM email_steps s JOIN email_campaigns ec ON ec.id = s.email_campaign_id
       WHERE s.template_id = ? LIMIT 1`,
    )
    .get(id) as { name: string } | undefined;
  if (used) throw new Error(`template is used by campaign "${used.name}"`);
  db.prepare("DELETE FROM email_templates WHERE id = ?").run(id);
}

// ── Rendering ────────────────────────────────────────────────────────────────

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const VAR_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g;

/**
 * Render `{{name}}` / `{{name|default}}`. `custom.<key>` reads the custom
 * map. Values are HTML-escaped when `html` is true (defaults are escaped too).
 */
export function renderString(
  tpl: string,
  vars: Record<string, unknown>,
  custom: Record<string, unknown>,
  opts: { html: boolean },
): { out: string; unknown: string[] } {
  const unknown = new Set<string>();
  const out = tpl.replace(VAR_RE, (_m, rawName: string, def: string | undefined) => {
    const name = rawName.toLowerCase();
    let value: unknown;
    if (name.startsWith("custom.")) {
      const key = rawName.slice("custom.".length);
      value = custom[key] ?? custom[key.toLowerCase()];
    } else if (name in vars) {
      value = vars[name];
    } else {
      unknown.add(rawName);
    }
    let s =
      value === null || value === undefined || value === ""
        ? (def ?? "")
        : typeof value === "object"
          ? JSON.stringify(value)
          : coerceString(value);
    if (opts.html) s = escapeHtml(s);
    return s;
  });
  return { out, unknown: [...unknown] };
}

export type SenderVars = { senderName?: string | null; senderEmail?: string | null };

/** Variables for a contact (+ sender, unsubscribe URL, footer fields). */
export function contactVars(
  db: HubDb,
  contact: Contact | null,
  extra: SenderVars & { unsubscribeUrl?: string | null; vars?: Record<string, unknown> } = {},
): { vars: Record<string, unknown>; custom: Record<string, unknown> } {
  const settings = getEmailSettings(db);
  let company: string | null = null;
  if (contact?.companyId) {
    const r = db.prepare("SELECT name FROM companies WHERE id = ?").get(contact.companyId) as
      | { name: string }
      | undefined;
    company = r?.name ?? null;
  }
  const vars: Record<string, unknown> = {
    first_name: contact?.firstName ?? null,
    last_name: contact?.lastName ?? null,
    name: contact?.name || null,
    email: contact?.email ?? null,
    company,
    title: contact?.title ?? null,
    city: contact?.city ?? null,
    unsubscribe_url: extra.unsubscribeUrl ?? null,
    sender_name: extra.senderName ?? null,
    sender_email: extra.senderEmail ?? null,
    physical_address: settings.physicalAddress ?? ADDRESS_PLACEHOLDER,
    company_name: settings.companyName ?? extra.senderName ?? null,
  };
  for (const [k, v] of Object.entries(extra.vars ?? {})) vars[k.toLowerCase()] = v;
  return { vars, custom: contact?.custom ?? {} };
}

export const ADDRESS_PLACEHOLDER = "[Postal address — set it in Business hub › Email settings]";

// ── Lint + footer ────────────────────────────────────────────────────────────

export type TemplateLint = { warnings: string[]; hasUnsubscribe: boolean };

function hasUnsubscribeLink(html: string, text: string): boolean {
  return /\{\{\s*unsubscribe_url/i.test(html) || /\{\{\s*unsubscribe_url/i.test(text);
}

export function lintTemplate(
  db: HubDb,
  t: { subject: string; html: string; text: string },
): TemplateLint {
  const warnings: string[] = [];
  const known = new Set<string>(TEMPLATE_VARS);
  for (const src of [t.subject, t.html, t.text]) {
    for (const m of src.matchAll(VAR_RE)) {
      const n = m[1].toLowerCase();
      if (!known.has(n) && !n.startsWith("custom."))
        warnings.push(`unknown variable {{${m[1]}}} renders empty`);
    }
  }
  const hasUnsubscribe = hasUnsubscribeLink(t.html, t.text);
  if (!hasUnsubscribe)
    warnings.push(
      "no {{unsubscribe_url}} link — a compliant footer with an unsubscribe link is appended automatically",
    );
  if (!getEmailSettings(db).physicalAddress)
    warnings.push("no postal address configured — the footer shows a placeholder");
  if (t.subject.length > 150) warnings.push("subject is longer than 150 characters");
  return { warnings: [...new Set(warnings)], hasUnsubscribe };
}

const FOOTER_HTML = `<div style="margin-top:32px;padding-top:12px;border-top:1px solid #e5e5e5;font:12px/1.5 Arial,sans-serif;color:#777">{{company_name|}} · {{physical_address}}<br>You received this email because you are in our contacts. <a href="{{unsubscribe_url}}" style="color:#777">Unsubscribe</a></div>`;
const FOOTER_TEXT = `\n\n--\n{{company_name|}} · {{physical_address}}\nUnsubscribe: {{unsubscribe_url}}\n`;

/** Append the compliant footer when the template has no unsubscribe link. */
export function withFooter(t: { html: string; text: string }): {
  html: string;
  text: string;
  appended: boolean;
} {
  if (hasUnsubscribeLink(t.html, t.text)) return { ...t, appended: false };
  let html = t.html;
  if (html.trim()) {
    html = /<\/body>/i.test(html)
      ? html.replace(/<\/body>/i, `${FOOTER_HTML}</body>`)
      : `${html}${FOOTER_HTML}`;
  }
  const text = t.text.trim() ? `${t.text}${FOOTER_TEXT}` : t.text;
  return { html, text, appended: true };
}

/** Plain-text alternative from HTML (links become "text (url)"). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(
      /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (_m, href: string, inner: string) => {
        const label = inner.replace(/<[^>]+>/g, "").trim();
        return label && label !== href ? `${label} (${href})` : href;
      },
    )
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type RenderedEmail = {
  subject: string;
  html: string;
  text: string;
  warnings: string[];
  footerAppended: boolean;
};

/** Render a template for one contact: footer (when needed) → variables → text part. */
export function renderEmail(
  db: HubDb,
  t: { subject: string; html: string; text: string },
  contact: Contact | null,
  ctx: SenderVars & {
    unsubscribeUrl: string | null;
    vars?: Record<string, unknown>;
    footer?: boolean;
  },
): RenderedEmail {
  const footer = ctx.footer === false ? { ...t, appended: false } : withFooter(t);
  const { vars, custom } = contactVars(db, contact, ctx);
  const subject = renderString(t.subject, vars, custom, { html: false });
  const html = renderString(footer.html, vars, custom, { html: true });
  const text = renderString(footer.text, vars, custom, { html: false });
  const unknown = new Set([...subject.unknown, ...html.unknown, ...text.unknown]);
  return {
    subject: subject.out.replace(/[\r\n]+/g, " ").trim(),
    html: html.out,
    text: text.out.trim() ? text.out : html.out ? htmlToText(html.out) : "",
    warnings: [...unknown].map((u) => `unknown variable {{${u}}}`),
    footerAppended: footer.appended,
  };
}

/** Preview a stored template or ad-hoc content against a contact (or a sample). */
export function previewTemplate(
  db: HubDb,
  input: {
    templateId?: string;
    subject?: string;
    html?: string;
    text?: string;
    contactId?: string;
  },
): RenderedEmail & { lint: TemplateLint } {
  const tpl = input.templateId ? getTemplate(db, input.templateId) : null;
  if (input.templateId && !tpl) throw new Error(`template not found: ${input.templateId}`);
  const t = {
    subject: input.subject ?? tpl?.subject ?? "",
    html: input.html ?? tpl?.html ?? "",
    text: input.text ?? tpl?.text ?? "",
  };
  const contact: Contact | null = input.contactId
    ? getContact(db, input.contactId)
    : {
        ...SAMPLE_CONTACT,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
  const r = renderEmail(db, t, contact, {
    unsubscribeUrl: "#unsubscribe-preview",
    senderName: "Your Name",
    senderEmail: "you@example.com",
  });
  return { ...r, lint: lintTemplate(db, t) };
}

const SAMPLE_CONTACT: Omit<Contact, "createdAt" | "updatedAt"> = {
  id: "ct_sample",
  businessId: null,
  name: "Jane Doe",
  firstName: "Jane",
  lastName: "Doe",
  email: "jane@example.com",
  phone: null,
  phoneE164: null,
  title: "Head of Growth",
  companyId: null,
  clientId: null,
  lifecycle: "lead",
  score: 0,
  emailStatus: "unknown",
  emailOptIn: true,
  consentAt: null,
  consentSource: null,
  owner: null,
  city: "Austin",
  country: "US",
  social: {},
  custom: {},
  firstSourceId: null,
  firstCampaignId: null,
  firstPageId: null,
  lastActivityAt: null,
  importBatchId: null,
  legacyRef: null,
};
