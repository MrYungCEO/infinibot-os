/**
 * Federation API Services — Service Manager
 *
 * Manages lifecycle of federation-compatible API servers.
 */

import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import {
  ServiceDefinition,
  ServiceInstance,
  ServiceEvent,
  ServiceEventType,
  StartServiceOptions,
  StopServiceOptions,
} from "./types.js";
import { getServiceRegistry, ServiceRegistryStore } from "./registry.js";

// ============================================================
// Service Manager
// ============================================================

export class ServiceManager extends EventEmitter {
  private registry: ServiceRegistryStore;
  private processes: Map<string, ChildProcess> = new Map();
  private healthChecks: Map<string, NodeJS.Timeout> = new Map();
  private nodeId: string;
  private initPromise: Promise<void> | null = null;

  constructor(stateDir?: string, nodeId?: string) {
    super();
    this.registry = getServiceRegistry(stateDir);
    this.nodeId = nodeId || process.env.INFINIBOT_NODE_ID || "local";
    // Clean up stale instances on startup
    this.initPromise = this.cleanupStaleInstances();
  }

  /**
   * Clean up stale instances from previous gateway runs.
   * Marks any "running" instances that aren't actually responding as "stopped".
   */
  private async cleanupStaleInstances(): Promise<void> {
    console.log(`[ServiceManager] Starting stale instance cleanup for node: ${this.nodeId}`);

    const instances = this.registry.getAllInstances();
    console.log(`[ServiceManager] Found ${instances.length} total instances`);

    const staleInstances = instances.filter(
      (i) => i.nodeId === this.nodeId && i.status === "running",
    );
    console.log(
      `[ServiceManager] Found ${staleInstances.length} potentially stale running instances`,
    );

    for (const instance of staleInstances) {
      const service = this.registry.getService(instance.serviceId);
      if (!service) {
        console.log(`[ServiceManager] No service definition for ${instance.serviceId}, skipping`);
        continue;
      }

      const healthUrl = `${instance.url}${service.healthCheck.endpoint}`;
      console.log(`[ServiceManager] Checking health: ${healthUrl}`);

      // Quick health check
      let isHealthy = false;
      try {
        const resp = await fetch(healthUrl, {
          method: service.healthCheck.method || "GET",
          signal: AbortSignal.timeout(3000),
        });
        isHealthy = resp.ok;
        console.log(
          `[ServiceManager] Health check result for ${instance.serviceId}: ${resp.status} (ok: ${isHealthy})`,
        );
      } catch (err) {
        console.log(`[ServiceManager] Health check failed for ${instance.serviceId}: ${err}`);
      }

      if (isHealthy) {
        console.log(`[ServiceManager] ${instance.serviceId} is actually running, keeping status`);
        continue;
      }

      // Mark as stopped
      console.log(`[ServiceManager] Marking ${instance.serviceId} as stopped (was stale)`);
      instance.status = "stopped";
      instance.lastError = "Stale instance from previous session";
      this.registry.setInstance(instance);
    }

    console.log(`[ServiceManager] Stale instance cleanup complete`);
  }

  /** Wait for init cleanup to complete */
  async ready(): Promise<void> {
    if (this.initPromise) await this.initPromise;
  }

  // ── Lifecycle Management ──

