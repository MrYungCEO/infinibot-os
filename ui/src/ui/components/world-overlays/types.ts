/**
 * Shared types for the <world-overlays> family (mission / heatmap / achievements).
 *
 * All coordinates are CSS px relative to the overlay element's box — identical
 * to the contract <agent-fx-layer> uses, so both layers stack cleanly over the
 * same world canvas.
 */

/** Minimal agent shape read from window.__agentFxState. */
export interface OverlayAgent {
  id: string;
  x: number;
  y: number;
  status?: string;
  backend?: string;
}

export type HeatmapMode = "credit_burn" | "activity_density" | "failure_rate";

/** A sector building that holds critical-path tasks (screen px + radius). */
export interface MissionSector {
  x: number;
  y: number;
  r: number;
  label: string;
}

export interface MissionData {
  /** Agent ids working a critical-path task — highlighted with a gold ring. */
  criticalAgentIds: string[];
  /** Sector buildings holding critical tasks — pulse gold. */
  criticalSectors: MissionSector[];
  projectId?: string;
}

/** Per-agent weights for the heatmap modes (id → value). */
export interface HeatmapWeights {
  burn?: Record<string, number>;
  failure?: Record<string, number>;
}

/** Serialized achievement record + its static def, as consumed by the UI. */
export interface UiAchievement {
  id: string;
  kind: string;
  label: string;
  description: string;
  icon: string;
  tier: "bronze" | "silver" | "gold" | "legendary";
  earnedAt: number;
}

declare global {
  interface Window {
    __worldHeatmap?: HeatmapWeights;
    __worldMission?: MissionData;
    /** Aggregate system-activity level (0..1) — drives the volumetric ground-grid
     *  pulse (activity-map) and <world-environment>. Published by world-feeds. */
    __worldActivity?: number;
  }
}
