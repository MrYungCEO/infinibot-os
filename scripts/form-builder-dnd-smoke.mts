#!/usr/bin/env node
/**
 * Smoke for the drag-and-drop form builder's controller helpers:
 *   addFieldAt(state, kind, index, step?)
 *   moveFieldTo(state, fieldId, targetIndex, step?)
 *   duplicateField(state, fieldId)
 *
 * Runs the controller against an in-memory `AppViewState` stub so we
 * don't need the gateway client. Asserts:
 *   - addFieldAt respects index ordering and `step` pinning
 *   - addFieldAt selects the new field for the inspector (editingFieldId)
 *   - moveFieldTo reorders within a flat list
 *   - moveFieldTo across steps re-pins the field's `step`
 *   - duplicateField inserts adjacent + unique name + cloned options
 *
 * Run: node --import tsx scripts/form-builder-dnd-smoke.mts
 */

import {
  type LeadQualifierFormsState,
  type QualifierFormConfig,
  addFieldAt,
  createInitialFormBuilderState,
  duplicateField,
  moveFieldTo,
} from "../ui/src/ui/controllers/lead-qualifier-forms.ts";

function ok(label: string) { console.log(`✓ ${label}`); }
function fail(label: string, detail?: unknown): never {
  console.error(`✗ ${label}`);
  if (detail !== undefined) console.error("  detail:", detail);
  process.exit(1);
}

function makeForm(): QualifierFormConfig {
  const now = Date.now();
  return {
    id: "qf_dnd",
    businessId: "biz-dnd",
    funnelId: null,
    qualifierBusinessId: null,
    slug: "dnd-smoke",
    name: "DnD smoke",
    tag: "",
    published: false,
    layout: "multi-step",
    style: {
      templateId: "modern-card",
      primaryColor: "#fbbf24",
      bgColor: "#0a0a0f",
      textColor: "#e4e4e7",
      cardColor: null,
      accentColor: "#a855f7",
      fontStack: "Inter",
      radius: 12,
      darkHero: true,
      logoUrl: null,
      bgImageUrl: null,
      customCss: "",
    },
    content: {
      title: "DnD",
      headline: "DnD",
      subheadline: "",
      eyebrow: "",
      bullets: [],
      testimonials: [],
      cta: "Submit",
      thankYouHeadline: "Thanks",
      thankYouBody: "",
      thankYouUrl: "",
      calendlyUrl: "",
      videoUrl: "",
    },
    fields: [
      { id: "a", name: "name", label: "Name", kind: "text", required: true, step: 1 },
      { id: "b", name: "email", label: "Email", kind: "email", required: true, step: 1 },
      { id: "c", name: "phone", label: "Phone", kind: "phone", step: 2 },
    ],
    qualifier: { scoreThreshold: 0, saveUnqualified: true },
    crmDatabaseId: null,
    honeypotField: "company_url",
    createdAt: now,
    updatedAt: now,
  };
}

// Build the minimal AppViewState surface the controllers actually touch.
function makeState(): {
  leadQualifierFormsState: LeadQualifierFormsState;
  businessState: { activeBusinessId: string };
  requestUpdate: () => void;
} {
  const fs = createInitialFormBuilderState();
  const form = makeForm();
  fs.forms[form.id] = form;
  fs.selectedFormId = form.id;
  return {
    leadQualifierFormsState: fs,
    businessState: { activeBusinessId: "biz-dnd" },
    requestUpdate: () => {},
  };
}

// ── 1. addFieldAt inserts at a specific index ─────────────────
{
  const state = makeState();
  // deno-lint-ignore no-explicit-any
  const id = addFieldAt(state as any, "url", 1);
  if (!id) fail("addFieldAt returned null");
  const form = state.leadQualifierFormsState.forms["qf_dnd"];
  if (form.fields.length !== 4) fail("expected 4 fields after addFieldAt", form.fields);
  if (form.fields[1].kind !== "url") fail("new field not at index 1", form.fields.map((f) => f.kind));
  if (form.fields[0].id !== "a" || form.fields[2].id !== "b") {
    fail("other fields shifted unexpectedly", form.fields.map((f) => f.id));
  }
  if (state.leadQualifierFormsState.editingFieldId !== id) {
    fail("editingFieldId not updated to new field");
  }
  ok("addFieldAt inserts at index 1, selects new field for inspector");
}

// ── 2. addFieldAt with step pin ───────────────────────────────
{
  const state = makeState();
  // deno-lint-ignore no-explicit-any
  const id = addFieldAt(state as any, "textarea", 3, 2);
  const form = state.leadQualifierFormsState.forms["qf_dnd"];
  const added = form.fields.find((f) => f.id === id)!;
  if (added.step !== 2) fail(`addFieldAt didn't pin to step 2, got step=${added.step}`);
  ok("addFieldAt with step=2 pins the new field to step 2");
}

