/**
 * Identity Sync for Federation
 *
 * Synchronizes Infini's personality/soul files and gateway credentials
 * from master node to all connected satellites, ensuring a unified
 * identity across the federation.
 *
 * Files synced:
 * - SOUL.md - Core personality and values
 * - USER.md - User information
 * - AGENTS.md - Agent instructions
 * - IDENTITY.md - Name and avatar
 * - MEMORY.md - Long-term memory
 * - TOOLS.md - Tool configurations
 * - HEARTBEAT.md - Heartbeat tasks
 *
 * Also syncs:
 * - Gateway password (for unified access)
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { FederationHub, ConnectedNode } from "./hub.js";
import type { MemoryFileWatcher } from "./file-watcher.js";

const log = createSubsystemLogger("federation").child("identity-sync");

// =============================================================================
// Types
// =============================================================================

/** Identity files to sync */
export const IDENTITY_FILES = [
  "SOUL.md",
  "USER.md",
  "AGENTS.md",
  "IDENTITY.md",
  "MEMORY.md",
  "TOOLS.md",
  "HEARTBEAT.md",
] as const;

/** Auth profiles to sync (relative to .infinibot/agents/) */
export const AUTH_PROFILE_PATHS = [
  "main/agent/auth-profiles.json",
  "coder/agent/auth-profiles.json",
] as const;

/** Identity sync payload sent to satellites */
export interface IdentitySyncPayload {
  type: "identity.sync";
  /** Identity file contents keyed by filename */
  files: Record<string, string>;
  /** Auth profiles keyed by relative path (e.g., "main/agent/auth-profiles.json") */
  authProfiles?: Record<string, string>;
  /** Gateway password for unified access (optional) */
  gatewayPassword?: string;
  /** API keys for LLM providers + voice services (synced securely from master) */
  apiKeys?: {
    ANTHROPIC_API_KEY?: string;
    OPENAI_API_KEY?: string;
    GOOGLE_API_KEY?: string;
    GEMINI_API_KEY?: string;
    REPLICATE_API_TOKEN?: string;
    XAI_API_KEY?: string;
    /**
     * LiveKit room-server credentials. Satellites that mint voice-call
     * tokens (server-voice-connection.ts) sign with these — without
     * them the satellite uses the `devkey`/`secret` defaults which
     * master's LiveKit container rejects, causing the call to fail to
     * establish or drop immediately. Master sends master's creds; the
     * satellite applies them as env vars so getLivekitCreds() picks
     * them up on every connection-token request.
     */
    LIVEKIT_API_KEY?: string;
    LIVEKIT_API_SECRET?: string;
  };
  /**
   * Shared infinibot.json config blocks pushed verbatim from master to
   * satellites so a freshly-paired satellite sees the same Notion DBs,
   * provider keys, Loops/MCP wiring, etc. without re-running every wizard.
   * Top-level keys mirror the InfinibotConfig shape; satellites overwrite
   * the same keys in their local config on receipt.
   */
  sharedConfig?: {
    notion?: Record<string, unknown>;
    models?: { providers?: Record<string, unknown> };
    loops?: Record<string, unknown>;
    mcpServers?: Record<string, unknown>;
    /**
     * Voice container URLs (Kokoro / Speaches / LiveKit). Optional —
     * satellites auto-derive these from the master's hostname on
     * connect (bootstrapVoiceFromMaster). Master only needs to broadcast
     * this when the voice containers live on a different host or use
     * non-default ports, in which case the satellite's auto-derived
     * URLs would be wrong.
     */
    voice?: Record<string, unknown>;
  };
  /** Master version for auto-update checks */
  version?: string;
  /** Master node ID */
  masterNodeId: string;
  /** Timestamp */
  timestamp: number;
}

/** Identity sync acknowledgment from satellite */
export interface IdentitySyncAck {
  type: "identity.sync.ack";
  nodeId: string;
  filesReceived: string[];
  success: boolean;
  error?: string;
}

