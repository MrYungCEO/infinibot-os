/**
 * `setup.*` RPCs behind the local quickstart wizard (ui/src/ui/views/local-setup.ts).
 *
 * Every write goes through the existing `quickstart.applyPatch` /
 * `quickstart.finalize` handlers, so the wizard produces exactly the config
 * the legacy wizard and `infinibot onboard` do. What's new here:
 *   - keys are accepted only after the provider authenticates them
 *     (src/saas/key-validation.ts, shared with the hosted quickstart);
 *   - channel tokens are checked the same way before they're saved;
 *   - satellite mode: read an invite, test it against the master with a real
 *     register, and write the `federation` block.
 */
import os from "node:os";

import { readConfigFileSnapshot } from "../config/io.js";
import { satelliteTokenFromConfig } from "../federation/security.js";
import { normalizeShare } from "../federation/share-policy.js";
import { quickstartHandlers } from "../gateway/server-methods/quickstart.js";
import type { GatewayRequestHandlers } from "../gateway/server-methods/types.js";
import { runKeyCheck, validateProviderKey } from "../saas/key-validation.js";
import { getConnector } from "../saas/onboarding-connect-catalog.js";
import { invokeOrThrow } from "./invoke.js";
import { buildProviderPatch, listSetupProviders, setupProviderIds } from "./providers.js";
import {
  buildSatelliteConfig,
  normalizeMasterUrl,
  parsePairingInvite,
  probeFirstReachable,
  type PairingInvite,
} from "./satellite.js";

const CLOUD_URL = "https://cloud.infinibotos.com/app/";

/** Channels the local wizard offers: token-pasted, checked with the platform before saving. */
const CHANNEL_IDS = ["telegram", "discord", "slack"] as const;
type ChannelId = (typeof CHANNEL_IDS)[number];

/** Config field each connector field is written to (src/config/types.<channel>.ts). */
const CHANNEL_FIELD: Record<ChannelId, Record<string, string>> = {
  telegram: { token: "botToken" },
  discord: { token: "token" },
  slack: { token: "botToken", appToken: "appToken" },
};

