import { spawn } from "node:child_process";
import fs from "node:fs";

import type { Command } from "commander";
import type { GatewayAuthMode } from "../../config/config.js";
import {
  CONFIG_PATH,
  loadConfig,
  readConfigFileSnapshot,
  resolveGatewayPort,
} from "../../config/config.js";
import { resolveGatewayAuth } from "../../gateway/auth.js";
import { startGatewayServer } from "../../gateway/server.js";
import type { GatewayWsLogStyle } from "../../gateway/ws-logging.js";
import { setGatewayWsLogStyle } from "../../gateway/ws-logging.js";
import { setVerbose } from "../../globals.js";
import { GatewayLockError } from "../../infra/gateway-lock.js";
import { formatPortDiagnostics, inspectPortUsage } from "../../infra/ports.js";
import { setConsoleSubsystemFilter, setConsoleTimestampPrefix } from "../../logging/console.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { defaultRuntime } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";
import { forceFreePortAndWait } from "../ports.js";
import { ensureDevGatewayConfig } from "./dev.js";
import { runGatewayLoop } from "./run-loop.js";
import {
  describeUnknownError,
  extractGatewayMiskeys,
  maybeExplainGatewayServiceStop,
  parsePort,
  toOptionString,
} from "./shared.js";
import { runSatelliteMode, shouldRunSatelliteMode, getMasterUrl } from "./satellite.js";
import {
  resolveAuthForLaunch,
  buildControlUiLaunchUrl,
  preferLocalUiHost,
} from "../control-ui-launch.js";

type GatewayRunOpts = {
  port?: unknown;
  bind?: unknown;
  token?: unknown;
  auth?: unknown;
  password?: unknown;
  tailscale?: unknown;
  tailscaleResetOnExit?: boolean;
  allowUnconfigured?: boolean;
  force?: boolean;
  /** When false (set by --no-open), don't auto-launch the Control UI. */
  open?: boolean;
  noOpen?: boolean;
  verbose?: boolean;
  claudeCliLogs?: boolean;
  wsLog?: unknown;
  compact?: boolean;
  rawStream?: boolean;
  rawStreamPath?: unknown;
  dev?: boolean;
  reset?: boolean;
  // Federation options
  satellite?: boolean;
  master?: unknown;
  /**
   * Run as a federation master hub. Without this flag (and without
   * `federation.mode: "master"` in the config), the gateway runs as a
   * regular local gateway and the federation hub is *not* started — meaning
   * satellite connections to ws://this-host:47913/federation will be
   * refused.
   */
  masterMode?: boolean;
  federationPort?: unknown;
};

const gatewayLog = createSubsystemLogger("gateway");

