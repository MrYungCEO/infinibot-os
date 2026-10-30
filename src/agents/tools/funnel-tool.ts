/**
 * Funnel Agent Tool
 * Allows agents to manage funnels, leads, offers, and analyze business metrics
 */

import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, readNumberParam, readStringArrayParam } from "./common.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { callGatewayTool, type GatewayCallOptions } from "./gateway.js";

const log = createSubsystemLogger("funnel-tool");

// ============================================================
// Tool Schema
// ============================================================

const FUNNEL_ACTIONS = [
  // Business actions
  "create_business",
  "list_businesses",
  // Funnel actions
  "create_funnel",
  "list_funnels",
  "get_funnel",
  "update_funnel",
  "analyze_funnel",
  // Stage actions
  "add_stage",
  "update_stage",
  "connect_stages",
  // Lead actions
  "create_lead",
  "search_leads",
  "get_lead",
  "update_lead",
  "score_lead",
  "qualify_lead",
  "match_offer",
  "log_activity",
  // Offer actions
  "create_offer",
  "list_offers",
  "update_offer",
  // Task actions
  "create_task",
  "list_tasks",
  "complete_task",
  // Metrics actions
  "log_metric",
  "get_metrics",
  // Analysis actions
  "analyze_bottlenecks",
  "suggest_improvements",
  "generate_sop",
  // AI actions
  "classify_intent",
  "generate_questions",
  "generate_response",
] as const;

const FUNNEL_TYPES = ["sales", "marketing", "onboarding", "support", "recruitment", "custom"] as const;
const FUNNEL_STATUSES = ["draft", "active", "paused", "archived"] as const;
const STAGE_TYPES = ["entry", "standard", "decision", "exit", "parking"] as const;
const LEAD_SOURCES = ["website", "referral", "social", "email", "phone", "advertisement", "event", "import", "manual", "other"] as const;
const LEAD_STATUSES = ["new", "contacted", "qualified", "proposal", "negotiation", "won", "lost", "nurturing", "disqualified"] as const;
const LEAD_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
const LEAD_TEMPERATURES = ["cold", "warm", "hot"] as const;
const OFFER_TYPES = ["lead_magnet", "low_ticket", "mid_ticket", "high_ticket", "product", "service", "subscription", "bundle", "custom"] as const;
const TASK_TYPES = ["follow_up", "call", "email", "meeting", "proposal", "demo", "review", "custom"] as const;
const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
const RESPONSE_TYPES = ["initial", "follow_up", "offer", "qualification", "closing"] as const;

