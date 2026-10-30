import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgencyOperationsStore } from "./store.js";
import { DEFAULT_AGENCY_ID } from "./types.js";
import {
  NOTION_PROVIDER,
  connectAgencyNotionDatabase,
  pullAgencyEntitiesFromNotion,
  pushAgencyEntitiesToNotion,
  syncAgencyEntitiesWithNotion,
  type NotionTransport,
} from "./notion-bridge.js";

/**
 * An in-memory stand-in for the Notion API. Every request is recorded so a
 * test can assert not just the resulting data but that a no-op sync issued no
 * writes at all — the property that keeps this database from growing without
 * bound. The real API is never contacted.
 */
function fakeNotion(
  seed: Array<{ id: string; name: string; status?: string; email?: string; notes?: string }> = [],
) {
  const properties = {
    Name: { type: "title" },
    Status: { type: "select" },
    Email: { type: "email" },
    Notes: { type: "rich_text" },
  };
  const pages = new Map<string, any>();
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  let nextId = 1;

  const buildPage = (id: string, values: Record<string, unknown>) => ({
    id,
    url: `https://notion.so/${id}`,
    properties: {
      Name: { type: "title", title: [{ plain_text: String(values.name ?? "") }] },
      Status: { type: "select", select: values.status ? { name: values.status } : null },
      Email: { type: "email", email: values.email ?? null },
      Notes: { type: "rich_text", rich_text: values.notes ? [{ plain_text: values.notes }] : [] },
    },
  });

  const readIncoming = (incoming: any) => ({
    name: incoming?.Name?.title?.[0]?.text?.content ?? "",
    status: incoming?.Status?.select?.name ?? null,
    email: incoming?.Email?.email ?? null,
    notes: incoming?.Notes?.rich_text?.[0]?.text?.content ?? null,
  });

  for (const row of seed) pages.set(row.id, buildPage(row.id, row));

  const transport: NotionTransport = {
    async request(path, init) {
      const method = init?.method ?? "GET";
      calls.push({ method, path, body: init?.body });
      if (method === "GET" && path.startsWith("/databases/")) {
        return {
          id: "db-1",
          title: [{ plain_text: "Clients CRM" }],
          url: "https://notion.so/db-1",
          properties,
        };
      }
      if (method === "POST" && path.endsWith("/query")) {
        return { results: [...pages.values()], has_more: false, next_cursor: null };
      }
      if (method === "POST" && path === "/pages") {
        const id = `created-${nextId++}`;
        const page = buildPage(id, readIncoming(init?.body?.properties));
        pages.set(id, page);
        return page;
      }
      if (method === "PATCH" && path.startsWith("/pages/")) {
        const id = path.slice("/pages/".length);
        const page = buildPage(id, readIncoming(init?.body?.properties));
        pages.set(id, page);
        return page;
      }
      throw new Error(`unexpected notion call ${method} ${path}`);
    },
  };

  return {
    transport,
    calls,
    writes: () =>
      calls.filter((call) => call.method === "POST" && call.path === "/pages").length +
      calls.filter((call) => call.method === "PATCH").length,
    setRemote(id: string, values: Record<string, unknown>) {
      pages.set(id, buildPage(id, values));
    },
    page: (id: string) => pages.get(id),
    pageCount: () => pages.size,
  };
}

