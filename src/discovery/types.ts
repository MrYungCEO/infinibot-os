/**
 * Discovery Docs — shared types.
 *
 * A "template" is the user-authored recipe: a public form (deployed to
 * Netlify), context pulled from local InfiniBot databases, an AI
 * generation step, and a pipeline of post-actions (PDF / email /
 * Telegram / CRM / Calendly). A "run" is one submission flowing through
 * that recipe.
 *
 * Persisted in `${stateDir}/discovery.db` (SQLite). Netlify holds the
 * live form only; submissions are pulled into our DB on the poll cycle
 * and the run record is the canonical record of what happened.
 */

// ── Input form ────────────────────────────────────────────────

export type InputFieldType =
  | "text"
  | "textarea"
  | "email"
  | "tel"
  | "url"
  | "number"
  | "select"
  | "checkbox"
  | "radio"
  | "date";

export interface InputField {
  id: string;
  label: string;
  type: InputFieldType;
  required: boolean;
  placeholder?: string;
  helpText?: string;
  /** select / radio options */
  options?: string[];
  /** name attribute on the rendered HTML input — also the key in the submission payload */
  name: string;
}

// ── Context sources ───────────────────────────────────────────

/** Where to pull dynamic context from — registered InfiniBot databases. */
export interface ContextSource {
  id: string;
  /** Human-friendly label shown in the editor. */
  label: string;
  /** InfiniBot database id (resolved via the registry, not Notion). */
  databaseId: string;
  /** Variable name available in the prompt as `{{ctx.<variableName>}}`. */
  variableName: string;
  /** How many rows to fetch. */
  rowLimit: number;
  /** Optional filter: only include rows where `<filterPropertyId>` equals `<filterValue>`. */
  filterPropertyId?: string;
  filterValue?: string;
  /** Whether to include the row's body markdown (false = title + values only — smaller prompt). */
  includeBody: boolean;
}

// ── AI generation ─────────────────────────────────────────────

export interface AiConfig {
  /** Model id from /models (e.g. "anthropic:claude-sonnet-4-6"). */
  model: string;
  temperature: number;
  maxTokens: number;
  /** Editable system prompt. Supports tokens:
   *    {{input.<fieldName>}}        — submitted value
   *    {{ctx.<variableName>}}       — context source (rendered as JSON)
   *    {{biz.name}} / {{biz.industry}} — active business profile values
   */
  systemPrompt: string;
  /** Optional user-prompt skeleton; when blank the runner builds a default from the input fields. */
  userPromptTemplate: string;
}

// ── Layout / style ────────────────────────────────────────────

export type DocLayout = "audit" | "report" | "proposal" | "letter" | "brief";

export interface DocStyle {
  brandColor: string;
  accent: string;
  fontFamily: string;
  pageSize: "letter" | "a4";
  /** Optional logo URL inserted into the rendered doc header. */
  logoUrl?: string;
}

// ── Actions ───────────────────────────────────────────────────

export type ActionKind =
  | "generate_pdf"
  | "send_email"
  | "log_to_crm"
  | "telegram_notify"
  | "qualify_lead"
  | "calendly_link";

/**
 * Optional condition. An action only runs if the run's `qualifyCategory`
 * matches. Use `op: "always"` to skip the condition.
 */
export interface ActionCondition {
  op: "always" | "equals" | "in" | "above";
  category?: string;
  categories?: string[];
}

export interface TemplateAction {
  id: string;
  kind: ActionKind;
  label?: string;
  config: Record<string, unknown>;
  condition?: ActionCondition;
}

// ── Approval gate ─────────────────────────────────────────────

export interface ApprovalGate {
  /** Categories that auto-approve (skip the queue). */
  autoApproveCategories: string[];
  /** Categories that go to the approval queue. */
  requireManualForCategories: string[];
  /** Categories that auto-reject. */
  rejectCategories: string[];
  /**
   * Calendly event-type URI sent to approved leads.
   * Example: "https://api.calendly.com/event_types/AAA-BBB-CCC".
   */
  calendlyEventTypeUri?: string;
  /** Optional message sent alongside the Calendly link. */
  approvalMessageTemplate?: string;
}

// ── Netlify integration ───────────────────────────────────────

export interface NetlifyBinding {
  /** Netlify site id this template's form lives on. */
  siteId: string;
  /** Form name on Netlify — `data-netlify-form="<formName>"`. */
  formName: string;
  /** Public form URL. */
  publicUrl: string;
  /** Last submission id we've processed — used as the highwater mark. */
  lastSeenSubmissionId: string | null;
  /** Last successful poll timestamp (ms). */
  lastPolledAt: number | null;
}

