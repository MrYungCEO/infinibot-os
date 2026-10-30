/**
 * One KinglyVault connection: an install linked through KinglyVault Connect
 * (the agent relay, extensions/kinglyvault-relay) also gets its plugin licence
 * from the same link — no second "Connect" step.
 *
 * The relay keeps its device secret in <state dir>/kinglyvault-relay/state.json
 * (0600). While this install has no plugin-licence device link yet, the gateway
 * hands that secret to KinglyVault's `infinibot-entitlements` function
 * (`relay-exchange`), which checks it against the relay connection (hash only)
 * and answers with a plugin-licence device link (refresh token) plus a signed
 * entitlement token for the same account. From then on the normal refresh
 * loop (./store.ts) keeps it in sync; the relay secret is not used again.
 *
 * Runs at start (so already-paired installs need no re-pairing) and whenever
 * the relay state changes (a new pairing). Never logs the secret or tokens.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveSharedDir } from "../../config/paths.js";
import {
  entitlementsApiUrl,
  importEntitlementToken,
  readEntitlementFile,
  writeEntitlementFile,
  type EntitlementSummary,
} from "./store.js";

type FetchImpl = typeof fetch;

export function relayStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveSharedDir(env), "kinglyvault-relay", "state.json");
}

/** The relay's device secret + connection id, when this install is paired. */
export function readRelayLink(
  env: NodeJS.ProcessEnv = process.env,
): { secret: string; connectionId: string | null; deviceName: string | null } | null {
  try {
    const s = JSON.parse(fs.readFileSync(relayStatePath(env), "utf8")) as Record<string, unknown>;
    if (typeof s.deviceSecret !== "string" || s.deviceSecret.length < 20) return null;
    return {
      secret: s.deviceSecret,
      connectionId: typeof s.connectionId === "string" ? s.connectionId : null,
      deviceName: typeof s.deviceName === "string" ? s.deviceName : null,
    };
  } catch {
    return null;
  }
}

export type RelayLinkResult =
  | { ok: true; changed: string[]; summary: EntitlementSummary }
  | {
      ok: false;
      /** not-paired / already-linked are normal; the rest are worth showing. */
      reason:
        | "not-paired"
        | "already-linked"
        | "unavailable"
        | "refused"
        | "unreachable"
        | "bad-token";
      error?: string;
    };

const fingerprint = (secret: string) =>
  createHash("sha256").update(`relay-exchange:${secret}`).digest("hex").slice(0, 16);

/** Secrets KinglyVault refused (revoked / unknown): don't ask again for them. */
const refused = new Set<string>();

/**
 * Link the plugin licence from the relay pairing when it isn't linked yet.
 * Safe to call often: it does nothing once linked or when not paired.
 */
export async function linkEntitlementsFromRelay(
  opts: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: FetchImpl;
    now?: () => number;
    /** Ask again even if KinglyVault refused this secret before. */
    force?: boolean;
  } = {},
): Promise<RelayLinkResult> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const file = readEntitlementFile(env);
  if (file.refreshToken) return { ok: false, reason: "already-linked" };
  const relay = readRelayLink(env);
  if (!relay) return { ok: false, reason: "not-paired" };
  const fp = fingerprint(relay.secret);
  if (refused.has(fp) && !opts.force) return { ok: false, reason: "refused" };
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(entitlementsApiUrl(file, env), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "relay-exchange",
        relaySecret: relay.secret,
        label: relay.deviceName ?? undefined,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    const error = `KinglyVault can't be reached right now (${String((err as Error)?.message ?? err)}). Your saved plugin access keeps working meanwhile.`;
    recordError(error, env, now());
    return { ok: false, reason: "unreachable", error };
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  if (res.status === 401 || res.status === 403 || res.status === 410) {
    refused.add(fp);
    const error =
      "KinglyVault no longer recognises this install's connection. Connect KinglyVault again to unlock your plugins.";
    recordError(error, env, now());
    return { ok: false, reason: "refused", error };
  }
  if (
    res.status === 404 ||
    res.status === 501 ||
    (res.status === 400 && body.error === "unknown_action")
  ) {
    return {
      ok: false,
      reason: "unavailable",
      error: "This KinglyVault doesn't support linking plugins from KinglyVault Connect yet.",
    };
  }
  if (res.status !== 200 || typeof body.token !== "string") {
    const error = `KinglyVault couldn't link your plugins (${res.status}${body.error ? `: ${String(body.error)}` : ""}).`;
    recordError(error, env, now());
    return { ok: false, reason: "unreachable", error };
  }
  const imported = importEntitlementToken(
    { token: body.token, refreshToken: body.refreshToken, apiUrl: body.apiUrl },
    env,
    now(),
  );
  if (!imported.ok) {
    recordError(imported.error, env, now());
    return { ok: false, reason: "bad-token", error: imported.error };
  }
  return { ok: true, changed: imported.changed, summary: imported.summary };
}

function recordError(msg: string, env: NodeJS.ProcessEnv, at: number) {
  const file = readEntitlementFile(env);
  // Only annotate an existing licence file; never create one just for an error.
  if (!file.token && !file.refreshToken) return;
  try {
    writeEntitlementFile({ ...file, lastError: msg, lastRefreshAt: at }, env);
  } catch {
    // best effort
  }
}

/** Tests only. */
export function resetRelayLinkForTests(): void {
  refused.clear();
}
