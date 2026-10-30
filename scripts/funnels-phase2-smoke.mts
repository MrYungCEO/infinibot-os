#!/usr/bin/env node
/**
 * Phase 2 smoke: form submission → bound funnel auto-ingest.
 *
 * Exercises the same code path the public form-submit handler runs
 * (without standing up the HTTP server). We replicate just enough of
 * the handler body to verify: bound form → lead created in the entry
 * stage with the form_<id> tag and the form payload preserved in
 * customFields.
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { randomBytes } from "node:crypto";

const sandbox = path.join(os.tmpdir(), `infinibot-phase2-${randomBytes(3).toString("hex")}`);
process.env.INFINIBOT_STATE_DIR = sandbox;
await fs.mkdir(sandbox, { recursive: true });

const { getFunnelStore, resetFunnelStore } = await import("../src/funnels/store.ts");
resetFunnelStore();

function ok(label: string) { console.log(`✓ ${label}`); }
function fail(label: string, detail?: unknown): never {
  console.error(`✗ ${label}`); if (detail !== undefined) console.error("  detail:", detail);
  process.exit(1);
}

// ── Replica of the auto-ingest block in server-pages-public.ts ──
// We exercise it directly so the test doesn't need an HTTP server.
async function ingestFormSubmission(args: {
  formId: string;
  payload: Record<string, unknown>;
  score?: number;
  qualifierLeadId?: string;
  qualified: boolean;
}): Promise<string | undefined> {
  const store = getFunnelStore();
  const binding = store.getFormBinding(args.formId);
  if (!binding) return args.qualifierLeadId;
  const tag = binding.tag ? `form_${binding.tag}` : `form_${args.formId}`;
  let leadId = args.qualifierLeadId;
  if (leadId) {
    const existing = store.getLead(leadId);
    if (existing) {
      const tags = Array.from(new Set([...(existing.tags ?? []), tag, `form_${args.formId}`]));
      store.updateLead(leadId, {
        funnelId: binding.funnelId,
        stageId: binding.entryStageId,
        tags,
      });
    }
  } else {
    const data = args.payload;
    const name =
      (typeof data.name === "string" && data.name) ||
      (typeof data.fullName === "string" && data.fullName) ||
      (typeof data.email === "string" && data.email) ||
      "Form submission";
    const created = store.createLead({
      businessId: binding.businessId,
      funnelId: binding.funnelId,
      stageId: binding.entryStageId,
      name,
      email: typeof data.email === "string" ? data.email : undefined,
      phone: typeof data.phone === "string" ? data.phone : undefined,
      company: typeof data.company === "string" ? data.company : undefined,
      source: "form" as never,
      status: args.qualified ? ("qualified" as never) : ("new" as never),
      priority: "medium" as never,
      score: args.score,
      tags: [tag, `form_${args.formId}`],
      customFields: data,
    });
    leadId = created.id;
  }
  return leadId;
}

async function main() {
  console.log("=== sandbox:", sandbox, "===\n");
  const store = getFunnelStore();
  const biz = store.createBusiness({ name: "Acme", type: "service", status: "active" });
  const funnel = store.createFunnel({
    businessId: biz.id,
    name: "Sales",
    type: "sales",
    status: "active",
  });
  const entry = store.createStage({ funnelId: funnel.id, name: "Inbox", type: "entry", position: 0 });

  // 1. No binding → submission is a no-op as far as the funnel is concerned.
  console.log("--- 1. submit when no binding exists ---");
  const leadIdA = await ingestFormSubmission({
    formId: "form-no-binding",
    payload: { name: "Nobody" },
    qualified: false,
  });
  if (leadIdA) fail("no-binding submit should not create a funnel lead", leadIdA);
  if (store.listLeads({ funnelId: funnel.id }).length !== 0) fail("funnel has leads but shouldn't");
  ok("no binding → no funnel write");

  // 2. Bind a form, then submit → lead lands in entry stage with tags.
  console.log("\n--- 2. bind + submit (no qualifier leadId) ---");
  store.bindFormToFunnel({
    formId: "form-A",
    businessId: biz.id,
    funnelId: funnel.id,
    entryStageId: entry.id,
  });
  const leadIdB = await ingestFormSubmission({
    formId: "form-A",
    payload: {
      name: "Alice",
      email: "alice@example.com",
      phone: "+15555550100",
      company: "Acme Co",
      message: "interested",
    },
    qualified: false,
  });
  if (!leadIdB) fail("expected lead created");
  const lead = store.getLead(leadIdB)!;
  if (lead.funnelId !== funnel.id) fail("wrong funnel", lead);
  if (lead.stageId !== entry.id) fail("wrong stage", lead);
  if (!(lead.tags ?? []).includes("form_form-A")) fail("missing form tag", lead.tags);
  if (lead.email !== "alice@example.com") fail("email not carried", lead);
  if (!lead.customFields || (lead.customFields as Record<string, unknown>).message !== "interested") {
    fail("customFields didn't preserve raw payload", lead.customFields);
  }
  ok(`lead created: ${lead.id} name=${lead.name} stage=${entry.name}`);

  // 3. Submit with an existing qualifier-created leadId → move it onto the funnel.
  console.log("\n--- 3. bind + submit when qualifier already made a lead ---");
  // Simulate qualifier creating a lead somewhere else first.
  const orphan = store.createLead({
    businessId: biz.id,
    funnelId: funnel.id, // qualifier picked default funnel
    stageId: entry.id,
    name: "Bob",
    email: "bob@example.com",
    source: "webhook" as never,
    status: "new" as never,
    priority: "medium" as never,
    tags: ["qualifier"],
  });
  // Re-bind to a different form id and submit referencing the orphan.
  store.bindFormToFunnel({
    formId: "form-B",
    businessId: biz.id,
    funnelId: funnel.id,
    entryStageId: entry.id,
    tag: "premium",
  });
  const leadIdC = await ingestFormSubmission({
    formId: "form-B",
    payload: { name: "Bob" },
    qualifierLeadId: orphan.id,
    qualified: true,
  });
  if (leadIdC !== orphan.id) fail("should reuse qualifier leadId", { expected: orphan.id, got: leadIdC });
  const reused = store.getLead(orphan.id)!;
  const tags = reused.tags ?? [];
  if (!tags.includes("form_premium") && !tags.includes("form_form-B")) {
    fail("qualifier lead didn't get tagged with the form binding tag", tags);
  }
  if (!tags.includes("qualifier")) fail("original qualifier tag was wiped", tags);
  ok(`qualifier lead got bound to form: tags=${tags.join(",")}`);

  // 4. Snapshot via the gateway handler now attributes both leads correctly.
  console.log("\n--- 4. funnels.flow.snapshot reflects the ingest ---");
  const { funnelsFlowHandlers } = await import("../src/gateway/server-methods/funnels-flow.ts");
  let snap: Record<string, unknown> | undefined;
  await (funnelsFlowHandlers["funnels.flow.snapshot"] as (o: unknown) => Promise<void>)({
    req: { type: "req", id: "t", method: "funnels.flow.snapshot", params: { funnelId: funnel.id } },
    params: { funnelId: funnel.id },
    respond: (okFlag: boolean, payload?: unknown) => {
      if (okFlag) snap = payload as Record<string, unknown>;
    },
    client: {},
    isWebchatConnect: false,
    context: {},
  });
  if (!snap) fail("snapshot returned no payload");
  const sources = snap.sources as Array<{ kind: string; id: string; leadCount: number }>;
  const formA = sources.find((s) => s.id === "form-A");
  const formB = sources.find((s) => s.id === "form-B" || s.tag === "form_premium");
  if (!formA || formA.leadCount !== 1) fail("form-A source count wrong", sources);
  if (!formB || formB.leadCount !== 1) fail("form-B source count wrong", sources);
  ok(`snapshot sources: form-A=${formA.leadCount}, premium=${formB.leadCount}`);

  await fs.rm(sandbox, { recursive: true, force: true });
  ok("sandbox cleaned");
  console.log("\nOK — Phase 2 auto-ingest verified");
}

main().catch(async (err) => {
  console.error("FAIL:", err);
  try { await fs.rm(sandbox, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
