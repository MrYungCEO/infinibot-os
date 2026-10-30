/** Seed deterministic invoice states into a throwaway side-gateway state copy. */
import { resolve } from "node:path";

import { getAgencyOperationsStore, resetAgencyOperationsStores } from "../../src/agency-operations/store.js";
import { closeHubDbs, openHubDb } from "../../src/business-hub/db.js";
import { syncAgencyRevenueToLedger } from "../../src/business-hub/revenue/canonical.js";

const stateDir = resolve(process.argv[2] ?? "");
if (!process.argv[2] || stateDir === resolve(process.env.HOME ?? "/", ".infinibot")) {
  throw new Error("Pass a throwaway state directory; refusing the live ~/.infinibot state");
}

const now = Date.now();
const day = 86_400_000;
const store = getAgencyOperationsStore(stateDir);
const client = store.createClient({
  name: "Northstar Studio",
  email: "founder@northstar.example",
  billingEmail: "finance@northstar.example",
});
const project = store.createProject("default", { name: "Northstar launch", clientId: client.id });

const partial = store.createInvoiceDraft({
  clientId: client.id,
  dueAt: now - 47 * day,
  projectIds: [project.id],
  lineItems: [{ description: "Monthly growth retainer", quantity: 1, unitPriceCents: 480_000, cadence: "monthly" }],
});
store.issueInvoice(partial.invoice.id, undefined, { issuedAt: now - 77 * day, dueAt: now - 47 * day });
store.recordPayment(partial.invoice.id, { amountCents: 180_000, paidAt: now - 60 * day, method: "bank" });

const paid = store.createInvoiceDraft({
  clientId: client.id,
  dueAt: now - 8 * day,
  projectIds: [project.id],
  lineItems: [{ description: "Launch production", quantity: 1, unitPriceCents: 220_000 }],
});
store.issueInvoice(paid.invoice.id, undefined, { issuedAt: now - 30 * day, dueAt: now - 8 * day });
store.recordPayment(paid.invoice.id, { amountCents: 220_000, paidAt: now - 12 * day, method: "bank" });

const current = store.createInvoiceDraft({
  clientId: client.id,
  dueAt: now + 12 * day,
  projectIds: [project.id],
  lineItems: [{ description: "Creative sprint", quantity: 1, unitPriceCents: 95_000 }],
});
store.issueInvoice(current.invoice.id, undefined, { issuedAt: now - 3 * day, dueAt: now + 12 * day });

const voided = store.createInvoiceDraft({
  clientId: client.id,
  projectIds: [project.id],
  lineItems: [{ description: "Canceled scope", quantity: 1, unitPriceCents: 50_000 }],
});
store.issueInvoice(voided.invoice.id);
store.voidInvoice(voided.invoice.id, undefined, "Side-gateway visual fixture");

const db = openHubDb(resolve(stateDir, "business-hub.db"));
const merged = syncAgencyRevenueToLedger(db, { stateDir, now });
console.log(JSON.stringify({ clientId: client.id, projectId: project.id, invoiceIds: [partial.invoice.id, paid.invoice.id, current.invoice.id, voided.invoice.id], merged }, null, 2));
resetAgencyOperationsStores();
closeHubDbs();
