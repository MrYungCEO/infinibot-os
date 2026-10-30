/**
 * In-memory invite token store for one-time device pairing.
 *
 * Tokens are 32 random hex chars (16 bytes), single-use, and expire after
 * 15 minutes. The store is process-local — restarts invalidate all pending
 * invites, which is acceptable (they're short-lived convenience links).
 */

import { randomBytes } from "node:crypto";

const TTL_MS = 15 * 60 * 1000; // 15 minutes

type InviteEntry = {
  token: string;
  createdAt: number;
  expiresAt: number;
};

const store = new Map<string, InviteEntry>();

function pruneExpired(): void {
  const now = Date.now();
  for (const [token, entry] of store) {
    if (now >= entry.expiresAt) {
      store.delete(token);
    }
  }
}

export function createInviteToken(): { token: string; expiresAt: number } {
  pruneExpired();
  const token = randomBytes(16).toString("hex");
  const now = Date.now();
  const expiresAt = now + TTL_MS;
  store.set(token, { token, createdAt: now, expiresAt });
  return { token, expiresAt };
}

/**
 * Consume (single-use) an invite token.
 * Returns true if the token was valid and has been removed; false otherwise.
 */
export function consumeInviteToken(token: string): boolean {
  pruneExpired();
  if (!token || typeof token !== "string") return false;
  const entry = store.get(token);
  if (!entry) return false;
  if (Date.now() >= entry.expiresAt) {
    store.delete(token);
    return false;
  }
  store.delete(token);
  return true;
}

export function listInviteTokens(): Array<{ token: string; expiresAt: number; createdAt: number }> {
  pruneExpired();
  return Array.from(store.values()).map((e) => ({
    token: e.token,
    expiresAt: e.expiresAt,
    createdAt: e.createdAt,
  }));
}
