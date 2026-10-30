/**
 * Coder CLI permission-bypass policy (`tools.coder.autoApprove`).
 *
 * The coder CLIs (Claude Code, OpenCode, Codex, Gemini) each have a flag that
 * skips every permission prompt. That's what the operator wants for their own
 * autonomous fixes, and it's remote code execution for anyone else who can
 * steer the agent. The policy decides who gets the bypass:
 *
 * - "operator" (default; SaaS mode is always "never"): trusted turns keep the caller's autoApprove choice;
 *   untrusted turns (non-owner senders, hook content) never get the bypass.
 * - "always": legacy — honor autoApprove regardless of origin.
 * - "never": never emit the bypass flag.
 */

import type { InfinibotConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import { isSaasMode } from "../../saas/config.js";

export type CoderAutoApprovePolicy = "operator" | "always" | "never";

export function resolveCoderAutoApprovePolicy(cfg?: InfinibotConfig): CoderAutoApprovePolicy {
  // Hosted SaaS: a signed-in tenant is not the machine owner, and the config is
  // tenant-writable on fleet Machines, so the bypass flag is never emitted
  // there, whatever the config says.
  if (isSaasMode()) return "never";
  const raw = cfg?.tools?.coder?.autoApprove;
  if (raw === "always" || raw === "never" || raw === "operator") return raw;
  return "operator";
}

/**
 * Final autoApprove decision for a coder spawn.
 * @param requested what the caller asked for (tool param; undefined → true, the historical default)
 * @param trustedOrigin whether the turn that requested the spawn is trusted (undefined → trusted:
 *   callers without origin info are operator surfaces such as MCP / RPC / autonomy)
 */
export function resolveCoderAutoApprove(params: {
  requested?: boolean;
  trustedOrigin?: boolean;
  cfg?: InfinibotConfig;
}): boolean {
  const policy = resolveCoderAutoApprovePolicy(params.cfg);
  if (policy === "never") return false;
  const requested = params.requested !== false;
  if (policy === "always") return requested;
  return requested && params.trustedOrigin !== false;
}

/**
 * Last-line guard applied where the bypass flag is emitted. Only enforces the
 * global "never" switch (origin is decided upstream by the tool). Config load
 * failures fall back to the caller's value so a broken config can't wedge spawns.
 */
export function allowCoderBypassFlag(autoApprove: boolean | undefined): boolean {
  if (!autoApprove) return false;
  try {
    return resolveCoderAutoApprovePolicy(loadConfig()) !== "never";
  } catch {
    return true;
  }
}
