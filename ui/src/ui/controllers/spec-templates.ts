/**
 * Standardised, customisable project-spec templates.
 *
 * A spec that opens blank gets used as a scratchpad — which is what the free
 * "Notes" editor already was. These templates give every project the same
 * skeleton (Overview / Scope / Deliverables / To-do / Acceptance criteria /
 * Out of scope, plus Milestones where the shape of the work needs dates), so
 * two people reading two specs are reading the same document.
 *
 * ## Where custom templates live
 *
 * There is no "list documents" RPC on the block store — only
 * `kanban.projects.content.getBlocks` / `.saveBlocks` keyed by an arbitrary
 * string. So a custom template is persisted as *two* documents under a
 * reserved key prefix, and no backend change is needed:
 *
 *  - `__spec_template__::<slug>`     — the template's blocks, verbatim.
 *  - `__spec_template__::__index__`  — a single `code` block whose text is a
 *    JSON array of `{slug, name, description}`, because without it there
 *    would be no way to discover which slugs exist.
 *
 * The prefix is reserved: `specDocId()` builds `<projectId>::spec`, and a
 * project id can never be the literal string `__spec_template__`, so template
 * documents and project specs cannot collide.
 *
 * Trade-off, stated plainly: the index is a second write, so a crash between
 * the two writes can leave a template document with no index entry (invisible,
 * harmless) or an index entry with no document (surfaced as an empty template
 * rather than a crash — see `loadCustomTemplate`). Both are recoverable by
 * re-saving; neither loses a project's spec.
 *
 * ## Merge safety
 *
 * `applyTemplate` will never drop a to-do that is checked or that has already
 * been dispatched to an AI employee. That is not an emergent property of the
 * merge algorithm — it is a final, explicit pass (`carryOverProtected`) that
 * re-appends anything the merge lost. See the note on that function.
 */

import type { GatewayBrowserClient } from "../gateway";
import type { SpecBlock } from "./project-spec";

/** Reserved document-key prefix for template storage. Never a project id. */
export const SPEC_TEMPLATE_PREFIX = "__spec_template__";
/** Document key holding the JSON index of custom templates. */
export const SPEC_TEMPLATE_INDEX_DOC = `${SPEC_TEMPLATE_PREFIX}::__index__`;

/** Document key for one custom template's blocks. */
export function customTemplateDocId(slug: string): string {
  return `${SPEC_TEMPLATE_PREFIX}::${slug}`;
}

/** Project facts a built-in template can weave into its scaffold. */
export interface SpecTemplateContext {
  name?: string;
  description?: string;
  techStack?: string[];
}

export interface SpecTemplate {
  slug: string;
  name: string;
  /** One line shown under the name in the picker. */
  description: string;
  source: "builtin" | "custom";
  build(context: SpecTemplateContext): SpecBlock[];
}

/** Metadata as it is persisted in the index document. */
export interface CustomTemplateMeta {
  slug: string;
  name: string;
  description: string;
}

/**
 * The sections every standard template carries, in order. Kept as data so the
 * merge can recognise a section it did not itself write, and so the panel can
 * explain what "standard" means without duplicating the list.
 */
export const STANDARD_SECTIONS = [
  "Overview",
  "Scope",
  "Deliverables",
  "Milestones",
  "To-do",
  "Acceptance criteria",
  "Out of scope",
] as const;

// ── Block construction helpers ───────────────────────────────────────────

interface SectionSpec {
  heading: string;
  /** Lines under the heading. `todo` lines become dispatchable checkboxes. */
  lines: Array<{ type: SpecBlock["type"]; text: string }>;
}

function p(text: string) {
  return { type: "paragraph", text } as const;
}
function b(text: string) {
  return { type: "bullet", text } as const;
}
function t(text: string) {
  return { type: "todo", text } as const;
}

/**
 * Turn a title plus a list of sections into blocks with stable, template-local
 * ids. Ids are deterministic (`<slug>-<n>`) rather than random so that
 * re-applying the same template to the same spec is idempotent at the block
 * level — a merge can recognise "I already added this" and a dispatch key
 * derived from a block id stays stable across reloads.
 */
