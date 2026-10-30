/**
 * Documents limits for hosted (SaaS) tenants.
 *
 * Self-hosted installs keep the generous defaults (200 MB per upload, no
 * workspace quota). A SaaS tenant shares a small volume with the rest of its
 * workspace, so uploads are capped per file and per workspace, Notion ZIPs
 * inflate to at most the remaining quota, and API imports run as one job at a
 * time with a page cap (see import-jobs.ts).
 *
 * Env overrides (bytes / counts): INFINIBOT_DOCUMENTS_MAX_UPLOAD_BYTES,
 * INFINIBOT_DOCUMENTS_QUOTA_BYTES, INFINIBOT_DOCUMENTS_NOTION_MAX_PAGES.
 */

import fs from "node:fs";
import path from "node:path";

const MB = 1024 * 1024;

export function isSaasDocuments(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.SAAS_MODE?.trim() ?? "");
}

function envNumber(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key]?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export type DocumentsLimits = {
  /** Max bytes for one uploaded file (or Notion ZIP). */
  maxUploadBytes: number;
  /** Max bytes stored in one workspace; null = unlimited. */
  quotaBytes: number | null;
  /** Max pages/rows one Notion API import may write; null = unlimited. */
  notionMaxPages: number | null;
};

export function documentsLimits(env: NodeJS.ProcessEnv = process.env): DocumentsLimits {
  const saas = isSaasDocuments(env);
  return {
    maxUploadBytes:
      envNumber(env, "INFINIBOT_DOCUMENTS_MAX_UPLOAD_BYTES") ?? (saas ? 25 * MB : 200 * MB),
    quotaBytes: envNumber(env, "INFINIBOT_DOCUMENTS_QUOTA_BYTES") ?? (saas ? 1024 * MB : null),
    notionMaxPages: envNumber(env, "INFINIBOT_DOCUMENTS_NOTION_MAX_PAGES") ?? (saas ? 500 : null),
  };
}

/** Total bytes under a documents store root (symlinks ignored). */
export function documentsUsageBytes(root: string): number {
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        // Pre-import backups are ours, not the tenant's content.
        if (dir === root && ent.name === "backups") continue;
        stack.push(abs);
      } else if (ent.isFile()) {
        try {
          total += fs.statSync(abs).size;
        } catch {
          // raced with a delete
        }
      }
    }
  }
  return total;
}

export class DocumentsQuotaError extends Error {
  readonly status = 413;
  constructor(message: string) {
    super(message);
    this.name = "DocumentsQuotaError";
  }
}

function fmt(bytes: number): string {
  return bytes >= 1024 * MB
    ? `${(bytes / (1024 * MB)).toFixed(1)} GB`
    : `${Math.ceil(bytes / MB)} MB`;
}

/** Bytes still free in the workspace quota (Infinity when unlimited). */
export function documentsQuotaRemaining(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const { quotaBytes } = documentsLimits(env);
  if (quotaBytes === null) return Number.POSITIVE_INFINITY;
  return Math.max(0, quotaBytes - documentsUsageBytes(root));
}

/** Throw a 413 when `incomingBytes` more would exceed the workspace quota. */
export function assertDocumentsQuota(
  root: string,
  incomingBytes: number,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const { quotaBytes } = documentsLimits(env);
  if (quotaBytes === null) return;
  const used = documentsUsageBytes(root);
  if (used + incomingBytes > quotaBytes) {
    throw new DocumentsQuotaError(
      `Documents storage is full (${fmt(used)} of ${fmt(quotaBytes)} used). Delete files or empty the trash to upload more.`,
    );
  }
}
