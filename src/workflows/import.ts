/**
 * Workflow import — turn an uploaded file into a WorkflowCreateParams.
 *
 * Accepts:
 *   - InfiniBot workflow JSON  ({ name, body, description?, tags?, inputs?, … })
 *   - InfiniBot workflow markdown (YAML frontmatter + body)
 *   - n8n workflow JSON ({ nodes: [...], connections: {...} }) — converted to
 *     an ordered, human-readable step list the agent can follow.
 *
 * Errors are plain-English `WorkflowImportError`s.
 */

import YAML from "yaml";
import type { WorkflowCreateParams, WorkflowInputDef } from "./types.js";

export class WorkflowImportError extends Error {}

export const WORKFLOW_UPLOAD_MAX_BYTES = 2 * 1024 * 1024;

export type WorkflowImportFormat = "infinibot-json" | "markdown" | "n8n";

export type ParsedWorkflowImport = {
  format: WorkflowImportFormat;
  params: WorkflowCreateParams;
};

export function slugifyWorkflowName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

function cleanTags(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const tags = v
    .map((t) =>
      typeof t === "string"
        ? t
        : t && typeof t === "object"
          ? str((t as { name?: unknown }).name)
          : undefined,
    )
    .filter((t): t is string => !!t);
  return tags.length ? tags : undefined;
}

function pickCommon(obj: Record<string, unknown>): Partial<WorkflowCreateParams> {
  const out: Partial<WorkflowCreateParams> = {};
  const description = str(obj.description);
  if (description) out.description = description;
  const tags = cleanTags(obj.tags);
  if (tags) out.tags = tags;
  const author = str(obj.author);
  if (author) out.author = author;
  const agent = str(obj.agent);
  if (agent) out.agent = agent;
  const model = str(obj.model);
  if (model) out.model = model;
  if (typeof obj.timeoutSeconds === "number" && obj.timeoutSeconds > 0) {
    out.timeoutSeconds = obj.timeoutSeconds;
  }
  if (Array.isArray(obj.inputs)) out.inputs = obj.inputs as WorkflowInputDef[];
  return out;
}

function nodeLabel(type: string): string {
  const short = type.split(".").pop() ?? type;
  return short.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}

function summarizeParams(params: unknown): string[] {
  if (!params || typeof params !== "object") return [];
  const lines: string[] = [];
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    if (lines.length >= 6) break;
    if (typeof v === "string" && v.trim()) {
      // Never carry credentials / secrets across.
      if (/token|secret|password|apikey|api_key|authorization/i.test(k)) continue;
      lines.push(`${k}: ${v.length > 200 ? `${v.slice(0, 200)}…` : v}`);
    } else if (typeof v === "number" || typeof v === "boolean") {
      lines.push(`${k}: ${String(v)}`);
    }
  }
  return lines;
}

function convertN8n(obj: Record<string, unknown>, fileName: string): WorkflowCreateParams {
  const nodes = (obj.nodes as Array<Record<string, unknown>>).filter(
    (n) => n && typeof n === "object" && typeof n.name === "string",
  );
  if (nodes.length === 0) {
    throw new WorkflowImportError(
      "This n8n workflow has no steps (nodes) in it, so there's nothing to import.",
    );
  }
  const connections =
    obj.connections && typeof obj.connections === "object"
      ? (obj.connections as Record<string, { main?: Array<Array<{ node?: string }>> }>)
      : {};
  const byName = new Map(nodes.map((n) => [n.name as string, n]));
  const incoming = new Set<string>();
  for (const out of Object.values(connections)) {
    for (const branch of out?.main ?? [])
      for (const c of branch ?? []) if (c?.node) incoming.add(c.node);
  }
  const starts = nodes.filter((n) => !incoming.has(n.name as string)).map((n) => n.name as string);
  // Breadth-first walk so steps read in execution order.
  const order: string[] = [];
  const seen = new Set<string>();
  const queue = [...(starts.length ? starts : [nodes[0].name as string])];
  while (queue.length) {
    const cur = queue.shift()!;
    if (seen.has(cur) || !byName.has(cur)) continue;
    seen.add(cur);
    order.push(cur);
    for (const branch of connections[cur]?.main ?? [])
      for (const c of branch ?? []) if (c?.node) queue.push(c.node);
  }
  for (const n of nodes) if (!seen.has(n.name as string)) order.push(n.name as string);

  const name = str(obj.name) ?? fileName.replace(/\.json$/i, "") ?? "Imported n8n workflow";
  const lines: string[] = [
    `# ${name}`,
    "",
    "Imported from an n8n workflow. Carry out these steps in order, using InfiniBot's own tools where an n8n node has no direct equivalent. Stop and ask if a step needs an account or credential that isn't connected.",
    "",
  ];
  order.forEach((nodeName, i) => {
    const n = byName.get(nodeName)!;
    const type = typeof n.type === "string" ? n.type : "step";
    lines.push(
      `${i + 1}. **${nodeName}** (${nodeLabel(type)})${n.disabled ? " — disabled in n8n, skip" : ""}`,
    );
    for (const l of summarizeParams(n.parameters)) lines.push(`   - ${l}`);
    const next = (connections[nodeName]?.main ?? [])
      .flat()
      .map((c) => c?.node)
      .filter(Boolean);
    if (next.length) lines.push(`   - then: ${next.join(", ")}`);
  });
  lines.push("");
  return {
    name,
    body: lines.join("\n"),
    tags: ["imported", "n8n", ...(cleanTags(obj.tags) ?? [])],
    description: str(obj.description) ?? `Imported from n8n (${nodes.length} steps)`,
  };
}

