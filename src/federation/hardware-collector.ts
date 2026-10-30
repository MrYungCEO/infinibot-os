/**
 * Shared HardwareSnapshot collector.
 *
 * Used by:
 *  - Master gateway (server-hardware-http.ts) — collects its own snapshot.
 *  - Satellite (federation/satellite.ts) — collects its snapshot and pushes
 *    it up to the master via the `hardware.snapshot` federation message.
 *
 * Keeping snapshot collection in one place ensures both sides emit the same
 * shape and use the same per-tick measurements (CPU delta, network counters,
 * GPU cache, etc.).
 */

import os from "node:os";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execCb);

// ─── Snapshot type ────────────────────────────────────────────────────────────

export interface HardwareSnapshot {
  cpu: {
    percent: number;
    perCorePercent: number[];
    loadAvg: [number, number, number];
    cores: number;
    model: string;
  };
  memory: {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    percent: number;
  };
  gpu: {
    vendor: string;
    utilizationPercent: number;
    vramUsedBytes: number;
    vramTotalBytes: number;
    name: string;
  } | null;
  disk: {
    mounts: Array<{ path: string; totalBytes: number; usedBytes: number; percent: number }>;
  };
  network: {
    interfaces: Array<{ name: string; rxBytesPerSec: number; txBytesPerSec: number }>;
  };
  system: {
    hostname: string;
    platform: string;
    arch: string;
    uptimeSec: number;
    kernelRelease: string;
  };
  processes: Array<{ pid: number; name: string; cpuPercent: number; memoryBytes: number }>;
  timestamp: number;
}

// ─── Aggregate CPU ────────────────────────────────────────────────────────────

interface CPUMeasurement {
  idle: number;
  total: number;
}
let lastCPUMeasurement: CPUMeasurement | null = null;

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

export function getCPUPercent(): number {
  const current = getCPUTimes();
  if (!lastCPUMeasurement) {
    lastCPUMeasurement = current;
    const loadAvg = os.loadavg()[0];
    const cpuCount = os.cpus().length;
    return Math.min(100, Math.round((loadAvg / cpuCount) * 100));
  }
  const idleDiff = current.idle - lastCPUMeasurement.idle;
  const totalDiff = current.total - lastCPUMeasurement.total;
  lastCPUMeasurement = current;
  if (totalDiff === 0) return 0;
  return Math.max(0, Math.min(100, Math.round(100 - (idleDiff / totalDiff) * 100)));
}

// ─── Per-core CPU ─────────────────────────────────────────────────────────────

interface CoreMeasurement {
  idle: number;
  total: number;
}
let lastCoreMeasurements: CoreMeasurement[] | null = null;

function getPerCoreCPUPercent(): number[] {
  const cpus = os.cpus();
  const current = cpus.map((cpu) => {
    const idle = cpu.times.idle;
    const total = cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
    return { idle, total };
  });

  if (!lastCoreMeasurements || lastCoreMeasurements.length !== current.length) {
    lastCoreMeasurements = current;
    const loadAvg = os.loadavg()[0];
    return cpus.map(() => Math.min(100, Math.round((loadAvg / cpus.length) * 100)));
  }

  const result = current.map((cur, i) => {
    const prev = lastCoreMeasurements![i];
    const idleDiff = cur.idle - prev.idle;
    const totalDiff = cur.total - prev.total;
    if (totalDiff === 0) return 0;
    return Math.max(0, Math.min(100, Math.round(100 - (idleDiff / totalDiff) * 100)));
  });

  lastCoreMeasurements = current;
  return result;
}

// ─── GPU (cached) ─────────────────────────────────────────────────────────────

interface GpuCacheEntry {
  value: HardwareSnapshot["gpu"];
  cachedAt: number;
}
let gpuCache: GpuCacheEntry | null = null;

