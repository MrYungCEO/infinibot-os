/** Public commercial-licensing contract shared by the site, API and CLI. */
export const COMMERCIAL_LICENSE_VERSION = "1.0 (2026-10-27)";
/** Licensor named in the agreement and in every signed key. */
export const COMMERCIAL_LICENSOR = "Kingly Intelligence Systems LLC";
export const COMMERCIAL_LICENSE_AGREEMENT_URL = "https://cloud.infinibotos.com/licenses/agreement";
export const COMMERCIAL_LICENSE_ISSUER = "https://cloud.infinibotos.com";
export const COMMERCIAL_LICENSE_AUDIENCE = "infinibot-commercial";
export const COMMERCIAL_LICENSE_KEY_ID = "ib-commercial-ed25519-2026-01";
export const COMMERCIAL_LICENSE_GRACE_DAYS = 14;

export type CommercialTierId = "indie" | "business" | "agency" | "enterprise";

export type CommercialTier = {
  id: CommercialTierId;
  name: string;
  priceCents: number;
  interval: "year" | "180_days" | "60_days";
  billingDays: number;
  seats: number;
  organizations: number;
  revenueCapUsd: number | null;
  whiteLabel: boolean;
  summary: string;
  features: string[];
};

export const COMMERCIAL_TIERS: readonly CommercialTier[] = [
  {
    id: "indie",
    name: "Indie Commercial",
    priceCents: 29_900,
    interval: "year",
    billingDays: 365,
    seats: 1,
    organizations: 1,
    revenueCapUsd: 1_000_000,
    whiteLabel: false,
    summary: "For a solo builder or small company shipping one commercial product.",
    features: [
      "Competing commercial use",
      "One legal entity",
      "One operator seat",
      "Email support",
    ],
  },
  {
    id: "business",
    name: "Team / Business",
    priceCents: 149_900,
    interval: "year",
    billingDays: 365,
    seats: 20,
    organizations: 3,
    revenueCapUsd: 10_000_000,
    whiteLabel: false,
    summary: "For product teams operating InfiniBot commercially across several workspaces.",
    features: [
      "Up to 20 seats",
      "Up to 3 organizations",
      "Hosted or embedded service",
      "Priority email support",
    ],
  },
  {
    id: "agency",
    name: "Agency / Reseller",
    priceCents: 249_900,
    interval: "180_days",
    billingDays: 180,
    seats: 50,
    organizations: 25,
    revenueCapUsd: 25_000_000,
    whiteLabel: true,
    summary: "For agencies, managed-service providers, resellers and white-label deployments.",
    features: [
      "Up to 50 staff seats",
      "Up to 25 client organizations",
      "Resale and managed hosting",
      "White-label rights",
    ],
  },
  {
    id: "enterprise",
    name: "Enterprise / OEM",
    priceCents: 249_900,
    interval: "60_days",
    billingDays: 60,
    seats: 250,
    organizations: 100,
    revenueCapUsd: null,
    whiteLabel: true,
    summary: "For large deployments, OEM distribution and negotiated support or source terms.",
    features: [
      "Up to 250 seats",
      "Up to 100 organizations",
      "OEM and white-label rights",
      "Contract and support addenda",
    ],
  },
] as const;

/** Commercial uses granted per tier (Agreement §4.1); recorded in the signed key. */
export function commercialUsesForTier(id: CommercialTierId, whiteLabel: boolean): string[] {
  const uses = ["internal", "competing", "hosted", "distributed"];
  if (id === "agency" || id === "enterprise") uses.push("managed-services", "resale");
  if (id === "enterprise") uses.push("oem");
  if (whiteLabel) uses.push("white-label");
  return uses;
}

export function commercialTier(id: unknown): CommercialTier | null {
  return COMMERCIAL_TIERS.find((tier) => tier.id === id) ?? null;
}

export function licenseExpirySeconds(issuedAtSeconds: number, years = 1): number {
  const at = new Date(issuedAtSeconds * 1000);
  at.setUTCFullYear(at.getUTCFullYear() + years);
  return Math.floor(at.getTime() / 1000);
}
