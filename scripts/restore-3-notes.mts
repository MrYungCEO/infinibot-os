#!/usr/bin/env node
/**
 * One-shot restore for the 3 previous notes from ~/clawd-main/state/notes/
 * into the active InfiniBot config dir.
 *
 * Behavior:
 *   - If the notes role is mapped to a database (which is the default
 *     after the unification), each note becomes a row via the bridge.
 *   - If the role is NOT mapped, falls back to writing into the file
 *     NoteStore at ~/.infinibot/notes/<id>.md.
 *
 * Idempotent — the bridge's `_infinibot_legacy_notes` marker (or the
 * NoteStore's id-based dedup) skips notes that are already restored.
 */

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const SOURCE_DIR = process.env.NOTES_SOURCE_DIR ?? "";
if (!SOURCE_DIR) throw new Error("Set NOTES_SOURCE_DIR to the folder holding the notes to restore.");
const STATE_DIR = process.env.INFINIBOT_STATE_DIR ?? path.join(os.homedir(), ".infinibot");
process.env.INFINIBOT_STATE_DIR = STATE_DIR;

const { NoteStore } = await import("../src/notes/store.js");
const { getRoleMode, importLegacyRecordsToRole, listRowsForRole } = await import(
  "../src/databases/system-role-bridge.js"
);

interface ParsedNote {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  author?: string;
  body: string;
}

/**
 * Minimal YAML frontmatter parser. Supports the few keys we actually
 * write: id, name, description, tags (array), author, createdAt,
 * updatedAt. No need for a full YAML library — these are simple K/V
 * lines plus one bracketed array.
 */
function parseNoteFile(filePath: string): ParsedNote {
  const raw = fsSync.readFileSync(filePath, "utf-8");
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/.exec(raw);
  if (!m) {
    const id = path.basename(filePath, ".md");
    return { id, name: id, body: raw };
  }
  const front = m[1];
  const body = m[2];
  const lines = front.split("\n");
  const meta: Record<string, string | string[]> = {};
  for (const line of lines) {
    const km = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!km) continue;
    const key = km[1];
    let val = km[2].trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (val.startsWith("[") && val.endsWith("]")) {
      const inner = val.slice(1, -1).trim();
      meta[key] = inner.length
        ? inner.split(",").map((s) => s.trim().replace(/^"|"$/g, ""))
        : [];
      continue;
    }
    meta[key] = val;
  }
  return {
    id: (meta.id as string) ?? path.basename(filePath, ".md"),
    name: (meta.name as string) ?? path.basename(filePath, ".md"),
    description: (meta.description as string) || undefined,
    tags: Array.isArray(meta.tags) ? meta.tags : undefined,
    author: (meta.author as string) || undefined,
    body,
  };
}

async function main() {
  console.log(`source:  ${SOURCE_DIR}`);
  console.log(`target:  INFINIBOT_STATE_DIR=${STATE_DIR}\n`);

  // Discover source notes
  const entries = await fs.readdir(SOURCE_DIR).catch(() => [] as string[]);
  const mdFiles = entries.filter((f) => f.endsWith(".md"));
  if (mdFiles.length === 0) {
    console.error("No .md files found in source.");
    process.exit(1);
  }
  console.log(`found ${mdFiles.length} note files:`);
  for (const f of mdFiles) console.log(`  - ${f}`);
  console.log();

  // Parse all
  const notes: ParsedNote[] = [];
  for (const f of mdFiles) {
    try {
      notes.push(parseNoteFile(path.join(SOURCE_DIR, f)));
    } catch (err) {
      console.warn(`  skipped ${f}: ${(err as Error).message}`);
    }
  }

  // Decide routing — bridge-aware
  const role = getRoleMode("notes");
  console.log(`notes role mode: ${role.mode}${role.databaseId ? ` (db ${role.databaseId})` : ""}\n`);

  if (role.mode === "database") {
    console.log(`Restoring via database bridge…`);
    const records = notes.map((n) => ({
      legacyId: n.id,
      title: n.name,
      body: n.body,
      values: {
        description: n.description,
        tags: n.tags,
        author: n.author,
      } as unknown as Record<string, import("../src/databases/types.js").PropertyValue>,
    }));
    const result = importLegacyRecordsToRole("notes", records);
    console.log(
      `  imported=${result.imported}  skipped=${result.skipped}  errors=${result.errors.length}`,
    );
    if (result.errors.length) console.log(result.errors);
    // Show what's there now
    const all = listRowsForRole("notes");
    console.log(`\ndatabase now contains ${all.length} notes:`);
    for (const r of all.slice(0, 10)) console.log(`  ${r.id}  ${r.title}`);
  } else {
    console.log(`Restoring via legacy file NoteStore…`);
    const store = new NoteStore(STATE_DIR);
    let imported = 0;
    let skipped = 0;
    for (const n of notes) {
      if (store.get(n.id)) {
        skipped++;
        continue;
      }
      store.create({
        id: n.id,
        name: n.name,
        description: n.description,
        tags: n.tags,
        author: n.author,
        body: n.body,
      });
      imported++;
    }
    console.log(`  imported=${imported}  skipped=${skipped}`);
    const after = store.list({});
    console.log(`\nfile-store now contains ${after.length} notes:`);
    for (const n of after.slice(0, 10)) console.log(`  ${n.id}  ${n.name}`);
  }

  console.log(`\nDone.`);
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
