/**
 * `community` agent tool — the Community Manager agent's handle on the plugin.
 * Reads are free; moderation goes through the same approval gate as the
 * engine (bans, kicks, timeouts > 1 h, DMs to > 25 people, @everyone wait for
 * a human). The tool never exposes the bot token.
 */

import { Type } from "@sinclair/typebox";
import { jsonResult, readNumberParam, readStringParam, stringEnum, type AnyAgentTool } from "infinibot/plugin-sdk";

import { LEAD_STAGES, type LeadStage, type ModActionKind } from "./contract.js";
import type { CommunityEngine } from "./engine.js";

const Schema = Type.Object({
  action: stringEnum([
    "status",
    "leads",
    "update_lead",
    "mod_queue",
    "moderate",
    "schedule_post",
    "dm_members",
    "activity",
  ]),
  leadId: Type.Optional(Type.String()),
  stage: Type.Optional(Type.String({ description: `Lead stage: ${LEAD_STAGES.join(", ")}` })),
  kind: Type.Optional(Type.String({ description: "moderate: warn | timeout | kick | ban" })),
  userId: Type.Optional(Type.String({ description: "Discord user id" })),
  username: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String()),
  minutes: Type.Optional(Type.Number({ description: "timeout length in minutes (over 60 needs approval)" })),
  title: Type.Optional(Type.String()),
  content: Type.Optional(Type.String()),
  channelId: Type.Optional(Type.String()),
  at: Type.Optional(Type.String({ description: "ISO time for schedule_post (default: now)" })),
  userIds: Type.Optional(Type.Array(Type.String(), { description: "dm_members recipients (opt-in members only)" })),
});

export function createCommunityTool(engine: () => CommunityEngine): AnyAgentTool {
  return {
    label: "Community",
    name: "community",
    description: `Run the Discord community (Young CEO Society) through the Community Manager plugin.

Actions:
- status: mode (shadow/live/paused), server, today's KPIs
- leads: open leads by tier/score (hot ≥ 60) with primary + secondary offer, CTA and assignee (every lead always has an offer)
- update_lead: leadId + stage (${LEAD_STAGES.join(" / ")})
- mod_queue: moderation actions waiting for approval + recent actions
- moderate: kind warn|timeout|kick|ban, userId, reason, minutes. Kicks, bans and timeouts over 60 min become approval requests — never claim they happened until approved.
- schedule_post: title, content, optional channelId/at. Posts that ping @everyone/@here wait for approval.
- dm_members: userIds + content. More than 25 recipients waits for approval. Only DM members who opted in.
- activity: the recent decision log

Rules: never give financial advice or promise returns (the bot refuses to send banned claims); trading channels get the risk disclaimer automatically.`,
    parameters: Schema,
    execute: async (_id, args) => {
      const p = args as Record<string, unknown>;
      const action = readStringParam(p, "action", { required: true });
      const e = engine();
      const store = e.store;
      const s = store.getSettings();
      try {
        switch (action) {
          case "status":
            return jsonResult({
              mode: s.mode,
              paused: s.paused,
              guild: s.guildName,
              leadsOpen: store.listLeads({ open: true }).length,
              pendingApprovals: store.listModActions({ status: "pending_approval" }).length,
            });
          case "leads":
            return jsonResult({ leads: store.listLeads({ guildId: s.guildId, open: true, limit: 50 }) });
          case "update_lead": {
            const stage = readStringParam(p, "stage") as LeadStage | undefined;
            if (!stage || !LEAD_STAGES.includes(stage)) return jsonResult({ error: `stage must be one of ${LEAD_STAGES.join(", ")}` });
            const lead = store.updateLead(readStringParam(p, "leadId") ?? "", { stage }, "agent");
            return jsonResult(lead ? { lead } : { error: "lead not found" });
          }
          case "mod_queue":
            return jsonResult({ pending: store.listModActions({ status: "pending_approval" }), recent: store.listModActions({ limit: 20 }) });
          case "moderate": {
            const kind = readStringParam(p, "kind") as ModActionKind | undefined;
            const userId = readStringParam(p, "userId");
            const reason = readStringParam(p, "reason") ?? "";
            if (!kind || !["warn", "timeout", "kick", "ban"].includes(kind)) return jsonResult({ error: "kind must be warn, timeout, kick or ban" });
            if (!userId || !/^\d{3,25}$/.test(userId)) return jsonResult({ error: "userId (Discord id) required" });
            if (!reason.trim()) return jsonResult({ error: "reason required" });
            const minutes = readNumberParam(p, "minutes");
            const rec = await e.moderate(s, {
              action: kind,
              targetId: userId,
              targetName: readStringParam(p, "username") ?? userId,
              durationMs: kind === "timeout" ? Math.max(1, minutes ?? 10) * 60_000 : null,
              rule: "agent",
              reason,
              actor: "community-agent",
            });
            return jsonResult({
              id: rec.id,
              status: rec.status,
              note:
                rec.status === "pending_approval"
                  ? "Waiting for a human approval — this has NOT happened yet."
                  : rec.status === "shadow" || rec.status === "paused"
                    ? "Logged only (shadow mode or paused) — nothing was done on Discord."
                    : "Done.",
            });
          }
          case "schedule_post": {
            const content = readStringParam(p, "content") ?? "";
            const title = readStringParam(p, "title") ?? content.slice(0, 40);
            if (!content.trim()) return jsonResult({ error: "content required" });
            const at = readStringParam(p, "at");
            const scheduleAt = at ? Date.parse(at) : Date.now();
            if (!Number.isFinite(scheduleAt)) return jsonResult({ error: "at must be an ISO time" });
            const c = store.createCampaign({
              title,
              content,
              channelId: readStringParam(p, "channelId") ?? null,
              scheduleAt,
              status: "scheduled",
              pingsEveryone: /@(everyone|here)\b/.test(content),
            });
            return jsonResult({ campaign: c, note: c.pingsEveryone ? "Pings @everyone — it will wait for approval." : "Scheduled." });
          }
          case "dm_members": {
            const ids = Array.isArray(p.userIds) ? (p.userIds as unknown[]).map(String).filter((x) => /^\d{3,25}$/.test(x)) : [];
            const content = readStringParam(p, "content") ?? "";
            if (!ids.length || !content.trim()) return jsonResult({ error: "userIds and content required" });
            const rec = await e.requestMassDm(s, ids, content);
            return jsonResult({ id: rec.id, status: rec.status, recipients: ids.length });
          }
          case "activity":
            return jsonResult({ items: store.listActivity({ limit: 50 }) });
          default:
            return jsonResult({ error: `unknown action ${action}` });
        }
      } catch (err) {
        return jsonResult({ error: String(err instanceof Error ? err.message : err) });
      }
    },
  };
}
