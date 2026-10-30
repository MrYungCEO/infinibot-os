/**
 * Discovery Docs — prompt token resolver.
 *
 * Substitutes `{{token}}` references in the user's system/user prompt
 * with concrete values. Supported namespaces:
 *
 *   {{input.<fieldName>}}    — submitted form value
 *   {{ctx.<variableName>}}   — context source (rendered as JSON)
 *   {{biz.<key>}}            — active business profile field
 *   {{run.<key>}}            — run metadata (id, createdAt iso, etc.)
 *
 * Missing tokens render as `[missing: <token>]` so the user can spot a
 * bad reference in the AI's output instead of getting a literal
 * `undefined` baked in.
 */

import type { ResolvedContext } from "./context.js";

export interface PromptResolveInput {
  systemPrompt: string;
  userPromptTemplate: string;
  /** Falls back to a default question when blank. */
  inputs: Record<string, string>;
  context: ResolvedContext;
  business: Record<string, unknown>;
  runId: string;
  runTimestamp: number;
}

export interface ResolvedPrompts {
  system: string;
  user: string;
}

const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

export function resolvePrompts(input: PromptResolveInput): ResolvedPrompts {
  const lookup = buildLookup(input);
  const system = substitute(input.systemPrompt, lookup);
  const userTpl =
    input.userPromptTemplate && input.userPromptTemplate.trim()
      ? input.userPromptTemplate
      : defaultUserPrompt(input.inputs);
  const user = substitute(userTpl, lookup);
  return { system, user };
}

function buildLookup(input: PromptResolveInput): Map<string, string> {
  const m = new Map<string, string>();

  for (const [k, v] of Object.entries(input.inputs)) {
    m.set(`input.${k}`, stringifyForPrompt(v));
  }
  for (const [k, v] of Object.entries(input.context)) {
    m.set(`ctx.${k}`, stringifyForPrompt(v));
  }
  for (const [k, v] of Object.entries(input.business)) {
    m.set(`biz.${k}`, stringifyForPrompt(v));
  }
  m.set("run.id", input.runId);
  m.set("run.timestamp", new Date(input.runTimestamp).toISOString());

  return m;
}

function substitute(template: string, lookup: Map<string, string>): string {
  return template.replace(TOKEN_RE, (_full, key: string) => {
    if (lookup.has(key)) return lookup.get(key)!;
    return `[missing: ${key}]`;
  });
}

function stringifyForPrompt(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function defaultUserPrompt(inputs: Record<string, string>): string {
  const lines = Object.entries(inputs)
    .filter(([, v]) => v && v.trim())
    .map(([k, v]) => `- **${k}**: ${v}`);
  if (lines.length === 0) {
    return "Generate the document using the system prompt instructions and any available context.";
  }
  return `Generate the document for the following submission:\n\n${lines.join("\n")}`;
}

/**
 * Light helper for the editor's token-reference panel — turn an
 * inputFields array + context-source list + business profile into a
 * flat list of `{{token}}` strings the user can click to insert.
 */
export function listAvailableTokens(opts: {
  inputFieldNames: string[];
  contextVariables: string[];
  businessKeys: string[];
}): Array<{ token: string; description: string; section: string }> {
  const out: Array<{ token: string; description: string; section: string }> = [];
  for (const f of opts.inputFieldNames) {
    out.push({
      token: `{{input.${f}}}`,
      description: `Value submitted in the "${f}" form field.`,
      section: "Input",
    });
  }
  for (const v of opts.contextVariables) {
    out.push({
      token: `{{ctx.${v}}}`,
      description: `Rows from the linked database, serialized as JSON.`,
      section: "Context",
    });
  }
  for (const k of opts.businessKeys) {
    out.push({
      token: `{{biz.${k}}}`,
      description: `Active business profile: ${k}.`,
      section: "Business",
    });
  }
  out.push({
    token: `{{run.id}}`,
    description: `Unique id for this run — handy for log lookups.`,
    section: "Run",
  });
  out.push({
    token: `{{run.timestamp}}`,
    description: `ISO timestamp of when this run started.`,
    section: "Run",
  });
  return out;
}