async function readConfig(): Promise<Record<string, unknown>> {
  const snap = await readConfigFileSnapshot();
  const parsed = snap.parsed;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

const applyPatch = (patch: Record<string, unknown>) =>
  invokeOrThrow(quickstartHandlers["quickstart.applyPatch"], { patch });

/**
 * Rewrite the whole `federation` block. applyPatch deep-merges (a stale
 * token would survive) and only deletes `null` keys that already exist, so
 * drop the block, then write the computed one.
 */
async function replaceFederation(
  next: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const config = await readConfig();
  const current = (config.federation as Record<string, unknown> | undefined) ?? {};
  const updated = next({ ...current });
  if (config.federation !== undefined) await applyPatch({ federation: null });
  await applyPatch({ federation: updated });
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function channelSummary(config: Record<string, unknown>) {
  const channels = (config.channels as Record<string, Record<string, unknown>> | undefined) ?? {};
  return CHANNEL_IDS.map((id) => {
    const spec = getConnector(id)!;
    const cfg = channels[id] ?? {};
    const fields = CHANNEL_FIELD[id];
    return {
      id,
      label: spec.label,
      blurb: spec.blurb,
      signupUrl: spec.signupUrl ?? null,
      fields: spec.fields.map((f) => ({ id: f.id, label: f.label, hint: f.hint })),
      configured:
        cfg.enabled !== false &&
        Object.values(fields).some((k) => typeof cfg[k] === "string" && cfg[k]),
    };
  });
}

function decode(raw: unknown): PairingInvite {
  return parsePairingInvite(str(raw));
}

export const setupHandlers: GatewayRequestHandlers = {
  /** Everything the wizard needs to draw its first frame (and resume after a reload). */
  "setup.status": async ({ respond }) => {
    try {
      const config = await readConfig();
      const qs = await invokeOrThrow<{
        steps?: Array<{ id: string; state?: string }>;
        gateway?: { port?: number | null };
      }>(quickstartHandlers["quickstart.status"], {});
      const fed = (config.federation as Record<string, unknown> | undefined) ?? {};
      const voiceStep = qs.steps?.find((s) => s.id === "voice");
      const primary = str(
        (config.agents as { defaults?: { model?: { primary?: unknown } } } | undefined)?.defaults
          ?.model?.primary ?? "",
      );
      respond(true, {
        installMode: fed.mode === "satellite" ? "satellite" : "standalone",
        providers: listSetupProviders(config),
        primaryModel: primary || null,
        channels: channelSummary(config),
        robovoice: { linked: voiceStep?.state === "complete" },
        satellite: {
          masterUrl: str(fed.masterUrl) || null,
          nodeName: str(fed.nodeName) || null,
          paired: fed.mode === "satellite" && Boolean(satelliteTokenFromConfig(fed.authToken)),
          share: normalizeShare(fed.share),
        },
        hostname: os.hostname(),
        platform: process.platform,
        gatewayPort: qs.gateway?.port ?? 18789,
        cloudUrl: CLOUD_URL,
        onboarded: Boolean((config.onboarding as { completed?: unknown } | undefined)?.completed),
      });
    } catch (err) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: String((err as Error).message ?? err),
      });
    }
  },

  /**
   * Verify a key with the provider (authenticated call: a bogus key never
   * passes), then write it. Local Ollama is checked by reaching its host.
   */
  "setup.provider.save": async ({ params, respond }) => {
    const provider = str(params.provider);
    if (!setupProviderIds().includes(provider)) {
      respond(true, { ok: false, error: `Unsupported provider: ${provider || "(none)"}` });
      return;
    }
    const config = await readConfig();
    const keepPrimary =
      Boolean(
        (config.agents as { defaults?: { model?: { primary?: unknown } } } | undefined)?.defaults
          ?.model?.primary,
      ) && params.makePrimary !== true;
    if (provider === "ollama") {
      const host = (str(params.endpoint).trim() || "http://localhost:11434").replace(/\/$/, "");
      let reachable = false;
      try {
        const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5000) });
        reachable = res.ok;
      } catch {
        reachable = false;
      }
      if (!reachable) {
        respond(true, {
          ok: false,
          error: `Can't reach Ollama at ${host}. Start it with \`ollama serve\` and try again.`,
        });
        return;
      }
      await applyPatch(buildProviderPatch({ provider, endpoint: host, keepPrimary }));
      respond(true, { ok: true, verified: true, maskedKey: host });
      return;
    }
    const apiKey = str(params.apiKey).trim();
    const check = await validateProviderKey(provider, apiKey);
    if (!check.ok) {
      respond(true, { ok: false, error: check.error ?? "The provider rejected this key." });
      return;
    }
    try {
      await applyPatch(buildProviderPatch({ provider, apiKey, keepPrimary }));
    } catch (err) {
      respond(true, {
        ok: false,
        error: `Key verified, but saving failed: ${String((err as Error).message ?? err)}`,
      });
      return;
    }
    const provider_ = listSetupProviders(await readConfig()).find((p) => p.id === provider);
    respond(true, {
      ok: true,
      verified: check.verified !== false,
      modelCount: check.modelCount,
      maskedKey: provider_?.maskedKey ?? null,
    });
  },

  "setup.provider.remove": async ({ params, respond }) => {
    const provider = str(params.provider);
    if (!setupProviderIds().includes(provider)) {
      respond(false, undefined, { code: "BAD_REQUEST", message: "Unknown provider" });
      return;
    }
    const config = await readConfig();
    const primary = str(
      (config.agents as { defaults?: { model?: { primary?: unknown } } } | undefined)?.defaults
        ?.model?.primary,
    );
    await applyPatch({
      models: { providers: { [provider]: null } },
      ...(primary.startsWith(`${provider}/`)
        ? { agents: { defaults: { model: { primary: null } } } }
        : {}),
    });
    respond(true, { ok: true });
  },

  /** Check a channel's token(s) with the platform, then enable the channel. */
  "setup.channel.save": async ({ params, respond }) => {
    const channel = str(params.channel) as ChannelId;
    if (!CHANNEL_IDS.includes(channel)) {
      respond(true, { ok: false, error: "Unsupported channel" });
      return;
    }
    const spec = getConnector(channel)!;
    const values = (
      params.values && typeof params.values === "object" ? params.values : {}
    ) as Record<string, unknown>;
    const patch: Record<string, unknown> = { enabled: true };
    let account: string | undefined;
    for (const field of spec.fields) {
      const value = str(values[field.id]).trim();
      if (!value) {
        respond(true, { ok: false, error: `${field.label} is required.` });
        return;
      }
      if (field.check) {
        // "Telegram rejected this key"; Slack has two tokens, so name the one that failed.
        const label = spec.fields.length > 1 ? `${spec.label} (${field.label})` : spec.label;
        const res = await runKeyCheck(label, field.check, value);
        if (!res.ok) {
          respond(true, { ok: false, error: res.error ?? `${spec.label} rejected this token.` });
          return;
        }
        account ??= res.account;
      }
      patch[CHANNEL_FIELD[channel][field.id]] = value;
    }
    await applyPatch({ channels: { [channel]: patch } });
    respond(true, { ok: true, account: account ?? null });
  },

  "setup.channel.remove": async ({ params, respond }) => {
    const channel = str(params.channel) as ChannelId;
    if (!CHANNEL_IDS.includes(channel)) {
      respond(false, undefined, { code: "BAD_REQUEST", message: "Unsupported channel" });
      return;
    }
    const cleared = Object.fromEntries(Object.values(CHANNEL_FIELD[channel]).map((k) => [k, null]));
    await applyPatch({ channels: { [channel]: { enabled: false, ...cleared } } });
    respond(true, { ok: true });
  },

  /** Read an invite without contacting anyone: where it points and what it grants. */
  "setup.satellite.decodeInvite": async ({ params, respond }) => {
    try {
      const inv = decode(params.invite);
      respond(true, {
        ok: true,
        format: inv.format,
        masterUrls: inv.masterUrls,
        hubName: inv.hubName,
        satelliteName: inv.satelliteName,
        expiresAt: inv.expiresAt,
        permission: (inv.token.permissions as { level?: string } | undefined)?.level ?? null,
      });
    } catch (err) {
      respond(true, { ok: false, error: String((err as Error).message ?? err) });
    }
  },

  /** Look for a master on the LAN (mDNS) and the tailnet. Best effort, a few seconds. */
  "setup.satellite.discover": async ({ respond }) => {
    const found: Array<{ name: string; url: string; source: "mdns" | "tailscale" }> = [];
    const [mdns, tail] = await Promise.allSettled([
      import("../federation/discovery.js").then((m) => m.discoverMaster(3500)),
      import("../federation/tailscale-discovery.js").then((m) =>
        m.scanForFederationMasters(18789, 2500),
      ),
    ]);
    if (mdns.status === "fulfilled" && mdns.value) {
      const m = mdns.value;
      try {
        found.push({
          name: m.nodeName || m.host,
          url: normalizeMasterUrl(m.wsUrl || `${m.host}:${m.port}`),
          source: "mdns",
        });
      } catch {
        /* unusable advertisement */
      }
    }
    if (tail.status === "fulfilled") {
      for (const c of tail.value) {
        try {
          const url = normalizeMasterUrl(c.wsUrl);
          if (!found.some((f) => f.url === url)) {
            found.push({
              name: (c.peer as { hostName?: string; dnsName?: string }).hostName ?? url,
              url,
              source: "tailscale",
            });
          }
        } catch {
          /* skip */
        }
      }
    }
    respond(true, { masters: found });
  },

  /**
   * Test the connection exactly as the satellite will make it: register with
   * the invite's token. With only an address (no invite), checks whether the
   * master is reachable and whether it admits uninvited nodes.
   */
  "setup.satellite.test": async ({ params, respond }) => {
    let urls: string[] = [];
    let token = null;
    try {
      if (str(params.invite).trim()) {
        const inv = decode(params.invite);
        token = inv.token;
        urls = inv.masterUrls;
      }
      if (str(params.masterUrl).trim()) {
        const typed = normalizeMasterUrl(str(params.masterUrl));
        urls = [typed, ...urls.filter((u) => u !== typed)];
      }
    } catch (err) {
      respond(true, {
        ok: false,
        code: "BAD_INVITE",
        error: String((err as Error).message ?? err),
        tried: [],
      });
      return;
    }
    if (urls.length === 0) {
      respond(true, {
        ok: false,
        code: "BAD_REQUEST",
        error: "Enter the master's address or paste an invite.",
        tried: [],
      });
      return;
    }
    const result = await probeFirstReachable(urls, token, {
      timeoutMs: 8000,
      nodeName: str(params.nodeName) || os.hostname(),
    });
    respond(true, result);
  },

  /** Write the satellite's federation block (mode, master, token, name, shares). */
  "setup.satellite.save": async ({ params, respond }) => {
    try {
      let token = null;
      let label: string | null = null;
      let masterUrl = str(params.masterUrl).trim();
      if (str(params.invite).trim()) {
        const inv = decode(params.invite);
        token = inv.token;
        label = inv.hubName;
        masterUrl ||= inv.masterUrls[0] ?? "";
      }
      if (!masterUrl) throw new Error("Enter the master's address.");
      const federation = buildSatelliteConfig({
        masterUrl,
        token,
        nodeName: str(params.nodeName) || os.hostname(),
        share: params.share,
        label,
      });
      await replaceFederation((current) => {
        // Keep unrelated keys (publicUrl, masters, …); nothing stale from an
        // earlier pairing (token, shares, label) survives a re-pair.
        const { authToken: _t, share: _s, label: _l, ...rest } = current;
        return { ...rest, ...federation };
      });
      respond(true, {
        ok: true,
        federation: {
          ...federation,
          authToken: federation.authToken
            ? { satelliteId: federation.authToken.satelliteId }
            : undefined,
        },
      });
    } catch (err) {
      respond(true, { ok: false, error: String((err as Error).message ?? err) });
    }
  },

  /** Back to standalone: drop the satellite block. */
  "setup.satellite.clear": async ({ respond }) => {
    await replaceFederation((current) => {
      const { masterUrl: _m, authToken: _t, share: _s, label: _l, ...rest } = current;
      return { ...rest, mode: "standalone" };
    });
    respond(true, { ok: true });
  },

  /**
   * Finish. Both modes run `quickstart.finalize` (gateway defaults, auth
   * secret, standard agents). A satellite then pulls the master's shared
   * config (model providers, MCP, voice) so it can run without its own keys.
   */
  "setup.finalize": async ({ params, respond }) => {
    try {
      await invokeOrThrow(quickstartHandlers["quickstart.finalize"], {});
      let mirrored: string[] | null = null;
      let mirrorError: string | null = null;
      if (params.mode === "satellite") {
        const config = await readConfig();
        const fed = (config.federation as Record<string, unknown> | undefined) ?? {};
        try {
          const res = await invokeOrThrow<{ applied?: string[] }>(
            quickstartHandlers["quickstart.federation.fetchMasterConfig"],
            {
              masterUrl: str(fed.masterUrl),
              nodeName: str(fed.nodeName),
              authToken: fed.authToken,
              timeoutMs: 15000,
            },
          );
          mirrored = Array.isArray(res?.applied) ? res.applied : [];
        } catch (err) {
          mirrorError = String((err as Error).message ?? err);
        }
      }
      const config = await readConfig();
      const gw = (config.gateway as { port?: unknown } | undefined) ?? {};
      respond(true, {
        ok: true,
        gatewayPort: typeof gw.port === "number" ? gw.port : 18789,
        mirrored,
        mirrorError,
      });
    } catch (err) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: String((err as Error).message ?? err),
      });
    }
  },
};

export const SETUP_METHODS: readonly string[] = Object.keys(setupHandlers);
