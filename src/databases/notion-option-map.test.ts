import { afterEach, describe, expect, it } from "vitest";
import {
  parseNotionOptionSchema,
  primeNotionOptionSchema,
  resolveNotionOption,
  sanitizeNotionPageWrite,
  setNotionOptionFetcherForTests,
} from "./notion-option-map.js";

const LIVE_TASKS = parseNotionOptionSchema("tasks", {
  properties: {
    "Status Update": {
      type: "status",
      status: {
        options: [
          { id: "1", name: "Not started" },
          { id: "2", name: "Awaiting Response" },
          { id: "3", name: "Revisit" },
          { id: "4", name: "In progress" },
          { id: "5", name: "Done" },
        ],
        groups: [
          { name: "To-do", option_ids: ["1"] },
          { name: "In progress", option_ids: ["2", "3", "4"] },
          { name: "Complete", option_ids: ["5"] },
        ],
      },
    },
    "Priority Level": {
      type: "select",
      select: {
        options: [{ name: "High" }, { name: "Low" }, { name: "Medium" }, { name: "Immediate" }],
      },
    },
    Node: { type: "select", select: { options: [{ name: "master" }] } },
  },
});
const status = LIVE_TASKS.props["Status Update"]!;
const prio = LIVE_TASKS.props["Priority Level"]!;

afterEach(() => setNotionOptionFetcherForTests(null));

describe("resolveNotionOption", () => {
  it("parses option names and status groups", () => {
    expect(status.options).toHaveLength(5);
    expect(status.groups?.find((g) => g.name === "In progress")?.options).toEqual([
      "Awaiting Response",
      "Revisit",
      "In progress",
    ]);
  });

  it.each([
    ["todo", "Not started", "alias"],
    ["backlog", "Not started", "alias"],
    ["in_progress", "In progress", "exact"],
    ["review", "Awaiting Response", "alias"],
    ["done", "Done", "exact"],
    ["Done", "Done", "exact"],
    ["IN PROGRESS", "In progress", "exact"],
    ["blocked", "Awaiting Response", "alias"],
  ])("%s → %s (%s)", (local, want, via) => {
    expect(resolveNotionOption(status, local)).toEqual({ name: want, via });
  });

  it("prefers 'In review' / 'Review' when the DB has one", () => {
    const s = parseNotionOptionSchema("x", {
      properties: {
        S: {
          type: "status",
          status: {
            options: [{ name: "Todo" }, { name: "In review" }, { name: "Awaiting Response" }],
          },
        },
      },
    }).props.S!;
    expect(resolveNotionOption(s, "review").name).toBe("In review");
  });

  it("falls back to the status group, then to null", () => {
    const s = parseNotionOptionSchema("x", {
      properties: {
        S: {
          type: "status",
          status: {
            options: [
              { id: "a", name: "Queued" },
              { id: "b", name: "Cooking" },
              { id: "c", name: "Shipped" },
            ],
            groups: [
              { name: "To-do", option_ids: ["a"] },
              { name: "In progress", option_ids: ["b"] },
              { name: "Complete", option_ids: ["c"] },
            ],
          },
        },
      },
    }).props.S!;
    expect(resolveNotionOption(s, "review")).toEqual({ name: "Cooking", via: "group" });
    expect(resolveNotionOption(s, "done")).toEqual({ name: "Shipped", via: "group" });
    expect(resolveNotionOption(s, "todo")).toEqual({ name: "Queued", via: "group" });
    expect(resolveNotionOption(s, "some-unknown-value")).toEqual({ name: null, via: "none" });
    expect(resolveNotionOption(undefined, "review")).toEqual({ name: null, via: "none" });
  });

  it("honours overrides only when they name a real option", () => {
    expect(resolveNotionOption(status, "review", { review: "Revisit" }).name).toBe("Revisit");
    expect(resolveNotionOption(status, "review", { review: "Nope" }).name).toBe(
      "Awaiting Response",
    );
  });

  it("canonicalises select priorities", () => {
    expect(resolveNotionOption(prio, "high").name).toBe("High");
    expect(resolveNotionOption(prio, "critical").name).toBe("Immediate");
  });
});

describe("sanitizeNotionPageWrite", () => {
  it("rewrites/drops status, canonicalises select, keeps free-form selects", async () => {
    primeNotionOptionSchema({ ...LIVE_TASKS, dbId: "tasksdb" });
    const body = JSON.stringify({
      parent: { database_id: "tasksdb" },
      properties: {
        "Status Update": { status: { name: "review" } },
        "Priority Level": { select: { name: "high" } },
        Node: { select: { name: "robo1" } },
      },
    });
    const out = JSON.parse((await sanitizeNotionPageWrite("k", "/pages", "POST", body, []))!);
    expect(out.properties["Status Update"]).toEqual({ status: { name: "Awaiting Response" } });
    expect(out.properties["Priority Level"]).toEqual({ select: { name: "High" } });
    expect(out.properties.Node).toEqual({ select: { name: "robo1" } });

    const bad = JSON.stringify({ properties: { "Status Update": { status: { name: "zzz" } } } });
    const out2 = JSON.parse(
      (await sanitizeNotionPageWrite("k", "/pages/abc", "PATCH", bad, ["tasksdb"]))!,
    );
    expect(out2.properties["Status Update"]).toBeUndefined();
  });

  it("leaves non-page requests and unknown DBs untouched", async () => {
    const body = JSON.stringify({ properties: { S: { status: { name: "x" } } } });
    expect(await sanitizeNotionPageWrite("k", "/databases/x/query", "POST", body, [])).toBe(body);
    setNotionOptionFetcherForTests(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await sanitizeNotionPageWrite("k", "/pages", "POST", body, ["unknown"])).toBe(body);
  });
});