describe("agency Notion mirror", () => {
  let dir: string;
  let store: AgencyOperationsStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agency-notion-"));
    store = new AgencyOperationsStore(join(dir, "agency.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function connect(notion: ReturnType<typeof fakeNotion>) {
    return connectAgencyNotionDatabase(
      store,
      { agencyId: DEFAULT_AGENCY_ID, entityType: "client", databaseId: "db-1", actorId: "tester" },
      notion.transport,
    );
  }

  it("connects a database, caches its schema and derives a field map", async () => {
    const notion = fakeNotion();
    const result = await connect(notion);
    expect(result.changed).toBe(true);
    expect(result.binding.externalDatabaseName).toBe("Clients CRM");
    expect(result.binding.syncDirection).toBe("bidirectional");
    // Tokens must never reach agency.db.
    expect(JSON.stringify(result.binding)).not.toMatch(/secret|Bearer|api[_-]?key/i);
    expect((result.binding.schema as any)?.fieldMap).toMatchObject({
      name: "Name",
      status: "Status",
      billingEmail: "Email",
      notes: "Notes",
    });
    // Reconnecting the same database writes nothing.
    expect((await connect(notion)).changed).toBe(false);
  });

  it("pulls remote pages into agency.db and links them", async () => {
    const notion = fakeNotion([
      { id: "page-1", name: "Acme", status: "Active", email: "ap@acme.test", notes: "retainer" },
      { id: "page-2", name: "Globex", status: "Lead" },
    ]);
    await connect(notion);
    const report = await pullAgencyEntitiesFromNotion(
      store,
      { agencyId: DEFAULT_AGENCY_ID, entityType: "client", actorId: "tester" },
      notion.transport,
    );
    expect(report).toMatchObject({ scanned: 2, created: 2, updated: 0, unchanged: 0 });
    const clients = store.listClients(DEFAULT_AGENCY_ID);
    expect(clients.map((client) => client.name).sort()).toEqual(["Acme", "Globex"]);
    expect(clients.find((client) => client.name === "Acme")).toMatchObject({
      status: "active",
      billingEmail: "ap@acme.test",
      notes: "retainer",
    });
    // "Lead" maps onto the agency vocabulary rather than being stored raw.
    expect(clients.find((client) => client.name === "Globex")?.status).toBe("prospect");
    expect(store.listExternalLinks(DEFAULT_AGENCY_ID, { provider: NOTION_PROVIDER })).toHaveLength(
      2,
    );
  });

  it("is a true no-op when nothing changed on either side", async () => {
    const notion = fakeNotion([{ id: "page-1", name: "Acme", status: "Active" }]);
    await connect(notion);
    await syncAgencyEntitiesWithNotion(
      store,
      { agencyId: DEFAULT_AGENCY_ID, entityType: "client", actorId: "tester" },
      notion.transport,
    );

    const snapshotBefore = store.exportReplicationSnapshot(DEFAULT_AGENCY_ID, "node-a").digest;
    const writesBefore = notion.writes();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { pull, push } = await syncAgencyEntitiesWithNotion(
        store,
        { agencyId: DEFAULT_AGENCY_ID, entityType: "client", actorId: "tester" },
        notion.transport,
      );
      expect(pull).toMatchObject({ created: 0, updated: 0, unchanged: 1, conflicts: 0 });
      expect(push).toMatchObject({ created: 0, updated: 0, unchanged: 1, conflicts: 0 });
    }

    // No Notion writes and no local rows changed: the replication digest, which
    // covers every agency-scoped table including the links, is untouched.
    expect(notion.writes()).toBe(writesBefore);
    expect(store.exportReplicationSnapshot(DEFAULT_AGENCY_ID, "node-a").digest).toBe(
      snapshotBefore,
    );
    expect(store.listClients(DEFAULT_AGENCY_ID)).toHaveLength(1);
  });

  it("detects a changed remote and applies it on the next pull", async () => {
    const notion = fakeNotion([{ id: "page-1", name: "Acme", status: "Active" }]);
    await connect(notion);
    await pullAgencyEntitiesFromNotion(
      store,
      { agencyId: DEFAULT_AGENCY_ID, entityType: "client", actorId: "tester" },
      notion.transport,
    );
    const client = store.listClients(DEFAULT_AGENCY_ID)[0]!;

    notion.setRemote("page-1", { name: "Acme Holdings", status: "Active", notes: "renamed" });

    const second = await pullAgencyEntitiesFromNotion(
      store,
      { agencyId: DEFAULT_AGENCY_ID, entityType: "client", actorId: "tester" },
      notion.transport,
    );
    expect(second).toMatchObject({ scanned: 1, updated: 1, unchanged: 0, created: 0 });
    expect(store.getClient(client.id, DEFAULT_AGENCY_ID)).toMatchObject({
      name: "Acme Holdings",
      notes: "renamed",
    });
    expect(
      store.getExternalLink(DEFAULT_AGENCY_ID, NOTION_PROVIDER, "client", client.id)?.syncState,
    ).toBe("in_sync");
  });

  it("pushes a locally changed record and leaves the rest alone", async () => {
    const notion = fakeNotion([
      { id: "page-1", name: "Acme", status: "Active" },
      { id: "page-2", name: "Globex", status: "Active" },
    ]);
    await connect(notion);
    await syncAgencyEntitiesWithNotion(
      store,
      { agencyId: DEFAULT_AGENCY_ID, entityType: "client", actorId: "tester" },
      notion.transport,
    );
    const acme = store.listClients(DEFAULT_AGENCY_ID).find((c) => c.name === "Acme")!;

    store.updateClient(acme.id, { notes: "upsold" }, { agencyId: DEFAULT_AGENCY_ID });
    const before = notion.writes();
    const report = await pushAgencyEntitiesToNotion(
      store,
      { agencyId: DEFAULT_AGENCY_ID, entityType: "client", actorId: "tester" },
      notion.transport,
    );
    expect(report).toMatchObject({ scanned: 2, updated: 1, unchanged: 1, created: 0 });
    expect(notion.writes()).toBe(before + 1);
    expect(notion.page("page-1").properties.Notes.rich_text[0].plain_text).toBe("upsold");
  });

  it("creates a remote page for a local-only record", async () => {
    const notion = fakeNotion();
    await connect(notion);
    store.createClient({ name: "Local Only" }, { agencyId: DEFAULT_AGENCY_ID });
    const report = await pushAgencyEntitiesToNotion(
      store,
      { agencyId: DEFAULT_AGENCY_ID, entityType: "client", actorId: "tester" },
      notion.transport,
    );
    expect(report).toMatchObject({ created: 1, updated: 0, unchanged: 0 });
    expect(notion.pageCount()).toBe(1);
    // And immediately settles: the follow-up push writes nothing.
    expect(
      (
        await pushAgencyEntitiesToNotion(
          store,
          { agencyId: DEFAULT_AGENCY_ID, entityType: "client", actorId: "tester" },
          notion.transport,
        )
      ).unchanged,
    ).toBe(1);
  });

  it("flags a conflict instead of clobbering the source of truth", async () => {
    const notion = fakeNotion([{ id: "page-1", name: "Acme", status: "Active" }]);
    await connect(notion);
    await pullAgencyEntitiesFromNotion(
      store,
      { agencyId: DEFAULT_AGENCY_ID, entityType: "client", actorId: "tester" },
      notion.transport,
    );
    const client = store.listClients(DEFAULT_AGENCY_ID)[0]!;

    // Both sides move independently.
    store.updateClient(client.id, { notes: "local edit" }, { agencyId: DEFAULT_AGENCY_ID });
    notion.setRemote("page-1", { name: "Acme", status: "Active", notes: "remote edit" });

    const report = await pullAgencyEntitiesFromNotion(
      store,
      { agencyId: DEFAULT_AGENCY_ID, entityType: "client", actorId: "tester" },
      notion.transport,
    );
    expect(report.conflicts).toBe(1);
    expect(report.updated).toBe(0);
    // The local row is untouched and the conflict is visible to the operator.
    expect(store.getClient(client.id, DEFAULT_AGENCY_ID)?.notes).toBe("local edit");
    const status = store
      .externalSyncStatus(DEFAULT_AGENCY_ID, NOTION_PROVIDER)
      .find((entry) => entry.entityType === "client")!;
    expect(status).toMatchObject({ connected: true, conflicts: 1, driftDetected: true, linked: 1 });

    // A push over a conflicted link also refuses to write.
    const writes = notion.writes();
    const push = await pushAgencyEntitiesToNotion(
      store,
      { agencyId: DEFAULT_AGENCY_ID, entityType: "client", actorId: "tester" },
      notion.transport,
    );
    expect(push.conflicts).toBe(1);
    expect(notion.writes()).toBe(writes);
  });

  it("honours a pull-only binding", async () => {
    const notion = fakeNotion([{ id: "page-1", name: "Acme" }]);
    await connectAgencyNotionDatabase(
      store,
      {
        agencyId: DEFAULT_AGENCY_ID,
        entityType: "client",
        databaseId: "db-1",
        syncDirection: "pull",
        actorId: "tester",
      },
      notion.transport,
    );
    store.createClient({ name: "Never Pushed" }, { agencyId: DEFAULT_AGENCY_ID });
    const { pull, push } = await syncAgencyEntitiesWithNotion(
      store,
      { agencyId: DEFAULT_AGENCY_ID, entityType: "client", actorId: "tester" },
      notion.transport,
    );
    expect(pull?.created).toBe(1);
    expect(push).toBeNull();
    expect(notion.pageCount()).toBe(1);
  });

  it("drops a link whose local row was deleted rather than resurrecting it", async () => {
    const notion = fakeNotion();
    await connect(notion);
    const project = store.createProject(DEFAULT_AGENCY_ID, { name: "Ghost" }, "tester");
    store.recordExternalLink({
      agencyId: DEFAULT_AGENCY_ID,
      provider: NOTION_PROVIDER,
      entityType: "client",
      entityId: project.id,
      externalId: "page-1",
      localHash: "a",
      remoteHash: "b",
    });
    notion.setRemote("page-1", { name: "Ghost" });
    const report = await pullAgencyEntitiesFromNotion(
      store,
      { agencyId: DEFAULT_AGENCY_ID, entityType: "client", actorId: "tester" },
      notion.transport,
    );
    expect(report.skipped).toBe(1);
    expect(
      store.getExternalLink(DEFAULT_AGENCY_ID, NOTION_PROVIDER, "client", project.id),
    ).toBeNull();
  });

  it("refuses to sync an entity type with no connected database", async () => {
    const notion = fakeNotion();
    await expect(
      pullAgencyEntitiesFromNotion(
        store,
        { agencyId: DEFAULT_AGENCY_ID, entityType: "task" },
        notion.transport,
      ),
    ).rejects.toThrow(/no Notion database is connected for task/);
  });
});
