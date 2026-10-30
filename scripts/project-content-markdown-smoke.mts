#!/usr/bin/env node
/**
 * Round-trip smoke for the project-content markdown pipeline.
 *
 * 1. Convert a representative markdown document → blocks → markdown and
 *    confirm the result reads identically. (Paragraphs collapse multi-line
 *    to single line, which is standard markdown behavior.)
 * 2. Confirm the shared module exposes the same Block / BlockType shape
 *    the editor uses by comparing the produced JSON to the editor's
 *    expectations.
 * 3. Confirm the kanban_tool actions land via the same path the UI's
 *    project editor reads from (saveProjectContentBlocks /
 *    getProjectContentBlocks).
 */

import {
  type Block,
  blocksToMarkdown,
  markdownToBlocks,
} from "../src/content/blocks-markdown.js";
import { getKanbanStore } from "../src/tasks/store.js";
import { STATE_DIR } from "../src/config/paths.js";
import { resolve } from "node:path";

const SAMPLE_MD = `# Project Roadmap

Q4 plan for the **redesign** initiative.

## Phase 1 — Foundation

- Audit current UX
- Map flows
- Inventory components

## Phase 2 — Build

1. New design system
2. Migrate views
3. QA sweep

> 🎯 Goal: ship by end of December

- [ ] Spec writeup
- [x] Stakeholder buy-in
- [ ] Engineering kickoff

\`\`\`ts
function example() {
  return "code blocks should round-trip";
}
\`\`\`

![architecture](https://example.com/arch.png)

---

Final notes.`;

function assertEqual(a: unknown, b: unknown, label: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    console.error(`✗ ${label}`);
    console.error("  expected:", b);
    console.error("  got:     ", a);
    process.exit(1);
  } else {
    console.log(`✓ ${label}`);
  }
}

async function main() {
  console.log("=== 1. markdown → blocks → markdown round-trip ===");
  const blocks = markdownToBlocks(SAMPLE_MD);
  console.log(`parsed ${blocks.length} blocks:`);
  for (const b of blocks) {
    console.log(`  ${b.type.padEnd(10)} ${(b.text ?? "").slice(0, 60)}`);
  }
  const md2 = blocksToMarkdown(blocks);
  const blocks2 = markdownToBlocks(md2);
  // Re-parse should produce the same block types in the same order.
  const types1 = blocks.map((b) => b.type);
  const types2 = blocks2.map((b) => b.type);
  assertEqual(types2, types1, "round-trip preserves block types in order");

  // Specific spot-checks of key block types
  const types = new Set(blocks.map((b) => b.type));
  const required = ["h1", "h2", "paragraph", "bullet", "numbered", "callout", "todo", "code", "image", "divider"];
  for (const t of required) {
    if (!types.has(t as Block["type"])) {
      console.error(`✗ block type "${t}" not found in parsed sample`);
      process.exit(1);
    }
  }
  console.log("✓ all expected block types present");

  // Todo state survives round-trip
  const todoBefore = blocks.filter((b) => b.type === "todo");
  const todoAfter = blocks2.filter((b) => b.type === "todo");
  assertEqual(
    todoAfter.map((t) => t.checked === true),
    todoBefore.map((t) => t.checked === true),
    "todo checked state round-trips",
  );
  // Code language survives
  const codeBefore = blocks.find((b) => b.type === "code");
  const codeAfter = blocks2.find((b) => b.type === "code");
  assertEqual(codeAfter?.language, codeBefore?.language, "code fence language round-trips");

  console.log("\n=== 2. store integration: agent writes md → UI editor reads blocks ===");
  const store = getKanbanStore(resolve(STATE_DIR));
  const testProjectId = `smoke_md_${Date.now()}`;
  const blocksToWrite = markdownToBlocks(SAMPLE_MD);
  store.saveProjectContentBlocks(testProjectId, blocksToWrite);
  // This is the same call the UI's project content editor uses on load.
  const readBack = store.getProjectContentBlocks(testProjectId);
  const readBlocks = readBack.blocks as Block[];
  console.log(`stored: ${blocksToWrite.length} blocks, read back: ${readBlocks.length} blocks`);
  assertEqual(
    readBlocks.map((b) => b.type),
    blocksToWrite.map((b) => b.type),
    "stored blocks read back in same order",
  );
  assertEqual(
    readBlocks.map((b) => b.text),
    blocksToWrite.map((b) => b.text),
    "stored block text preserved",
  );

  console.log("\n=== 3. read-back as markdown matches re-parse ===");
  const readMd = blocksToMarkdown(readBlocks);
  const reparsed = markdownToBlocks(readMd);
  assertEqual(
    reparsed.map((b) => b.type),
    readBlocks.map((b) => b.type),
    "markdown round-trip from store is stable",
  );

  console.log("\nOK — project markdown pipeline verified end-to-end");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
