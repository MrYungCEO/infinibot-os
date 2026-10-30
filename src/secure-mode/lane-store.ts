/**
 * The Secure Mode data lane: kanban, documents and knowledge-graph nodes and
 * edges, each kept as an encrypted document in the SecureVault. Nothing here
 * imports the normal kanban/documents/relations stores or any Notion code, so
 * a secure write has no path to the normal lane or to a cloud sync.
 */

import { randomUUID } from "node:crypto";

import type { SecureVault } from "./vault.js";

export type SecureTaskStatus = "todo" | "in_progress" | "review" | "done" | "blocked";
export const SECURE_TASK_STATUSES: readonly SecureTaskStatus[] = [
  "todo",
  "in_progress",
  "review",
  "done",
  "blocked",
];
export type SecurePriority = "low" | "medium" | "high" | "urgent";

export interface SecureProject {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SecureTask {
  id: string;
  title: string;
  description?: string;
  status: SecureTaskStatus;
  priority?: SecurePriority;
  projectId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SecureDocMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  size: number;
}

export interface SecureDoc extends SecureDocMeta {
  content: string;
}

export interface SecureGraphNode {
  id: string;
  label: string;
  kind: string;
  summary?: string;
  createdAt: number;
  /** Set on nodes copied in by the one-time seed. */
  seeded?: boolean;
}

export interface SecureGraphEdge {
  id: string;
  source: string;
  target: string;
  rel: string;
  seeded?: boolean;
}

interface KanbanDoc {
  projects: SecureProject[];
  tasks: SecureTask[];
}
interface DocsIndex {
  docs: SecureDocMeta[];
}
interface GraphDoc {
  nodes: SecureGraphNode[];
  edges: SecureGraphEdge[];
  seededAt?: number;
}

const GRAPH_KINDS = new Set([
  "project",
  "task",
  "note",
  "person",
  "client",
  "decision",
  "issue",
  "report",
  "content",
  "idea",
  "product",
  "opportunity",
]);

export class SecureLaneError extends Error {
  readonly code = "INVALID_REQUEST";
}

function str(v: unknown, max = 10_000): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

function sid(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export class SecureLaneStore {
  constructor(
    private readonly vault: SecureVault,
    private readonly now: () => number = Date.now,
  ) {}

  // ── kanban ──────────────────────────────────────────────────────────────
  private kanban(): KanbanDoc {
    const d = this.vault.readJson<KanbanDoc>("kanban", { projects: [], tasks: [] });
    return { projects: d.projects ?? [], tasks: d.tasks ?? [] };
  }

  listKanban(): KanbanDoc {
    return this.kanban();
  }

  createProject(input: { name?: unknown; description?: unknown }): SecureProject {
    const name = str(input.name, 200);
    if (!name) throw new SecureLaneError("project name is required");
    const d = this.kanban();
    const t = this.now();
    const p: SecureProject = {
      id: sid("sp"),
      name,
      description: str(input.description),
      createdAt: t,
      updatedAt: t,
    };
    d.projects.push(p);
    this.vault.writeJson("kanban", d);
    return p;
  }

  findProjectByName(name: string): SecureProject | undefined {
    const n = name.trim().toLowerCase();
    return this.kanban().projects.find((p) => p.name.toLowerCase() === n);
  }

  deleteProject(id: string): boolean {
    const d = this.kanban();
    const before = d.projects.length;
    d.projects = d.projects.filter((p) => p.id !== id);
    if (d.projects.length === before) return false;
    d.tasks = d.tasks.map((t) => (t.projectId === id ? { ...t, projectId: undefined } : t));
    this.vault.writeJson("kanban", d);
    return true;
  }

  createTask(input: {
    title?: unknown;
    description?: unknown;
    status?: unknown;
    priority?: unknown;
    projectId?: unknown;
  }): SecureTask {
    const title = str(input.title, 500);
    if (!title) throw new SecureLaneError("task title is required");
    const d = this.kanban();
    const projectId = str(input.projectId, 100);
    if (projectId && !d.projects.some((p) => p.id === projectId)) {
      throw new SecureLaneError(`unknown secure project ${projectId}`);
    }
    const t = this.now();
    const task: SecureTask = {
      id: sid("st"),
      title,
      description: str(input.description),
      status: normalizeStatus(input.status) ?? "todo",
      priority: normalizePriority(input.priority),
      projectId,
      createdAt: t,
      updatedAt: t,
    };
    d.tasks.push(task);
    this.vault.writeJson("kanban", d);
    return task;
  }

  updateTask(id: string, patch: Record<string, unknown>): SecureTask {
    const d = this.kanban();
    const idx = d.tasks.findIndex((t) => t.id === id);
    if (idx < 0) throw new SecureLaneError(`unknown secure task ${id}`);
    const cur = d.tasks[idx];
    const next: SecureTask = { ...cur, updatedAt: this.now() };
    if (patch.title !== undefined) {
      const title = str(patch.title, 500);
      if (!title) throw new SecureLaneError("task title cannot be empty");
      next.title = title;
    }
    if (patch.description !== undefined) next.description = str(patch.description);
    if (patch.status !== undefined) {
      const s = normalizeStatus(patch.status);
      if (!s) throw new SecureLaneError(`status must be one of ${SECURE_TASK_STATUSES.join(", ")}`);
      next.status = s;
    }
    if (patch.priority !== undefined) next.priority = normalizePriority(patch.priority);
    if (patch.projectId !== undefined) {
      const pid = str(patch.projectId, 100);
      if (pid && !d.projects.some((p) => p.id === pid))
        throw new SecureLaneError(`unknown secure project ${pid}`);
      next.projectId = pid;
    }
    d.tasks[idx] = next;
    this.vault.writeJson("kanban", d);
    return next;
  }

  deleteTask(id: string): boolean {
    const d = this.kanban();
    const before = d.tasks.length;
    d.tasks = d.tasks.filter((t) => t.id !== id);
    if (d.tasks.length === before) return false;
    this.vault.writeJson("kanban", d);
    return true;
  }

  // ── documents ──────────────────────────────────────────────────────────
  private docsIndex(): DocsIndex {
    const d = this.vault.readJson<DocsIndex>("docs-index", { docs: [] });
    return { docs: d.docs ?? [] };
  }

  listDocs(): SecureDocMeta[] {
    return this.docsIndex()
      .docs.slice()
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getDoc(id: string): SecureDoc | null {
    const meta = this.docsIndex().docs.find((d) => d.id === id);
    if (!meta) return null;
    const body = this.vault.readJson<{ content: string }>(`doc-${id}`, { content: "" });
    return { ...meta, content: body.content ?? "" };
  }

  createDoc(input: { title?: unknown; content?: unknown }): SecureDoc {
    const title = str(input.title, 300) ?? "Untitled";
    const content = typeof input.content === "string" ? input.content.slice(0, 2_000_000) : "";
    const t = this.now();
    const meta: SecureDocMeta = {
      id: sid("sd"),
      title,
      createdAt: t,
      updatedAt: t,
      size: content.length,
    };
    this.vault.writeJson(`doc-${meta.id}`, { content });
    const idx = this.docsIndex();
    idx.docs.push(meta);
    this.vault.writeJson("docs-index", idx);
    return { ...meta, content };
  }

  updateDoc(id: string, patch: { title?: unknown; content?: unknown }): SecureDoc {
    const idx = this.docsIndex();
    const i = idx.docs.findIndex((d) => d.id === id);
    if (i < 0) throw new SecureLaneError(`unknown secure document ${id}`);
    const meta = { ...idx.docs[i], updatedAt: this.now() };
    if (patch.title !== undefined) meta.title = str(patch.title, 300) ?? meta.title;
    let content =
      this.vault.readJson<{ content: string }>(`doc-${id}`, { content: "" }).content ?? "";
    if (typeof patch.content === "string") {
      content = patch.content.slice(0, 2_000_000);
      this.vault.writeJson(`doc-${id}`, { content });
    }
    meta.size = content.length;
    idx.docs[i] = meta;
    this.vault.writeJson("docs-index", idx);
    return { ...meta, content };
  }

  deleteDoc(id: string): boolean {
    const idx = this.docsIndex();
    const before = idx.docs.length;
    idx.docs = idx.docs.filter((d) => d.id !== id);
    if (idx.docs.length === before) return false;
    this.vault.writeJson("docs-index", idx);
    this.vault.remove(`doc-${id}`);
    return true;
  }

  // ── knowledge graph ────────────────────────────────────────────────────
  private graph(): GraphDoc {
    const d = this.vault.readJson<GraphDoc>("graph", { nodes: [], edges: [] });
    return { nodes: d.nodes ?? [], edges: d.edges ?? [], seededAt: d.seededAt };
  }

  graphMeta(): { nodes: number; edges: number; seededAt?: number } {
    const g = this.graph();
    return { nodes: g.nodes.length, edges: g.edges.length, seededAt: g.seededAt };
  }

  createNode(input: { label?: unknown; kind?: unknown; summary?: unknown }): SecureGraphNode {
    const label = str(input.label, 300);
    if (!label) throw new SecureLaneError("node label is required");
    const kindRaw = str(input.kind, 40)?.toLowerCase();
    const kind = kindRaw && GRAPH_KINDS.has(kindRaw) ? kindRaw : "note";
    const g = this.graph();
    const node: SecureGraphNode = {
      id: sid("sn"),
      label,
      kind,
      summary: str(input.summary, 4000),
      createdAt: this.now(),
    };
    g.nodes.push(node);
    this.vault.writeJson("graph", g);
    return node;
  }

  deleteNode(id: string): boolean {
    const g = this.graph();
    const before = g.nodes.length;
    g.nodes = g.nodes.filter((n) => n.id !== id);
    if (g.nodes.length === before) return false;
    g.edges = g.edges.filter((e) => e.source !== id && e.target !== id);
    this.vault.writeJson("graph", g);
    return true;
  }

  link(input: { source?: unknown; target?: unknown; rel?: unknown }): SecureGraphEdge {
    const source = str(input.source, 200);
    const target = str(input.target, 200);
    if (!source || !target) throw new SecureLaneError("source and target are required");
    if (source === target) throw new SecureLaneError("cannot link a node to itself");
    const known = this.knownNodeIds();
    for (const id of [source, target]) {
      if (!known.has(id)) throw new SecureLaneError(`unknown secure graph node ${id}`);
    }
    const g = this.graph();
    const rel = str(input.rel, 80) ?? "related";
    const existing = g.edges.find(
      (e) => e.source === source && e.target === target && e.rel === rel,
    );
    if (existing) return existing;
    const edge: SecureGraphEdge = { id: sid("se"), source, target, rel };
    g.edges.push(edge);
    this.vault.writeJson("graph", g);
    return edge;
  }

  unlink(id: string): boolean {
    const g = this.graph();
    const before = g.edges.length;
    g.edges = g.edges.filter((e) => e.id !== id);
    if (g.edges.length === before) return false;
    this.vault.writeJson("graph", g);
    return true;
  }

  private knownNodeIds(): Set<string> {
    const ids = new Set<string>();
    const k = this.kanban();
    for (const p of k.projects) ids.add(`secure:project:${p.id}`);
    for (const t of k.tasks) ids.add(`secure:task:${t.id}`);
    for (const d of this.docsIndex().docs) ids.add(`secure:doc:${d.id}`);
    for (const n of this.graph().nodes) ids.add(n.id);
    return ids;
  }

  /**
   * One-time copy of a normal-lane graph into the secure graph (explicit
   * owner action). Copies labels/kinds and edges only; refuses a second run.
   */
  seedFromSnapshot(snapshot: {
    nodes: Array<{ id: string; kind: string; label: string }>;
    edges: Array<{ source: string; target: string; rel: string }>;
  }): { nodes: number; edges: number; seededAt: number } {
    const g = this.graph();
    if (g.seededAt)
      throw new SecureLaneError("the secure graph was already seeded; seeding is one-time");
    const t = this.now();
    const idMap = new Map<string, string>();
    for (const n of snapshot.nodes) {
      const id = `seed:${n.id}`;
      idMap.set(n.id, id);
      g.nodes.push({
        id,
        label: String(n.label ?? n.id).slice(0, 300),
        kind: GRAPH_KINDS.has(n.kind) ? n.kind : "note",
        createdAt: t,
        seeded: true,
      });
    }
    let edges = 0;
    for (const e of snapshot.edges) {
      const source = idMap.get(e.source);
      const target = idMap.get(e.target);
      if (!source || !target || source === target) continue;
      g.edges.push({
        id: sid("se"),
        source,
        target,
        rel: String(e.rel ?? "related").slice(0, 80),
        seeded: true,
      });
      edges += 1;
    }
    g.seededAt = t;
    this.vault.writeJson("graph", g);
    return { nodes: snapshot.nodes.length, edges, seededAt: t };
  }

  /** Same shape as graph.global.snapshot so the KG renderer can draw it. */
  snapshot(): {
    generatedAt: number;
    nodes: Array<{
      id: string;
      kind: string;
      label: string;
      meta?: Record<string, unknown>;
      weight?: number;
    }>;
    edges: Array<{ source: string; target: string; rel: string; weight?: number }>;
    typeStats: Record<string, number>;
    kinds: string[];
    lane: "secure";
  } {
    const k = this.kanban();
    const docs = this.docsIndex().docs;
    const g = this.graph();
    const nodes: Array<{
      id: string;
      kind: string;
      label: string;
      meta?: Record<string, unknown>;
      weight?: number;
    }> = [];
    const edges: Array<{ source: string; target: string; rel: string; weight?: number }> = [];
    for (const p of k.projects) {
      nodes.push({
        id: `secure:project:${p.id}`,
        kind: "project",
        label: p.name,
        meta: { secure: true, description: p.description },
        weight: 0.9,
      });
    }
    for (const t of k.tasks) {
      const id = `secure:task:${t.id}`;
      nodes.push({
        id,
        kind: "task",
        label: t.title,
        meta: { secure: true, status: t.status, priority: t.priority },
        weight: 0.4,
      });
      if (t.projectId)
        edges.push({ source: `secure:project:${t.projectId}`, target: id, rel: "contains" });
    }
    for (const d of docs) {
      nodes.push({
        id: `secure:doc:${d.id}`,
        kind: "note",
        label: d.title,
        meta: { secure: true, doc: true, updatedAt: d.updatedAt },
        weight: 0.5,
      });
    }
    for (const n of g.nodes) {
      nodes.push({
        id: n.id,
        kind: n.kind,
        label: n.label,
        meta: { secure: true, summary: n.summary, seeded: n.seeded },
        weight: 0.5,
      });
    }
    this.addOcrFiles(nodes, edges);
    const ids = new Set(nodes.map((n) => n.id));
    for (const e of g.edges) {
      if (ids.has(e.source) && ids.has(e.target))
        edges.push({ source: e.source, target: e.target, rel: e.rel });
    }
    const typeStats: Record<string, number> = {};
    for (const n of nodes) typeStats[n.kind] = (typeStats[n.kind] ?? 0) + 1;
    return {
      generatedAt: this.now(),
      nodes,
      edges,
      typeStats,
      kinds: Object.keys(typeStats),
      lane: "secure",
    };
  }

  /**
   * Secure-lane uploads (Files page in Secure Mode, secure chat attachments)
   * as `file` nodes + their OCR entities as `topic` nodes. Read straight from
   * the vault's OCR registry — these never reach the normal graph.
   */
  private addOcrFiles(
    nodes: Array<{
      id: string;
      kind: string;
      label: string;
      meta?: Record<string, unknown>;
      weight?: number;
    }>,
    edges: Array<{ source: string; target: string; rel: string; weight?: number }>,
  ): void {
    type Entry = {
      id: string;
      name: string;
      ext: string;
      mime: string;
      status: string;
      summary?: string;
      pages?: number;
      confidence?: number | null;
      updatedAt: number;
      source?: { projectId?: string; sessionKey?: string; agentId?: string };
    };
    let entries: Entry[] = [];
    try {
      entries = Object.values(
        this.vault.readJson<{ entries?: Record<string, Entry> }>("ocr-registry", {}).entries ?? {},
      )
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 500);
    } catch {
      return;
    }
    const projectIds = new Set(this.kanban().projects.map((p) => p.id));
    const topics = new Map<string, { label: string; count: number }>();
    for (const e of entries) {
      const id = `secure:file:${e.id}`;
      const fileKind = e.mime.startsWith("image/")
        ? "image"
        : e.mime.startsWith("video/")
          ? "video"
          : "document";
      nodes.push({
        id,
        kind: "file",
        label: e.name,
        weight: 0.45,
        meta: {
          secure: true,
          fileId: e.id,
          lane: "secure",
          name: e.name,
          relPath: null,
          fileKind,
          status: e.status,
          mime: e.mime,
          summary: e.summary,
          pages: e.pages,
          confidence: e.confidence ?? null,
          projectId: e.source?.projectId,
        },
      });
      if (e.source?.projectId && projectIds.has(e.source.projectId)) {
        edges.push({
          source: id,
          target: `secure:project:${e.source.projectId}`,
          rel: "in project",
        });
      }
      if (e.status !== "done") continue;
      let ents: string[] = [];
      try {
        const sc = this.vault.readJson<{
          entities?: string[];
          analyses?: Array<{ findings?: Array<{ title?: string }> }>;
        } | null>(`ocr-sidecar-${e.id}`, null);
        ents = [
          ...(sc?.entities ?? []),
          ...(sc?.analyses ?? []).flatMap((a) => (a.findings ?? []).map((f) => f.title ?? "")),
        ];
      } catch {
        ents = [];
      }
      for (const raw of ents.slice(0, 12)) {
        const label = String(raw).replace(/\*\*/g, "").trim().slice(0, 80);
        const slug = label
          .toLowerCase()
          .replace(/[^\p{L}\p{N}]+/gu, "-")
          .replace(/^-|-$/g, "");
        if (!slug || slug.length < 2) continue;
        const tid = `secure:topic:${slug}`;
        const t = topics.get(tid) ?? { label, count: 0 };
        t.count++;
        topics.set(tid, t);
        edges.push({ source: id, target: tid, rel: "mentions" });
      }
    }
    for (const [tid, t] of [...topics.entries()].slice(0, 600)) {
      nodes.push({
        id: tid,
        kind: "topic",
        label: t.label,
        weight: 0.25 + Math.min(0.5, t.count * 0.1),
        meta: { secure: true, count: t.count },
      });
    }
  }

  counts(): { projects: number; tasks: number; docs: number; nodes: number; edges: number } {
    const k = this.kanban();
    const g = this.graph();
    return {
      projects: k.projects.length,
      tasks: k.tasks.length,
      docs: this.docsIndex().docs.length,
      nodes: g.nodes.length,
      edges: g.edges.length,
    };
  }
}

function normalizeStatus(v: unknown): SecureTaskStatus | undefined {
  if (typeof v !== "string") return undefined;
  const s = v
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  const alias: Record<string, SecureTaskStatus> = {
    backlog: "todo",
    to_do: "todo",
    open: "todo",
    doing: "in_progress",
    inprogress: "in_progress",
    in_review: "review",
    complete: "done",
    completed: "done",
  };
  const n = (alias[s] ?? s) as SecureTaskStatus;
  return SECURE_TASK_STATUSES.includes(n) ? n : undefined;
}

function normalizePriority(v: unknown): SecurePriority | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim().toLowerCase();
  return (["low", "medium", "high", "urgent"] as const).find((p) => p === s);
}