function buildBlocks(slug: string, title: string, sections: SectionSpec[]): SpecBlock[] {
  const out: SpecBlock[] = [];
  let n = 0;
  const id = () => `${slug}-${++n}`;
  out.push({ id: id(), type: "h1", text: title });
  for (const section of sections) {
    out.push({ id: id(), type: "h2", text: section.heading });
    for (const line of section.lines) {
      const block: SpecBlock = { id: id(), type: line.type, text: line.text };
      if (line.type === "todo") block.checked = false;
      out.push(block);
    }
  }
  return out;
}

function title(context: SpecTemplateContext, fallback: string): string {
  return context.name ? `${context.name} — spec` : fallback;
}

function overviewLines(context: SpecTemplateContext, prompt: string) {
  const lines: SectionSpec["lines"] = [p(context.description?.trim() || prompt)];
  if (context.techStack?.length) {
    lines.push(b(`Stack: ${context.techStack.join(" · ")}`));
  }
  return lines;
}

// ── Built-in templates ───────────────────────────────────────────────────

const WEB_BUILD: SpecTemplate = {
  slug: "web-build",
  name: "Web build",
  description: "Fixed-scope site or app build with milestones and a launch gate.",
  source: "builtin",
  build: (context) =>
    buildBlocks("web-build", title(context, "Web build — spec"), [
      {
        heading: "Overview",
        lines: overviewLines(context, "What we are building, for whom, and why it exists."),
      },
      {
        heading: "Scope",
        lines: [
          b("Pages / screens in scope, one line each."),
          b("Integrations the build depends on (CMS, payments, analytics)."),
          b("Who supplies copy, imagery and brand assets, and by when."),
        ],
      },
      {
        heading: "Deliverables",
        lines: [
          b("Designed, responsive, accessible front end."),
          b("Deployed environment plus handover of access."),
          b("Short written handover: how to edit it, who to call."),
        ],
      },
      {
        heading: "Milestones",
        lines: [
          b("Kickoff — scope signed, assets received."),
          b("Design review — layouts approved."),
          b("Build complete — staging URL for client review."),
          b("Launch — live on production domain."),
        ],
      },
      {
        heading: "To-do",
        lines: [
          p("Anything here can be handed to an AI employee from the panel below."),
          t("Confirm scope and asset handover with the client"),
          t("Produce page-level layouts for review"),
          t("Build and deploy to staging"),
        ],
      },
      {
        heading: "Acceptance criteria",
        lines: [
          b("Every page in scope renders correctly on mobile and desktop."),
          b("No console errors; core flows work end to end."),
          b("Client has signed off on staging before launch."),
        ],
      },
      {
        heading: "Out of scope",
        lines: [
          b("Ongoing content updates after launch."),
          b("Anything not listed under Scope — raise it as a change request."),
        ],
      },
    ]),
};

const RETAINER: SpecTemplate = {
  slug: "retainer",
  name: "Retainer / ongoing",
  description: "Recurring monthly engagement — commitments, cadence and reporting.",
  source: "builtin",
  build: (context) =>
    buildBlocks("retainer", title(context, "Retainer — spec"), [
      {
        heading: "Overview",
        lines: overviewLines(
          context,
          "What this retainer covers each month, and the outcome it is bought for.",
        ),
      },
      {
        heading: "Scope",
        lines: [
          b("Monthly hours or work units included."),
          b("Response and turnaround commitments."),
          b("Named contacts on both sides."),
        ],
      },
      {
        heading: "Deliverables",
        lines: [
          b("Recurring deliverable, stated as a countable thing per month."),
          b("Monthly report covering what shipped and what moved."),
        ],
      },
      {
        heading: "Milestones",
        lines: [
          b("Month 1 — baseline captured, backlog agreed."),
          b("Quarterly review — renew, resize or stop."),
        ],
      },
      {
        heading: "To-do",
        lines: [
          p("Recurring work for this cycle. Dispatch each item to an AI employee."),
          t("Confirm this cycle's priorities with the client"),
          t("Draft the monthly report"),
        ],
      },
      {
        heading: "Acceptance criteria",
        lines: [
          b("Committed work units delivered within the cycle."),
          b("Report sent before the invoice date."),
        ],
      },
      {
        heading: "Out of scope",
        lines: [
          b("Net-new builds — those are separate fixed-scope projects."),
          b("Unused hours do not roll over unless stated here."),
        ],
      },
    ]),
};