// ── 3. addFieldAt with step=1 strips the explicit step ────────
//     (step is optional/undefined in the data; only >1 is stored)
{
  const state = makeState();
  // deno-lint-ignore no-explicit-any
  const id = addFieldAt(state as any, "text", 0, 1);
  const form = state.leadQualifierFormsState.forms["qf_dnd"];
  const added = form.fields.find((f) => f.id === id)!;
  if (added.step !== undefined) fail(`step=1 should be stored as undefined, got ${added.step}`);
  ok("addFieldAt with step=1 leaves step undefined (default)");
}

// ── 4. moveFieldTo reorders ───────────────────────────────────
{
  const state = makeState();
  // Move "c" (phone) to index 0
  // deno-lint-ignore no-explicit-any
  moveFieldTo(state as any, "c", 0);
  const form = state.leadQualifierFormsState.forms["qf_dnd"];
  if (form.fields[0].id !== "c") fail("phone not at index 0", form.fields.map((f) => f.id));
  ok("moveFieldTo moves field 'c' to index 0");
}

// ── 5. moveFieldTo across steps re-pins the step ─────────────
{
  const state = makeState();
  // Move "a" from step 1 → step 2
  // deno-lint-ignore no-explicit-any
  moveFieldTo(state as any, "a", 2, 2);
  const form = state.leadQualifierFormsState.forms["qf_dnd"];
  const moved = form.fields.find((f) => f.id === "a")!;
  if (moved.step !== 2) fail(`field 'a' should now be on step 2, got step=${moved.step}`);
  ok("moveFieldTo with step=2 re-pins field 'a' to step 2");
}

// ── 6. moveFieldTo with step=1 strips the field's step ────────
{
  const state = makeState();
  // Move "c" (step 2) → step 1
  // deno-lint-ignore no-explicit-any
  moveFieldTo(state as any, "c", 0, 1);
  const form = state.leadQualifierFormsState.forms["qf_dnd"];
  const moved = form.fields.find((f) => f.id === "c")!;
  if (moved.step !== undefined) fail(`step=1 should clear .step, got ${moved.step}`);
  ok("moveFieldTo with step=1 clears .step (back to default)");
}

// ── 7. duplicateField inserts adjacent + unique name ──────────
{
  const state = makeState();
  // deno-lint-ignore no-explicit-any
  const newId = duplicateField(state as any, "b");
  const form = state.leadQualifierFormsState.forms["qf_dnd"];
  if (form.fields.length !== 4) fail("duplicate didn't add a row", form.fields.length);
  const idx = form.fields.findIndex((f) => f.id === newId);
  if (idx !== 2) fail(`duplicate should be adjacent (idx=2), got ${idx}`);
  if (form.fields[idx].name !== "email_copy") {
    fail(`duplicate name should be 'email_copy', got '${form.fields[idx].name}'`);
  }
  if (form.fields[idx].kind !== "email") fail("duplicate kind mismatch");
  ok("duplicateField inserts directly after source with name 'email_copy'");
}

// ── 8. duplicateField twice → email_copy then email_copy_2 ────
{
  const state = makeState();
  // deno-lint-ignore no-explicit-any
  duplicateField(state as any, "b");
  // deno-lint-ignore no-explicit-any
  duplicateField(state as any, "b");
  const form = state.leadQualifierFormsState.forms["qf_dnd"];
  const names = form.fields.map((f) => f.name);
  if (!names.includes("email_copy") || !names.includes("email_copy_2")) {
    fail("repeat duplicate should yield email_copy + email_copy_2", names);
  }
  ok("duplicateField twice yields email_copy + email_copy_2");
}

// ── 9. duplicateField deep-clones options (no shared array) ────
{
  const state = makeState();
  const form = state.leadQualifierFormsState.forms["qf_dnd"];
  // Make field "c" a select with options first.
  form.fields[2] = {
    ...form.fields[2],
    kind: "select",
    options: [
      { label: "Low", value: "low", score: 1 },
      { label: "High", value: "high", score: 3 },
    ],
  };
  // deno-lint-ignore no-explicit-any
  const newId = duplicateField(state as any, "c");
  const cloned = form.fields.find((f) => f.id === newId)!;
  // Mutate clone's options — source must stay intact.
  cloned.options![0].label = "MUTATED";
  const src = form.fields.find((f) => f.id === "c")!;
  if (src.options![0].label !== "Low") {
    fail("duplicate shared the options array with the source");
  }
  ok("duplicateField deep-clones the options[] array");
}

console.log("\nOK — drag-and-drop builder controller helpers verified");
