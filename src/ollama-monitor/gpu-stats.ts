/**
 * GPU Stats Module
 * Parses nvidia-smi output for GPU statistics.
 */

import { exec } from "child_process";
import { promisify } from "util";
import type { GpuStats } from "./types.js";

const execAsync = promisify(exec);

// nvidia-smi query command
const NVIDIA_SMI_CMD =
  "nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free,temperature.gpu,utilization.gpu,power.draw --format=csv,noheader,nounits";

/**
 * Parse nvidia-smi output into GpuStats
 *
 * @example Output format:
 * "NVIDIA GeForce RTX 5090, 32768, 12345, 20423, 45, 25, 150.50"
 */
function parseNvidiaSmiOutput(output: string): GpuStats | null {
  const trimmed = output.trim();
  if (!trimmed) return null;

  // Handle multiple GPUs - take the first one for now
  const firstLine = trimmed.split("\n")[0];
  const parts = firstLine.split(",").map((p) => p.trim());

  if (parts.length < 7) {
    return null;
  }

  const [name, memTotalMB, memUsedMB, memFreeMB, tempC, utilPercent, powerW] = parts;

  // Convert MB to bytes
  const MB_TO_BYTES = 1024 * 1024;

  return {
    name: name,
    vramTotal: parseFloat(memTotalMB) * MB_TO_BYTES,
    vramUsed: parseFloat(memUsedMB) * MB_TO_BYTES,
    vramFree: parseFloat(memFreeMB) * MB_TO_BYTES,
    temperature: parseFloat(tempC),
    utilization: parseFloat(utilPercent),
    powerDraw: parseFloat(powerW),
  };
}

/**
 * Get GPU stats from nvidia-smi
 *
 * @param host - Optional SSH host for remote execution (e.g., "user@192.0.2.7")
 * @returns GpuStats or null if nvidia-smi is not available or fails
 */
export async function getGpuStats(host?: string): Promise<GpuStats | null> {
  try {
    const command = host ? `ssh ${host} "${NVIDIA_SMI_CMD.replace(/"/g, '\\"')}"` : NVIDIA_SMI_CMD;

    const { stdout, stderr } = await execAsync(command, {
      timeout: 10000,
      windowsHide: true,
    });

    if (stderr && !stdout) {
      return null;
    }

    return parseNvidiaSmiOutput(stdout);
  } catch (error: any) {
    // nvidia-smi not found or failed
    if (
      error.code === "ENOENT" ||
      error.message?.includes("not found") ||
      error.message?.includes("not recognized")
    ) {
      return null;
    }
    // SSH timeout or connection failed
    if (error.killed || error.code === "ETIMEDOUT") {
      return null;
    }
    return null;
  }
}

/**
 * Check if nvidia-smi is available
 */
export async function isNvidiaSmiAvailable(host?: string): Promise<boolean> {
  try {
    const command = host ? `ssh ${host} "nvidia-smi --version"` : "nvidia-smi --version";

    await execAsync(command, { timeout: 5000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get all GPUs (for multi-GPU systems)
 */
export async function getAllGpuStats(host?: string): Promise<GpuStats[]> {
  try {
    const command = host ? `ssh ${host} "${NVIDIA_SMI_CMD.replace(/"/g, '\\"')}"` : NVIDIA_SMI_CMD;

    const { stdout } = await execAsync(command, {
      timeout: 10000,
      windowsHide: true,
    });

    const lines = stdout
      .trim()
      .split("\n")
      .filter((l) => l.trim());
    const gpus: GpuStats[] = [];

    for (const line of lines) {
      const gpu = parseNvidiaSmiOutput(line);
      if (gpu) {
        gpus.push(gpu);
      }
    }

    return gpus;
  } catch {
    return [];
  }
}
