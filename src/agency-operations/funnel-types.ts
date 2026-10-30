export type AgencyFunnelKind =
  | "lead_generation"
  | "sales"
  | "client_onboarding"
  | "delivery"
  | "retention"
  | "recruitment"
  | "custom";
export type AgencyFunnelStatus =
  | "draft"
  | "setup"
  | "ready"
  | "live"
  | "degraded"
  | "paused"
  | "archived";
export type AgencyFunnelNodeType =
  | "source"
  | "action"
  | "decision"
  | "delay"
  | "sub_funnel"
  | "exit";

export interface AgencyFunnel {
  id: string;
  agencyId: string;
  parentFunnelId: string | null;
  legacyFunnelId: string | null;
  name: string;
  description: string;
  kind: AgencyFunnelKind;
  status: AgencyFunnelStatus;
  ownerId: string | null;
  objective: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgencyFunnelNode {
  id: string;
  agencyId: string;
  funnelId: string;
  nodeType: AgencyFunnelNodeType;
  name: string;
  description: string;
  config: Record<string, unknown>;
  positionX: number;
  positionY: number;
  sortOrder: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AgencyFunnelEdge {
  id: string;
  agencyId: string;
  funnelId: string;
  sourceNodeId: string;
  targetNodeId: string;
  label: string | null;
  condition: Record<string, unknown>;
  priority: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export type SetupRequirementKind =
  | "integration"
  | "credential"
  | "content"
  | "configuration"
  | "approval";
export type SetupRequirementStatus = "missing" | "in_progress" | "satisfied" | "waived";
export interface AgencyFunnelRequirement {
  id: string;
  agencyId: string;
  funnelId: string;
  nodeId: string | null;
  connectionId: string | null;
  kind: SetupRequirementKind;
  name: string;
  description: string;
  required: boolean;
  status: SetupRequirementStatus;
  evidence: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export type FunnelConnectionStatus =
  | "disconnected"
  | "configuring"
  | "connected"
  | "degraded"
  | "error";
export interface AgencyFunnelConnection {
  id: string;
  agencyId: string;
  funnelId: string;
  nodeId: string | null;
  provider: string;
  connectionKey: string;
  status: FunnelConnectionStatus;
  config: Record<string, unknown>;
  lastCheckedAt: number | null;
  lastHealthyAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export type FunnelHealthStatus = "healthy" | "degraded" | "unhealthy" | "unknown";
export interface AgencyFunnelHealthCheck {
  id: string;
  agencyId: string;
  funnelId: string;
  targetType: "funnel" | "node" | "connection";
  targetId: string;
  status: FunnelHealthStatus;
  message: string | null;
  latencyMs: number | null;
  details: Record<string, unknown>;
  checkedAt: number;
}

export interface AgencyFunnelKpiDefinition {
  id: string;
  agencyId: string;
  funnelId: string;
  nodeId: string | null;
  key: string;
  name: string;
  unit: "count" | "currency_cents" | "percent" | "seconds" | "score";
  aggregation: "sum" | "average" | "latest" | "rate";
  direction: "higher_is_better" | "lower_is_better";
  targetValue: number | null;
  warningValue: number | null;
  windowSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface AgencyFunnelKpiReading {
  id: string;
  agencyId: string;
  funnelId: string;
  kpiId: string;
  value: number;
  dimensions: Record<string, string>;
  recordedAt: number;
}

export type FunnelGapSeverity = "info" | "warning" | "critical";
export interface AgencyFunnelGap {
  code: string;
  severity: FunnelGapSeverity;
  entityType: "funnel" | "node" | "connection" | "requirement" | "kpi";
  entityId: string;
  message: string;
  recommendedAction: string;
}

export interface AgencyFunnelOperatingContext {
  generatedAt: number;
  agencyId: string;
  funnel: AgencyFunnel;
  subFunnels: AgencyFunnel[];
  graph: { nodes: AgencyFunnelNode[]; edges: AgencyFunnelEdge[] };
  setup: {
    ready: boolean;
    required: number;
    satisfied: number;
    requirements: AgencyFunnelRequirement[];
    connections: AgencyFunnelConnection[];
  };
  health: {
    status: FunnelHealthStatus;
    checks: AgencyFunnelHealthCheck[];
  };
  kpis: Array<
    AgencyFunnelKpiDefinition & {
      latest: AgencyFunnelKpiReading | null;
      state: "on_target" | "warning" | "critical" | "unknown";
    }
  >;
  gaps: AgencyFunnelGap[];
  recommendedActions: string[];
}
