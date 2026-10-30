/**
 * Project specs — a structured, dispatchable document per project.
 *
 * The /projects page already mounted the Notion-style block editor as a free
 * "Notes" box. That gave interactive checkboxes but no shape: nothing said what
 * the deliverables were, and a checked box was just a checked box — no work
 * reached an AI employee.
 *
 * This controller adds the spec on top of the SAME block store, under a
 * separate document key (`<projectId>::spec`), so notes and spec never
 * overwrite each other and the spec inherits persistence, undo and the slash
 * menu for free.
 *
 * **Why everything here is local.** `projects.*` is wrapped in
 * `applySatelliteProxy`, so the project LIST comes from master. But the block
 * store (`kanban.projects.content.*`) and the AI workforce
 * (`agency.ops.employee.*`) are NOT proxied — they are this node's. A spec
 * stored on master could not dispatch to a local employee, and a work item
 * created locally could not be shown against a master-held spec. So the spec
 * lives beside the workforce that executes it, exactly as the Notes editor
 * already does. Trade-off: a spec is per-device, not shared across the mesh.
 *
 * **Dispatch is idempotent.** Each to-do carries a stable block id, and the
 * work item is created with `idempotencyKey = spec:<projectId>:<blockId>`, so
 * clicking twice — or re-dispatching after a reload — cannot fan out duplicate
 * work into the autonomy loop.
 */

import type { GatewayBrowserClient } from "../gateway";
import { resolveAgency } from "./agency-common";
import {
  BUILTIN_SPEC_TEMPLATES,
  applyTemplate,
  listCustomTemplates,
  saveCustomTemplate,
  type ApplyMode,
  type SpecTemplate,
  type SpecTemplateContext,
} from "./spec-templates";

/** Block shape as the editor persists it. Mirrors views/project-content-editor. */
export interface SpecBlock {
  id: string;
  type: string;
  text: string;
  checked?: boolean;
  language?: string;
  src?: string;
}

/** The document key for a project's spec, kept distinct from its notes. */
export function specDocId(projectId: string): string {
  return `${projectId}::spec`;
}

/** Stable idempotency key for one to-do's dispatch. */
export function dispatchKey(projectId: string, blockId: string): string {
  return `spec:${projectId}:${blockId}`;
}

/** The AI-assisted actions a spec can route to the Project Manager. */
export type PmAction = "draft" | "review" | "breakdown";

/**
 * FNV-1a, 32-bit, hex. Not a security hash — it exists only to give an
 * idempotency key a cheap, deterministic "which version of the text is this"
 * discriminator that is identical in every browser.
 */
export function stableHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Idempotency key for a Project Manager request.
 *
 * A bare `spec:<id>:pm:review` key would be double-click-safe but would also
 * refuse the *second* review a month later, when the spec has changed and a
 * fresh review is exactly what the operator wants. So the key carries a hash of
 * the material being sent: clicking twice on the same text is one work item;
 * asking again after editing the spec is a new one. `revision` is the spec
 * markdown for draft/review, and `<blockId>|<text>` for a single-block
 * breakdown.
 */
export function pmActionKey(projectId: string, action: PmAction, revision: string): string {
  return `spec:${projectId}:pm:${action}:${stableHash(revision)}`;
}

/** Roles we accept as "the Project Manager", loosest match last. */
const PM_ROLE_RE = /\b(project\s*manager|delivery\s*manager|programme?\s*manager)\b|^pm$/i;

/**
 * Resolve the employee that PM work routes to.
 *
 * Never invents an id — it only ever returns one of the employees the gateway
 * listed. When nothing matches, the caller is expected to show a picker rather
 * than guessing at the nearest-sounding role.
 */
export function findProjectManager(
  employees: { id: string; name: string; role: string | null }[],
): { id: string; name: string; role: string | null } | null {
  return employees.find((e) => PM_ROLE_RE.test((e.role ?? "").trim())) ?? null;
}

/**
 * Render spec blocks as markdown, so the PM receives the document as a human
 * would read it rather than as a blob of block JSON.
 */
