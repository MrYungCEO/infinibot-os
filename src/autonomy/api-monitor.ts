/**
 * Autonomy Architecture — API Usage Monitoring
 * Tracks API calls, costs, and autonomous vs interactive usage
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { ApiUsageEntry, ApiUsageSummary } from "./types.js";
import { recordLegacyApiUsage } from "../credits/recorder.js";

let db: Database.Database | null = null;
let dbPath = "state/autonomy/api-usage.db";

/**
 * Initialize API monitoring database
 */
export function initApiMonitor(path?: string): void {
  if (path) {
    dbPath = path;
  }

  // Ensure directory exists
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_usage (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      session_key TEXT,
      task_id TEXT,
      autonomous INTEGER NOT NULL DEFAULT 0
    );
    
    CREATE INDEX IF NOT EXISTS idx_api_usage_timestamp ON api_usage(timestamp);
    CREATE INDEX IF NOT EXISTS idx_api_usage_provider ON api_usage(provider);
    CREATE INDEX IF NOT EXISTS idx_api_usage_autonomous ON api_usage(autonomous);
  `);
}

/**
 * Generate usage entry ID
 */
function generateUsageId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 6);
  return `api_${timestamp}_${random}`;
}

/**
 * Record an API usage entry
 */
export function recordApiUsage(
  provider: string,
  model: string,
  tokensIn: number,
  tokensOut: number,
  costUsd: number,
  options: {
    sessionKey?: string;
    taskId?: string;
    autonomous?: boolean;
  } = {},
): ApiUsageEntry {
  if (!db) {
    initApiMonitor();
  }

  const entry: ApiUsageEntry = {
    id: generateUsageId(),
    timestamp: Date.now(),
    provider,
    model,
    tokensIn,
    tokensOut,
    costUsd,
    sessionKey: options.sessionKey,
    taskId: options.taskId,
    autonomous: options.autonomous ?? false,
  };

  db!
    .prepare(`
    INSERT INTO api_usage (id, timestamp, provider, model, tokens_in, tokens_out, cost_usd, session_key, task_id, autonomous)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .run(
      entry.id,
      entry.timestamp,
      entry.provider,
      entry.model,
      entry.tokensIn,
      entry.tokensOut,
      entry.costUsd,
      entry.sessionKey || null,
      entry.taskId || null,
      entry.autonomous ? 1 : 0,
    );

  // Mirror into the unified credit ledger so the new Credits UI sees every
  // legacy autonomy call without duplicating the recorder logic. Best-effort.
  try {
    recordLegacyApiUsage(provider, model, tokensIn, tokensOut, costUsd, {
      sessionKey: options.sessionKey,
      taskId: options.taskId,
      autonomous: options.autonomous,
    });
  } catch {
    /* never block the legacy path on a ledger failure */
  }

  return entry;
}

/**
 * Get usage summary for a time period
 */
export function getUsageSummary(period: "hour" | "day" | "week" | "month"): ApiUsageSummary {
  if (!db) {
    initApiMonitor();
  }

  const now = Date.now();
  let periodStart: number;

  switch (period) {
    case "hour":
      periodStart = now - 60 * 60 * 1000;
      break;
    case "day":
      periodStart = now - 24 * 60 * 60 * 1000;
      break;
    case "week":
      periodStart = now - 7 * 24 * 60 * 60 * 1000;
      break;
    case "month":
      periodStart = now - 30 * 24 * 60 * 60 * 1000;
      break;
  }

  // Get totals
  const totals = db!
    .prepare(`
    SELECT 
      SUM(tokens_in) as total_tokens_in,
      SUM(tokens_out) as total_tokens_out,
      SUM(cost_usd) as total_cost,
      SUM(CASE WHEN autonomous = 1 THEN tokens_in + tokens_out ELSE 0 END) as autonomous_tokens,
      SUM(tokens_in + tokens_out) as all_tokens
    FROM api_usage
    WHERE timestamp >= ?
  `)
    .get(periodStart) as any;

  // Get by provider
  const byProviderRows = db!
    .prepare(`
    SELECT 
      provider,
      SUM(tokens_in + tokens_out) as tokens,
      SUM(cost_usd) as cost
    FROM api_usage
    WHERE timestamp >= ?
    GROUP BY provider
  `)
    .all(periodStart) as any[];

  const byProvider: Record<string, { tokens: number; cost: number }> = {};
  for (const row of byProviderRows) {
    byProvider[row.provider] = { tokens: row.tokens || 0, cost: row.cost || 0 };
  }

  // Get by model
  const byModelRows = db!
    .prepare(`
    SELECT 
      model,
      SUM(tokens_in + tokens_out) as tokens,
      SUM(cost_usd) as cost
    FROM api_usage
    WHERE timestamp >= ?
    GROUP BY model
  `)
    .all(periodStart) as any[];

  const byModel: Record<string, { tokens: number; cost: number }> = {};
  for (const row of byModelRows) {
    byModel[row.model] = { tokens: row.tokens || 0, cost: row.cost || 0 };
  }

  const totalTokens = totals?.all_tokens || 0;
  const autonomousTokens = totals?.autonomous_tokens || 0;

  return {
    period,
    periodStart,
    totalTokensIn: totals?.total_tokens_in || 0,
    totalTokensOut: totals?.total_tokens_out || 0,
    totalCostUsd: totals?.total_cost || 0,
    autonomousPercent: totalTokens > 0 ? (autonomousTokens / totalTokens) * 100 : 0,
    byProvider,
    byModel,
  };
}

