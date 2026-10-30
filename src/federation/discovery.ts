/**
 * Federation Discovery - mDNS Advertisement and Scanning
 *
 * Provides automatic discovery of federation master nodes via mDNS/Bonjour.
 * Masters advertise their federation service on the local network, and satellites
 * can automatically discover and connect without manual IP configuration.
 */

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { EventEmitter } from "node:events";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { NodeCapabilities } from "./types.js";

// Import mDNS library (@homebridge/ciao is already in dependencies)
let ciao: typeof import("@homebridge/ciao") | null = null;

/**
 * Lazy load the mDNS library
 */
async function loadCiao(): Promise<typeof import("@homebridge/ciao") | null> {
  if (ciao !== null) {
    return ciao;
  }

  try {
    ciao = await import("@homebridge/ciao");
    return ciao;
  } catch (err) {
    console.warn("mDNS discovery not available:", err);
    return null;
  }
}

const log = createSubsystemLogger("federation").child("discovery");

// =============================================================================
// Types
// =============================================================================

/** mDNS Service Configuration */
export interface MDNSServiceConfig {
  /** Service type (default: _infinibot-federation._tcp) */
  serviceType?: string;
  /** Federation port */
  port: number;
  /** Node ID */
  nodeId: string;
  /** Node name for display */
  nodeName?: string;
  /** Protocol version */
  version?: string;
  /** Node capabilities (encoded as TXT record) */
  capabilities?: Partial<NodeCapabilities>;
  /** Additional TXT record data */
  txtData?: Record<string, string>;
}

/** Discovered Master Node */
export interface DiscoveredMaster {
  /** Node ID */
  nodeId: string;
  /** Node name */
  nodeName: string;
  /** Host/IP address */
  host: string;
  /** Federation port */
  port: number;
  /** Protocol version */
  version: string;
  /** Capabilities */
  capabilities: string[];
  /** Full WebSocket URL */
  wsUrl: string;
  /** Additional TXT data */
  txtData: Record<string, string>;
  /** Discovery timestamp */
  discoveredAt: number;
}

/** Discovery Events */
export interface DiscoveryEvents {
  /** Master node discovered */
  "master-discovered": [master: DiscoveredMaster];
  /** Master node lost */
  "master-lost": [nodeId: string];
  /** Discovery started */
  "discovery-started": [];
  /** Discovery stopped */
  "discovery-stopped": [];
  /** Error occurred */
  error: [error: Error];
}

// =============================================================================
// Constants
// =============================================================================

/** Default mDNS service type for InfiniBot Federation */
export const DEFAULT_SERVICE_TYPE = "_infinibot-federation._tcp";

/** Default mDNS domain */
export const DEFAULT_DOMAIN = "local";

/** Capability encoding separator */
export const CAPABILITY_SEPARATOR = ",";

/** Maximum TXT record value length (mDNS limitation) */
export const MAX_TXT_VALUE_LENGTH = 255;

// =============================================================================
// Federation Discovery Manager
// =============================================================================

/**
 * Manages mDNS advertisement and discovery for federation nodes
 */
export class FederationDiscoveryManager extends EventEmitter<DiscoveryEvents> {
  private advertiser?: any; // ciao.Responder
  private browser?: any; // ciao.Browser
  private discoveredMasters = new Map<string, DiscoveredMaster>();
  private isAdvertising = false;
  private isScanning = false;

  constructor() {
    super();
  }

