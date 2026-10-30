/**
 * Business hub email — transports behind one interface:
 *   send({from,to,subject,html,text,headers,replyTo,messageId}) → {messageId}
 *
 * Kinds: smtp-account (an Email Accounts smtp-imap account), smtp-custom and
 * ses-smtp (host/user/pass kept encrypted in hub_meta), resend and postmark
 * (BYOK HTTP APIs), gmail (the connected Gmail OAuth account; plain text only
 * because the Gmail send path builds a text/plain message without custom
 * headers).
 */

import { isIP } from "node:net";
import { isFleetTenantMachineEnv } from "../../saas/fleet-config-guard.js";
import { isPrivateAddress } from "../leadgen/http.js";
import { getEmailAccountsStore } from "../../services/email/accounts-store.js";

export type SenderKind =
  | "smtp-account"
  | "smtp-custom"
  | "ses-smtp"
  | "resend"
  | "postmark"
  | "gmail";

export const SENDER_KINDS: readonly SenderKind[] = [
  "smtp-account",
  "smtp-custom",
  "ses-smtp",
  "resend",
  "postmark",
  "gmail",
];

/** A sender with secrets decrypted — internal only, never returned over RPC. */
export type SenderConfig = {
  id: string;
  kind: SenderKind;
  label: string;
  fromName?: string | null;
  fromEmail?: string | null;
  replyTo?: string | null;
  /** smtp-account: Email Accounts id; gmail: Gmail account id (optional → default). */
  accountId?: string | null;
  host?: string | null;
  port?: number | null;
  secure?: boolean | null;
  user?: string | null;
  pass?: string | null;
  /** ses-smtp: AWS region (email-smtp.<region>.amazonaws.com). */
  region?: string | null;
  /** resend / postmark API key or server token. */
  apiKey?: string | null;
  /** postmark message stream (default "outbound"; use "broadcast" for campaigns). */
  messageStream?: string | null;
  /** resend: svix signing secret (whsec_…) used to verify webhooks. */
  webhookSigningSecret?: string | null;
};

export type OutgoingEmail = {
  from: { name?: string | null; address: string };
  to: string;
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
  replyTo?: string | null;
  /** RFC 5322 Message-ID ("<id@domain>") — honoured by SMTP transports. */
  messageId?: string;
};

export type SendResult = { messageId: string };
export type VerifyResult = { ok: boolean; error?: string; latencyMs?: number };

export interface EmailTransport {
  readonly kind: SenderKind;
  /** False for transports that cannot carry HTML / custom headers (gmail). */
  readonly supportsHtml: boolean;
  send(msg: OutgoingEmail): Promise<SendResult>;
  verify(): Promise<VerifyResult>;
}

type FetchFn = typeof fetch;

function maskSecrets(err: unknown, ...secrets: Array<string | null | undefined>): string {
  let s = err instanceof Error ? err.message : String(err);
  for (const secret of secrets) if (secret && secret.length > 2) s = s.split(secret).join("***");
  return s.slice(0, 500);
}

export function formatFrom(from: OutgoingEmail["from"]): string {
  const name = from.name?.replace(/["\r\n<>]/g, "").trim();
  return name ? `"${name}" <${from.address}>` : from.address;
}

// ── SMTP (nodemailer) ────────────────────────────────────────────────────────

type SmtpOpts = {
  host: string;
  port: number;
  secure: boolean;
  user?: string | null;
  pass?: string | null;
};

function smtpTransport(kind: SenderKind, resolve: () => SmtpOpts): EmailTransport {
  const build = async () => {
    const o = resolve();
    const nodemailer = await import("nodemailer");
    return {
      o,
      t: nodemailer.createTransport({
        host: o.host,
        port: o.port,
        secure: o.secure,
        auth: o.user ? { user: o.user, pass: o.pass ?? "" } : undefined,
        connectionTimeout: 15_000,
        greetingTimeout: 10_000,
        socketTimeout: 30_000,
      }),
    };
  };
  return {
    kind,
    supportsHtml: true,
    async send(msg) {
      const { o, t } = await build();
      try {
        const info = await t.sendMail({
          from: { name: msg.from.name ?? "", address: msg.from.address },
          to: msg.to,
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
          replyTo: msg.replyTo ?? undefined,
          headers: msg.headers,
          messageId: msg.messageId,
        });
        return { messageId: String(info.messageId ?? msg.messageId ?? "") };
      } catch (err) {
        throw new Error(maskSecrets(err, o.pass));
      } finally {
        t.close();
      }
    },
    async verify() {
      const start = Date.now();
      let pass: string | null | undefined;
      try {
        const { o, t } = await build();
        pass = o.pass;
        await t.verify();
        t.close();
        return { ok: true, latencyMs: Date.now() - start };
      } catch (err) {
        return { ok: false, error: maskSecrets(err, pass) };
      }
    },
  };
}

/**
 * InfiniBot Cloud: a tenant Machine sits on the platform's private network,
 * so a tenant's SMTP sender must name a public mail host (BYOK provider),
 * never localhost, a *.internal name or a private address.
 */
export function assertCloudSmtpHost(host: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!isFleetTenantMachineEnv(env)) return;
  const h = host.toLowerCase().replace(/\.$/, "");
  if (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".internal") ||
    h.endsWith(".flycast") ||
    (isIP(h) !== 0 && isPrivateAddress(h)) ||
    !h.includes(".")
  )
    throw new Error("SMTP host must be a public mail server on InfiniBot Cloud");
}