async function getCachedGpuData(): Promise<HardwareSnapshot["gpu"]> {
  const now = Date.now();
  if (gpuCache && now - gpuCache.cachedAt < 2000) return gpuCache.value;

  const started = Date.now();
  // NVIDIA
  try {
    const { stdout } = await exec(
      "nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits",
      { timeout: 3000 },
    );
    const line = stdout.trim().split("\n")[0];
    if (line) {
      const parts = line.split(",").map((p) => p.trim());
      if (parts.length >= 4) {
        const [name, utilStr, usedStr, totalStr] = parts;
        const utilizationPercent = parseInt(utilStr ?? "0", 10);
        const usedMB = parseInt(usedStr ?? "0", 10);
        const totalMB = parseInt(totalStr ?? "0", 10);
        if (!isNaN(utilizationPercent) && !isNaN(usedMB) && !isNaN(totalMB) && totalMB > 0) {
          const entry: HardwareSnapshot["gpu"] = {
            vendor: "NVIDIA",
            name: name ?? "NVIDIA GPU",
            utilizationPercent,
            vramUsedBytes: usedMB * 1024 * 1024,
            vramTotalBytes: totalMB * 1024 * 1024,
          };
          const elapsed = Date.now() - started;
          const cacheTtl = elapsed > 500 ? Math.max(2000, elapsed * 2) : 2000;
          gpuCache = { value: entry, cachedAt: now - (2000 - cacheTtl) };
          return entry;
        }
      }
    }
  } catch {
    /* no NVIDIA */
  }

  // AMD (Linux only)
  if (os.platform() === "linux") {
    try {
      const { stdout } = await exec("rocm-smi --showuse --showmeminfo vram --json", {
        timeout: 3000,
      });
      const data = JSON.parse(stdout) as Record<string, Record<string, unknown>>;
      const cards = Object.keys(data).filter((k) => k.startsWith("card"));
      if (cards.length > 0) {
        const card = data[cards[0]] ?? {};
        const utilizationPercent = Number(card["GPU use (%)"]) || 0;
        const usedMB = Math.round(
          (Number(card["VRAM Total Used Memory (B)"]) || 0) / (1024 * 1024),
        );
        const totalMB = Math.round((Number(card["VRAM Total Memory (B)"]) || 0) / (1024 * 1024));
        const entry: HardwareSnapshot["gpu"] = {
          vendor: "AMD",
          name: "AMD Radeon GPU",
          utilizationPercent,
          vramUsedBytes: usedMB * 1024 * 1024,
          vramTotalBytes: totalMB * 1024 * 1024,
        };
        gpuCache = { value: entry, cachedAt: now };
        return entry;
      }
    } catch {
      /* no AMD */
    }
  }

  gpuCache = { value: null, cachedAt: now };
  return null;
}

// ─── Disk ─────────────────────────────────────────────────────────────────────

// Pseudo / virtual mount points we don't want to surface.
const PSEUDO_FS_PREFIXES = ["/sys", "/proc", "/dev", "/run", "/boot/efi", "/snap"];

function isPseudoMount(path: string): boolean {
  if (path === "none" || path === "tmpfs") return true;
  return PSEUDO_FS_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

async function getDiskStats(): Promise<HardwareSnapshot["disk"]> {
  if (os.platform() === "win32") return { mounts: [] };
  try {
    // `df -P` (POSIX) — all mounts, one line per filesystem
    const { stdout } = await exec("df -P", { timeout: 2500 });
    const lines = stdout.trim().split("\n").slice(1);
    const seen = new Set<string>();
    const mounts: HardwareSnapshot["disk"]["mounts"] = [];
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) continue;
      const totalKB = parseInt(parts[1] ?? "0", 10);
      const usedKB = parseInt(parts[2] ?? "0", 10);
      const pct = parseInt((parts[4] ?? "0%").replace("%", ""), 10);
      const mountPath = parts.slice(5).join(" ");
      if (!mountPath || !isFinite(totalKB) || totalKB <= 0) continue;
      if (isPseudoMount(mountPath)) continue;
      if (seen.has(mountPath)) continue;
      seen.add(mountPath);
      mounts.push({
        path: mountPath,
        totalBytes: totalKB * 1024,
        usedBytes: usedKB * 1024,
        percent: isNaN(pct) ? 0 : pct,
      });
    }
    // Largest first — generally most relevant to user.
    mounts.sort((a, b) => b.totalBytes - a.totalBytes);
    return { mounts };
  } catch {
    return { mounts: [] };
  }
}

