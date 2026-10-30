/**
 * Ideas store — local-first, one JSON file per install:
 *
 *   <stateDir>/ideas/ideas.json   { version: 1, ideas: Idea[], requests: {key: id} }
 *
 * Small by nature (people capture hundreds of ideas, not millions), so the
 * whole file is read once, kept in memory and rewritten atomically (temp file
 * + rename) on every change. `requests` remembers idempotency keys so a phone
 * that queued a capture offline and retries it never creates a duplicate.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveStateDirWithLegacyEnv } from "../config/paths.js";
import {
  IDEA_SOURCES,
  IDEA_STATUSES,
  type Idea,
  type IdeaCreateParams,
  type IdeaListParams,
  type IdeaPatch,
  type IdeaSource,
  type IdeaStatus,
} from "./types.js";

type FileShape = { version: 1; ideas: Idea[]; requests: Record<string, string> };

const MAX_TITLE = 200;
const MAX_BODY = 20_000;
const MAX_TAGS = 12;
const MAX_REQUEST_KEYS = 2_000;

export class IdeaValidationError extends Error {}

function cleanTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const t of tags) {
    if (typeof t !== "string") continue;
    const v = t.trim().replace(/^#/, "").toLowerCase().slice(0, 40);
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function cleanIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  return [
    ...new Set(
      ids.filter((v): v is string => typeof v === "string" && !!v.trim()).map((v) => v.trim()),
    ),
  ];
}

/** "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm", else undefined. */
export function cleanWhen(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return /^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d)?$/.test(s) &&
    !Number.isNaN(Date.parse(s.slice(0, 10)))
    ? s
    : undefined;
}

export function isIdeaStatus(v: unknown): v is IdeaStatus {
  return typeof v === "string" && (IDEA_STATUSES as readonly string[]).includes(v);
}

function sourceOf(v: unknown): IdeaSource {
  return typeof v === "string" && (IDEA_SOURCES as readonly string[]).includes(v)
    ? (v as IdeaSource)
    : "web";
}

export class IdeaStore {
  private readonly file: string;
  private data: FileShape | null = null;

  constructor(
    stateDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.file = path.join(stateDir, "ideas", "ideas.json");
  }

