/**
 * Orchestrates one IMAP listener per enabled smtp-imap inbound account.
 *
 *   • `startInboundManager()` — call once on gateway startup; lazily
 *     spawns listeners and keeps a stop-handle map keyed on accountId.
 *   • `restartListenerFor(accountId)` — called after `email.accounts.update`
 *     so config edits take effect without a gateway bounce.
 *   • Stores incoming messages into the `email_messages` table (created
 *     lazily on first use) and de-dupes by `messageId`.
 *   • Emits an `email.inbox` event via the supplied broadcaster so UIs
 *     update in real time.
 *
 * This module is intentionally side-effect-light at import time — it
 * only does work when `startInboundManager` is called from the gateway
 * bootstrap, so the CLI / test paths that don't need inbound aren't
 * affected.
 */
import Database from "better-sqlite3";
import { join } from "node:path";

import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveConfigDir } from "../../utils.js";
import { getEmailAccountsStore } from "./accounts-store.js";
import type { EmailAccount } from "./accounts-types.js";
import {
  startImapListener,
  type ImapListenerHandle,
  type ParsedInboundMessage,
} from "./providers/imap.js";

const log = createSubsystemLogger("email-inbound");

type Broadcaster = (event: string, payload: unknown) => void;

const handles = new Map<string, ImapListenerHandle>();
let broadcaster: Broadcaster | null = null;
let messagesDb: Database.Database | null = null;
let started = false;

function getMessagesDb(): Database.Database {
  if (messagesDb) return messagesDb;
  const dir = process.env.INFINIBOT_STATE_DIR?.trim() ?? resolveConfigDir();
  const db = new Database(join(dir, "email-messages.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_messages (
      id TEXT PRIMARY KEY,
      accountId TEXT NOT NULL,
      messageId TEXT,
      threadId TEXT,
      mailbox TEXT,
      fromAddr TEXT,
      fromName TEXT,
      toAddrs TEXT,
      subject TEXT,
      text TEXT,
      html TEXT,
      headers TEXT,
      receivedAt INTEGER NOT NULL,
      sentAt INTEGER,
      uid INTEGER,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_email_messages_account ON email_messages(accountId);
    CREATE INDEX IF NOT EXISTS idx_email_messages_received ON email_messages(receivedAt);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_email_messages_msgid ON email_messages(messageId)
      WHERE messageId IS NOT NULL;
  `);
  messagesDb = db;
  return db;
}

function persistMessage(account: EmailAccount, msg: ParsedInboundMessage): boolean {
  const db = getMessagesDb();
  const id = `${account.id}:${msg.uid}`;
  try {
    db.prepare(
      `INSERT INTO email_messages
         (id, accountId, messageId, threadId, mailbox, fromAddr, fromName, toAddrs, subject, text, html, headers, receivedAt, sentAt, uid, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      account.id,
      msg.messageId,
      msg.threadId ?? null,
      msg.mailbox,
      msg.from,
      msg.fromName ?? null,
      JSON.stringify(msg.to),
      msg.subject,
      msg.text ?? null,
      msg.html ?? null,
      JSON.stringify(msg.headers),
      msg.receivedAt,
      msg.date,
      msg.uid,
      Date.now(),
    );
    return true;
  } catch (err) {
    // Dedupe collisions hit the UNIQUE on messageId — skip silently.
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("UNIQUE")) return false;
    log.warn("persistMessage failed", { accountId: account.id, err: message });
    return false;
  }
}

