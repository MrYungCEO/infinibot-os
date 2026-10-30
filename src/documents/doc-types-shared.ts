/**
 * Document types — the pure, browser-safe half (no node: imports): the type
 * model, the built-in registry, templates and the inference rules. The
 * control UI imports this directly; doc-types.ts adds the persisted store.
 */

import type { DocNode, DocPropertyValue } from "./types.js";

/** Where a type's items live. */
export type DocTypeBacking = "documents" | "ideas" | "reports";

export interface DocTypeDef {
  id: string;
  label: string;
  /** Icon name from ui/src/ui/icons.ts. */
  icon: string;
  /** #rrggbb */
  color: string;
  description?: string;
  /** Body a new document of this type starts with. `{{date}}` → YYYY-MM-DD. */
  template?: string;
  builtin: boolean;
  backing: DocTypeBacking;
  /** False for read-only listings (Reports). */
  creatable: boolean;
  hidden?: boolean;
  archived?: boolean;
  order: number;
}

export interface CustomDocType {
  id: string;
  label: string;
  icon: string;
  color: string;
  description?: string;
  template?: string;
  archived?: boolean;
  createdAt: string;
  updatedAt: string;
}

export const DEFAULT_DOC_TYPE = "note";

export const BUILTIN_DOC_TYPES: ReadonlyArray<Omit<DocTypeDef, "order">> = [
  {
    id: "note",
    label: "Note",
    icon: "penLine",
    color: "#d9b45f",
    builtin: true,
    backing: "documents",
    creatable: true,
    description: "Quick thoughts and scratch notes",
  },
  {
    id: "idea",
    label: "Idea",
    icon: "lightbulb",
    color: "#f3c623",
    builtin: true,
    backing: "ideas",
    creatable: true,
    description: "Captured ideas — explore, park, promote",
  },
  {
    id: "document",
    label: "Document",
    icon: "fileText",
    color: "#c9c3b6",
    builtin: true,
    backing: "documents",
    creatable: true,
    description: "Long-form documents and imported pages",
  },
  {
    id: "meeting",
    label: "Meeting notes",
    icon: "users",
    color: "#5fb3d9",
    builtin: true,
    backing: "documents",
    creatable: true,
    description: "Agenda, notes, decisions, action items",
    template:
      "## Date\n{{date}}\n\n## Attendees\n- \n\n## Agenda\n1. \n\n## Notes\n\n## Decisions\n- \n\n## Action items\n- [ ] \n",
  },
  {
    id: "research",
    label: "Research",
    icon: "book",
    color: "#7cc68d",
    builtin: true,
    backing: "documents",
    creatable: true,
    description: "Findings, analysis, sources — plus Research workspace items",
    template: "## Question\n\n## Findings\n\n## Sources\n- \n",
  },
  {
    id: "report",
    label: "Report",
    icon: "barChart",
    color: "#e08a5f",
    builtin: true,
    backing: "reports",
    creatable: false,
    description: "Rendered reports (read-only, from Reports)",
  },
  {
    id: "sop",
    label: "SOP / How-to",
    icon: "clipboard",
    color: "#9f8cf0",
    builtin: true,
    backing: "documents",
    creatable: true,
    description: "Procedures, guides and runbooks",
    template: "## Purpose\n\n## When to use\n\n## Steps\n1. \n2. \n3. \n\n## Checks\n- [ ] \n",
  },
  {
    id: "spec",
    label: "Spec / PRD",
    icon: "fileCode",
    color: "#4fc1c9",
    builtin: true,
    backing: "documents",
    creatable: true,
    description: "Requirements and specifications",
    template:
      "## Problem\n\n## Goals\n- \n\n## Non-goals\n- \n\n## Requirements\n1. \n\n## Open questions\n- \n",
  },
  {
    id: "brief",
    label: "Brief",
    icon: "briefcase",
    color: "#e0b25f",
    builtin: true,
    backing: "documents",
    creatable: true,
    description: "Briefs, proposals and pitches",
    template:
      "## Objective\n\n## Audience\n\n## Key message\n\n## Deliverables\n- \n\n## Timeline\n",
  },
  {
    id: "journal",
    label: "Journal / Log",
    icon: "calendar",
    color: "#c98fb8",
    builtin: true,
    backing: "documents",
    creatable: true,
    description: "Dated entries, logs and diaries",
    template: "## {{date}}\n\n",
  },
  {
    id: "plan",
    label: "Plan",
    icon: "target",
    color: "#e06a6a",
    builtin: true,
    backing: "documents",
    creatable: true,
    description: "Plans, roadmaps and strategies",
    template: "## Goal\n\n## Milestones\n- [ ] \n\n## Risks\n- \n\n## Next steps\n- [ ] \n",
  },
  {
    id: "template",
    label: "Template",
    icon: "layers",
    color: "#8fa3b8",
    builtin: true,
    backing: "documents",
    creatable: true,
    description: "Reusable starting points",
  },
  {
    id: "snippet",
    label: "Snippet / Prompt",
    icon: "terminal",
    color: "#a3c95f",
    builtin: true,
    backing: "documents",
    creatable: true,
    description: "Prompts, snippets and reusable text",
    template: "```\n\n```\n",
  },
];

export const BUILTIN_IDS: ReadonlySet<string> = new Set(BUILTIN_DOC_TYPES.map((t) => t.id));

export function isBuiltinType(id: string): boolean {
  return BUILTIN_IDS.has(id);
}

