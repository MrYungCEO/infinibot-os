/**
 * Federation CLI
 *
 * Commands for managing the InfiniBot federation system:
 * - `infinibot connect <url>` - Connect this node to a master gateway
 * - `infinibot connect --scan` - Scan Tailscale network for masters
 * - `infinibot federation status` - Show federation status
 * - `infinibot federation nodes` - List connected nodes
 * - `infinibot federation scan` - Scan for federation masters
 */

import type { Command } from "commander";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { loadConfig, writeConfigFile, type InfinibotConfig } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import { colorize, isRich, theme } from "../terminal/theme.js";
import { FederationSatellite, type SatelliteConfig } from "../federation/satellite.js";
import { getConnectedNodes } from "../federation/agent-tools.js";
import {
  getTailscaleNetwork,
  resolveFederationMasterUrl,
  scanForFederationMasters,
} from "../federation/tailscale-discovery.js";
import os from "os";

const log = createSubsystemLogger("federation").child("cli");

// =============================================================================
// Connect Command
// =============================================================================

interface ConnectOptions {
  name?: string;
  workspace?: string;
  save?: boolean;
  json?: boolean;
  scan?: boolean;
  port?: string;
}

async function runConnectCommand(
  masterUrl: string | undefined,
  opts: ConnectOptions,
): Promise<void> {
  const rich = isRich();
  const port = opts.port ? parseInt(opts.port, 10) : 47913;

  // If --scan is provided, discover masters via Tailscale
  if (opts.scan || !masterUrl) {
    await runScanAndConnect(opts, port);
    return;
  }

  // Resolve the URL (handles Tailscale hostnames, IPs, full URLs)
  let resolvedUrl: string;
  try {
    resolvedUrl = await resolveFederationMasterUrl(masterUrl, port);
  } catch {
    defaultRuntime.error(`Invalid master URL: ${masterUrl}`);
    defaultRuntime.exit(1);
    return;
  }

  const url = new URL(resolvedUrl);
  const cfg = loadConfig();
  const nodeName = opts.name ?? cfg.federation?.nodeName ?? os.hostname();
  const workspace = opts.workspace ?? process.cwd();

  const satelliteConfig: SatelliteConfig = {
    masterUrl: url.toString(),
    nodeName,
    workspace,
    autoReconnect: false,
  };

  if (!opts.json) {
    defaultRuntime.log(colorize(rich, theme.heading, "Connecting to Federation Master"));
    defaultRuntime.log(`${colorize(rich, theme.muted, "URL:")} ${url.toString()}`);
    defaultRuntime.log(`${colorize(rich, theme.muted, "Node name:")} ${nodeName}`);
    defaultRuntime.log("");
  }

  try {
    const satellite = new FederationSatellite(satelliteConfig);

    satellite.on("state:change", (state) => {
      if (!opts.json) {
        defaultRuntime.log(`${colorize(rich, theme.muted, "State:")} ${state}`);
      }
    });

    await satellite.connect();
    const manifest = satellite.getManifest();

    if (opts.json) {
      defaultRuntime.log(
        JSON.stringify(
          {
            success: true,
            nodeId: manifest.id,
            nodeName: manifest.name,
            masterUrl: url.toString(),
            capabilities: manifest.capabilities,
          },
          null,
          2,
        ),
      );
    } else {
      defaultRuntime.log("");
      defaultRuntime.log(colorize(rich, theme.success, "✓ Connected successfully!"));
      defaultRuntime.log(`${colorize(rich, theme.muted, "Node ID:")} ${manifest.id}`);
    }

    await satellite.disconnect();

    if (opts.save) {
      const updatedConfig: Partial<InfinibotConfig> = {
        ...cfg,
        federation: {
          ...cfg.federation,
          enabled: true,
          mode: "satellite",
          masterUrl: url.toString(),
          nodeName,
        },
      };

      await writeConfigFile(updatedConfig as InfinibotConfig);

      if (!opts.json) {
        defaultRuntime.log("");
        defaultRuntime.log(colorize(rich, theme.success, "✓ Configuration saved"));
        defaultRuntime.log(
          `${colorize(rich, theme.muted, "Run")} infinibot gateway ${colorize(rich, theme.muted, "to start in satellite mode")}`,
        );
      }
    } else if (!opts.json) {
      defaultRuntime.log("");
      defaultRuntime.log(colorize(rich, theme.muted, "To save this configuration, run:"));
      defaultRuntime.log(`  infinibot connect ${masterUrl} --save`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (opts.json) {
      defaultRuntime.log(JSON.stringify({ success: false, error: message }, null, 2));
    } else {
      defaultRuntime.error(colorize(rich, theme.error, `✗ Connection failed: ${message}`));
    }

    defaultRuntime.exit(1);
  }
}

async function runScanAndConnect(opts: ConnectOptions, port: number): Promise<void> {
  const rich = isRich();

  if (!opts.json) {
    defaultRuntime.log(
      colorize(rich, theme.heading, "Scanning Tailscale Network for Federation Masters"),
    );
    defaultRuntime.log("");
  }

  // Check Tailscale status first
  const network = await getTailscaleNetwork();

  if (!network.connected) {
    if (opts.json) {
      defaultRuntime.log(
        JSON.stringify(
          { success: false, error: network.error ?? "Tailscale not connected" },
          null,
          2,
        ),
      );
    } else {
      defaultRuntime.error(
        colorize(
          rich,
          theme.error,
          `✗ Tailscale not connected: ${network.error ?? "unknown error"}`,
        ),
      );
      defaultRuntime.log("");
      defaultRuntime.log(
        colorize(rich, theme.muted, "Ensure Tailscale is running and connected to your tailnet."),
      );
    }
    defaultRuntime.exit(1);
    return;
  }

  if (!opts.json) {
    defaultRuntime.log(
      `${colorize(rich, theme.muted, "Tailnet:")} ${network.tailnetName ?? "unknown"}`,
    );
    defaultRuntime.log(
      `${colorize(rich, theme.muted, "This node:")} ${network.selfDnsName ?? network.selfIps[0] ?? "unknown"}`,
    );
    defaultRuntime.log(
      `${colorize(rich, theme.muted, "Peers online:")} ${network.peers.filter((p) => p.online && !p.isSelf).length}`,
    );
    defaultRuntime.log("");
    defaultRuntime.log(colorize(rich, theme.muted, "Probing peers for federation masters..."));
  }

  const masters = await scanForFederationMasters(port);

  if (masters.length === 0) {
    if (opts.json) {
      defaultRuntime.log(
        JSON.stringify(
          { success: false, error: "No federation masters found", peers: network.peers.length },
          null,
          2,
        ),
      );
    } else {
      defaultRuntime.log("");
      defaultRuntime.log(
        colorize(
          rich,
          theme.error,
          "No active federation masters found on your Tailscale network.",
        ),
      );
      defaultRuntime.log("");
      defaultRuntime.log(colorize(rich, theme.muted, "To start a master, run on your server:"));
      defaultRuntime.log(`  infinibot gateway --master`);
    }
    defaultRuntime.exit(1);
    return;
  }

  if (opts.json) {
    defaultRuntime.log(
      JSON.stringify(
        {
          success: true,
          masters: masters.map((m) => ({
            hostname: m.peer.hostname,
            dnsName: m.peer.dnsName,
            wsUrl: m.wsUrl,
            httpsUrl: m.httpsUrl,
            os: m.peer.os,
            reason: m.reason,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  defaultRuntime.log("");
  defaultRuntime.log(
    colorize(
      rich,
      theme.success,
      `✓ Found ${masters.length} federation master${masters.length > 1 ? "s" : ""}:`,
    ),
  );
  defaultRuntime.log("");

  for (let i = 0; i < masters.length; i++) {
    const m = masters[i];
    const num = colorize(rich, theme.muted, `[${i + 1}]`);
    const name = colorize(rich, theme.heading, m.peer.hostname);
    const dns = colorize(rich, theme.muted, m.peer.dnsName);

    defaultRuntime.log(`${num} ${name}`);
    defaultRuntime.log(`    ${colorize(rich, theme.muted, "DNS:")} ${dns}`);
    defaultRuntime.log(`    ${colorize(rich, theme.muted, "URL:")} ${m.wsUrl}`);
    if (m.peer.os) {
      defaultRuntime.log(`    ${colorize(rich, theme.muted, "OS:")} ${m.peer.os}`);
    }
    defaultRuntime.log("");
  }

  // If only one master found, offer to connect
  if (masters.length === 1) {
    defaultRuntime.log(colorize(rich, theme.muted, "To connect to this master:"));
    defaultRuntime.log(`  infinibot connect ${masters[0].peer.hostname} --save`);
  } else {
    defaultRuntime.log(colorize(rich, theme.muted, "To connect to a master:"));
    defaultRuntime.log(`  infinibot connect <hostname> --save`);
  }
}

// =============================================================================
// Federation Status Command
// =============================================================================

interface StatusOptions {
  json?: boolean;
}

async function runStatusCommand(opts: StatusOptions): Promise<void> {
  const rich = isRich();
  const cfg = loadConfig();

  const mode = cfg.federation?.mode ?? "standalone";
  const enabled = cfg.federation?.enabled !== false;
  const masterUrl = cfg.federation?.masterUrl;
  const nodeName = cfg.federation?.nodeName ?? os.hostname();

  // Also get Tailscale status
  const tailscale = await getTailscaleNetwork();

  if (opts.json) {
    defaultRuntime.log(
      JSON.stringify(
        {
          enabled,
          mode,
          nodeName,
          masterUrl: masterUrl ?? null,
          federationPort: cfg.federation?.federationPort ?? 47913,
          tailscale: {
            connected: tailscale.connected,
            dnsName: tailscale.selfDnsName ?? null,
            tailnet: tailscale.tailnetName ?? null,
            peersOnline: tailscale.peers.filter((p) => p.online && !p.isSelf).length,
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  defaultRuntime.log(colorize(rich, theme.heading, "Federation Status"));
  defaultRuntime.log("");
  defaultRuntime.log(`${colorize(rich, theme.muted, "Enabled:")} ${enabled ? "yes" : "no"}`);
  defaultRuntime.log(`${colorize(rich, theme.muted, "Mode:")} ${mode}`);
  defaultRuntime.log(`${colorize(rich, theme.muted, "Node name:")} ${nodeName}`);

  if (mode === "satellite" && masterUrl) {
    defaultRuntime.log(`${colorize(rich, theme.muted, "Master URL:")} ${masterUrl}`);
  }

  if (mode === "master") {
    const port = cfg.federation?.federationPort ?? 47913;
    defaultRuntime.log(`${colorize(rich, theme.muted, "Federation port:")} ${port}`);
  }

  // Tailscale info
  defaultRuntime.log("");
  defaultRuntime.log(colorize(rich, theme.heading, "Tailscale"));
  if (tailscale.connected) {
    defaultRuntime.log(
      `${colorize(rich, theme.muted, "Status:")} ${colorize(rich, theme.success, "Connected")}`,
    );
    defaultRuntime.log(
      `${colorize(rich, theme.muted, "DNS Name:")} ${tailscale.selfDnsName ?? "unknown"}`,
    );
    defaultRuntime.log(
      `${colorize(rich, theme.muted, "Tailnet:")} ${tailscale.tailnetName ?? "unknown"}`,
    );
    defaultRuntime.log(
      `${colorize(rich, theme.muted, "Peers online:")} ${tailscale.peers.filter((p) => p.online && !p.isSelf).length}`,
    );
  } else {
    defaultRuntime.log(
      `${colorize(rich, theme.muted, "Status:")} ${colorize(rich, theme.error, "Not connected")}`,
    );
    if (tailscale.error) {
      defaultRuntime.log(`${colorize(rich, theme.muted, "Error:")} ${tailscale.error}`);
    }
  }
}

// =============================================================================
// Federation Nodes Command
// =============================================================================

interface NodesOptions {
  json?: boolean;
}

async function runNodesCommand(opts: NodesOptions): Promise<void> {
  const rich = isRich();

  try {
    const nodes = await getConnectedNodes();

    if (opts.json) {
      defaultRuntime.log(JSON.stringify({ nodes }, null, 2));
      return;
    }

    defaultRuntime.log(colorize(rich, theme.heading, "Federation Nodes"));
    defaultRuntime.log("");

    if (nodes.length === 0) {
      defaultRuntime.log(colorize(rich, theme.muted, "No nodes connected"));
      return;
    }

    for (const node of nodes) {
      const status = node.connected
        ? colorize(rich, theme.success, "●")
        : colorize(rich, theme.error, "○");
      const name = node.displayName ?? node.nodeId;
      const platform = node.platform ?? "unknown";
      const caps = node.caps.length > 0 ? node.caps.join(", ") : "none";

      defaultRuntime.log(`${status} ${colorize(rich, theme.heading, name)}`);
      defaultRuntime.log(`  ${colorize(rich, theme.muted, "ID:")} ${node.nodeId}`);
      defaultRuntime.log(`  ${colorize(rich, theme.muted, "Platform:")} ${platform}`);
      defaultRuntime.log(`  ${colorize(rich, theme.muted, "Capabilities:")} ${caps}`);
      defaultRuntime.log("");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    defaultRuntime.error(`Failed to list nodes: ${message}`);
    defaultRuntime.exit(1);
  }
}

// =============================================================================
// Federation Scan Command
// =============================================================================

interface ScanOptions {
  json?: boolean;
  port?: string;
}

async function runScanCommand(opts: ScanOptions): Promise<void> {
  const rich = isRich();
  const port = opts.port ? parseInt(opts.port, 10) : 47913;

  if (!opts.json) {
    defaultRuntime.log(colorize(rich, theme.heading, "Scanning Tailscale Network"));
    defaultRuntime.log("");
  }

  const network = await getTailscaleNetwork();

  if (!network.connected) {
    if (opts.json) {
      defaultRuntime.log(
        JSON.stringify(
          {
            success: false,
            error: network.error ?? "Tailscale not connected",
          },
          null,
          2,
        ),
      );
    } else {
      defaultRuntime.error(colorize(rich, theme.error, `✗ Tailscale not connected`));
    }
    defaultRuntime.exit(1);
    return;
  }

  if (!opts.json) {
    defaultRuntime.log(
      `${colorize(rich, theme.muted, "Tailnet:")} ${network.tailnetName ?? "unknown"}`,
    );
    defaultRuntime.log(`${colorize(rich, theme.muted, "This node:")} ${network.selfDnsName}`);
    defaultRuntime.log("");
  }

  // List all peers
  const onlinePeers = network.peers.filter((p) => p.online && !p.isSelf);

  if (!opts.json) {
    defaultRuntime.log(
      colorize(rich, theme.heading, `Tailscale Peers (${onlinePeers.length} online)`),
    );
    defaultRuntime.log("");

    for (const peer of onlinePeers) {
      const status = colorize(rich, theme.success, "●");
      defaultRuntime.log(`${status} ${colorize(rich, theme.heading, peer.hostname)}`);
      defaultRuntime.log(`  ${colorize(rich, theme.muted, "DNS:")} ${peer.dnsName}`);
      defaultRuntime.log(`  ${colorize(rich, theme.muted, "IPs:")} ${peer.ips.join(", ")}`);
      if (peer.os) {
        defaultRuntime.log(`  ${colorize(rich, theme.muted, "OS:")} ${peer.os}`);
      }
      defaultRuntime.log("");
    }
  }

  // Scan for federation masters
  if (!opts.json) {
    defaultRuntime.log(colorize(rich, theme.muted, "Probing for federation masters..."));
    defaultRuntime.log("");
  }

  const masters = await scanForFederationMasters(port);

  if (opts.json) {
    defaultRuntime.log(
      JSON.stringify(
        {
          success: true,
          tailnet: network.tailnetName,
          selfDnsName: network.selfDnsName,
          peers: onlinePeers.map((p) => ({
            hostname: p.hostname,
            dnsName: p.dnsName,
            ips: p.ips,
            os: p.os,
          })),
          masters: masters.map((m) => ({
            hostname: m.peer.hostname,
            dnsName: m.peer.dnsName,
            wsUrl: m.wsUrl,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (masters.length === 0) {
    defaultRuntime.log(colorize(rich, theme.error, "No active federation masters found."));
  } else {
    defaultRuntime.log(
      colorize(
        rich,
        theme.success,
        `Found ${masters.length} federation master${masters.length > 1 ? "s" : ""}:`,
      ),
    );
    defaultRuntime.log("");
    for (const m of masters) {
      defaultRuntime.log(`  ${colorize(rich, theme.heading, m.peer.hostname)} → ${m.wsUrl}`);
    }
  }
}

// =============================================================================
// Register CLI
// =============================================================================

export function registerFederationCli(program: Command): void {
  // Top-level connect command
  program
    .command("connect")
    .description("Connect this node to a federation master (supports Tailscale hostnames)")
    .argument("[master-url]", "Master URL, hostname, or Tailscale name (omit to scan)")
    .option("--name <name>", "Display name for this node")
    .option("--workspace <path>", "Workspace directory to advertise")
    .option("--port <port>", "Federation port (default: 47913)")
    .option("--save", "Save configuration to config file", false)
    .option("--scan", "Scan Tailscale network for masters", false)
    .option("--json", "Output JSON", false)
    .action(async (masterUrl: string | undefined, opts: ConnectOptions) => {
      await runConnectCommand(masterUrl, opts);
    });

  // Federation subcommand group
  const federation = program.command("federation").description("Federation management");

  federation
    .command("status")
    .description("Show federation and Tailscale status")
    .option("--json", "Output JSON", false)
    .action(async (opts: StatusOptions) => {
      await runStatusCommand(opts);
    });

  federation
    .command("nodes")
    .description("List connected federation nodes")
    .option("--json", "Output JSON", false)
    .action(async (opts: NodesOptions) => {
      await runNodesCommand(opts);
    });

  federation
    .command("scan")
    .description("Scan Tailscale network for peers and federation masters")
    .option("--port <port>", "Federation port to probe (default: 47913)")
    .option("--json", "Output JSON", false)
    .action(async (opts: ScanOptions) => {
      await runScanCommand(opts);
    });

  federation
    .command("connect")
    .description("Connect this node to a federation master")
    .argument("[master-url]", "Master URL or Tailscale hostname")
    .option("--name <name>", "Display name for this node")
    .option("--workspace <path>", "Workspace directory to advertise")
    .option("--port <port>", "Federation port (default: 47913)")
    .option("--save", "Save configuration to config file", false)
    .option("--scan", "Scan Tailscale network for masters", false)
    .option("--json", "Output JSON", false)
    .action(async (masterUrl: string | undefined, opts: ConnectOptions) => {
      await runConnectCommand(masterUrl, opts);
    });

  // =============================================================================
  // Code Sync Command
  // =============================================================================

  interface CodeSyncOptions {
    dryRun?: boolean;
    remote?: string;
    branch?: string;
    json?: boolean;
  }

  interface CodeSyncStatusOptions {
    json?: boolean;
  }

  federation
    .command("sync")
    .description(
      "Sync code changes across federation devices via Git (push/pull with conflict detection)",
    )
    .option("--dry-run", "Show what would happen without making changes", false)
    .option("--remote <name>", "Git remote to sync with (default: origin)")
    .option("--branch <name>", "Branch to sync (default: main)")
    .option("--json", "Output JSON", false)
    .action(async (opts: CodeSyncOptions) => {
      const rich = isRich();
      const { sync, syncDryRun, statusTable } = await import("../federation/code-sync.js");

      const cfg: Record<string, string> = {};
      if (opts.remote) cfg.remote = opts.remote;
      if (opts.branch) cfg.branch = opts.branch;

      if (opts.dryRun) {
        const result = syncDryRun(cfg);
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
        } else {
          defaultRuntime.log(colorize(rich, theme.muted, `Action:  ${result.action}`));
          defaultRuntime.log(colorize(rich, theme.muted, `Message: ${result.message}`));
          if (result.aheadBefore > 0)
            defaultRuntime.log(
              colorize(rich, theme.muted, `Ahead:   ${result.aheadBefore} commit(s)`),
            );
          if (result.behindBefore > 0)
            defaultRuntime.log(
              colorize(rich, theme.muted, `Behind:  ${result.behindBefore} commit(s)`),
            );
        }
      } else {
        defaultRuntime.log(colorize(rich, theme.muted, "Running federation code sync..."));
        defaultRuntime.log("");
        const result = sync(cfg);
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
        } else {
          const actionColor = result.ok ? theme.success : theme.error;
          defaultRuntime.log(
            `${colorize(rich, theme.muted, "Action:")}  ${colorize(rich, actionColor, result.action)}`,
          );
          defaultRuntime.log(
            `${colorize(rich, theme.muted, "Before:")}  ${result.beforeCommit.slice(0, 12)}`,
          );
          defaultRuntime.log(
            `${colorize(rich, theme.muted, "After:")}   ${result.afterCommit.slice(0, 12)}`,
          );
          defaultRuntime.log(`${colorize(rich, theme.muted, "Message:")} ${result.message}`);
          if (!result.ok) {
            defaultRuntime.log(
              `${colorize(rich, theme.error, "Error:")}   ${result.error || result.message}`,
            );
          }
        }
      }
    });

  // =============================================================================
  // Invite / Join / Invites (master-mints, satellite-redeems)
  // =============================================================================

  federation
    .command("invite")
    .description("Mint a one-command satellite invite (master)")
    .option("--label <name>", "Human label for the satellite (default: hostname)")
    .option("--expires <duration>", "Invite TTL: 30d|12h|60m (default: 30d)")
    .option("--satellite-id <id>", "Override satellite id (default: auto)")
    .option("--master-url <url>", "Override master URL (default: gateway.publicUrl or LAN)")
    .option("--qr", "Print a QR code (skipped when no QR helper is bundled)", false)
    .option("--copy", "Copy the encoded invite to the clipboard", false)
    .option("--json", "Output JSON instead of human text", false)
    .action(
      async (opts: {
        label?: string;
        expires?: string;
        satelliteId?: string;
        masterUrl?: string;
        qr?: boolean;
        copy?: boolean;
        json?: boolean;
      }) => {
        const { mintInvite } = await import("./gateway-cli/federation-invite.js");
        let result;
        try {
          result = mintInvite({
            label: opts.label,
            expires: opts.expires,
            satelliteId: opts.satelliteId,
            masterUrl: opts.masterUrl,
          });
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          defaultRuntime.error(`Failed to mint invite: ${m}`);
          defaultRuntime.exit(1);
          return;
        }

        if (opts.json) {
          defaultRuntime.log(
            JSON.stringify(
              {
                inviteId: result.inviteId,
                fingerprint: result.fingerprint,
                expiresAt: new Date(result.invite.expiresAt).toISOString(),
                label: result.invite.label,
                satelliteId: result.invite.satelliteIdHint,
                masterUrl: result.invite.masterUrl,
                encoded: result.encoded,
              },
              null,
              2,
            ),
          );
          return;
        }

        const rich = isRich();
        defaultRuntime.log(
          colorize(rich, theme.heading, `Satellite invite for: ${result.invite.label}`),
        );
        defaultRuntime.log(`Expires:     ${new Date(result.invite.expiresAt).toLocaleString()}`);
        defaultRuntime.log(`Fingerprint: ${result.fingerprint}`);
        defaultRuntime.log("");
        defaultRuntime.log("Run this on the satellite (after `npm i -g infinibot`):");
        defaultRuntime.log("");
        defaultRuntime.log(`  infinibot federation join ${result.encoded}`);
        defaultRuntime.log("");

        if (opts.qr) {
          defaultRuntime.log("(--qr unavailable in this build)");
        }
        if (opts.copy) {
          try {
            const { copyToClipboard } = await import("../infra/clipboard.js");
            const ok = await copyToClipboard(result.encoded);
            defaultRuntime.log(
              ok ? "Copied to clipboard." : "(clipboard unavailable on this platform)",
            );
          } catch {
            defaultRuntime.log("(clipboard unavailable on this platform)");
          }
        }
      },
    );

  federation
    .command("join <invite>")
    .description("Redeem a federation invite on a satellite")
    .option("--no-restart", "Do not restart the gateway after persisting config")
    .option("--config-only", "Persist config and exit (implies --no-restart)", false)
    .option("--yes", "Skip confirmation prompt", false)
    .action(
      async (
        encoded: string,
        opts: { noRestart?: boolean; configOnly?: boolean; yes?: boolean },
      ) => {
        const { runJoinCommand } = await import("./gateway-cli/federation-join.js");
        try {
          await runJoinCommand({
            encoded,
            yes: opts.yes,
            configOnly: opts.configOnly,
            noRestart: opts.noRestart,
            log: (m) => defaultRuntime.log(m),
            error: (m) => defaultRuntime.error(m),
          });
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          defaultRuntime.error(`Failed to join federation: ${m}`);
          defaultRuntime.exit(1);
        }
      },
    );

  const invitesGroup = federation
    .command("invites")
    .description("List or revoke satellite invites (master)");

  invitesGroup
    .command("list")
    .description("List active satellite invites")
    .option("--json", "Output JSON", false)
    .action(async (opts: { json?: boolean }) => {
      const { readInvites } = await import("../federation/invite-store.js");
      const all = readInvites();
      if (opts.json) {
        defaultRuntime.log(JSON.stringify(all, null, 2));
        return;
      }
      if (all.length === 0) {
        defaultRuntime.log("No invites issued.");
        return;
      }
      for (const r of all) {
        const status = r.revokedAt
          ? "revoked"
          : r.redeemedAt
            ? "redeemed"
            : Date.now() > r.expiresAt
              ? "expired"
              : "active";
        defaultRuntime.log(
          `${r.fingerprint}  ${status.padEnd(8)}  ${r.label ?? "(no label)"}  exp:${new Date(r.expiresAt).toISOString()}`,
        );
      }
    });

  invitesGroup
    .command("revoke <fingerprintOrId>")
    .description("Revoke an invite by fingerprint or invite id")
    .action(async (matcher: string) => {
      const { markRevoked } = await import("../federation/invite-store.js");
      const rec = markRevoked(matcher);
      if (!rec) {
        defaultRuntime.error(`No invite matches: ${matcher}`);
        defaultRuntime.exit(1);
        return;
      }
      try {
        const { getFederationSecurity } = await import("../federation/security.js");
        getFederationSecurity().revokeSatelliteToken(rec.satelliteId);
      } catch {
        // best effort — gateway may not be running in this process
      }
      defaultRuntime.log(`Revoked ${rec.fingerprint} (satellite: ${rec.satelliteId})`);
    });

  federation
    .command("sync-status")
    .description("Show code sync status (HEAD, ahead/behind, uncommitted work)")
    .option("--json", "Output JSON", false)
    .action(async (opts: CodeSyncStatusOptions) => {
      const { getStatus, statusTable } = await import("../federation/code-sync.js");
      const status = getStatus();
      if (opts.json) {
        defaultRuntime.log(JSON.stringify(status, null, 2));
      } else {
        defaultRuntime.log(statusTable());
      }
    });
}