export function specBlocksToMarkdown(blocks: SpecBlock[]): string {
  const lines: string[] = [];
  let numbered = 0;
  for (const block of blocks) {
    if (block.type !== "numbered") numbered = 0;
    switch (block.type) {
      case "h1": lines.push(`# ${block.text}`); break;
      case "h2": lines.push(`## ${block.text}`); break;
      case "h3": lines.push(`### ${block.text}`); break;
      case "bullet": lines.push(`- ${block.text}`); break;
      case "numbered": lines.push(`${++numbered}. ${block.text}`); break;
      case "todo": lines.push(`- [${block.checked ? "x" : " "}] ${block.text}`); break;
      case "quote": lines.push(`> ${block.text}`); break;
      case "callout": lines.push(`> 💡 ${block.text}`); break;
      case "code": lines.push("```" + (block.language ?? ""), block.text, "```"); break;
      case "divider": lines.push("---"); break;
      case "image": lines.push(`![${block.text}](${block.src ?? ""})`); break;
      default: lines.push(block.text);
    }
  }
  return lines.join("\n").trim();
}

/**
 * The scaffold a project spec starts from.
 *
 * Deliberately opinionated: a spec that opens blank gets used as a scratchpad,
 * which is what "Notes" already was. Headings name the four things a delivery
 * agency actually needs to agree on, and the to-do section is what dispatch
 * reads from.
 */
export function specTemplate(project: {
  name?: string;
  description?: string;
  techStack?: string[];
}): SpecBlock[] {
  const id = (n: number) => `seed-${n}`;
  const blocks: SpecBlock[] = [
    { id: id(1), type: "h1", text: project.name ? `${project.name} — spec` : "Project spec" },
    {
      id: id(2),
      type: "paragraph",
      text: project.description ?? "One paragraph on what this project is and why it exists.",
    },
    { id: id(3), type: "h2", text: "Deliverables" },
    { id: id(4), type: "bullet", text: "What the client actually receives. One line each." },
    { id: id(5), type: "h2", text: "To-do" },
    {
      id: id(6),
      type: "paragraph",
      text: "Anything checked off here can be handed to an AI employee from the panel below.",
    },
    { id: id(7), type: "todo", text: "Break the first deliverable into a task", checked: false },
    { id: id(8), type: "h2", text: "Acceptance criteria" },
    { id: id(9), type: "bullet", text: "How we know it is done and can invoice for it." },
  ];
  if (project.techStack?.length) {
    blocks.push(
      { id: id(10), type: "h2", text: "Stack" },
      { id: id(11), type: "paragraph", text: project.techStack.join(" · ") },
    );
  }
  return blocks;
}

export type DispatchStatus =
  | "queued"
  | "accepted"
  | "in_progress"
  | "review"
  | "completed"
  | "waiting"
  | "cancelled"
  | "escalated";

export interface SpecTodo {
  blockId: string;
  text: string;
  checked: boolean;
  /** The work item this to-do was dispatched as, when it has been. */
  workItemId: string | null;
  status: DispatchStatus | null;
  workerName: string | null;
}

export interface ProjectSpecState {
  projectId: string | null;
  loading: boolean;
  saving: boolean;
  /** True once the template has been written for a project with no spec yet. */
  seeded: boolean;
  blocks: SpecBlock[];
  todos: SpecTodo[];
  employees: { id: string; name: string; role: string | null }[];
  /** Block id currently being dispatched, so only that row shows a spinner. */
  dispatchingBlockId: string | null;
  /** The agency the workforce lives in, resolved once per session. */
  agencyId: string | null;
  /** Built-in plus custom templates, once loaded. */
  templates: SpecTemplate[];
  templatesLoading: boolean;
  /** Which AI action is in flight, so only that button shows busy. */
  busyAction: string | null;
  error: string | null;
  message: string | null;
}

const IDLE: ProjectSpecState = {
  projectId: null,
  loading: false,
  saving: false,
  seeded: false,
  blocks: [],
  todos: [],
  employees: [],
  dispatchingBlockId: null,
  agencyId: null,
  templates: [],
  templatesLoading: false,
  busyAction: null,
  error: null,
  message: null,
};

let state: ProjectSpecState = { ...IDLE };

export function projectSpecState(): ProjectSpecState {
  return state;
}

