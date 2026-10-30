import { mkdirSync } from "fs";
import { join } from "path";
import Database from "better-sqlite3";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { recordLegacyBudgetEntry } from "../credits/recorder.js";

const log = createSubsystemLogger("budget");

// ── Types ────────────────────────────────────────────

export interface BudgetEntry {
  id: string;
  provider: string;
  model?: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  agentId: string;
  sessionKey?: string;
  timestamp: number;
}

export interface MonthlyBudget {
  provider: string;
  monthKey: string;
  totalCostUsd: number;
  totalTokensIn: number;
  totalTokensOut: number;
  budgetLimitUsd?: number;
}

export interface DailyCost {
  date: string;
  provider: string;
  totalCostUsd: number;
  totalTokensIn: number;
  totalTokensOut: number;
  entryCount: number;
}

export interface AgentCost {
  agentId: string;
  totalCostUsd: number;
  totalTokensIn: number;
  totalTokensOut: number;
  entryCount: number;
}

// ── Store ────────────────────────────────────────────

export class BudgetStore {
  private db: Database.Database;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    const dbPath = join(stateDir, "budget.db");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.createTables();
    const count = (
      this.db.prepare("SELECT COUNT(*) as cnt FROM budget_entries").get() as { cnt: number }
    ).cnt;
    log.info("Budget store loaded (SQLite)", { entries: count });
  }

  private createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS budget_entries (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        model TEXT,
        tokensIn INTEGER NOT NULL DEFAULT 0,
        tokensOut INTEGER NOT NULL DEFAULT 0,
        costUsd REAL NOT NULL DEFAULT 0,
        agentId TEXT NOT NULL DEFAULT 'unknown',
        sessionKey TEXT,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_budget_provider ON budget_entries(provider);
      CREATE INDEX IF NOT EXISTS idx_budget_timestamp ON budget_entries(timestamp);
      CREATE INDEX IF NOT EXISTS idx_budget_agentId ON budget_entries(agentId);

      CREATE TABLE IF NOT EXISTS monthly_summaries (
        provider TEXT NOT NULL,
        monthKey TEXT NOT NULL,
        totalCostUsd REAL NOT NULL DEFAULT 0,
        totalTokensIn INTEGER NOT NULL DEFAULT 0,
        totalTokensOut INTEGER NOT NULL DEFAULT 0,
        budgetLimitUsd REAL,
        PRIMARY KEY (provider, monthKey)
      );
    `);
  }

  recordUsage(entry: Omit<BudgetEntry, "id">): BudgetEntry {
    const id = crypto.randomUUID();
    const full: BudgetEntry = { id, ...entry };

    const insertAndUpdate = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO budget_entries (id, provider, model, tokensIn, tokensOut, costUsd, agentId, sessionKey, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          full.provider,
          full.model ?? null,
          full.tokensIn,
          full.tokensOut,
          full.costUsd,
          full.agentId,
          full.sessionKey ?? null,
          full.timestamp,
        );

      // Update monthly summary
      const monthKey = toMonthKey(full.timestamp);
      this.db
        .prepare(
          `INSERT INTO monthly_summaries (provider, monthKey, totalCostUsd, totalTokensIn, totalTokensOut)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(provider, monthKey)
         DO UPDATE SET
           totalCostUsd = totalCostUsd + excluded.totalCostUsd,
           totalTokensIn = totalTokensIn + excluded.totalTokensIn,
           totalTokensOut = totalTokensOut + excluded.totalTokensOut`,
        )
        .run(full.provider, monthKey, full.costUsd, full.tokensIn, full.tokensOut);
    });

    insertAndUpdate();

    // Mirror into the unified credit ledger. Best-effort — never block.
    try {
      recordLegacyBudgetEntry({
        provider: full.provider,
        model: full.model,
        tokensIn: full.tokensIn,
        tokensOut: full.tokensOut,
        costUsd: full.costUsd,
        agentId: full.agentId,
        sessionKey: full.sessionKey,
        timestamp: full.timestamp,
      });
    } catch {
      /* ignore */
    }

    return full;
  }

  getMonthlySpend(provider: string, monthKey?: string): MonthlyBudget | null {
    const key = monthKey ?? toMonthKey(Date.now());
    const row = this.db
      .prepare("SELECT * FROM monthly_summaries WHERE provider = ? AND monthKey = ?")
      .get(provider, key) as any;
    if (!row) return null;
    return {
      provider: row.provider,
      monthKey: row.monthKey,
      totalCostUsd: row.totalCostUsd,
      totalTokensIn: row.totalTokensIn,
      totalTokensOut: row.totalTokensOut,
      budgetLimitUsd: row.budgetLimitUsd ?? undefined,
    };
  }

  getAllMonthlySpend(monthKey?: string): MonthlyBudget[] {
    const key = monthKey ?? toMonthKey(Date.now());
    const rows = this.db
      .prepare("SELECT * FROM monthly_summaries WHERE monthKey = ? ORDER BY totalCostUsd DESC")
      .all(key) as any[];
    return rows.map((row) => ({
      provider: row.provider,
      monthKey: row.monthKey,
      totalCostUsd: row.totalCostUsd,
      totalTokensIn: row.totalTokensIn,
      totalTokensOut: row.totalTokensOut,
      budgetLimitUsd: row.budgetLimitUsd ?? undefined,
    }));
  }

  getBudgetRemaining(provider: string, budgetLimitUsd: number, monthKey?: string): number {
    const spend = this.getMonthlySpend(provider, monthKey);
    if (!spend) return budgetLimitUsd;
    return Math.max(0, budgetLimitUsd - spend.totalCostUsd);
  }

  getDailyCosts(days: number): DailyCost[] {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const rows = this.db
      .prepare(
        `SELECT
        substr(date(timestamp / 1000, 'unixepoch'), 1, 10) as date,
        provider,
        SUM(costUsd) as totalCostUsd,
        SUM(tokensIn) as totalTokensIn,
        SUM(tokensOut) as totalTokensOut,
        COUNT(*) as entryCount
       FROM budget_entries
       WHERE timestamp >= ?
       GROUP BY date, provider
       ORDER BY date DESC, provider`,
      )
      .all(cutoff) as any[];
    return rows.map((r) => ({
      date: r.date,
      provider: r.provider,
      totalCostUsd: r.totalCostUsd,
      totalTokensIn: r.totalTokensIn,
      totalTokensOut: r.totalTokensOut,
      entryCount: r.entryCount,
    }));
  }

  getAgentCosts(agentId: string, monthKey?: string): AgentCost | null {
    const key = monthKey ?? toMonthKey(Date.now());
    const startOfMonth = monthKeyToTimestamp(key);
    const endOfMonth = monthKeyToTimestamp(nextMonthKey(key));
    const row = this.db
      .prepare(
        `SELECT
        agentId,
        SUM(costUsd) as totalCostUsd,
        SUM(tokensIn) as totalTokensIn,
        SUM(tokensOut) as totalTokensOut,
        COUNT(*) as entryCount
       FROM budget_entries
       WHERE agentId = ? AND timestamp >= ? AND timestamp < ?
       GROUP BY agentId`,
      )
      .get(agentId, startOfMonth, endOfMonth) as any;
    if (!row) return null;
    return {
      agentId: row.agentId,
      totalCostUsd: row.totalCostUsd,
      totalTokensIn: row.totalTokensIn,
      totalTokensOut: row.totalTokensOut,
      entryCount: row.entryCount,
    };
  }

  getRecentEntries(limit = 50): BudgetEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM budget_entries ORDER BY timestamp DESC LIMIT ?")
      .all(limit) as any[];
    return rows.map(rowToEntry);
  }

  setBudgetLimit(provider: string, budgetLimitUsd: number, monthKey?: string): void {
    const key = monthKey ?? toMonthKey(Date.now());
    this.db
      .prepare(
        `INSERT INTO monthly_summaries (provider, monthKey, totalCostUsd, totalTokensIn, totalTokensOut, budgetLimitUsd)
       VALUES (?, ?, 0, 0, 0, ?)
       ON CONFLICT(provider, monthKey)
       DO UPDATE SET budgetLimitUsd = ?`,
      )
      .run(provider, key, budgetLimitUsd, budgetLimitUsd);
  }
}

// ── Helpers ──────────────────────────────────────────

function toMonthKey(timestamp: number): string {
  const d = new Date(timestamp);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function monthKeyToTimestamp(key: string): number {
  const [year, month] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1)).getTime();
}

function nextMonthKey(key: string): string {
  const [year, month] = key.split("-").map(Number);
  if (month === 12) return `${year + 1}-01`;
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

function rowToEntry(row: any): BudgetEntry {
  return {
    id: row.id,
    provider: row.provider,
    model: row.model ?? undefined,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    costUsd: row.costUsd,
    agentId: row.agentId,
    sessionKey: row.sessionKey ?? undefined,
    timestamp: row.timestamp,
  };
}

// ── Singleton ────────────────────────────────────────

let storeInstance: BudgetStore | null = null;

export function getBudgetStore(stateDir?: string): BudgetStore {
  if (!storeInstance && stateDir) {
    storeInstance = new BudgetStore(stateDir);
  }
  if (!storeInstance) {
    throw new Error("Budget store not initialized with stateDir");
  }
  return storeInstance;
}
