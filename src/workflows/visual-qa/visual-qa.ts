/**
 * Multi-Device Visual QA / Layout Check — standardized, reusable workflow.
 *
 * Parameterized visual-QA pass for ANY site: for every page × every device
 * viewport it loads the page headless, screenshots it full-page, and
 * programmatically checks for element overlap + spacing/overflow/tap-target
 * problems, then sends the whole screenshot flow + a pass/fail issue summary
 * to Telegram. The heavy lifting lives in the reusable engine at
 * `scripts/visual-qa-multidevice.mjs`; this workflow just parameterizes and
 * invokes it, so it can be re-run on any project.
 *
 * Registration mirrors {@link ensureReleasePublisherWorkflow} — an idempotent
 * `ensure...` registrar that writes the definition into the WorkflowStore so
 * it appears in `workflows.list` as a standard workflow.
 */

import { WorkflowStore } from "../store.js";
import { resolveStateDir } from "../../config/paths.js";

export const VISUAL_QA_WORKFLOW_ID = "multi-device-visual-qa";

const WORKFLOW_BODY = `# Multi-Device Visual QA / Layout Check

Standardized, reusable visual-QA pass for **any** website. For every page ×
every device width it loads the page headless (puppeteer + system Chrome),
takes a full-page screenshot, and programmatically checks for **element
overlap** and **spacing/layout** problems (horizontal overflow, content wider
than the viewport, elements clipping/touching edges, tiny tap targets on
mobile), then sends the whole screenshot flow + a pass/fail issue summary to
Telegram.

This workflow is **read-only** against the live target URL — it never edits the
target site. All artifacts are written under a /tmp directory.

## Inputs
See the \`<inputs>\` block at the top of this task.
- **baseUrl** — target site root (e.g. \`https://example.com\`).
- **pages** — comma-separated routes to check (e.g. \`/,/about,/contact\`). Blank = just \`/\`.
- **devices** — comma-separated device presets. Blank = full standard matrix:
  \`desktop-1920,desktop-1440,tablet-1024,tablet-768,mobile-390,mobile-360\`.
- **crawl** — if true, auto-discover additional pages from the nav of the first page.
- **sendTelegram** — if true, send the screenshot flow + summary to Telegram.

## Step 1 — Run the reusable engine

Call the \`Bash\` tool **once** to run the standardized engine, passing the
inputs through. Write artifacts to \`/tmp/visualqa-<host>/\`:

\`\`\`
node scripts/visual-qa-multidevice.mjs \\
  --url "{{baseUrl}}" \\
  --pages "{{pages}}" \\
  --devices "{{devices}}" \\
  --out "/tmp/visualqa-run" \\
  {{crawl}} \\
  {{sendTelegram}}
\`\`\`

(Include \`--crawl\` only when crawl is true; include \`--telegram\` only when
sendTelegram is true.)

## Step 2 — Read the report

Read \`/tmp/visualqa-run/report.json\` (and \`report.md\`). It contains, per
page × device: a **pass/fail** verdict and the specific issues found
(\`horizontal-overflow\`, \`element-overlap\`, \`edge-clipping\`,
\`tiny-tap-targets\`, \`load-error\`).

## Step 3 — Report back

Summarize per page/device which views are **clean** and which have
**overlap / bad spacing / overflow**, and confirm the Telegram send. If the
engine reported \`telegram.ok === false\`, surface the error (missing botToken /
chatId is the usual cause) so the operator can fix the channel config.
`;

/** Register the workflow definition in the store (idempotent). */
export function ensureVisualQaWorkflow(stateDir = resolveStateDir()): void {
  try {
    const store = new WorkflowStore(stateDir);
    const existing = store.get(VISUAL_QA_WORKFLOW_ID);
    if (existing) return;
    store.create({
      id: VISUAL_QA_WORKFLOW_ID,
      name: "Multi-Device Visual QA / Layout Check",
      description:
        "Screenshot every page across a desktop/tablet/mobile device matrix, programmatically flag element overlap + spacing/overflow/tap-target problems, and send the full screenshot flow + pass/fail summary to Telegram. Reusable for any site.",
      tags: ["qa", "visual", "layout", "responsive", "screenshots", "telegram"],
      author: "visual-qa",
      kind: "static",
      body: WORKFLOW_BODY,
      timeoutSeconds: 1200,
      inputs: [
        {
          name: "baseUrl",
          label: "Target base URL",
          type: "url",
          required: true,
          placeholder: "https://example.com",
          description: "Root URL of the site to visually QA.",
        },
        {
          name: "pages",
          label: "Pages / routes (comma-separated)",
          type: "string",
          required: false,
          default: "/",
          description: "Routes to check, e.g. /,/about,/contact. Blank = home only.",
        },
        {
          name: "devices",
          label: "Device matrix (comma-separated)",
          type: "string",
          required: false,
          default: "desktop-1920,desktop-1440,tablet-1024,tablet-768,mobile-390,mobile-360",
          description:
            "Device presets. Options: desktop-1920, desktop-1440, tablet-1024, tablet-768, mobile-390, mobile-360.",
        },
        {
          name: "crawl",
          label: "Auto-discover pages from nav",
          type: "boolean",
          required: false,
          default: false,
          description: "Crawl the first page's nav for additional same-origin routes.",
        },
        {
          name: "sendTelegram",
          label: "Send results to Telegram",
          type: "boolean",
          required: false,
          default: true,
          description: "Send all screenshots + the pass/fail issue summary to Telegram.",
        },
      ],
      requires: [
        {
          kind: "tool",
          name: "Bash",
          reason: "Runs the puppeteer visual-QA engine (scripts/visual-qa-multidevice.mjs).",
        },
        {
          kind: "channel",
          name: "telegram",
          optional: true,
          reason: "Only needed when sendTelegram is true.",
        },
      ],
    });
  } catch {
    /* best-effort — built-in workflow registration must never block boot. */
  }
}