/** Fill `{{date}}` placeholders in a template body. */
export function renderTemplate(tpl: string | undefined, now = new Date()): string {
  if (!tpl) return "";
  return tpl.replace(/\{\{\s*date\s*\}\}/g, now.toISOString().slice(0, 10));
}

// ── Inference (migration + read-time default for untyped documents) ─────────

export interface InferredType {
  type: string;
  reason: string;
}

/** Words/phrases → type, checked against titles (word-boundary regexes, first match wins). */
const TITLE_RULES: Array<[RegExp, string]> = [
  [
    /\b(meeting|stand-?up|1:1|one[- ]on[- ]one|retro(spective)?|minutes|call notes|interview notes|(weekly|daily|team) sync)\b/i,
    "meeting",
  ],
  [/\b(journal|diary|changelog|daily log|diagnostic log|log)\b/i, "journal"],
  [/\b(templates?)\b/i, "template"],
  [/\b(prompts?|snippets?|prompt[- ]anatomy)\b/i, "snippet"],
  [/\b(spec|specs|specification|prd|requirements)\b/i, "spec"],
  [/\b(plan|plans|roadmap|strategy|milestones)\b/i, "plan"],
  [/\b(sop|how[- ]to|guide|playbook|runbook|manual|reference|procedure|checklist|skill)\b/i, "sop"],
  [/\b(brief|proposal|pitch|one[- ]pager|recommendation)\b/i, "brief"],
  [
    /\b(research|analysis|analyses|competitive|competitor|landscape|dossier|compared|comparison|study|findings|discovery|news)\b/i,
    "research",
  ],
];

const TAG_RULES: Record<string, string> = {
  meeting: "meeting",
  meetings: "meeting",
  standup: "meeting",
  research: "research",
  analysis: "research",
  "competitive-analysis": "research",
  plan: "plan",
  roadmap: "plan",
  "continuation-plan": "plan",
  spec: "spec",
  prd: "spec",
  requirements: "spec",
  sop: "sop",
  howto: "sop",
  "how-to": "sop",
  guide: "sop",
  runbook: "sop",
  playbook: "sop",
  documentation: "sop",
  reference: "sop",
  log: "journal",
  journal: "journal",
  diary: "journal",
  prompt: "snippet",
  prompts: "snippet",
  snippet: "snippet",
  template: "template",
  brief: "brief",
  proposal: "brief",
};

/** Legacy note categories (notes.* `category`, capture.save, idea promotion). */
const CATEGORY_RULES: Record<string, string> = {
  log: "journal",
  journal: "journal",
  meeting: "meeting",
  research: "research",
  plan: "plan",
  spec: "spec",
  sop: "sop",
  brief: "brief",
  template: "template",
  snippet: "snippet",
  prompt: "snippet",
  idea: "document",
  document: "document",
  "voice-note": "note",
  note: "note",
};

function propString(v: DocPropertyValue | undefined): string | undefined {
  if (typeof v === "string") return v.trim().toLowerCase() || undefined;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0].trim().toLowerCase() || undefined;
  return undefined;
}

/**
 * Best-guess type for a document that has none. Order: legacy category/type
 * property → tags → title words → source (imports/uploads = Document) → Note.
 * `customTypes` lets a property like `Type: Recipe` match a custom type by label.
 */
export function inferDocType(
  node: Pick<DocNode, "kind" | "title" | "tags" | "properties" | "source" | "file">,
  customTypes: Array<Pick<DocTypeDef, "id" | "label">> = [],
): InferredType {
  const props = node.properties ?? {};
  for (const key of ["Type", "type", "Category", "category", "Kind"]) {
    const v = propString(props[key]);
    if (!v) continue;
    if (CATEGORY_RULES[v]) return { type: CATEGORY_RULES[v]!, reason: `property ${key}=${v}` };
    if (BUILTIN_IDS.has(v) && v !== "idea" && v !== "report")
      return { type: v, reason: `property ${key}=${v}` };
    const custom = customTypes.find((c) => c.label.toLowerCase() === v || c.id === v);
    if (custom) return { type: custom.id, reason: `property ${key}=${v}` };
  }
  for (const raw of node.tags ?? []) {
    const t = raw.trim().toLowerCase().replace(/^#/, "");
    if (TAG_RULES[t]) return { type: TAG_RULES[t]!, reason: `tag #${t}` };
  }
  const title = (node.title ?? "").replace(/[_]+/g, " ").replace(/\.(md|markdown|txt)$/i, "");
  for (const [re, type] of TITLE_RULES) {
    const m = re.exec(title);
    if (m) return { type, reason: `title "${m[0]}"` };
  }
  const src = node.source?.type;
  if (src === "notion" || src === "notion-zip")
    return { type: "document", reason: `imported from ${src}` };
  if (src === "upload" || src === "url" || src === "path")
    return { type: "document", reason: `${src} source` };
  if (node.kind === "file") return { type: "document", reason: "uploaded file" };
  if (src === "obsidian") return { type: "note", reason: "obsidian note" };
  return { type: DEFAULT_DOC_TYPE, reason: "default" };
}

/** The type a node shows as: its stored type, else the inferred one. Folders have none. */
export function effectiveDocType(
  node: DocNode,
  customTypes: Array<Pick<DocTypeDef, "id" | "label">> = [],
): { type: string | null; inferred: boolean } {
  if (node.kind === "folder") return { type: null, inferred: false };
  if (node.type) return { type: node.type, inferred: false };
  return { type: inferDocType(node, customTypes).type, inferred: true };
}
