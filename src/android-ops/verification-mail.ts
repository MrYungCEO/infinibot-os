/**
 * Reading a verification code out of the operator's OWN mailbox.
 *
 * This is the one part of "human verification" the system's design does permit:
 * the recovery domain is a domain the operator controls, catch-all forwards it
 * to their Gmail, and the account being verified is theirs. Reading a code they
 * were sent is not bypassing a check — it is completing one with the mailbox it
 * was addressed to.
 *
 * What stays escalated is everything this cannot answer: a CAPTCHA, a 2FA
 * prompt, a suspicious-login challenge, an SMS to a number nobody owns. If no
 * code arrives for the alias, the caller halts exactly as before rather than
 * guessing.
 *
 * Credentials come from InfiniBot's existing Gmail connection (an OAuth refresh
 * token in infinibot.json). Nothing here stores or logs the token, and the code
 * it returns is typed onto the handset, never written to the run record.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface GmailCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  email: string;
}

export interface VerificationCode {
  code: string;
  subject: string;
  from: string;
  receivedAt: number;
}

/** The Gmail account InfiniBot is already connected to, if any. */
export function loadGmailCredentials(stateDir?: string): GmailCredentials | null {
  const path = join(
    stateDir ?? process.env.INFINIBOT_STATE_DIR ?? join(homedir(), ".infinibot"),
    "infinibot.json",
  );
  try {
    const cfg = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const integrations = cfg.integrations as { gmail?: { accounts?: unknown[] } } | undefined;
    const account = integrations?.gmail?.accounts?.[0] as Record<string, string> | undefined;
    if (!account?.clientId || !account?.clientSecret || !account?.refreshToken) return null;
    return {
      clientId: account.clientId,
      clientSecret: account.clientSecret,
      refreshToken: account.refreshToken,
      email: account.email ?? "",
    };
  } catch {
    return null;
  }
}

async function accessToken(
  creds: GmailCredentials,
  doFetch: typeof fetch = fetch,
): Promise<string> {
  const res = await doFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const json = (await res.json()) as {
    access_token?: string;
    error_description?: string;
    error?: string;
  };
  if (!json.access_token) {
    throw new Error(
      `Gmail token refresh failed: ${json.error_description ?? json.error ?? "no token returned"}`,
    );
  }
  return json.access_token;
}

/** Decode a Gmail API body part, which is base64url with no padding. */
function decodePart(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function collectText(payload: unknown): string {
  const part = payload as
    | { mimeType?: string; body?: { data?: string }; parts?: unknown[] }
    | undefined;
  if (!part) return "";
  let text = "";
  if (part.body?.data) text += decodePart(part.body.data) + "\n";
  for (const child of part.parts ?? []) text += collectText(child);
  return text;
}

/**
 * The code, pulled from the subject first.
 *
 * Platforms put it there precisely so it is readable from a notification, and a
 * body is full of other numbers — years, ports, unsubscribe ids — that a naive
 * scan happily mistakes for a code.
 */
export function extractCode(subject: string, body: string): string | null {
  const fromSubject = subject.match(/\b(\d{6,8})\b/);
  if (fromSubject) return fromSubject[1];
  const labelled = body.match(/(?:code|kod|c[oó]digo)\D{0,20}\b(\d{6,8})\b/i);
  if (labelled) return labelled[1];
  const standalone = body.match(/^\s*(\d{6})\s*$/m);
  return standalone ? standalone[1] : null;
}

/**
 * Newest verification code addressed to `alias`, within `withinMs`.
 *
 * Recency is the guard against replaying an old code: a stale one is worse than
 * none, because it looks like success and fails on the handset.
 */
export async function findVerificationCode(
  alias: string,
  opts: { withinMs?: number; creds?: GmailCredentials | null; fetchImpl?: typeof fetch } = {},
): Promise<VerificationCode | null> {
  /* `?? ` would treat an explicit null as "not supplied" and quietly load the
     machine's real credentials — including inside a test that meant to assert
     the no-connection path */
  const creds = opts.creds !== undefined ? opts.creds : loadGmailCredentials();
  if (!creds) throw new Error("No Gmail connection is configured in InfiniBot.");
  const doFetch = opts.fetchImpl ?? fetch;
  const withinMs = opts.withinMs ?? 15 * 60 * 1000;
  const token = await accessToken(creds, doFetch);
  const auth = { authorization: `Bearer ${token}` };

  /* deliveredto: catches catch-all forwarding, where To: may be rewritten */
  const query = `newer_than:1d (to:${alias} OR deliveredto:${alias} OR "${alias}")`;
  const listRes = await doFetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10&q=${encodeURIComponent(query)}`,
    { headers: auth },
  );
  const list = (await listRes.json()) as { messages?: Array<{ id: string }> };
  if (!list.messages?.length) return null;

  for (const summary of list.messages) {
    const msgRes = await doFetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${summary.id}?format=full`,
      { headers: auth },
    );
    const msg = (await msgRes.json()) as {
      internalDate?: string;
      payload?: { headers?: Array<{ name: string; value: string }> };
    };
    const receivedAt = Number(msg.internalDate ?? 0);
    if (receivedAt && Date.now() - receivedAt > withinMs) continue;
    const headers = msg.payload?.headers ?? [];
    const header = (name: string) =>
      headers.find((h) => h.name.toLowerCase() === name)?.value ?? "";
    const subject = header("subject");
    const body = collectText(msg.payload);
    const code = extractCode(subject, body);
    if (code) return { code, subject, from: header("from"), receivedAt };
  }
  return null;
}
