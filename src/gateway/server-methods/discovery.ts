/**
 * Discovery Docs — gateway RPC handlers.
 *
 * Methods:
 *   discovery.templates.list / get / upsert / delete
 *   discovery.templates.publish / unpublish     (Netlify deploy)
 *   discovery.runs.list / get
 *   discovery.run.execute                       (manual test or scripted)
 *   discovery.run.approve / reject
 *   discovery.settings.get / update
 *   discovery.netlify.status / connect / test / disconnect
 *   discovery.netlify.poll                      (manual kick-off)
 */

import { randomUUID } from "node:crypto";

import { ErrorCodes, errorShape } from "../protocol/index.js";
import { STATE_DIR } from "../../config/paths.js";
import type { GatewayRequestHandlers } from "./types.js";

import { getDiscoveryStore } from "../../discovery/store.js";
import {
  netlifyStatus,
  writeNetlifySecrets,
  clearNetlifySecrets,
  getNetlifyToken,
} from "../../discovery/secrets.js";
import { NetlifyClient } from "../../discovery/netlify.js";
import { generateBusinessSite } from "../../discovery/form-html.js";
import { runPipeline, approveRun, rejectRun } from "../../discovery/runner.js";
import { pollOnce } from "../../discovery/netlify-poller.js";
import {
  DEFAULT_AI_CONFIG,
  DEFAULT_STYLE,
  DEFAULT_APPROVAL,
  type DiscoveryDocTemplate,
} from "../../discovery/types.js";

// ── Active-business helper ──────────────────────────────────

interface BusinessSlim {
  id: string;
  name: string;
  industry?: string;
  [k: string]: unknown;
}

function loadBusinessProfile(businessId: string | null | undefined): BusinessSlim | null {
  try {
    // Reuse the business module's state file. Keeping the import local so
    // a future refactor of business state location doesn't cascade.
    const { readFileSync, existsSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");
    const path = join(STATE_DIR, "business.json");
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf-8")) as {
      businesses?: BusinessSlim[];
      activeBusinessId?: string;
    };
    const id = businessId || data.activeBusinessId;
    if (!id) return null;
    return data.businesses?.find((b) => b.id === id) ?? null;
  } catch {
    return null;
  }
}

// ── Defaults for new templates ──────────────────────────────

