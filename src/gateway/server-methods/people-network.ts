/**
 * Gateway RPC handlers for the People Network ("My Network").
 *
 * Distinct from the federation "Infinibot Network" (instances) and from
 * `network.tailscale.*`: these methods serve the owner's relationship graph.
 * Served by the business-agency plugin like opportunity.* (module "network"
 * in src/business-agency/methods.ts), so they share its scopes and the
 * multi-user deny-by-default rule (no METHOD_RULES entry ⇒ owner only).
 *
 *   network.contacts.list      (read)  { query?, contactType?, tag?, status?, clientId?, limit?, sort?: "warm", minWarm?, maxWarm?, band? }
 *   network.contacts.get       (read)  { id } → { contact, connections, opportunities, history, path, node (incl. warm score + breakdown), warmHistory, linked }
 *   network.contacts.create    (write) { name, org?, role?, contactType?, tags?, channels?, …, connectToMe? }
 *   network.contacts.update    (write) { id, …fields }
 *   network.contacts.delete    (write) { id }
 *   network.contacts.promoteClient (write) { clientId, strength? }
 *   network.clients.search     (read)  { query?, limit? } → CRM clients + whether already in the network
 *   network.connections.list   (read)  { contactId?, status? }
 *   network.connections.create (write) { fromId, toId, relationshipType?, strength?, direction?, values?, … }
 *   network.connections.update (write) { id, …fields }
 *   network.connections.delete (write) { id }
 *   network.opportunities.link   (write) { kind: contact|connection, id, opportunityId, role? }
 *   network.opportunities.unlink (write) { kind, id, opportunityId }
 *   network.graph              (read)  → NetworkGraph (nodes, edges, opportunities, stats, suggestedClients)
 *   network.path               (read)  { toId, fromId? } → warm-intro path
 *   network.context            (read)  { contactId? | opportunityId? | objectType+objectId? } → AI decision context (text + data)
 *   network.history            (read)  { objectIds?, objectType?, limit? }
 *   network.links.list         (read)  { kind, id } → { groups, total }  (what a contact/connection is linked to)
 *                                      { objectType, objectId } → { people, text }  (who is linked to an object)
 *                                      { all: true } → { links }  (every link, for graph satellites)
 *   network.links.add          (write) { kind, id, objectType, objectId, role? }
 *   network.links.remove       (write) { relationId } | { kind, id, objectType, objectId }
 *   network.links.search       (read)  { query?, types?, limit? } → picker candidates across linkable types
 *
 * Links live in the shared relations store (src/network/links.ts).
 *
 * Every write lands in the §33 audit log and broadcasts `network.changed`.
 */

import { getAuditStore } from "../../business-objects/audit.js";
import {
  dropNetworkEdges,
  getNetworkGraph,
  hydrateContact,
  linkOpportunity,
  NETWORK_AGENT,
  networkContext,
  promoteClient,
  searchClients,
  unlinkOpportunity,
  warmPath,
} from "../../network/service.js";
import {
  allNetworkLinks,
  LINKABLE_TYPES,
  linkObject,
  linksForNetworkObject,
  peopleForObject,
  searchLinkables,
  unlinkObject,
} from "../../network/links.js";
import { getNetworkStore } from "../../network/store.js";
import {
  ME_ID,
  type Contact,
  type ConnectionCreateParams,
  type ConnectionUpdateParams,
  type ContactCreateParams,
  type ContactListParams,
  type ContactUpdateParams,
} from "../../network/types.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";

type Opts = GatewayRequestHandlerOptions;

function bad(respond: Opts["respond"], message: string) {
  respond(false, undefined, { code: "INVALID_REQUEST", message });
}
function notFound(respond: Opts["respond"], message: string) {
  respond(false, undefined, { code: "NOT_FOUND", message });
}
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
function changed(opts: Opts, op: string, id: string | null) {
  try {
    opts.context?.broadcast?.("network.changed", { op, id }, { dropIfSlow: true });
  } catch {
    /* best-effort live update */
  }
}