const CONTENT: SpecTemplate = {
  slug: "content-production",
  name: "Content production",
  description: "Batch content: formats, volumes, review loop and publishing.",
  source: "builtin",
  build: (context) =>
    buildBlocks("content-production", title(context, "Content production — spec"), [
      {
        heading: "Overview",
        lines: overviewLines(
          context,
          "The content this project produces, the audience, and the channel it lands on.",
        ),
      },
      {
        heading: "Scope",
        lines: [
          b("Formats and volumes per cycle (e.g. 8 posts, 2 long-form, 1 video)."),
          b("Voice, tone and brand rules that apply."),
          b("Who reviews, and how many revision rounds are included."),
        ],
      },
      {
        heading: "Deliverables",
        lines: [
          b("Finished assets in the agreed formats and dimensions."),
          b("Source files and captions/alt text."),
          b("Publishing calendar."),
        ],
      },
      {
        heading: "Milestones",
        lines: [
          b("Concepts approved."),
          b("First batch delivered for review."),
          b("Final batch scheduled."),
        ],
      },
      {
        heading: "To-do",
        lines: [
          p("Each item below can be dispatched to an AI employee."),
          t("Draft the content brief and voice guide"),
          t("Produce the first batch"),
          t("Schedule approved assets"),
        ],
      },
      {
        heading: "Acceptance criteria",
        lines: [
          b("Agreed volume delivered on the agreed dates."),
          b("Every asset passes brand and factual review."),
        ],
      },
      {
        heading: "Out of scope",
        lines: [
          b("Paid promotion and media spend."),
          b("Revisions beyond the included rounds."),
        ],
      },
    ]),
};

const AUTOMATION: SpecTemplate = {
  slug: "automation",
  name: "Automation / integration",
  description: "Systems work — trigger, data flow, failure handling and rollback.",
  source: "builtin",
  build: (context) =>
    buildBlocks("automation", title(context, "Automation — spec"), [
      {
        heading: "Overview",
        lines: overviewLines(
          context,
          "The manual process this replaces, and what it costs today.",
        ),
      },
      {
        heading: "Scope",
        lines: [
          b("Systems connected, and which is the source of truth."),
          b("Trigger — what starts the flow."),
          b("Data written, and where."),
          b("Credentials and access required, and who provides them."),
        ],
      },
      {
        heading: "Deliverables",
        lines: [
          b("Working automation in the client's own accounts."),
          b("Runbook: how to pause it, how to re-run a failed job."),
          b("Failure alerting to a named human."),
        ],
      },
      {
        heading: "Milestones",
        lines: [
          b("Access granted and mapping agreed."),
          b("Dry run against test data."),
          b("Cutover to live, with the manual process still available."),
        ],
      },
      {
        heading: "To-do",
        lines: [
          p("Dispatch these to an AI employee once access is in place."),
          t("Map the fields between the two systems"),
          t("Build and dry-run the flow against test data"),
          t("Write the runbook and wire up failure alerts"),
        ],
      },
      {
        heading: "Acceptance criteria",
        lines: [
          b("Dry run matches the manual process on the same input."),
          b("A forced failure alerts a human and does not silently drop data."),
          b("Rollback to the manual process is documented and tested."),
        ],
      },
      {
        heading: "Out of scope",
        lines: [
          b("Changes to the connected systems themselves."),
          b("Ongoing monitoring after handover, unless a retainer covers it."),
        ],
      },
    ]),
};

