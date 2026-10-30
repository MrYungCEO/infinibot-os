/**
 * Federation API Services — Service Registry
 *
 * Manages service definitions and runtime state.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { ServiceDefinition, ServiceInstance, ServiceRegistry } from "./types.js";

// ============================================================
// Default Services (Built-in)
// ============================================================

const DEFAULT_SERVICES: ServiceDefinition[] = [
  {
    id: "image-api",
    name: "Image Generation API",
    description:
      "Local AI image generation powered by ComfyUI. Supports Flux, SD3.5, Hunyuan, and more.",
    type: "python",
    version: "1.0.0",

    workdir:
      process.env.INFINIBOT_IMAGE_API_DIR ?? join(homedir(), ".infinibot", "services", "image-api"),
    startCommand: "uvicorn",
    startArgs: ["server:app", "--host", "0.0.0.0", "--port", "8899"],
    env: {
      COMFY_URL: "http://127.0.0.1:8000",
    },

    port: 8899,
    host: "0.0.0.0",
    baseUrl: "http://localhost:8899",

    healthCheck: {
      endpoint: "/health",
      method: "GET",
      expectedStatus: 200,
      timeoutMs: 5000,
      intervalMs: 30000,
      jsonPath: "status",
      expectedValue: "healthy",
    },
    startupTimeoutMs: 30000,
    autoRestart: true,
    maxRestartAttempts: 3,

    capabilities: [
      {
        name: "hasComfyUI",
        provides: [
          "flux-dev",
          "flux-schnell",
          "sd3.5-large",
          "hunyuan-dit",
          "seedream-3",
          "qwen2-vl",
        ],
        requirements: {
          needsGPU: true,
          gpuVRAM: 12,
        },
      },
    ],
    federationEnabled: true,

    docsUrl: "/docs",
    endpoints: [
      {
        path: "/v1/generate",
        method: "POST",
        description: "Generate image from prompt (async)",
        primary: true,
      },
      {
        path: "/v1/generate/sync",
        method: "POST",
        description: "Generate image from prompt (sync)",
      },
      {
        path: "/v1/models",
        method: "GET",
        description: "List available models",
      },
      {
        path: "/v1/jobs/{id}",
        method: "GET",
        description: "Get job status",
      },
    ],

    tags: ["image", "generation", "ai", "comfyui"],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: "stt-server",
    name: "Speech-to-Text Server",
    description: "Local speech recognition using Whisper. Transcribes audio to text.",
    type: "python",
    version: "1.0.0",

    workdir:
      process.env.INFINIBOT_STT_SERVER_DIR ??
      join(homedir(), ".infinibot", "services", "stt-server"),
    startCommand: "python",
    startArgs: ["server.py"],

    port: 8877,
    host: "0.0.0.0",
    baseUrl: "http://localhost:8877",

    healthCheck: {
      endpoint: "/health",
      method: "GET",
      expectedStatus: 200,
      timeoutMs: 5000,
      intervalMs: 30000,
    },
    startupTimeoutMs: 60000, // Whisper model loading
    autoRestart: true,
    maxRestartAttempts: 3,

    capabilities: [
      {
        name: "hasVoice",
        provides: ["whisper-large-v3", "whisper-medium", "transcription"],
        requirements: {
          needsGPU: true,
          gpuVRAM: 6,
        },
      },
    ],
    federationEnabled: true,

    endpoints: [
      {
        path: "/v1/transcribe",
        method: "POST",
        description: "Transcribe audio file",
        primary: true,
      },
    ],

    tags: ["voice", "stt", "whisper", "transcription"],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
];

// ============================================================
// Registry Store
// ============================================================

export class ServiceRegistryStore {
  private services: Map<string, ServiceDefinition> = new Map();
  private instances: Map<string, ServiceInstance> = new Map();
  private registryPath: string;

  constructor(stateDir: string) {
    this.registryPath = resolve(stateDir, "services", "registry.json");
    this.ensureDir();
    this.load();
  }

  private ensureDir(): void {
    const dir = dirname(this.registryPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  private load(): void {
    // Load saved state
    if (existsSync(this.registryPath)) {
      try {
        const data = JSON.parse(readFileSync(this.registryPath, "utf-8"));
        for (const svc of data.services || []) {
          this.services.set(svc.id, svc);
        }
        for (const [key, inst] of Object.entries(data.instances || {})) {
          this.instances.set(key, inst as ServiceInstance);
        }
      } catch (e) {
        console.error("[ServiceRegistry] Failed to load registry:", e);
      }
    }

    // Merge default services (don't overwrite user modifications)
    for (const svc of DEFAULT_SERVICES) {
      if (!this.services.has(svc.id)) {
        this.services.set(svc.id, svc);
      }
    }

    this.save();
  }

  private save(): void {
    const data = {
      services: Array.from(this.services.values()),
      instances: Object.fromEntries(this.instances),
      lastSyncTimestamp: Date.now(),
    };
    writeFileSync(this.registryPath, JSON.stringify(data, null, 2));
  }

  // ── Service CRUD ──

  getService(id: string): ServiceDefinition | undefined {
    return this.services.get(id);
  }

  getAllServices(): ServiceDefinition[] {
    return Array.from(this.services.values());
  }

  registerService(service: ServiceDefinition): void {
    service.createdAt = service.createdAt || Date.now();
    service.updatedAt = Date.now();
    this.services.set(service.id, service);
    this.save();
  }

  updateService(id: string, updates: Partial<ServiceDefinition>): ServiceDefinition | undefined {
    const service = this.services.get(id);
    if (!service) return undefined;

    const updated = { ...service, ...updates, updatedAt: Date.now() };
    this.services.set(id, updated);
    this.save();
    return updated;
  }

  unregisterService(id: string): boolean {
    const deleted = this.services.delete(id);
    if (deleted) {
      // Also remove any instances
      for (const key of this.instances.keys()) {
        if (key.startsWith(`${id}:`)) {
          this.instances.delete(key);
        }
      }
      this.save();
    }
    return deleted;
  }

  // ── Instance Management ──

  private instanceKey(serviceId: string, nodeId: string): string {
    return `${serviceId}:${nodeId}`;
  }

  getInstance(serviceId: string, nodeId: string): ServiceInstance | undefined {
    return this.instances.get(this.instanceKey(serviceId, nodeId));
  }

  getAllInstances(): ServiceInstance[] {
    return Array.from(this.instances.values());
  }

  getServiceInstances(serviceId: string): ServiceInstance[] {
    return Array.from(this.instances.values()).filter((i) => i.serviceId === serviceId);
  }

  setInstance(instance: ServiceInstance): void {
    const key = this.instanceKey(instance.serviceId, instance.nodeId);
    this.instances.set(key, instance);
    this.save();
  }

  updateInstance(
    serviceId: string,
    nodeId: string,
    updates: Partial<ServiceInstance>,
  ): ServiceInstance | undefined {
    const key = this.instanceKey(serviceId, nodeId);
    const instance = this.instances.get(key);
    if (!instance) return undefined;

    const updated = { ...instance, ...updates };
    this.instances.set(key, updated);
    this.save();
    return updated;
  }

  removeInstance(serviceId: string, nodeId: string): boolean {
    const key = this.instanceKey(serviceId, nodeId);
    const deleted = this.instances.delete(key);
    if (deleted) this.save();
    return deleted;
  }

  // ── Queries ──

  getServicesByCapability(capability: string): ServiceDefinition[] {
    return Array.from(this.services.values()).filter((s) =>
      s.capabilities.some((c) => c.name === capability),
    );
  }

  getServicesByTag(tag: string): ServiceDefinition[] {
    return Array.from(this.services.values()).filter((s) => s.tags?.includes(tag));
  }

  getRunningInstances(): ServiceInstance[] {
    return Array.from(this.instances.values()).filter((i) => i.status === "running");
  }

  // ── Federation Export ──

  getCapabilitiesForNode(nodeId: string): Record<string, string[]> {
    const caps: Record<string, string[]> = {};
    for (const inst of this.instances.values()) {
      if (inst.nodeId === nodeId && inst.status === "running") {
        const service = this.services.get(inst.serviceId);
        if (service?.federationEnabled) {
          for (const cap of service.capabilities) {
            if (!caps[cap.name]) caps[cap.name] = [];
            caps[cap.name].push(...cap.provides);
          }
        }
      }
    }
    return caps;
  }
}

// Singleton accessor
let registryInstance: ServiceRegistryStore | null = null;

export function getServiceRegistry(stateDir?: string): ServiceRegistryStore {
  if (!registryInstance) {
    if (!stateDir) {
      stateDir = process.env.INFINIBOT_STATE_DIR || resolve(process.cwd(), "state");
    }
    registryInstance = new ServiceRegistryStore(stateDir);
  }
  return registryInstance;
}

/** Force reset the singleton - call on gateway restart to pick up file changes */
export function resetServiceRegistry(): void {
  registryInstance = null;
}
