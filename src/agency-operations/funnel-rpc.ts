import type {
  AgencyFunnel,
  AgencyFunnelConnection,
  AgencyFunnelEdge,
  AgencyFunnelGap,
  FunnelHealthStatus,
  AgencyFunnelKpiDefinition,
  AgencyFunnelNode,
  AgencyFunnelOperatingContext,
} from "./funnel-types.js";

export const AGENCY_FUNNEL_RPC_METHODS = {
  overview: "agency.ops.funnels.overview",
  mapGet: "agency.ops.funnels.map.get",
  mapUpsert: "agency.ops.funnels.map.upsert",
  connectionUpsert: "agency.ops.funnels.connection.upsert",
  connectionCheck: "agency.ops.funnels.connection.check",
  kpiRecord: "agency.ops.funnels.kpi.record",
  context: "agency.ops.funnels.context",
  healthCheck: "agency.ops.funnels.health.check",
} as const;

export interface AgencyFunnelOverview {
  coreFunnel: AgencyFunnel | null;
  subFunnels: AgencyFunnel[];
  nodes: AgencyFunnelNode[];
  edges: AgencyFunnelEdge[];
  connections: Array<{
    id: string;
    name: string;
    kind: string;
    status: AgencyFunnelConnection["status"];
    required: boolean;
    lastCheckedAt: number | null;
    message: string | null;
  }>;
  kpis: Array<{
    id: string;
    name: string;
    value: number | null;
    target: number | null;
    unit: AgencyFunnelKpiDefinition["unit"];
    status: "on_target" | "warning" | "critical" | "unknown";
  }>;
  gaps: Array<{
    id: string;
    severity: AgencyFunnelGap["severity"];
    title: string;
    description: string;
    recommendedAction: string;
    ownerWorkerId: string | null;
  }>;
  healthStatus: FunnelHealthStatus;
  healthScore: number;
  setupPercent: number;
}

export type AgencyFunnelRpcRequest =
  | {
      method: typeof AGENCY_FUNNEL_RPC_METHODS.overview;
      params: { agencyId: string; funnelId?: string };
    }
  | {
      method: typeof AGENCY_FUNNEL_RPC_METHODS.mapGet;
      params: { agencyId: string; funnelId: string };
    }
  | {
      method: typeof AGENCY_FUNNEL_RPC_METHODS.mapUpsert;
      params: {
        agencyId: string;
        funnelId: string;
        nodes: AgencyFunnelNode[];
        edges: AgencyFunnelEdge[];
      };
    }
  | {
      method: typeof AGENCY_FUNNEL_RPC_METHODS.connectionUpsert;
      params: {
        agencyId: string;
        funnelId: string;
        connection: Partial<AgencyFunnelConnection> &
          Pick<AgencyFunnelConnection, "provider" | "connectionKey">;
      };
    }
  | {
      method: typeof AGENCY_FUNNEL_RPC_METHODS.connectionCheck;
      params: { agencyId: string; funnelId: string; connectionId: string };
    }
  | {
      method: typeof AGENCY_FUNNEL_RPC_METHODS.kpiRecord;
      params: { agencyId: string; kpiId: string; value: number; recordedAt?: number };
    }
  | {
      method: typeof AGENCY_FUNNEL_RPC_METHODS.context;
      params: { agencyId: string; funnelId?: string };
      result?: AgencyFunnelOperatingContext | null;
    }
  | {
      method: typeof AGENCY_FUNNEL_RPC_METHODS.healthCheck;
      params: { agencyId: string; funnelId?: string };
    };
