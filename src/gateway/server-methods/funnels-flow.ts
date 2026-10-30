/**
 * Funnels — flow & binding handlers.
 *
 * Closes the gap between the funnel store and the rest of the InfiniBot
 * system (forms, landing pages, qualifier, CRM, integrations). Provides:
 *
 *   funnels.form.bind / unbind / list_bindings
 *   funnels.page.bind / unbind / list_bindings
 *   funnels.flow.snapshot   — end-to-end aggregate the new UI renders
 *   funnels.lead.source     — provenance for one lead (which form/page/integration)
 *
 * Lives in its own file so funnels.ts (already 700+ lines) stays focused
 * on intra-funnel CRUD.
 */

import { getFunnelStore } from "../../funnels/store.js";
import { getAutomationBridge } from "../../funnels/automation/bridge.js";
import { listRuns as listQualifierRuns } from "../../services/qualifier/store.js";
import type { GatewayRequestHandlers } from "./types.js";

// Boot the automation bridge so qualification rules fire on lead events.
// Idempotent — safe if called repeatedly.
getAutomationBridge();

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/* ─── form ↔ funnel bindings ────────────────────────────────────── */

export const funnelsFlowHandlers: GatewayRequestHandlers = {
  "funnels.form.bind": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const formId = asString(p.formId);
      const businessId = asString(p.businessId);
      const funnelId = asString(p.funnelId);
      const entryStageId = asString(p.entryStageId);
      if (!formId || !businessId || !funnelId || !entryStageId) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "formId, businessId, funnelId, entryStageId are all required",
        });
        return;
      }
      const result = getFunnelStore().bindFormToFunnel({
        formId,
        businessId,
        funnelId,
        entryStageId,
        tag: asString(p.tag),
      });
      respond(true, { binding: result });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "funnels.form.unbind": async ({ params, respond }) => {
    try {
      const formId = asString((params as Record<string, unknown>)?.formId);
      if (!formId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "formId required" });
        return;
      }
      respond(true, { unbound: getFunnelStore().unbindForm(formId) });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "funnels.form.list_bindings": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const bindings = getFunnelStore().listFormBindings({
        businessId: asString(p.businessId),
        funnelId: asString(p.funnelId),
      });
      respond(true, { count: bindings.length, bindings });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /* ─── landing-page ↔ funnel bindings ───────────────────────────── */

  "funnels.page.bind": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const pageId = asString(p.pageId);
      const businessId = asString(p.businessId);
      const funnelId = asString(p.funnelId);
      const entryStageId = asString(p.entryStageId);
      if (!pageId || !businessId || !funnelId || !entryStageId) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "pageId, businessId, funnelId, entryStageId are all required",
        });
        return;
      }
      const result = getFunnelStore().bindPageToFunnel({
        pageId,
        businessId,
        funnelId,
        entryStageId,
        tag: asString(p.tag),
      });
      respond(true, { binding: result });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "funnels.page.unbind": async ({ params, respond }) => {
    try {
      const pageId = asString((params as Record<string, unknown>)?.pageId);
      if (!pageId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "pageId required" });
        return;
      }
      respond(true, { unbound: getFunnelStore().unbindPage(pageId) });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "funnels.page.list_bindings": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const bindings = getFunnelStore().listPageBindings({
        businessId: asString(p.businessId),
        funnelId: asString(p.funnelId),
      });
      respond(true, { count: bindings.length, bindings });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /* ─── flow snapshot — the end-to-end aggregate ─────────────────── */

  "funnels.flow.snapshot": async ({ params, respond }) => {
    try {
      const funnelId = asString((params as Record<string, unknown>)?.funnelId);
      if (!funnelId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "funnelId required" });
        return;
      }
      const store = getFunnelStore();
      const funnel = store.getFunnel(funnelId);
      if (!funnel) {
        respond(false, undefined, { code: "NOT_FOUND", message: "funnel not found" });
        return;
      }
      const stages = store.getStages(funnelId);
      const leads = store.listLeads({ funnelId }).filter((l) => !l.archivedAt);
      const formBindings = store.listFormBindings({ funnelId });
      const pageBindings = store.listPageBindings({ funnelId });

      // Group leads by source (tag prefix) — this is how we attribute
      // each lead back to a form, page, integration, or manual import.
      // Sources without any leads still appear (so empty form bindings
      // show up in the UI as a connected-but-quiet upstream node).
      const bySource = new Map<string, number>();
      for (const lead of leads) {
        const tags = lead.tags ?? [];
        const src =
          tags.find((t) => t.startsWith("form_"))?.slice(5) ??
          tags.find((t) => t.startsWith("page_"))?.slice(5) ??
          tags.find((t) => t.startsWith("integration_"))?.slice(12) ??
          tags.find((t) => t.startsWith("import_"))?.slice(7) ??
          "manual";
        bySource.set(src, (bySource.get(src) ?? 0) + 1);
      }

      // Stage rollup: count + qualified-verdict breakdown.
      const verdicts = listQualifierRuns(funnel.businessId, 500);
      const verdictByLead = new Map<string, "qualified" | "unqualified" | "pending" | "error">();
      for (const v of verdicts) {
        if (!v.leadId) continue;
        const prev = verdictByLead.get(v.leadId);
        // Keep the latest verdict — qualifier runs are stored newest-first.
        if (!prev) verdictByLead.set(v.leadId, v.result);
      }

      const stageRollups = stages.map((stage: import("../../funnels/types.js").Stage) => {
        const stageLeads = leads.filter((l) => l.stageId === stage.id);
        let qualified = 0;
        let unqualified = 0;
        let pending = 0;
        for (const l of stageLeads) {
          const v = verdictByLead.get(l.id);
          if (v === "qualified") qualified++;
          else if (v === "unqualified") unqualified++;
          else pending++;
        }
        return {
          id: stage.id,
          name: stage.name,
          type: stage.type,
          position: stage.position,
          leadCount: stageLeads.length,
          qualified,
          unqualified,
          pending,
          // First 5 lead previews — keeps the snapshot small but useful.
          sampleLeads: stageLeads.slice(0, 5).map((l) => ({
            id: l.id,
            name: l.name,
            score: l.score ?? null,
            status: l.status,
          })),
        };
      });

      // Outcomes: won / lost / promoted-to-CRM counts.
      const won = leads.filter((l) => l.status === "won").length;
      const lost = leads.filter((l) => l.status === "lost").length;
      const promotedToCrm = leads.filter((l) =>
        (l.tags ?? []).some((t) => t === "promoted_to_crm" || t.startsWith("crm_")),
      ).length;

      // Sources rollup with the form/page bindings as known upstreams.
      // A binding can match leads by a few possible keys depending on how
      // the lead was tagged (raw id, prefixed id, or the binding's tag).
      // Consume each matched key so untracked rollup doesn't double-count.
      const consume = (keys: Array<string | undefined | null>): number => {
        let total = 0;
        for (const k of keys) {
          if (!k) continue;
          const v = bySource.get(k);
          if (v !== undefined) {
            total += v;
            bySource.delete(k);
          }
        }
        return total;
      };
      const sources = [
        ...formBindings.map((b) => ({
          kind: "form" as const,
          id: b.formId,
          tag: b.tag ?? `form_${b.formId}`,
          entryStageId: b.entryStageId,
          leadCount: consume([
            b.formId,
            `form_${b.formId}`,
            b.tag ?? undefined,
            b.tag ? `form_${b.tag}` : undefined,
          ]),
        })),
        ...pageBindings.map((b) => ({
          kind: "page" as const,
          id: b.pageId,
          tag: b.tag ?? `page_${b.pageId}`,
          entryStageId: b.entryStageId,
          leadCount: consume([
            b.pageId,
            `page_${b.pageId}`,
            b.tag ?? undefined,
            b.tag ? `page_${b.tag}` : undefined,
          ]),
        })),
        // Anything else that delivered leads but isn't bound (manual
        // imports, raw integrations, etc.) shows up as an "untracked"
        // source so the user sees it and can decide whether to bind.
        ...[...bySource.entries()].map(([src, count]) => ({
          kind: "untracked" as const,
          id: src,
          tag: src,
          entryStageId: null as string | null,
          leadCount: count,
        })),
      ];

      respond(true, {
        funnel: {
          id: funnel.id,
          name: funnel.name,
          type: funnel.type,
          businessId: funnel.businessId,
          status: funnel.status,
        },
        sources,
        stages: stageRollups,
        outcomes: {
          won,
          lost,
          promotedToCrm,
          totalLeads: leads.length,
        },
        verdictsAttached: verdictByLead.size,
        generatedAt: new Date().toISOString(),
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /* ─── per-lead provenance ──────────────────────────────────────── */

  "funnels.lead.source": async ({ params, respond }) => {
    try {
      const leadId = asString((params as Record<string, unknown>)?.leadId);
      if (!leadId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "leadId required" });
        return;
      }
      const lead = getFunnelStore().getLead(leadId);
      if (!lead) {
        respond(false, undefined, { code: "NOT_FOUND", message: "lead not found" });
        return;
      }
      const tags = lead.tags ?? [];
      const formTag = tags.find((t) => t.startsWith("form_"));
      const pageTag = tags.find((t) => t.startsWith("page_"));
      const integrationTag = tags.find((t) => t.startsWith("integration_"));
      const importTag = tags.find((t) => t.startsWith("import_"));
      const kind = formTag
        ? "form"
        : pageTag
          ? "page"
          : integrationTag
            ? "integration"
            : importTag
              ? "import"
              : "manual";
      const sourceId =
        formTag?.slice(5) ??
        pageTag?.slice(5) ??
        integrationTag?.slice(12) ??
        importTag?.slice(7) ??
        null;
      respond(true, {
        leadId,
        kind,
        sourceId,
        funnelId: lead.funnelId,
        stageId: lead.stageId,
        firstContactAt: lead.firstContactAt ?? lead.createdAt,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};