interface SpecHost {
  requestUpdate?: () => void;
}

function patch(host: SpecHost, next: Partial<ProjectSpecState>): void {
  state = { ...state, ...next };
  host.requestUpdate?.();
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.trim() || "the gateway rejected the request without saying why";
}

/** True when this gateway can dispatch spec to-dos into the autonomy loop. */
export function supportsSpecDispatch(client: GatewayBrowserClient): boolean {
  const advertised = client.serverMethods;
  return advertised ? advertised.has("agency.ops.employee.work-item.create") : false;
}

function toBlocks(raw: unknown): SpecBlock[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((b): b is Record<string, unknown> => Boolean(b) && typeof b === "object")
    .map((b) => ({
      id: typeof b.id === "string" ? b.id : "",
      type: typeof b.type === "string" ? b.type : "paragraph",
      text: typeof b.text === "string" ? b.text : "",
      checked: b.checked === true,
      language: typeof b.language === "string" ? b.language : undefined,
      src: typeof b.src === "string" ? b.src : undefined,
    }))
    .filter((b) => b.id);
}

/**
 * Pair each to-do block with the work item it was dispatched as.
 *
 * The join is on the work item's `context.blockId`, which dispatch writes.
 * Falling back to the idempotency key would also work, but reading context
 * keeps this independent of how the key is formatted.
 */
function joinTodos(
  blocks: SpecBlock[],
  projectId: string,
  workItems: Record<string, unknown>[],
  employees: { id: string; name: string }[],
): SpecTodo[] {
  const byBlock = new Map<string, Record<string, unknown>>();
  for (const item of workItems) {
    const context = (item.context ?? {}) as Record<string, unknown>;
    if (context.source !== "project-spec") continue;
    if (context.projectId !== projectId) continue;
    // PM actions (draft / review / breakdown) also carry source=project-spec and
    // may carry a blockId. They are advisory work *about* a to-do, not the
    // dispatch *of* it, so they must not claim the checkbox's status slot.
    if (typeof context.specAction === "string") continue;
    const blockId = typeof context.blockId === "string" ? context.blockId : null;
    if (blockId) byBlock.set(blockId, item);
  }
  const employeeName = new Map(employees.map((e) => [e.id, e.name]));
  return blocks
    .filter((b) => b.type === "todo")
    .map((b) => {
      const item = byBlock.get(b.id);
      const workerId = item && typeof item.workerId === "string" ? item.workerId : null;
      return {
        blockId: b.id,
        text: b.text,
        checked: b.checked === true,
        workItemId: item && typeof item.id === "string" ? item.id : null,
        status: item && typeof item.status === "string" ? (item.status as DispatchStatus) : null,
        workerName: workerId ? (employeeName.get(workerId) ?? workerId) : null,
      };
    });
}

/**
 * Load a project's spec, seeding the template the first time it is opened.
 *
 * Seeding writes immediately rather than rendering a "would-be" document, so
 * what the operator sees is what is stored — no invisible state that vanishes
 * if they close the panel without typing.
 */
