/**
 * UI controller for the lead-qualifier form builder.
 *
 * Owns the per-business form catalogue (CRUD + template instantiation),
 * the editor state for the currently-selected form, and the analytics
 * fetch hooks for the KPI dashboard.
 *
 * Storage: gateway-backed via `leads.qualifier.forms.*` RPCs (see
 * `src/gateway/server-methods/lead-qualifier.ts`). Falls back to
 * in-memory state when offline so the UI is still inspectable.
 */
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import { gatewayOrigin } from "../gateway-endpoint";

// ── Types (mirror src/services/qualifier/forms.ts) ────────────

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
  score?: number;
}

export interface FormField {
  id: string;
  name: string;
  label: string;
  kind: FormFieldKind;
  required?: boolean;
  placeholder?: string;
  helpText?: string;
  options?: FormFieldOption[];
  min?: number;
  max?: number;
  defaultValue?: string;
  step?: number;
  pattern?: string;
  span?: number;
}

export type FormLayout =
  | "single-column"
  | "two-column"
  | "multi-step"
  | "step-by-step"
  | "long-form"
  | "card-grid";

export interface FormStyle {
  templateId: string;
  primaryColor: string;
  bgColor: string;
  textColor: string;
  cardColor: string | null;
  accentColor: string;
  fontStack: string;
  radius: number;
  darkHero: boolean;
  logoUrl: string | null;
  /** Where to render the logo on each page. Defaults to "center-top". */
  logoPosition?: "center-top" | "top-left" | "hidden";
  /** Logo max-width in pixels. Defaults to 140. */
  logoMaxWidth?: number;
  bgImageUrl: string | null;
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
  title: string;
  headline: string;
  subheadline: string;
  eyebrow: string;
  bullets: string[];
  testimonials: Array<{ quote: string; author: string; role?: string }>;
  cta: string;
  thankYouHeadline: string;
  thankYouBody: string;
  thankYouUrl: string;
  calendlyUrl: string;
  videoUrl: string;
  /**
   * Per-step content for the step-by-step layout. Index 0 = step 1.
   * Missing entries fall back to the form-level eyebrow/headline/sub.
   */
  stepContent?: Array<{
    eyebrow?: string;
    headline?: string;
    subheadline?: string;
  }>;
}

export interface FormQualifier {
  scoreThreshold: number;
  saveUnqualified: boolean;
}

export interface QualifierFormConfig {
  id: string;
  businessId: string;
  funnelId: string | null;
  qualifierBusinessId: string | null;
  slug: string;
  name: string;
  tag: string;
  published: boolean;
  layout: FormLayout;
  style: FormStyle;
  content: FormContent;
  fields: FormField[];
  qualifier: FormQualifier;
  crmDatabaseId: string | null;
  honeypotField: string;
  createdAt: number;
  updatedAt: number;
}