// ─── Network ──────────────────────────────────────────────────────────────────

interface NetCounter {
  rx: number;
  tx: number;
  ts: number;
}
const lastNetCounters = new Map<string, NetCounter>();

async function getNetworkStats(): Promise<HardwareSnapshot["network"]> {
  if (os.platform() !== "linux") return { interfaces: [] };
  try {
    const { stdout } = await exec("cat /proc/net/dev", { timeout: 1000 });
    const now = Date.now();
    const lines = stdout.trim().split("\n").slice(2);
    const collected: Array<{
      name: string;
      rxBytesPerSec: number;
      txBytesPerSec: number;
      total: number;
    }> = [];

    for (const line of lines) {
      const trimmed = line.trim();
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx < 0) continue;
      const iface = trimmed.slice(0, colonIdx).trim();
      if (iface === "lo") continue;
      const parts = trimmed
        .slice(colonIdx + 1)
        .trim()
        .split(/\s+/);
      const rx = parseInt(parts[0] ?? "0", 10);
      const tx = parseInt(parts[8] ?? "0", 10);
      if (isNaN(rx) || isNaN(tx)) continue;

      const last = lastNetCounters.get(iface);
      let rxBytesPerSec = 0;
      let txBytesPerSec = 0;
      if (last) {
        const elapsedSec = Math.max(0.001, (now - last.ts) / 1000);
        rxBytesPerSec = Math.max(0, (rx - last.rx) / elapsedSec);
        txBytesPerSec = Math.max(0, (tx - last.tx) / elapsedSec);
      }
      lastNetCounters.set(iface, { rx, tx, ts: now });
      collected.push({
        name: iface,
        rxBytesPerSec,
        txBytesPerSec,
        total: rxBytesPerSec + txBytesPerSec,
      });
    }
    collected.sort((a, b) => b.total - a.total);
    return {
      interfaces: collected.map(({ name, rxBytesPerSec, txBytesPerSec }) => ({
        name,
        rxBytesPerSec,
        txBytesPerSec,
      })),
    };
  } catch {
    return { interfaces: [] };
  }
}

// ─── Processes ────────────────────────────────────────────────────────────────

interface ProcCacheEntry {
  value: HardwareSnapshot["processes"];
  cachedAt: number;
}
let procCache: ProcCacheEntry | null = null;

async function getTopProcesses(): Promise<HardwareSnapshot["processes"]> {
  const now = Date.now();
  if (procCache && now - procCache.cachedAt < 4000) return procCache.value;
  if (os.platform() === "win32") {
    procCache = { value: [], cachedAt: now };
    return [];
  }
  try {
    // ps -eo pid,pcpu,rss,comm  — pcpu is averaged since process start; good
    // enough for a "top processes" indicator without sampling.
    const { stdout } = await exec("ps -eo pid,pcpu,rss,comm --sort=-pcpu --no-headers", {
      timeout: 2500,
    });
    const lines = stdout.trim().split("\n").slice(0, 5);
    const procs: HardwareSnapshot["processes"] = [];
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) continue;
      const pid = parseInt(parts[0] ?? "0", 10);
      const cpuPercent = parseFloat(parts[1] ?? "0");
      const rssKB = parseInt(parts[2] ?? "0", 10);
      const name = parts.slice(3).join(" ");
      if (!pid || isNaN(pid)) continue;
      procs.push({
        pid,
        name: name || "?",
        cpuPercent: isNaN(cpuPercent) ? 0 : Math.round(cpuPercent * 10) / 10,
        memoryBytes: isNaN(rssKB) ? 0 : rssKB * 1024,
      });
    }
    procCache = { value: procs, cachedAt: now };
    return procs;
  } catch {
    procCache = { value: [], cachedAt: now };
    return [];
  }
}