export async function loadProjectSpec(
  host: SpecHost,
  client: GatewayBrowserClient,
  project: { projectId: string; name?: string; description?: string; techStack?: string[] },
  agencyId: string | null,
): Promise<void> {
  const docId = specDocId(project.projectId);
  patch(host, {
    projectId: project.projectId,
    loading: true,
    error: null,
    message: null,
    seeded: false,
  });
  try {
    const response = (await client.request("kanban.projects.content.getBlocks", {
      projectId: docId,
    })) as Record<string, unknown> | undefined;
    let blocks = toBlocks(response?.blocks);
    let seeded = false;
    if (blocks.length === 0) {
      blocks = specTemplate(project);
      await client.request("kanban.projects.content.saveBlocks", { projectId: docId, blocks });
      seeded = true;
    }
    // Employees and in-flight work are only meaningful when an agency is
    // selected; a project with no agency still gets a readable spec.
    let employees: { id: string; name: string; role: string | null }[] = [];
    let workItems: Record<string, unknown>[] = [];
    if (agencyId && supportsSpecDispatch(client)) {
      const [empRes, inboxRes] = await Promise.all([
        client.request("agency.ops.employees.list", { agencyId }).catch(() => null),
        client
          .request("agency.ops.employee.inbox.list", { agencyId, limit: 200 })
          .catch(() => null),
      ]);
      const rawEmployees = (empRes as Record<string, unknown> | null)?.employees;
      if (Array.isArray(rawEmployees)) {
        employees = rawEmployees
          .filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === "object")
          .map((e) => ({
            id: String(e.id ?? ""),
            name: String(e.name ?? e.id ?? "unnamed"),
            role: typeof e.role === "string" ? e.role : null,
          }))
          .filter((e) => e.id);
      }
      const rawItems = (inboxRes as Record<string, unknown> | null)?.workItems;
      if (Array.isArray(rawItems)) {
        workItems = rawItems.filter(
          (i): i is Record<string, unknown> => Boolean(i) && typeof i === "object",
        );
      }
    }
    patch(host, {
      loading: false,
      blocks,
      seeded,
      employees,
      todos: joinTodos(blocks, project.projectId, workItems, employees),
      message: seeded ? "Started this spec from the standard template." : null,
    });
  } catch (error) {
    patch(host, { loading: false, error: errorText(error) });
  }
}

/**
 * Re-read the spec blocks and work-item statuses without re-seeding.
 *
 * Called after the editor saves and after a dispatch, so the to-do panel and
 * the document never drift apart.
 */
export async function refreshProjectSpec(
  host: SpecHost,
  client: GatewayBrowserClient,
  projectId: string,
  agencyId: string | null,
): Promise<void> {
  try {
    const response = (await client.request("kanban.projects.content.getBlocks", {
      projectId: specDocId(projectId),
    })) as Record<string, unknown> | undefined;
    const blocks = toBlocks(response?.blocks);
    let workItems: Record<string, unknown>[] = [];
    if (agencyId && supportsSpecDispatch(client)) {
      const inbox = (await client
        .request("agency.ops.employee.inbox.list", { agencyId, limit: 200 })
        .catch(() => null)) as Record<string, unknown> | null;
      const rawItems = inbox?.workItems;
      if (Array.isArray(rawItems)) {
        workItems = rawItems.filter(
          (i): i is Record<string, unknown> => Boolean(i) && typeof i === "object",
        );
      }
    }
    patch(host, {
      blocks,
      todos: joinTodos(blocks, projectId, workItems, state.employees),
    });
  } catch (error) {
    patch(host, { error: errorText(error) });
  }
}

/**
 * Hand one to-do to an AI employee as a work item.
 *
 * The item enters the loop as `queued`, which is the staged column the human
 * authorisation gate sits on — dispatching from a spec does NOT start work, it
 * queues it, exactly like every other route into the workforce.
 */
export async function dispatchTodo(
  host: SpecHost,
  client: GatewayBrowserClient,
  options: {
    agencyId: string;
    projectId: string;
    projectName: string;
    blockId: string;
    title: string;
    workerId: string;
  },
): Promise<boolean> {
  if (state.dispatchingBlockId) return false;
  patch(host, { dispatchingBlockId: options.blockId, error: null, message: null });
  try {
    await client.request("agency.ops.employee.work-item.create", {
      agencyId: options.agencyId,
      workerId: options.workerId,
      title: options.title.slice(0, 200) || "Spec item",
      instructions:
        `From the project spec for "${options.projectName}".\n\n` +
        `Task: ${options.title}\n\n` +
        "Complete this item and report what changed. If the item is ambiguous, " +
        "raise it rather than guessing.",
      priority: "normal",
      // Stable across retries and reloads, so a double click cannot fan out
      // duplicate work into the loop.
      idempotencyKey: dispatchKey(options.projectId, options.blockId),
      context: {
        source: "project-spec",
        projectId: options.projectId,
        blockId: options.blockId,
      },
    });
    patch(host, { dispatchingBlockId: null, message: `Queued "${options.title.slice(0, 60)}".` });
    await refreshProjectSpec(host, client, options.projectId, options.agencyId);
    return true;
  } catch (error) {
    patch(host, { dispatchingBlockId: null, error: errorText(error) });
    return false;
  }
}

