/**
 * Workflow Store — file-based CRUD with YAML frontmatter markdown files.
 *
 * Storage layout:
 *   <stateDir>/workflows/<id>.md
 *
 * Each file has YAML frontmatter (--- delimited) and a markdown body.
 */

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type {
  Workflow,
  WorkflowCreateParams,
  WorkflowInputDef,
  WorkflowListItem,
  WorkflowMeta,
  WorkflowRequirement,
  WorkflowSearchParams,
  WorkflowUpdateParams,
} from "./types.js";

// ── Frontmatter helpers ──────────────────────────────────────
//
// Switched from a hand-rolled toy parser to the `yaml` package because the
// new schema has nested arrays/objects (inputs[], requires[]) that the
// previous parser couldn't represent. The yaml package handles round-trip
// round-tripping cleanly.

function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };
  const yamlBlock = match[1];
  const body = match[2];
  let parsed: unknown = {};
  try {
    parsed = YAML.parse(yamlBlock) ?? {};
  } catch {
    parsed = {};
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return { meta: parsed as Record<string, unknown>, body };
  }
  return { meta: {}, body };
}

function buildMetaObject(meta: WorkflowMeta): Record<string, unknown> {
  // Build the YAML doc in a stable order so diffs stay clean.
  const out: Record<string, unknown> = {};
  out.id = meta.id;
  out.name = meta.name;
  if (meta.description) out.description = meta.description;
  if (meta.tags?.length) out.tags = meta.tags;
  if (meta.author) out.author = meta.author;
  out.createdAt = meta.createdAt;
  out.updatedAt = meta.updatedAt;
  if (meta.kind) out.kind = meta.kind;
  if (meta.continuous) out.continuous = meta.continuous;
  if (meta.agent) out.agent = meta.agent;
  if (meta.model) out.model = meta.model;
  if (typeof meta.timeoutSeconds === "number") out.timeoutSeconds = meta.timeoutSeconds;
  if (meta.inputs?.length) out.inputs = meta.inputs;
  if (meta.requires?.length) out.requires = meta.requires;
  if (meta.notionPageId) out.notionPageId = meta.notionPageId;
  if (meta.notionSyncedAt) out.notionSyncedAt = meta.notionSyncedAt;
  return out;
}

function serializeFrontmatter(meta: WorkflowMeta, body: string): string {
  const yamlBody = YAML.stringify(buildMetaObject(meta), { lineWidth: 0 }).trimEnd();
  return `---\n${yamlBody}\n---\n${body}`;
}

