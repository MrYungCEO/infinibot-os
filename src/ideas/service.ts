/**
 * Ideas service — the operations shared by the ideas.* / capture.* RPCs and
 * the `ideas` agent tool: create (with relation edges), link, promote, and
 * quick-capture save.
 *
 * Promotion and capture never re-implement another store: they call the
 * existing gateway RPCs in-process (kanban.tasks.create, kanban.projects.create,
 * notes.create) through `call`, so Notion mirroring, list caches and change
 * broadcasts behave exactly as when the board or Documents page writes.
 * Relation edges go to the objrel store (src/relations), which the knowledge
 * graph already reads.
 */

import fs from "node:fs";
import path from "node:path";

import { resolveStateDirWithLegacyEnv } from "../config/paths.js";
import type { CaptureDraft, CaptureKind } from "./capture.js";
import { broadcastIdeasChanged } from "./events.js";
import { linkedClientIds } from "./client-source.js";
import { describeDate } from "./date-parse.js";
import {
  defaultEntityLinker,
  syncClientLinks,
  syncProjectLinks,
  type EntityLinker,
} from "./project-links.js";
import { getIdeaStore, type IdeaStore } from "./store.js";
import {
  IDEA_PROMOTE_TARGETS,
  type Idea,
  type IdeaCreateParams,
  type IdeaPromoteTarget,
} from "./types.js";

/** Calls a gateway RPC in-process; resolves its payload or throws its error. */
export type GatewayCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export type RelationWriter = {
  link(edge: {
    fromType: string;
    fromId: string;
    edge: string;
    toType: string;
    toId: string;
    createdBy?: string;
  }): void;
  unlink(edge: { fromType: string; fromId: string; toType: string; toId: string }): void;
  linksFrom(
    fromType: string,
    fromId: string,
  ): Array<{ edge: string; toType: string; toId: string }>;
};

export type IdeaServiceDeps = {
  store?: IdeaStore;
  call?: GatewayCall;
  relations?: RelationWriter | null;
  /** relations.db pairs for the web project page; null disables. */
  entities?: EntityLinker | null;
  stateDir?: string;
};

/** In-process dispatch into the core gateway handler map (lazy: server-methods imports us). */
export function localGatewayCall(): GatewayCall {
  return async (method, params) => {
    const { coreGatewayHandlers } = await import("../gateway/server-methods.js");
    const handler = coreGatewayHandlers[method];
    if (!handler) throw new Error(`no gateway handler for ${method}`);
    return await new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const respond = (ok: boolean, payload?: unknown, error?: { message?: string }) => {
        if (settled) return;
        settled = true;
        if (ok) resolve(payload);
        else reject(new Error(error?.message ?? `${method} failed`));
      };
      Promise.resolve(
        handler({
          req: { type: "req", id: `ideas-${Date.now()}`, method, params } as never,
          params,
          client: null,
          isWebchatConnect: () => false,
          respond: respond as never,
          context: undefined as never,
        }),
      ).catch((err) =>
        respond(false, undefined, { message: err instanceof Error ? err.message : String(err) }),
      );
    });
  };
}

/** Relation edges through the objrel store; null-safe when better-sqlite3 is unavailable. */
export async function defaultRelationWriter(stateDir?: string): Promise<RelationWriter | null> {
  try {
    const { getRelationsStore } = await import("../relations/store.js");
    const store = getRelationsStore(stateDir);
    return {
      link: (e) => {
        store.create({
          ...e,
          createdBy: e.createdBy ?? "ideas",
          clientRequestId: `${e.fromType}:${e.fromId}:${e.edge}:${e.toType}:${e.toId}`,
        });
      },
      unlink: (e) => {
        for (const r of store.list({
          fromType: e.fromType,
          fromId: e.fromId,
          toType: e.toType,
          toId: e.toId,
        }))
          store.delete(r.id);
      },
      linksFrom: (fromType, fromId) =>
        store
          .list({ fromType, fromId })
          .map((r) => ({ edge: String(r.edge), toType: String(r.toType), toId: r.toId })),
    };
  } catch {
    return null;
  }
}

async function resolveDeps(deps: IdeaServiceDeps): Promise<{
  store: IdeaStore;
  call: GatewayCall;
  relations: RelationWriter | null;
  entities: EntityLinker | null;
}> {
  return {
    store: deps.store ?? getIdeaStore(deps.stateDir),
    call: deps.call ?? localGatewayCall(),
    relations:
      deps.relations === undefined ? await defaultRelationWriter(deps.stateDir) : deps.relations,
    entities:
      deps.entities === undefined ? await defaultEntityLinker(deps.stateDir) : deps.entities,
  };
}

