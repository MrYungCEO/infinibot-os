import {
  syncToNotion,
  syncFromNotion,
  syncBidirectional,
  getNotionSyncStatus,
  createNotionDatabases,
} from "../../tasks/notion-sync.js";
import { syncNotionPage, extractNotionPageId } from "../../databases/notion-page-sync.js";
import { loadConfig } from "../../config/config.js";
import { GatewayRequestHandlers } from "./types.js";

// ── Workflow → Notion page ────────────────────────────────────────
//
// The kanban sync above mirrors projects/tasks into their own databases.
// Workflows have no Notion database, so they are mirrored as plain child
// pages under the operator's configured `notion.parentPageId` — the same
// parent the setup wizard uses.

const NOTION_VERSION = "2022-06-28";
const NOTION_BASE = "https://api.notion.com/v1";

function notionHeaders(): Record<string, string> {
  const key = process.env.NOTION_API_KEY ?? loadConfig().notion?.apiKey;
  if (!key) throw new Error("Notion API key not set (NOTION_API_KEY or config notion.apiKey)");
  return {
    Authorization: `Bearer ${key}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

async function notionFetch(path: string, init: RequestInit): Promise<any> {
  const res = await fetch(`${NOTION_BASE}${path}`, {
    ...init,
    headers: notionHeaders(),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as any)?.message ?? `Notion HTTP ${res.status}`);
  }
  return data;
}

/** Notion caps a rich_text run at 2000 chars, so long bodies are chunked. */
function bodyToBlocks(body: string): unknown[] {
  const chunks: string[] = [];
  for (let i = 0; i < body.length; i += 1900) chunks.push(body.slice(i, i + 1900));
  if (chunks.length === 0) chunks.push("");
  return chunks.map((text) => ({
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content: text } }] },
  }));
}

export const notionSyncHandlers: GatewayRequestHandlers = {
  "notion.sync": async ({ respond }) => {
    try {
      const result = await syncBidirectional();
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "notion.sync.status": async ({ respond }) => {
    try {
      const status = getNotionSyncStatus();
      respond(true, status);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "notion.sync.push": async ({ respond }) => {
    try {
      const result = await syncToNotion();
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "notion.sync.pull": async ({ respond }) => {
    try {
      const result = await syncFromNotion();
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Mirror a single workflow to Notion as a child page. Creates the page on
   * first sync and rewrites it thereafter (existing blocks are archived so
   * the page reflects the current body rather than accumulating copies).
   * Answers `{ notionPageId, url, created }` — the caller stores the id back
   * on the workflow so subsequent syncs update in place.
   */
  "notion.sync.workflow": async ({ params, respond }) => {
    try {
      const workflowId = typeof params.workflowId === "string" ? params.workflowId : "";
      const name =
        typeof params.name === "string" && params.name.trim()
          ? params.name.trim()
          : workflowId || "Untitled workflow";
      const description = typeof params.description === "string" ? params.description : "";
      const tags = Array.isArray(params.tags) ? (params.tags as string[]) : [];
      const body = typeof params.body === "string" ? params.body : "";
      const existingPageId =
        typeof params.notionPageId === "string" && params.notionPageId.trim()
          ? params.notionPageId.trim()
          : null;

      if (!workflowId) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "workflowId is required" });
        return;
      }

      const PARA_BREAK = "\n\n";
      const header = [description, tags.length ? `Tags: ${tags.join(", ")}` : ""]
        .filter(Boolean)
        .join(PARA_BREAK);
      const children = bodyToBlocks(header ? `${header}${PARA_BREAK}${body}` : body);

      if (existingPageId) {
        await notionFetch(`/pages/${existingPageId}`, {
          method: "PATCH",
          body: JSON.stringify({
            properties: { title: { title: [{ type: "text", text: { content: name } }] } },
          }),
        });

        // Clear the previous body so the page is a mirror, not an append log.
        const listed = await notionFetch(`/blocks/${existingPageId}/children?page_size=100`, {
          method: "GET",
        });
        for (const block of (listed?.results ?? []) as Array<{ id?: string }>) {
          if (!block?.id) continue;
          await notionFetch(`/blocks/${block.id}`, { method: "DELETE" });
        }

        await notionFetch(`/blocks/${existingPageId}/children`, {
          method: "PATCH",
          body: JSON.stringify({ children }),
        });

        respond(true, { notionPageId: existingPageId, created: false, workflowId });
        return;
      }

      const parentPageId = loadConfig().notion?.parentPageId;
      if (!parentPageId) {
        respond(false, undefined, {
          code: "NOT_CONFIGURED",
          message:
            "No Notion parent page configured. Set notion.parentPageId (the Notion setup wizard does this) before syncing workflows.",
        });
        return;
      }

      const page = await notionFetch("/pages", {
        method: "POST",
        body: JSON.stringify({
          parent: { page_id: parentPageId },
          properties: { title: { title: [{ type: "text", text: { content: name } }] } },
          children,
        }),
      });

      respond(true, { notionPageId: page?.id, url: page?.url, created: true, workflowId });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "notion.sync.setup": async ({ params, respond }) => {
    try {
      const parentPageId =
        typeof params.parentPageId === "string" ? params.parentPageId : undefined;
      const result = await createNotionDatabases(parentPageId);
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Sync a single Notion PAGE (by URL or page ID) into InfiniBot.
   *
   * Creates or updates:
   *   • A note with the full page content (all blocks recursively, markdown)
   *   • A Kanban project matching the page title
   *   • Kanban tasks from to_do blocks and embedded database rows
   *
   * Idempotent: re-syncing the same page updates rather than duplicates.
   *
   * params: { pageUrl?: string, pageId?: string, apiKey?: string }
   * result: { pageId, title, noteId, isNew, subpages, mediaUrls, tasksCreated, tasksUpdated, projectId, warnings }
   */
  "notion.page.sync": async ({ params, respond }) => {
    try {
      const urlOrId =
        (typeof params.pageUrl === "string" && params.pageUrl.trim() ? params.pageUrl : null) ??
        (typeof params.pageId === "string" && params.pageId.trim() ? params.pageId : null);

      if (!urlOrId) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "pageUrl or pageId is required",
        });
        return;
      }

      const apiKey =
        typeof params.apiKey === "string" && params.apiKey.trim()
          ? params.apiKey
          : (process.env.NOTION_API_KEY ?? loadConfig().notion?.apiKey);

      if (!apiKey) {
        respond(false, undefined, {
          code: "NOT_CONFIGURED",
          message:
            "No Notion API key. Set NOTION_API_KEY or configure via the Notion setup wizard.",
        });
        return;
      }

      const result = await syncNotionPage(urlOrId, {
        apiKey,
        maxDepth: typeof params.maxDepth === "number" ? params.maxDepth : 2,
        maxBlocksPerPage:
          typeof params.maxBlocksPerPage === "number" ? params.maxBlocksPerPage : 250,
      });

      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Preview a Notion page without writing anything — returns title, subpages,
   * media URLs, and to_do count. Useful for a "what will be synced?" preview.
   *
   * params: { pageUrl?: string, pageId?: string, apiKey?: string }
   */
  "notion.page.preview": async ({ params, respond }) => {
    try {
      const urlOrId =
        (typeof params.pageUrl === "string" && params.pageUrl.trim() ? params.pageUrl : null) ??
        (typeof params.pageId === "string" && params.pageId.trim() ? params.pageId : null);

      if (!urlOrId) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "pageUrl or pageId is required",
        });
        return;
      }

      const apiKey =
        typeof params.apiKey === "string" && params.apiKey.trim()
          ? params.apiKey
          : (process.env.NOTION_API_KEY ?? loadConfig().notion?.apiKey);

      if (!apiKey) {
        respond(false, undefined, {
          code: "NOT_CONFIGURED",
          message: "No Notion API key configured.",
        });
        return;
      }

      const pageId = extractNotionPageId(urlOrId);

      // Import helpers directly from notion-import for preview
      const { fetchPageBlocksDeep, collectFileUrlsFromBlocks, richTextToMarkdown } =
        await import("../../databases/notion-import.js");

      const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Notion-Version": "2022-06-28",
        },
        signal: AbortSignal.timeout(15_000),
      });
      const page = await res.json();
      if (!res.ok) {
        respond(false, undefined, {
          code: "NOTION_ERROR",
          message: page?.message ?? `HTTP ${res.status}`,
        });
        return;
      }

      const title =
        Object.values(page.properties ?? {})
          .filter((v: any) => v?.type === "title")
          .map((v: any) => richTextToMarkdown(v.title))
          .find(Boolean) || "Untitled";

      const blocks = await fetchPageBlocksDeep(pageId, apiKey, {
        maxDepth: 1,
        maxBlocksPerPage: 100,
      });

      const subpages = blocks
        .filter((b: any) => b.type === "child_page")
        .map((b: any) => ({ id: b.id, title: b.child_page?.title ?? "Untitled" }));

      const childDatabases = blocks
        .filter((b: any) => b.type === "child_database")
        .map((b: any) => ({ id: b.id, title: b.child_database?.title ?? "Untitled" }));

      const mediaUrls = collectFileUrlsFromBlocks(blocks);

      const todoCount = blocks.reduce((acc: number, b: any) => {
        const walk = (list: any[]): number =>
          list.reduce(
            (a: number, x: any) =>
              a + (x.type === "to_do" ? 1 : 0) + (Array.isArray(x.children) ? walk(x.children) : 0),
            0,
          );
        return (
          acc + (b.type === "to_do" ? 1 : 0) + (Array.isArray(b.children) ? walk(b.children) : 0)
        );
      }, 0);

      respond(true, {
        pageId,
        title,
        subpages,
        childDatabases,
        mediaUrls,
        todoCount,
        blockCount: blocks.length,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};
