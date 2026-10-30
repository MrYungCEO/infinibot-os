/**
 * Business hub revenue — connected payment accounts (`revenue_accounts`).
 *
 * A key is stored either encrypted (`secret`, via services/email/secret-crypto)
 * or as a reference (`secret_ref`): `env:NAME` or `env-file:/abs/path#NAME`,
 * resolved at sync time and never copied into the database. Nothing here
 * returns a key: listings show provider, label, `••••last4` company ref and
 * the key kind only. `discoverAccounts()` finds keys already on this install
 * (plugin settings, env, legacy income.json) and reports a sha256 fingerprint
 * so the UI can connect them without re-pasting.
 *
 * InfiniBot Cloud (a fleet tenant Machine, FLEET_TENANT_ID set): the Machine's
 * env and filesystem belong to the platform, not the tenant, so key references
 * are refused and env keys are never discovered — a tenant pastes its own
 * Whop / Stripe key (BYOK), stored encrypted in its own hub database.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isFleetTenantMachineEnv } from "../../saas/fleet-config-guard.js";
import type { HubDb } from "../db.js";
import { hubId } from "../util.js";
import { rec, s, type RevenueProvider } from "./types.js";

export type KeyKind = "stored" | "env" | "env-file" | "none";
export type AccountStatus = "idle" | "syncing" | "ok" | "error" | "paused";

/** Full account row (internal — carries the encrypted secret / ref). */
export type RevenueAccount = {
  id: string;
  provider: RevenueProvider;
  label: string;
  companyRef: string | null;
  apiVersion: string | null;
  secret: string | null;
  secretRef: string | null;
  webhookSecret: string | null;
  status: AccountStatus;
  lastError: string | null;
  lastSyncAt: number | null;
  businessId: string | null;
  createdAt: number;
  updatedAt: number;
};

export type SyncStateInfo = {
  object: string;
  cursor: boolean;
  backfillDone: boolean;
  highWater: number | null;
  fetched: number;
  pages: number;
  lastRunAt: number | null;
  lastError: string | null;
};

export type MaskedAccount = {
  id: string;
  provider: RevenueProvider;
  label: string;
  companyRef: string | null;
  apiVersion: string | null;
  keyKind: KeyKind;
  keyRefName: string | null;
  hasWebhookSecret: boolean;
  status: AccountStatus;
  lastSyncAt: number | null;
  lastError: string | null;
  businessId: string | null;
  sync: SyncStateInfo[];
  counts: { txns: Record<string, number>; subscriptions: number; products: number };
  createdAt: number;
};

export type SecretCodec = {
  encrypt(plain: string): string | null;
  decrypt(blob: string): string | null;
};

let defaultCodecPromise: Promise<SecretCodec> | null = null;

/** The install's AES-GCM codec (lazy — only touched when a key is stored). */
export function defaultSecretCodec(): Promise<SecretCodec> {
  defaultCodecPromise ??= import("../../services/email/secret-crypto.js").then((m) => ({
    encrypt: (p: string) => m.encryptSecret(p),
    decrypt: (b: string) => m.decryptSecret(b),
  }));
  return defaultCodecPromise;
}

// ── Secret references ─────────────────────────────────────────────────────────

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type ParsedRef =
  | { kind: "env"; name: string }
  | { kind: "env-file"; path: string; name: string };

export const CLOUD_SECRET_REF_ERROR =
  "Key references (env:/env-file:) are self-hosted only — paste the key itself on InfiniBot Cloud";

export function parseSecretRef(ref: string, env: NodeJS.ProcessEnv = process.env): ParsedRef {
  if (isFleetTenantMachineEnv(env)) throw new Error(CLOUD_SECRET_REF_ERROR);
  const r = ref.trim();
  if (r.startsWith("env:")) {
    const name = r.slice(4);
    if (!ENV_NAME_RE.test(name)) throw new Error("secretRef env:NAME has an invalid name");
    return { kind: "env", name };
  }
  if (r.startsWith("env-file:")) {
    const body = r.slice(9);
    const hash = body.lastIndexOf("#");
    const path = hash > 0 ? body.slice(0, hash) : "";
    const name = hash > 0 ? body.slice(hash + 1) : "";
    if (!path || !isAbsolute(path)) throw new Error("secretRef env-file: needs an absolute path");
    if (!ENV_NAME_RE.test(name)) throw new Error("secretRef env-file:/path#NAME needs a NAME");
    return { kind: "env-file", path, name };
  }
  throw new Error("secretRef must be env:NAME or env-file:/abs/path#NAME");
}

