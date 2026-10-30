/**
 * Gateway Methods — Mobile (Expo Go + EAS Build).
 *
 * Drives the user's `infinibot` Expo project from the dashboard:
 *   • `mobile.expo.start` / `.stop` / `.status` — manage Metro
 *   • `mobile.eas.whoami`         — confirm `eas login` is set
 *   • `mobile.eas.build`          — kick a personal IPA build
 *   • `mobile.eas.builds`         — poll recent builds for progress
 *   • `mobile.eas.cancel`         — abort an in-flight build
 *   • `mobile.config.get` / `.set` — store the project dir + bind URL
 *
 * The UI's `/mobile` page wires these into a two-tab flow: "Try in Expo
 * Go" (QR) and "Build my own IPA" (EAS walkthrough).
 */

import {
  detectLanAddress,
  detectTailscaleAddress,
  detectTailscaleHost,
  getExpoState,
  resolveDefaultProjectDir,
  startExpo,
  stopExpo,
  type ExpoMode,
} from "../../mobile/expo-runner.js";
import {
  cancelEasBuild,
  listEasBuilds,
  listEasDevices,
  startEasBuild,
  whoami as easWhoami,
  type EasBuildPlatform,
  type EasBuildProfile,
} from "../../mobile/eas-runner.js";
import { resolveStateDir } from "../../config/paths.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GatewayRequestHandlers } from "./types.js";

// ── Persisted config ────────────────────────────────────────

interface MobileConfig {
  /** Path to the Expo project directory. */
  projectDir?: string;
  /** Default Expo start mode — tunnel works across networks. */
  defaultMode?: ExpoMode;
  /** Override the gateway URL the Expo app should connect to. */
  gatewayUrlOverride?: string;
  /** Apple Developer Team ID to use when listing registered EAS devices. */
  appleTeamId?: string;
  /** iPhone/iPad UDID selected for iOS internal IPA installs. */
  iosDeviceUdid?: string;
  /**
   * EXPO_OFFLINE policy for `expo start`: "auto" (default) = online when
   * expo-cli is logged in (Expo Go needs the signed manifest), offline when
   * it is not; true/false force it. Tunnel mode is always online.
   */
  expoOffline?: "auto" | boolean;
}

function configPath(): string {
  return join(resolveStateDir(), "mobile.json");
}

function readConfig(): MobileConfig {
  const p = configPath();
  let cfg: MobileConfig = {};
  if (existsSync(p)) {
    try {
      cfg = JSON.parse(readFileSync(p, "utf-8")) as MobileConfig;
    } catch {
      /* fall through */
    }
  }
  // Durable fallback: when projectDir isn't configured, look for the
  // canonical sibling expo project so a fresh clone (or wiped state)
  // still finds it without the user editing JSON. The bundled `mobile/`
  // subdir takes precedence so contributors who pull the in-repo copy
  // see it work out of the box.
  if (!cfg.projectDir) {
    cfg.projectDir = discoverExpoProjectDir() ?? cfg.projectDir;
  }
  return cfg;
}

/**
 * Look for an Expo project the dashboard should drive:
 *   1. Env override `INFINIBOT_MOBILE_EXPO_DIR` for non-standard installs.
 *   2. The shared resolver in the Expo runner, which prefers the package's
 *      bundled `mobile/` dir (in-repo or `node_modules/infinibot/mobile`),
 *      then legacy machine-specific candidates.
 *
 * Returns the first existing path that has an `app.json` (the Expo project
 * marker). Quiet on failure — `mobile.config.set` always wins.
 */
function discoverExpoProjectDir(): string | undefined {
  const env = process.env.INFINIBOT_MOBILE_EXPO_DIR;
  if (env && existsSync(join(env, "app.json"))) return env;
  const resolved = resolveDefaultProjectDir();
  if (existsSync(join(resolved, "app.json"))) return resolved;
  return undefined;
}

function writeConfig(cfg: MobileConfig): void {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2), "utf-8");
}

// ── Helpers ─────────────────────────────────────────────────

function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function asBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function normalizeUdid(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const cleaned = v
    .trim()
    .replace(/[\s-]+/g, "")
    .toUpperCase();
  return /^[A-F0-9]{24,40}$/.test(cleaned) ? cleaned : undefined;
}

function isInternalIosBuild(platform: EasBuildPlatform, profile: EasBuildProfile): boolean {
  return platform === "ios" && profile !== "production";
}

/**
 * Best-effort guess at the gateway's own URL from the user's perspective.
 * Prefers the Tailscale MagicDNS hostname (e.g. `myhost.tailnet-name.ts.net`)
 * over the raw Tailscale IP, then LAN IP, then loopback.
 */
async function inferGatewayUrl(opts: { connect?: { auth?: { password?: string } } }): Promise<{
  url: string;
  password: string | undefined;
  tailscaleAddress: string | null;
  tailnetHostname: string | null;
}> {
  const hostname = await detectTailscaleHost();
  const tsRaw = detectTailscaleAddress();
  const lan = detectLanAddress();
  const port = process.env.GATEWAY_PORT ? Number(process.env.GATEWAY_PORT) : 18789;
  const host = hostname ?? tsRaw ?? lan ?? "127.0.0.1";
  return {
    url: `ws://${host}:${port}`,
    password: opts.connect?.auth?.password,
    tailscaleAddress: tsRaw,
    tailnetHostname: hostname,
  };
}

// ── Handlers ────────────────────────────────────────────────

