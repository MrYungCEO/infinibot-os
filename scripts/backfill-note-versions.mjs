#!/usr/bin/env node
/**
 * Idempotent backfill: fold the three June-2026 competitor reports into the
 * `infinibot-competitor-analysis` document family (v1/v2/v3, v3 = current).
 *
 * Writes directly to the live notes store so the collapse works immediately
 * without a gateway restart:
 *   - database mode → merges version fields into database_rows.values_json
 *   - legacy mode   → updates the markdown frontmatter
 *
 * Safe to re-run. Already-correct notes are skipped.
 *
 *   node scripts/backfill-note-versions.mjs
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const FAMILY_ID = "infinibot-competitor-analysis";
const MEMBERS = [
  { id: "row_a0be3614-c959-43e4-b807-5398ee96f49e", version: 1, versionLabel: "Competitive Landscape" },
  { id: "row_45d9c496-81bd-455b-86c1-38b2b01bf0fc", version: 2, versionLabel: "Business OS reframe" },
  { id: "row_4781b361-bd72-4567-b129-84db49f99dc9", version: 3, versionLabel: "Mobile + local stack expansion" },
];

const stateDir = process.env.INFINIBOT_STATE_DIR || join(homedir(), ".infinibot");
const dbPath = join(stateDir, "databases.db");

const applied = [];
const skipped = [];
const missing = [];

function backfillDb() {
  const Database = require(join(process.cwd(), "node_modules", "better-sqlite3"));
  const db = new Database(dbPath);
  const sel = db.prepare("SELECT id, values_json FROM database_rows WHERE id = ?");
  const upd = db.prepare("UPDATE database_rows SET values_json = ?, updated_at = ? WHERE id = ?");
  const now = Date.now();
  const count = MEMBERS.length;
  for (const m of MEMBERS) {
    const row = sel.get(m.id);
    if (!row) {
      missing.push(m.id);
      continue;
    }
    let values = {};
    try {
      values = JSON.parse(row.values_json || "{}");
    } catch {
      values = {};
    }
    const isCurrent = m.version === count;
    const idx = MEMBERS.findIndex((x) => x.id === m.id);
    const supersededBy = idx > 0 ? null : null; // recomputed below after sort
    const target = {
      documentFamilyId: FAMILY_ID,
      version: m.version,
      versionLabel: m.versionLabel,
      isCurrent,
      supersededBy: m.version < count ? MEMBERS.find((x) => x.version === m.version + 1)?.id : undefined,
      supersedes: m.version > 1 ? MEMBERS.find((x) => x.version === m.version - 1)?.id : undefined,
    };
    const alreadyOk =
      values.documentFamilyId === FAMILY_ID &&
      values.version === m.version &&
      values.versionLabel === m.versionLabel &&
      values.isCurrent === isCurrent;
    if (alreadyOk) {
      skipped.push(m.id);
      continue;
    }
    const next = { ...values, ...target };
    // Drop undefined keys so they don't serialize as null noise.
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    upd.run(JSON.stringify(next), now, m.id);
    applied.push(m.id);
  }
  db.close();
}

function backfillLegacy() {
  const dir = join(stateDir, "notes");
  if (!existsSync(dir)) return;
  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  const count = MEMBERS.length;
  for (const m of MEMBERS) {
    const fp = join(dir, `${m.id}.md`);
    if (!existsSync(fp)) {
      // Only a true miss if the DB pass didn't already handle it.
      if (!applied.includes(m.id) && !skipped.includes(m.id)) missing.push(m.id);
      continue;
    }
    let raw = readFileSync(fp, "utf-8");
    const isCurrent = m.version === count;
    const set = {
      documentFamilyId: FAMILY_ID,
      version: String(m.version),
      versionLabel: `"${m.versionLabel}"`,
    };
    if (isCurrent) set.isCurrent = "true";
    let changed = false;
    raw = raw.replace(/^---\r?\n([\s\S]*?)\r?\n---/, (full, fm) => {
      let lines = fm.split("\n").filter((l) => {
        const key = l.split(":")[0].trim();
        return !["documentFamilyId", "version", "versionLabel", "isCurrent"].includes(key);
      });
      for (const [k, v] of Object.entries(set)) lines.push(`${k}: ${v}`);
      changed = true;
      return `---\n${lines.join("\n")}\n---`;
    });
    if (changed) {
      writeFileSync(fp, raw, "utf-8");
      applied.push(m.id);
    } else {
      skipped.push(m.id);
    }
  }
}

if (existsSync(dbPath)) backfillDb();
backfillLegacy();

console.log(
  JSON.stringify(
    { familyId: FAMILY_ID, applied, skipped, missing, currentId: MEMBERS[MEMBERS.length - 1].id },
    null,
    2,
  ),
);
