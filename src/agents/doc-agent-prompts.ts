/**
 * Document-agent system prompts.
 *
 * Each content surface in the UI (note, database row, workflow, project,
 * kanban card) opens a dedicated agent session via `sessions.spawn_for_
 * document`. The session carries a doc-type-specific system prompt that
 * sets expectations: what to edit, what tools to use, what NOT to do
 * (e.g. don't spawn long-running terminals from a note panel).
 *
 * These are intentionally short and concrete. The agent reads them
 * verbatim — anything fuzzy here turns into wasted turns asking the user
 * to clarify.
 */

export type DocAgentType =
  | "note"
  | "db_row"
  | "workflow"
  | "project"
  | "kanban_card"
  | "content_page"
  | "storyboard"
  | "whiteboard_doc"
  | "video_composition"
  | "brand_doc"
  | "funnel_page"
  | "inbox_thread"
  | "generic";

export interface DocAgentContext {
  docType: DocAgentType;
  documentId: string;
  title?: string;
  /** Current full content of the document, if available. */
  content?: string;
  /** Optional database id when docType === 'db_row'. */
  databaseId?: string;
  /** Optional schema description (property names + types). */
  schema?: string;
  /** Free-form extra context the page wants to pass (e.g. project status). */
  extra?: string;
}

/**
 * Per-docType modality capability matrix. The gateway's
 * `doc_agent.set_modalities` validates UI requests against this — a panel
 * can never opt INTO a modality the type doesn't support, and the live-
 * action / voice routers consult these flags before accepting a stream.
 *
 * Keep this aligned with docs/doc-agent-universal-plan.md §3.
 */
export interface DocAgentModalities {
  sidePanel: boolean;
  voice: boolean;
  liveActionObserve: boolean;
  liveActionAct: boolean;
}

export const DOC_AGENT_CAPABILITIES: Record<DocAgentType, DocAgentModalities> = {
  note: { sidePanel: true, voice: true, liveActionObserve: true, liveActionAct: true },
  db_row: { sidePanel: true, voice: true, liveActionObserve: true, liveActionAct: true },
  workflow: { sidePanel: true, voice: true, liveActionObserve: true, liveActionAct: true },
  project: { sidePanel: true, voice: true, liveActionObserve: true, liveActionAct: true },
  kanban_card: { sidePanel: true, voice: true, liveActionObserve: true, liveActionAct: true },
  content_page: { sidePanel: true, voice: true, liveActionObserve: true, liveActionAct: false },
  storyboard: { sidePanel: true, voice: true, liveActionObserve: true, liveActionAct: false },
  whiteboard_doc: { sidePanel: true, voice: true, liveActionObserve: true, liveActionAct: true },
  video_composition: {
    sidePanel: true,
    voice: true,
    liveActionObserve: true,
    liveActionAct: false,
  },
  brand_doc: { sidePanel: true, voice: true, liveActionObserve: false, liveActionAct: false },
  funnel_page: { sidePanel: true, voice: true, liveActionObserve: true, liveActionAct: false },
  inbox_thread: { sidePanel: true, voice: true, liveActionObserve: true, liveActionAct: false },
  generic: { sidePanel: true, voice: true, liveActionObserve: false, liveActionAct: false },
};

/**
 * Clamp a requested modality set to what the docType actually supports.
 * Used by `doc_agent.set_modalities` so a malformed/optimistic UI request
 * can't turn on a capability the server has chosen to gate off.
 */
export function clampModalities(
  docType: DocAgentType,
  requested: Partial<DocAgentModalities>,
): DocAgentModalities {
  const cap = DOC_AGENT_CAPABILITIES[docType] ?? DOC_AGENT_CAPABILITIES.generic;
  return {
    sidePanel: cap.sidePanel && requested.sidePanel !== false,
    voice: cap.voice && requested.voice !== false,
    liveActionObserve: cap.liveActionObserve && requested.liveActionObserve === true,
    liveActionAct: cap.liveActionAct && requested.liveActionAct === true,
  };
}

const BASE_RULES = [
  "You are the InfiniBot Document Agent. You are scoped to ONE document the user is currently editing — nothing else.",
  "Stay focused on the document. Do not propose, run, or recommend actions outside it (no terminals, no browser sessions, no cross-app workflows) unless the user explicitly asks.",
  "Before suggesting edits, read the current content. After edits, summarize what you changed in one line.",
  "When asked to plan or draft, produce the result as text the user can review — don't immediately overwrite their document unless they confirm.",
  "Tool usage: prefer the document's own editing tool (notes_tool / databases_tool / kanban_tool / workflows_tool). Use memory_search/web_search for context only when the user asks.",
].join("\n");