const FunnelToolSchema = Type.Object({
  action: stringEnum(FUNNEL_ACTIONS),
  
  // Business params
  businessId: Type.Optional(Type.String({ description: "Business ID" })),
  businessName: Type.Optional(Type.String({ description: "Business name" })),
  industry: Type.Optional(Type.String({ description: "Business industry" })),
  
  // Funnel params
  funnelId: Type.Optional(Type.String({ description: "Funnel ID" })),
  funnelName: Type.Optional(Type.String({ description: "Funnel name" })),
  funnelType: Type.Optional(stringEnum(FUNNEL_TYPES)),
  funnelStatus: Type.Optional(stringEnum(FUNNEL_STATUSES)),
  
  // Stage params
  stageId: Type.Optional(Type.String({ description: "Stage ID" })),
  stageName: Type.Optional(Type.String({ description: "Stage name" })),
  stageType: Type.Optional(stringEnum(STAGE_TYPES)),
  stagePosition: Type.Optional(Type.Number({ description: "Stage position in funnel" })),
  sourceStageId: Type.Optional(Type.String({ description: "Source stage for connections" })),
  targetStageId: Type.Optional(Type.String({ description: "Target stage for connections" })),
  connectionLabel: Type.Optional(Type.String({ description: "Label for stage connection" })),
  
  // Lead params
  leadId: Type.Optional(Type.String({ description: "Lead ID" })),
  leadName: Type.Optional(Type.String({ description: "Lead name" })),
  email: Type.Optional(Type.String({ description: "Email address" })),
  phone: Type.Optional(Type.String({ description: "Phone number" })),
  company: Type.Optional(Type.String({ description: "Company name" })),
  title: Type.Optional(Type.String({ description: "Job title" })),
  leadSource: Type.Optional(stringEnum(LEAD_SOURCES)),
  leadStatus: Type.Optional(stringEnum(LEAD_STATUSES)),
  leadPriority: Type.Optional(stringEnum(LEAD_PRIORITIES)),
  leadTemperature: Type.Optional(stringEnum(LEAD_TEMPERATURES)),
  estimatedValue: Type.Optional(Type.Number({ description: "Estimated deal value" })),
  assignedTo: Type.Optional(Type.String({ description: "Assigned user/agent ID" })),
  tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for the lead" })),
  
  // Offer params
  offerId: Type.Optional(Type.String({ description: "Offer ID" })),
  offerName: Type.Optional(Type.String({ description: "Offer name" })),
  offerType: Type.Optional(stringEnum(OFFER_TYPES)),
  price: Type.Optional(Type.Number({ description: "Offer price" })),
  currency: Type.Optional(Type.String({ description: "Currency code (USD, EUR, etc.)" })),
  targetStages: Type.Optional(Type.Array(Type.String(), { description: "Target stage IDs for offer" })),
  minScore: Type.Optional(Type.Number({ description: "Minimum lead score for offer" })),
  features: Type.Optional(Type.Array(Type.String(), { description: "Offer features list" })),
  
  // Task params
  taskId: Type.Optional(Type.String({ description: "Task ID" })),
  taskTitle: Type.Optional(Type.String({ description: "Task title" })),
  taskType: Type.Optional(stringEnum(TASK_TYPES)),
  taskPriority: Type.Optional(stringEnum(TASK_PRIORITIES)),
  dueAt: Type.Optional(Type.String({ description: "Due date (ISO 8601)" })),
  
  // Metric params
  metricName: Type.Optional(Type.String({ description: "Metric name" })),
  metricValue: Type.Optional(Type.Number({ description: "Metric value" })),
  
  // Activity params
  activityType: Type.Optional(Type.String({ description: "Activity type (note, email, call, meeting, task, etc.)" })),
  activityDescription: Type.Optional(Type.String({ description: "Activity description" })),
  
  // AI params
  responseType: Type.Optional(stringEnum(RESPONSE_TYPES)),
  messages: Type.Optional(Type.Array(Type.String(), { description: "Message history for intent classification" })),
  
  // Common params
  description: Type.Optional(Type.String({ description: "Description" })),
  search: Type.Optional(Type.String({ description: "Search query" })),
  limit: Type.Optional(Type.Number({ description: "Max results to return" })),
  offset: Type.Optional(Type.Number({ description: "Pagination offset" })),
  
  // Gateway connection (optional overrides)
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
});

// ============================================================
// Tool Implementation
// ============================================================

