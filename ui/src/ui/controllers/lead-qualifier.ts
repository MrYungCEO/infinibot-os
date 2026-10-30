/**
 * Lead Qualifier — webhook-driven inbound lead pipeline with configurable
 * qualification criteria and a sequential action runner. Mirrors the n8n
 * workflow shape (Webhook → Classifier → branch → CRM page / proposal /
 * notify) but exposes it as an editable per-business UI flow that hooks
 * into the existing CRM database (clients controller) and Kanban project
 * system.
 *
 * The UI is the source of truth for the configuration; the gateway side
 * (`leads.qualifier.*`) runs the actual webhook. When the gateway
 * endpoints aren't available yet the controller persists everything to
 * localStorage so the page is fully functional offline — the user can
 * design their pipeline before the backend lands.
 */
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";

// ── Types ────────────────────────────────────────────────────────────────

export type CriterionField =
  /** Numeric — used for budget/min-amount thresholds. */
  | "budget"
  /** String fields off the webhook payload. */
  | "industry"
  | "timeline"
  | "name"
  | "email"
  | "phone"
  | "frustration"
  | "wish"
  | "tried"
  | "business_snapshot"
  /** Array fields — services/solution_fit. */
  | "solution_fit"
  /** A custom JSONPath into the body, written by the user. */
  | "custom";

export type CriterionOp =
  | "gte" | "lte" | "gt" | "lt" | "eq" | "neq"
  | "contains" | "not_contains"
  | "exists" | "not_exists"
  | "in" | "not_in"
  | "regex";

export interface Criterion {
  id: string;
  field: CriterionField;
  /** When `field === "custom"` this is a dotted path like `body.budget`. Otherwise unused. */
  customPath?: string;
  op: CriterionOp;
  /** Comparison value as a string — coerced to number for numeric ops, split by comma for in/not_in. */
  value: string;
  /** Human-readable label shown in the criterion editor. */
  label?: string;
}

export type ActionStepKind =
  | "save-to-crm"
  | "notify-telegram"
  | "send-email"
  | "ai-proposal"
  | "respond-webhook"
  | "link-to-project"
  | "branch-on-criteria"
  | "tag-lead";

export interface ActionStep {
  id: string;
  kind: ActionStepKind;
  /** Custom display label for the step in the canvas. */
  label?: string;
  /** Whether this step runs only when the lead qualified (true) or only when unqualified (false). null = both. */
  branch: "qualified" | "unqualified" | null;
  /** Step-specific configuration — shape depends on `kind`. */
  config: Record<string, unknown>;
}

/** Built-in style templates for AI-generated proposal HTML. */
export interface StyleTemplate {
  id: string;
  name: string;
  description: string;
  /**
   * The CSS the AI agent should compose its HTML against. Sent through to
   * the AI prompt as the styling envelope.
   */
  css: string;
  /** Sample HTML preview used in the picker thumbnail. */
  preview: string;
  /** Theme palette this template targets — purely informational. */
  palette: "gradient-purple" | "clean-mono" | "cyber-hud";
}

export interface QualifierConfig {
  /** Stable id; matches one business profile (so the page is per-business). */
  businessId: string;
  /** User-facing name. */
  name: string;
  /** True if the qualifier is wired and accepting webhook traffic. */
  enabled: boolean;
  /**
   * Path on the gateway the webhook is mounted at. Read-only from the UI —
   * generated server-side, surfaced here so the user can copy it into
   * their form / external system.
   */
  webhookPath: string;
  /** Optional shared secret the user can require in the request header. */
  webhookSecret: string;
  /**
   * AND/OR combinator across `criteria`. AND = lead must satisfy every
   * criterion to qualify. OR = at least one match.
   */
  criteriaMode: "all" | "any";
  criteria: Criterion[];
  /** Sequential action stack run after qualification. */
  actions: ActionStep[];
  /** Selected style template id from STYLE_TEMPLATES. */
  styleTemplateId: string;
  /**
   * Kanban project a qualified lead is auto-attached to (creates a task in
   * the configured "Inbox" / first-column when null status). Empty string
   * = not linked.
   */
  linkedProjectId: string;
  /**
   * Notion CRM database to save qualified leads into. Defaults to the
   * active business profile's `crmDatabaseId` so it inherits whatever the
   * Clients tab is using; overridable here.
   */
  crmDatabaseId: string;
  /** Maintenance metadata. */
  createdAt: number;
  updatedAt: number;
}

export type QualifierResult = "qualified" | "unqualified" | "error";

export interface QualifierRunRecord {
  id: string;
  receivedAt: number;
  result: QualifierResult;
  /** Snapshot of the inbound payload (truncated for the log). */
  payloadPreview: string;
  /** Reason — which criterion matched, or which action errored. */
  note: string;
  /** When the action stack finished (or failed). */
  completedAt: number | null;
}

