/**
 * Gateway RPCs for the unified email dispatcher.
 *
 * Single entrypoint the UI's "Send Email" composer (in Lead and Client
 * detail views) and any agent tool calls when it needs to deliver an
 * email. Provider selection lives in src/services/email/dispatcher.ts —
 * this file is a thin gateway shim.
 *
 * Methods:
 *   email.send         — send a transactional email; returns providerUsed
 *   email.providerInfo — surface which providers are configured so the UI
 *                        can render a sensible "From … via …" hint and
 *                        disable the composer when nothing is configured.
 */
import {
  isProviderConfigured,
  sendEmail,
  type EmailProvider,
} from "../../services/email/dispatcher.js";
import { getEmailAccountsStore } from "../../services/email/accounts-store.js";
import type { GatewayRequestHandlers } from "./types.js";

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asStringOrArray(v: unknown): string | string[] | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (Array.isArray(v)) {
    const out = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
    return out.length > 0 ? out : null;
  }
  return null;
}

export const emailHandlers: GatewayRequestHandlers = {
  "email.send": async ({ params, respond }) => {
    const to = asStringOrArray(params?.to);
    const subject = asString(params?.subject);
    if (!to) {
      respond(false, undefined, {
        code: "BAD_REQUEST",
        message: "to (string or string[]) required",
      });
      return;
    }
    if (!subject && !asString(params?.transactionalId)) {
      respond(false, undefined, {
        code: "BAD_REQUEST",
        message: "subject or transactionalId required",
      });
      return;
    }
    try {
      const result = await sendEmail({
        to,
        subject,
        body: asString(params?.body) || undefined,
        html: asString(params?.html) || undefined,
        from: asString(params?.from) || undefined,
        replyTo: asString(params?.replyTo) || undefined,
        transactionalId: asString(params?.transactionalId) || undefined,
        providerHint: (asString(params?.providerHint) as EmailProvider) || undefined,
        businessId: asString(params?.businessId) || undefined,
        accountId: asString(params?.accountId) || undefined,
        dataVariables:
          params?.dataVariables && typeof params.dataVariables === "object"
            ? (params.dataVariables as Record<string, string | number>)
            : undefined,
      });
      if (!result.ok) {
        respond(false, undefined, { code: result.code, message: result.message });
        return;
      }
      respond(true, {
        providerUsed: result.providerUsed,
        providerMessageId: result.providerMessageId,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "email.providerInfo": async ({ respond }) => {
    try {
      // Surface the managed-accounts surface alongside the env-driven
      // provider hints so the composer can render a sensible From-picker
      // and disable the send button when nothing is wired up.
      let accounts: Array<{
        id: string;
        kind: string;
        address: string;
        displayName: string;
        isPrimary: boolean;
        businessId: string | null;
        labels: string[];
        outboundEnabled: boolean;
        inboundEnabled: boolean;
      }> = [];
      try {
        accounts = getEmailAccountsStore()
          .list()
          .map((a) => ({
            id: a.id,
            kind: a.kind,
            address: a.address,
            displayName: a.displayName,
            isPrimary: a.isPrimary,
            businessId: a.businessId,
            labels: a.labels,
            outboundEnabled: a.outbound.enabled,
            inboundEnabled: a.inbound.enabled,
          }));
      } catch {
        /* store init failure shouldn't kill providerInfo */
      }
      respond(true, {
        resend: isProviderConfigured("resend"),
        loops: isProviderConfigured("loops"),
        smtp: isProviderConfigured("smtp"),
        defaultFrom: process.env.RESEND_FROM ?? process.env.EMAIL_FROM ?? null,
        accounts,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};
