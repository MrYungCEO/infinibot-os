/**
 * Shared types for the EmailAccount model. Lives in its own file so the
 * UI bundle (and any tests) can import the types without dragging in
 * the SQLite store.
 */

export type EmailProviderKind = "gmail" | "smtp-imap" | "mailgun" | "sendgrid" | "resend";

export interface EmailAccountOutboundConfig {
  smtpHost?: string;
  smtpPort?: number;
  /** true = implicit SSL (465); false = STARTTLS (587). */
  smtpSecure?: boolean;
  smtpUser?: string;
  /** Plaintext on input; the store always encrypts on write. */
  smtpPassword?: string;
  /** Gmail variant — references existing OAuth account in `hooks.gmail.account`. */
  gmailAccount?: string;
  /** Future API-based providers (Mailgun / SendGrid / Resend). */
  apiKey?: string;
  apiDomain?: string;
  /** Mail-from address. Defaults to `account.address`. */
  fromAddress?: string;
}

export interface EmailAccountInboundConfig {
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  imapUser?: string;
  imapPassword?: string;
  imapMailbox?: string;
  gmailWatchTopic?: string;
}

export interface EmailAccountHealthChannel {
  ok: boolean;
  lastCheckedAt: number;
  lastError?: string;
}

export interface EmailAccountHealth {
  outbound: EmailAccountHealthChannel;
  inbound: EmailAccountHealthChannel;
}

export interface EmailAccount {
  id: string;
  kind: EmailProviderKind;
  displayName: string;
  address: string;
  isPrimary: boolean;
  labels: string[];
  businessId: string | null;
  outbound: {
    enabled: boolean;
    config: EmailAccountOutboundConfig;
  };
  inbound: {
    enabled: boolean;
    config: EmailAccountInboundConfig;
    pollIntervalSec?: number;
  };
  health: EmailAccountHealth;
  createdAt: number;
  updatedAt: number;
}

export type EmailAccountInput = Omit<
  EmailAccount,
  "id" | "isPrimary" | "createdAt" | "updatedAt" | "health"
> & {
  /** Optional; when omitted falls to store logic (first per-business wins). */
  isPrimary?: boolean;
};

export type EmailAccountPatch = Partial<
  Omit<EmailAccount, "id" | "createdAt" | "updatedAt" | "health">
>;

export interface EmailAccountListFilter {
  businessId?: string | null;
  kind?: EmailProviderKind;
  /** When true, password/apiKey are decrypted into the returned objects. */
  includeSecrets?: boolean;
}

export interface EmailAccountTestResult {
  outbound?: { ok: boolean; error?: string; latencyMs?: number };
  inbound?: { ok: boolean; error?: string; latencyMs?: number };
}
