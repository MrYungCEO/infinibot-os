/**
 * Who may open the live browser viewer.
 *
 * The viewer shows — and types into — the workspace's signed-in Chrome, so it
 * is an owner/admin surface:
 *   - hosted tenant Machine: the tenant's owner and admins only;
 *   - shared multi-tenant SaaS gateway: nobody (that browser is the operator's);
 *   - self-hosted: an operator connection with the admin scope.
 */
import { FLEET_CONFIG_WRITE_ROLES, isFleetTenantMachineEnv } from "../../saas/fleet-config-guard.js";

export type ViewerAccess = { allowed: true } | { allowed: false; reason: string };

export function browserViewerAccess(params: {
  saasMode: boolean;
  env?: NodeJS.ProcessEnv;
  role?: string;
  scopes?: readonly string[];
  hasTenant: boolean;
}): ViewerAccess {
  if (params.saasMode) {
    if (!isFleetTenantMachineEnv(params.env)) {
      return { allowed: false, reason: "The live browser is available on a dedicated cloud gateway." };
    }
    if (!params.hasTenant) {
      return { allowed: false, reason: "Sign in to your workspace to use the live browser." };
    }
    const role = params.role?.trim().toLowerCase() ?? "";
    return FLEET_CONFIG_WRITE_ROLES.has(role)
      ? { allowed: true }
      : {
          allowed: false,
          reason: "Only the workspace owner or an admin can open the live browser: it is signed in to the workspace's accounts.",
        };
  }
  return (params.scopes ?? []).includes("operator.admin")
    ? { allowed: true }
    : { allowed: false, reason: "The live browser needs an admin connection." };
}
