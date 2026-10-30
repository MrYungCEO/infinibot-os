/**
 * Autonomy Architecture — Hardware & Activity Detection
 * Monitors system resources and user activity for smart scheduling
 */

import { exec } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import os from "os";
import { SystemActivityState, HardwareThresholds, DEFAULT_AUTONOMY_CONFIG } from "./types.js";
import { logAudit } from "./audit.js";

const execAsync = promisify(exec);

let thresholds: HardwareThresholds = DEFAULT_AUTONOMY_CONFIG.hardwareThresholds;
let lastActivityState: SystemActivityState | null = null;
const isWindows = process.platform === "win32";
const isLinux = process.platform === "linux";
const isMac = process.platform === "darwin";

// CPU sampling state for Linux (delta-based percent)
let _cpuLastTotal = 0;
let _cpuLastIdle = 0;

/**
 * Initialize hardware monitoring with custom thresholds
 */
export function initHardware(customThresholds?: Partial<HardwareThresholds>): void {
  if (customThresholds) {
    thresholds = { ...thresholds, ...customThresholds };
  }
}

/**
 * Get user idle time on Windows (via PowerShell)
 */
async function getWindowsIdleTime(): Promise<number> {
  try {
    const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;

public class IdleTime {
    [DllImport("user32.dll")]
    static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
    
    [StructLayout(LayoutKind.Sequential)]
    struct LASTINPUTINFO {
        public uint cbSize;
        public uint dwTime;
    }
    
    public static uint GetIdleTime() {
        LASTINPUTINFO lii = new LASTINPUTINFO();
        lii.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
        GetLastInputInfo(ref lii);
        return ((uint)Environment.TickCount - lii.dwTime);
    }
}
"@
[IdleTime]::GetIdleTime()
`.trim();

    const { stdout } = await execAsync(
      `powershell -Command "${script.replace(/"/g, '\\"').replace(/\n/g, " ")}"`,
      {
        timeout: 10000,
      },
    );

    return parseInt(stdout.trim(), 10) || 0;
  } catch {
    // Fallback: assume user is active
    return 0;
  }
}

/**
 * Get CPU usage on Windows
 */
