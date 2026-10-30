/**
 * Funnel System Gateway Handlers
 * RPC methods for business automation and sales funnel management
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getFunnelStore } from "../../funnels/store.js";
import {
  getAgencyFunnelStore,
  getAgencyOperationsStore,
  type AgencyRole,
} from "../../agency-operations/index.js";
import { resolveStateDir } from "../../config/paths.js";
import { getUserStore } from "../../users/store.js";
import type {
  Business,
  Funnel,
  FunnelType,
  FunnelStatus,
  Stage,
  StageType,
  Lead,
  LeadSource,
  LeadStatus,
  LeadPriority,
  LeadFilters,
  FunnelFilters,
  Offer,
  OfferType,
  FunnelTask,
  FunnelTaskType,
  FunnelTaskPriority,
  FunnelTaskStatus,
  TaskFilters,
  MetricType,
  MetricPeriod,
} from "../../funnels/types.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";

const log = createSubsystemLogger("funnels-gateway");

function agencyActorId(opts: GatewayRequestHandlerOptions): string {
  const authUser = opts.client?.authUser?.trim().toLowerCase();
  if (opts.client?.authMethod === "tailscale" && authUser) return `tailscale:${authUser}`;
  const password = opts.client?.connect.auth?.password;
  if (typeof password === "string" && password) {
    const user = getUserStore(resolveStateDir()).findByGatewayPassword(password);
    if (user) return user.id;
  }
  return "local-owner";
}

function requireAgencyFunnelWrite(opts: GatewayRequestHandlerOptions, agencyId: string): void {
  const operations = getAgencyOperationsStore(resolveStateDir());
  if (!operations.getAgency(agencyId)) return; // Legacy non-agency business.
  const actorId = agencyActorId(opts);
  const role = operations
    .listAgencyMembers(agencyId)
    .find((membership) => membership.userId === actorId)?.role as AgencyRole | undefined;
  if (!role) throw new Error("agency membership required");
  if (!["owner", "admin", "member"].includes(role)) throw new Error("insufficient agency role");
}

function reconcileCanonicalFunnel(legacyFunnelId: string, agencyIdHint?: string): void {
  const legacy = getFunnelStore();
  const funnel = legacy.getFunnel(legacyFunnelId);
  const agencyId = funnel?.businessId ?? agencyIdHint;
  if (!agencyId) return;
  const operations = getAgencyOperationsStore(resolveStateDir());
  if (!operations.getAgency(agencyId)) return;
  const canonical = getAgencyFunnelStore(resolveStateDir());
  if (!funnel || funnel.status === "archived") {
    canonical.archiveLegacyFunnel(agencyId, legacyFunnelId);
    return;
  }
  canonical.reconcileLegacySnapshot(agencyId, {
    funnel,
    stages: legacy.getStages(legacyFunnelId),
    edges: legacy.getConnections(legacyFunnelId),
  });
}

// ═══════════════════════════════════════════════════════════════
// ERROR HELPER
// ═══════════════════════════════════════════════════════════════

function extractErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object") {
    if ("message" in e && typeof (e as any).message === "string") {
      return (e as any).message;
    }
    if ("error" in e && typeof (e as any).error === "string") {
      return (e as any).error;
    }
    try {
      return JSON.stringify(e);
    } catch {
      return "[complex error object]";
    }
  }
  return String(e);
}

// ═══════════════════════════════════════════════════════════════
// CANVAS LAYOUT STATE (for React Flow)
// ═══════════════════════════════════════════════════════════════

// In-memory cache for canvas layouts (could be persisted later)
const canvasLayouts: Map<
  string,
  {
    nodes: Array<{ id: string; position: { x: number; y: number }; data: any }>;
    edges: Array<{ id: string; source: string; target: string; data?: any }>;
    viewport?: { x: number; y: number; zoom: number };
    updatedAt: string;
  }
> = new Map();

// ═══════════════════════════════════════════════════════════════
// HANDLERS
// ═══════════════════════════════════════════════════════════════

export const funnelHandlers: GatewayRequestHandlers = {
  // ═══════════════════════════════════════════════════════════════
  // BUSINESS HANDLERS
  // ═══════════════════════════════════════════════════════════════

  "funnels.business.create": async ({ params, respond }) => {
    try {
      const store = getFunnelStore();
      const name = params.name as string;

      if (!name) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "name is required" });
        return;
      }

      const business = store.createBusiness({
        name,
        description: params.description as string | undefined,
        industry: params.industry as string | undefined,
        website: params.website as string | undefined,
        email: params.email as string | undefined,
        phone: params.phone as string | undefined,
        address: params.address as string | undefined,
        timezone: (params.timezone as string) ?? "UTC",
        currency: (params.currency as string) ?? "USD",
        ownerId: params.ownerId as string | undefined,
      });

      log.info("Created business", { businessId: business.id, name });
      respond(true, { business });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "funnels.business.get": async ({ params, respond }) => {
    try {
      const store = getFunnelStore();
      const id = (params.id as string) || (params.businessId as string);

      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }

      const business = store.getBusiness(id);
      if (!business) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Business not found" });
        return;
      }

      respond(true, { business });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "funnels.business.list": async ({ params, respond }) => {
    try {
      const store = getFunnelStore();

      // Mirror the main business store (state/business.json) into funnels.db
      // on every list call. Funnels has its own `businesses` table with FK
      // constraints from funnels/leads/offers, so we can't just return the
      // main-store rows directly — we have to make sure rows with matching
      // ids exist locally so a subsequent `funnels.create` doesn't break the
      // FK. Without this mirror, the funnel onboarding wizard never sees the
      // businesses the user already set up elsewhere and silently falls back
      // to the "name your brand" text input.
      try {
        const fs = await import("node:fs");
        const path = await import("node:path");
        // Mirror business.ts:getStateDir (resolveStateDir(), request-scoped on
        // a cloud workspace) — a different path re-introduces the empty-list bug.
        const stateDir = resolveStateDir();
        const statePath = path.join(stateDir, "business.json");
        const raw = fs.readFileSync(statePath, "utf-8");
        const parsed = JSON.parse(raw) as { businesses?: Array<Record<string, unknown>> };
        if (Array.isArray(parsed.businesses)) {
          for (const biz of parsed.businesses) {
            if (typeof biz.id !== "string" || !biz.id) continue;
            store.upsertBusinessRaw({
              id: biz.id,
              name: typeof biz.name === "string" && biz.name ? biz.name : "Untitled",
              description: typeof biz.tagline === "string" ? biz.tagline : undefined,
              industry: typeof biz.industry === "string" ? biz.industry : undefined,
              website: typeof biz.website === "string" ? biz.website : undefined,
              logo: typeof biz.logo === "string" ? biz.logo : undefined,
              email: typeof biz.email === "string" ? biz.email : undefined,
              phone: typeof biz.phone === "string" ? biz.phone : undefined,
              address: typeof biz.address === "string" ? biz.address : undefined,
            });
          }
        }
      } catch {
        // No main-store file yet (fresh install) or it's malformed. Fall
        // through to whatever funnels.db already has — the onboarding wizard
        // will offer its "create new" branch when the list is still empty.
      }

      const ownerId = params.ownerId as string | undefined;
      const businesses = store.getBusinesses(ownerId);
      respond(true, { businesses, count: businesses.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "funnels.business.update": async ({ params, respond }) => {
    try {
      const store = getFunnelStore();
      const id = (params.id as string) || (params.businessId as string);

      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }

      const updates: Partial<Business> = {};
      if (params.name !== undefined) updates.name = params.name as string;
      if (params.description !== undefined) updates.description = params.description as string;
      if (params.industry !== undefined) updates.industry = params.industry as string;
      if (params.website !== undefined) updates.website = params.website as string;
      if (params.email !== undefined) updates.email = params.email as string;
      if (params.phone !== undefined) updates.phone = params.phone as string;
      if (params.address !== undefined) updates.address = params.address as string;
      if (params.timezone !== undefined) updates.timezone = params.timezone as string;
      if (params.currency !== undefined) updates.currency = params.currency as string;

      const business = store.updateBusiness(id, updates);
      if (!business) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Business not found" });
        return;
      }

      log.info("Updated business", { businessId: id });
      respond(true, { business });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // FUNNEL HANDLERS
  // ═══════════════════════════════════════════════════════════════

  "funnels.create": async (opts) => {
    const { params, respond } = opts;
    try {
      const store = getFunnelStore();
      const businessId = params.businessId as string;
      const name = params.name as string;

      if (!businessId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "businessId is required" });
        return;
      }
      if (!name) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "name is required" });
        return;
      }
      requireAgencyFunnelWrite(opts, businessId);

      const funnel = store.createFunnel({
        businessId,
        name,
        description: params.description as string | undefined,
        type: (params.type as FunnelType) ?? "sales",
        status: "draft",
        automationEnabled: false,
      });

      // Bootstrap the per-funnel workspace (assets, templates, sop dirs
      // + a default page.json) so subsequent operations don't need to
      // re-check existence.
      try {
        const { ensureFunnelWorkspace } = await import("../../funnels/workspace.js");
        ensureFunnelWorkspace(funnel.id, funnel.name);
      } catch (err) {
        log.warn("ensureFunnelWorkspace failed", { funnelId: funnel.id, error: String(err) });
      }

      // Auto-register in the /apps catalog so the funnel surfaces next
      // to projects, sites, etc. Description tracks both the funnel
      // type and its business for quick scanning.
      try {
        const { autoRegister } = await import("../../apps/store.js");
        const { resolveStateDir } = await import("../../config/paths.js");
        autoRegister(resolveStateDir(), {
          sourceKind: "manual",
          sourceId: funnel.id,
          name: funnel.name,
          description: funnel.description ?? `${funnel.type} funnel`,
          type: "other",
          businessId,
          meta: { kind: "funnel", funnelType: funnel.type },
        });
      } catch (err) {
        log.warn("apps.autoRegister failed for funnel", {
          funnelId: funnel.id,
          error: String(err),
        });
      }

      log.info("Created funnel", { funnelId: funnel.id, name, businessId });
      reconcileCanonicalFunnel(funnel.id, businessId);
      respond(true, { funnel });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "funnels.get": async ({ params, respond }) => {
    try {
      const store = getFunnelStore();
      const id = (params.id as string) || (params.funnelId as string);

      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }

      const funnel = store.getFunnel(id);
      if (!funnel) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Funnel not found" });
        return;
      }

      // Include stages and connections
      const stages = store.getStages(id);
      const connections = store.getConnections(id);

      respond(true, { funnel, stages, connections });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "funnels.list": async ({ params, respond }) => {
    try {
      const store = getFunnelStore();
      const filters: FunnelFilters = {
        businessId: params.businessId as string | undefined,
        type: params.type as FunnelType | FunnelType[] | undefined,
        status: params.status as FunnelStatus | FunnelStatus[] | undefined,
        search: params.search as string | undefined,
        limit: typeof params.limit === "number" ? params.limit : 50,
        offset: typeof params.offset === "number" ? params.offset : 0,
      };

      const funnels = store.getFunnels(filters);
      respond(true, { funnels, count: funnels.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "funnels.update": async (opts) => {
    const { params, respond } = opts;
    try {
      const store = getFunnelStore();
      const id = (params.id as string) || (params.funnelId as string);

      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }
      const existing = store.getFunnel(id);
      if (existing) requireAgencyFunnelWrite(opts, existing.businessId);

      const updates: Partial<Funnel> = {};
      if (params.name !== undefined) updates.name = params.name as string;
      if (params.description !== undefined) updates.description = params.description as string;
      if (params.type !== undefined) updates.type = params.type as FunnelType;
      if (params.status !== undefined) updates.status = params.status as FunnelStatus;
      if (params.color !== undefined) updates.color = params.color as string;
      if (params.icon !== undefined) updates.icon = params.icon as string;
      if (params.automationEnabled !== undefined)
        updates.automationEnabled = params.automationEnabled as boolean;
      if (params.webhookUrl !== undefined) updates.webhookUrl = params.webhookUrl as string;

      const funnel = store.updateFunnel(id, updates);
      if (!funnel) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Funnel not found" });
        return;
      }

      log.info("Updated funnel", { funnelId: id });
      reconcileCanonicalFunnel(id, funnel.businessId);
      respond(true, { funnel });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "funnels.delete": async (opts) => {
    const { params, respond } = opts;
    try {
      const store = getFunnelStore();
      const id = (params.id as string) || (params.funnelId as string);

      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }
      const existing = store.getFunnel(id);
      if (existing) requireAgencyFunnelWrite(opts, existing.businessId);

      // Soft delete by archiving
      const funnel = store.updateFunnel(id, {
        status: "archived",
        archivedAt: new Date().toISOString(),
      });

      if (!funnel) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Funnel not found" });
        return;
      }

      log.info("Archived funnel", { funnelId: id });
      reconcileCanonicalFunnel(id, funnel.businessId);
      respond(true, { deleted: true, funnelId: id });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "funnels.duplicate": async (opts) => {
    const { params, respond } = opts;
    try {
      const store = getFunnelStore();
      const id = (params.id as string) || (params.funnelId as string);
      const newName = params.name as string | undefined;

      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }

      const original = store.getFunnel(id);
      if (!original) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Funnel not found" });
        return;
      }
      requireAgencyFunnelWrite(opts, original.businessId);

      // Create duplicate funnel
      const duplicate = store.createFunnel({
        businessId: original.businessId,
        name: newName || `${original.name} (Copy)`,
        description: original.description,
        type: original.type,
        status: "draft",
        automationEnabled: false,
      });

      // Duplicate stages
      const originalStages = store.getStages(id);
      const stageMapping: Record<string, string> = {};

      for (const stage of originalStages) {
        const newStage = store.createStage({
          funnelId: duplicate.id,
          name: stage.name,
          type: stage.type,
          position: stage.position,
          description: stage.description,
          color: stage.color,
          icon: stage.icon,
        });
        stageMapping[stage.id] = newStage.id;
      }

      // Duplicate connections
      const originalConnections = store.getConnections(id);
      for (const conn of originalConnections) {
        const newSourceId = stageMapping[conn.sourceStageId];
        const newTargetId = stageMapping[conn.targetStageId];
        if (newSourceId && newTargetId) {
          store.createConnection({
            funnelId: duplicate.id,
            sourceStageId: newSourceId,
            targetStageId: newTargetId,
            label: conn.label,
          });
        }
      }

      log.info("Duplicated funnel", { originalId: id, duplicateId: duplicate.id });
      reconcileCanonicalFunnel(duplicate.id, duplicate.businessId);
      respond(true, { funnel: duplicate, stageMapping });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "funnels.analytics": async ({ params, respond }) => {
    try {
      const store = getFunnelStore();
      const id = (params.id as string) || (params.funnelId as string);

      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }

      const funnel = store.getFunnel(id);
      if (!funnel) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Funnel not found" });
        return;
      }

      const stages = store.getStages(id);
      const leads = store.getLeads({ funnelId: id, limit: 10000 });

      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const newLeads = leads.filter((l) => l.createdAt >= thirtyDaysAgo);
      const wonLeads = leads.filter((l) => l.status === "won");
      const lostLeads = leads.filter((l) => l.status === "lost");

      const leadsPerStage: Record<string, number> = {};
      const valuePerStage: Record<string, number> = {};
      for (const stage of stages) {
        leadsPerStage[stage.id] = leads.filter((l) => l.stageId === stage.id).length;
        valuePerStage[stage.id] = leads
          .filter((l) => l.stageId === stage.id)
          .reduce((sum, l) => sum + (l.estimatedValue ?? 0), 0);
      }

      // Calculate stage conversion rates
      const stageConversionRates: Record<string, number> = {};
      for (let i = 0; i < stages.length - 1; i++) {
        const currentCount = leadsPerStage[stages[i].id] ?? 0;
        const nextCount = leadsPerStage[stages[i + 1].id] ?? 0;
        stageConversionRates[stages[i].id] =
          currentCount > 0 ? (nextCount / currentCount) * 100 : 0;
      }

      const totalValue = leads.reduce((sum, l) => sum + (l.estimatedValue ?? 0), 0);
      const wonValue = wonLeads.reduce(
        (sum, l) => sum + (l.actualValue ?? l.estimatedValue ?? 0),
        0,
      );
      const lostValue = lostLeads.reduce((sum, l) => sum + (l.estimatedValue ?? 0), 0);

      // Calculate bottlenecks
      const bottlenecks: { stageId: string; stageName: string; issue: string; severity: string }[] =
        [];
      for (const stage of stages) {
        const convRate = stageConversionRates[stage.id];
        if (convRate !== undefined && convRate < 20) {
          bottlenecks.push({
            stageId: stage.id,
            stageName: stage.name,
            issue: `Low conversion rate (${convRate.toFixed(1)}%)`,
            severity: convRate < 10 ? "critical" : "warning",
          });
        }

        const leadCount = leadsPerStage[stage.id] ?? 0;
        if (leads.length > 10 && leadCount / leads.length > 0.5) {
          bottlenecks.push({
            stageId: stage.id,
            stageName: stage.name,
            issue: `High lead accumulation (${((leadCount / leads.length) * 100).toFixed(0)}% of leads stuck here)`,
            severity: "warning",
          });
        }
      }

      const analytics = {
        funnelId: id,
        period: { start: thirtyDaysAgo, end: new Date().toISOString() },
        totalLeads: leads.length,
        newLeads: newLeads.length,
        convertedLeads: wonLeads.length,
        lostLeads: lostLeads.length,
        overallConversionRate: leads.length > 0 ? (wonLeads.length / leads.length) * 100 : 0,
        stageConversionRates,
        totalValue,
        wonValue,
        lostValue,
        averageDealSize: wonLeads.length > 0 ? wonValue / wonLeads.length : 0,
        leadsPerStage,
        valuePerStage,
      };

      respond(true, { analytics, bottlenecks });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // STAGE HANDLERS
  // ═══════════════════════════════════════════════════════════════

  "funnels.stage.add": async (opts) => {
    const { params, respond } = opts;
    try {
      const store = getFunnelStore();
      const funnelId = params.funnelId as string;
      const name = params.name as string;

      if (!funnelId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "funnelId is required" });
        return;
      }
      if (!name) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "name is required" });
        return;
      }
      const parentFunnel = store.getFunnel(funnelId);
      if (parentFunnel) requireAgencyFunnelWrite(opts, parentFunnel.businessId);

      // Get existing stages to calculate position
      const existingStages = store.getStages(funnelId);
      const position =
        typeof params.position === "number" ? params.position : existingStages.length;

      const stage = store.createStage({
        funnelId,
        name,
        type: (params.type as StageType) ?? "standard",
        position,
        description: params.description as string | undefined,
        color: params.color as string | undefined,
        icon: params.icon as string | undefined,
      });

      log.info("Added stage", { stageId: stage.id, funnelId, name });
      reconcileCanonicalFunnel(funnelId, parentFunnel?.businessId);
      respond(true, { stage });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "funnels.stage.update": async (opts) => {
    const { params, respond } = opts;
    try {
      const store = getFunnelStore();
      const id = (params.id as string) || (params.stageId as string);

      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }
      const existingStage = store.getStage(id);
      const parentFunnel = existingStage ? store.getFunnel(existingStage.funnelId) : null;
      if (parentFunnel) requireAgencyFunnelWrite(opts, parentFunnel.businessId);

      const updates: Partial<Stage> = {};
      if (params.name !== undefined) updates.name = params.name as string;
      if (params.description !== undefined) updates.description = params.description as string;
      if (params.type !== undefined) updates.type = params.type as StageType;
      if (params.color !== undefined) updates.color = params.color as string;
      if (params.icon !== undefined) updates.icon = params.icon as string;
      if (typeof params.position === "number") updates.position = params.position;
      if (typeof params.autoMoveAfterDays === "number")
        updates.autoMoveAfterDays = params.autoMoveAfterDays;
      if (typeof params.maxDaysAllowed === "number") updates.maxDaysAllowed = params.maxDaysAllowed;

      const stage = store.updateStage(id, updates);
      if (!stage) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Stage not found" });
        return;
      }

      log.info("Updated stage", { stageId: id });
      reconcileCanonicalFunnel(stage.funnelId, parentFunnel?.businessId);
      respond(true, { stage });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "funnels.stage.delete": async (opts) => {
    const { params, respond } = opts;
    try {
      const store = getFunnelStore();
      const id = (params.id as string) || (params.stageId as string);

      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }

      const stage = store.getStage(id);
      if (!stage) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Stage not found" });
        return;
      }
      const parentFunnel = store.getFunnel(stage.funnelId);
      if (parentFunnel) requireAgencyFunnelWrite(opts, parentFunnel.businessId);

      // Check if stage has leads
      const leads = store.getLeads({ stageId: id, limit: 1 });
      if (leads.length > 0) {
        respond(false, undefined, {
          code: "HAS_LEADS",
          message: "Cannot delete stage with leads. Move or delete leads first.",
        });
        return;
      }

      store.deleteStage(id);
      log.info("Deleted stage", { stageId: id });
      reconcileCanonicalFunnel(stage.funnelId, parentFunnel?.businessId);
      respond(true, { deleted: true, stageId: id });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "funnels.stage.connect": async (opts) => {
    const { params, respond } = opts;
    try {
      const store = getFunnelStore();
      const funnelId = params.funnelId as string;
      const sourceStageId = (params.sourceStageId as string) || (params.from as string);
      const targetStageId = (params.targetStageId as string) || (params.to as string);

      if (!funnelId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "funnelId is required" });
        return;
      }
      if (!sourceStageId || !targetStageId) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "sourceStageId and targetStageId are required",
        });
        return;
      }
      const parentFunnel = store.getFunnel(funnelId);
      if (parentFunnel) requireAgencyFunnelWrite(opts, parentFunnel.businessId);

      const connection = store.createConnection({
        funnelId,
        sourceStageId,
        targetStageId,
        label: params.label as string | undefined,
      });

      log.info("Connected stages", { connectionId: connection.id, funnelId });
      reconcileCanonicalFunnel(funnelId, parentFunnel?.businessId);
      respond(true, { connection });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "funnels.stage.disconnect": async (opts) => {
    const { params, respond } = opts;
    try {
      const store = getFunnelStore();
      const connectionId = (params.connectionId as string) || (params.id as string);
      if (!connectionId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "connectionId is required" });
        return;
      }
      const existingConnection = store.getConnection(connectionId);
      const parentFunnel = existingConnection ? store.getFunnel(existingConnection.funnelId) : null;
      if (parentFunnel) requireAgencyFunnelWrite(opts, parentFunnel.businessId);
      const removed = store.deleteConnection(connectionId);
      if (!removed) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Connection not found" });
        return;
      }
      log.info("Disconnected stages", { connectionId });
      if (existingConnection) {
        reconcileCanonicalFunnel(existingConnection.funnelId, parentFunnel?.businessId);
      }
      respond(true, { deleted: true, connectionId });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "funnels.stage.reorder": async (opts) => {
    const { params, respond } = opts;
    try {
      const store = getFunnelStore();
      const funnelId = params.funnelId as string;
      const stageOrder = params.stageOrder as string[];

      if (!funnelId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "funnelId is required" });
        return;
      }
      if (!stageOrder || !Array.isArray(stageOrder)) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "stageOrder array is required",
        });
        return;
      }
      const parentFunnel = store.getFunnel(funnelId);
      if (parentFunnel) requireAgencyFunnelWrite(opts, parentFunnel.businessId);

      // Update each stage's position
      for (let i = 0; i < stageOrder.length; i++) {
        store.updateStage(stageOrder[i], { position: i });
      }

      const stages = store.getStages(funnelId);
      log.info("Reordered stages", { funnelId, count: stageOrder.length });
      reconcileCanonicalFunnel(funnelId, parentFunnel?.businessId);
      respond(true, { stages });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "funnels.stage.kpis": async ({ params, respond }) => {
    try {
      const store = getFunnelStore();
      const stageId = (params.stageId as string) || (params.id as string);

      if (!stageId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "stageId is required" });
        return;
      }

      const stage = store.getStage(stageId);
      if (!stage) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Stage not found" });
        return;
      }

      // Get leads in this stage
      const leads = store.getLeads({ stageId, limit: 10000 });

      // Calculate KPIs
      const totalValue = leads.reduce((sum, l) => sum + (l.estimatedValue ?? 0), 0);
      const avgValue = leads.length > 0 ? totalValue / leads.length : 0;
      const priorityBreakdown = {
        urgent: leads.filter((l) => l.priority === "urgent").length,
        high: leads.filter((l) => l.priority === "high").length,
        medium: leads.filter((l) => l.priority === "medium").length,
        low: leads.filter((l) => l.priority === "low").length,
      };

      respond(true, {
        stageId,
        stageName: stage.name,
        leadCount: leads.length,
        totalValue,
        avgValue,
        priorityBreakdown,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // LEAD HANDLERS
  // ═══════════════════════════════════════════════════════════════

  "funnels.lead.create": async ({ params, respond }) => {
    try {
      const store = getFunnelStore();
      const businessId = params.businessId as string;
      const funnelId = params.funnelId as string;
      const stageId = params.stageId as string;
      const name = params.name as string;

      if (!businessId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "businessId is required" });
        return;
      }
      if (!funnelId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "funnelId is required" });
        return;
      }
      if (!stageId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "stageId is required" });
        return;
      }
      if (!name) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "name is required" });
        return;
      }

      const lead = store.createLead({
        businessId,
        funnelId,
        stageId,
        name,
        email: params.email as string | undefined,
        phone: params.phone as string | undefined,
        company: params.company as string | undefined,
        source: (params.source as LeadSource) ?? "manual",
        status: "new",
        priority: "medium",
        estimatedValue:
          typeof params.estimatedValue === "number" ? params.estimatedValue : undefined,
        tags: params.tags as string[] | undefined,
        customFields: params.customFields as Record<string, unknown> | undefined,
      });

      log.info("Created lead", { leadId: lead.id, name, funnelId });
      respond(true, { lead });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "funnels.lead.get": async ({ params, respond }) => {
    try {
      const store = getFunnelStore();
      const id = (params.id as string) || (params.leadId as string);

      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }

      const lead = store.getLead(id);
      if (!lead) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Lead not found" });
        return;
      }

      // Include activities and history
      const activities = store.getLeadActivities(id);
      const stageHistory = store.getLeadStageHistory(id);

      respond(true, { lead, activities, stageHistory });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "funnels.lead.update": async ({ params, respond }) => {
    try {
      const store = getFunnelStore();
      const id = (params.id as string) || (params.leadId as string);

      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }

      const updates: Partial<Lead> = {};
      if (params.name !== undefined) updates.name = params.name as string;
      if (params.email !== undefined) updates.email = params.email as string;
      if (params.phone !== undefined) updates.phone = params.phone as string;
      if (params.company !== undefined) updates.company = params.company as string;
      if (params.title !== undefined) updates.title = params.title as string;
      if (params.status !== undefined) updates.status = params.status as LeadStatus;
      if (params.priority !== undefined) updates.priority = params.priority as LeadPriority;
      if (typeof params.score === "number") updates.score = params.score;
      if (typeof params.estimatedValue === "number") updates.estimatedValue = params.estimatedValue;
      if (params.assignedTo !== undefined) updates.assignedTo = params.assignedTo as string;
      if (params.tags !== undefined) updates.tags = params.tags as string[];
      if (params.customFields !== undefined)
        updates.customFields = params.customFields as Record<string, unknown>;
      if (params.expectedCloseDate !== undefined)
        updates.expectedCloseDate = params.expectedCloseDate as string;

      const lead = store.updateLead(id, updates);
      if (!lead) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Lead not found" });
        return;
      }

      log.info("Updated lead", { leadId: id });
      respond(true, { lead });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "funnels.lead.search": async ({ params, respond }) => {
    try {
      const store = getFunnelStore();
      const filters: LeadFilters = {
        businessId: params.businessId as string | undefined,
        funnelId: params.funnelId as string | undefined,
        stageId: params.stageId as string | undefined,
        status: params.status as LeadStatus | LeadStatus[] | undefined,
        priority: params.priority as LeadPriority | LeadPriority[] | undefined,
        source: params.source as LeadSource | LeadSource[] | undefined,
        assignedTo: params.assignedTo as string | undefined,
        tags: params.tags as string[] | undefined,
        minScore: typeof params.minScore === "number" ? params.minScore : undefined,
        maxScore: typeof params.maxScore === "number" ? params.maxScore : undefined,
        search: (params.search as string) || (params.query as string | undefined),
        limit: typeof params.limit === "number" ? params.limit : 50,
        offset: typeof params.offset === "number" ? params.offset : 0,
        orderBy: params.orderBy as string | undefined,
        orderDir: params.orderDir as "asc" | "desc" | undefined,
      };

      const leads = store.getLeads(filters);
      // Get total count without limit
      const totalFilters = { ...filters, limit: undefined, offset: undefined };
      const allLeads = store.getLeads(totalFilters);

      respond(true, { leads, total: allLeads.length, count: leads.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "funnels.lead.score": async ({ params, respond }) => {
    try {
      const store = getFunnelStore();
      const id = (params.id as string) || (params.leadId as string);
      const score = params.score as number;

      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }
      if (typeof score !== "number" || score < 0 || score > 100) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "score must be a number between 0 and 100",
        });
        return;
      }

      const lead = store.updateLead(id, { score });
      if (!lead) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Lead not found" });
        return;
      }

      // Record activity
      store.addLeadActivity({
        leadId: id,
        type: "score_change",
        description: `Score updated to ${score}`,
        metadata: { newScore: score },
        performedBy: params.performedBy as string | undefined,
      });

      log.info("Scored lead", { leadId: id, score });
      respond(true, { lead });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "funnels.lead.qualify": async ({ params, respond }) => {
    try {
      const store = getFunnelStore();
      const id = (params.id as string) || (params.leadId as string);

      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }

      const lead = store.getLead(id);
      if (!lead) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Lead not found" });
        return;
      }

      // Calculate qualification based on data completeness and score
      const qualificationFactors = {
        hasEmail: !!lead.email,
        hasPhone: !!lead.phone,
        hasCompany: !!lead.company,
        hasEstimatedValue: !!lead.estimatedValue,
        scoreAbove50: (lead.score ?? 0) >= 50,
        scoreAbove75: (lead.score ?? 0) >= 75,
        hasBeenContacted: !!lead.firstContactAt,
        recentActivity:
          !!lead.lastActivityAt &&
          Date.now() - new Date(lead.lastActivityAt).getTime() < 7 * 24 * 60 * 60 * 1000,
      };

      const qualificationScore = Object.values(qualificationFactors).filter(Boolean).length;
      const isQualified = qualificationScore >= 5;

      // Update lead status if qualified
      if (isQualified && lead.status === "new") {
        store.updateLead(id, { status: "qualified" });
      }

      respond(true, {
        leadId: id,
        isQualified,
        qualificationScore,
        maxScore: Object.keys(qualificationFactors).length,
        factors: qualificationFactors,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "funnels.lead.matchOffer": async ({ params, respond }) => {
    try {
      const store = getFunnelStore();
      const id = (params.id as string) || (params.leadId as string);

      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }

      const lead = store.getLead(id);
      if (!lead) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Lead not found" });
        return;
      }

      // Find matching offers
      const allOffers = store.getOffers(lead.businessId);
      const matchingOffers = allOffers.filter((offer) => {
        if (offer.status !== "active") return false;
        if (offer.targetStages?.length && !offer.targetStages.includes(lead.stageId)) return false;
        if (offer.minScore !== undefined && (lead.score ?? 0) < offer.minScore) return false;
        if (offer.targetTags?.length && !offer.targetTags.some((t) => lead.tags?.includes(t)))
          return false;
        if (offer.validUntil && new Date(offer.validUntil) < new Date()) return false;
        return true;
      });

      respond(true, {
        leadId: id,
        matchingOffers,
        count: matchingOffers.length,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "funnels.lead.assignFunnel": async ({ params, respond }) => {
    try {
      const store = getFunnelStore();
      const id = (params.id as string) || (params.leadId as string);
      const funnelId = params.funnelId as string;
      const stageId = params.stageId as string;

      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }
      if (!funnelId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "funnelId is required" });
        return;
      }

      // Verify funnel exists
      const funnel = store.getFunnel(funnelId);
      if (!funnel) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Funnel not found" });
        return;
      }

      // If no stageId provided, use first stage
      let targetStageId = stageId;
      if (!targetStageId) {
        const stages = store.getStages(funnelId);
        const entryStage = stages.find((s) => s.type === "entry") || stages[0];
        if (!entryStage) {
          respond(false, undefined, { code: "NO_STAGES", message: "Funnel has no stages" });
          return;
        }
        targetStageId = entryStage.id;
      }

      const lead = store.updateLead(id, { funnelId, stageId: targetStageId });
      if (!lead) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Lead not found" });
        return;
      }

      log.info("Assigned lead to funnel", { leadId: id, funnelId, stageId: targetStageId });
      respond(true, { lead });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "funnels.lead.moveStage": async ({ params, respond }) => {
    try {
      const store = getFunnelStore();
      const id = (params.id as string) || (params.leadId as string);
      const stageId = (params.stageId as string) || (params.toStageId as string);
      const reason = params.reason as string | undefined;

      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }
      if (!stageId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "stageId is required" });
        return;
      }

      const lead = store.updateLead(id, { stageId });
      if (!lead) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Lead not found" });
        return;
      }

      // Record activity
      store.addLeadActivity({
        leadId: id,
        type: "stage_change",
        description: `Moved to stage: ${stageId}${reason ? ` (${reason})` : ""}`,
        metadata: { newStageId: stageId, reason },
        performedBy: params.performedBy as string | undefined,
      });

      log.info("Moved lead to stage", { leadId: id, stageId });
      respond(true, { lead });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // KPI HANDLERS
  // ═══════════════════════════════════════════════════════════════

  "funnels.kpi.log": async ({ params, respond }) => {
    try {
      const store = getFunnelStore();
      const businessId = params.businessId as string;
      const name = params.name as string;
      const value = params.value as number;

      if (!businessId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "businessId is required" });
        return;
      }
      if (!name) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "name is required" });
        return;
      }
      if (typeof value !== "number") {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "value must be a number" });
        return;
      }

      const now = new Date().toISOString();
      const metric = store.createMetric({
        businessId,
        funnelId: params.funnelId as string | undefined,
        stageId: params.stageId as string | undefined,
        name,
        type: (params.type as MetricType) ?? "count",
        currentValue: value,
        period: (params.period as MetricPeriod) ?? "all_time",
        calculatedAt: now,
      });

      log.info("Logged KPI metric", { metricId: metric.id, name, value });
      respond(true, { metric });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "funnels.kpi.get": async ({ params, respond }) => {
    try {
      const store = getFunnelStore();
      const businessId = params.businessId as string;
      const funnelId = params.funnelId as string | undefined;

      if (!businessId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "businessId is required" });
        return;
      }

      const metrics = store.getMetrics(businessId, funnelId);
      respond(true, { metrics, count: metrics.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "funnels.kpi.compare": async ({ params, respond }) => {
    try {
      const store = getFunnelStore();
      const businessId = params.businessId as string;
      const metricName = (params.metricName as string) || (params.name as string);

      if (!businessId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "businessId is required" });
        return;
      }
      if (!metricName) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "metricName is required" });
        return;
      }

      const metrics = store.getMetrics(businessId);
      const targetMetrics = metrics.filter((m) => m.name === metricName);

      if (targetMetrics.length === 0) {
        respond(false, undefined, {
          code: "NOT_FOUND",
          message: "No metrics found with that name",
        });
        return;
      }

      // Calculate comparison data
      const comparison = targetMetrics.map((m) => ({
        metricId: m.id,
        funnelId: m.funnelId,
        stageId: m.stageId,
        currentValue: m.currentValue,
        previousValue: m.previousValue,
        changePercent: m.changePercent,
        trend:
          m.changePercent && m.changePercent > 0
            ? "up"
            : m.changePercent && m.changePercent < 0
              ? "down"
              : "stable",
      }));

      respond(true, { metricName, comparison, count: comparison.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // TASK HANDLERS
  // ═══════════════════════════════════════════════════════════════

  "funnels.task.create": async ({ params, respond }) => {
    try {
      const store = getFunnelStore();
      const businessId = params.businessId as string;
      const title = params.title as string;

      if (!businessId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "businessId is required" });
        return;
      }
      if (!title) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "title is required" });
        return;
      }

      const task = store.createTask({
        businessId,
        title,
        description: params.description as string | undefined,
        type: (params.type as FunnelTaskType) ?? "follow_up",
        status: "pending",
        priority: (params.priority as FunnelTaskPriority) ?? "normal",
        funnelId: params.funnelId as string | undefined,
        leadId: params.leadId as string | undefined,
        stageId: params.stageId as string | undefined,
        assignedTo: params.assignedTo as string | undefined,
        dueAt: params.dueAt as string | undefined,
      });

      log.info("Created task", { taskId: task.id, title });
      respond(true, { task });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "funnels.task.update": async ({ params, respond }) => {
    try {
      const store = getFunnelStore();
      const id = (params.id as string) || (params.taskId as string);

      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }

      const updates: Partial<FunnelTask> = {};
      if (params.title !== undefined) updates.title = params.title as string;
      if (params.description !== undefined) updates.description = params.description as string;
      if (params.type !== undefined) updates.type = params.type as FunnelTaskType;
      if (params.status !== undefined) updates.status = params.status as FunnelTaskStatus;
      if (params.priority !== undefined) updates.priority = params.priority as FunnelTaskPriority;
      if (params.assignedTo !== undefined) updates.assignedTo = params.assignedTo as string;
      if (params.dueAt !== undefined) updates.dueAt = params.dueAt as string;

      const task = store.updateTask(id, updates);
      if (!task) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Task not found" });
        return;
      }

      log.info("Updated task", { taskId: id });
      respond(true, { task });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "funnels.task.complete": async ({ params, respond }) => {
    try {
      const store = getFunnelStore();
      const id = (params.id as string) || (params.taskId as string);

      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }

      const task = store.updateTask(id, {
        status: "completed",
        completedAt: new Date().toISOString(),
      });
      if (!task) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Task not found" });
        return;
      }

      log.info("Completed task", { taskId: id });
      respond(true, { task });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "funnels.task.getChecklist": async ({ params, respond }) => {
    try {
      const store = getFunnelStore();
      const filters: TaskFilters = {
        businessId: params.businessId as string | undefined,
        funnelId: params.funnelId as string | undefined,
        leadId: params.leadId as string | undefined,
        stageId: params.stageId as string | undefined,
        assignedTo: params.assignedTo as string | undefined,
        status: params.status as FunnelTaskStatus | FunnelTaskStatus[] | undefined,
        overdue: params.overdue as boolean | undefined,
        limit: typeof params.limit === "number" ? params.limit : 50,
        offset: typeof params.offset === "number" ? params.offset : 0,
      };

      const tasks = store.getTasks(filters);

      // Group by status
      const now = new Date();
      const grouped = {
        pending: tasks.filter((t) => t.status === "pending"),
        in_progress: tasks.filter((t) => t.status === "in_progress"),
        completed: tasks.filter((t) => t.status === "completed"),
        overdue: tasks.filter((t) => t.status === "pending" && t.dueAt && new Date(t.dueAt) < now),
      };

      respond(true, { tasks, grouped, count: tasks.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // OFFER HANDLERS
  // ═══════════════════════════════════════════════════════════════

  "funnels.offer.create": async ({ params, respond }) => {
    try {
      const store = getFunnelStore();
      const businessId = params.businessId as string;
      const name = params.name as string;
      const price = params.price as number;

      if (!businessId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "businessId is required" });
        return;
      }
      if (!name) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "name is required" });
        return;
      }
      if (typeof price !== "number") {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "price must be a number" });
        return;
      }

      const offer = store.createOffer({
        businessId,
        name,
        price,
        description: params.description as string | undefined,
        type: (params.type as OfferType) ?? "product",
        status: "draft",
        currency: (params.currency as string) ?? "USD",
        targetStages: params.targetStages as string[] | undefined,
        targetTags: params.targetTags as string[] | undefined,
        minScore: typeof params.minScore === "number" ? params.minScore : undefined,
        features: params.features as string[] | undefined,
      });

      log.info("Created offer", { offerId: offer.id, name });
      respond(true, { offer });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "funnels.offer.update": async ({ params, respond }) => {
    try {
      const store = getFunnelStore();
      const id = (params.id as string) || (params.offerId as string);

      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }

      const updates: Partial<Offer> = {};
      if (params.name !== undefined) updates.name = params.name as string;
      if (params.description !== undefined) updates.description = params.description as string;
      if (params.type !== undefined) updates.type = params.type as OfferType;
      if (params.status !== undefined) updates.status = params.status as any;
      if (typeof params.price === "number") updates.price = params.price;
      if (params.currency !== undefined) updates.currency = params.currency as string;
      if (typeof params.discountPercent === "number")
        updates.discountPercent = params.discountPercent;
      if (typeof params.discountAmount === "number") updates.discountAmount = params.discountAmount;
      if (params.validFrom !== undefined) updates.validFrom = params.validFrom as string;
      if (params.validUntil !== undefined) updates.validUntil = params.validUntil as string;
      if (params.targetStages !== undefined) updates.targetStages = params.targetStages as string[];
      if (params.targetTags !== undefined) updates.targetTags = params.targetTags as string[];
      if (typeof params.minScore === "number") updates.minScore = params.minScore;
      if (params.features !== undefined) updates.features = params.features as string[];

      const offer = store.updateOffer(id, updates);
      if (!offer) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Offer not found" });
        return;
      }

      log.info("Updated offer", { offerId: id });
      respond(true, { offer });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "funnels.offer.toggle": async ({ params, respond }) => {
    try {
      const store = getFunnelStore();
      const id = (params.id as string) || (params.offerId as string);

      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }

      const existing = store.getOffer(id);
      if (!existing) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Offer not found" });
        return;
      }

      const newStatus = existing.status === "active" ? "draft" : "active";
      const offer = store.updateOffer(id, { status: newStatus });

      log.info("Toggled offer status", { offerId: id, newStatus });
      respond(true, { offer });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "funnels.offer.list": async ({ params, respond }) => {
    try {
      const store = getFunnelStore();
      const businessId = params.businessId as string;

      if (!businessId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "businessId is required" });
        return;
      }

      let offers = store.getOffers(businessId);

      // Apply additional filters
      if (params.status) {
        const statuses = Array.isArray(params.status) ? params.status : [params.status];
        offers = offers.filter((o) => statuses.includes(o.status));
      }
      if (params.type) {
        const types = Array.isArray(params.type) ? params.type : [params.type];
        offers = offers.filter((o) => types.includes(o.type));
      }

      respond(true, { offers, count: offers.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "funnels.offer.checkEligibility": async ({ params, respond }) => {
    try {
      const store = getFunnelStore();
      const offerId = (params.offerId as string) || (params.id as string);
      const leadId = params.leadId as string;

      if (!offerId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "offerId is required" });
        return;
      }
      if (!leadId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "leadId is required" });
        return;
      }

      const offer = store.getOffer(offerId);
      if (!offer) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Offer not found" });
        return;
      }

      const lead = store.getLead(leadId);
      if (!lead) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Lead not found" });
        return;
      }

      // Check eligibility
      const eligibilityChecks = {
        offerActive: offer.status === "active",
        stageMatches: !offer.targetStages?.length || offer.targetStages.includes(lead.stageId),
        scoreMatches: offer.minScore === undefined || (lead.score ?? 0) >= offer.minScore,
        tagsMatch:
          !offer.targetTags?.length || offer.targetTags.some((t) => lead.tags?.includes(t)),
        notExpired: !offer.validUntil || new Date(offer.validUntil) >= new Date(),
        withinLimit:
          offer.maxRedemptions === undefined ||
          (offer.currentRedemptions ?? 0) < offer.maxRedemptions,
      };

      const isEligible = Object.values(eligibilityChecks).every(Boolean);

      respond(true, {
        offerId,
        leadId,
        isEligible,
        checks: eligibilityChecks,
        offer: isEligible ? offer : undefined,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // CANVAS HANDLERS (React Flow)
  // ═══════════════════════════════════════════════════════════════

  "funnels.canvas.getLayout": async ({ params, respond }) => {
    try {
      const store = getFunnelStore();
      const funnelId = (params.funnelId as string) || (params.id as string);

      if (!funnelId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "funnelId is required" });
        return;
      }

      const funnel = store.getFunnel(funnelId);
      if (!funnel) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Funnel not found" });
        return;
      }

      // Check for cached layout
      const cachedLayout = canvasLayouts.get(funnelId);
      if (cachedLayout) {
        respond(true, { ...cachedLayout, fromCache: true });
        return;
      }

      // Generate default layout from stages
      const stages = store.getStages(funnelId);
      const connections = store.getConnections(funnelId);

      const nodes = stages.map((stage, index) => ({
        id: stage.id,
        type: "stageNode",
        position: { x: 100 + index * 250, y: 100 },
        data: {
          label: stage.name,
          stageType: stage.type,
          color: stage.color,
          icon: stage.icon,
          leadCount: stage.leadCount ?? 0,
        },
      }));

      const edges = connections.map((conn) => ({
        id: conn.id,
        source: conn.sourceStageId,
        target: conn.targetStageId,
        type: "smoothstep",
        data: { label: conn.label },
      }));

      respond(true, { nodes, edges, fromCache: false });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "funnels.canvas.saveLayout": async ({ params, respond }) => {
    try {
      const funnelId = (params.funnelId as string) || (params.id as string);
      const nodes = params.nodes as any[];
      const edges = params.edges as any[];
      const viewport = params.viewport as { x: number; y: number; zoom: number } | undefined;

      if (!funnelId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "funnelId is required" });
        return;
      }
      if (!nodes || !Array.isArray(nodes)) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "nodes array is required" });
        return;
      }

      // Save to cache
      canvasLayouts.set(funnelId, {
        nodes,
        edges: edges || [],
        viewport,
        updatedAt: new Date().toISOString(),
      });

      log.info("Saved canvas layout", {
        funnelId,
        nodeCount: nodes.length,
        edgeCount: edges?.length ?? 0,
      });
      respond(true, { saved: true, funnelId });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // FLOW MAP HANDLERS (Visual Funnel Builder)
  // ═══════════════════════════════════════════════════════════════

  // ── SLICE C: Unified canvas model ────────────────────────────
  //
  // A funnel + its stages IS the flow map. These handlers read/write
  // the unified model. Legacy flow_maps are auto-migrated to funnels
  // on first access so operators don't lose any drafts they had saved.
  // Old saves that didn't have a funnelId become real funnels here.

  "funnels.flowmap.get": async ({ params, respond }) => {
    try {
      const store = getFunnelStore();
      const id = params.id as string | undefined;
      const businessId = params.businessId as string | undefined;
      const explicitFunnelId = params.funnelId as string | undefined;

      // Resolve to a funnel id, then project as a flow map.
      let funnelId: string | undefined;
      if (explicitFunnelId) {
        funnelId = explicitFunnelId;
      } else if (id?.startsWith("funnel:")) {
        funnelId = id.slice("funnel:".length);
      } else if (id) {
        // Legacy flow_map id — find its bound funnel or migrate it.
        const legacy = store.getFlowMap(id);
        if (legacy?.funnelId) funnelId = legacy.funnelId;
        else if (legacy) {
          // Lazy-migrate: persist this legacy flow map as a unified funnel.
          const { funnel } = store.saveFlowMapAsFunnel({
            name: legacy.name,
            businessId: legacy.businessId,
            nodes: legacy.nodes,
            connections: legacy.connections,
          });
          funnelId = funnel.id;
        }
      } else if (businessId) {
        const all = store.listFunnelsAsFlowMaps(businessId);
        funnelId = all[0]?.funnelId;
      }

      const flowMap = funnelId ? store.buildFlowMapFromFunnel(funnelId) : null;
      respond(true, { flowMap });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "funnels.flowmap.list": async ({ params, respond }) => {
    try {
      const store = getFunnelStore();
      const businessId = params.businessId as string | undefined;

      // Migrate any legacy flow_maps that don't yet have a funnel
      // binding. Once migrated they show up as funnel-backed projections
      // alongside everything else.
      const legacy = store.listFlowMaps(businessId);
      for (const lm of legacy) {
        if (!lm.funnelId) {
          store.saveFlowMapAsFunnel({
            name: lm.name,
            businessId: lm.businessId,
            nodes: lm.nodes,
            connections: lm.connections,
          });
        }
      }

      const flowMaps = store.listFunnelsAsFlowMaps(businessId);
      respond(true, { flowMaps });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "funnels.flowmap.save": async ({ params, respond }) => {
    try {
      const store = getFunnelStore();
      const { id, name, businessId, nodes, connections, funnelId, funnelType } = params as {
        id?: string;
        name: string;
        businessId: string;
        nodes: any[];
        connections: any[];
        funnelId?: string;
        funnelType?: "sales" | "marketing" | "onboarding" | "support" | "recruitment" | "custom";
      };

      if (!name) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "name is required" });
        return;
      }
      if (!businessId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "businessId is required" });
        return;
      }

      // Resolve incoming id to a funnelId hint when possible.
      const resolvedFunnelId =
        funnelId ?? (id?.startsWith("funnel:") ? id.slice("funnel:".length) : undefined);

      const { funnel } = store.saveFlowMapAsFunnel({
        flowMapId: id,
        funnelId: resolvedFunnelId,
        name,
        businessId,
        nodes: nodes || [],
        connections: connections || [],
        funnelType,
      });

      const flowMap = store.buildFlowMapFromFunnel(funnel.id);
      log.info("Saved flow map (unified)", {
        funnelId: funnel.id,
        nodeCount: nodes?.length ?? 0,
      });
      respond(true, { flowMap });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  /**
   * SLICE C: Promote is now a backward-compat wrapper.
   *
   * Under the unified model the canvas IS the funnel — every
   * funnels.flowmap.save creates/updates a funnel + stages. Existing
   * callers that still hit promote get the same result: the flow map's
   * funnel is materialized (or returned if it already exists) and a
   * canonical flowMap projection is returned. Legacy flow_map rows are
   * migrated transparently.
   */
  "funnels.flowmap.promote": async ({ params, respond }) => {
    try {
      const store = getFunnelStore();
      const p = params as {
        flowMapId: string;
        funnelName?: string;
        funnelType?: "sales" | "marketing" | "onboarding" | "support" | "recruitment" | "custom";
      };
      if (!p.flowMapId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "flowMapId required" });
        return;
      }

      // If the id is the new synthetic form, the funnel already exists.
      if (p.flowMapId.startsWith("funnel:")) {
        const funnelId = p.flowMapId.slice("funnel:".length);
        const funnel = store.getFunnel(funnelId);
        if (!funnel) {
          respond(false, undefined, { code: "NOT_FOUND", message: "funnel not found" });
          return;
        }
        if (p.funnelName && p.funnelName !== funnel.name) {
          store.updateFunnel(funnel.id, { name: p.funnelName });
        }
        respond(true, {
          flowMap: store.buildFlowMapFromFunnel(funnel.id),
          funnel: store.getFunnel(funnel.id),
        });
        return;
      }

      // Legacy flow_map id — migrate to the unified model.
      const legacy = store.getFlowMap(p.flowMapId);
      if (!legacy) {
        respond(false, undefined, { code: "NOT_FOUND", message: "flow map not found" });
        return;
      }
      if (legacy.nodes.length === 0) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "flow map has no nodes — add at least one step before going live",
        });
        return;
      }

      // Reuse an existing binding if there is one; otherwise this writes
      // a new funnel.
      const { funnel } = store.saveFlowMapAsFunnel({
        flowMapId: p.flowMapId,
        funnelId: legacy.funnelId,
        name: p.funnelName ?? legacy.name,
        businessId: legacy.businessId,
        nodes: legacy.nodes,
        connections: legacy.connections,
        funnelType: p.funnelType,
      });

      // Stamp the legacy flow_maps row with the funnel binding so a
      // future promote-by-legacy-id is idempotent (re-uses the funnel
      // instead of creating a new one).
      if (!legacy.funnelId) {
        store.updateFlowMap(legacy.id, { funnelId: funnel.id });
      }

      log.info("Promoted flow map (unified)", { flowMapId: p.flowMapId, funnelId: funnel.id });
      respond(true, {
        flowMap: store.buildFlowMapFromFunnel(funnel.id),
        funnel,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "funnels.flowmap.delete": async ({ params, respond }) => {
    try {
      const store = getFunnelStore();
      const id = params.id as string;

      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }

      // Unified: id of "funnel:<funnelId>" → delete the funnel (cascades
      // to stages + connections + leads via the FK). Otherwise drop the
      // legacy flow_map row.
      if (id.startsWith("funnel:")) {
        const funnelId = id.slice("funnel:".length);
        const deleted = store.deleteFunnel(funnelId);
        respond(true, { deleted });
        return;
      }
      const deleted = store.deleteFlowMap(id);
      respond(true, { deleted });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // INTEGRATION HANDLERS
  // ═══════════════════════════════════════════════════════════════

  "funnels.integrations.platforms": async ({ respond }) => {
    try {
      // Dynamic import to avoid circular deps
      const { platformRegistry, platformIORegistry } =
        await import("../../funnels/integrations/platforms.js");

      const platforms = Object.entries(platformRegistry).map(([id, platform]) => ({
        id,
        name: platform.name,
        icon: platform.icon,
        color: platform.color,
        description: platform.description,
        methods: platform.methods,
        preferredMethod: platform.preferredMethod,
        features: platform.features,
        kpis: platform.kpis,
        io: platformIORegistry[id] || { inputs: [], outputs: [] },
      }));

      respond(true, { platforms });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "funnels.integrations.platform": async ({ params, respond }) => {
    try {
      const platformId = params.platformId as string;
      if (!platformId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "platformId is required" });
        return;
      }

      const { getPlatformIntegration, getPlatformIO } =
        await import("../../funnels/integrations/platforms.js");

      const platform = getPlatformIntegration(platformId);
      const io = getPlatformIO(platformId);

      if (!platform) {
        respond(false, undefined, {
          code: "NOT_FOUND",
          message: `Platform ${platformId} not found`,
        });
        return;
      }

      respond(true, { platform: { ...platform, io } });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  // ── Public lead-capture page ──────────────────────────────

  /** Read the per-funnel page config (form fields, theme, headline, etc.). */
  "funnels.page.config.get": async ({ params, respond }) => {
    try {
      const id = (params.id as string) || (params.funnelId as string);
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "funnelId required" });
        return;
      }
      const { readPageConfig, defaultPageConfig, ensureFunnelWorkspace } =
        await import("../../funnels/workspace.js");
      const funnel = getFunnelStore().getFunnel(id);
      if (!funnel) {
        respond(false, undefined, { code: "NOT_FOUND", message: "funnel not found" });
        return;
      }
      // Bootstrap workspace + default config on first read so the UI
      // never sees an empty page editor.
      ensureFunnelWorkspace(funnel.id, funnel.name);
      const cfg = readPageConfig(funnel.id) ?? defaultPageConfig(funnel.name);
      respond(true, { config: cfg });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  /** Persist page config edits — fields, theme, headline, published flag. */
  "funnels.page.config.set": async ({ params, respond }) => {
    try {
      const id = (params.id as string) || (params.funnelId as string);
      const cfg = params.config as Record<string, unknown> | undefined;
      if (!id || !cfg) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "funnelId and config required",
        });
        return;
      }
      const { writePageConfig, ensureFunnelWorkspace, defaultPageConfig } =
        await import("../../funnels/workspace.js");
      const funnel = getFunnelStore().getFunnel(id);
      if (!funnel) {
        respond(false, undefined, { code: "NOT_FOUND", message: "funnel not found" });
        return;
      }
      ensureFunnelWorkspace(funnel.id, funnel.name);
      // Merge against defaults so partial saves don't lose un-set keys.
      const merged = {
        ...defaultPageConfig(funnel.name),
        ...cfg,
        updatedAt: Date.now(),
      } as Parameters<typeof writePageConfig>[1];
      writePageConfig(funnel.id, merged);
      respond(true, { config: merged });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  /** Toggle the public published flag (no-arg toggle, or pass `published: true|false`). */
  "funnels.page.publish": async ({ params, respond }) => {
    try {
      const id = (params.id as string) || (params.funnelId as string);
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "funnelId required" });
        return;
      }
      const { readPageConfig, writePageConfig, defaultPageConfig, ensureFunnelWorkspace } =
        await import("../../funnels/workspace.js");
      const funnel = getFunnelStore().getFunnel(id);
      if (!funnel) {
        respond(false, undefined, { code: "NOT_FOUND", message: "funnel not found" });
        return;
      }
      ensureFunnelWorkspace(funnel.id, funnel.name);
      const cfg = readPageConfig(funnel.id) ?? defaultPageConfig(funnel.name);
      cfg.published =
        typeof params.published === "boolean" ? (params.published as boolean) : !cfg.published;
      writePageConfig(funnel.id, cfg);

      // Mirror to /apps so a published landing-page-style entry appears.
      try {
        const { autoRegister } = await import("../../apps/store.js");
        const { resolveStateDir } = await import("../../config/paths.js");
        autoRegister(resolveStateDir(), {
          sourceKind: "landing-page",
          sourceId: `funnel-page-${funnel.id}`,
          name: `${funnel.name} — page`,
          description: cfg.headline,
          type: "landing-page",
          businessId: funnel.businessId ?? null,
          url: cfg.published ? `/p/funnels/${cfg.slug}` : null,
          meta: { funnelId: funnel.id, slug: cfg.slug, published: cfg.published },
        });
      } catch {
        /* swallow */
      }

      respond(true, { config: cfg });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  /** Render the page HTML — handy for the dashboard preview iframe. */
  "funnels.page.preview": async ({ params, respond }) => {
    try {
      const id = (params.id as string) || (params.funnelId as string);
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "funnelId required" });
        return;
      }
      const { readPageConfig, defaultPageConfig } = await import("../../funnels/workspace.js");
      const { renderPageHtml } = await import("../../funnels/page-render.js");
      const funnel = getFunnelStore().getFunnel(id);
      if (!funnel) {
        respond(false, undefined, { code: "NOT_FOUND", message: "funnel not found" });
        return;
      }
      const cfg = readPageConfig(funnel.id) ?? defaultPageConfig(funnel.name);
      respond(true, { html: renderPageHtml(cfg, funnel.id), config: cfg });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  /** Submission log — recent public form posts with leadId attribution. */
  "funnels.page.submissions": async ({ params, respond }) => {
    try {
      const id = (params.id as string) || (params.funnelId as string);
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "funnelId required" });
        return;
      }
      const { readSubmissions } = await import("../../funnels/workspace.js");
      const limit = typeof params.limit === "number" ? (params.limit as number) : 100;
      respond(true, { submissions: readSubmissions(id, limit) });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },
};
