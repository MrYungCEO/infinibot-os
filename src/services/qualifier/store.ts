/**
 * Lead Qualifier persistence — server-backed store for qualifier configs
 * and run records.
 *
 * Replaces the localStorage-only persistence in the UI controller. The
 * UI used to fall back to localStorage when the gateway endpoints
 * weren't wired; now this module IS the wiring, so configs survive
 * across browsers and become reachable from agent tools / automations.
 *
 * State layout:
 *   state/lead-qualifier.json
 *     { configs: { [businessId]: QualifierConfigV1 },
 *       runs:    { [businessId]: QualifierRunRecordV1[] } }
 *
 * Why JSON: same rationale as notion-conflicts.ts — low write volume,
 * short records, and the file is loadable from any context (no SQLite
 * dependency on the import path).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("qualifier-store");

// ─── Types (server-side mirror of the UI controller's QualifierConfig) ──
// Kept loose (most fields optional) so a future UI bump doesn't require
// a paired schema change here. The shape is contract-by-test; we never
// read fields we don't expect to be present.

export type QualifierResult = "qualified" | "unqualified" | "error";

export interface QualifierConfigV1 {
  businessId: string;
  name: string;
  enabled: boolean;
  webhookPath: string;
  webhookSecret?: string;
  criteriaMode: "all" | "any";
  criteria: Array<Record<string, unknown>>;
  actions: Array<{
    id: string;
    kind: string;
    branch?: string | null;
    config?: Record<string, unknown>;
    label?: string;
  }>;
  styleTemplateId?: string;
  linkedProjectId?: string;
  crmDatabaseId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface QualifierRunRecordV1 {
  id: string;
  receivedAt: number;
  result: QualifierResult;
  payloadPreview: string;
  note: string;
  completedAt: number | null;
  /** Which lead row, if any, the run produced. Set when save-to-crm fired. */
  leadId?: string;
  /** Action-by-action outcomes for the runs UI. */
  actionResults?: Array<{ actionId: string; kind: string; ok: boolean; detail?: string }>;
}

interface StateFile {
  configs: Record<string, QualifierConfigV1>;
  runs: Record<string, QualifierRunRecordV1[]>;
}

const RUNS_PER_BUSINESS_CAP = 200;

function getStateDir(): string {
  return process.env.INFINIBOT_STATE_DIR ?? "state";
}

function getStatePath(): string {
  return join(getStateDir(), "lead-qualifier.json");
}

function loadFile(): StateFile {
  const p = getStatePath();
  if (!existsSync(p)) return { configs: {}, runs: {} };
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<StateFile>;
    return {
      configs: raw.configs && typeof raw.configs === "object" ? raw.configs : {},
      runs: raw.runs && typeof raw.runs === "object" ? raw.runs : {},
    };
  } catch (err) {
    log.warn("qualifier file unreadable, starting empty", { err: String(err) });
    return { configs: {}, runs: {} };
  }
}

function saveFile(file: StateFile): void {
  const p = getStatePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(file, null, 2));
}

// ─── Configs ──

export function listConfigs(): Record<string, QualifierConfigV1> {
  return loadFile().configs;
}

export function getConfig(businessId: string): QualifierConfigV1 | null {
  if (!businessId) return null;
  return loadFile().configs[businessId] ?? null;
}

export function upsertConfig(config: QualifierConfigV1): QualifierConfigV1 {
  if (!config.businessId) throw new Error("upsertConfig: businessId required");
  const file = loadFile();
  const now = Date.now();
  const existing = file.configs[config.businessId];
  const merged: QualifierConfigV1 = {
    ...existing,
    ...config,
    createdAt: existing?.createdAt ?? config.createdAt ?? now,
    updatedAt: now,
  };
  file.configs[config.businessId] = merged;
  saveFile(file);
  return merged;
}

export function deleteConfig(businessId: string): boolean {
  const file = loadFile();
  if (!file.configs[businessId]) return false;
  delete file.configs[businessId];
  delete file.runs[businessId];
  saveFile(file);
  return true;
}

// ─── Runs (audit log of qualifier executions) ──

export function listRuns(businessId: string, limit?: number): QualifierRunRecordV1[] {
  const all = loadFile().runs[businessId] ?? [];
  const sorted = [...all].sort((a, b) => b.receivedAt - a.receivedAt);
  return typeof limit === "number" ? sorted.slice(0, limit) : sorted;
}

export function appendRun(businessId: string, record: QualifierRunRecordV1): void {
  const file = loadFile();
  const list = file.runs[businessId] ?? [];
  list.push(record);
  // Cap per-business so a chatty webhook doesn't grow this file forever.
  if (list.length > RUNS_PER_BUSINESS_CAP) {
    list.splice(0, list.length - RUNS_PER_BUSINESS_CAP);
  }
  file.runs[businessId] = list;
  saveFile(file);
}

export function updateRun(
  businessId: string,
  runId: string,
  patch: Partial<QualifierRunRecordV1>,
): QualifierRunRecordV1 | null {
  const file = loadFile();
  const list = file.runs[businessId] ?? [];
  const idx = list.findIndex((r) => r.id === runId);
  if (idx === -1) return null;
  list[idx] = { ...list[idx], ...patch };
  saveFile(file);
  return list[idx];
}
