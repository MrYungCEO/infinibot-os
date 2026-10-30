/**
 * Funnel System MCP Server — Full Tool Suite
 * Business automation, sales funnels, leads, offers, and KPI tracking
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { getFunnelStore } from "./store.js";
import type {
  FunnelType,
  FunnelStatus,
  StageType,
  LeadSource,
  LeadStatus,
  LeadPriority,
  FunnelTaskType,
  FunnelTaskStatus,
  FunnelTaskPriority,
  OfferType,
  OfferStatus,
  MetricPeriod,
  LeadFilters,
  FunnelFilters,
  TaskFilters,
  QualificationCondition,
  QualificationActionConfig,
} from "./types.js";

// ═══════════════════════════════════════════════════════════════════════════════
// MCP SERVER SETUP
// ═══════════════════════════════════════════════════════════════════════════════

const server = new Server(
  {
    name: "funnel-system",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ─────────────────────────────────────────────────────────────────────────
    // BUSINESS CRUD
    // ─────────────────────────────────────────────────────────────────────────
    {
      name: "create_business",
      description: "Create a new business entity",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Business name" },
          description: { type: "string", description: "Business description" },
          industry: { type: "string", description: "Industry sector" },
          website: { type: "string", description: "Business website URL" },
          email: { type: "string", description: "Contact email" },
          phone: { type: "string", description: "Contact phone" },
          address: { type: "string", description: "Business address" },
          timezone: { type: "string", description: "Timezone (e.g., America/New_York)" },
          currency: { type: "string", description: "Currency code (e.g., USD)" },
          ownerId: { type: "string", description: "Owner user ID" },
        },
        required: ["name"],
      },
    },
    {
      name: "get_business",
      description: "Get a business by ID",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Business ID" },
        },
        required: ["id"],
      },
    },
    {
      name: "list_businesses",
      description: "List all businesses",
      inputSchema: {
        type: "object",
        properties: {
          ownerId: { type: "string", description: "Filter by owner ID" },
        },
      },
    },
    {
      name: "update_business",
      description: "Update a business",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Business ID" },
          name: { type: "string" },
          description: { type: "string" },
          industry: { type: "string" },
          website: { type: "string" },
          email: { type: "string" },
          phone: { type: "string" },
          address: { type: "string" },
          timezone: { type: "string" },
          currency: { type: "string" },
        },
        required: ["id"],
      },
    },
    {
      name: "delete_business",
      description: "Delete a business",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Business ID" },
        },
        required: ["id"],
      },
    },

    // ─────────────────────────────────────────────────────────────────────────
    // FUNNEL CRUD + ANALYTICS
    // ─────────────────────────────────────────────────────────────────────────
    {
      name: "create_funnel",
      description: "Create a new funnel",
      inputSchema: {
        type: "object",
        properties: {
          businessId: { type: "string", description: "Business ID this funnel belongs to" },
          name: { type: "string", description: "Funnel name" },
          description: { type: "string", description: "Funnel description" },
          type: {
            type: "string",
            enum: ["sales", "marketing", "onboarding", "support", "recruitment", "custom"],
            description: "Funnel type",
          },
          status: { type: "string", enum: ["draft", "active", "paused", "archived"], default: "draft" },
          color: { type: "string", description: "Color for visual display" },
          icon: { type: "string", description: "Icon identifier" },
          automationEnabled: { type: "boolean", description: "Enable automation rules" },
          webhookUrl: { type: "string", description: "Webhook URL for events" },
        },
        required: ["businessId", "name", "type"],
      },
    },
    {
      name: "get_funnel",
      description: "Get a funnel by ID with full details",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Funnel ID" },
        },
        required: ["id"],
      },
    },
    {
      name: "list_funnels",
      description: "List funnels with optional filters",
      inputSchema: {
        type: "object",
        properties: {
          businessId: { type: "string", description: "Filter by business ID" },
          type: {
            type: "string",
            enum: ["sales", "marketing", "onboarding", "support", "recruitment", "custom"],
          },
          status: {
            type: "string",
            enum: ["draft", "active", "paused", "archived"],
          },
          search: { type: "string", description: "Search term" },
          limit: { type: "number" },
          offset: { type: "number" },
        },
      },
    },
    {
      name: "update_funnel",
      description: "Update a funnel",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Funnel ID" },
          name: { type: "string" },
          description: { type: "string" },
          status: { type: "string", enum: ["draft", "active", "paused", "archived"] },
          color: { type: "string" },
          icon: { type: "string" },
          automationEnabled: { type: "boolean" },
          webhookUrl: { type: "string" },
        },
        required: ["id"],
      },
    },
    {
      name: "delete_funnel",
      description: "Delete a funnel",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Funnel ID" },
        },
        required: ["id"],
      },
    },
    {
      name: "duplicate_funnel",
      description: "Duplicate an existing funnel with all stages",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Source funnel ID" },
          newName: { type: "string", description: "Name for the duplicated funnel" },
          targetBusinessId: { type: "string", description: "Target business (optional, defaults to same)" },
        },
        required: ["id"],
      },
    },
    {
      name: "get_funnel_analytics",
      description: "Get comprehensive analytics for a funnel",
      inputSchema: {
        type: "object",
        properties: {
          funnelId: { type: "string", description: "Funnel ID" },
          startDate: { type: "string", description: "Period start (ISO date)" },
          endDate: { type: "string", description: "Period end (ISO date)" },
        },
        required: ["funnelId"],
      },
    },

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE MANAGEMENT
    // ─────────────────────────────────────────────────────────────────────────
    {
      name: "add_stage",
      description: "Add a new stage to a funnel",
      inputSchema: {
        type: "object",
        properties: {
          funnelId: { type: "string", description: "Funnel ID" },
          name: { type: "string", description: "Stage name" },
          description: { type: "string", description: "Stage description" },
          type: {
            type: "string",
            enum: ["entry", "standard", "decision", "exit", "parking"],
            description: "Stage type",
          },
          position: { type: "number", description: "Position in funnel (auto-assigned if omitted)" },
          color: { type: "string", description: "Color for visual display" },
          icon: { type: "string", description: "Icon identifier" },
          autoMoveAfterDays: { type: "number", description: "Auto-advance after N days" },
          maxDaysAllowed: { type: "number", description: "Alert threshold for leads staying too long" },
        },
        required: ["funnelId", "name", "type"],
      },
    },
    {
      name: "get_stage",
      description: "Get a stage by ID",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Stage ID" },
        },
        required: ["id"],
      },
    },
    {
      name: "list_stages",
      description: "List all stages in a funnel",
      inputSchema: {
        type: "object",
        properties: {
          funnelId: { type: "string", description: "Funnel ID" },
        },
        required: ["funnelId"],
      },
    },
    {
      name: "update_stage",
      description: "Update an existing stage",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Stage ID" },
          name: { type: "string" },
          description: { type: "string" },
          type: { type: "string", enum: ["entry", "standard", "decision", "exit", "parking"] },
          color: { type: "string" },
          icon: { type: "string" },
          autoMoveAfterDays: { type: "number" },
          maxDaysAllowed: { type: "number" },
        },
        required: ["id"],
      },
    },
    {
      name: "delete_stage",
      description: "Delete a stage",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Stage ID to delete" },
        },
        required: ["id"],
      },
    },
    {
      name: "reorder_stages",
      description: "Reorder stages in a funnel",
      inputSchema: {
        type: "object",
        properties: {
          funnelId: { type: "string", description: "Funnel ID" },
          stageOrder: {
            type: "array",
            items: { type: "string" },
            description: "Array of stage IDs in desired order",
          },
        },
        required: ["funnelId", "stageOrder"],
      },
    },
    {
      name: "connect_stages",
      description: "Create a connection between two stages",
      inputSchema: {
        type: "object",
        properties: {
          funnelId: { type: "string", description: "Funnel ID" },
          sourceStageId: { type: "string", description: "Source stage ID" },
          targetStageId: { type: "string", description: "Target stage ID" },
          label: { type: "string", description: "Connection label" },
          conditionType: {
            type: "string",
            enum: ["manual", "auto", "rule"],
            description: "Condition type for movement",
          },
          conditionConfig: { type: "object", description: "Condition configuration" },
        },
        required: ["funnelId", "sourceStageId", "targetStageId"],
      },
    },
    {
      name: "get_stage_kpis",
      description: "Get KPIs for a specific stage",
      inputSchema: {
        type: "object",
        properties: {
          stageId: { type: "string", description: "Stage ID" },
        },
        required: ["stageId"],
      },
    },

    // ─────────────────────────────────────────────────────────────────────────
    // LEAD MANAGEMENT
    // ─────────────────────────────────────────────────────────────────────────
    {
      name: "create_lead",
      description: "Create a new lead",
      inputSchema: {
        type: "object",
        properties: {
          businessId: { type: "string", description: "Business ID" },
          funnelId: { type: "string", description: "Funnel ID" },
          stageId: { type: "string", description: "Initial stage ID" },
          name: { type: "string", description: "Lead name" },
          email: { type: "string", description: "Email address" },
          phone: { type: "string", description: "Phone number" },
          company: { type: "string", description: "Company name" },
          title: { type: "string", description: "Job title" },
          source: {
            type: "string",
            enum: ["website", "referral", "social", "email", "phone", "advertisement", "event", "import", "manual", "other"],
          },
          status: { type: "string", enum: ["new", "contacted", "qualified", "proposal", "negotiation", "won", "lost", "nurturing", "disqualified"] },
          priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
          estimatedValue: { type: "number", description: "Estimated deal value" },
          currency: { type: "string", description: "Currency code" },
          assignedTo: { type: "string", description: "User/agent ID" },
          tags: { type: "array", items: { type: "string" } },
          customFields: { type: "object", description: "Custom field values" },
        },
        required: ["businessId", "funnelId", "stageId", "name"],
      },
    },
    {
      name: "get_lead",
      description: "Get a lead by ID with full details",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Lead ID" },
          includeActivities: { type: "boolean", description: "Include activity history" },
          includeStageHistory: { type: "boolean", description: "Include stage history" },
        },
        required: ["id"],
      },
    },
    {
      name: "update_lead",
      description: "Update a lead",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Lead ID" },
          name: { type: "string" },
          email: { type: "string" },
          phone: { type: "string" },
          company: { type: "string" },
          title: { type: "string" },
          status: { type: "string", enum: ["new", "contacted", "qualified", "proposal", "negotiation", "won", "lost", "nurturing", "disqualified"] },
          priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
          estimatedValue: { type: "number" },
          assignedTo: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          customFields: { type: "object" },
          expectedCloseDate: { type: "string" },
        },
        required: ["id"],
      },
    },
    {
      name: "search_leads",
      description: "Search leads with filters",
      inputSchema: {
        type: "object",
        properties: {
          businessId: { type: "string" },
          funnelId: { type: "string" },
          stageId: { type: "string" },
          status: { type: "string", enum: ["new", "contacted", "qualified", "proposal", "negotiation", "won", "lost", "nurturing", "disqualified"] },
          priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
          source: { type: "string" },
          assignedTo: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          minScore: { type: "number" },
          maxScore: { type: "number" },
          search: { type: "string", description: "Search name, email, company" },
          createdAfter: { type: "string" },
          createdBefore: { type: "string" },
          limit: { type: "number" },
          offset: { type: "number" },
          orderBy: { type: "string" },
          orderDir: { type: "string", enum: ["asc", "desc"] },
        },
      },
    },
    {
      name: "delete_lead",
      description: "Delete a lead",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Lead ID" },
        },
        required: ["id"],
      },
    },
    {
      name: "score_lead",
      description: "Set or update lead score",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Lead ID" },
          score: { type: "number", description: "Score (0-100)" },
          reason: { type: "string", description: "Reason for score change" },
        },
        required: ["id", "score"],
      },
    },
    {
      name: "qualify_lead",
      description: "Qualify or disqualify a lead",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Lead ID" },
          qualified: { type: "boolean", description: "Whether lead is qualified" },
          reason: { type: "string", description: "Qualification reason" },
        },
        required: ["id", "qualified"],
      },
    },
    {
      name: "match_offer",
      description: "Find matching offers for a lead",
      inputSchema: {
        type: "object",
        properties: {
          leadId: { type: "string", description: "Lead ID" },
        },
        required: ["leadId"],
      },
    },
    {
      name: "assign_to_funnel",
      description: "Assign a lead to a funnel",
      inputSchema: {
        type: "object",
        properties: {
          leadId: { type: "string", description: "Lead ID" },
          funnelId: { type: "string", description: "Target funnel ID" },
          stageId: { type: "string", description: "Target stage ID" },
        },
        required: ["leadId", "funnelId", "stageId"],
      },
    },
    {
      name: "move_to_stage",
      description: "Move a lead to a different stage",
      inputSchema: {
        type: "object",
        properties: {
          leadId: { type: "string", description: "Lead ID" },
          stageId: { type: "string", description: "Target stage ID" },
          reason: { type: "string", description: "Reason for move" },
          performedBy: { type: "string", description: "User/agent who performed the move" },
        },
        required: ["leadId", "stageId"],
      },
    },
    {
      name: "add_lead_activity",
      description: "Add an activity to a lead's history",
      inputSchema: {
        type: "object",
        properties: {
          leadId: { type: "string", description: "Lead ID" },
          type: { type: "string", enum: ["note", "email", "call", "meeting", "task", "stage_change", "score_change", "system"] },
          description: { type: "string", description: "Activity description" },
          metadata: { type: "object", description: "Additional metadata" },
          performedBy: { type: "string", description: "User/agent who performed the activity" },
        },
        required: ["leadId", "type", "description"],
      },
    },
    {
      name: "get_lead_activities",
      description: "Get activity history for a lead",
      inputSchema: {
        type: "object",
        properties: {
          leadId: { type: "string", description: "Lead ID" },
          limit: { type: "number", description: "Maximum number of activities" },
        },
        required: ["leadId"],
      },
    },
    {
      name: "get_lead_stage_history",
      description: "Get stage transition history for a lead",
      inputSchema: {
        type: "object",
        properties: {
          leadId: { type: "string", description: "Lead ID" },
        },
        required: ["leadId"],
      },
    },

    // ─────────────────────────────────────────────────────────────────────────
    // KPI TRACKING
    // ─────────────────────────────────────────────────────────────────────────
    {
      name: "log_metric",
      description: "Log a metric value",
      inputSchema: {
        type: "object",
        properties: {
          businessId: { type: "string", description: "Business ID" },
          funnelId: { type: "string", description: "Funnel ID (optional)" },
          stageId: { type: "string", description: "Stage ID (optional)" },
          name: { type: "string", description: "Metric name" },
          description: { type: "string", description: "Metric description" },
          type: { type: "string", enum: ["count", "sum", "average", "percentage", "ratio", "duration", "currency"] },
          currentValue: { type: "number", description: "Current value" },
          targetValue: { type: "number", description: "Target value" },
          period: { type: "string", enum: ["daily", "weekly", "monthly", "quarterly", "yearly", "all_time"] },
          unit: { type: "string", description: "Unit of measurement" },
        },
        required: ["businessId", "name", "type", "currentValue", "period"],
      },
    },
    {
      name: "get_metrics",
      description: "Get metrics for a business/funnel",
      inputSchema: {
        type: "object",
        properties: {
          businessId: { type: "string", description: "Business ID" },
          funnelId: { type: "string", description: "Funnel ID (optional)" },
        },
        required: ["businessId"],
      },
    },
    {
      name: "compare_periods",
      description: "Compare metrics between two periods",
      inputSchema: {
        type: "object",
        properties: {
          funnelId: { type: "string", description: "Funnel ID" },
          period1Start: { type: "string", description: "First period start" },
          period1End: { type: "string", description: "First period end" },
          period2Start: { type: "string", description: "Second period start" },
          period2End: { type: "string", description: "Second period end" },
        },
        required: ["funnelId", "period1Start", "period1End", "period2Start", "period2End"],
      },
    },
    {
      name: "add_metric_snapshot",
      description: "Add a point-in-time snapshot for a metric",
      inputSchema: {
        type: "object",
        properties: {
          metricId: { type: "string", description: "Metric ID" },
          value: { type: "number", description: "Snapshot value" },
          period: { type: "string", enum: ["daily", "weekly", "monthly", "quarterly", "yearly", "all_time"] },
          periodStart: { type: "string", description: "Period start date" },
          periodEnd: { type: "string", description: "Period end date" },
          metadata: { type: "object", description: "Additional metadata" },
        },
        required: ["metricId", "value", "period", "periodStart", "periodEnd"],
      },
    },

    // ─────────────────────────────────────────────────────────────────────────
    // TASK/SOP MANAGEMENT
    // ─────────────────────────────────────────────────────────────────────────
    {
      name: "create_task",
      description: "Create a funnel task",
      inputSchema: {
        type: "object",
        properties: {
          businessId: { type: "string", description: "Business ID" },
          funnelId: { type: "string", description: "Funnel ID (optional)" },
          leadId: { type: "string", description: "Lead ID (optional)" },
          stageId: { type: "string", description: "Stage ID (optional)" },
          title: { type: "string", description: "Task title" },
          description: { type: "string", description: "Task description" },
          type: { type: "string", enum: ["follow_up", "call", "email", "meeting", "proposal", "demo", "review", "custom"] },
          status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled", "overdue"], default: "pending" },
          priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
          assignedTo: { type: "string", description: "Assignee user/agent ID" },
          createdBy: { type: "string", description: "Creator user/agent ID" },
          dueAt: { type: "string", description: "Due date (ISO)" },
          reminderAt: { type: "string", description: "Reminder date (ISO)" },
        },
        required: ["businessId", "title", "type"],
      },
    },
    {
      name: "get_task",
      description: "Get a task by ID",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Task ID" },
        },
        required: ["id"],
      },
    },
    {
      name: "update_task",
      description: "Update a task",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Task ID" },
          title: { type: "string" },
          description: { type: "string" },
          status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled", "overdue"] },
          priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
          assignedTo: { type: "string" },
          dueAt: { type: "string" },
          reminderAt: { type: "string" },
        },
        required: ["id"],
      },
    },
    {
      name: "complete_task",
      description: "Mark a task as completed",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Task ID" },
          completedBy: { type: "string", description: "User/agent who completed" },
        },
        required: ["id"],
      },
    },
    {
      name: "list_tasks",
      description: "List tasks with filters",
      inputSchema: {
        type: "object",
        properties: {
          businessId: { type: "string" },
          funnelId: { type: "string" },
          leadId: { type: "string" },
          stageId: { type: "string" },
          assignedTo: { type: "string" },
          status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled", "overdue"] },
          type: { type: "string", enum: ["follow_up", "call", "email", "meeting", "proposal", "demo", "review", "custom"] },
          dueBefore: { type: "string" },
          dueAfter: { type: "string" },
          overdue: { type: "boolean" },
          limit: { type: "number" },
          offset: { type: "number" },
        },
      },
    },
    {
      name: "delete_task",
      description: "Delete a task",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Task ID" },
        },
        required: ["id"],
      },
    },
    {
      name: "get_stage_checklist",
      description: "Get checklist/SOP items for a stage based on tasks",
      inputSchema: {
        type: "object",
        properties: {
          stageId: { type: "string", description: "Stage ID" },
        },
        required: ["stageId"],
      },
    },
    {
      name: "generate_sop",
      description: "Generate standard operating procedure for a funnel",
      inputSchema: {
        type: "object",
        properties: {
          funnelId: { type: "string", description: "Funnel ID" },
          format: { type: "string", enum: ["markdown", "json", "html"], description: "Output format" },
        },
        required: ["funnelId"],
      },
    },

    // ─────────────────────────────────────────────────────────────────────────
    // OFFER MANAGEMENT
    // ─────────────────────────────────────────────────────────────────────────
    {
      name: "create_offer",
      description: "Create a new offer",
      inputSchema: {
        type: "object",
        properties: {
          businessId: { type: "string", description: "Business ID" },
          name: { type: "string", description: "Offer name" },
          description: { type: "string", description: "Offer description" },
          type: { type: "string", enum: ["product", "service", "subscription", "bundle", "custom"] },
          status: { type: "string", enum: ["draft", "active", "expired", "archived"], default: "draft" },
          price: { type: "number", description: "Price" },
          currency: { type: "string", description: "Currency code" },
          discountPercent: { type: "number", description: "Discount percentage" },
          discountAmount: { type: "number", description: "Discount fixed amount" },
          validFrom: { type: "string", description: "Valid from date (ISO)" },
          validUntil: { type: "string", description: "Valid until date (ISO)" },
          maxRedemptions: { type: "number", description: "Maximum redemptions allowed" },
          targetStages: { type: "array", items: { type: "string" }, description: "Stage IDs where offer is presented" },
          targetTags: { type: "array", items: { type: "string" }, description: "Lead tags to target" },
          minScore: { type: "number", description: "Minimum lead score required" },
          features: { type: "array", items: { type: "string" }, description: "Feature list" },
          terms: { type: "string", description: "Terms and conditions" },
        },
        required: ["businessId", "name", "type", "price", "currency"],
      },
    },
    {
      name: "get_offer",
      description: "Get an offer by ID",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Offer ID" },
        },
        required: ["id"],
      },
    },
    {
      name: "update_offer",
      description: "Update an offer",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Offer ID" },
          name: { type: "string" },
          description: { type: "string" },
          status: { type: "string", enum: ["draft", "active", "expired", "archived"] },
          price: { type: "number" },
          discountPercent: { type: "number" },
          discountAmount: { type: "number" },
          validFrom: { type: "string" },
          validUntil: { type: "string" },
          maxRedemptions: { type: "number" },
          targetStages: { type: "array", items: { type: "string" } },
          targetTags: { type: "array", items: { type: "string" } },
          minScore: { type: "number" },
          features: { type: "array", items: { type: "string" } },
          terms: { type: "string" },
        },
        required: ["id"],
      },
    },
    {
      name: "delete_offer",
      description: "Delete an offer",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Offer ID" },
        },
        required: ["id"],
      },
    },
    {
      name: "toggle_offer_active",
      description: "Activate or deactivate an offer",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Offer ID" },
          active: { type: "boolean", description: "Whether offer should be active" },
        },
        required: ["id", "active"],
      },
    },
    {
      name: "get_active_offers",
      description: "Get all active offers for a business",
      inputSchema: {
        type: "object",
        properties: {
          businessId: { type: "string", description: "Business ID" },
        },
        required: ["businessId"],
      },
    },
    {
      name: "check_eligibility",
      description: "Check if a lead is eligible for an offer",
      inputSchema: {
        type: "object",
        properties: {
          offerId: { type: "string", description: "Offer ID" },
          leadId: { type: "string", description: "Lead ID" },
        },
        required: ["offerId", "leadId"],
      },
    },

    // ─────────────────────────────────────────────────────────────────────────
    // AUTOMATION RULES
    // ─────────────────────────────────────────────────────────────────────────
    {
      name: "create_rule",
      description: "Create an automation rule",
      inputSchema: {
        type: "object",
        properties: {
          businessId: { type: "string", description: "Business ID" },
          funnelId: { type: "string", description: "Funnel ID (optional)" },
          stageId: { type: "string", description: "Stage ID (optional)" },
          name: { type: "string", description: "Rule name" },
          description: { type: "string", description: "Rule description" },
          enabled: { type: "boolean", description: "Whether rule is enabled", default: true },
          priority: { type: "number", description: "Priority (lower = higher priority)" },
          triggerOn: {
            type: "string",
            enum: ["lead_created", "lead_updated", "stage_changed", "field_changed", "manual"],
          },
          triggerField: { type: "string", description: "Field name for field_changed trigger" },
          conditions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                field: { type: "string" },
                operator: { type: "string", enum: ["equals", "not_equals", "contains", "not_contains", "greater_than", "less_than", "is_set", "is_not_set", "in_list", "not_in_list"] },
                value: {},
              },
            },
          },
          actions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["add_score", "subtract_score", "set_score", "move_stage", "add_tag", "remove_tag", "assign_to", "create_task", "send_notification", "webhook"] },
                config: { type: "object" },
              },
            },
          },
        },
        required: ["businessId", "name", "triggerOn", "conditions", "actions"],
      },
    },
    {
      name: "get_rule",
      description: "Get an automation rule by ID",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Rule ID" },
        },
        required: ["id"],
      },
    },
    {
      name: "list_rules",
      description: "List automation rules",
      inputSchema: {
        type: "object",
        properties: {
          businessId: { type: "string", description: "Business ID" },
          funnelId: { type: "string" },
          enabled: { type: "boolean" },
        },
        required: ["businessId"],
      },
    },
    {
      name: "update_rule",
      description: "Update an automation rule",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Rule ID" },
          name: { type: "string" },
          description: { type: "string" },
          enabled: { type: "boolean" },
          priority: { type: "number" },
          triggerOn: { type: "string" },
          conditions: { type: "array" },
          actions: { type: "array" },
        },
        required: ["id"],
      },
    },
    {
      name: "delete_rule",
      description: "Delete an automation rule",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Rule ID" },
        },
        required: ["id"],
      },
    },
    {
      name: "toggle_rule",
      description: "Enable or disable a rule",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Rule ID" },
          enabled: { type: "boolean" },
        },
        required: ["id", "enabled"],
      },
    },

    // ─────────────────────────────────────────────────────────────────────────
    // CONVERSATIONS
    // ─────────────────────────────────────────────────────────────────────────
    {
      name: "create_conversation",
      description: "Create a conversation for a lead",
      inputSchema: {
        type: "object",
        properties: {
          businessId: { type: "string", description: "Business ID" },
          leadId: { type: "string", description: "Lead ID" },
          channel: { type: "string", enum: ["email", "phone", "sms", "whatsapp", "telegram", "discord", "website_chat", "in_person", "other"] },
          subject: { type: "string", description: "Conversation subject" },
          externalId: { type: "string", description: "External reference ID" },
          assignedTo: { type: "string", description: "Assigned user/agent ID" },
        },
        required: ["businessId", "leadId", "channel"],
      },
    },
    {
      name: "get_conversation",
      description: "Get a conversation by ID",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Conversation ID" },
        },
        required: ["id"],
      },
    },
    {
      name: "list_conversations",
      description: "List conversations for a lead",
      inputSchema: {
        type: "object",
        properties: {
          leadId: { type: "string", description: "Lead ID" },
          status: { type: "string", enum: ["active", "closed", "pending", "archived"] },
        },
        required: ["leadId"],
      },
    },
    {
      name: "add_message",
      description: "Add a message to a conversation",
      inputSchema: {
        type: "object",
        properties: {
          conversationId: { type: "string", description: "Conversation ID" },
          direction: { type: "string", enum: ["inbound", "outbound"] },
          senderType: { type: "string", enum: ["lead", "user", "agent", "system"] },
          senderId: { type: "string", description: "Sender ID" },
          senderName: { type: "string", description: "Sender display name" },
          content: { type: "string", description: "Message content" },
          contentType: { type: "string", enum: ["text", "html", "markdown"], default: "text" },
        },
        required: ["conversationId", "direction", "senderType", "content"],
      },
    },
    {
      name: "get_messages",
      description: "Get messages in a conversation",
      inputSchema: {
        type: "object",
        properties: {
          conversationId: { type: "string", description: "Conversation ID" },
          limit: { type: "number", description: "Maximum messages to return" },
        },
        required: ["conversationId"],
      },
    },

    // ─────────────────────────────────────────────────────────────────────────
    // AI TOOLS (stub implementations)
    // ─────────────────────────────────────────────────────────────────────────
    {
      name: "analyze_funnel",
      description: "AI analysis of funnel performance and bottlenecks",
      inputSchema: {
        type: "object",
        properties: {
          funnelId: { type: "string", description: "Funnel ID to analyze" },
          depth: { type: "string", enum: ["quick", "standard", "deep"], description: "Analysis depth" },
        },
        required: ["funnelId"],
      },
    },
    {
      name: "suggest_improvements",
      description: "Get AI-powered suggestions for funnel improvements",
      inputSchema: {
        type: "object",
        properties: {
          funnelId: { type: "string", description: "Funnel ID" },
          targetMetric: { type: "string", enum: ["conversion_rate", "lead_velocity", "revenue", "stage_time", "qualification_rate"] },
        },
        required: ["funnelId"],
      },
    },
    {
      name: "forecast_revenue",
      description: "Forecast revenue based on funnel data and historical trends",
      inputSchema: {
        type: "object",
        properties: {
          funnelId: { type: "string", description: "Funnel ID" },
          period: { type: "string", enum: ["week", "month", "quarter", "year"], description: "Forecast period" },
          scenario: { type: "string", enum: ["conservative", "moderate", "optimistic"] },
        },
        required: ["funnelId", "period"],
      },
    },
  ],
}));

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  const args = rawArgs || {};
  const store = getFunnelStore();

  try {
    switch (name) {
      // ─────────────────────────────────────────────────────────────────────────
      // BUSINESS CRUD
      // ─────────────────────────────────────────────────────────────────────────

      case "create_business": {
        const business = store.createBusiness({
          name: args.name as string,
          description: args.description as string | undefined,
          industry: args.industry as string | undefined,
          website: args.website as string | undefined,
          email: args.email as string | undefined,
          phone: args.phone as string | undefined,
          address: args.address as string | undefined,
          timezone: args.timezone as string | undefined,
          currency: args.currency as string | undefined,
          ownerId: args.ownerId as string | undefined,
        });
        return jsonResponse({ success: true, business });
      }

      case "get_business": {
        const business = store.getBusiness(args.id as string);
        if (!business) {
          return jsonResponse({ error: "Business not found" });
        }
        return jsonResponse({ business });
      }

      case "list_businesses": {
        const businesses = store.getBusinesses(args.ownerId as string | undefined);
        return jsonResponse({ businesses, count: businesses.length });
      }

      case "update_business": {
        const { id, ...updates } = args;
        const business = store.updateBusiness(id as string, updates);
        if (!business) {
          return jsonResponse({ error: "Business not found" });
        }
        return jsonResponse({ success: true, business });
      }

      case "delete_business": {
        store.deleteBusiness(args.id as string);
        return jsonResponse({ success: true });
      }

      // ─────────────────────────────────────────────────────────────────────────
      // FUNNEL CRUD + ANALYTICS
      // ─────────────────────────────────────────────────────────────────────────

      case "create_funnel": {
        const funnel = store.createFunnel({
          businessId: args.businessId as string,
          name: args.name as string,
          description: args.description as string | undefined,
          type: args.type as FunnelType,
          status: (args.status as FunnelStatus) || "draft",
          color: args.color as string | undefined,
          icon: args.icon as string | undefined,
          automationEnabled: args.automationEnabled as boolean || false,
          webhookUrl: args.webhookUrl as string | undefined,
        });
        return jsonResponse({ success: true, funnel });
      }

      case "get_funnel": {
        const funnel = store.getFunnel(args.id as string);
        if (!funnel) {
          return jsonResponse({ error: "Funnel not found" });
        }
        // Optionally include stages
        const stages = store.getStages(funnel.id);
        return jsonResponse({ funnel, stages });
      }

      case "list_funnels": {
        const funnels = store.getFunnels(args as FunnelFilters);
        return jsonResponse({ funnels, count: funnels.length });
      }

      case "update_funnel": {
        const { id, ...updates } = args;
        const funnel = store.updateFunnel(id as string, updates);
        if (!funnel) {
          return jsonResponse({ error: "Funnel not found" });
        }
        return jsonResponse({ success: true, funnel });
      }

      case "delete_funnel": {
        store.deleteFunnel(args.id as string);
        return jsonResponse({ success: true });
      }

      case "duplicate_funnel": {
        const source = store.getFunnel(args.id as string);
        if (!source) {
          return jsonResponse({ error: "Source funnel not found" });
        }
        const targetBusinessId = (args.targetBusinessId as string) || source.businessId;
        const newName = (args.newName as string) || `${source.name} (Copy)`;

        // Create new funnel
        const newFunnel = store.createFunnel({
          businessId: targetBusinessId,
          name: newName,
          description: source.description,
          type: source.type,
          status: "draft",
          color: source.color,
          icon: source.icon,
          automationEnabled: source.automationEnabled,
        });

        // Copy stages
        const stages = store.getStages(source.id);
        const stageIdMap: Record<string, string> = {};

        for (const stage of stages) {
          const newStage = store.createStage({
            funnelId: newFunnel.id,
            name: stage.name,
            description: stage.description,
            type: stage.type,
            position: stage.position,
            color: stage.color,
            icon: stage.icon,
            autoMoveAfterDays: stage.autoMoveAfterDays,
            maxDaysAllowed: stage.maxDaysAllowed,
          });
          stageIdMap[stage.id] = newStage.id;
        }

        // Copy connections
        const connections = store.getConnections(source.id);
        for (const conn of connections) {
          store.createConnection({
            funnelId: newFunnel.id,
            sourceStageId: stageIdMap[conn.sourceStageId],
            targetStageId: stageIdMap[conn.targetStageId],
            label: conn.label,
            conditionType: conn.conditionType,
            conditionConfig: conn.conditionConfig,
          });
        }

        return jsonResponse({ success: true, funnel: newFunnel, stageCount: stages.length });
      }

      case "get_funnel_analytics": {
        const now = new Date();
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        const startDate = (args.startDate as string) || thirtyDaysAgo.toISOString();
        const endDate = (args.endDate as string) || now.toISOString();

        const analytics = store.getFunnelAnalytics(
          args.funnelId as string,
          startDate,
          endDate
        );
        return jsonResponse({ analytics });
      }

      // ─────────────────────────────────────────────────────────────────────────
      // STAGE MANAGEMENT
      // ─────────────────────────────────────────────────────────────────────────

      case "add_stage": {
        // Auto-assign position if not provided
        let position = args.position as number | undefined;
        if (position === undefined) {
          const existing = store.getStages(args.funnelId as string);
          position = existing.length;
        }

        const stage = store.createStage({
          funnelId: args.funnelId as string,
          name: args.name as string,
          description: args.description as string | undefined,
          type: args.type as StageType,
          position,
          color: args.color as string | undefined,
          icon: args.icon as string | undefined,
          autoMoveAfterDays: args.autoMoveAfterDays as number | undefined,
          maxDaysAllowed: args.maxDaysAllowed as number | undefined,
        });
        return jsonResponse({ success: true, stage });
      }

      case "get_stage": {
        const stage = store.getStage(args.id as string);
        if (!stage) {
          return jsonResponse({ error: "Stage not found" });
        }
        return jsonResponse({ stage });
      }

      case "list_stages": {
        const stages = store.getStages(args.funnelId as string);
        return jsonResponse({ stages, count: stages.length });
      }

      case "update_stage": {
        const { id, ...updates } = args;
        const stage = store.updateStage(id as string, updates);
        if (!stage) {
          return jsonResponse({ error: "Stage not found" });
        }
        return jsonResponse({ success: true, stage });
      }

      case "delete_stage": {
        store.deleteStage(args.id as string);
        return jsonResponse({ success: true });
      }

      case "reorder_stages": {
        const stageOrder = args.stageOrder as string[];
        for (let i = 0; i < stageOrder.length; i++) {
          store.updateStage(stageOrder[i], { position: i });
        }
        return jsonResponse({ success: true });
      }

      case "connect_stages": {
        const connection = store.createConnection({
          funnelId: args.funnelId as string,
          sourceStageId: args.sourceStageId as string,
          targetStageId: args.targetStageId as string,
          label: args.label as string | undefined,
          conditionType: args.conditionType as "manual" | "auto" | "rule" | undefined,
          conditionConfig: args.conditionConfig as Record<string, unknown> | undefined,
        });
        return jsonResponse({ success: true, connection });
      }

      case "get_stage_kpis": {
        const stage = store.getStage(args.stageId as string);
        if (!stage) {
          return jsonResponse({ error: "Stage not found" });
        }
        return jsonResponse({
          stageId: stage.id,
          leadCount: stage.leadCount,
          avgTimeInStage: stage.avgTimeInStage,
        });
      }

      // ─────────────────────────────────────────────────────────────────────────
      // LEAD MANAGEMENT
      // ─────────────────────────────────────────────────────────────────────────

      case "create_lead": {
        const lead = store.createLead({
          businessId: args.businessId as string,
          funnelId: args.funnelId as string,
          stageId: args.stageId as string,
          name: args.name as string,
          email: args.email as string | undefined,
          phone: args.phone as string | undefined,
          company: args.company as string | undefined,
          title: args.title as string | undefined,
          source: (args.source as LeadSource) || "manual",
          status: (args.status as LeadStatus) || "new",
          priority: (args.priority as LeadPriority) || "medium",
          estimatedValue: args.estimatedValue as number | undefined,
          currency: args.currency as string | undefined,
          assignedTo: args.assignedTo as string | undefined,
          tags: args.tags as string[] | undefined,
          customFields: args.customFields as Record<string, unknown> | undefined,
        });
        return jsonResponse({ success: true, lead });
      }

      case "get_lead": {
        const lead = store.getLead(args.id as string);
        if (!lead) {
          return jsonResponse({ error: "Lead not found" });
        }
        const result: Record<string, unknown> = { lead };

        if (args.includeActivities) {
          result.activities = store.getLeadActivities(lead.id);
        }
        if (args.includeStageHistory) {
          result.stageHistory = store.getLeadStageHistory(lead.id);
        }
        return jsonResponse(result);
      }

      case "update_lead": {
        const { id, ...updates } = args;
        const lead = store.updateLead(id as string, updates);
        if (!lead) {
          return jsonResponse({ error: "Lead not found" });
        }
        return jsonResponse({ success: true, lead });
      }

      case "search_leads": {
        const leads = store.getLeads(args as LeadFilters);
        return jsonResponse({ leads, count: leads.length });
      }

      case "delete_lead": {
        store.deleteLead(args.id as string);
        return jsonResponse({ success: true });
      }

      case "score_lead": {
        const lead = store.updateLead(args.id as string, {
          score: args.score as number,
        });
        if (!lead) {
          return jsonResponse({ error: "Lead not found" });
        }
        // Log the score change activity
        store.addLeadActivity({
          leadId: args.id as string,
          type: "score_change",
          description: args.reason as string || `Score updated to ${args.score}`,
          metadata: { newScore: args.score },
        });
        return jsonResponse({ success: true, lead });
      }

      case "qualify_lead": {
        const status = args.qualified ? "qualified" : "disqualified";
        const lead = store.updateLead(args.id as string, { status });
        if (!lead) {
          return jsonResponse({ error: "Lead not found" });
        }
        store.addLeadActivity({
          leadId: args.id as string,
          type: "system",
          description: args.reason as string || `Lead ${status}`,
        });
        return jsonResponse({ success: true, lead });
      }

      case "match_offer": {
        const lead = store.getLead(args.leadId as string);
        if (!lead) {
          return jsonResponse({ error: "Lead not found" });
        }
        const allOffers = store.getOffers(lead.businessId, "active");
        const matchedOffers = allOffers.filter((offer) => {
          // Check stage targeting
          if (offer.targetStages?.length && !offer.targetStages.includes(lead.stageId)) {
            return false;
          }
          // Check score requirement
          if (offer.minScore && (!lead.score || lead.score < offer.minScore)) {
            return false;
          }
          // Check tag targeting
          if (offer.targetTags?.length) {
            const hasTag = offer.targetTags.some((t) => lead.tags?.includes(t));
            if (!hasTag) return false;
          }
          return true;
        });
        return jsonResponse({ offers: matchedOffers, count: matchedOffers.length });
      }

      case "assign_to_funnel": {
        const lead = store.updateLead(args.leadId as string, {
          funnelId: args.funnelId as string,
          stageId: args.stageId as string,
        });
        if (!lead) {
          return jsonResponse({ error: "Lead not found" });
        }
        return jsonResponse({ success: true, lead });
      }

      case "move_to_stage": {
        const lead = store.updateLead(args.leadId as string, {
          stageId: args.stageId as string,
        });
        if (!lead) {
          return jsonResponse({ error: "Lead not found" });
        }
        return jsonResponse({ success: true, lead });
      }

      case "add_lead_activity": {
        const activity = store.addLeadActivity({
          leadId: args.leadId as string,
          type: args.type as "note" | "email" | "call" | "meeting" | "task" | "stage_change" | "score_change" | "system",
          description: args.description as string,
          metadata: args.metadata as Record<string, unknown> | undefined,
          performedBy: args.performedBy as string | undefined,
        });
        return jsonResponse({ success: true, activity });
      }

      case "get_lead_activities": {
        const activities = store.getLeadActivities(
          args.leadId as string,
          args.limit as number | undefined
        );
        return jsonResponse({ activities, count: activities.length });
      }

      case "get_lead_stage_history": {
        const history = store.getLeadStageHistory(args.leadId as string);
        return jsonResponse({ history, count: history.length });
      }

      // ─────────────────────────────────────────────────────────────────────────
      // KPI TRACKING
      // ─────────────────────────────────────────────────────────────────────────

      case "log_metric": {
        const metric = store.createMetric({
          businessId: args.businessId as string,
          funnelId: args.funnelId as string | undefined,
          stageId: args.stageId as string | undefined,
          name: args.name as string,
          description: args.description as string | undefined,
          type: args.type as "count" | "sum" | "average" | "percentage" | "ratio" | "duration" | "currency",
          currentValue: args.currentValue as number,
          targetValue: args.targetValue as number | undefined,
          period: args.period as MetricPeriod,
          unit: args.unit as string | undefined,
          calculatedAt: new Date().toISOString(),
        });
        return jsonResponse({ success: true, metric });
      }

      case "get_metrics": {
        const metrics = store.getMetrics(
          args.businessId as string,
          args.funnelId as string | undefined
        );
        return jsonResponse({ metrics, count: metrics.length });
      }

      case "compare_periods": {
        const analytics1 = store.getFunnelAnalytics(
          args.funnelId as string,
          args.period1Start as string,
          args.period1End as string
        );
        const analytics2 = store.getFunnelAnalytics(
          args.funnelId as string,
          args.period2Start as string,
          args.period2End as string
        );
        return jsonResponse({
          period1: analytics1,
          period2: analytics2,
          comparison: {
            leadsDelta: analytics2.totalLeads - analytics1.totalLeads,
            conversionDelta: analytics2.overallConversionRate - analytics1.overallConversionRate,
            valueDelta: analytics2.wonValue - analytics1.wonValue,
          },
        });
      }

      case "add_metric_snapshot": {
        const snapshot = store.addSnapshot({
          metricId: args.metricId as string,
          value: args.value as number,
          period: args.period as MetricPeriod,
          periodStart: args.periodStart as string,
          periodEnd: args.periodEnd as string,
          metadata: args.metadata as Record<string, unknown> | undefined,
        });
        return jsonResponse({ success: true, snapshot });
      }

      // ─────────────────────────────────────────────────────────────────────────
      // TASK/SOP MANAGEMENT
      // ─────────────────────────────────────────────────────────────────────────

      case "create_task": {
        const task = store.createTask({
          businessId: args.businessId as string,
          funnelId: args.funnelId as string | undefined,
          leadId: args.leadId as string | undefined,
          stageId: args.stageId as string | undefined,
          title: args.title as string,
          description: args.description as string | undefined,
          type: args.type as FunnelTaskType,
          status: (args.status as FunnelTaskStatus) || "pending",
          priority: (args.priority as FunnelTaskPriority) || "normal",
          assignedTo: args.assignedTo as string | undefined,
          createdBy: args.createdBy as string | undefined,
          dueAt: args.dueAt as string | undefined,
          reminderAt: args.reminderAt as string | undefined,
        });
        return jsonResponse({ success: true, task });
      }

      case "get_task": {
        const task = store.getTask(args.id as string);
        if (!task) {
          return jsonResponse({ error: "Task not found" });
        }
        return jsonResponse({ task });
      }

      case "update_task": {
        const { id, ...updates } = args;
        const task = store.updateTask(id as string, updates);
        if (!task) {
          return jsonResponse({ error: "Task not found" });
        }
        return jsonResponse({ success: true, task });
      }

      case "complete_task": {
        const task = store.updateTask(args.id as string, {
          status: "completed",
          completedAt: new Date().toISOString(),
        });
        if (!task) {
          return jsonResponse({ error: "Task not found" });
        }
        return jsonResponse({ success: true, task });
      }

      case "list_tasks": {
        const tasks = store.getTasks(args as TaskFilters);
        return jsonResponse({ tasks, count: tasks.length });
      }

      case "delete_task": {
        store.deleteTask(args.id as string);
        return jsonResponse({ success: true });
      }

      case "get_stage_checklist": {
        const tasks = store.getTasks({ stageId: args.stageId as string });
        return jsonResponse({ checklist: tasks, count: tasks.length });
      }

      case "generate_sop": {
        const funnel = store.getFunnel(args.funnelId as string);
        if (!funnel) {
          return jsonResponse({ error: "Funnel not found" });
        }
        const stages = store.getStages(funnel.id);
        const format = (args.format as string) || "markdown";

        if (format === "json") {
          return jsonResponse({
            sop: {
              funnel: { name: funnel.name, type: funnel.type },
              stages: stages.map((s) => ({
                name: s.name,
                type: s.type,
                description: s.description,
                position: s.position,
              })),
            },
          });
        }

        // Generate markdown SOP
        let md = `# ${funnel.name} SOP\n\n`;
        md += `**Type:** ${funnel.type}\n`;
        md += `**Description:** ${funnel.description || "N/A"}\n\n`;
        md += `## Stages\n\n`;

        for (const stage of stages) {
          md += `### ${stage.position + 1}. ${stage.name}\n`;
          md += `- **Type:** ${stage.type}\n`;
          if (stage.description) md += `- **Description:** ${stage.description}\n`;
          if (stage.autoMoveAfterDays) md += `- **Auto-move after:** ${stage.autoMoveAfterDays} days\n`;
          if (stage.maxDaysAllowed) md += `- **Max days allowed:** ${stage.maxDaysAllowed}\n`;
          md += `\n`;
        }

        return jsonResponse({ sop: md, format: "markdown" });
      }

      // ─────────────────────────────────────────────────────────────────────────
      // OFFER MANAGEMENT
      // ─────────────────────────────────────────────────────────────────────────

      case "create_offer": {
        const offer = store.createOffer({
          businessId: args.businessId as string,
          name: args.name as string,
          description: args.description as string | undefined,
          type: args.type as OfferType,
          status: (args.status as OfferStatus) || "draft",
          price: args.price as number,
          currency: args.currency as string,
          discountPercent: args.discountPercent as number | undefined,
          discountAmount: args.discountAmount as number | undefined,
          validFrom: args.validFrom as string | undefined,
          validUntil: args.validUntil as string | undefined,
          maxRedemptions: args.maxRedemptions as number | undefined,
          targetStages: args.targetStages as string[] | undefined,
          targetTags: args.targetTags as string[] | undefined,
          minScore: args.minScore as number | undefined,
          features: args.features as string[] | undefined,
          terms: args.terms as string | undefined,
        });
        return jsonResponse({ success: true, offer });
      }

      case "get_offer": {
        const offer = store.getOffer(args.id as string);
        if (!offer) {
          return jsonResponse({ error: "Offer not found" });
        }
        return jsonResponse({ offer });
      }

      case "update_offer": {
        const { id, ...updates } = args;
        const offer = store.updateOffer(id as string, updates);
        if (!offer) {
          return jsonResponse({ error: "Offer not found" });
        }
        return jsonResponse({ success: true, offer });
      }

      case "delete_offer": {
        store.deleteOffer(args.id as string);
        return jsonResponse({ success: true });
      }

      case "toggle_offer_active": {
        const status = args.active ? "active" : "expired";
        const offer = store.updateOffer(args.id as string, { status });
        if (!offer) {
          return jsonResponse({ error: "Offer not found" });
        }
        return jsonResponse({ success: true, offer });
      }

      case "get_active_offers": {
        const offers = store.getOffers(args.businessId as string, "active");
        return jsonResponse({ offers, count: offers.length });
      }

      case "check_eligibility": {
        const offer = store.getOffer(args.offerId as string);
        const lead = store.getLead(args.leadId as string);

        if (!offer) return jsonResponse({ error: "Offer not found" });
        if (!lead) return jsonResponse({ error: "Lead not found" });

        const eligible = true;
        const reasons: string[] = [];

        // Check stage targeting
        if (offer.targetStages?.length && !offer.targetStages.includes(lead.stageId)) {
          reasons.push(`Lead not in target stage`);
        }
        // Check score requirement
        if (offer.minScore && (!lead.score || lead.score < offer.minScore)) {
          reasons.push(`Lead score ${lead.score || 0} below minimum ${offer.minScore}`);
        }
        // Check validity dates
        const now = new Date();
        if (offer.validFrom && new Date(offer.validFrom) > now) {
          reasons.push(`Offer not yet valid`);
        }
        if (offer.validUntil && new Date(offer.validUntil) < now) {
          reasons.push(`Offer expired`);
        }
        // Check redemption limit
        if (offer.maxRedemptions && offer.currentRedemptions && offer.currentRedemptions >= offer.maxRedemptions) {
          reasons.push(`Redemption limit reached`);
        }

        return jsonResponse({
          eligible: reasons.length === 0,
          reasons: reasons.length > 0 ? reasons : undefined,
        });
      }

      // ─────────────────────────────────────────────────────────────────────────
      // AUTOMATION RULES
      // ─────────────────────────────────────────────────────────────────────────

      case "create_rule": {
        const rule = store.createRule({
          businessId: args.businessId as string,
          funnelId: args.funnelId as string | undefined,
          stageId: args.stageId as string | undefined,
          name: args.name as string,
          description: args.description as string | undefined,
          enabled: args.enabled !== false,
          priority: (args.priority as number) || 100,
          triggerOn: args.triggerOn as "lead_created" | "lead_updated" | "stage_changed" | "field_changed" | "manual",
          triggerField: args.triggerField as string | undefined,
          conditions: args.conditions as QualificationCondition[],
          actions: args.actions as QualificationActionConfig[],
        });
        return jsonResponse({ success: true, rule });
      }

      case "get_rule": {
        const rule = store.getRule(args.id as string);
        if (!rule) {
          return jsonResponse({ error: "Rule not found" });
        }
        return jsonResponse({ rule });
      }

      case "list_rules": {
        const rules = store.getRules(
          args.businessId as string,
          args.funnelId as string | undefined,
          args.enabled as boolean | undefined
        );
        return jsonResponse({ rules, count: rules.length });
      }

      case "update_rule": {
        const { id, ...updates } = args;
        const rule = store.updateRule(id as string, updates);
        if (!rule) {
          return jsonResponse({ error: "Rule not found" });
        }
        return jsonResponse({ success: true, rule });
      }

      case "delete_rule": {
        store.deleteRule(args.id as string);
        return jsonResponse({ success: true });
      }

      case "toggle_rule": {
        const rule = store.updateRule(args.id as string, { enabled: args.enabled as boolean });
        if (!rule) {
          return jsonResponse({ error: "Rule not found" });
        }
        return jsonResponse({ success: true, rule });
      }

      // ─────────────────────────────────────────────────────────────────────────
      // CONVERSATIONS
      // ─────────────────────────────────────────────────────────────────────────

      case "create_conversation": {
        const conversation = store.createConversation({
          businessId: args.businessId as string,
          leadId: args.leadId as string,
          channel: args.channel as "email" | "phone" | "sms" | "whatsapp" | "telegram" | "discord" | "website_chat" | "in_person" | "other",
          status: "active",
          subject: args.subject as string | undefined,
          externalId: args.externalId as string | undefined,
          assignedTo: args.assignedTo as string | undefined,
          startedAt: new Date().toISOString(),
        });
        return jsonResponse({ success: true, conversation });
      }

      case "get_conversation": {
        const conversation = store.getConversation(args.id as string);
        if (!conversation) {
          return jsonResponse({ error: "Conversation not found" });
        }
        return jsonResponse({ conversation });
      }

      case "list_conversations": {
        const conversations = store.getConversations(
          args.leadId as string,
          args.status as string | undefined
        );
        return jsonResponse({ conversations, count: conversations.length });
      }

      case "add_message": {
        const message = store.addMessage({
          conversationId: args.conversationId as string,
          direction: args.direction as "inbound" | "outbound",
          senderType: args.senderType as "lead" | "user" | "agent" | "system",
          senderId: args.senderId as string | undefined,
          senderName: args.senderName as string | undefined,
          content: args.content as string,
          contentType: (args.contentType as "text" | "html" | "markdown") || "text",
        });
        return jsonResponse({ success: true, message });
      }

      case "get_messages": {
        const messages = store.getMessages(
          args.conversationId as string,
          args.limit as number | undefined
        );
        return jsonResponse({ messages, count: messages.length });
      }

      // ─────────────────────────────────────────────────────────────────────────
      // AI TOOLS (stub implementations)
      // ─────────────────────────────────────────────────────────────────────────

      case "analyze_funnel": {
        const now = new Date();
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        const analytics = store.getFunnelAnalytics(
          args.funnelId as string,
          thirtyDaysAgo.toISOString(),
          now.toISOString()
        );

        // Generate analysis based on data
        const bottlenecks: string[] = [];
        for (const [stageId, rate] of Object.entries(analytics.stageConversionRates)) {
          if (rate < 50) {
            bottlenecks.push(`Stage ${stageId} has low conversion (${rate}%)`);
          }
        }

        return jsonResponse({
          analysis: {
            summary: `Funnel has ${analytics.totalLeads} leads with ${analytics.overallConversionRate}% overall conversion`,
            metrics: {
              totalLeads: analytics.totalLeads,
              conversionRate: analytics.overallConversionRate,
              wonValue: analytics.wonValue,
              avgDealSize: analytics.averageDealSize,
            },
            bottlenecks,
            depth: args.depth || "standard",
          },
        });
      }

      case "suggest_improvements": {
        const now = new Date();
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        const analytics = store.getFunnelAnalytics(
          args.funnelId as string,
          thirtyDaysAgo.toISOString(),
          now.toISOString()
        );

        const suggestions: Array<{ area: string; suggestion: string; impact: string }> = [];

        if (analytics.overallConversionRate < 30) {
          suggestions.push({
            area: "Lead Quality",
            suggestion: "Consider implementing stricter lead qualification criteria",
            impact: "Could improve conversion rate by 10-20%",
          });
        }

        if (analytics.averageDealSize < 1000) {
          suggestions.push({
            area: "Deal Size",
            suggestion: "Focus on upselling and cross-selling to increase deal values",
            impact: "Could increase average deal size by 25-40%",
          });
        }

        return jsonResponse({
          suggestions,
          targetMetric: args.targetMetric || "conversion_rate",
        });
      }

      case "forecast_revenue": {
        const now = new Date();
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        const analytics = store.getFunnelAnalytics(
          args.funnelId as string,
          thirtyDaysAgo.toISOString(),
          now.toISOString()
        );

        const scenario = (args.scenario as string) || "moderate";
        const period = args.period as string;

        // Simple forecast based on historical data
        const multipliers: Record<string, Record<string, number>> = {
          conservative: { week: 0.8, month: 3, quarter: 8, year: 30 },
          moderate: { week: 1, month: 4, quarter: 12, year: 45 },
          optimistic: { week: 1.2, month: 5, quarter: 16, year: 60 },
        };

        const weeklyRevenue = analytics.wonValue / 4; // Assume 30-day data = 4 weeks
        const multiplier = multipliers[scenario]?.[period] || 1;
        const forecastedRevenue = Math.round(weeklyRevenue * multiplier);

        return jsonResponse({
          forecast: {
            period,
            scenario,
            projectedRevenue: forecastedRevenue,
            projectedDeals: Math.round(forecastedRevenue / (analytics.averageDealSize || 1000)),
            confidence: scenario === "moderate" ? "70%" : scenario === "conservative" ? "85%" : "55%",
            basedOn: `${analytics.totalLeads} leads and ${analytics.wonValue} won value in last 30 days`,
          },
        });
      }

      default:
        return jsonResponse({ error: `Unknown tool: ${name}` });
    }
  } catch (error) {
    return jsonResponse({ error: String(error) });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// RESOURCES (expose funnels as MCP resources)
// ═══════════════════════════════════════════════════════════════════════════════

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const store = getFunnelStore();
  const funnels = store.getFunnels({});

  return {
    resources: funnels.map((funnel) => ({
      uri: `funnel-system://funnels/${funnel.id}`,
      name: funnel.name,
      description: funnel.description || `${funnel.type} funnel`,
      mimeType: "application/json",
    })),
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  const store = getFunnelStore();

  // Parse URI: funnel-system://funnels/{id}
  const funnelMatch = uri.match(/^funnel-system:\/\/funnels\/(.+)$/);
  if (funnelMatch) {
    const funnel = store.getFunnel(funnelMatch[1]);
    if (!funnel) {
      throw new Error(`Funnel not found: ${funnelMatch[1]}`);
    }
    const stages = store.getStages(funnel.id);
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify({ funnel, stages }, null, 2),
        },
      ],
    };
  }

  throw new Error(`Invalid URI: ${uri}`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

function jsonResponse(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Funnel System MCP Server running on stdio");
}

main().catch(console.error);

