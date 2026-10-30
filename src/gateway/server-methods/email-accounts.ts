/**
 * Gateway RPCs for managed EmailAccount rows (SMTP/IMAP, Gmail, etc.).
 *
 * Methods:
 *   email.accounts.list / get / create / update / delete / setPrimary
 *   email.accounts.test       — verify a single account's connection
 *   email.accounts.discover   — autoconfig prefill for the Add wizard
 *   email.accounts.inbox.list — query the unified inbound message log
 *
 * Secrets are encrypted in the store; the `list`/`get` responses use
 * the store's default masked surface (passwords cleared), so the UI
 * never sees plaintext. Updates merge — sending `smtpPassword: ""`
 * keeps the existing password; sending it as a non-empty string
 * rotates.
 */
import { discoverEmailProvider } from "../../services/email/autodiscover.js";
import { getEmailAccountsStore } from "../../services/email/accounts-store.js";
import type {
  EmailAccountInboundConfig,
  EmailAccountInput,
  EmailAccountOutboundConfig,
  EmailAccountPatch,
  EmailProviderKind,
} from "../../services/email/accounts-types.js";
import { testImapConnection } from "../../services/email/providers/imap.js";
import { testSmtpConnection } from "../../services/email/providers/smtp.js";
import {
  listInboundMessages,
  restartListenerFor,
  stopListenerFor,
} from "../../services/email/inbound-manager.js";
import type { GatewayRequestHandlers } from "./types.js";

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asBool(v: unknown, fallback = false): boolean {
  if (typeof v === "boolean") return v;
  return fallback;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return undefined;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function pickKind(v: unknown): EmailProviderKind {
  const allowed: EmailProviderKind[] = ["gmail", "smtp-imap", "mailgun", "sendgrid", "resend"];
  return allowed.includes(v as EmailProviderKind) ? (v as EmailProviderKind) : "smtp-imap";
}

function parseOutbound(raw: unknown): EmailAccountOutboundConfig {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: EmailAccountOutboundConfig = {};
  if (typeof r.smtpHost === "string") out.smtpHost = r.smtpHost;
  if (typeof r.smtpPort === "number") out.smtpPort = r.smtpPort;
  if (typeof r.smtpSecure === "boolean") out.smtpSecure = r.smtpSecure;
  if (typeof r.smtpUser === "string") out.smtpUser = r.smtpUser;
  if (typeof r.smtpPassword === "string" && r.smtpPassword.length > 0) {
    out.smtpPassword = r.smtpPassword;
  }
  if (typeof r.gmailAccount === "string") out.gmailAccount = r.gmailAccount;
  if (typeof r.apiKey === "string" && r.apiKey.length > 0) out.apiKey = r.apiKey;
  if (typeof r.apiDomain === "string") out.apiDomain = r.apiDomain;
  if (typeof r.fromAddress === "string") out.fromAddress = r.fromAddress;
  return out;
}

function parseInbound(raw: unknown): EmailAccountInboundConfig {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: EmailAccountInboundConfig = {};
  if (typeof r.imapHost === "string") out.imapHost = r.imapHost;
  if (typeof r.imapPort === "number") out.imapPort = r.imapPort;
  if (typeof r.imapSecure === "boolean") out.imapSecure = r.imapSecure;
  if (typeof r.imapUser === "string") out.imapUser = r.imapUser;
  if (typeof r.imapPassword === "string" && r.imapPassword.length > 0) {
    out.imapPassword = r.imapPassword;
  }
  if (typeof r.imapMailbox === "string") out.imapMailbox = r.imapMailbox;
  if (typeof r.gmailWatchTopic === "string") out.gmailWatchTopic = r.gmailWatchTopic;
  return out;
}

export const emailAccountsHandlers: GatewayRequestHandlers = {
  "email.accounts.list": async ({ params, respond }) => {
    try {
      const businessIdRaw = params?.businessId;
      const businessId =
        businessIdRaw === null
          ? null
          : typeof businessIdRaw === "string" && businessIdRaw
            ? businessIdRaw
            : undefined;
      const kind = pickKind(params?.kind);
      const filter: { businessId?: string | null; kind?: EmailProviderKind } = {};
      if (businessId !== undefined) filter.businessId = businessId;
      if (typeof params?.kind === "string") filter.kind = kind;
      const accounts = getEmailAccountsStore().list(filter);
      respond(true, { accounts });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "email.accounts.get": async ({ params, respond }) => {
    try {
      const id = asString(params?.id);
      if (!id) return respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
      const acct = getEmailAccountsStore().get(id);
      if (!acct)
        return respond(false, undefined, { code: "NOT_FOUND", message: "no such account" });
      respond(true, { account: acct });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "email.accounts.create": async ({ params, respond }) => {
    try {
      const kind = pickKind(params?.kind);
      const address = asString(params?.address).trim();
      const displayName = asString(params?.displayName).trim() || address;
      if (!address) {
        return respond(false, undefined, { code: "BAD_REQUEST", message: "address required" });
      }
      const businessIdRaw = params?.businessId;
      const businessId = typeof businessIdRaw === "string" && businessIdRaw ? businessIdRaw : null;
      const labels = asStringArray(params?.labels);
      const outboundEnabled = asBool((params?.outbound as any)?.enabled, true);
      const inboundEnabled = asBool((params?.inbound as any)?.enabled, true);
      const input: EmailAccountInput = {
        kind,
        address,
        displayName,
        labels,
        businessId,
        isPrimary:
          typeof params?.isPrimary === "boolean" ? (params!.isPrimary as boolean) : undefined,
        outbound: {
          enabled: outboundEnabled,
          config: parseOutbound((params?.outbound as any)?.config),
        },
        inbound: {
          enabled: inboundEnabled,
          config: parseInbound((params?.inbound as any)?.config),
          pollIntervalSec: asNumber((params?.inbound as any)?.pollIntervalSec) ?? undefined,
        },
      };
      const account = getEmailAccountsStore().create(input);
      // Spin up the IMAP listener if applicable.
      void restartListenerFor(account.id);
      respond(true, { account });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "email.accounts.update": async ({ params, respond }) => {
    try {
      const id = asString(params?.id);
      if (!id) return respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
      const patchRaw =
        (params?.patch as Record<string, unknown>) || (params as Record<string, unknown>);
      const patch: EmailAccountPatch = {};
      if (typeof patchRaw.kind === "string") patch.kind = pickKind(patchRaw.kind);
      if (typeof patchRaw.address === "string") patch.address = patchRaw.address;
      if (typeof patchRaw.displayName === "string") patch.displayName = patchRaw.displayName;
      if (Array.isArray(patchRaw.labels)) patch.labels = asStringArray(patchRaw.labels);
      if ("businessId" in patchRaw) {
        patch.businessId =
          typeof patchRaw.businessId === "string" && patchRaw.businessId
            ? (patchRaw.businessId as string)
            : null;
      }
      if (typeof patchRaw.isPrimary === "boolean") patch.isPrimary = patchRaw.isPrimary;
      if (patchRaw.outbound && typeof patchRaw.outbound === "object") {
        const o = patchRaw.outbound as Record<string, unknown>;
        patch.outbound = {
          enabled: typeof o.enabled === "boolean" ? o.enabled : true,
          config: parseOutbound(o.config),
        };
      }
      if (patchRaw.inbound && typeof patchRaw.inbound === "object") {
        const o = patchRaw.inbound as Record<string, unknown>;
        patch.inbound = {
          enabled: typeof o.enabled === "boolean" ? o.enabled : true,
          config: parseInbound(o.config),
          pollIntervalSec: asNumber(o.pollIntervalSec),
        };
      }
      const account = getEmailAccountsStore().update(id, patch);
      void restartListenerFor(account.id);
      respond(true, { account });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "email.accounts.delete": async ({ params, respond }) => {
    try {
      const id = asString(params?.id);
      if (!id) return respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
      await stopListenerFor(id);
      getEmailAccountsStore().delete(id);
      respond(true, { ok: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      respond(false, undefined, { code: "INTERNAL_ERROR", message });
    }
  },

  "email.accounts.setPrimary": async ({ params, respond }) => {
    try {
      const id = asString(params?.id);
      if (!id) return respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
      const account = getEmailAccountsStore().setPrimary(id);
      respond(true, { account });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "email.accounts.test": async ({ params, respond }) => {
    try {
      const id = asString(params?.id);
      if (!id) return respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
      const direction = asString(params?.direction) || "both";
      const store = getEmailAccountsStore();
      const bundle = store.get(id, { includeSecrets: true });
      if (!bundle) {
        return respond(false, undefined, { code: "NOT_FOUND", message: "no such account" });
      }
      const result: {
        outbound?: { ok: boolean; error?: string; latencyMs?: number };
        inbound?: { ok: boolean; error?: string; latencyMs?: number };
      } = {};
      if (direction === "outbound" || direction === "both") {
        if (bundle.kind === "smtp-imap" && bundle.outbound.enabled) {
          result.outbound = await testSmtpConnection(bundle.outbound.config);
        } else {
          result.outbound = {
            ok: false,
            error: `outbound test not supported for kind=${bundle.kind}`,
          };
        }
        store.recordHealth(id, "outbound", {
          ok: result.outbound.ok,
          lastError: result.outbound.error,
          lastCheckedAt: Date.now(),
        });
      }
      if (direction === "inbound" || direction === "both") {
        if (bundle.kind === "smtp-imap" && bundle.inbound.enabled) {
          result.inbound = await testImapConnection(bundle.inbound.config);
        } else {
          result.inbound = {
            ok: false,
            error: `inbound test not supported for kind=${bundle.kind}`,
          };
        }
        store.recordHealth(id, "inbound", {
          ok: result.inbound.ok,
          lastError: result.inbound.error,
          lastCheckedAt: Date.now(),
        });
      }
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "email.accounts.discover": async ({ params, respond }) => {
    try {
      const address = asString(params?.address).trim();
      if (!address) {
        return respond(false, undefined, { code: "BAD_REQUEST", message: "address required" });
      }
      const result = await discoverEmailProvider(address);
      if (!result.ok) {
        return respond(true, { ok: false, error: result.error });
      }
      respond(true, { ok: true, suggestion: result.suggestion });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "email.accounts.inbox.list": async ({ params, respond }) => {
    try {
      const accountId = asString(params?.accountId) || undefined;
      const businessId = asString(params?.businessId) || undefined;
      const limit = asNumber(params?.limit);
      const messages = listInboundMessages({ accountId, businessId, limit });
      respond(true, { messages });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};
