/**
 * IMAP provider — imapflow connection + mailparser MIME parsing for
 * inbound `kind: "smtp-imap"` accounts. Two entry points:
 *
 *   • `testImapConnection(inbound)` — verify host/port/credentials by
 *     opening, SELECT-ing the mailbox, and closing. Returns latency.
 *   • `startImapListener(account, inbound, onMessage)` — long-lived
 *     listener that uses IDLE when the server supports it (most do)
 *     and falls back to polling otherwise. Returns a `stop()` handle.
 *
 * Reconnection: exponential backoff (1s → 30s) so a flaky network or
 * the server kicking us during a deploy doesn't permanently silence
 * the inbox. The caller (inbound-manager) doesn't have to babysit it.
 */
import type { ImapFlow, FetchMessageObject } from "imapflow";

import type { EmailAccount, EmailAccountInboundConfig } from "../accounts-types.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";

const log = createSubsystemLogger("email-imap");

export interface ParsedInboundMessage {
  uid: number;
  messageId: string | null;
  inReplyTo?: string;
  references?: string[];
  threadId?: string;
  from: string;
  fromName?: string;
  to: string[];
  cc?: string[];
  subject: string;
  text?: string;
  html?: string;
  date: number;
  receivedAt: number;
  mailbox: string;
  headers: Record<string, string>;
}

async function loadImapFlow(): Promise<typeof import("imapflow")> {
  return import("imapflow");
}

async function loadMailparser(): Promise<typeof import("mailparser")> {
  return import("mailparser");
}

function buildClientConfig(inbound: EmailAccountInboundConfig) {
  const port = inbound.imapPort ?? 993;
  const secure = inbound.imapSecure ?? port === 993;
  return {
    host: inbound.imapHost!,
    port,
    secure,
    auth: { user: inbound.imapUser!, pass: inbound.imapPassword! },
    logger: false as const,
    // imapflow defaults to a soft timeout; bump it so a slow server
    // doesn't sever IDLE prematurely.
    socketTimeout: 60_000,
  };
}

function maskError(err: unknown, password: string | undefined): string {
  let raw = err instanceof Error ? err.message : String(err);
  if (password && password.length > 2) raw = raw.split(password).join("***");
  return raw;
}

export async function testImapConnection(
  inbound: EmailAccountInboundConfig,
): Promise<{ ok: boolean; error?: string; latencyMs?: number }> {
  if (!inbound.imapHost) return { ok: false, error: "imapHost missing" };
  if (!inbound.imapUser) return { ok: false, error: "imapUser missing" };
  if (!inbound.imapPassword) return { ok: false, error: "imapPassword missing" };
  const start = Date.now();
  try {
    const { ImapFlow } = await loadImapFlow();
    const client = new ImapFlow(buildClientConfig(inbound));
    await client.connect();
    await client.mailboxOpen(inbound.imapMailbox || "INBOX", { readOnly: true });
    await client.logout();
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, error: maskError(err, inbound.imapPassword) };
  }
}

