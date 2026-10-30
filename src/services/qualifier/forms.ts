/**
 * Lead-qualifier form builder — persistent store for public, branded
 * lead capture forms that POST into the qualifier pipeline.
 *
 * Each `QualifierForm` is independent of the per-business
 * `QualifierConfigV1` (one business can run many forms — one for a
 * webinar funnel, one for a high-ticket mentorship, one for cold IG
 * DMs, etc.) but every form references a `businessId` so qualifier
 * actions resolve the right CRM / kanban project / branding.
 *
 * Files written under `<state>/lead-qualifier-forms/`:
 *   forms.json              — full form configs keyed by id
 *   analytics-<id>.jsonl    — append-only event stream (view, focus,
 *                              start, submit) per form, used by the
 *                              KPI dashboard
 *
 * This module is deliberately CRUD-only — submission handling lives in
 * `src/gateway/server-pages-public.ts` (public HTTP) and reuses
 * `runQualifier()` to execute the action stack so we don't duplicate
 * pipeline logic.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { randomUUID } from "node:crypto";

import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("qualifier-forms");

// ── Types ─────────────────────────────────────────────────────

export type FormFieldKind =
  | "text"
  | "email"
  | "phone"
  | "url"
  | "number"
  | "textarea"
  | "select"
  | "radio"
  | "checkbox"
  | "checkbox-group"
  | "rating"
  | "date"
  | "hidden"
  | "consent";

export interface FormFieldOption {
  label: string;
  value: string;
  /** Optional score added to the lead-quality total when this option is picked. */
  score?: number;
}

export interface FormField {
  id: string;
  /** Form-data key that the qualifier criteria reference (e.g. `email`, `budget`). */
  name: string;
  label: string;
  kind: FormFieldKind;
  required?: boolean;
  placeholder?: string;
  helpText?: string;
  /** For select / radio / checkbox-group. */
  options?: FormFieldOption[];
  /** For number / rating. */
  min?: number;
  max?: number;
  /** For hidden — submitted value. */
  defaultValue?: string;
  /** Which page/step (1-indexed) for multi-step layouts. */
  step?: number;
  /** Optional regex pattern for client-side validation. */
  pattern?: string;
  /** Optional column span (1-12) for the grid layout. */
  span?: number;
}

export type FormLayout =
  /** Single column, all fields stacked. Default for low-friction lead capture. */
  | "single-column"
  /** Two-column grid that collapses to single on mobile. */
  | "two-column"
  /** Multi-step wizard (one `step` group per screen with Next / Back). */
  | "multi-step"
  /**
   * Page-by-page wizard: each step renders as its own full-screen
   * centered card with logo at top-center, per-step headline, and a
   * single field group. Animated transitions between pages. Best for
   * Typeform-style flow.
   */
  | "step-by-step"
  /** Long-form sales-letter layout — hero, social-proof, then form. */
  | "long-form"
  /** Card grid layout for product/offer selection then qualifying details. */
  | "card-grid";

export interface FormStyle {
  /** Theme preset id (links to FORM_TEMPLATES) — drives the base CSS. */
  templateId: string;
  /** Brand primary color (CTA, accents). */
  primaryColor: string;
  /** Page background. */
  bgColor: string;
  /** Body text color. */
  textColor: string;
  /** Card background — null = transparent over page bg. */
  cardColor: string | null;
  /** Accent / secondary color used for gradients + borders. */
  accentColor: string;
  /** CSS font-family stack. */
  fontStack: string;
  /** Border radius for inputs + cards in pixels. */
  radius: number;
  /** When true the rendered page uses a dark gradient hero. */
  darkHero: boolean;
  /** Logo asset URL (absolute or relative to gateway). */
  logoUrl: string | null;
  /**
   * Where to position the logo on every page.
   *   "center-top"  — centered above the headline (default for step-by-step)
   *   "top-left"    — pinned to the top-left of the hero
   *   "hidden"      — don't render even if logoUrl is set
   */
  logoPosition?: "center-top" | "top-left" | "hidden";
  /** Logo max-width in pixels — caps how big the logo can render. */
  logoMaxWidth?: number;
  /** Background image / video URL (optional). */
  bgImageUrl: string | null;
  /** Custom CSS injected last — escape hatch for branding. */
  customCss: string;
  /** Active theme preset id. */
  themeId?: string;
  /** Separate heading font (pairs with body fontStack). */
  headingFontStack?: string;
  /** CTA button visual style. */
  buttonStyle?: "solid" | "outline" | "glass" | "gradient" | "neon";
  /** Card/surface treatment. */
  surfaceStyle?: "flat" | "raised" | "glass" | "gradient" | "noise";
  /** Drop shadow intensity: 0=none, 3=dramatic. */
  shadowLevel?: 0 | 1 | 2 | 3;
  /** Optional accent gradient (overrides plain accentColor in gradients). */
  accentGradient?: { from: string; to: string; angle?: number } | null;
  /** Input field visual style. */
  inputStyle?: "underline" | "filled" | "outline" | "glass";
  /** Spacing density. */
  density?: "comfortable" | "compact" | "spacious";
  /** Animation level. */
  motionLevel?: "off" | "subtle" | "full";
}

export interface FormContent {
  /** Browser title + OG title. */
  title: string;
  /** Headline shown above the form (h1). */
  headline: string;
  /** Sub-headline / lead paragraph. */
  subheadline: string;
  /** Optional preheader text (small caps eyebrow above headline). */
  eyebrow: string;
  /** Feature bullets shown above the form. */
  bullets: string[];
  /** Testimonial pull-quotes shown in long-form layouts. */
  testimonials: Array<{ quote: string; author: string; role?: string }>;
  /** Submit button label. */
  cta: string;
  /** Inline thank-you headline (used when redirect is empty). */
  thankYouHeadline: string;
  /** Inline thank-you body. */
  thankYouBody: string;
  /** External redirect URL on success (overrides inline thank-you). */
  thankYouUrl: string;
  /** Calendly-style booking embed URL shown on the success page. */
  calendlyUrl: string;
  /** Optional video embed URL shown above the form (YouTube/Vimeo/MP4). */
  videoUrl: string;
  /**
   * Per-step content for the `step-by-step` layout. Index is the
   * step number (0-based — step #1 = index 0). Each entry overrides
   * the form-level headline/sub/eyebrow on that step. Missing entries
   * fall back to the form-level content so authors only fill what
   * they want to differ per page.
   */
  stepContent?: Array<{
    eyebrow?: string;
    headline?: string;
    subheadline?: string;
  }>;
}