function safeLink(
  relations: RelationWriter | null,
  e: Parameters<RelationWriter["link"]>[0],
): void {
  try {
    relations?.link(e);
  } catch {
    /* edges are an index, never a reason to fail the write */
  }
}

/** Create an idea and write its "about project" edges. */
export async function createIdea(
  p: IdeaCreateParams,
  deps: IdeaServiceDeps = {},
): Promise<{ idea: Idea; created: boolean }> {
  const { store, relations, entities } = await resolveDeps({
    ...deps,
    call: deps.call ?? (async () => undefined),
  });
  const res = store.create(p);
  if (res.created) {
    syncProjectLinks(
      {
        kind: "idea",
        id: res.idea.id,
        before: [],
        after: res.idea.projectIds,
        createdBy: p.createdBy,
      },
      { objrel: relations, entity: entities },
    );
    if (res.idea.clientIds?.length)
      syncClientLinks(
        {
          kind: "idea",
          id: res.idea.id,
          before: [],
          after: res.idea.clientIds,
          createdBy: p.createdBy,
        },
        { objrel: relations, entity: entities },
      );
    broadcastIdeasChanged({ op: "create", id: res.idea.id, title: res.idea.title });
  }
  return res;
}

export type LinkKind = "project" | "task" | "doc";

/** Link / unlink an idea to a board project, task or document (ids + relation edge). */
export async function linkIdea(
  id: string,
  kind: LinkKind,
  targetId: string,
  opts: { unlink?: boolean } = {},
  deps: IdeaServiceDeps = {},
): Promise<Idea> {
  const { store, relations, entities } = await resolveDeps({
    ...deps,
    call: deps.call ?? (async () => undefined),
  });
  const idea = store.get(id);
  if (!idea) throw new Error(`idea ${id} not found`);
  if (kind === "project") {
    try {
      if (opts.unlink) entities?.unlink({ type: "project", id: targetId }, { type: "idea", id });
      else entities?.link({ type: "project", id: targetId }, { type: "idea", id });
    } catch {
      /* index only */
    }
  }
  const field = kind === "project" ? "projectIds" : kind === "task" ? "taskIds" : "docIds";
  const cur = new Set(idea[field]);
  if (opts.unlink) cur.delete(targetId);
  else cur.add(targetId);
  const updated = store.update(id, { [field]: [...cur] });
  const toType = kind === "doc" ? "note" : kind;
  try {
    if (opts.unlink) relations?.unlink({ fromType: "idea", fromId: id, toType, toId: targetId });
    else
      safeLink(relations, {
        fromType: "idea",
        fromId: id,
        edge: kind === "project" ? "idea_about_project" : "relates_to",
        toType,
        toId: targetId,
      });
  } catch {
    /* index only */
  }
  broadcastIdeasChanged({ op: "link", id, title: idea.title });
  return updated!;
}

export type PromoteResult = {
  idea: Idea;
  target: { kind: IdeaPromoteTarget; id: string; title: string; payload: unknown };
};

function idOf(payload: unknown): string {
  const p = payload as {
    id?: unknown;
    note?: { id?: unknown };
    project?: { id?: unknown };
    task?: { id?: unknown };
  } | null;
  const id = p?.id ?? p?.note?.id ?? p?.project?.id ?? p?.task?.id;
  if (typeof id !== "string" || !id) throw new Error("the target store returned no id");
  return id;
}

/**
 * Promote an idea into a board task, a board project or a Documents note.
 * The idea stays (status "promoted", promotedTo + the new id in its links), so
 * promotion is visible both ways. Promoting twice to the same kind returns the
 * first target instead of creating a duplicate.
 */
