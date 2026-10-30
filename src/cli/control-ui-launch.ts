/**
 * Shared Control UI launch helpers.
 *
 * Both `infinibot ui open` and the auto-open on `infinibot gateway`/`gateway
 * run` need to build the same kind of URL: the Control UI root carrying the
 * gateway credential in the URL *hash* so the page auto-authenticates. The
 * hash (not query-string) is intentional — the gateway HTTP server never sees
 * the fragment, so the credential stays out of access logs, proxy traces, and
 * Referer headers. The Control UI side of the contract lives in
 * `ui/src/ui/auth-hash.ts`.
 */
import { loadConfig } from "../config/config.js";

export type GatewayAuthSnapshot = {
  mode: "token" | "password";
  token?: string;
  password?: string;
};

/**
 * Resolve the gateway credential the Control UI needs, the same way the
 * runtime gateway does (config → env), so a token written in
 * `~/.infinibot/infinibot.json` *or* exported as `INFINIBOT_GATEWAY_TOKEN`
 * both work without any extra flag-juggling.
 */
export function resolveAuthForLaunch(
  env: NodeJS.ProcessEnv = process.env,
): GatewayAuthSnapshot {
  let cfgAuth: { mode?: "token" | "password"; token?: string; password?: string } = {};
  try {
    const cfg = loadConfig() as { gateway?: { auth?: typeof cfgAuth } };
    cfgAuth = cfg?.gateway?.auth ?? {};
  } catch {
    // Config may not exist yet on a brand-new install. Fall through to env.
  }
  const token = cfgAuth.token ?? env.INFINIBOT_GATEWAY_TOKEN ?? undefined;
  const password = cfgAuth.password ?? env.INFINIBOT_GATEWAY_PASSWORD ?? undefined;
  // Match resolveGatewayAuth in src/gateway/auth.ts: explicit mode wins,
  // otherwise password presence implies password mode.
  const mode: "token" | "password" = cfgAuth.mode ?? (password ? "password" : "token");
  return { mode, token, password };
}

/**
 * Collapse a wildcard bind host to loopback for a browsable URL. A server
 * bound to 0.0.0.0 / :: is listening on every interface (loopback included),
 * but those addresses aren't directly browsable — 127.0.0.1 is. A specific
 * host (e.g. a tailnet IP the gateway bound to) is returned unchanged so the
 * URL actually reaches the listener instead of dead-ending on localhost.
 */
export function browsableHost(bindHost: string): string {
  if (bindHost === "0.0.0.0" || bindHost === "::" || bindHost === "[::]") {
    return "127.0.0.1";
  }
  return bindHost;
}

/**
 * Pick the best host for a browser running on the *same machine* as the
 * gateway. Strongly prefers loopback: the Control UI only works in a secure
 * context (HTTPS or localhost), and a bare-IP HTTP origin (e.g. a tailnet IP)
 * is NOT secure, so the UI's gateway client refuses to connect there. When the
 * gateway is listening on loopback (it is, for any non-wildcard bind — see
 * resolveGatewayListenHosts), use 127.0.0.1. Falls back to the primary bind
 * host only if loopback genuinely isn't in the listen set.
 */
export function preferLocalUiHost(bindHosts: string[]): string {
  const hasLoopback = bindHosts.some(
    (h) => h === "127.0.0.1" || h === "::1" || h === "[::1]" || h === "localhost",
  );
  if (hasLoopback) return "127.0.0.1";
  // Wildcard binds cover loopback even when it isn't listed explicitly.
  if (bindHosts.some((h) => h === "0.0.0.0" || h === "::" || h === "[::]")) {
    return "127.0.0.1";
  }
  return browsableHost(bindHosts[0] ?? "127.0.0.1");
}

/**
 * Build the Control UI launch URL: `http://<host>:<port><basePath>/` plus an
 * optional `?onboarding=1` and a `#token=…`/`#password=…` hash carrying
 * whichever credential matches the gateway's resolved auth mode.
 */
export function buildControlUiLaunchUrl(opts: {
  host: string;
  port: number;
  basePath: string;
  auth: GatewayAuthSnapshot;
  onboarding?: boolean;
}): string {
  const { host, port, basePath, auth, onboarding } = opts;
  const root = `http://${host}:${port}${basePath || ""}/`;
  const search = onboarding ? "?onboarding=1" : "";

  const hashParts: string[] = [];
  if (auth.mode === "password" && auth.password) {
    hashParts.push(`password=${encodeURIComponent(auth.password)}`);
  } else if (auth.mode === "token" && auth.token) {
    hashParts.push(`token=${encodeURIComponent(auth.token)}`);
  }
  const hash = hashParts.length > 0 ? `#${hashParts.join("&")}` : "";

  return `${root}${search}${hash}`;
}

/** True when the snapshot carries a usable credential for its mode. */
export function hasLaunchCredential(auth: GatewayAuthSnapshot): boolean {
  return (
    (auth.mode === "token" && Boolean(auth.token)) ||
    (auth.mode === "password" && Boolean(auth.password))
  );
}