async function runGatewayCommand(opts: GatewayRunOpts) {
  const isDevProfile = process.env.INFINIBOT_PROFILE?.trim().toLowerCase() === "dev";
  const devMode = Boolean(opts.dev) || isDevProfile;
  if (opts.reset && !devMode) {
    defaultRuntime.error("Use --reset with --dev.");
    defaultRuntime.exit(1);
    return;
  }

  setConsoleTimestampPrefix(true);
  setVerbose(Boolean(opts.verbose));
  if (opts.claudeCliLogs) {
    setConsoleSubsystemFilter(["agent/claude-cli"]);
    process.env.INFINIBOT_CLAUDE_CLI_LOG_OUTPUT = "1";
  }
  const wsLogRaw = (opts.compact ? "compact" : opts.wsLog) as string | undefined;
  const wsLogStyle: GatewayWsLogStyle =
    wsLogRaw === "compact" ? "compact" : wsLogRaw === "full" ? "full" : "auto";
  if (
    wsLogRaw !== undefined &&
    wsLogRaw !== "auto" &&
    wsLogRaw !== "compact" &&
    wsLogRaw !== "full"
  ) {
    defaultRuntime.error('Invalid --ws-log (use "auto", "full", "compact")');
    defaultRuntime.exit(1);
  }
  setGatewayWsLogStyle(wsLogStyle);

  if (opts.rawStream) {
    process.env.INFINIBOT_RAW_STREAM = "1";
  }
  const rawStreamPath = toOptionString(opts.rawStreamPath);
  if (rawStreamPath) {
    process.env.INFINIBOT_RAW_STREAM_PATH = rawStreamPath;
  }

  if (devMode) {
    await ensureDevGatewayConfig({ reset: Boolean(opts.reset) });
  }

  const cfg = loadConfig();
  // Propagate the wizard-saved Notion API key to NOTION_API_KEY so the many
  // legacy readers (kanban-sync, focus-tool, kanban-tool, business-income,
  // notion-proxy, lead-service, etc.) see it without each having to import
  // src/databases/notion-config.ts. Without this, sessions silently bypass
  // Notion and only write to local SQLite, because those readers fall back
  // to "no key" when the env var is unset on a wizard-only setup. We never
  // overwrite an explicitly exported env var — operator-set values win.
  const notionBlock = cfg.notion as { apiKey?: unknown; syncMode?: unknown } | undefined;
  const notionKey = notionBlock?.apiKey;
  const notionSyncMode = notionBlock?.syncMode;
  if (
    !process.env.NOTION_API_KEY &&
    typeof notionKey === "string" &&
    notionKey.length > 0 &&
    notionSyncMode !== "off"
  ) {
    process.env.NOTION_API_KEY = notionKey;
  }
  const portOverride = parsePort(opts.port);
  if (opts.port !== undefined && portOverride === null) {
    defaultRuntime.error("Invalid port");
    defaultRuntime.exit(1);
  }
  const port = portOverride ?? resolveGatewayPort(cfg);
  if (!Number.isFinite(port) || port <= 0) {
    defaultRuntime.error("Invalid port");
    defaultRuntime.exit(1);
  }
  if (opts.force) {
    try {
      const { killed, waitedMs, escalatedToSigkill } = await forceFreePortAndWait(port, {
        timeoutMs: 2000,
        intervalMs: 100,
        sigtermTimeoutMs: 700,
      });
      if (killed.length === 0) {
        gatewayLog.info(`force: no listeners on port ${port}`);
      } else {
        for (const proc of killed) {
          gatewayLog.info(
            `force: killed pid ${proc.pid}${proc.command ? ` (${proc.command})` : ""} on port ${port}`,
          );
        }
        if (escalatedToSigkill) {
          gatewayLog.info(`force: escalated to SIGKILL while freeing port ${port}`);
        }
        if (waitedMs > 0) {
          gatewayLog.info(`force: waited ${waitedMs}ms for port ${port} to free`);
        }
      }
    } catch (err) {
      defaultRuntime.error(`Force: ${String(err)}`);
      defaultRuntime.exit(1);
      return;
    }
  }
  if (opts.token) {
    const token = toOptionString(opts.token);
    if (token) process.env.INFINIBOT_GATEWAY_TOKEN = token;
  }
  if (opts.password) {
    const password = toOptionString(opts.password);
    if (password) process.env.INFINIBOT_GATEWAY_PASSWORD = password;
  }
  const authModeRaw = toOptionString(opts.auth);
  const authMode: GatewayAuthMode | null =
    authModeRaw === "token" || authModeRaw === "password" ? authModeRaw : null;
  if (authModeRaw && !authMode) {
    defaultRuntime.error('Invalid --auth (use "token" or "password")');
    defaultRuntime.exit(1);
    return;
  }
  // Propagate the chosen mode to env so that `resolveLiveGatewayAuth`, which
  // re-reads the config from disk on every WebSocket connect, doesn't undo
  // the operator's `--auth` choice. Without this, a config with
  // `gateway.auth.password` set causes the heuristic in `resolveGatewayAuth`
  // to flip the live mode back to "password" and reject token-mode clients
  // (e.g. quickstart UI, MCP) with `password_missing`.
  if (authMode) process.env.INFINIBOT_GATEWAY_AUTH_MODE = authMode;
  const tailscaleRaw = toOptionString(opts.tailscale);
  const tailscaleMode =
    tailscaleRaw === "off" || tailscaleRaw === "serve" || tailscaleRaw === "funnel"
      ? tailscaleRaw
      : null;
  if (tailscaleRaw && !tailscaleMode) {
    defaultRuntime.error('Invalid --tailscale (use "off", "serve", or "funnel")');
    defaultRuntime.exit(1);
    return;
  }
  const passwordRaw = toOptionString(opts.password);
  const tokenRaw = toOptionString(opts.token);

  const configExists = fs.existsSync(CONFIG_PATH);
  const mode = cfg.gateway?.mode;
  if (!opts.allowUnconfigured && mode !== "local") {
    if (!configExists) {
      defaultRuntime.error(
        `Missing config. Run \`${formatCliCommand("infinibot setup")}\` or set gateway.mode=local (or pass --allow-unconfigured).`,
      );
    } else {
      defaultRuntime.error(
        `Gateway start blocked: set gateway.mode=local (current: ${mode ?? "unset"}) or pass --allow-unconfigured.`,
      );
    }
    defaultRuntime.exit(1);
    return;
  }
  const bindRaw = toOptionString(opts.bind) ?? cfg.gateway?.bind ?? "loopback";
  const bind =
    bindRaw === "loopback" ||
    bindRaw === "lan" ||
    bindRaw === "auto" ||
    bindRaw === "custom" ||
    bindRaw === "tailnet"
      ? bindRaw
      : null;
  if (!bind) {
    defaultRuntime.error('Invalid --bind (use "loopback", "lan", "tailnet", "auto", or "custom")');
    defaultRuntime.exit(1);
    return;
  }

  const snapshot = await readConfigFileSnapshot().catch(() => null);
  const miskeys = extractGatewayMiskeys(snapshot?.parsed);
  const authConfig = {
    ...cfg.gateway?.auth,
    ...(authMode ? { mode: authMode } : {}),
    ...(passwordRaw ? { password: passwordRaw } : {}),
    ...(tokenRaw ? { token: tokenRaw } : {}),
  };
  const resolvedAuth = resolveGatewayAuth({
    authConfig,
    env: process.env,
    tailscaleMode: tailscaleMode ?? cfg.gateway?.tailscale?.mode ?? "off",
  });
  const resolvedAuthMode = resolvedAuth.mode;
  const tokenValue = resolvedAuth.token;
  const passwordValue = resolvedAuth.password;
  const hasToken = typeof tokenValue === "string" && tokenValue.trim().length > 0;
  const hasPassword = typeof passwordValue === "string" && passwordValue.trim().length > 0;
  const hasSharedSecret =
    (resolvedAuthMode === "token" && hasToken) || (resolvedAuthMode === "password" && hasPassword);
  const authHints: string[] = [];
  if (miskeys.hasGatewayToken) {
    authHints.push('Found "gateway.token" in config. Use "gateway.auth.token" instead.');
  }
  if (miskeys.hasRemoteToken) {
    authHints.push(
      '"gateway.remote.token" is for remote CLI calls; it does not enable local gateway auth.',
    );
  }
  if (resolvedAuthMode === "token" && !hasToken && !resolvedAuth.allowTailscale) {
    defaultRuntime.error(
      [
        "Gateway auth is set to token, but no token is configured.",
        "Set gateway.auth.token (or INFINIBOT_GATEWAY_TOKEN), or pass --token.",
        ...authHints,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    defaultRuntime.exit(1);
    return;
  }
  if (resolvedAuthMode === "password" && !hasPassword) {
    defaultRuntime.error(
      [
        "Gateway auth is set to password, but no password is configured.",
        "Set gateway.auth.password (or INFINIBOT_GATEWAY_PASSWORD), or pass --password.",
        ...authHints,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    defaultRuntime.exit(1);
    return;
  }
  if (bind !== "loopback" && !hasSharedSecret) {
    defaultRuntime.error(
      [
        `Refusing to bind gateway to ${bind} without auth.`,
        "Set gateway.auth.token/password (or INFINIBOT_GATEWAY_TOKEN/INFINIBOT_GATEWAY_PASSWORD) or pass --token/--password.",
        ...authHints,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    defaultRuntime.exit(1);
    return;
  }

  // Control UI launch policy — computed up front so both the satellite and
  // standalone paths share it. Disabled by `--no-open` (commander stores this
  // as `opts.open === false`) or the `INFINIBOT_NO_OPEN` env var.
  const openUi = opts.open !== false && !opts.noOpen && process.env.INFINIBOT_NO_OPEN !== "1";

  // Check for satellite mode
  const masterUrlOpt = toOptionString(opts.master);
  if (
    shouldRunSatelliteMode({
      satellite: Boolean(opts.satellite),
      master: masterUrlOpt ?? undefined,
    })
  ) {
    const masterUrl = getMasterUrl({ master: masterUrlOpt ?? undefined });
    if (!masterUrl) {
      defaultRuntime.error(
        "Satellite mode requires a master URL. Use --master <url> or configure federation.masterUrl in config.",
      );
      defaultRuntime.exit(1);
      return;
    }

    gatewayLog.info(`starting in satellite mode, master: ${masterUrl}`);
    try {
      const result = await runSatelliteMode(
        {
          masterUrl,
          port,
          bind,
          auth:
            authMode || passwordRaw || tokenRaw
              ? {
                  mode: authMode ?? undefined,
                  token: tokenRaw,
                  password: passwordRaw,
                }
              : undefined,
          verbose: Boolean(opts.verbose),
        },
        defaultRuntime,
      );

      // The satellite runs a full local gateway (Control UI included) on
      // `port`, so open it just like the standalone path does — otherwise
      // satellite-mode users never get a browser tab on startup. Use the
      // host the gateway actually bound to (e.g. a tailnet IP) so the URL
      // doesn't dead-end on localhost.
      const uiUrl = controlUiUrlForServer(result.gateway);
      defaultRuntime.log(`✓ Gateway is up (satellite). Control UI: ${maskUiUrl(uiUrl)}`);
      if (openUi) {
        setTimeout(() => openGatewayUi(uiUrl), 150);
      }

      // Keep running until closed
      await new Promise<void>((resolve) => {
        const cleanup = async () => {
          await result.close();
          resolve();
        };
        process.once("SIGINT", cleanup);
        process.once("SIGTERM", cleanup);
      });
      return;
    } catch (err) {
      defaultRuntime.error(`Satellite mode failed: ${String(err)}`);
      defaultRuntime.exit(1);
      return;
    }
  }

  // Open the Control UI in a browser once the gateway is up. Only fires
  // on the first successful start; subsequent in-process restarts
  // (SIGUSR1) don't re-open the tab. `openUi` policy is computed above; the
  // URL is derived from the host the server actually bound to.
  let firstStartOpened = false;

  try {
    await runGatewayLoop({
      runtime: defaultRuntime,
      start: async () => {
        // CLI-driven federation overrides. `--master-mode` flips on the
        // FederationHub at startup so the gateway accepts incoming
        // satellites on /federation. The hub attaches to the same HTTP
        // server as the gateway, so the actual listen port is `--port`
        // (default 18789), NOT `--federation-port` — that flag now only
        // updates the configured `federation.federationPort` value used
        // for status display + future external listeners.
        const federationPortOpt = toOptionString(opts.federationPort);
        const federationPortNum = federationPortOpt
          ? Number.parseInt(federationPortOpt, 10)
          : undefined;
        const federationOverride =
          opts.masterMode || (federationPortNum && Number.isFinite(federationPortNum))
            ? {
                ...(opts.masterMode ? { enabled: true, mode: "master" as const } : {}),
                ...(federationPortNum && Number.isFinite(federationPortNum)
                  ? { federationPort: federationPortNum }
                  : {}),
              }
            : undefined;
        const server = await startGatewayServer(port, {
          bind,
          auth:
            authMode || passwordRaw || tokenRaw || authModeRaw
              ? {
                  mode: authMode ?? undefined,
                  token: tokenRaw,
                  password: passwordRaw,
                }
              : undefined,
          tailscale:
            tailscaleMode || opts.tailscaleResetOnExit
              ? {
                  mode: tailscaleMode ?? undefined,
                  resetOnExit: Boolean(opts.tailscaleResetOnExit),
                }
              : undefined,
          federationOverride,
        });
        if (!firstStartOpened) {
          firstStartOpened = true;
          const uiUrl = controlUiUrlForServer(server);
          defaultRuntime.log(`✓ Gateway is up. Control UI: ${maskUiUrl(uiUrl)}`);
          if (openUi) {
            // Tiny delay — Windows occasionally races the very first
            // browser request against the gateway's listen socket; the
            // same delay is used in the wizard's setup-ui flow.
            setTimeout(() => openGatewayUi(uiUrl), 150);
          }
        }
        return server;
      },
    });
  } catch (err) {
    if (
      err instanceof GatewayLockError ||
      (err && typeof err === "object" && (err as { name?: string }).name === "GatewayLockError")
    ) {
      const errMessage = describeUnknownError(err);
      defaultRuntime.error(
        `Gateway failed to start: ${errMessage}\nIf the gateway is supervised, stop it with: ${formatCliCommand("infinibot gateway stop")}`,
      );
      try {
        const diagnostics = await inspectPortUsage(port);
        if (diagnostics.status === "busy") {
          for (const line of formatPortDiagnostics(diagnostics)) {
            defaultRuntime.error(line);
          }
        }
      } catch {
        // ignore diagnostics failures
      }
      await maybeExplainGatewayServiceStop();
      defaultRuntime.exit(1);
      return;
    }
    defaultRuntime.error(`Gateway failed to start: ${String(err)}`);
    defaultRuntime.exit(1);
  }
}

/**
 * Build the browsable Control UI URL for a browser on this machine, carrying
 * the gateway credential in the hash so the tab lands authenticated rather
 * than on a login prompt.
 *
 * Prefers loopback (127.0.0.1): the Control UI only runs in a secure context
 * (HTTPS or localhost), so a bare-IP HTTP origin like a tailnet address is
 * rejected by the browser ("control ui requires HTTPS or localhost"). The
 * gateway now also listens on loopback for any non-wildcard bind, so this URL
 * both connects *and* is a secure context.
 */
function controlUiUrlForServer(server: {
  bindHost: string;
  bindHosts: string[];
  port: number;
  controlUiBasePath: string;
}): string {
  return buildControlUiLaunchUrl({
    host: preferLocalUiHost(server.bindHosts),
    port: server.port,
    basePath: server.controlUiBasePath,
    auth: resolveAuthForLaunch(),
  });
}

/** Strip the credential hash before logging so the token stays out of logs. */
function maskUiUrl(url: string): string {
  return url.replace(/#.*$/, "#…");
}

/**
 * Cross-platform browser launch. Detached + stdio=ignore so the child
 * outlives this process and doesn't pipe noise into our log stream.
 * Failures are silent — the URL is already printed for manual recovery.
 */
function openGatewayUi(url: string): void {
  const platform = process.platform;
  const [command, args] =
    platform === "win32"
      ? // Empty quoted title is required by cmd's `start` so the URL isn't
        // mistaken for the window title.
        ["cmd", ["/c", "start", "", url]]
      : platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    // A missing opener (headless server, container without xdg-open) is
    // reported as an async 'error' event, not a throw. Unhandled, it becomes
    // an uncaught exception that takes the whole gateway down.
    child.on("error", () => {
      /* fall back to the printed URL in the success line */
    });
    child.unref();
  } catch {
    /* fall back to the printed URL in the success line */
  }
}

export function addGatewayRunCommand(cmd: Command): Command {
  return (
    cmd
      .option("--port <port>", "Port for the gateway WebSocket")
      .option(
        "--bind <mode>",
        'Bind mode ("loopback"|"lan"|"tailnet"|"auto"|"custom"). Defaults to config gateway.bind (or loopback).',
      )
      .option(
        "--token <token>",
        "Shared token required in connect.params.auth.token (default: INFINIBOT_GATEWAY_TOKEN env if set)",
      )
      .option("--auth <mode>", 'Gateway auth mode ("token"|"password")')
      .option("--password <password>", "Password for auth mode=password")
      .option("--tailscale <mode>", 'Tailscale exposure mode ("off"|"serve"|"funnel")')
      .option(
        "--tailscale-reset-on-exit",
        "Reset Tailscale serve/funnel configuration on shutdown",
        false,
      )
      .option(
        "--allow-unconfigured",
        "Allow gateway start without gateway.mode=local in config",
        false,
      )
      .option("--dev", "Create a dev config + workspace if missing (no BOOTSTRAP.md)", false)
      .option(
        "--reset",
        "Reset dev config + credentials + sessions + workspace (requires --dev)",
        false,
      )
      .option("--force", "Kill any existing listener on the target port before starting", false)
      .option(
        "--no-open",
        "Don't open the Control UI in a browser on startup (or set INFINIBOT_NO_OPEN=1)",
      )
      .option("--verbose", "Verbose logging to stdout/stderr", false)
      .option(
        "--claude-cli-logs",
        "Only show claude-cli logs in the console (includes stdout/stderr)",
        false,
      )
      .option("--ws-log <style>", 'WebSocket log style ("auto"|"full"|"compact")', "auto")
      .option("--compact", 'Alias for "--ws-log compact"', false)
      .option("--raw-stream", "Log raw model stream events to jsonl", false)
      .option("--raw-stream-path <path>", "Raw stream jsonl path")
      // Federation options
      .option("--satellite", "Run in satellite mode (connect to a master gateway)", false)
      .option(
        "--master <url>",
        "Master gateway URL for satellite mode (e.g., ws://192.168.1.100:47913/federation)",
      )
      .option(
        "--master-mode",
        "Run as a federation master hub (accepts incoming satellite connections on /federation)",
        false,
      )
      .option(
        "--federation-port <port>",
        "Port for federation hub (master mode only; default 47913)",
      )
      .action(async (_opts, command: Command) => {
        await runGatewayCommand(resolveGatewayRunOpts(command));
      })
  );
}

/**
 * `gateway` and `gateway run` declare the same options, and commander hands
 * an option typed after `run` to the PARENT (`gateway run --port 19431` →
 * gateway.opts().port, run.opts().port undefined). The run then fell back to
 * INFINIBOT_GATEWAY_PORT — 18789 in any shell spawned by the live gateway —
 * so a side gateway "detected the live gateway" and refused to start. Take
 * every option the user actually typed, on either command.
 */
export function resolveGatewayRunOpts(command: Command): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...command.opts() };
  const parent = command.parent;
  if (!parent || parent.name() !== "gateway") return merged;
  for (const [key, value] of Object.entries(parent.opts())) {
    const parentSource = parent.getOptionValueSource(key);
    const localSource = command.getOptionValueSource(key);
    if ((parentSource === "cli" || parentSource === "env") && localSource !== "cli") {
      merged[key] = value;
    }
  }
  return merged;
}
