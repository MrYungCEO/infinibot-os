/**
 * Unified email dispatcher.
 *
 * Single entry point every InfiniBot subsystem (qualifier action runner,
 * funnel autoresponder, "Send Email" UI button) calls when it needs to
 * deliver email. Picks a provider in this order:
 *
 *   1. Explicit `providerHint` in the input (e.g. force "loops" for a
 *      specific transactional template).
 *   2. **Resend** — `RESEND_API_KEY` env. Generic transactional sends
 *      with raw subject + body. Pure HTTP, no socket handling.
 *   3. **Loops** — `LOOPS_API_KEY` env, but ONLY when the caller
 *      provides `transactionalId` (Loops requires a pre-defined
 *      template — it doesn't accept raw bodies).
 *   4. Otherwise: `NO_PROVIDER` error so callers can degrade gracefully
 *      (queue, surface a warning, etc).
 *
 * Why only HTTP providers in v1: SMTP (nodemailer) means a new dep +
 * socket-level error handling; not in v1 scope. Adding it later is just
 * another switch arm in `dispatch()`.
 *
 * Failure model: returns `{ ok: true, providerUsed, providerMessageId? }`
 * on success, or `{ ok: false, code, message }` on failure. Never throws
 * — callers should be able to log + continue.
 */
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { CampaignContext } from "../../campaigns/types.js";
import { getEmailAccountsStore } from "./accounts-store.js";
import { sendViaSmtp } from "./providers/smtp.js";

const log = createSubsystemLogger("email-dispatcher");

export type EmailProvider = "resend" | "loops" | "smtp";

export interface SendEmailInput {
  /** Recipient address (or array). */
  to: string | string[];
  subject: string;
  /** Plain-text body. Required unless `transactionalId` (Loops) is set. */
  body?: string;
  /** Optional HTML body. */
  html?: string;
  /** Force a specific provider when set. Otherwise auto-selected. */
  providerHint?: EmailProvider;
  /** Override the From address. Default falls back to env per-provider. */
  from?: string;
  /** Reply-To header. */
  replyTo?: string;
  /** Loops-only: id of the pre-configured transactional template. */
  transactionalId?: string;
  /** Loops-only: mail-merge data the template references. */
  dataVariables?: Record<string, string | number>;
  /**
   * Hint about which business this send is "for" — surfaced to providers
   * that support segmentation (Loops `userGroup`) and to telemetry. Not
   * required.
   */
  businessId?: string;
  /**
   * Force a specific managed EmailAccount (SMTP/Gmail/etc). If set, the
   * dispatcher uses that account's provider regardless of providerHint
   * and ignores Resend/Loops auto-pick.
   */
  accountId?: string;
  /**
   * Optional outreach-campaign context. When set, the dispatcher records
   * the send against the campaign's `emailsSent` counter and downstream
   * AI-driven body generators can read it (see TODO at the call site).
   *
   * TODO(campaigns): wire `campaignContext` into the AI body generation
   * paths that compose `body`/`html` before dispatch — currently only
   * used for telemetry. See `src/funnels/intake.ts:293`, `src/services/
   * qualifier/runner.ts:123`, `src/discovery/actions.ts:216`.
   */
  campaignContext?: CampaignContext;
}

export type SendEmailResult =
  | {
      ok: true;
      providerUsed: EmailProvider;
      providerMessageId?: string;
    }
  | {
      ok: false;
      code:
        | "NO_PROVIDER"
        | "MISSING_FIELD"
        | "PROVIDER_REJECTED"
        | "PROVIDER_ERROR"
        | "NETWORK_ERROR";
      message: string;
      providerTried?: EmailProvider;
    };

/** True iff the named provider is reachable (env present). */
export function isProviderConfigured(p: EmailProvider): boolean {
  if (p === "resend") return !!process.env.RESEND_API_KEY;
  if (p === "loops") return !!process.env.LOOPS_API_KEY;
  if (p === "smtp") {
    // SMTP is "configured" iff at least one smtp-imap account exists.
    try {
      return (
        getEmailAccountsStore()
          .list({ kind: "smtp-imap" })
          .some((a) => a.outbound.enabled) === true
      );
    } catch {
      return false;
    }
  }
  return false;
}

/** Pick the auto-default provider given the input. Loops only when a template id is set. */
export function pickProvider(input: SendEmailInput): EmailProvider | null {
  if (input.providerHint) {
    return isProviderConfigured(input.providerHint) ? input.providerHint : null;
  }
  if (isProviderConfigured("resend") && (input.body || input.html)) return "resend";
  if (isProviderConfigured("loops") && input.transactionalId) return "loops";
  return null;
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  if (!input.to || (Array.isArray(input.to) && input.to.length === 0)) {
    return { ok: false, code: "MISSING_FIELD", message: "to required" };
  }
  if (!input.subject && !input.transactionalId) {
    return {
      ok: false,
      code: "MISSING_FIELD",
      message: "subject required (or transactionalId for Loops)",
    };
  }
  // Account-routed send takes precedence: explicit accountId, or fall
  // back to the primary account for the businessId, before considering
  // env-level Resend/Loops auto-pick.
  const routedAccount = resolveAccountForSend(input);
  if (routedAccount) {
    try {
      const result = await sendViaAccount(routedAccount, input);
      bumpCampaignCounter(input, result);
      return result;
    } catch (err) {
      log.warn("account-routed send exception", { accountId: routedAccount, err: String(err) });
      return {
        ok: false,
        code: "PROVIDER_ERROR",
        message: err instanceof Error ? err.message : String(err),
        providerTried: "smtp",
      };
    }
  }
  const provider = pickProvider(input);
  if (!provider) {
    return {
      ok: false,
      code: "NO_PROVIDER",
      message:
        "No email provider configured. Set RESEND_API_KEY, LOOPS_API_KEY, or add an SMTP/IMAP account in Email Accounts.",
    };
  }
  try {
    // TODO(campaigns): When `input.campaignContext` is present, an
    // AI body composer should run here BEFORE dispatch — using
    // campaign.context.valueProp, products[], targetAudience.description,
    // and business.voice.tone to personalize subject + body. Right now
    // we only record the send against the campaign counter below.
    const result = provider === "resend" ? await sendViaResend(input) : await sendViaLoops(input);
    bumpCampaignCounter(input, result);
    return result;
  } catch (err) {
    log.warn("dispatcher exception", { provider, err: String(err) });
    return {
      ok: false,
      code: "PROVIDER_ERROR",
      message: err instanceof Error ? err.message : String(err),
      providerTried: provider,
    };
  }
}

