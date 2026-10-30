/**
 * InfiCode — Fleet types.
 *
 * Mirrors extensions/infinicode/src/types.ts (the plugin's wire contract) on
 * the frontend. Kept as a local mirror rather than a shared import since the
 * UI package doesn't reach into extensions/ source — same tradeoff the
 * plugin itself makes against infinicode-main.
 */

export interface FleetNodeStatusEntry {
  nodeId: string;
  displayName?: string;
  platform?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  version?: string;
  caps?: string[];
  commands?: string[];
  connected?: boolean;
  connectedAtMs?: number;
  role?: string;
  load?: number;
  site?: string;
}

/** Loose — only the fields the panel actually displays are read defensively. */
export interface FleetHardwareSnapshot {
  cpu?: { percent?: number };
  memory?: { percent?: number };
  system?: { hostname?: string; uptimeSec?: number };
  timestamp?: number;
}

export interface MaintenanceReport {
  nodeId: string;
  role: string;
  site?: string;
  taskName: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  ok: boolean;
  summary: string;
  errors?: string[];
}

export interface FleetRecord {
  nodeId: string;
  status?: FleetNodeStatusEntry;
  hardware?: FleetHardwareSnapshot;
  recentEvents?: unknown[];
  reports: MaintenanceReport[];
  lastSeenAt: number;
}
