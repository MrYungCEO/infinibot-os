/**
 * Federation Resource Monitor
 *
 * Collects real-time resource metrics for load balancing.
 * Monitors CPU, memory, GPU, and session counts.
 */

import os from "node:os";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";

import { createSubsystemLogger } from "../logging/subsystem.js";
import type { NodeLoadMetrics, LoadBalancerConfig } from "./types.js";
import { getActiveRemoteSessions } from "./remote-session-registry.js";

const exec = promisify(execCb);
const log = createSubsystemLogger("federation").child("resource-monitor");

// ============================================================
// CPU Monitoring
// ============================================================

interface CPUMeasurement {
  idle: number;
  total: number;
}

let lastCPUMeasurement: CPUMeasurement | null = null;

/**
 * Get current CPU times for measuring utilization.
 */
function getCPUTimes(): CPUMeasurement {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;

  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }

  return { idle, total };
}

/**
 * Calculate CPU utilization percentage since last measurement.
 * Returns 0-100 percentage.
 */
export function getCPUPercent(): number {
  const current = getCPUTimes();

  if (!lastCPUMeasurement) {
    lastCPUMeasurement = current;
    // First call - use load average as fallback
    const loadAvg = os.loadavg()[0];
    const cpuCount = os.cpus().length;
    return Math.min(100, Math.round((loadAvg / cpuCount) * 100));
  }

  const idleDiff = current.idle - lastCPUMeasurement.idle;
  const totalDiff = current.total - lastCPUMeasurement.total;
  lastCPUMeasurement = current;

  if (totalDiff === 0) return 0;

  const usedPercent = 100 - (idleDiff / totalDiff) * 100;
  return Math.max(0, Math.min(100, Math.round(usedPercent)));
}

// ============================================================
// Memory Monitoring
// ============================================================

/**
 * Get memory utilization percentage.
 */
export function getMemoryPercent(): number {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  return Math.round((used / total) * 100);
}

/**
 * Get memory info in MB.
 */
export function getMemoryInfo(): { totalMB: number; usedMB: number; freeMB: number } {
  const total = os.totalmem();
  const free = os.freemem();
  return {
    totalMB: Math.round(total / (1024 * 1024)),
    usedMB: Math.round((total - free) / (1024 * 1024)),
    freeMB: Math.round(free / (1024 * 1024)),
  };
}

// ============================================================
// GPU Monitoring
// ============================================================

interface GPUMetrics {
  utilizationPercent: number;
  memoryPercent: number;
  memoryUsedMB: number;
  memoryTotalMB: number;
}

let lastGPUMetrics: GPUMetrics | null = null;
let gpuAvailable: boolean | null = null;

/**
 * Query NVIDIA GPU metrics via nvidia-smi.
 */
async function queryNvidiaGPU(): Promise<GPUMetrics | null> {
  try {
    const { stdout } = await exec(
      "nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits",
      { timeout: 5000 },
    );

    const line = stdout.trim().split("\n")[0];
    if (!line) return null;

    const parts = line.split(",").map((p) => p.trim());
    if (parts.length < 3) return null;

    const [utilStr, usedStr, totalStr] = parts;
    const utilizationPercent = parseInt(utilStr, 10);
    const memoryUsedMB = parseInt(usedStr, 10);
    const memoryTotalMB = parseInt(totalStr, 10);

    if (isNaN(utilizationPercent) || isNaN(memoryUsedMB) || isNaN(memoryTotalMB)) {
      return null;
    }

    const memoryPercent = Math.round((memoryUsedMB / memoryTotalMB) * 100);

    return {
      utilizationPercent,
      memoryPercent,
      memoryUsedMB,
      memoryTotalMB,
    };
  } catch {
    return null;
  }
}

/**
 * Query AMD GPU metrics via rocm-smi (Linux only).
 */
async function queryAMDGPU(): Promise<GPUMetrics | null> {
  if (os.platform() !== "linux") return null;

  try {
    const { stdout } = await exec("rocm-smi --showuse --showmeminfo vram --json", {
      timeout: 5000,
    });

    const data = JSON.parse(stdout);
    const cards = Object.keys(data).filter((k) => k.startsWith("card"));
    if (cards.length === 0) return null;

    const card = data[cards[0]];
    const utilizationPercent = card?.["GPU use (%)"] ?? 0;
    const memoryUsedMB = Math.round((card?.["VRAM Total Used Memory (B)"] ?? 0) / (1024 * 1024));
    const memoryTotalMB = Math.round((card?.["VRAM Total Memory (B)"] ?? 1) / (1024 * 1024));
    const memoryPercent = memoryTotalMB > 0 ? Math.round((memoryUsedMB / memoryTotalMB) * 100) : 0;

    return {
      utilizationPercent,
      memoryPercent,
      memoryUsedMB,
      memoryTotalMB,
    };
  } catch {
    return null;
  }
}

