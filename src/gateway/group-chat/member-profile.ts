/**
 * Gateway-side inputs for the group member context block: each member's role
 * and real tool capabilities (from its tool policy), the owner's name / time
 * zone, and binding defaults resolved from a linked kanban project.
 */
import fs from "node:fs";
import path from "node:path";

import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { resolveUserTimezone } from "../../agents/date-time.js";
import {
  isToolAllowedByPolicies,
  resolveEffectiveToolPolicy,
} from "../../agents/pi-tools.policy.js";
import { resolveToolProfilePolicy } from "../../agents/tool-policy.js";
import type { InfinibotConfig } from "../../config/config.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { GroupContextMember } from "../../shared/group-chat/context.js";
import type { GroupMember } from "../../shared/group-chat/planner.js";

/** "You are DEV — the primary coding agent …" → "the primary coding agent …". */
export function roleFromSystemPrompt(prompt: unknown): string | undefined {
  if (typeof prompt !== "string") return undefined;
  const first = prompt.trim().split("\n")[0]?.trim() ?? "";
  const m = /^You are\s+[^—–,:-]{1,40}?\s*[—–,:-]\s*(.+)$/i.exec(first);
  const role = (m?.[1] ?? "").replace(/[.\s]+$/, "").trim();
  if (!role) return undefined;
  return role.length > 120 ? `${role.slice(0, 119)}…` : role;
}

export function profileGroupMembers(
  cfg: InfinibotConfig,
  members: GroupMember[],
): GroupContextMember[] {
  return members.map((m) => {
    const out: GroupContextMember = { ...m };
    try {
      // Raw roster entry: resolveAgentConfig() drops `systemPrompt`.
      const agentCfg = (cfg.agents?.list ?? []).find(
        (a) => normalizeAgentId(String(a?.id ?? "")) === normalizeAgentId(m.id),
      ) as ({ systemPrompt?: string; identity?: { theme?: string } } & Record<string, unknown>) | undefined;
      out.role = roleFromSystemPrompt(agentCfg?.systemPrompt) ?? agentCfg?.identity?.theme?.trim();
      const p = resolveEffectiveToolPolicy({ config: cfg, sessionKey: `agent:${m.id}:gcmember-x` });
      const profile = resolveToolProfilePolicy(p.profile);
      const profileWithAlso =
        profile?.allow && p.profileAlsoAllow?.length
          ? { ...profile, allow: [...profile.allow, ...p.profileAlsoAllow] }
          : profile;
      const policies = [profileWithAlso, p.globalPolicy, p.agentPolicy];
      const can = (name: string) => isToolAllowedByPolicies(name, policies);
      out.canExec = can("exec");
      out.canWrite = can("write") || can("edit");
      out.canSpawn = can("claude_coder") || can("sessions_spawn");
    } catch {
      /* best effort — the block just omits roles/capabilities */
    }
    return out;
  });
}

/** Owner name + time zone from the default agent's USER.md (same file 1:1 chats inject). */
export function resolveOwnerInfo(cfg: InfinibotConfig): { name?: string; timeZone?: string } {
  let name: string | undefined;
  let tz: string | undefined;
  try {
    const dir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
    if (dir) {
      const text = fs.readFileSync(path.join(dir, "USER.md"), "utf-8").slice(0, 8000);
      name = /\*\*Name:\*\*\s*(.+)/.exec(text)?.[1]?.trim();
      tz = /\*\*Time ?zone:\*\*\s*([A-Za-z_/+-]+)/i.exec(text)?.[1]?.trim();
    }
  } catch {
    /* no USER.md */
  }
  const configured = (cfg.agents?.defaults as { userTimezone?: string } | undefined)?.userTimezone;
  let timeZone: string | undefined;
  try {
    timeZone = resolveUserTimezone(configured ?? tz);
  } catch {
    timeZone = tz;
  }
  return { ...(name && !/^\*?\(/.test(name) ? { name } : {}), ...(timeZone ? { timeZone } : {}) };
}
