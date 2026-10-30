/**
 * Satellite CLI - Simple one-command satellite connection
 *
 * Usage: infinibot satellite <master-url>
 * Example: infinibot satellite 192.168.1.130:18789
 */

import { hostname } from "node:os";
import { resolve } from "node:path";
import fs from "node:fs";
import type { Command } from "commander";
import { CONFIG_PATH } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runSatelliteMode } from "./gateway-cli/satellite.js";
import { defaultRuntime } from "../runtime.js";

const log = createSubsystemLogger("satellite");

interface SatelliteCLIOptions {
  name?: string;
  port?: string;
  save?: boolean;
  autoDiscover?: boolean;
  discoveryTimeout?: string;
}

function formatMasterUrl(input: string): string {
  let url = input.trim();

  // Map http(s):// to ws(s)://, add ws:// if no protocol at all.
  // Blindly prepending ws:// to an https:// URL yields a URL whose
  // hostname is literally "https" — guaranteed ENOTFOUND.
  if (url.startsWith("http://")) {
    url = `ws://${url.slice("http://".length)}`;
  } else if (url.startsWith("https://")) {
    url = `wss://${url.slice("https://".length)}`;
  } else if (!url.startsWith("ws://") && !url.startsWith("wss://")) {
    url = `ws://${url}`;
  }

  // Add /federation path if missing
  try {
    const parsed = new URL(url);
    if (!parsed.pathname || parsed.pathname === "/") {
      parsed.pathname = "/federation";
    }
    return parsed.toString();
  } catch {
    throw new Error(`Invalid master URL: ${input}`);
  }
}

function saveConfig(masterUrl: string, nodeName: string): void {
  const configPath = CONFIG_PATH;
  let config: Record<string, unknown> = {};

  // Load existing config if it exists
  try {
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    }
  } catch {
    // Start fresh if config is invalid
    config = {};
  }

  // Update federation config
  config.federation = {
    enabled: true,
    mode: "satellite",
    masterUrl,
    nodeName,
  };

  // Ensure directory exists
  const configDir = resolve(configPath, "..");
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  // Write config
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  log.info(`Config saved to ${configPath}`);
}

async function runSatelliteCommand(
  masterInput: string | undefined,
  opts: SatelliteCLIOptions,
): Promise<void> {
  try {
    const nodeName = opts.name ?? hostname();
    const port = opts.port ? parseInt(opts.port, 10) : undefined;
    const discoveryTimeoutMs = opts.discoveryTimeout
      ? parseInt(opts.discoveryTimeout, 10) * 1000
      : 10000;

    let masterUrl: string;

    // Handle auto-discovery
    if (opts.autoDiscover || masterInput === "auto" || !masterInput) {
      console.log(`
╔══════════════════════════════════════════════════════════════╗
║  🛰️  MOLTBOT SATELLITE MODE - AUTO DISCOVERY                  ║
╠══════════════════════════════════════════════════════════════╣
║  Discovering masters via mDNS...                            ║
║  Timeout: ${(discoveryTimeoutMs / 1000).toString().padEnd(48)} seconds ║
╚══════════════════════════════════════════════════════════════╝
`);

      masterUrl = "auto"; // This will trigger auto-discovery in the satellite
    } else {
      masterUrl = formatMasterUrl(masterInput);
    }

    if (!opts.autoDiscover && masterInput !== "auto" && masterInput) {
      console.log(`
╔══════════════════════════════════════════════════════════════╗
║  🛰️  MOLTBOT SATELLITE MODE                                   ║
╠══════════════════════════════════════════════════════════════╣
║  Master:  ${masterUrl.padEnd(48)} ║
║  Node:    ${nodeName.padEnd(48)} ║
║  Port:    ${(port ?? 18789).toString().padEnd(48)} ║
╚══════════════════════════════════════════════════════════════╝
`);
    }

    // Save config if requested (or by default)
    if (opts.save !== false) {
      saveConfig(masterUrl, nodeName);
    }

    // Run satellite mode
    const result = await runSatelliteMode(
      {
        masterUrl,
        nodeName,
        port,
        workspace: process.cwd(),
        verbose: true,
        autoDiscover: opts.autoDiscover || masterInput === "auto" || !masterInput,
        discoveryTimeoutMs,
      },
      defaultRuntime,
    );

    console.log(`\n✅ Connected to master federation hub`);
    console.log(`   Local gateway running on port ${port ?? 18789}`);
    console.log(`   Press Ctrl+C to stop\n`);

    // Keep running until interrupted
    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => {
        console.log("\n🛑 Shutting down...");
        void result.close().then(resolve);
      });
      process.on("SIGTERM", () => {
        void result.close().then(resolve);
      });
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ Failed to start satellite: ${message}\n`);
    process.exit(1);
  }
}

export function registerSatelliteCli(program: Command): void {
  program
    .command("satellite [master]")
    .description("Connect to a master gateway as a satellite node")
    .option("-n, --name <name>", "Node name (defaults to hostname)")
    .option("-p, --port <port>", "Local gateway port (default: 18789)")
    .option("--no-save", "Don't save config (one-time connection)")
    .option("--auto-discover", "Auto-discover master via mDNS (ignores master parameter)")
    .option("--discovery-timeout <seconds>", "Discovery timeout in seconds (default: 10)", "10")
    .addHelpText(
      "after",
      `
Examples:
  infinibot satellite 192.168.1.130:18789        Connect to master on LAN
  infinibot satellite 192.168.1.130              Uses default port 18789
  infinibot satellite ws://master.local:18789  Explicit WebSocket URL
  infinibot satellite 10.0.0.1 --name Robo2    Custom node name
  infinibot satellite 192.168.1.130 --no-save    Don't save to config
  
  Auto-discovery via mDNS:
  infinibot satellite --auto-discover           Discover master automatically
  infinibot satellite auto                      Same as --auto-discover
  infinibot satellite --auto-discover --discovery-timeout 30  Wait 30 seconds for discovery

The satellite will:
  1. Connect to the master's federation hub (auto-discovered or specified)
  2. Start a local gateway for direct client connections
  3. Sync state with the master
  4. Route tasks as directed by the master
`,
    )
    .action(runSatelliteCommand);
}
