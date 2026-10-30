/**
 * SMTP provider — nodemailer-backed outbound for `kind: "smtp-imap"`
 * accounts. The transport is rebuilt per-send (no pooling for v1) to
 * keep the implementation simple; if a tight outbound loop ever shows
 * up we can switch to a per-account pool keyed on `account.id`.
 *
 * Errors that include the password get masked before they go anywhere
 * near a log line — nodemailer's "Invalid login" error otherwise echoes
 * the AUTH PLAIN payload.
 */
import type { EmailAccount, EmailAccountOutboundConfig } from "../accounts-types.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";

const log = createSubsystemLogger("email-smtp");

export interface SmtpSendInput {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  from?: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

export interface SmtpSendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

function maskError(err: unknown, password: string | undefined): string {
  let raw = err instanceof Error ? err.message : String(err);
  if (password && password.length > 2) {
    // Naive but effective for nodemailer's echo-on-failure.
    raw = raw.split(password).join("***");
  }
  return raw;
}

async function loadNodemailer(): Promise<typeof import("nodemailer")> {
  return import("nodemailer");
}

export async function sendViaSmtp(
  account: EmailAccount,
  outbound: EmailAccountOutboundConfig,
  input: SmtpSendInput,
): Promise<SmtpSendResult> {
  const password = outbound.smtpPassword;
  try {
    if (!outbound.smtpHost) return { ok: false, error: "smtpHost missing" };
    if (!outbound.smtpUser) return { ok: false, error: "smtpUser missing" };
    if (!password) return { ok: false, error: "smtpPassword missing" };
    const nodemailer = await loadNodemailer();
    const port = outbound.smtpPort ?? 587;
    const secure = outbound.smtpSecure ?? port === 465;
    const transport = nodemailer.createTransport({
      host: outbound.smtpHost,
      port,
      secure,
      auth: { user: outbound.smtpUser, pass: password },
      // Conservative timeouts — fail fast rather than hang forever on a
      // bad host. Tunable later if real users complain about flaky links.
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });
    const from = input.from ?? outbound.fromAddress ?? account.address;
    const info = await transport.sendMail({
      from,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      replyTo: input.replyTo,
      headers: input.headers,
    });
    transport.close();
    log.info("smtp send ok", {
      accountId: account.id,
      to: input.to,
      messageId: info.messageId,
    });
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    const masked = maskError(err, password);
    log.warn("smtp send failed", { accountId: account.id, error: masked });
    return { ok: false, error: masked };
  }
}

/**
 * Outbound connection test — opens an SMTP socket, authenticates,
 * and disconnects without sending. Returns latency-in-ms on success
 * so the UI can render a "tested in NNms" badge.
 */
export async function testSmtpConnection(
  outbound: EmailAccountOutboundConfig,
): Promise<{ ok: boolean; error?: string; latencyMs?: number }> {
  if (!outbound.smtpHost) return { ok: false, error: "smtpHost missing" };
  if (!outbound.smtpUser) return { ok: false, error: "smtpUser missing" };
  if (!outbound.smtpPassword) return { ok: false, error: "smtpPassword missing" };
  const start = Date.now();
  try {
    const nodemailer = await loadNodemailer();
    const port = outbound.smtpPort ?? 587;
    const secure = outbound.smtpSecure ?? port === 465;
    const transport = nodemailer.createTransport({
      host: outbound.smtpHost,
      port,
      secure,
      auth: { user: outbound.smtpUser, pass: outbound.smtpPassword },
      connectionTimeout: 10_000,
      greetingTimeout: 8_000,
      socketTimeout: 15_000,
    });
    await transport.verify();
    transport.close();
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, error: maskError(err, outbound.smtpPassword) };
  }
}