export async function promoteIdea(
  id: string,
  to: IdeaPromoteTarget,
  opts: { projectId?: string; title?: string; priority?: string; createdBy?: string } = {},
  deps: IdeaServiceDeps = {},
): Promise<PromoteResult> {
  if (!(IDEA_PROMOTE_TARGETS as readonly string[]).includes(to)) {
    throw new Error(`to must be one of ${IDEA_PROMOTE_TARGETS.join(", ")}`);
  }
  const { store, call, relations } = await resolveDeps(deps);
  const idea = store.get(id);
  if (!idea) throw new Error(`idea ${id} not found`);
  if (idea.promotedTo && idea.promotedTo.kind === to) {
    return { idea, target: { kind: to, id: idea.promotedTo.id, title: idea.title, payload: null } };
  }
  const title = (opts.title?.trim() || idea.title).slice(0, 200);
  const tagLine = idea.tags.length ? `\n\nTags: ${idea.tags.map((t) => `#${t}`).join(" ")}` : "";
  const origin = `\n\n— Promoted from idea “${idea.title}” (${idea.id}).`;
  const projectId = opts.projectId?.trim() || idea.projectIds[0];
  let payload: unknown;
  if (to === "task") {
    payload = await call("kanban.tasks.create", {
      title,
      description: `${idea.body}${tagLine}${origin}`.trim(),
      status: "todo",
      priority: opts.priority ?? "medium",
      ...(projectId ? { projectId } : {}),
    });
  } else if (to === "project") {
    payload = await call("kanban.projects.create", {
      name: title,
      description: `${idea.body}${tagLine}${origin}`.trim(),
    });
  } else {
    payload = await call("notes.create", {
      name: title,
      body: `${idea.body || title}${origin}`,
      tags: idea.tags,
      category: "idea",
      ...(projectId ? { projectId } : {}),
    });
  }
  const targetId = idOf(payload);
  const at = new Date().toISOString();
  const updated = store.update(id, {
    status: "promoted",
    promotedTo: { kind: to, id: targetId, at },
    ...(to === "task" ? { taskIds: [...new Set([...idea.taskIds, targetId])] } : {}),
    ...(to === "project" ? { projectIds: [...new Set([...idea.projectIds, targetId])] } : {}),
    ...(to === "document" ? { docIds: [...new Set([...idea.docIds, targetId])] } : {}),
  })!;
  safeLink(relations, {
    fromType: "idea",
    fromId: id,
    edge:
      to === "task"
        ? "idea_becomes_task"
        : to === "project"
          ? "idea_becomes_project"
          : "idea_becomes_note",
    toType: to === "document" ? "note" : to,
    toId: targetId,
    createdBy: opts.createdBy,
  });
  if (to === "task" && projectId) {
    safeLink(relations, {
      fromType: "project",
      fromId: projectId,
      edge: "project_has_task",
      toType: "task",
      toId: targetId,
      createdBy: "ideas",
    });
  }
  broadcastIdeasChanged({ op: "promote", id, title: idea.title });
  return { idea: updated, target: { kind: to, id: targetId, title, payload } };
}

// ── quick capture save ────────────────────────────────────────────────────────

export type CaptureSaved = {
  kind: CaptureKind;
  id: string;
  title: string;
  /** True when this clientRequestId was already saved (offline retry). */
  duplicate: boolean;
  /** Where the item lives, for the "open" link on the success toast. */
  open: { kind: "note" | "task" | "project" | "idea"; id: string; projectId?: string };
};

type CaptureLog = Record<
  string,
  {
    kind: CaptureKind;
    id: string;
    title: string;
    at: string;
    projectId?: string;
    clientId?: string;
  }
>;

const MAX_CAPTURE_LOG = 1_000;

function captureLogPath(stateDir?: string): string {
  return path.join(stateDir || resolveStateDirWithLegacyEnv(), "ideas", "capture-log.json");
}

function readCaptureLog(file: string): CaptureLog {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as CaptureLog;
  } catch {
    return {};
  }
}

function writeCaptureLog(file: string, log: CaptureLog): void {
  const keys = Object.keys(log);
  if (keys.length > MAX_CAPTURE_LOG)
    for (const k of keys.slice(0, keys.length - MAX_CAPTURE_LOG)) delete log[k];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(log));
  fs.renameSync(tmp, file);
}

function draftBody(d: CaptureDraft): string {
  return (d.body || d.transcript || d.title).trim();
}

/**
 * Save a confirmed capture draft into the right store. `clientRequestId` makes
 * it idempotent: the phone queues captures while offline and retries; a retry
 * of a save that already landed returns the first item (duplicate: true).
 */