function metaFromParsed(parsed: Record<string, unknown>, fallbackId: string): WorkflowMeta {
  const kindRaw = parsed.kind;
  const kind: WorkflowMeta["kind"] =
    kindRaw === "continuous" || kindRaw === "static" ? kindRaw : undefined;
  const continuousRaw = parsed.continuous;
  const continuous: WorkflowMeta["continuous"] =
    continuousRaw && typeof continuousRaw === "object" && !Array.isArray(continuousRaw)
      ? (continuousRaw as WorkflowMeta["continuous"])
      : undefined;
  return {
    id: typeof parsed.id === "string" ? parsed.id : fallbackId,
    name: typeof parsed.name === "string" ? parsed.name : fallbackId,
    description: typeof parsed.description === "string" ? parsed.description : undefined,
    tags: Array.isArray(parsed.tags)
      ? parsed.tags.filter((t): t is string => typeof t === "string")
      : undefined,
    author: typeof parsed.author === "string" ? parsed.author : undefined,
    createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    notionPageId: typeof parsed.notionPageId === "string" ? parsed.notionPageId : undefined,
    notionSyncedAt: typeof parsed.notionSyncedAt === "string" ? parsed.notionSyncedAt : undefined,
    kind,
    continuous,
    agent: typeof parsed.agent === "string" ? parsed.agent : undefined,
    model: typeof parsed.model === "string" ? parsed.model : undefined,
    timeoutSeconds: typeof parsed.timeoutSeconds === "number" ? parsed.timeoutSeconds : undefined,
    inputs: Array.isArray(parsed.inputs) ? (parsed.inputs as WorkflowInputDef[]) : undefined,
    requires: Array.isArray(parsed.requires)
      ? (parsed.requires as WorkflowRequirement[])
      : undefined,
  };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function metaToListItem(meta: WorkflowMeta, body: string): WorkflowListItem {
  return {
    ...meta,
    preview: body.slice(0, 200).replace(/\n/g, " ").trim(),
    bodyLength: body.length,
  };
}

// ── Store class ──────────────────────────────────────────────

export class WorkflowStore {
  private readonly dir: string;

  constructor(stateDir: string) {
    this.dir = path.join(stateDir, "workflows");
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  private filePath(id: string): string {
    // Sanitize to prevent path traversal
    const safe = id.replace(/[^a-z0-9_-]/gi, "");
    return path.join(this.dir, `${safe}.md`);
  }

  /** List all workflows (optionally filtered). */
  list(params?: WorkflowSearchParams): WorkflowListItem[] {
    const files = fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith(".md"))
      .sort();

    let items: WorkflowListItem[] = [];

    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(this.dir, file), "utf-8");
        const { meta, body } = parseFrontmatter(raw);
        const wf = metaFromParsed(meta, file.replace(/\.md$/, ""));
        items.push(metaToListItem(wf, body));
      } catch {
        // Skip unreadable files
      }
    }

    // Apply filters
    if (params?.query) {
      const q = params.query.toLowerCase();
      items = items.filter(
        (w) =>
          w.name.toLowerCase().includes(q) ||
          w.description?.toLowerCase().includes(q) ||
          w.preview.toLowerCase().includes(q) ||
          w.tags?.some((t) => t.toLowerCase().includes(q)),
      );
    }
    if (params?.tags?.length) {
      const filterTags = params.tags.map((t) => t.toLowerCase());
      items = items.filter((w) => w.tags?.some((t) => filterTags.includes(t.toLowerCase())));
    }
    if (params?.author) {
      items = items.filter((w) => w.author === params.author);
    }
    if (params?.limit && params.limit > 0) {
      items = items.slice(0, params.limit);
    }

    return items;
  }

  /** Get a single workflow by ID. */
  get(id: string): Workflow | null {
    const fp = this.filePath(id);
    if (!fs.existsSync(fp)) return null;

    const raw = fs.readFileSync(fp, "utf-8");
    const { meta, body } = parseFrontmatter(raw);
    const wf = metaFromParsed(meta, id);
    return { ...wf, body };
  }

  /** Create a new workflow. Returns the created workflow. */
  create(params: WorkflowCreateParams): Workflow {
    const id = params.id || slugify(params.name);
    const now = new Date().toISOString();

    // Check duplicate
    if (fs.existsSync(this.filePath(id))) {
      throw new Error(`Workflow "${id}" already exists`);
    }

    const meta: WorkflowMeta = {
      id,
      name: params.name,
      description: params.description,
      tags: params.tags,
      author: params.author,
      createdAt: now,
      updatedAt: now,
      kind: params.kind,
      continuous: params.continuous,
      inputs: params.inputs,
      requires: params.requires,
      agent: params.agent,
      model: params.model,
      timeoutSeconds: params.timeoutSeconds,
    };

    const content = serializeFrontmatter(meta, params.body);
    fs.writeFileSync(this.filePath(id), content, "utf-8");

    return { ...meta, body: params.body };
  }

  /** Update an existing workflow. Returns the updated workflow or null. */
  update(params: WorkflowUpdateParams): Workflow | null {
    const existing = this.get(params.id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const updated: WorkflowMeta = {
      id: existing.id,
      name: params.name ?? existing.name,
      description: params.description ?? existing.description,
      tags: params.tags ?? existing.tags,
      author: existing.author,
      createdAt: existing.createdAt,
      updatedAt: now,
      notionPageId: params.notionPageId ?? existing.notionPageId,
      notionSyncedAt: params.notionSyncedAt ?? existing.notionSyncedAt,
      kind: params.kind ?? existing.kind,
      continuous: params.continuous ?? existing.continuous,
      inputs: params.inputs ?? existing.inputs,
      requires: params.requires ?? existing.requires,
      agent: params.agent ?? existing.agent,
      model: params.model ?? existing.model,
      timeoutSeconds: params.timeoutSeconds ?? existing.timeoutSeconds,
    };
    const body = params.body ?? existing.body;

    const content = serializeFrontmatter(updated, body);
    fs.writeFileSync(this.filePath(params.id), content, "utf-8");

    return { ...updated, body };
  }

  /** Delete a workflow by ID. Returns true if deleted. */
  delete(id: string): boolean {
    const fp = this.filePath(id);
    if (!fs.existsSync(fp)) return false;
    fs.unlinkSync(fp);
    return true;
  }

  /** Get the storage directory path. */
  getDir(): string {
    return this.dir;
  }
}