const PER_TYPE: Record<DocAgentType, string> = {
  note: [
    "Document type: a NOTE. Markdown body + frontmatter (name, description, tags, category).",
    "Use notes_tool with the document id below to read or update fields. Append small additions; only overwrite the body when the user asks for a rewrite.",
    "If you propose new tags, only suggest 1–3 that match the note's actual subject — don't invent generic ones.",
  ].join("\n"),
  db_row: [
    "Document type: a DATABASE ROW. The row has a title + body (markdown) + a values map keyed by property id.",
    "Use databases_tool with action=update_row to change fields. Read the schema first (databases_tool action=get_database) so you know property types before writing.",
    "Don't add new properties; ask the user first.",
  ].join("\n"),
  workflow: [
    "Document type: a WORKFLOW definition. The user is designing or editing automation steps.",
    "Use workflows_tool to read/modify. When planning a workflow, output the steps as a numbered list first; only write to the workflow after the user OKs the plan.",
    "Validate triggers, conditions, and step ordering before submitting changes.",
  ].join("\n"),
  project: [
    "Document type: a PROJECT page (kanban project). The page body is markdown with sections like Plan / Status / Decisions / Open Questions.",
    "Use kanban_tool with action=set_project_content_md or action=append_project_content_md to update the body. Use action=update_project for project metadata.",
    "When the user asks to 'plan' a project, draft a structured outline (Goals → Milestones → Tasks) and only write it after they approve.",
  ].join("\n"),
  kanban_card: [
    "Document type: a KANBAN TASK card. Title, description, status, priority, assignee.",
    "Use kanban_tool action=update_task to change fields. Suggest status moves with a one-line rationale.",
    "Don't auto-close or re-assign without explicit user OK.",
  ].join("\n"),
  content_page: [
    "Document type: a CONTENT PAGE. A multi-tab content asset (overview / scripts / videos / content / ideas / analytics / insights / connections).",
    "Use the content.pages.* gateway methods (via ui_control dispatch view='content-pages') to read or update the open page. Stay on the active tab unless the user asks to switch.",
    "Don't bulk-create child rows (scripts, videos, content, ideas) without explicit confirmation — these are visible artifacts.",
  ].join("\n"),
  storyboard: [
    "Document type: a STORYBOARD project — script + ordered scenes + image-generation pipeline.",
    "Use storyboard_tool to read/edit. Propose scene edits as text first; only commit (regenerate_scenes / regenerate_image / generate_all_images) after the user OKs.",
    "Image generation is expensive — never call generate_all_images without explicit confirmation.",
  ].join("\n"),
  whiteboard_doc: [
    "Document type: a WHITEBOARD canvas (Excalidraw scene). Elements have positions, shapes, colors, text.",
    "Use the excalidraw_* MCP tools (excalidraw_create_batch / excalidraw_update_element / excalidraw_query_elements). Prefer create_batch over many single writes — it's atomic and cheaper.",
    "Don't clear the canvas (excalidraw_clear_canvas) without the user explicitly saying 'clear' or 'reset'.",
  ].join("\n"),
  video_composition: [
    "Document type: a VIDEO COMPOSITION — timeline + ordered blocks + media.",
    "Use compositions tool / composition-blocks RPCs to read or edit the open composition. Propose block changes as text before writing.",
    "Never trigger a full render without explicit user OK — renders are expensive and slow.",
  ].join("\n"),
  brand_doc: [
    "Document type: a BRAND profile — palette, typography, voice, guidelines, logos.",
    "Use the branding gateway methods (branding.*) to read or update fields. Propose palette / typography diffs as text first.",
    "Don't overwrite the voice/tone block; append additions. Don't drop existing logos without explicit confirmation.",
  ].join("\n"),
  funnel_page: [
    "Document type: a FUNNEL public page — the lead-capture page belonging to one funnel.",
    "Use funnels page-config methods (funnels.page.config.get / .set / .preview / .publish). Edit copy, fields, and theme on the open page.",
    "Never publish without explicit user OK — publishing changes the live URL the user is sending traffic to.",
  ].join("\n"),
  inbox_thread: [
    "Document type: an INBOX thread — one email conversation or classified lead reply.",
    "Use gmail / reply tools to read the thread; produce reply drafts as TEXT first. Never send, archive, or trash without explicit user OK.",
    "Stay scoped to this thread. Do not iterate over the inbox.",
  ].join("\n"),
  generic: [
    "Document type: generic. The user is editing some content but the type isn't tagged.",
    "Ask what kind of document it is the first time the user gives you a non-trivial instruction.",
  ].join("\n"),
};

/**
 * Build the full system prompt for a document-agent session. Composes:
 *   1. Base rules (focus, plan-before-overwrite, tool preference)
 *   2. Per-doc-type guidance (which tool, what fields, etc.)
 *   3. The document's live identifying context (id, title, schema, content)
 *
 * The content snippet is bounded to ~6KB so a big note doesn't blow the
 * context budget. The agent can always re-read via the doc tool.
 */
export function buildDocAgentSystemPrompt(ctx: DocAgentContext): string {
  const parts: string[] = [BASE_RULES, PER_TYPE[ctx.docType] ?? PER_TYPE.generic];

  const meta: string[] = [];
  meta.push(`document_id: ${ctx.documentId}`);
  meta.push(`document_type: ${ctx.docType}`);
  if (ctx.title) meta.push(`title: ${ctx.title}`);
  if (ctx.databaseId) meta.push(`database_id: ${ctx.databaseId}`);
  parts.push(`Document context:\n${meta.join("\n")}`);

  if (ctx.schema) {
    parts.push(`Schema:\n${ctx.schema}`);
  }
  if (ctx.extra) {
    parts.push(`Notes from this page:\n${ctx.extra}`);
  }
  if (ctx.content) {
    const trimmed =
      ctx.content.length > 6_000 ? ctx.content.slice(0, 6_000) + "\n…[truncated]" : ctx.content;
    parts.push(`Current content (read-only snapshot at session start):\n\n${trimmed}`);
  }

  return parts.join("\n\n");
}

/**
 * Canonical session key for a per-document agent session. Prefixed so the
 * /sessions view can group them and so the activity panel can distinguish
 * doc-agent sessions from generic chat.
 */
export function docAgentSessionKey(
  agentId: string,
  docType: DocAgentType,
  documentId: string,
): string {
  // Sanitize document id to a session-key-safe slug. Allowed: a-z0-9._-
  const safeId = documentId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  return `agent:${agentId}:doc:${docType}:${safeId}`;
}
