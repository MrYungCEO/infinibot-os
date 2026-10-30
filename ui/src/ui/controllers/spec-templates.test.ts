/**
 * The contract these tests defend is narrow and load-bearing: applying a
 * template must never destroy a to-do that has real, in-flight work behind it.
 * A dispatched to-do is joined to its work item by block id, so dropping the
 * block orphans a queued job — the operator sees no checkbox, the employee sees
 * a task nobody asked for.
 */

import { describe, expect, it } from "vitest";
import {
  BUILTIN_SPEC_TEMPLATES,
  CARRY_OVER_HEADING,
  applyTemplate,
  findTemplate,
  isProtectedBlock,
  parseTemplateIndex,
  serialiseTemplateIndex,
  slugifyTemplateName,
  STANDARD_SECTIONS,
  type SpecTemplate,
} from "./spec-templates";
import { dispatchKey, pmActionKey, stableHash } from "./project-spec";
import type { SpecBlock } from "./project-spec";

const webBuild = findTemplate(BUILTIN_SPEC_TEMPLATES, "web-build")!;
const blank = findTemplate(BUILTIN_SPEC_TEMPLATES, "blank")!;

function todo(id: string, text: string, checked = false): SpecBlock {
  return { id, type: "todo", text, checked };
}

describe("built-in templates", () => {
  it("all carry the standard sections", () => {
    for (const template of BUILTIN_SPEC_TEMPLATES) {
      const headings = template
        .build({ name: "Acme" })
        .filter((block) => block.type === "h2")
        .map((block) => block.text);
      for (const section of STANDARD_SECTIONS) {
        if (section === "Milestones" && template.slug === "blank") continue;
        expect(headings, `${template.slug} missing ${section}`).toContain(section);
      }
    }
  });

  it("produces stable block ids across builds", () => {
    const a = webBuild.build({ name: "Acme" }).map((b) => b.id);
    const b = webBuild.build({ name: "Acme" }).map((b) => b.id);
    expect(a).toEqual(b);
  });

  it("weaves the project's own description into the overview", () => {
    const blocks = webBuild.build({ name: "Acme", description: "A shop for bolts." });
    expect(blocks.some((b) => b.text === "A shop for bolts.")).toBe(true);
  });
});

