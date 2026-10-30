/**
 * Gateway RPCs for the user-friendly Notion setup wizard.
 *
 * One method per step so the web UI can render granular progress and surface
 * actionable error messages (the most common case is "you forgot to share
 * the parent page with the integration" — the wizard catches that in the
 * verify step and tells the user exactly what to do).
 */
import {
  createSystemDatabases,
  finalizeNotionSetup,
  getStatus,
  importPageAsMarkdown,
  listAccessiblePages,
  runVerification,
  verifyToken,
  type NotionSetupStatus,
} from "../../databases/notion-wizard.js";
import { getNotionConfig, setNotionRuntimeOverride } from "../../databases/notion-config.js";
import { describeKanbanState } from "../../databases/kanban-store-ops.js";
import { NoteStore } from "../../notes/store.js";
import { getRoleMode, upsertRowForRole } from "../../databases/system-role-bridge.js";
import type { PropertyValue } from "../../databases/types.js";
import type { GatewayRequestHandlers } from "./types.js";

/**
 * Create a note honoring the same storage routing as the `notes.create`
 * gateway handler: a database-backed "notes" role when mapped, else the
 * legacy file store. Keeps Notion-imported pages visible in the Notes UI.
 */
function createImportedNote(title: string, body: string): void {
  if (getRoleMode("notes").mode === "database") {
    upsertRowForRole("notes", {
      title,
      body,
      values: {
        category: "Notion import",
        tags: ["notion"],
      } as unknown as Record<string, PropertyValue>,
    });
    return;
  }
  const stateDir = process.env.INFINIBOT_STATE_DIR ?? "state";
  new NoteStore(stateDir).create({
    name: title,
    body,
    category: "Notion import",
    tags: ["notion"],
  });
}

