// Open-source build stub: the real module is part of the hosted product (see docs/licensing/PRIVATE-SPLIT.md).
export interface OwnerCheck {
  ok: boolean;
  status: number;
  email?: string;
  ownerEmail?: string;
}

/** Fails closed: no platform owner exists in this build. */
export async function requireOwner(_token: string | undefined): Promise<OwnerCheck> {
  return { ok: false, status: 500 };
}
