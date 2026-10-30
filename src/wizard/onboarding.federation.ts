/**
 * Federation Onboarding
 *
 * Allows users to choose between standalone mode or connecting as a federation node
 * to a master gateway. When connected as a federation node, memories and soul files
 * are synced from the master.
 */

import { hostname } from "node:os";
import { WebSocket } from "ws";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { InfinibotConfig } from "../config/config.js";
import type { WizardPrompter } from "./prompts.js";
import { resolveDisplayName } from "../cli/cli-name.js";

const log = createSubsystemLogger("wizard").child("federation");

// =============================================================================
// Types
// =============================================================================

export type FederationSetupMode = "standalone" | "federation-node";

export interface FederationSetupResult {
  mode: FederationSetupMode;
  config: InfinibotConfig;
  /** Master URL if federation node */
  masterUrl?: string;
  /** Node name for federation */
  nodeName?: string;
}

// =============================================================================
// Federation Setup
// =============================================================================

/**
 * Test connection to a master gateway.
 */
async function testMasterConnection(masterUrl: string): Promise<{
  ok: boolean;
  error?: string;
  nodeName?: string;
}> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve({ ok: false, error: "Connection timeout (10s)" });
    }, 10000);

    try {
      // Convert HTTP URL to WebSocket if needed
      let wsUrl = masterUrl.trim();
      if (wsUrl.startsWith("http://")) {
        wsUrl = wsUrl.replace("http://", "ws://");
      } else if (wsUrl.startsWith("https://")) {
        wsUrl = wsUrl.replace("https://", "wss://");
      }

      // Append /federation path if not present
      if (!wsUrl.includes("/federation")) {
        wsUrl = wsUrl.replace(/\/$/, "") + "/federation";
      }

      const ws = new WebSocket(wsUrl);

      ws.on("open", () => {
        clearTimeout(timeout);
        // Send a probe message
        ws.send(
          JSON.stringify({
            type: "node.probe",
            payload: {},
            nodeId: "onboarding-probe",
            timestamp: Date.now(),
          }),
        );

        // Give it a moment to respond then close
        setTimeout(() => {
          ws.close();
          resolve({ ok: true });
        }, 500);
      });

      ws.on("error", (err) => {
        clearTimeout(timeout);
        resolve({ ok: false, error: err.message });
      });

      ws.on("close", () => {
        // If we get here from timeout, it's already resolved
      });
    } catch (err) {
      clearTimeout(timeout);
      resolve({ ok: false, error: (err as Error).message });
    }
  });
}

/**
 * Prompt user for federation setup.
 */