  /**
   * Start advertising this node as a master
   */
  async startAdvertising(config: MDNSServiceConfig): Promise<void> {
    const ciao = await loadCiao();
    if (!ciao) {
      throw new Error("mDNS library not available - cannot advertise");
    }

    if (this.isAdvertising) {
      log.warn("Already advertising - stopping previous advertisement");
      await this.stopAdvertising();
    }

    const serviceType = config.serviceType ?? DEFAULT_SERVICE_TYPE;
    const nodeName = config.nodeName ?? hostname();

    try {
      // Create mDNS responder
      this.advertiser = ciao.getResponder();

      // Encode capabilities for TXT record
      const capabilities = this.encodeCapabilities(config.capabilities);

      // Prepare TXT record data
      const txtData = {
        version: config.version ?? "1.0",
        nodeId: config.nodeId,
        nodeName,
        capabilities,
        ...config.txtData,
      };

      // Validate TXT record size
      this.validateTxtData(txtData);

      // Create and advertise the service
      const service = this.advertiser.createService({
        name: nodeName,
        type: serviceType,
        port: config.port,
        txt: txtData,
      });

      await service.advertise();

      this.isAdvertising = true;

      log.info("mDNS advertisement started", {
        serviceType,
        port: config.port,
        nodeId: config.nodeId,
        nodeName,
        capabilities: config.capabilities,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error("Failed to start mDNS advertisement", { error: error.message });
      throw new Error(`Failed to start mDNS advertisement: ${error.message}`);
    }
  }

  /**
   * Stop advertising this node
   */
  async stopAdvertising(): Promise<void> {
    if (!this.isAdvertising || !this.advertiser) {
      return;
    }

    try {
      await this.advertiser.destroy();
      this.advertiser = undefined;
      this.isAdvertising = false;

      log.info("mDNS advertisement stopped");
    } catch (err) {
      log.error("Error stopping mDNS advertisement", { error: err });
    }
  }

  /**
   * Start scanning for master nodes
   */
  async startScanning(serviceType?: string): Promise<void> {
    const ciao = await loadCiao();
    if (!ciao) {
      throw new Error("mDNS library not available - cannot scan");
    }

    if (this.isScanning) {
      log.warn("Already scanning - stopping previous scan");
      await this.stopScanning();
    }

    const type = serviceType ?? DEFAULT_SERVICE_TYPE;

    try {
      // Create mDNS browser via responder
      // Note: @homebridge/ciao doesn't expose a public browser API in its types,
      // but the underlying implementation supports it via the responder.
      const responder = ciao.getResponder() as any;
      this.browser = responder.createServiceBrowser(type);

      // Handle service discoveries
      this.browser.on("serviceUp", (service: any) => {
        this.handleServiceUp(service);
      });

      this.browser.on("serviceDown", (service: any) => {
        this.handleServiceDown(service);
      });

      this.browser.on("serviceChanged", (service: any) => {
        this.handleServiceChanged(service);
      });

      // Start browsing
      await this.browser.start();

      this.isScanning = true;
      this.emit("discovery-started");

      log.info("mDNS scanning started", { serviceType: type });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error("Failed to start mDNS scanning", { error: error.message });
      throw new Error(`Failed to start mDNS scanning: ${error.message}`);
    }
  }

  /**
   * Stop scanning for master nodes
   */
  async stopScanning(): Promise<void> {
    if (!this.isScanning || !this.browser) {
      return;
    }

    try {
      await this.browser.stop();
      this.browser = undefined;
      this.isScanning = false;
      this.discoveredMasters.clear();
      this.emit("discovery-stopped");

      log.info("mDNS scanning stopped");
    } catch (err) {
      log.error("Error stopping mDNS scanning", { error: err });
    }
  }

  /**
   * Get all currently discovered master nodes
   */
  getDiscoveredMasters(): DiscoveredMaster[] {
    return Array.from(this.discoveredMasters.values());
  }

  /**
   * Get a specific discovered master by node ID
   */
  getDiscoveredMaster(nodeId: string): DiscoveredMaster | undefined {
    return this.discoveredMasters.get(nodeId);
  }

  /**
   * Check if we're currently advertising
   */
  isCurrentlyAdvertising(): boolean {
    return this.isAdvertising;
  }

  /**
   * Check if we're currently scanning
   */
  isCurrentlyScanning(): boolean {
    return this.isScanning;
  }

  /**
   * Cleanup - stop all operations
   */
  async destroy(): Promise<void> {
    const promises: Promise<void>[] = [];

    if (this.isAdvertising) {
      promises.push(this.stopAdvertising());
    }

    if (this.isScanning) {
      promises.push(this.stopScanning());
    }

    await Promise.all(promises);
    this.removeAllListeners();
  }

  // =============================================================================
  // Private Methods
  // =============================================================================

  /**
   * Handle mDNS service discovered
   */
  private handleServiceUp(service: any): void {
    try {
      const master = this.parseDiscoveredService(service);
      if (master) {
        this.discoveredMasters.set(master.nodeId, master);
        this.emit("master-discovered", master);

        log.info("Master node discovered", {
          nodeId: master.nodeId,
          nodeName: master.nodeName,
          host: master.host,
          port: master.port,
          wsUrl: master.wsUrl,
        });
      }
    } catch (err) {
      log.error("Error parsing discovered service", { error: err, service });
    }
  }

  /**
   * Handle mDNS service lost
   */
  private handleServiceDown(service: any): void {
    try {
      const nodeId = service.txt?.nodeId;
      if (nodeId && this.discoveredMasters.has(nodeId)) {
        this.discoveredMasters.delete(nodeId);
        this.emit("master-lost", nodeId);

        log.info("Master node lost", { nodeId, serviceName: service.name });
      }
    } catch (err) {
      log.error("Error handling service down", { error: err, service });
    }
  }

  /**
   * Handle mDNS service changed
   */
  private handleServiceChanged(service: any): void {
    try {
      // Treat as a new discovery
      this.handleServiceUp(service);
    } catch (err) {
      log.error("Error handling service changed", { error: err, service });
    }
  }

  /**
   * Parse discovered mDNS service into DiscoveredMaster
   */
  private parseDiscoveredService(service: any): DiscoveredMaster | null {
    const { name, host, port, txt = {} } = service;

    // Required fields
    const nodeId = txt.nodeId;
    if (!nodeId || !host || !port) {
      log.debug("Incomplete service discovery - missing required fields", {
        nodeId,
        host,
        port,
        name,
      });
      return null;
    }

    // Parse capabilities
    const capabilityString = txt.capabilities || "";
    const capabilities = capabilityString
      .split(CAPABILITY_SEPARATOR)
      .map((cap: string) => cap.trim())
      .filter((cap: string) => cap.length > 0);

    // Build WebSocket URL
    const wsUrl = `ws://${host}:${port}/federation`;

    const master: DiscoveredMaster = {
      nodeId,
      nodeName: txt.nodeName || name || nodeId,
      host,
      port,
      version: txt.version || "unknown",
      capabilities,
      wsUrl,
      txtData: txt,
      discoveredAt: Date.now(),
    };

    return master;
  }

  /**
   * Encode capabilities for TXT record
   */
  private encodeCapabilities(capabilities?: Partial<NodeCapabilities>): string {
    if (!capabilities) {
      return "";
    }

    const capList: string[] = [];

    // Add individual capability flags
    Object.entries(capabilities).forEach(([key, value]) => {
      if (value === true) {
        capList.push(key);
      } else if (typeof value === "string") {
        capList.push(`${key}:${value}`);
      } else if (Array.isArray(value)) {
        value.forEach((item) => {
          if (typeof item === "string") {
            capList.push(`${key}:${item}`);
          }
        });
      }
    });

    const encoded = capList.join(CAPABILITY_SEPARATOR);

    // Ensure we don't exceed mDNS TXT record limits
    if (encoded.length > MAX_TXT_VALUE_LENGTH) {
      log.warn("Capabilities string too long for mDNS TXT record", {
        length: encoded.length,
        maxLength: MAX_TXT_VALUE_LENGTH,
      });
      return encoded.substring(0, MAX_TXT_VALUE_LENGTH);
    }

    return encoded;
  }

  /**
   * Validate TXT record data size
   */
  private validateTxtData(txtData: Record<string, string>): void {
    for (const [key, value] of Object.entries(txtData)) {
      if (value.length > MAX_TXT_VALUE_LENGTH) {
        log.warn(`TXT record value too long for key '${key}'`, {
          key,
          length: value.length,
          maxLength: MAX_TXT_VALUE_LENGTH,
        });
      }
    }
  }
}

// =============================================================================
// Convenience Functions
// =============================================================================

/**
 * Create and configure a discovery manager for master mode
 */
export async function createMasterDiscovery(
  config: MDNSServiceConfig,
): Promise<FederationDiscoveryManager> {
  const discovery = new FederationDiscoveryManager();
  await discovery.startAdvertising(config);
  return discovery;
}

/**
 * Create and configure a discovery manager for satellite mode
 */
export async function createSatelliteDiscovery(
  serviceType?: string,
): Promise<FederationDiscoveryManager> {
  const discovery = new FederationDiscoveryManager();
  await discovery.startScanning(serviceType);
  return discovery;
}

/**
 * Scan for masters and return the first one found (with timeout)
 */
export async function discoverMaster(
  timeoutMs: number = 10000,
  serviceType?: string,
): Promise<DiscoveredMaster | null> {
  const discovery = new FederationDiscoveryManager();

  return new Promise((resolve) => {
    let resolved = false;

    // Timeout handler
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        void discovery.destroy().finally(() => resolve(null));
      }
    }, timeoutMs);

    // Success handler
    discovery.once("master-discovered", (master) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        void discovery.destroy().finally(() => resolve(master));
      }
    });

    // Error handler
    discovery.once("error", (error) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        log.error("Discovery error", { error: error.message });
        void discovery.destroy().finally(() => resolve(null));
      }
    });

    // Start scanning
    discovery.startScanning(serviceType).catch((error) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        log.error("Failed to start discovery", { error: error.message });
        resolve(null);
      }
    });
  });
}

/**
 * Generate a default node ID for discovery
 */
export function generateDiscoveryNodeId(): string {
  return `node-${randomUUID()}`;
}

/**
 * Check if mDNS discovery is available
 */
export async function isDiscoveryAvailable(): Promise<boolean> {
  const ciaoModule = await loadCiao();
  return !!ciaoModule;
}
