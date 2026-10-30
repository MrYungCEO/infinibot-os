/**
 * Notion API Service
 * Direct API calls to Notion for page/database operations
 */

// Notion API configuration
const NOTION_API_URL = 'https://api.notion.com/v1';
const NOTION_VERSION = '2025-09-03';

// Get API key from environment or config
let apiKey = null;

export function setNotionApiKey(key) {
  apiKey = key;
}

// Base fetch helper
async function notionFetch(endpoint, options = {}) {
  if (!apiKey) {
    throw new Error('Notion API key not configured');
  }
  
  const url = `${NOTION_API_URL}${endpoint}`;
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
    ...options.headers,
  };
  
  const response = await fetch(url, {
    ...options,
    headers,
  });
  
  const data = await response.json();
  
  if (!response.ok) {
    throw new Error(data.message || `Notion API error: ${response.status}`);
  }
  
  return data;
}

// Page operations
export async function getPage(pageId) {
  return notionFetch(`/pages/${pageId}`);
}

export async function updatePage(pageId, properties) {
  return notionFetch(`/pages/${pageId}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties }),
  });
}

export async function createPage(parentDatabaseId, properties, children = []) {
  const body = {
    parent: { database_id: parentDatabaseId },
    properties,
  };
  
  if (children.length > 0) {
    body.children = children;
  }
  
  return notionFetch('/pages', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// Block operations
export async function getBlockChildren(blockId, startCursor = null, pageSize = 100) {
  let endpoint = `/blocks/${blockId}/children?page_size=${pageSize}`;
  if (startCursor) {
    endpoint += `&start_cursor=${startCursor}`;
  }
  return notionFetch(endpoint);
}

export async function appendBlockChildren(blockId, children) {
  return notionFetch(`/blocks/${blockId}/children`, {
    method: 'PATCH',
    body: JSON.stringify({ children }),
  });
}

export async function deleteBlock(blockId) {
  return notionFetch(`/blocks/${blockId}`, {
    method: 'DELETE',
  });
}

// Database operations
export async function getDatabase(databaseId) {
  return notionFetch(`/databases/${databaseId}`);
}

export async function queryDatabase(databaseId, filter = null, sorts = null, startCursor = null, pageSize = 100) {
  // Use data_sources endpoint for queries (2025-09-03 API version)
  const body = { page_size: pageSize };
  if (filter) body.filter = filter;
  if (sorts) body.sorts = sorts;
  if (startCursor) body.start_cursor = startCursor;
  
  return notionFetch(`/data_sources/${databaseId}/query`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// Search
export async function search(query, filter = null, sort = null, startCursor = null, pageSize = 100) {
  const body = { query, page_size: pageSize };
  if (filter) body.filter = filter;
  if (sort) body.sort = sort;
  if (startCursor) body.start_cursor = startCursor;
  
  return notionFetch('/search', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// Users
export async function listUsers(startCursor = null, pageSize = 100) {
  let endpoint = `/users?page_size=${pageSize}`;
  if (startCursor) {
    endpoint += `&start_cursor=${startCursor}`;
  }
  return notionFetch(endpoint);
}

export async function getUser(userId) {
  return notionFetch(`/users/${userId}`);
}

// NOTE: this module talks to api.notion.com directly and is only the fallback
// for when the gateway is unreachable. The gateway's own Notion RPCs are:
//   notion.get { pageId }                    GET   /pages/{id}
//   notion.update { pageId, properties }     PATCH /pages/{id}
//   notion.databases.query { databaseId… }   POST  /databases/{id}/query
//   notion.blocks.append { blockId, children }
//   notion.db.list / notion.db.pages.blocks { pageId }  (Database Manager: schema + block tree)
// (src/gateway/server-methods/notion-proxy.ts, notion-databases.ts)

export default {
  setNotionApiKey,
  getPage,
  updatePage,
  createPage,
  getBlockChildren,
  appendBlockChildren,
  deleteBlock,
  getDatabase,
  queryDatabase,
  search,
  listUsers,
  getUser,
};
