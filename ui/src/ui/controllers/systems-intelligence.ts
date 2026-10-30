/**
 * Systems Intelligence Controller
 * 
 * Manages state and data operations for the Systems Intelligence feature.
 * Handles values, priorities, system nodes, relationships, reviews, and insights.
 */

import type { AppViewState } from "../app-view-state";

// ══════════════════════════════════════════════════════════════════════════════
// TYPES
// ══════════════════════════════════════════════════════════════════════════════

export type SystemsView = "values" | "goals" | "priorities" | "map" | "reviews" | "insights";

export interface SystemValue {
  id: string;
  name: string;
  description: string;
  category: "core" | "growth" | "operational" | "relational";
  weight: number; // 1-10 importance
  color: string;
  icon?: string;
  linkedPriorities: string[];
  createdAt: number;
  updatedAt: number;
}

export type GoalTimeframe = "life" | "long" | "medium" | "short";
export type GoalStatus = "active" | "achieved" | "paused" | "abandoned";

export interface GoalMilestone {
  id: string;
  title: string;
  targetDate?: number;
  completed: boolean;
  completedAt?: number;
}

export interface SystemGoal {
  id: string;
  title: string;
  description: string;
  timeframe: GoalTimeframe;
  targetDate?: number;
  linkedValues: string[];
  milestones: GoalMilestone[];
  progress: number; // 0-100
  status: GoalStatus;
  color?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SystemPriority {
  id: string;
  title: string;
  description: string;
  status: "active" | "paused" | "completed" | "abandoned";
  progress: number; // 0-100
  targetDate?: string;
  linkedValues: string[];
  linkedGoals: string[];
  milestones: PriorityMilestone[];
  createdAt: number;
  updatedAt: number;
}

export interface PriorityMilestone {
  id: string;
  title: string;
  completed: boolean;
  completedAt?: number;
}

export interface SystemNode {
  id: string;
  label: string;
  type: "value" | "priority" | "goal" | "project" | "habit" | "belief";
  x?: number;
  y?: number;
  color?: string;
  size?: number;
  metadata?: Record<string, unknown>;
}

export interface SystemRelationship {
  id: string;
  sourceId: string;
  targetId: string;
  type: "supports" | "conflicts" | "requires" | "enables" | "blocks";
  strength: number; // 1-10
  description?: string;
}

export interface SystemReview {
  id: string;
  type: "daily" | "weekly" | "monthly" | "quarterly" | "yearly";
  date: string;
  reflections: string;
  alignmentScore: number; // 0-100
  highlights: string[];
  challenges: string[];
  adjustments: string[];
  createdAt: number;
}

export interface SystemInsight {
  id: string;
  type: "alignment" | "conflict" | "opportunity" | "warning" | "suggestion";
  title: string;
  description: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  relatedIds: string[]; // IDs of related values/priorities
  actionable: boolean;
  action?: string;
  createdAt: number;
  dismissedAt?: number;
}

export interface SystemsIntelligenceState {
  // Navigation
  currentView: SystemsView;
  
  // Data
  values: SystemValue[];
  goals: SystemGoal[];
  priorities: SystemPriority[];
  nodes: SystemNode[];
  relationships: SystemRelationship[];
  reviews: SystemReview[];
  insights: SystemInsight[];
  
  // Loading states
  loading: boolean;
  valuesLoading: boolean;
  goalsLoading: boolean;
  prioritiesLoading: boolean;
  nodesLoading: boolean;
  reviewsLoading: boolean;
  insightsLoading: boolean;
  
  // UI state
  error: string | null;
  selectedValueId: string | null;
  selectedGoalId: string | null;
  selectedPriorityId: string | null;
  selectedNodeId: string | null;
  selectedReviewId: string | null;
  
  // Modals
  showValueModal: boolean;
  showGoalModal: boolean;
  showPriorityModal: boolean;
  showReviewModal: boolean;
  editingValue: SystemValue | null;
  editingGoal: SystemGoal | null;
  editingPriority: SystemPriority | null;
  