// ─── Memory helpers (re-exported for callers that want raw counters) ──────────

export function getMemoryPercent(): number {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  return Math.round((used / total) * 100);
}

export function getMemoryInfo(): { totalMB: number; usedMB: number; freeMB: number } {
  const total = os.totalmem();
  const free = os.freemem();
  return {
    totalMB: Math.round(total / (1024 * 1024)),
    usedMB: Math.round((total - free) / (1024 * 1024)),
    freeMB: Math.round(free / (1024 * 1024)),
  };
}

// ─── Collect ──────────────────────────────────────────────────────────────────

export async function collectHardwareSnapshot(): Promise<HardwareSnapshot> {
  const cpuPercent = getCPUPercent();
  const perCorePercent = getPerCoreCPUPercent();
  const cpus = os.cpus();
  const model = cpus[0]?.model?.trim() ?? "Unknown CPU";
  const loadAvgRaw = os.loadavg();
  const loadAvg: [number, number, number] = [
    parseFloat(loadAvgRaw[0].toFixed(2)),
    parseFloat(loadAvgRaw[1].toFixed(2)),
    parseFloat(loadAvgRaw[2].toFixed(2)),
  ];

  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = totalBytes - freeBytes;

  const [gpu, disk, network, processes] = await Promise.all([
    getCachedGpuData(),
    getDiskStats(),
    getNetworkStats(),
    getTopProcesses(),
  ]);

  return {
    cpu: { percent: cpuPercent, perCorePercent, loadAvg, cores: cpus.length, model },
    memory: {
      totalBytes,
      usedBytes,
      freeBytes,
      percent: Math.round((usedBytes / totalBytes) * 100),
    },
    gpu,
    disk,
    network,
    system: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      uptimeSec: Math.round(os.uptime()),
      kernelRelease: os.release(),
    },
    processes,
    timestamp: Date.now(),
  };
}

// ─── Diff helper (used by satellite throttle) ─────────────────────────────────

/**
 * Returns true if two snapshots differ by >= thresholdPct on any axis we care
 * about (cpu, mem, gpu util/vram, top network total).  Used by satellites to
 * skip a push when nothing has meaningfully changed.
 */
export function snapshotMeaningfullyChanged(
  a: HardwareSnapshot | null,
  b: HardwareSnapshot,
  thresholdPct = 2,
): boolean {
  if (!a) return true;
  if (Math.abs(a.cpu.percent - b.cpu.percent) >= thresholdPct) return true;
  if (Math.abs(a.memory.percent - b.memory.percent) >= thresholdPct) return true;
  const aGpu = a.gpu?.utilizationPercent ?? 0;
  const bGpu = b.gpu?.utilizationPercent ?? 0;
  if (Math.abs(aGpu - bGpu) >= thresholdPct) return true;
  const aVram =
    a.gpu && a.gpu.vramTotalBytes > 0 ? (a.gpu.vramUsedBytes / a.gpu.vramTotalBytes) * 100 : 0;
  const bVram =
    b.gpu && b.gpu.vramTotalBytes > 0 ? (b.gpu.vramUsedBytes / b.gpu.vramTotalBytes) * 100 : 0;
  if (Math.abs(aVram - bVram) >= thresholdPct) return true;
  const aNet = a.network.interfaces[0]?.rxBytesPerSec ?? 0;
  const bNet = b.network.interfaces[0]?.rxBytesPerSec ?? 0;
  // For network we use absolute byte threshold (>=64 KB/s change) since
  // percent doesn't make sense here.
  if (Math.abs(aNet - bNet) >= 64 * 1024) return true;
  return false;
}
