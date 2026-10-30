/**
 * SSH Device Gateway Handlers
 *
 * Manages network SSH devices — add, configure, scan, test connections.
 * Supports real-time scan progress via WebSocket events.
 */

import { resolve } from "path";
import { GatewayRequestHandlers } from "./types.js";
import { getSSHDeviceStore } from "../../ssh-devices/store.js";
import {
  scanSubnet,
  scanIPs,
  checkSSHPort,
  testSSHConnection,
  getLocalSubnet,
  pingHost,
  resolveHostname,
  type ScanProgressEvent,
} from "../../ssh-devices/scanner.js";
import type { SSHDevice } from "../../ssh-devices/types.js";

function getStore() {
  const stateDir = process.env.INFINIBOT_STATE_DIR || "state";
  return getSSHDeviceStore(resolve(stateDir));
}

// Mask password in device output
function maskDevice(d: SSHDevice): Omit<SSHDevice, "password"> & { password?: string } {
  return { ...d, password: d.password ? "***" : undefined };
}

export const sshDeviceHandlers: GatewayRequestHandlers = {
  // ── List all devices ────────────────────────────────────
  "ssh.device.list": async ({ respond }) => {
    try {
      const store = getStore();
      const devices = store.list();
      const activeId = store.getActiveDeviceId();
      respond(true, {
        devices: devices.map(maskDevice),
        activeDeviceId: activeId,
      });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ── Get single device ───────────────────────────────────
  "ssh.device.get": async ({ params, respond }) => {
    try {
      const store = getStore();
      const { id, name, ip } = params as { id?: string; name?: string; ip?: string };

      let device: SSHDevice | null = null;
      if (id) device = store.get(id);
      else if (name) device = store.getByName(name);
      else if (ip) device = store.getByIp(ip);

      if (!device) {
        respond(true, { error: "Device not found" });
        return;
      }

      respond(true, { device: maskDevice(device) });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ── Create device ───────────────────────────────────────
  "ssh.device.create": async ({ params, respond }) => {
    try {
      const store = getStore();
      const p = params as {
        name: string;
        ip: string;
        port?: number;
        username: string;
        password?: string;
        privateKey?: string;
        description?: string;
        tags?: string[];
      };

      if (!p.name || !p.ip || !p.username) {
        respond(true, { error: "name, ip, and username are required" });
        return;
      }

      // Check for duplicate IP
      const existing = store.getByIp(p.ip);
      if (existing) {
        respond(true, { error: `Device with IP ${p.ip} already exists: ${existing.name}` });
        return;
      }

      const device = store.create({
        name: p.name,
        ip: p.ip,
        port: p.port || 22,
        username: p.username,
        password: p.password,
        privateKey: p.privateKey,
        description: p.description,
        tags: p.tags,
      });

      respond(true, { device: maskDevice(device) });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ── Update device ───────────────────────────────────────
  "ssh.device.update": async ({ params, respond }) => {
    try {
      const store = getStore();
      const { id, ...updates } = params as {
        id: string;
        name?: string;
        ip?: string;
        port?: number;
        username?: string;
        password?: string;
        privateKey?: string;
        description?: string;
        tags?: string[];
      };

      if (!id) {
        respond(true, { error: "id is required" });
        return;
      }

      const device = store.update(id, updates);
      if (!device) {
        respond(true, { error: "Device not found" });
        return;
      }

      respond(true, { device: maskDevice(device) });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ── Delete device ───────────────────────────────────────
  "ssh.device.delete": async ({ params, respond }) => {
    try {
      const store = getStore();
      const { id } = params as { id: string };

      if (!id) {
        respond(true, { error: "id is required" });
        return;
      }

      const deleted = store.delete(id);
      respond(true, { deleted });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ── Set active device ───────────────────────────────────
  "ssh.device.setActive": async ({ params, respond }) => {
    try {
      const store = getStore();
      const { id, name } = params as { id?: string; name?: string };

      let deviceId: string | null = null;

      if (id) {
        const device = store.get(id);
        if (!device) {
          respond(true, { error: "Device not found" });
          return;
        }
        deviceId = id;
      } else if (name) {
        const device = store.getByName(name);
        if (!device) {
          respond(true, { error: `Device '${name}' not found` });
          return;
        }
        deviceId = device.id;
      }

      store.setActiveDevice(deviceId);
      const activeDevice = deviceId ? store.get(deviceId) : null;

      respond(true, {
        activeDeviceId: deviceId,
        activeDevice: activeDevice ? maskDevice(activeDevice) : null,
      });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ── Get active device ───────────────────────────────────
  "ssh.device.getActive": async ({ respond }) => {
    try {
      const store = getStore();
      const device = store.getActiveDevice();
      respond(true, {
        device: device ? maskDevice(device) : null,
      });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ── Search devices ──────────────────────────────────────
  "ssh.device.search": async ({ params, respond }) => {
    try {
      const store = getStore();
      const { query } = params as { query?: string };
      const devices = store.search(query || "");
      respond(true, {
        devices: devices.map(maskDevice),
      });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ── Scan network (with real-time progress) ──────────────
  "ssh.device.scan": async ({ params, respond, context }) => {
    try {
      const p = params as {
        subnet?: string;
        ips?: string[];
        port?: number;
        concurrency?: number;
        streamProgress?: boolean;
      };
      const port = p.port || 22;
      const streamProgress = p.streamProgress !== false; // Default to true

      console.log("[ssh.scan] Starting scan, streamProgress:", streamProgress);

      // Progress callback for real-time updates
      const onProgress = streamProgress
        ? (event: ScanProgressEvent) => {
            console.log("[ssh.scan] Broadcasting progress event:", event.type);
            context.broadcast("ssh.scan.progress", event);
          }
        : undefined;

      if (p.ips && p.ips.length > 0) {
        const results = await scanIPs(p.ips, port, onProgress);
        respond(true, { results, scannedCount: p.ips.length });
        return;
      }

      const subnet = p.subnet || (await getLocalSubnet());
      if (!subnet) {
        respond(true, {
          error: "Could not determine local subnet. Please specify subnet parameter.",
        });
        return;
      }

      const results = await scanSubnet(subnet, port, p.concurrency || 50, onProgress);
      respond(true, { subnet, results, scannedCount: 254 });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ── Check single IP ─────────────────────────────────────
  "ssh.device.check": async ({ params, respond }) => {
    try {
      const { ip, port } = params as { ip: string; port?: number };

      if (!ip) {
        respond(true, { error: "ip is required" });
        return;
      }

      const result = await checkSSHPort(ip, port || 22);
      const hostname = await resolveHostname(ip);

      respond(true, { ...result, hostname });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ── Test connection ─────────────────────────────────────
  "ssh.device.test": async ({ params, respond }) => {
    try {
      const store = getStore();
      const p = params as {
        id?: string;
        ip?: string;
        port?: number;
        username?: string;
        password?: string;
        privateKey?: string;
      };

      let ip: string;
      let port: number = p.port || 22;
      let username: string;
      let password: string | undefined;
      let privateKey: string | undefined;

      if (p.id) {
        const device = store.get(p.id);
        if (!device) {
          respond(true, { error: "Device not found" });
          return;
        }
        ip = device.ip;
        port = device.port;
        username = device.username;
        password = device.password;
        privateKey = device.privateKey;
      } else if (p.ip && p.username) {
        ip = p.ip;
        username = p.username;
        password = p.password;
        privateKey = p.privateKey;
      } else {
        respond(true, { error: "Either id or (ip + username) required" });
        return;
      }

      const result = await testSSHConnection(ip, port, username, password, privateKey, {
        deviceId: p.id ?? ip,
        host: ip,
      });

      // Update device status if testing saved device
      if (p.id) {
        store.update(p.id, {
          isOnline: result.success,
          lastSeen: Date.now(),
          ...(result.success ? { lastConnected: Date.now() } : {}),
        });
      }

      respond(true, result);
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ── Ping device ─────────────────────────────────────────
  "ssh.device.ping": async ({ params, respond }) => {
    try {
      const store = getStore();
      const { id, ip: ipParam } = params as { id?: string; ip?: string };

      let ip: string;

      if (id) {
        const device = store.get(id);
        if (!device) {
          respond(true, { error: "Device not found" });
          return;
        }
        ip = device.ip;
      } else if (ipParam) {
        ip = ipParam;
      } else {
        respond(true, { error: "Either id or ip required" });
        return;
      }

      const reachable = await pingHost(ip);

      if (id) {
        store.update(id, {
          isOnline: reachable,
          lastSeen: Date.now(),
        });
      }

      respond(true, { ip, reachable });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ── Refresh all device statuses ─────────────────────────
  "ssh.device.refreshStatus": async ({ respond }) => {
    try {
      const store = getStore();
      const devices = store.list();
      const results: { id: string; name: string; isOnline: boolean }[] = [];

      for (const device of devices) {
        const reachable = await pingHost(device.ip);
        store.update(device.id, {
          isOnline: reachable,
          lastSeen: Date.now(),
        });
        results.push({ id: device.id, name: device.name, isOnline: reachable });
      }

      respond(true, { results });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ── Get credentials (for internal use) ──────────────────
  "ssh.device.credentials": async ({ params, respond }) => {
    try {
      const store = getStore();
      const { id } = params as { id: string };

      const creds = store.getCredentials(id);
      if (!creds) {
        respond(true, { error: "Device not found" });
        return;
      }
      respond(true, creds);
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },
};