async function getWindowsCpuUsage(): Promise<number> {
  try {
    const { stdout } = await execAsync(
      "powershell -Command \"(Get-Counter '\\Processor(_Total)\\% Processor Time').CounterSamples.CookedValue\"",
      { timeout: 10000 },
    );
    return parseFloat(stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

/**
 * Get memory usage on Windows
 */
async function getWindowsMemoryUsage(): Promise<number> {
  try {
    const { stdout } = await execAsync(
      'powershell -Command "$os = Get-CimInstance Win32_OperatingSystem; [math]::Round(100 - ($os.FreePhysicalMemory / $os.TotalVisibleMemorySize * 100), 2)"',
      { timeout: 10000 },
    );
    return parseFloat(stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

/**
 * Linux: idle time via xprintidle / loginctl, falling back to 0 (assume active).
 */
async function getLinuxIdleTime(): Promise<number> {
  try {
    const { stdout } = await execAsync("xprintidle", { timeout: 1500 });
    const n = parseInt(stdout.trim(), 10);
    if (!isNaN(n)) return n;
  } catch {}
  try {
    const { stdout } = await execAsync(
      "loginctl show-session $(loginctl | awk 'NR==2{print $1}') -p IdleSinceHint --value",
      { timeout: 1500, shell: "/bin/bash" as any },
    );
    const hintUs = parseInt(stdout.trim(), 10);
    if (!isNaN(hintUs) && hintUs > 0) {
      const nowUs = Date.now() * 1000;
      return Math.max(0, Math.floor((nowUs - hintUs) / 1000));
    }
  } catch {}
  // No idle source — assume active so autonomy doesn't run on top of the user.
  return 0;
}

/**
 * Linux CPU% via /proc/stat delta sample.
 */
async function getLinuxCpuUsage(): Promise<number> {
  try {
    const buf = await readFile("/proc/stat", "utf8");
    const line = buf.split("\n", 1)[0];
    const fields = line.trim().split(/\s+/).slice(1).map(Number);
    if (fields.length < 4 || fields.some((n) => isNaN(n))) return 0;
    const idle = (fields[3] || 0) + (fields[4] || 0); // idle + iowait
    const total = fields.reduce((a, b) => a + b, 0);
    let pct = 0;
    if (_cpuLastTotal > 0) {
      const totalDelta = total - _cpuLastTotal;
      const idleDelta = idle - _cpuLastIdle;
      if (totalDelta > 0) {
        pct = Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100));
      }
    } else {
      // First call: sample short window so we don't return 0.
      _cpuLastTotal = total;
      _cpuLastIdle = idle;
      await new Promise((r) => setTimeout(r, 250));
      const buf2 = await readFile("/proc/stat", "utf8");
      const f2 = buf2.split("\n", 1)[0].trim().split(/\s+/).slice(1).map(Number);
      if (f2.length >= 4 && !f2.some((n) => isNaN(n))) {
        const idle2 = (f2[3] || 0) + (f2[4] || 0);
        const total2 = f2.reduce((a, b) => a + b, 0);
        const totalDelta = total2 - total;
        const idleDelta = idle2 - idle;
        if (totalDelta > 0) {
          pct = Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100));
        }
        _cpuLastTotal = total2;
        _cpuLastIdle = idle2;
        return pct;
      }
    }
    _cpuLastTotal = total;
    _cpuLastIdle = idle;
    return pct;
  } catch {
    return 0;
  }
}

/**
 * Linux memory% from /proc/meminfo.
 */
async function getLinuxMemoryUsage(): Promise<number> {
  try {
    const buf = await readFile("/proc/meminfo", "utf8");
    const map: Record<string, number> = {};
    for (const ln of buf.split("\n")) {
      const m = ln.match(/^(\w+):\s+(\d+)\s+kB/);
      if (m) map[m[1]] = parseInt(m[2], 10);
    }
    const total = map.MemTotal || 0;
    const avail = map.MemAvailable || map.MemFree || 0;
    if (!total) return 0;
    return Math.max(0, Math.min(100, ((total - avail) / total) * 100));
  } catch {
    return 0;
  }
}

/**
 * Linux: top processes by CPU.
 */
async function getLinuxProcesses(): Promise<string[]> {
  try {
    const { stdout } = await execAsync("ps -eo comm --sort=-pcpu --no-headers | head -10", {
      timeout: 1500,
      shell: "/bin/bash" as any,
    });
    return stdout
      .trim()
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * macOS CPU% via top -l1 fallback.
 */
async function getMacCpuUsage(): Promise<number> {
  try {
    const { stdout } = await execAsync("top -l 1 -n 0 | awk '/CPU usage/ {print $3}'", {
      timeout: 2500,
      shell: "/bin/bash" as any,
    });
    const n = parseFloat(stdout.replace("%", "").trim());
    return isNaN(n) ? 0 : n;
  } catch {
    return 0;
  }
}

async function getMacMemoryUsage(): Promise<number> {
  try {
    const total = os.totalmem();
    const free = os.freemem();
    return Math.max(0, Math.min(100, ((total - free) / total) * 100));
  } catch {
    return 0;
  }
}

async function getMacIdleTime(): Promise<number> {
  try {
    const { stdout } = await execAsync(
      "ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print $NF/1000000; exit}'",
      { timeout: 1500, shell: "/bin/bash" as any },
    );
    const ms = parseFloat(stdout.trim());
    return isNaN(ms) ? 0 : Math.floor(ms);
  } catch {
    return 0;
  }
}

async function getMacProcesses(): Promise<string[]> {
  try {
    const { stdout } = await execAsync("ps -A -o comm -r | head -10 | tail -n +2", {
      timeout: 1500,
      shell: "/bin/bash" as any,
    });
    return stdout
      .trim()
      .split("\n")
      .map((s) => s.split("/").pop() || s)
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Get NVIDIA GPU memory usage
 */
async function getNvidiaGpuMemory(): Promise<{ used: number; total: number } | null> {
  try {
    const { stdout } = await execAsync(
      "nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits",
      { timeout: 10000 },
    );

    const [used, total] = stdout
      .trim()
      .split(",")
      .map((s) => parseInt(s.trim(), 10));

    if (!isNaN(used) && !isNaN(total)) {
      return { used, total };
    }
  } catch {
    // No NVIDIA GPU or nvidia-smi not available
  }

  return null;
}

/**
 * Get list of running processes (simplified)
 */
async function getRunningProcesses(): Promise<string[]> {
  try {
    const { stdout } = await execAsync(
      'powershell -Command "Get-Process | Where-Object { $_.CPU -gt 1 } | Select-Object -First 10 -ExpandProperty ProcessName"',
      { timeout: 10000 },
    );
    return stdout.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Check full system activity state
 */
export async function checkSystemActivity(): Promise<SystemActivityState> {
  const now = Date.now();

  // Get all metrics in parallel, dispatching by platform
  const idlePromise = isWindows
    ? getWindowsIdleTime()
    : isMac
      ? getMacIdleTime()
      : isLinux
        ? getLinuxIdleTime()
        : Promise.resolve(0);
  const cpuPromise = isWindows
    ? getWindowsCpuUsage()
    : isMac
      ? getMacCpuUsage()
      : isLinux
        ? getLinuxCpuUsage()
        : Promise.resolve(0);
  const memPromise = isWindows
    ? getWindowsMemoryUsage()
    : isMac
      ? getMacMemoryUsage()
      : isLinux
        ? getLinuxMemoryUsage()
        : Promise.resolve(0);
  const procPromise = isWindows
    ? getRunningProcesses()
    : isMac
      ? getMacProcesses()
      : isLinux
        ? getLinuxProcesses()
        : Promise.resolve([] as string[]);

  const [idleTimeMs, cpuUsage, memoryUsage, gpuMemory, processes] = await Promise.all([
    idlePromise,
    cpuPromise,
    memPromise,
    getNvidiaGpuMemory(),
    procPromise,
  ]);

  const state: SystemActivityState = {
    lastCheck: now,
    isUserActive: idleTimeMs < thresholds.idleThresholdMs,
    idleTimeMs,
    cpuUsagePercent: cpuUsage,
    memoryUsagePercent: memoryUsage,
    gpuMemoryUsedMb: gpuMemory?.used,
    gpuMemoryTotalMb: gpuMemory?.total,
    processesRunning: processes,
  };

  // Log significant state changes
  if (lastActivityState) {
    const wasActive = lastActivityState.isUserActive;
    const isActive = state.isUserActive;

    if (wasActive !== isActive) {
      logAudit("hardware_check", isActive ? "User became active" : "User became idle", {
        category: "system",
        details: {
          idleTimeMs,
          idleThreshold: thresholds.idleThresholdMs,
        },
      });
    }
  }

  lastActivityState = state;
  return state;
}

/**
 * Check if it's safe to run hardware-intensive tasks
 */
export async function canRunHardwareIntensive(): Promise<{
  allowed: boolean;
  reason?: string;
  state: SystemActivityState;
}> {
  const state = await checkSystemActivity();

  // User is active — don't run intensive tasks
  if (state.isUserActive) {
    return {
      allowed: false,
      reason: `User is active (idle ${Math.round(state.idleTimeMs / 1000)}s < ${Math.round(thresholds.idleThresholdMs / 1000)}s threshold)`,
      state,
    };
  }

  // CPU too high
  if (state.cpuUsagePercent > thresholds.maxCpuPercent) {
    return {
      allowed: false,
      reason: `CPU usage too high (${state.cpuUsagePercent.toFixed(1)}% > ${thresholds.maxCpuPercent}% limit)`,
      state,
    };
  }

  // Memory too high
  if (state.memoryUsagePercent > thresholds.maxMemoryPercent) {
    return {
      allowed: false,
      reason: `Memory usage too high (${state.memoryUsagePercent.toFixed(1)}% > ${thresholds.maxMemoryPercent}% limit)`,
      state,
    };
  }

  // GPU memory too high (if available)
  if (state.gpuMemoryUsedMb && state.gpuMemoryTotalMb) {
    const gpuPercent = (state.gpuMemoryUsedMb / state.gpuMemoryTotalMb) * 100;
    if (gpuPercent > thresholds.maxGpuMemoryPercent) {
      return {
        allowed: false,
        reason: `GPU memory too high (${gpuPercent.toFixed(1)}% > ${thresholds.maxGpuMemoryPercent}% limit)`,
        state,
      };
    }
  }

  return {
    allowed: true,
    state,
  };
}

/**
 * Quick check if user is idle
 */
export async function isUserIdle(): Promise<boolean> {
  const idleTime = await getWindowsIdleTime();
  return idleTime >= thresholds.idleThresholdMs;
}

/**
 * Get formatted idle time
 */
export async function getIdleTimeFormatted(): Promise<string> {
  const idleMs = await getWindowsIdleTime();

  if (idleMs < 60000) {
    return `${Math.round(idleMs / 1000)}s`;
  } else if (idleMs < 3600000) {
    return `${Math.round(idleMs / 60000)}m`;
  } else {
    return `${(idleMs / 3600000).toFixed(1)}h`;
  }
}

/**
 * Get last known activity state (without re-checking)
 */
export function getLastActivityState(): SystemActivityState | null {
  return lastActivityState;
}

// Export convenience object
export const hardware = {
  init: initHardware,
  check: checkSystemActivity,
  canRunIntensive: canRunHardwareIntensive,
  isUserIdle,
  getIdleTime: getIdleTimeFormatted,
  getLastState: getLastActivityState,
};
