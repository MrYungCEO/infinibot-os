import path from "node:path";

import { resolveStateDir } from "../config/paths.js";
import { DEFAULT_AGENT_ID } from "../routing/session-key.js";
import { resolveUserPath } from "../utils.js";
import { isSaasTenantScope } from "../saas/tenant-config.js";

export function resolveInfiniBotAgentDir(): string {
  // SaaS member: a host-wide agent-dir override would hand every tenant the
  // operator's auth store, so it only applies outside a tenant scope.
  const override = isSaasTenantScope()
    ? undefined
    : process.env.INFINIBOT_AGENT_DIR?.trim() || process.env.PI_CODING_AGENT_DIR?.trim();
  if (override) return resolveUserPath(override);
  const defaultAgentDir = path.join(resolveStateDir(), "agents", DEFAULT_AGENT_ID, "agent");
  return resolveUserPath(defaultAgentDir);
}

export function ensureInfiniBotAgentEnv(): string {
  const dir = resolveInfiniBotAgentDir();
  if (!process.env.INFINIBOT_AGENT_DIR) process.env.INFINIBOT_AGENT_DIR = dir;
  if (!process.env.PI_CODING_AGENT_DIR) process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}
