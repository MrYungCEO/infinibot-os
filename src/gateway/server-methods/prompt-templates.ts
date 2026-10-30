import * as store from "../../prompt-templates/store.js";
import type { GatewayRequestHandlers } from "./types.js";

export const promptTemplateHandlers: GatewayRequestHandlers = {
  "promptTemplates.list": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { category?: string; tag?: string };
      const templates = store.list(p);
      respond(true, { templates, count: templates.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "promptTemplates.get": async ({ params, respond }) => {
    try {
      const { id } = params as { id: string };
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id required" });
        return;
      }
      const t = store.get(id);
      if (!t) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Template "${id}" not found` });
        return;
      }
      respond(true, t);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "promptTemplates.create": async ({ params, respond }) => {
    try {
      const p = params as {
        name: string;
        description?: string;
        body: string;
        tags?: string[];
        category?: string;
      };
      if (!p.name || typeof p.body !== "string") {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "name and body are required",
        });
        return;
      }
      const t = store.create(p);
      respond(true, t);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "promptTemplates.update": async ({ params, respond }) => {
    try {
      const { id, ...patch } = params as { id: string; [k: string]: unknown };
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id required" });
        return;
      }
      const t = store.update(id, patch as store.PromptTemplatePatch);
      if (!t) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Template "${id}" not found` });
        return;
      }
      respond(true, t);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "promptTemplates.delete": async ({ params, respond }) => {
    try {
      const { id } = params as { id: string };
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id required" });
        return;
      }
      const ok = store.remove(id);
      if (!ok) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Template "${id}" not found` });
        return;
      }
      respond(true, { deleted: true, id });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "promptTemplates.search": async ({ params, respond }) => {
    try {
      const { query } = params as { query?: string };
      if (!query) {
        respond(true, { templates: [], count: 0 });
        return;
      }
      const templates = store.search(query);
      respond(true, { templates, count: templates.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};