export function parseWorkflowUpload(fileName: string, data: Buffer): ParsedWorkflowImport {
  if (!data.length) throw new WorkflowImportError("That file is empty.");
  if (data.length > WORKFLOW_UPLOAD_MAX_BYTES) {
    throw new WorkflowImportError(
      `That file is ${(data.length / 1024 / 1024).toFixed(1)} MB; the workflow upload limit is ${Math.round(WORKFLOW_UPLOAD_MAX_BYTES / 1024 / 1024)} MB.`,
    );
  }
  if (data[0] === 0x50 && data[1] === 0x4b) {
    throw new WorkflowImportError(
      "That's a zip file. Workflows are a single .json or .md file. (Skill zips go on the Skills page.)",
    );
  }
  for (let i = 0; i < Math.min(data.length, 4096); i++) {
    if (data[i] === 0) {
      throw new WorkflowImportError("That file isn't text. Upload a workflow .json or .md file.");
    }
  }
  const text = data.toString("utf-8").replace(/^﻿/, "");
  const trimmed = text.trimStart();

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let obj: unknown;
    try {
      obj = JSON.parse(text);
    } catch (err) {
      const m = /position (\d+)/.exec(String((err as Error).message));
      const where = m ? ` near character ${m[1]}` : "";
      throw new WorkflowImportError(
        `That file isn't valid JSON${where}. It may be cut off or have a stray comma or quote.`,
      );
    }
    if (Array.isArray(obj)) {
      if (obj.length === 1 && obj[0] && typeof obj[0] === "object") obj = obj[0];
      else throw new WorkflowImportError("That JSON is a list. Upload one workflow per file.");
    }
    if (!obj || typeof obj !== "object") {
      throw new WorkflowImportError("That JSON isn't a workflow object.");
    }
    const rec = obj as Record<string, unknown>;
    if (Array.isArray(rec.nodes) && rec.connections && typeof rec.connections === "object") {
      return { format: "n8n", params: convertN8n(rec, fileName) };
    }
    if (Array.isArray(rec.nodes)) {
      throw new WorkflowImportError(
        "This looks like an n8n workflow but it's missing its connections, so the step order can't be worked out.",
      );
    }
    const name = str(rec.name) ?? str(rec.title);
    const body =
      typeof rec.body === "string" ? rec.body : (str(rec.instructions) ?? str(rec.prompt));
    if (!name) {
      throw new WorkflowImportError('This workflow JSON needs a "name".');
    }
    if (!body || !body.trim()) {
      throw new WorkflowImportError(
        'This workflow JSON needs a "body" (the written steps). It looks like a different kind of JSON file.',
      );
    }
    return { format: "infinibot-json", params: { ...pickCommon(rec), name, body } };
  }

  // Markdown with frontmatter
  const m = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/);
  if (!m) {
    throw new WorkflowImportError(
      "I couldn't recognise that file. Workflows are .json files (InfiniBot or n8n) or .md files that start with a --- header containing a name.",
    );
  }
  let meta: unknown;
  try {
    meta = YAML.parse(m[1]);
  } catch {
    throw new WorkflowImportError(
      "The header at the top of that workflow isn't valid. Check the lines between the two --- markers.",
    );
  }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    throw new WorkflowImportError(
      "The header at the top of that workflow is empty. It needs a name.",
    );
  }
  const rec = meta as Record<string, unknown>;
  const name = str(rec.name);
  if (!name) throw new WorkflowImportError("The workflow header needs a name.");
  const body = m[2] ?? "";
  if (!body.trim())
    throw new WorkflowImportError("That workflow has a header but no steps below it.");
  return { format: "markdown", params: { ...pickCommon(rec), name, body } };
}
