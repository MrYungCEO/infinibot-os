/**
 * InfiniBot 2026 — Set Up & Monetization Playbook · v1
 *
 *   node_modules/.bin/tsx scripts/infinibot-2026-playbook-v1.mts
 *
 * Output: /tmp/infinibot-2026-playbook-v1.pdf
 *
 * Rendered through the canonical black-gold report pipeline
 * (src/reports/render.ts → renderReport). No ad-hoc pandoc / wkhtmltopdf /
 * weasyprint — per memory rule reports_canonical_pdf_path.
 *
 * Chapter content lives in the shared sibling module
 * (infinibot-2026-playbook-v1-content.mts) so the canonical report and the
 * deluxe ebook (infinibot-2026-playbook-v1-deluxe.mts) render from one source.
 */
import { renderReport } from "../src/reports/render.js";
import type { ReportPayload } from "../src/reports/types.js";
import { sections, playbookMeta } from "./infinibot-2026-playbook-v1-content.mjs";

const OUT = "/tmp/infinibot-2026-playbook-v1.pdf";

// ─────────────────────────────────────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────────────────────────────────────
const payload: ReportPayload = {
  title: playbookMeta.title,
  subtitle: playbookMeta.subtitle,
  eyebrow: playbookMeta.eyebrow,
  metrics: playbookMeta.metrics,
  sections,
  footer: playbookMeta.footer,
};

const buf = await renderReport(payload, { savePath: OUT });
console.log(`WROTE ${OUT} (${buf.length} bytes, ${sections.length} sections)`);