  // Computed
  alignmentScore: number; // Overall alignment score 0-100
  lastSyncAt: number | null;
}

// ══════════════════════════════════════════════════════════════════════════════
// STATE FACTORY
// ══════════════════════════════════════════════════════════════════════════════

export function createSystemsIntelligenceState(): SystemsIntelligenceState {
  return {
    currentView: "values",
    values: [],
    goals: [],
    priorities: [],
    nodes: [],
    relationships: [],
    reviews: [],
    insights: [],
    loading: false,
    valuesLoading: false,
    goalsLoading: false,
    prioritiesLoading: false,
    nodesLoading: false,
    reviewsLoading: false,
    insightsLoading: false,
    error: null,
    selectedValueId: null,
    selectedGoalId: null,
    selectedPriorityId: null,
    selectedNodeId: null,
    selectedReviewId: null,
    showValueModal: false,
    showGoalModal: false,
    showPriorityModal: false,
    showReviewModal: false,
    editingValue: null,
    editingGoal: null,
    editingPriority: null,
    alignmentScore: 0,
    lastSyncAt: null,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// GATEWAY CALLS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Load all systems intelligence data
 */
export async function loadAll(
  client: any,
  state: SystemsIntelligenceState,
  onUpdate: () => void
): Promise<void> {
  state.loading = true;
  state.error = null;
  onUpdate();
  
  try {
    const [values, goals, priorities, nodes, relationships, reviews, insights] = await Promise.all([
      client.request("systems.values.list", {}) as Promise<SystemValue[]>,
      client.request("systems.goals.list", {}) as Promise<SystemGoal[]>,
      client.request("systems.priorities.list", {}) as Promise<SystemPriority[]>,
      client.request("systems.nodes.list", {}) as Promise<SystemNode[]>,
      client.request("systems.relationships.list", {}) as Promise<SystemRelationship[]>,
      client.request("systems.reviews.list", {}) as Promise<SystemReview[]>,
      client.request("systems.insights.list", {}) as Promise<SystemInsight[]>,
    ]);
    
    state.values = values || [];
    state.goals = goals || [];
    state.priorities = priorities || [];
    state.nodes = nodes || [];
    state.relationships = relationships || [];
    state.reviews = reviews || [];
    state.insights = insights || [];
    state.alignmentScore = calculateAlignment(state);
    state.lastSyncAt = Date.now();
  } catch (err: any) {
    console.error("[SystemsIntelligence] Load failed:", err);
    state.error = err.message || "Failed to load systems data";
    // Initialize with empty data on failure
    state.values = [];
    state.goals = [];
    state.priorities = [];
    state.nodes = [];
    state.relationships = [];
    state.reviews = [];
    state.insights = [];
  }
  
  state.loading = false;
  onUpdate();
}

// ── Values CRUD ──────────────────────────────────────────────────────────────

export async function createValue(
  client: any,
  state: SystemsIntelligenceState,
  value: Partial<SystemValue>,
  onUpdate: () => void
): Promise<SystemValue | null> {
  state.valuesLoading = true;
  onUpdate();
  
  try {
    const newValue = await client.request("systems.values.create", value) as SystemValue | null;
    if (newValue) {
      state.values = [...state.values, newValue];
      state.alignmentScore = calculateAlignment(state);
    }
    state.valuesLoading = false;
    onUpdate();
    return newValue;
  } catch (err: any) {
    state.error = err.message || "Failed to create value";
    state.valuesLoading = false;
    onUpdate();
    return null;
  }
}

export async function updateValue(
  client: any,
  state: SystemsIntelligenceState,
  id: string,
  patch: Partial<SystemValue>,
  onUpdate: () => void
): Promise<boolean> {
  state.valuesLoading = true;
  onUpdate();
  
  try {
    await client.request("systems.values.update", { id, ...patch });
    state.values = state.values.map(v => v.id === id ? { ...v, ...patch, updatedAt: Date.now() } : v);
    state.alignmentScore = calculateAlignment(state);
    state.valuesLoading = false;
    onUpdate();
    return true;
  } catch (err: any) {
    state.error = err.message || "Failed to update value";
    state.valuesLoading = false;
    onUpdate();
    return false;
  }
}

export async function deleteValue(
  client: any,
  state: SystemsIntelligenceState,
  id: string,
  onUpdate: () => void
): Promise<boolean> {
  state.valuesLoading = true;
  onUpdate();
  
  try {
    await client.request("systems.values.delete", { id });
    state.values = state.values.filter(v => v.id !== id);
    state.alignmentScore = calculateAlignment(state);
    state.valuesLoading = false;
    onUpdate();
    return true;
  } catch (err: any) {
    state.error = err.message || "Failed to delete value";
    state.valuesLoading = false;
    onUpdate();
    return false;
  }
}

// ── Goals CRUD ───────────────────────────────────────────────────────────────

export async function createGoal(
  client: any,
  state: SystemsIntelligenceState,
  goal: Partial<SystemGoal>,
  onUpdate: () => void
): Promise<SystemGoal | null> {
  state.goalsLoading = true;
  onUpdate();
  
  try {
    const newGoal = await client.request("systems.goals.create", goal) as SystemGoal | null;
    if (newGoal) {
      state.goals = [...state.goals, newGoal];
      state.alignmentScore = calculateAlignment(state);
    }
    state.goalsLoading = false;
    onUpdate();
    return newGoal;
  } catch (err: any) {
    state.error = err.message || "Failed to create goal";
    state.goalsLoading = false;
    onUpdate();
    return null;
  }
}

export async function updateGoal(
  client: any,
  state: SystemsIntelligenceState,
  id: string,
  patch: Partial<SystemGoal>,
  onUpdate: () => void
): Promise<boolean> {
  state.goalsLoading = true;
  onUpdate();
  
  try {
    await client.request("systems.goals.update", { id, ...patch });
    state.goals = state.goals.map(g => g.id === id ? { ...g, ...patch, updatedAt: Date.now() } : g);
    state.alignmentScore = calculateAlignment(state);
    state.goalsLoading = false;
    onUpdate();
    return true;
  } catch (err: any) {
    state.error = err.message || "Failed to update goal";
    state.goalsLoading = false;
    onUpdate();
    return false;
  }
}

export async function deleteGoal(
  client: any,
  state: SystemsIntelligenceState,
  id: string,
  onUpdate: () => void
): Promise<boolean> {
  state.goalsLoading = true;
  onUpdate();
  
  try {
    await client.request("systems.goals.delete", { id });
    state.goals = state.goals.filter(g => g.id !== id);
    state.alignmentScore = calculateAlignment(state);
    state.goalsLoading = false;
    onUpdate();
    return true;
  } catch (err: any) {
    state.error = err.message || "Failed to delete goal";
    state.goalsLoading = false;
    onUpdate();
    return false;
  }
}

// ── Priorities CRUD ──────────────────────────────────────────────────────────

export async function createPriority(
  client: any,
  state: SystemsIntelligenceState,
  priority: Partial<SystemPriority>,
  onUpdate: () => void
): Promise<SystemPriority | null> {
  state.prioritiesLoading = true;
  onUpdate();
  
  try {
    const newPriority = await client.request("systems.priorities.create", priority) as SystemPriority | null;
    if (newPriority) {
      state.priorities = [...state.priorities, newPriority];
      state.alignmentScore = calculateAlignment(state);
    }
    state.prioritiesLoading = false;
    onUpdate();
    return newPriority;
  } catch (err: any) {
    state.error = err.message || "Failed to create priority";
    state.prioritiesLoading = false;
    onUpdate();
    return null;
  }
}

export async function updatePriority(
  client: any,
  state: SystemsIntelligenceState,
  id: string,
  patch: Partial<SystemPriority>,
  onUpdate: () => void
): Promise<boolean> {
  state.prioritiesLoading = true;
  onUpdate();
  
  try {
    await client.request("systems.priorities.update", { id, ...patch });
    state.priorities = state.priorities.map(p => p.id === id ? { ...p, ...patch, updatedAt: Date.now() } : p);
    state.alignmentScore = calculateAlignment(state);
    state.prioritiesLoading = false;
    onUpdate();
    return true;
  } catch (err: any) {
    state.error = err.message || "Failed to update priority";
    state.prioritiesLoading = false;
    onUpdate();
    return false;
  }
}

export async function deletePriority(
  client: any,
  state: SystemsIntelligenceState,
  id: string,
  onUpdate: () => void
): Promise<boolean> {
  state.prioritiesLoading = true;
  onUpdate();
  
  try {
    await client.request("systems.priorities.delete", { id });
    state.priorities = state.priorities.filter(p => p.id !== id);
    state.alignmentScore = calculateAlignment(state);
    state.prioritiesLoading = false;
    onUpdate();
    return true;
  } catch (err: any) {
    state.error = err.message || "Failed to delete priority";
    state.prioritiesLoading = false;
    onUpdate();
    return false;
  }
}

// ── Reviews CRUD ─────────────────────────────────────────────────────────────

export async function createReview(
  client: any,
  state: SystemsIntelligenceState,
  review: Partial<SystemReview>,
  onUpdate: () => void
): Promise<SystemReview | null> {
  state.reviewsLoading = true;
  onUpdate();
  
  try {
    const newReview = await client.request("systems.reviews.create", review) as SystemReview | null;
    if (newReview) {
      state.reviews = [newReview, ...state.reviews];
    }
    state.reviewsLoading = false;
    onUpdate();
    return newReview;
  } catch (err: any) {
    state.error = err.message || "Failed to create review";
    state.reviewsLoading = false;
    onUpdate();
    return null;
  }
}

export async function deleteReview(
  client: any,
  state: SystemsIntelligenceState,
  id: string,
  onUpdate: () => void
): Promise<boolean> {
  state.reviewsLoading = true;
  onUpdate();
  
  try {
    await client.request("systems.reviews.delete", { id });
    state.reviews = state.reviews.filter(r => r.id !== id);
    state.reviewsLoading = false;
    onUpdate();
    return true;
  } catch (err: any) {
    state.error = err.message || "Failed to delete review";
    state.reviewsLoading = false;
    onUpdate();
    return false;
  }
}

// ── Insights ─────────────────────────────────────────────────────────────────

export async function generateInsights(
  client: any,
  state: SystemsIntelligenceState,
  onUpdate: () => void
): Promise<void> {
  state.insightsLoading = true;
  onUpdate();
  
  try {
    const insights = await client.request("systems.insights.generate", {
      values: state.values,
      priorities: state.priorities,
      relationships: state.relationships,
    }) as SystemInsight[] | null;
    state.insights = insights || [];
  } catch (err: any) {
    state.error = err.message || "Failed to generate insights";
  }
  
  state.insightsLoading = false;
  onUpdate();
}

export async function dismissInsight(
  client: any,
  state: SystemsIntelligenceState,
  id: string,
  onUpdate: () => void
): Promise<void> {
  try {
    await client.request("systems.insights.dismiss", { id });
    state.insights = state.insights.map(i => 
      i.id === id ? { ...i, dismissedAt: Date.now() } : i
    );
    onUpdate();
  } catch (err: any) {
    state.error = err.message || "Failed to dismiss insight";
    onUpdate();
  }
}

// ── Graph/Map ────────────────────────────────────────────────────────────────

export async function createNode(
  client: any,
  state: SystemsIntelligenceState,
  node: Partial<SystemNode>,
  onUpdate: () => void
): Promise<SystemNode | null> {
  state.nodesLoading = true;
  onUpdate();
  
  try {
    const newNode = await client.request("systems.nodes.create", node) as SystemNode | null;
    if (newNode) {
      state.nodes = [...state.nodes, newNode];
    }
    state.nodesLoading = false;
    onUpdate();
    return newNode;
  } catch (err: any) {
    state.error = err.message || "Failed to create node";
    state.nodesLoading = false;
    onUpdate();
    return null;
  }
}

export async function createRelationship(
  client: any,
  state: SystemsIntelligenceState,
  relationship: Partial<SystemRelationship>,
  onUpdate: () => void
): Promise<SystemRelationship | null> {
  try {
    const newRel = await client.request("systems.relationships.create", relationship) as SystemRelationship | null;
    if (newRel) {
      state.relationships = [...state.relationships, newRel];
      onUpdate();
    }
    return newRel;
  } catch (err: any) {
    state.error = err.message || "Failed to create relationship";
    onUpdate();
    return null;
  }
}

export async function deleteRelationship(
  client: any,
  state: SystemsIntelligenceState,
  id: string,
  onUpdate: () => void
): Promise<boolean> {
  try {
    await client.request("systems.relationships.delete", { id });
    state.relationships = state.relationships.filter(r => r.id !== id);
    onUpdate();
    return true;
  } catch (err: any) {
    state.error = err.message || "Failed to delete relationship";
    onUpdate();
    return false;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// COMPUTED / HELPERS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate overall alignment score based on:
 * - How well priorities align with values
 * - Priority progress weighted by value importance
 * - Relationship health (supports vs conflicts)
 */
export function calculateAlignment(state: SystemsIntelligenceState): number {
  if (state.values.length === 0 || state.priorities.length === 0) {
    return 0;
  }
  
  let totalScore = 0;
  let totalWeight = 0;
  
  // Calculate alignment for each priority
  for (const priority of state.priorities) {
    if (priority.status === "abandoned") continue;
    
    // Get linked values and their weights
    const priorityValueIds = priority.linkedValues || (priority as any).valueIds || [];
    const linkedValues = state.values.filter(v => 
      priorityValueIds.includes(v.id)
    );
    
    if (linkedValues.length === 0) {
      // Unlinked priorities contribute less
      totalScore += priority.progress * 0.5;
      totalWeight += 10;
    } else {
      // Weight by value importance
      const valueWeight = linkedValues.reduce((sum, v) => sum + v.weight, 0);
      totalScore += priority.progress * valueWeight;
      totalWeight += valueWeight * 100;
    }
  }
  
  // Factor in relationship health
  const supports = state.relationships.filter(r => r.type === "supports" || r.type === "enables").length;
  const conflicts = state.relationships.filter(r => r.type === "conflicts" || r.type === "blocks").length;
  const relationshipHealth = supports > 0 ? (supports / (supports + conflicts)) : 0.5;
  
  const baseScore = totalWeight > 0 ? (totalScore / totalWeight) * 100 : 0;
  const adjustedScore = baseScore * (0.7 + 0.3 * relationshipHealth);
  
  return Math.round(Math.min(100, Math.max(0, adjustedScore)));
}

/**
 * Get values by category
 */
export function getValuesByCategory(state: SystemsIntelligenceState): Record<string, SystemValue[]> {
  const categories: Record<string, SystemValue[]> = {
    core: [],
    growth: [],
    operational: [],
    relational: [],
  };
  
  for (const value of state.values) {
    if (categories[value.category]) {
      categories[value.category].push(value);
    }
  }
  
  return categories;
}

/**
 * Get active insights (not dismissed)
 */
export function getActiveInsights(state: SystemsIntelligenceState): SystemInsight[] {
  return state.insights.filter(i => !i.dismissedAt);
}

/**
 * Get recent reviews
 */
export function getRecentReviews(state: SystemsIntelligenceState, limit = 5): SystemReview[] {
  return [...state.reviews]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

/**
 * Get priorities linked to a specific value
 */
export function getPrioritiesForValue(state: SystemsIntelligenceState, valueId: string): SystemPriority[] {
  return state.priorities.filter(p => {
    const values = p.linkedValues || (p as any).valueIds || [];
    return values.includes(valueId);
  });
}

/**
 * Get values linked to a specific priority
 */
export function getValuesForPriority(state: SystemsIntelligenceState, priorityId: string): SystemValue[] {
  const priority = state.priorities.find(p => p.id === priorityId);
  if (!priority) return [];
  const values = priority.linkedValues || (priority as any).valueIds || [];
  return state.values.filter(v => values.includes(v.id));
}

// ══════════════════════════════════════════════════════════════════════════════
// VIEW STATE HELPERS
// ══════════════════════════════════════════════════════════════════════════════

export function setView(
  state: SystemsIntelligenceState,
  view: SystemsView,
  onUpdate: () => void
): void {
  state.currentView = view;
  onUpdate();
}

export function openValueModal(
  state: SystemsIntelligenceState,
  value?: SystemValue,
  onUpdate?: () => void
): void {
  state.showValueModal = true;
  state.editingValue = value || null;
  onUpdate?.();
}

export function closeValueModal(
  state: SystemsIntelligenceState,
  onUpdate: () => void
): void {
  state.showValueModal = false;
  state.editingValue = null;
  onUpdate();
}

export function openGoalModal(
  state: SystemsIntelligenceState,
  goal?: SystemGoal,
  onUpdate?: () => void
): void {
  state.showGoalModal = true;
  state.editingGoal = goal || null;
  onUpdate?.();
}

export function closeGoalModal(
  state: SystemsIntelligenceState,
  onUpdate: () => void
): void {
  state.showGoalModal = false;
  state.editingGoal = null;
  onUpdate();
}

export function selectGoal(
  state: SystemsIntelligenceState,
  id: string | null,
  onUpdate: () => void
): void {
  state.selectedGoalId = id;
  onUpdate();
}

export function openPriorityModal(
  state: SystemsIntelligenceState,
  priority?: SystemPriority,
  onUpdate?: () => void
): void {
  state.showPriorityModal = true;
  state.editingPriority = priority || null;
  onUpdate?.();
}

export function closePriorityModal(
  state: SystemsIntelligenceState,
  onUpdate: () => void
): void {
  state.showPriorityModal = false;
  state.editingPriority = null;
  onUpdate();
}

export function openReviewModal(
  state: SystemsIntelligenceState,
  onUpdate: () => void
): void {
  state.showReviewModal = true;
  onUpdate();
}

export function closeReviewModal(
  state: SystemsIntelligenceState,
  onUpdate: () => void
): void {
  state.showReviewModal = false;
  onUpdate();
}

export function selectValue(
  state: SystemsIntelligenceState,
  id: string | null,
  onUpdate: () => void
): void {
  state.selectedValueId = id;
  onUpdate();
}

export function selectPriority(
  state: SystemsIntelligenceState,
  id: string | null,
  onUpdate: () => void
): void {
  state.selectedPriorityId = id;
  onUpdate();
}

export function clearError(
  state: SystemsIntelligenceState,
  onUpdate: () => void
): void {
  state.error = null;
  onUpdate();
}

// ══════════════════════════════════════════════════════════════════════════════
// VALUE CATEGORY CONFIG
// ══════════════════════════════════════════════════════════════════════════════

export const VALUE_CATEGORIES = {
  core: {
    label: "Core Values",
    description: "Fundamental beliefs that define who you are",
    color: "var(--g-primary)", // Gold
    icon: "⭐",
  },
  growth: {
    label: "Growth Values",
    description: "Values driving personal and professional development",
    color: "#10b981", // Green
    icon: "🌱",
  },
  operational: {
    label: "Operational Values",
    description: "Values guiding daily decisions and work",
    color: "#3b82f6", // Blue
    icon: "⚙️",
  },
  relational: {
    label: "Relational Values",
    description: "Values shaping relationships and interactions",
    color: "#ec4899", // Pink
    icon: "🤝",
  },
};

// ── Auto-Linking ─────────────────────────────────────────────────────────────

export interface AutoLinkResult {
  linked: Array<{
    nodeId: string;
    nodeLabel: string;
    anchorId: string;
    anchorName: string;
    anchorType: string;
    relationshipType: string;
    score: number;
  }>;
  unmatched: Array<{
    nodeId: string;
    nodeLabel: string;
    bestScore: number;
  }>;
  summary: {
    orphansFound: number;
    linked: number;
    unmatched: number;
    dryRun: boolean;
  };
}

export async function previewAutoLink(
  client: any,
  minScore?: number
): Promise<AutoLinkResult | null> {
  try {
    const result = await client.request("systems.autolink.preview", { minScore: minScore ?? 0.15 });
    return result as AutoLinkResult;
  } catch (err: any) {
    console.error("[SystemsIntelligence] Auto-link preview failed:", err);
    return null;
  }
}

export async function executeAutoLink(
  client: any,
  state: SystemsIntelligenceState,
  onUpdate: () => void,
  minScore?: number
): Promise<AutoLinkResult | null> {
  state.loading = true;
  onUpdate();
  
  try {
    const result = await client.request("systems.autolink.orphans", { 
      minScore: minScore ?? 0.15,
      dryRun: false 
    }) as AutoLinkResult;
    
    // Reload data to reflect new relationships
    await loadAll(client, state, onUpdate);
    
    return result;
  } catch (err: any) {
    console.error("[SystemsIntelligence] Auto-link failed:", err);
    state.error = err.message || "Failed to auto-link orphans";
    state.loading = false;
    onUpdate();
    return null;
  }
}

export async function getOrphanNodes(
  client: any
): Promise<SystemNode[]> {
  try {
    const result = await client.request("systems.orphans.list", {});
    return (result as any).orphans || [];
  } catch (err: any) {
    console.error("[SystemsIntelligence] Failed to get orphans:", err);
    return [];
  }
}

export async function getSuggestionsForNode(
  client: any,
  nodeId: string,
  limit?: number
): Promise<Array<{
  anchorId: string;
  anchorType: string;
  anchorName: string;
  score: number;
  relationshipType: string;
}>> {
  try {
    const result = await client.request("systems.autolink.suggestions", { nodeId, limit: limit ?? 5 });
    return (result as any).suggestions || [];
  } catch (err: any) {
    console.error("[SystemsIntelligence] Failed to get suggestions:", err);
    return [];
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ══════════════════════════════════════════════════════════════════════════════

export const GOAL_TIMEFRAMES = {
  life: { label: "Life Goal", description: "A lifelong aspiration", color: "#ff6b6b", icon: "🌟" },
  long: { label: "Long-term", description: "5+ years", color: "#f59e0b", icon: "📅" },
  medium: { label: "Medium-term", description: "1-5 years", color: "#8b5cf6", icon: "📆" },
  short: { label: "Short-term", description: "< 1 year", color: "#06b6d4", icon: "⏰" },
};

export const GOAL_STATUSES = {
  active: { label: "Active", color: "#10b981", icon: "▶" },
  achieved: { label: "Achieved", color: "var(--g-primary)", icon: "🏆" },
  paused: { label: "Paused", color: "#f59e0b", icon: "⏸" },
  abandoned: { label: "Abandoned", color: "#6b7280", icon: "✕" },
};

export const PRIORITY_STATUSES = {
  active: { label: "Active", color: "#10b981", icon: "▶" },
  paused: { label: "Paused", color: "#f59e0b", icon: "⏸" },
  completed: { label: "Completed", color: "#3b82f6", icon: "✓" },
  abandoned: { label: "Abandoned", color: "#6b7280", icon: "✕" },
};

export const REVIEW_TYPES = {
  daily: { label: "Daily Review", icon: "📅" },
  weekly: { label: "Weekly Review", icon: "📆" },
  monthly: { label: "Monthly Review", icon: "🗓" },
  quarterly: { label: "Quarterly Review", icon: "📊" },
  yearly: { label: "Yearly Review", icon: "🎯" },
};

export const INSIGHT_TYPES = {
  alignment: { label: "Alignment", color: "#10b981", icon: "✓" },
  conflict: { label: "Conflict", color: "#ef4444", icon: "⚠" },
  opportunity: { label: "Opportunity", color: "#3b82f6", icon: "💡" },
  warning: { label: "Warning", color: "#f59e0b", icon: "⚡" },
  suggestion: { label: "Suggestion", color: "#8b5cf6", icon: "💭" },
};

export const RELATIONSHIP_TYPES = {
  supports: { label: "Supports", color: "#10b981" },
  conflicts: { label: "Conflicts", color: "#ef4444" },
  requires: { label: "Requires", color: "#3b82f6" },
  enables: { label: "Enables", color: "#8b5cf6" },
  blocks: { label: "Blocks", color: "#f59e0b" },
};
