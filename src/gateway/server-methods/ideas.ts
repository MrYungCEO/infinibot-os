/**
 * Ideas + quick capture RPCs.
 *
 *   ideas.list     (read)  { query?, status?, tag?, projectId?, limit?, since? } → { ideas, counts, tags }
 *   ideas.get      (read)  { id } → { idea, relations }
 *   ideas.create   (write) { title, body?, tags?, source?, status?, projectIds?, taskIds?, docIds?, clientRequestId? }
 *   ideas.update   (write) { id, patch } or { id, ...fields }
 *   ideas.delete   (write) { id }
 *   ideas.link     (write) { id, kind: project|task|doc, targetId, unlink? }
 *   ideas.promote  (write) { id, to: task|project|document, projectId?, title?, priority? }
 *
 *   capture.structure (write — calls a model) { kind, transcript } → { draft }
 *   capture.save      (write) { draft, clientRequestId? } → saved item (idempotent per key)
 *   capture.assignProject (write) { kind: idea|note|task, id, projectId|null } → { kind, id, projectId }
 *   capture.assignClient  (write) { kind: idea|note|task|project, id, clientId|null } → { kind, id, clientId }
 *   capture.clients       (read)  {} → { clients: [{ id, name, aliases, email, status, updatedAt }], agencyId }
 *   capture.clientForProject (read) { projectId } → { client | null }
 *
 * capture.structure also takes { timeZone? } (the phone's IANA zone; else the
 * configured user timezone, else the host's) and returns dueDate / dueTime /
 * dateSuggestion and clientId / clientSuggestion next to the project fields.
 *
 * The store is local-first (<stateDir>/ideas/ideas.json, src/ideas/store.ts);
 * promotion and capture go through the existing kanban / notes RPCs in-process
 * (src/ideas/service.ts). Every write broadcasts `ideas.changed`.
 */

import { loadConfig } from "../../config/config.js";
import type { CaptureClient } from "../../ideas/client-match.js";
import {
  activeAgencyId,
  invalidateCaptureClients,
  loadCaptureClients,
  projectClientResolver,
} from "../../ideas/client-source.js";
import { hostTimeZone, isHm, isIsoDate, isValidTimeZone } from "../../ideas/date-parse.js";
import {
  CAPTURE_KINDS,
  defaultCaptureComplete,
  isCaptureKind,
  structureCapture,
  type CaptureComplete,
  type CaptureDraft,
  type CaptureProject,
} from "../../ideas/capture.js";
import { broadcastIdeasChanged } from "../../ideas/events.js";
import {
  assignClient,
  assignProject,
  createIdea,
  defaultRelationWriter,
  linkIdea,
  localGatewayCall,
  promoteIdea,
  saveCapture,
  type LinkKind,
} from "../../ideas/service.js";
import {
  defaultEntityLinker,
  syncClientLinks,
  syncProjectLinks,
} from "../../ideas/project-links.js";
import { cleanWhen, getIdeaStore, IdeaValidationError, isIdeaStatus } from "../../ideas/store.js";
import {
  IDEA_PROMOTE_TARGETS,
  IDEA_STATUSES,
  type IdeaPatch,
  type IdeaPromoteTarget,
  type IdeaStatus,
} from "../../ideas/types.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { coerceString } from "../../shared/text/coerce.js";

type Respond = GatewayRequestHandlerOptions["respond"];

function bad(respond: Respond, message: string): void {
  respond(false, undefined, { code: "INVALID_REQUEST", message });
}

