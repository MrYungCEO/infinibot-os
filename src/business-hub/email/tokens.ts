/**
 * Business hub email — HMAC-signed tokens for the public, self-authenticating
 * routes: open pixel, click redirect, unsubscribe, and the contact token a
 * click carries to the landing page (`ib_c`) for identity stitching.
 *
 * Format: base64url(JSON payload) + "." + base64url(HMAC-SHA256)[0..22].
 * The payload names its kind (`t`), so an open token can never be replayed
 * as an unsubscribe or a redirect token.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { HubDb } from "../db.js";
import { getTokenSecret, HUB_HTTP_BASE } from "./config.js";

export type OpenToken = { t: "o"; s: string };
export type ClickToken = { t: "k"; s: string; u: string };
export type UnsubToken = { t: "u"; e: string; s?: string; c?: string };
export type ContactToken = { t: "c"; c: string; x: number };
export type HubToken = OpenToken | ClickToken | UnsubToken | ContactToken;

const SIG_LEN = 22; // ~131 bits

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url").slice(0, SIG_LEN);
}

export function signToken(db: HubDb, payload: HubToken): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(getTokenSecret(db), body)}`;
}

/** Verify + decode a token of the expected kind; null when forged/expired/wrong kind. */
export function verifyToken<K extends HubToken["t"]>(
  db: HubDb,
  token: string,
  kind: K,
  now = Date.now(),
): Extract<HubToken, { t: K }> | null {
  if (typeof token !== "string" || token.length > 4096) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expect = sign(getTokenSecret(db), body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (p.t !== kind) return null;
  if (kind === "c" && (typeof p.x !== "number" || p.x * 1000 < now)) return null;
  return p as Extract<HubToken, { t: K }>;
}

const CONTACT_TOKEN_TTL_S = 60 * 60 * 24 * 60; // 60 days

export function contactToken(db: HubDb, contactId: string, now = Date.now()): string {
  return signToken(db, { t: "c", c: contactId, x: Math.floor(now / 1000) + CONTACT_TOKEN_TTL_S });
}

/**
 * Public URLs for the tracking routes. The gateway's plugin router matches
 * exact paths only, so tokens always travel as `?t=` on fixed paths.
 */
export function hubUrls(baseUrl: string) {
  const root = `${baseUrl}${HUB_HTTP_BASE}`;
  return {
    open: (token: string) => `${root}/t/o?t=${token}`,
    click: (token: string) => `${root}/t/k?t=${token}`,
    unsubscribe: (token: string) => `${root}/u?t=${token}`,
    snippet: `${root}/t/s.js`,
    collect: `${root}/t/c`,
  };
}
