import { createHash, randomUUID, sign, verify } from "node:crypto";
import {
  COMMERCIAL_LICENSE_AUDIENCE,
  COMMERCIAL_LICENSE_GRACE_DAYS,
  COMMERCIAL_LICENSE_ISSUER,
  COMMERCIAL_LICENSE_KEY_ID,
  COMMERCIAL_LICENSE_VERSION,
  COMMERCIAL_LICENSOR,
  commercialTier,
  type CommercialTierId,
} from "./catalog.js";
import { COMMERCIAL_LICENSE_PUBLIC_KEY_PEM } from "./public-key.js";

export type CommercialLicensePayload = {
  iss: typeof COMMERCIAL_LICENSE_ISSUER;
  aud: typeof COMMERCIAL_LICENSE_AUDIENCE;
  sub: string;
  jti: string;
  iat: number;
  nbf: number;
  exp: number;
  tier: CommercialTierId;
  /** Licensor named in the Commercial License Agreement. */
  licensor?: string;
  licensee: string;
  email: string;
  seats: number;
  organizations: number;
  whiteLabel: boolean;
  /** Annual Gross Revenue limit in USD; null = no standard limit. */
  revenueCapUsd?: number | null;
  /** Billing term: each paid period extends the key by termDays. */
  term?: { interval: string; termDays: number; autoRenew: boolean };
  commercialUses: string[];
  graceDays: number;
  agreementVersion: string;
  source: "whop" | "manual" | "complimentary";
};

type TokenHeader = { alg: "EdDSA"; typ: "JWT"; kid: string };

const b64u = (value: string | Buffer) => Buffer.from(value).toString("base64url");

function jsonPart(value: unknown): string {
  return b64u(JSON.stringify(value));
}

export function decodeCommercialLicense(token: string): CommercialLicensePayload | null {
  const parts = token.trim().split(".");
  if (parts.length !== 3) return null;
  try {
    const value = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    return value && typeof value === "object" ? (value as CommercialLicensePayload) : null;
  } catch {
    return null;
  }
}

export type CommercialLicenseVerification = {
  valid: boolean;
  payload: CommercialLicensePayload | null;
  state: "active" | "grace" | "expired" | "invalid";
  reason?: string;
};

export function verifyCommercialLicense(
  token: string,
  options: { publicKeyPem?: string; nowSeconds?: number } = {},
): CommercialLicenseVerification {
  const parts = token.trim().split(".");
  const payload = decodeCommercialLicense(token);
  if (parts.length !== 3 || !payload)
    return { valid: false, payload: null, state: "invalid", reason: "malformed" };
  let header: TokenHeader;
  try {
    header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as TokenHeader;
  } catch {
    return { valid: false, payload, state: "invalid", reason: "malformed_header" };
  }
  if (header.alg !== "EdDSA" || header.kid !== COMMERCIAL_LICENSE_KEY_ID)
    return { valid: false, payload, state: "invalid", reason: "unsupported_key" };
  const ok = verify(
    null,
    Buffer.from(`${parts[0]}.${parts[1]}`),
    options.publicKeyPem ?? COMMERCIAL_LICENSE_PUBLIC_KEY_PEM,
    Buffer.from(parts[2]!, "base64url"),
  );
  if (!ok) return { valid: false, payload, state: "invalid", reason: "bad_signature" };
  if (payload.iss !== COMMERCIAL_LICENSE_ISSUER || payload.aud !== COMMERCIAL_LICENSE_AUDIENCE)
    return { valid: false, payload, state: "invalid", reason: "wrong_issuer_or_audience" };
  if (!commercialTier(payload.tier) || !payload.sub || !payload.jti || !payload.licensee)
    return { valid: false, payload, state: "invalid", reason: "invalid_claims" };
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (payload.nbf > now + 300)
    return { valid: false, payload, state: "invalid", reason: "not_yet_valid" };
  if (payload.exp >= now) return { valid: true, payload, state: "active" };
  if (payload.exp + payload.graceDays * 86_400 >= now)
    return { valid: true, payload, state: "grace", reason: "expired_in_grace" };
  return { valid: false, payload, state: "expired", reason: "expired" };
}

export function signCommercialLicense(
  input: Omit<
    CommercialLicensePayload,
    "iss" | "aud" | "jti" | "agreementVersion" | "graceDays" | "licensor"
  > & { jti?: string },
  privateKeyPem: string,
): { token: string; payload: CommercialLicensePayload } {
  const catalog = commercialTier(input.tier);
  const payload: CommercialLicensePayload = {
    ...input,
    licensor: COMMERCIAL_LICENSOR,
    revenueCapUsd:
      input.revenueCapUsd !== undefined ? input.revenueCapUsd : (catalog?.revenueCapUsd ?? null),
    term: input.term ?? {
      interval: catalog?.interval ?? "year",
      termDays: catalog?.billingDays ?? 365,
      autoRenew: true,
    },
    iss: COMMERCIAL_LICENSE_ISSUER,
    aud: COMMERCIAL_LICENSE_AUDIENCE,
    jti: input.jti ?? randomUUID(),
    graceDays: COMMERCIAL_LICENSE_GRACE_DAYS,
    agreementVersion: COMMERCIAL_LICENSE_VERSION,
  };
  const encoded = `${jsonPart({ alg: "EdDSA", typ: "JWT", kid: COMMERCIAL_LICENSE_KEY_ID } satisfies TokenHeader)}.${jsonPart(payload)}`;
  const signature = sign(null, Buffer.from(encoded), privateKeyPem);
  return { token: `${encoded}.${b64u(signature)}`, payload };
}

export function licenseTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Deployment-friendly private-key loader (multiline PEM or base64-encoded PEM). */
export function commercialPrivateKey(env: Record<string, string | undefined>): string {
  const pem = env.COMMERCIAL_LICENSE_PRIVATE_KEY?.trim();
  if (pem) return pem.replace(/\\n/g, "\n");
  const encoded = env.COMMERCIAL_LICENSE_PRIVATE_KEY_B64?.trim();
  if (encoded) {
    const decoded = Buffer.from(encoded, "base64").toString("utf8").trim();
    if (decoded.includes("BEGIN PRIVATE KEY")) return decoded;
  }
  throw new Error("COMMERCIAL_LICENSE_PRIVATE_KEY is not configured");
}
