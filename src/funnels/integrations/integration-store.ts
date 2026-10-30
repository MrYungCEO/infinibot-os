/**
 * Integration Credentials Store
 * Secure storage for platform API keys and OAuth tokens
 */

import Database from "better-sqlite3";
import { resolve } from "node:path";
import { stateFilePathWithLegacyMigration } from "../../config/paths.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("integration-store");
import type { IntegrationCredential, PlatformId } from "./types.js";

let _db: Database.Database | null = null;

function getDb(stateDir?: string): Database.Database {
  if (_db) return _db;

  // An explicit stateDir (tests) still wins; otherwise use the canonical dir
  // and migrate any database written by the old `<cwd>/state` fallback.
  const dbPath = stateDir
    ? resolve(stateDir, "integrations.db")
    : stateFilePathWithLegacyMigration("integrations.db");

  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");

  // Create tables
  _db.exec(`
    CREATE TABLE IF NOT EXISTS integration_credentials (
      id TEXT PRIMARY KEY,
      platform_id TEXT NOT NULL,
      business_id TEXT DEFAULT 'default',
      method TEXT NOT NULL,
      access_token TEXT,
      refresh_token TEXT,
      token_expiry INTEGER,
      api_key TEXT,
      api_secret TEXT,
      webhook_url TEXT,
      webhook_secret TEXT,
      connected INTEGER DEFAULT 0,
      last_verified INTEGER,
      last_error TEXT,
      account_id TEXT,
      account_name TEXT,
      config_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE INDEX IF NOT EXISTS idx_creds_platform ON integration_credentials(platform_id);
    CREATE INDEX IF NOT EXISTS idx_creds_business ON integration_credentials(business_id);
  `);

  log.info("[integration-store] Database initialized");
  return _db;
}

export class IntegrationStore {
  private db: Database.Database;

  constructor(stateDir?: string) {
    this.db = getDb(stateDir);
  }

  // ═══════════════════════════════════════════════════════════════
  // CREDENTIALS CRUD
  // ═══════════════════════════════════════════════════════════════

  saveCredential(
    cred: IntegrationCredential & { businessId?: string; config?: Record<string, any> },
  ): IntegrationCredential {
    const stmt = this.db.prepare(`
      INSERT INTO integration_credentials (
        id, platform_id, business_id, method,
        access_token, refresh_token, token_expiry,
        api_key, api_secret,
        webhook_url, webhook_secret,
        connected, last_verified, last_error,
        account_id, account_name, config_json,
        updated_at
      ) VALUES (
        @id, @platformId, @businessId, @method,
        @accessToken, @refreshToken, @tokenExpiry,
        @apiKey, @apiSecret,
        @webhookUrl, @webhookSecret,
        @connected, @lastVerified, @lastError,
        @accountId, @accountName, @configJson,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT(id) DO UPDATE SET
        access_token = @accessToken,
        refresh_token = @refreshToken,
        token_expiry = @tokenExpiry,
        api_key = @apiKey,
        api_secret = @apiSecret,
        webhook_url = @webhookUrl,
        webhook_secret = @webhookSecret,
        connected = @connected,
        last_verified = @lastVerified,
        last_error = @lastError,
        account_id = @accountId,
        account_name = @accountName,
        config_json = @configJson,
        updated_at = CURRENT_TIMESTAMP
    `);

    stmt.run({
      id: cred.id,
      platformId: cred.platformId,
      businessId: cred.businessId || "default",
      method: cred.method,
      accessToken: cred.accessToken || null,
      refreshToken: cred.refreshToken || null,
      tokenExpiry: cred.tokenExpiry || null,
      apiKey: cred.apiKey || null,
      apiSecret: cred.apiSecret || null,
      webhookUrl: cred.webhookUrl || null,
      webhookSecret: cred.webhookSecret || null,
      connected: cred.connected ? 1 : 0,
      lastVerified: cred.lastVerified || null,
      lastError: cred.lastError || null,
      accountId: cred.accountId || null,
      accountName: cred.accountName || null,
      configJson: cred.config ? JSON.stringify(cred.config) : null,
    });

    return cred;
  }

  getCredential(id: string): IntegrationCredential | null {
    const row = this.db
      .prepare(`SELECT * FROM integration_credentials WHERE id = ?`)
      .get(id) as any;
    return row ? this.rowToCredential(row) : null;
  }

  getCredentialByPlatform(
    platformId: PlatformId,
    businessId = "default",
  ): IntegrationCredential | null {
    const row = this.db
      .prepare(`
      SELECT * FROM integration_credentials 
      WHERE platform_id = ? AND business_id = ?
      ORDER BY connected DESC, updated_at DESC
      LIMIT 1
    `)
      .get(platformId, businessId) as any;
    return row ? this.rowToCredential(row) : null;
  }

  listCredentials(businessId?: string): IntegrationCredential[] {
    let rows: any[];
    if (businessId) {
      rows = this.db
        .prepare(`SELECT * FROM integration_credentials WHERE business_id = ? ORDER BY platform_id`)
        .all(businessId) as any[];
    } else {
      rows = this.db
        .prepare(`SELECT * FROM integration_credentials ORDER BY business_id, platform_id`)
        .all() as any[];
    }
    return rows.map((r) => this.rowToCredential(r));
  }

  listCredentialsByPlatform(platformId: PlatformId): IntegrationCredential[] {
    const rows = this.db
      .prepare(`SELECT * FROM integration_credentials WHERE platform_id = ? ORDER BY business_id`)
      .all(platformId) as any[];
    return rows.map((r) => this.rowToCredential(r));
  }

  deleteCredential(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM integration_credentials WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  updateConnectionStatus(id: string, connected: boolean, error?: string): void {
    this.db
      .prepare(`
      UPDATE integration_credentials 
      SET connected = ?, last_verified = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `)
      .run(connected ? 1 : 0, Date.now(), error || null, id);
  }

  private rowToCredential(
    row: any,
  ): IntegrationCredential & { businessId?: string; config?: Record<string, any> } {
    return {
      id: row.id,
      platformId: row.platform_id,
      businessId: row.business_id,
      method: row.method,
      accessToken: row.access_token || undefined,
      refreshToken: row.refresh_token || undefined,
      tokenExpiry: row.token_expiry || undefined,
      apiKey: row.api_key || undefined,
      apiSecret: row.api_secret || undefined,
      webhookUrl: row.webhook_url || undefined,
      webhookSecret: row.webhook_secret || undefined,
      connected: !!row.connected,
      lastVerified: row.last_verified || undefined,
      lastError: row.last_error || undefined,
      accountId: row.account_id || undefined,
      accountName: row.account_name || undefined,
      config: row.config_json ? JSON.parse(row.config_json) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

// Singleton
let _store: IntegrationStore | null = null;

export function getIntegrationStore(stateDir?: string): IntegrationStore {
  if (!_store) {
    _store = new IntegrationStore(stateDir);
  }
  return _store;
}
