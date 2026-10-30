/**
 * KinglyVault → "Link my Cloud InfiniBot" (one account, zero pairing).
 *
 * KinglyVault opens this app with `?kvconnect=start&kvintent=<one-time intent>`.
 * Once the gateway answers, we start the KinglyVault link carrying that intent
 * (kvconnect.start) and hop this tab to kinglyvault.com/infinibot/link, like an
 * OAuth redirect. KV approves it for the member who clicked (the intent is
 * bound to their KV account) and sends them back here via `return`.
 *
 * Safe against forged links: an intent from someone else's KV account is not
 * auto-approved on KV, so the worst case is an ordinary approval page.
 * The intent survives a sign-in redirect in sessionStorage (10 min, one use).
 */
import type { GatewayBrowserClient } from "../gateway";
import type { KvConnectStatus } from "./kv-connect-approval";

const INTENT_RE = /^[A-Za-z0-9_-]{24,100}$/;
const STORE_KEY = "ib:kv-intent";
const TTL_MS = 10 * 60_000;

/** Reads (and removes from the address bar) a KV connect intent. Falls back to one saved before a sign-in redirect. */
export function takeKvIntentFromUrl(win: Pick<Window, "location" | "history" | "sessionStorage"> = window): string | null {
  const url = new URL(win.location.href);
  if (url.searchParams.get("kvconnect") === "start") {
    const intent = url.searchParams.get("kvintent") ?? "";
    url.searchParams.delete("kvconnect");
    url.searchParams.delete("kvintent");
    try {
      win.history.replaceState(win.history.state, "", url.pathname + (url.search ? url.search : "") + url.hash);
    } catch {
      /* best effort */
    }
    if (INTENT_RE.test(intent)) {
      try {
        win.sessionStorage.setItem(STORE_KEY, JSON.stringify({ intent, at: Date.now() }));
      } catch {
        /* private mode */
      }
      return intent;
    }
    return null;
  }
  try {
    const raw = win.sessionStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { intent?: string; at?: number };
    if (typeof v.intent === "string" && INTENT_RE.test(v.intent) && typeof v.at === "number" && Date.now() - v.at < TTL_MS) return v.intent;
    win.sessionStorage.removeItem(STORE_KEY);
  } catch {
    /* ignore */
  }
  return null;
}

export function clearKvIntent(storage: Pick<Storage, "removeItem"> = window.sessionStorage): void {
  try {
    storage.removeItem(STORE_KEY);
  } catch {
    /* ignore */
  }
}

/** kinglyvault.com/infinibot/link?code=… plus where to come back to. */
export function withReturn(verifyUrl: string, returnUrl: string): string {
  const u = new URL(verifyUrl);
  u.searchParams.set("return", returnUrl);
  return u.toString();
}

/**
 * Starts the intent-carrying link and returns the URL to send the browser to
 * (null when the gateway has no KinglyVault Connect or gave no URL).
 */
export async function startKvIntentLink(client: GatewayBrowserClient, intent: string, returnUrl: string): Promise<string | null> {
  if (typeof client.supports === "function" && !client.supports("kvconnect.start")) return null;
  const s = await client.request<KvConnectStatus>("kvconnect.start", { intent });
  const url = s.linking?.verifyUrl;
  return url ? withReturn(url, returnUrl) : null;
}