export interface FormTemplate {
  id: string;
  name: string;
  badge: string;
  tag: string;
  tagline: string;
  category: "high-ticket" | "low-ticket" | "discovery" | "support" | "newsletter";
  layout: FormLayout;
  swatch: string;
  style: Partial<FormStyle>;
  content: Partial<FormContent>;
  fields: Omit<FormField, "id">[];
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

export const FORM_THEMES: FormTheme[] = [
  {
    id: "obsidian-lux",
    name: "Obsidian Lux",
    tagline: "Black & gold — luxury serif with dramatic depth",
    category: "luxury",
    thumbnailGradient: "linear-gradient(135deg, #1c1408 0%, #3d2b06 50%, #c9a227 100%)",
    recommendedFor: ["multi-step", "step-by-step", "long-form"],
    style: {
      templateId: "obsidian-lux", themeId: "obsidian-lux",
      primaryColor: "#c9a227", bgColor: "#0a0907", textColor: "#f0e8d0",
      cardColor: "rgba(20,15,5,0.92)", accentColor: "#8b6914",
      fontStack: "Georgia, 'Times New Roman', serif",
      headingFontStack: "'Playfair Display', Georgia, 'Times New Roman', serif",
      radius: 6, darkHero: true, logoUrl: null, logoPosition: "center-top",
      logoMaxWidth: 140, bgImageUrl: null, customCss: "",
      buttonStyle: "gradient", surfaceStyle: "glass", shadowLevel: 3,
      accentGradient: { from: "#c9a227", to: "#8b6914", angle: 135 },
      inputStyle: "glass", density: "spacious", motionLevel: "subtle",
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
      templateId: "aurora-glass", themeId: "aurora-glass",
      primaryColor: "#8b5cf6", bgColor: "#0d0721", textColor: "#e8e0ff",
      cardColor: "rgba(139,92,246,0.08)", accentColor: "#06b6d4",
      fontStack: "Inter, system-ui, sans-serif",
      headingFontStack: "Inter, system-ui, sans-serif",
      radius: 16, darkHero: true, logoUrl: null, logoPosition: "center-top",
      logoMaxWidth: 140, bgImageUrl: null, customCss: "",
      buttonStyle: "glass", surfaceStyle: "glass", shadowLevel: 2,
      accentGradient: { from: "#8b5cf6", to: "#06b6d4", angle: 135 },
      inputStyle: "glass", density: "comfortable", motionLevel: "full",
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
      templateId: "editorial-print", themeId: "editorial-print",
      primaryColor: "#1a1410", bgColor: "#f5f0e8", textColor: "#1a1410",
      cardColor: "#ffffff", accentColor: "#8b7355",
      fontStack: "'Merriweather', Georgia, 'Times New Roman', serif",
      headingFontStack: "'Playfair Display', Georgia, 'Times New Roman', serif",
      radius: 2, darkHero: false, logoUrl: null, logoPosition: "top-left",
      logoMaxWidth: 120, bgImageUrl: null, customCss: "",
      buttonStyle: "outline", surfaceStyle: "flat", shadowLevel: 0,
      accentGradient: null,
      inputStyle: "underline", density: "spacious", motionLevel: "off",
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
      templateId: "neon-noir", themeId: "neon-noir",
      primaryColor: "#f72585", bgColor: "#050508", textColor: "#f0f0f8",
      cardColor: "#0d0d14", accentColor: "#7209b7",
      fontStack: "Inter, system-ui, sans-serif",
      headingFontStack: "Inter, system-ui, sans-serif",
      radius: 8, darkHero: true, logoUrl: null, logoPosition: "center-top",
      logoMaxWidth: 140, bgImageUrl: null, customCss: "",
      buttonStyle: "neon", surfaceStyle: "raised", shadowLevel: 2,
      accentGradient: { from: "#f72585", to: "#7209b7", angle: 135 },
      inputStyle: "outline", density: "comfortable", motionLevel: "full",
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
      templateId: "minimal-mono", themeId: "minimal-mono",
      primaryColor: "#111111", bgColor: "#fafafa", textColor: "#111111",
      cardColor: "#ffffff", accentColor: "#555555",
      fontStack: "Inter, system-ui, -apple-system, sans-serif",
      headingFontStack: "Inter, system-ui, -apple-system, sans-serif",
      radius: 4, darkHero: false, logoUrl: null, logoPosition: "top-left",
      logoMaxWidth: 120, bgImageUrl: null, customCss: "",
      buttonStyle: "solid", surfaceStyle: "flat", shadowLevel: 0,
      accentGradient: null,
      inputStyle: "outline", density: "comfortable", motionLevel: "off",
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
      templateId: "soft-sunrise", themeId: "soft-sunrise",
      primaryColor: "#f97316", bgColor: "#fff8f0", textColor: "#3d1f00",
      cardColor: "#ffffff", accentColor: "#fb923c",
      fontStack: "Inter, system-ui, sans-serif",
      headingFontStack: "'Plus Jakarta Sans', Inter, system-ui, sans-serif",
      radius: 20, darkHero: false, logoUrl: null, logoPosition: "center-top",
      logoMaxWidth: 140, bgImageUrl: null, customCss: "",
      buttonStyle: "gradient", surfaceStyle: "raised", shadowLevel: 1,
      accentGradient: { from: "#f97316", to: "#fbbf24", angle: 135 },
      inputStyle: "filled", density: "comfortable", motionLevel: "subtle",
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
      templateId: "terminal-phosphor", themeId: "terminal-phosphor",
      primaryColor: "#00ff41", bgColor: "#020402", textColor: "#00ff41",
      cardColor: "#050a05", accentColor: "#39ff14",
      fontStack: "'JetBrains Mono', 'Courier New', monospace",
      headingFontStack: "'JetBrains Mono', 'Courier New', monospace",
      radius: 0, darkHero: true, logoUrl: null, logoPosition: "top-left",
      logoMaxWidth: 120, bgImageUrl: null, customCss: "",
      buttonStyle: "neon", surfaceStyle: "flat", shadowLevel: 1,
      accentGradient: null,
      inputStyle: "underline", density: "compact", motionLevel: "off",
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
      templateId: "cosmic-deep", themeId: "cosmic-deep",
      primaryColor: "#64ffda", bgColor: "#020c1b", textColor: "#ccd6f6",
      cardColor: "rgba(2,12,27,0.85)", accentColor: "#8892b0",
      fontStack: "Inter, system-ui, sans-serif",
      headingFontStack: "'Raleway', Inter, system-ui, sans-serif",
      radius: 4, darkHero: true, logoUrl: null, logoPosition: "center-top",
      logoMaxWidth: 140, bgImageUrl: null, customCss: "",
      buttonStyle: "outline", surfaceStyle: "noise", shadowLevel: 2,
      accentGradient: { from: "#64ffda", to: "#0a8b8b", angle: 135 },
      inputStyle: "filled", density: "spacious", motionLevel: "subtle",
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
      templateId: "boutique-studio", themeId: "boutique-studio",
      primaryColor: "#8b4513", bgColor: "#f4ede4", textColor: "#2c1810",
      cardColor: "#fdf8f3", accentColor: "#d2691e",
      fontStack: "'Cormorant Garamond', Georgia, 'Times New Roman', serif",
      headingFontStack: "'Cormorant Garamond', Georgia, 'Times New Roman', serif",
      radius: 2, darkHero: false, logoUrl: null, logoPosition: "top-left",
      logoMaxWidth: 120, bgImageUrl: null, customCss: "",
      buttonStyle: "solid", surfaceStyle: "flat", shadowLevel: 0,
      accentGradient: null,
      inputStyle: "underline", density: "spacious", motionLevel: "off",
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
      templateId: "pristine-white", themeId: "pristine-white",
      primaryColor: "#3b82f6", bgColor: "#ffffff", textColor: "#0f172a",
      cardColor: "#f8fafc", accentColor: "#2563eb",
      fontStack: "Inter, system-ui, -apple-system, sans-serif",
      headingFontStack: "Inter, system-ui, -apple-system, sans-serif",
      radius: 8, darkHero: false, logoUrl: null, logoPosition: "top-left",
      logoMaxWidth: 120, bgImageUrl: null, customCss: "",
      buttonStyle: "solid", surfaceStyle: "flat", shadowLevel: 1,
      accentGradient: null,
      inputStyle: "outline", density: "comfortable", motionLevel: "subtle",
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
      templateId: "vault-glass", themeId: "vault-glass",
      primaryColor: "#c084fc", bgColor: "#1a1a2e", textColor: "#e2e2f0",
      cardColor: "rgba(192,132,252,0.07)", accentColor: "#818cf8",
      fontStack: "Inter, system-ui, sans-serif",
      headingFontStack: "'DM Sans', Inter, system-ui, sans-serif",
      radius: 14, darkHero: true, logoUrl: null, logoPosition: "center-top",
      logoMaxWidth: 140, bgImageUrl: null, customCss: "",
      buttonStyle: "glass", surfaceStyle: "glass", shadowLevel: 2,
      accentGradient: { from: "#c084fc", to: "#818cf8", angle: 135 },
      inputStyle: "glass", density: "comfortable", motionLevel: "subtle",
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
      templateId: "hyper-gradient", themeId: "hyper-gradient",
      primaryColor: "#f72585", bgColor: "#0f0a2e", textColor: "#ffffff",
      cardColor: "rgba(255,255,255,0.05)", accentColor: "#4361ee",
      fontStack: "Inter, system-ui, sans-serif",
      headingFontStack: "Inter, system-ui, sans-serif",
      radius: 24, darkHero: true, logoUrl: null, logoPosition: "center-top",
      logoMaxWidth: 140, bgImageUrl: null, customCss: "",
      buttonStyle: "gradient", surfaceStyle: "gradient", shadowLevel: 2,
      accentGradient: { from: "#f72585", to: "#4361ee", angle: 135 },
      inputStyle: "glass", density: "comfortable", motionLevel: "full",
    },
  },
];

export interface FormKpiSummary {
  views: number;
  starts: number;
  submits: number;
  qualified: number;
  unqualified: number;
  conversionRate: number;
  qualifiedRate: number;
  fieldAbandonment: Array<{ field: string; count: number }>;
  hourly: Array<{ hour: number; views: number; submits: number }>;
  bySource: Array<{ source: string; views: number; submits: number }>;
  recent: Array<Record<string, unknown>>;
}

export interface FormSubmissionRecord {
  id: string;
  formId: string;
  ts: number;
  payload: Record<string, unknown>;
  qualified: boolean;
  leadId?: string;
  score: number;
  ip?: string;
  userAgent?: string;
  utm?: Record<string, string>;
  rejected?: "honeypot" | "rate_limit" | "validation";
}

// ── Controller state ──────────────────────────────────────────

export interface LeadQualifierFormsState {
  loading: boolean;
  saving: boolean;
  error: string | null;
  /** Form configs keyed by id. */
  forms: Record<string, QualifierFormConfig>;
  templates: FormTemplate[];
  selectedFormId: string | null;
  editorTab: "design" | "fields" | "settings" | "analytics" | "embed";
  /** KPI summary cache per form id. */
  kpi: Record<string, FormKpiSummary>;
  /** Submission cache per form id. */
  submissions: Record<string, FormSubmissionRecord[]>;
  /** Open template picker overlay when true. */
  pickerOpen: boolean;
  /** Currently-previewed field for the field editor panel. */
  editingFieldId: string | null;
  /** Slide-over preview iframe panel toggle. */
  previewOpen: boolean;
  /** Slide-over analytics dashboard toggle. */
  analyticsOpen: boolean;
  /** Form-picker dropdown in the header. */
  formMenuOpen: boolean;
  /** Split-button dropdown next to Publish — exposes Netlify deploy + open URL. */
  publishMenuOpen: boolean;
  /** Set true after first load attempt. */
  loaded: boolean;

