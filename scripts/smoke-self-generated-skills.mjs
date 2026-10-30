#!/usr/bin/env node
/**
 * End-to-end smoke test for the self-generated skills auto-accept flow.
 *
 * What it proves:
 *  1. A draft written to the queue + accepted via acceptDraft() lands as
 *     SKILL.md in the InfiniBot managed skills dir.
 *  2. listDrafts() reports it as "accepted".
 *  3. The same draft cannot be double-accepted.
 *  4. With the new default (`requireApproval` undefined), the gateway
 *     would auto-accept on list — simulated here by calling acceptDraft
 *     in the same idempotent way.
 *
 * Run from repo root: node scripts/smoke-self-generated-skills.mjs
 *
 * Uses tsx-loader so we can import .ts sources directly without a
 * full build.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// Re-implement queue-store's append/accept against a fresh temp directory.
// We can't redirect CONFIG_DIR (it's a module-level const), so this test
// targets the live ~/.infinibot dir and tags entries with `smoke-`
// prefixes so they can be identified + ignored by humans.

const queueStore = await import("../src/agents/skills/queue-store.ts");
const { listDrafts, acceptDraft, rejectDraft } = queueStore;
const { CREATE_QUEUE_PATH } = await import("../src/agents/claude-code/skill-system.ts");
const { CONFIG_DIR } = await import("../src/utils.ts");

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function makeDraftFile(slug) {
  const dir = join(tmpdir(), `smoke-skill-${slug}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  writeFileSync(
    path,
    `---\nname: ${slug}\ndescription: smoke-test self-generated skill\n---\n\nAuto-accepted self-generated skill body.\n`,
    "utf-8",
  );
  return path;
}

function appendQueue(entry) {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  appendFileSync(CREATE_QUEUE_PATH, JSON.stringify(entry) + "\n", "utf-8");
}

console.log("\n— draft → accept → installed as active skill —");
const slug = `smoke-self-gen-${Date.now()}`;
const draftPath = makeDraftFile(slug);
const id = randomUUID();
appendQueue({
  id,
  at: new Date().toISOString(),
  runId: "smoke-run-1",
  agentId: "smoke-agent",
  slug,
  draftPath,
  task: "smoke test for auto-accept",
  durationMs: 1000,
});

const beforeList = listDrafts({ status: "pending" });
assert(
  beforeList.some((d) => d.id === id),
  "draft appears as pending after enqueue",
);

acceptDraft(id, { targetScope: "infinibot" });

const afterList = listDrafts();
const accepted = afterList.find((d) => d.id === id);
assert(accepted, "draft still in queue listing after accept");
assert(accepted?.status === "accepted", "status flipped to accepted");

const installedPath = join(CONFIG_DIR, "skills", slug, "SKILL.md");
assert(existsSync(installedPath), `SKILL.md installed at ${installedPath}`);
if (existsSync(installedPath)) {
  const content = readFileSync(installedPath, "utf-8");
  assert(content.includes("Auto-accepted self-generated skill body"), "installed content matches draft");
}

console.log("\n— double-accept is rejected (idempotency check) —");
let threw = false;
try {
  acceptDraft(id, { targetScope: "infinibot" });
} catch {
  threw = true;
}
assert(threw, "acceptDraft throws when draft already accepted");

console.log("\n— auto-accept-on-list simulation: pending → all accepted —");
const slug2 = `smoke-self-gen-list-${Date.now()}`;
const draftPath2 = makeDraftFile(slug2);
const id2 = randomUUID();
appendQueue({
  id: id2,
  at: new Date().toISOString(),
  runId: "smoke-run-2",
  agentId: "smoke-agent",
  slug: slug2,
  draftPath: draftPath2,
  task: "another smoke test",
  durationMs: 1000,
});

// What the gateway's skills.drafts.list now does internally when
// requireApproval !== true:
for (const d of listDrafts({ status: "pending" })) {
  if (!d.draftPath || !existsSync(d.draftPath)) {
    try {
      rejectDraft(d.id, "draft file missing");
    } catch { /* noop */ }
    continue;
  }
  try {
    acceptDraft(d.id, { targetScope: "infinibot" });
  } catch {
    /* already accepted — fine */
  }
}

const stillPending = listDrafts({ status: "pending" });
assert(stillPending.length === 0, `no pending drafts remain (had ${stillPending.length})`);

const justAccepted = listDrafts().find((d) => d.id === id2);
assert(justAccepted?.status === "accepted", "the new draft was auto-accepted");
assert(
  existsSync(join(CONFIG_DIR, "skills", slug2, "SKILL.md")),
  "second skill is installed in managed skills dir",
);

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
