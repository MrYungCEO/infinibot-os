/**
 * Kingly Vault — Store Factory
 * Central entry point for vault data stores
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "path";
import { VaultSqliteStore } from "./sqlite-store.js";
import type { VaultDataSource } from "./interface.js";

// Re-export all types and interfaces
export * from "./types.js";
export * from "./interface.js";
export { VaultSqliteStore } from "./sqlite-store.js";

/**
 * Configuration for creating a vault store
 */
export interface VaultStoreConfig {
  /** Store type */
  type?: "sqlite";

  /** SQLite configuration */
  sqlite?: {
    /** Path to the database file. Defaults to 'state/vault/vault.db' */
    path?: string;
  };

}

/**
 * Default state directory - use absolute path from env or relative fallback
 */
const INFINIBOT_ROOT =
  process.env.INFINIBOT_ROOT ||
  process.env.INFINIBOT_STATE_DIR?.replace(/[\\/]state$/, "") ||
  process.cwd();
const DEFAULT_STATE_DIR = join(INFINIBOT_ROOT, "state", "vault");
const DEFAULT_DB_NAME = "vault.db";

// Singleton instance
let storeInstance: VaultDataSource | null = null;

/**
 * Get or create the vault data store.
 * Uses singleton pattern - subsequent calls return the same instance.
 *
 * Supports multiple store types:
 * - 'sqlite' (default): Local SQLite database
 * - 'composite': SQLite for members + Supabase for courses (future)
 *
 * @param config - Optional configuration. Required on first call.
 * @returns The vault data store instance
 *
 * @example
 * ```typescript
 * // Initialize with default SQLite
 * const store = getVaultStore();
 
 * ```
 */
export function getVaultStore(config?: VaultStoreConfig): VaultDataSource {
  if (storeInstance) {
    return storeInstance;
  }

  const storeType = config?.type || process.env.VAULT_STORE_TYPE || "sqlite";

  switch (storeType) {
    case "sqlite":
    default: {
      const dbPath = config?.sqlite?.path ?? join(DEFAULT_STATE_DIR, DEFAULT_DB_NAME);
      storeInstance = new VaultSqliteStore(dbPath);
      break;
    }
  }

  return storeInstance;
}

export function getSupabaseStore(): null {
  return null;
}

/**
 * Create a new vault store without singleton behavior.
 * Useful for testing or when you need multiple isolated stores.
 *
 * @param config - Store configuration
 * @returns A new vault data store instance
 *
 * @example
 * ```typescript
 * // Create isolated test store
 * const testStore = createVaultStore({ sqlite: { path: './test-vault.db' } });
 *
 * // Use for testing
 * await testStore.upsertMember({ id: 'test-1', tier: 'free' });
 * const member = await testStore.getMember('test-1');
 *
 * // Clean up
 * (testStore as VaultSqliteStore).close();
 * ```
 */
export function createVaultStore(config?: VaultStoreConfig): VaultDataSource {
  const dbPath = config?.sqlite?.path ?? join(DEFAULT_STATE_DIR, DEFAULT_DB_NAME);
  return new VaultSqliteStore(dbPath);
}

/**
 * Reset the singleton store instance.
 * Primarily for testing purposes.
 */
export function resetVaultStore(): void {
  if (storeInstance && storeInstance instanceof VaultSqliteStore) {
    storeInstance.close();
  }
  storeInstance = null;
}
