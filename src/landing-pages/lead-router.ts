/**
 * Form-submission → CRM router.
 *
 * Each landing page is owned by a `communityId`, which we treat as the
 * tenant id ("business id"). Submissions are persisted per-business so each
 * business has its own isolated CRM feed, then optionally fanned out to
 * downstream destinations (Notion CRM, Telegram alert, etc).
 *
 * Storage:
 *   <CONFIG_DIR>/landing-pages/leads/<businessId>/submissions.jsonl
 *   <CONFIG_DIR>/landing-pages/leads/<businessId>/index.json   — lightweight aggregate
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { CONFIG_DIR } from "../utils.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("lp-leads");

const LEADS_ROOT = path.join(CONFIG_DIR, "landing-pages", "leads");

export interface FormSubmission {
  id: string;
  businessId: string;
  pageId: string;
  pageSlug?: string;
  formId: string;
  receivedAtMs: number;
  data: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
  source?: string;
  /** Set when this submission has been pushed to a destination (Notion CRM, Telegram etc). */
  forwarded?: Array<{ destination: string; status: "ok" | "error"; at: number; error?: string }>;
}

export interface BusinessLeadsIndex {
  businessId: string;
  total: number;
  byPage: Record<string, number>;
  byForm: Record<string, number>;
  lastSubmittedAtMs?: number;
}

function dirFor(businessId: string): string {
  const safe = businessId.replace(/[^a-zA-Z0-9_.-]/g, "_") || "default";
  return path.join(LEADS_ROOT, safe);
}

async function appendSubmission(s: FormSubmission): Promise<void> {
  const dir = dirFor(s.businessId);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, "submissions.jsonl"), `${JSON.stringify(s)}\n`, "utf-8");
}

async function loadIndex(businessId: string): Promise<BusinessLeadsIndex> {
  const p = path.join(dirFor(businessId), "index.json");
  try {
    const raw = await fs.readFile(p, "utf-8");
    return JSON.parse(raw) as BusinessLeadsIndex;
  } catch {
    return { businessId, total: 0, byPage: {}, byForm: {} };
  }
}

async function saveIndex(idx: BusinessLeadsIndex): Promise<void> {
  const dir = dirFor(idx.businessId);
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, "index.json");
  const tmp = `${target}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(tmp, JSON.stringify(idx, null, 2), "utf-8");
  await fs.rename(tmp, target);
}

export async function captureSubmission(input: {
  businessId: string;
  pageId: string;
  pageSlug?: string;
  formId: string;
  data: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
  source?: string;
}): Promise<FormSubmission> {
  const sub: FormSubmission = {
    id: randomUUID(),
    businessId: input.businessId,
    pageId: input.pageId,
    pageSlug: input.pageSlug,
    formId: input.formId,
    data: input.data,
    receivedAtMs: Date.now(),
    ip: input.ip,
    userAgent: input.userAgent,
    source: input.source,
    forwarded: [],
  };
  await appendSubmission(sub);
  // Update aggregate
  const idx = await loadIndex(input.businessId);
  idx.total += 1;
  idx.byPage[input.pageId] = (idx.byPage[input.pageId] || 0) + 1;
  idx.byForm[input.formId] = (idx.byForm[input.formId] || 0) + 1;
  idx.lastSubmittedAtMs = sub.receivedAtMs;
  await saveIndex(idx);
  log.info(`submission captured: business=${input.businessId} page=${input.pageId} form=${input.formId}`);
  return sub;
}

export async function listBusinessSubmissions(businessId: string, opts?: { limit?: number; pageId?: string }): Promise<FormSubmission[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 1000);
  const pageId = opts?.pageId;
  const file = path.join(dirFor(businessId), "submissions.jsonl");
  let raw: string;
  try { raw = await fs.readFile(file, "utf-8"); } catch { return []; }
  const lines = raw.split("\n").filter(Boolean);
  const out: FormSubmission[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      const s = JSON.parse(lines[i]) as FormSubmission;
      if (pageId && s.pageId !== pageId) continue;
      out.push(s);
    } catch { /* skip malformed */ }
  }
  return out;
}

export async function getBusinessLeadsIndex(businessId: string): Promise<BusinessLeadsIndex> {
  return loadIndex(businessId);
}

export async function listBusinesses(): Promise<string[]> {
  try {
    const entries = await fs.readdir(LEADS_ROOT, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}