function smtpFromSender(s: SenderConfig): SmtpOpts {
  const host =
    s.kind === "ses-smtp"
      ? `email-smtp.${(s.region ?? "").trim() || "us-east-1"}.amazonaws.com`
      : (s.host ?? "").trim();
  if (!host) throw new Error("SMTP host missing");
  if (!/^[a-z0-9.-]+$/i.test(host)) throw new Error("invalid SMTP host");
  assertCloudSmtpHost(host);
  const port = s.port ?? 587;
  return { host, port, secure: s.secure ?? port === 465, user: s.user, pass: s.pass };
}

function smtpFromAccount(accountId: string | null | undefined): SmtpOpts {
  if (!accountId) throw new Error("accountId required for an smtp-account sender");
  const bundle = getEmailAccountsStore().getDecryptedOutbound(accountId);
  if (!bundle) throw new Error(`email account not found: ${accountId}`);
  const { account, outbound } = bundle;
  if (account.kind !== "smtp-imap")
    throw new Error(`email account ${accountId} is ${account.kind}, not smtp-imap`);
  if (!account.outbound.enabled) throw new Error(`email account ${accountId} outbound is disabled`);
  if (!outbound.smtpHost || !outbound.smtpUser || !outbound.smtpPassword)
    throw new Error(`email account ${accountId} SMTP config incomplete`);
  const port = outbound.smtpPort ?? 587;
  return {
    host: outbound.smtpHost,
    port,
    secure: outbound.smtpSecure ?? port === 465,
    user: outbound.smtpUser,
    pass: outbound.smtpPassword,
  };
}

/** Default From address of an smtp-account sender (the account's address). */
export function accountFromAddress(accountId: string): string | null {
  try {
    const a = getEmailAccountsStore().get(accountId);
    return a ? (a.outbound.config.fromAddress ?? a.address) : null;
  } catch {
    return null;
  }
}

// ── Resend ───────────────────────────────────────────────────────────────────

function resendTransport(s: SenderConfig, fetchFn: FetchFn): EmailTransport {
  const key = () => {
    if (!s.apiKey) throw new Error("Resend API key missing");
    return s.apiKey;
  };
  return {
    kind: "resend",
    supportsHtml: true,
    async send(msg) {
      const body: Record<string, unknown> = {
        from: formatFrom(msg.from),
        to: [msg.to],
        subject: msg.subject,
      };
      if (msg.html) body.html = msg.html;
      if (msg.text) body.text = msg.text;
      if (msg.replyTo) body.reply_to = msg.replyTo;
      if (msg.headers && Object.keys(msg.headers).length) body.headers = msg.headers;
      const res = await fetchFn("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      const json = (await res.json().catch(() => ({}))) as {
        id?: string;
        message?: string;
        name?: string;
      };
      if (!res.ok || !json.id)
        throw new Error(`Resend ${res.status}: ${json.message ?? json.name ?? "rejected"}`);
      return { messageId: json.id };
    },
    async verify() {
      const start = Date.now();
      try {
        const res = await fetchFn("https://api.resend.com/domains", {
          headers: { Authorization: `Bearer ${key()}` },
          signal: AbortSignal.timeout(15_000),
        });
        // A send-only key gets 401 "restricted_api_key" on /domains, which still proves it is valid.
        const json = (await res.json().catch(() => ({}))) as { name?: string; message?: string };
        if (res.ok || json.name === "restricted_api_key")
          return { ok: true, latencyMs: Date.now() - start };
        return { ok: false, error: `Resend ${res.status}: ${json.message ?? "invalid key"}` };
      } catch (err) {
        return { ok: false, error: maskSecrets(err, s.apiKey) };
      }
    },
  };
}