// ── Agency + template plumbing ───────────────────────────────────────────

/**
 * Resolve (once) the agency whose workforce this spec dispatches into.
 *
 * Cached on state rather than re-resolved per action: without an agency there
 * is no workforce, and every AI action below needs the same answer.
 */
export async function ensureSpecAgency(
  host: SpecHost,
  client: GatewayBrowserClient,
): Promise<string | null> {
  if (state.agencyId) return state.agencyId;
  const failures: string[] = [];
  const { agencyId } = await resolveAgency(client, failures).catch(() => ({ agencyId: null }));
  if (agencyId) patch(host, { agencyId });
  return agencyId;
}

/** Load built-in templates plus whatever the operator has saved. */
export async function ensureSpecTemplates(
  host: SpecHost,
  client: GatewayBrowserClient,
  options: { force?: boolean } = {},
): Promise<void> {
  if (state.templatesLoading) return;
  if (state.templates.length > 0 && !options.force) return;
  patch(host, { templatesLoading: true });
  const custom = await listCustomTemplates(client).catch(() => [] as SpecTemplate[]);
  patch(host, {
    templatesLoading: false,
    templates: [...BUILTIN_SPEC_TEMPLATES, ...custom],
  });
}

/** Block ids that already carry a work item — the untouchable set for a merge. */
export function dispatchedBlockIds(): string[] {
  return state.todos.filter((todo) => todo.workItemId).map((todo) => todo.blockId);
}

/**
 * Apply a template to a project's spec and persist the result.
 *
 * `currentBlocks` should come from the live editor when one is mounted, since
 * its debounced buffer can be ahead of what the gateway has stored; falling
 * back to the last loaded blocks is only for the unmounted case.
 */
export async function applySpecTemplate(
  host: SpecHost,
  client: GatewayBrowserClient,
  options: {
    projectId: string;
    template: SpecTemplate;
    mode: ApplyMode;
    context?: SpecTemplateContext;
    currentBlocks?: SpecBlock[];
    onApplied?: (blocks: SpecBlock[]) => void;
  },
): Promise<boolean> {
  if (state.busyAction) return false;
  patch(host, { busyAction: `template:${options.template.slug}`, error: null, message: null });
  try {
    const existing = options.currentBlocks ?? state.blocks;
    const result = applyTemplate(existing, options.template, options.mode, options.context ?? {}, {
      dispatchedBlockIds: dispatchedBlockIds(),
    });
    await client.request("kanban.projects.content.saveBlocks", {
      projectId: specDocId(options.projectId),
      blocks: result.blocks,
    });
    options.onApplied?.(result.blocks);
    const carried = result.carriedOver.length
      ? ` Kept ${result.carriedOver.length} in-flight to-do${result.carriedOver.length === 1 ? "" : "s"}.`
      : "";
    patch(host, {
      busyAction: null,
      blocks: result.blocks,
      message:
        `Applied "${options.template.name}" (${options.mode}) — ` +
        `${result.added} block${result.added === 1 ? "" : "s"} added.${carried}`,
    });
    await refreshProjectSpec(host, client, options.projectId, state.agencyId);
    return true;
  } catch (error) {
    patch(host, { busyAction: null, error: errorText(error) });
    return false;
  }
}

/** Capture the current spec as a reusable custom template. */
export async function saveSpecAsTemplate(
  host: SpecHost,
  client: GatewayBrowserClient,
  options: { name: string; description?: string; blocks: SpecBlock[] },
): Promise<boolean> {
  if (state.busyAction) return false;
  if (!options.name.trim()) {
    patch(host, { error: "Give the template a name first." });
    return false;
  }
  patch(host, { busyAction: "template:save", error: null, message: null });
  try {
    const meta = await saveCustomTemplate(client, options);
    patch(host, { busyAction: null, message: `Saved "${meta.name}" as a reusable template.` });
    await ensureSpecTemplates(host, client, { force: true });
    return true;
  } catch (error) {
    patch(host, { busyAction: null, error: errorText(error) });
    return false;
  }
}

// ── AI-assisted actions, routed to the Project Manager ───────────────────