/** Read one variable from a dotenv-style file (no interpolation). */
export function readEnvFileVar(path: string, name: string): string | null {
  let txt: string;
  try {
    txt = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let found: string | null = null;
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || m[1] !== name) continue;
    let v = m[2].trim();
    const q = v[0];
    if ((q === '"' || q === "'") && v.lastIndexOf(q) > 0) v = v.slice(1, v.lastIndexOf(q));
    else v = v.replace(/\s+#.*$/, "");
    found = v.trim() || null;
  }
  return found;
}

export function resolveSecretRef(ref: string, env: NodeJS.ProcessEnv = process.env): string | null {
  // Cloud: never read the platform's env or files on a tenant's behalf.
  if (isFleetTenantMachineEnv(env)) return null;
  const p = parseSecretRef(ref, env);
  if (p.kind === "env") return env[p.name]?.trim() || null;
  return readEnvFileVar(p.path, p.name);
}

function isRef(v: string | null): v is string {
  return !!v && (v.startsWith("env:") || v.startsWith("env-file:"));
}

/** The plaintext key for an account (never log or return it). */
export async function resolveAccountSecret(
  acct: RevenueAccount,
  codec?: SecretCodec,
): Promise<string | null> {
  if (acct.secretRef) return resolveSecretRef(acct.secretRef);
  if (acct.secret) return (codec ?? (await defaultSecretCodec())).decrypt(acct.secret);
  return null;
}

export async function resolveWebhookSecret(
  acct: RevenueAccount,
  codec?: SecretCodec,
): Promise<string | null> {
  const w = acct.webhookSecret;
  if (!w) return null;
  if (isRef(w)) return resolveSecretRef(w);
  return (codec ?? (await defaultSecretCodec())).decrypt(w);
}

export function fingerprint(secret: string): string {
  return createHash("sha256").update(secret.trim()).digest("hex").slice(0, 8);
}

