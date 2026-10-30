export type FunnelNodeType =
  | "traffic-source"
  | "platform"
  | "lead-magnet"
  | "nurture"
  | "conversion-asset"
  | "qualifier"
  | "website-asset"
  | "closer"
  | "product"
  | "retention"
  | "list-segment";

export type FunnelSection = "all" | "traffic" | "capture" | "mofu" | "website" | "retention";

export interface FunnelNode {
  id: string;
  label: string;
  type: FunnelNodeType;
  section: FunnelSection;
  agentId?: string;
  url?: string;
  metrics?: {
    volume?: number;
    conversionRate?: number;
    revenue?: number;
    activeNow?: number;
  };
  status?: "active" | "idle" | "warning" | "critical";
  tools?: string[];
  systemPromptHint?: string;
}

export interface FunnelEdge {
  id: string;
  source: string;
  target: string;
  volume?: number;
  type?: "solid" | "dashed";
}
