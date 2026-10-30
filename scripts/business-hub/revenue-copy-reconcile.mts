/**
 * Reconcile provider totals against a copied Business Hub database.
 *
 * Provider calls are GET-only. The script refuses the live hub database so
 * completion evidence can never mutate or lock the owner's active state.
 */
import { resolve } from "node:path";

import { closeHubDbs, openHubDb } from "../../src/business-hub/db.js";
import { reconcile } from "../../src/business-hub/revenue/reconcile.js";

const databasePath = resolve(process.argv[2] ?? "");
const liveDatabasePath = resolve(process.env.HOME ?? "/", ".infinibot", "business-hub.db");
if (!process.argv[2] || databasePath === liveDatabasePath) {
  throw new Error("Pass a copied business-hub.db; refusing to reconcile the live database");
}

const accountIds = process.argv.slice(3);
const db = openHubDb(databasePath);
try {
  const ids = accountIds.length
    ? accountIds
    : (
        db
          .prepare("SELECT id FROM revenue_accounts WHERE provider IN ('whop','stripe') ORDER BY id")
          .all() as Array<{ id: string }>
      ).map((row) => row.id);
  const results = [];
  for (const accountId of ids) results.push(await reconcile(db, accountId));
  console.log(JSON.stringify(results, null, 2));
} finally {
  closeHubDbs();
}
