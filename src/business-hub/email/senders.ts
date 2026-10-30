/**
 * Business hub email — sender configurations (hub_meta `email.senders`).
 * Secrets (SMTP password, API keys, webhook signing secret) are encrypted
 * with the install key (services/email/secret-crypto) and never leave this
 * module unmasked: the RPC surface sees `••••last4` only.
 */

import { decryptSecret, encryptSecret } from "../../services/email/secret-crypto.js";
import { getMeta, setMeta, type HubDb } from "../db.js";
import { hubId, normalizeEmail, parseJson, str } from "../util.js";
import { getEmailRuntime, getWebhookSecret, HUB_HTTP_BASE, resolveBaseUrl } from "./config.js";
import {
  accountFromAddress,
  createTransport,
  SENDER_KINDS,
  type EmailTransport,
  type SenderConfig,
  type SenderKind,
  type VerifyResult,
} from "./transport.js";

type StoredSender = Omit<SenderConfig, "pass" | "apiKey" | "webhookSigningSecret"> & {
  passEnc?: string | null;
  passLast4?: string | null;
  apiKeyEnc?: string | null;
  apiKeyLast4?: string | null;
  signingEnc?: string | null;
  createdAt: number;
  updatedAt: number;
};

export type PublicSender = Omit<StoredSender, "passEnc" | "apiKeyEnc" | "signingEnc"> & {
  pass: string | null;
  apiKey: string | null;
  webhookSigningSecret: string | null;
  /** Where to point the provider's bounce/complaint webhook (resend/postmark/ses-smtp). */
  webhookUrl: string | null;
};

const SECRET_FIELDS = ["pass", "apiKey", "webhookSigningSecret"] as const;

function readAll(db: HubDb): StoredSender[] {
  return parseJson<StoredSender[]>(getMeta(db, "email.senders"), []);
}

function writeAll(db: HubDb, list: StoredSender[]): void {
  setMeta(db, "email.senders", JSON.stringify(list));
}

const mask = (last4: string | null | undefined, enc: string | null | undefined) =>
  enc ? `••••${last4 ?? ""}` : null;

function webhookProvider(kind: SenderKind): string | null {
  return kind === "resend"
    ? "resend"
    : kind === "postmark"
      ? "postmark"
      : kind === "ses-smtp"
        ? "ses"
        : null;
}

/** Webhook URL for a provider (contains the per-install secret — show to the owner only). */
export function webhookUrl(db: HubDb, provider: string, baseUrl?: string | null): string | null {
  const base = resolveBaseUrl(db, baseUrl);
  if (!base) return null;
  return `${base}${HUB_HTTP_BASE}/webhooks/email?provider=${provider}&s=${getWebhookSecret(db)}`;
}

function toPublic(db: HubDb, s: StoredSender): PublicSender {
  const { passEnc, apiKeyEnc, signingEnc, ...rest } = s;
  const provider = webhookProvider(s.kind);
  return {
    ...rest,
    pass: mask(s.passLast4, passEnc),
    apiKey: mask(s.apiKeyLast4, apiKeyEnc),
    webhookSigningSecret: signingEnc ? "••••" : null,
    webhookUrl: provider ? webhookUrl(db, provider) : null,
  };
}

export function listSenders(db: HubDb): PublicSender[] {
  return readAll(db).map((s) => toPublic(db, s));
}

function decrypt(s: StoredSender): SenderConfig {
  const { passEnc, apiKeyEnc, signingEnc, passLast4, apiKeyLast4, createdAt, updatedAt, ...rest } =
    s;
  void passLast4;
  void apiKeyLast4;
  void createdAt;
  void updatedAt;
  return {
    ...rest,
    pass: decryptSecret(passEnc),
    apiKey: decryptSecret(apiKeyEnc),
    webhookSigningSecret: decryptSecret(signingEnc),
  };
}

/** Decrypted sender (internal: transports + webhook verification). */
export function getSenderConfig(db: HubDb, id: string): SenderConfig | null {
  const s = readAll(db).find((x) => x.id === id);
  return s ? decrypt(s) : null;
}

export function sendersOfKind(db: HubDb, kind: SenderKind): SenderConfig[] {
  return readAll(db)
    .filter((s) => s.kind === kind)
    .map(decrypt);
}

const isMasked = (v: unknown) => typeof v === "string" && v.startsWith("••••");

