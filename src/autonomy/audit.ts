/**
 * Autonomy Architecture — Audit Log System
 * Tamper-evident, append-only log of all autonomous actions
 */

import { createHash } from "crypto";
import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { AuditEntry, AuditActionType } from "./types.js";

let auditBasePath = "state/autonomy/audit";
let lastEntryHash: string | null = null;

/**
 * Initialize audit system with custom path
 */
export function initAudit(basePath?: string): void {
  if (basePath) {
    auditBasePath = basePath;
  }

  // Ensure directory exists
  if (!existsSync(auditBasePath)) {
    mkdirSync(auditBasePath, { recursive: true });
  }

  // Load last hash for chain continuity
  const todayFile = getTodayAuditPath();
  if (existsSync(todayFile)) {
    try {
      const content = readFileSync(todayFile, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      if (lines.length > 0) {
        const lastEntry = JSON.parse(lines[lines.length - 1]) as AuditEntry;
        lastEntryHash = lastEntry.hash || null;
      }
    } catch {
      // Fresh start
      lastEntryHash = null;
    }
  }
}

/**
 * Get today's audit log path
 */
function getTodayAuditPath(): string {
  const date = new Date().toISOString().split("T")[0];
  return join(auditBasePath, `${date}.jsonl`);
}

/**
 * Generate hash for tamper-evidence chain
 */
function generateEntryHash(entry: Omit<AuditEntry, "hash">, previousHash: string | null): string {
  const payload = JSON.stringify({ ...entry, previousHash });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

/**
 * Generate unique ID for audit entry
 */
function generateAuditId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `audit_${timestamp}_${random}`;
}

/**
 * Log an action to the audit trail
 */
export function logAudit(
  actionType: AuditActionType,
  description: string,
  options: {
    category?: AuditEntry["category"];
    target?: string;
    outcome?: AuditEntry["outcome"];
    details?: Record<string, unknown>;
    sessionKey?: string;
    agentId?: string;
  } = {},
): AuditEntry {
  const now = Date.now();

  const entry: Omit<AuditEntry, "hash"> = {
    id: generateAuditId(),
    timestamp: now,
    isoTime: new Date(now).toISOString(),
    actionType,
    category: options.category || inferCategory(actionType),
    description,
    target: options.target,
    outcome: options.outcome || "success",
    details: options.details,
    sessionKey: options.sessionKey,
    agentId: options.agentId,
  };

  // Generate tamper-evident hash
  const hash = generateEntryHash(entry, lastEntryHash);
  const fullEntry: AuditEntry = { ...entry, hash };

  // Append to today's log
  const logPath = getTodayAuditPath();
  if (!existsSync(dirname(logPath))) {
    mkdirSync(dirname(logPath), { recursive: true });
  }

  appendFileSync(logPath, JSON.stringify(fullEntry) + "\n", "utf-8");

  // Update chain
  lastEntryHash = hash;

  return fullEntry;
}

/**
 * Infer category from action type
 */
function inferCategory(actionType: AuditActionType): AuditEntry["category"] {
  if (
    actionType.startsWith("task_") ||
    actionType.startsWith("autonomous_") ||
    actionType.startsWith("heartbeat_")
  ) {
    return "autonomy";
  }
  if (actionType.startsWith("file_")) {
    return "file";
  }
  if (actionType === "exec_command") {
    return "exec";
  }
  if (actionType === "api_call") {
    return "api";
  }
  if (actionType === "notification_sent") {
    return "notification";
  }
  return "system";
}

/**
 * Read audit entries for a specific date
 */
export function readAuditLog(date?: string): AuditEntry[] {
  const targetDate = date || new Date().toISOString().split("T")[0];
  const logPath = join(auditBasePath, `${targetDate}.jsonl`);

  if (!existsSync(logPath)) {
    return [];
  }

  const content = readFileSync(logPath, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);

  return lines.map((line) => JSON.parse(line) as AuditEntry);
}

/**
 * Get recent audit entries (last N entries across all days)
 */
export function getRecentAuditEntries(limit: number = 50): AuditEntry[] {
  if (!existsSync(auditBasePath)) {
    return [];
  }

  const files = readdirSync(auditBasePath)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .reverse();

  const entries: AuditEntry[] = [];

  for (const file of files) {
    if (entries.length >= limit) break;

    const filePath = join(auditBasePath, file);
    const content = readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean).reverse();

    for (const line of lines) {
      if (entries.length >= limit) break;
      entries.push(JSON.parse(line) as AuditEntry);
    }
  }

  return entries;
}

/**
 * Verify audit chain integrity
 */
export function verifyAuditChain(date?: string): {
  valid: boolean;
  brokenAt?: string;
  error?: string;
} {
  const entries = readAuditLog(date);

  if (entries.length === 0) {
    return { valid: true };
  }

  let previousHash: string | null = null;

  for (const entry of entries) {
    const { hash, ...rest } = entry;
    const expectedHash = generateEntryHash(rest, previousHash);

    if (hash !== expectedHash) {
      return {
        valid: false,
        brokenAt: entry.id,
        error: `Hash mismatch at entry ${entry.id}`,
      };
    }

    previousHash = hash;
  }

  return { valid: true };
}

/**
 * Get audit statistics for today
 */
export function getTodayAuditStats(): {
  totalEntries: number;
  byCategory: Record<string, number>;
  byOutcome: Record<string, number>;
  cageInterferences: number;
} {
  const entries = readAuditLog();

  const byCategory: Record<string, number> = {};
  const byOutcome: Record<string, number> = {};
  let cageInterferences = 0;

  for (const entry of entries) {
    byCategory[entry.category] = (byCategory[entry.category] || 0) + 1;
    byOutcome[entry.outcome] = (byOutcome[entry.outcome] || 0) + 1;

    if (entry.actionType === "cage_interference_detected") {
      cageInterferences++;
    }
  }

  return {
    totalEntries: entries.length,
    byCategory,
    byOutcome,
    cageInterferences,
  };
}

/**
 * Log cage interference detection
 */
export function logCageInterference(
  description: string,
  details?: Record<string, unknown>,
): AuditEntry {
  return logAudit("cage_interference_detected", description, {
    category: "system",
    outcome: "blocked",
    details: {
      ...details,
      severity: "warning",
      timestamp: new Date().toISOString(),
    },
  });
}

// Export convenience methods
export const audit = {
  init: initAudit,
  log: logAudit,
  read: readAuditLog,
  recent: getRecentAuditEntries,
  verify: verifyAuditChain,
  stats: getTodayAuditStats,
  logCageInterference,
};