function defaultTemplate(businessId: string, name: string): DiscoveryDocTemplate {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "template";
  const now = Date.now();
  return {
    id: randomUUID(),
    businessId,
    name,
    description: "",
    type: "discovery_form",
    slug,
    inputFields: [
      {
        id: randomUUID(),
        name: "fullName",
        label: "Full name",
        type: "text",
        required: true,
        placeholder: "Jane Doe",
      },
      {
        id: randomUUID(),
        name: "email",
        label: "Email",
        type: "email",
        required: true,
        placeholder: "jane@acme.co",
      },
      {
        id: randomUUID(),
        name: "company",
        label: "Company",
        type: "text",
        required: false,
        placeholder: "Acme Inc",
      },
      {
        id: randomUUID(),
        name: "goals",
        label: "Top 1-3 goals",
        type: "textarea",
        required: true,
        placeholder: "Where are you trying to get to?",
      },
      {
        id: randomUUID(),
        name: "currentStack",
        label: "Current AI / automation stack",
        type: "textarea",
        required: false,
      },
    ],
    contextSources: [],
    ai: { ...DEFAULT_AI_CONFIG },
    layout: "audit",
    style: { ...DEFAULT_STYLE },
    actions: [
      {
        id: randomUUID(),
        kind: "qualify_lead",
        config: { extractFromMarkdown: true, candidates: ["qualified", "maybe", "unqualified"] },
      },
      {
        id: randomUUID(),
        kind: "generate_pdf",
        config: { filename: "{{template.slug}}-{{run.id}}.pdf" },
      },
      { id: randomUUID(), kind: "log_to_crm", config: {} },
      {
        id: randomUUID(),
        kind: "send_email",
        config: { to: "{{input.email}}", subject: "Your AI Readiness Audit" },
      },
      { id: randomUUID(), kind: "telegram_notify", config: {}, condition: { op: "always" } },
      {
        id: randomUUID(),
        kind: "calendly_link",
        config: {},
        condition: { op: "equals", category: "qualified" },
      },
    ],
    approval: { ...DEFAULT_APPROVAL },
    netlify: null,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

// ── Handlers ────────────────────────────────────────────────

export const discoveryHandlers: GatewayRequestHandlers = {
  // ── Templates ────────────────────────────────────────────
  "discovery.templates.list": async ({ params, respond }) => {
    try {
      const businessId = (params as { businessId?: string })?.businessId;
      if (!businessId) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "businessId required"));
        return;
      }
      const store = getDiscoveryStore(STATE_DIR);
      respond(true, { templates: store.listTemplates(businessId) });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, String(e)));
    }
  },

  "discovery.templates.get": async ({ params, respond }) => {
    try {
      const id = (params as { id?: string })?.id;
      if (!id) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id required"));
        return;
      }
      const store = getDiscoveryStore(STATE_DIR);
      const tpl = store.getTemplate(id);
      if (!tpl) {
        respond(false, undefined, errorShape(ErrorCodes.NOT_FOUND, "Template not found"));
        return;
      }
      respond(true, { template: tpl });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, String(e)));
    }
  },

  "discovery.templates.upsert": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const store = getDiscoveryStore(STATE_DIR);
      // Two modes: create a fresh template from a name, or upsert a full template.
      if (p.template) {
        const next = store.upsertTemplate(p.template as DiscoveryDocTemplate);
        respond(true, { template: next });
        return;
      }
      const businessId = typeof p.businessId === "string" ? p.businessId : null;
      const name = typeof p.name === "string" ? p.name : "New template";
      if (!businessId) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "businessId required"));
        return;
      }
      const tpl = defaultTemplate(businessId, name);
      const next = store.upsertTemplate(tpl);
      respond(true, { template: next });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, String(e)));
    }
  },

  "discovery.templates.delete": async ({ params, respond }) => {
    try {
      const id = (params as { id?: string })?.id;
      if (!id) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id required"));
        return;
      }
      const ok = getDiscoveryStore(STATE_DIR).deleteTemplate(id);
      respond(true, { deleted: ok });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, String(e)));
    }
  },

  // ── Netlify wiring ───────────────────────────────────────

  "discovery.netlify.status": async ({ respond }) => {
    try {
      respond(true, netlifyStatus(STATE_DIR));
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, String(e)));
    }
  },

  "discovery.netlify.connect": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const token = typeof p.token === "string" ? p.token.trim() : "";
      if (!token) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "token required"));
        return;
      }
      // Validate by round-tripping /user.
      const client = new NetlifyClient({ token });
      const me = await client.whoami();
      const accountSlug =
        typeof p.accountSlug === "string" ? p.accountSlug : me.default_account_slug;
      const sitePrefix = typeof p.sitePrefix === "string" ? p.sitePrefix : undefined;
      writeNetlifySecrets(STATE_DIR, { token, accountSlug, sitePrefix });
      respond(true, {
        ok: true,
        connected: true,
        whoami: {
          email: me.email,
          fullName: me.full_name,
          defaultAccountSlug: me.default_account_slug,
        },
      });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, String(e)));
    }
  },

  "discovery.netlify.test": async ({ respond }) => {
    try {
      const token = getNetlifyToken(STATE_DIR);
      if (!token) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Netlify not connected"));
        return;
      }
      const client = new NetlifyClient({ token });
      const me = await client.whoami();
      const sites = await client.listSites();
      respond(true, { ok: true, email: me.email, siteCount: sites.length });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, String(e)));
    }
  },

  "discovery.netlify.disconnect": async ({ respond }) => {
    try {
      clearNetlifySecrets(STATE_DIR);
      respond(true, { ok: true });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, String(e)));
    }
  },

  "discovery.netlify.poll": async ({ respond }) => {
    try {
      const result = await pollOnce();
      respond(true, result);
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, String(e)));
    }
  },

  // ── Publish a business's forms to Netlify ────────────────

  "discovery.templates.publish": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const businessId = typeof p.businessId === "string" ? p.businessId : null;
      if (!businessId) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "businessId required"));
        return;
      }
      const token = getNetlifyToken(STATE_DIR);
      if (!token) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "Netlify not connected — call discovery.netlify.connect first",
          ),
        );
        return;
      }
      const store = getDiscoveryStore(STATE_DIR);
      const biz = loadBusinessProfile(businessId);
      if (!biz) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.NOT_FOUND, `Business ${businessId} not found`),
        );
        return;
      }
      const allTpls = store.listTemplates(businessId).filter((t) => t.enabled);
      if (allTpls.length === 0) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "No enabled templates to publish"),
        );
        return;
      }
      const sec = netlifyStatus(STATE_DIR);
      const client = new NetlifyClient({ token });

      // One site per business — find or create by deterministic name.
      const baseName = (
        (sec.sitePrefix ?? "ib-") +
        slugify(biz.name) +
        "-" +
        businessId.slice(0, 6)
      ).slice(0, 63);
      const site = await client.findOrCreateSite({
        name: baseName,
        accountSlug: sec.accountSlug ?? undefined,
      });

      // Generate static HTML for the site.
      const files = generateBusinessSite({
        businessId,
        businessName: biz.name,
        brandColor:
          typeof biz.brandColor === "string"
            ? biz.brandColor
            : (allTpls[0].style.brandColor ?? "#8b5cf6"),
        accent:
          typeof biz.accent === "string" ? biz.accent : (allTpls[0].style.accent ?? "#22d3ee"),
        fontFamily:
          typeof biz.fontFamily === "string"
            ? biz.fontFamily
            : (allTpls[0].style.fontFamily ?? "Inter, system-ui, sans-serif"),
        templates: allTpls,
      });
      const deploy = await client.deployFiles(site.id, files);

      // After deploy, Netlify auto-detects the forms — wait briefly and
      // resolve form ids so the poller can filter by form_name correctly.
      let forms: Array<{ id: string; name: string }> = [];
      for (let i = 0; i < 5; i++) {
        try {
          forms = await client.listForms(site.id);
          if (forms.length > 0) break;
        } catch {
          /* ignore */
        }
        await new Promise((r) => setTimeout(r, 1500));
      }

      // Stamp every template with its binding details so the poller and
      // the UI know the public URL.
      const publicUrlBase = site.ssl_url || site.url || `https://${site.name}.netlify.app`;
      const updated: DiscoveryDocTemplate[] = [];
      for (const tpl of allTpls) {
        const formName = `discovery-${tpl.slug}`;
        const form = forms.find((f) => f.name === formName);
        const next: DiscoveryDocTemplate = {
          ...tpl,
          netlify: {
            siteId: site.id,
            formName,
            publicUrl: `${publicUrlBase}/${tpl.slug}`,
            lastSeenSubmissionId: tpl.netlify?.lastSeenSubmissionId ?? null,
            lastPolledAt: tpl.netlify?.lastPolledAt ?? null,
          },
        };
        updated.push(store.upsertTemplate(next));
        // Touch the form id by name (best-effort log).
        void form;
      }

      respond(true, {
        siteId: site.id,
        siteName: site.name,
        publicUrl: publicUrlBase,
        deployId: deploy.id,
        deployState: deploy.state,
        templates: updated,
        formsDetected: forms.length,
      });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, String(e)));
    }
  },

  // ── Runs ──────────────────────────────────────────────────

  "discovery.runs.list": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const store = getDiscoveryStore(STATE_DIR);
      respond(true, {
        runs: store.listRuns({
          businessId: typeof p.businessId === "string" ? p.businessId : undefined,
          templateId: typeof p.templateId === "string" ? p.templateId : undefined,
          approvalState: typeof p.approvalState === "string" ? p.approvalState : undefined,
          limit: typeof p.limit === "number" ? p.limit : 100,
          offset: typeof p.offset === "number" ? p.offset : 0,
        }),
      });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, String(e)));
    }
  },

  "discovery.runs.get": async ({ params, respond }) => {
    try {
      const id = (params as { id?: string })?.id;
      if (!id) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id required"));
        return;
      }
      const run = getDiscoveryStore(STATE_DIR).getRun(id);
      if (!run) {
        respond(false, undefined, errorShape(ErrorCodes.NOT_FOUND, "Run not found"));
        return;
      }
      respond(true, { run });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, String(e)));
    }
  },

  "discovery.run.execute": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const templateId = typeof p.templateId === "string" ? p.templateId : null;
      const inputs = (p.inputs ?? {}) as Record<string, string>;
      const dryRun = p.dryRun === true;
      if (!templateId) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "templateId required"));
        return;
      }
      const store = getDiscoveryStore(STATE_DIR);
      const tpl = store.getTemplate(templateId);
      if (!tpl) {
        respond(false, undefined, errorShape(ErrorCodes.NOT_FOUND, "Template not found"));
        return;
      }
      const biz = loadBusinessProfile(tpl.businessId);
      if (!biz) {
        respond(false, undefined, errorShape(ErrorCodes.NOT_FOUND, "Business not found"));
        return;
      }
      const run = await runPipeline({
        template: tpl,
        inputs,
        source: "manual_test",
        business: biz,
        dryRun,
      });
      respond(true, { run });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, String(e)));
    }
  },

  "discovery.run.approve": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const id = typeof p.id === "string" ? p.id : null;
      const approver = typeof p.approver === "string" ? p.approver : "operator";
      const note = typeof p.note === "string" ? p.note : undefined;
      if (!id) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id required"));
        return;
      }
      const run = await approveRun(id, approver, note);
      if (!run) {
        respond(false, undefined, errorShape(ErrorCodes.NOT_FOUND, "Run not found"));
        return;
      }
      respond(true, { run });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, String(e)));
    }
  },

  "discovery.run.reject": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const id = typeof p.id === "string" ? p.id : null;
      const approver = typeof p.approver === "string" ? p.approver : "operator";
      const note = typeof p.note === "string" ? p.note : undefined;
      if (!id) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id required"));
        return;
      }
      const run = rejectRun(id, approver, note);
      if (!run) {
        respond(false, undefined, errorShape(ErrorCodes.NOT_FOUND, "Run not found"));
        return;
      }
      respond(true, { run });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, String(e)));
    }
  },

  // ── Settings ──────────────────────────────────────────────

  "discovery.settings.get": async ({ respond }) => {
    try {
      respond(true, getDiscoveryStore(STATE_DIR).getSettings());
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, String(e)));
    }
  },

  "discovery.settings.update": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      respond(true, getDiscoveryStore(STATE_DIR).updateSettings(p));
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, String(e)));
    }
  },
};

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