/**
 * Get recent API usage entries
 */
export function getRecentUsage(limit: number = 50): ApiUsageEntry[] {
  if (!db) {
    initApiMonitor();
  }

  const rows = db!
    .prepare(`
    SELECT * FROM api_usage
    ORDER BY timestamp DESC
    LIMIT ?
  `)
    .all(limit) as any[];

  return rows.map((row) => ({
    id: row.id,
    timestamp: row.timestamp,
    provider: row.provider,
    model: row.model,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    costUsd: row.cost_usd,
    sessionKey: row.session_key,
    taskId: row.task_id,
    autonomous: row.autonomous === 1,
  }));
}

/**
 * Get today's usage stats
 */
export function getTodayStats(): {
  totalCalls: number;
  totalTokens: number;
  totalCost: number;
  autonomousCalls: number;
  autonomousPercent: number;
} {
  if (!db) {
    initApiMonitor();
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStart = today.getTime();

  const stats = db!
    .prepare(`
    SELECT 
      COUNT(*) as total_calls,
      SUM(tokens_in + tokens_out) as total_tokens,
      SUM(cost_usd) as total_cost,
      SUM(CASE WHEN autonomous = 1 THEN 1 ELSE 0 END) as autonomous_calls
    FROM api_usage
    WHERE timestamp >= ?
  `)
    .get(todayStart) as any;

  const totalCalls = stats?.total_calls || 0;
  const autonomousCalls = stats?.autonomous_calls || 0;

  return {
    totalCalls,
    totalTokens: stats?.total_tokens || 0,
    totalCost: stats?.total_cost || 0,
    autonomousCalls,
    autonomousPercent: totalCalls > 0 ? (autonomousCalls / totalCalls) * 100 : 0,
  };
}

/**
 * Get usage for a specific task
 */
export function getTaskUsage(taskId: string): {
  entries: ApiUsageEntry[];
  totalTokens: number;
  totalCost: number;
} {
  if (!db) {
    initApiMonitor();
  }

  const rows = db!
    .prepare(`
    SELECT * FROM api_usage
    WHERE task_id = ?
    ORDER BY timestamp ASC
  `)
    .all(taskId) as any[];

  const entries = rows.map((row) => ({
    id: row.id,
    timestamp: row.timestamp,
    provider: row.provider,
    model: row.model,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    costUsd: row.cost_usd,
    sessionKey: row.session_key,
    taskId: row.task_id,
    autonomous: row.autonomous === 1,
  }));

  const totalTokens = entries.reduce((sum, e) => sum + e.tokensIn + e.tokensOut, 0);
  const totalCost = entries.reduce((sum, e) => sum + e.costUsd, 0);

  return { entries, totalTokens, totalCost };
}

/**
 * Close database connection
 */
export function closeApiMonitor(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// Export convenience object
export const apiMonitor = {
  init: initApiMonitor,
  record: recordApiUsage,
  summary: getUsageSummary,
  recent: getRecentUsage,
  today: getTodayStats,
  taskUsage: getTaskUsage,
  close: closeApiMonitor,
};
