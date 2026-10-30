/**
 * InfiCode — fixed sector grid.
 *
 * A light, dependency-free mirror of the 10 fixed sectors defined in the
 * isometric map (`views/agent-ops/iso/sector-layout.ts`). We deliberately do
 * NOT import that module: it pulls in pixi.js + gsap, which have no place in
 * this plain-DOM/monospace twin. The ids/names/systems are copied verbatim so
 * the two surfaces read as the same station.
 */

import type { MeshAgent } from "../../controllers/agent-mesh.js";

export interface SectorCell {
  id: string;
  /** Short HUD name shown in the panel header. */
  name: string;
  /** Backing subsystem (label subtitle). */
  system: string;
  /** Single-glyph badge used in the compact grid header. */
  glyph: string;
}

/** The 10 fixed sectors — order matches sector-layout.ts SECTORS. */
export const SECTORS: SectorCell[] = [
  { id: "observatory", name: "OBSERVATORY", system: "analytics", glyph: "◎" },
  { id: "mission-control", name: "MISSION CONTROL", system: "autonomy + cron", glyph: "⌖" },
  { id: "comms-deck", name: "COMMS DECK", system: "channels", glyph: "☰" },
  { id: "agent-quarters", name: "AGENT QUARTERS", system: "agents + sessions", glyph: "⌂" },
  { id: "command-atrium", name: "COMMAND ATRIUM", system: "federation hub", glyph: "✦" },
  { id: "broadcast-studio", name: "BROADCAST STUDIO", system: "media + voice", glyph: "♪" },
  { id: "the-vault", name: "THE VAULT", system: "security + config", glyph: "▣" },
  { id: "engineering-bay", name: "ENGINEERING BAY", system: "terminals", glyph: "⚙" },
  { id: "gateway-concourse", name: "GATEWAY CONCOURSE", system: "gateway", glyph: "◈" },
  { id: "canvas-atrium", name: "CANVAS ATRIUM", system: "canvas + design", glyph: "✎" },
];

const SECTOR_IDS = SECTORS.map((s) => s.id);

/** Stable hash → sector, used as a deterministic fallback for idle agents. */
function hashToSector(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return SECTOR_IDS[Math.abs(h) % SECTOR_IDS.length];
}

/**
 * Route an agent to a sector by its current activity — a simple, stable mapping
 * (we don't port the whole PixiJS layout engine). Orchestrators gather in the
 * Command Atrium; workers land in the sector matching their last tool; idle /
 * completed agents rest in Agent Quarters (with a hash fallback so the grid is
 * never lopsided).
 */
export function sectorForAgent(agent: MeshAgent): string {
  if (agent.role === "orchestrator") return "command-atrium";

  const kind = (agent.lastActivityKind || "").toLowerCase();
  if (kind) {
    if (/(edit|write|apply|patch|create|bash|exec|shell|build)/.test(kind)) return "engineering-bay";
    if (/(read|grep|search|glob|list|analy|inspect)/.test(kind)) return "observatory";
    if (/(message|send|chat|notify|broadcast|comm)/.test(kind)) return "comms-deck";
    if (/(voice|speak|media|render|image|video)/.test(kind)) return "broadcast-studio";
    if (/(config|secret|token|auth|security|vault)/.test(kind)) return "the-vault";
    if (/(canvas|design|draw|paint)/.test(kind)) return "canvas-atrium";
    if (/(task|plan|schedule|cron|autonom)/.test(kind)) return "mission-control";
  }

  switch (agent.status) {
    case "working":
    case "starting":
      return "engineering-bay";
    case "blocked":
      return "the-vault";
    case "finishing":
      return "gateway-concourse";
    case "idle":
      return "agent-quarters";
    case "completed":
    case "failed":
      return "gateway-concourse";
    default:
      return hashToSector(agent.sessionKey || agent.agentId);
  }
}
