/**
 * Gateway-side public base URL for web-opener links (`<base>/m/<path>`).
 *
 * Wraps the pure resolver in ./links.ts with the live config and a cached
 * Tailscale MagicDNS host. The Tailscale probe is async (it shells out to
 * `tailscale status`), so it is primed once at gateway startup and on first
 * use; until it lands, links fall back to INFINIBOT_PUBLIC_URL /
 * federation.publicUrl or no web link at all.
 */

import { loadConfig, type InfinibotConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { linkPair, resolvePublicBaseUrl, type DeepLinkTarget, type LinkPair } from "./links.js";

const log = createSubsystemLogger("deep-links");

/** undefined = not probed yet; null = probed, no tailnet host. */
let tailnetHost: string | null | undefined;
let probing: Promise<void> | null = null;
let probedAt = 0;
/** A miss (tailscale not up yet at boot) is retried after this long. */
const MISS_RETRY_MS = 5 * 60_000;

function probeDue(): boolean {
  if (tailnetHost === undefined) return true;
  return tailnetHost === null && Date.now() - probedAt > MISS_RETRY_MS;
}

/** Resolve (once) the Tailscale host. Safe to call repeatedly. */
export function primePublicBase(): Promise<void> {
  if (probing) return probing;
  if (!probeDue()) return Promise.resolve();
  probing = (async () => {
    try {
      const { resolveTailnetDnsHint } = await import("../gateway/server-discovery.js");
      // Never shell out under tests; INFINIBOT_TAILNET_DNS still applies.
      const host = await resolveTailnetDnsHint({ enabled: !process.env.VITEST });
      tailnetHost = host?.trim() || null;
    } catch (err) {
      tailnetHost = null;
      log.debug?.("tailnet host probe failed", { error: String(err) });
    }
  })().finally(() => {
    probedAt = Date.now();
    probing = null;
  });
  return probing;
}

function currentCfg(cfg?: InfinibotConfig | null): InfinibotConfig | null {
  if (cfg !== undefined) return cfg;
  try {
    return loadConfig();
  } catch {
    return null;
  }
}

function gatewayPort(cfg: InfinibotConfig | null): number | undefined {
  const envRaw = process.env.INFINIBOT_GATEWAY_PORT?.trim();
  const parsed = envRaw ? Number.parseInt(envRaw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  const p = cfg?.gateway?.port;
  return typeof p === "number" && p > 0 ? p : undefined;
}

/** The public base URL right now (null when none is known). */
export function getPublicBaseUrl(cfg?: InfinibotConfig | null): string | null {
  if (probeDue()) void primePublicBase();
  const c = currentCfg(cfg);
  return resolvePublicBaseUrl(c, { tailnetHost: tailnetHost ?? null, port: gatewayPort(c) });
}

/** Deep link + web opener URL using the live config. */
export function gatewayLinkPair(
  targetOrLink: DeepLinkTarget | string,
  cfg?: InfinibotConfig | null,
): LinkPair {
  return linkPair(targetOrLink, null, { base: getPublicBaseUrl(cfg) });
}

/** Just the https web opener URL (null without a public base). */
export function gatewayWebUrl(
  targetOrLink: DeepLinkTarget | string,
  cfg?: InfinibotConfig | null,
): string | null {
  return gatewayLinkPair(targetOrLink, cfg).webUrl;
}

/** Tests: pin the tailnet host (null = none) or reset to "not probed". */
export function setTailnetHostForTests(host: string | null | undefined): void {
  tailnetHost = host;
  probing = null;
  probedAt = Date.now();
}