export interface LeadQualifierState {
  loading: boolean;
  saving: boolean;
  error: string | null;
  success: string | null;
  /** Qualifier configs keyed by businessId. The active one is selected via state.businessState.activeBusinessId. */
  configs: Record<string, QualifierConfig>;
  /** Recent webhook hits for the active business. */
  runs: QualifierRunRecord[];
  /** UI: which step's inline editor is expanded. */
  expandedStepId: string | null;
  /** UI: which template is currently being previewed. */
  previewTemplateId: string | null;
  /** UI: dragging step id (for the action stack DnD). */
  dragStepId: string | null;
  dragOverIndex: number | null;
  /** Set true once we've attempted to load from the gateway. */
  loaded: boolean;
  /** UI: project-picker modal open + search query. */
  projectPickerOpen: boolean;
  projectPickerQuery: string;
  /** UI: business-picker modal open + search query + inline-create name. */
  businessPickerOpen: boolean;
  businessPickerQuery: string;
  businessPickerCreateName: string;
}

// ── Style templates ─────────────────────────────────────────────────────

export const STYLE_TEMPLATES: StyleTemplate[] = [
  {
    id: "kingly-gradient",
    name: "Gradient Hero",
    description: "Bold purple gradient hero card — dark background, white type, glowing CTA.",
    palette: "gradient-purple",
    preview: "linear-gradient(135deg, #0f0c29, #302b63, #24243e)",
    css: `body {
  background: linear-gradient(135deg, #0f0c29, #302b63, #24243e);
  font-family: 'Segoe UI', sans-serif;
  color: #fff;
  margin: 0;
  padding: 0;
}
.container {
  max-width: 600px; margin: auto;
  background: #1c1c1c; border-radius: 10px; overflow: hidden;
  box-shadow: 0 0 15px rgba(0,0,0,0.4);
}
.header {
  padding: 30px 20px;
  background: linear-gradient(to right, #6a11cb, #2575fc);
  text-align: center;
}
.header h1 { margin: 0; font-size: 24px; color: #fff; }
.section { padding: 20px; }
.section h2 { font-size: 18px; margin-bottom: 10px; color: #b987ff; }
.section p { margin: 5px 0; line-height: 1.6; font-size: 15px; }
.btn-container { text-align: center; padding: 30px 20px; }
.btn {
  display: inline-block;
  background: #8e2de2; color: white;
  padding: 14px 28px; border-radius: 30px;
  text-decoration: none; font-weight: bold;
  box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  transition: background 0.3s ease;
}
.btn:hover { background: #5f00ba; }`,
  },
  {
    id: "clean-mono",
    name: "Clean Mono",
    description: "Minimal black-on-white quote layout — looks like a clean professional services proposal. Best for legal / consulting / agency.",
    palette: "clean-mono",
    preview: "linear-gradient(135deg, #ffffff, #f3f3f3)",
    css: `body {
  background: #fff;
  font-family: 'Segoe UI', sans-serif;
  color: #000; margin: 0; padding: 0;
}
.container {
  max-width: 600px; margin: auto;
  background: #fff; border: 1px solid #000;
  border-radius: 6px; padding: 20px;
}
.header {
  text-align: center;
  border-bottom: 1px solid #000;
  padding-bottom: 20px; margin-bottom: 20px;
}
.header h1 { margin: 0; font-size: 24px; color: #000; }
.section { margin-bottom: 20px; }
.section h2 {
  font-size: 18px; margin-bottom: 10px; color: #000;
  border-bottom: 1px solid #000; padding-bottom: 5px;
}
.section p { margin: 5px 0; line-height: 1.6; font-size: 15px; }
.btn-container { text-align: center; margin-top: 30px; }
.btn {
  display: inline-block;
  background: #000; color: #fff;
  padding: 10px 20px; border-radius: 4px;
  text-decoration: none; font-weight: bold;
  transition: background 0.3s ease;
}
.btn:hover { background: #333; }`,
  },
  {
    id: "cyber-hud",
    name: "Cyberpunk HUD",
    description: "Terminal-tinted glass cards with scanline accents. Pulls from the active theme — adapts to whichever palette the user has set.",
    palette: "cyber-hud",
    preview: "linear-gradient(135deg, #0b0820, color-mix(in srgb, var(--g-primary) 18%, #060406))",
    css: `body {
  background:
    radial-gradient(ellipse 80% 60% at 50% 0%, color-mix(in srgb, #fbbf24 8%, transparent), transparent 60%),
    #060406;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  color: #f5eacd; margin: 0; padding: 24px;
}
.container {
  max-width: 620px; margin: auto;
  background: rgba(13, 10, 4, 0.7);
  border: 1px solid color-mix(in srgb, #fbbf24 22%, transparent);
  border-radius: 14px; padding: 24px;
  backdrop-filter: blur(14px) saturate(140%);
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.6);
}
.header {
  margin-bottom: 18px; padding-bottom: 12px;
  border-bottom: 1px dashed color-mix(in srgb, #fbbf24 18%, transparent);
}
.header h1 {
  margin: 0; font-size: 20px; letter-spacing: 0.04em;
  color: #fbbf24; text-shadow: 0 0 12px color-mix(in srgb, #fbbf24 35%, transparent);
}
.section { margin-bottom: 16px; }
.section h2 {
  font-size: 11px; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase;
  color: #c9b880; margin-bottom: 6px;
}
.section p { margin: 4px 0; line-height: 1.55; font-size: 13px; color: #e8d8a4; }
.btn-container { text-align: center; margin-top: 24px; }
.btn {
  display: inline-block;
  background: linear-gradient(135deg, #fbbf24, #f59e0b);
  color: #0a0700; padding: 10px 24px; border-radius: 6px;
  text-decoration: none; font-weight: 800; letter-spacing: 0.06em;
  text-transform: uppercase; font-size: 11px;
  box-shadow: 0 0 18px color-mix(in srgb, #fbbf24 40%, transparent);
}
.btn:hover { box-shadow: 0 0 28px color-mix(in srgb, #fbbf24 60%, transparent); }`,
  },
];