function pmInstructions(
  action: PmAction,
  projectName: string,
  specMarkdown: string,
  blockText?: string,
): { title: string; body: string } {
  const spec = specMarkdown.trim() || "_(the spec is currently empty)_";
  if (action === "draft") {
    return {
      title: `Draft the project spec for ${projectName}`,
      body:
        `Draft the project spec for "${projectName}".\n\n` +
        "Fill in every standard section — Overview, Scope, Deliverables, To-do, " +
        "Acceptance criteria, Out of scope, and Milestones where the work has dates. " +
        "Write the To-do section as concrete, individually dispatchable tasks.\n\n" +
        `Current spec:\n\n${spec}\n\n` +
        "Where a fact is missing (budget, dates, who supplies assets), say so " +
        "explicitly in the draft rather than inventing it.",
    };
  }
  if (action === "review") {
    return {
      title: `Review the project spec for ${projectName}`,
      body:
        `Review and refine the project spec for "${projectName}".\n\n` +
        "Look for: scope that is not measurable, deliverables with no acceptance " +
        "criterion, to-dos too large to hand to one worker, and anything that " +
        "should be under Out of scope but is not. Return the refined spec plus a " +
        "short list of what you changed and why.\n\n" +
        `Current spec:\n\n${spec}`,
    };
  }
  return {
    title: `Break down: ${(blockText ?? "").slice(0, 80) || "spec item"}`,
    body:
      `From the project spec for "${projectName}", break this deliverable into ` +
      "individually assignable tasks.\n\n" +
      `Deliverable: ${blockText ?? ""}\n\n` +
      "Return a flat list of tasks, each small enough for one worker to finish in " +
      "a single sitting, each with its own acceptance criterion. If the deliverable " +
      "is too vague to break down, say what is missing instead of guessing.\n\n" +
      `Full spec for context:\n\n${spec}`,
  };
}

/**
 * Route an AI-assisted spec action to the Project Manager.
 *
 * Like every other route into the workforce, the item enters as `queued` — the
 * staged column is the human authorisation gate, so asking the PM to draft a
 * spec never starts work on its own.
 */
export async function askProjectManager(
  host: SpecHost,
  client: GatewayBrowserClient,
  options: {
    agencyId: string;
    projectId: string;
    projectName: string;
    action: PmAction;
    /** Must come from `agency.ops.employees.list` — never a synthesised id. */
    workerId: string;
    blocks: SpecBlock[];
    /** Required for `breakdown`: the block being decomposed. */
    blockId?: string;
    blockText?: string;
  },
): Promise<boolean> {
  const busyKey = `pm:${options.action}${options.blockId ? `:${options.blockId}` : ""}`;
  if (state.busyAction) return false;
  if (options.action === "breakdown" && !options.blockId) {
    patch(host, { error: "Nothing selected to break down." });
    return false;
  }
  patch(host, { busyAction: busyKey, error: null, message: null });
  try {
    const markdown = specBlocksToMarkdown(options.blocks);
    const { title, body } = pmInstructions(
      options.action,
      options.projectName,
      markdown,
      options.blockText,
    );
    const revision =
      options.action === "breakdown"
        ? `${options.blockId}|${options.blockText ?? ""}`
        : markdown;
    await client.request("agency.ops.employee.work-item.create", {
      agencyId: options.agencyId,
      workerId: options.workerId,
      title: title.slice(0, 200),
      instructions: body,
      priority: "normal",
      idempotencyKey: pmActionKey(options.projectId, options.action, revision),
      context: {
        source: "project-spec",
        projectId: options.projectId,
        specAction: options.action,
        ...(options.blockId ? { blockId: options.blockId } : {}),
      },
    });
    patch(host, { busyAction: null, message: `Queued for the Project Manager: ${title}` });
    await refreshProjectSpec(host, client, options.projectId, options.agencyId);
    return true;
  } catch (error) {
    patch(host, { busyAction: null, error: errorText(error) });
    return false;
  }
}

/** Clear the transient banner after the operator has read it. */
export function clearSpecNotice(host: SpecHost): void {
  patch(host, { error: null, message: null });
}

/** Drop spec state. Used when the selected project changes and by tests. */
export function resetProjectSpec(): void {
  state = { ...IDLE };
}