export function createFunnelTool(options?: {
  agentId?: string;
}): AnyAgentTool {
  const callingAgentId = options?.agentId || "Infini";
  
  return {
    label: "Funnel",
    name: "funnel",
    description: `Manage sales funnels, leads, offers, and business automation.

**Business Actions:**
- create_business, list_businesses: Manage business profiles

**Funnel Actions:**
- create_funnel, list_funnels, get_funnel: Manage funnels
- analyze_funnel: Get analytics and conversion rates
- generate_sop: Generate Standard Operating Procedure

**Stage Actions:**
- add_stage, update_stage: Manage funnel stages
- connect_stages: Define stage transitions

**Lead Actions:**
- create_lead, search_leads, get_lead, update_lead: Manage leads
- score_lead: Get lead score breakdown (engagement, fit, urgency)
- qualify_lead: Full qualification (score + intent + questions)
- match_offer: Find best offers for a lead

**Offer Actions:**
- create_offer, list_offers, update_offer: Manage offers
- Types: lead_magnet, low_ticket, mid_ticket, high_ticket

**Task Actions:**
- create_task, list_tasks, complete_task: Manage follow-up tasks

**Metric Actions:**
- log_metric, get_metrics: Track KPIs

**Analysis Actions:**
- analyze_bottlenecks: Find funnel problems
- suggest_improvements: Get AI-powered suggestions

**AI Actions:**
- classify_intent: Determine buyer/curious/freebie_seeker/spam
- generate_questions: Get qualification questions
- generate_response: Generate personalized messages

Stage types: entry, standard, decision, exit, parking
Lead temps: cold (<40 score), warm (40-70), hot (>70)`,
    parameters: FunnelToolSchema,
    execute: async (_toolCallId, args, _context) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      
      // Gateway connection options
      const gatewayOpts: GatewayCallOptions = {
        gatewayUrl: readStringParam(params, "gatewayUrl"),
        gatewayToken: readStringParam(params, "gatewayToken"),
        timeoutMs: readNumberParam(params, "timeoutMs"),
      };
      
      // Helper to call gateway
      async function callFunnel(method: string, methodParams?: Record<string, unknown>): Promise<any> {
        return callGatewayTool(method, gatewayOpts, methodParams);
      }

      try {
        switch (action) {
          // ── Business Actions ────────────────────────────────
          
          case "create_business": {
            const name = readStringParam(params, "businessName", { required: true });
            const result = await callFunnel("funnels.business.create", {
              name,
              description: readStringParam(params, "description"),
              industry: readStringParam(params, "industry"),
            });
            log.info("Created business", { name });
            return jsonResult({ status: "ok", ...result });
          }
          
          case "list_businesses": {
            const result = await callFunnel("funnels.business.list");
            return jsonResult({ status: "ok", ...result });
          }
          
          // ── Funnel Actions ──────────────────────────────────
          
          case "create_funnel": {
            const businessId = readStringParam(params, "businessId", { required: true });
            const name = readStringParam(params, "funnelName", { required: true });
            const result = await callFunnel("funnels.create", {
              businessId,
              name,
              description: readStringParam(params, "description"),
              type: readStringParam(params, "funnelType"),
            });
            log.info("Created funnel", { businessId, name });
            return jsonResult({ status: "ok", ...result });
          }
          
          case "list_funnels": {
            const result = await callFunnel("funnels.list", {
              businessId: readStringParam(params, "businessId"),
              type: readStringParam(params, "funnelType"),
              status: readStringParam(params, "funnelStatus"),
              search: readStringParam(params, "search"),
              limit: readNumberParam(params, "limit") || 50,
              offset: readNumberParam(params, "offset") || 0,
            });
            return jsonResult({ status: "ok", ...result });
          }
          
          case "get_funnel": {
            const funnelId = readStringParam(params, "funnelId", { required: true });
            const result = await callFunnel("funnels.get", { id: funnelId });
            return jsonResult({ status: "ok", ...result });
          }
          
          case "update_funnel": {
            const funnelId = readStringParam(params, "funnelId", { required: true });
            const result = await callFunnel("funnels.update", {
              id: funnelId,
              name: readStringParam(params, "funnelName"),
              description: readStringParam(params, "description"),
              type: readStringParam(params, "funnelType"),
              status: readStringParam(params, "funnelStatus"),
            });
            return jsonResult({ status: "ok", ...result });
          }
          
          case "analyze_funnel": {
            const funnelId = readStringParam(params, "funnelId", { required: true });
            const result = await callFunnel("funnels.analyze", { id: funnelId });
            return jsonResult({ status: "ok", ...result });
          }
          
          case "generate_sop": {
            const funnelId = readStringParam(params, "funnelId", { required: true });
            const result = await callFunnel("funnels.generateSOP", { id: funnelId });
            return jsonResult({ status: "ok", ...result });
          }
          
          // ── Stage Actions ───────────────────────────────────
          
          case "add_stage": {
            const funnelId = readStringParam(params, "funnelId", { required: true });
            const name = readStringParam(params, "stageName", { required: true });
            const result = await callFunnel("funnels.stage.create", {
              funnelId,
              name,
              type: readStringParam(params, "stageType"),
              position: readNumberParam(params, "stagePosition"),
              description: readStringParam(params, "description"),
            });
            log.info("Created stage", { funnelId, name });
            return jsonResult({ status: "ok", ...result });
          }
          
          case "update_stage": {
            const stageId = readStringParam(params, "stageId", { required: true });
            const result = await callFunnel("funnels.stage.update", {
              id: stageId,
              name: readStringParam(params, "stageName"),
              description: readStringParam(params, "description"),
              type: readStringParam(params, "stageType"),
              position: readNumberParam(params, "stagePosition"),
            });
            return jsonResult({ status: "ok", ...result });
          }
          
          case "connect_stages": {
            const funnelId = readStringParam(params, "funnelId", { required: true });
            const sourceStageId = readStringParam(params, "sourceStageId", { required: true });
            const targetStageId = readStringParam(params, "targetStageId", { required: true });
            const result = await callFunnel("funnels.stage.connect", {
              funnelId,
              sourceStageId,
              targetStageId,
              label: readStringParam(params, "connectionLabel"),
            });
            log.info("Connected stages", { funnelId, sourceStageId, targetStageId });
            return jsonResult({ status: "ok", ...result });
          }
          
          // ── Lead Actions ────────────────────────────────────
          
          case "create_lead": {
            const businessId = readStringParam(params, "businessId", { required: true });
            const funnelId = readStringParam(params, "funnelId", { required: true });
            const stageId = readStringParam(params, "stageId", { required: true });
            const name = readStringParam(params, "leadName", { required: true });
            
            const result = await callFunnel("funnels.lead.create", {
              businessId,
              funnelId,
              stageId,
              name,
              email: readStringParam(params, "email"),
              phone: readStringParam(params, "phone"),
              company: readStringParam(params, "company"),
              source: readStringParam(params, "leadSource"),
              estimatedValue: readNumberParam(params, "estimatedValue"),
              tags: readStringArrayParam(params, "tags"),
            });
            log.info("Created lead", { businessId, funnelId, name });
            return jsonResult({ status: "ok", ...result });
          }
          
          case "search_leads": {
            const result = await callFunnel("funnels.lead.search", {
              businessId: readStringParam(params, "businessId"),
              funnelId: readStringParam(params, "funnelId"),
              stageId: readStringParam(params, "stageId"),
              status: readStringParam(params, "leadStatus"),
              priority: readStringParam(params, "leadPriority"),
              source: readStringParam(params, "leadSource"),
              assignedTo: readStringParam(params, "assignedTo"),
              tags: readStringArrayParam(params, "tags"),
              minScore: readNumberParam(params, "minScore"),
              search: readStringParam(params, "search"),
              limit: readNumberParam(params, "limit") || 50,
              offset: readNumberParam(params, "offset") || 0,
            });
            return jsonResult({ status: "ok", ...result });
          }
          
          case "get_lead": {
            const leadId = readStringParam(params, "leadId", { required: true });
            const result = await callFunnel("funnels.lead.get", { id: leadId });
            return jsonResult({ status: "ok", ...result });
          }
          
          case "update_lead": {
            const leadId = readStringParam(params, "leadId", { required: true });
            const result = await callFunnel("funnels.lead.update", {
              id: leadId,
              name: readStringParam(params, "leadName"),
              email: readStringParam(params, "email"),
              phone: readStringParam(params, "phone"),
              company: readStringParam(params, "company"),
              title: readStringParam(params, "title"),
              status: readStringParam(params, "leadStatus"),
              priority: readStringParam(params, "leadPriority"),
              stageId: readStringParam(params, "stageId"),
              assignedTo: readStringParam(params, "assignedTo"),
              estimatedValue: readNumberParam(params, "estimatedValue"),
              tags: readStringArrayParam(params, "tags"),
            });
            return jsonResult({ status: "ok", ...result });
          }
          
          case "score_lead": {
            const leadId = readStringParam(params, "leadId", { required: true });
            const result = await callFunnel("funnels.lead.score", { id: leadId });
            return jsonResult({ status: "ok", ...result });
          }
          
          case "qualify_lead": {
            const leadId = readStringParam(params, "leadId", { required: true });
            const result = await callFunnel("funnels.lead.qualify", { id: leadId });
            return jsonResult({ status: "ok", ...result });
          }
          
          case "match_offer": {
            const leadId = readStringParam(params, "leadId", { required: true });
            const result = await callFunnel("funnels.lead.matchOffer", { id: leadId });
            return jsonResult({ status: "ok", ...result });
          }
          
          case "log_activity": {
            const leadId = readStringParam(params, "leadId", { required: true });
            const type = readStringParam(params, "activityType", { required: true });
            const description = readStringParam(params, "activityDescription", { required: true });
            const result = await callFunnel("funnels.lead.activity", {
              leadId,
              type,
              description,
              performedBy: callingAgentId,
            });
            return jsonResult({ status: "ok", ...result });
          }
          
          // ── Offer Actions ───────────────────────────────────
          
          case "create_offer": {
            const businessId = readStringParam(params, "businessId", { required: true });
            const name = readStringParam(params, "offerName", { required: true });
            const price = readNumberParam(params, "price", { required: true });
            
            const result = await callFunnel("funnels.offer.create", {
              businessId,
              name,
              description: readStringParam(params, "description"),
              type: readStringParam(params, "offerType"),
              price,
              currency: readStringParam(params, "currency"),
              targetStages: readStringArrayParam(params, "targetStages"),
              minScore: readNumberParam(params, "minScore"),
              features: readStringArrayParam(params, "features"),
            });
            log.info("Created offer", { businessId, name, price });
            return jsonResult({ status: "ok", ...result });
          }
          
          case "list_offers": {
            const result = await callFunnel("funnels.offer.list", {
              businessId: readStringParam(params, "businessId"),
            });
            return jsonResult({ status: "ok", ...result });
          }
          
          case "update_offer": {
            const offerId = readStringParam(params, "offerId", { required: true });
            const result = await callFunnel("funnels.offer.update", {
              id: offerId,
              name: readStringParam(params, "offerName"),
              description: readStringParam(params, "description"),
              price: readNumberParam(params, "price"),
              targetStages: readStringArrayParam(params, "targetStages"),
              minScore: readNumberParam(params, "minScore"),
            });
            return jsonResult({ status: "ok", ...result });
          }
          
          // ── Task Actions ────────────────────────────────────
          
          case "create_task": {
            const businessId = readStringParam(params, "businessId", { required: true });
            const title = readStringParam(params, "taskTitle", { required: true });
            
            const result = await callFunnel("funnels.task.create", {
              businessId,
              title,
              description: readStringParam(params, "description"),
              type: readStringParam(params, "taskType"),
              priority: readStringParam(params, "taskPriority"),
              funnelId: readStringParam(params, "funnelId"),
              leadId: readStringParam(params, "leadId"),
              stageId: readStringParam(params, "stageId"),
              assignedTo: readStringParam(params, "assignedTo"),
              dueAt: readStringParam(params, "dueAt"),
            });
            log.info("Created task", { businessId, title });
            return jsonResult({ status: "ok", ...result });
          }
          
          case "list_tasks": {
            const result = await callFunnel("funnels.task.list", {
              businessId: readStringParam(params, "businessId"),
              funnelId: readStringParam(params, "funnelId"),
              leadId: readStringParam(params, "leadId"),
              assignedTo: readStringParam(params, "assignedTo"),
              limit: readNumberParam(params, "limit") || 50,
              offset: readNumberParam(params, "offset") || 0,
            });
            return jsonResult({ status: "ok", ...result });
          }
          
          case "complete_task": {
            const taskId = readStringParam(params, "taskId", { required: true });
            const result = await callFunnel("funnels.task.complete", { id: taskId });
            log.info("Completed task", { taskId });
            return jsonResult({ status: "ok", ...result });
          }
          
          // ── Metric Actions ──────────────────────────────────
          
          case "log_metric": {
            const businessId = readStringParam(params, "businessId", { required: true });
            const name = readStringParam(params, "metricName", { required: true });
            const value = readNumberParam(params, "metricValue", { required: true });
            
            const result = await callFunnel("funnels.metric.log", {
              businessId,
              name,
              value,
              funnelId: readStringParam(params, "funnelId"),
              stageId: readStringParam(params, "stageId"),
            });
            return jsonResult({ status: "ok", ...result });
          }
          
          case "get_metrics": {
            const businessId = readStringParam(params, "businessId", { required: true });
            const result = await callFunnel("funnels.metric.get", {
              businessId,
              funnelId: readStringParam(params, "funnelId"),
            });
            return jsonResult({ status: "ok", ...result });
          }
          
          // ── Analysis Actions ────────────────────────────────
          
          case "analyze_bottlenecks": {
            const funnelId = readStringParam(params, "funnelId", { required: true });
            const analyzeResult = await callFunnel("funnels.analyze", { id: funnelId });
            return jsonResult({ 
              status: "ok", 
              bottlenecks: analyzeResult.bottlenecks,
              analytics: analyzeResult.analytics,
            });
          }
          
          case "suggest_improvements": {
            const funnelId = readStringParam(params, "funnelId", { required: true });
            const result = await callFunnel("funnels.ai.suggestImprovements", { funnelId });
            return jsonResult({ status: "ok", ...result });
          }
          
          // ── AI Actions ──────────────────────────────────────
          
          case "classify_intent": {
            const leadId = readStringParam(params, "leadId", { required: true });
            const result = await callFunnel("funnels.ai.classifyIntent", {
              leadId,
              messages: readStringArrayParam(params, "messages"),
            });
            return jsonResult({ status: "ok", ...result });
          }
          
          case "generate_questions": {
            const leadId = readStringParam(params, "leadId", { required: true });
            const result = await callFunnel("funnels.ai.generateQuestions", {
              leadId,
              stageId: readStringParam(params, "stageId"),
            });
            return jsonResult({ status: "ok", ...result });
          }
          
          case "generate_response": {
            const leadId = readStringParam(params, "leadId", { required: true });
            const responseType = readStringParam(params, "responseType", { required: true });
            const result = await callFunnel("funnels.ai.generateResponse", {
              leadId,
              responseType,
            });
            return jsonResult({ status: "ok", ...result });
          }
          
          default:
            return jsonResult({ status: "error", error: `Unknown action: ${action}` });
        }
      } catch (err: any) {
        log.error("Funnel tool error", { action, error: err.message });
        return jsonResult({ 
          status: "error", 
          error: err.message,
          action,
        });
      }
    },
  };
}

// Export the tool factory
export const funnelToolName = "funnel";
export const funnelToolDescription = "Manage sales funnels, leads, offers, and business automation with AI-powered lead scoring and qualification";
export const funnelToolParameters = FunnelToolSchema;