// ── Defaults ─────────────────────────────────────────────────────────────

let _idCounter = 0;
function newId(prefix: string): string {
  _idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${_idCounter}`;
}

/**
 * Default action stack mirrors the n8n workflow shape: save to CRM →
 * notify telegram → AI proposal (only on qualified) → respond to webhook.
 * Users can reorder, drop, or add more.
 */
function defaultActions(): ActionStep[] {
  return [
    {
      id: newId("act"),
      kind: "save-to-crm",
      label: "Save to CRM",
      branch: "qualified",
      config: {
        statusValue: "Lead",
        titleField: "name",
      },
    },
    {
      id: newId("act"),
      kind: "notify-telegram",
      label: "Notify Telegram",
      branch: null,
      config: {
        chatId: "",
        template:
          "🔥 New lead: {{ name }}\n💸 Budget: {{ budget }}\n⏱️ Timeline: {{ timeline }}\n✅ Services: {{ solution_fit }}",
      },
    },
    {
      id: newId("act"),
      kind: "ai-proposal",
      label: "AI proposal",
      branch: "qualified",
      config: {
        model: "google/gemini-pro",
        instructions:
          "Generate a personalized service proposal for the lead. Pull pain from {{ frustration }}, vision from {{ wish }}, and recommend services from {{ solution_fit }}. End with a Calendly CTA.",
      },
    },
    {
      id: newId("act"),
      kind: "send-email",
      label: "Send proposal email",
      branch: "qualified",
      config: {
        to: "{{ email }}",
        subject: "{{ business }} — service quote",
        useTemplate: true,
      },
    },
    {
      id: newId("act"),
      kind: "link-to-project",
      label: "Add to workspace project",
      branch: "qualified",
      config: {
        columnStatus: "todo",
      },
    },
    {
      id: newId("act"),
      kind: "respond-webhook",
      label: "Reply to webhook (unqualified)",
      branch: "unqualified",
      config: {
        json: {
          output:
            "👋 Thanks for your interest! Your budget falls below our custom-build minimum. Our self-service templates may be a better fit.",
        },
      },
    },
  ];
}

function defaultCriteria(): Criterion[] {
  return [
    {
      id: newId("crit"),
      field: "budget",
      op: "gte",
      value: "100",
      label: "Budget ≥ $100",
    },
  ];
}

export function defaultQualifierConfig(businessId: string, businessName?: string): QualifierConfig {
  const now = Date.now();
  return {
    businessId,
    name: businessName ? `${businessName} qualifier` : "Lead qualifier",
    enabled: false,
    webhookPath: "",
    webhookSecret: "",
    criteriaMode: "all",
    criteria: defaultCriteria(),
    actions: defaultActions(),
    styleTemplateId: STYLE_TEMPLATES[0].id,
    linkedProjectId: "",
    crmDatabaseId: "",
    createdAt: now,
    updatedAt: now,
  };
}

export function createInitialLeadQualifierState(): LeadQualifierState {
  return {
    loading: false,
    saving: false,
    error: null,
    success: null,
    configs: {},
    runs: [],
    expandedStepId: null,
    previewTemplateId: null,
    dragStepId: null,
    dragOverIndex: null,
    loaded: false,
    projectPickerOpen: false,
    projectPickerQuery: "",
    businessPickerOpen: false,
    businessPickerQuery: "",
    businessPickerCreateName: "",
  };
}

// ── Persistence ──────────────────────────────────────────────────────────

const STORAGE_KEY = "infinibot.lead-qualifier.configs.v1";

function readLocal(): Record<string, QualifierConfig> {
  try {
    if (typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeLocal(configs: Record<string, QualifierConfig>): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(configs));
  } catch {
    /* ignore quota */
  }
}

// ── Public API ───────────────────────────────────────────────────────────

export function activeQualifierConfig(state: AppViewState): QualifierConfig | null {
  const lq = state.leadQualifierState;
  const businessId = state.businessState?.activeBusinessId ?? null;
  if (!lq || !businessId) return null;
  return lq.configs[businessId] ?? null;
}

/** Ensure a config exists for the active business, seeding from defaults if not. */
export function ensureActiveConfig(state: AppViewState): QualifierConfig | null {
  const lq = state.leadQualifierState;
  const bs = state.businessState;
  if (!lq || !bs?.activeBusinessId) return null;
  const existing = lq.configs[bs.activeBusinessId];
  if (existing) return existing;
  const profile = bs.businesses.find((b) => b.id === bs.activeBusinessId);
  const seed = defaultQualifierConfig(bs.activeBusinessId, profile?.name);
  // Inherit the business's CRM database if connected so the qualifier
  // points at the same DB the Clients tab is using by default.
  if (profile?.crmDatabaseId) seed.crmDatabaseId = profile.crmDatabaseId;
  lq.configs[bs.activeBusinessId] = seed;
  writeLocal(lq.configs);
  return seed;
}

export async function loadLeadQualifier(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const lq = state.leadQualifierState;
  if (!lq) return;
  lq.loading = true;
  lq.error = null;
  state.requestUpdate?.();

  // Make sure the active-business chip + picker have data to render even
  // when the user lands here without first visiting the Business tab.
  // The tab-activation hook in app-settings.ts does this too, but doing it
  // here as well covers re-renders / cold mounts where the hook may not
  // have fired (e.g. router restored from URL, deep link from notification).
  try {
    if (!state.businessState || (state.businessState.businesses ?? []).length === 0) {
      const businessMod = await import("./business.js");
      if (!state.businessState) {
        state.businessState = businessMod.createInitialBusinessState();
      }
      await businessMod.loadBusiness(state, client);
    }
  } catch (e) {
    console.warn("[lead-qualifier] business load failed:", e);
  }

  try {
    let remote: Record<string, QualifierConfig> | null = null;
    try {
      const res = (await client.request("leads.qualifier.list", {})) as {
        configs?: Record<string, QualifierConfig>;
      } | null;
      if (res && res.configs && typeof res.configs === "object") remote = res.configs;
    } catch {
      /* gateway endpoint not available — fall through to local */
    }
    lq.configs = remote ?? readLocal();
    lq.loaded = true;
  } catch (e) {
    lq.error = (e as Error)?.message ?? String(e);
  } finally {
    lq.loading = false;
    state.requestUpdate?.();
  }
}

export async function saveActiveConfig(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const lq = state.leadQualifierState;
  if (!lq) return;
  const config = activeQualifierConfig(state);
  if (!config) return;
  config.updatedAt = Date.now();
  lq.saving = true;
  lq.error = null;
  state.requestUpdate?.();
  try {
    try {
      await client.request("leads.qualifier.upsert", { config });
    } catch {
      // Gateway not ready — keep going, the local copy is always written.
    }
    writeLocal(lq.configs);
    lq.success = "Saved";
    state.requestUpdate?.();
    setTimeout(() => {
      if (lq.success === "Saved") {
        lq.success = null;
        state.requestUpdate?.();
      }
    }, 1800);
  } catch (e) {
    lq.error = (e as Error)?.message ?? String(e);
  } finally {
    lq.saving = false;
    state.requestUpdate?.();
  }
}

export function patchActiveConfig(state: AppViewState, patch: Partial<QualifierConfig>): void {
  const cfg = activeQualifierConfig(state);
  if (!cfg) return;
  Object.assign(cfg, patch, { updatedAt: Date.now() });
  state.requestUpdate?.();
}

// ── Criterion editing ───────────────────────────────────────────────────

export function addCriterion(state: AppViewState, partial?: Partial<Criterion>): void {
  const cfg = activeQualifierConfig(state);
  if (!cfg) return;
  cfg.criteria.push({
    id: newId("crit"),
    field: partial?.field ?? "budget",
    op: partial?.op ?? "gte",
    value: partial?.value ?? "100",
    label: partial?.label,
    customPath: partial?.customPath,
  });
  cfg.updatedAt = Date.now();
  state.requestUpdate?.();
}

export function updateCriterion(state: AppViewState, id: string, patch: Partial<Criterion>): void {
  const cfg = activeQualifierConfig(state);
  if (!cfg) return;
  const idx = cfg.criteria.findIndex((c) => c.id === id);
  if (idx < 0) return;
  cfg.criteria[idx] = { ...cfg.criteria[idx], ...patch };
  cfg.updatedAt = Date.now();
  state.requestUpdate?.();
}

export function removeCriterion(state: AppViewState, id: string): void {
  const cfg = activeQualifierConfig(state);
  if (!cfg) return;
  cfg.criteria = cfg.criteria.filter((c) => c.id !== id);
  cfg.updatedAt = Date.now();
  state.requestUpdate?.();
}

// ── Action stack editing ────────────────────────────────────────────────

export function addAction(state: AppViewState, kind: ActionStepKind): void {
  const cfg = activeQualifierConfig(state);
  if (!cfg) return;
  cfg.actions.push({
    id: newId("act"),
    kind,
    label: defaultLabelForKind(kind),
    branch: kind === "respond-webhook" ? "unqualified" : null,
    config: defaultConfigForKind(kind),
  });
  cfg.updatedAt = Date.now();
  state.requestUpdate?.();
}

export function updateAction(state: AppViewState, id: string, patch: Partial<ActionStep>): void {
  const cfg = activeQualifierConfig(state);
  if (!cfg) return;
  const idx = cfg.actions.findIndex((a) => a.id === id);
  if (idx < 0) return;
  cfg.actions[idx] = { ...cfg.actions[idx], ...patch };
  cfg.updatedAt = Date.now();
  state.requestUpdate?.();
}

export function removeAction(state: AppViewState, id: string): void {
  const cfg = activeQualifierConfig(state);
  if (!cfg) return;
  cfg.actions = cfg.actions.filter((a) => a.id !== id);
  cfg.updatedAt = Date.now();
  state.requestUpdate?.();
}

export function reorderActions(state: AppViewState, draggedId: string, targetIndex: number): void {
  const cfg = activeQualifierConfig(state);
  if (!cfg) return;
  const fromIdx = cfg.actions.findIndex((a) => a.id === draggedId);
  if (fromIdx < 0) return;
  const [moved] = cfg.actions.splice(fromIdx, 1);
  // Recompute target idx after splice (if moving down, the original
  // target index now refers to the wrong slot).
  const adjustedTarget = targetIndex > fromIdx ? targetIndex - 1 : targetIndex;
  cfg.actions.splice(Math.max(0, Math.min(cfg.actions.length, adjustedTarget)), 0, moved);
  cfg.updatedAt = Date.now();
  state.requestUpdate?.();
}

// ── Helpers shown in the action picker ──────────────────────────────────

export const ACTION_KIND_LABELS: Record<ActionStepKind, string> = {
  "save-to-crm": "Save to CRM",
  "notify-telegram": "Notify Telegram",
  "send-email": "Send email",
  "ai-proposal": "AI proposal",
  "respond-webhook": "Respond to webhook",
  "link-to-project": "Link to project",
  "branch-on-criteria": "Branch on criteria",
  "tag-lead": "Tag lead",
};

export const ACTION_KIND_ICONS: Record<ActionStepKind, string> = {
  "save-to-crm": "🗂",
  "notify-telegram": "✈",
  "send-email": "✉",
  "ai-proposal": "✦",
  "respond-webhook": "↩",
  "link-to-project": "📁",
  "branch-on-criteria": "⎇",
  "tag-lead": "🏷",
};

function defaultLabelForKind(kind: ActionStepKind): string {
  return ACTION_KIND_LABELS[kind] ?? kind;
}

function defaultConfigForKind(kind: ActionStepKind): Record<string, unknown> {
  switch (kind) {
    case "save-to-crm":
      return { statusValue: "Lead", titleField: "name" };
    case "notify-telegram":
      return { chatId: "", template: "🔥 New lead: {{ name }}" };
    case "send-email":
      return { to: "{{ email }}", subject: "Following up", useTemplate: true };
    case "ai-proposal":
      return { model: "google/gemini-pro", instructions: "" };
    case "respond-webhook":
      return { json: { ok: true, message: "Thanks — we'll be in touch." } };
    case "link-to-project":
      return { columnStatus: "todo" };
    case "branch-on-criteria":
      return { criteriaIds: [] };
    case "tag-lead":
      return { tags: [] };
  }
}

// ── Qualification logic (client-side preview / dry-run) ─────────────────

function readPath(obj: any, path: string): unknown {
  if (!path) return undefined;
  return path.split(".").reduce((acc, key) => (acc != null ? acc[key] : undefined), obj);
}

function readField(payload: Record<string, any>, c: Criterion): unknown {
  if (c.field === "custom") return readPath(payload, c.customPath ?? "");
  // Most fields live under body.<name> per the n8n template — try that first,
  // falling back to a direct top-level lookup so users posting a flat body
  // still work.
  const fromBody = payload?.body?.[c.field];
  return fromBody !== undefined ? fromBody : payload?.[c.field];
}

function compareNumeric(a: unknown, b: string, op: CriterionOp): boolean | null {
  const an = typeof a === "number" ? a : parseFloat(String(a ?? ""));
  const bn = parseFloat(b);
  if (!Number.isFinite(an) || !Number.isFinite(bn)) return null;
  switch (op) {
    case "gte": return an >= bn;
    case "lte": return an <= bn;
    case "gt": return an > bn;
    case "lt": return an < bn;
    case "eq": return an === bn;
    case "neq": return an !== bn;
    default: return null;
  }
}

export function evaluateCriterion(c: Criterion, payload: Record<string, any>): boolean {
  const value = readField(payload, c);
  if (c.op === "exists") return value !== undefined && value !== null && value !== "";
  if (c.op === "not_exists") return value === undefined || value === null || value === "";
  if (c.op === "in" || c.op === "not_in") {
    const list = c.value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const haystack = Array.isArray(value)
      ? value.map((v) => String(v).toLowerCase())
      : [String(value ?? "").toLowerCase()];
    const some = list.some((needle) => haystack.includes(needle));
    return c.op === "in" ? some : !some;
  }
  if (c.op === "regex") {
    try {
      const re = new RegExp(c.value);
      return re.test(String(value ?? ""));
    } catch {
      return false;
    }
  }
  if (c.op === "contains" || c.op === "not_contains") {
    const haystack = Array.isArray(value)
      ? value.map((v) => String(v).toLowerCase()).join(" ")
      : String(value ?? "").toLowerCase();
    const needle = c.value.toLowerCase();
    const has = haystack.includes(needle);
    return c.op === "contains" ? has : !has;
  }
  // Numeric comparisons
  const numeric = compareNumeric(value, c.value, c.op);
  if (numeric !== null) return numeric;
  // Fallback string equality
  if (c.op === "eq") return String(value ?? "") === c.value;
  if (c.op === "neq") return String(value ?? "") !== c.value;
  return false;
}

export function evaluateQualification(
  config: QualifierConfig,
  payload: Record<string, any>,
): { qualified: boolean; matched: string[]; failed: string[] } {
  const matched: string[] = [];
  const failed: string[] = [];
  for (const c of config.criteria) {
    if (evaluateCriterion(c, payload)) matched.push(c.id);
    else failed.push(c.id);
  }
  const qualified =
    config.criteriaMode === "all"
      ? failed.length === 0 && matched.length === config.criteria.length
      : matched.length > 0;
  return { qualified, matched, failed };
}

/** Append a synthetic test run to the recent-runs list. */
export function recordRun(state: AppViewState, record: Omit<QualifierRunRecord, "id">): void {
  const lq = state.leadQualifierState;
  if (!lq) return;
  lq.runs = [
    { id: newId("run"), ...record },
    ...lq.runs,
  ].slice(0, 50);
  state.requestUpdate?.();
}

/**
 * Run a sample payload through the qualifier locally so the user can verify
 * their criteria + branch routing without firing the live action stack.
 */
export function dryRun(state: AppViewState, payload: Record<string, any>): QualifierRunRecord {
  const cfg = activeQualifierConfig(state);
  if (!cfg) {
    return {
      id: newId("run"),
      receivedAt: Date.now(),
      completedAt: Date.now(),
      result: "error",
      payloadPreview: "(no active qualifier)",
      note: "No qualifier config for the active business.",
    };
  }
  const evalRes = evaluateQualification(cfg, payload);
  const qualified = evalRes.qualified;
  const note = qualified
    ? `Qualified — ${evalRes.matched.length}/${cfg.criteria.length} criteria matched (${cfg.criteriaMode})`
    : `Unqualified — only ${evalRes.matched.length}/${cfg.criteria.length} matched (${cfg.criteriaMode})`;
  const record: QualifierRunRecord = {
    id: newId("run"),
    receivedAt: Date.now(),
    completedAt: Date.now(),
    result: qualified ? "qualified" : "unqualified",
    payloadPreview: JSON.stringify(payload).slice(0, 200),
    note,
  };
  recordRun(state, record);
  return record;
}

// ── Quick-start presets ─────────────────────────────────────────────────

export interface QualifierPreset {
  id: string;
  name: string;
  tagline: string;
  /** Marketing tag — emoji + 2-word descriptor shown on the picker card. */
  badge: string;
  criteriaMode: "all" | "any";
  criteria: Omit<Criterion, "id">[];
  actions: Omit<ActionStep, "id">[];
}

/**
 * Three starter pipelines covering the most common shapes — picked from
 * the empty state so a brand-new business gets a working qualifier in
 * one click. The shapes mirror common patterns: capture → notify (lowest
 * friction), full sales triage with proposal email (the n8n flow shipped
 * with this codebase), and a support-style routing pipeline.
 */
export const QUALIFIER_PRESETS: QualifierPreset[] = [
  {
    id: "lead-capture",
    name: "Lead capture",
    tagline: "Capture inbound, save to CRM, ping you in Telegram.",
    badge: "🪝 Capture",
    criteriaMode: "all",
    criteria: [
      { field: "email", op: "exists", value: "", label: "Email present" },
    ],
    actions: [
      { kind: "save-to-crm", label: "Save to CRM", branch: null,
        config: { statusValue: "Lead", titleField: "name" } },
      { kind: "notify-telegram", label: "Notify Telegram", branch: null,
        config: { chatId: "", template: "🪝 New lead: {{ name }} · {{ email }}\n💼 {{ business_snapshot }}" } },
      { kind: "respond-webhook", label: "Reply to caller", branch: null,
        config: { json: { ok: true, message: "Thanks — we'll be in touch within 24h." } } },
    ],
  },
  {
    id: "sales-triage",
    name: "Sales triage",
    tagline: "Budget gate, AI-generated proposal email, project card on qualified.",
    badge: "✦ Sales",
    criteriaMode: "all",
    criteria: [
      { field: "budget", op: "gte", value: "100", label: "Budget ≥ $100" },
      { field: "email", op: "exists", value: "", label: "Email present" },
    ],
    actions: [
      { kind: "save-to-crm", label: "Save to CRM", branch: "qualified",
        config: { statusValue: "Lead", titleField: "name" } },
      { kind: "notify-telegram", label: "Notify Telegram", branch: null,
        config: { chatId: "", template: "🔥 New lead: {{ name }}\n💸 {{ budget }} · ⏱ {{ timeline }}\n✅ {{ solution_fit }}" } },
      { kind: "ai-proposal", label: "AI proposal", branch: "qualified",
        config: {
          model: "google/gemini-pro",
          instructions:
            "Generate a personalized service proposal for {{ name }} at {{ business_snapshot }}. Pull pain from {{ frustration }}, vision from {{ wish }}. Recommend services from {{ solution_fit }}. End with a Calendly CTA.",
        } },
      { kind: "send-email", label: "Send proposal email", branch: "qualified",
        config: { to: "{{ email }}", subject: "{{ business_snapshot }} — service quote", useTemplate: true } },
      { kind: "link-to-project", label: "Add to workspace project", branch: "qualified",
        config: { columnStatus: "todo" } },
      { kind: "respond-webhook", label: "Decline (under budget)", branch: "unqualified",
        config: { json: { output: "Thanks for the interest! Your budget falls below our build minimum — our self-service templates may be a better fit." } } },
    ],
  },
  {
    id: "support-intake",
    name: "Support intake",
    tagline: "Triage by frustration keyword, route to project, auto-tag.",
    badge: "🛟 Support",
    criteriaMode: "any",
    criteria: [
      { field: "frustration", op: "exists", value: "", label: "Issue described" },
    ],
    actions: [
      { kind: "save-to-crm", label: "Save to CRM as Ticket", branch: null,
        config: { statusValue: "Open", titleField: "name" } },
      { kind: "tag-lead", label: "Tag as support", branch: null, config: { tags: ["support", "inbound"] } },
      { kind: "link-to-project", label: "Add to triage project", branch: null,
        config: { columnStatus: "todo" } },
      { kind: "notify-telegram", label: "Ping support channel", branch: null,
        config: { chatId: "", template: "🛟 Support: {{ name }}\n{{ frustration }}\n📞 {{ phone }} · ✉ {{ email }}" } },
      { kind: "respond-webhook", label: "Acknowledge", branch: null,
        config: { json: { ok: true, message: "We received your request — a teammate will reply shortly." } } },
    ],
  },
];

/** Apply a preset to the active config (replaces criteria + actions in place). */
export function applyPreset(state: AppViewState, presetId: string): void {
  const cfg = activeQualifierConfig(state);
  if (!cfg) return;
  const preset = QUALIFIER_PRESETS.find((p) => p.id === presetId);
  if (!preset) return;
  cfg.criteriaMode = preset.criteriaMode;
  cfg.criteria = preset.criteria.map((c) => ({ ...c, id: newId("crit") }));
  cfg.actions = preset.actions.map((a) => ({ ...a, id: newId("act") }));
  cfg.updatedAt = Date.now();
  state.requestUpdate?.();
}

// ── Diagnostics ─────────────────────────────────────────────────────────

export interface ConfigWarning {
  level: "warn" | "info";
  message: string;
}

/**
 * Surface inline warnings about config issues — missing actions, an
 * ai-proposal step with no follow-up email, criteria configured but no
 * branches, etc. Renders as a banner above the editor.
 */
export function configWarnings(cfg: QualifierConfig | null): ConfigWarning[] {
  if (!cfg) return [];
  const out: ConfigWarning[] = [];
  if (cfg.actions.length === 0) {
    out.push({ level: "warn", message: "No actions configured — the webhook will fire but nothing will happen." });
    return out;
  }
  if (cfg.criteria.length === 0) {
    out.push({ level: "info", message: "No criteria — every webhook hit is treated as qualified." });
  }
  const hasAi = cfg.actions.some((a) => a.kind === "ai-proposal");
  const hasEmail = cfg.actions.some((a) => a.kind === "send-email");
  if (hasAi && !hasEmail) {
    out.push({ level: "info", message: "AI proposal step has no Send-email step downstream — the generated body won't be delivered." });
  }
  const hasSave = cfg.actions.some((a) => a.kind === "save-to-crm");
  if (!hasSave && cfg.actions.length > 0) {
    out.push({ level: "info", message: "No Save-to-CRM step — leads won't be persisted to your Notion database." });
  }
  if (cfg.actions.some((a) => a.kind === "link-to-project") && !cfg.linkedProjectId) {
    out.push({ level: "warn", message: "A Link-to-project step exists but no project is selected on the right." });
  }
  if (cfg.actions.some((a) => a.kind === "save-to-crm") && !cfg.crmDatabaseId) {
    out.push({ level: "warn", message: "A Save-to-CRM step exists but no CRM database is connected for this business." });
  }
  if (cfg.enabled && !cfg.webhookPath) {
    out.push({ level: "info", message: "Pipeline marked Active but the gateway hasn't minted a webhook URL yet — save to provision one." });
  }
  return out;
}

// ── Token rendering (preview) ──────────────────────────────────────────

const TOKEN_RE = /\{\{\s*([\w._]+)\s*\}\}/g;

/** Replace `{{ token }}` placeholders with values from the (optionally nested) payload. Used for live previews. */
export function renderTokens(template: string, payload: Record<string, any>): string {
  if (!template) return "";
  return template.replace(TOKEN_RE, (_match, path) => {
    // Try both `body.<path>` and direct `<path>` so users can write either.
    const direct = readTokenPath(payload, path);
    if (direct !== undefined) return formatTokenValue(direct);
    const fromBody = readTokenPath(payload?.body ?? {}, path);
    return formatTokenValue(fromBody);
  });
}

function readTokenPath(obj: any, path: string): unknown {
  if (!obj || !path) return undefined;
  return path.split(".").reduce((acc: any, key: string) => (acc != null ? acc[key] : undefined), obj);
}

function formatTokenValue(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(String).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Tokens the user can drop into templates. Surfaced in the helper popover. */
export const COMMON_TOKENS: Array<{ token: string; description: string }> = [
  { token: "name", description: "Lead's name" },
  { token: "email", description: "Email address" },
  { token: "phone", description: "Phone number" },
  { token: "budget", description: "Budget amount (string)" },
  { token: "timeline", description: "When they want to start" },
  { token: "frustration", description: "Pain in their words" },
  { token: "wish", description: "Desired outcome" },
  { token: "solution_fit", description: "Services they're after (comma-joined)" },
  { token: "business_snapshot", description: "Short business description" },
  { token: "industry", description: "Industry classification" },
  { token: "tried", description: "What they've tried before" },
];

// ── Webhook test ping (real call when gateway is reachable) ─────────────

export async function pingWebhook(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<QualifierRunRecord> {
  const cfg = activeQualifierConfig(state);
  if (!cfg) {
    return {
      id: newId("run"),
      receivedAt: Date.now(),
      completedAt: Date.now(),
      result: "error",
      payloadPreview: "",
      note: "No active qualifier to ping.",
    };
  }
  const startedAt = Date.now();
  try {
    const res = await client.request("leads.qualifier.test", {
      businessId: cfg.businessId,
      payload: SAMPLE_PAYLOAD,
    });
    const record: QualifierRunRecord = {
      id: newId("run"),
      receivedAt: startedAt,
      completedAt: Date.now(),
      result: ((res as any)?.qualified ? "qualified" : "unqualified") as QualifierResult,
      payloadPreview: JSON.stringify(SAMPLE_PAYLOAD).slice(0, 200),
      note: (res as any)?.note ?? "Sent via gateway test endpoint.",
    };
    recordRun(state, record);
    return record;
  } catch (e) {
    // Gateway endpoint not yet implemented — fall back to a local dry-run.
    const fallback = dryRun(state, SAMPLE_PAYLOAD);
    fallback.note = `Gateway test endpoint unavailable — ran locally. (${(e as Error)?.message ?? "no detail"})`;
    return fallback;
  }
}

/** Sample webhook body the test runner submits. */
export const SAMPLE_PAYLOAD: Record<string, any> = {
  body: {
    name: "Jane Doe",
    email: "jane@example.com",
    phone: "+1 (555) 555-5555",
    business: "Acme Photography",
    business_snapshot: "Boutique wedding studio in Austin, ~30 weddings/yr.",
    industry: "creative-services",
    frustration: "Lost track of inquiries — bookings drop because I reply 4 days late.",
    wish: "An automated funnel that captures + qualifies and books me only the right couples.",
    timeline: "Within 2 weeks",
    budget: "1500",
    tried: "Tried Calendly + a Google form, but doesn't filter at all.",
    solution_fit: ["AI Lead Capture", "CRM Setup", "Email Funnels"],
  },
};