export async function saveCapture(
  draft: CaptureDraft,
  clientRequestId: string | undefined,
  deps: IdeaServiceDeps = {},
): Promise<CaptureSaved> {
  const title = draft.title?.trim();
  if (!title) throw new Error("title is required");
  const key = clientRequestId?.trim();
  const logFile = captureLogPath(deps.stateDir);
  if (key) {
    const hit = readCaptureLog(logFile)[key];
    if (hit) {
      return {
        kind: hit.kind,
        id: hit.id,
        title: hit.title,
        duplicate: true,
        open: {
          kind: hit.kind === "log" ? "note" : (hit.kind as CaptureSaved["open"]["kind"]),
          id: hit.id,
          ...(hit.projectId ? { projectId: hit.projectId } : {}),
        },
      };
    }
  }
  const { call, relations, entities } = await resolveDeps(deps);
  const tags = Array.isArray(draft.tags) ? draft.tags.filter((t) => typeof t === "string") : [];
  let id: string;
  let openKind: CaptureSaved["open"]["kind"];
  let projectId: string | undefined = draft.projectId || undefined;
  const clientId: string | undefined = draft.clientId?.trim() || undefined;
  const due =
    draft.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(draft.dueDate) ? draft.dueDate : undefined;
  const dueTime =
    due && draft.dueTime && /^\d{2}:\d{2}$/.test(draft.dueTime) ? draft.dueTime : undefined;
  /** "2026-10-17" / "2026-10-17T15:00" — how ideas and notes store their date. */
  const when = due ? (dueTime ? `${due}T${dueTime}` : due) : undefined;
  switch (draft.kind) {
    case "idea": {
      const res = await createIdea(
        {
          title,
          body: draftBody(draft),
          tags,
          source: "voice",
          projectIds: projectId ? [projectId] : [],
          clientIds: clientId ? [clientId] : [],
          ...(when ? { reviewOn: when } : {}),
          createdBy: "owner",
          ...(key ? { clientRequestId: key } : {}),
        },
        { ...deps, relations, entities },
      );
      id = res.idea.id;
      openKind = "idea";
      break;
    }
    case "task": {
      const dueLine = due ? `\n\nDue: ${describeDate(due, dueTime)}` : "";
      const payload = await call("kanban.tasks.create", {
        title,
        description: `${draftBody(draft)}${dueLine}${tags.length ? `\n\nTags: ${tags.map((t) => `#${t}`).join(" ")}` : ""}`,
        status: "todo",
        priority: draft.priority ?? "medium",
        ...(projectId ? { projectId } : {}),
        ...(due ? { dueDate: due } : {}),
        ...(dueTime ? { dueTime } : {}),
        ...(clientId ? { clientId } : {}),
      });
      id = idOf(payload);
      openKind = "task";
      break;
    }
    case "project": {
      const payload = await call("kanban.projects.create", {
        name: title,
        description: draftBody(draft),
        ...(due ? { dueDate: due } : {}),
        ...(clientId ? { clientId } : {}),
      });
      id = idOf(payload);
      projectId = id;
      openKind = "project";
      break;
    }
    case "note":
    case "log": {
      const payload = await call("notes.create", {
        name: title,
        body: draftBody(draft),
        tags: draft.kind === "log" && !tags.includes("log") ? ["log", ...tags] : tags,
        category: draft.kind === "log" ? "log" : "voice-note",
        ...(projectId ? { projectId } : {}),
        ...(clientId ? { clientId } : {}),
        ...(when ? { reviewOn: when } : {}),
      });
      id = idOf(payload);
      openKind = "note";
      break;
    }
    default:
      throw new Error(`unknown capture kind ${String((draft as { kind?: unknown }).kind)}`);
  }
  if (projectId && draft.kind !== "project") {
    syncProjectLinks(
      {
        kind: draft.kind === "log" ? "note" : draft.kind,
        id,
        before: [],
        after: [projectId],
        createdBy: "capture",
      },
      { objrel: relations, entity: entities },
    );
  }
  if (clientId) {
    syncClientLinks(
      {
        kind: draft.kind === "log" ? "note" : draft.kind,
        id,
        before: [],
        after: [clientId],
        createdBy: "capture",
      },
      { objrel: relations, entity: entities },
    );
  }
  if (key) {
    const log = readCaptureLog(logFile);
    log[key] = {
      kind: draft.kind,
      id,
      title,
      at: new Date().toISOString(),
      ...(projectId ? { projectId } : {}),
      ...(clientId ? { clientId } : {}),
    };
    try {
      writeCaptureLog(logFile, log);
    } catch {
      /* idempotency is best-effort; the item itself is saved */
    }
  }
  return {
    kind: draft.kind,
    id,
    title,
    duplicate: false,
    open: { kind: openKind, id, ...(projectId ? { projectId } : {}) },
  };
}

// ── change an item's project ─────────────────────────────────────────────────

