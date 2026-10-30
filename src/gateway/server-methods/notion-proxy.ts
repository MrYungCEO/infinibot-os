import type { GatewayRequestHandlers } from "./types.js";

const NOTION_VERSION = "2022-06-28"; // Valid Notion API version
const NOTION_BASE = "https://api.notion.com/v1";

function getNotionApiKey(): string {
  const key = process.env.NOTION_API_KEY;
  if (!key) throw new Error("NOTION_API_KEY not set");
  return key;
}

const notionHeaders = (): Record<string, string> => ({
  Authorization: `Bearer ${getNotionApiKey()}`,
  "Notion-Version": NOTION_VERSION,
  "Content-Type": "application/json",
});

export const notionProxyHandlers: GatewayRequestHandlers = {
  /**
   * notion.query — Query a database or data source
   * If databaseId is provided, uses /databases/{id}/query (standard endpoint)
   * If dataSourceId is provided, uses /data_sources/{id}/query (beta endpoint)
   * params: { databaseId?: string, dataSourceId?: string, filter?: object, sorts?: object[], startCursor?: string, pageSize?: number }
   */
  "notion.query": async ({ params, respond }) => {
    try {
      const { databaseId, dataSourceId, filter, sorts, startCursor, pageSize } = params as {
        databaseId?: string;
        dataSourceId?: string;
        filter?: object;
        sorts?: object[];
        startCursor?: string;
        pageSize?: number;
      };
      
      // Prefer databaseId (standard API), fallback to dataSourceId (beta API)
      const id = databaseId || dataSourceId;
      const endpoint = databaseId 
        ? `${NOTION_BASE}/databases/${databaseId}/query`
        : `${NOTION_BASE}/data_sources/${dataSourceId}/query`;
      
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "databaseId or dataSourceId is required" });
        return;
      }
      
      const body: Record<string, unknown> = {};
      if (filter) body.filter = filter;
      if (sorts) body.sorts = sorts;
      if (startCursor) body.start_cursor = startCursor;
      if (pageSize) body.page_size = pageSize;

      const res = await fetch(endpoint, {
        method: "POST",
        headers: notionHeaders(),
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        respond(false, undefined, { code: "NOTION_ERROR", message: data.message ?? `HTTP ${res.status}` });
        return;
      }
      respond(true, data);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * notion.databases.query — POST to /databases/{databaseId}/query (standard endpoint)
   * params: { databaseId: string, filter?: object, sorts?: object[], startCursor?: string, pageSize?: number }
   */
  "notion.databases.query": async ({ params, respond }) => {
    try {
      const { databaseId, filter, sorts, startCursor, pageSize } = params as {
        databaseId: string;
        filter?: object;
        sorts?: object[];
        startCursor?: string;
        pageSize?: number;
      };
      if (!databaseId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "databaseId is required" });
        return;
      }
      const body: Record<string, unknown> = {};
      if (filter) body.filter = filter;
      if (sorts) body.sorts = sorts;
      if (startCursor) body.start_cursor = startCursor;
      if (pageSize) body.page_size = pageSize;

      const res = await fetch(`${NOTION_BASE}/databases/${databaseId}/query`, {
        method: "POST",
        headers: notionHeaders(),
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        respond(false, undefined, { code: "NOTION_ERROR", message: data.message ?? `HTTP ${res.status}` });
        return;
      }
      respond(true, data);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * notion.create — POST to /pages
   * params: { parent: { database_id: string }, properties: object, children?: object[] }
   */
  "notion.create": async ({ params, respond }) => {
    try {
      const res = await fetch(`${NOTION_BASE}/pages`, {
        method: "POST",
        headers: notionHeaders(),
        body: JSON.stringify(params),
      });
      const data = await res.json();
      if (!res.ok) {
        respond(false, undefined, { code: "NOTION_ERROR", message: data.message ?? `HTTP ${res.status}` });
        return;
      }
      respond(true, data);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * notion.update — PATCH to /pages/{pageId}
   * params: { pageId: string, properties?: object, archived?: boolean }
   */
  "notion.update": async ({ params, respond }) => {
    try {
      const { pageId, ...body } = params as { pageId: string; [key: string]: unknown };
      if (!pageId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "pageId is required" });
        return;
      }
      const res = await fetch(`${NOTION_BASE}/pages/${pageId}`, {
        method: "PATCH",
        headers: notionHeaders(),
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        respond(false, undefined, { code: "NOTION_ERROR", message: data.message ?? `HTTP ${res.status}` });
        return;
      }
      respond(true, data);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * notion.blocks.append — PATCH /blocks/{blockId}/children
   * Append blocks to a page or block.
   * params: { blockId: string, children: object[] }
   */
  "notion.blocks.append": async ({ params, respond }) => {
    try {
      const { blockId, children } = params as { blockId: string; children: object[] };
      if (!blockId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "blockId is required" });
        return;
      }
      if (!children || !Array.isArray(children)) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "children array is required" });
        return;
      }
      const res = await fetch(`${NOTION_BASE}/blocks/${blockId}/children`, {
        method: "PATCH",
        headers: notionHeaders(),
        body: JSON.stringify({ children }),
      });
      const data = await res.json();
      if (!res.ok) {
        respond(false, undefined, { code: "NOTION_ERROR", message: data.message ?? `HTTP ${res.status}` });
        return;
      }
      respond(true, data);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * notion.pages.create — POST /pages with parent page (for subpages)
   * params: { parentPageId: string, title: string, children?: object[] }
   */
  "notion.pages.create": async ({ params, respond }) => {
    try {
      const { parentPageId, title, children } = params as {
        parentPageId: string; title: string; children?: object[];
      };
      if (!parentPageId || !title) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "parentPageId and title are required" });
        return;
      }
      const body: Record<string, unknown> = {
        parent: { type: "page_id", page_id: parentPageId },
        properties: {
          title: { title: [{ text: { content: title } }] },
        },
      };
      if (children && Array.isArray(children)) {
        body.children = children;
      }
      const res = await fetch(`${NOTION_BASE}/pages`, {
        method: "POST",
        headers: notionHeaders(),
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        respond(false, undefined, { code: "NOTION_ERROR", message: data.message ?? `HTTP ${res.status}` });
        return;
      }
      respond(true, data);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * notion.get — GET /pages/{pageId}
   * params: { pageId: string }
   */
  "notion.get": async ({ params, respond }) => {
    try {
      const { pageId } = params as { pageId: string };
      if (!pageId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "pageId is required" });
        return;
      }
      const res = await fetch(`${NOTION_BASE}/pages/${pageId}`, {
        method: "GET",
        headers: notionHeaders(),
      });
      const data = await res.json();
      if (!res.ok) {
        respond(false, undefined, { code: "NOTION_ERROR", message: data.message ?? `HTTP ${res.status}` });
        return;
      }
      respond(true, data);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * notion.createPage — Create a page in a database
   * params: { databaseId: string, properties: object }
   */
  "notion.createPage": async ({ params, respond }) => {
    try {
      const { databaseId, properties } = params as { databaseId: string; properties: object };
      if (!databaseId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "databaseId is required" });
        return;
      }
      const body = {
        parent: { database_id: databaseId },
        properties,
      };
      const res = await fetch(`${NOTION_BASE}/pages`, {
        method: "POST",
        headers: notionHeaders(),
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        respond(false, undefined, { code: "NOTION_ERROR", message: data.message ?? `HTTP ${res.status}` });
        return;
      }
      respond(true, data);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * notion.updatePage — Update a page's properties
   * params: { pageId: string, properties: object }
   */
  "notion.updatePage": async ({ params, respond }) => {
    try {
      const { pageId, properties } = params as { pageId: string; properties: object };
      if (!pageId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "pageId is required" });
        return;
      }
      const res = await fetch(`${NOTION_BASE}/pages/${pageId}`, {
        method: "PATCH",
        headers: notionHeaders(),
        body: JSON.stringify({ properties }),
      });
      const data = await res.json();
      if (!res.ok) {
        respond(false, undefined, { code: "NOTION_ERROR", message: data.message ?? `HTTP ${res.status}` });
        return;
      }
      respond(true, data);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * notion.archivePage — Archive (soft delete) a page
   * params: { pageId: string }
   */
  "notion.archivePage": async ({ params, respond }) => {
    try {
      const { pageId } = params as { pageId: string };
      if (!pageId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "pageId is required" });
        return;
      }
      const res = await fetch(`${NOTION_BASE}/pages/${pageId}`, {
        method: "PATCH",
        headers: notionHeaders(),
        body: JSON.stringify({ archived: true }),
      });
      const data = await res.json();
      if (!res.ok) {
        respond(false, undefined, { code: "NOTION_ERROR", message: data.message ?? `HTTP ${res.status}` });
        return;
      }
      respond(true, data);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};
