// Open-source build stub: the real module is part of the hosted product (see docs/licensing/PRIVATE-SPLIT.md).
export type Plan = "free" | "starter" | "ceo" | "vip";

export type LicenseSource = "rpc" | "electron" | "cache" | "default" | "self-hosted";

export interface LicenseState {
  plan: Plan;
  features: string[];
  expiresAt: number | null;
  source: LicenseSource;
}

export function minimumPlanFor(_featureId: string): Plan | null {
  return null;
}

export function hasFeature(_state: LicenseState | null | undefined, _id: string): boolean {
  return true;
}

export function subscribeLicenseState(cb: (state: LicenseState) => void): () => void {
  cb({ plan: "vip", features: [], expiresAt: null, source: "self-hosted" });
  return () => {};
}