const BLANK: SpecTemplate = {
  slug: "blank",
  name: "Blank",
  description: "Just the standard headings — fill them in yourself.",
  source: "builtin",
  build: (context) =>
    buildBlocks(
      "blank",
      title(context, "Project spec"),
      STANDARD_SECTIONS.filter((s) => s !== "Milestones").map((heading) => ({
        heading,
        lines:
          heading === "To-do"
            ? [t("First task")]
            : heading === "Overview"
              ? overviewLines(context, "One paragraph on what this is and why it exists.")
              : [b("…")],
      })),
    ),
};

export const BUILTIN_SPEC_TEMPLATES: SpecTemplate[] = [
  WEB_BUILD,
  RETAINER,
  CONTENT,
  AUTOMATION,
  BLANK,
];

export function findTemplate(templates: SpecTemplate[], slug: string): SpecTemplate | null {
  return templates.find((template) => template.slug === slug) ?? null;
}

// ── Merge ────────────────────────────────────────────────────────────────

export type ApplyMode = "replace" | "merge";

export interface ApplyTemplateOptions {
  /**
   * Block ids that already have a work item against them. Together with
   * `checked`, this is what makes a to-do untouchable.
   */
  dispatchedBlockIds?: Iterable<string>;
}

export interface ApplyTemplateResult {
  blocks: SpecBlock[];
  /** Ids of protected to-dos that the merge would have dropped and we re-added. */
  carriedOver: string[];
  /** How many blocks the template contributed. */
  added: number;
  mode: ApplyMode;
}

const HEADINGS = new Set(["h1", "h2", "h3"]);

/** Heading used when a protected to-do has to be rescued. */
export const CARRY_OVER_HEADING = "Carried over";

function normalise(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ").replace(/[:.]+$/, "");
}

/**
 * A to-do is protected when it is checked, or when it has been dispatched to an
 * AI employee. Dispatch is keyed on the block id, so losing the block orphans a
 * queued work item — the checkbox stops reflecting real, in-flight work.
 */
export function isProtectedBlock(block: SpecBlock, dispatched: Set<string>): boolean {
  if (dispatched.has(block.id)) return true;
  return block.type === "todo" && block.checked === true;
}

interface Section {
  heading: SpecBlock | null;
  body: SpecBlock[];
}

function splitSections(blocks: SpecBlock[]): Section[] {
  const sections: Section[] = [];
  let current: Section = { heading: null, body: [] };
  for (const block of blocks) {
    if (HEADINGS.has(block.type)) {
      if (current.heading || current.body.length) sections.push(current);
      current = { heading: block, body: [] };
    } else {
      current.body.push(block);
    }
  }
  if (current.heading || current.body.length) sections.push(current);
  return sections;
}

function flatten(sections: Section[]): SpecBlock[] {
  const out: SpecBlock[] = [];
  for (const section of sections) {
    if (section.heading) out.push(section.heading);
    out.push(...section.body);
  }
  return out;
}

/** Give template-derived blocks ids that cannot collide with what is already there. */
function freshen(blocks: SpecBlock[], taken: Set<string>): SpecBlock[] {
  return blocks.map((block) => {
    let id = block.id;
    let n = 2;
    while (taken.has(id)) id = `${block.id}-${n++}`;
    taken.add(id);
    return { ...block, id };
  });
}

/**
 * The safety net.
 *
 * Every path through `applyTemplate` ends here. Rather than reasoning about
 * whether the merge *happened* to keep each protected to-do, we check, and
 * re-append the ones that are missing under their own heading. A merge bug can
 * therefore make the document untidy; it cannot make queued work disappear.
 */
