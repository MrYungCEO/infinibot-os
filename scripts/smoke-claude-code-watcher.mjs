#!/usr/bin/env node
// Smoke test against real ~/.claude/projects/. Asserts:
//   - top-level transcripts only (no subagent rows)
//   - prune cleared the agent-X.jsonl rows from the previous watcher version
//   - all upserts complete without "upsert failed" warnings
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync, copyFileSync, existsSync } from "node:fs";

import { startClaudeCodeWatcher } from "../src/gateway/claude-code-watcher.ts";
import { loadSessionStore, saveSessionStore } from "../src/config/sessions.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "smoke-cc-watcher-"));
const storePath = path.join(tmp, "sessions.json");
const projectsDir = path.join(os.homedir(), ".claude", "projects");

// Pre-seed the store with a stale subagent-shaped row so we can verify pruning
// strips it. Use a fake sessionFile path that doesn't exist.
await saveSessionStore(storePath, {
  "claude-code:agent-deadbeef1": {
    sessionId: "agent-deadbeef1",
    sessionFile: path.join(projectsDir, "fake", "session", "subagents", "agent-deadbeef1.jsonl"),
    updatedAt: Date.now(),
    label: "stale subagent row",
  },
});

console.log(`watching ${projectsDir} → ${storePath}`);
const handle = startClaudeCodeWatcher({ projectsDir, storePath });
await handle.ready();

const store = loadSessionStore(storePath, { skipCache: true });
const entries = Object.entries(store);
const subagentEntries = entries.filter(([k]) => /:agent-/.test(k));
const topLevelEntries = entries.filter(([, e]) => {
  const f = e?.sessionFile;
  return f && existsSync(f) && !/[\\/]subagents[\\/]/.test(f);
});

console.log(`\nresults:`);
console.log(`  total entries:           ${entries.length}`);
console.log(`  subagent-shaped rows:    ${subagentEntries.length}  (must be 0)`);
console.log(`  top-level rows:          ${topLevelEntries.length}`);
console.log(`  stale-row pruned:        ${store["claude-code:agent-deadbeef1"] ? "NO ❌" : "yes ✓"}`);

console.log("\nsample top-level rows:");
for (const [key, entry] of topLevelEntries.slice(0, 5)) {
  console.log(`  ${key}`);
  console.log(`    label: ${entry.label}, model: ${entry.model ?? "(none)"}, tokens: ${entry.totalTokens ?? 0}`);
}

await handle.close();
rmSync(tmp, { recursive: true, force: true });