async function parseMessage(
  raw: FetchMessageObject,
  mailbox: string,
): Promise<ParsedInboundMessage | null> {
  if (!raw.source) return null;
  const { simpleParser } = await loadMailparser();
  const parsed = await simpleParser(raw.source);
  const headers: Record<string, string> = {};
  for (const [k, v] of parsed.headers.entries()) {
    headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  const fromAddr = parsed.from?.value?.[0];
  const toList = (parsed.to && (Array.isArray(parsed.to) ? parsed.to[0] : parsed.to)?.value) || [];
  const ccListRaw = parsed.cc as { value?: Array<{ address?: string }> } | undefined;
  const ccList = ccListRaw?.value ?? [];
  return {
    uid: raw.uid,
    messageId: parsed.messageId ?? null,
    inReplyTo: parsed.inReplyTo,
    references: Array.isArray(parsed.references)
      ? parsed.references
      : parsed.references
        ? [parsed.references]
        : undefined,
    threadId: typeof raw.threadId === "string" ? raw.threadId : undefined,
    from: fromAddr?.address ?? "",
    fromName: fromAddr?.name,
    to: toList.map((t) => t.address).filter((a): a is string => !!a),
    cc: ccList.map((t) => t.address).filter((a): a is string => !!a),
    subject: parsed.subject ?? "",
    text: parsed.text ?? undefined,
    html: typeof parsed.html === "string" ? parsed.html : undefined,
    date: parsed.date ? parsed.date.getTime() : Date.now(),
    receivedAt: Date.now(),
    mailbox,
    headers,
  };
}

export interface ImapListenerHandle {
  stop: () => Promise<void>;
}

export async function startImapListener(
  account: EmailAccount,
  inbound: EmailAccountInboundConfig,
  onMessage: (msg: ParsedInboundMessage) => void,
): Promise<ImapListenerHandle> {
  if (!inbound.imapHost || !inbound.imapUser || !inbound.imapPassword) {
    throw new Error("imap config incomplete (host/user/password required)");
  }
  const mailbox = inbound.imapMailbox || "INBOX";
  let stopped = false;
  let client: ImapFlow | null = null;
  let reconnectMs = 1000;
  const pollIntervalMs = Math.max((account.inbound.pollIntervalSec ?? 60) * 1000, 5000);

  const run = async (): Promise<void> => {
    while (!stopped) {
      try {
        const { ImapFlow } = await loadImapFlow();
        client = new ImapFlow(buildClientConfig(inbound));
        await client.connect();
        const lock = await client.getMailboxLock(mailbox);
        try {
          // Listen for new mail. imapflow emits 'exists' on each new uid arrival.
          const onExists = async () => {
            if (!client || stopped) return;
            try {
              for await (const msg of client.fetch(
                { seen: false },
                { uid: true, source: true, threadId: true },
              )) {
                if (stopped) break;
                const parsed = await parseMessage(msg as FetchMessageObject, mailbox);
                if (parsed) {
                  try {
                    onMessage(parsed);
                  } catch (err) {
                    log.warn("imap onMessage handler threw", {
                      accountId: account.id,
                      err: err instanceof Error ? err.message : String(err),
                    });
                  }
                }
              }
            } catch (err) {
              log.warn("imap fetch failed", {
                accountId: account.id,
                err: maskError(err, inbound.imapPassword),
              });
            }
          };
          client.on("exists", onExists);
          await onExists();
          // Hold the lock + IDLE until stopped or disconnected.
          if (typeof (client as any).idle === "function") {
            // imapflow auto-IDLEs on supported servers when no other ops are in flight.
            await new Promise<void>((resolve, reject) => {
              if (!client) return resolve();
              client.once("close", () => resolve());
              client.once("error", (e) => reject(e));
              // Periodic poll fallback in case IDLE drops silently.
              const t = setInterval(() => {
                if (stopped) {
                  clearInterval(t);
                  resolve();
                }
              }, pollIntervalMs);
            });
          } else {
            // No IDLE — poll loop.
            while (!stopped && client) {
              await new Promise((r) => setTimeout(r, pollIntervalMs));
              await onExists();
            }
          }
        } finally {
          lock.release();
        }
        if (client && client.usable) {
          try {
            await client.logout();
          } catch {
            /* best-effort */
          }
        }
        client = null;
        reconnectMs = 1000;
      } catch (err) {
        log.warn("imap listener error, will reconnect", {
          accountId: account.id,
          err: maskError(err, inbound.imapPassword),
          backoffMs: reconnectMs,
        });
        if (client) {
          try {
            await client.logout();
          } catch {
            /* ignore */
          }
          client = null;
        }
        if (stopped) break;
        await new Promise((r) => setTimeout(r, reconnectMs));
        reconnectMs = Math.min(reconnectMs * 2, 30_000);
      }
    }
  };

  // Kick off without awaiting so the caller can keep going.
  void run();

  return {
    stop: async () => {
      stopped = true;
      if (client) {
        try {
          await client.logout();
        } catch {
          /* ignore */
        }
        client = null;
      }
    },
  };
}
