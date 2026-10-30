/**
 * Drives the OAuth 2.0 Device Authorization Grant (RFC 8628) from the CLI
 * side: prints the user-code, attempts to open a browser, polls the Vault
 * until the user approves (or the device code expires / is denied), and
 * persists the resulting token bundle.
 */

import { spawn } from "node:child_process";
import process from "node:process";

import { DeviceDeniedError, TokenExpiredError } from "./errors.js";
import { saveAuth, type StoredAuth } from "./token-store.js";
import {
  DEFAULT_VAULT_SCOPES,
  pollToken,
  resolveVaultBaseUrl,
  startDevice,
  VaultError,
  type TokenBundle,
} from "./vault-client.js";

export type DeviceFlowStart = {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  deviceCode: string;
  /** seconds between polls */
  interval: number;
  /** ms epoch */
  expiresAt: number;
};

export type StartDeviceFlowOpts = {
  scopes?: readonly string[];
  deviceLabel?: string;
  baseUrl?: string;
  /** Test seam: skip the browser-open + stderr banner. */
  silent?: boolean;
  /** Test seam: override the browser-open helper. */
  openBrowser?: (url: string) => void;
};

export type PollOpts = {
  baseUrl?: string;
  /** Test seam: override the wall clock. */
  now?: () => number;
  /** Test seam: override the sleep helper (defaults to setTimeout). */
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_SLEEP = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function defaultOpenBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === "win32" ? "cmd" : platform === "darwin" ? "open" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", '""', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    // A missing opener emits an async 'error'; ignore it like a throw.
    child.on("error", () => {});
    child.unref();
  } catch {
    // Best-effort. Caller already prints the URL.
  }
}

export async function startDeviceFlow(opts: StartDeviceFlowOpts = {}): Promise<DeviceFlowStart> {
  const scopes = opts.scopes ?? DEFAULT_VAULT_SCOPES;
  const res = await startDevice(
    { scopes, device_label: opts.deviceLabel },
    { baseUrl: opts.baseUrl },
  );
  const expiresAt = Date.now() + res.expires_in * 1000;

  if (!opts.silent) {
    process.stderr.write(
      [
        "Sign in to InfiniBot",
        "────────────────────",
        `Open: ${res.verification_uri}`,
        `Code: ${res.user_code}`,
        "Waiting for approval (press Ctrl+C to abort)…",
        "",
      ].join("\n"),
    );
    const opener = opts.openBrowser ?? defaultOpenBrowser;
    try {
      opener(res.verification_uri_complete || res.verification_uri);
    } catch {
      // Best-effort.
    }
  }

  return {
    userCode: res.user_code,
    verificationUri: res.verification_uri,
    verificationUriComplete: res.verification_uri_complete,
    deviceCode: res.device_code,
    interval: res.interval,
    expiresAt,
  };
}

export async function pollUntilApproved(
  start: Pick<DeviceFlowStart, "deviceCode" | "interval" | "expiresAt">,
  opts: PollOpts = {},
): Promise<TokenBundle> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? DEFAULT_SLEEP;
  let interval = Math.max(1, start.interval);

  while (true) {
    if (now() >= start.expiresAt) {
      throw new TokenExpiredError();
    }
    try {
      const tokens = await pollToken({ device_code: start.deviceCode }, { baseUrl: opts.baseUrl });
      return tokens;
    } catch (err) {
      if (!(err instanceof VaultError)) throw err;
      switch (err.code) {
        case "authorization_pending":
          break;
        case "slow_down":
          interval += 5;
          break;
        case "expired_token":
          throw new TokenExpiredError();
        case "access_denied":
          throw new DeviceDeniedError();
        default:
          throw err;
      }
    }
    await sleep(interval * 1000);
  }
}

export function tokenBundleToStoredAuth(
  tokens: TokenBundle,
  vaultUrl: string,
  now = Date.now(),
): StoredAuth {
  const refreshLifetime = tokens.refresh_expires_in ?? Math.max(tokens.expires_in * 12, 86_400);
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: now + tokens.expires_in * 1000,
    refresh_expires_at: now + refreshLifetime * 1000,
    tenant_id: tokens.tenant_id,
    scopes: tokens.scopes,
    vault_url: vaultUrl,
    saved_at: now,
  };
}

export async function loginInteractive(opts: StartDeviceFlowOpts = {}): Promise<StoredAuth> {
  const baseUrl = resolveVaultBaseUrl(opts.baseUrl);
  const start = await startDeviceFlow({ ...opts, baseUrl });
  const tokens = await pollUntilApproved(start, { baseUrl });
  const stored = tokenBundleToStoredAuth(tokens, baseUrl);
  await saveAuth(stored);
  return stored;
}