/** Identity sync configuration */
export interface IdentitySyncConfig {
  /** Workspace path containing identity files */
  workspace: string;
  /** Whether to sync gateway password */
  syncPassword: boolean;
  /** Gateway password to sync (if syncPassword is true) */
  gatewayPassword?: string;
  /** Whether to sync API keys to satellites (default: true) */
  syncApiKeys?: boolean;
  /**
   * Whether to share infinibot.json config blocks (notion, models.providers,
   * loops, mcpServers) from master to satellites. Default: true — without
   * this, every satellite has to re-run the Notion / provider wizards.
   */
  syncSharedConfig?: boolean;
  /** Files to sync (defaults to IDENTITY_FILES) */
  files?: string[];
}

// =============================================================================
// Identity Sync Manager
// =============================================================================

export class IdentitySyncManager {
  private workspace: string;
  private syncPassword: boolean;
  private syncApiKeys: boolean;
  private syncSharedConfig: boolean;
  private gatewayPassword?: string;
  private files: string[];
  private hub?: FederationHub;
  private nodeId: string;

  constructor(config: IdentitySyncConfig & { nodeId: string }) {
    this.workspace = config.workspace;
    this.syncPassword = config.syncPassword;
    this.syncApiKeys = config.syncApiKeys ?? true; // Default: sync API keys
    this.syncSharedConfig = config.syncSharedConfig ?? true;
    this.gatewayPassword = config.gatewayPassword;
    this.files = config.files ?? [...IDENTITY_FILES];
    this.nodeId = config.nodeId;

    log.info(
      `IdentitySyncManager initialized, files: ${this.files.join(", ")}, syncApiKeys: ${this.syncApiKeys}, syncSharedConfig: ${this.syncSharedConfig}`,
    );
  }

  /**
   * Set the federation hub reference.
   */
  setHub(hub: FederationHub): void {
    this.hub = hub;

    // Listen for new node connections
    hub.on("node:connected", (node: ConnectedNode) => {
      this.pushIdentityToNode(node).catch((err) => {
        log.error(`Failed to push identity to ${node.id}:`, err);
      });
    });

    log.info("IdentitySyncManager attached to hub");
  }

  /**
   * Set the file watcher reference for auto-sync on file changes.
   */
  setFileWatcher(fileWatcher: MemoryFileWatcher): void {
    // Listen for identity file changes and auto-sync to all satellites
    fileWatcher.on("identity:changed", (event: import("./file-watcher.js").FileChangeEvent) => {
      log.info(`Identity file changed: ${event.filePath}, triggering auto-sync`);
      this.pushIdentityToAll().catch((err) => {
        log.error(`Failed to auto-sync identity after ${event.filePath} change:`, err);
      });
    });

    log.info("IdentitySyncManager connected to file watcher for auto-sync");
  }

  /**
   * Update the gateway password.
   */
  setGatewayPassword(password: string): void {
    this.gatewayPassword = password;
    log.debug("Gateway password updated");
  }

  /**
   * Read all identity files from workspace.
   */
  async readIdentityFiles(): Promise<Record<string, string>> {
    const files: Record<string, string> = {};

    for (const filename of this.files) {
      try {
        const filepath = join(this.workspace, filename);
        const content = await readFile(filepath, "utf-8");
        files[filename] = content;
        log.debug(`Read identity file: ${filename} (${content.length} bytes)`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          log.debug(`Identity file not found: ${filename}`);
        } else {
          log.warn(`Failed to read ${filename}:`, err as Record<string, unknown>);
        }
      }
    }

    return files;
  }