// ── Template + Run ────────────────────────────────────────────

export type DiscoveryDocType = "discovery_form" | "ai_audit" | "proposal" | "summary" | "custom";

export interface DiscoveryDocTemplate {
  id: string;
  businessId: string;
  name: string;
  description: string;
  type: DiscoveryDocType;
  slug: string;

  inputFields: InputField[];
  contextSources: ContextSource[];
  ai: AiConfig;
  layout: DocLayout;
  style: DocStyle;
  actions: TemplateAction[];
  approval: ApprovalGate;

  /** Netlify binding (null until "Publish form" runs). */
  netlify: NetlifyBinding | null;

  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export type RunSource = "manual_test" | "netlify" | "api";

export type RunApprovalState = "auto-approved" | "pending" | "approved" | "rejected";

export interface ActionResult {
  actionId: string;
  kind: ActionKind;
  status: "pending" | "skipped" | "running" | "done" | "failed";
  startedAt: number | null;
  finishedAt: number | null;
  detail: string | null;
  /** Action-specific output (e.g. pdf path, message id). */
  output?: Record<string, unknown>;
}

export interface DiscoveryDocRun {
  id: string;
  templateId: string;
  businessId: string;
  source: RunSource;

  /** The raw input the form submitted. */
  inputs: Record<string, string>;
  /** Snapshot of context fetched at the moment of run. */
  contextSnapshot: Record<string, unknown>;
  /** Rendered AI prompts used (for debugging / replay). */
  resolvedSystemPrompt: string;
  resolvedUserPrompt: string;
  /** The AI's markdown output. */
  generatedMarkdown: string;
  /** Category set by the qualify_lead action (or AI). */
  qualifyCategory: string | null;

  actions: ActionResult[];
  approvalState: RunApprovalState;
  approvalNote: string | null;

  /** Netlify provenance — null for manual runs. */
  netlifySubmissionId: string | null;
  /** Optional flag — has the lead's Calendly link been sent? */
  calendlyLinkSent: boolean;

  createdAt: number;
  updatedAt: number;
}

// ── Settings ──────────────────────────────────────────────────

export interface DiscoverySettings {
  /** Polling interval (ms) for the Netlify cron — defaults to 30s. */
  netlifyPollIntervalMs: number;
  /** Hard cap on submissions processed per template per day — abuse brake. */
  perTemplateDailyLimit: number;
  /** When true, the poller deletes submissions from Netlify after successful local processing. */
  deleteFromNetlifyAfterProcess: boolean;
  /** Grace window for keep-on-failure (ms). */
  keepOnFailureGraceMs: number;
}

export const DEFAULT_SETTINGS: DiscoverySettings = {
  netlifyPollIntervalMs: 30_000,
  perTemplateDailyLimit: 100,
  deleteFromNetlifyAfterProcess: true,
  keepOnFailureGraceMs: 7 * 24 * 60 * 60 * 1000,
};

// ── Default templates ────────────────────────────────────────

export const DEFAULT_AI_CONFIG: AiConfig = {
  model: "anthropic:claude-sonnet-4-6",
  temperature: 0.4,
  maxTokens: 4000,
  systemPrompt: `You are a senior consultant generating a client-ready discovery document.

Context:
- Business: {{biz.name}} ({{biz.industry}})
- Services offered: {{ctx.services}}

Lead submission:
{{input.fullName}} <{{input.email}}>
Company: {{input.company}}
Goals: {{input.goals}}
Current stack: {{input.currentStack}}

Write a clear, structured "AI Readiness Audit" for this lead. Include:
1. Executive Summary (2-3 sentences)
2. Current State Analysis (concrete observations from the inputs)
3. AI Readiness Score (1-10) with brief reasoning
4. Top 3 Recommendations (specific, actionable, tied to our services)
5. Suggested Next Step

Tone: confident, vendor-neutral, no jargon dumps. Aim for 600-900 words of Markdown.`,
  userPromptTemplate: "",
};

export const DEFAULT_STYLE: DocStyle = {
  brandColor: "#8b5cf6",
  accent: "#22d3ee",
  fontFamily: "Inter, system-ui, sans-serif",
  pageSize: "letter",
};

export const DEFAULT_APPROVAL: ApprovalGate = {
  autoApproveCategories: ["qualified"],
  requireManualForCategories: ["maybe", "warm"],
  rejectCategories: ["unqualified"],
};
