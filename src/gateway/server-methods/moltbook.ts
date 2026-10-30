/**
 * Moltbook gateway handlers — proxy all Moltbook API calls.
 * API key stays server-side, never exposed to browser client.
 */

import { resolve } from "path";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import type { GatewayRequestHandlers } from "./types.js";

const MOLTBOOK_API = "https://www.moltbook.com/api/v1";

function getApiKey(): string {
  const credPath = resolve(homedir(), ".config", "moltbook", "credentials.json");
  if (!existsSync(credPath))
    throw new Error("Moltbook credentials not found. Register first via the Moltbook skill.");
  const creds = JSON.parse(readFileSync(credPath, "utf-8"));
  if (!creds.api_key) throw new Error("No api_key in Moltbook credentials file.");
  return creds.api_key;
}

function getCredentials(): Record<string, unknown> {
  const credPath = resolve(homedir(), ".config", "moltbook", "credentials.json");
  if (!existsSync(credPath)) return {};
  return JSON.parse(readFileSync(credPath, "utf-8"));
}

async function moltbookFetch(path: string, options?: RequestInit): Promise<unknown> {
  const key = getApiKey();
  const resp = await fetch(`${MOLTBOOK_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Moltbook API ${resp.status}: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export const moltbookHandlers: GatewayRequestHandlers = {
  /** Get agent status + profile */
  "moltbook.status": async ({ respond }) => {
    try {
      const creds = getCredentials();
      const [me, status] = await Promise.all([
        moltbookFetch("/agents/me"),
        moltbookFetch("/agents/status"),
      ]);
      respond(true, {
        ...(me as object),
        ...(status as object),
        credentials: { agent_name: creds.agent_name, agent_id: creds.agent_id },
      });
    } catch (e) {
      respond(false, undefined, { code: "MOLTBOOK_ERROR", message: String(e) });
    }
  },

  /** Get feed (global or personalized) */
  "moltbook.feed": async ({ params, respond }) => {
    try {
      const {
        sort = "hot",
        limit = 25,
        submolt,
        personalized,
      } = params as {
        sort?: string;
        limit?: number;
        submolt?: string;
        personalized?: boolean;
      };
      let path: string;
      if (submolt) {
        path = `/submolts/${encodeURIComponent(submolt)}/feed?sort=${sort}&limit=${limit}`;
      } else if (personalized) {
        path = `/feed?sort=${sort}&limit=${limit}`;
      } else {
        path = `/posts?sort=${sort}&limit=${limit}`;
      }
      const data = await moltbookFetch(path);
      respond(true, data);
    } catch (e) {
      respond(false, undefined, { code: "MOLTBOOK_ERROR", message: String(e) });
    }
  },

  /** Get a single post */
  "moltbook.post.get": async ({ params, respond }) => {
    try {
      const { id } = params as { id: string };
      const data = await moltbookFetch(`/posts/${encodeURIComponent(id)}`);
      respond(true, data);
    } catch (e) {
      respond(false, undefined, { code: "MOLTBOOK_ERROR", message: String(e) });
    }
  },

  /** Create a post */
  "moltbook.post.create": async ({ params, respond }) => {
    try {
      const { submolt, title, content, url } = params as {
        submolt: string;
        title: string;
        content?: string;
        url?: string;
      };
      const body: Record<string, string> = { submolt, title };
      if (content) body.content = content;
      if (url) body.url = url;
      const data = await moltbookFetch("/posts", {
        method: "POST",
        body: JSON.stringify(body),
      });
      respond(true, data);
    } catch (e) {
      respond(false, undefined, { code: "MOLTBOOK_ERROR", message: String(e) });
    }
  },

  /** Delete a post */
  "moltbook.post.delete": async ({ params, respond }) => {
    try {
      const { id } = params as { id: string };
      const data = await moltbookFetch(`/posts/${encodeURIComponent(id)}`, { method: "DELETE" });
      respond(true, data);
    } catch (e) {
      respond(false, undefined, { code: "MOLTBOOK_ERROR", message: String(e) });
    }
  },

  /** Vote on a post */
  "moltbook.post.vote": async ({ params, respond }) => {
    try {
      const { id, direction } = params as { id: string; direction: "up" | "down" };
      const data = await moltbookFetch(
        `/posts/${encodeURIComponent(id)}/${direction === "down" ? "downvote" : "upvote"}`,
        { method: "POST" },
      );
      respond(true, data);
    } catch (e) {
      respond(false, undefined, { code: "MOLTBOOK_ERROR", message: String(e) });
    }
  },

  /** Get comments on a post */
  "moltbook.comments.list": async ({ params, respond }) => {
    try {
      const { postId, sort = "top" } = params as { postId: string; sort?: string };
      const data = await moltbookFetch(
        `/posts/${encodeURIComponent(postId)}/comments?sort=${sort}`,
      );
      respond(true, data);
    } catch (e) {
      respond(false, undefined, { code: "MOLTBOOK_ERROR", message: String(e) });
    }
  },

  /** Create a comment */
  "moltbook.comment.create": async ({ params, respond }) => {
    try {
      const { postId, content, parent_id } = params as {
        postId: string;
        content: string;
        parent_id?: string;
      };
      const body: Record<string, string> = { content };
      if (parent_id) body.parent_id = parent_id;
      const data = await moltbookFetch(`/posts/${encodeURIComponent(postId)}/comments`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      respond(true, data);
    } catch (e) {
      respond(false, undefined, { code: "MOLTBOOK_ERROR", message: String(e) });
    }
  },

  /** Vote on a comment */
  "moltbook.comment.vote": async ({ params, respond }) => {
    try {
      const { id, direction } = params as { id: string; direction: "up" | "down" };
      const data = await moltbookFetch(
        `/comments/${encodeURIComponent(id)}/${direction === "down" ? "downvote" : "upvote"}`,
        { method: "POST" },
      );
      respond(true, data);
    } catch (e) {
      respond(false, undefined, { code: "MOLTBOOK_ERROR", message: String(e) });
    }
  },

  /** List submolts */
  "moltbook.submolts.list": async ({ respond }) => {
    try {
      const data = await moltbookFetch("/submolts");
      respond(true, data);
    } catch (e) {
      respond(false, undefined, { code: "MOLTBOOK_ERROR", message: String(e) });
    }
  },

  /** Get submolt info */
  "moltbook.submolt.get": async ({ params, respond }) => {
    try {
      const { name } = params as { name: string };
      const data = await moltbookFetch(`/submolts/${encodeURIComponent(name)}`);
      respond(true, data);
    } catch (e) {
      respond(false, undefined, { code: "MOLTBOOK_ERROR", message: String(e) });
    }
  },

  /** Create a submolt */
  "moltbook.submolt.create": async ({ params, respond }) => {
    try {
      const { name, display_name, description } = params as {
        name: string;
        display_name: string;
        description: string;
      };
      const data = await moltbookFetch("/submolts", {
        method: "POST",
        body: JSON.stringify({ name, display_name, description }),
      });
      respond(true, data);
    } catch (e) {
      respond(false, undefined, { code: "MOLTBOOK_ERROR", message: String(e) });
    }
  },

  /** Subscribe to a submolt */
  "moltbook.submolt.subscribe": async ({ params, respond }) => {
    try {
      const { name } = params as { name: string };
      const data = await moltbookFetch(`/submolts/${encodeURIComponent(name)}/subscribe`, {
        method: "POST",
      });
      respond(true, data);
    } catch (e) {
      respond(false, undefined, { code: "MOLTBOOK_ERROR", message: String(e) });
    }
  },

  /** Check DM activity */
  "moltbook.dm.check": async ({ respond }) => {
    try {
      const data = await moltbookFetch("/agents/dm/check");
      respond(true, data);
    } catch (e) {
      respond(false, undefined, { code: "MOLTBOOK_ERROR", message: String(e) });
    }
  },

  /** List DM conversations */
  "moltbook.dm.conversations": async ({ respond }) => {
    try {
      const data = await moltbookFetch("/agents/dm/conversations");
      respond(true, data);
    } catch (e) {
      respond(false, undefined, { code: "MOLTBOOK_ERROR", message: String(e) });
    }
  },

  /** Read a conversation */
  "moltbook.dm.read": async ({ params, respond }) => {
    try {
      const { id } = params as { id: string };
      const data = await moltbookFetch(`/agents/dm/conversations/${encodeURIComponent(id)}`);
      respond(true, data);
    } catch (e) {
      respond(false, undefined, { code: "MOLTBOOK_ERROR", message: String(e) });
    }
  },

  /** Send a DM */
  "moltbook.dm.send": async ({ params, respond }) => {
    try {
      const { id, message, needs_human_input } = params as {
        id: string;
        message: string;
        needs_human_input?: boolean;
      };
      const body: Record<string, unknown> = { message };
      if (needs_human_input) body.needs_human_input = true;
      const data = await moltbookFetch(`/agents/dm/conversations/${encodeURIComponent(id)}/send`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      respond(true, data);
    } catch (e) {
      respond(false, undefined, { code: "MOLTBOOK_ERROR", message: String(e) });
    }
  },

  /** Send a DM request */
  "moltbook.dm.request": async ({ params, respond }) => {
    try {
      const { to, to_owner, message } = params as {
        to?: string;
        to_owner?: string;
        message: string;
      };
      const body: Record<string, string> = { message };
      if (to) body.to = to;
      if (to_owner) body.to_owner = to_owner;
      const data = await moltbookFetch("/agents/dm/request", {
        method: "POST",
        body: JSON.stringify(body),
      });
      respond(true, data);
    } catch (e) {
      respond(false, undefined, { code: "MOLTBOOK_ERROR", message: String(e) });
    }
  },

  /** Approve DM request */
  "moltbook.dm.approve": async ({ params, respond }) => {
    try {
      const { id } = params as { id: string };
      const data = await moltbookFetch(`/agents/dm/requests/${encodeURIComponent(id)}/approve`, {
        method: "POST",
      });
      respond(true, data);
    } catch (e) {
      respond(false, undefined, { code: "MOLTBOOK_ERROR", message: String(e) });
    }
  },

  /** DM requests list */
  "moltbook.dm.requests": async ({ respond }) => {
    try {
      const data = await moltbookFetch("/agents/dm/requests");
      respond(true, data);
    } catch (e) {
      respond(false, undefined, { code: "MOLTBOOK_ERROR", message: String(e) });
    }
  },

  /** Semantic search */
  "moltbook.search": async ({ params, respond }) => {
    try {
      const {
        q,
        type = "all",
        limit = 20,
      } = params as {
        q: string;
        type?: string;
        limit?: number;
      };
      const data = await moltbookFetch(
        `/search?q=${encodeURIComponent(q)}&type=${type}&limit=${limit}`,
      );
      respond(true, data);
    } catch (e) {
      respond(false, undefined, { code: "MOLTBOOK_ERROR", message: String(e) });
    }
  },

  /** Update profile */
  "moltbook.profile.update": async ({ params, respond }) => {
    try {
      const { description, metadata } = params as {
        description?: string;
        metadata?: unknown;
      };
      const body: Record<string, unknown> = {};
      if (description !== undefined) body.description = description;
      if (metadata !== undefined) body.metadata = metadata;
      const data = await moltbookFetch("/agents/me", {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      respond(true, data);
    } catch (e) {
      respond(false, undefined, { code: "MOLTBOOK_ERROR", message: String(e) });
    }
  },

  /** View another agent's profile */
  "moltbook.agent.profile": async ({ params, respond }) => {
    try {
      const { name } = params as { name: string };
      const data = await moltbookFetch(`/agents/profile?name=${encodeURIComponent(name)}`);
      respond(true, data);
    } catch (e) {
      respond(false, undefined, { code: "MOLTBOOK_ERROR", message: String(e) });
    }
  },

  /** Follow an agent */
  "moltbook.agent.follow": async ({ params, respond }) => {
    try {
      const { name } = params as { name: string };
      const data = await moltbookFetch(`/agents/${encodeURIComponent(name)}/follow`, {
        method: "POST",
      });
      respond(true, data);
    } catch (e) {
      respond(false, undefined, { code: "MOLTBOOK_ERROR", message: String(e) });
    }
  },

  /** Unfollow an agent */
  "moltbook.agent.unfollow": async ({ params, respond }) => {
    try {
      const { name } = params as { name: string };
      const data = await moltbookFetch(`/agents/${encodeURIComponent(name)}/follow`, {
        method: "DELETE",
      });
      respond(true, data);
    } catch (e) {
      respond(false, undefined, { code: "MOLTBOOK_ERROR", message: String(e) });
    }
  },
};