async function spawnListener(account: EmailAccount): Promise<void> {
  if (!account.inbound.enabled) return;
  if (account.kind !== "smtp-imap") return; // Gmail handled by existing pubsub
  const existing = handles.get(account.id);
  if (existing) {
    try {
      await existing.stop();
    } catch {
      /* ignore */
    }
    handles.delete(account.id);
  }
  const bundle = getEmailAccountsStore().getDecryptedInbound(account.id);
  if (!bundle) return;
  const { inbound } = bundle;
  if (!inbound.imapHost || !inbound.imapUser || !inbound.imapPassword) {
    log.warn("inbound config incomplete, skipping listener", { accountId: account.id });
    return;
  }
  try {
    const handle = await startImapListener(account, inbound, (msg) => {
      const stored = persistMessage(account, msg);
      if (stored && broadcaster) {
        broadcaster("email.inbox", {
          accountId: account.id,
          address: account.address,
          messageId: msg.messageId,
          subject: msg.subject,
          from: msg.from,
          fromName: msg.fromName,
          receivedAt: msg.receivedAt,
        });
      }
      getEmailAccountsStore().recordHealth(account.id, "inbound", {
        ok: true,
        lastCheckedAt: Date.now(),
      });
    });
    handles.set(account.id, handle);
    log.info("imap listener started", { accountId: account.id, address: account.address });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("imap listener spawn failed", { accountId: account.id, err: msg });
    getEmailAccountsStore().recordHealth(account.id, "inbound", {
      ok: false,
      lastError: msg,
      lastCheckedAt: Date.now(),
    });
  }
}

export async function startInboundManager(broadcast: Broadcaster | null = null): Promise<void> {
  if (started) return;
  started = true;
  broadcaster = broadcast;
  try {
    const accounts = getEmailAccountsStore().list({ kind: "smtp-imap" });
    for (const acct of accounts) {
      if (acct.inbound.enabled) await spawnListener(acct);
    }
  } catch (err) {
    log.warn("startInboundManager failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function restartListenerFor(accountId: string): Promise<void> {
  if (!started) return;
  const acct = getEmailAccountsStore().get(accountId);
  if (!acct) {
    const existing = handles.get(accountId);
    if (existing) {
      await existing.stop().catch(() => {});
      handles.delete(accountId);
    }
    return;
  }
  await spawnListener(acct);
}

export async function stopListenerFor(accountId: string): Promise<void> {
  const handle = handles.get(accountId);
  if (!handle) return;
  await handle.stop().catch(() => {});
  handles.delete(accountId);
}

export async function stopInboundManager(): Promise<void> {
  started = false;
  for (const [, h] of handles) {
    await h.stop().catch(() => {});
  }
  handles.clear();
}

export interface InboundMessageRow {
  id: string;
  accountId: string;
  messageId: string | null;
  threadId: string | null;
  mailbox: string | null;
  fromAddr: string | null;
  fromName: string | null;
  toAddrs: string[];
  subject: string | null;
  text: string | null;
  html: string | null;
  receivedAt: number;
  sentAt: number | null;
  uid: number | null;
}

export function listInboundMessages(opts: {
  accountId?: string;
  businessId?: string;
  limit?: number;
}): InboundMessageRow[] {
  const db = getMessagesDb();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  let accountIds: string[] | null = null;
  if (opts.businessId) {
    accountIds = getEmailAccountsStore()
      .list({ businessId: opts.businessId })
      .map((a) => a.id);
  }
  if (opts.accountId) {
    accountIds = [opts.accountId];
  }
  let rows: any[];
  if (accountIds && accountIds.length > 0) {
    const placeholders = accountIds.map(() => "?").join(",");
    rows = db
      .prepare(
        `SELECT * FROM email_messages WHERE accountId IN (${placeholders}) ORDER BY receivedAt DESC LIMIT ${limit}`,
      )
      .all(...accountIds);
  } else if (accountIds && accountIds.length === 0) {
    return [];
  } else {
    rows = db.prepare(`SELECT * FROM email_messages ORDER BY receivedAt DESC LIMIT ${limit}`).all();
  }
  return rows.map((r: any) => ({
    id: r.id,
    accountId: r.accountId,
    messageId: r.messageId,
    threadId: r.threadId,
    mailbox: r.mailbox,
    fromAddr: r.fromAddr,
    fromName: r.fromName,
    toAddrs: r.toAddrs ? JSON.parse(r.toAddrs) : [],
    subject: r.subject,
    text: r.text,
    html: r.html,
    receivedAt: r.receivedAt,
    sentAt: r.sentAt,
    uid: r.uid,
  }));
}
