/**
 * Federation API Services — Type Definitions
 *
 * Unified type system for managing federation-compatible API servers.
 */

// ============================================================
// Server Definition Types
// ============================================================

export type ServiceStatus = "running" | "stopped" | "starting" | "stopping" | "error" | "unknown";
export type ServiceType = "python" | "node" | "docker" | "binary" | "external";

/**
 * Health check configuration for a service
 */
export interface HealthCheckConfig {
  /** Endpoint to check (relative to baseUrl) */
  endpoint: string;
  /** HTTP method */
  method: "GET" | "POST";
  /** Expected status code */
  expectedStatus: number;
  /** Timeout in ms */
  timeoutMs: number;
  /** Interval between checks in ms */
  intervalMs: number;
  /** JSON path to check for specific value (e.g., "status" or "data.healthy") */
  jsonPath?: string;
  /** Expected value at jsonPath */
  expectedValue?: string | boolean;
}

/**
 * Federation capability declaration for a service
 */
export interface ServiceCapability {
  /** Capability name (matches NodeCapabilities fields) */
  name: string;
  /** Sub-capabilities or details */
  provides: string[];
  /** Resource requirements */
  requirements?: {
    gpuVRAM?: number;
    systemRAM?: number;
    needsGPU?: boolean;
  };
}

/**
 * API endpoint exposed by a service
 */
export interface ServiceEndpoint {
  /** Endpoint path */
  path: string;
  /** HTTP method */
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  /** Description */
  description: string;
  /** Whether this is the primary endpoint */
  primary?: boolean;
  /** Request body schema (OpenAPI-style) */
  requestSchema?: Record<string, unknown>;
  /** Response schema */
  responseSchema?: Record<string, unknown>;
}

/**
 * Service definition — everything needed to manage an API server
 */
export interface ServiceDefinition {
  /** Unique service identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description */
  description: string;
  /** Service type */
  type: ServiceType;
  /** Version (semver) */
  version: string;

  // ── Runtime Configuration ──
  /** Working directory */
  workdir: string;
  /** Start command */
  startCommand: string;
  /** Start command arguments */
  startArgs?: string[];
  /** Stop command (optional, defaults to process kill) */
  stopCommand?: string;
  /** Environment variables */
  env?: Record<string, string>;

  // ── Network Configuration ──
  /** Port the service listens on */
  port: number;
  /** Host to bind to (default: 0.0.0.0) */
  host?: string;
  /** Base URL path prefix */
  basePath?: string;
  /** Full base URL (computed or override) */
  baseUrl?: string;

  // ── Health & Monitoring ──
  /** Health check configuration */
  healthCheck: HealthCheckConfig;
  /** Startup timeout in ms */
  startupTimeoutMs?: number;
  /** Auto-restart on failure */
  autoRestart?: boolean;
  /** Max restart attempts */
  maxRestartAttempts?: number;

  // ── Federation Integration ──
  /** Capabilities this service provides */
  capabilities: ServiceCapability[];
  /** Whether to advertise to federation */
  federationEnabled: boolean;
  /** Node preference (run on specific node) */
  preferNode?: string;
  /** Can run on multiple nodes */
  allowMultiNode?: boolean;

  // ── API Documentation ──
  /** OpenAPI/Swagger docs URL */
  docsUrl?: string;
  /** Key endpoints */
  endpoints?: ServiceEndpoint[];

  // ── Metadata ──
  /** Tags for filtering/grouping */
  tags?: string[];
  /** Dependencies (other service IDs) */
  dependencies?: string[];
  /** Created timestamp */
  createdAt?: number;
  /** Last modified timestamp */
  updatedAt?: number;
}

/**
 * Runtime state of a service instance
 */
export interface ServiceInstance {
  /** Service definition ID */
  serviceId: string;
  /** Node ID where this instance is running */
  nodeId: string;
  /** Current status */
  status: ServiceStatus;
  /** Process ID (if managed) */
  pid?: number;
  /** Actual URL this instance is accessible at */
  url: string;
  /** When this instance started */
  startedAt?: number;
  /** Last health check result */
  lastHealthCheck?: {
    timestamp: number;
    healthy: boolean;
    latencyMs: number;
    error?: string;
  };
  /** Restart count */
  restartCount: number;
  /** Last error message */
  lastError?: string;
  /** Metrics */
  metrics?: {
    requestsTotal: number;
    requestsPerMinute: number;
    avgLatencyMs: number;
    errorsTotal: number;
  };
}

/**
 * Service registry — all known services and their instances
 */
export interface ServiceRegistry {
  /** Service definitions */
  services: ServiceDefinition[];
  /** Running instances (by serviceId:nodeId) */
  instances: Map<string, ServiceInstance>;
  /** Last sync timestamp */
  lastSyncTimestamp: number;
}

// ============================================================
// Manager Types
// ============================================================

export interface StartServiceOptions {
  /** Override environment variables */
  env?: Record<string, string>;
  /** Wait for healthy status */
  waitForHealthy?: boolean;
  /** Startup timeout override */
  timeoutMs?: number;
  /** Target node (for federation) */
  nodeId?: string;
}

export interface StopServiceOptions {
  /** Force kill (SIGKILL vs SIGTERM) */
  force?: boolean;
  /** Timeout before force kill */
  timeoutMs?: number;
}

export interface ServiceManagerConfig {
  /** Registry file path */
  registryPath: string;
  /** Health check interval (global default) */
  healthCheckIntervalMs: number;
  /** Enable auto-restart globally */
  autoRestartEnabled: boolean;
  /** Federation integration enabled */
  federationEnabled: boolean;
}

// ============================================================
// Events
// ============================================================

export type ServiceEventType =
  | "service.registered"
  | "service.unregistered"
  | "service.starting"
  | "service.started"
  | "service.stopping"
  | "service.stopped"
  | "service.error"
  | "service.health.pass"
  | "service.health.fail"
  | "service.restarting";

export interface ServiceEvent {
  type: ServiceEventType;
  serviceId: string;
  nodeId: string;
  timestamp: number;
  data?: Record<string, unknown>;
}
