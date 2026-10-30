/**
 * Business & Agency — one-time "keep it on" check for existing installs.
 *
 * Wired into src/plugins/core-surface-migrations.ts (same marker file and
 * explicit-choice rules as Discipline / Canvas Library). A fresh install has
 * none of the data below, so the bundled plugin stays OFF; an install whose
 * owner already runs a business keeps it ON.
 *
 * Only USER-AUTHORED business rows count. Tables that fill themselves on any
 * install are ignored on purpose:
 *   - agency.db `agencies` / `agency_projects` / `agency_tasks` / legacy
 *     mappings are auto-imported from the kanban board the first time the
 *     agency selector loaded;
 *   - hq-progress.json events are recorded whenever a kanban task completes.
 *
 * Data is never moved: every store keeps its existing path (it lives beside
 * core data and several stores are live SQLite WAL databases), so turning the
 * plugin off and on again is lossless. See docs/plugins/BUSINESS-AGENCY.md.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type { InfinibotConfig } from "../config/config.js";
import { BUSINESS_AGENCY_PLUGIN_ID } from "./methods.js";

/** Roster agents that ship with the plugin (extensions/business-agency/agents). */
export const BUSINESS_AGENCY_AGENT_IDS = [
  "client-director",
  "outreach",
  "ledger",
  "scout",
  "ops-ceo-briefing",
  "ops-monitor",
] as const;

type Db = { prepare: (sql: string) => { get: (...a: unknown[]) => unknown }; close: () => void };

function openReadonly(file: string): Db | null {
  if (!fs.existsSync(file)) return null;
  try {
    const Database = createRequire(import.meta.url)("better-sqlite3") as new (
      f: string,
      o: { readonly: boolean; fileMustExist: boolean },
    ) => Db;
    return new Database(file, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

/** Tables (of `file`) that hold at least one row. Missing file/table → none. */
function tablesWithRows(file: string, tables: readonly string[]): string[] {
  const db = openReadonly(file);
  if (!db) return [];
  const out: string[] = [];
  try {
    for (const table of tables) {
      try {
        if (db.prepare(`SELECT 1 AS x FROM "${table}" LIMIT 1`).get()) out.push(table);
      } catch {
        /* table missing in an older schema */
      }
    }
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** User-authored agency.db tables (clients, deals, money). */
const AGENCY_USER_TABLES = [
  "clients",
  "engagements",
  "opportunities",
  "proposals",
  "invoices",
  "payments",
  "revenue_entries",
] as const;

/** Register stores: <file> → main table. */
const REGISTER_STORES: Array<[string, string]> = [
  ["opportunity.db", "opportunities"],
  ["decision.db", "decisions"],
  ["risk.db", "risks"],
  ["commitment.db", "commitments"],
  ["person.db", "person"],
];

function businessJsonHasClients(file: string): boolean {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8")) as {
      clients?: unknown[];
      businesses?: Array<{ clients?: unknown[] }>;
    };
    if (Array.isArray(data.clients) && data.clients.length > 0) return true;
    return (data.businesses ?? []).some((b) => Array.isArray(b?.clients) && b.clients.length > 0);
  } catch {
    return false;
  }
}

/** Legacy stores (funnels, campaigns, leads) resolve `INFINIBOT_STATE_DIR` or cwd "state". */
export function businessLegacyStateDir(): string {
  return process.env.INFINIBOT_STATE_DIR || process.env.MOLTBOT_STATE_DIR || "state";
}

/**
 * Evidence that this install runs a business. Each entry is a short
 * human-readable reason; empty = no data. `stateDirs` are checked in order.
 */
export function detectBusinessAgencyData(stateDirs: string[]): string[] {
  const reasons: string[] = [];
  const seen = new Set<string>();
  for (const dir of stateDirs) {
    const abs = path.resolve(dir);
    if (seen.has(abs)) continue;
    seen.add(abs);
    const agency = tablesWithRows(
      path.join(abs, "agency-operations", "agency.db"),
      AGENCY_USER_TABLES,
    );
    if (agency.length) reasons.push(`agency workspace (${agency.join(", ")})`);
    for (const [file, table] of REGISTER_STORES) {
      if (tablesWithRows(path.join(abs, file), [table]).length) {
        reasons.push(`${table} register (${file})`);
      }
    }
    if (businessJsonHasClients(path.join(abs, "business.json"))) {
      reasons.push("clients in business.json");
    }
    const funnels = tablesWithRows(path.join(abs, "funnels", "funnels.db"), ["funnels", "leads"]);
    if (funnels.length) reasons.push(`funnels store (${funnels.join(", ")})`);
    if (tablesWithRows(path.join(abs, "campaigns", "campaigns.db"), ["campaigns"]).length) {
      reasons.push("campaigns");
    }
  }
  return [...new Set(reasons)];
}

export function businessAgencyHasExistingData(stateDir: string): boolean {
  return detectBusinessAgencyData([stateDir, businessLegacyStateDir()]).length > 0;
}

/**
 * Hand the seed-managed business agents (written by the core roster before
 * the move: `_seedVersion` set, no `_plugin`) to the plugin. The plugin's
 * roster then refreshes them while it is enabled and removes them while it is
 * off; an agent the operator customised (no `_seedVersion`) is left alone.
 * Mutates and returns `config`.
 */
export function adoptBusinessAgencyAgents(config: InfinibotConfig): {
  config: InfinibotConfig;
  adopted: string[];
} {
  const agents = (config as Record<string, unknown>).agents as
    | { list?: Array<Record<string, unknown>> }
    | undefined;
  const adopted: string[] = [];
  for (const entry of agents?.list ?? []) {
    const id = typeof entry?.id === "string" ? entry.id : "";
    if (!(BUSINESS_AGENCY_AGENT_IDS as readonly string[]).includes(id)) continue;
    if (typeof entry._seedVersion !== "string" || entry._plugin !== undefined) continue;
    entry._plugin = BUSINESS_AGENCY_PLUGIN_ID;
    adopted.push(id);
  }
  return { config, adopted };
}