function fail(respond: Respond, err: unknown): void {
  if (err instanceof IdeaValidationError) {
    bad(respond, err.message);
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  respond(false, undefined, {
    code: /not found/i.test(message) ? "NOT_FOUND" : "INTERNAL_ERROR",
    message,
  });
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

function strList(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string")
    return v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return undefined;
}

/**
 * Every active board project for capture's project association: id, name,
 * parent (sub-projects), a short description and recency. Archived projects
 * are excluded (kanban.projects.list drops them by default).
 */
export function toCaptureProjects(raw: unknown): CaptureProject[] {
  const list = Array.isArray(raw)
    ? raw
    : ((raw as { projects?: unknown[] } | null)?.projects ?? []);
  const rows = (list as Array<Record<string, unknown>>).filter((p) => p && typeof p === "object");
  const names = new Map<string, string>();
  for (const p of rows) {
    const id = coerceString(p.id);
    const name = coerceString(p.name ?? p.title).trim();
    if (id && name) names.set(id, name);
  }
  const out: CaptureProject[] = [];
  for (const p of rows) {
    const id = coerceString(p.id);
    const name = names.get(id);
    if (!id || !name || p.archived === true) continue;
    const parentId = typeof p.parentProjectId === "string" ? p.parentProjectId : undefined;
    const description =
      typeof p.description === "string"
        ? p.description.replace(/\s+/g, " ").trim().slice(0, 240)
        : "";
    const aliases = Array.isArray(p.aliases)
      ? (p.aliases as unknown[]).filter((a): a is string => typeof a === "string" && !!a.trim())
      : [];
    const updatedAt =
      typeof p.updatedAt === "number" || typeof p.updatedAt === "string"
        ? (p.updatedAt as number | string)
        : undefined;
    out.push({
      id,
      name,
      ...(description ? { description } : {}),
      ...(aliases.length ? { aliases } : {}),
      ...(parentId
        ? { parentId, ...(names.get(parentId) ? { parentName: names.get(parentId) } : {}) }
        : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      ...(Array.isArray(p.clientNotionIds) && p.clientNotionIds.length
        ? {
            clientNotionIds: (p.clientNotionIds as unknown[]).filter(
              (x): x is string => typeof x === "string",
            ),
          }
        : {}),
    });
  }
  return out;
}

/** The owner's timezone: what the phone said, else agents.defaults.userTimezone, else the host's. */
export function captureTimeZone(hint: unknown): string {
  if (isValidTimeZone(hint)) return hint;
  try {
    const tz = loadConfig().agents?.defaults?.userTimezone;
    if (isValidTimeZone(tz)) return tz;
  } catch {
    /* config unavailable */
  }
  return hostTimeZone();
}

async function captureProjects(): Promise<CaptureProject[]> {
  try {
    return toCaptureProjects(await localGatewayCall()("kanban.projects.list", {}));
  } catch {
    return [];
  }
}

/** Tests swap the model / project / client sources. */
export const ideasRpcDeps: {
  complete: () => Promise<CaptureComplete | null>;
  projects: () => Promise<CaptureProject[]>;
  clients: () => Promise<CaptureClient[]>;
  clientResolver: (
    clients: CaptureClient[],
    projects: CaptureProject[],
  ) => Promise<(projectId: string) => CaptureClient | undefined>;
} = {
  complete: () => defaultCaptureComplete("main"),
  projects: captureProjects,
  clients: async () => (await loadCaptureClients()).clients,
  clientResolver: (clients, projects) => projectClientResolver(clients, projects),
};

/** Slim client rows for the phone's client picker. */
function pickerClient(c: CaptureClient) {
  return {
    id: c.id,
    name: c.name,
    ...(c.aliases?.length ? { aliases: c.aliases } : {}),
    ...(c.email ? { email: c.email } : {}),
    ...(c.status ? { status: c.status } : {}),
    ...(c.description ? { about: c.description.slice(0, 120) } : {}),
    ...(c.notionPageId ? { notionPageId: c.notionPageId } : {}),
    ...(c.updatedAt !== undefined ? { updatedAt: c.updatedAt } : {}),
  };
}

/** A real date / time from the phone, else undefined. */
const dateParam = (v: unknown) => (isIsoDate(v) ? v : undefined);
const timeParam = (v: unknown) => (isHm(v) ? v : undefined);

export const ideasHandlers: GatewayRequestHandlers = {
  "ideas.list": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const statuses = strList(p.status)?.filter(isIdeaStatus) as IdeaStatus[] | undefined;
      const store = getIdeaStore();
      const projectId = str(p.projectId);
      const limit = typeof p.limit === "number" ? p.limit : undefined;
      let ideas = store.list({
        query: str(p.query),
        status: statuses?.length ? statuses : undefined,
        tag: str(p.tag),
        clientId: str(p.clientId),
        since: typeof p.since === "number" || typeof p.since === "string" ? p.since : undefined,
        limit: projectId ? 1000 : limit,
      });
      if (projectId) {
        ideas = ideas.filter((i) => i.projectIds.includes(projectId));
        if (limit) ideas = ideas.slice(0, limit);
      }
      respond(true, { ideas, counts: store.counts(), tags: store.tags(), statuses: IDEA_STATUSES });
    } catch (err) {
      fail(respond, err);
    }
  },

  "ideas.get": async ({ params, respond }) => {
    try {
      const id = str((params as { id?: unknown })?.id);
      if (!id) return bad(respond, "id is required");
      const idea = getIdeaStore().get(id);
      if (!idea)
        return respond(false, undefined, { code: "NOT_FOUND", message: `idea ${id} not found` });
      let relations: Array<{ edge: string; toType: string; toId: string }> = [];
      try {
        relations = (await defaultRelationWriter())?.linksFrom("idea", id) ?? [];
      } catch {
        /* relations are optional */
      }
      respond(true, { idea, relations });
    } catch (err) {
      fail(respond, err);
    }
  },

  "ideas.create": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const title = str(p.title);
      if (!title) return bad(respond, "title is required");
      const res = await createIdea({
        title,
        body: typeof p.body === "string" ? p.body : "",
        tags: strList(p.tags),
        source: (str(p.source) as never) ?? "web",
        status: isIdeaStatus(p.status) ? p.status : undefined,
        projectIds: strList(p.projectIds),
        taskIds: strList(p.taskIds),
        docIds: strList(p.docIds),
        clientIds: strList(p.clientIds) ?? (str(p.clientId) ? [str(p.clientId)!] : undefined),
        reviewOn: cleanWhen(p.reviewOn),
        createdBy: str(p.createdBy) ?? "owner",
        clientRequestId: str(p.clientRequestId),
      });
      respond(true, { idea: res.idea, created: res.created });
    } catch (err) {
      fail(respond, err);
    }
  },

  "ideas.update": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const id = str(p.id);
      if (!id) return bad(respond, "id is required");
      const src = (p.patch && typeof p.patch === "object" ? p.patch : p) as Record<string, unknown>;
      const patch: IdeaPatch = {};
      if (src.title !== undefined) patch.title = coerceString(src.title);
      if (src.body !== undefined) patch.body = coerceString(src.body);
      if (src.tags !== undefined) patch.tags = strList(src.tags) ?? [];
      if (src.status !== undefined) {
        if (!isIdeaStatus(src.status))
          return bad(respond, `status must be one of ${IDEA_STATUSES.join(", ")}`);
        patch.status = src.status;
      }
      if (src.projectIds !== undefined) patch.projectIds = strList(src.projectIds) ?? [];
      if (src.taskIds !== undefined) patch.taskIds = strList(src.taskIds) ?? [];
      if (src.docIds !== undefined) patch.docIds = strList(src.docIds) ?? [];
      if (src.clientIds !== undefined) patch.clientIds = strList(src.clientIds) ?? [];
      if (src.reviewOn !== undefined)
        patch.reviewOn =
          src.reviewOn === null || src.reviewOn === "" ? null : coerceString(src.reviewOn);
      const prior = getIdeaStore().get(id);
      const before = prior?.projectIds ?? [];
      const clientsBefore = prior?.clientIds ?? [];
      const idea = getIdeaStore().update(id, patch);
      if (!idea)
        return respond(false, undefined, { code: "NOT_FOUND", message: `idea ${id} not found` });
      if (patch.projectIds || patch.clientIds) {
        const linkers = {
          objrel: await defaultRelationWriter().catch(() => null),
          entity: await defaultEntityLinker().catch(() => null),
        };
        if (patch.projectIds)
          syncProjectLinks(
            { kind: "idea", id, before, after: idea.projectIds, createdBy: "owner" },
            linkers,
          );
        if (patch.clientIds)
          syncClientLinks(
            {
              kind: "idea",
              id,
              before: clientsBefore,
              after: idea.clientIds ?? [],
              createdBy: "owner",
            },
            linkers,
          );
      }
      broadcastIdeasChanged({ op: "update", id, title: idea.title });
      respond(true, { idea });
    } catch (err) {
      fail(respond, err);
    }
  },

  "ideas.delete": async ({ params, respond }) => {
    try {
      const id = str((params as { id?: unknown })?.id);
      if (!id) return bad(respond, "id is required");
      if (!getIdeaStore().delete(id))
        return respond(false, undefined, { code: "NOT_FOUND", message: `idea ${id} not found` });
      try {
        const rel = await import("../../relations/store.js");
        rel.getRelationsStore().deleteMatch({ fromType: "idea", fromId: id });
      } catch {
        /* edges are an index */
      }
      broadcastIdeasChanged({ op: "delete", id });
      respond(true, { deleted: true, id });
    } catch (err) {
      fail(respond, err);
    }
  },

  "ideas.link": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const id = str(p.id);
      const kind = str(p.kind) as LinkKind | undefined;
      const targetId = str(p.targetId);
      if (!id || !targetId) return bad(respond, "id and targetId are required");
      if (kind !== "project" && kind !== "task" && kind !== "doc")
        return bad(respond, "kind must be project | task | doc");
      const idea = await linkIdea(id, kind, targetId, { unlink: p.unlink === true });
      respond(true, { idea });
    } catch (err) {
      fail(respond, err);
    }
  },

  "ideas.promote": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const id = str(p.id);
      const to = str(p.to) as IdeaPromoteTarget | undefined;
      if (!id) return bad(respond, "id is required");
      if (!to || !(IDEA_PROMOTE_TARGETS as readonly string[]).includes(to)) {
        return bad(respond, `to must be one of ${IDEA_PROMOTE_TARGETS.join(", ")}`);
      }
      const res = await promoteIdea(id, to, {
        projectId: str(p.projectId),
        title: str(p.title),
        priority: str(p.priority),
        createdBy: "owner",
      });
      respond(true, {
        idea: res.idea,
        target: { kind: res.target.kind, id: res.target.id, title: res.target.title },
      });
    } catch (err) {
      fail(respond, err);
    }
  },

  "capture.structure": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const kind = p.kind;
      const transcript = typeof p.transcript === "string" ? p.transcript.trim().slice(0, 6000) : "";
      if (!isCaptureKind(kind))
        return bad(respond, `kind must be one of ${CAPTURE_KINDS.join(", ")}`);
      if (!transcript) return bad(respond, "transcript is required");
      const [complete, projects, clients] = await Promise.all([
        p.ai === false ? Promise.resolve(null) : ideasRpcDeps.complete().catch(() => null),
        ideasRpcDeps.projects().catch(() => []),
        ideasRpcDeps.clients().catch(() => [] as CaptureClient[]),
      ]);
      const clientOfProject = await ideasRpcDeps
        .clientResolver(clients, projects)
        .catch(() => undefined);
      const timeZone = captureTimeZone(p.timeZone);
      const draft = await structureCapture(kind, transcript, {
        complete,
        projects,
        clients,
        clientOfProject,
        timeZone,
      });
      respond(true, {
        draft,
        projectCount: projects.length,
        clientCount: clients.length,
        timeZone,
      });
    } catch (err) {
      fail(respond, err);
    }
  },

  "capture.save": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const d = (p.draft ?? {}) as Partial<CaptureDraft>;
      if (!isCaptureKind(d.kind))
        return bad(respond, `draft.kind must be one of ${CAPTURE_KINDS.join(", ")}`);
      if (!str(d.title)) return bad(respond, "draft.title is required");
      const draft: CaptureDraft = {
        kind: d.kind,
        title: String(d.title).trim().slice(0, 200),
        body: typeof d.body === "string" ? d.body.slice(0, 20_000) : "",
        tags: strList(d.tags) ?? [],
        ...(str(d.projectId) && d.kind !== "project" ? { projectId: str(d.projectId) } : {}),
        ...(str(d.clientId) ? { clientId: str(d.clientId) } : {}),
        ...(dateParam(d.dueDate) ? { dueDate: dateParam(d.dueDate) } : {}),
        ...(dateParam(d.dueDate) && timeParam(d.dueTime) ? { dueTime: timeParam(d.dueTime) } : {}),
        ...(d.priority === "low" || d.priority === "medium" || d.priority === "high"
          ? { priority: d.priority }
          : {}),
        transcript: typeof d.transcript === "string" ? d.transcript : "",
        structuredBy: d.structuredBy === "ai" ? "ai" : "heuristic",
      };
      if (draft.clientId) {
        // Only real CRM clients (an unknown list = can't check, allow).
        const clients = await ideasRpcDeps.clients().catch(() => [] as CaptureClient[]);
        if (clients.length && !clients.some((c) => c.id === draft.clientId)) delete draft.clientId;
      }
      const saved = await saveCapture(draft, str(p.clientRequestId));
      respond(true, saved);
    } catch (err) {
      fail(respond, err);
    }
  },

  "capture.assignProject": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const kind = str(p.kind);
      const id = str(p.id);
      if (kind !== "idea" && kind !== "note" && kind !== "task")
        return bad(respond, "kind must be idea | note | task");
      if (!id) return bad(respond, "id is required");
      const projectId = p.projectId === null ? null : (str(p.projectId) ?? null);
      if (projectId) {
        // Only real board projects (an unknown list = can't check, allow).
        const projects = await ideasRpcDeps.projects().catch(() => []);
        if (projects.length && !projects.some((x) => x.id === projectId))
          return respond(false, undefined, {
            code: "NOT_FOUND",
            message: `project ${projectId} not found`,
          });
      }
      const res = await assignProject(kind, id, projectId, {
        previousProjectId: str(p.previousProjectId) ?? null,
      });
      respond(true, res);
    } catch (err) {
      fail(respond, err);
    }
  },

  "capture.assignClient": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const kind = str(p.kind);
      const id = str(p.id);
      if (kind !== "idea" && kind !== "note" && kind !== "task" && kind !== "project")
        return bad(respond, "kind must be idea | note | task | project");
      if (!id) return bad(respond, "id is required");
      const clientId = p.clientId === null ? null : (str(p.clientId) ?? null);
      if (clientId) {
        const clients = await ideasRpcDeps.clients().catch(() => [] as CaptureClient[]);
        if (clients.length && !clients.some((c) => c.id === clientId))
          return respond(false, undefined, {
            code: "NOT_FOUND",
            message: `client ${clientId} not found`,
          });
      }
      const res = await assignClient(kind, id, clientId, {
        previousClientId: str(p.previousClientId) ?? null,
      });
      respond(true, res);
    } catch (err) {
      fail(respond, err);
    }
  },

  "capture.clients": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      if (p.fresh === true) invalidateCaptureClients();
      const clients = await ideasRpcDeps.clients();
      respond(true, {
        clients: clients.map(pickerClient),
        count: clients.length,
        agencyId: activeAgencyId(),
      });
    } catch (err) {
      fail(respond, err);
    }
  },

  "capture.clientForProject": async ({ params, respond }) => {
    try {
      const projectId = str((params as { projectId?: unknown })?.projectId);
      if (!projectId) return bad(respond, "projectId is required");
      const [clients, projects] = await Promise.all([
        ideasRpcDeps.clients().catch(() => [] as CaptureClient[]),
        ideasRpcDeps.projects().catch(() => [] as CaptureProject[]),
      ]);
      const resolve = await ideasRpcDeps.clientResolver(clients, projects);
      const c = resolve(projectId);
      respond(true, { client: c ? pickerClient(c) : null });
    } catch (err) {
      fail(respond, err);
    }
  },
};

export const IDEAS_READ_METHODS = [
  "ideas.list",
  "ideas.get",
  "capture.clients",
  "capture.clientForProject",
] as const;
export const IDEAS_WRITE_METHODS = [
  "ideas.create",
  "ideas.update",
  "ideas.delete",
  "ideas.link",
  "ideas.promote",
  "capture.structure",
  "capture.save",
  "capture.assignProject",
  "capture.assignClient",
] as const;
