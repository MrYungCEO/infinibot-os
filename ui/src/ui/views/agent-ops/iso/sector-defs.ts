/**
 * Station sector registry — pure data (no Pixi), shared by the 2D iso engine
 * (sector-layout.ts re-exports it), the 3D mesh world and the mobile app.
 */

export const STATION_GRID = { cols: 24, rows: 24 };

export interface SectorDef {
  id: string;
  name: string;
  /** Backing subsystem, shown as the label subtitle. */
  system: string;
  /** Tile-space rect on the station grid. */
  c: number;
  r: number;
  w: number;
  h: number;
}

/** 3×3 supergrid on the 24×24 platform, right column split for the Vault. */
export const SECTORS: SectorDef[] = [
  { id: 'observatory', name: 'OBSERVATORY', system: 'analytics', c: 0, r: 0, w: 8, h: 8 },
  { id: 'mission-control', name: 'MISSION CONTROL', system: 'autonomy + cron', c: 8, r: 0, w: 8, h: 8 },
  { id: 'comms-deck', name: 'COMMS DECK', system: 'channels', c: 16, r: 0, w: 8, h: 8 },
  { id: 'agent-quarters', name: 'AGENT QUARTERS', system: 'agents + sessions', c: 0, r: 8, w: 8, h: 8 },
  { id: 'command-atrium', name: 'COMMAND ATRIUM', system: 'federation hub', c: 8, r: 8, w: 8, h: 8 },
  { id: 'broadcast-studio', name: 'BROADCAST STUDIO', system: 'media + voice', c: 16, r: 8, w: 8, h: 4 },
  { id: 'the-vault', name: 'THE VAULT', system: 'security + config', c: 16, r: 12, w: 8, h: 4 },
  { id: 'engineering-bay', name: 'ENGINEERING BAY', system: 'terminals', c: 0, r: 16, w: 8, h: 8 },
  { id: 'gateway-concourse', name: 'GATEWAY CONCOURSE', system: 'gateway', c: 8, r: 16, w: 8, h: 8 },
  { id: 'canvas-atrium', name: 'CANVAS ATRIUM', system: 'canvas + design', c: 16, r: 16, w: 8, h: 8 },
];
