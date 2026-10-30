/**
 * SSH Device Scanner - Network discovery for SSH-enabled devices
 * Supports real-time progress callbacks for UI updates
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import type { SSHDeviceScanResult, SSHDeviceConnectionTest } from "./types.js";
import { spawn } from "child_process";
import { Socket } from "net";
import { broadcastSSHEvent, type SSHEventContext } from "./events.js";

const log = createSubsystemLogger("ssh-scanner");

// Default SSH port
const SSH_PORT = 22;

// Timeout for port checks (ms)
const PORT_CHECK_TIMEOUT = 2000;

/**
 * Progress callback for real-time scan updates
 */
export type ScanProgressCallback = (event: ScanProgressEvent) => void;

export type ScanProgressEvent =
  | { type: "start"; subnet: string; total: number; port: number }
  | { type: "checking"; ip: string; current: number; total: number }
  | { type: "found"; device: SSHDeviceScanResult; current: number; total: number }
  | {
      type: "checked";
      ip: string;
      found: boolean;
      current: number;
      total: number;
      responseTime?: number;
    }
  | { type: "batch_complete"; batchNumber: number; totalBatches: number; foundSoFar: number }
  | { type: "complete"; found: number; total: number; durationMs: number };

/**
 * Check if a single IP:port has SSH available
 */
export async function checkSSHPort(
  ip: string,
  port: number = SSH_PORT,
): Promise<SSHDeviceScanResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new Socket();
    let resolved = false;

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
      }
    };

    socket.setTimeout(PORT_CHECK_TIMEOUT);

    socket.on("connect", () => {
      const responseTime = Date.now() - start;
      // Try to read SSH banner
      socket.once("data", (data) => {
        const banner = data.toString().trim();
        const isSSH = banner.toLowerCase().includes("ssh");
        cleanup();
        resolve({
          ip,
          port,
          isSSH,
          responseTime,
          hostname: isSSH ? banner.split(" ")[0] : undefined,
        });
      });

      // If no data within 500ms, assume it's SSH anyway (some servers don't send banner)
      setTimeout(() => {
        if (!resolved) {
          cleanup();
          resolve({ ip, port, isSSH: true, responseTime });
        }
      }, 500);
    });

    socket.on("timeout", () => {
      cleanup();
      resolve({ ip, port, isSSH: false });
    });

    socket.on("error", () => {
      cleanup();
      resolve({ ip, port, isSSH: false });
    });

    socket.connect(port, ip);
  });
}

/**
 * Scan a range of IPs for SSH devices with real-time progress
 * @param subnet - e.g., "192.168.1" (will scan .1 to .254)
 * @param port - SSH port to check
 * @param concurrency - How many IPs to check simultaneously
 * @param onProgress - Callback for real-time progress updates
 */
export async function scanSubnet(
  subnet: string,
  port: number = SSH_PORT,
  concurrency: number = 50,
  onProgress?: ScanProgressCallback,
): Promise<SSHDeviceScanResult[]> {
  const startTime = Date.now();
  log.info("Starting subnet scan", { subnet, port, concurrency });

  const ips: string[] = [];
  for (let i = 1; i <= 254; i++) {
    ips.push(`${subnet}.${i}`);
  }

  const total = ips.length;
  onProgress?.({ type: "start", subnet, total, port });

  const results: SSHDeviceScanResult[] = [];
  const chunks: string[][] = [];

  // Split into chunks for concurrent processing
  for (let i = 0; i < ips.length; i += concurrency) {
    chunks.push(ips.slice(i, i + concurrency));
  }

  let checked = 0;
  let batchNumber = 0;

  for (const chunk of chunks) {
    batchNumber++;

    // Process chunk with individual progress updates
    const chunkPromises = chunk.map(async (ip) => {
      onProgress?.({ type: "checking", ip, current: checked + 1, total });

      const result = await checkSSHPort(ip, port);
      checked++;

      if (result.isSSH) {
        results.push(result);
        onProgress?.({
          type: "found",
          device: result,
          current: checked,
          total,
        });
      }

      onProgress?.({
        type: "checked",
        ip,
        found: result.isSSH,
        current: checked,
        total,
        responseTime: result.responseTime,
      });

      return result;
    });

    await Promise.all(chunkPromises);

    onProgress?.({
      type: "batch_complete",
      batchNumber,
      totalBatches: chunks.length,
      foundSoFar: results.length,
    });
  }

  const durationMs = Date.now() - startTime;
  onProgress?.({ type: "complete", found: results.length, total, durationMs });

  log.info("Subnet scan complete", { subnet, found: results.length, durationMs });
  return results;
}

/**
 * Scan specific IPs for SSH with progress
 */
