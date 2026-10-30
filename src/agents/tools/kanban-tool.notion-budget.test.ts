/**
 * list_projects against a misbehaving Notion: the pagination is bounded (no
 * endless repeated-cursor loop, a total budget) and a caller abort (turn
 * aborted / tool timed out) stops in-flight requests without tripping the
 * shared "Notion is down" circuit. Either way the tool answers from the local
 * store instead of holding the agent's turn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tripNotionCircuit = vi.fn();

vi.mock("../../databases/notion-config.js", () => ({
  getNotionApiKeyOrNull: () => "secret_test",
  isNotionEnabled: () => true,
  resolveNotionDbId: (role: string) => (role === "kanban-projects" ? "db-projects" : "db-tasks"),
}));
vi.mock("../../databases/store.js", () => ({
  getDatabasesStore: () => ({ resolveSystemRole: () => null }),
}));
vi.mock("../../databases/kanban-store-ops.js", () => ({
  isNotionCircuitOpen: () => false,
  tripNotionCircuit,
  listNotionPendingProjects: () => [],
  listProjects: () => [
    { id: "local-1", name: "InfiniBot local", status: "todo", priority: "medium" },
  ],
}));

const { createKanbanTool } = await import("./kanban-tool.js");

const page = (id: string) => ({
  id,
  properties: { Name: { type: "title", title: [{ plain_text: `InfiniBot ${id}` }] } },
});
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const parse = (r: unknown) =>
  JSON.parse((r as { content: Array<{ text: string }> }).content[0].text);

describe("kanban list_projects with a misbehaving Notion", () => {
  beforeEach(() => tripNotionCircuit.mockReset());
  afterEach(() => vi.unstubAllGlobals());

  it("reads every page when Notion behaves", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n += 1;
        return json({
          results: [page(`p${n}`)],
          has_more: n < 3,
          next_cursor: n < 3 ? `c${n}` : null,
        });
      }),
    );
    const out = parse(
      await createKanbanTool().execute("c", { action: "list_projects", query: "infinibot" }),
    );
    expect(out).toMatchObject({ source: "notion-legacy", count: 3, matched: 3 });
  });

  it("stops on a repeated cursor instead of paging forever, then serves local", async () => {
    const fetchMock = vi.fn(async () =>
      json({ results: [page("p")], has_more: true, next_cursor: "same" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const out = parse(await createKanbanTool().execute("c", { action: "list_projects" }));
    expect(out.source).toBe("local");
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it("a caller abort ends a hung Notion request and doesn't trip the circuit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      ),
    );
    const ctl = new AbortController();
    const pending = createKanbanTool().execute("c", { action: "list_projects" }, ctl.signal);
    setTimeout(() => ctl.abort(new Error("tool kanban timed out")), 20);
    const t0 = Date.now();
    const out = parse(await pending);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(out.source).toBe("local");
    expect(tripNotionCircuit).not.toHaveBeenCalled();
  });

  it("a real Notion failure still trips the circuit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message: "boom" }), { status: 502 })),
    );
    const out = parse(await createKanbanTool().execute("c", { action: "list_projects" }));
    expect(out.source).toBe("local");
    expect(tripNotionCircuit).toHaveBeenCalledTimes(1);
  });
});
