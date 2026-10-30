/**
 * SQLite-backed store for EmailAccount rows. Mirrors the convention used
 * by src/funnels/store.ts and src/discipline/store.ts: a singleton
 * instance keyed on state dir, lazy table init in the constructor, no
 * migrations framework (CREATE TABLE IF NOT EXISTS + targeted ALTERs).
 *
 * Secrets (passwords, API keys) are encrypted at rest via
 * src/services/email/secret-crypto.ts (AES-256-GCM, per-install key).
 * `list()` / `get()` decrypt only when `includeSecrets=true` so the
 * default surface (UI cards, RPC listing) never carries plaintext.
 *
 * "Exactly one primary per business" is enforced atomically inside
 * transactions: setPrimary / create-with-primary / update-with-primary
 * all clear other primaries in the same businessId scope inside the
 * same db.transaction(). A NULL businessId is its own scope (personal).
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveConfigDir } from "../../utils.js";
import { decryptSecret, encryptSecret } from "./secret-crypto.js";
import type {
  EmailAccount,
  EmailAccountInboundConfig,
  EmailAccountInput,
  EmailAccountListFilter,
  EmailAccountOutboundConfig,
  EmailAccountPatch,
  EmailProviderKind,
} from "./accounts-types.js";

const log = createSubsystemLogger("email-accounts");

const SECRET_FIELDS_OUTBOUND = ["smtpPassword", "apiKey"] as const;
const SECRET_FIELDS_INBOUND = ["imapPassword"] as const;

type AccountRow = {
  id: string;
  kind: string;
  displayName: string;
  address: string;
  isPrimary: number;
  labels: string;
  businessId: string | null;
  outboundEnabled: number;
  outboundConfig: string;
  inboundEnabled: number;
  inboundConfig: string;
  inboundPollSec: number | null;
  healthOutbound: string;
  healthInbound: string;
  createdAt: number;
  updatedAt: number;
};

function nowMs(): number {
  return Date.now();
}

function safeJSON<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

function encryptOutbound(cfg: EmailAccountOutboundConfig): EmailAccountOutboundConfig {
  const next: EmailAccountOutboundConfig = { ...cfg };
  for (const field of SECRET_FIELDS_OUTBOUND) {
    const v = (next as any)[field];
    if (typeof v === "string" && v.length > 0) {
      (next as any)[field] = encryptSecret(v);
    }
  }
  return next;
}

function decryptOutbound(cfg: EmailAccountOutboundConfig): EmailAccountOutboundConfig {
  const next: EmailAccountOutboundConfig = { ...cfg };
  for (const field of SECRET_FIELDS_OUTBOUND) {
    const v = (next as any)[field];
    if (typeof v === "string" && v.length > 0) {
      (next as any)[field] = decryptSecret(v) ?? "";
    }
  }
  return next;
}

function maskOutbound(cfg: EmailAccountOutboundConfig): EmailAccountOutboundConfig {
  const next: EmailAccountOutboundConfig = { ...cfg };
  for (const field of SECRET_FIELDS_OUTBOUND) {
    if ((next as any)[field]) (next as any)[field] = "";
  }
  return next;
}

function encryptInbound(cfg: EmailAccountInboundConfig): EmailAccountInboundConfig {
  const next: EmailAccountInboundConfig = { ...cfg };
  for (const field of SECRET_FIELDS_INBOUND) {
    const v = (next as any)[field];
    if (typeof v === "string" && v.length > 0) {
      (next as any)[field] = encryptSecret(v);
    }
  }
  return next;
}

function decryptInbound(cfg: EmailAccountInboundConfig): EmailAccountInboundConfig {
  const next: EmailAccountInboundConfig = { ...cfg };
  for (const field of SECRET_FIELDS_INBOUND) {
    const v = (next as any)[field];
    if (typeof v === "string" && v.length > 0) {
      (next as any)[field] = decryptSecret(v) ?? "";
    }
  }
  return next;
}

function maskInbound(cfg: EmailAccountInboundConfig): EmailAccountInboundConfig {
  const next: EmailAccountInboundConfig = { ...cfg };
  for (const field of SECRET_FIELDS_INBOUND) {
    if ((next as any)[field]) (next as any)[field] = "";
  }
  return next;
}

function rowToAccount(row: AccountRow, includeSecrets: boolean): EmailAccount {
  const outboundRaw = safeJSON<EmailAccountOutboundConfig>(row.outboundConfig, {});
  const inboundRaw = safeJSON<EmailAccountInboundConfig>(row.inboundConfig, {});
  const outboundConfig = includeSecrets ? decryptOutbound(outboundRaw) : maskOutbound(outboundRaw);
  const inboundConfig = includeSecrets ? decryptInbound(inboundRaw) : maskInbound(inboundRaw);
  return {
    id: row.id,
    kind: row.kind as EmailProviderKind,
    displayName: row.displayName,
    address: row.address,
    isPrimary: row.isPrimary === 1,
    labels: safeJSON<string[]>(row.labels, []),
    businessId: row.businessId,
    outbound: { enabled: row.outboundEnabled === 1, config: outboundConfig },
    inbound: {
      enabled: row.inboundEnabled === 1,
      config: inboundConfig,
      pollIntervalSec: row.inboundPollSec ?? undefined,
    },
    health: {
      outbound: safeJSON(row.healthOutbound, { ok: false, lastCheckedAt: 0 }),
      inbound: safeJSON(row.healthInbound, { ok: false, lastCheckedAt: 0 }),
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class EmailAccountsStore {
  private db: Database.Database;

  constructor(stateDir: string) {
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
    const dbPath = join(stateDir, "email-accounts.db");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.createTables();
    const cnt = (this.db.prepare("SELECT COUNT(*) as c FROM email_accounts").get() as { c: number })
      .c;
    log.info("email-accounts store loaded", { path: dbPath, accounts: cnt });
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS email_accounts (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        displayName TEXT NOT NULL,
        address TEXT NOT NULL,
        isPrimary INTEGER NOT NULL DEFAULT 0,
        labels TEXT NOT NULL DEFAULT '[]',
        businessId TEXT,
        outboundEnabled INTEGER NOT NULL DEFAULT 1,
        outboundConfig TEXT NOT NULL DEFAULT '{}',
        inboundEnabled INTEGER NOT NULL DEFAULT 1,
        inboundConfig TEXT NOT NULL DEFAULT '{}',
        inboundPollSec INTEGER,
        healthOutbound TEXT NOT NULL DEFAULT '{"ok":false,"lastCheckedAt":0}',
        healthInbound TEXT NOT NULL DEFAULT '{"ok":false,"lastCheckedAt":0}',
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_email_accounts_business ON email_accounts(businessId);
      CREATE INDEX IF NOT EXISTS idx_email_accounts_kind ON email_accounts(kind);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_email_accounts_address_kind
        ON email_accounts(LOWER(address), kind);
    `);
  }

  // ── Queries ────────────────────────────────────────────────

  list(filter: EmailAccountListFilter = {}): EmailAccount[] {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (filter.businessId !== undefined) {
      if (filter.businessId === null) {
        clauses.push("businessId IS NULL");
      } else {
        clauses.push("businessId = ?");
        args.push(filter.businessId);
      }
    }
    if (filter.kind) {
      clauses.push("kind = ?");
      args.push(filter.kind);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const sql = `SELECT * FROM email_accounts ${where} ORDER BY isPrimary DESC, displayName ASC`;
    const rows = this.db.prepare(sql).all(...args) as AccountRow[];
    return rows.map((r) => rowToAccount(r, filter.includeSecrets === true));
  }

  get(id: string, opts?: { includeSecrets?: boolean }): EmailAccount | null {
    const row = this.db.prepare("SELECT * FROM email_accounts WHERE id = ?").get(id) as
      | AccountRow
      | undefined;
    return row ? rowToAccount(row, opts?.includeSecrets === true) : null;
  }

  getPrimary(businessId: string | null, opts?: { includeSecrets?: boolean }): EmailAccount | null {
    const row =
      businessId === null
        ? (this.db
            .prepare(
              "SELECT * FROM email_accounts WHERE businessId IS NULL AND isPrimary = 1 LIMIT 1",
            )
            .get() as AccountRow | undefined)
        : (this.db
            .prepare("SELECT * FROM email_accounts WHERE businessId = ? AND isPrimary = 1 LIMIT 1")
            .get(businessId) as AccountRow | undefined);
    return row ? rowToAccount(row, opts?.includeSecrets === true) : null;
  }

  // ── Mutations ──────────────────────────────────────────────

  create(input: EmailAccountInput): EmailAccount {
    const id = randomUUID();
    const now = nowMs();
    const businessId = input.businessId ?? null;
    const labels = Array.isArray(input.labels) ? input.labels : [];
    const outboundConfig = JSON.stringify(encryptOutbound(input.outbound?.config ?? {}));
    const inboundConfig = JSON.stringify(encryptInbound(input.inbound?.config ?? {}));
    const insert = this.db.prepare(`
      INSERT INTO email_accounts
        (id, kind, displayName, address, isPrimary, labels, businessId,
         outboundEnabled, outboundConfig, inboundEnabled, inboundConfig, inboundPollSec,
         healthOutbound, healthInbound, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const txn = this.db.transaction((mark: boolean) => {
      if (mark) this.clearPrimaryFor(businessId);
      insert.run(
        id,
        input.kind,
        input.displayName,
        input.address,
        mark ? 1 : 0,
        JSON.stringify(labels),
        businessId,
        input.outbound?.enabled ? 1 : 0,
        outboundConfig,
        input.inbound?.enabled ? 1 : 0,
        inboundConfig,
        input.inbound?.pollIntervalSec ?? null,
        JSON.stringify({ ok: false, lastCheckedAt: 0 }),
        JSON.stringify({ ok: false, lastCheckedAt: 0 }),
        now,
        now,
      );
    });

    const wantsPrimary = input.isPrimary === true || this.countForBusiness(businessId) === 0;
    txn(wantsPrimary);

    const out = this.get(id);
    if (!out) throw new Error("email account create failed: row vanished post-insert");
    return out;
  }

  update(id: string, patch: EmailAccountPatch): EmailAccount {
    const existing = this.db.prepare("SELECT * FROM email_accounts WHERE id = ?").get(id) as
      | AccountRow
      | undefined;
    if (!existing) throw new Error(`email account not found: ${id}`);

    const businessId =
      patch.businessId === undefined ? existing.businessId : (patch.businessId ?? null);

    const labels =
      patch.labels !== undefined
        ? JSON.stringify(Array.isArray(patch.labels) ? patch.labels : [])
        : existing.labels;

    let outboundConfig = existing.outboundConfig;
    if (patch.outbound?.config !== undefined) {
      // Merge: any field omitted in patch keeps existing (encrypted) value.
      const existingDecrypted = decryptOutbound(
        safeJSON<EmailAccountOutboundConfig>(existing.outboundConfig, {}),
      );
      const merged: EmailAccountOutboundConfig = { ...existingDecrypted, ...patch.outbound.config };
      outboundConfig = JSON.stringify(encryptOutbound(merged));
    }
    let inboundConfig = existing.inboundConfig;
    if (patch.inbound?.config !== undefined) {
      const existingDecrypted = decryptInbound(
        safeJSON<EmailAccountInboundConfig>(existing.inboundConfig, {}),
      );
      const merged: EmailAccountInboundConfig = { ...existingDecrypted, ...patch.inbound.config };
      inboundConfig = JSON.stringify(encryptInbound(merged));
    }

    const outboundEnabled =
      patch.outbound?.enabled === undefined
        ? existing.outboundEnabled
        : patch.outbound.enabled
          ? 1
          : 0;
    const inboundEnabled =
      patch.inbound?.enabled === undefined
        ? existing.inboundEnabled
        : patch.inbound.enabled
          ? 1
          : 0;
    const inboundPollSec =
      patch.inbound?.pollIntervalSec === undefined
        ? existing.inboundPollSec
        : (patch.inbound.pollIntervalSec ?? null);

    const txn = this.db.transaction(() => {
      if (patch.isPrimary === true) this.clearPrimaryFor(businessId);
      this.db
        .prepare(
          `UPDATE email_accounts SET
              kind = ?, displayName = ?, address = ?, isPrimary = ?, labels = ?, businessId = ?,
              outboundEnabled = ?, outboundConfig = ?, inboundEnabled = ?, inboundConfig = ?, inboundPollSec = ?,
              updatedAt = ?
           WHERE id = ?`,
        )
        .run(
          patch.kind ?? existing.kind,
          patch.displayName ?? existing.displayName,
          patch.address ?? existing.address,
          patch.isPrimary === undefined ? existing.isPrimary : patch.isPrimary ? 1 : 0,
          labels,
          businessId,
          outboundEnabled,
          outboundConfig,
          inboundEnabled,
          inboundConfig,
          inboundPollSec,
          nowMs(),
          id,
        );
    });
    txn();
    const out = this.get(id);
    if (!out) throw new Error("email account update failed: row vanished mid-update");
    return out;
  }

  delete(id: string): { ok: true } {
    const row = this.db
      .prepare("SELECT isPrimary, businessId FROM email_accounts WHERE id = ?")
      .get(id) as { isPrimary: number; businessId: string | null } | undefined;
    if (!row) throw new Error(`email account not found: ${id}`);
    if (row.isPrimary === 1) {
      const siblings = this.countForBusiness(row.businessId);
      if (siblings > 1) {
        throw new Error(
          "cannot delete primary email account while other accounts exist; reassign primary first",
        );
      }
    }
    this.db.prepare("DELETE FROM email_accounts WHERE id = ?").run(id);
    return { ok: true };
  }

  setPrimary(id: string): EmailAccount {
    const row = this.db.prepare("SELECT businessId FROM email_accounts WHERE id = ?").get(id) as
      | { businessId: string | null }
      | undefined;
    if (!row) throw new Error(`email account not found: ${id}`);
    const txn = this.db.transaction(() => {
      this.clearPrimaryFor(row.businessId);
      this.db
        .prepare("UPDATE email_accounts SET isPrimary = 1, updatedAt = ? WHERE id = ?")
        .run(nowMs(), id);
    });
    txn();
    const out = this.get(id);
    if (!out) throw new Error("setPrimary: row vanished");
    return out;
  }

  recordHealth(
    id: string,
    direction: "outbound" | "inbound",
    health: { ok: boolean; lastError?: string; lastCheckedAt?: number },
  ): void {
    const json = JSON.stringify({
      ok: health.ok,
      lastError: health.lastError,
      lastCheckedAt: health.lastCheckedAt ?? nowMs(),
    });
    const column = direction === "outbound" ? "healthOutbound" : "healthInbound";
    this.db
      .prepare(`UPDATE email_accounts SET ${column} = ?, updatedAt = ? WHERE id = ?`)
      .run(json, nowMs(), id);
  }

  /** Returns the *decrypted* outbound config for sending — never log this. */
  getDecryptedOutbound(
    id: string,
  ): { account: EmailAccount; outbound: EmailAccountOutboundConfig } | null {
    const acct = this.get(id, { includeSecrets: true });
    if (!acct) return null;
    return { account: acct, outbound: acct.outbound.config };
  }

  /** Returns the *decrypted* inbound config for IMAP fetching. */
  getDecryptedInbound(
    id: string,
  ): { account: EmailAccount; inbound: EmailAccountInboundConfig } | null {
    const acct = this.get(id, { includeSecrets: true });
    if (!acct) return null;
    return { account: acct, inbound: acct.inbound.config };
  }

  // ── Internals ──────────────────────────────────────────────

  private countForBusiness(businessId: string | null): number {
    if (businessId === null) {
      return (
        this.db
          .prepare("SELECT COUNT(*) as c FROM email_accounts WHERE businessId IS NULL")
          .get() as { c: number }
      ).c;
    }
    return (
      this.db
        .prepare("SELECT COUNT(*) as c FROM email_accounts WHERE businessId = ?")
        .get(businessId) as { c: number }
    ).c;
  }

  private clearPrimaryFor(businessId: string | null): void {
    if (businessId === null) {
      this.db
        .prepare(
          "UPDATE email_accounts SET isPrimary = 0, updatedAt = ? WHERE businessId IS NULL AND isPrimary = 1",
        )
        .run(nowMs());
    } else {
      this.db
        .prepare(
          "UPDATE email_accounts SET isPrimary = 0, updatedAt = ? WHERE businessId = ? AND isPrimary = 1",
        )
        .run(nowMs(), businessId);
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* best-effort */
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────

let instance: EmailAccountsStore | null = null;
let instanceDir: string | null = null;

export function getEmailAccountsStore(stateDir?: string): EmailAccountsStore {
  const dir = stateDir ?? process.env.INFINIBOT_STATE_DIR?.trim() ?? resolveConfigDir();
  if (!instance || instanceDir !== dir) {
    if (instance) instance.close();
    instance = new EmailAccountsStore(dir);
    instanceDir = dir;
  }
  return instance;
}

export function resetEmailAccountsStore(): void {
  if (instance) {
    instance.close();
    instance = null;
    instanceDir = null;
  }
}