/**
 * Get current GPU metrics.
 * Returns null if no GPU is available.
 */
export async function getGPUMetrics(): Promise<GPUMetrics | null> {
  // Skip if we know there's no GPU
  if (gpuAvailable === false) return lastGPUMetrics;

  // Try NVIDIA first
  const nvidia = await queryNvidiaGPU();
  if (nvidia) {
    gpuAvailable = true;
    lastGPUMetrics = nvidia;
    return nvidia;
  }

  // Try AMD
  const amd = await queryAMDGPU();
  if (amd) {
    gpuAvailable = true;
    lastGPUMetrics = amd;
    return amd;
  }

  // No GPU found
  gpuAvailable = false;
  return null;
}

// ============================================================
// Session Counting
// ============================================================

/** Callback to get active session count (injected by hub/gateway) */
let sessionCountCallback: (() => number) | null = null;

/** Callback to get pending task count (injected by task queue) */
let pendingTasksCallback: (() => number) | null = null;

/**
 * Register callback to get active session count.
 */
export function registerSessionCountCallback(callback: () => number): void {
  sessionCountCallback = callback;
}

/**
 * Register callback to get pending tasks count.
 */
export function registerPendingTasksCallback(callback: () => number): void {
  pendingTasksCallback = callback;
}

/**
 * Get the number of active sessions on this node.
 */
export function getActiveSessions(): number {
  if (sessionCountCallback) {
    return sessionCountCallback();
  }
  // Fall back to remote session registry
  return getActiveRemoteSessions().length;
}

/**
 * Get the number of pending tasks.
 */
export function getPendingTasks(): number {
  if (pendingTasksCallback) {
    return pendingTasksCallback();
  }
  return 0;
}

// ============================================================
// Load Score Calculation
// ============================================================

/** Default weights for load score calculation */
const DEFAULT_WEIGHTS = {
  cpu: 0.3,
  memory: 0.25,
  gpu: 0.2,
  sessions: 0.15,
  pending: 0.1,
};

/**
 * Calculate composite load score from metrics.
 * Returns 0-100 where higher = more loaded.
 */
export function calculateLoadScore(
  metrics: Omit<NodeLoadMetrics, "loadScore">,
  weights: LoadBalancerConfig["weights"] = {},
): number {
  const w = { ...DEFAULT_WEIGHTS, ...weights };

  let score = 0;

  // CPU contribution
  score += metrics.cpuPercent * w.cpu;

  // Memory contribution
  score += metrics.memoryPercent * w.memory;

  // GPU contribution (if available)
  if (metrics.gpuPercent !== undefined) {
    score += metrics.gpuPercent * w.gpu;
  } else {
    // Redistribute GPU weight to CPU and memory if no GPU
    score += metrics.cpuPercent * (w.gpu * 0.6);
    score += metrics.memoryPercent * (w.gpu * 0.4);
  }

  // Session contribution (capped at 50 to avoid over-weighting)
  const sessionScore = Math.min(metrics.activeSessions * 5, 50);
  score += sessionScore * w.sessions;

  // Pending tasks contribution (capped at 50)
  const pendingScore = Math.min(metrics.pendingTasks * 10, 50);
  score += pendingScore * w.pending;

  return Math.min(100, Math.round(score));
}

// ============================================================
// Metrics Collection
// ============================================================

/**
 * Collect all local resource metrics.
 */
export async function collectLocalMetrics(nodeId: string): Promise<NodeLoadMetrics> {
  const [gpu] = await Promise.all([getGPUMetrics()]);

  const cpuPercent = getCPUPercent();
  const memoryPercent = getMemoryPercent();
  const activeSessions = getActiveSessions();
  const pendingTasks = getPendingTasks();

  const baseMetrics = {
    nodeId,
    timestamp: Date.now(),
    cpuPercent,
    memoryPercent,
    gpuPercent: gpu?.utilizationPercent,
    gpuMemoryPercent: gpu?.memoryPercent,
    activeSessions,
    pendingTasks,
  };

  const loadScore = calculateLoadScore(baseMetrics);

  return {
    ...baseMetrics,
    loadScore,
  };
}

