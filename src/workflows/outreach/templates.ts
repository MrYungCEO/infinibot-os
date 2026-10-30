/**
 * Outreach Template Store
 *
 * Reads markdown files from ~/.infinibot/outreach/templates/*.md
 * Each file has YAML frontmatter: { subject, cadence_days, max_followups }
 * Body supports mustache: {{lead.name}}, {{lead.website}}, {{lead.recommended_pitch}}, {{me.first_name}}
 *
 * Returns a parsed TemplateRecord. Index is kept in-memory (no extra DB call needed).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, basename, extname } from "node:path";
import { homedir } from "node:os";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TemplateRecord {
  id: string;
  name: string;
  filePath: string;
  subject: string;
  body: string;
  /** Days between follow-ups, e.g. [3, 7, 14] */
  cadenceDays: number[];
  maxFollowups: number;
  /** If set, this is a variant of another template (for A/B testing). */
  variantOf?: string;
}

export interface SenderIdentity {
  firstName: string;
  lastName: string;
  email: string;
  companyName: string;
  /** Physical address required for CAN-SPAM compliance. */
  physicalAddress: string;
  replyTo?: string;
  unsubscribeBaseUrl?: string;
}

// ── Template directory ────────────────────────────────────────────────────────

function getTemplatesDir(): string {
  return resolve(homedir(), ".infinibot", "outreach", "templates");
}

// ── Sender identity ───────────────────────────────────────────────────────────

let _senderIdentity: SenderIdentity | null = null;

export function getSenderIdentity(): SenderIdentity {
  if (_senderIdentity) return _senderIdentity;

  const identityPath = resolve(homedir(), ".infinibot", "sender-identity.json");
  if (!existsSync(identityPath)) {
    console.warn(
      "[outreach] ~/.infinibot/sender-identity.json not found — using placeholder sender identity. " +
        "Create this file to comply with CAN-SPAM (physical address required). " +
        "TODO(closed-loop): configure sender identity before production sends.",
    );
    _senderIdentity = {
      firstName: "Agent",
      lastName: "AI",
      email: "outreach@example.com",
      companyName: "Your Company",
      physicalAddress: "123 Main St, Anytown, USA 00000",
      replyTo: "outreach@example.com",
    };
    return _senderIdentity;
  }

  try {
    const raw = readFileSync(identityPath, "utf8");
    _senderIdentity = JSON.parse(raw) as SenderIdentity;
    return _senderIdentity;
  } catch (err) {
    console.error(`[outreach] Failed to parse sender-identity.json: ${String(err)}`);
    throw new Error(`Invalid sender-identity.json: ${String(err)}`);
  }
}

// ── Parse YAML frontmatter (minimal, no dep) ─────────────────────────────────

