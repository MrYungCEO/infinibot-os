/**
 * Secure research records, kept ONLY in the encrypted vault:
 *
 *   research-log        index: one row per run (id, session, status, the
 *                       exact outbound queries and when they were sent)
 *   research-<id>       the full run: goal, proposed vs. sanitized queries,
 *                       what the sanitizer removed, sources, page extracts,
 *                       the summary and value estimates, and the egress log
 *
 * Both are AES-256-GCM sealed by SecureVault; nothing here touches the normal
 * lane, Notion, memory files or logs.
 */

import { randomUUID } from "node:crypto";

import type { SecureVault } from "../vault.js";
import type { EgressEvent } from "./fetcher.js";
import type { RemovedItem } from "./sanitizer.js";

export const RESEARCH_LOG_STORE = "research-log";
export const RESEARCH_RECORD_PREFIX = "research-";
const MAX_LOG_ROWS = 500;

export type ResearchStatus =
  | "pending_approval"
  | "approved"
  | "running"
  | "done"
  | "denied"
  | "expired"
  | "blocked"
  | "failed";

export type ResearchApprovalMode = "ask" | "auto-sanitized";

export type ResearchQuery = {
  /** Exactly what left (or would leave) this machine. */
  query: string;
  /** What was proposed before sanitizing (stays local). */
  proposed?: string;
  removed?: RemovedItem[];
  sentAt?: number;
  results?: number;
  error?: string;
};

export type ResearchSource = {
  url: string;
  /** "snippet" = only the search engine's result snippet was used (no page fetch). */
  kind?: "page" | "snippet";
  title?: string;
  query?: string;
  fetchedAt?: number;
  status?: number;
  bytes?: number;
  /** Local-model extract of the page (stays local). */
  extract?: string;
  error?: string;
};

export type ValueEstimate = {
  item: string;
  low: number | null;
  high: number | null;
  currency: string;
  basis?: string;
  confidence?: "low" | "medium" | "high";
  sources: string[];
};

export type ResearchAttachments = {
  sessionKey?: string;
  projectId?: string;
  fileIds?: string[];
};

export type ResearchRecord = {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: ResearchStatus;
  approvalMode: ResearchApprovalMode;
  goal: string;
  attachments: ResearchAttachments;
  queries: ResearchQuery[];
  rejected?: Array<{ proposed: string; reason: string }>;
  decidedAt?: number;
  decidedBy?: string;
  edited?: boolean;
  searchEngine?: string;
  proxy?: "none" | "socks5" | "http";
  model?: string;
  sources: ResearchSource[];
  summary?: string;
  estimates?: ValueEstimate[];
  egress: EgressEvent[];
  error?: string;
};

/** The index row (what the Secure Research log panel lists). */
export type ResearchLogRow = {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: ResearchStatus;
  approvalMode: ResearchApprovalMode;
  sessionKey?: string;
  projectId?: string;
  fileIds?: string[];
  queries: Array<{ query: string; sentAt?: number }>;
  sources: number;
  hosts: string[];
};

export function newResearchId(): string {
  return `rs_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export function toLogRow(r: ResearchRecord): ResearchLogRow {
  const hosts = new Set<string>();
  for (const e of r.egress) if (!e.blocked) hosts.add(e.host);
  return {
    id: r.id,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    status: r.status,
    approvalMode: r.approvalMode,
    sessionKey: r.attachments.sessionKey,
    projectId: r.attachments.projectId,
    fileIds: r.attachments.fileIds,
    queries: r.queries.map((q) => ({ query: q.query, ...(q.sentAt ? { sentAt: q.sentAt } : {}) })),
    sources: r.sources.filter((s) => !s.error).length,
    hosts: [...hosts].slice(0, 40),
  };
}

export class ResearchStore {
  constructor(private readonly vault: SecureVault) {}

  save(record: ResearchRecord): void {
    this.vault.writeJson(`${RESEARCH_RECORD_PREFIX}${record.id}`, record);
    const rows = this.vault.readJson<ResearchLogRow[]>(RESEARCH_LOG_STORE, []);
    const row = toLogRow(record);
    const i = rows.findIndex((r) => r.id === record.id);
    if (i >= 0) rows[i] = row;
    else rows.unshift(row);
    rows.sort((a, b) => b.createdAt - a.createdAt);
    this.vault.writeJson(RESEARCH_LOG_STORE, rows.slice(0, MAX_LOG_ROWS));
  }

  get(id: string): ResearchRecord | null {
    if (!/^rs_[a-z0-9]{8,32}$/.test(id)) return null;
    const store = `${RESEARCH_RECORD_PREFIX}${id}`;
    if (!this.vault.has(store)) return null;
    return this.vault.readJson<ResearchRecord | null>(store, null);
  }

  list(opts: { sessionKey?: string; limit?: number } = {}): ResearchLogRow[] {
    const rows = this.vault.readJson<ResearchLogRow[]>(RESEARCH_LOG_STORE, []);
    const filtered = opts.sessionKey ? rows.filter((r) => r.sessionKey === opts.sessionKey) : rows;
    return filtered.slice(0, Math.max(1, Math.min(500, opts.limit ?? 100)));
  }

  remove(id: string): boolean {
    const rec = this.get(id);
    if (!rec) return false;
    this.vault.remove(`${RESEARCH_RECORD_PREFIX}${id}`);
    const rows = this.vault
      .readJson<ResearchLogRow[]>(RESEARCH_LOG_STORE, [])
      .filter((r) => r.id !== id);
    this.vault.writeJson(RESEARCH_LOG_STORE, rows);
    return true;
  }
}
