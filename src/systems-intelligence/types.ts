/**
 * Systems Intelligence Types
 * 
 * Core data types for the Systems Intelligence feature which enables
 * tracking of values, priorities, system nodes, relationships, and reviews.
 */

// ── Values ──────────────────────────────────────────────────────

export interface Value {
  id: string;
  name: string;
  description: string;
  indicators: string[];
  color: string;
  order: number;
  createdAt: number;
  updatedAt: number;
}

export type ValueCreateParams = Omit<Value, 'id' | 'createdAt' | 'updatedAt'>;
export type ValueUpdateParams = Partial<Omit<Value, 'id' | 'createdAt'>> & { id: string };

// ── Goals ───────────────────────────────────────────────────────

export type GoalTimeframe = 'short' | 'medium' | 'long' | 'life';
export type GoalStatus = 'active' | 'achieved' | 'paused' | 'abandoned';

export interface GoalMilestone {
  id: string;
  title: string;
  targetDate?: number;
  completed: boolean;
  completedAt?: number;
}

export interface Goal {
  id: string;
  title: string;
  description?: string;
  timeframe: GoalTimeframe;
  targetDate?: number;
  valueIds: string[];
  milestones: GoalMilestone[];
  progress: number;
  status: GoalStatus;
  color?: string;
  createdAt: number;
  updatedAt: number;
}

export type GoalCreateParams = Omit<Goal, 'id' | 'createdAt' | 'updatedAt'>;
export type GoalUpdateParams = Partial<Omit<Goal, 'id' | 'createdAt'>> & { id: string };

export interface GoalListParams {
  timeframe?: GoalTimeframe;
  status?: GoalStatus;
  limit?: number;
}

// ── Priorities ──────────────────────────────────────────────────

export interface Outcome {
  id: string;
  description: string;
  targetDate?: number;
  completed: boolean;
}

export interface Priority {
  id: string;
  title: string;
  description?: string;
  quarter: string;
  rank: number;
  valueIds: string[];
  goalIds?: string[];  // Link priorities to goals (optional for backwards compatibility)
  outcomes: Outcome[];
  progress: number;
  status: 'active' | 'completed' | 'paused';
  createdAt: number;
  updatedAt: number;
}

export type PriorityCreateParams = Omit<Priority, 'id' | 'createdAt' | 'updatedAt'>;
export type PriorityUpdateParams = Partial<Omit<Priority, 'id' | 'createdAt'>> & { id: string };

// ── System Nodes ────────────────────────────────────────────────

export type SystemNodeType = 'business' | 'project' | 'person' | 'asset' | 'revenue_stream';

export interface SystemNode {
  id: string;
  type: SystemNodeType;
  name: string;
  description?: string;
  notionId?: string;
  kanbanProjectId?: string;
  valueIds?: string[];
  priorityIds?: string[];
  metadata: Record<string, any>;
  x?: number;
  y?: number;
  createdAt: number;
  updatedAt: number;
}

export type SystemNodeCreateParams = Omit<SystemNode, 'id' | 'createdAt' | 'updatedAt'>;
export type SystemNodeUpdateParams = Partial<Omit<SystemNode, 'id' | 'createdAt'>> & { id: string };

// ── Relationships ───────────────────────────────────────────────

export type RelationshipType = 'feeds' | 'depends_on' | 'synergy' | 'resource_flow' | 'attention_flow' | 'enables' | 'supports' | 'implements' | 'contains' | 'references';

export interface Relationship {
  id: string;
  sourceId: string;
  targetId: string;
  type: RelationshipType;
  strength: number;
  label?: string;
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

export type RelationshipCreateParams = Omit<Relationship, 'id' | 'createdAt' | 'updatedAt'>;
export type RelationshipUpdateParams = Partial<Omit<Relationship, 'id' | 'createdAt'>> & { id: string };

// ── Reviews ─────────────────────────────────────────────────────

export type ReviewType = 'daily' | 'weekly' | 'monthly';

export interface PriorityProgress {
  priorityId: string;
  notes: string;
  progress: number;
}

export interface Review {
  id: string;
  type: ReviewType;
  date: number;
  priorityProgress: PriorityProgress[];
  reflections: string;
  wins: string[];
  challenges: string[];
  nextActions: string[];
  createdAt: number;
}

export type ReviewCreateParams = Omit<Review, 'id' | 'createdAt'>;

// ── System Graph ────────────────────────────────────────────────

export interface SystemGraph {
  nodes: SystemNode[];
  relationships: Relationship[];
  values: Value[];
  priorities: Priority[];
}

// ── List/Search Params ──────────────────────────────────────────

export interface ValueListParams {
  limit?: number;
}

export interface PriorityListParams {
  quarter?: string;
  status?: Priority['status'];
  limit?: number;
}

export interface SystemNodeListParams {
  type?: SystemNodeType;
  limit?: number;
}

export interface RelationshipListParams {
  sourceId?: string;
  targetId?: string;
  type?: RelationshipType;
  limit?: number;
}

export interface ReviewListParams {
  type?: ReviewType;
  startDate?: number;
  endDate?: number;
  limit?: number;
}
