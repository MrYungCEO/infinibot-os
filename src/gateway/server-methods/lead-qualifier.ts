/**
 * Gateway RPCs for the Lead Qualifier.
 *
 * Server-backed counterpart to the UI controller in
 * `ui/src/ui/controllers/lead-qualifier.ts`. The UI used to fall back to
 * localStorage when these handlers were missing — now they exist, so
 * configs persist across browsers and the action runner is reachable
 * from agent tools and the public webhook.
 *
 * Methods:
 *   leads.qualifier.list   — every config keyed by businessId
 *   leads.qualifier.get    — one config by businessId
 *   leads.qualifier.upsert — create / update
 *   leads.qualifier.delete — drop config + run history
 *   leads.qualifier.run    — execute the action stack against a payload
 *   leads.qualifier.runs   — list recent run records (audit log)
 *   leads.qualifier.test   — synonym for run, used by the UI's "ping" button
 */
import {
  appendRun,
  deleteConfig,
  getConfig,
  listConfigs,
  listRuns,
  upsertConfig,
  type QualifierConfigV1,
  type QualifierRunRecordV1,
} from "../../services/qualifier/store.js";
import { runQualifier } from "../../services/qualifier/runner.js";
import {
  FORM_TEMPLATES,
  deleteForm,
  getForm,
  listForms,
  listSubmissions,
  newFormFromTemplate,
  slugify,
  summarizeKpi,
  upsertForm,
  type QualifierFormConfig,
} from "../../services/qualifier/forms.js";
import { renderFormHtml } from "../../services/qualifier/form-render.js";
import { deployStaticHtml, getUser, listSites } from "../../services/netlify/deploy.js";
import { loadConfig } from "../../config/config.js";
import { readConfigFileSnapshot, writeConfigFile } from "../../config/io.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { GatewayRequestHandlers } from "./types.js";