describe("applyTemplate — merge safety", () => {
  const dispatched = todo("blk-dispatched", "Build and deploy to staging");
  const done = todo("blk-done", "Confirm scope with client", true);
  const loose = todo("blk-open", "Something nobody has touched");

  const existing: SpecBlock[] = [
    { id: "h", type: "h1", text: "Acme — spec" },
    { id: "todo-h", type: "h2", text: "To-do" },
    dispatched,
    done,
    loose,
  ];

  it("keeps checked and dispatched to-dos when merging", () => {
    const result = applyTemplate(existing, webBuild, "merge", { name: "Acme" }, {
      dispatchedBlockIds: ["blk-dispatched"],
    });
    const ids = result.blocks.map((b) => b.id);
    expect(ids).toContain("blk-dispatched");
    expect(ids).toContain("blk-done");
    // The checked state travels with the block, not just the id.
    expect(result.blocks.find((b) => b.id === "blk-done")?.checked).toBe(true);
  });

  it("keeps checked and dispatched to-dos even when REPLACING", () => {
    const result = applyTemplate(existing, webBuild, "replace", { name: "Acme" }, {
      dispatchedBlockIds: ["blk-dispatched"],
    });
    const ids = result.blocks.map((b) => b.id);
    expect(ids).toContain("blk-dispatched");
    expect(ids).toContain("blk-done");
    expect(result.carriedOver.sort()).toEqual(["blk-dispatched", "blk-done"]);
    expect(result.blocks.some((b) => b.text === CARRY_OVER_HEADING)).toBe(true);
    // An untouched to-do is NOT protected — replace is allowed to drop it.
    expect(ids).not.toContain("blk-open");
  });

  it("never mints a duplicate block id", () => {
    const result = applyTemplate(existing, webBuild, "merge", { name: "Acme" }, {
      dispatchedBlockIds: ["blk-dispatched"],
    });
    const ids = result.blocks.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("preserves every existing block id when merging", () => {
    const result = applyTemplate(existing, webBuild, "merge", { name: "Acme" });
    for (const block of existing) {
      expect(result.blocks.map((b) => b.id)).toContain(block.id);
    }
  });

  it("does not duplicate a line the spec already has", () => {
    const once = applyTemplate(existing, webBuild, "merge", { name: "Acme" });
    const twice = applyTemplate(once.blocks, webBuild, "merge", { name: "Acme" });
    expect(twice.added).toBe(0);
    expect(twice.blocks.length).toBe(once.blocks.length);
  });

  it("matches sections case- and punctuation-insensitively", () => {
    const sloppy: SpecBlock[] = [
      { id: "x1", type: "h2", text: "to-do:" },
      todo("x2", "Confirm scope and asset handover with the client"),
    ];
    const result = applyTemplate(sloppy, webBuild, "merge", {});
    const headings = result.blocks.filter((b) => b.type === "h2").map((b) => b.text);
    // The existing "to-do:" heading is reused, not shadowed by a second "To-do".
    expect(headings.filter((h) => /to-do/i.test(h))).toEqual(["to-do:"]);
    // …and its one matching line was recognised as already present.
    expect(
      result.blocks.filter(
        (b) => b.text === "Confirm scope and asset handover with the client",
      ),
    ).toHaveLength(1);
  });

  it("survives a template that drops everything (the safety net alone holds)", () => {
    const empty: SpecTemplate = {
      slug: "empty",
      name: "Empty",
      description: "",
      source: "builtin",
      build: () => [],
    };
    const result = applyTemplate(existing, empty, "replace", {}, {
      dispatchedBlockIds: ["blk-dispatched"],
    });
    expect(result.blocks.map((b) => b.id)).toContain("blk-dispatched");
    expect(result.blocks.map((b) => b.id)).toContain("blk-done");
  });

  it("seeds an empty spec from the template wholesale", () => {
    const result = applyTemplate([], blank, "merge", { name: "Acme" });
    expect(result.blocks.length).toBeGreaterThan(0);
    expect(result.blocks[0].type).toBe("h1");
    expect(result.carriedOver).toEqual([]);
  });

  it("classifies protection correctly", () => {
    const set = new Set(["blk-dispatched"]);
    expect(isProtectedBlock(dispatched, set)).toBe(true);
    expect(isProtectedBlock(done, set)).toBe(true);
    expect(isProtectedBlock(loose, set)).toBe(false);
    expect(isProtectedBlock({ id: "p", type: "paragraph", text: "hi" }, set)).toBe(false);
  });
});

describe("custom template persistence helpers", () => {
  it("round-trips the index document", () => {
    const entries = [{ slug: "shopify", name: "Shopify launch", description: "d" }];
    expect(parseTemplateIndex(serialiseTemplateIndex(entries))).toEqual(entries);
  });

  it("treats an unreadable index as empty rather than throwing", () => {
    expect(parseTemplateIndex([{ id: "i", type: "code", text: "[not json" }])).toEqual([]);
    expect(parseTemplateIndex([])).toEqual([]);
  });

  it("slugifies names into safe document keys", () => {
    expect(slugifyTemplateName("Shopify Launch!")).toBe("shopify-launch");
    expect(slugifyTemplateName("   ")).toBe("custom");
    expect(slugifyTemplateName("///")).toBe("custom");
  });
});

describe("idempotency key generation", () => {
  it("is stable for the same to-do", () => {
    expect(dispatchKey("proj-1", "blk-9")).toBe(dispatchKey("proj-1", "blk-9"));
    expect(dispatchKey("proj-1", "blk-9")).toBe("spec:proj-1:blk-9");
  });

  it("separates projects and blocks", () => {
    expect(dispatchKey("proj-1", "blk-9")).not.toBe(dispatchKey("proj-2", "blk-9"));
    expect(dispatchKey("proj-1", "blk-9")).not.toBe(dispatchKey("proj-1", "blk-8"));
  });

  it("gives PM actions their own namespace, so a to-do and its breakdown never collide", () => {
    expect(pmActionKey("proj-1", "breakdown", "blk-9|text")).not.toBe(
      dispatchKey("proj-1", "blk-9"),
    );
    expect(pmActionKey("proj-1", "draft", "x")).not.toBe(pmActionKey("proj-1", "review", "x"));
  });

  it("is stable for identical spec text and changes when the spec changes", () => {
    const a = pmActionKey("proj-1", "review", "## To-do\n- [ ] a");
    const b = pmActionKey("proj-1", "review", "## To-do\n- [ ] a");
    const c = pmActionKey("proj-1", "review", "## To-do\n- [ ] a\n- [ ] b");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("hashes deterministically to a fixed-width hex string", () => {
    expect(stableHash("hello")).toBe(stableHash("hello"));
    expect(stableHash("hello")).toMatch(/^[0-9a-f]{8}$/);
    expect(stableHash("hello")).not.toBe(stableHash("hellp"));
  });
});
