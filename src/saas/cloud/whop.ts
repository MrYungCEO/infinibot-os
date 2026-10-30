// Open-source build stub: the real module is part of the hosted product (see docs/licensing/PRIVATE-SPLIT.md).
export type PaidTier = "starter" | "pro" | "business" | "scale";

export type Env = Record<string, string | undefined>;

export type SignatureResult = { ok: true } | { ok: false; reason: string };

export type WhopAction = "activate" | "deactivate" | "payment_failed" | "ignore";

export interface WhopEvent {
  eventId: string;
  type: string;
  action: WhopAction;
  tenantId: string | null;
  membershipId: string | null;
  paymentId: string | null;
  planId: string | null;
  tier: PaidTier | null;
  amountUsd: number | null;
  manageUrl?: string | null;
  entitlement?: string | null;
  email?: string | null;
}

type HeaderSource = Headers | Record<string, string>;

/** Fails closed: nothing is verified in this build. */
export function verifyWhopSignature(
  _headers: HeaderSource,
  _body: string,
  _secret: string,
  _nowSeconds?: number,
): SignatureResult {
  return { ok: false, reason: "not available in the open-source build" };
}

export function parseWhopEvent(
  _body: unknown,
  _deliveryId: string | null,
  _env: Env = {},
): WhopEvent {
  throw new Error("not available in the open-source build");
}