const log = createSubsystemLogger("lead-qualifier-rpc");

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function genRunId(): string {
  return `qrun-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const leadQualifierHandlers: GatewayRequestHandlers = {
  "leads.qualifier.list": async ({ respond }) => {
    try {
      respond(true, { configs: listConfigs() });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "leads.qualifier.get": async ({ params, respond }) => {
    const businessId = asString(params?.businessId);
    if (!businessId) {
      respond(false, undefined, { code: "BAD_REQUEST", message: "businessId required" });
      return;
    }
    try {
      respond(true, { config: getConfig(businessId) });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "leads.qualifier.upsert": async ({ params, respond }) => {
    const config = (params?.config ?? params) as Partial<QualifierConfigV1>;
    if (!config?.businessId) {
      respond(false, undefined, { code: "BAD_REQUEST", message: "config.businessId required" });
      return;
    }
    try {
      const saved = upsertConfig({
        businessId: config.businessId,
        name: config.name ?? "Lead qualifier",
        enabled: config.enabled ?? true,
        webhookPath: config.webhookPath ?? `/api/qualifier/${config.businessId}`,
        webhookSecret: config.webhookSecret,
        criteriaMode: config.criteriaMode === "any" ? "any" : "all",
        criteria: Array.isArray(config.criteria) ? config.criteria : [],
        actions: Array.isArray(config.actions) ? config.actions : [],
        styleTemplateId: config.styleTemplateId,
        linkedProjectId: config.linkedProjectId,
        crmDatabaseId: config.crmDatabaseId,
        createdAt: config.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      });
      respond(true, { config: saved });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "leads.qualifier.delete": async ({ params, respond }) => {
    const businessId = asString(params?.businessId);
    if (!businessId) {
      respond(false, undefined, { code: "BAD_REQUEST", message: "businessId required" });
      return;
    }
    try {
      respond(true, { deleted: deleteConfig(businessId) });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "leads.qualifier.runs": async ({ params, respond }) => {
    const businessId = asString(params?.businessId);
    const limit = typeof params?.limit === "number" ? params.limit : 50;
    if (!businessId) {
      respond(false, undefined, { code: "BAD_REQUEST", message: "businessId required" });
      return;
    }
    try {
      respond(true, { runs: listRuns(businessId, limit) });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "leads.qualifier.run": async ({ params, respond }) => {
    const businessId = asString(params?.businessId);
    const payload = (params?.payload ?? {}) as Record<string, unknown>;
    if (!businessId) {
      respond(false, undefined, { code: "BAD_REQUEST", message: "businessId required" });
      return;
    }
    const config = getConfig(businessId);
    if (!config) {
      respond(false, undefined, {
        code: "NO_CONFIG",
        message: `no qualifier config for business ${businessId}`,
      });
      return;
    }
    const runId = genRunId();
    const now = Date.now();
    // Pre-record the run so the runs UI shows it immediately even if the
    // action stack is slow. The runner result patches it in below.
    appendRun(businessId, {
      id: runId,
      receivedAt: now,
      result: "qualified",
      payloadPreview: JSON.stringify(payload).slice(0, 500),
      note: "running…",
      completedAt: null,
    });

    try {
      const result = await runQualifier(payload, config);
      const final: QualifierRunRecordV1 = {
        id: runId,
        receivedAt: now,
        result: result.ok ? result.result : "error",
        payloadPreview: JSON.stringify(payload).slice(0, 500),
        note: result.actions.map((a) => `${a.kind}:${a.ok ? "ok" : "fail"}`).join(", "),
        completedAt: Date.now(),
        leadId: result.leadId,
        actionResults: result.actions.map((a) => ({
          actionId: a.actionId,
          kind: a.kind,
          ok: a.ok,
          detail: a.detail,
        })),
      };
      // Replace the placeholder by appending a fresh record with the same
      // id (store handles dedupe via update path on the next read — for
      // simplicity we just rewrite the slot via a direct file update).
      // Cheap: re-load, replace by id, persist.
      const { updateRun } = await import("../../services/qualifier/store.js");
      updateRun(businessId, runId, final);
      log.info("qualifier run", {
        businessId,
        runId,
        result: final.result,
        actions: final.actionResults?.length ?? 0,
      });
      respond(true, { run: final });
    } catch (e) {
      const final: QualifierRunRecordV1 = {
        id: runId,
        receivedAt: now,
        result: "error",
        payloadPreview: JSON.stringify(payload).slice(0, 500),
        note: e instanceof Error ? e.message : String(e),
        completedAt: Date.now(),
      };
      const { updateRun } = await import("../../services/qualifier/store.js");
      updateRun(businessId, runId, final);
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // The UI calls `.test` from its "Send sample payload" button. Same
  // semantics as `.run`; aliased here so existing controllers don't need
  // to change.
  "leads.qualifier.test": async ({ params, respond, ...rest }) => {
    return leadQualifierHandlers["leads.qualifier.run"]({ params, respond, ...rest } as never);
  },

  // ─── Form builder ──────────────────────────────────────────────
  //
  // Public-facing branded forms that POST into the qualifier pipeline.
  // Configs live in `lead-qualifier-forms/forms.json`; KPI events stream
  // into per-form JSONL files. See src/services/qualifier/forms.ts.

  /** List every form (optionally filtered by business / funnel). */
  "leads.qualifier.forms.list": async ({ params, respond }) => {
    try {
      const businessId = asString(params?.businessId) || undefined;
      const funnelId = params?.funnelId === null ? null : asString(params?.funnelId) || undefined;
      respond(true, { forms: listForms({ businessId, funnelId }) });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Fetch a form by id (or slug). */
  "leads.qualifier.forms.get": async ({ params, respond }) => {
    const id = asString(params?.id);
    if (!id) {
      respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
      return;
    }
    try {
      respond(true, { form: getForm(id) });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Create or update a form. The form is identified by `form.id`; omit on create. */
  "leads.qualifier.forms.upsert": async ({ params, respond }) => {
    const form = (params?.form ?? params) as Partial<QualifierFormConfig>;
    if (!form?.businessId) {
      respond(false, undefined, { code: "BAD_REQUEST", message: "form.businessId required" });
      return;
    }
    try {
      const saved = upsertForm({ ...form, businessId: form.businessId });
      respond(true, { form: saved });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Create a new form pre-filled from a template. */
  "leads.qualifier.forms.fromTemplate": async ({ params, respond }) => {
    const businessId = asString(params?.businessId);
    const templateId = asString(params?.templateId);
    const name = asString(params?.name);
    if (!businessId || !templateId) {
      respond(false, undefined, {
        code: "BAD_REQUEST",
        message: "businessId + templateId required",
      });
      return;
    }
    try {
      const form = newFormFromTemplate(businessId, templateId, name);
      respond(true, { form });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** List the bundled form templates (high-ticket mentorship, etc.). */
  "leads.qualifier.forms.templates": async ({ respond }) => {
    respond(true, { templates: FORM_TEMPLATES });
  },

  /** Delete a form (and its analytics + submissions stream). */
  "leads.qualifier.forms.delete": async ({ params, respond }) => {
    const id = asString(params?.id);
    if (!id) {
      respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
      return;
    }
    try {
      respond(true, { deleted: deleteForm(id) });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Toggle the published flag — when false the public URL returns 404. */
  "leads.qualifier.forms.publish": async ({ params, respond }) => {
    const id = asString(params?.id);
    if (!id) {
      respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
      return;
    }
    try {
      const form = getForm(id);
      if (!form) {
        respond(false, undefined, { code: "NOT_FOUND", message: "form not found" });
        return;
      }
      const next =
        typeof params?.published === "boolean" ? (params.published as boolean) : !form.published;
      // Publishing with an empty slug routes /f/ to the SPA fallback,
      // which is the "gateway default page" users see instead of their
      // form. Derive one from the name so the public URL always resolves.
      const slug = (form.slug || "").trim() || slugify(form.name || "form");
      const saved = upsertForm({ ...form, slug, published: next });
      respond(true, { form: saved });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Render the form HTML — used for the dashboard preview iframe. */
  "leads.qualifier.forms.preview": async ({ params, respond }) => {
    const id = asString(params?.id);
    if (!id) {
      respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
      return;
    }
    try {
      const form = getForm(id);
      if (!form) {
        respond(false, undefined, { code: "NOT_FOUND", message: "form not found" });
        return;
      }
      respond(true, { html: renderFormHtml(form), form });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** KPI dashboard data — views, submits, conversion, by-source, abandonment. */
  "leads.qualifier.forms.kpi": async ({ params, respond }) => {
    const id = asString(params?.id);
    if (!id) {
      respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
      return;
    }
    try {
      respond(true, { kpi: summarizeKpi(id) });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Recent submissions for the form. */
  "leads.qualifier.forms.submissions": async ({ params, respond }) => {
    const id = asString(params?.id);
    const limit = typeof params?.limit === "number" ? params.limit : 100;
    if (!id) {
      respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
      return;
    }
    try {
      respond(true, { submissions: listSubmissions(id, limit) });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // ─────────────────────────────────────────────────────────
  // Netlify deploy — host the form on Netlify; submissions hit
  // the local gateway via the configured public apiBaseUrl.
  // ─────────────────────────────────────────────────────────

  /** Report which Netlify integration bits are present. */
  "netlify.status": async ({ respond }) => {
    try {
      const cfg = loadConfig() as {
        netlify?: { accessToken?: string; apiBaseUrl?: string; formSites?: Record<string, string> };
      };
      const token = cfg.netlify?.accessToken?.trim() ?? "";
      const apiBaseUrl = cfg.netlify?.apiBaseUrl?.trim() ?? "";
      const formSites = cfg.netlify?.formSites ?? {};
      let user: { email?: string; full_name?: string } | null = null;
      if (token) {
        try {
          user = await getUser(token);
        } catch (e) {
          respond(true, {
            configured: false,
            tokenPresent: true,
            apiBaseUrl,
            formSites,
            error: (e as Error).message,
          });
          return;
        }
      }
      respond(true, {
        configured: !!token,
        tokenPresent: !!token,
        user,
        apiBaseUrl,
        formSites,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Persist a Netlify personal access token + optional gateway public URL. */
  "netlify.connect": async ({ params, respond }) => {
    try {
      const accessToken = asString(params?.accessToken).trim();
      const apiBaseUrl = asString(params?.apiBaseUrl).trim();
      if (!accessToken) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "accessToken required" });
        return;
      }
      // Validate before writing — Netlify returns 401 on a bad token.
      const user = await getUser(accessToken).catch((e) => {
        throw new Error(`Token validation failed: ${(e as Error).message}`);
      });
      await mutateNetlifyConfig((block) => {
        block.accessToken = accessToken;
        if (apiBaseUrl) block.apiBaseUrl = apiBaseUrl;
      });
      respond(true, { user, configured: true });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Update the public gateway URL without re-validating the token. */
  "netlify.setApiBaseUrl": async ({ params, respond }) => {
    try {
      const apiBaseUrl = asString(params?.apiBaseUrl).trim();
      if (!apiBaseUrl) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "apiBaseUrl required" });
        return;
      }
      await mutateNetlifyConfig((block) => {
        block.apiBaseUrl = apiBaseUrl;
      });
      respond(true, { apiBaseUrl });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** List sites the user owns — used by the deploy dialog as a target picker. */
  "netlify.sites": async ({ respond }) => {
    try {
      const cfg = loadConfig() as { netlify?: { accessToken?: string } };
      const token = cfg.netlify?.accessToken?.trim();
      if (!token) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "Netlify not connected" });
        return;
      }
      respond(true, { sites: await listSites(token) });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Deploy a form's rendered HTML to Netlify. Submissions point at the
   * configured `apiBaseUrl` (must be a public URL — Tailscale funnel,
   * ngrok, cloudflared, or a static IP), so the gateway stays local while
   * the form is hosted on Netlify's edge.
   */
  "netlify.deploy": async ({ params, respond }) => {
    try {
      const id = asString(params?.id);
      if (!id) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
        return;
      }
      const form = getForm(id);
      if (!form) {
        respond(false, undefined, { code: "NOT_FOUND", message: "form not found" });
        return;
      }
      const cfg = loadConfig() as {
        netlify?: { accessToken?: string; apiBaseUrl?: string; formSites?: Record<string, string> };
      };
      const token = cfg.netlify?.accessToken?.trim();
      if (!token) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "Netlify not connected" });
        return;
      }
      // Caller can override apiBaseUrl per-deploy (handy when testing a new
      // tunnel). Falls back to the persisted value, which can also be empty
      // (then the form posts to whatever origin Netlify serves it from —
      // useful for previewing the static layout but submissions will fail).
      const apiBaseUrl = asString(params?.apiBaseUrl).trim() || cfg.netlify?.apiBaseUrl || "";
      if (!apiBaseUrl) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message:
            "apiBaseUrl required — set a public URL for the gateway (Tailscale, ngrok, or static IP) so the Netlify form can POST submissions back here.",
        });
        return;
      }
      const html = renderFormHtml(form, { apiBaseUrl });
      const persistedSiteId =
        (params?.siteId ? asString(params.siteId).trim() : "") ||
        (cfg.netlify?.formSites?.[id] ?? "");
      const siteName =
        asString(params?.siteName).trim() || `infinibot-form-${form.slug || form.id}`;

      const result = await deployStaticHtml({
        token,
        html,
        siteId: persistedSiteId || undefined,
        siteName,
      });

      // Persist site id so the next deploy lands on the same site instead
      // of spinning up a new one (and a new random URL) every time.
      if (result.site.id) {
        await mutateNetlifyConfig((block) => {
          if (!block.formSites) block.formSites = {};
          block.formSites[id] = result.site.id;
        });
      }
      respond(true, { result });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};

// ============================================================
// Netlify config persistence helper
// ============================================================

async function mutateNetlifyConfig(
  fn: (block: {
    accessToken?: string;
    apiBaseUrl?: string;
    formSites?: Record<string, string>;
  }) => void,
): Promise<void> {
  const snap = await readConfigFileSnapshot();
  const parsed =
    snap.parsed && typeof snap.parsed === "object" && !Array.isArray(snap.parsed)
      ? { ...(snap.parsed as Record<string, unknown>) }
      : {};
  const block = ((parsed.netlify as Record<string, unknown> | undefined) ?? {}) as {
    accessToken?: string;
    apiBaseUrl?: string;
    formSites?: Record<string, string>;
  };
  const next = { ...block };
  fn(next);
  parsed.netlify = next;
  await writeConfigFile(parsed as never);
}
