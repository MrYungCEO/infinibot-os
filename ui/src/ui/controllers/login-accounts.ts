/**
 * Pre-auth probe: does this gateway have multi-user accounts?
 *
 * GET /api/users/login → { accountsExist: boolean } (public, boolean only).
 * A fresh single-user install answers false, so the login screen shows just
 * the gateway-password field. Any failure (older gateway → 405, offline,
 * auth gate) reads as "unknown" and keeps the user-account toggle available,
 * so an existing multi-user install is never locked into one mode.
 */

export type AccountsProbe = "unknown" | "none" | "exist";

let _result: AccountsProbe = "unknown";
let _probedFor: string | null = null;

function httpBaseFor(gatewayUrl: string): string {
  return (gatewayUrl || "").replace(/^ws/, "http").replace(/\/$/, "");
}

export function getAccountsProbe(): AccountsProbe {
  return _result;
}

/** Probe once per gateway URL; calls `onChange` when the answer arrives. */
export function probeUserAccounts(gatewayUrl: string, onChange: () => void): void {
  const key = gatewayUrl || "";
  if (_probedFor === key) return;
  _probedFor = key;
  _result = "unknown";
  const url = `${httpBaseFor(gatewayUrl)}/api/users/login`;
  void fetch(url, { method: "GET", credentials: "include" })
    .then(async (res) => {
      if (!res.ok) return;
      const body = (await res.json()) as { accountsExist?: unknown };
      if (typeof body?.accountsExist !== "boolean") return;
      _result = body.accountsExist ? "exist" : "none";
      onChange();
    })
    .catch(() => {
      /* keep "unknown" */
    });
}

/** Test hook. */
export function _resetAccountsProbe(): void {
  _result = "unknown";
  _probedFor = null;
}
