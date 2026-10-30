/**
 * `robovoice_call` agent tool: an InfiniBot agent starts, checks or ends a
 * Robovoice voice call (itself by default), or reads the link status.
 *
 * Allowlist trap: the tool is registered through the plugin (resolvePluginTools
 * in src/agents/infinibot-tools.ts picks it up), and must also be allowed per
 * agent — standard-roster `main.toolsAllow` has it; a live install needs
 * `agents.list[main].tools.allow` += "robovoice_call" (see the plugin README).
 */

import { Type } from "@sinclair/typebox";
import { optionalStringEnum, stringEnum } from "infinibot/plugin-sdk";

import type { RobovoiceLinkService } from "./link.js";

export const ROBOVOICE_TOOL_NAME = "robovoice_call";

export const RobovoiceCallToolSchema = Type.Object({
  action: stringEnum(["start", "status", "end", "link_status"] as const, {
    description:
      "start: begin a voice call with an agent (returns a call link); status: is the call live + minutes used; end: hang up; link_status: Robovoice link and location",
  }),
  agent: Type.Optional(Type.String({ description: "InfiniBot agent id to call (default: you)" })),
  mode: optionalStringEnum(["auto", "cloud", "local"] as const, {
    description: "cloud = web call link on Robovoice cloud; local = Robovoice Desktop on this computer; auto (default) = Desktop if running, else cloud",
  }),
  room: Type.Optional(Type.String({ description: "Call room from action=start (for status / end)" })),
  since: Type.Optional(Type.String({ description: "started_at from action=start (for status)" })),
});

type Params = { action?: string; agent?: string; mode?: string; room?: string; since?: string };

const json = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  details: payload,
});

export function createRobovoiceCallTool(service: () => RobovoiceLinkService, ctx: { agentId?: string }) {
  return {
    name: ROBOVOICE_TOOL_NAME,
    label: "Robovoice Call",
    description:
      "Hold a real-time voice call through Robovoice with an InfiniBot agent (yourself by default). " +
      "Only when the user asks for cloud voice — local voice is the default. Cloud voice is free. " +
      "action=start returns a call link to give the user; status reports live state and minutes used; " +
      "end hangs up; link_status shows the Robovoice link.",
    parameters: RobovoiceCallToolSchema,
    async execute(_toolCallId: string, raw: unknown) {
      const p = (raw && typeof raw === "object" ? raw : {}) as Params;
      try {
        const s = service();
        switch (p.action) {
          case "link_status": {
            const st = await s.status({ remote: true });
            return json({
              linked: st.linked,
              org: st.org?.name,
              location: st.location?.name,
              device: st.device?.id,
              agents: st.agents,
              note: st.remoteError,
            });
          }
          case "start": {
            const agent = p.agent?.trim() || ctx.agentId || "main";
            const mode = p.mode === "cloud" || p.mode === "local" ? p.mode : "auto";
            const call = await s.startCall(agent, { mode });
            return json({
              started: true,
              agent,
              mode: call.mode,
              url: call.url ?? null,
              desktop: call.device ?? null,
              room: call.room,
              since: call.started_at,
              tell_user:
                call.mode === "cloud"
                  ? `Open ${call.url} to talk${call.fellBackToCloud ? " (Robovoice Desktop wasn't online, so this uses the cloud)" : ""}.`
                  : `Robovoice Desktop "${call.device?.name}" is starting the call on this computer.`,
            });
          }
          case "status": {
            if (!p.room) throw new Error("room is required (from action=start)");
            const st = await s.callStatus(p.room, p.since);
            return json({
              live: st.live,
              participants: st.participants,
              minutes_used: Math.round((st.usage.billable_seconds / 60) * 10) / 10,
            });
          }
          case "end": {
            if (!p.room) throw new Error("room is required (from action=start)");
            return json(await s.endCall(p.room));
          }
          default:
            throw new Error("action must be start, status, end or link_status");
        }
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}
