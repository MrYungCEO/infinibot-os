/**
 * Systems Intelligence gateway handlers
 *
 * Gateway methods for managing values, priorities, system nodes,
 * relationships, and reviews.
 *
 * Methods:
 *   systems.values.list / create / update / delete
 *   systems.priorities.list / create / update / delete
 *   systems.nodes.list / create / update / delete
 *   systems.relationships.list / create / update / delete
 *   systems.reviews.list / create
 *   systems.graph.get
 */

import { getSystemsIntelligenceStore } from "../../systems-intelligence/store.js";
import type {
  ValueUpdateParams,
  ValueListParams,
  PriorityUpdateParams,
  PriorityListParams,
  SystemNodeCreateParams,
  SystemNodeUpdateParams,
  SystemNodeListParams,
  RelationshipCreateParams,
  RelationshipUpdateParams,
  RelationshipListParams,
  ReviewCreateParams,
  ReviewListParams,
} from "../../systems-intelligence/types.js";
import type { GatewayRequestHandlers } from "./types.js";

const getStore = () => {
  const stateDir = process.env.INFINIBOT_STATE_DIR ?? "state";
  return getSystemsIntelligenceStore(stateDir);
};

export const systemsIntelligenceHandlers: GatewayRequestHandlers = {
  // ═══════════════════════════════════════════════════════════════
  // VALUES
  // ═══════════════════════════════════════════════════════════════

  "systems.values.list": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as ValueListParams;
      const values = getStore().listValues(p);
      respond(true, values);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "systems.values.get": async ({ params, respond }) => {
    try {
      const { id } = params as { id: string };
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const value = getStore().getValue(id);
      if (!value) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Value "${id}" not found` });
        return;
      }
      respond(true, value);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "systems.values.create": async ({ params, respond }) => {
    try {
      const p = params as any;
      if (!p.name || !p.description) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "name and description are required",
        });
        return;
      }
      // Auto-generate order if not provided
      const existingValues = getStore().listValues();
      const order = typeof p.order === "number" ? p.order : existingValues.length;
      // Default color if not provided
      const color = p.color || "#6366f1";
      const value = getStore().createValue({
        name: p.name,
        description: p.description,
        color,
        order,
        indicators: p.indicators ?? [],
        category: p.category || "core",
        weight: p.weight ?? 5,
      } as any);
      respond(true, value);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "systems.values.update": async ({ params, respond }) => {
    try {
      const p = params as unknown as ValueUpdateParams;
      if (!p.id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const value = getStore().updateValue(p);
      if (!value) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Value "${p.id}" not found` });
        return;
      }
      respond(true, value);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "systems.values.delete": async ({ params, respond }) => {
    try {
      const { id } = params as { id: string };
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const deleted = getStore().deleteValue(id);
      if (!deleted) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Value "${id}" not found` });
        return;
      }
      respond(true, { deleted: true, id });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // GOALS
  // ═══════════════════════════════════════════════════════════════

  "systems.goals.list": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as any;
      const goals = getStore().listGoals(p);
      respond(true, goals);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "systems.goals.get": async ({ params, respond }) => {
    try {
      const { id } = params as { id: string };
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const goal = getStore().getGoal(id);
      if (!goal) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Goal "${id}" not found` });
        return;
      }
      respond(true, goal);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "systems.goals.create": async ({ params, respond }) => {
    try {
      const p = params as any;
      if (!p.title) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "title is required",
        });
        return;
      }
      const goal = getStore().createGoal({
        title: p.title,
        description: p.description || "",
        timeframe: p.timeframe || "medium",
        targetDate: p.targetDate,
        valueIds: p.valueIds || p.linkedValues || [],
        milestones: p.milestones || [],
        progress: p.progress || 0,
        status: p.status || "active",
        color: p.color,
      } as any);
      respond(true, goal);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "systems.goals.update": async ({ params, respond }) => {
    try {
      const p = params as any;
      if (!p.id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const goal = getStore().updateGoal(p);
      if (!goal) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Goal "${p.id}" not found` });
        return;
      }
      respond(true, goal);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "systems.goals.delete": async ({ params, respond }) => {
    try {
      const { id } = params as { id: string };
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const deleted = getStore().deleteGoal(id);
      if (!deleted) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Goal "${id}" not found` });
        return;
      }
      respond(true, { deleted: true, id });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // PRIORITIES
  // ═══════════════════════════════════════════════════════════════

  "systems.priorities.list": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as PriorityListParams;
      const priorities = getStore().listPriorities(p);
      respond(true, priorities);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "systems.priorities.get": async ({ params, respond }) => {
    try {
      const { id } = params as { id: string };
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const priority = getStore().getPriority(id);
      if (!priority) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Priority "${id}" not found` });
        return;
      }
      respond(true, priority);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "systems.priorities.create": async ({ params, respond }) => {
    try {
      const p = params as any;
      // Title is required, quarter and rank are optional (auto-generated if not provided)
      if (!p.title) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "title is required",
        });
        return;
      }
      // Auto-generate quarter (current quarter like "2026-Q1")
      const now = new Date();
      const currentQuarter = `${now.getFullYear()}-Q${Math.ceil((now.getMonth() + 1) / 3)}`;
      // Auto-generate rank based on existing priorities count
      const existingPriorities = getStore().listPriorities();
      const autoRank = existingPriorities.length + 1;

      const priority = getStore().createPriority({
        title: p.title,
        description: p.description ?? "",
        quarter: p.quarter ?? currentQuarter,
        rank: typeof p.rank === "number" ? p.rank : autoRank,
        valueIds: p.valueIds ?? p.linkedValues ?? [],
        outcomes: p.outcomes ?? [],
        progress: p.progress ?? 0,
        status: p.status ?? "active",
      });
      respond(true, priority);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "systems.priorities.update": async ({ params, respond }) => {
    try {
      const p = params as unknown as PriorityUpdateParams;
      if (!p.id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const priority = getStore().updatePriority(p);
      if (!priority) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Priority "${p.id}" not found` });
        return;
      }
      respond(true, priority);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "systems.priorities.delete": async ({ params, respond }) => {
    try {
      const { id } = params as { id: string };
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const deleted = getStore().deletePriority(id);
      if (!deleted) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Priority "${id}" not found` });
        return;
      }
      respond(true, { deleted: true, id });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // SYSTEM NODES
  // ═══════════════════════════════════════════════════════════════

  "systems.nodes.list": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as SystemNodeListParams;
      const nodes = getStore().listNodes(p);
      respond(true, nodes);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "systems.nodes.get": async ({ params, respond }) => {
    try {
      const { id } = params as { id: string };
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const node = getStore().getNode(id);
      if (!node) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Node "${id}" not found` });
        return;
      }
      respond(true, node);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "systems.nodes.create": async ({ params, respond }) => {
    try {
      const p = params as unknown as SystemNodeCreateParams;
      const validTypes = ["business", "project", "person", "asset", "revenue_stream"];
      if (!p.name || !p.type || !validTypes.includes(p.type)) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: `name and type (one of: ${validTypes.join(", ")}) are required`,
        });
        return;
      }
      const node = getStore().createNode({
        ...p,
        metadata: p.metadata ?? {},
      });
      respond(true, node);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "systems.nodes.update": async ({ params, respond }) => {
    try {
      const p = params as unknown as SystemNodeUpdateParams;
      if (!p.id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const node = getStore().updateNode(p);
      if (!node) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Node "${p.id}" not found` });
        return;
      }
      respond(true, node);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "systems.nodes.delete": async ({ params, respond }) => {
    try {
      const { id } = params as { id: string };
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const deleted = getStore().deleteNode(id);
      if (!deleted) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Node "${id}" not found` });
        return;
      }
      respond(true, { deleted: true, id });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // RELATIONSHIPS
  // ═══════════════════════════════════════════════════════════════

  "systems.relationships.list": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as RelationshipListParams;
      const relationships = getStore().listRelationships(p);
      respond(true, relationships);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "systems.relationships.get": async ({ params, respond }) => {
    try {
      const { id } = params as { id: string };
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const relationship = getStore().getRelationship(id);
      if (!relationship) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Relationship "${id}" not found` });
        return;
      }
      respond(true, relationship);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "systems.relationships.create": async ({ params, respond }) => {
    try {
      const p = params as unknown as RelationshipCreateParams;
      const validTypes = ["feeds", "depends_on", "synergy", "resource_flow", "attention_flow"];
      if (!p.sourceId || !p.targetId || !p.type || !validTypes.includes(p.type)) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: `sourceId, targetId, and type (one of: ${validTypes.join(", ")}) are required`,
        });
        return;
      }
      const relationship = getStore().createRelationship({
        ...p,
        strength: p.strength ?? 1,
      });
      respond(true, relationship);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "systems.relationships.update": async ({ params, respond }) => {
    try {
      const p = params as unknown as RelationshipUpdateParams;
      if (!p.id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const relationship = getStore().updateRelationship(p);
      if (!relationship) {
        respond(false, undefined, {
          code: "NOT_FOUND",
          message: `Relationship "${p.id}" not found`,
        });
        return;
      }
      respond(true, relationship);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "systems.relationships.delete": async ({ params, respond }) => {
    try {
      const { id } = params as { id: string };
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const deleted = getStore().deleteRelationship(id);
      if (!deleted) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Relationship "${id}" not found` });
        return;
      }
      respond(true, { deleted: true, id });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // REVIEWS
  // ═══════════════════════════════════════════════════════════════

  "systems.reviews.list": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as ReviewListParams;
      const reviews = getStore().listReviews(p);
      respond(true, reviews);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "systems.reviews.get": async ({ params, respond }) => {
    try {
      const { id } = params as { id: string };
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const review = getStore().getReview(id);
      if (!review) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Review "${id}" not found` });
        return;
      }
      respond(true, review);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "systems.reviews.create": async ({ params, respond }) => {
    try {
      const p = params as unknown as ReviewCreateParams;
      const validTypes = ["daily", "weekly", "monthly"];
      if (!p.type || !validTypes.includes(p.type) || typeof p.date !== "number") {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: `type (one of: ${validTypes.join(", ")}) and date (timestamp) are required`,
        });
        return;
      }
      const review = getStore().createReview({
        ...p,
        priorityProgress: p.priorityProgress ?? [],
        reflections: p.reflections ?? "",
        wins: p.wins ?? [],
        challenges: p.challenges ?? [],
        nextActions: p.nextActions ?? [],
      });
      respond(true, review);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "systems.reviews.delete": async ({ params, respond }) => {
    try {
      const { id } = params as { id: string };
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const deleted = getStore().deleteReview(id);
      if (!deleted) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Review "${id}" not found` });
        return;
      }
      respond(true, { deleted: true, id });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // INSIGHTS (generated dynamically, not stored)
  // ═══════════════════════════════════════════════════════════════

  "systems.insights.list": async ({ respond }) => {
    try {
      // Generate insights based on current system state
      const store = getStore();
      const values = store.listValues();
      const priorities = store.listPriorities();
      const relationships = store.listRelationships();
      const insights: any[] = [];
      const now = Date.now();

      // Check for values without priorities
      for (const value of values) {
        const linkedPriorities = priorities.filter(
          (p) => Array.isArray(p.valueIds) && p.valueIds.includes(value.id),
        );
        if (linkedPriorities.length === 0) {
          insights.push({
            id: `insight-no-priority-${value.id}`,
            type: "warning",
            title: `Value "${value.name}" has no linked priorities`,
            description: "Consider creating priorities that support this value.",
            severity: "medium",
            relatedIds: [value.id],
            actionable: true,
            action: "Create a priority linked to this value",
            createdAt: now,
          });
        }
      }

      // Check for stalled priorities
      for (const priority of priorities) {
        if (priority.status === "active" && priority.progress < 20) {
          const daysSinceUpdate = (now - priority.updatedAt) / (1000 * 60 * 60 * 24);
          if (daysSinceUpdate > 7) {
            insights.push({
              id: `insight-stalled-${priority.id}`,
              type: "warning",
              title: `Priority "${priority.title}" may be stalled`,
              description: `No progress in ${Math.floor(daysSinceUpdate)} days.`,
              severity: "high",
              relatedIds: [priority.id],
              actionable: true,
              action: "Review and update this priority",
              createdAt: now,
            });
          }
        }
      }

      // Check for well-aligned priorities
      for (const priority of priorities) {
        if (priority.status === "active" && priority.progress >= 70) {
          insights.push({
            id: `insight-aligned-${priority.id}`,
            type: "alignment",
            title: `Great progress on "${priority.title}"!`,
            description: `${priority.progress}% complete.`,
            severity: "info",
            relatedIds: [priority.id],
            actionable: false,
            createdAt: now,
          });
        }
      }

      respond(true, insights);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "systems.insights.generate": async ({ respond }) => {
    // Same as list - insights are generated dynamically
    try {
      const store = getStore();
      const values = store.listValues();
      const priorities = store.listPriorities();
      const insights: any[] = [];
      const now = Date.now();

      for (const value of values) {
        const linkedPriorities = priorities.filter(
          (p) => Array.isArray(p.valueIds) && p.valueIds.includes(value.id),
        );
        if (linkedPriorities.length === 0) {
          insights.push({
            id: `insight-no-priority-${value.id}`,
            type: "warning",
            title: `Value "${value.name}" has no linked priorities`,
            description: "Consider creating priorities that support this value.",
            severity: "medium",
            relatedIds: [value.id],
            actionable: true,
            createdAt: now,
          });
        }
      }

      respond(true, insights);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "systems.insights.dismiss": async ({ params, respond }) => {
    // Insights are generated dynamically, dismiss is a no-op
    respond(true, { ok: true, id: params.id });
  },

  // ═══════════════════════════════════════════════════════════════
  // SYSTEM GRAPH
  // ═══════════════════════════════════════════════════════════════

  "systems.graph.get": async ({ params, respond }) => {
    try {
      const graph = getStore().getSystemGraph();
      respond(true, graph);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // UNIFIED SYSTEMS MAP - Aggregate all data sources
  // ═══════════════════════════════════════════════════════════════

  "systems.map.aggregate": async ({ params, respond, context }) => {
    try {
      const store = getStore();

      // Get core systems intelligence data
      const values = store.listValues();
      const goals = store.listGoals();
      const priorities = store.listPriorities();
      const relationships = store.listRelationships();

      // Build nodes array with different types
      const nodes: Array<{
        id: string;
        type: "value" | "goal" | "priority" | "project" | "task" | "note" | "income";
        label: string;
        description?: string;
        status?: string;
        progress?: number;
        color?: string;
        weight?: number;
        timeframe?: string;
        metadata?: Record<string, any>;
      }> = [];

      // Build links array for relationships
      const links: Array<{
        source: string;
        target: string;
        type: string;
        strength?: number;
      }> = [];

      // 1. Add Values (core anchors - top of the graph)
      for (const value of values) {
        const v = value as any;
        nodes.push({
          id: `value:${value.id}`,
          type: "value",
          label: value.name,
          description: value.description,
          color: value.color || "#6366f1",
          weight: v.weight ?? 5,
          metadata: { category: v.category || "core", indicators: value.indicators },
        });
      }

      // 2. Add Goals and link to values
      for (const goal of goals) {
        const timeframeColors: Record<string, string> = {
          life: "#ff6b6b", // Red for life goals
          long: "#f59e0b", // Orange for long-term (5+ years)
          medium: "#8b5cf6", // Purple for medium (1-5 years)
          short: "#06b6d4", // Cyan for short-term (<1 year)
        };

        nodes.push({
          id: `goal:${goal.id}`,
          type: "goal",
          label: goal.title,
          description: goal.description,
          status: goal.status,
          progress: goal.progress,
          timeframe: goal.timeframe,
          color: goal.color || timeframeColors[goal.timeframe] || "#8b5cf6",
          metadata: {
            timeframe: goal.timeframe,
            targetDate: goal.targetDate,
            milestones: goal.milestones,
          },
        });

        // Link goal to values
        const valueIds = Array.isArray(goal.valueIds)
          ? goal.valueIds
          : typeof goal.valueIds === "string"
            ? JSON.parse(goal.valueIds || "[]")
            : [];
        for (const valueId of valueIds) {
          links.push({
            source: `value:${valueId}`,
            target: `goal:${goal.id}`,
            type: "enables",
            strength: 0.9,
          });
        }
      }

      // 3. Add Priorities and link to values and goals
      for (const priority of priorities) {
        nodes.push({
          id: `priority:${priority.id}`,
          type: "priority",
          label: priority.title,
          description: priority.description,
          status: priority.status,
          progress: priority.progress,
          color: "#D4AF37",
          metadata: { quarter: priority.quarter, rank: priority.rank },
        });

        // Link priority to values
        const valueIds = Array.isArray(priority.valueIds)
          ? priority.valueIds
          : typeof priority.valueIds === "string"
            ? JSON.parse(priority.valueIds || "[]")
            : [];
        for (const valueId of valueIds) {
          links.push({
            source: `value:${valueId}`,
            target: `priority:${priority.id}`,
            type: "supports",
            strength: 0.8,
          });
        }

        // Link priority to goals
        const goalIds = (priority as any).goalIds
          ? Array.isArray((priority as any).goalIds)
            ? (priority as any).goalIds
            : JSON.parse((priority as any).goalIds || "[]")
          : [];
        for (const goalId of goalIds) {
          links.push({
            source: `goal:${goalId}`,
            target: `priority:${priority.id}`,
            type: "implements",
            strength: 0.85,
          });
        }
      }

      // 3. Get kanban projects and tasks directly from store
      try {
        const { getKanbanStore } = await import("../../tasks/store.js");
        const path = await import("node:path");
        const stateDir = process.env.INFINIBOT_STATE_DIR ?? "state";
        const kanbanStore = getKanbanStore(path.resolve(stateDir));

        const projectsResult = await kanbanStore.getProjects();
        for (const project of projectsResult) {
          nodes.push({
            id: `project:${project.id}`,
            type: "project",
            label: project.name || "Unnamed Project",
            description: project.description,
            status: project.status,
            color: "#22c55e",
            metadata: {
              id: project.id, // Local kanban ID
              notionPageId: (project as any).notionPageId, // Notion page ID if synced
              notionId: project.notionId, // Legacy
            },
          });

          // Auto-detect priority relationships by name matching
          for (const priority of priorities) {
            const pTitle = priority.title.toLowerCase();
            const projName = (project.name || "").toLowerCase();
            if (projName.includes(pTitle) || pTitle.includes(projName)) {
              links.push({
                source: `priority:${priority.id}`,
                target: `project:${project.id}`,
                type: "implements",
                strength: 0.7,
              });
            }
          }
        }

        const tasksResult = await kanbanStore.getTasks();
        for (const task of tasksResult) {
          // Only include active/in-progress tasks to reduce noise
          if (task.status === "done" && !(params as any)?.includeDone) continue;

          nodes.push({
            id: `task:${task.id}`,
            type: "task",
            label: task.title,
            description: task.description,
            status: task.status,
            progress: task.done ? 100 : 0,
            color: task.done ? "#94a3b8" : "#3b82f6",
            metadata: {
              id: task.id, // Local kanban ID
              notionPageId: (task as any).notionPageId, // Notion page ID if synced
              projectId: task.projectId,
              priority: task.priority,
              assignee: task.assignee,
            },
          });

          // Link task to project
          if (task.projectId) {
            links.push({
              source: `project:${task.projectId}`,
              target: `task:${task.id}`,
              type: "contains",
              strength: 0.5,
            });
          }
        }
      } catch (e) {
        // Kanban data not available, continue without it
        console.warn("[systems.map.aggregate] Kanban data unavailable:", e);
      }

      // 4. Get notes directly from store
      try {
        const { NoteStore } = await import("../../notes/store.js");
        const stateDir = process.env.INFINIBOT_STATE_DIR ?? "state";
        const notesStore = new NoteStore(stateDir);

        const notesResult = notesStore.list({});
        for (const note of notesResult) {
          nodes.push({
            id: `note:${note.id}`,
            type: "note",
            label: note.name || "Untitled Note",
            description: note.description,
            color: "#a855f7",
            metadata: { category: note.category, tags: note.tags },
          });

          // Auto-detect relationships by tag/category matching
          for (const priority of priorities) {
            const pTitle = priority.title.toLowerCase();
            const noteName = (note.name || "").toLowerCase();
            const noteTags = Array.isArray(note.tags)
              ? note.tags.join(" ").toLowerCase()
              : (note.tags || "").toLowerCase();
            if (noteName.includes(pTitle) || noteTags.includes(pTitle)) {
              links.push({
                source: `priority:${priority.id}`,
                target: `note:${note.id}`,
                type: "references",
                strength: 0.4,
              });
            }
          }
        }
      } catch (e) {
        console.warn("[systems.map.aggregate] Notes data unavailable:", e);
      }

      // 5. Get business income streams from file
      try {
        const fs = await import("node:fs");
        const path = await import("node:path");
        const stateDir = process.env.INFINIBOT_STATE_DIR ?? "state";
        const incomePath = path.join(stateDir, "business", "income.json");

        if (fs.existsSync(incomePath)) {
          const incomeData = JSON.parse(fs.readFileSync(incomePath, "utf-8"));
          const streams = incomeData.streams || [];

          for (const stream of streams) {
            nodes.push({
              id: `income:${stream.id}`,
              type: "income",
              label: stream.name,
              description: stream.description,
              color: "#f59e0b",
              metadata: {
                platform: stream.platform,
                type: stream.type,
                monthlyAmount: stream.monthlyAmount,
              },
            });

            // Link income to "Financial Freedom" or similar values
            for (const value of values) {
              const vName = value.name.toLowerCase();
              if (
                vName.includes("financial") ||
                vName.includes("freedom") ||
                vName.includes("wealth") ||
                vName.includes("autonomy")
              ) {
                links.push({
                  source: `value:${value.id}`,
                  target: `income:${stream.id}`,
                  type: "enables",
                  strength: 0.6,
                });
              }
            }
          }
        }
      } catch (e) {
        console.warn("[systems.map.aggregate] Business data unavailable:", e);
      }

      // 6. Add explicit relationships from systems-intelligence
      for (const rel of relationships) {
        links.push({
          source: rel.sourceId,
          target: rel.targetId,
          type: rel.type,
          strength: rel.strength ?? 0.5,
        });
      }

      // 7. Generate suggestions (flashlight → laser) with goal-aware focus algorithm
      const suggestions: Array<{
        type: "focus" | "align" | "connect" | "prune" | "goal";
        title: string;
        description: string;
        priority: "high" | "medium" | "low";
        actionableIds: string[];
      }> = [];

      // Find orphan nodes (not connected to values or goals)
      const connectedToValueOrGoal = new Set<string>();
      for (const link of links) {
        if (link.source.startsWith("value:") || link.source.startsWith("goal:")) {
          connectedToValueOrGoal.add(link.target);
        }
      }
      // Trace connections transitively
      let changed = true;
      while (changed) {
        changed = false;
        for (const link of links) {
          if (connectedToValueOrGoal.has(link.source) && !connectedToValueOrGoal.has(link.target)) {
            connectedToValueOrGoal.add(link.target);
            changed = true;
          }
        }
      }

      const orphanNodes = nodes.filter(
        (n) => n.type !== "value" && n.type !== "goal" && !connectedToValueOrGoal.has(n.id),
      );
      if (orphanNodes.length > 0) {
        suggestions.push({
          type: "align",
          title: `${orphanNodes.length} items not aligned to values/goals`,
          description: `Unconnected: ${orphanNodes
            .slice(0, 3)
            .map((n) => n.label)
            .join(", ")}${orphanNodes.length > 3 ? "..." : ""}. Link them or archive.`,
          priority: orphanNodes.length > 5 ? "high" : "medium",
          actionableIds: orphanNodes.map((n) => n.id),
        });
      }

      // Find goals without progress (stalled goals)
      const stalledGoals = goals.filter(
        (g) =>
          g.status === "active" &&
          g.progress < 10 &&
          Date.now() - g.createdAt > 30 * 24 * 60 * 60 * 1000, // Older than 30 days
      );
      if (stalledGoals.length > 0) {
        suggestions.push({
          type: "goal",
          title: `${stalledGoals.length} goals need attention`,
          description: `Stalled goals: ${stalledGoals.map((g) => g.title).join(", ")}. Create priorities or break into milestones.`,
          priority: "high",
          actionableIds: stalledGoals.map((g) => `goal:${g.id}`),
        });
      }

      // Find goals without linked priorities (no execution plan)
      const goalsWithPriorities = new Set(
        links
          .filter((l) => l.type === "implements" && l.source.startsWith("goal:"))
          .map((l) => l.source),
      );
      const unexecutedGoals = goals.filter(
        (g) => g.status === "active" && !goalsWithPriorities.has(`goal:${g.id}`),
      );
      if (unexecutedGoals.length > 0) {
        suggestions.push({
          type: "goal",
          title: `${unexecutedGoals.length} goals need priorities`,
          description: `Create quarterly priorities for: ${unexecutedGoals.map((g) => g.title).join(", ")}`,
          priority: "high",
          actionableIds: unexecutedGoals.map((g) => `goal:${g.id}`),
        });
      }

      // Find values without goals (values need long-term vision)
      const valuesWithGoals = new Set(
        links
          .filter((l) => l.type === "enables" && l.target.startsWith("goal:"))
          .map((l) => l.source),
      );
      const valuesNeedingGoals = values.filter((v) => !valuesWithGoals.has(`value:${v.id}`));
      if (valuesNeedingGoals.length > 0) {
        suggestions.push({
          type: "focus",
          title: `${valuesNeedingGoals.length} values lack long-term goals`,
          description: `Create goals for: ${valuesNeedingGoals.map((v) => v.name).join(", ")}`,
          priority: "medium",
          actionableIds: valuesNeedingGoals.map((v) => `value:${v.id}`),
        });
      }

      // Find values without priorities (no active work)
      const valuesWithPriorities = new Set(
        links.filter((l) => l.type === "supports").map((l) => l.source),
      );
      const unservedValues = values.filter((v) => !valuesWithPriorities.has(`value:${v.id}`));
      if (unservedValues.length > 0) {
        suggestions.push({
          type: "focus",
          title: `${unservedValues.length} values without active priorities`,
          description: `Create priorities to serve: ${unservedValues.map((v) => v.name).join(", ")}`,
          priority: "high",
          actionableIds: unservedValues.map((v) => `value:${v.id}`),
        });
      }

      // Find overloaded priorities (too many tasks)
      const taskCountByPriority: Record<string, number> = {};
      for (const link of links) {
        if (link.type === "implements" || link.type === "contains") {
          const priorityId = link.source;
          taskCountByPriority[priorityId] = (taskCountByPriority[priorityId] || 0) + 1;
        }
      }
      for (const [priorityId, count] of Object.entries(taskCountByPriority)) {
        if (count > 10) {
          const priority = nodes.find((n) => n.id === priorityId);
          suggestions.push({
            type: "focus",
            title: `Priority "${priority?.label}" may be overloaded`,
            description: `${count} connected items. Consider breaking into sub-priorities.`,
            priority: "medium",
            actionableIds: [priorityId],
          });
        }
      }

      // Prioritize suggestions: goal-related first, then alignment, then focus
      suggestions.sort((a, b) => {
        const typeOrder = { goal: 0, align: 1, focus: 2, connect: 3, prune: 4 };
        const priorityOrder = { high: 0, medium: 1, low: 2 };
        const typeCompare = (typeOrder[a.type] ?? 5) - (typeOrder[b.type] ?? 5);
        if (typeCompare !== 0) return typeCompare;
        return (priorityOrder[a.priority] ?? 3) - (priorityOrder[b.priority] ?? 3);
      });

      // Calculate alignment score (now includes goals in the hierarchy)
      const totalNodes = nodes.filter((n) => n.type !== "value" && n.type !== "goal").length;
      const alignedNodes = [...connectedToValueOrGoal].filter(
        (id) => !id.startsWith("value:") && !id.startsWith("goal:"),
      ).length;
      const alignmentScore = totalNodes > 0 ? Math.round((alignedNodes / totalNodes) * 100) : 100;

      respond(true, {
        nodes,
        links,
        suggestions,
        stats: {
          totalNodes: nodes.length,
          totalLinks: links.length,
          alignmentScore,
          byType: {
            value: values.length,
            goal: goals.length,
            priority: priorities.length,
            project: nodes.filter((n) => n.type === "project").length,
            task: nodes.filter((n) => n.type === "task").length,
            note: nodes.filter((n) => n.type === "note").length,
            income: nodes.filter((n) => n.type === "income").length,
          },
        },
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // AUTO-LINKING - Smart connection of orphan nodes
  // ═══════════════════════════════════════════════════════════════

  "systems.nodes.position": async ({ params, respond }) => {
    try {
      const { id, x, y } = params as { id: string; x: number; y: number };
      if (!id || typeof x !== "number" || typeof y !== "number") {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "id, x, and y are required",
        });
        return;
      }
      const success = getStore().updateNodePosition(id, x, y);
      respond(true, { success, id, x, y });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "systems.nodes.positions": async ({ params, respond }) => {
    try {
      const { positions } = params as { positions: Array<{ id: string; x: number; y: number }> };
      if (!Array.isArray(positions)) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "positions array is required",
        });
        return;
      }
      const updated = getStore().updateNodePositions(positions);
      respond(true, { updated, total: positions.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "systems.autolink.orphans": async ({ params, respond }) => {
    try {
      const store = getStore();
      const p = params as { minScore?: number; dryRun?: boolean; nodeTypes?: string[] };

      const result = store.autoLinkOrphans({
        minScore: p.minScore ?? 0.15,
        dryRun: p.dryRun ?? false,
        nodeTypes: p.nodeTypes,
      });

      respond(true, {
        ...result,
        summary: {
          orphansFound: result.linked.length + result.unmatched.length,
          linked: result.linked.length,
          unmatched: result.unmatched.length,
          dryRun: p.dryRun ?? false,
        },
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "systems.autolink.preview": async ({ params, respond }) => {
    try {
      const store = getStore();
      const p = params as { minScore?: number; nodeTypes?: string[] };

      // Always dry run for preview
      const result = store.autoLinkOrphans({
        minScore: p.minScore ?? 0.15,
        dryRun: true,
        nodeTypes: p.nodeTypes,
      });

      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "systems.autolink.suggestions": async ({ params, respond }) => {
    try {
      const store = getStore();
      const { nodeId, limit } = params as { nodeId: string; limit?: number };

      if (!nodeId) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "nodeId is required" });
        return;
      }

      const suggestions = store.getSuggestionsForNode(nodeId, limit ?? 5);
      respond(true, { nodeId, suggestions });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "systems.orphans.list": async ({ params, respond }) => {
    try {
      const store = getStore();
      const orphans = store.findOrphanNodes();

      respond(true, {
        orphans,
        count: orphans.length,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};
