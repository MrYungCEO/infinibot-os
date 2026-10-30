#!/usr/bin/env node
/**
 * Smoke test for the new step-by-step form layout.
 *
 * Builds a 3-step QualifierFormConfig in-memory with per-step content
 * + a logo, renders it via renderFormHtml, then verifies the output
 * has the structural pieces we promised:
 *
 *   1. body class has "layout-step-by-step" (so CSS scopes correctly)
 *   2. step dots (`.sbs-dots`) present with exactly 3 dots
 *   3. three `.sbs-page` fieldsets, only the first un-hidden
 *   4. each page carries its own logo (`.logo-block`) at center-top
 *   5. per-step content overrides the form-level headlines on steps 2/3
 *   6. step 1 falls back to form-level content when stepContent[0] empty
 *   7. logo respects logoMaxWidth via inline style
 *   8. step-by-step body skips the standalone .hero (the per-page block
 *      replaces it — without this, headlines would render twice)
 *
 * Run: node --import tsx scripts/form-step-by-step-smoke.mts
 */

import { renderFormHtml } from "../src/services/qualifier/form-render.ts";
import type { QualifierFormConfig } from "../src/services/qualifier/forms.ts";

function ok(label: string) { console.log(`✓ ${label}`); }
function fail(label: string, detail?: unknown): never {
  console.error(`✗ ${label}`);
  if (detail !== undefined) console.error("  detail:", detail);
  process.exit(1);
}

const now = Date.now();
const cfg: QualifierFormConfig = {
  id: "qf_smoke_001",
  businessId: "biz-smoke",
  funnelId: null,
  qualifierBusinessId: null,
  slug: "sbs-smoke",
  name: "Step-by-step smoke",
  tag: "smoke",
  published: true,
  layout: "step-by-step",
  style: {
    templateId: "modern-card",
    primaryColor: "#fbbf24",
    bgColor: "#0a0a0f",
    textColor: "#e4e4e7",
    cardColor: null,
    accentColor: "#a855f7",
    fontStack: "Inter, system-ui, sans-serif",
    radius: 14,
    darkHero: true,
    logoUrl: "https://example.com/logo.png",
    logoPosition: "center-top",
    logoMaxWidth: 180,
    bgImageUrl: null,
    customCss: "",
  },
  content: {
    title: "Sign up",
    headline: "Form-level headline",
    subheadline: "Form-level sub",
    eyebrow: "Form-level eyebrow",
    bullets: [],
    testimonials: [],
    cta: "Submit",
    thankYouHeadline: "Thanks!",
    thankYouBody: "We'll be in touch.",
    thankYouUrl: "",
    calendlyUrl: "",
    videoUrl: "",
    stepContent: [
      // Step 1 — leave empty so it falls back to form-level
      {},
      { eyebrow: "Step 2 eyebrow", headline: "Step 2 headline", subheadline: "Step 2 sub" },
      { headline: "Step 3 — what now?", subheadline: "Final step." },
    ],
  },
  fields: [
    { id: "name", name: "name", label: "Name", kind: "text", required: true, step: 1 },
    { id: "email", name: "email", label: "Email", kind: "email", required: true, step: 1 },
    { id: "company", name: "company", label: "Company", kind: "text", step: 2 },
    { id: "budget", name: "budget", label: "Budget", kind: "select", step: 2, options: [
      { label: "Low", value: "low", score: 1 },
      { label: "High", value: "high", score: 3 },
    ] },
    { id: "notes", name: "notes", label: "Notes", kind: "textarea", step: 3 },
  ],
  qualifier: { scoreThreshold: 0, saveUnqualified: true },
  crmDatabaseId: null,
  honeypotField: "company_url",
  createdAt: now,
  updatedAt: now,
};

const html = renderFormHtml(cfg);

// 1. body has the layout class
if (!html.includes('class="layout-step-by-step"')) {
  fail("body class missing 'layout-step-by-step'");
}
ok("body class is layout-step-by-step");

// 2. Step dots
const dotMatches = html.match(/class="sbs-dot"/g) ?? [];
if (dotMatches.length !== 3) fail(`expected 3 .sbs-dot, got ${dotMatches.length}`);
ok(`step dots: ${dotMatches.length} rendered`);

// 3. Three .sbs-page fieldsets, only the first un-hidden
// idx===0 renders trailing space (empty hidden); idx>0 renders ` hidden`.
const pageRe = /<fieldset class="step sbs-page" data-step="(\d+)"\s*(hidden)?\s*>/g;
const pages: Array<{ step: number; hidden: boolean }> = [];
let m: RegExpExecArray | null;
while ((m = pageRe.exec(html)) !== null) {
  pages.push({ step: Number(m[1]), hidden: !!m[2] });
}
if (pages.length !== 3) fail(`expected 3 .sbs-page, got ${pages.length}`, pages);
if (pages[0].hidden) fail("step 1 should be visible on load");
if (!pages[1].hidden || !pages[2].hidden) fail("steps 2+3 should start hidden");
ok(`3 step pages; step 1 visible, steps 2+3 hidden`);

// 4. Logo block on each page (center-top), with inline max-width style
const logoMatches = html.match(/class="logo-block logo-center-top">/g) ?? [];
// 3 inside step pages — the hero path isn't used for step-by-step.
if (logoMatches.length < 3) fail(`expected ≥3 logo-blocks (one per step), got ${logoMatches.length}`);
if (!html.includes("max-width:180px")) fail("logoMaxWidth not applied as inline style");
ok(`logos: ${logoMatches.length} center-top blocks, max-width 180px`);

// 5. Per-step content overrides
if (!html.includes("Step 2 eyebrow")) fail("step 2 eyebrow missing");
if (!html.includes("Step 2 headline")) fail("step 2 headline missing");
if (!html.includes("Step 3 — what now?")) fail("step 3 headline missing");
ok("step 2 + 3 per-step content rendered");

// 6. Step 1 falls back to form-level
if (!html.includes("Form-level eyebrow")) fail("step 1 didn't fall back to form-level eyebrow");
if (!html.includes("Form-level headline")) fail("step 1 didn't fall back to form-level headline");
ok("step 1 fell back to form-level content");

// 7. (covered above with max-width)

// 8. No standalone .hero section (would duplicate the headline)
if (/<section class="hero"/.test(html)) fail("step-by-step rendered a standalone .hero (duplicates headlines)");
ok("no standalone .hero section in step-by-step output");

// 9. Honeypot + nav present
if (!html.includes('class="hp"')) fail("honeypot input missing");
if (!html.includes('id="next"')) fail("Next button missing");
if (!html.includes('id="prev"')) fail("Back button missing");
if (!html.includes('id="submit"')) fail("Submit button missing");
ok("honeypot + nav buttons (next/prev/submit) all present");

console.log("\nOK — step-by-step form layout verified");