// ─── Resend ──

async function sendViaResend(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey)
    return {
      ok: false,
      code: "NO_PROVIDER",
      message: "RESEND_API_KEY not set",
      providerTried: "resend",
    };
  const from =
    input.from ?? process.env.RESEND_FROM ?? process.env.EMAIL_FROM ?? "no-reply@example.com";
  const to = Array.isArray(input.to) ? input.to : [input.to];
  const body: Record<string, unknown> = {
    from,
    to,
    subject: input.subject,
  };
  if (input.html) body.html = input.html;
  if (input.body) body.text = input.body;
  if (input.replyTo) body.reply_to = input.replyTo;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as {
    id?: string;
    message?: string;
    name?: string;
  };
  if (!res.ok) {
    return {
      ok: false,
      code: "PROVIDER_REJECTED",
      message: `Resend ${res.status}: ${json.message ?? json.name ?? "unknown error"}`,
      providerTried: "resend",
    };
  }
  return { ok: true, providerUsed: "resend", providerMessageId: json.id };
}

// ─── Loops (transactional only) ──

async function sendViaLoops(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = process.env.LOOPS_API_KEY;
  if (!apiKey)
    return {
      ok: false,
      code: "NO_PROVIDER",
      message: "LOOPS_API_KEY not set",
      providerTried: "loops",
    };
  if (!input.transactionalId) {
    return {
      ok: false,
      code: "MISSING_FIELD",
      message: "Loops requires transactionalId — Loops doesn't accept raw subject/body",
      providerTried: "loops",
    };
  }
  const to = Array.isArray(input.to) ? input.to[0] : input.to;
  const body: Record<string, unknown> = {
    transactionalId: input.transactionalId,
    email: to,
  };
  if (input.dataVariables) body.dataVariables = input.dataVariables;

  const res = await fetch("https://app.loops.so/api/v1/transactional", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string };
  if (!res.ok || json.success === false) {
    return {
      ok: false,
      code: "PROVIDER_REJECTED",
      message: `Loops ${res.status}: ${json.message ?? "transactional rejected"}`,
      providerTried: "loops",
    };
  }
  return { ok: true, providerUsed: "loops" };
}

// ─── Account-routed (SMTP/Gmail/etc) ──

function resolveAccountForSend(input: SendEmailInput): string | null {
  try {
    const store = getEmailAccountsStore();
    if (input.accountId) {
      const acct = store.get(input.accountId);
      if (acct && acct.outbound.enabled) return acct.id;
      return null;
    }
    if (input.businessId) {
      const primary = store.getPrimary(input.businessId);
      if (primary && primary.outbound.enabled) return primary.id;
    }
    return null;
  } catch {
    return null;
  }
}

async function sendViaAccount(accountId: string, input: SendEmailInput): Promise<SendEmailResult> {
  const store = getEmailAccountsStore();
  const bundle = store.getDecryptedOutbound(accountId);
  if (!bundle) {
    return {
      ok: false,
      code: "NO_PROVIDER",
      message: `email account not found: ${accountId}`,
    };
  }
  const { account, outbound } = bundle;
  if (account.kind === "smtp-imap") {
    const res = await sendViaSmtp(account, outbound, {
      to: input.to,
      subject: input.subject,
      text: input.body,
      html: input.html,
      from: input.from ?? outbound.fromAddress ?? account.address,
      replyTo: input.replyTo,
    });
    store.recordHealth(account.id, "outbound", {
      ok: res.ok,
      lastError: res.error,
      lastCheckedAt: Date.now(),
    });
    if (!res.ok) {
      return {
        ok: false,
        code: "PROVIDER_REJECTED",
        message: res.error ?? "smtp rejected",
        providerTried: "smtp",
      };
    }
    return { ok: true, providerUsed: "smtp", providerMessageId: res.messageId };
  }
  // Gmail / future providers fall back to the existing global dispatcher
  // pickers — we just report NO_PROVIDER if they aren't wired here yet.
  return {
    ok: false,
    code: "NO_PROVIDER",
    message: `account-routed send not implemented for kind=${account.kind}`,
  };
}

function bumpCampaignCounter(input: SendEmailInput, result: SendEmailResult): void {
  if (!result.ok || !input.campaignContext?.campaign?.id) return;
  void (async () => {
    try {
      const { getCampaignsStore } = await import("../../campaigns/store.js");
      getCampaignsStore().bumpStat(input.campaignContext!.campaign!.id, "emailsSent", 1);
    } catch {
      // Telemetry only — never break a send because the counter failed.
    }
  })();
}