export type AssignProjectKind = "idea" | "note" | "task";

export type AssignProjectResult = {
  kind: AssignProjectKind;
  id: string;
  projectId: string | null;
  previous: string[];
};

/**
 * Set (or clear, projectId null) the board project of an idea, note or task,
 * through the owning store, and bring both relation indexes in line so the
 * item moves on the project page, the knowledge graph and ideas.get.
 * Ideas are single-project here: the picker replaces the list.
 */
export async function assignProject(
  kind: AssignProjectKind,
  id: string,
  projectId: string | null,
  deps: IdeaServiceDeps & { previousProjectId?: string | null } = {},
): Promise<AssignProjectResult> {
  const { store, call, relations, entities } = await resolveDeps(deps);
  const next = projectId?.trim() || null;
  let previous: string[] = [];
  if (kind === "idea") {
    const idea = store.get(id);
    if (!idea) throw new Error(`idea ${id} not found`);
    previous = [...idea.projectIds];
    store.update(id, { projectIds: next ? [next] : [] });
    broadcastIdeasChanged({ op: "link", id, title: idea.title });
  } else if (kind === "note") {
    try {
      const n = (await call("notes.get", { id })) as { projectId?: unknown } | null;
      if (typeof n?.projectId === "string" && n.projectId) previous = [n.projectId];
    } catch {
      /* fall back to the caller's previousProjectId */
    }
    // notes.update keeps the old value for undefined; "" clears it.
    await call("notes.update", { id, projectId: next ?? "" });
  } else if (kind === "task") {
    await call("kanban.tasks.update", { id, patch: { projectId: next } });
  } else {
    throw new Error("kind must be idea | note | task");
  }
  if (!previous.length && deps.previousProjectId) previous = [deps.previousProjectId];
  syncProjectLinks(
    { kind, id, before: previous, after: next ? [next] : [], createdBy: "owner" },
    { objrel: relations, entity: entities },
  );
  return { kind, id, projectId: next, previous };
}

// ── change an item's client ──────────────────────────────────────────────────

export type AssignClientKind = "idea" | "note" | "task" | "project";

export type AssignClientResult = {
  kind: AssignClientKind;
  id: string;
  clientId: string | null;
  previous: string[];
};

/**
 * Set (or clear, clientId null) the CRM client of an idea, note, task or
 * project. Ideas and notes keep it on the item (clientIds / clientId); tasks
 * and projects keep it in the relation indexes and, when Notion is the board,
 * in the task's "Customer" / the project's "Clients" relation. Either way the
 * client page and the knowledge graph see the item move.
 */
export async function assignClient(
  kind: AssignClientKind,
  id: string,
  clientId: string | null,
  deps: IdeaServiceDeps & { previousClientId?: string | null } = {},
): Promise<AssignClientResult> {
  const { store, call, relations, entities } = await resolveDeps(deps);
  const next = clientId?.trim() || null;
  let previous: string[] = [];
  if (kind === "idea") {
    const idea = store.get(id);
    if (!idea) throw new Error(`idea ${id} not found`);
    previous = [...(idea.clientIds ?? [])];
    store.update(id, { clientIds: next ? [next] : [] });
    broadcastIdeasChanged({ op: "link", id, title: idea.title });
  } else if (kind === "note") {
    try {
      const n = (await call("notes.get", { id })) as { clientId?: unknown } | null;
      if (typeof n?.clientId === "string" && n.clientId) previous = [n.clientId];
    } catch {
      /* fall back to the relation index */
    }
    // notes.update keeps the old value for undefined; "" clears it.
    await call("notes.update", { id, clientId: next ?? "" });
  } else if (kind === "task" || kind === "project") {
    previous = await linkedClientIds(kind, id, deps.stateDir).catch(() => []);
    const method = kind === "task" ? "kanban.tasks.update" : "kanban.projects.update";
    await call(method, {
      id,
      patch: { clientId: next, previousClientIds: previous },
    });
  } else {
    throw new Error("kind must be idea | note | task | project");
  }
  if (!previous.length) {
    if (deps.previousClientId) previous = [deps.previousClientId];
    else if (kind === "note" || kind === "idea")
      previous = await linkedClientIds(kind, id, deps.stateDir).catch(() => []);
  }
  syncClientLinks(
    { kind, id, before: previous, after: next ? [next] : [], createdBy: "owner" },
    { objrel: relations, entity: entities },
  );
  return { kind, id, clientId: next, previous };
}
