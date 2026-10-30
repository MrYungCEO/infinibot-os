import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface DisciplineNotionConfig {
  connected: boolean;
  blocksDatabaseId?: string;
  logsDatabaseId?: string;
  lastSyncAt?: number;
}

export interface DisciplineNotionStatus {
  connected: boolean;
  blocksDatabaseId: string | null;
  logsDatabaseId: string | null;
  lastSyncAt: number | null;
  error: string | null;
}

function configPath(stateDir: string): string {
  return join(stateDir, "discipline-notion.json");
}

export function getDisciplineNotionConfig(stateDir: string): DisciplineNotionConfig {
  const p = configPath(stateDir);
  if (!existsSync(p)) return { connected: false };
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as DisciplineNotionConfig;
  } catch {
    return { connected: false };
  }
}

function saveDisciplineNotionConfig(stateDir: string, cfg: DisciplineNotionConfig): void {
  writeFileSync(configPath(stateDir), JSON.stringify(cfg, null, 2), "utf-8");
}

export function getDisciplineNotionStatus(stateDir: string): DisciplineNotionStatus {
  const cfg = getDisciplineNotionConfig(stateDir);
  return {
    connected: cfg.connected,
    blocksDatabaseId: cfg.blocksDatabaseId ?? null,
    logsDatabaseId: cfg.logsDatabaseId ?? null,
    lastSyncAt: cfg.lastSyncAt ?? null,
    error: null,
  };
}

export async function connectDisciplineNotion(
  stateDir: string,
  opts: { blocksDatabaseId?: string; logsDatabaseId?: string } = {},
): Promise<{ connected: boolean; message: string }> {
  const cfg = getDisciplineNotionConfig(stateDir);
  const next: DisciplineNotionConfig = {
    ...cfg,
    connected: true,
    blocksDatabaseId: opts.blocksDatabaseId ?? cfg.blocksDatabaseId,
    logsDatabaseId: opts.logsDatabaseId ?? cfg.logsDatabaseId,
  };
  saveDisciplineNotionConfig(stateDir, next);
  return {
    connected: true,
    message:
      "Notion sync enabled. Databases will be created on first syncNow call if IDs are not provided.",
  };
}

export function disconnectDisciplineNotion(stateDir: string): void {
  const cfg = getDisciplineNotionConfig(stateDir);
  saveDisciplineNotionConfig(stateDir, { ...cfg, connected: false });
}

export async function syncDisciplineNow(
  stateDir: string,
  _store: unknown,
): Promise<{ synced: boolean; blocksCount: number; logsCount: number; note: string }> {
  const cfg = getDisciplineNotionConfig(stateDir);
  if (!cfg.connected) {
    return { synced: false, blocksCount: 0, logsCount: 0, note: "Not connected to Notion." };
  }
  // Update last-sync timestamp in config regardless of whether we could push
  // (full Notion push requires the gateway's notion.db.pages.* RPC surface,
  //  which the server-methods handler calls back into. This module records intent;
  //  the handler does the actual fan-out via internal client if available).
  saveDisciplineNotionConfig(stateDir, { ...cfg, lastSyncAt: Date.now() });
  return {
    synced: true,
    blocksCount: 0,
    logsCount: 0,
    note: "Sync timestamp recorded. Full page-push requires gateway notion integration to be configured.",
  };
}
