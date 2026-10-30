/**
 * Owner / admin grant: unlocks paid plugins on the owner's own machine without
 * a KinglyVault device link.
 *
 * File: <shared state dir>/plugin-owner-grant.json (0600)
 *   { "version": 1, "token": "<RS256 JWT>" }
 *
 * The token is signed with the KinglyVault licence key — the same embedded
 * public key as purchase tokens (./kinglyvault-key.ts) — and must carry:
 *
 *   { iss: "kinglyvault", aud: "infinibot-plugins-owner", sub, role: "owner",
 *     machine: sha256("infinibot-owner:" + <this machine's id>), iat, exp,
 *     ent: [{ p: "*" | "<plugin id>", src: "admin:owner", until: null }] }
 *
 * Why a customer can't use it:
 *  - Only the KinglyVault private key (server env / KV `.env`, never shipped)
 *    can sign one; there is no env var, config key or build flag that skips
 *    the signature or swaps the key.
 *  - The audience differs from purchase tokens, so it can't be pasted through
 *    plugins.entitlements.import, and a purchase token dropped in this file is
 *    rejected.
 *  - It is bound to one machine id, so a copied file does nothing elsewhere.
 *  - `exp` is a hard end (no offline grace, no refresh). Re-mint to extend.
 *  - `*` covers first-party paid plugins only, as with plan tokens.
 *
 * Mint: `scripts/mint-owner-plugin-grant.mts` (needs the private key).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveSharedDir } from "../../config/paths.js";
import { verifyEntitlementToken, type EntitlementClaims, type PluginEntitlement } from "./store.js";

export const OWNER_GRANT_AUDIENCE = "infinibot-plugins-owner";
export const OWNER_GRANT_SOURCE = "admin:owner";

export function ownerGrantFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveSharedDir(env), "plugin-owner-grant.json");
}

let machineIdMemo: string | null | undefined;
let machineIdOverride: string | null | undefined;

/** Tests only: pretend to be another machine (undefined = real id). */
export function __setOwnerGrantMachineIdForTests(id: string | null | undefined): void {
  machineIdOverride = id;
}

function readMachineId(): string | null {
  for (const f of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const v = fs.readFileSync(f, "utf8").trim();
      if (v) return v;
    } catch {
      // try the next one
    }
  }
  try {
    if (process.platform === "darwin") {
      const out = execFileSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
        encoding: "utf8",
        timeout: 3000,
      });
      return /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out)?.[1] ?? null;
    }
    if (process.platform === "win32") {
      const out = execFileSync(
        "reg",
        ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"],
        { encoding: "utf8", timeout: 3000 },
      );
      return /MachineGuid\s+REG_SZ\s+(\S+)/.exec(out)?.[1] ?? null;
    }
  } catch {
    // no machine id → no owner grant on this machine
  }
  return null;
}

/** sha256 of this machine's OS id, as stored in the grant's `machine` claim. */
export function ownerMachineHash(): string | null {
  const id =
    machineIdOverride !== undefined ? machineIdOverride : (machineIdMemo ??= readMachineId());
  if (!id) return null;
  return createHash("sha256").update(`infinibot-owner:${id}`).digest("hex");
}

export type OwnerGrantState =
  | { state: "none" }
  | { state: "invalid"; reason: string }
  | { state: "wrong-machine"; claims: EntitlementClaims }
  | { state: "expired"; claims: EntitlementClaims }
  | { state: "valid"; claims: EntitlementClaims };

let memo: { file: string; mtimeMs: number; token: string | null } | null = null;

function readGrantToken(env: NodeJS.ProcessEnv): string | null {
  const file = ownerGrantFilePath(env);
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  if (memo && memo.file === file && memo.mtimeMs === st.mtimeMs) return memo.token;
  let token: string | null = null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { token?: unknown };
    token = typeof raw.token === "string" ? raw.token.trim() : null;
  } catch {
    token = null;
  }
  memo = { file, mtimeMs: st.mtimeMs, token };
  return token;
}

export function ownerGrantStateOf(token: string | null, now = Date.now()): OwnerGrantState {
  if (!token) return { state: "none" };
  const v = verifyEntitlementToken(token, OWNER_GRANT_AUDIENCE);
  if (!v.ok) return { state: "invalid", reason: v.reason };
  const raw = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
  if (raw.role !== "owner") return { state: "invalid", reason: "not an owner grant" };
  const here = ownerMachineHash();
  if (!here || raw.machine !== here) return { state: "wrong-machine", claims: v.claims };
  if (now >= v.claims.exp * 1000) return { state: "expired", claims: v.claims };
  return { state: "valid", claims: v.claims };
}

export function ownerGrantState(
  now = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): OwnerGrantState {
  return ownerGrantStateOf(readGrantToken(env), now);
}

/** The owner grant's entitlement for `id`, or null when it doesn't cover it. */
export function ownerGrantEntitlement(
  id: string,
  now: number,
  wildcard: boolean,
  env: NodeJS.ProcessEnv = process.env,
): PluginEntitlement | null {
  const g = ownerGrantState(now, env);
  if (g.state !== "valid") return null;
  const item = g.claims.ent.find(
    (e) => (e.p === id || (wildcard && e.p === "*")) && (e.until === null || e.until * 1000 > now),
  );
  if (!item) return null;
  return {
    state: "valid",
    source: OWNER_GRANT_SOURCE,
    until: new Date(g.claims.exp * 1000).toISOString(),
  };
}

/** Part of the loader cache key (see store.entitlementCacheStamp). */
export function ownerGrantStamp(now = Date.now(), env: NodeJS.ProcessEnv = process.env): string {
  const token = readGrantToken(env);
  if (!token) return "owner-none";
  const digest = createHash("sha256").update(token).digest("hex").slice(0, 12);
  return `owner-${digest}:${ownerGrantStateOf(token, now).state}`;
}

export function ownerGrantSummary(
  now = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): {
  active: boolean;
  state: OwnerGrantState["state"];
  subject: string | null;
  expiresAt: string | null;
} | null {
  const g = ownerGrantState(now, env);
  if (g.state === "none") return null;
  const claims = "claims" in g ? g.claims : null;
  return {
    active: g.state === "valid",
    state: g.state,
    subject: claims?.sub ?? null,
    expiresAt: claims ? new Date(claims.exp * 1000).toISOString() : null,
  };
}
