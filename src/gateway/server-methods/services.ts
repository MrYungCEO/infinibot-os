/**
 * Federation Service Discovery & MCP Builder Gateway Methods
 *
 * Provides:
 * - Docker container detection
 * - Manual service directory registration
 * - Service-to-MCP building automation
 * - Federation service exposure management
 */

import type { GatewayRequestHandlerOptions } from "./types.js";
import { resolve, join } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// ══════════════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════════════

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  status: string;
  state: "running" | "exited" | "paused" | "created";
  ports: Array<{
    hostPort: number;
    containerPort: number;
    protocol: string;
  }>;
  created: string;
  networks: string[];
}

export interface FederationService {
  id: string;
  name: string;
  type: "docker" | "directory" | "api";
  nodeId: string;

  // Docker-specific
  containerId?: string;
  containerName?: string;

  // Directory-specific
  path?: string;

  // API-specific
  baseUrl?: string;
  docsUrl?: string;

  // Common
  ports?: number[];
  protocol?: string;
  capabilities?: string[];
  mcpServerId?: string; // If MCP already built
  mcpStatus?: "none" | "building" | "built" | "error";
  mcpError?: string;

  // Federation exposure
  exposed: boolean;
  exposedTo?: string[]; // Node IDs or "all"

  createdAt: number;
  updatedAt: number;
}

interface ServiceStore {
  services: FederationService[];
  lastDockerScan?: number;
}

// ══════════════════════════════════════════════════════════════════════════════
// Store
// ══════════════════════════════════════════════════════════════════════════════

