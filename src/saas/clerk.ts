// Open-source build stub: the real module is part of the hosted product (see docs/licensing/PRIVATE-SPLIT.md).
export interface ClerkIdentity {
  clerkUserId: string;
  email?: string;
  claims: Record<string, unknown>;
}

/** No Clerk here: every token is refused. */
export async function verifyClerkToken(_token: string | undefined): Promise<ClerkIdentity | null> {
  return null;
}