// ============================================================
// Resource Monitor Class
// ============================================================

export interface ResourceMonitorEvents {
  metrics: (metrics: NodeLoadMetrics) => void;
  overload: (metrics: NodeLoadMetrics) => void;
  recovered: (metrics: NodeLoadMetrics) => void;
}

export class ResourceMonitor extends EventEmitter {
  private nodeId: string;
  private interval: NodeJS.Timeout | null = null;
  private intervalMs: number;
  private overloadThreshold: number;
  private lastMetrics: NodeLoadMetrics | null = null;
  private wasOverloaded = false;
  private weights: LoadBalancerConfig["weights"];

  constructor(nodeId: string, config: LoadBalancerConfig = {}) {
    super();
    this.nodeId = nodeId;
    this.intervalMs = config.metricsIntervalMs ?? 15000;
    this.overloadThreshold = config.overloadThreshold ?? 80;
    this.weights = config.weights;
  }

  /**
   * Start collecting metrics at regular intervals.
   */
  start(): void {
    if (this.interval) return;

    log.info(`starting resource monitor for ${this.nodeId}, interval: ${this.intervalMs}ms`);

    // Collect immediately
    void this.collect();

    // Then collect at intervals
    this.interval = setInterval(() => this.collect(), this.intervalMs);
    this.interval.unref();
  }

  /**
   * Stop collecting metrics.
   */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      log.info(`stopped resource monitor for ${this.nodeId}`);
    }
  }

  /**
   * Collect metrics once.
   */
  async collect(): Promise<NodeLoadMetrics> {
    try {
      const metrics = await collectLocalMetrics(this.nodeId);

      // Apply custom weights if provided
      if (this.weights) {
        metrics.loadScore = calculateLoadScore(metrics, this.weights);
      }

      this.lastMetrics = metrics;
      this.emit("metrics", metrics);

      // Check for overload state changes
      const isOverloaded = metrics.loadScore >= this.overloadThreshold;
      if (isOverloaded && !this.wasOverloaded) {
        log.warn(`node ${this.nodeId} is overloaded: loadScore=${metrics.loadScore}`);
        this.emit("overload", metrics);
      } else if (!isOverloaded && this.wasOverloaded) {
        log.info(`node ${this.nodeId} recovered: loadScore=${metrics.loadScore}`);
        this.emit("recovered", metrics);
      }
      this.wasOverloaded = isOverloaded;

      return metrics;
    } catch (err) {
      log.error(`failed to collect metrics: ${err}`);
      throw err;
    }
  }

  /**
   * Get the most recent metrics.
   */
  getLastMetrics(): NodeLoadMetrics | null {
    return this.lastMetrics;
  }

  /**
   * Check if currently overloaded.
   */
  isOverloaded(): boolean {
    return this.wasOverloaded;
  }

  /**
   * Update the node ID (e.g., after registration with master).
   */
  setNodeId(nodeId: string): void {
    this.nodeId = nodeId;
    if (this.lastMetrics) {
      this.lastMetrics.nodeId = nodeId;
    }
  }
}

// ============================================================
// Singleton Instance
// ============================================================

let defaultMonitor: ResourceMonitor | null = null;

/**
 * Get the default resource monitor.
 */
export function getResourceMonitor(): ResourceMonitor | null {
  return defaultMonitor;
}

/**
 * Initialize the default resource monitor.
 */
export function initResourceMonitor(nodeId: string, config?: LoadBalancerConfig): ResourceMonitor {
  if (defaultMonitor) {
    defaultMonitor.stop();
  }
  defaultMonitor = new ResourceMonitor(nodeId, config);
  return defaultMonitor;
}

/**
 * Start the default resource monitor.
 */
export function startResourceMonitor(nodeId: string, config?: LoadBalancerConfig): ResourceMonitor {
  const monitor = initResourceMonitor(nodeId, config);
  monitor.start();
  return monitor;
}

/**
 * Stop the default resource monitor.
 */
export function stopResourceMonitor(): void {
  if (defaultMonitor) {
    defaultMonitor.stop();
    defaultMonitor = null;
  }
}