export async function setupFederation(params: {
  config: InfinibotConfig;
  prompter: WizardPrompter;
  quickstart: boolean;
  nodeName?: string;
  /** Non-interactive federation mode */
  federationMode?: "standalone" | "satellite";
  /** Non-interactive master URL */
  federationMasterUrl?: string;
  /** Non-interactive node name */
  federationNodeName?: string;
}): Promise<FederationSetupResult> {
  const {
    config,
    prompter,
    quickstart,
    nodeName,
    federationMode,
    federationMasterUrl,
    federationNodeName,
  } = params;

  // Handle non-interactive mode
  if (federationMode) {
    if (federationMode === "standalone") {
      return {
        mode: "standalone",
        config: {
          ...config,
          federation: {
            enabled: false,
            mode: "standalone",
          },
        },
      };
    }

    if (federationMode === "satellite") {
      if (!federationMasterUrl) {
        throw new Error(
          "--federation-master-url is required when using --federation-mode satellite",
        );
      }

      let normalizedUrl = federationMasterUrl.trim();
      if (!normalizedUrl.includes("://")) {
        normalizedUrl = `ws://${normalizedUrl}`;
      }

      const finalNodeName = federationNodeName ?? nodeName ?? hostname();

      return {
        mode: "federation-node",
        config: {
          ...config,
          federation: {
            enabled: true,
            mode: "satellite",
            masterUrl: normalizedUrl,
            nodeName: finalNodeName,
            discovery: true,
            delegate: ["mcp"],
          },
        },
        masterUrl: normalizedUrl,
        nodeName: finalNodeName,
      };
    }
  }

  // Check if federation is already configured
  const existingFederation = config.federation;
  const hasExistingFederation =
    existingFederation?.mode === "satellite" && existingFederation?.masterUrl;

  // In quickstart mode, default to standalone unless already configured
  if (quickstart && !hasExistingFederation) {
    return {
      mode: "standalone",
      config,
    };
  }

  // Show federation info
  await prompter.note(
    [
      `${resolveDisplayName()} supports federation - connecting multiple devices to work as one.`,
      "",
      "**Standalone Mode** (default):",
      "  - Independent setup with local memories and personality files",
      "  - No connection to other gateways",
      "",
      "**Federation Node Mode**:",
      "  - Connects to a master gateway",
      "  - Syncs SOUL.md, USER.md, MEMORY.md, and other identity files from master",
      "  - Shares sessions, tasks, and state with the federation",
      "  - Uses master's MCP servers and capabilities",
    ].join("\n"),
    "Federation Setup",
  );

  // If already configured as federation node, offer to keep settings
  if (hasExistingFederation) {
    const keepExisting = await prompter.confirm({
      message: `Keep existing federation connection to ${existingFederation.masterUrl}?`,
      initialValue: true,
    });

    if (keepExisting) {
      return {
        mode: "federation-node",
        config,
        masterUrl: existingFederation.masterUrl,
        nodeName: existingFederation.nodeName,
      };
    }
  }

  // Choose federation mode
  const mode = (await prompter.select({
    message: "How should this device operate?",
    options: [
      {
        value: "standalone",
        label: "Standalone",
        hint: "Independent setup with local files",
      },
      {
        value: "federation-node",
        label: "Federation Node",
        hint: "Connect to master, sync memories and soul files",
      },
    ],
    initialValue: "standalone",
  })) as FederationSetupMode;

  if (mode === "standalone") {
    // Clear any existing federation config
    const nextConfig: InfinibotConfig = {
      ...config,
      federation: {
        enabled: false,
        mode: "standalone",
      },
    };

    return {
      mode: "standalone",
      config: nextConfig,
    };
  }

  // Federation node setup
  const masterUrl = await prompter.text({
    message: "Master gateway URL",
    placeholder: "ws://192.168.1.100:47913",
    initialValue: existingFederation?.masterUrl ?? "",
    validate: (value) => {
      if (!value.trim()) {
        return "Master URL is required";
      }
      // Basic URL validation
      if (!value.includes("://") && !value.match(/^\d+\.\d+\.\d+\.\d+:\d+$/)) {
        return "Enter a valid URL (e.g., ws://192.168.1.100:47913 or 192.168.1.100:47913)";
      }
      return undefined;
    },
  });

  // Normalize URL
  let normalizedUrl = masterUrl.trim();
  if (!normalizedUrl.includes("://")) {
    normalizedUrl = `ws://${normalizedUrl}`;
  }

  // Test connection
  await prompter.note("Testing connection to master gateway...", "Connection Test");
  const testResult = await testMasterConnection(normalizedUrl);

  if (!testResult.ok) {
    const proceed = await prompter.confirm({
      message: `Could not connect to master: ${testResult.error}. Continue anyway?`,
      initialValue: false,
    });

    if (!proceed) {
      // Fall back to standalone
      return {
        mode: "standalone",
        config: {
          ...config,
          federation: {
            enabled: false,
            mode: "standalone",
          },
        },
      };
    }
  } else {
    await prompter.note("✓ Successfully connected to master gateway", "Connection Test");
  }

  // Node name
  const finalNodeName =
    nodeName ??
    (await prompter.text({
      message: "Name for this node (shown in federation)",
      placeholder: hostname(),
      initialValue: existingFederation?.nodeName ?? hostname(),
    }));

  // What to sync
  const syncOptions = await prompter.multiselect<string>({
    message: "What should sync from master?",
    options: [
      { value: "identity", label: "Identity files", hint: "SOUL.md, USER.md, IDENTITY.md" },
      { value: "memory", label: "Memory files", hint: "MEMORY.md, AGENTS.md" },
      { value: "tools", label: "Tool configs", hint: "TOOLS.md, HEARTBEAT.md" },
      {
        value: "databases",
        label: "Databases & API config",
        hint: "Notion creds + DB ids, provider keys, Loops, MCP servers",
      },
      { value: "password", label: "Gateway password", hint: "Use same password as master" },
    ],
    initialValues: ["identity", "memory", "tools", "databases"],
  });

  // Build federation config
  const nextConfig: InfinibotConfig = {
    ...config,
    federation: {
      enabled: true,
      mode: "satellite",
      masterUrl: normalizedUrl,
      nodeName: finalNodeName,
      discovery: true,
      // Store sync preferences for identity sync manager
      delegate: ["mcp"], // Default to delegating MCP to master
    },
  };

  await prompter.note(
    [
      "Federation node configured!",
      "",
      `Master: ${normalizedUrl}`,
      `Node name: ${finalNodeName}`,
      `Syncing: ${syncOptions
        .map((s) => {
          if (s === "identity") return "identity files";
          if (s === "memory") return "memory files";
          if (s === "tools") return "tool configs";
          if (s === "databases") return "databases & API config";
          if (s === "password") return "gateway password";
          return s;
        })
        .join(", ")}`,
      "",
      "On startup, this node will:",
      "  1. Connect to the master gateway",
      "  2. Receive identity/memory files + shared config (Notion creds + DB ids, provider keys, Loops, MCP servers) from master",
      "  3. Sync state and share capabilities",
    ].join("\n"),
    "Federation Ready",
  );

  return {
    mode: "federation-node",
    config: nextConfig,
    masterUrl: normalizedUrl,
    nodeName: finalNodeName,
  };
}

/**
 * Quick check if federation should be prompted in quickstart mode.
 * Returns true if we should skip (standalone by default).
 */
export function shouldSkipFederationPrompt(config: InfinibotConfig): boolean {
  // Skip if already configured as satellite
  if (config.federation?.mode === "satellite" && config.federation?.masterUrl) {
    return true;
  }
  return false;
}