  /**
   * Collect API keys from environment AND from the master's infinibot.json
   * `models.providers.<id>.apiKey` entries. The wizard typically stores
   * provider keys in the config file (not env vars), so an env-only sync
   * would leave satellites with no anthropic/openai/etc. credentials —
   * and the embedded agent on a satellite would crash with "No API key
   * found for provider <name>" even though master had one all along.
   *
   * Precedence: env var > config (env wins so a deployment-specific
   * override doesn't get silently downgraded by the persisted wizard
   * value).
   */
  private async collectApiKeys(): Promise<IdentitySyncPayload["apiKeys"]> {
    const keys: IdentitySyncPayload["apiKeys"] = {};

    // Standard env var names used across the codebase. LIVEKIT_* are
    // included so satellites can mint voice-call tokens signed with
    // master's room-server credentials (the satellite-side LiveKit
    // container is master's, not a separate per-node instance).
    const keyNames = [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GOOGLE_API_KEY",
      "GEMINI_API_KEY",
      "REPLICATE_API_TOKEN",
      "XAI_API_KEY",
      "LIVEKIT_API_KEY",
      "LIVEKIT_API_SECRET",
    ] as const;

    // 1) Env first (highest priority).
    for (const name of keyNames) {
      const value = process.env[name];
      if (value) keys[name] = value;
    }

    // 2) Fall back to config — read models.providers.<id>.apiKey for any
    // provider whose canonical env-var name we recognise. Mapping is keyed
    // by provider id (the wizard's convention: lowercase short name).
    const providerToEnv: Record<string, (typeof keyNames)[number]> = {
      anthropic: "ANTHROPIC_API_KEY",
      claude: "ANTHROPIC_API_KEY",
      openai: "OPENAI_API_KEY",
      google: "GOOGLE_API_KEY",
      gemini: "GEMINI_API_KEY",
      replicate: "REPLICATE_API_TOKEN",
      xai: "XAI_API_KEY",
      grok: "XAI_API_KEY",
    };
    try {
      const { readConfigFileSnapshot } = await import("../config/io.js");
      const snapshot = await readConfigFileSnapshot();
      const parsed = snapshot.parsed;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const models = (parsed as Record<string, unknown>).models as
          | { providers?: Record<string, unknown> }
          | undefined;
        const providers = models?.providers;
        if (providers && typeof providers === "object" && !Array.isArray(providers)) {
          for (const [providerId, providerCfg] of Object.entries(providers)) {
            if (!providerCfg || typeof providerCfg !== "object") continue;
            const cfg = providerCfg as Record<string, unknown>;
            const apiKey = typeof cfg.apiKey === "string" ? cfg.apiKey.trim() : "";
            if (!apiKey) continue;
            const envName = providerToEnv[providerId.toLowerCase()];
            if (envName && !keys[envName]) {
              keys[envName] = apiKey;
            }
          }
        }
      }
    } catch (err) {
      log.warn(
        `Failed to read models.providers for API key sync: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const count = Object.keys(keys).length;
    if (count > 0) {
      log.debug(`Collected ${count} API keys for sync (env + config)`);
    }

    return count > 0 ? keys : undefined;
  }

  /**
   * Collect the shared infinibot.json blocks (notion creds + DB ids, model
   * provider definitions, Loops + MCP wiring) so satellites can talk to the
   * same databases + LLM providers + integrations as the master without
   * re-running every wizard. Reads from disk on each call so a wizard that
   * just persisted new config gets picked up by the next push.
   */
  private async collectSharedConfig(): Promise<IdentitySyncPayload["sharedConfig"] | undefined> {
    try {
      const { readConfigFileSnapshot } = await import("../config/io.js");
      const snapshot = await readConfigFileSnapshot();
      const parsed = snapshot.parsed;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
      const root = parsed as Record<string, unknown>;

      const shared: NonNullable<IdentitySyncPayload["sharedConfig"]> = {};

      if (root.notion && typeof root.notion === "object" && !Array.isArray(root.notion)) {
        shared.notion = root.notion as Record<string, unknown>;
      }

      // Only share providers (model defs + provider keys); leave defaults
      // like primary-model selection up to each satellite. The provider
      // block is what carries the API keys + endpoint URLs satellites need.
      if (root.models && typeof root.models === "object" && !Array.isArray(root.models)) {
        const providers = (root.models as Record<string, unknown>).providers;
        if (providers && typeof providers === "object" && !Array.isArray(providers)) {
          shared.models = { providers: providers as Record<string, unknown> };
        }
      }

      if (root.loops && typeof root.loops === "object" && !Array.isArray(root.loops)) {
        shared.loops = root.loops as Record<string, unknown>;
      }

      if (
        root.mcpServers &&
        typeof root.mcpServers === "object" &&
        !Array.isArray(root.mcpServers)
      ) {
        shared.mcpServers = root.mcpServers as Record<string, unknown>;
      }

      // Voice container URLs — only broadcast when master has explicitly
      // configured them in its own infinibot.json. We strip the
      // `autoFromMaster` flag so satellites don't think these are auto-
      // derived (they're operator-pinned on master and should be treated
      // as overrides on the satellite side).
      if (root.voice && typeof root.voice === "object" && !Array.isArray(root.voice)) {
        const v = { ...(root.voice as Record<string, unknown>) };
        delete v.autoFromMaster;
        delete v.masterHost;
        // Only include if there's a real URL to send (skip when the
        // master's own voice block is just the auto-derived flags).
        if (
          typeof v.kokoroUrl === "string" ||
          typeof v.speachesUrl === "string" ||
          typeof v.livekitUrl === "string" ||
          typeof v.livekitUrlExternal === "string"
        ) {
          shared.voice = v;
        }
      }

      const blockCount = Object.keys(shared).length;
      if (blockCount === 0) return undefined;
      log.debug(
        `Collected ${blockCount} shared config block(s) for sync: ${Object.keys(shared).join(", ")}`,
      );
      return shared;
    } catch (err) {
      log.warn("Failed to collect shared config blocks:", err as Record<string, unknown>);
      return undefined;
    }
  }

  /**
   * Build the identity sync payload.
   */
  async buildSyncPayload(): Promise<IdentitySyncPayload> {
    const files = await this.readIdentityFiles();

    const payload: IdentitySyncPayload = {
      type: "identity.sync",
      files,
      masterNodeId: this.nodeId,
      timestamp: Date.now(),
    };

    if (this.syncPassword && this.gatewayPassword) {
      payload.gatewayPassword = this.gatewayPassword;
    }

    // Include API keys for satellites to use
    if (this.syncApiKeys) {
      const apiKeys = await this.collectApiKeys();
      if (apiKeys) {
        payload.apiKeys = apiKeys;
        log.info(`Including ${Object.keys(apiKeys).length} API keys in identity sync`);
      }
    }

    // Include shared infinibot.json blocks (notion, model providers,
    // loops, mcpServers) so satellites use the same databases + integrations.
    if (this.syncSharedConfig) {
      const sharedConfig = await this.collectSharedConfig();
      if (sharedConfig) {
        payload.sharedConfig = sharedConfig;
        log.info(
          `Including shared config blocks in identity sync: ${Object.keys(sharedConfig).join(", ")}`,
        );
      }
    }

    // Include version for auto-update checks
    try {
      const pkgPath = new URL("../../package.json", import.meta.url);
      const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
      payload.version = pkg.version;
      log.debug(`Including version ${pkg.version} in identity sync`);
    } catch {
      log.warn("Could not read package.json for version sync");
    }

    // Include auth profiles for agent authentication
    const authProfiles = await this.readAuthProfiles();
    if (Object.keys(authProfiles).length > 0) {
      payload.authProfiles = authProfiles;
      log.info(`Including ${Object.keys(authProfiles).length} auth profiles in identity sync`);
    }

    return payload;
  }

  /**
   * Read auth profiles from .infinibot/agents directory.
   */
  private async readAuthProfiles(): Promise<Record<string, string>> {
    const profiles: Record<string, string> = {};
    const homeDir = process.env.HOME || process.env.USERPROFILE || "";
    const agentsDir = join(homeDir, ".infinibot", "agents");

    for (const relPath of AUTH_PROFILE_PATHS) {
      try {
        const fullPath = join(agentsDir, relPath);
        const content = await readFile(fullPath, "utf-8");
        profiles[relPath] = content;
        log.debug(`Read auth profile: ${relPath}`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          log.warn(`Failed to read auth profile ${relPath}:`, err as Record<string, unknown>);
        }
      }
    }

    return profiles;
  }

  /**
   * Push identity to a specific node.
   */
  async pushIdentityToNode(node: ConnectedNode): Promise<void> {
    if (!this.hub) {
      log.warn("No hub available for identity push");
      return;
    }

    log.info(`Pushing identity to node: ${node.manifest.name} (${node.id})`);

    try {
      const payload = await this.buildSyncPayload();

      // Send via WebSocket
      node.socket.send(
        JSON.stringify({
          type: "identity.sync",
          payload,
          nodeId: this.nodeId,
          timestamp: Date.now(),
        }),
      );

      log.info(`Identity pushed to ${node.id}: ${Object.keys(payload.files).length} files`);
    } catch (err) {
      log.error(`Failed to push identity to ${node.id}:`, err as Record<string, unknown>);
      throw err;
    }
  }

  /**
   * Push identity to all connected nodes.
   */
  async pushIdentityToAll(): Promise<{ success: number; failed: number }> {
    if (!this.hub) {
      log.warn("No hub available for identity push");
      return { success: 0, failed: 0 };
    }

    const nodes = this.hub.getConnectedNodes();
    let success = 0;
    let failed = 0;

    for (const node of nodes) {
      try {
        await this.pushIdentityToNode(node);
        success++;
      } catch {
        failed++;
      }
    }

    log.info(`Identity pushed to ${success}/${nodes.length} nodes`);
    return { success, failed };
  }

  /**
   * Handle incoming identity sync (on satellite side).
   */
  async handleIdentitySync(payload: IdentitySyncPayload): Promise<IdentitySyncAck> {
    log.info(`Receiving identity sync from master ${payload.masterNodeId}`);

    const received: string[] = [];
    let success = true;
    let error: string | undefined;

    try {
      // Write identity files
      for (const [filename, content] of Object.entries(payload.files)) {
        try {
          const filepath = join(this.workspace, filename);
          await mkdir(dirname(filepath), { recursive: true });
          await writeFile(filepath, content, "utf-8");
          received.push(filename);
          log.debug(`Wrote identity file: ${filename}`);
        } catch (err) {
          log.error(`Failed to write ${filename}:`, err as Record<string, unknown>);
        }
      }

      // Apply gateway password if provided
      if (payload.gatewayPassword) {
        // This would need to update the config - emit an event for the gateway to handle
        log.info("Gateway password received from master");
        // The gateway should listen for this and update its config
        this.emit?.("password:sync", payload.gatewayPassword);
      }

      log.info(`Identity sync complete: ${received.length} files written`);
    } catch (err) {
      success = false;
      error = (err as Error).message;
      log.error("Identity sync failed:", err as Record<string, unknown>);
    }

    return {
      type: "identity.sync.ack",
      nodeId: this.nodeId,
      filesReceived: received,
      success,
      error,
    };
  }

  // EventEmitter-like emit for password sync
  private emit?: (event: string, data: unknown) => void;

  /**
   * Set event emitter for password sync notifications.
   */
  setEmitter(emit: (event: string, data: unknown) => void): void {
    this.emit = emit;
  }
}

// =============================================================================
// Singleton
// =============================================================================

let defaultIdentitySyncManager: IdentitySyncManager | null = null;

/**
 * Get the identity sync manager.
 */
export function getIdentitySyncManager(): IdentitySyncManager | null {
  return defaultIdentitySyncManager;
}

/**
 * Initialize the identity sync manager.
 */
export function initIdentitySyncManager(
  config: IdentitySyncConfig & { nodeId: string },
): IdentitySyncManager {
  if (defaultIdentitySyncManager) {
    log.warn("IdentitySyncManager already initialized");
    return defaultIdentitySyncManager;
  }
  defaultIdentitySyncManager = new IdentitySyncManager(config);
  return defaultIdentitySyncManager;
}

/**
 * Stop the identity sync manager.
 */
export function stopIdentitySyncManager(): void {
  defaultIdentitySyncManager = null;
}
