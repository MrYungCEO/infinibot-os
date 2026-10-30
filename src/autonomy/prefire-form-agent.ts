/**
 * Dynamic pre-fire form generator + readiness checker.
 *
 * Calls Claude with the task's title / description / project context and
 * asks it to emit (a) a JSON schema describing the questions IT decides it
 * needs before it can safely execute the work, and (b) a yes/no readiness
 * verdict once answers come back.
 *
 * The agent is intentionally allowed to pick its own fields — this is what
 * makes the questionnaire "dynamic". The schema is constrained to a small
 * set of field types so the UI + Telegram renderers can present any form
 * the model emits without bespoke handling.
 */

import type { AssistantMessage, Context, Model } from "@mariozechner/pi-ai";
import { complete, getModel } from "@mariozechner/pi-ai";
import type { PrefireField, PrefireForm, PrefireFieldType } from "./types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { readClaudeCliCredentials } from "../agents/cli-credentials.js";

const log = createSubsystemLogger("autonomy-prefire-form");

const ALLOWED_TYPES: ReadonlySet<PrefireFieldType> = new Set([
  "text",
  "textarea",
  "number",
  "boolean",
  "select",
  "multiselect",
]);

export interface PrefireFormContext {
  taskId: string;
  title: string;
  description?: string;
  project?: { id?: string; name?: string; description?: string } | null;
  /** Free-form extra context the caller wants to inject (notes, links). */
  notes?: string;
}

export interface GenerateResult {
  ok: boolean;
  form?: PrefireForm;
  error?: string;
}

export interface ReadinessResult {
  ready: boolean;
  reason: string;
  missing?: string[];
}

// Resolve a usable Anthropic credential without requiring ANTHROPIC_API_KEY:
//   1. ANTHROPIC_API_KEY env (legacy direct key)
//   2. ANTHROPIC_OAUTH_TOKEN env (explicit OAuth)
//   3. Claude Code's stored OAuth (~/.claude/.credentials.json) — the
//      common case for users running the gateway under their Claude Code
//      subscription.
// pi-ai's anthropic provider auto-detects the `sk-ant-oat` prefix and
// switches to Bearer + the right `anthropic-beta` headers, so passing
// the OAuth token through `apiKey` works for both modes.
function resolveAnthropicKey(): string | null {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (apiKey) return apiKey;

  const oauth = process.env.ANTHROPIC_OAUTH_TOKEN?.trim();
  if (oauth) return oauth;

  try {
    const creds = readClaudeCliCredentials({ allowKeychainPrompt: false });
    if (creds) {
      const token = creds.type === "oauth" ? creds.access : creds.token;
      if (token) return token;
    }
  } catch {
    /* best-effort fallback */
  }
  return null;
}

function preferredModelId(): string {
  return process.env.ANTHROPIC_AUTONOMY_MODEL || "claude-sonnet-4-5";
}

function resolveModel(): Model<"anthropic-messages"> {
  const id = preferredModelId();
  try {
    return getModel("anthropic", id as never) as Model<"anthropic-messages">;
  } catch {
    // Catalog may not carry the configured id (e.g. version churn);
    // fall back to a known-good Sonnet so the flow still runs.
    return getModel("anthropic", "claude-sonnet-4-5") as Model<"anthropic-messages">;
  }
}

// OAuth-token inference requires the caller identify as Claude Code;
// without this prefix the API returns 401. Harmless for direct-key
// callers, so we always prepend it.
const CLAUDE_CODE_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";
function withClaudeCodePrefix(base: string): string {
  return `${CLAUDE_CODE_PREFIX}\n\n${base}`;
}

function extractAssistantText(message: AssistantMessage): string {
  for (const block of message.content) {
    if (block.type === "text" && typeof block.text === "string") return block.text;
  }
  return "";
}

