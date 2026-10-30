/**
 * Merge duplicate Notion-linked kanban rows (see src/tasks/notion-dedupe-repair.ts).
 *
 *   node --import tsx scripts/notion-dedupe-repair.ts [--state-dir DIR] [--apply]
 *
 * Without --apply it is a dry run: prints the JSON report, writes nothing.
 * With --apply it backs up kanban.db / object-relations.db / relations.db to
 * <state>/backups/notion-dedupe-<ts>/ first, then merges.
 */
import os from "node:os";
import path from "node:path";
import { repairNotionDuplicates } from "../src/tasks/notion-dedupe-repair.js";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const stateDir =
  flag("--state-dir") ?? process.env.INFINIBOT_STATE_DIR ?? path.join(os.homedir(), ".infinibot");
const apply = args.includes("--apply");

const report = await repairNotionDuplicates({ stateDir, dryRun: !apply });
console.log(JSON.stringify(report, null, 2));
