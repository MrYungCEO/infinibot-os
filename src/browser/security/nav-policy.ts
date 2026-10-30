/**
 * Navigation policy — guards every browserNavigate call before Playwright
 * touches the URL.
 *
 * Two layers of defense, in order:
 *   1. URL scheme allowlist. `http`, `https` always; `file`, `data`,
 *      `javascript`, `chrome*`, `about*` blocked unless the profile policy
 *      explicitly opts in.
 *   2. SSRF check on http(s). Hostname must resolve to a public address
 *      (reuses src/infra/net/ssrf.ts). Private IPs (127.x, 10.x, 192.168,
 *      cloud metadata 169.254.169.254, etc.) are blocked unless the
 *      hostname is on the profile's explicit allow list.
 *
 * The policy is per-profile so an "infini" daily-driver gets the strict
 * defaults while a developer can keep a "localdev" profile that's
 * explicitly allowed to hit 127.0.0.1.
 */

import { assertPublicHostname } from "../../infra/net/ssrf.js";

export type UrlScheme =
  | "http"
  | "https"
  | "file"
  | "data"
  | "javascript"
  | "chrome"
  | "chrome-extension"
  | "about"
  | "blob"
  | "view-source"
  | "other";

export interface NavPolicy {
  /**
   * Allowed URL schemes. Default: ["http", "https"]. Add "file"/"data" only
   * if you trust the profile's automation contract.
   */
  allowedSchemes?: UrlScheme[];
  /**
   * Allow hostnames that would otherwise fail SSRF (e.g. "localhost",
   * "127.0.0.1", an internal hostname). Exact match, case-insensitive.
   */
  allowPrivateHosts?: string[];
  /**
   * Bypass the SSRF check entirely. Only set this for explicit
   * developer-loop profiles where everything is local. Default false.
   */
  allowPrivateNetworks?: boolean;
  /**
   * Block hostnames matching these glob patterns even if they're public.
   * Useful for denying known-dangerous domains (e.g. accounts.google.com
   * on a profile that should never authenticate).
   */
  denyHosts?: string[];
}

export const DEFAULT_NAV_POLICY: Readonly<NavPolicy> = Object.freeze({
  allowedSchemes: ["http", "https"] as UrlScheme[],
  allowPrivateHosts: [],
  allowPrivateNetworks: false,
  denyHosts: [],
});

export class NavigationBlockedError extends Error {
  readonly code = "NAV_BLOCKED" as const;
  constructor(
    message: string,
    readonly reason: "scheme" | "private_ip" | "denied_host" | "invalid_url",
    readonly url: string,
  ) {
    super(message);
    this.name = "NavigationBlockedError";
  }
}

function classifyScheme(scheme: string): UrlScheme {
  const s = scheme.toLowerCase();
  if (s === "http" || s === "https") return s;
  if (s === "file") return "file";
  if (s === "data") return "data";
  if (s === "javascript") return "javascript";
  if (s === "about") return "about";
  if (s === "blob") return "blob";
  if (s === "view-source") return "view-source";
  if (s === "chrome") return "chrome";
  if (s === "chrome-extension") return "chrome-extension";
  return "other";
}

function matchesGlob(host: string, pattern: string): boolean {
  // Minimal glob: "*" matches any sequence; case-insensitive exact-with-wildcards.
  if (!pattern) return false;
  if (pattern === host) return true;
  if (!pattern.includes("*")) {
    return host.toLowerCase() === pattern.toLowerCase();
  }
  const regex = new RegExp(
    "^" +
      pattern
        .toLowerCase()
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*") +
      "$",
  );
  return regex.test(host.toLowerCase());
}

/**
 * Enforce the policy for a single URL. Throws NavigationBlockedError if
 * the URL would be unsafe under the policy. Returns the parsed URL for
 * the caller to reuse.
 */
export async function assertNavigable(
  url: string,
  policy: NavPolicy = DEFAULT_NAV_POLICY,
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new NavigationBlockedError(`Invalid URL: ${url}`, "invalid_url", url);
  }

  const scheme = classifyScheme(parsed.protocol.replace(/:$/, ""));
  const allowed = policy.allowedSchemes ?? DEFAULT_NAV_POLICY.allowedSchemes!;
  if (!allowed.includes(scheme)) {
    throw new NavigationBlockedError(
      `URL scheme "${parsed.protocol}" is not permitted by the active navigation policy. ` +
        `Allowed: ${allowed.join(", ")}. ` +
        (scheme === "file" || scheme === "data" || scheme === "javascript"
          ? "Add this scheme to the profile's allowedSchemes if you intentionally want to navigate to it."
          : ""),
      "scheme",
      url,
    );
  }

  // Deny host patterns regardless of public/private.
  const hostname = parsed.hostname;
  if (hostname && policy.denyHosts?.length) {
    for (const pat of policy.denyHosts) {
      if (matchesGlob(hostname, pat)) {
        throw new NavigationBlockedError(
          `Host "${hostname}" is on the profile's denyHosts list (matched pattern "${pat}").`,
          "denied_host",
          url,
        );
      }
    }
  }

  // SSRF only matters for http(s); other schemes have no DNS to resolve.
  if (scheme === "http" || scheme === "https") {
    if (policy.allowPrivateNetworks) return parsed;

    if (hostname && policy.allowPrivateHosts?.length) {
      for (const allow of policy.allowPrivateHosts) {
        if (matchesGlob(hostname, allow)) return parsed;
      }
    }

    if (hostname) {
      try {
        await assertPublicHostname(hostname);
      } catch {
        throw new NavigationBlockedError(
          `Host "${hostname}" resolves to a private/internal network. ` +
            `Add it to the profile's allowPrivateHosts list to permit this navigation, ` +
            `or set allowPrivateNetworks=true on a developer-loop profile.`,
          "private_ip",
          url,
        );
      }
    }
  }

  return parsed;
}
