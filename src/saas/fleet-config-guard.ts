// Open-source build stub: the real module is part of the hosted product (see docs/licensing/PRIVATE-SPLIT.md).
import type { InfinibotConfig } from "../config/types.js";

type Dict = Record<string, unknown>;

export const FLEET_CONFIG_WRITE_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

export function isFleetTenantMachineEnv(_env: NodeJS.ProcessEnv = process.env): boolean {
  return false;
}

export type FleetConfigWriteDecision =
  | { allowed: true }
  | { allowed: false; reason: "not-fleet" | "member" | "no-role"; message: string };

/** Same answer the hosted module gives off the fleet: this gateway is not a fleet Machine. */
export function fleetConfigWriteDecision(_params: {
  env?: NodeJS.ProcessEnv;
  scopedUserId: string | undefined;
  role: string | undefined;
  fleetMachineOptIn?: boolean;
}): FleetConfigWriteDecision {
  return {
    allowed: false,
    reason: "not-fleet",
    message: "Shared configuration cannot be changed from a tenant scope.",
  };
}

export function isPlatformManagedEnvKey(_key: string): boolean {
  return false;
}

export type FleetConfigSanitizeResult =
  | { ok: true; config: InfinibotConfig; notes: string[] }
  | { ok: false; error: string };

export function sanitizeFleetTenantConfigWrite(params: {
  incoming: InfinibotConfig;
  raw: InfinibotConfig;
  overlaid: InfinibotConfig;
  redactionSentinel: string;
}): FleetConfigSanitizeResult {
  return { ok: true, config: params.incoming, notes: [] };
}

export function tenantOverlaySyncFor(_params: { next: InfinibotConfig; raw: InfinibotConfig }): {
  model?: { primary: string; fallbacks?: string[] } | null;
  assistant?: Dict;
} {
  return {};
}
