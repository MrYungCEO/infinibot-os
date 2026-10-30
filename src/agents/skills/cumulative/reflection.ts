/**
 * Reflection pass — turns a trajectory into a draft SKILL.md.
 *
 * The prompt is intentionally tight: we want a single, reusable, generic
 * skill that captures *the technique* not *the task instance*. Names are
 * kebab-case, descriptions are short imperative clauses, bodies are
 * markdown with a numbered procedure plus a "When to use" header.
 *
 * The completion is provider-agnostic — callers inject a `complete`
 * function. This keeps the cumulative-skills package free of any direct
 * dependency on Anthropic / Google / OpenAI SDKs and lets callers route
 * through whatever auth profile they prefer.
 */
import { createSubsystemLogger } from "../../../logging/subsystem.js";

import type { ReflectionDraft, Trajectory } from "./types.js";

const log = createSubsystemLogger("cumulative-skills/reflection");

const SYSTEM_PROMPT = `You are an expert agent-trainer. Your job is to read a successful agent run and distill the *reusable technique* it demonstrates into a SKILL — a markdown procedure that the same agent can invoke next time it faces a similar task.

A great skill is:
- **Generic, not specific** — strip the user's actual data; describe the *pattern*.
- **Procedural** — numbered steps the agent can follow.
- **Compact** — under 800 tokens of body. No filler.
- **Conditional on triggers** — clearly state when to invoke and when NOT to.

You MUST respond with one JSON object — no prose around it — matching this exact shape:
{
  "name": "kebab-case-name",
  "description": "One imperative sentence the agent will see in its skill listing. Start with a verb.",
  "emoji": "🔧",
  "confidence": 0.0,
  "body": "# Title\\n\\n## When to use\\n…\\n\\n## Procedure\\n1. …\\n\\n## Caveats\\n…"
}

Rules:
1. The name MUST be kebab-case, 2-4 words, lowercase ASCII.
2. The description MUST start with an imperative verb ("Build a…", "Detect…", "Refactor…").
3. confidence is your honest 0-1 self-rating. Use < 0.5 if the run was too task-specific to generalize.
4. If you can't extract a generalizable technique, set confidence to 0 and put "" in body — the caller will discard it.
5. Never include the user's literal data, names, or paths in body. Use placeholders like <project_name>.
6. Do not invent capabilities. Only describe steps that actually appear in the trajectory.`;

export interface ReflectionInput {
  /** The trajectory to distill. */
  trajectory: Trajectory;
  /**
   * Provider-agnostic completion function. Caller chooses the model + auth.
   * Should return the model's raw text (we'll JSON.parse it).
   */
  complete: (params: { system: string; user: string; maxOutputTokens?: number }) => Promise<string>;
}

/**
 * Run the reflection. Returns null when the model couldn't produce a usable
 * draft (low confidence, malformed JSON, empty body) — caller should treat
 * that as "skip this trajectory" rather than "error".
 */
export async function reflectTrajectoryIntoSkill(
  input: ReflectionInput,
): Promise<ReflectionDraft | null> {
  const userMessage = buildUserMessage(input.trajectory);
  let raw: string;
  try {
    raw = await input.complete({
      system: SYSTEM_PROMPT,
      user: userMessage,
      maxOutputTokens: 2000,
    });
  } catch (err) {
    log.warn(`reflection completion failed: ${(err as Error)?.message ?? err}`);
    return null;
  }
  return parseReflectionResponse(raw);
}

/** Pretty-print the trajectory in a structure the model can reason over. */
function buildUserMessage(trajectory: Trajectory): string {
  const lines: string[] = [];
  lines.push("## Task prompt");
  lines.push(trajectory.taskPrompt.slice(0, 4_000));
  lines.push("");
  lines.push("## Steps");
  for (const step of trajectory.steps) {
    lines.push(`- [${step.kind}] ${step.label}`);
    if (step.content) lines.push(`  ${step.content.replace(/\n/g, "\n  ").slice(0, 1_500)}`);
  }
  lines.push("");
  lines.push("## Final output");
  lines.push(trajectory.finalOutput.slice(0, 4_000));
  lines.push("");
  lines.push("## Metrics");
  lines.push(JSON.stringify(trajectory.metrics, null, 2));
  return lines.join("\n");
}

/**
 * Parse the model's response. The system prompt asks for a bare JSON
 * object but we accept models that wrap it in ```json fences — common
 * across providers — and we sanitize the fields so a single bad value
 * doesn't poison the corpus.
 */
export function parseReflectionResponse(raw: string): ReflectionDraft | null {
  const trimmed = stripCodeFence(raw.trim());
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const name = sanitizeName(obj.name);
  const description = typeof obj.description === "string" ? obj.description.trim() : "";
  const body = typeof obj.body === "string" ? obj.body.trim() : "";
  const emoji = typeof obj.emoji === "string" ? obj.emoji.trim().slice(0, 4) : undefined;
  const confidence = typeof obj.confidence === "number" ? Math.max(0, Math.min(1, obj.confidence)) : 0;
  if (!name || !description || !body) return null;
  return { name, description, body, emoji, confidence };
}

function stripCodeFence(text: string): string {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  return fenced ? (fenced[1] ?? "").trim() : text;
}

/** Force kebab-case, ASCII, max 64 chars. */
function sanitizeName(input: unknown): string {
  if (typeof input !== "string") return "";
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