export async function scanIPs(
  ips: string[],
  port: number = SSH_PORT,
  onProgress?: ScanProgressCallback,
): Promise<SSHDeviceScanResult[]> {
  const startTime = Date.now();
  log.info("Scanning IPs", { count: ips.length, port });

  const total = ips.length;
  onProgress?.({ type: "start", subnet: "custom", total, port });

  const results: SSHDeviceScanResult[] = [];
  let checked = 0;

  for (const ip of ips) {
    onProgress?.({ type: "checking", ip, current: checked + 1, total });

    const result = await checkSSHPort(ip, port);
    checked++;

    if (result.isSSH) {
      results.push(result);
      onProgress?.({ type: "found", device: result, current: checked, total });
    }

    onProgress?.({
      type: "checked",
      ip,
      found: result.isSSH,
      current: checked,
      total,
      responseTime: result.responseTime,
    });
  }

  const durationMs = Date.now() - startTime;
  onProgress?.({ type: "complete", found: results.length, total, durationMs });

  return results;
}

/**
 * Get the local subnet by checking network interfaces
 */
export async function getLocalSubnet(): Promise<string | null> {
  try {
    const os = await import("os");
    const interfaces = os.networkInterfaces();

    for (const name of Object.keys(interfaces)) {
      const iface = interfaces[name];
      if (!iface) continue;

      for (const entry of iface) {
        // Skip loopback and non-IPv4
        if (entry.internal || entry.family !== "IPv4") continue;

        // Get subnet from IP (e.g., 192.168.1.100 -> 192.168.1)
        const parts = entry.address.split(".");
        if (parts.length === 4) {
          return parts.slice(0, 3).join(".");
        }
      }
    }
  } catch (err) {
    log.warn("Failed to get local subnet", { error: String(err) });
  }
  return null;
}

/**
 * Test SSH connection with credentials
 */
export async function testSSHConnection(
  ip: string,
  port: number,
  username: string,
  password?: string,
  privateKey?: string,
  eventContext?: Partial<SSHEventContext>,
): Promise<SSHDeviceConnectionTest> {
  const start = Date.now();
  const host = eventContext?.host ?? ip;
  const deviceId = eventContext?.deviceId ?? host;

  // First check if port is open
  const portCheck = await checkSSHPort(ip, port);
  if (!portCheck.isSSH) {
    broadcastSSHEvent("ssh.connection.error", {
      deviceId,
      host,
      error: `SSH port ${port} not responding on ${ip}`,
      ts: Date.now(),
    });
    return {
      success: false,
      message: `SSH port ${port} not responding on ${ip}`,
    };
  }

  // Try actual SSH connection using ssh command
  return new Promise((resolve) => {
    const args = [
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "ConnectTimeout=5",
      "-o",
      "BatchMode=yes",
      "-p",
      String(port),
    ];

    if (privateKey) {
      args.push("-i", privateKey);
    }

    args.push(`${username}@${ip}`, "echo", "SSH_TEST_OK");
    const command = "echo SSH_TEST_OK";

    const proc = spawn("ssh", args, {
      env: { ...process.env, SSHPASS: password },
      timeout: 10000,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      const latencyMs = Date.now() - start;
      const exitCode = code ?? -1;

      if (code === 0 && stdout.includes("SSH_TEST_OK")) {
        broadcastSSHEvent("ssh.connection.opened", {
          deviceId,
          host,
          ts: Date.now(),
        });
        broadcastSSHEvent("ssh.command.executed", {
          deviceId,
          host,
          command,
          exitCode,
          durationMs: latencyMs,
          ts: Date.now(),
        });
        broadcastSSHEvent("ssh.connection.closed", {
          deviceId,
          host,
          durationMs: latencyMs,
          ts: Date.now(),
        });
        resolve({
          success: true,
          message: "Connection successful",
          latencyMs,
          serverVersion: portCheck.hostname,
        });
      } else {
        // Connection failed but port was open - likely auth issue
        resolve({
          success: false,
          message: stderr.trim() || `SSH connection failed (exit code ${code})`,
          latencyMs,
          serverVersion: portCheck.hostname,
        });
        broadcastSSHEvent("ssh.command.executed", {
          deviceId,
          host,
          command,
          exitCode,
          durationMs: latencyMs,
          ts: Date.now(),
        });
        broadcastSSHEvent("ssh.connection.error", {
          deviceId,
          host,
          error: stderr.trim() || `SSH connection failed (exit code ${code})`,
          ts: Date.now(),
        });
      }
    });

    proc.on("error", (err) => {
      broadcastSSHEvent("ssh.connection.error", {
        deviceId,
        host,
        error: err.message,
        ts: Date.now(),
      });
      resolve({
        success: false,
        message: `SSH command failed: ${err.message}`,
      });
    });
  });
}

/**
 * Quick ping check (uses system ping)
 */
export async function pingHost(ip: string): Promise<boolean> {
  return new Promise((resolve) => {
    const isWindows = process.platform === "win32";
    const args = isWindows ? ["-n", "1", "-w", "1000", ip] : ["-c", "1", "-W", "1", ip];

    const proc = spawn("ping", args, { timeout: 3000 });

    proc.on("close", (code) => {
      resolve(code === 0);
    });

    proc.on("error", () => {
      resolve(false);
    });
  });
}

/**
 * Get hostname via reverse DNS or NetBIOS
 */
export async function resolveHostname(ip: string): Promise<string | null> {
  try {
    const dns = await import("dns").then((m) => m.promises);
    const hostnames = await dns.reverse(ip);
    return hostnames[0] || null;
  } catch {
    return null;
  }
}
