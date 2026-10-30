import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectPropertyAssets,
  mapNotionPropertyType,
  notionPageProperties,
  notionPropertyValue,
  notionSchemaToColumns,
} from "./properties.js";

const ws = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "__fixtures__", "api-workspace.json"), "utf-8"),
);
const DB = "33333333-3333-4333-8333-333333333333";
const ROW1 = "44444444-4444-4444-8444-444444444444";

describe("notionSchemaToColumns", () => {
  it("maps Notion types, puts the title first and drops unsupported types", () => {
    expect(notionSchemaToColumns(ws.databases[DB].properties)).toEqual([
      { key: "Name", name: "Name", type: "title" },
      { key: "Status", name: "Status", type: "select" },
      { key: "Tags", name: "Tags", type: "multiSelect" },
      { key: "Due", name: "Due", type: "date" },
      { key: "Done", name: "Done", type: "checkbox" },
      { key: "Score", name: "Score", type: "number" },
      { key: "Owner", name: "Owner", type: "person" },
      { key: "Link", name: "Link", type: "url" },
      { key: "Related", name: "Related", type: "relation" },
      { key: "Calc", name: "Calc", type: "text" },
      { key: "Created", name: "Created", type: "createdAt" },
    ]);
  });

  it("covers the full type table", () => {
    const expected: Record<string, string | null> = {
      title: "title",
      rich_text: "text",
      number: "number",
      select: "select",
      multi_select: "multiSelect",
      status: "status",
      date: "date",
      checkbox: "checkbox",
      url: "url",
      email: "email",
      phone_number: "phone",
      people: "person",
      files: "files",
      relation: "relation",
      created_time: "createdAt",
      last_edited_time: "updatedAt",
      formula: "text",
      rollup: "text",
      unique_id: "text",
      button: null,
    };
    for (const [notion, doc] of Object.entries(expected)) {
      expect(mapNotionPropertyType(notion)).toBe(doc);
    }
  });
});

describe("notionPageProperties", () => {
  it("splits the title out and converts row values", () => {
    const { title, properties } = notionPageProperties(ws.pages[ROW1].properties);
    expect(title).toBe("Ship importer");
    expect(properties).toEqual({
      Status: "Done",
      Tags: ["eng", "docs"],
      Due: "2026-09-01 → 2026-09-05",
      Done: true,
      Score: 3,
      Owner: ["Ada Lovelace"],
      Link: "https://example.com",
      Related: ["55555555555545558555555555555555"],
      Calc: 6,
      Created: "2026-01-01T00:00:00.000Z",
    });
    expect(properties).not.toHaveProperty("Name");
  });
});

describe("notionPropertyValue", () => {
  it("handles the long tail of property types", () => {
    const rt = (s: string) => [{ plain_text: s }];
    expect(notionPropertyValue({ type: "rich_text", rich_text: rt("hi") })).toBe("hi");
    expect(notionPropertyValue({ type: "status", status: { name: "In progress" } })).toBe(
      "In progress",
    );
    expect(notionPropertyValue({ type: "select", select: null })).toBeNull();
    expect(notionPropertyValue({ type: "email", email: "a@b.c" })).toBe("a@b.c");
    expect(notionPropertyValue({ type: "phone_number", phone_number: "" })).toBeNull();
    expect(notionPropertyValue({ type: "date", date: { start: "2026-01-02" } })).toBe("2026-01-02");
    expect(notionPropertyValue({ type: "number", number: null })).toBeNull();
    expect(
      notionPropertyValue({ type: "formula", formula: { type: "string", string: "ok" } }),
    ).toBe("ok");
    expect(
      notionPropertyValue({ type: "formula", formula: { type: "boolean", boolean: false } }),
    ).toBe(false);
    expect(
      notionPropertyValue({
        type: "formula",
        formula: { type: "date", date: { start: "2026-01-01", end: "2026-01-02" } },
      }),
    ).toBe("2026-01-01 → 2026-01-02");
    expect(notionPropertyValue({ type: "rollup", rollup: { type: "number", number: 7 } })).toBe(
      "7",
    );
    expect(
      notionPropertyValue({
        type: "rollup",
        rollup: {
          type: "array",
          array: [
            { type: "title", title: rt("A") },
            { type: "multi_select", multi_select: [{ name: "x" }, { name: "y" }] },
          ],
        },
      }),
    ).toBe("A, x, y");
    expect(
      notionPropertyValue({ type: "unique_id", unique_id: { prefix: "TASK", number: 12 } }),
    ).toBe("TASK-12");
    expect(notionPropertyValue({ type: "last_edited_by", last_edited_by: { id: "u9" } })).toBe(
      "u9",
    );
    expect(notionPropertyValue({ type: "button", button: {} })).toBeNull();
    expect(notionPropertyValue(undefined)).toBeNull();
  });

  it("maps files to URLs, resolving hosted ones through resolveAsset", () => {
    const prop = {
      type: "files",
      files: [
        { type: "file", name: "a.pdf", file: { url: "https://s3/a.pdf?sig" } },
        { type: "external", name: "b", external: { url: "https://ext/b.png" } },
      ],
    };
    expect(
      notionPropertyValue(prop, { resolveAsset: () => "/api/documents/assets/x.pdf" }),
    ).toEqual(["/api/documents/assets/x.pdf", "https://ext/b.png"]);
    expect(collectPropertyAssets({ F: prop }).map((a) => [a.name, a.hosted])).toEqual([
      ["a.pdf", true],
      ["b", false],
    ]);
  });
});

describe("rollups of relations", () => {
  it("shows related page titles instead of raw ids when titleOf is given", () => {
    const rollup = {
      type: "rollup",
      rollup: {
        type: "array",
        array: [
          { type: "relation", relation: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }] },
          { type: "relation", relation: [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }] },
        ],
      },
    };
    const titles: Record<string, string> = { aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa: "Alpha" };
    expect(notionPropertyValue(rollup, { titleOf: (id) => titles[id] })).toBe(
      "Alpha, bbbbbbbbbbbb4bbb8bbbbbbbbbbbbbbb",
    );
  });
});