function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  if (!content.startsWith("---")) return { frontmatter: {}, body: content };
  const end = content.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: {}, body: content };

  const yamlSection = content.slice(3, end).trim();
  const body = content.slice(end + 4).trim();

  const frontmatter: Record<string, unknown> = {};
  for (const line of yamlSection.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    // Simple type coercions
    if (value.startsWith("[") && value.endsWith("]")) {
      // Array: [3, 7, 14]
      frontmatter[key] = value
        .slice(1, -1)
        .split(",")
        .map((v) => parseFloat(v.trim()))
        .filter((n) => !isNaN(n));
    } else if (!isNaN(Number(value)) && value !== "") {
      frontmatter[key] = Number(value);
    } else {
      frontmatter[key] = value.replace(/^["']|["']$/g, "");
    }
  }

  return { frontmatter, body };
}

// ── Load templates ────────────────────────────────────────────────────────────

export function loadTemplates(): TemplateRecord[] {
  const dir = getTemplatesDir();
  if (!existsSync(dir)) {
    console.warn(`[outreach] Templates dir not found: ${dir} — creating with default template`);
    _ensureDefaultTemplate(dir);
    if (!existsSync(dir)) return [];
  }

  const files = readdirSync(dir).filter((f) => extname(f) === ".md");
  if (files.length === 0) {
    _ensureDefaultTemplate(dir);
    const refilled = readdirSync(dir).filter((f) => extname(f) === ".md");
    if (refilled.length === 0) return [];
    files.push(...refilled);
  }

  const templates: TemplateRecord[] = [];
  for (const file of files) {
    const filePath = join(dir, file);
    try {
      const raw = readFileSync(filePath, "utf8");
      const { frontmatter, body } = parseFrontmatter(raw);
      const name = basename(file, ".md");
      const record: TemplateRecord = {
        id: name,
        name,
        filePath,
        subject: String(frontmatter.subject ?? `Quick question about {{lead.name}}`),
        body,
        cadenceDays: Array.isArray(frontmatter.cadence_days)
          ? (frontmatter.cadence_days as number[])
          : [3, 7, 14],
        maxFollowups: Number(frontmatter.max_followups ?? 3),
        variantOf: frontmatter.variant_of ? String(frontmatter.variant_of) : undefined,
      };
      templates.push(record);
    } catch (err) {
      console.error(`[outreach] Failed to parse template ${file}: ${String(err)}`);
    }
  }

  return templates;
}

/** Get a single template by id (filename without .md). */
export function getTemplate(id: string): TemplateRecord | null {
  const templates = loadTemplates();
  return templates.find((t) => t.id === id) ?? null;
}

/** Round-robin across variants of a template for A/B testing. */
export function pickTemplateVariant(
  templates: TemplateRecord[],
  baseId: string,
): TemplateRecord | null {
  const variants = templates.filter((t) => t.variantOf === baseId || t.id === baseId);
  if (variants.length === 0) return null;
  // Simple round-robin: pick based on current minute
  return variants[Math.floor(Date.now() / 60000) % variants.length] ?? variants[0] ?? null;
}

// ── Mustache interpolation ────────────────────────────────────────────────────

export interface TemplateContext {
  lead: {
    name: string;
    website?: string | null;
    email?: string | null;
    phone?: string | null;
    address?: string | null;
    recommended_pitch?: string | null;
  };
  me: {
    first_name: string;
    last_name: string;
    company: string;
    email: string;
  };
  unsubscribe_url?: string;
  physical_address?: string;
}

export function renderTemplate(
  template: TemplateRecord,
  context: TemplateContext,
): { subject: string; body: string } {
  const render = (str: string): string =>
    str
      .replace(/\{\{lead\.name\}\}/g, context.lead.name)
      .replace(/\{\{lead\.website \|\| "([^"]+)"\}\}/g, context.lead.website || "$1")
      .replace(/\{\{lead\.website\}\}/g, context.lead.website ?? "your business")
      .replace(
        /\{\{lead\.recommended_pitch\}\}/g,
        context.lead.recommended_pitch ?? "your services",
      )
      .replace(/\{\{me\.first_name\}\}/g, context.me.first_name)
      .replace(/\{\{me\.last_name\}\}/g, context.me.last_name)
      .replace(/\{\{me\.company\}\}/g, context.me.company)
      .replace(/\{\{me\.email\}\}/g, context.me.email)
      .replace(/\{\{unsubscribe_url\}\}/g, context.unsubscribe_url ?? "#unsubscribe")
      .replace(/\{\{physical_address\}\}/g, context.physical_address ?? "");

  return { subject: render(template.subject), body: render(template.body) };
}

// ── Default template ──────────────────────────────────────────────────────────

function _ensureDefaultTemplate(dir: string): void {
  const { mkdirSync, writeFileSync } = require("node:fs");
  try {
    mkdirSync(dir, { recursive: true });
    const defaultTemplate = `---
subject: Quick question about {{lead.name}}
cadence_days: [3, 7, 14]
max_followups: 3
---
Hi there,

I came across {{lead.name}} and was impressed by {{lead.recommended_pitch}}.

We help businesses like yours [insert your value prop here]. I'd love to show you how we can help.

Would you be open to a quick 15-minute call this week?

Best,
{{me.first_name}}
{{me.company}}

---
{{physical_address}}
[Unsubscribe]({{unsubscribe_url}})
`;
    writeFileSync(join(dir, "default.md"), defaultTemplate, "utf8");
    console.log(`[outreach] Created default template at ${dir}/default.md`);
  } catch (err) {
    console.error(`[outreach] Failed to create default template: ${String(err)}`);
  }
}
