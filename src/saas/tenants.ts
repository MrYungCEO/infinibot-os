// Open-source build stub: the real module is part of the hosted product (see docs/licensing/PRIVATE-SPLIT.md).
import type { ClerkIdentity } from "./clerk.js";

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  plan: string;
  stateNamespace: string;
  status: string;
}

export interface SaasUser {
  id: string;
  clerkUserId: string | null;
  email: string;
  tenantId: string;
  role: string;
  status: string;
}

export interface ResolvedTenant {
  tenant: Tenant;
  user: SaasUser;
}

export async function resolveTenantForIdentity(_identity: ClerkIdentity): Promise<ResolvedTenant> {
  throw new Error("not available in the open-source build");
}