/** Run a write; store rule errors (validation) answer INVALID_REQUEST. */
async function write(
  opts: Opts,
  op: string,
  fn: () =>
    | Promise<{ id: string | null; payload: unknown }>
    | { id: string | null; payload: unknown },
) {
  let out: { id: string | null; payload: unknown };
  try {
    out = await fn();
  } catch (e) {
    const msg = errText(e);
    if (/not found/i.test(msg)) notFound(opts.respond, msg);
    else bad(opts.respond, msg);
    return;
  }
  opts.respond(true, out.payload);
  changed(opts, op, out.id);
}

export const peopleNetworkHandlers: GatewayRequestHandlers = {
  // ── Contacts ──────────────────────────────────────────────────────
  "network.contacts.list": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as ContactListParams & {
        sort?: string;
        minWarm?: number;
        maxWarm?: number;
        band?: string;
      };
      let contacts: Array<Contact & { warmScore?: number; warmBand?: string; warmTrend?: string }> =
        await Promise.all(
          getNetworkStore()
            .listContacts(p)
            .map((c) => hydrateContact(c)),
        );
      const wantsWarm =
        p.sort === "warm" ||
        typeof p.minWarm === "number" ||
        typeof p.maxWarm === "number" ||
        Boolean(str(p.band));
      if (wantsWarm) {
        const nodes = new Map((await getNetworkGraph()).nodes.map((n) => [n.id, n]));
        contacts = contacts.map((c) => {
          const n = nodes.get(c.id);
          return {
            ...c,
            warmScore: n?.warmScore ?? 0,
            warmBand: n?.warmBand,
            warmTrend: n?.warmTrend,
          };
        });
        if (typeof p.minWarm === "number")
          contacts = contacts.filter((c) => (c.warmScore ?? 0) >= p.minWarm!);
        if (typeof p.maxWarm === "number")
          contacts = contacts.filter((c) => (c.warmScore ?? 0) <= p.maxWarm!);
        if (str(p.band)) contacts = contacts.filter((c) => c.warmBand === str(p.band));
        if (p.sort === "warm") contacts.sort((a, b) => (b.warmScore ?? 0) - (a.warmScore ?? 0));
      }
      respond(true, { contacts, count: contacts.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: errText(e) });
    }
  },

  "network.contacts.get": async ({ params, respond }) => {
    try {
      const id = str(params?.id);
      if (!id) return bad(respond, "id is required");
      const store = getNetworkStore();
      const c = store.getContact(id);
      if (!c) return notFound(respond, `contact "${id}" not found`);
      const ctx = await networkContext({ contactId: id });
      // Pipeline stage moves of this contact's deals (opportunity.update audits them).
      const oppIds = new Set(((ctx.opportunities ?? []) as Array<{ id: string }>).map((o) => o.id));
      const audit = getAuditStore();
      const opportunityHistory = [...oppIds]
        .flatMap((oid) =>
          audit
            .list({ objectType: "opportunity", objectId: oid, limit: 20 })
            .filter((e) => e.meta?.field === "stage")
            .map((e) => ({
              opportunityId: oid,
              from: String(e.meta.from ?? ""),
              to: String(e.meta.to ?? ""),
              at: e.when,
              what: e.what,
            })),
        )
        .sort((a, b) => b.at - a.at)
        .slice(0, 30);
      respond(true, {
        warmHistory: store.warmHistory(id, Date.now() - 90 * 86_400_000),
        linked: ctx.linked ?? [],
        opportunityHistory,
        contact: await hydrateContact(c),
        connections: ctx.connections ?? [],
        opportunities: ctx.opportunities ?? [],
        history: ctx.history ?? [],
        path: ctx.path ?? null,
        node: ctx.contact ?? null,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: errText(e) });
    }
  },

  "network.contacts.create": async (opts) =>
    write(opts, "contact.create", async () => {
      const p = (opts.params ?? {}) as ContactCreateParams & {
        connectToMe?:
          | boolean
          | { relationshipType?: string; strength?: number; values?: unknown[] };
      };
      const store = getNetworkStore();
      const contact = store.createContact(p, "user");
      let connectionId: string | null = null;
      if (p.connectToMe) {
        const cfg = typeof p.connectToMe === "object" ? p.connectToMe : {};
        connectionId = store.createConnection(
          {
            fromId: ME_ID,
            toId: contact.id,
            relationshipType:
              cfg.relationshipType ?? (contact.contactType === "client" ? "client-of" : "other"),
            strength: cfg.strength ?? 3,
            values: (cfg.values as ConnectionCreateParams["values"]) ?? [],
            lastTouchDate: contact.lastTouchDate,
          },
          "user",
        ).id;
      }
      getAuditStore().log({
        what: `Network contact added: ${contact.name || contact.clientId}`,
        trigger: "network.contacts.create",
        agent: NETWORK_AGENT,
        action: "created contact",
        objectType: "contact",
        objectId: contact.id,
        meta: { contactType: contact.contactType, clientId: contact.clientId, connectionId },
      });
      return { id: contact.id, payload: { contact: await hydrateContact(contact), connectionId } };
    }),

  "network.contacts.update": async (opts) =>
    write(opts, "contact.update", async () => {
      const p = (opts.params ?? {}) as unknown as ContactUpdateParams;
      if (!str(p.id)) throw new Error("id is required");
      const store = getNetworkStore();
      const before = store.getContact(p.id);
      const c = store.updateContact(p, "user");
      if (!c || !before) throw new Error(`contact "${p.id}" not found`);
      if (before.status !== c.status)
        getAuditStore().log({
          what: `Contact ${c.name || c.id} status ${before.status} → ${c.status}`,
          trigger: "network.contacts.update",
          agent: NETWORK_AGENT,
          action: "status change",
          objectType: "contact",
          objectId: c.id,
          meta: { from: before.status, to: c.status },
        });
      return { id: c.id, payload: { contact: await hydrateContact(c) } };
    }),

  "network.contacts.delete": async (opts) =>
    write(opts, "contact.delete", () => {
      const id = str(opts.params?.id);
      if (!id) throw new Error("id is required");
      const store = getNetworkStore();
      const c = store.getContact(id);
      if (!c) throw new Error(`contact "${id}" not found`);
      const { connectionIds } = store.deleteContact(id, "user");
      dropNetworkEdges("contact", id);
      for (const cid of connectionIds) dropNetworkEdges("connection", cid);
      getAuditStore().log({
        what: `Network contact removed: ${c.name || c.clientId}`,
        trigger: "network.contacts.delete",
        agent: NETWORK_AGENT,
        action: `deleted contact and ${connectionIds.length} connection(s); linked client untouched`,
        objectType: "contact",
        objectId: id,
      });
      return { id, payload: { deleted: true, id, connectionIds } };
    }),

  "network.contacts.promoteClient": async (opts) =>
    write(opts, "contact.promoteClient", async () => {
      const clientId = str(opts.params?.clientId);
      if (!clientId) throw new Error("clientId is required");
      const strength = typeof opts.params?.strength === "number" ? opts.params.strength : undefined;
      const r = await promoteClient({
        clientId,
        strength,
        agencyId: str(opts.params?.agencyId) || undefined,
      });
      return { id: r.contact.id, payload: r };
    }),

  "network.clients.search": async ({ params, respond }) => {
    try {
      const clients = await searchClients(str(params?.query), {
        limit: typeof params?.limit === "number" ? params.limit : 25,
        agencyId: str(params?.agencyId) || undefined,
      });
      respond(true, { clients, count: clients.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: errText(e) });
    }
  },

  // ── Connections ───────────────────────────────────────────────────
  "network.connections.list": async ({ params, respond }) => {
    try {
      const connections = getNetworkStore().listConnections({
        contactId: str(params?.contactId) || undefined,
        status: str(params?.status) || undefined,
      });
      respond(true, { connections, count: connections.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: errText(e) });
    }
  },

  "network.connections.create": async (opts) =>
    write(opts, "connection.create", () => {
      const p = (opts.params ?? {}) as unknown as ConnectionCreateParams;
      const cx = getNetworkStore().createConnection(p, "user");
      getAuditStore().log({
        what: `Connected ${cx.fromId} ↔ ${cx.toId} (${cx.relationshipType}, ${cx.strength}/5)`,
        trigger: "network.connections.create",
        agent: NETWORK_AGENT,
        action: "created connection",
        objectType: "connection",
        objectId: cx.id,
        meta: { fromId: cx.fromId, toId: cx.toId, values: cx.values },
      });
      return { id: cx.id, payload: { connection: cx } };
    }),

  "network.connections.update": async (opts) =>
    write(opts, "connection.update", () => {
      const p = (opts.params ?? {}) as unknown as ConnectionUpdateParams;
      if (!str(p.id)) throw new Error("id is required");
      const store = getNetworkStore();
      const before = store.getConnection(p.id);
      const cx = store.updateConnection(p, "user");
      if (!cx || !before) throw new Error(`connection "${p.id}" not found`);
      if (before.status !== cx.status || before.strength !== cx.strength)
        getAuditStore().log({
          what: `Connection ${cx.id} ${before.status}/${before.strength} → ${cx.status}/${cx.strength}`,
          trigger: "network.connections.update",
          agent: NETWORK_AGENT,
          action: "status/strength change",
          objectType: "connection",
          objectId: cx.id,
        });
      return { id: cx.id, payload: { connection: cx } };
    }),

  "network.connections.delete": async (opts) =>
    write(opts, "connection.delete", () => {
      const id = str(opts.params?.id);
      if (!id) throw new Error("id is required");
      if (!getNetworkStore().deleteConnection(id, "user"))
        throw new Error(`connection "${id}" not found`);
      dropNetworkEdges("connection", id);
      getAuditStore().log({
        what: `Connection removed: ${id}`,
        trigger: "network.connections.delete",
        agent: NETWORK_AGENT,
        objectType: "connection",
        objectId: id,
      });
      return { id, payload: { deleted: true, id } };
    }),

  // ── Opportunity links ─────────────────────────────────────────────
  "network.opportunities.link": async (opts) =>
    write(opts, "opportunity.link", () => {
      const kind = str(opts.params?.kind) as "contact" | "connection";
      if (kind !== "contact" && kind !== "connection")
        throw new Error('kind must be "contact" or "connection"');
      const id = str(opts.params?.id);
      const opportunityId = str(opts.params?.opportunityId);
      if (!id || !opportunityId) throw new Error("id and opportunityId are required");
      const r = linkOpportunity({
        kind,
        id,
        opportunityId,
        role: str(opts.params?.role) || undefined,
        actor: "user",
      });
      return { id, payload: r };
    }),

  "network.opportunities.unlink": async (opts) =>
    write(opts, "opportunity.unlink", () => {
      const kind = str(opts.params?.kind) as "contact" | "connection";
      if (kind !== "contact" && kind !== "connection")
        throw new Error('kind must be "contact" or "connection"');
      const id = str(opts.params?.id);
      const opportunityId = str(opts.params?.opportunityId);
      if (!id || !opportunityId) throw new Error("id and opportunityId are required");
      const removed = unlinkOpportunity({ kind, id, opportunityId, actor: "user" });
      return { id, payload: { removed } };
    }),

  // ── Cross-object links (projects, notes, files, tasks, …) ──────────
  "network.links.list": async ({ params, respond }) => {
    try {
      const objectType = str(params?.objectType);
      const objectId = str(params?.objectId);
      if (objectType || objectId) {
        if (!objectType || !objectId) return bad(respond, "objectType and objectId are required");
        return respond(true, {
          objectType,
          objectId,
          ...(await peopleForObject(objectType, objectId)),
        });
      }
      if (params?.all === true) {
        const links = await allNetworkLinks();
        return respond(true, { links, count: links.length, types: LINKABLE_TYPES });
      }
      const kind = str(params?.kind);
      const id = str(params?.id);
      if (kind !== "contact" && kind !== "connection")
        return bad(
          respond,
          'kind must be "contact" or "connection" (or pass objectType + objectId)',
        );
      if (!id) return bad(respond, "id is required");
      respond(true, { kind, id, ...(await linksForNetworkObject(kind, id)) });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: errText(e) });
    }
  },

  "network.links.add": async (opts) =>
    write(opts, "link.add", async () => {
      const kind = str(opts.params?.kind) as "contact" | "connection";
      const id = str(opts.params?.id);
      const r = await linkObject({
        kind,
        id,
        objectType: str(opts.params?.objectType),
        objectId: str(opts.params?.objectId),
        role: str(opts.params?.role) || undefined,
        actor: "user",
      });
      return { id, payload: r };
    }),

  "network.links.remove": async (opts) =>
    write(opts, "link.remove", () => {
      const removed = unlinkObject({
        relationId: str(opts.params?.relationId) || undefined,
        kind: str(opts.params?.kind) || undefined,
        id: str(opts.params?.id) || undefined,
        objectType: str(opts.params?.objectType) || undefined,
        objectId: str(opts.params?.objectId) || undefined,
        actor: "user",
      });
      return { id: str(opts.params?.id) || null, payload: { removed } };
    }),

  "network.links.search": async ({ params, respond }) => {
    try {
      const types = Array.isArray(params?.types)
        ? (params.types as unknown[]).map((t) => String(t))
        : str(params?.type)
          ? [str(params?.type)]
          : undefined;
      const r = await searchLinkables(str(params?.query), {
        types,
        limit: typeof params?.limit === "number" ? params.limit : 8,
      });
      respond(true, { ...r, count: r.results.length, types: LINKABLE_TYPES });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: errText(e) });
    }
  },

  // ── Graph / path / context / history ──────────────────────────────
  "network.graph": async ({ params, respond }) => {
    try {
      respond(true, await getNetworkGraph({ agencyId: str(params?.agencyId) || undefined }));
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: errText(e) });
    }
  },

  "network.path": async ({ params, respond }) => {
    try {
      const toId = str(params?.toId);
      if (!toId) return bad(respond, "toId is required");
      respond(true, await warmPath(toId, str(params?.fromId) || ME_ID));
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: errText(e) });
    }
  },

  "network.context": async ({ params, respond }) => {
    try {
      const r = await networkContext({
        contactId: str(params?.contactId) || undefined,
        opportunityId: str(params?.opportunityId) || undefined,
        objectType: str(params?.objectType) || undefined,
        objectId: str(params?.objectId) || undefined,
        agencyId: str(params?.agencyId) || undefined,
      });
      if (r.found === false) return notFound(respond, String(r.error));
      respond(true, r);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: errText(e) });
    }
  },

  "network.history": async ({ params, respond }) => {
    try {
      const ids = Array.isArray(params?.objectIds)
        ? (params.objectIds as unknown[])
            .map((x) => String(x))
            .filter(Boolean)
            .slice(0, 200)
        : undefined;
      const history = getNetworkStore().history({
        objectIds: ids,
        objectType: str(params?.objectType) || undefined,
        limit: typeof params?.limit === "number" ? params.limit : 100,
      });
      respond(true, { history, count: history.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: errText(e) });
    }
  },
};