  async start(serviceId: string, options: StartServiceOptions = {}): Promise<ServiceInstance> {
    const service = this.registry.getService(serviceId);
    if (!service) {
      throw new Error(`Service not found: ${serviceId}`);
    }

    const nodeId = options.nodeId || this.nodeId;
    const instanceKey = `${serviceId}:${nodeId}`;

    // Check if already running
    const existing = this.registry.getInstance(serviceId, nodeId);
    if (existing?.status === "running") {
      return existing;
    }

    this.emit("service", this.createEvent("service.starting", serviceId, nodeId));

    // Build environment
    const env = {
      ...process.env,
      ...service.env,
      ...options.env,
    };

    // Determine base URL
    const host = service.host || "localhost";
    const baseUrl = service.baseUrl || `http://${host}:${service.port}`;

    // Create instance record
    const instance: ServiceInstance = {
      serviceId,
      nodeId,
      status: "starting",
      url: baseUrl,
      startedAt: Date.now(),
      restartCount: existing?.restartCount || 0,
    };
    this.registry.setInstance(instance);

    try {
      // Spawn process
      const proc = spawn(service.startCommand, service.startArgs || [], {
        cwd: service.workdir,
        env,
        shell: true,
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      proc.stdout?.on("data", (data) => {
        console.log(`[${serviceId}] ${data.toString().trim()}`);
      });

      proc.stderr?.on("data", (data) => {
        console.error(`[${serviceId}] ${data.toString().trim()}`);
      });

      proc.on("error", (err) => {
        console.error(`[${serviceId}] Process error:`, err);
        this.handleProcessExit(serviceId, nodeId, 1);
      });

      proc.on("exit", (code) => {
        this.handleProcessExit(serviceId, nodeId, code || 0);
      });

      this.processes.set(instanceKey, proc);
      instance.pid = proc.pid;

      // Wait for healthy if requested
      if (options.waitForHealthy !== false) {
        const timeout = options.timeoutMs || service.startupTimeoutMs || 30000;
        const healthy = await this.waitForHealthy(service, baseUrl, timeout);
        if (!healthy) {
          throw new Error(`Service failed to become healthy within ${timeout}ms`);
        }
      }

      // Update status
      instance.status = "running";
      this.registry.setInstance(instance);
      this.emit(
        "service",
        this.createEvent("service.started", serviceId, nodeId, { pid: proc.pid }),
      );

      // Start health check loop
      this.startHealthCheck(service, instance);

      return instance;
    } catch (error) {
      instance.status = "error";
      instance.lastError = String(error);
      this.registry.setInstance(instance);
      this.emit(
        "service",
        this.createEvent("service.error", serviceId, nodeId, { error: String(error) }),
      );
      throw error;
    }
  }

  async stop(serviceId: string, options: StopServiceOptions = {}): Promise<void> {
    const nodeId = this.nodeId;
    const instanceKey = `${serviceId}:${nodeId}`;

    const instance = this.registry.getInstance(serviceId, nodeId);
    if (!instance) {
      return; // Already stopped
    }

    this.emit("service", this.createEvent("service.stopping", serviceId, nodeId));

    // Stop health check
    const healthCheck = this.healthChecks.get(instanceKey);
    if (healthCheck) {
      clearInterval(healthCheck);
      this.healthChecks.delete(instanceKey);
    }

    // Kill process
    const proc = this.processes.get(instanceKey);
    if (proc && !proc.killed) {
      if (options.force) {
        proc.kill("SIGKILL");
      } else {
        proc.kill("SIGTERM");
        // Force kill after timeout
        const timeout = options.timeoutMs || 10000;
        setTimeout(() => {
          if (!proc.killed) {
            proc.kill("SIGKILL");
          }
        }, timeout);
      }
    }

    this.processes.delete(instanceKey);

    // Update registry
    instance.status = "stopped";
    this.registry.setInstance(instance);
    this.emit("service", this.createEvent("service.stopped", serviceId, nodeId));
  }

  async restart(serviceId: string, options: StartServiceOptions = {}): Promise<ServiceInstance> {
    await this.stop(serviceId, { force: false, timeoutMs: 5000 });
    await this.sleep(1000); // Brief pause
    return this.start(serviceId, options);
  }

  // ── Health Checks ──

  private async checkHealth(
    service: ServiceDefinition,
    baseUrl: string,
  ): Promise<{ healthy: boolean; latencyMs: number; error?: string }> {
    const hc = service.healthCheck;
    const url = `${baseUrl}${hc.endpoint}`;
    const start = Date.now();

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), hc.timeoutMs);

      const response = await fetch(url, {
        method: hc.method,
        signal: controller.signal,
      });

      clearTimeout(timeout);
      const latencyMs = Date.now() - start;

      if (response.status !== hc.expectedStatus) {
        return {
          healthy: false,
          latencyMs,
          error: `Unexpected status: ${response.status}`,
        };
      }

      // Check JSON path if configured
      if (hc.jsonPath && hc.expectedValue !== undefined) {
        const data = await response.json();
        const value = this.getJsonPath(data, hc.jsonPath);
        if (value !== hc.expectedValue) {
          return {
            healthy: false,
            latencyMs,
            error: `${hc.jsonPath}=${value}, expected ${hc.expectedValue}`,
          };
        }
      }

      return { healthy: true, latencyMs };
    } catch (error) {
      return {
        healthy: false,
        latencyMs: Date.now() - start,
        error: String(error),
      };
    }
  }

  private async waitForHealthy(
    service: ServiceDefinition,
    baseUrl: string,
    timeoutMs: number,
  ): Promise<boolean> {
    const start = Date.now();
    const interval = 1000;

    while (Date.now() - start < timeoutMs) {
      const result = await this.checkHealth(service, baseUrl);
      if (result.healthy) {
        return true;
      }
      await this.sleep(interval);
    }

    return false;
  }

  private startHealthCheck(service: ServiceDefinition, instance: ServiceInstance): void {
    const key = `${service.id}:${instance.nodeId}`;
    const intervalMs = service.healthCheck.intervalMs;

    const check = setInterval(async () => {
      const result = await this.checkHealth(service, instance.url);

      // Update instance
      instance.lastHealthCheck = {
        timestamp: Date.now(),
        healthy: result.healthy,
        latencyMs: result.latencyMs,
        error: result.error,
      };

      if (!result.healthy) {
        this.emit(
          "service",
          this.createEvent("service.health.fail", service.id, instance.nodeId, result),
        );

        // Auto-restart if configured
        if (service.autoRestart && instance.restartCount < (service.maxRestartAttempts || 3)) {
          instance.restartCount++;
          this.emit(
            "service",
            this.createEvent("service.restarting", service.id, instance.nodeId, {
              attempt: instance.restartCount,
            }),
          );
          try {
            await this.restart(service.id);
          } catch (e) {
            console.error(`[${service.id}] Auto-restart failed:`, e);
          }
        }
      } else {
        if (instance.status !== "running") {
          instance.status = "running";
        }
        this.emit(
          "service",
          this.createEvent("service.health.pass", service.id, instance.nodeId, result),
        );
      }

      this.registry.setInstance(instance);
    }, intervalMs);

    this.healthChecks.set(key, check);
  }

  // ── Manual Health Check ──

  async checkServiceHealth(
    serviceId: string,
  ): Promise<{ healthy: boolean; latencyMs: number; error?: string }> {
    const service = this.registry.getService(serviceId);
    if (!service) {
      return { healthy: false, latencyMs: 0, error: "Service not found" };
    }

    const instance = this.registry.getInstance(serviceId, this.nodeId);
    const baseUrl = instance?.url || service.baseUrl || `http://localhost:${service.port}`;

    return this.checkHealth(service, baseUrl);
  }

  // ── Status ──

  getStatus(serviceId: string): ServiceInstance | undefined {
    return this.registry.getInstance(serviceId, this.nodeId);
  }

  getAllStatus(): ServiceInstance[] {
    return this.registry.getAllInstances();
  }

  // ── Private Helpers ──

  private handleProcessExit(serviceId: string, nodeId: string, code: number): void {
    const key = `${serviceId}:${nodeId}`;
    this.processes.delete(key);

    const instance = this.registry.getInstance(serviceId, nodeId);
    if (instance && instance.status !== "stopped") {
      instance.status = code === 0 ? "stopped" : "error";
      instance.lastError = code !== 0 ? `Process exited with code ${code}` : undefined;
      this.registry.setInstance(instance);
      this.emit(
        "service",
        this.createEvent("service.stopped", serviceId, nodeId, { exitCode: code }),
      );
    }
  }

  private createEvent(
    type: ServiceEventType,
    serviceId: string,
    nodeId: string,
    data?: Record<string, unknown>,
  ): ServiceEvent {
    return { type, serviceId, nodeId, timestamp: Date.now(), data };
  }

  private getJsonPath(obj: any, path: string): any {
    return path.split(".").reduce((o, k) => o?.[k], obj);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ── Registry Access ──

  getRegistry(): ServiceRegistryStore {
    return this.registry;
  }
}

// Singleton
let managerInstance: ServiceManager | null = null;

export function getServiceManager(stateDir?: string, nodeId?: string): ServiceManager {
  if (!managerInstance) {
    managerInstance = new ServiceManager(stateDir, nodeId);
  }
  return managerInstance;
}

/** Force reset the singleton - call on gateway restart */
export function resetServiceManager(): void {
  managerInstance = null;
}
