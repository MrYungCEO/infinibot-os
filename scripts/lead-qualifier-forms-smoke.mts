/**
 * Smoke test for the lead-qualifier form builder.
 *
 * Validates the in-process store: template → create → fetch by slug →
 * append analytics + submissions → KPI summary → delete. No gateway
 * HTTP traffic; this is the unit-level contract for `src/services/qualifier/forms.ts`.
 *
 * Run with: `bun scripts/lead-qualifier-forms-smoke.mts`
 *           (or `npx tsx scripts/lead-qualifier-forms-smoke.mts`)
 */
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "lqforms-smoke-"));
process.env.INFINIBOT_STATE_DIR = tmp;

const {
  FORM_TEMPLATES,
  newFormFromTemplate,
  getForm,
  getFormBySlug,
  listForms,
  upsertForm,
  deleteForm,
  appendAnalytics,
  readAnalytics,
  summarizeKpi,
  appendSubmission,
  listSubmissions,
} = await import("../src/services/qualifier/forms.ts");

const { renderFormHtml } = await import("../src/services/qualifier/form-render.ts");

let failed = 0;
function assert(cond: unknown, name: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}`);
  }
}

try {
  console.log("→ Templates");
  assert(FORM_TEMPLATES.length >= 5, `bundled templates >= 5 (got ${FORM_TEMPLATES.length})`);
  assert(
    FORM_TEMPLATES.some((t) => t.id === "high-ticket-mentorship"),
    "high-ticket-mentorship template present",
  );
  assert(
    FORM_TEMPLATES.some((t) => t.id === "discovery-call"),
    "discovery-call template present",
  );

  console.log("→ Create from template");
  const created = newFormFromTemplate("biz_demo", "high-ticket-mentorship", "Demo HT App");
  assert(created.id.startsWith("qf_"), "id has qf_ prefix");
  assert(created.businessId === "biz_demo", "businessId persisted");
  assert(created.layout === "multi-step", "layout from template");
  assert(created.fields.length > 5, "fields scaffolded");
  assert(created.slug === "demo-ht-app", `slug slugified (got ${created.slug})`);
  assert(created.qualifier.scoreThreshold === 12, "scoreThreshold from template");

  console.log("→ Read by id + slug");
  const byId = getForm(created.id);
  assert(byId?.id === created.id, "getForm returns the form");
  const bySlug = getFormBySlug(created.slug);
  assert(bySlug?.id === created.id, "getFormBySlug returns the form");

  console.log("→ List filters");
  const all = listForms();
  assert(all.length === 1, `listForms returns 1 (got ${all.length})`);
  assert(listForms({ businessId: "biz_demo" }).length === 1, "businessId filter matches");
  assert(listForms({ businessId: "biz_other" }).length === 0, "businessId filter excludes");
  assert(listForms({ funnelId: null }).length === 1, "funnelId=null filter matches default");

  console.log("→ Update + slug uniqueness");
  const second = upsertForm({
    businessId: "biz_demo",
    name: "Demo HT App", // same name to trigger slug collision
  });
  assert(second.slug === "demo-ht-app-2", `unique slug minted (got ${second.slug})`);

  console.log("→ Submission log");
  appendSubmission(created.id, {
    id: "sub_1",
    formId: created.id,
    ts: Date.now(),
    payload: { name: "Jane", email: "jane@example.com", budget: "15k-30k" },
    qualified: true,
    leadId: "lead_abc",
    score: 14,
  });
  const subs = listSubmissions(created.id);
  assert(subs.length === 1, "submission appended");
  assert(subs[0].leadId === "lead_abc", "leadId persisted");

  console.log("→ Analytics + KPI");
  const now = Date.now();
  const vid = "vid_test";
  appendAnalytics(created.id, { ts: now, vid, kind: "view" });
  appendAnalytics(created.id, { ts: now + 100, vid, kind: "start" });
  appendAnalytics(created.id, { ts: now + 200, vid, kind: "field-focus", field: "name" });
  appendAnalytics(created.id, {
    ts: now + 300,
    vid,
    kind: "field-complete",
    field: "name",
  });
  appendAnalytics(created.id, {
    ts: now + 1000,
    vid,
    kind: "submit-success",
    qualified: true,
    leadId: "lead_abc",
  });
  // Second viewer abandons after touching `email`.
  appendAnalytics(created.id, { ts: now + 2000, vid: "vid_abandon", kind: "view" });
  appendAnalytics(created.id, {
    ts: now + 2200,
    vid: "vid_abandon",
    kind: "field-focus",
    field: "email",
  });

  const events = readAnalytics(created.id);
  assert(events.length === 7, `7 events stored (got ${events.length})`);

  const kpi = summarizeKpi(created.id);
  assert(kpi.views === 2, `views = 2 (got ${kpi.views})`);
  assert(kpi.starts === 1, `starts = 1 (got ${kpi.starts})`);
  assert(kpi.submits === 1, `submits = 1 (got ${kpi.submits})`);
  assert(kpi.qualified === 1, `qualified = 1 (got ${kpi.qualified})`);
  assert(
    kpi.conversionRate === 0.5,
    `conversion = 0.5 (got ${kpi.conversionRate})`,
  );
  assert(
    kpi.fieldAbandonment.some((f) => f.field === "email"),
    "email field flagged as abandoned by the second viewer",
  );

  console.log("→ HTML render");
  const html = renderFormHtml(created);
  assert(html.startsWith("<!doctype html>"), "html doctype");
  assert(html.includes(created.content.headline), "headline rendered");
  assert(html.includes(`/api/forms/lq/${created.slug}/submit`), "submit URL embedded");
  assert(html.includes(`/api/forms/lq/${created.slug}/track`), "track URL embedded");
  assert(html.includes("data-total-steps"), "multi-step attr present");

  console.log("→ Delete");
  assert(deleteForm(created.id), "deleteForm returns true");
  assert(getForm(created.id) === null, "form gone after delete");

  console.log("");
  if (failed === 0) {
    console.log("✅ All form-builder smoke checks passed");
  } else {
    console.log(`❌ ${failed} check(s) failed`);
    process.exit(1);
  }
} finally {
  if (existsSync(tmp)) {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