function sanitizeField(raw: unknown, index: number): PrefireField | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id =
    typeof r.id === "string" && r.id.trim()
      ? r.id.trim()
      : typeof r.label === "string"
        ? r.label
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_+|_+$/g, "")
            .slice(0, 40) || `field_${index}`
        : `field_${index}`;
  const label = typeof r.label === "string" && r.label.trim() ? r.label.trim() : id;
  const type = (typeof r.type === "string" ? r.type.toLowerCase() : "text") as PrefireFieldType;
  const safeType: PrefireFieldType = ALLOWED_TYPES.has(type) ? type : "text";
  const field: PrefireField = {
    id,
    label,
    type: safeType,
    required: r.required !== false, // default to required so the form blocks
  };
  if (typeof r.help === "string") field.help = r.help;
  if (typeof r.placeholder === "string") field.placeholder = r.placeholder;
  if ((safeType === "select" || safeType === "multiselect") && Array.isArray(r.options)) {
    field.options = r.options
      .filter((o): o is string => typeof o === "string" && o.trim().length > 0)
      .map((o) => o.trim());
  }
  if (
    r.default !== undefined &&
    (typeof r.default === "string" ||
      typeof r.default === "number" ||
      typeof r.default === "boolean" ||
      Array.isArray(r.default))
  ) {
    field.default = r.default as PrefireField["default"];
  }
  return field;
}

function extractJson(text: string): unknown {
  // Strip ```json fences if present; otherwise grab the first {...} blob.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const blob = fenced ? fenced[1] : text;
  const start = blob.indexOf("{");
  const end = blob.lastIndexOf("}");
  if (start < 0 || end < 0 || end < start) {
    throw new Error("no JSON object in model response");
  }
  return JSON.parse(blob.slice(start, end + 1));
}

function buildGeneratorPrompt(ctx: PrefireFormContext): string {
  const lines: string[] = [];
  lines.push(`# Task title\n${ctx.title}`);
  if (ctx.description) lines.push(`# Task description\n${ctx.description}`);
  if (ctx.project) {
    lines.push(
      `# Parent project\nname: ${ctx.project.name ?? "(unnamed)"}\nid: ${ctx.project.id ?? ""}`,
    );
    if (ctx.project.description) lines.push(`# Project description\n${ctx.project.description}`);
  }
  if (ctx.notes) lines.push(`# Notes\n${ctx.notes}`);
  lines.push(`# Output

Decide what you need to know from the operator before you can safely take
this task. Return JSON only, matching:

{
  "summary": "one-paragraph plain-English summary of how you'd execute",
  "fields": [
    {
      "id": "snake_case_id",
      "label": "Human-readable label",
      "type": "text" | "textarea" | "number" | "boolean" | "select" | "multiselect",
      "required": true,
      "help": "optional plain-language hint",
      "options": ["...", "..."]    // only for select / multiselect
    }
  ]
}

Rules:
- Pick the minimum set of questions needed to remove ambiguity. Do not pad.
- Always include a "success_criteria" textarea so the agent knows when it's done.
- If success depends on a specific path, repo, or URL, ask for it as text.
- Use "boolean" for yes/no toggles, "select" for one-of, "multiselect" for many-of.
- Do NOT add a "completed" / "ready" field — readiness is computed separately.
- Output JSON ONLY, no commentary.
`);
  return lines.join("\n\n");
}