  // ── Netlify cloud-deploy ────────────────────────────────
  /** Mirrored from `netlify.status` so the accordion can render without re-fetching. */
  netlifyStatus: {
    configured: boolean;
    user?: { email?: string; full_name?: string } | null;
    apiBaseUrl: string;
    formSites: Record<string, string>;
  } | null;
  netlifyConnectOpen: boolean;
  netlifyConnectBusy: boolean;
  netlifyTokenInput: string;
  netlifyApiBaseUrlInput: string;
  netlifyDeployBusy: Record<string, boolean>;
  netlifyDeployResult: Record<string, { url: string; siteId: string; state: string }>;
  netlifyError: string | null;
  /**
   * Inspector accordion open state for the Cloud deploy · Netlify section.
   * Set true when the user clicks "Connect Netlify…" from the publish menu
   * so the accordion auto-opens and the connect form is visible.
   */
  netlifyAccordionOpen: boolean;
  /** Category filter for the theme gallery ("" = all categories). */
  themeGalleryFilter: string;
}

export function createInitialFormBuilderState(): LeadQualifierFormsState {
  return {
    loading: false,
    saving: false,
    error: null,
    forms: {},
    templates: [],
    selectedFormId: null,
    editorTab: "design",
    kpi: {},
    submissions: {},
    pickerOpen: false,
    editingFieldId: null,
    previewOpen: false,
    analyticsOpen: false,
    formMenuOpen: false,
    publishMenuOpen: false,
    loaded: false,
    netlifyStatus: null,
    netlifyConnectOpen: false,
    netlifyConnectBusy: false,
    netlifyTokenInput: "",
    netlifyApiBaseUrlInput: "",
    netlifyDeployBusy: {},
    netlifyDeployResult: {},
    netlifyError: null,
    netlifyAccordionOpen: false,
    themeGalleryFilter: "",
  };
}

// ── ID helper (deterministic per-tab counter) ─────────────────

let _idCounter = 0;
function newId(prefix: string): string {
  _idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${_idCounter}`;
}

// ── Selectors ─────────────────────────────────────────────────

export function activeForm(state: AppViewState): QualifierFormConfig | null {
  const s = state.leadQualifierFormsState;
  if (!s || !s.selectedFormId) return null;
  return s.forms[s.selectedFormId] ?? null;
}

export function listFormsForActiveBusiness(state: AppViewState): QualifierFormConfig[] {
  const s = state.leadQualifierFormsState;
  const bid = state.businessState?.activeBusinessId ?? null;
  if (!s || !bid) return [];
  return Object.values(s.forms).filter((f) => f.businessId === bid);
}

// ── Async API ─────────────────────────────────────────────────

export async function loadFormBuilder(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const s = state.leadQualifierFormsState;
  if (!s) return;
  s.loading = true;
  s.error = null;
  state.requestUpdate?.();
  try {
    const businessId = state.businessState?.activeBusinessId;
    const [listRes, templatesRes] = await Promise.all([
      client.request("leads.qualifier.forms.list", businessId ? { businessId } : {}),
      client.request("leads.qualifier.forms.templates", {}),
    ]);
    const forms = ((listRes as { forms?: QualifierFormConfig[] })?.forms ?? []).reduce(
      (acc, f) => {
        acc[f.id] = f;
        return acc;
      },
      {} as Record<string, QualifierFormConfig>,
    );
    s.forms = forms;
    s.templates = ((templatesRes as { templates?: FormTemplate[] })?.templates ?? []) as FormTemplate[];
    if (!s.selectedFormId && Object.keys(forms).length > 0) {
      s.selectedFormId = Object.keys(forms)[0];
    }
    s.loaded = true;
  } catch (e) {
    s.error = (e as Error)?.message ?? String(e);
  } finally {
    s.loading = false;
    state.requestUpdate?.();
  }
}

export async function createFormFromTemplate(
  state: AppViewState,
  client: GatewayBrowserClient,
  templateId: string,
  name?: string,
): Promise<QualifierFormConfig | null> {
  const s = state.leadQualifierFormsState;
  const bid = state.businessState?.activeBusinessId;
  if (!s || !bid) return null;
  s.saving = true;
  s.error = null;
  state.requestUpdate?.();
  try {
    const res = await client.request("leads.qualifier.forms.fromTemplate", {
      businessId: bid,
      templateId,
      name,
    });
    const form = (res as { form?: QualifierFormConfig })?.form;
    if (form) {
      s.forms[form.id] = form;
      s.selectedFormId = form.id;
      s.pickerOpen = false;
    }
    return form ?? null;
  } catch (e) {
    s.error = (e as Error)?.message ?? String(e);
    return null;
  } finally {
    s.saving = false;
    state.requestUpdate?.();
  }
}

export async function saveActiveForm(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const s = state.leadQualifierFormsState;
  const form = activeForm(state);
  if (!s || !form) return;
  s.saving = true;
  s.error = null;
  state.requestUpdate?.();
  try {
    const res = await client.request("leads.qualifier.forms.upsert", { form });
    const saved = (res as { form?: QualifierFormConfig })?.form;
    if (saved) s.forms[saved.id] = saved;
  } catch (e) {
    s.error = (e as Error)?.message ?? String(e);
  } finally {
    s.saving = false;
    state.requestUpdate?.();
  }
}

export async function deleteActiveForm(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const s = state.leadQualifierFormsState;
  const form = activeForm(state);
  if (!s || !form) return;
  if (typeof confirm === "function" && !confirm(`Delete form "${form.name}"? This cannot be undone.`)) {
    return;
  }
  try {
    await client.request("leads.qualifier.forms.delete", { id: form.id });
    delete s.forms[form.id];
    s.selectedFormId = Object.keys(s.forms)[0] ?? null;
    state.requestUpdate?.();
  } catch (e) {
    s.error = (e as Error)?.message ?? String(e);
    state.requestUpdate?.();
  }
}

export async function togglePublish(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const form = activeForm(state);
  if (!form) return;
  const wasPublished = form.published;
  try {
    const res = await client.request("leads.qualifier.forms.publish", {
      id: form.id,
      published: !form.published,
    });
    const updated = (res as { form?: QualifierFormConfig })?.form;
    const s = state.leadQualifierFormsState;
    if (updated && s) s.forms[updated.id] = updated;
    // On the off→on transition, open the public form in a new tab and
    // surface the post-publish menu (URL + Netlify deploy). Off→on only:
    // unpublishing should not pop a window.
    if (!wasPublished && updated?.published && s) {
      s.publishMenuOpen = true;
      const url = publicFormUrl(updated);
      if (url && typeof window !== "undefined") {
        // window.open may be blocked if not triggered by user gesture —
        // it is here (togglePublish runs in a click handler), but fall
        // back gracefully if the popup blocker still kills it.
        try {
          window.open(url, "_blank", "noopener");
        } catch {
          /* ignored — the dropdown still shows the URL + copy button */
        }
      }
      // Prime Netlify status so the menu can render the deploy CTA
      // without waiting on a round-trip when the user opens it.
      if (!s.netlifyStatus) {
        void loadNetlifyStatus(state, client);
      }
    }
    state.requestUpdate?.();
  } catch (e) {
    const s = state.leadQualifierFormsState;
    if (s) s.error = (e as Error)?.message ?? String(e);
    state.requestUpdate?.();
  }
}

export async function loadKpi(
  state: AppViewState,
  client: GatewayBrowserClient,
  formId: string,
): Promise<void> {
  const s = state.leadQualifierFormsState;
  if (!s) return;
  try {
    const [kpiRes, subsRes] = await Promise.all([
      client.request("leads.qualifier.forms.kpi", { id: formId }),
      client.request("leads.qualifier.forms.submissions", { id: formId, limit: 50 }),
    ]);
    const kpi = (kpiRes as { kpi?: FormKpiSummary })?.kpi;
    const submissions =
      (subsRes as { submissions?: FormSubmissionRecord[] })?.submissions ?? [];
    if (kpi) s.kpi[formId] = kpi;
    s.submissions[formId] = submissions;
  } catch (e) {
    s.error = (e as Error)?.message ?? String(e);
  } finally {
    state.requestUpdate?.();
  }
}

// ── Mutators ──────────────────────────────────────────────────

export function patchActiveForm(state: AppViewState, patch: Partial<QualifierFormConfig>): void {
  const form = activeForm(state);
  if (!form) return;
  Object.assign(form, patch, { updatedAt: Date.now() });
  state.requestUpdate?.();
}

export function patchStyle(state: AppViewState, patch: Partial<FormStyle>): void {
  const form = activeForm(state);
  if (!form) return;
  form.style = { ...form.style, ...patch };
  form.updatedAt = Date.now();
  state.requestUpdate?.();
}

export function patchContent(state: AppViewState, patch: Partial<FormContent>): void {
  const form = activeForm(state);
  if (!form) return;
  form.content = { ...form.content, ...patch };
  form.updatedAt = Date.now();
  state.requestUpdate?.();
}

export function patchQualifier(state: AppViewState, patch: Partial<FormQualifier>): void {
  const form = activeForm(state);
  if (!form) return;
  form.qualifier = { ...form.qualifier, ...patch };
  form.updatedAt = Date.now();
  state.requestUpdate?.();
}

export function addField(state: AppViewState, kind: FormFieldKind = "text"): void {
  const form = activeForm(state);
  if (!form) return;
  const id = newId("field");
  const baseName = kind === "email" ? "email" : kind === "phone" ? "phone" : `field_${form.fields.length + 1}`;
  const safeName = ensureUniqueFieldName(form.fields, baseName);
  form.fields.push({
    id,
    name: safeName,
    label: labelForKind(kind),
    kind,
    required: false,
    placeholder: "",
    options:
      kind === "select" || kind === "radio" || kind === "checkbox-group"
        ? [
            { label: "Option A", value: "a", score: 0 },
            { label: "Option B", value: "b", score: 0 },
          ]
        : undefined,
  });
  form.updatedAt = Date.now();
  const s = state.leadQualifierFormsState;
  if (s) s.editingFieldId = id;
  state.requestUpdate?.();
}

export function updateField(state: AppViewState, id: string, patch: Partial<FormField>): void {
  const form = activeForm(state);
  if (!form) return;
  const idx = form.fields.findIndex((f) => f.id === id);
  if (idx < 0) return;
  form.fields[idx] = { ...form.fields[idx], ...patch };
  form.updatedAt = Date.now();
  state.requestUpdate?.();
}

export function removeField(state: AppViewState, id: string): void {
  const form = activeForm(state);
  if (!form) return;
  form.fields = form.fields.filter((f) => f.id !== id);
  form.updatedAt = Date.now();
  const s = state.leadQualifierFormsState;
  if (s && s.editingFieldId === id) s.editingFieldId = null;
  state.requestUpdate?.();
}

export function moveField(state: AppViewState, id: string, delta: number): void {
  const form = activeForm(state);
  if (!form) return;
  const idx = form.fields.findIndex((f) => f.id === id);
  if (idx < 0) return;
  const target = Math.max(0, Math.min(form.fields.length - 1, idx + delta));
  if (target === idx) return;
  const [moved] = form.fields.splice(idx, 1);
  form.fields.splice(target, 0, moved);
  form.updatedAt = Date.now();
  state.requestUpdate?.();
}

/**
 * Insert a freshly-created field of the given kind at a specific index in
 * the active form's `fields[]` array. Used by the drag-and-drop palette
 * when a chip is dropped between existing cards on the canvas.
 *
 * `step` pins the new field to a specific multi-step page. Pass it when
 * dropping into a per-step drop zone (multi-step / step-by-step layouts).
 * The inserted field becomes the new `editingFieldId` so the inspector
 * pops open against it.
 */
export function addFieldAt(
  state: AppViewState,
  kind: FormFieldKind,
  index: number,
  step?: number,
): string | null {
  const form = activeForm(state);
  if (!form) return null;
  const id = newId("field");
  const baseName =
    kind === "email" ? "email" : kind === "phone" ? "phone" : `field_${form.fields.length + 1}`;
  const safeName = ensureUniqueFieldName(form.fields, baseName);
  const field: FormField = {
    id,
    name: safeName,
    label: labelForKind(kind),
    kind,
    required: false,
    placeholder: "",
    options: defaultOptionsFor(kind),
    ...(step && step > 1 ? { step } : {}),
  };
  const clamped = Math.max(0, Math.min(form.fields.length, index));
  form.fields.splice(clamped, 0, field);
  form.updatedAt = Date.now();
  const s = state.leadQualifierFormsState;
  if (s) s.editingFieldId = id;
  state.requestUpdate?.();
  return id;
}

/**
 * Move an existing field to an absolute target index (and optionally
 * re-pin it to a different step). Used by drag-reorder on the canvas
 * and by drag-into-step for multi-step layouts.
 *
 * The target index is interpreted *after* the source field is removed
 * from its current slot — callers should pass the index they want the
 * field to end up at in the post-move array, NOT the slot the drop
 * indicator was painted in. (`computeMoveTargetIndex` in the view
 * handles the bookkeeping.)
 */
export function moveFieldTo(
  state: AppViewState,
  id: string,
  targetIndex: number,
  step?: number,
): void {
  const form = activeForm(state);
  if (!form) return;
  const idx = form.fields.findIndex((f) => f.id === id);
  if (idx < 0) return;
  const [moved] = form.fields.splice(idx, 1);
  if (step !== undefined) {
    if (step > 1) moved.step = step;
    else delete moved.step;
  }
  const clamped = Math.max(0, Math.min(form.fields.length, targetIndex));
  form.fields.splice(clamped, 0, moved);
  form.updatedAt = Date.now();
  state.requestUpdate?.();
}

/**
 * Duplicate a field — same kind/label/options/scoring, fresh id + a
 * `<name>_copy[_N]` unique name. Inserted directly after the source.
 */
export function duplicateField(state: AppViewState, id: string): string | null {
  const form = activeForm(state);
  if (!form) return null;
  const idx = form.fields.findIndex((f) => f.id === id);
  if (idx < 0) return null;
  const src = form.fields[idx];
  const newName = ensureUniqueFieldName(form.fields, `${src.name}_copy`);
  const cloned: FormField = {
    ...src,
    id: newId("field"),
    name: newName,
    options: src.options ? src.options.map((o) => ({ ...o })) : undefined,
  };
  form.fields.splice(idx + 1, 0, cloned);
  form.updatedAt = Date.now();
  const s = state.leadQualifierFormsState;
  if (s) s.editingFieldId = cloned.id;
  state.requestUpdate?.();
  return cloned.id;
}

function defaultOptionsFor(kind: FormFieldKind): FormFieldOption[] | undefined {
  if (kind === "select" || kind === "radio" || kind === "checkbox-group") {
    return [
      { label: "Option A", value: "a", score: 0 },
      { label: "Option B", value: "b", score: 0 },
    ];
  }
  return undefined;
}

export function updateFieldOption(
  state: AppViewState,
  fieldId: string,
  optionIndex: number,
  patch: Partial<FormFieldOption>,
): void {
  const form = activeForm(state);
  if (!form) return;
  const field = form.fields.find((f) => f.id === fieldId);
  if (!field?.options) return;
  field.options[optionIndex] = { ...field.options[optionIndex], ...patch };
  form.updatedAt = Date.now();
  state.requestUpdate?.();
}

export function addFieldOption(state: AppViewState, fieldId: string): void {
  const form = activeForm(state);
  if (!form) return;
  const field = form.fields.find((f) => f.id === fieldId);
  if (!field) return;
  if (!field.options) field.options = [];
  field.options.push({
    label: `Option ${field.options.length + 1}`,
    value: `opt_${field.options.length + 1}`,
    score: 0,
  });
  form.updatedAt = Date.now();
  state.requestUpdate?.();
}

export function removeFieldOption(state: AppViewState, fieldId: string, optionIndex: number): void {
  const form = activeForm(state);
  if (!form) return;
  const field = form.fields.find((f) => f.id === fieldId);
  if (!field?.options) return;
  field.options.splice(optionIndex, 1);
  form.updatedAt = Date.now();
  state.requestUpdate?.();
}

// ── Helpers ───────────────────────────────────────────────────

function ensureUniqueFieldName(existing: FormField[], base: string): string {
  const taken = new Set(existing.map((f) => f.name));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

function labelForKind(kind: FormFieldKind): string {
  switch (kind) {
    case "email": return "Email";
    case "phone": return "Phone";
    case "url": return "Website";
    case "number": return "Number";
    case "textarea": return "Message";
    case "select": return "Pick one";
    case "radio": return "Choose one";
    case "checkbox": return "Confirm";
    case "checkbox-group": return "Select all that apply";
    case "rating": return "Rate (1-5)";
    case "date": return "Date";
    case "consent": return "I agree";
    case "hidden": return "Hidden value";
    default: return "Text";
  }
}

export function fieldKindOptions(): Array<{ kind: FormFieldKind; label: string; icon: string }> {
  return [
    { kind: "text", label: "Short text", icon: "T" },
    { kind: "email", label: "Email", icon: "✉" },
    { kind: "phone", label: "Phone", icon: "☎" },
    { kind: "url", label: "URL", icon: "🔗" },
    { kind: "number", label: "Number", icon: "#" },
    { kind: "textarea", label: "Long text", icon: "¶" },
    { kind: "select", label: "Dropdown", icon: "▾" },
    { kind: "radio", label: "Radio", icon: "◉" },
    { kind: "checkbox-group", label: "Checkboxes", icon: "☑" },
    { kind: "rating", label: "Rating", icon: "★" },
    { kind: "date", label: "Date", icon: "📅" },
    { kind: "consent", label: "Consent", icon: "✓" },
    { kind: "hidden", label: "Hidden", icon: "○" },
  ];
}

export function publicFormUrl(form: QualifierFormConfig | null): string {
  if (!form?.slug) return "";
  const base = typeof window !== "undefined" ? gatewayOrigin() : "";
  return `${base}/f/${form.slug}`;
}

export function embedSnippet(form: QualifierFormConfig | null): string {
  const url = publicFormUrl(form);
  if (!url) return "";
  return `<iframe src="${url}" style="width:100%;min-height:720px;border:0;border-radius:14px" loading="lazy"></iframe>`;
}

// ── Netlify deploy controller ────────────────────────────────────
// Mirrors the gateway's netlify.* RPCs into local state so the form
// builder accordion can render without re-fetching on every keypress.

export async function loadNetlifyStatus(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const s = state.leadQualifierFormsState;
  if (!s) return;
  try {
    const r = (await client.request("netlify.status", {})) as {
      configured: boolean;
      user?: { email?: string; full_name?: string } | null;
      apiBaseUrl?: string;
      formSites?: Record<string, string>;
    };
    s.netlifyStatus = {
      configured: !!r.configured,
      user: r.user ?? null,
      apiBaseUrl: r.apiBaseUrl ?? "",
      formSites: r.formSites ?? {},
    };
    if (!s.netlifyApiBaseUrlInput) s.netlifyApiBaseUrlInput = s.netlifyStatus.apiBaseUrl;
  } catch (e) {
    s.netlifyError = (e as Error)?.message ?? String(e);
  }
  state.requestUpdate?.();
}

export async function connectNetlify(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const s = state.leadQualifierFormsState;
  if (!s) return;
  const accessToken = s.netlifyTokenInput.trim();
  const apiBaseUrl = s.netlifyApiBaseUrlInput.trim();
  if (!accessToken) {
    s.netlifyError = "Personal access token required.";
    state.requestUpdate?.();
    return;
  }
  s.netlifyError = null;
  s.netlifyConnectBusy = true;
  state.requestUpdate?.();
  try {
    await client.request("netlify.connect", { accessToken, apiBaseUrl });
    s.netlifyTokenInput = "";
    s.netlifyConnectOpen = false;
    await loadNetlifyStatus(state, client);
  } catch (e) {
    s.netlifyError = (e as Error)?.message ?? String(e);
  } finally {
    s.netlifyConnectBusy = false;
    state.requestUpdate?.();
  }
}

export async function updateNetlifyApiBaseUrl(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const s = state.leadQualifierFormsState;
  if (!s) return;
  const apiBaseUrl = s.netlifyApiBaseUrlInput.trim();
  if (!apiBaseUrl) return;
  try {
    await client.request("netlify.setApiBaseUrl", { apiBaseUrl });
    await loadNetlifyStatus(state, client);
  } catch (e) {
    s.netlifyError = (e as Error)?.message ?? String(e);
    state.requestUpdate?.();
  }
}

export async function deployFormToNetlify(
  state: AppViewState,
  client: GatewayBrowserClient,
  formId: string,
): Promise<void> {
  const s = state.leadQualifierFormsState;
  if (!s) return;
  s.netlifyDeployBusy = { ...s.netlifyDeployBusy, [formId]: true };
  s.netlifyError = null;
  state.requestUpdate?.();
  try {
    const r = (await client.request("netlify.deploy", {
      id: formId,
      apiBaseUrl: s.netlifyApiBaseUrlInput.trim() || undefined,
    })) as { result?: { url: string; site: { id: string }; state: string } };
    if (r.result) {
      s.netlifyDeployResult = {
        ...s.netlifyDeployResult,
        [formId]: {
          url: r.result.url,
          siteId: r.result.site.id,
          state: r.result.state,
        },
      };
      // Refresh the status so the persisted formSites map is in sync.
      await loadNetlifyStatus(state, client);
    }
  } catch (e) {
    s.netlifyError = (e as Error)?.message ?? String(e);
  } finally {
    s.netlifyDeployBusy = { ...s.netlifyDeployBusy, [formId]: false };
    state.requestUpdate?.();
  }
}