function carryOverProtected(
  blocks: SpecBlock[],
  original: SpecBlock[],
  dispatched: Set<string>,
): { blocks: SpecBlock[]; carriedOver: string[] } {
  const present = new Set(blocks.map((block) => block.id));
  const missing = original.filter(
    (block) => isProtectedBlock(block, dispatched) && !present.has(block.id),
  );
  if (missing.length === 0) return { blocks, carriedOver: [] };
  const taken = new Set(present);
  let headingId = "carry-over";
  while (taken.has(headingId)) headingId = `${headingId}-2`;
  return {
    blocks: [
      ...blocks,
      { id: headingId, type: "h2", text: CARRY_OVER_HEADING },
      ...missing.map((block) => ({ ...block })),
    ],
    carriedOver: missing.map((block) => block.id),
  };
}

/**
 * Apply a template to an existing spec.
 *
 * `merge` keeps the operator's document and folds in whatever the template adds
 * that is not already there: sections are matched by normalised heading text,
 * and within a matched section only lines whose text is not already present are
 * appended. Existing blocks keep their ids, which is what preserves the join
 * between a to-do and the work item it was dispatched as.
 *
 * `replace` swaps the document for the template — but still carries over
 * checked and dispatched to-dos, because a template swap is a formatting
 * decision and should never be a way to silently cancel queued work. The panel
 * says as much on the button.
 */
export function applyTemplate(
  existing: SpecBlock[],
  template: SpecTemplate,
  mode: ApplyMode,
  context: SpecTemplateContext = {},
  options: ApplyTemplateOptions = {},
): ApplyTemplateResult {
  const dispatched = new Set(options.dispatchedBlockIds ?? []);
  const templateBlocks = template.build(context);

  if (mode === "replace") {
    const fresh = freshen(templateBlocks, new Set());
    const rescued = carryOverProtected(fresh, existing, dispatched);
    return { blocks: rescued.blocks, carriedOver: rescued.carriedOver, added: fresh.length, mode };
  }

  const taken = new Set(existing.map((block) => block.id));
  const existingSections = splitSections(existing);
  const templateSections = splitSections(templateBlocks);

  // First matching heading wins; a spec with two "To-do" headings gets its
  // new lines appended to the first, which is where a reader looks.
  const byHeading = new Map<string, Section>();
  for (const section of existingSections) {
    if (!section.heading) continue;
    const key = normalise(section.heading.text);
    if (!byHeading.has(key)) byHeading.set(key, section);
  }

  const seenText = (section: Section) =>
    new Set(section.body.map((block) => normalise(block.text)).filter(Boolean));

  let added = 0;
  const appended: Section[] = [];
  for (const section of templateSections) {
    if (!section.heading) {
      // Template preamble (there is none today) — only useful on an empty spec.
      if (existing.length === 0) {
        const body = freshen(section.body, taken);
        added += body.length;
        appended.push({ heading: null, body });
      }
      continue;
    }
    const match = byHeading.get(normalise(section.heading.text));
    if (match) {
      const seen = seenText(match);
      const novel = section.body.filter((block) => {
        const key = normalise(block.text);
        return key ? !seen.has(key) : true;
      });
      if (novel.length) {
        const body = freshen(novel, taken);
        added += body.length;
        match.body.push(...body);
      }
      continue;
    }
    const [heading, ...body] = freshen([section.heading, ...section.body], taken);
    added += 1 + body.length;
    appended.push({ heading, body });
  }

  const merged = flatten([...existingSections, ...appended]);
  const rescued = carryOverProtected(merged, existing, dispatched);
  return { blocks: rescued.blocks, carriedOver: rescued.carriedOver, added, mode };
}

// ── Custom template persistence ──────────────────────────────────────────

export function slugifyTemplateName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "custom";
}

function toBlocks(raw: unknown): SpecBlock[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((block): block is Record<string, unknown> => Boolean(block) && typeof block === "object")
    .map((block) => ({
      id: typeof block.id === "string" ? block.id : "",
      type: typeof block.type === "string" ? block.type : "paragraph",
      text: typeof block.text === "string" ? block.text : "",
      checked: block.checked === true,
      language: typeof block.language === "string" ? block.language : undefined,
      src: typeof block.src === "string" ? block.src : undefined,
    }))
    .filter((block) => block.id);
}