export async function generatePrefireForm(ctx: PrefireFormContext): Promise<GenerateResult> {
  const apiKey = resolveAnthropicKey();
  if (!apiKey) {
    return {
      ok: false,
      error:
        "No Anthropic credentials found — set ANTHROPIC_API_KEY, ANTHROPIC_OAUTH_TOKEN, or sign in to Claude Code.",
    };
  }

  try {
    const model = resolveModel();
    const context: Context = {
      systemPrompt: withClaudeCodePrefix(
        "You are the autonomous-control pre-fire planner. You decide what " +
          "questions to ask the operator before kicking off a task. Output " +
          "strict JSON only — no markdown, no commentary.",
      ),
      messages: [{ role: "user", content: buildGeneratorPrompt(ctx), timestamp: Date.now() }],
    };
    const message = (await complete(model, context, {
      apiKey,
      maxTokens: 1500,
    })) as AssistantMessage;
    const text = extractAssistantText(message);
    if (!text) {
      return { ok: false, error: "model returned no text block" };
    }
    const parsed = extractJson(text);
    if (!parsed || typeof parsed !== "object") {
      return { ok: false, error: "model JSON not an object" };
    }
    const p = parsed as Record<string, unknown>;
    const fieldsRaw = Array.isArray(p.fields) ? p.fields : [];
    const fields: PrefireField[] = [];
    fieldsRaw.forEach((raw, i) => {
      const field = sanitizeField(raw, i);
      if (field) fields.push(field);
    });
    if (fields.length === 0) {
      return { ok: false, error: "model returned zero fields" };
    }
    const form: PrefireForm = {
      summary: typeof p.summary === "string" ? p.summary : undefined,
      fields,
      answers: {},
      agentReady: false,
      generatedAt: Date.now(),
      model: model.id,
    };
    return { ok: true, form };
  } catch (err) {
    const status = (err as { status?: number }).status;
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("prefire form generation failed", { error: msg, status });
    return { ok: false, error: status ? `${status} - ${msg}` : msg };
  }
}

export async function evaluatePrefireReadiness(
  form: PrefireForm,
  ctx: PrefireFormContext,
): Promise<ReadinessResult> {
  // Cheap structural check first — saves an LLM call when fields are empty.
  const missing: string[] = [];
  for (const field of form.fields) {
    if (!field.required) continue;
    const value = form.answers?.[field.id];
    if (value === undefined || value === null) {
      missing.push(field.label || field.id);
      continue;
    }
    if (typeof value === "string" && value.trim() === "") {
      missing.push(field.label || field.id);
    } else if (Array.isArray(value) && value.length === 0) {
      missing.push(field.label || field.id);
    }
  }
  if (missing.length > 0) {
    return {
      ready: false,
      reason: `Awaiting answers: ${missing.join(", ")}`,
      missing,
    };
  }

  const apiKey = resolveAnthropicKey();
  if (!apiKey) {
    // Without credentials, fall back to "all required answered = ready".
    return {
      ready: true,
      reason: "All required fields answered (no LLM available for deeper check)",
    };
  }

  try {
    const model = resolveModel();
    const answersPreview = form.fields
      .map((f) => {
        const v = form.answers[f.id];
        const rendered = Array.isArray(v) ? v.join(", ") : v == null ? "(empty)" : String(v);
        return `- ${f.label}: ${rendered}`;
      })
      .join("\n");
    const prompt = `# Task title\n${ctx.title}\n\n# Task description\n${
      ctx.description ?? "(none)"
    }\n\n# Operator's answers\n${answersPreview}\n\nReturn JSON:\n{ "ready": true|false, "reason": "one sentence" }`;
    const context: Context = {
      systemPrompt: withClaudeCodePrefix(
        "You are the autonomous-control pre-fire planner. Decide whether the " +
          "operator's answers give you enough to execute safely. Output strict JSON only.",
      ),
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    };
    const message = (await complete(model, context, {
      apiKey,
      maxTokens: 200,
    })) as AssistantMessage;
    const text = extractAssistantText(message);
    if (!text) {
      return { ready: true, reason: "model returned no text — accepting answers" };
    }
    const parsed = extractJson(text) as Record<string, unknown>;
    const ready = parsed.ready === true;
    const reason =
      typeof parsed.reason === "string" && parsed.reason.trim()
        ? parsed.reason.trim()
        : ready
          ? "Agent confirmed it has enough context."
          : "Agent says it needs more detail.";
    return { ready, reason };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("prefire readiness check failed", { error: msg });
    // Fail open — if the model errors, trust the structural check we already passed.
    return {
      ready: true,
      reason: `LLM readiness check failed (${msg}); accepting structural completeness.`,
    };
  }
}
