/**
 * Funnel automation bridge — wires the FunnelStore's lead lifecycle
 * events into the AutomationEngine.
 *
 * Without this bridge the engine has no inputs and the qualification
 * rules created in the UI never fire. The store deliberately knows
 * nothing about automation (so unit tests stay cheap), so we glue the
 * two together at the gateway boot layer via getAutomationBridge().
 *
 * Idempotent — the bridge installs exactly one subscriber per store
 * instance. Calling getAutomationBridge() repeatedly is safe; resetting
 * the funnel store (tests) re-installs the subscriber.
 */

import { AutomationEngine } from "./engine.js";
import { createTriggerEvent, type TriggerEvent } from "./triggers.js";
import { getFunnelStore, type FunnelStore, type LeadStoreEvent } from "../store.js";
import type { FunnelTask, Lead, QualificationRule } from "../types.js";
import { logInfo, logWarn } from "../../logger.js";

const log = {
  info: (data: unknown, msg: string) =>
    logInfo(`[funnels.automation.bridge] ${msg} ${JSON.stringify(data)}`),
  warn: (data: unknown, msg: string) =>
    logWarn(`[funnels.automation.bridge] ${msg} ${JSON.stringify(data)}`),
};

interface BridgeState {
  engine: AutomationEngine;
  store: FunnelStore;
  unsubscribe: () => void;
  ruleCache: Map<string, QualificationRule[]>;
}

let state: BridgeState | null = null;

function buildEngine(store: FunnelStore): AutomationEngine {
  return new AutomationEngine({
    updateLead: async (leadId, updates) => {
      store.updateLead(leadId, updates as Partial<Lead>);
    },
    moveLead: async (leadId, stageId, reason) => {
      store.moveLead(leadId, stageId, reason);
    },
    createTask: async (task) => {
      return store.createTask(task as Omit<FunnelTask, "id" | "createdAt" | "updatedAt">);
    },
    sendNotification: async (opts) => {
      // No notification service is wired here yet — log so the UI can
      // surface it via execution logs.
      log.info({ opts }, "automation notification (no transport bound)");
    },
    callWebhook: async (url, method, headers, body) => {
      return fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    },
    logActivity: async (leadId, type, description) => {
      const allowed = new Set([
        "note",
        "email",
        "call",
        "meeting",
        "task",
        "stage_change",
        "score_change",
        "system",
      ]);
      store.addLeadActivity({
        leadId,
        type: (allowed.has(type) ? type : "system") as
          | "note"
          | "email"
          | "call"
          | "meeting"
          | "task"
          | "stage_change"
          | "score_change"
          | "system",
        description,
        metadata: { source: "automation" },
      });
    },
    loadRules: async (businessId, funnelId) => {
      return store.listRules(businessId, funnelId, true);
    },
    updateRuleStats: async (ruleId, updates) => {
      store.updateRule(ruleId, updates as Partial<QualificationRule>);
    },
  });
}

function leadEventToTrigger(event: LeadStoreEvent): TriggerEvent | null {
  const lead = event.lead;
  switch (event.kind) {
    case "lead_created":
      return createTriggerEvent("lead_created", lead.businessId, {
        funnelId: lead.funnelId,
        leadId: lead.id,
        lead,
        data: { source: lead.source },
      });
    case "lead_updated":
      return createTriggerEvent("lead_updated", lead.businessId, {
        funnelId: lead.funnelId,
        leadId: lead.id,
        lead,
        data: { changed: event.changed as readonly string[] },
      });
    case "stage_changed":
      return createTriggerEvent("stage_changed", lead.businessId, {
        funnelId: lead.funnelId,
        leadId: lead.id,
        lead,
        data: {
          fromStageId: event.fromStageId,
          toStageId: event.toStageId,
          reason: event.reason,
        },
      });
    case "score_changed":
      return createTriggerEvent("score_changed", lead.businessId, {
        funnelId: lead.funnelId,
        leadId: lead.id,
        lead,
        data: { oldScore: event.oldScore, newScore: event.newScore },
      });
    case "tag_added":
      return createTriggerEvent("tag_added", lead.businessId, {
        funnelId: lead.funnelId,
        leadId: lead.id,
        lead,
        data: { tag: event.tag },
      });
    case "tag_removed":
      return createTriggerEvent("tag_removed", lead.businessId, {
        funnelId: lead.funnelId,
        leadId: lead.id,
        lead,
        data: { tag: event.tag },
      });
    default:
      return null;
  }
}

async function ensureRulesLoaded(
  bridge: BridgeState,
  businessId: string,
  funnelId?: string,
): Promise<void> {
  const key = `${businessId}::${funnelId ?? "*"}`;
  if (bridge.ruleCache.has(key)) return;
  const rules = bridge.store.listRules(businessId, funnelId, true);
  bridge.ruleCache.set(key, rules);
  for (const rule of rules) bridge.engine.upsertRule(rule);
}

export function getAutomationBridge(): { engine: AutomationEngine } {
  if (state) return { engine: state.engine };
  const store = getFunnelStore();
  const engine = buildEngine(store);
  const ruleCache = new Map<string, QualificationRule[]>();

  const unsubscribe = store.onLeadEvent((event) => {
    const trigger = leadEventToTrigger(event);
    if (!trigger || !trigger.funnelId) return;
    // Lazy-load rules for this business/funnel. Synchronous from cache
    // after the first event; non-blocking otherwise.
    void ensureRulesLoaded(
      { engine, store, unsubscribe: () => {}, ruleCache },
      trigger.businessId,
      trigger.funnelId,
    )
      .then(() => engine.processEvent(trigger))
      .catch((err) => log.warn({ err: String(err) }, "automation processEvent failed"));
  });

  state = { engine, store, unsubscribe, ruleCache };
  return { engine };
}

export function resetAutomationBridge(): void {
  if (state) {
    try {
      state.unsubscribe();
    } catch {}
  }
  state = null;
}

export function reloadRulesForFunnel(businessId: string, funnelId?: string): void {
  if (!state) return;
  const key = `${businessId}::${funnelId ?? "*"}`;
  state.ruleCache.delete(key);
  const rules = state.store.listRules(businessId, funnelId, true);
  state.ruleCache.set(key, rules);
  for (const rule of rules) state.engine.upsertRule(rule);
}