/** Per-field qualifying logic that runs client-side AND server-side. */
export interface FormQualifier {
  /** Sum of `score` values across selected options ≥ this threshold = qualified. */
  scoreThreshold: number;
  /** When true, an unqualified submission still saves but skips the qualified-only actions. */
  saveUnqualified: boolean;
}

export interface QualifierFormConfig {
  /** Stable id (`qf_<uuid>`). */
  id: string;
  /** Owning business — required so actions resolve the right CRM. */
  businessId: string;
  /** Optional funnel id — submissions roll up into this funnel's KPI dashboard. */
  funnelId: string | null;
  /** Optional qualifier config id this form is bound to (defaults to the business's primary qualifier). */
  qualifierBusinessId: string | null;
  /** Public URL slug — must be unique across forms. */
  slug: string;
  /** User-facing name (shown in admin UI). */
  name: string;
  /** Marketing tag (e.g. "High-ticket mentorship"). */
  tag: string;
  /** Active flag — when false the public URL 404s. */
  published: boolean;
  /** Layout shape. */
  layout: FormLayout;
  /** Style overrides — template id + brand colors. */
  style: FormStyle;
  /** Copy (headlines, bullets, CTAs, thank-you). */
  content: FormContent;
  /** Fields rendered on the form. */
  fields: FormField[];
  /** Scoring / qualifying rules. */
  qualifier: FormQualifier;
  /** Optional CRM database id override (otherwise inherits business CRM). */
  crmDatabaseId: string | null;
  /** Anti-bot honeypot input name. */
  honeypotField: string;
  /** Maintenance metadata. */
  createdAt: number;
  updatedAt: number;
}

export type FormAnalyticsEventKind =
  | "view"
  | "start"
  | "field-focus"
  | "field-complete"
  | "step-advance"
  | "submit-attempt"
  | "submit-success"
  | "submit-error";

export interface FormAnalyticsEvent {
  ts: number;
  /** Anonymous viewer id (cookie-less session string from client JS). */
  vid: string;
  kind: FormAnalyticsEventKind;
  /** Field name when applicable. */
  field?: string;
  /** Step index for multi-step. */
  step?: number;
  /** Referrer URL (truncated). */
  ref?: string;
  /** UTM tags pulled from the query string. */
  utm?: Record<string, string>;
  /** When `kind === submit-*`, the resulting leadId / result. */
  leadId?: string;
  qualified?: boolean;
}

export interface FormSubmissionRecord {
  id: string;
  formId: string;
  ts: number;
  payload: Record<string, unknown>;
  qualified: boolean;
  leadId?: string;
  /** Aggregated score from `FormFieldOption.score` sums. */
  score: number;
  ip?: string;
  userAgent?: string;
  utm?: Record<string, string>;
  rejected?: "honeypot" | "rate_limit" | "validation";
}

// ── Storage paths ─────────────────────────────────────────────

function stateDir(): string {
  return process.env.INFINIBOT_STATE_DIR ?? "state";
}

function formsDir(): string {
  return join(stateDir(), "lead-qualifier-forms");
}

function formsFile(): string {
  return join(formsDir(), "forms.json");
}

function analyticsFile(formId: string): string {
  return join(formsDir(), `analytics-${formId}.jsonl`);
}

function submissionsFile(formId: string): string {
  return join(formsDir(), `submissions-${formId}.jsonl`);
}

function ensureDir(): void {
  const d = formsDir();
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

// ── Form CRUD ─────────────────────────────────────────────────

interface FormsFile {
  forms: Record<string, QualifierFormConfig>;
}

function loadAll(): FormsFile {
  ensureDir();
  const p = formsFile();
  if (!existsSync(p)) return { forms: {} };
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<FormsFile>;
    return { forms: raw.forms && typeof raw.forms === "object" ? raw.forms : {} };
  } catch (e) {
    log.warn("forms file unreadable, starting empty", { err: String(e) });
    return { forms: {} };
  }
}

function saveAll(file: FormsFile): void {
  ensureDir();
  const p = formsFile();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(file, null, 2));
}

export function listForms(filter?: {
  businessId?: string;
  funnelId?: string | null;
}): QualifierFormConfig[] {
  const all = Object.values(loadAll().forms);
  return all.filter((f) => {
    if (filter?.businessId && f.businessId !== filter.businessId) return false;
    if (filter?.funnelId !== undefined && f.funnelId !== filter.funnelId) return false;
    return true;
  });
}

export function getForm(id: string): QualifierFormConfig | null {
  if (!id) return null;
  return loadAll().forms[id] ?? null;
}

export function getFormBySlug(slug: string): QualifierFormConfig | null {
  if (!slug) return null;
  const all = loadAll().forms;
  for (const f of Object.values(all)) {
    if (f.slug === slug) return f;
  }
  return null;
}

export function upsertForm(
  form: Partial<QualifierFormConfig> & { businessId: string },
): QualifierFormConfig {
  if (!form.businessId) throw new Error("upsertForm: businessId required");
  const file = loadAll();
  const now = Date.now();
  const id = form.id ?? `qf_${randomUUID()}`;
  const existing = file.forms[id];
  const slug = ensureUniqueSlug(file.forms, form.slug ?? slugify(form.name ?? "form"), id);
  const merged: QualifierFormConfig = {
    ...defaultForm(form.businessId),
    ...existing,
    ...form,
    id,
    slug,
    createdAt: existing?.createdAt ?? form.createdAt ?? now,
    updatedAt: now,
  };
  file.forms[id] = merged;
  saveAll(file);
  return merged;
}

export function deleteForm(id: string): boolean {
  const file = loadAll();
  if (!file.forms[id]) return false;
  delete file.forms[id];
  saveAll(file);
  return true;
}

// ── Analytics events ──────────────────────────────────────────

const ANALYTICS_LINE_CAP = 5000;

export function appendAnalytics(formId: string, event: FormAnalyticsEvent): void {
  if (!formId) return;
  ensureDir();
  appendFileSync(analyticsFile(formId), JSON.stringify(event) + "\n", "utf-8");
}

