/**
 * Outreach Provider — interface + Mock + Resend implementations.
 *
 * Selection via env: OUTREACH_PROVIDER=resend|mock (default: mock).
 * Set RESEND_API_KEY to use the real Resend provider.
 *
 * Interface contract:
 *   send({ to, subject, body, threadId?, replyTo? }) → { messageId, threadId }
 *
 * TODO(closed-loop): DNS / domain setup required before production use.
 * See src/workflows/outreach/README.md for setup instructions.
 */

import { randomUUID } from "node:crypto";

// ── Interface ─────────────────────────────────────────────────────────────────

export interface SendParams {
  to: string;
  subject: string;
  /** Full HTML or plaintext body (HTML preferred for tracking pixel). */
  body: string;
  /** Resend / SMTP thread ID — set on follow-ups to keep thread. */
  threadId?: string;
  /** Reply-To header, e.g. for a shared reply inbox. */
  replyTo?: string;
  /** From display name. */
  fromName?: string;
  /** From email. Must be a verified domain for Resend. */
  fromEmail?: string;
}

export interface SendResult {
  messageId: string;
  threadId: string;
  provider: "mock" | "resend";
}

export interface OutreachProvider {
  readonly name: "mock" | "resend";
  send(params: SendParams): Promise<SendResult>;
}

// ── Mock Provider (dev/no-key default) ───────────────────────────────────────

export class MockProvider implements OutreachProvider {
  readonly name = "mock" as const;

  async send(params: SendParams): Promise<SendResult> {
    const messageId = `mock-${randomUUID()}`;
    const threadId = params.threadId ?? `thread-${randomUUID()}`;

    console.log(
      [
        `[outreach:mock] ── EMAIL SENT (mock) ──`,
        `  To:       ${params.to}`,
        `  Subject:  ${params.subject}`,
        `  ThreadId: ${threadId}`,
        `  MsgId:    ${messageId}`,
        `  Body:     ${params.body.slice(0, 120)}…`,
      ].join("\n"),
    );

    return { messageId, threadId, provider: "mock" };
  }
}

// ── Resend Provider ───────────────────────────────────────────────────────────

export class ResendProvider implements OutreachProvider {
  readonly name = "resend" as const;
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async send(params: SendParams): Promise<SendResult> {
    const fromEmail = params.fromEmail ?? process.env.OUTREACH_FROM_EMAIL ?? "outreach@example.com";
    const fromName = params.fromName ?? process.env.OUTREACH_FROM_NAME ?? "Outreach";
    const from = `${fromName} <${fromEmail}>`;

    const body: Record<string, unknown> = {
      from,
      to: [params.to],
      subject: params.subject,
      html: params.body,
    };

    if (params.replyTo) body["reply_to"] = params.replyTo;
    if (params.threadId) {
      // Resend supports reply threading via the `in_reply_to` header or a custom header.
      // We store the original Message-ID in the DB; here we set In-Reply-To.
      body["headers"] = { "In-Reply-To": params.threadId };
    }

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Resend API error ${res.status}: ${err}`);
    }

    const data = (await res.json()) as { id: string };
    const messageId = data.id;
    const threadId = params.threadId ?? messageId;

    console.log(`[outreach:resend] sent messageId=${messageId} to=${params.to}`);
    return { messageId, threadId, provider: "resend" };
  }
}

// ── Provider factory ──────────────────────────────────────────────────────────

let _provider: OutreachProvider | null = null;

/**
 * Returns the configured OutreachProvider singleton.
 * Selection order:
 *   1. OUTREACH_PROVIDER=resend + RESEND_API_KEY → ResendProvider
 *   2. OUTREACH_PROVIDER=mock (explicit) → MockProvider
 *   3. No env or missing key → MockProvider (with startup warning)
 */
export function getOutreachProvider(): OutreachProvider {
  if (_provider) return _provider;

  const selected = (process.env.OUTREACH_PROVIDER ?? "mock").toLowerCase();
  const resendKey = process.env.RESEND_API_KEY;

  if (selected === "resend") {
    if (!resendKey) {
      console.warn(
        "[outreach] OUTREACH_PROVIDER=resend but RESEND_API_KEY is not set — falling back to mock. " +
          "Set RESEND_API_KEY in your environment to enable real email sending.",
      );
      _provider = new MockProvider();
    } else {
      _provider = new ResendProvider(resendKey);
    }
  } else {
    if (selected !== "mock") {
      console.warn(
        `[outreach] Unknown OUTREACH_PROVIDER="${selected}" — falling back to mock. Valid values: mock, resend`,
      );
    }
    _provider = new MockProvider();
  }

  console.log(`[outreach] provider=${_provider.name}`);
  return _provider;
}

/** Reset singleton (used in tests). */
export function resetOutreachProvider(): void {
  _provider = null;
}
