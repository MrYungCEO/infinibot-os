/**
 * Business hub email — install-level settings (public base URL, physical
 * address, global send caps, link style), the per-install secrets behind
 * signed links and webhook URLs, and the runtime hooks the orchestrator
 * wires (pipeline automation, transport overrides).
 *
 * Settings live in `hub_meta` so each state dir (SaaS tenant) has its own.
 */

import { randomBytes } from "node:crypto";
import { getMeta, setMeta, type HubDb } from "../db.js";
import { parseJson } from "../util.js";
import type { EmailTransport, SenderConfig } from "./transport.js";

/** Public route prefix every tracking / unsubscribe / webhook URL hangs off. */
export const HUB_HTTP_BASE = "/plugins/business-agency";

export type EmailSettings = {
  /** Public origin recipients and landing pages can reach (e.g. https://bot.acme.com). */
  publicBaseUrl: string | null;
  /** Postal address required in commercial email footers (CAN-SPAM / GDPR). */
  physicalAddress: string | null;
  /** Shown in the footer ("You are receiving this from <companyName>"). */
  companyName: string | null;
  /** Hard ceiling across every campaign. */
  globalPerMinute: number;
  globalPerDay: number;
  defaultSenderId: string | null;
};

const DEFAULT_SETTINGS: EmailSettings = {
  publicBaseUrl: null,
  physicalAddress: null,
  companyName: null,
  globalPerMinute: 60,
  globalPerDay: 2000,
  defaultSenderId: null,
};

export function getEmailSettings(db: HubDb): EmailSettings {
  const raw = parseJson<Partial<EmailSettings>>(getMeta(db, "email.config"), {});
  const merged = { ...DEFAULT_SETTINGS, ...raw };
  return {
    publicBaseUrl: merged.publicBaseUrl,
    physicalAddress: merged.physicalAddress,
    companyName: merged.companyName,
    globalPerMinute: merged.globalPerMinute,
    globalPerDay: merged.globalPerDay,
    defaultSenderId: merged.defaultSenderId,
  };
}

export function saveEmailSettings(db: HubDb, patch: Partial<EmailSettings>): EmailSettings {
  const cur = getEmailSettings(db);
  const next: EmailSettings = { ...cur };
  if (patch.publicBaseUrl !== undefined) next.publicBaseUrl = cleanBaseUrl(patch.publicBaseUrl);
  if (patch.physicalAddress !== undefined)
    next.physicalAddress = patch.physicalAddress?.trim().slice(0, 300) || null;
  if (patch.companyName !== undefined)
    next.companyName = patch.companyName?.trim().slice(0, 120) || null;
  if (patch.globalPerMinute !== undefined)
    next.globalPerMinute = clampInt(patch.globalPerMinute, 1, 1000);
  if (patch.globalPerDay !== undefined)
    next.globalPerDay = clampInt(patch.globalPerDay, 1, 100_000);
  if (patch.defaultSenderId !== undefined) next.defaultSenderId = patch.defaultSenderId || null;
  setMeta(db, "email.config", JSON.stringify(next));
  return next;
}

function clampInt(v: unknown, lo: number, hi: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

export function cleanBaseUrl(raw: string | null | undefined): string | null {
  const s = raw?.trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

// ── Secrets ──────────────────────────────────────────────────────────────────

function ensureSecret(db: HubDb, key: string): string {
  const cur = getMeta(db, key);
  if (cur) return cur;
  const fresh = randomBytes(32).toString("base64url");
  // INSERT OR IGNORE semantics: a concurrent writer wins, we re-read.
  db.prepare("INSERT OR IGNORE INTO hub_meta(key,value) VALUES(?,?)").run(key, fresh);
  return getMeta(db, key) ?? fresh;
}

/** HMAC key for open / click / unsubscribe / contact tokens (generated once). */
export function getTokenSecret(db: HubDb): string {
  return ensureSecret(db, "email.tokenSecret");
}

/** Secret path segment for provider webhooks (generated once). */
export function getWebhookSecret(db: HubDb): string {
  return ensureSecret(db, "email.webhookSecret");
}

// ── Runtime (hooks + overrides wired by the orchestrator) ───────────────────

export type BusinessHubHooks = {
  /** A landing-page form was submitted and stitched to a contact. */
  onFormSubmitted?: (
    contactId: string,
    info: { siteId: string; pageId: string | null; campaignId: string | null },
  ) => void;
  /** A contact replied to a campaign / one-off email. */
  onReplied?: (
    contactId: string,
    info: {
      sendId: string;
      emailCampaignId: string | null;
      inboundId?: string | null;
      subject?: string | null;
      body?: string | null;
      autoReply?: boolean;
      receivedAt?: number;
    },
  ) => void;
  /** An email to a contact was handed to the provider (campaign step or one-off). */
  onSent?: (contactId: string, info: { sendId: string; emailCampaignId: string | null }) => void;
  /** A contact clicked a tracked link. */
  onClicked?: (
    contactId: string,
    info: { sendId: string; emailCampaignId: string | null; url: string },
  ) => void;
};

export type TransportFactory = (sender: SenderConfig) => EmailTransport;

export type EmailRuntime = {
  hooks: BusinessHubHooks;
  /** Fallback public base URL (e.g. the gateway's tunnel URL) when settings have none. */
  baseUrl?: string | (() => string | null | undefined);
  /** Override how a sender becomes a transport (tests / sandboxes). */
  transportFactory?: TransportFactory;
  /** fetch used by HTTP providers (Resend / Postmark / SNS confirm). */
  fetch?: typeof fetch;
  log?: (msg: string, data?: Record<string, unknown>) => void;
};

let runtime: EmailRuntime = { hooks: {} };

/** Merge hooks / overrides into the process-wide email runtime. */
export function configureEmailRuntime(patch: Partial<EmailRuntime>): void {
  runtime = { ...runtime, ...patch, hooks: { ...runtime.hooks, ...patch.hooks } };
}

export function resetEmailRuntime(): void {
  runtime = { hooks: {} };
}

export function getEmailRuntime(): EmailRuntime {
  return runtime;
}

/** Fire a hook without letting a hook failure break the caller. */
export function fireHook<K extends keyof BusinessHubHooks>(
  hooks: BusinessHubHooks | undefined,
  name: K,
  ...args: Parameters<NonNullable<BusinessHubHooks[K]>>
): void {
  const fn = (hooks?.[name] ?? runtime.hooks[name]) as ((...a: unknown[]) => void) | undefined;
  if (!fn) return;
  try {
    fn(...args);
  } catch (err) {
    runtime.log?.(`hook ${name} failed`, { err: String(err) });
  }
}

/** Public base URL: explicit → settings → runtime fallback. Null when unknown. */
export function resolveBaseUrl(db: HubDb, explicit?: string | null): string | null {
  const fromExplicit = cleanBaseUrl(explicit);
  if (fromExplicit) return fromExplicit;
  const fromSettings = getEmailSettings(db).publicBaseUrl;
  if (fromSettings) return fromSettings;
  const rt = typeof runtime.baseUrl === "function" ? runtime.baseUrl() : runtime.baseUrl;
  return cleanBaseUrl(rt ?? null);
}