export function readAnalytics(formId: string, limit = ANALYTICS_LINE_CAP): FormAnalyticsEvent[] {
  const p = analyticsFile(formId);
  if (!existsSync(p)) return [];
  try {
    const lines = readFileSync(p, "utf-8")
      .split(/\r?\n/)
      .filter((l) => l.trim());
    return lines.slice(-limit).map((l) => JSON.parse(l) as FormAnalyticsEvent);
  } catch {
    return [];
  }
}

export interface FormKpiSummary {
  views: number;
  starts: number;
  submits: number;
  qualified: number;
  unqualified: number;
  conversionRate: number;
  qualifiedRate: number;
  /** Per-field abandonment — last field touched before drop-off. */
  fieldAbandonment: Array<{ field: string; count: number }>;
  /** Hourly event histogram for the last 24h, oldest → newest. */
  hourly: Array<{ hour: number; views: number; submits: number }>;
  /** Source breakdown from utm_source tags. */
  bySource: Array<{ source: string; views: number; submits: number }>;
  /** Last 20 events for the live activity stream. */
  recent: FormAnalyticsEvent[];
}

export function summarizeKpi(formId: string): FormKpiSummary {
  const events = readAnalytics(formId);
  let views = 0;
  let starts = 0;
  let submits = 0;
  let qualified = 0;
  let unqualified = 0;
  const lastField: Record<string, string | undefined> = {};
  const sourceMap = new Map<string, { views: number; submits: number }>();
  const now = Date.now();
  const hourBuckets: Record<number, { views: number; submits: number }> = {};
  for (let i = 23; i >= 0; i--) {
    const h = new Date(now - i * 3600_000).getHours();
    hourBuckets[h] = { views: 0, submits: 0 };
  }

  for (const e of events) {
    if (e.kind === "view") views++;
    if (e.kind === "start") starts++;
    if (e.kind === "submit-success") {
      submits++;
      if (e.qualified) qualified++;
      else unqualified++;
    }
    if (e.field) lastField[e.vid] = e.field;
    const src = e.utm?.utm_source ?? "(direct)";
    if (!sourceMap.has(src)) sourceMap.set(src, { views: 0, submits: 0 });
    const bucket = sourceMap.get(src)!;
    if (e.kind === "view") bucket.views++;
    if (e.kind === "submit-success") bucket.submits++;

    const hr = new Date(e.ts).getHours();
    if (hourBuckets[hr]) {
      if (e.kind === "view") hourBuckets[hr].views++;
      if (e.kind === "submit-success") hourBuckets[hr].submits++;
    }
  }

  // Field abandonment — vids that never submitted, count the last field they touched.
  const submittedVids = new Set(
    events.filter((e) => e.kind === "submit-success").map((e) => e.vid),
  );
  const abandonMap = new Map<string, number>();
  for (const [vid, field] of Object.entries(lastField)) {
    if (!field || submittedVids.has(vid)) continue;
    abandonMap.set(field, (abandonMap.get(field) ?? 0) + 1);
  }

  const conversionRate = views > 0 ? submits / views : 0;
  const qualifiedRate = submits > 0 ? qualified / submits : 0;
  const recent = events.slice(-20).reverse();

  return {
    views,
    starts,
    submits,
    qualified,
    unqualified,
    conversionRate,
    qualifiedRate,
    fieldAbandonment: Array.from(abandonMap.entries())
      .map(([field, count]) => ({ field, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
    hourly: Object.entries(hourBuckets).map(([h, b]) => ({
      hour: Number(h),
      views: b.views,
      submits: b.submits,
    })),
    bySource: Array.from(sourceMap.entries())
      .map(([source, b]) => ({ source, views: b.views, submits: b.submits }))
      .sort((a, b) => b.views - a.views)
      .slice(0, 8),
    recent,
  };
}

// ── Submissions log ───────────────────────────────────────────

export function appendSubmission(formId: string, rec: FormSubmissionRecord): void {
  if (!formId) return;
  ensureDir();
  appendFileSync(submissionsFile(formId), JSON.stringify(rec) + "\n", "utf-8");
}

export function listSubmissions(formId: string, limit = 200): FormSubmissionRecord[] {
  const p = submissionsFile(formId);
  if (!existsSync(p)) return [];
  try {
    const lines = readFileSync(p, "utf-8")
      .split(/\r?\n/)
      .filter((l) => l.trim());
    return lines
      .slice(-limit)
      .reverse()
      .map((l) => JSON.parse(l) as FormSubmissionRecord);
  } catch {
    return [];
  }
}

// ── Slug helpers ──────────────────────────────────────────────

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "form"
  );
}

function ensureUniqueSlug(
  existing: Record<string, QualifierFormConfig>,
  base: string,
  selfId: string,
): string {
  const slug = slugify(base);
  let candidate = slug;
  let n = 2;
  while (Object.values(existing).some((f) => f.slug === candidate && f.id !== selfId)) {
    candidate = `${slug}-${n++}`;
  }
  return candidate;
}

// ── Defaults ──────────────────────────────────────────────────

function defaultForm(businessId: string): QualifierFormConfig {
  const now = Date.now();
  return {
    id: `qf_${randomUUID()}`,
    businessId,
    funnelId: null,
    qualifierBusinessId: null,
    slug: "form",
    name: "Untitled form",
    tag: "",
    published: false,
    layout: "single-column",
    style: {
      templateId: "modern-card",
      primaryColor: "#fbbf24",
      bgColor: "#0a0a0f",
      textColor: "#e4e4e7",
      cardColor: null,
      accentColor: "#a855f7",
      fontStack: "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif",
      radius: 12,
      darkHero: true,
      logoUrl: null,
      logoPosition: "center-top",
      logoMaxWidth: 140,
      bgImageUrl: null,
      customCss: "",
    },
    content: {
      title: "Lead capture",
      headline: "Tell us about your project",
      subheadline: "We'll review and reply within 24 hours.",
      eyebrow: "",
      bullets: [],
      testimonials: [],
      cta: "Submit",
      thankYouHeadline: "Thanks!",
      thankYouBody: "We've received your details and will be in touch shortly.",
      thankYouUrl: "",
      calendlyUrl: "",
      videoUrl: "",
    },
    fields: [
      {
        id: "name",
        name: "name",
        label: "Your name",
        kind: "text",
        required: true,
        placeholder: "Jane Doe",
      },
      {
        id: "email",
        name: "email",
        label: "Email",
        kind: "email",
        required: true,
        placeholder: "you@example.com",
      },
    ],
    qualifier: {
      scoreThreshold: 0,
      saveUnqualified: true,
    },
    crmDatabaseId: null,
    honeypotField: "company_url",
    createdAt: now,
    updatedAt: now,
  };
}

export function newFormFromTemplate(
  businessId: string,
  templateId: string,
  baseName: string,
): QualifierFormConfig {
  const tpl = FORM_TEMPLATES.find((t) => t.id === templateId);
  const seed = defaultForm(businessId);
  const name = baseName || tpl?.name || seed.name;
  // Derive a fresh slug from the chosen name — `seed.slug` is the
  // generic "form" placeholder which would otherwise stick.
  const slug = slugify(name);
  if (!tpl) return upsertForm({ ...seed, name, slug });
  return upsertForm({
    ...seed,
    name,
    slug,
    tag: tpl.tag,
    layout: tpl.layout,
    style: { ...seed.style, ...tpl.style, templateId },
    content: { ...seed.content, ...tpl.content },
    fields: tpl.fields.map((f, i) => ({ ...f, id: f.name || `field_${i}` })),
    qualifier: { ...seed.qualifier, ...tpl.qualifier },
  });
}

// ── Templates ─────────────────────────────────────────────────

export interface FormTemplate {
  id: string;
  name: string;
  /** Marketing badge shown on the template picker card. */
  badge: string;
  tag: string;
  /** Short one-line description shown in the picker. */
  tagline: string;
  /** Funnel category (e.g. "High-ticket", "Low-ticket"). */
  category: "high-ticket" | "low-ticket" | "discovery" | "support" | "newsletter";
  layout: FormLayout;
  /** Visual swatch (CSS gradient) for the picker card. */
  swatch: string;
  /** Style preset — merged into the form's StyleConfig.style. */
  style: Partial<FormStyle>;
  /** Copy preset — merged into FormContent. */
  content: Partial<FormContent>;
  /** Field shape (id is auto-derived from name). */
  fields: Omit<FormField, "id">[];
  /** Default qualifier rules. */
  qualifier: Partial<FormQualifier>;
}

export interface FormTheme {
  id: string;
  name: string;
  tagline: string;
  category: "premium" | "minimal" | "bold" | "glass" | "editorial" | "playful" | "dark" | "luxury";
  thumbnailGradient: string;
  recommendedFor: FormLayout[];
  style: FormStyle;
}

export const FORM_TEMPLATES: FormTemplate[] = [
  {
    id: "high-ticket-mentorship",
    name: "High-ticket mentorship application",
    badge: "👑 High-ticket",
    tag: "High-ticket mentorship",
    tagline:
      "Long-form application with revenue / budget / commitment screening for $5k–$50k coaching offers.",
    category: "high-ticket",
    layout: "multi-step",
    swatch: "linear-gradient(135deg, #1a0b2e 0%, #3a1c71 50%, #d76d77 100%)",
    style: {
      templateId: "high-ticket-mentorship",
      primaryColor: "#d4a574",
      bgColor: "#0c0816",
      textColor: "#f5e9d0",
      cardColor: "#1a0f2a",
      accentColor: "#d76d77",
      fontStack: "'Playfair Display', Georgia, serif",
      radius: 8,
      darkHero: true,
    },
    content: {
      eyebrow: "Application — limited cohort",
      headline: "Apply for 1:1 mentorship",
      subheadline:
        "Tell us where you are now and where you want to be. We screen every application — only serious applicants advance to a strategy call.",
      bullets: [
        "Personalised 1:1 strategy sessions",
        "Private community of 7-figure operators",
        "Direct line to me and the senior team",
      ],
      cta: "Submit application",
      thankYouHeadline: "Application received",
      thankYouBody:
        "If your goals match the program we'll be in touch within 48 hours to schedule your strategy call.",
    },
    fields: [
      { name: "name", label: "Full name", kind: "text", required: true, step: 1 },
      { name: "email", label: "Email", kind: "email", required: true, step: 1 },
      {
        name: "phone",
        label: "Phone (WhatsApp preferred)",
        kind: "phone",
        required: true,
        step: 1,
      },
      {
        name: "current_revenue",
        label: "Current monthly revenue",
        kind: "select",
        required: true,
        step: 2,
        options: [
          { label: "Pre-revenue", value: "0", score: 0 },
          { label: "$1k – $5k / mo", value: "1k-5k", score: 1 },
          { label: "$5k – $20k / mo", value: "5k-20k", score: 3 },
          { label: "$20k – $50k / mo", value: "20k-50k", score: 5 },
          { label: "$50k+ / mo", value: "50k+", score: 7 },
        ],
      },
      {
        name: "budget",
        label: "Investment budget",
        kind: "select",
        required: true,
        step: 2,
        options: [
          { label: "Under $1k", value: "<1k", score: 0 },
          { label: "$1k – $5k", value: "1k-5k", score: 1 },
          { label: "$5k – $15k", value: "5k-15k", score: 3 },
          { label: "$15k – $30k", value: "15k-30k", score: 5 },
          { label: "$30k+", value: "30k+", score: 7 },
        ],
      },
      {
        name: "timeline",
        label: "When would you start?",
        kind: "select",
        required: true,
        step: 2,
        options: [
          { label: "This week", value: "this-week", score: 3 },
          { label: "Within 30 days", value: "30-days", score: 2 },
          { label: "Within 90 days", value: "90-days", score: 1 },
          { label: "Just researching", value: "researching", score: 0 },
        ],
      },
      {
        name: "frustration",
        label: "What's stopping you right now?",
        kind: "textarea",
        required: true,
        step: 3,
        placeholder: "Be specific — what's actually broken?",
      },
      {
        name: "wish",
        label: "12 months from now — what does success look like?",
        kind: "textarea",
        required: true,
        step: 3,
      },
      {
        name: "commitment",
        label: "How committed are you (1-5)?",
        kind: "rating",
        min: 1,
        max: 5,
        required: true,
        step: 3,
      },
      {
        name: "agree_terms",
        label: "I understand applications are screened and not all are accepted.",
        kind: "consent",
        required: true,
        step: 3,
      },
    ],
    qualifier: { scoreThreshold: 12, saveUnqualified: true },
  },
  {
    id: "discovery-call",
    name: "Discovery call booking",
    badge: "📅 Discovery",
    tag: "Discovery call",
    tagline:
      "Lighter triage form gating a Calendly booking — qualifies on budget + timeline before showing the calendar.",
    category: "discovery",
    layout: "single-column",
    swatch: "linear-gradient(135deg, #0f172a 0%, #1e3a8a 100%)",
    style: {
      templateId: "discovery-call",
      primaryColor: "#3b82f6",
      bgColor: "#0f172a",
      textColor: "#f1f5f9",
      cardColor: "#1e293b",
      accentColor: "#06b6d4",
      fontStack: "Inter, system-ui, sans-serif",
      radius: 10,
      darkHero: false,
    },
    content: {
      eyebrow: "Free strategy call",
      headline: "Book your discovery call",
      subheadline:
        "A 30-minute conversation — we'll map your current bottleneck and lay out the fastest path forward.",
      bullets: [
        "No pitch — strategy first",
        "30 minutes, video or phone",
        "Limited slots each week",
      ],
      cta: "See available times",
    },
    fields: [
      { name: "name", label: "Full name", kind: "text", required: true },
      { name: "email", label: "Email", kind: "email", required: true },
      { name: "company", label: "Company", kind: "text" },
      {
        name: "budget",
        label: "Project budget",
        kind: "select",
        required: true,
        options: [
          { label: "< $500", value: "<500", score: 0 },
          { label: "$500 – $2k", value: "500-2k", score: 1 },
          { label: "$2k – $10k", value: "2k-10k", score: 3 },
          { label: "$10k+", value: "10k+", score: 5 },
        ],
      },
      {
        name: "timeline",
        label: "Ideal start date",
        kind: "select",
        required: true,
        options: [
          { label: "ASAP", value: "asap", score: 3 },
          { label: "1-4 weeks", value: "1-4w", score: 2 },
          { label: "1-3 months", value: "1-3m", score: 1 },
          { label: "Exploring", value: "exploring", score: 0 },
        ],
      },
      {
        name: "notes",
        label: "What do you want to talk about?",
        kind: "textarea",
        placeholder: "One or two sentences is plenty.",
      },
    ],
    qualifier: { scoreThreshold: 4, saveUnqualified: true },
  },
  {
    id: "newsletter-optin",
    name: "Newsletter opt-in",
    badge: "✉️ Newsletter",
    tag: "Newsletter",
    tagline:
      "Single-field name+email opt-in optimized for conversion — minimal friction lead magnet capture.",
    category: "newsletter",
    layout: "single-column",
    swatch: "linear-gradient(135deg, #fffbeb 0%, #fef3c7 100%)",
    style: {
      templateId: "newsletter-optin",
      primaryColor: "#f59e0b",
      bgColor: "#fffbeb",
      textColor: "#111827",
      cardColor: "#ffffff",
      accentColor: "#d97706",
      fontStack: "ui-serif, Georgia, 'Times New Roman', serif",
      radius: 14,
      darkHero: false,
    },
    content: {
      eyebrow: "Free weekly insights",
      headline: "Operator's Letter",
      subheadline:
        "One email each Sunday — what's actually moving the needle in service businesses, no filler.",
      bullets: [],
      cta: "Subscribe",
      thankYouHeadline: "You're in.",
      thankYouBody: "Check your inbox for the welcome note.",
    },
    fields: [
      { name: "name", label: "First name", kind: "text", required: true, placeholder: "Jane" },
      {
        name: "email",
        label: "Email",
        kind: "email",
        required: true,
        placeholder: "you@example.com",
      },
      {
        name: "agree_terms",
        label: "I agree to receive weekly emails (no spam, unsubscribe anytime).",
        kind: "consent",
        required: true,
      },
    ],
    qualifier: { scoreThreshold: 0, saveUnqualified: true },
  },
  {
    id: "service-quote",
    name: "Service quote request",
    badge: "💼 Service",
    tag: "Service quote",
    tagline:
      "Project-style intake with services multi-select + budget + timeline — fits agency and freelance offers.",
    category: "low-ticket",
    layout: "two-column",
    swatch: "linear-gradient(135deg, #064e3b 0%, #10b981 100%)",
    style: {
      templateId: "service-quote",
      primaryColor: "#10b981",
      bgColor: "#022c22",
      textColor: "#ecfdf5",
      cardColor: "#064e3b",
      accentColor: "#34d399",
      fontStack: "Inter, system-ui, sans-serif",
      radius: 10,
      darkHero: true,
    },
    content: {
      eyebrow: "Quote request",
      headline: "Get a project quote",
      subheadline:
        "Tell us about the work and we'll send a fixed scope + price within one business day.",
      bullets: [],
      cta: "Request quote",
    },
    fields: [
      { name: "name", label: "Your name", kind: "text", required: true },
      { name: "email", label: "Email", kind: "email", required: true },
      { name: "company", label: "Company", kind: "text" },
      { name: "website", label: "Website", kind: "url" },
      {
        name: "solution_fit",
        label: "Services needed",
        kind: "checkbox-group",
        required: true,
        options: [
          { label: "Website / landing pages", value: "website", score: 1 },
          { label: "CRM setup", value: "crm", score: 1 },
          { label: "Email funnels", value: "email", score: 1 },
          { label: "Paid ads", value: "ads", score: 2 },
          { label: "Branding / design", value: "branding", score: 1 },
          { label: "AI agents / automation", value: "ai", score: 2 },
        ],
      },
      {
        name: "budget",
        label: "Project budget",
        kind: "number",
        required: true,
        placeholder: "1500",
        min: 0,
      },
      {
        name: "timeline",
        label: "Timeline",
        kind: "select",
        required: true,
        options: [
          { label: "Rush (under 1 week)", value: "rush", score: 3 },
          { label: "Standard (2-4 weeks)", value: "standard", score: 2 },
          { label: "Flexible", value: "flexible", score: 1 },
        ],
      },
      {
        name: "frustration",
        label: "What's the pain point you're solving?",
        kind: "textarea",
        span: 12,
      },
    ],
    qualifier: { scoreThreshold: 3, saveUnqualified: true },
  },
  {
    id: "long-form-sales",
    name: "Long-form sales letter",
    badge: "📜 Sales",
    tag: "Long-form sales",
    tagline:
      "Hero + bullets + testimonials + video embed + qualifying form — for high-intent traffic.",
    category: "high-ticket",
    layout: "long-form",
    swatch: "linear-gradient(135deg, #18181b 0%, #27272a 100%)",
    style: {
      templateId: "long-form-sales",
      primaryColor: "#fbbf24",
      bgColor: "#0c0a09",
      textColor: "#fafaf9",
      cardColor: "#1c1917",
      accentColor: "#f97316",
      fontStack: "'Inter', system-ui, sans-serif",
      radius: 6,
      darkHero: true,
    },
    content: {
      eyebrow: "Watch the 8-min demo",
      headline: "Stop guessing — get the playbook that actually works",
      subheadline:
        "The exact system we use to take service businesses from $5k/mo to $50k/mo without ads, hiring, or working more hours.",
      bullets: [
        "Repeatable lead generation in 14 days",
        "$10k+ offer stack that converts cold traffic",
        "Done-with-you ops + AI automation",
      ],
      testimonials: [
        {
          quote: "Went from $7k months grinding alone to $34k months with a tight team in 90 days.",
          author: "M. Reyes",
          role: "Founder, Reyes Studio",
        },
        {
          quote: "Finally a system that doesn't fall apart the moment I stop pushing.",
          author: "K. Tran",
          role: "Coach",
        },
      ],
      cta: "Apply now",
    },
    fields: [
      { name: "name", label: "Your name", kind: "text", required: true },
      { name: "email", label: "Email", kind: "email", required: true },
      { name: "phone", label: "Phone", kind: "phone", required: true },
      {
        name: "current_revenue",
        label: "Current monthly revenue",
        kind: "select",
        required: true,
        options: [
          { label: "Under $5k", value: "<5k", score: 0 },
          { label: "$5k – $20k", value: "5k-20k", score: 2 },
          { label: "$20k+", value: "20k+", score: 4 },
        ],
      },
      {
        name: "budget",
        label: "Investment budget",
        kind: "select",
        required: true,
        options: [
          { label: "Under $1k", value: "<1k", score: 0 },
          { label: "$1k – $10k", value: "1k-10k", score: 2 },
          { label: "$10k+", value: "10k+", score: 4 },
        ],
      },
    ],
    qualifier: { scoreThreshold: 6, saveUnqualified: true },
  },
  {
    id: "support-intake",
    name: "Support intake",
    badge: "🛟 Support",
    tag: "Support",
    tagline:
      "Categorised support form — issue category + severity + screenshot URL — for triage routing.",
    category: "support",
    layout: "single-column",
    swatch: "linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%)",
    style: {
      templateId: "support-intake",
      primaryColor: "#3b82f6",
      bgColor: "#0f172a",
      textColor: "#e2e8f0",
      cardColor: "#1e293b",
      accentColor: "#60a5fa",
      fontStack: "Inter, system-ui, sans-serif",
      radius: 10,
      darkHero: false,
    },
    content: {
      eyebrow: "Help & support",
      headline: "Open a support ticket",
      subheadline: "We respond within 4 business hours.",
      cta: "Open ticket",
      thankYouHeadline: "Ticket received",
      thankYouBody: "We'll reply to the email you provided within 4 business hours.",
    },
    fields: [
      { name: "name", label: "Your name", kind: "text", required: true },
      { name: "email", label: "Email", kind: "email", required: true },
      {
        name: "category",
        label: "Category",
        kind: "radio",
        required: true,
        options: [
          { label: "Billing", value: "billing" },
          { label: "Technical issue", value: "tech" },
          { label: "Feature request", value: "feature" },
          { label: "Other", value: "other" },
        ],
      },
      {
        name: "severity",
        label: "How urgent?",
        kind: "rating",
        min: 1,
        max: 5,
      },
      { name: "frustration", label: "Describe the issue", kind: "textarea", required: true },
      { name: "screenshot_url", label: "Screenshot / loom URL", kind: "url" },
    ],
    qualifier: { scoreThreshold: 0, saveUnqualified: true },
  },
];

export const FORM_THEMES: FormTheme[] = [
  {
    id: "obsidian-lux",
    name: "Obsidian Lux",
    tagline: "Black & gold — luxury serif with dramatic depth",
    category: "luxury",
    thumbnailGradient: "linear-gradient(135deg, #1c1408 0%, #3d2b06 50%, #c9a227 100%)",
    recommendedFor: ["multi-step", "step-by-step", "long-form"],
    style: {
      templateId: "obsidian-lux",
      themeId: "obsidian-lux",
      primaryColor: "#c9a227",
      bgColor: "#0a0907",
      textColor: "#f0e8d0",
      cardColor: "rgba(20,15,5,0.92)",
      accentColor: "#8b6914",
      fontStack: "Georgia, 'Times New Roman', serif",
      headingFontStack: "'Playfair Display', Georgia, 'Times New Roman', serif",
      radius: 6,
      darkHero: true,
      logoUrl: null,
      logoPosition: "center-top",
      logoMaxWidth: 140,
      bgImageUrl: null,
      customCss: "",
      buttonStyle: "gradient",
      surfaceStyle: "glass",
      shadowLevel: 3,
      accentGradient: { from: "#c9a227", to: "#8b6914", angle: 135 },
      inputStyle: "glass",
      density: "spacious",
      motionLevel: "subtle",
    },
  },
  {
    id: "aurora-glass",
    name: "Aurora Glass",
    tagline: "Translucent indigo / cyan — soft glow, premium glass",
    category: "glass",
    thumbnailGradient: "linear-gradient(135deg, #0d0721 0%, #2d1b69 50%, #06b6d4 100%)",
    recommendedFor: ["step-by-step", "single-column"],
    style: {
      templateId: "aurora-glass",
      themeId: "aurora-glass",
      primaryColor: "#8b5cf6",
      bgColor: "#0d0721",
      textColor: "#e8e0ff",
      cardColor: "rgba(139,92,246,0.08)",
      accentColor: "#06b6d4",
      fontStack: "Inter, system-ui, sans-serif",
      headingFontStack: "Inter, system-ui, sans-serif",
      radius: 16,
      darkHero: true,
      logoUrl: null,
      logoPosition: "center-top",
      logoMaxWidth: 140,
      bgImageUrl: null,
      customCss: "",
      buttonStyle: "glass",
      surfaceStyle: "glass",
      shadowLevel: 2,
      accentGradient: { from: "#8b5cf6", to: "#06b6d4", angle: 135 },
      inputStyle: "glass",
      density: "comfortable",
      motionLevel: "full",
    },
  },
  {
    id: "editorial-print",
    name: "Editorial Print",
    tagline: "Cream & ink — hairline borders, serif, zero shadow",
    category: "editorial",
    thumbnailGradient: "linear-gradient(135deg, #f5f0e8 0%, #ede5d8 100%)",
    recommendedFor: ["long-form", "single-column"],
    style: {
      templateId: "editorial-print",
      themeId: "editorial-print",
      primaryColor: "#1a1410",
      bgColor: "#f5f0e8",
      textColor: "#1a1410",
      cardColor: "#ffffff",
      accentColor: "#8b7355",
      fontStack: "'Merriweather', Georgia, 'Times New Roman', serif",
      headingFontStack: "'Playfair Display', Georgia, 'Times New Roman', serif",
      radius: 2,
      darkHero: false,
      logoUrl: null,
      logoPosition: "top-left",
      logoMaxWidth: 120,
      bgImageUrl: null,
      customCss: "",
      buttonStyle: "outline",
      surfaceStyle: "flat",
      shadowLevel: 0,
      accentGradient: null,
      inputStyle: "underline",
      density: "spacious",
      motionLevel: "off",
    },
  },
  {
    id: "neon-noir",
    name: "Neon Noir",
    tagline: "Near-black with electric magenta & purple neon glow",
    category: "bold",
    thumbnailGradient: "linear-gradient(135deg, #050508 0%, #1a0a2e 50%, #f72585 100%)",
    recommendedFor: ["multi-step", "single-column"],
    style: {
      templateId: "neon-noir",
      themeId: "neon-noir",
      primaryColor: "#f72585",
      bgColor: "#050508",
      textColor: "#f0f0f8",
      cardColor: "#0d0d14",
      accentColor: "#7209b7",
      fontStack: "Inter, system-ui, sans-serif",
      headingFontStack: "Inter, system-ui, sans-serif",
      radius: 8,
      darkHero: true,
      logoUrl: null,
      logoPosition: "center-top",
      logoMaxWidth: 140,
      bgImageUrl: null,
      customCss: "",
      buttonStyle: "neon",
      surfaceStyle: "raised",
      shadowLevel: 2,
      accentGradient: { from: "#f72585", to: "#7209b7", angle: 135 },
      inputStyle: "outline",
      density: "comfortable",
      motionLevel: "full",
    },
  },
  {
    id: "minimal-mono",
    name: "Minimal Mono",
    tagline: "Pure white, single accent — business clean, no noise",
    category: "minimal",
    thumbnailGradient: "linear-gradient(135deg, #fafafa 0%, #f0f0f0 100%)",
    recommendedFor: ["single-column", "two-column"],
    style: {
      templateId: "minimal-mono",
      themeId: "minimal-mono",
      primaryColor: "#111111",
      bgColor: "#fafafa",
      textColor: "#111111",
      cardColor: "#ffffff",
      accentColor: "#555555",
      fontStack: "Inter, system-ui, -apple-system, sans-serif",
      headingFontStack: "Inter, system-ui, -apple-system, sans-serif",
      radius: 4,
      darkHero: false,
      logoUrl: null,
      logoPosition: "top-left",
      logoMaxWidth: 120,
      bgImageUrl: null,
      customCss: "",
      buttonStyle: "solid",
      surfaceStyle: "flat",
      shadowLevel: 0,
      accentGradient: null,
      inputStyle: "outline",
      density: "comfortable",
      motionLevel: "off",
    },
  },
  {
    id: "soft-sunrise",
    name: "Soft Sunrise",
    tagline: "Warm orange gradient, generous radius, friendly energy",
    category: "playful",
    thumbnailGradient: "linear-gradient(135deg, #fff8f0 0%, #fed7aa 60%, #f97316 100%)",
    recommendedFor: ["single-column", "step-by-step"],
    style: {
      templateId: "soft-sunrise",
      themeId: "soft-sunrise",
      primaryColor: "#f97316",
      bgColor: "#fff8f0",
      textColor: "#3d1f00",
      cardColor: "#ffffff",
      accentColor: "#fb923c",
      fontStack: "Inter, system-ui, sans-serif",
      headingFontStack: "'Plus Jakarta Sans', Inter, system-ui, sans-serif",
      radius: 20,
      darkHero: false,
      logoUrl: null,
      logoPosition: "center-top",
      logoMaxWidth: 140,
      bgImageUrl: null,
      customCss: "",
      buttonStyle: "gradient",
      surfaceStyle: "raised",
      shadowLevel: 1,
      accentGradient: { from: "#f97316", to: "#fbbf24", angle: 135 },
      inputStyle: "filled",
      density: "comfortable",
      motionLevel: "subtle",
    },
  },
  {
    id: "terminal-phosphor",
    name: "Terminal Phosphor",
    tagline: "Black screen, phosphor green, monospace — hacker chic",
    category: "bold",
    thumbnailGradient: "linear-gradient(135deg, #020402 0%, #041204 50%, #00ff41 100%)",
    recommendedFor: ["single-column", "multi-step"],
    style: {
      templateId: "terminal-phosphor",
      themeId: "terminal-phosphor",
      primaryColor: "#00ff41",
      bgColor: "#020402",
      textColor: "#00ff41",
      cardColor: "#050a05",
      accentColor: "#39ff14",
      fontStack: "'JetBrains Mono', 'Courier New', monospace",
      headingFontStack: "'JetBrains Mono', 'Courier New', monospace",
      radius: 0,
      darkHero: true,
      logoUrl: null,
      logoPosition: "top-left",
      logoMaxWidth: 120,
      bgImageUrl: null,
      customCss: "",
      buttonStyle: "neon",
      surfaceStyle: "flat",
      shadowLevel: 1,
      accentGradient: null,
      inputStyle: "underline",
      density: "compact",
      motionLevel: "off",
    },
  },
  {
    id: "cosmic-deep",
    name: "Cosmic Deep",
    tagline: "Deep navy, teal accents, noise texture — premium dark",
    category: "dark",
    thumbnailGradient: "linear-gradient(135deg, #020c1b 0%, #0a1628 50%, #64ffda 100%)",
    recommendedFor: ["multi-step", "long-form"],
    style: {
      templateId: "cosmic-deep",
      themeId: "cosmic-deep",
      primaryColor: "#64ffda",
      bgColor: "#020c1b",
      textColor: "#ccd6f6",
      cardColor: "rgba(2,12,27,0.85)",
      accentColor: "#8892b0",
      fontStack: "Inter, system-ui, sans-serif",
      headingFontStack: "'Raleway', Inter, system-ui, sans-serif",
      radius: 4,
      darkHero: true,
      logoUrl: null,
      logoPosition: "center-top",
      logoMaxWidth: 140,
      bgImageUrl: null,
      customCss: "",
      buttonStyle: "outline",
      surfaceStyle: "noise",
      shadowLevel: 2,
      accentGradient: { from: "#64ffda", to: "#0a8b8b", angle: 135 },
      inputStyle: "filled",
      density: "spacious",
      motionLevel: "subtle",
    },
  },
  {
    id: "boutique-studio",
    name: "Boutique Studio",
    tagline: "Muted earth tones, Cormorant serif, airy spacing",
    category: "editorial",
    thumbnailGradient: "linear-gradient(135deg, #f4ede4 0%, #e8d5c4 50%, #8b4513 100%)",
    recommendedFor: ["long-form", "single-column"],
    style: {
      templateId: "boutique-studio",
      themeId: "boutique-studio",
      primaryColor: "#8b4513",
      bgColor: "#f4ede4",
      textColor: "#2c1810",
      cardColor: "#fdf8f3",
      accentColor: "#d2691e",
      fontStack: "'Cormorant Garamond', Georgia, 'Times New Roman', serif",
      headingFontStack: "'Cormorant Garamond', Georgia, 'Times New Roman', serif",
      radius: 2,
      darkHero: false,
      logoUrl: null,
      logoPosition: "top-left",
      logoMaxWidth: 120,
      bgImageUrl: null,
      customCss: "",
      buttonStyle: "solid",
      surfaceStyle: "flat",
      shadowLevel: 0,
      accentGradient: null,
      inputStyle: "underline",
      density: "spacious",
      motionLevel: "off",
    },
  },
  {
    id: "pristine-white",
    name: "Pristine White",
    tagline: "Pure flat white, single brand accent — business-clean",
    category: "minimal",
    thumbnailGradient: "linear-gradient(135deg, #ffffff 0%, #f8fafc 50%, #3b82f6 100%)",
    recommendedFor: ["single-column", "two-column"],
    style: {
      templateId: "pristine-white",
      themeId: "pristine-white",
      primaryColor: "#3b82f6",
      bgColor: "#ffffff",
      textColor: "#0f172a",
      cardColor: "#f8fafc",
      accentColor: "#2563eb",
      fontStack: "Inter, system-ui, -apple-system, sans-serif",
      headingFontStack: "Inter, system-ui, -apple-system, sans-serif",
      radius: 8,
      darkHero: false,
      logoUrl: null,
      logoPosition: "top-left",
      logoMaxWidth: 120,
      bgImageUrl: null,
      customCss: "",
      buttonStyle: "solid",
      surfaceStyle: "flat",
      shadowLevel: 1,
      accentGradient: null,
      inputStyle: "outline",
      density: "comfortable",
      motionLevel: "subtle",
    },
  },
  {
    id: "vault-glass",
    name: "Vault Glass",
    tagline: "Frosted glass panels, purple accent ring, premium feel",
    category: "premium",
    thumbnailGradient: "linear-gradient(135deg, #1a1a2e 0%, #2d2060 50%, #c084fc 100%)",
    recommendedFor: ["step-by-step", "multi-step", "single-column"],
    style: {
      templateId: "vault-glass",
      themeId: "vault-glass",
      primaryColor: "#c084fc",
      bgColor: "#1a1a2e",
      textColor: "#e2e2f0",
      cardColor: "rgba(192,132,252,0.07)",
      accentColor: "#818cf8",
      fontStack: "Inter, system-ui, sans-serif",
      headingFontStack: "'DM Sans', Inter, system-ui, sans-serif",
      radius: 14,
      darkHero: true,
      logoUrl: null,
      logoPosition: "center-top",
      logoMaxWidth: 140,
      bgImageUrl: null,
      customCss: "",
      buttonStyle: "glass",
      surfaceStyle: "glass",
      shadowLevel: 2,
      accentGradient: { from: "#c084fc", to: "#818cf8", angle: 135 },
      inputStyle: "glass",
      density: "comfortable",
      motionLevel: "subtle",
    },
  },
  {
    id: "hyper-gradient",
    name: "Hyper Gradient",
    tagline: "Vibrant gradient bg, extreme radius, bold buttons — loud",
    category: "playful",
    thumbnailGradient: "linear-gradient(135deg, #0f0a2e 0%, #4361ee 50%, #f72585 100%)",
    recommendedFor: ["single-column", "step-by-step"],
    style: {
      templateId: "hyper-gradient",
      themeId: "hyper-gradient",
      primaryColor: "#f72585",
      bgColor: "#0f0a2e",
      textColor: "#ffffff",
      cardColor: "rgba(255,255,255,0.05)",
      accentColor: "#4361ee",
      fontStack: "Inter, system-ui, sans-serif",
      headingFontStack: "Inter, system-ui, sans-serif",
      radius: 24,
      darkHero: true,
      logoUrl: null,
      logoPosition: "center-top",
      logoMaxWidth: 140,
      bgImageUrl: null,
      customCss: "",
      buttonStyle: "gradient",
      surfaceStyle: "gradient",
      shadowLevel: 2,
      accentGradient: { from: "#f72585", to: "#4361ee", angle: 135 },
      inputStyle: "glass",
      density: "comfortable",
      motionLevel: "full",
    },
  },
];

/** Sweep dormant analytics files to keep state dir tidy. */
export function pruneOldAnalytics(maxAgeMs = 1000 * 60 * 60 * 24 * 30): number {
  const dir = formsDir();
  if (!existsSync(dir)) return 0;
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const entry of readdirSync(dir)) {
    if (!entry.startsWith("analytics-")) continue;
    const full = join(dir, entry);
    try {
      const stat = readFileSync(full, "utf-8");
      const lines = stat.split(/\r?\n/).filter((l) => l.trim());
      const last = lines[lines.length - 1];
      const lastTs = last ? (JSON.parse(last) as FormAnalyticsEvent).ts : 0;
      if (lastTs && lastTs < cutoff) {
        writeFileSync(full, "", "utf-8");
        removed++;
      }
    } catch {
      /* ignore */
    }
  }
  return removed;
}
