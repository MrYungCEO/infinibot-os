import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildNetworkGraph, findWarmPath } from "./graph.js";
import { getNetworkStore } from "./store.js";
import { ME_ID, type Connection, type Contact } from "./types.js";

type Handlers = Record<string, (opts: unknown) => Promise<void> | void>;

async function call(h: Handlers, method: string, params: Record<string, unknown> = {}) {
  let out: { ok: boolean; payload: unknown; error: unknown } = {
    ok: false,
    payload: null,
    error: null,
  };
  const events: Array<[string, unknown]> = [];
  await h[method]({
    params,
    respond: (ok: boolean, payload: unknown, error: unknown) => {
      out = { ok, payload, error };
    },
    context: { broadcast: (e: string, p: unknown) => events.push([e, p]) },
  });
  return { ...out, events } as {
    ok: boolean;
    payload: any;
    error: any;
    events: Array<[string, unknown]>;
  };
}

describe("people network", () => {
  let stateDir: string;
  let prevStateDir: string | undefined;
  let h: Handlers;
  let setClients: (src: unknown) => void;

  beforeAll(async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-network-"));
    prevStateDir = process.env.INFINIBOT_STATE_DIR;
    process.env.INFINIBOT_STATE_DIR = stateDir;
    const svc = await import("./service.js");
    setClients = svc.setNetworkClientSourceForTest as (src: unknown) => void;
    const clients = [
      {
        id: "cl-acme",
        name: "Acme Corp",
        pipelineStatusLabel: "Active",
        email: "ops@acme.test",
        phone: null,
      },
      {
        id: "cl-beta",
        name: "Beta LLC",
        pipelineStatusLabel: "Prospect",
        email: null,
        phone: "+1555",
      },
    ];
    setClients({
      getClient: (id: string) => clients.find((c) => c.id === id) ?? null,
      listClients: () => clients,
    });
    h = (await import("../gateway/server-methods/people-network.js"))
      .peopleNetworkHandlers as unknown as Handlers;
  });

  afterAll(() => {
    setClients(undefined);
    if (prevStateDir === undefined) delete process.env.INFINIBOT_STATE_DIR;
    else process.env.INFINIBOT_STATE_DIR = prevStateDir;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("store: contact CRUD, validation and tracked history", () => {
    const s = getNetworkStore(path.join(stateDir, "unit"));
    expect(() => s.createContact({ name: "  " })).toThrow(/name is required/);
    const c = s.createContact({
      name: "Ana Diaz",
      tags: "vc, Fintech,vc",
      contactType: "INVESTOR",
      priority: "p9",
    });
    expect(c.tags).toEqual(["vc", "Fintech"]);
    expect(c.contactType).toBe("investor");
    expect(c.priority).toBe("P2");
    expect(c.owner).toBe(ME_ID);
    const u = s.updateContact({ id: c.id, status: "cold", nextAction: "Send deck" }, "tester")!;
    expect(u.status).toBe("Cold");
    const hist = s.history({ objectIds: [c.id] });
    const fields = hist.map((x) => x.field);
    expect(fields).toContain("status");
    expect(fields).toContain("nextAction");
    expect(hist.find((x) => x.field === "status")).toMatchObject({
      from: "Active",
      to: "Cold",
      actor: "tester",
    });
  });

  it("store: connections clamp strength, reject self/dupes/unknown endpoints, cascade on delete", () => {
    const s = getNetworkStore(path.join(stateDir, "unit2"));
    const a = s.createContact({ name: "A" });
    const b = s.createContact({ name: "B" });
    expect(() => s.createConnection({ fromId: a.id, toId: a.id })).toThrow(/itself/);
    expect(() => s.createConnection({ fromId: a.id, toId: "nope" })).toThrow(/not found/);
    const cx = s.createConnection({
      fromId: a.id,
      toId: b.id,
      strength: 9,
      values: [
        { valueType: "revenue", estimatedValue: 5000, description: "referrals" },
        { valueType: "x", description: "" },
      ],
    });
    expect(cx.strength).toBe(5);
    expect(cx.values).toHaveLength(1);
    expect(() => s.createConnection({ fromId: b.id, toId: a.id })).toThrow(/already connected/);
    const up = s.updateConnection({ id: cx.id, strength: 2, status: "dormant" })!;
    expect(up).toMatchObject({ strength: 2, status: "Dormant" });
    expect(s.history({ objectIds: [cx.id] }).map((x) => x.field)).toEqual(
      expect.arrayContaining(["strength", "status", "created"]),
    );
    const del = s.deleteContact(a.id);
    expect(del).toEqual({ deleted: true, connectionIds: [cx.id] });
    expect(s.getConnection(cx.id)).toBeNull();
  });

  it("graph: values, open opportunities (direct, client and connection), staleness, suggestions", () => {
    const now = Date.parse("2026-10-25T00:00:00Z");
    const mk = (id: string, extra: Partial<Contact> = {}): Contact =>
      ({
        id,
        name: id,
        org: "",
        role: "",
        contactType: "other",
        tags: [],
        channels: {},
        notes: "",
        status: "Active",
        owner: "me",
        priority: "P2",
        lastTouchDate: "",
        hubContactId: "",
        clientId: "",
        createdAt: 0,
        updatedAt: 0,
        ...extra,
      }) as Contact;
    const cx = (
      id: string,
      fromId: string,
      toId: string,
      strength: number,
      extra: Partial<Connection> = {},
    ): Connection =>
      ({
        id,
        fromId,
        toId,
        relationshipType: "colleague",
        strength,
        direction: "mutual",
        values: [],
        lastTouchDate: "",
        status: "Active",
        notes: "",
        owner: "me",
        createdAt: 0,
        updatedAt: 0,
        ...extra,
      }) as Connection;
    const g = buildNetworkGraph({
      now,
      contacts: [
        mk("ana", { lastTouchDate: "2026-10-20" }),
        mk("ben", { clientId: "cl-1" }),
        mk("cy"),
      ],
      connections: [
        cx("x1", ME_ID, "ana", 5, {
          values: [{ valueType: "intro-access", estimatedValue: 2000, description: "VC intros" }],
        }),
        cx("x2", "ana", "ben", 3, {
          values: [{ valueType: "revenue", estimatedValue: 10000, description: "" }],
        }),
        cx("x3", "ben", "ghost", 4),
      ],
      opportunities: [
        { id: "o1", name: "Deal 1", stage: "Proposal", estimatedValue: 50000, clientId: "cl-1" },
        { id: "o2", name: "Deal 2", stage: "Won", estimatedValue: 9000 },
        { id: "o3", name: "Deal 3", stage: "Discovery", estimatedValue: 7000 },
        { id: "o4", name: "Other client", stage: "New", estimatedValue: 1, clientId: "cl-2" },
      ],
      links: [
        { kind: "contact", fromId: "cy", opportunityId: "o2" },
        { kind: "connection", fromId: "x2", opportunityId: "o3", role: "introducer" },
      ],
      clients: new Map([
        [
          "cl-1",
          { id: "cl-1", name: "Ben Co", pipelineStatus: "Active", email: null, phone: null },
        ],
        ["cl-2", { id: "cl-2", name: "Zed", pipelineStatus: "", email: null, phone: null }],
      ]),
    });
    expect(g.edges.map((e) => e.id)).toEqual(["x1", "x2"]); // dangling x3 dropped
    const ana = g.nodes.find((n) => n.id === "ana")!;
    const ben = g.nodes.find((n) => n.id === "ben")!;
    const cy = g.nodes.find((n) => n.id === "cy")!;
    expect(ana.relationshipValue).toBe(12000);
    expect(ana.staleDays).toBe(5);
    expect(ana.openOpportunities).toBe(1); // o3 through the x2 connection
    expect(ben.isClient).toBe(true);
    expect(ben.openOpportunities).toBe(2); // o1 via client + o3 via connection
    expect(ben.pipelineValue).toBe(57000);
    expect(cy.openOpportunities).toBe(0);
    expect(cy.totalOpportunities).toBe(1);
    expect(cy.staleDays).toBeNull();
    expect(g.edges.find((e) => e.id === "x2")!.openOpportunities).toBe(1);
    expect(g.stats).toMatchObject({
      contacts: 3,
      clients: 1,
      connections: 2,
      openOpportunities: 2,
      pipelineValue: 57000,
    });
    expect(g.suggestedClients).toEqual([{ id: "cl-2", name: "Zed", openOpportunities: 1 }]);
  });

  it("path: prefers strong ties and skips ended connections", () => {
    const c = (id: string, a: string, b: string, strength: number, status = "Active") =>
      ({ id, fromId: a, toId: b, strength, status, relationshipType: "friend" }) as Connection;
    const conns = [
      c("weak", ME_ID, "t", 1),
      c("s1", ME_ID, "m", 5),
      c("s2", "m", "t", 5),
      c("dead", ME_ID, "z", 5, "Ended"),
    ];
    const p = findWarmPath(
      conns,
      "t",
      ME_ID,
      new Map([
        ["m", "Mia"],
        ["t", "Tom"],
      ]),
    );
    expect(p.found).toBe(true);
    expect(p.nodeIds).toEqual([ME_ID, "m", "t"]);
    expect(p.description).toBe("You → Mia (friend, 5/5) → Tom (friend, 5/5)");
    expect(findWarmPath(conns, "z").found).toBe(false);
  });

  it("rpc: full flow — contacts, client promotion, connections, opportunity links, graph, path, context", async () => {
    const ana = await call(h, "network.contacts.create", {
      name: "Ana Diaz",
      org: "Seed Fund",
      contactType: "investor",
      tags: ["vc"],
      connectToMe: {
        relationshipType: "investor",
        strength: 4,
        values: [{ valueType: "capital", estimatedValue: 250000, description: "Seed cheque" }],
      },
    });
    expect(ana.ok).toBe(true);
    expect(ana.events[0]?.[0]).toBe("network.changed");
    const anaId = ana.payload.contact.id as string;

    const bad = await call(h, "network.contacts.create", { name: "" });
    expect(bad.ok).toBe(false);
    expect(bad.error.code).toBe("INVALID_REQUEST");

    const search = await call(h, "network.clients.search", { query: "acme" });
    expect(search.payload.clients).toEqual([
      expect.objectContaining({ id: "cl-acme", name: "Acme Corp", inNetwork: null }),
    ]);
    const promoted = await call(h, "network.contacts.promoteClient", { clientId: "cl-acme" });
    expect(promoted.ok).toBe(true);
    expect(promoted.payload.created).toBe(true);
    const acmeId = promoted.payload.contact.id as string;
    expect(promoted.payload.contact).toMatchObject({
      name: "Acme Corp",
      clientId: "cl-acme",
      contactType: "client",
    });
    const again = await call(h, "network.contacts.promoteClient", { clientId: "cl-acme" });
    expect(again.payload).toMatchObject({ created: false });
    expect(
      (await call(h, "network.contacts.promoteClient", { clientId: "missing" })).error.code,
    ).toBe("NOT_FOUND");

    const cx = await call(h, "network.connections.create", {
      fromId: anaId,
      toId: acmeId,
      relationshipType: "introduced-by",
      strength: 3,
      values: [{ valueType: "intro-access", description: "Ana introduced Acme" }],
    });
    expect(cx.ok).toBe(true);

    const { getOpportunityStore } = await import("../opportunity/store.js");
    const opp = getOpportunityStore().create({
      name: "Acme rollout",
      owner: "me",
      stage: "Proposal",
      estimatedValue: 40000,
      clientId: "cl-acme",
    });
    const opp2 = getOpportunityStore().create({
      name: "Fund partnership",
      owner: "me",
      stage: "Discovery",
      estimatedValue: 15000,
    });
    const link = await call(h, "network.opportunities.link", {
      kind: "contact",
      id: anaId,
      opportunityId: opp2.id,
      role: "decision-maker",
    });
    expect(link.ok).toBe(true);
    expect(
      (
        await call(h, "network.opportunities.link", {
          kind: "contact",
          id: anaId,
          opportunityId: "nope",
        })
      ).error.code,
    ).toBe("NOT_FOUND");

    const graph = await call(h, "network.graph");
    expect(graph.ok).toBe(true);
    const nodes = graph.payload.nodes as Array<{
      id: string;
      openOpportunities: number;
      isClient: boolean;
      relationshipValue: number;
    }>;
    expect(nodes.find((n) => n.id === acmeId)).toMatchObject({
      isClient: true,
      openOpportunities: 1,
    });
    expect(nodes.find((n) => n.id === anaId)).toMatchObject({
      openOpportunities: 1,
      relationshipValue: 250000,
    });
    expect(graph.payload.stats).toMatchObject({
      contacts: 2,
      connections: 3,
      openOpportunities: 2,
      pipelineValue: 55000,
    });

    const p = await call(h, "network.path", { toId: acmeId });
    expect(p.payload.found).toBe(true);
    expect(p.payload.nodeIds[0]).toBe(ME_ID);

    // Status change on the deal is audited and shows on the contact.
    await (
      await import("../gateway/server-methods/opportunity.js")
    ).opportunityHandlers["opportunity.update"]({
      params: { id: opp2.id, stage: "Negotiation" },
      respond: () => {},
      context: {},
    } as never);
    const got = await call(h, "network.contacts.get", { id: anaId });
    expect(got.ok).toBe(true);
    expect(got.payload.opportunities).toEqual([
      expect.objectContaining({
        id: opp2.id,
        stage: "Negotiation",
        role: "decision-maker",
        open: true,
      }),
    ]);
    expect(got.payload.opportunityHistory[0]).toMatchObject({
      opportunityId: opp2.id,
      from: "Discovery",
      to: "Negotiation",
    });

    const ctx = await call(h, "network.context", { contactId: anaId });
    expect(ctx.payload.text).toContain("Ana Diaz");
    expect(ctx.payload.text).toContain("Fund partnership [Negotiation, open]");
    expect(ctx.payload.text).toContain("capital $250,000");
    expect(ctx.payload.text).toContain("Discovery → Negotiation");
    const octx = await call(h, "network.context", { opportunityId: opp.id });
    expect(octx.payload.people).toEqual([
      expect.objectContaining({ contactId: acmeId, via: "client" }),
    ]);
    const overview = await call(h, "network.context");
    expect(overview.payload.text).toMatch(/2 contacts \(1 clients\)/);

    const upd = await call(h, "network.contacts.update", { id: anaId, status: "Warm" });
    expect(upd.payload.contact.status).toBe("Warm");
    const hist = await call(h, "network.history", { objectIds: [anaId] });
    expect(hist.payload.history.map((x: { field: string }) => x.field)).toEqual(
      expect.arrayContaining(["status", "opportunity.linked", "created"]),
    );
    const { getAuditStore } = await import("../business-objects/audit.js");
    expect(
      getAuditStore().list({ objectType: "contact", objectId: anaId }).length,
    ).toBeGreaterThanOrEqual(3);

    // Delete cascades connections and relations edges, never the CRM client.
    const del = await call(h, "network.contacts.delete", { id: anaId });
    expect(del.payload.connectionIds.length).toBe(2);
    const { getRelationsStore } = await import("../relations/store.js");
    expect(getRelationsStore().linksAround("contact", anaId)).toEqual([]);
    expect((await call(h, "network.contacts.get", { id: anaId })).error.code).toBe("NOT_FOUND");
    expect(
      (await call(h, "network.clients.search", { query: "acme" })).payload.clients[0].inNetwork,
    ).toBe(acmeId);
  });

  it("agent tool: overview, context and status updates go through the same store", async () => {
    const { createPeopleNetworkToolImpl } = await import("../agents/tools/people-network-tool.js");
    const tool = createPeopleNetworkToolImpl();
    const run = async (args: Record<string, unknown>) => {
      const r = (await tool.execute("t", args)) as {
        details?: unknown;
        content: Array<{ text: string }>;
      };
      return JSON.parse(r.content[0].text) as any;
    };
    const added = await run({
      action: "add_contact",
      data: { name: "Tool Person", connectToMe: true },
    });
    expect(added.created).toBe(true);
    const id = added.contact.id;
    const upd = await run({ action: "update_contact", id, data: { status: "Dormant" } });
    expect(upd.contact.status).toBe("Dormant");
    const ctx = await run({ action: "context", id });
    expect(ctx.text).toContain("Tool Person");
    const hist = await run({ action: "history", id });
    expect(
      hist.history.some(
        (x: { field: string; actor: string }) =>
          x.field === "status" && x.actor === "agent:people_network",
      ),
    ).toBe(true);
    expect((await run({ action: "overview" })).scope).toBe("overview");
    expect((await run({ action: "bogus" })).error).toMatch(/Unknown action/);
  });

  it("cross-object links: add, list both sides, search, context, unlink, audit", async () => {
    // Through the real notes.create handler so the note lands wherever notes live.
    const nh = (await import("../gateway/server-methods/notes.js"))
      .noteHandlers as unknown as Handlers;
    const created = await call(nh, "notes.create", { name: "Kickoff notes", body: "Agenda" });
    const note = (created.payload.note ?? created.payload) as { id: string };
    expect(note.id).toBeTruthy();
    const { getIdeaStore } = await import("../ideas/store.js");
    const { idea } = getIdeaStore().create({ title: "Referral program idea", body: "" });
    fs.mkdirSync(path.join(stateDir, "files", "deals"), { recursive: true });
    fs.writeFileSync(path.join(stateDir, "files", "deals", "term-sheet.pdf"), "pdf");
    const { getOpportunityStore } = await import("../opportunity/store.js");
    const opp = getOpportunityStore().create({
      name: "Linked deal",
      owner: "me",
      stage: "Proposal",
      estimatedValue: 9000,
    });

    const zoe = (
      await call(h, "network.contacts.create", {
        name: "Zoe Link",
        org: "Northwind",
        connectToMe: { strength: 4, values: [{ valueType: "revenue", estimatedValue: 12000 }] },
      })
    ).payload;
    const zoeId = zoe.contact.id as string;
    const yan = (await call(h, "network.contacts.create", { name: "Yan Link" })).payload.contact;
    const cx = (
      await call(h, "network.connections.create", { fromId: zoeId, toId: yan.id, strength: 2 })
    ).payload.connection;

    const add = await call(h, "network.links.add", {
      kind: "contact",
      id: zoeId,
      objectType: "note",
      objectId: note.id,
      role: "author",
    });
    expect(add.ok).toBe(true);
    expect(add.payload).toMatchObject({
      created: true,
      item: { type: "note", label: "Kickoff notes" },
    });
    expect(add.events.map((e) => e[0])).toContain("network.changed");
    // Idempotent re-link.
    const again = await call(h, "network.links.add", {
      kind: "contact",
      id: zoeId,
      objectType: "note",
      objectId: note.id,
    });
    expect(again.payload).toMatchObject({ created: false, relationId: add.payload.relationId });
    expect(
      (
        await call(h, "network.links.add", {
          kind: "contact",
          id: zoeId,
          objectType: "file",
          objectId: "deals/term-sheet.pdf",
        })
      ).payload.item,
    ).toMatchObject({ label: "term-sheet.pdf", resolved: true });
    expect(
      (
        await call(h, "network.links.add", {
          kind: "contact",
          id: zoeId,
          objectType: "opportunity",
          objectId: opp.id,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await call(h, "network.links.add", {
          kind: "connection",
          id: cx.id,
          objectType: "idea",
          objectId: idea.id,
        })
      ).ok,
    ).toBe(true);

    // Rejections: bad type, missing target, missing network object, path escape.
    const rej = async (p: Record<string, unknown>) => (await call(h, "network.links.add", p)).error;
    expect(
      (await rej({ kind: "contact", id: zoeId, objectType: "planet", objectId: "x" })).code,
    ).toBe("INVALID_REQUEST");
    expect(
      (await rej({ kind: "contact", id: zoeId, objectType: "note", objectId: "nope" })).code,
    ).toBe("NOT_FOUND");
    expect(
      (await rej({ kind: "contact", id: "ghost", objectType: "note", objectId: note.id })).code,
    ).toBe("NOT_FOUND");
    expect(
      (await rej({ kind: "contact", id: zoeId, objectType: "file", objectId: "../../etc/passwd" }))
        .code,
    ).toBe("NOT_FOUND");
    expect(
      (await rej({ kind: "robot", id: zoeId, objectType: "note", objectId: note.id })).code,
    ).toBe("INVALID_REQUEST");

    // Network side: grouped by type, opportunity edge included.
    const list = await call(h, "network.links.list", { kind: "contact", id: zoeId });
    expect(list.payload.total).toBe(3);
    expect(list.payload.groups.map((g: { type: string }) => g.type)).toEqual([
      "note",
      "file",
      "opportunity",
    ]);
    expect(list.payload.groups[0].items[0]).toMatchObject({
      role: "author",
      label: "Kickoff notes",
    });

    // Object side: the note sees Zoe with value; the idea sees both ends of the connection.
    const onNote = await call(h, "network.links.list", { objectType: "note", objectId: note.id });
    expect(onNote.payload.people).toEqual([
      expect.objectContaining({ contactId: zoeId, via: "contact", relationshipValue: 12000 }),
    ]);
    expect(onNote.payload.text).toContain("Zoe Link");
    expect(onNote.payload.text).toContain("relationship value $12,000");
    const onIdea = await call(h, "network.links.list", { objectType: "idea", objectId: idea.id });
    expect(onIdea.payload.people.map((p: { contactId: string }) => p.contactId).sort()).toEqual(
      [zoeId, yan.id].sort(),
    );
    const all = await call(h, "network.links.list", { all: true });
    expect(all.payload.links.length).toBe(3); // opportunity links ride their own edge

    // AI context: contact scope lists linked objects; object scope lists people.
    const ctx = await call(h, "network.context", { contactId: zoeId });
    expect(ctx.payload.text).toContain("Linked to:");
    expect(ctx.payload.text).toContain("Kickoff notes [note");
    const octx = await call(h, "network.context", { objectType: "note", objectId: note.id });
    expect(octx.payload).toMatchObject({ scope: "object" });
    expect(octx.payload.people[0].contactId).toBe(zoeId);

    // Picker search across types.
    const found = await call(h, "network.links.search", { query: "kickoff" });
    expect(found.payload.results).toEqual([
      expect.objectContaining({ type: "note", id: note.id, label: "Kickoff notes" }),
    ]);
    const files = await call(h, "network.links.search", { query: "term", types: ["file"] });
    expect(files.payload.results[0]).toMatchObject({ type: "file", id: "deals/term-sheet.pdf" });

    // Unlink by relation id and by tuple; non-network edges are refused.
    const rm = await call(h, "network.links.remove", { relationId: add.payload.relationId });
    expect(rm.payload.removed).toBe(1);
    const rm2 = await call(h, "network.links.remove", {
      kind: "contact",
      id: zoeId,
      objectType: "opportunity",
      objectId: opp.id,
    });
    expect(rm2.payload.removed).toBe(1);
    const { getRelationsStore } = await import("../relations/store.js");
    const foreign = getRelationsStore().create({
      fromType: "client",
      fromId: "cl-acme",
      edge: "client_has_opportunity",
      toType: "opportunity",
      toId: opp.id,
    });
    expect((await call(h, "network.links.remove", { relationId: foreign.id })).ok).toBe(false);
    expect(
      (await call(h, "network.links.list", { kind: "contact", id: zoeId })).payload.total,
    ).toBe(1);

    // History + audit trail.
    const hist = await call(h, "network.history", { objectIds: [zoeId] });
    expect(hist.payload.history.map((x: { field: string }) => x.field)).toEqual(
      expect.arrayContaining(["link.added", "link.removed"]),
    );
    const { getAuditStore } = await import("../business-objects/audit.js");
    const triggers = getAuditStore()
      .list({ objectType: "contact", objectId: zoeId })
      .map((e) => e.trigger);
    expect(triggers).toEqual(expect.arrayContaining(["network.links.add", "network.links.remove"]));

    // Agent tool: link / linked / unlink / find_linkable.
    const { createPeopleNetworkToolImpl } = await import("../agents/tools/people-network-tool.js");
    const tool = createPeopleNetworkToolImpl();
    const run = async (args: Record<string, unknown>) =>
      JSON.parse(
        ((await tool.execute("t", args)) as { content: Array<{ text: string }> }).content[0].text,
      ) as any;
    const tl = await run({
      action: "link",
      kind: "contact",
      id: yan.id,
      objectType: "note",
      objectId: note.id,
    });
    expect(tl.created).toBe(true);
    const linked = await run({ action: "linked", objectType: "note", objectId: note.id });
    expect(linked.people[0]).toMatchObject({ contactId: yan.id, name: "Yan Link" });
    expect((await run({ action: "linked", kind: "contact", id: yan.id })).total).toBe(1);
    expect((await run({ action: "find_linkable", query: "referral" })).results[0].type).toBe(
      "idea",
    );
    expect((await run({ action: "unlink", relationId: tl.relationId })).removed).toBe(1);

    // Deleting a contact drops its links.
    await call(h, "network.contacts.delete", { id: zoeId });
    expect(getRelationsStore().linksAround("contact", zoeId)).toEqual([]);
  });

  it("warm score: graph + override + sort/filter + history + trend + context", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const warm = (
      await call(h, "network.contacts.create", {
        name: "Warm Wendy",
        lastTouchDate: today,
        connectToMe: { strength: 5 },
      })
    ).payload.contact;
    const cold = (await call(h, "network.contacts.create", { name: "Cold Carl" })).payload.contact;
    const g = await call(h, "network.graph");
    const node = (id: string) =>
      (g.payload.nodes as Array<Record<string, any>>).find((n) => n.id === id)!;
    expect(node(warm.id).warmScore).toBeGreaterThan(node(cold.id).warmScore);
    expect(node(cold.id)).toMatchObject({ warmScore: 0, warmBand: "dormant" });
    expect(Object.keys(node(warm.id).warmBreakdown)).toEqual([
      "recency",
      "strength",
      "frequency",
      "opportunities",
      "reciprocity",
      "links",
    ]);
    expect(g.payload.stats.bands).toBeTruthy();

    const pinned = await call(h, "network.contacts.update", { id: cold.id, warmOverride: 80 });
    expect(pinned.payload.contact.warmOverride).toBe(80);
    const sorted = await call(h, "network.contacts.list", { sort: "warm", minWarm: 1 });
    expect(sorted.payload.contacts[0]).toMatchObject({
      id: cold.id,
      warmScore: 80,
      warmBand: "inner",
    });
    expect(sorted.payload.contacts.some((c: { id: string }) => c.id === warm.id)).toBe(true);
    const inner = await call(h, "network.contacts.list", { band: "inner" });
    expect(inner.payload.contacts.map((c: { id: string }) => c.id)).toContain(cold.id);

    const got = await call(h, "network.contacts.get", { id: cold.id });
    expect(got.payload.node).toMatchObject({
      warmScore: 80,
      warmOverridden: true,
      warmComputed: 0,
    });
    const scores = got.payload.warmHistory.map((p: { score: number }) => p.score);
    expect(scores).toEqual(expect.arrayContaining([0, 80]));
    expect(got.payload.node.warmTrend).toBe("warming");
    const hist = await call(h, "network.history", { objectIds: [cold.id] });
    expect(hist.payload.history.map((x: { field: string }) => x.field)).toContain("warmOverride");
    const ctx = await call(h, "network.context", { contactId: cold.id });
    expect(ctx.payload.text).toContain(
      "Warm score 80/100 (Inner circle, owner override; formula says 0",
    );
    const ov = await call(h, "network.context");
    expect(ov.payload.text).toMatch(/Warm score: average \d+\/100; rings — Inner circle/);

    // Clearing the override falls back to the formula.
    const cleared = await call(h, "network.contacts.update", { id: cold.id, warmOverride: null });
    expect(cleared.payload.contact.warmOverride).toBeNull();
  });
});