  private load(): FileShape {
    if (this.data) return this.data;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<FileShape>;
      this.data = {
        version: 1,
        ideas: Array.isArray(raw.ideas) ? raw.ideas : [],
        requests: raw.requests && typeof raw.requests === "object" ? raw.requests : {},
      };
    } catch {
      this.data = { version: 1, ideas: [], requests: {} };
    }
    return this.data;
  }

  private save(): void {
    const data = this.load();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  /** Re-read from disk on the next access (another process wrote the file). */
  reload(): void {
    this.data = null;
  }

  create(p: IdeaCreateParams): { idea: Idea; created: boolean } {
    const data = this.load();
    const key = typeof p.clientRequestId === "string" ? p.clientRequestId.trim() : "";
    if (key && data.requests[key]) {
      const prior = data.ideas.find((i) => i.id === data.requests[key]);
      if (prior) return { idea: prior, created: false };
    }
    const title = typeof p.title === "string" ? p.title.trim().slice(0, MAX_TITLE) : "";
    if (!title) throw new IdeaValidationError("title is required");
    const at = this.now().toISOString();
    const idea: Idea = {
      id: `idea_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      title,
      body: typeof p.body === "string" ? p.body.slice(0, MAX_BODY) : "",
      tags: cleanTags(p.tags),
      source: sourceOf(p.source),
      status: isIdeaStatus(p.status) ? p.status : "new",
      projectIds: cleanIds(p.projectIds),
      taskIds: cleanIds(p.taskIds),
      docIds: cleanIds(p.docIds),
      clientIds: cleanIds(p.clientIds),
      ...(cleanWhen(p.reviewOn) ? { reviewOn: cleanWhen(p.reviewOn) } : {}),
      ...(p.createdBy ? { createdBy: String(p.createdBy).slice(0, 80) } : {}),
      createdAt: at,
      updatedAt: at,
    };
    data.ideas.unshift(idea);
    if (key) {
      data.requests[key] = idea.id;
      const keys = Object.keys(data.requests);
      if (keys.length > MAX_REQUEST_KEYS) {
        for (const k of keys.slice(0, keys.length - MAX_REQUEST_KEYS)) delete data.requests[k];
      }
    }
    this.save();
    return { idea, created: true };
  }

  get(id: string): Idea | null {
    return this.load().ideas.find((i) => i.id === id) ?? null;
  }

  list(p: IdeaListParams = {}): Idea[] {
    let out = [...this.load().ideas];
    const statuses = Array.isArray(p.status) ? p.status : p.status ? [p.status] : [];
    if (statuses.length) out = out.filter((i) => statuses.includes(i.status));
    if (p.tag) {
      const tag = p.tag.trim().replace(/^#/, "").toLowerCase();
      out = out.filter((i) => i.tags.includes(tag));
    }
    if (p.clientId) out = out.filter((i) => i.clientIds?.includes(p.clientId!));
    if (p.since !== undefined) {
      const t = typeof p.since === "number" ? p.since : Date.parse(p.since);
      if (Number.isFinite(t)) out = out.filter((i) => Date.parse(i.updatedAt) > t);
    }
    const q = p.query?.trim().toLowerCase();
    if (q) {
      out = out.filter((i) =>
        `${i.title}\n${i.body}\n${i.tags.join(" ")}`.toLowerCase().includes(q),
      );
    }
    out.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const limit =
      typeof p.limit === "number" && p.limit > 0 ? Math.min(Math.floor(p.limit), 1000) : 500;
    return out.slice(0, limit);
  }

  update(id: string, patch: IdeaPatch): Idea | null {
    const data = this.load();
    const idea = data.ideas.find((i) => i.id === id);
    if (!idea) return null;
    if (patch.title !== undefined) {
      const t = String(patch.title).trim().slice(0, MAX_TITLE);
      if (!t) throw new IdeaValidationError("title cannot be empty");
      idea.title = t;
    }
    if (patch.body !== undefined) idea.body = String(patch.body).slice(0, MAX_BODY);
    if (patch.tags !== undefined) idea.tags = cleanTags(patch.tags);
    if (patch.status !== undefined) {
      if (!isIdeaStatus(patch.status))
        throw new IdeaValidationError(`status must be one of ${IDEA_STATUSES.join(", ")}`);
      idea.status = patch.status;
    }
    if (patch.projectIds !== undefined) idea.projectIds = cleanIds(patch.projectIds);
    if (patch.taskIds !== undefined) idea.taskIds = cleanIds(patch.taskIds);
    if (patch.docIds !== undefined) idea.docIds = cleanIds(patch.docIds);
    if (patch.clientIds !== undefined) idea.clientIds = cleanIds(patch.clientIds);
    if (patch.reviewOn !== undefined) {
      const when = patch.reviewOn === null ? undefined : cleanWhen(patch.reviewOn);
      if (patch.reviewOn !== null && patch.reviewOn !== "" && !when)
        throw new IdeaValidationError("reviewOn must be YYYY-MM-DD or YYYY-MM-DDTHH:mm");
      if (when) idea.reviewOn = when;
      else delete idea.reviewOn;
    }
    if (patch.promotedTo !== undefined) idea.promotedTo = patch.promotedTo;
    idea.updatedAt = this.now().toISOString();
    this.save();
    return idea;
  }

  delete(id: string): boolean {
    const data = this.load();
    const before = data.ideas.length;
    data.ideas = data.ideas.filter((i) => i.id !== id);
    if (data.ideas.length === before) return false;
    for (const [k, v] of Object.entries(data.requests)) if (v === id) delete data.requests[k];
    this.save();
    return true;
  }

  /** Counts per status (for list headers / badges). */
  counts(): Record<IdeaStatus, number> {
    const out = Object.fromEntries(IDEA_STATUSES.map((s) => [s, 0])) as Record<IdeaStatus, number>;
    for (const i of this.load().ideas) out[i.status] = (out[i.status] ?? 0) + 1;
    return out;
  }

  /** Every tag in use, most used first. */
  tags(): Array<{ tag: string; count: number }> {
    const m = new Map<string, number>();
    for (const i of this.load().ideas) for (const t of i.tags) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }
}

const stores = new Map<string, IdeaStore>();

/** Process-wide store for a state dir (default: the active install's). */
export function getIdeaStore(stateDir?: string): IdeaStore {
  const dir = stateDir || resolveStateDirWithLegacyEnv();
  let s = stores.get(dir);
  if (!s) {
    s = new IdeaStore(dir);
    stores.set(dir, s);
  }
  return s;
}

/** Tests only. */
export function resetIdeaStoresForTests(): void {
  stores.clear();
}
