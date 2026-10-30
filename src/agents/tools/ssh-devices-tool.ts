/**
 * SSH Devices Tool - Agent tool for managing SSH network devices
 *
 * Provides actions for device CRUD, network scanning, connection testing,
 * and setting the active device context for /device command.
 */

import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam, readNumberParam } from "./common.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolve } from "node:path";
import { getSSHDeviceStore } from "../../ssh-devices/store.js";
import {
  scanSubnet,
  scanIPs,
  testSSHConnection,
  getLocalSubnet,
  pingHost,
} from "../../ssh-devices/scanner.js";

const log = createSubsystemLogger("ssh-devices-tool");

function getStore() {
  const stateDir = process.env.INFINIBOT_STATE_DIR ?? "state";
  return getSSHDeviceStore(resolve(stateDir));
}

export function createSSHDevicesTool(): AnyAgentTool {
  return {
    label: "SSH Devices",
    name: "ssh_devices",
    description: `Manage SSH network devices. Actions:
- list: List all configured devices
- get: Get device by id, name, or ip
- add: Add a new device (name, ip, username, password/privateKey, description)
- update: Update device fields
- delete: Remove a device
- set_active: Set the active device for /device context
- get_active: Get currently active device
- scan: Scan network for SSH devices (subnet or specific IPs)
- test: Test SSH connection to a device
- ping: Quick ping check
- search: Search devices by name/ip/description`,

    parameters: Type.Object({
      action: stringEnum(
        [
          "list",
          "get",
          "add",
          "update",
          "delete",
          "set_active",
          "get_active",
          "scan",
          "test",
          "ping",
          "search",
        ],
        { description: "Action to perform" },
      ),

      // Identifiers
      id: Type.Optional(Type.String({ description: "Device ID" })),
      name: Type.Optional(Type.String({ description: "Device name" })),
      ip: Type.Optional(Type.String({ description: "Device IP address" })),

      // Device config
      port: Type.Optional(Type.Number({ description: "SSH port (default 22)" })),
      username: Type.Optional(Type.String({ description: "SSH username" })),
      password: Type.Optional(Type.String({ description: "SSH password" })),
      privateKey: Type.Optional(Type.String({ description: "Path to SSH private key" })),
      description: Type.Optional(Type.String({ description: "Device description" })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Device tags" })),

      // Scan options
      subnet: Type.Optional(Type.String({ description: "Subnet to scan (e.g., 192.168.1)" })),
      ips: Type.Optional(Type.Array(Type.String(), { description: "Specific IPs to scan" })),

      // Search
      query: Type.Optional(Type.String({ description: "Search query" })),
    }),

    async execute(_toolCallId: string, args: Record<string, unknown>) {
      const input = args;
      const action = readStringParam(input, "action", { required: true });
      const store = getStore();

      try {
        switch (action) {
          // ── List devices ────────────────────────────────
          case "list": {
            const devices = store.list();
            const activeId = store.getActiveDeviceId();
            return jsonResult({
              devices: devices.map((d) => ({
                ...d,
                password: d.password ? "[set]" : undefined,
                isActive: d.id === activeId,
              })),
              activeDeviceId: activeId,
              count: devices.length,
            });
          }

          // ── Get device ──────────────────────────────────
          case "get": {
            const id = readStringParam(input, "id");
            const name = readStringParam(input, "name");
            const ip = readStringParam(input, "ip");

            let device = null;
            if (id) device = store.get(id);
            else if (name) device = store.getByName(name);
            else if (ip) device = store.getByIp(ip);
            else return jsonResult({ error: "Provide id, name, or ip" });

            if (!device) return jsonResult({ error: "Device not found" });

            return jsonResult({
              device: { ...device, password: device.password ? "[set]" : undefined },
            });
          }

          // ── Add device ──────────────────────────────────
          case "add": {
            const name = readStringParam(input, "name", { required: true });
            const ip = readStringParam(input, "ip", { required: true });
            const username = readStringParam(input, "username", { required: true });
            const port = readNumberParam(input, "port") ?? 22;
            const password = readStringParam(input, "password");
            const privateKey = readStringParam(input, "privateKey");
            const description = readStringParam(input, "description");
            const tags = input.tags as string[] | undefined;

            // Check duplicate
            const existing = store.getByIp(ip);
            if (existing) {
              return jsonResult({
                error: `Device with IP ${ip} already exists: ${existing.name}`,
                existingDevice: { id: existing.id, name: existing.name },
              });
            }

            const device = store.create({
              name,
              ip,
              port,
              username,
              password,
              privateKey,
              description,
              tags,
            });

            log.info("Device added via tool", { id: device.id, name: device.name });
            return jsonResult({
              success: true,
              device: { ...device, password: device.password ? "[set]" : undefined },
              message: `Device '${name}' added successfully`,
            });
          }

          // ── Update device ───────────────────────────────
          case "update": {
            const id = readStringParam(input, "id", { required: true });

            const updates: Record<string, unknown> = {};
            const name = readStringParam(input, "name");
            const ip = readStringParam(input, "ip");
            const port = readNumberParam(input, "port");
            const username = readStringParam(input, "username");
            const password = readStringParam(input, "password");
            const privateKey = readStringParam(input, "privateKey");
            const description = readStringParam(input, "description");

            if (name) updates.name = name;
            if (ip) updates.ip = ip;
            if (port) updates.port = port;
            if (username) updates.username = username;
            if (password) updates.password = password;
            if (privateKey) updates.privateKey = privateKey;
            if (description !== undefined) updates.description = description;
            if (input.tags) updates.tags = input.tags;

            const device = store.update(id, updates);
            if (!device) return jsonResult({ error: "Device not found" });

            return jsonResult({
              success: true,
              device: { ...device, password: device.password ? "[set]" : undefined },
              message: `Device '${device.name}' updated`,
            });
          }

          // ── Delete device ───────────────────────────────
          case "delete": {
            const id = readStringParam(input, "id", { required: true });
            const device = store.get(id);
            if (!device) return jsonResult({ error: "Device not found" });

            const deleted = store.delete(id);
            return jsonResult({
              success: deleted,
              message: deleted ? `Device '${device.name}' deleted` : "Failed to delete",
            });
          }

          // ── Set active device ───────────────────────────
          case "set_active": {
            const id = readStringParam(input, "id");
            const name = readStringParam(input, "name");

            let device = null;
            if (id) {
              device = store.get(id);
            } else if (name) {
              device = store.getByName(name);
            } else {
              // Clear active device
              store.setActiveDevice(null);
              return jsonResult({
                success: true,
                message: "Active device cleared",
                activeDevice: null,
              });
            }

            if (!device) return jsonResult({ error: "Device not found" });

            store.setActiveDevice(device.id);
            return jsonResult({
              success: true,
              message: `Active device set to '${device.name}'`,
              activeDevice: { ...device, password: device.password ? "[set]" : undefined },
            });
          }

          // ── Get active device ───────────────────────────
          case "get_active": {
            const device = store.getActiveDevice();
            if (!device) {
              return jsonResult({
                activeDevice: null,
                message: "No active device set. Use /device <name> to set one.",
              });
            }
            return jsonResult({
              activeDevice: { ...device, password: device.password ? "[set]" : undefined },
            });
          }

          // ── Scan network ────────────────────────────────
          case "scan": {
            const ips = input.ips as string[] | undefined;
            const port = readNumberParam(input, "port") ?? 22;

            if (ips && ips.length > 0) {
              const results = await scanIPs(ips, port);
              return jsonResult({
                results,
                scannedCount: ips.length,
                foundCount: results.length,
              });
            }

            const subnet = readStringParam(input, "subnet") || (await getLocalSubnet());
            if (!subnet) {
              return jsonResult({
                error: "Could not detect local subnet. Please specify subnet parameter.",
              });
            }

            const results = await scanSubnet(subnet, port, 50);
            return jsonResult({
              subnet,
              results,
              scannedCount: 254,
              foundCount: results.length,
              message: `Found ${results.length} SSH devices on ${subnet}.x`,
            });
          }

          // ── Test connection ─────────────────────────────
          case "test": {
            const id = readStringParam(input, "id");

            let ip: string;
            let port: number = readNumberParam(input, "port") ?? 22;
            let username: string;
            let password: string | undefined;
            let privateKey: string | undefined;

            if (id) {
              const device = store.get(id);
              if (!device) return jsonResult({ error: "Device not found" });
              ip = device.ip;
              port = device.port;
              username = device.username;
              password = device.password;
              privateKey = device.privateKey;
            } else {
              const ipParam = readStringParam(input, "ip", { required: true });
              const usernameParam = readStringParam(input, "username", { required: true });
              ip = ipParam;
              username = usernameParam;
              password = readStringParam(input, "password");
              privateKey = readStringParam(input, "privateKey");
            }

            const result = await testSSHConnection(ip, port, username, password, privateKey, {
              deviceId: id ?? ip,
              host: ip,
            });

            // Update device status if testing saved device
            if (id) {
              store.update(id, {
                isOnline: result.success,
                lastSeen: Date.now(),
                ...(result.success ? { lastConnected: Date.now() } : {}),
              });
            }

            return jsonResult({
              ...result,
              ip,
              port,
              username,
            });
          }

          // ── Ping device ─────────────────────────────────
          case "ping": {
            const id = readStringParam(input, "id");
            let ip: string | undefined;

            if (id) {
              const device = store.get(id);
              if (!device) return jsonResult({ error: "Device not found" });
              ip = device.ip;
            } else {
              ip = readStringParam(input, "ip");
            }

            if (!ip) return jsonResult({ error: "Device not found or IP not provided" });

            const reachable = await pingHost(ip);

            if (id) {
              store.update(id, { isOnline: reachable, lastSeen: Date.now() });
            }

            return jsonResult({ ip, reachable });
          }

          // ── Search devices ──────────────────────────────
          case "search": {
            const query = readStringParam(input, "query", { required: true });
            const devices = store.search(query);
            return jsonResult({
              devices: devices.map((d) => ({
                ...d,
                password: d.password ? "[set]" : undefined,
              })),
              count: devices.length,
            });
          }

          default:
            return jsonResult({ error: `Unknown action: ${action}` });
        }
      } catch (err) {
        log.error("SSH devices tool error", { action, error: String(err) });
        return jsonResult({ error: String(err) });
      }
    },
  };
}
