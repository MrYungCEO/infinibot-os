/**
 * Note Store — file-based CRUD with YAML frontmatter markdown files.
 *
 * Storage layout:
 *   <stateDir>/notes/<id>.md
 *
 * Each file has YAML frontmatter (--- delimited) and a markdown body.
 */

import fs from "node:fs";
import path from "node:path";
import type {
  Note,
  NoteCreateParams,
  NoteListItem,
  NoteMeta,
  NoteSearchParams,
  NoteUpdateParams,
} from "./types.js";
import { coerceString } from "../shared/text/coerce.js";

// ── Frontmatter helpers ──────────────────────────────────────

function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };

  const yamlBlock = match[1];
  const body = match[2];

  const meta: Record<string, unknown> = {};
  for (const line of yamlBlock.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx < 0) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let value: string | string[] = trimmed.slice(colonIdx + 1).trim();

    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1);
      meta[key] = inner
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else if (value === "true") {
      meta[key] = true;
    } else if (value === "false") {
      meta[key] = false;
    } else {
      meta[key] = value.replace(/^["']|["']$/g, "");
    }
  }
  return { meta, body };
}

function serializeFrontmatter(meta: NoteMeta, body: string): string {
  const lines = ["---"];
  lines.push(`id: ${meta.id}`);
  lines.push(`name: "${meta.name.replace(/"/g, '\\"')}"`);
  if (meta.description) lines.push(`description: "${meta.description.replace(/"/g, '\\"')}"`);
  if (meta.tags?.length) {
    lines.push(`tags: [${meta.tags.map((t) => `"${t}"`).join(", ")}]`);
  }
  if (meta.author) lines.push(`author: ${meta.author}`);
  if (meta.category) lines.push(`category: "${meta.category.replace(/"/g, '\\"')}"`);
  if (meta.pinned) lines.push(`pinned: true`);
  if (meta.linkedTo?.length) {
    lines.push(`linkedTo: [${meta.linkedTo.map((l) => `"${l}"`).join(", ")}]`);
  }
  if (meta.projectId) lines.push(`projectId: ${meta.projectId}`);
  if (meta.clientId) lines.push(`clientId: ${meta.clientId}`);
  if (meta.reviewOn) lines.push(`reviewOn: "${meta.reviewOn}"`);
  if (meta.documentFamilyId) lines.push(`documentFamilyId: ${meta.documentFamilyId}`);
  if (meta.version != null) lines.push(`version: ${meta.version}`);
  if (meta.versionLabel) lines.push(`versionLabel: "${meta.versionLabel.replace(/"/g, '\\"')}"`);
  if (meta.supersededBy) lines.push(`supersededBy: ${meta.supersededBy}`);
  if (meta.supersedes) lines.push(`supersedes: ${meta.supersedes}`);
  if (meta.isCurrent) lines.push(`isCurrent: true`);
  lines.push(`createdAt: ${meta.createdAt}`);
  lines.push(`updatedAt: ${meta.updatedAt}`);
  if (meta.notionPageId) lines.push(`notionPageId: ${meta.notionPageId}`);
  if (meta.notionSyncedAt) lines.push(`notionSyncedAt: ${meta.notionSyncedAt}`);
  lines.push("---");
  lines.push(body);
  return lines.join("\n");
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

/** Extract optional versioning fields from a parsed frontmatter record. */
function pickVersionMeta(meta: Record<string, unknown>): Partial<NoteMeta> {
  const rawVersion = meta.version;
  let version: number | undefined;
  if (typeof rawVersion === "number") version = rawVersion;
  else if (typeof rawVersion === "string" && rawVersion.trim() !== "") {
    const n = Number(rawVersion);
    if (Number.isFinite(n)) version = n;
  }
  return {
    documentFamilyId: (meta.documentFamilyId as string) || undefined,
    version,
    versionLabel: (meta.versionLabel as string) || undefined,
    supersededBy: (meta.supersededBy as string) || undefined,
    supersedes: (meta.supersedes as string) || undefined,
    isCurrent: meta.isCurrent === true || meta.isCurrent === "true" ? true : undefined,
  };
}

function metaToListItem(meta: NoteMeta, body: string): NoteListItem {
  return {
    ...meta,
    preview: body.slice(0, 200).replace(/\n/g, " ").trim(),
    bodyLength: body.length,
  };
}

// ── Store class ──────────────────────────────────────────────

export class NoteStore {
  private readonly dir: string;

  constructor(stateDir: string) {
    this.dir = path.join(stateDir, "notes");
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  private filePath(id: string): string {
    const safe = id.replace(/[^a-z0-9_-]/gi, "");
    return path.join(this.dir, `${safe}.md`);
  }

  /** List all notes (optionally filtered). */
  list(params?: NoteSearchParams): NoteListItem[] {
    const files = fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith(".md"))
      .sort();

    let items: NoteListItem[] = [];

    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(this.dir, file), "utf-8");
        const { meta, body } = parseFrontmatter(raw);
        const note: NoteMeta = {
          id: (meta.id as string) || file.replace(/\.md$/, ""),
          name: (meta.name as string) || file.replace(/\.md$/, ""),
          description: meta.description as string | undefined,
          tags: meta.tags as string[] | undefined,
          author: meta.author as string | undefined,
          category: meta.category as string | undefined,
          pinned: meta.pinned === true || meta.pinned === "true" ? true : undefined,
          linkedTo: meta.linkedTo as string[] | undefined,
          projectId: meta.projectId as string | undefined,
          clientId: meta.clientId ? coerceString(meta.clientId) : undefined,
          reviewOn: meta.reviewOn ? coerceString(meta.reviewOn) : undefined,
          createdAt: (meta.createdAt as string) || "",
          updatedAt: (meta.updatedAt as string) || "",
          notionPageId: meta.notionPageId as string | undefined,
          notionSyncedAt: meta.notionSyncedAt as string | undefined,
          ...pickVersionMeta(meta),
        };
        items.push(metaToListItem(note, body));
      } catch {
        // Skip unreadable files
      }
    }

    // Apply filters
    if (params?.query) {
      const q = params.query.toLowerCase();
      items = items.filter(
        (n) =>
          n.name.toLowerCase().includes(q) ||
          n.description?.toLowerCase().includes(q) ||
          n.preview.toLowerCase().includes(q) ||
          n.tags?.some((t) => t.toLowerCase().includes(q)),
      );
    }
    if (params?.tags?.length) {
      const filterTags = params.tags.map((t) => t.toLowerCase());
      items = items.filter((n) => n.tags?.some((t) => filterTags.includes(t.toLowerCase())));
    }
    if (params?.author) {
      items = items.filter((n) => n.author === params.author);
    }
    if (params?.category) {
      items = items.filter((n) => n.category === params.category);
    }
    if (params?.pinned !== undefined) {
      items = items.filter((n) => (n.pinned ?? false) === params.pinned);
    }
    if (params?.projectId) {
      items = items.filter((n) => n.projectId === params.projectId);
    }
    if (params?.clientId) {
      items = items.filter((n) => n.clientId === params.clientId);
    }
    if (params?.limit && params.limit > 0) {
      items = items.slice(0, params.limit);
    }

    return items;
  }

  /** Get a single note by ID. */
  get(id: string): Note | null {
    const fp = this.filePath(id);
    if (!fs.existsSync(fp)) return null;

    const raw = fs.readFileSync(fp, "utf-8");
    const { meta, body } = parseFrontmatter(raw);

    return {
      id: (meta.id as string) || id,
      name: (meta.name as string) || id,
      description: meta.description as string | undefined,
      tags: meta.tags as string[] | undefined,
      author: meta.author as string | undefined,
      category: meta.category as string | undefined,
      pinned: meta.pinned === true || meta.pinned === "true" ? true : undefined,
      linkedTo: meta.linkedTo as string[] | undefined,
      projectId: meta.projectId as string | undefined,
      clientId: meta.clientId ? coerceString(meta.clientId) : undefined,
      reviewOn: meta.reviewOn ? coerceString(meta.reviewOn) : undefined,
      createdAt: (meta.createdAt as string) || "",
      updatedAt: (meta.updatedAt as string) || "",
      notionPageId: meta.notionPageId as string | undefined,
      notionSyncedAt: meta.notionSyncedAt as string | undefined,
      ...pickVersionMeta(meta),
      body,
    };
  }

  /** Create a new note. Returns the created note. */
  create(params: NoteCreateParams): Note {
    const id = params.id || slugify(params.name);
    const now = new Date().toISOString();

    if (fs.existsSync(this.filePath(id))) {
      throw new Error(`Note "${id}" already exists`);
    }

    const meta: NoteMeta = {
      id,
      name: params.name,
      description: params.description,
      tags: params.tags,
      author: params.author,
      category: params.category,
      pinned: params.pinned,
      linkedTo: params.linkedTo,
      projectId: params.projectId,
      clientId: params.clientId || undefined,
      reviewOn: params.reviewOn || undefined,
      notionPageId: params.notionPageId,
      notionSyncedAt: params.notionSyncedAt,
      documentFamilyId: params.documentFamilyId,
      version: params.version,
      versionLabel: params.versionLabel,
      createdAt: now,
      updatedAt: now,
    };

    const content = serializeFrontmatter(meta, params.body);
    fs.writeFileSync(this.filePath(id), content, "utf-8");

    return { ...meta, body: params.body };
  }

  /** Update an existing note. Returns the updated note or null. */
  update(params: NoteUpdateParams): Note | null {
    const existing = this.get(params.id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const updated: NoteMeta = {
      id: existing.id,
      name: params.name ?? existing.name,
      description: params.description ?? existing.description,
      tags: params.tags ?? existing.tags,
      author: existing.author,
      category: params.category ?? existing.category,
      pinned: params.pinned ?? existing.pinned,
      linkedTo: params.linkedTo ?? existing.linkedTo,
      projectId: params.projectId ?? existing.projectId,
      clientId: params.clientId !== undefined ? params.clientId || undefined : existing.clientId,
      reviewOn: params.reviewOn !== undefined ? params.reviewOn || undefined : existing.reviewOn,
      createdAt: existing.createdAt,
      updatedAt: now,
      notionPageId: params.notionPageId ?? existing.notionPageId,
      notionSyncedAt: params.notionSyncedAt ?? existing.notionSyncedAt,
      documentFamilyId: params.documentFamilyId ?? existing.documentFamilyId,
      version: params.version ?? existing.version,
      versionLabel: params.versionLabel ?? existing.versionLabel,
      supersededBy: params.supersededBy ?? existing.supersededBy,
      supersedes: params.supersedes ?? existing.supersedes,
      isCurrent: params.isCurrent ?? existing.isCurrent,
    };
    const body = params.body ?? existing.body;

    const content = serializeFrontmatter(updated, body);
    fs.writeFileSync(this.filePath(params.id), content, "utf-8");

    return { ...updated, body };
  }

  /** Delete a note by ID. Returns true if deleted. */
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