export const mobileHandlers: GatewayRequestHandlers = {
  /** Get the persisted mobile config + a sane default URL/token. */
  "mobile.config.get": async ({ respond, client }) => {
    try {
      const cfg = readConfig();
      const inferred = await inferGatewayUrl({ connect: client?.connect });
      respond(true, {
        config: cfg,
        suggested: {
          gatewayUrl: cfg.gatewayUrlOverride ?? inferred.url,
          gatewayToken: inferred.password ?? null,
          lanAddress: detectLanAddress(),
          tailscaleAddress: inferred.tailscaleAddress,
          tailnetHostname: inferred.tailnetHostname,
        },
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Update the persisted mobile config — projectDir and bind URL. */
  "mobile.config.set": async ({ respond, params }) => {
    try {
      const cfg = readConfig();
      const next: MobileConfig = { ...cfg };
      if (params.projectDir !== undefined) next.projectDir = asStr(params.projectDir);
      if (params.defaultMode !== undefined) {
        const mode = asStr(params.defaultMode);
        if (mode === "tunnel" || mode === "lan" || mode === "localhost" || mode === "tailscale")
          next.defaultMode = mode;
      }
      if (params.gatewayUrlOverride !== undefined) {
        next.gatewayUrlOverride = asStr(params.gatewayUrlOverride);
      }
      if (params.appleTeamId !== undefined) next.appleTeamId = asStr(params.appleTeamId);
      if (params.expoOffline !== undefined) {
        const v = params.expoOffline;
        if (v === true || v === "true") next.expoOffline = true;
        else if (v === false || v === "false") next.expoOffline = false;
        else if (v === "auto" || v === null || v === "") next.expoOffline = "auto";
        else {
          respond(false, undefined, {
            code: "BAD_REQUEST",
            message: "expoOffline must be auto | true | false",
          });
          return;
        }
      }
      if (params.iosDeviceUdid !== undefined) {
        const udid = normalizeUdid(params.iosDeviceUdid);
        if (params.iosDeviceUdid && !udid) {
          respond(false, undefined, { code: "BAD_REQUEST", message: "invalid iOS device UDID" });
          return;
        }
        next.iosDeviceUdid = udid;
      }
      writeConfig(next);
      respond(true, { config: next });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Start the Expo dev server. Returns the current state immediately. */
  "mobile.expo.start": async ({ respond, params, client }) => {
    try {
      const cfg = readConfig();
      const mode = (asStr(params.mode) as ExpoMode | undefined) ?? cfg.defaultMode ?? "tunnel";
      const inferred = await inferGatewayUrl({ connect: client?.connect });
      const result = await startExpo({
        projectDir: asStr(params.projectDir) ?? cfg.projectDir,
        mode,
        port: typeof params.port === "number" ? params.port : 8081,
        gatewayUrl: asStr(params.gatewayUrl) ?? cfg.gatewayUrlOverride ?? inferred.url,
        gatewayToken: asStr(params.gatewayToken) ?? inferred.password,
        expoOffline: cfg.expoOffline ?? "auto",
      });
      respond(true, { state: result });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Stop the Expo dev server. */
  "mobile.expo.stop": async ({ respond }) => {
    try {
      const result = await stopExpo();
      respond(true, { state: result });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Snapshot of the current Expo runner state — polled by the UI. */
  "mobile.expo.status": async ({ respond }) => {
    try {
      respond(true, { state: getExpoState() });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Verify the user's EAS login. The dashboard surfaces the result so
   * we can prompt `eas login` before kicking a build.
   */
  "mobile.eas.whoami": async ({ respond }) => {
    try {
      const cfg = readConfig();
      const result = await easWhoami(cfg.projectDir);
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Kick an EAS build (default: preview / ios). */
  "mobile.eas.build": async ({ respond, params }) => {
    try {
      const cfg = readConfig();
      const platform = (asStr(params.platform) as EasBuildPlatform | undefined) ?? "ios";
      const profile = (asStr(params.profile) as EasBuildProfile | undefined) ?? "preview";
      const requestedUdid = normalizeUdid(params.iosDeviceUdid) ?? cfg.iosDeviceUdid;
      if (isInternalIosBuild(platform, profile) && requestedUdid) {
        const devices = await listEasDevices({
          projectDir: cfg.projectDir,
          appleTeamId: cfg.appleTeamId,
        });
        const registered = devices.some((d) => normalizeUdid(d.udid) === requestedUdid);
        if (!registered) {
          respond(true, {
            ok: false,
            log: [],
            error: `Device UDID ${requestedUdid} is not registered with EAS yet. Run eas device:create once, then refresh devices in /mobile and build again.`,
          });
          return;
        }
      }
      const result = await startEasBuild({
        projectDir: cfg.projectDir,
        platform,
        profile,
        clearCache: asBool(params.clearCache) ?? false,
        autoSubmit: asBool(params.autoSubmit) ?? false,
        refreshAdHocProvisioningProfile:
          isInternalIosBuild(platform, profile) && Boolean(requestedUdid),
      });
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** List Apple devices registered for EAS internal iOS distribution. */
  "mobile.eas.devices": async ({ respond }) => {
    try {
      const cfg = readConfig();
      const devices = await listEasDevices({
        projectDir: cfg.projectDir,
        appleTeamId: cfg.appleTeamId,
      });
      respond(true, { devices });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** List recent EAS builds (most recent first). */
  "mobile.eas.builds": async ({ respond, params }) => {
    try {
      const cfg = readConfig();
      const limit = typeof params.limit === "number" ? params.limit : 10;
      const builds = await listEasBuilds({ projectDir: cfg.projectDir, limit });
      respond(true, { builds });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Cancel an in-flight build by id. */
  "mobile.eas.cancel": async ({ respond, params }) => {
    try {
      const id = asStr(params.id);
      if (!id) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
        return;
      }
      const cfg = readConfig();
      const result = await cancelEasBuild(id, cfg.projectDir);
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};

export default mobileHandlers;