export function maskTail(v: string | null | undefined): string | null {
  if (!v) return null;
  return `••••${v.slice(-4)}`;
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

function rowToAccount(r: Row): RevenueAccount {
  return {
    id: r.id as string,
    provider: r.provider as RevenueProvider,
    label: r.label as string,
    companyRef: (r.company_ref as string) ?? null,
    apiVersion: (r.api_version as string) ?? null,
    secret: (r.secret as string) ?? null,
    secretRef: (r.secret_ref as string) ?? null,
    webhookSecret: (r.webhook_secret as string) ?? null,
    status: r.status as AccountStatus,
    lastError: (r.last_error as string) ?? null,
    lastSyncAt: (r.last_sync_at as number) ?? null,
    businessId: (r.business_id as string) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

export function getAccount(db: HubDb, id: string): RevenueAccount | null {
  const r = db.prepare("SELECT * FROM revenue_accounts WHERE id = ?").get(id) as Row | undefined;
  return r ? rowToAccount(r) : null;
}

export function getAccounts(db: HubDb): RevenueAccount[] {
  return (db.prepare("SELECT * FROM revenue_accounts ORDER BY created_at").all() as Row[]).map(
    rowToAccount,
  );
}

const PROVIDERS: readonly RevenueProvider[] = ["whop", "stripe", "legacy"];

export type AccountInput = {
  provider: RevenueProvider;
  label: string;
  companyRef?: string | null;
  apiVersion?: string | null;
  secret?: string | null;
  secretRef?: string | null;
  webhookSecret?: string | null;
  businessId?: string | null;
};

async function encodeSecret(
  plain: string | null | undefined,
  codec?: SecretCodec,
): Promise<string | null> {
  const v = plain?.trim();
  if (!v) return null;
  const enc = (codec ?? (await defaultSecretCodec())).encrypt(v);
  if (!enc) throw new Error("could not encrypt secret");
  return enc;
}

/** Webhook secrets accept a ref (`env:` / `env-file:`) or a value (encrypted). */
async function encodeWebhookSecret(
  v: string | null | undefined,
  codec?: SecretCodec,
): Promise<string | null> {
  const t = v?.trim();
  if (!t) return null;
  if (isRef(t)) {
    parseSecretRef(t);
    return t;
  }
  return encodeSecret(t, codec);
}

export async function createAccount(
  db: HubDb,
  input: AccountInput,
  codec?: SecretCodec,
): Promise<RevenueAccount> {
  if (!PROVIDERS.includes(input.provider)) throw new Error(`unknown provider: ${input.provider}`);
  const label = input.label?.trim();
  if (!label) throw new Error("label required");
  if (input.secretRef) parseSecretRef(input.secretRef);
  if (input.provider !== "legacy" && !input.secret?.trim() && !input.secretRef)
    throw new Error("secret or secretRef required");
  const id = hubId("racct");
  const now = Date.now();
  db.prepare(
    `INSERT INTO revenue_accounts(id,provider,label,company_ref,api_version,secret,secret_ref,webhook_secret,status,business_id,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    input.provider,
    label,
    input.companyRef?.trim() || null,
    input.apiVersion ?? null,
    input.secretRef ? null : await encodeSecret(input.secret, codec),
    input.secretRef?.trim() || null,
    await encodeWebhookSecret(input.webhookSecret, codec),
    "idle",
    input.businessId ?? null,
    now,
    now,
  );
  return getAccount(db, id)!;
}

export type AccountPatch = {
  label?: string;
  companyRef?: string | null;
  apiVersion?: string | null;
  secret?: string;
  secretRef?: string;
  webhookSecret?: string | null;
  status?: "paused" | "idle";
  businessId?: string | null;
};

export async function updateAccount(
  db: HubDb,
  id: string,
  patch: AccountPatch,
  codec?: SecretCodec,
): Promise<RevenueAccount> {
  const cur = getAccount(db, id);
  if (!cur) throw new Error("account not found");
  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown) => {
    sets.push(`${col} = ?`);
    vals.push(v);
  };
  if (patch.label !== undefined) {
    if (!patch.label.trim()) throw new Error("label cannot be empty");
    set("label", patch.label.trim());
  }
  if (patch.companyRef !== undefined) {
    set("company_ref", patch.companyRef?.trim() || null);
    set("api_version", null); // re-detect against the new company
  }
  if (patch.apiVersion !== undefined) set("api_version", patch.apiVersion);
  if (patch.secretRef) {
    parseSecretRef(patch.secretRef);
    set("secret_ref", patch.secretRef.trim());
    set("secret", null);
    set("api_version", null);
  } else if (patch.secret?.trim()) {
    set("secret", await encodeSecret(patch.secret, codec));
    set("secret_ref", null);
    set("api_version", null);
  }
  if (patch.webhookSecret !== undefined)
    set("webhook_secret", await encodeWebhookSecret(patch.webhookSecret, codec));
  if (patch.status) set("status", patch.status);
  if (patch.businessId !== undefined) set("business_id", patch.businessId);
  if (sets.length) {
    set("updated_at", Date.now());
    vals.push(id);
    db.prepare(`UPDATE revenue_accounts SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }
  return getAccount(db, id)!;
}

export function setAccountStatus(
  db: HubDb,
  id: string,
  status: AccountStatus,
  fields: { lastError?: string | null; lastSyncAt?: number; apiVersion?: string } = {},
): void {
  const sets = ["status = ?", "updated_at = ?"];
  const vals: unknown[] = [status, Date.now()];
  if (fields.lastError !== undefined) {
    sets.push("last_error = ?");
    vals.push(fields.lastError);
  }
  if (fields.lastSyncAt !== undefined) {
    sets.push("last_sync_at = ?");
    vals.push(fields.lastSyncAt);
  }
  if (fields.apiVersion !== undefined) {
    sets.push("api_version = ?");
    vals.push(fields.apiVersion);
  }
  vals.push(id);
  db.prepare(`UPDATE revenue_accounts SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

/** Remove an account; ledger/subscription/product rows only go with `purgeLedger`. */
export function removeAccount(
  db: HubDb,
  id: string,
  opts: { purgeLedger?: boolean } = {},
): { removed: boolean; purged: number } {
  let purged = 0;
  const removed = db.transaction(() => {
    const r = db.prepare("DELETE FROM revenue_accounts WHERE id = ?").run(id);
    db.prepare("DELETE FROM revenue_sync_state WHERE account_id = ?").run(id);
    if (opts.purgeLedger) {
      purged += db.prepare("DELETE FROM revenue_txns WHERE account_id = ?").run(id).changes;
      purged += db
        .prepare("DELETE FROM revenue_subscriptions WHERE account_id = ?")
        .run(id).changes;
      purged += db.prepare("DELETE FROM revenue_products WHERE account_id = ?").run(id).changes;
      db.prepare("DELETE FROM revenue_webhook_events WHERE account_id = ?").run(id);
    }
    return r.changes > 0;
  })();
  return { removed, purged };
}

export function syncStates(db: HubDb, accountId: string): SyncStateInfo[] {
  return (
    db
      .prepare("SELECT * FROM revenue_sync_state WHERE account_id = ? ORDER BY object")
      .all(accountId) as Row[]
  ).map((r) => ({
    object: r.object as string,
    cursor: r.cursor !== null,
    backfillDone: r.backfill_done === 1,
    highWater: (r.high_water as number) ?? null,
    fetched: r.fetched as number,
    pages: r.pages as number,
    lastRunAt: (r.last_run_at as number) ?? null,
    lastError: (r.last_error as string) ?? null,
  }));
}

function keyKind(a: RevenueAccount): { kind: KeyKind; name: string | null } {
  if (a.secretRef) {
    const p = parseSecretRef(a.secretRef);
    return { kind: p.kind, name: p.name };
  }
  return { kind: a.secret ? "stored" : "none", name: null };
}

export function maskAccount(db: HubDb, a: RevenueAccount): MaskedAccount {
  const txns: Record<string, number> = {};
  for (const r of db
    .prepare("SELECT type, COUNT(*) AS c FROM revenue_txns WHERE account_id = ? GROUP BY type")
    .all(a.id) as Array<{ type: string; c: number }>)
    txns[r.type] = r.c;
  const count = (table: string) =>
    (
      db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE account_id = ?`).get(a.id) as {
        c: number;
      }
    ).c;
  const k = keyKind(a);
  return {
    id: a.id,
    provider: a.provider,
    label: a.label,
    companyRef: maskTail(a.companyRef),
    apiVersion: a.apiVersion,
    keyKind: k.kind,
    keyRefName: k.name,
    hasWebhookSecret: !!a.webhookSecret,
    status: a.status,
    lastSyncAt: a.lastSyncAt,
    lastError: a.lastError,
    businessId: a.businessId,
    sync: syncStates(db, a.id),
    counts: {
      txns,
      subscriptions: count("revenue_subscriptions"),
      products: count("revenue_products"),
    },
    createdAt: a.createdAt,
  };
}

export function listAccounts(db: HubDb): MaskedAccount[] {
  return getAccounts(db).map((a) => maskAccount(db, a));
}

// ── Discovery ─────────────────────────────────────────────────────────────────

export type CandidateSource = "plugin-config" | "env" | "income-json";

export type AccountCandidate = {
  provider: "whop" | "stripe";
  fingerprint: string;
  label: string;
  sources: Array<{ source: CandidateSource; detail: string }>;
  /** Present when the key can be referenced instead of copied (env vars). */
  secretRef: string | null;
  companyRef: string | null;
  alreadyConnected: string | null;
  /** An account already syncs this Whop company with a different key (connecting would duplicate it). */
  companyConnected: string | null;
};

type RawCandidate = {
  provider: "whop" | "stripe";
  key: string;
  companyRef: string | null;
  source: CandidateSource;
  detail: string;
  label: string;
  secretRef: string | null;
};

export type DiscoverOptions = {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  /** Extra income.json paths (defaults: <stateDir>/business + cwd legacy). */
  incomePaths?: string[];
  /** Plugin config reader; defaults to the gateway config. */
  readConfig?: () => unknown;
  codec?: SecretCodec;
};

/** <stateDir>/business/income.json plus the cwd-relative path the old code used. */
export function legacyIncomePaths(stateDir?: string, env: NodeJS.ProcessEnv = process.env) {
  const out: string[] = [];
  if (stateDir) out.push(resolve(stateDir, "business", "income.json"));
  out.push(resolve(env.INFINIBOT_STATE_DIR || "state", "business", "income.json"));
  const seen = new Set<string>();
  return out.filter((p) => {
    let real = p;
    try {
      real = existsSync(p) ? realpathSync(p) : p;
    } catch {
      /* keep p */
    }
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  });
}

function readIncomeKeys(path: string): RawCandidate[] {
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  const out: RawCandidate[] = [];
  const add = (bizId: string, keys: unknown) => {
    const k = rec(keys);
    const whop = s(k.whop);
    if (whop)
      out.push({
        provider: "whop",
        key: whop,
        companyRef: s(k.whopCompanyId),
        source: "income-json",
        detail: `${path} (${bizId})`,
        label: `Whop (${bizId})`,
        secretRef: null,
      });
    const stripe = s(k.stripe);
    if (stripe)
      out.push({
        provider: "stripe",
        key: stripe,
        companyRef: null,
        source: "income-json",
        detail: `${path} (${bizId})`,
        label: `Stripe (${bizId})`,
        secretRef: null,
      });
  };
  const top = rec(raw);
  if (top.apiKeys) add("legacy", top.apiKeys);
  for (const [bizId, bucket] of Object.entries(rec(top.businesses)))
    add(bizId, rec(bucket).apiKeys);
  return out;
}

type PluginSettingsReader = {
  readBusinessAgencyProviderKey(provider: "whop" | "stripe", read?: () => unknown): string | null;
  readBusinessAgencySetting(key: string, read?: () => unknown): string | null;
};

/**
 * The business-agency runtime readers; when that module cannot load (e.g. a
 * partial checkout) and a config reader was given, read the same keys
 * (`plugins.entries.business-agency.config.*`) directly.
 */
async function pluginSettingsReader(readConfig?: () => unknown): Promise<PluginSettingsReader> {
  try {
    return await import("../../business-agency/runtime.js");
  } catch (err) {
    if (!readConfig) throw err;
    const setting = (key: string, read: () => unknown = readConfig) => {
      const entries = rec(rec(rec(read()).plugins).entries);
      return s(rec(rec(entries["business-agency"]).config)[key]);
    };
    const keys = { whop: "whopApiKey", stripe: "stripeSecretKey" } as const;
    return {
      readBusinessAgencyProviderKey: (provider, read) => setting(keys[provider], read),
      readBusinessAgencySetting: setting,
    };
  }
}

async function rawCandidates(opts: DiscoverOptions): Promise<RawCandidate[]> {
  const env = opts.env ?? process.env;
  const out: RawCandidate[] = [];
  try {
    const rt = await pluginSettingsReader(opts.readConfig);
    const read = opts.readConfig;
    const whop = rt.readBusinessAgencyProviderKey("whop", read);
    if (whop)
      out.push({
        provider: "whop",
        key: whop,
        companyRef: rt.readBusinessAgencySetting("whopCompanyId", read),
        source: "plugin-config",
        detail: "plugins.entries.business-agency.config.whopApiKey",
        label: "Whop (plugin settings)",
        secretRef: null,
      });
    const stripe = rt.readBusinessAgencyProviderKey("stripe", read);
    if (stripe)
      out.push({
        provider: "stripe",
        key: stripe,
        companyRef: null,
        source: "plugin-config",
        detail: "plugins.entries.business-agency.config.stripeSecretKey",
        label: "Stripe (plugin settings)",
        secretRef: null,
      });
  } catch {
    /* config unavailable */
  }
  const envKey = (name: string, provider: "whop" | "stripe") => {
    // Cloud: the Machine env is the platform's, never a tenant's key (BYOK only).
    if (isFleetTenantMachineEnv(env)) return;
    const v = env[name]?.trim();
    if (!v) return;
    out.push({
      provider,
      key: v,
      companyRef: provider === "whop" ? env.WHOP_COMPANY_ID?.trim() || null : null,
      source: "env",
      detail: name,
      label: `${provider === "whop" ? "Whop" : "Stripe"} (env)`,
      secretRef: `env:${name}`,
    });
  };
  envKey("WHOP_API_KEY", "whop");
  envKey("STRIPE_SECRET_KEY", "stripe");
  envKey("STRIPE_API_KEY", "stripe");
  for (const p of opts.incomePaths ?? legacyIncomePaths(opts.stateDir, env))
    out.push(...readIncomeKeys(p));
  return out;
}

/** Keys found on this install, deduped by fingerprint. Never returns a key. */
export async function discoverAccounts(
  db: HubDb,
  opts: DiscoverOptions = {},
): Promise<AccountCandidate[]> {
  const connected = new Map<string, string>();
  const byCompany = new Map<string, string>();
  for (const a of getAccounts(db))
    if (a.companyRef) byCompany.set(`${a.provider}|${a.companyRef}`, a.id);
  for (const a of getAccounts(db)) {
    try {
      const k = await resolveAccountSecret(a, opts.codec);
      if (k) connected.set(fingerprint(k), a.id);
    } catch {
      /* unresolvable ref */
    }
  }
  const byFp = new Map<string, AccountCandidate>();
  for (const c of await rawCandidates(opts)) {
    const fp = fingerprint(c.key);
    const cur = byFp.get(fp);
    if (cur) {
      cur.sources.push({ source: c.source, detail: c.detail });
      cur.secretRef ??= c.secretRef;
      cur.companyRef ??= maskTail(c.companyRef);
      if (c.companyRef)
        cur.companyConnected ??= byCompany.get(`${c.provider}|${c.companyRef}`) ?? null;
      continue;
    }
    byFp.set(fp, {
      provider: c.provider,
      fingerprint: fp,
      label: c.label,
      sources: [{ source: c.source, detail: c.detail }],
      secretRef: c.secretRef,
      companyRef: maskTail(c.companyRef),
      alreadyConnected: connected.get(fp) ?? null,
      companyConnected: c.companyRef
        ? (byCompany.get(`${c.provider}|${c.companyRef}`) ?? null)
        : null,
    });
  }
  return [...byFp.values()];
}

/**
 * Connect a discovered key by fingerprint: env keys become `env:` refs, other
 * sources are re-read server-side and stored encrypted (never round-tripped
 * through the UI).
 */
export async function connectDiscovered(
  db: HubDb,
  fp: string,
  input: { label?: string; businessId?: string | null } = {},
  opts: DiscoverOptions = {},
): Promise<RevenueAccount> {
  const all = await rawCandidates(opts);
  const matches = all.filter((c) => fingerprint(c.key) === fp);
  if (!matches.length) throw new Error("no discovered key with that fingerprint");
  const withRef = matches.find((c) => c.secretRef);
  const first = matches[0];
  const companyRef = matches.map((c) => c.companyRef).find((x) => !!x) ?? null;
  return createAccount(
    db,
    {
      provider: first.provider,
      label: input.label?.trim() || first.label,
      companyRef,
      secretRef: withRef?.secretRef ?? null,
      secret: withRef ? null : first.key,
      businessId: input.businessId ?? null,
    },
    opts.codec,
  );
}