export function saveSender(db: HubDb, input: Record<string, unknown>): PublicSender {
  const list = readAll(db);
  const id = str(input.id);
  const idx = id ? list.findIndex((s) => s.id === id) : -1;
  if (id && idx < 0) throw new Error(`sender not found: ${id}`);
  const cur = idx >= 0 ? list[idx] : null;
  const kind = (str(input.kind) ?? cur?.kind) as SenderKind | undefined;
  if (!kind || !SENDER_KINDS.includes(kind))
    throw new Error(`kind must be one of ${SENDER_KINDS.join(", ")}`);
  const now = Date.now();
  const next: StoredSender = {
    ...(cur ?? { id: hubId("snd"), createdAt: now }),
    kind,
    label: (str(input.label) ?? cur?.label ?? kind).slice(0, 120),
    updatedAt: now,
  } as StoredSender;
  const text = (k: keyof StoredSender, max = 300) => {
    if (input[k] === undefined) return;
    (next as Record<string, unknown>)[k] = str(input[k])?.slice(0, max) ?? null;
  };
  text("fromName", 120);
  text("accountId");
  text("host", 255);
  text("region", 40);
  text("messageStream", 60);
  for (const k of ["fromEmail", "replyTo"] as const) {
    if (input[k] === undefined) continue;
    const e = input[k] ? normalizeEmail(input[k]) : null;
    if (input[k] && !e) throw new Error(`${k} is not a valid email`);
    next[k] = e;
  }
  if (input.user !== undefined) next.user = str(input.user)?.slice(0, 300) ?? null;
  if (input.port !== undefined) {
    const p = Number(input.port);
    next.port = Number.isInteger(p) && p > 0 && p < 65536 ? p : null;
  }
  if (input.secure !== undefined) next.secure = input.secure === true;
  for (const f of SECRET_FIELDS) {
    const v = input[f];
    if (v === undefined || isMasked(v)) continue;
    const plain = typeof v === "string" ? v.trim() : "";
    const enc = plain ? encryptSecret(plain) : null;
    if (f === "pass") {
      next.passEnc = enc;
      next.passLast4 = plain ? plain.slice(-4) : null;
    } else if (f === "apiKey") {
      next.apiKeyEnc = enc;
      next.apiKeyLast4 = plain ? plain.slice(-4) : null;
    } else next.signingEnc = enc;
  }
  validateSender(decrypt(next));
  if (idx >= 0) list[idx] = next;
  else list.push(next);
  writeAll(db, list);
  return toPublic(db, next);
}

function validateSender(s: SenderConfig): void {
  switch (s.kind) {
    case "smtp-account":
      if (!s.accountId) throw new Error("accountId (an Email Accounts smtp-imap account) required");
      break;
    case "smtp-custom":
      if (!s.host) throw new Error("host required");
      break;
    case "ses-smtp":
      if (!s.region) throw new Error("region required (e.g. us-east-1)");
      if (!s.user || !s.pass) throw new Error("SES SMTP username and password required");
      break;
    case "resend":
    case "postmark":
      if (!s.apiKey) throw new Error(`${s.kind} API key required`);
      if (!s.fromEmail) throw new Error("fromEmail required");
      break;
    case "gmail":
      break;
  }
}

export function removeSender(db: HubDb, id: string): void {
  const used = db
    .prepare(
      "SELECT name FROM email_campaigns WHERE account_id = ? AND status IN ('active','paused') LIMIT 1",
    )
    .get(id) as { name: string } | undefined;
  if (used) throw new Error(`sender is used by running campaign "${used.name}"`);
  writeAll(
    db,
    readAll(db).filter((s) => s.id !== id),
  );
}

export type SenderRef = {
  senderId?: string | null;
  kind?: string | null;
  accountId?: string | null;
};

/**
 * Resolve a campaign / sendOne sender reference: a stored sender id, or an
 * ad-hoc smtp-account / gmail reference by account id.
 */
export function resolveSender(db: HubDb, ref: SenderRef): SenderConfig {
  if (ref.senderId) {
    const s = getSenderConfig(db, ref.senderId);
    if (!s) throw new Error(`sender not found: ${ref.senderId}`);
    return s;
  }
  const kind = ref.kind as SenderKind | undefined;
  if (kind === "smtp-account" && ref.accountId)
    return { id: `acct:${ref.accountId}`, kind, label: "Email account", accountId: ref.accountId };
  if (kind === "gmail")
    return {
      id: `gmail:${ref.accountId ?? "default"}`,
      kind,
      label: "Gmail",
      accountId: ref.accountId ?? null,
    };
  if (kind && SENDER_KINDS.includes(kind)) {
    const first = sendersOfKind(db, kind)[0];
    if (first) return first;
    throw new Error(`no ${kind} sender configured`);
  }
  throw new Error("sender required (senderId, or {kind:'smtp-account'|'gmail', accountId})");
}

/** From address for a sender: explicit → sender default → account address. */
export function senderFromAddress(s: SenderConfig): string | null {
  if (s.fromEmail) return s.fromEmail;
  if (s.kind === "smtp-account" && s.accountId) return accountFromAddress(s.accountId);
  if (s.kind === "smtp-custom" || s.kind === "ses-smtp") return normalizeEmail(s.user) ?? null;
  return null;
}

/** Transport for a sender, honouring the runtime override (tests / sandboxes). */
export function transportFor(s: SenderConfig): EmailTransport {
  const rt = getEmailRuntime();
  return rt.transportFactory ? rt.transportFactory(s) : createTransport(s, { fetch: rt.fetch });
}

/** Verify a sender's connection / credentials without sending anything. */
export async function verifySender(db: HubDb, ref: SenderRef): Promise<VerifyResult> {
  return transportFor(resolveSender(db, ref)).verify();
}