function getStoreDir(): string {
  const stateDir = process.env.INFINIBOT_STATE_DIR || resolve(process.cwd(), "state");
  const dir = join(stateDir, "federation");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function loadServiceStore(): ServiceStore {
  const storePath = join(getStoreDir(), "services.json");
  if (existsSync(storePath)) {
    try {
      return JSON.parse(readFileSync(storePath, "utf-8"));
    } catch {
      return { services: [] };
    }
  }
  return { services: [] };
}

function saveServiceStore(store: ServiceStore): void {
  const storePath = join(getStoreDir(), "services.json");
  writeFileSync(storePath, JSON.stringify(store, null, 2));
}

// ══════════════════════════════════════════════════════════════════════════════
// Docker Detection
// ══════════════════════════════════════════════════════════════════════════════

async function detectDockerContainers(nodeId?: string): Promise<DockerContainer[]> {
  try {
    // Check if Docker is available
    const { stdout } = await execAsync("docker ps -a --format json", { timeout: 10000 });

    const containers: DockerContainer[] = [];
    const lines = stdout.trim().split("\n").filter(Boolean);

    for (const line of lines) {
      try {
        const raw = JSON.parse(line);

        // Parse ports from Docker format
        const ports: DockerContainer["ports"] = [];
        if (raw.Ports) {
          const portMatches = raw.Ports.matchAll(/(\d+)->(\d+)\/(\w+)/g);
          for (const match of portMatches) {
            ports.push({
              hostPort: parseInt(match[1]),
              containerPort: parseInt(match[2]),
              protocol: match[3],
            });
          }
        }

        containers.push({
          id: raw.ID,
          name: raw.Names?.replace(/^\//, "") || raw.ID.slice(0, 12),
          image: raw.Image,
          status: raw.Status,
          state: raw.State?.toLowerCase() as DockerContainer["state"],
          ports,
          created: raw.CreatedAt,
          networks: raw.Networks?.split(",") || [],
        });
      } catch {
        // Skip invalid JSON lines
      }
    }

    return containers;
  } catch (err) {
    console.warn("[services] Docker detection failed:", err);
    return [];
  }
}

async function inspectDockerContainer(
  containerName: string,
): Promise<Record<string, unknown> | null> {
  try {
    const { stdout } = await execAsync(`docker inspect ${containerName}`, { timeout: 10000 });
    const data = JSON.parse(stdout);
    return data[0] || null;
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Service Analysis
// ══════════════════════════════════════════════════════════════════════════════

interface ServiceProfile {
  name: string;
  type: "docker" | "directory" | "api";
  endpoints: Array<{
    method: string;
    path: string;
    description?: string;
  }>;
  authentication?: {
    type: string;
    header?: string;
  };
  ports: number[];
  protocol: string;
  capabilities: string[];
  envVars?: string[];
  docsAvailable: boolean;
  docsUrl?: string;
}

async function analyzeDockerService(containerName: string): Promise<ServiceProfile | null> {
  const inspection = await inspectDockerContainer(containerName);
  if (!inspection) return null;

  const config = inspection.Config as Record<string, unknown> | undefined;
  const networkSettings = inspection.NetworkSettings as Record<string, unknown> | undefined;

  // Extract ports
  const ports: number[] = [];
  const portBindings = (networkSettings?.Ports || {}) as Record<string, unknown>;
  for (const key of Object.keys(portBindings)) {
    const match = key.match(/^(\d+)/);
    if (match) ports.push(parseInt(match[1]));
  }

  // Extract env vars (sanitized)
  const envVars: string[] = [];
  const envList = (config?.Env || []) as string[];
  for (const env of envList) {
    const [key] = env.split("=");
    if (
      !key.toLowerCase().includes("secret") &&
      !key.toLowerCase().includes("password") &&
      !key.toLowerCase().includes("key") &&
      !key.toLowerCase().includes("token")
    ) {
      envVars.push(key);
    }
  }

  // Try to detect API docs
  let docsAvailable = false;
  let docsUrl: string | undefined;

  for (const port of ports) {
    try {
      const { stdout } = await execAsync(
        `curl -s -o /dev/null -w "%{http_code}" http://localhost:${port}/docs`,
        { timeout: 3000 },
      );
      if (stdout.trim() === "200") {
        docsAvailable = true;
        docsUrl = `http://localhost:${port}/docs`;
        break;
      }
    } catch {
      // Try other common doc paths
      for (const path of ["/swagger.json", "/openapi.json", "/api-docs"]) {
        try {
          const { stdout } = await execAsync(
            `curl -s -o /dev/null -w "%{http_code}" http://localhost:${port}${path}`,
            { timeout: 3000 },
          );
          if (stdout.trim() === "200") {
            docsAvailable = true;
            docsUrl = `http://localhost:${port}${path}`;
            break;
          }
        } catch {}
      }
    }
  }

  // Infer capabilities from image name and env vars
  const capabilities: string[] = [];
  const imageName = ((config?.Image as string) || "").toLowerCase();

  if (imageName.includes("livekit")) {
    capabilities.push("rooms", "participants", "tracks", "egress", "ingress");
  } else if (imageName.includes("postgres")) {
    capabilities.push("query", "tables", "schemas");
  } else if (imageName.includes("redis")) {
    capabilities.push("get", "set", "keys", "pubsub");
  } else if (imageName.includes("mongo")) {
    capabilities.push("collections", "documents", "query");
  }

  return {
    name: containerName,
    type: "docker",
    endpoints: [], // Would need API docs parsing for this
    ports,
    protocol: ports.some((p) => [80, 443, 8080, 3000, 5000].includes(p)) ? "http" : "tcp",
    capabilities,
    envVars,
    docsAvailable,
    docsUrl,
  };
}

async function analyzeDirectoryService(path: string): Promise<ServiceProfile | null> {
  if (!existsSync(path)) return null;

  const capabilities: string[] = [];
  let protocol = "http";
  const ports: number[] = [];

  // Check for package.json
  const pkgPath = join(path, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

      // Infer from dependencies
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.express || deps.fastify || deps.koa) capabilities.push("rest-api");
      if (deps["socket.io"] || deps.ws) capabilities.push("websocket");
      if (deps.graphql) capabilities.push("graphql");
      if (deps["@modelcontextprotocol/sdk"]) capabilities.push("mcp-native");
    } catch {}
  }

  // Check for docker-compose.yml
  const composePath = join(path, "docker-compose.yml");
  if (existsSync(composePath)) {
    capabilities.push("docker-compose");
  }

  return {
    name: path.split(/[/\\]/).pop() || "service",
    type: "directory",
    endpoints: [],
    ports,
    protocol,
    capabilities,
    docsAvailable: false,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// Gateway Method Handlers
// ══════════════════════════════════════════════════════════════════════════════

export const servicesMethods: Record<
  string,
  (opts: GatewayRequestHandlerOptions) => Promise<void>
> = {
  /**
   * Scan for Docker containers
   */
  "services.docker.scan": async (opts) => {
    const { nodeId } = opts.req.params as { nodeId?: string };

    const containers = await detectDockerContainers(nodeId);
    const store = loadServiceStore();
    store.lastDockerScan = Date.now();
    saveServiceStore(store);

    opts.respond(true, {
      success: true,
      containers,
      scannedAt: store.lastDockerScan,
    });
  },

  /**
   * Analyze a specific Docker container
   */
  "services.docker.analyze": async (opts) => {
    const { containerName, containerId } = opts.req.params as {
      containerName?: string;
      containerId?: string;
    };

    const name = containerName || containerId;
    if (!name) {
      opts.respond(false, { error: "containerName or containerId required" });
      return;
    }

    const profile = await analyzeDockerService(name);
    if (!profile) {
      opts.respond(false, { error: "Failed to analyze container" });
      return;
    }

    opts.respond(true, {
      success: true,
      profile,
    });
  },

  /**
   * List all registered federation services
   */
  "services.list": async (opts) => {
    const { nodeId, type, exposed } = opts.req.params as {
      nodeId?: string;
      type?: string;
      exposed?: boolean;
    };

    const store = loadServiceStore();
    let services = store.services;

    if (nodeId) {
      services = services.filter((s) => s.nodeId === nodeId);
    }
    if (type) {
      services = services.filter((s) => s.type === type);
    }
    if (exposed !== undefined) {
      services = services.filter((s) => s.exposed === exposed);
    }

    opts.respond(true, {
      success: true,
      services,
      count: services.length,
    });
  },

  /**
   * Register a new service
   */
  "services.register": async (opts) => {
    const {
      name,
      type,
      nodeId,
      containerId,
      containerName,
      path,
      baseUrl,
      docsUrl,
      ports,
      capabilities,
      exposed,
    } = opts.req.params as Partial<FederationService> & { name: string; type: string };

    if (!name || !type) {
      opts.respond(false, { error: "name and type required" });
      return;
    }

    const store = loadServiceStore();

    // Check for duplicate
    const existing = store.services.find(
      (s) => s.name === name && s.nodeId === (nodeId || "local"),
    );
    if (existing) {
      opts.respond(false, {
        error: `Service ${name} already registered on node ${nodeId || "local"}`,
      });
      return;
    }

    const service: FederationService = {
      id: `svc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      type: type as FederationService["type"],
      nodeId: nodeId || "local",
      containerId,
      containerName,
      path,
      baseUrl,
      docsUrl,
      ports,
      capabilities,
      mcpStatus: "none",
      exposed: exposed ?? false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    store.services.push(service);
    saveServiceStore(store);

    opts.respond(true, {
      success: true,
      service,
    });
  },

  /**
   * Update service exposure settings
   */
  "services.expose": async (opts) => {
    const { serviceId, exposed, exposedTo } = opts.req.params as {
      serviceId: string;
      exposed: boolean;
      exposedTo?: string[];
    };

    if (!serviceId) {
      opts.respond(false, { error: "serviceId required" });
      return;
    }

    const store = loadServiceStore();
    const service = store.services.find((s) => s.id === serviceId);

    if (!service) {
      opts.respond(false, { error: "Service not found" });
      return;
    }

    service.exposed = exposed;
    service.exposedTo = exposedTo;
    service.updatedAt = Date.now();
    saveServiceStore(store);

    opts.respond(true, {
      success: true,
      service,
    });
  },

  /**
   * Delete a service
   */
  "services.delete": async (opts) => {
    const { serviceId } = opts.req.params as { serviceId: string };

    if (!serviceId) {
      opts.respond(false, { error: "serviceId required" });
      return;
    }

    const store = loadServiceStore();
    const idx = store.services.findIndex((s) => s.id === serviceId);

    if (idx === -1) {
      opts.respond(false, { error: "Service not found" });
      return;
    }

    const deleted = store.services.splice(idx, 1)[0];
    saveServiceStore(store);

    opts.respond(true, {
      success: true,
      deleted,
    });
  },

  /**
   * Trigger MCP build for a service
   * This updates the service status and returns build params for the sub-agent
   */
  "services.mcp.build": async (opts) => {
    const { serviceId, mcpName } = opts.req.params as {
      serviceId: string;
      mcpName?: string;
    };

    if (!serviceId) {
      opts.respond(false, { error: "serviceId required" });
      return;
    }

    const store = loadServiceStore();
    const service = store.services.find((s) => s.id === serviceId);

    if (!service) {
      opts.respond(false, { error: "Service not found" });
      return;
    }

    // Update status
    service.mcpStatus = "building";
    service.updatedAt = Date.now();
    saveServiceStore(store);

    // Generate build parameters for sub-agent
    const buildParams = {
      serviceId: service.id,
      serviceName: service.name,
      serviceType: service.type,
      mcpName: mcpName || service.name.toLowerCase().replace(/[^a-z0-9]/g, "-"),
      nodeId: service.nodeId,

      // Type-specific params
      ...(service.type === "docker" && {
        containerName: service.containerName || service.containerId,
      }),
      ...(service.type === "directory" && {
        path: service.path,
      }),
      ...(service.type === "api" && {
        baseUrl: service.baseUrl,
        docsUrl: service.docsUrl,
      }),

      ports: service.ports,
      capabilities: service.capabilities,
    };

    opts.respond(true, {
      success: true,
      service,
      buildParams,
      workflow: "mcp-service-integration-builder",
    });
  },

  /**
   * Update MCP build status
   */
  "services.mcp.status": async (opts) => {
    const { serviceId, status, mcpServerId, error } = opts.req.params as {
      serviceId: string;
      status: FederationService["mcpStatus"];
      mcpServerId?: string;
      error?: string;
    };

    if (!serviceId) {
      opts.respond(false, { error: "serviceId required" });
      return;
    }

    const store = loadServiceStore();
    const service = store.services.find((s) => s.id === serviceId);

    if (!service) {
      opts.respond(false, { error: "Service not found" });
      return;
    }

    service.mcpStatus = status;
    if (mcpServerId) service.mcpServerId = mcpServerId;
    if (error) service.mcpError = error;
    service.updatedAt = Date.now();
    saveServiceStore(store);

    opts.respond(true, {
      success: true,
      service,
    });
  },

  /**
   * Analyze a directory for service potential
   */
  "services.directory.analyze": async (opts) => {
    const { path: dirPath } = opts.req.params as { path: string };

    if (!dirPath) {
      opts.respond(false, { error: "path required" });
      return;
    }

    const fullPath = resolve(dirPath);
    const profile = await analyzeDirectoryService(fullPath);

    if (!profile) {
      opts.respond(false, { error: "Failed to analyze directory" });
      return;
    }

    opts.respond(true, {
      success: true,
      profile,
      path: fullPath,
    });
  },
};

export { servicesMethods as servicesHandlers };
export default servicesMethods;
