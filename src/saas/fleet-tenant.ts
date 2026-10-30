// Open-source build stub: the real module is part of the hosted product (see docs/licensing/PRIVATE-SPLIT.md).
import type { ClerkIdentity } from "./clerk.js";
import type { ResolvedTenant } from "./tenants.js";

export type ClerkGatewayDeps = {
  verify?: (token: string) => Promise<ClerkIdentity | null>;
  resolve?: (identity: ClerkIdentity) => Promise<ResolvedTenant>;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
};

export function fleetTenantStateDirs(
  _sharedDir: string,
  _env: NodeJS.ProcessEnv = process.env,
): string[] {
  return [];
}

export function tenantAllowedHere(
  _tenantId: string | undefined,
  _env: NodeJS.ProcessEnv = process.env,
): boolean {
  return true;
}

/** No Clerk here: every token is refused. */
export async function verifyClerkForThisGateway(
  _token: string | undefined,
  _deps: ClerkGatewayDeps = {},
): Promise<{ identity: ClerkIdentity; tenant?: ResolvedTenant } | null> {
  return null;
}

export function applyFleetTenantNamespace(
  _env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return undefined;
}

export function rememberFleetTenantNamespace(
  _tenantId: string,
  _namespace: string | undefined,
  _env: NodeJS.ProcessEnv = process.env,
): void {}
