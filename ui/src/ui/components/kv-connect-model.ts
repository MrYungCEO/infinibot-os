/**
 * "Connect KinglyVault" — the shapes of plugins.kv.* and what the panel shows
 * for them. Pure (no DOM), so it is unit-tested; <ib-kv-connect> renders it.
 */

export type KvCapabilities = { available: boolean; reason: string | null; checkedAt: string; webUrl: string };

export type KvAccount = {
  linked: boolean;
  email: string | null;
  state: "none" | "invalid" | "valid" | "grace" | "expired";
  lastRefreshAt: string | null;
  lastError: string | null;
  canRefresh: boolean;
  items: Array<{ pluginId: string; source: string; until: string | null; active: boolean }>;
  ownerGrant?: { active?: boolean; expiresAt?: string | null } | null;
};

export type KvConnect = {
  id: string;
  status: "pending" | "approved" | "denied" | "expired" | "error" | "cancelled";
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresAt: string;
  error: string | null;
  email: string | null;
  changed: string[];
  restart: unknown;
};

export type KvStatus = {
  capabilities: KvCapabilities;
  account: KvAccount;
  connect: KvConnect | null;
  /** Paired through KinglyVault Connect: unlocking needs no second sign-in. */
  relayPaired?: boolean;
};

export type KvView =
  /** Older gateway without plugins.kv.* — show nothing. */
  | { kind: "hidden" }
  | { kind: "loading" }
  | { kind: "linked"; email: string; detail: string; warn: string | null }
  | { kind: "waiting"; code: string; url: string; expiresAt: string }
  | { kind: "ready"; note: string | null }
  | { kind: "unavailable"; reason: string };

export function kvView(
  status: KvStatus | null | "unsupported",
  connect: KvConnect | null,
  opts: { now?: number } = {},
): KvView {
  if (status === "unsupported") return { kind: "hidden" };
  if (!status) return { kind: "loading" };
  const a = status.account;
  if (a.linked && a.state !== "none" && a.state !== "invalid") {
    const when = a.lastRefreshAt ? new Date(a.lastRefreshAt) : null;
    const owned = a.items.filter((i) => i.active);
    const all = owned.some((i) => i.pluginId === "*");
    const detail = all
      ? "Your plan includes every paid plugin."
      : owned.length
        ? `${owned.length} paid plugin${owned.length === 1 ? "" : "s"} unlocked.`
        : "No paid plugins on this account yet.";
    const warn =
      a.state === "grace"
        ? "Offline: using your saved purchases until KinglyVault can be reached."
        : a.state === "expired"
          ? "Your saved purchases are too old. Press Sync now, or reconnect."
          : a.lastError;
    return {
      kind: "linked",
      email: a.email ?? "your KinglyVault account",
      detail: `${detail}${when ? ` Last synced ${when.toLocaleString()}.` : ""}`,
      warn,
    };
  }
  const c = connect ?? status.connect;
  const now = opts.now ?? Date.now();
  if (c && c.status === "pending" && Date.parse(c.expiresAt) > now) {
    return { kind: "waiting", code: c.userCode, url: c.verificationUriComplete, expiresAt: c.expiresAt };
  }
  if (!status.capabilities.available) {
    return { kind: "unavailable", reason: status.capabilities.reason ?? "Not available yet." };
  }
  const note =
    c && (c.status === "denied" || c.status === "expired" || c.status === "error") ? c.error : null;
  return { kind: "ready", note };
}

/** "Method not found" from an older gateway (no plugins.kv.*). */
export function isUnknownMethod(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /unknown method|method not found|not supported/i.test(msg);
}

/** Accepts a bare token, or a whole `…#kv=` / `token=` link pasted by mistake. */
export function tokenFromPaste(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const direct = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
  if (direct.test(t)) return t;
  const inLink = /(?:token=)([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/.exec(t);
  return inLink ? inLink[1] : null;
}