export const notionWizardHandlers: GatewayRequestHandlers = {
  /** Returns current Notion + kanban state — UI renders the entry screen from this. */
  "notion.wizard.status": async ({ respond }) => {
    try {
      const [status, kanban] = await Promise.all([
        getStatus(),
        Promise.resolve(describeKanbanState()),
      ]);
      respond(true, { notion: status, kanban });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Validate a Notion API token. Returns the integration name + workspace on success. */
  "notion.wizard.verifyToken": async ({ params, respond }) => {
    const apiKey = typeof params.apiKey === "string" ? params.apiKey : "";
    const result = await verifyToken(apiKey);
    if (!result.ok) {
      respond(true, result); // 200 + { ok: false, hint } so the UI can render the inline error
      return;
    }
    // Stage the key in-memory so subsequent step calls can pass it implicitly.
    setNotionRuntimeOverride({
      apiKey,
      integrationName: result.integrationName ?? null,
    });
    respond(true, result);
  },

  /** List pages the integration has been granted access to. */
  "notion.wizard.listPages": async ({ params, respond }) => {
    const apiKey = typeof params.apiKey === "string" ? params.apiKey : "";
    if (!apiKey) {
      respond(false, undefined, { code: "BAD_REQUEST", message: "apiKey required" });
      return;
    }
    try {
      const pages = await listAccessiblePages(apiKey);
      respond(true, { pages });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Import selected Notion pages as Notes. Each page is flattened to markdown
   * and written to the Notes store (database-backed when the "notes" role is
   * mapped, else the legacy file store). Returns a per-page success/skip count
   * so the wizard can show what landed. `target` is accepted for forward
   * compatibility; "notes" is the only destination currently wired.
   */
  "notion.wizard.importPages": async ({ params, respond }) => {
    const apiKey = resolveApiKeyParam(params);
    const pageIds = Array.isArray(params.pageIds)
      ? (params.pageIds as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    const target = typeof params.target === "string" ? params.target : "notes";
    if (!apiKey) {
      respond(false, undefined, { code: "BAD_REQUEST", message: "apiKey required" });
      return;
    }
    if (pageIds.length === 0) {
      respond(false, undefined, { code: "BAD_REQUEST", message: "select at least one page" });
      return;
    }
    try {
      const imported: Array<{ id: string; title: string }> = [];
      const skipped: string[] = [];
      for (const pageId of pageIds) {
        const content = await importPageAsMarkdown(apiKey, pageId);
        if (!content) {
          skipped.push(pageId);
          continue;
        }
        const body = content.markdown.trim()
          ? content.markdown
          : "_(Imported from Notion — this page had no readable body blocks.)_";
        createImportedNote(content.title, body);
        imported.push({ id: content.id, title: content.title });
      }
      respond(true, { target, imported, importedCount: imported.length, skipped });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Create the Projects + Tasks system DBs under the chosen parent page. */
  "notion.wizard.createSystemDbs": async ({ params, respond }) => {
    const apiKey = typeof params.apiKey === "string" ? params.apiKey : "";
    const parentPageId = typeof params.parentPageId === "string" ? params.parentPageId : "";
    if (!apiKey || !parentPageId) {
      respond(false, undefined, {
        code: "BAD_REQUEST",
        message: "apiKey and parentPageId required",
      });
      return;
    }
    try {
      const result = await createSystemDatabases({
        apiKey,
        parentPageId,
        projectsTitle: typeof params.projectsTitle === "string" ? params.projectsTitle : undefined,
        tasksTitle: typeof params.tasksTitle === "string" ? params.tasksTitle : undefined,
      });
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Run the verification pass — token, both DBs, relation correctness, write probe. */
  "notion.wizard.verifySetup": async ({ params, respond }) => {
    // Fall back to the saved key when the wizard didn't pass one. The
    // wizard clears `state.notionInput.apiKey` on rehydrate (the server
    // never sends secrets back to the browser), so a "jump straight to
    // verify on revisit" flow has no plaintext key in hand and would
    // otherwise re-prompt the user for something they already saved.
    const apiKey = resolveApiKeyParam(params);
    const projectsDbId = typeof params.projectsDbId === "string" ? params.projectsDbId : "";
    const tasksDbId = typeof params.tasksDbId === "string" ? params.tasksDbId : "";
    if (!apiKey || !projectsDbId || !tasksDbId) {
      respond(false, undefined, {
        code: "BAD_REQUEST",
        message: "apiKey, projectsDbId, tasksDbId required",
      });
      return;
    }
    try {
      const result = await runVerification({ apiKey, projectsDbId, tasksDbId });
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Persist the verified configuration and flip sync mode. */
  "notion.wizard.finalize": async ({ params, respond }) => {
    const apiKey = resolveApiKeyParam(params);
    if (!apiKey) {
      respond(false, undefined, { code: "BAD_REQUEST", message: "apiKey required" });
      return;
    }
    const syncMode =
      params.syncMode === "off" || params.syncMode === "import-once" || params.syncMode === "mirror"
        ? params.syncMode
        : "mirror";
    try {
      const result = await finalizeNotionSetup({
        apiKey,
        syncMode,
        parentPageId: typeof params.parentPageId === "string" ? params.parentPageId : undefined,
        projectsDbId: typeof params.projectsDbId === "string" ? params.projectsDbId : undefined,
        tasksDbId: typeof params.tasksDbId === "string" ? params.tasksDbId : undefined,
        integrationName:
          typeof params.integrationName === "string" ? params.integrationName : undefined,
        clientsDbId: typeof params.clientsDbId === "string" ? params.clientsDbId : undefined,
        leadsDbId: typeof params.leadsDbId === "string" ? params.leadsDbId : undefined,
        companiesDbId: typeof params.companiesDbId === "string" ? params.companiesDbId : undefined,
        dealsDbId: typeof params.dealsDbId === "string" ? params.dealsDbId : undefined,
        contactsDbId: typeof params.contactsDbId === "string" ? params.contactsDbId : undefined,
      });
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Disconnect Notion entirely — kanban keeps working from local SQLite. */
  "notion.wizard.disconnect": async ({ respond }) => {
    try {
      await finalizeNotionSetup({
        apiKey: "",
        syncMode: "off",
      });
      respond(true, { ok: true });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};

/**
 * Resolve the API key to use for a wizard call. Prefers the value the
 * wizard just typed; falls back to whatever's already on disk so the user
 * doesn't have to re-paste their token to confirm an existing connection.
 *
 * Treats whitespace-only strings as empty so a stray space doesn't end up
 * persisted as a "Notion key".
 */
function resolveApiKeyParam(params: Record<string, unknown>): string {
  const fromParam = typeof params.apiKey === "string" ? params.apiKey.trim() : "";
  if (fromParam) return fromParam;
  const saved = (getNotionConfig().apiKey ?? "").trim();
  return saved;
}

// Re-export for convenience when listing all handlers.
export type { NotionSetupStatus };
