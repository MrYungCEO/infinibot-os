/**
 * InfiniBot agent → Robovoice character mapping.
 *
 * The voice UI encodes the driving agent into the LiveKit room name as
 * `voice-emp_<enc>-<uuid>` where <enc> is the agent id with every
 * non-alphanumeric char replaced by "_" (voice-chat.ts encodeAgentIdForRoom).
 * That is lossy, so mapping keys are matched by encoding them the same way.
 */

import type { RobovoiceSettings } from "./settings.js";

export function encodeAgentIdForRoom(agentId: string): string {
  return String(agentId).replace(/[^A-Za-z0-9]/g, "_");
}

/** Agent encoded in a voice room name, or undefined. UUID suffix is 36 chars. */
export function agentFromRoomName(room: string | undefined): string | undefined {
  if (!room) return undefined;
  const m = /^voice-emp_(.+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(room);
  return m ? m[1] : undefined;
}

export type CharacterResolution = {
  characterId?: string;
  /** "mapping" | "default" | "robovoice" (let Robovoice pick). */
  source: "mapping" | "default" | "robovoice";
  agentId?: string;
};

export function resolveCharacterForAgent(
  settings: Pick<RobovoiceSettings, "characterMap" | "defaultCharacterId">,
  req: { agentId?: string; room?: string },
): CharacterResolution {
  const agent = req.agentId?.trim() || undefined;
  const encoded = agent ? encodeAgentIdForRoom(agent) : agentFromRoomName(req.room);
  if (agent && settings.characterMap[agent]) {
    return { characterId: settings.characterMap[agent], source: "mapping", agentId: agent };
  }
  if (encoded) {
    for (const [key, ch] of Object.entries(settings.characterMap)) {
      if (encodeAgentIdForRoom(key) === encoded) return { characterId: ch, source: "mapping", agentId: key };
    }
  }
  if (settings.defaultCharacterId) {
    return { characterId: settings.defaultCharacterId, source: "default", agentId: agent };
  }
  return { source: "robovoice", agentId: agent };
}
