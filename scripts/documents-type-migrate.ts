/**
 * Document-type migration CLI (dry run by default).
 *
 *   node --import tsx scripts/documents-type-migrate.ts --root <documents dir> [--out report.md] [--json report.json]
 *   node --import tsx scripts/documents-type-migrate.ts --root <documents dir> --apply
 *
 * --root is a documents store directory (the folder holding index.json), e.g.
 * a COPY of ~/.infinibot/documents. Dry run never writes. --apply backs up
 * index.json to <root>/backups/types-premigration-<ts>.json first, then sets
 * `type` on untyped documents only (titles, bodies, tree, updatedAt untouched).
 * The same migration is available live as the documents.types.migrate RPC.
 */

import fs from "node:fs";
import path from "node:path";

import { docTypeStoreAt } from "../src/documents/doc-types.js";
import { DocumentStore } from "../src/documents/store.js";
import {
  applyTypeMigration,
  formatTypeMigrationReport,
  planTypeMigration,
} from "../src/documents/type-migration.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const root = arg("--root");
if (!root) {
  console.error("usage: documents-type-migrate.ts --root <documents dir> [--apply] [--out file.md] [--json file.json]");
  process.exit(2);
}
const abs = path.resolve(root);
if (!fs.existsSync(path.join(abs, "index.json"))) {
  console.error(`no index.json in ${abs}`);
  process.exit(2);
}
const apply = process.argv.includes("--apply");
const store = new DocumentStore(abs);
const types = docTypeStoreAt(abs).list();
const report = apply ? applyTypeMigration(store, types) : planTypeMigration(store, types);
const md = formatTypeMigrationReport(report);
const out = arg("--out");
const json = arg("--json");
if (out) fs.writeFileSync(out, md);
if (json) fs.writeFileSync(json, JSON.stringify(report, null, 1));
console.log(md.split("\n## Changes")[0]);
if (out) console.log(`\nfull report: ${out}`);