/** Parse the index document. Anything unreadable is treated as "no templates". */
export function parseTemplateIndex(blocks: SpecBlock[]): CustomTemplateMeta[] {
  const doc = blocks.find((block) => block.text.trim().startsWith("["));
  if (!doc) return [];
  try {
    const parsed: unknown = JSON.parse(doc.text);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === "object")
      .map((e) => ({
        slug: String(e.slug ?? ""),
        name: String(e.name ?? e.slug ?? "Custom template"),
        description: String(e.description ?? "Saved template"),
      }))
      .filter((e) => e.slug);
  } catch {
    return [];
  }
}

export function serialiseTemplateIndex(entries: CustomTemplateMeta[]): SpecBlock[] {
  return [{ id: "index", type: "code", text: JSON.stringify(entries, null, 2), language: "json" }];
}

async function readIndex(client: GatewayBrowserClient): Promise<CustomTemplateMeta[]> {
  const response = (await client
    .request("kanban.projects.content.getBlocks", { projectId: SPEC_TEMPLATE_INDEX_DOC })
    .catch(() => null)) as Record<string, unknown> | null;
  return parseTemplateIndex(toBlocks(response?.blocks));
}

async function writeIndex(
  client: GatewayBrowserClient,
  entries: CustomTemplateMeta[],
): Promise<void> {
  await client.request("kanban.projects.content.saveBlocks", {
    projectId: SPEC_TEMPLATE_INDEX_DOC,
    blocks: serialiseTemplateIndex(entries),
  });
}

/**
 * Load every custom template. A template whose document is missing still
 * appears (empty) rather than being dropped, so a half-written save is
 * visible and repairable instead of silently absent.
 */
export async function listCustomTemplates(
  client: GatewayBrowserClient,
): Promise<SpecTemplate[]> {
  const index = await readIndex(client);
  const loaded = await Promise.all(
    index.map(async (meta) => {
      const response = (await client
        .request("kanban.projects.content.getBlocks", { projectId: customTemplateDocId(meta.slug) })
        .catch(() => null)) as Record<string, unknown> | null;
      const blocks = toBlocks(response?.blocks);
      const template: SpecTemplate = {
        slug: meta.slug,
        name: meta.name,
        description: meta.description,
        source: "custom",
        // Custom templates are captured documents, not generators, so the
        // project context is deliberately ignored — what you saved is what
        // you get.
        build: () => blocks.map((block) => ({ ...block })),
      };
      return template;
    }),
  );
  return loaded;
}

/**
 * Save the given blocks as a reusable custom template.
 *
 * To-do state is stripped: a template ships tasks, not their completion. Saving
 * a spec with three ticked boxes and applying it elsewhere must not pre-tick
 * them on the new project.
 */
export async function saveCustomTemplate(
  client: GatewayBrowserClient,
  input: { name: string; description?: string; blocks: SpecBlock[] },
): Promise<CustomTemplateMeta> {
  const slug = slugifyTemplateName(input.name);
  const meta: CustomTemplateMeta = {
    slug,
    name: input.name.trim() || slug,
    description: input.description?.trim() || "Saved from a project spec",
  };
  const blocks = input.blocks.map((block, i) => ({
    ...block,
    id: `${slug}-${i + 1}`,
    ...(block.type === "todo" ? { checked: false } : {}),
  }));
  await client.request("kanban.projects.content.saveBlocks", {
    projectId: customTemplateDocId(slug),
    blocks,
  });
  const index = await readIndex(client);
  const next = [...index.filter((entry) => entry.slug !== slug), meta];
  await writeIndex(client, next);
  return meta;
}

/** Remove a custom template from the index and blank its document. */
export async function deleteCustomTemplate(
  client: GatewayBrowserClient,
  slug: string,
): Promise<void> {
  const index = await readIndex(client);
  await writeIndex(
    client,
    index.filter((entry) => entry.slug !== slug),
  );
  await client
    .request("kanban.projects.content.saveBlocks", {
      projectId: customTemplateDocId(slug),
      blocks: [],
    })
    .catch(() => undefined);
}
