/**
 * Federation Compute Manifest
 *
 * Collects and manages compute capability information for federation nodes.
 * Detects local GPU, RAM, Ollama, voice capabilities, and other compute resources.
 */

import { exec as execCb } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { loadConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { NodeCapabilities, NodeManifest } from "./types.js";

const exec = promisify(execCb);
const log = createSubsystemLogger("federation").child("manifest");

// ============================================================
// GPU Detection
// ============================================================

export interface GPUInfo {
  name: string;
  vramMB: number;
  vramUsedMB: number;
  vramFreeMB: number;
  utilizationPercent: number;
}

/**
 * Detect NVIDIA GPU via nvidia-smi command.
 * Returns null if no NVIDIA GPU or nvidia-smi not available.
 */
export async function detectNvidiaGPU(): Promise<GPUInfo | null> {
  try {
    const { stdout } = await exec(
      "nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu --format=csv,noheader,nounits",
      { timeout: 10000 },
    );

    const line = stdout.trim().split("\n")[0];
    if (!line) return null;

    const parts = line.split(",").map((p) => p.trim());
    if (parts.length < 5) return null;

    const [name, totalStr, usedStr, freeStr, utilStr] = parts;
    const vramMB = parseInt(totalStr, 10);
    const vramUsedMB = parseInt(usedStr, 10);
    const vramFreeMB = parseInt(freeStr, 10);
    const utilizationPercent = parseInt(utilStr, 10);

    if (isNaN(vramMB)) return null;

    log.debug(`detected NVIDIA GPU: ${name} (${Math.round(vramMB / 1024)}GB VRAM)`);

    return {
      name,
      vramMB,
      vramUsedMB: isNaN(vramUsedMB) ? 0 : vramUsedMB,
      vramFreeMB: isNaN(vramFreeMB) ? vramMB : vramFreeMB,
      utilizationPercent: isNaN(utilizationPercent) ? 0 : utilizationPercent,
    };
  } catch {
    // nvidia-smi not available or failed
    return null;
  }
}

/**
 * Detect AMD GPU via rocm-smi command (Linux).
 * Returns null if no AMD GPU or rocm-smi not available.
 */
export async function detectAMDGPU(): Promise<GPUInfo | null> {
  if (os.platform() !== "linux") return null;

  try {
    const { stdout } = await exec("rocm-smi --showmeminfo vram --json", { timeout: 10000 });
    const data = JSON.parse(stdout);

    // Parse rocm-smi JSON output
    const cards = Object.keys(data).filter((k) => k.startsWith("card"));
    if (cards.length === 0) return null;

    const card = data[cards[0]];
    const vramTotal = card?.["VRAM Total Memory (B)"];
    const vramUsed = card?.["VRAM Total Used Memory (B)"];

    if (!vramTotal) return null;

    const vramMB = Math.round(vramTotal / (1024 * 1024));
    const vramUsedMB = vramUsed ? Math.round(vramUsed / (1024 * 1024)) : 0;

    log.debug(`detected AMD GPU (${Math.round(vramMB / 1024)}GB VRAM)`);

    return {
      name: "AMD GPU",
      vramMB,
      vramUsedMB,
      vramFreeMB: vramMB - vramUsedMB,
      utilizationPercent: 0, // rocm-smi would need separate query
    };
  } catch {
    return null;
  }
}

/**
 * Detect Apple Silicon GPU (M1/M2/M3/M4 series).
 * Returns estimated VRAM based on unified memory.
 */
export async function detectAppleSiliconGPU(): Promise<GPUInfo | null> {
  if (os.platform() !== "darwin") return null;
  if (!os.cpus()[0]?.model?.includes("Apple")) return null;

  try {
    const { stdout } = await exec(
      "system_profiler SPDisplaysDataType | grep -E 'Chipset Model:|VRAM'",
      { timeout: 10000 },
    );

    const lines = stdout.trim().split("\n");
    let chipset = "Apple Silicon";

    for (const line of lines) {
      if (line.includes("Chipset Model:")) {
        chipset = line.split(":")[1]?.trim() || chipset;
      }
    }

    // Apple Silicon uses unified memory - estimate GPU share
    const totalMemoryMB = Math.round(os.totalmem() / (1024 * 1024));
    // GPU typically gets ~75% of unified memory
    const estimatedVRAM = Math.round(totalMemoryMB * 0.75);

    log.debug(`detected Apple Silicon GPU: ${chipset} (~${Math.round(estimatedVRAM / 1024)}GB unified)`);

    return {
      name: chipset,
      vramMB: estimatedVRAM,
      vramUsedMB: 0,
      vramFreeMB: estimatedVRAM,
      utilizationPercent: 0,
    };
  } catch {
    return null;
  }
}

/**
 * Detect any available GPU.
 * Tries NVIDIA first, then AMD, then Apple Silicon.
 */
export async function detectGPU(): Promise<GPUInfo | null> {
  // Try NVIDIA first (most common for ML)
  const nvidia = await detectNvidiaGPU();
  if (nvidia) return nvidia;

  // Try AMD
  const amd = await detectAMDGPU();
  if (amd) return amd;

  // Try Apple Silicon
  const apple = await detectAppleSiliconGPU();
  if (apple) return apple;

  return null;
}

// ============================================================
// System Info Detection
// ============================================================

/**
 * Get system RAM in GB.
 */
export function getSystemRAMGB(): number {
  return Math.round(os.totalmem() / (1024 * 1024 * 1024));
}

/**
 * Get system RAM in MB.
 */
export function getSystemRAMMB(): number {
  return Math.round(os.totalmem() / (1024 * 1024));
}

/**
 * Get available (free) RAM in MB.
 */
export function getFreeRAMMB(): number {
  return Math.round(os.freemem() / (1024 * 1024));
}

/**
 * Get CPU load average (1 min).
 * Returns 0-100 percentage on all platforms.
 */
export function getCPULoadPercent(): number {
  const loadAvg = os.loadavg()[0]; // 1-minute average
  const cpuCount = os.cpus().length;
  // Convert to percentage (0-100)
  return Math.min(100, Math.round((loadAvg / cpuCount) * 100));
}

// ============================================================
// Service Detection
// ============================================================

/**
 * Check if Ollama is running and accessible.
 */
export async function isOllamaAvailable(): Promise<boolean> {
  try {
    const { stdout } = await exec("curl -s http://localhost:11434/api/tags", { timeout: 5000 });
    const data = JSON.parse(stdout);
    return Array.isArray(data?.models);
  } catch {
    return false;
  }
}

/**
 * Get list of Ollama models if available.
 */
export async function getOllamaModels(): Promise<string[]> {
  try {
    const { stdout } = await exec("curl -s http://localhost:11434/api/tags", { timeout: 5000 });
    const data = JSON.parse(stdout);
    if (!Array.isArray(data?.models)) return [];
    return data.models.map((m: { name?: string }) => m.name || "").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Check if ComfyUI is running.
 */
export async function isComfyUIAvailable(): Promise<boolean> {
  try {
    const { stdout } = await exec("curl -s http://localhost:8188/system_stats", { timeout: 5000 });
    return stdout.includes("comfyui") || stdout.includes("cuda");
  } catch {
    return false;
  }
}

/**
 * Check if voice services are available (LiveKit or local TTS).
 */
export async function isVoiceAvailable(): Promise<boolean> {
  const cfg = loadConfig() as Record<string, unknown>;

  // Check if TTS is configured
  const tts = cfg.tts as { provider?: string } | undefined;
  if (tts?.provider) return true;

  // Check if LiveKit is configured (may not be in config types yet)
  const livekit = cfg.livekit as { url?: string; apiKey?: string } | undefined;
  if (livekit?.url && livekit?.apiKey) return true;

  return false;
}

// ============================================================
// Media Tool Detection
// ============================================================

export interface FFmpegCapabilities {
  available: boolean;
  version?: string;
  hasNvenc: boolean;
  hasNvdec: boolean;
  hasCuda: boolean;
  hasVulkan: boolean;
  codecs: string[];
}

/**
 * Detect FFmpeg installation and capabilities.
 */
export async function detectFFmpeg(): Promise<FFmpegCapabilities> {
  try {
    // Get version
    const { stdout: versionOut } = await exec("ffmpeg -version", { timeout: 10000 });
    const versionMatch = versionOut.match(/ffmpeg version ([^\s]+)/);
    const version = versionMatch?.[1] ?? "unknown";

    // Check for hardware acceleration
    const hasNvenc = versionOut.includes("--enable-nvenc") || versionOut.includes("nvenc");
    const hasNvdec = versionOut.includes("--enable-nvdec") || versionOut.includes("nvdec");
    const hasCuda = versionOut.includes("--enable-cuda") || versionOut.includes("cuda");
    const hasVulkan = versionOut.includes("--enable-vulkan") || versionOut.includes("vulkan");

    // Get available codecs
    const codecs: string[] = [];
    try {
      const { stdout: codecsOut } = await exec("ffmpeg -codecs 2>&1", { timeout: 10000 });
      if (codecsOut.includes("h264_nvenc")) codecs.push("h264_nvenc");
      if (codecsOut.includes("hevc_nvenc")) codecs.push("hevc_nvenc");
      if (codecsOut.includes("av1_nvenc")) codecs.push("av1_nvenc");
      if (codecsOut.includes("libx264")) codecs.push("libx264");
      if (codecsOut.includes("libx265")) codecs.push("libx265");
      if (codecsOut.includes("libvpx")) codecs.push("libvpx");
    } catch {
      // Codec detection failed
    }

    log.debug(`detected FFmpeg ${version} (nvenc: ${hasNvenc}, cuda: ${hasCuda})`);

    return {
      available: true,
      version,
      hasNvenc,
      hasNvdec,
      hasCuda,
      hasVulkan,
      codecs,
    };
  } catch {
    return {
      available: false,
      hasNvenc: false,
      hasNvdec: false,
      hasCuda: false,
      hasVulkan: false,
      codecs: [],
    };
  }
}

export interface ImageToolCapabilities {
  rembg: boolean;
  realesrgan: boolean;
  pillow: boolean;
  imagemagick: boolean;
}

/**
 * Detect image processing tools.
 */
export async function detectImageTools(): Promise<ImageToolCapabilities> {
  const caps: ImageToolCapabilities = {
    rembg: false,
    realesrgan: false,
    pillow: false,
    imagemagick: false,
  };

  // Check Python tools
  const pythonChecks = [
    { name: "rembg", key: "rembg" as const },
    { name: "realesrgan", key: "realesrgan" as const },
    { name: "PIL", key: "pillow" as const },
  ];

  for (const check of pythonChecks) {
    try {
      await exec(`python -c "import ${check.name === 'PIL' ? 'PIL' : check.name}"`, { timeout: 5000 });
      caps[check.key] = true;
    } catch {
      // Tool not available
    }
  }

  // Check ImageMagick
  try {
    await exec("magick -version", { timeout: 5000 });
    caps.imagemagick = true;
  } catch {
    try {
      await exec("convert -version", { timeout: 5000 });
      caps.imagemagick = true;
    } catch {
      // ImageMagick not available
    }
  }

  log.debug(`detected image tools: rembg=${caps.rembg}, realesrgan=${caps.realesrgan}, pillow=${caps.pillow}, imagemagick=${caps.imagemagick}`);

  return caps;
}

/**
 * Check if ComfyUI is installed (even if not running).
 */
export async function detectComfyUIInstallation(): Promise<{ installed: boolean; running: boolean; path?: string }> {
  // First check if running
  const running = await isComfyUIAvailable();
  if (running) {
    return { installed: true, running: true };
  }

  // Check common installation paths
  const possiblePaths = [
    path.join(os.homedir(), "ComfyUI"),
    path.join(os.homedir(), "Desktop", "ComfyUI"),
    "C:\\ComfyUI",
    "D:\\ComfyUI",
    "/opt/ComfyUI",
    path.join(os.homedir(), "stable-diffusion", "ComfyUI"),
  ];

  for (const p of possiblePaths) {
    try {
      const { existsSync } = await import("node:fs");
      if (existsSync(path.join(p, "main.py")) || existsSync(path.join(p, "comfy", "cli_args.py"))) {
        log.debug(`found ComfyUI installation at: ${p}`);
        return { installed: true, running: false, path: p };
      }
    } catch {
      // Path check failed
    }
  }

  return { installed: false, running: false };
}

// ============================================================
// Manifest Collection
// ============================================================

/**
 * Collect the local compute manifest.
 * Detects all local compute capabilities.
 */
export async function getLocalManifest(): Promise<NodeCapabilities> {
  log.debug("collecting local compute manifest");

  const startMs = Date.now();
  const cfg = loadConfig();

  // Detect GPU
  const gpu = await detectGPU();

  // Check services in parallel
  const [hasOllama, ollamaModels, comfyUIStatus, hasVoice, ffmpegCaps, imageTools] = await Promise.all([
    isOllamaAvailable(),
    getOllamaModels(),
    detectComfyUIInstallation(),
    isVoiceAvailable(),
    detectFFmpeg(),
    detectImageTools(),
  ]);

  // Collect MCP servers from config (may not be in config types yet)
  const mcpServers: string[] = [];
  const cfgAny = cfg as Record<string, unknown>;
  const mcpConfig = cfgAny.mcp as { servers?: Record<string, unknown> } | undefined;
  if (mcpConfig?.servers) {
    for (const [name, server] of Object.entries(mcpConfig.servers)) {
      if (server && typeof server === "object") {
        mcpServers.push(name);
      }
    }
  }

  // Collect agent IDs from agents.list
  const agents: string[] = [];
  if (cfg.agents?.list) {
    for (const agentDef of cfg.agents.list) {
      if (agentDef?.id) {
        agents.push(agentDef.id);
      }
    }
  }

  // Collect workspaces
  const workspaces: string[] = [];
  if (cfg.agents?.defaults?.workspace) {
    workspaces.push(cfg.agents.defaults.workspace);
  }
  // Add individual agent workspaces
  if (cfg.agents?.list) {
    for (const agentDef of cfg.agents.list) {
      if (agentDef?.workspace) {
        workspaces.push(agentDef.workspace);
      }
    }
  }

  // Build media services list based on detected capabilities
  const mediaServices: string[] = [];
  if (ffmpegCaps.available) {
    mediaServices.push("ffmpeg");
    if (ffmpegCaps.hasNvenc) mediaServices.push("nvenc");
  }
  if (imageTools.rembg) mediaServices.push("background-removal");
  if (imageTools.realesrgan) mediaServices.push("upscaling");
  if (imageTools.pillow) mediaServices.push("image-processing");
  if (comfyUIStatus.installed) mediaServices.push("comfyui");

  const capabilities: NodeCapabilities = {
    hasOllama,
    ollamaModels: ollamaModels.length > 0 ? ollamaModels : undefined,
    hasComfyUI: comfyUIStatus.installed,
    comfyUIPath: comfyUIStatus.path,
    hasVoice,
    gpu: gpu?.name,
    gpuVRAM: gpu ? Math.round(gpu.vramMB / 1024) : undefined,
    systemRAM: getSystemRAMGB(),
    mcpServers,
    agents,
    workspaces,
    platform: os.platform(),
    arch: os.arch(),
    // Media capabilities
    ffmpeg: ffmpegCaps.available ? {
      available: true,
      version: ffmpegCaps.version,
      hasNvenc: ffmpegCaps.hasNvenc,
      hasNvdec: ffmpegCaps.hasNvdec,
      hasCuda: ffmpegCaps.hasCuda,
      codecs: ffmpegCaps.codecs,
    } : undefined,
    imageTools: (imageTools.rembg || imageTools.pillow || imageTools.realesrgan || imageTools.imagemagick) ? imageTools : undefined,
    mediaServices: mediaServices.length > 0 ? mediaServices : undefined,
  };

  const durationMs = Date.now() - startMs;
  log.info(`collected local manifest in ${durationMs}ms`, {
    gpu: gpu?.name,
    gpuVRAM: capabilities.gpuVRAM,
    systemRAM: capabilities.systemRAM,
    hasOllama,
    hasComfyUI: comfyUIStatus.installed,
    hasVoice,
    mcpServers: mcpServers.length,
    agents: agents.length,
    mediaServices: mediaServices.length,
  });

  return capabilities;
}

/**
 * Build a full node manifest for this node.
 */
export async function buildLocalNodeManifest(opts?: {
  nodeId?: string;
  nodeName?: string;
  hostname?: string;
  port?: number;
  workspace?: string;
  isMaster?: boolean;
}): Promise<NodeManifest> {
  const cfg = loadConfig();
  const capabilities = await getLocalManifest();

  // Generate node ID - prefer config, then options, then auto-generate from hostname
  const nodeId = opts?.nodeId ?? cfg.federation?.nodeId ?? `node_${os.hostname().toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now().toString(36).slice(-4)}`;
  const nodeName = opts?.nodeName ?? cfg.federation?.nodeName ?? os.hostname();
  const hostname = opts?.hostname ?? os.hostname();
  const port = opts?.port ?? cfg.gateway?.port ?? 47913;
  const workspace =
    opts?.workspace ?? cfg.agents?.defaults?.workspace ?? process.cwd();
  const isMaster = opts?.isMaster ?? cfg.federation?.mode === "master";

  return {
    id: nodeId,
    name: nodeName,
    hostname,
    port,
    workspace,
    capabilities,
    isMaster,
    lastSeenMs: Date.now(),
    currentLoad: getCPULoadPercent(),
    activeSessions: 0, // Will be updated by session manager
  };
}

// ============================================================
// Node Manifest Storage
// ============================================================

/** In-memory storage for remote node manifests */
const remoteManifests = new Map<string, NodeManifest>();

/**
 * Update/store a remote node's manifest.
 */
export function updateNodeManifest(nodeId: string, manifest: NodeManifest): void {
  remoteManifests.set(nodeId, {
    ...manifest,
    lastSeenMs: Date.now(),
  });
  log.debug(`updated manifest for node: ${manifest.name} (${nodeId})`);
}

/**
 * Get a stored node manifest.
 */
export function getNodeManifest(nodeId: string): NodeManifest | undefined {
  return remoteManifests.get(nodeId);
}

/**
 * Remove a node's manifest.
 */
export function removeNodeManifest(nodeId: string): boolean {
  return remoteManifests.delete(nodeId);
}

/**
 * Get all stored node manifests.
 */
export function getAllNodeManifests(): NodeManifest[] {
  return [...remoteManifests.values()];
}

/**
 * Clear all stored manifests.
 */
export function clearNodeManifests(): void {
  remoteManifests.clear();
}

// ============================================================
// Live Status Updates
// ============================================================

export interface ComputeStatus {
  gpuUtilization?: number;
  gpuVRAMUsedMB?: number;
  gpuVRAMFreeMB?: number;
  cpuLoadPercent: number;
  ramUsedMB: number;
  ramFreeMB: number;
}

/**
 * Get current compute status (live metrics).
 */
export async function getComputeStatus(): Promise<ComputeStatus> {
  const gpu = await detectNvidiaGPU();
  const totalRAM = getSystemRAMMB();
  const freeRAM = getFreeRAMMB();

  return {
    gpuUtilization: gpu?.utilizationPercent,
    gpuVRAMUsedMB: gpu?.vramUsedMB,
    gpuVRAMFreeMB: gpu?.vramFreeMB,
    cpuLoadPercent: getCPULoadPercent(),
    ramUsedMB: totalRAM - freeRAM,
    ramFreeMB: freeRAM,
  };
}

/**
 * Calculate overall load score (0-100).
 * Combines CPU, RAM, and GPU metrics.
 */
export async function calculateLoadScore(): Promise<number> {
  const status = await getComputeStatus();

  const cpuWeight = 0.4;
  const ramWeight = 0.3;
  const gpuWeight = 0.3;

  const totalRAM = getSystemRAMMB();
  const ramPercent = ((totalRAM - status.ramFreeMB) / totalRAM) * 100;

  let score = status.cpuLoadPercent * cpuWeight + ramPercent * ramWeight;

  if (status.gpuUtilization !== undefined) {
    score += status.gpuUtilization * gpuWeight;
  } else {
    // No GPU - redistribute weight to CPU/RAM
    score = status.cpuLoadPercent * 0.55 + ramPercent * 0.45;
  }

  return Math.min(100, Math.round(score));
}

// ============================================================
// Refresh Scheduler
// ============================================================

let refreshInterval: NodeJS.Timeout | null = null;
let cachedManifest: NodeCapabilities | null = null;
let lastRefreshMs = 0;

/**
 * Get cached local manifest, refreshing if stale.
 */
export async function getCachedLocalManifest(maxAgeMs = 60000): Promise<NodeCapabilities> {
  if (cachedManifest && Date.now() - lastRefreshMs < maxAgeMs) {
    return cachedManifest;
  }

  cachedManifest = await getLocalManifest();
  lastRefreshMs = Date.now();
  return cachedManifest;
}

/**
 * Start periodic manifest refresh.
 */
export function startManifestRefresh(intervalMs = 60000): void {
  if (refreshInterval) return;

  refreshInterval = setInterval(async () => {
    try {
      cachedManifest = await getLocalManifest();
      lastRefreshMs = Date.now();
    } catch (err) {
      log.error("failed to refresh manifest", { error: err });
    }
  }, intervalMs);

  // Initial refresh
  getLocalManifest()
    .then((m) => {
      cachedManifest = m;
      lastRefreshMs = Date.now();
    })
    .catch((err) => {
      log.error("failed initial manifest collection", { error: err });
    });
}

/**
 * Stop periodic manifest refresh.
 */
export function stopManifestRefresh(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}
