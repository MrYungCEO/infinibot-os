/**
 * Gateway Methods — Form Bindings
 *
 * RPC surface for managing public form-submission bindings:
 *   forms.bindings.list
 *   forms.bindings.get
 *   forms.bindings.create
 *   forms.bindings.update
 *   forms.bindings.delete
 *   forms.submissions.list
 *
 * The actual submission endpoint is HTTP only (POST /api/forms/:id/submit)
 * so public HTML forms can hit it without WebSocket auth — see
 * src/gateway/server-pages-public.ts.
 */

import { resolveStateDir } from "../../config/paths.js";
import {
  getFormBindingStore,
  type FormBindingCreate,
  type FormBindingPatch,
} from "../../forms/bindings.js";

import type { GatewayRequestHandlers } from "./types.js";
import { requireFeature } from "../../license/middleware.js";

function store() {
  return getFormBindingStore(resolveStateDir());
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export const formsHandlers: GatewayRequestHandlers = {
  "forms.bindings.list": async ({ respond }) => {
    try {
      respond(true, { bindings: store().list() });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "forms.bindings.get": async ({ respond, params }) => {
    try {
      const id = asStr(params.id);
      if (!id) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
        return;
      }
      const binding = store().get(id);
      if (!binding) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Binding ${id} not found` });
        return;
      }
      respond(true, { binding });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  // Form Builder is a CEO-tier feature (form_builder).
  "forms.bindings.create": requireFeature("form_builder", async ({ respond, params }) => {
    try {
      const name = asStr(params.name);
      const databaseId = asStr(params.databaseId);
      if (!name || !databaseId) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "name and databaseId required",
        });
        return;
      }
      const input: FormBindingCreate = {
        id: asStr(params.id),
        name,
        databaseId,
        fieldMap: (params.fieldMap as Record<string, string> | undefined) ?? {},
        titleTemplate: asStr(params.titleTemplate),
        webhookUrl: asStr(params.webhookUrl),
        successRedirect: asStr(params.successRedirect),
        meta: (params.meta as Record<string, unknown> | undefined) ?? {},
      };
      const binding = store().create(input);
      respond(true, { binding });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }),

  "forms.bindings.update": async ({ respond, params }) => {
    try {
      const id = asStr(params.id);
      if (!id) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
        return;
      }
      const patch: FormBindingPatch = {};
      if (params.name !== undefined) patch.name = asStr(params.name);
      if (params.databaseId !== undefined) patch.databaseId = asStr(params.databaseId);
      if (params.fieldMap !== undefined) {
        patch.fieldMap = params.fieldMap as Record<string, string>;
      }
      if (params.titleTemplate !== undefined) patch.titleTemplate = asStr(params.titleTemplate);
      if (params.webhookUrl !== undefined) patch.webhookUrl = asStr(params.webhookUrl);
      if (params.successRedirect !== undefined) {
        patch.successRedirect = asStr(params.successRedirect);
      }
      if (params.meta !== undefined) patch.meta = params.meta as Record<string, unknown>;
      const binding = store().update(id, patch);
      if (!binding) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Binding ${id} not found` });
        return;
      }
      respond(true, { binding });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "forms.bindings.delete": async ({ respond, params }) => {
    try {
      const id = asStr(params.id);
      if (!id) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
        return;
      }
      respond(true, { deleted: store().delete(id) });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "forms.submissions.list": async ({ respond, params }) => {
    try {
      const bindingId = asStr(params.bindingId);
      if (!bindingId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "bindingId required" });
        return;
      }
      const limit = typeof params.limit === "number" ? params.limit : undefined;
      respond(true, {
        submissions: store().listSubmissions(bindingId, { limit }),
      });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },
};
