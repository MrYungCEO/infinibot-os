/**
 * Cloudflare Quick Tunnel integration for InfiniBot Gateway.
 *
 * Spawns cloudflared as a subprocess and parses the assigned URL.
 * Uses the free "quick tunnel" feature (no account required).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("gateway").child("cloudflare-tunnel");

export interface CloudflareTunnelState {
  enabled: boolean;
  status: "stopped" | "starting" | "running" | "error";
  url: string | null;
  error: string | null;
  startedAt: number | null;
}

let tunnelProcess: ChildProcess | null = null;
let tunnelState: CloudflareTunnelState = {
  enabled: false,
  status: "stopped",
  url: null,
  error: null,
  startedAt: null,
};

const tunnelEvents = new EventEmitter();

export function getTunnelState(): CloudflareTunnelState {
  return { ...tunnelState };
}

export function onTunnelStateChange(listener: (state: CloudflareTunnelState) => void): () => void {
  tunnelEvents.on("change", listener);
  return () => tunnelEvents.off("change", listener);
}

function updateState(partial: Partial<CloudflareTunnelState>): void {
  tunnelState = { ...tunnelState, ...partial };
  tunnelEvents.emit("change", getTunnelState());
}

/**
 * Start the Cloudflare Quick Tunnel pointing to the local gateway.
 */
export async function startCloudflareTunnel(opts: {
  port: number;
  protocol?: "http" | "https";
}): Promise<{ url: string | null; error: string | null }> {
  if (tunnelProcess) {
    return { url: tunnelState.url, error: null };
  }

  const { port, protocol = "http" } = opts;
  const localUrl = `${protocol}://localhost:${port}`;

  updateState({
    enabled: true,
    status: "starting",
    url: null,
    error: null,
  });

  return new Promise((resolve) => {
    try {
      // Spawn cloudflared quick tunnel
      const proc = spawn("cloudflared", ["tunnel", "--url", localUrl], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      tunnelProcess = proc;
      let resolved = false;
      let outputBuffer = "";

      const handleOutput = (data: Buffer) => {
        const text = data.toString();
        outputBuffer += text;

        // cloudflared outputs the URL to stderr in format:
        // "... https://xxx-xxx-xxx.trycloudflare.com ..."
        const urlMatch = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (urlMatch && !resolved) {
          resolved = true;
          const url = urlMatch[0];
          updateState({
            status: "running",
            url,
            startedAt: Date.now(),
          });
          log.info(`tunnel running: ${url}`);
          resolve({ url, error: null });
        }
      };

      proc.stdout?.on("data", handleOutput);
      proc.stderr?.on("data", handleOutput);

      proc.on("error", (err) => {
        const error = `failed to spawn cloudflared: ${err.message}`;
        log.error(error);
        updateState({
          status: "error",
          error,
        });
        if (!resolved) {
          resolved = true;
          resolve({ url: null, error });
        }
        tunnelProcess = null;
      });

      proc.on("exit", (code, signal) => {
        const reason = signal ? `signal ${signal}` : `code ${code}`;
        log.info(`tunnel process exited (${reason})`);
        
        if (!resolved) {
          resolved = true;
          const error = `cloudflared exited before providing URL (${reason})`;
          updateState({
            status: "error",
            error,
          });
          resolve({ url: null, error });
        } else {
          updateState({
            status: "stopped",
            url: null,
          });
        }
        tunnelProcess = null;
      });

      // Timeout if URL not received in 30 seconds
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          const error = "timeout waiting for tunnel URL (30s)";
          log.error(error);
          updateState({
            status: "error",
            error,
          });
          resolve({ url: null, error });
          stopCloudflareTunnel();
        }
      }, 30_000);

    } catch (err) {
      const error = `failed to start cloudflared: ${String(err)}`;
      log.error(error);
      updateState({
        status: "error",
        error,
      });
      resolve({ url: null, error });
    }
  });
}

/**
 * Stop the Cloudflare tunnel if running.
 */
export function stopCloudflareTunnel(): void {
  if (tunnelProcess) {
    log.info("stopping tunnel");
    tunnelProcess.kill("SIGTERM");
    tunnelProcess = null;
  }
  updateState({
    enabled: false,
    status: "stopped",
    url: null,
    error: null,
    startedAt: null,
  });
}

/**
 * Check if cloudflared is available on the system.
 */
export async function isCloudflaredAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("cloudflared", ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    proc.on("error", () => resolve(false));
    proc.on("exit", (code) => resolve(code === 0));

    // Timeout
    setTimeout(() => {
      proc.kill();
      resolve(false);
    }, 5000);
  });
}