// ── Postmark ─────────────────────────────────────────────────────────────────

function postmarkTransport(s: SenderConfig, fetchFn: FetchFn): EmailTransport {
  const token = () => {
    if (!s.apiKey) throw new Error("Postmark server token missing");
    return s.apiKey;
  };
  const headers = () => ({
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Postmark-Server-Token": token(),
  });
  return {
    kind: "postmark",
    supportsHtml: true,
    async send(msg) {
      const body: Record<string, unknown> = {
        From: formatFrom(msg.from),
        To: msg.to,
        Subject: msg.subject,
        MessageStream: s.messageStream || "outbound",
        // The hub tracks opens/clicks itself; Postmark's tracking would double-count.
        TrackOpens: false,
        TrackLinks: "None",
      };
      if (msg.html) body.HtmlBody = msg.html;
      if (msg.text) body.TextBody = msg.text;
      if (msg.replyTo) body.ReplyTo = msg.replyTo;
      if (msg.headers)
        body.Headers = Object.entries(msg.headers).map(([Name, Value]) => ({ Name, Value }));
      const res = await fetchFn("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      const json = (await res.json().catch(() => ({}))) as {
        MessageID?: string;
        ErrorCode?: number;
        Message?: string;
      };
      if (!res.ok || (json.ErrorCode ?? 0) !== 0 || !json.MessageID)
        throw new Error(`Postmark ${res.status}: ${json.Message ?? "rejected"}`);
      return { messageId: json.MessageID };
    },
    async verify() {
      const start = Date.now();
      try {
        const res = await fetchFn("https://api.postmarkapp.com/server", {
          headers: headers(),
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) return { ok: true, latencyMs: Date.now() - start };
        const json = (await res.json().catch(() => ({}))) as { Message?: string };
        return { ok: false, error: `Postmark ${res.status}: ${json.Message ?? "invalid token"}` };
      } catch (err) {
        return { ok: false, error: maskSecrets(err, s.apiKey) };
      }
    },
  };
}

// ── Gmail (connected OAuth account) ──────────────────────────────────────────

function gmailTransport(s: SenderConfig): EmailTransport {
  return {
    kind: "gmail",
    supportsHtml: false,
    async send(msg) {
      const { handleGmailTool } = await import("../../agents/tools/gmail-tool.js");
      const raw = await handleGmailTool({
        action: "send",
        accountId: s.accountId ?? undefined,
        to: msg.to,
        subject: msg.subject,
        body: msg.text ?? "",
      });
      const json = JSON.parse(raw) as { success?: boolean; id?: string; error?: string };
      if (!json.success || !json.id) throw new Error(json.error ?? "Gmail send failed");
      return { messageId: json.id };
    },
    async verify() {
      try {
        const { isGmailConfigured, listGmailAccounts } =
          await import("../../agents/tools/gmail-tool.js");
        if (!isGmailConfigured()) return { ok: false, error: "Gmail is not connected" };
        if (s.accountId && !listGmailAccounts().some((a) => a.id === s.accountId))
          return { ok: false, error: `Gmail account not connected: ${s.accountId}` };
        return { ok: true };
      } catch (err) {
        return { ok: false, error: maskSecrets(err) };
      }
    },
  };
}

/** Build the transport for a (decrypted) sender. */
export function createTransport(s: SenderConfig, opts: { fetch?: FetchFn } = {}): EmailTransport {
  const fetchFn = opts.fetch ?? fetch;
  switch (s.kind) {
    case "smtp-account":
      return smtpTransport("smtp-account", () => smtpFromAccount(s.accountId));
    case "smtp-custom":
    case "ses-smtp":
      return smtpTransport(s.kind, () => smtpFromSender(s));
    case "resend":
      return resendTransport(s, fetchFn);
    case "postmark":
      return postmarkTransport(s, fetchFn);
    case "gmail":
      return gmailTransport(s);
    default:
      throw new Error(`unknown sender kind: ${String((s as { kind: unknown }).kind)}`);
  }
}
