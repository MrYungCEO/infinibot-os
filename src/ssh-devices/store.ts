/**
 * SSH Device Store - SQLite-backed storage for SSH devices
 */

import { mkdirSync } from "fs";
import { join } from "path";
import Database from "better-sqlite3";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { SSHDevice } from "./types.js";
import { randomUUID } from "crypto";

const log = createSubsystemLogger("ssh-devices");

// Simple encryption for passwords (not production-grade, but better than plaintext)
const CIPHER_KEY = process.env.SSH_CIPHER_KEY || "infinibot-ssh-default-key-32ch";

function encrypt(text: string): string {
  // Base64 with key XOR - simple obfuscation
  const keyBytes = Buffer.from(CIPHER_KEY);
  const textBytes = Buffer.from(text);
  const result = Buffer.alloc(textBytes.length);
  for (let i = 0; i < textBytes.length; i++) {
    result[i] = textBytes[i] ^ keyBytes[i % keyBytes.length];
  }
  return result.toString("base64");
}

function decrypt(encoded: string): string {
  const keyBytes = Buffer.from(CIPHER_KEY);
  const encBytes = Buffer.from(encoded, "base64");
  const result = Buffer.alloc(encBytes.length);
  for (let i = 0; i < encBytes.length; i++) {
    result[i] = encBytes[i] ^ keyBytes[i % keyBytes.length];
  }
  return result.toString();
}

export class SSHDeviceStore {
  private db: Database.Database;
  private initialized = false;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    const dbPath = join(stateDir, "ssh-devices.db");

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");

    this.createTables();
    this.initialized = true;

    const count = (
      this.db.prepare("SELECT COUNT(*) as cnt FROM ssh_devices").get() as { cnt: number }
    ).cnt;
    log.info("SSH device store loaded", { devices: count });
  }

  private createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ssh_devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        ip TEXT NOT NULL,
        port INTEGER DEFAULT 22,
        username TEXT NOT NULL,
        password TEXT,
        privateKey TEXT,
        description TEXT,
        tags TEXT,
        lastConnected INTEGER,
        lastSeen INTEGER,
        isOnline INTEGER DEFAULT 0,
        discoveredAt INTEGER,
        hostname TEXT,
        osType TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ssh_devices_ip ON ssh_devices(ip);
      CREATE INDEX IF NOT EXISTS idx_ssh_devices_name ON ssh_devices(name);
      
      CREATE TABLE IF NOT EXISTS ssh_device_config (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
  }

  // ── CRUD Operations ─────────────────────────────────────

  list(): SSHDevice[] {
    const rows = this.db.prepare("SELECT * FROM ssh_devices ORDER BY name").all() as any[];
    return rows.map((r) => this.rowToDevice(r));
  }

  get(id: string): SSHDevice | null {
    const row = this.db.prepare("SELECT * FROM ssh_devices WHERE id = ?").get(id) as any;
    return row ? this.rowToDevice(row) : null;
  }

  getByName(name: string): SSHDevice | null {
    const row = this.db
      .prepare("SELECT * FROM ssh_devices WHERE LOWER(name) = LOWER(?)")
      .get(name) as any;
    return row ? this.rowToDevice(row) : null;
  }

  getByIp(ip: string): SSHDevice | null {
    const row = this.db.prepare("SELECT * FROM ssh_devices WHERE ip = ?").get(ip) as any;
    return row ? this.rowToDevice(row) : null;
  }

  create(device: Omit<SSHDevice, "id" | "createdAt" | "updatedAt">): SSHDevice {
    const id = randomUUID();
    const now = Date.now();

    const encryptedPassword = device.password ? encrypt(device.password) : null;

    this.db
      .prepare(`
      INSERT INTO ssh_devices (id, name, ip, port, username, password, privateKey, description, tags, 
        lastConnected, lastSeen, isOnline, discoveredAt, hostname, osType, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        device.name,
        device.ip,
        device.port || 22,
        device.username,
        encryptedPassword,
        device.privateKey || null,
        device.description || null,
        device.tags ? JSON.stringify(device.tags) : null,
        device.lastConnected || null,
        device.lastSeen || null,
        device.isOnline ? 1 : 0,
        device.discoveredAt || null,
        device.hostname || null,
        device.osType || null,
        now,
        now,
      );

    log.info("SSH device created", { id, name: device.name, ip: device.ip });
    return this.get(id)!;
  }

  update(id: string, updates: Partial<SSHDevice>): SSHDevice | null {
    const existing = this.get(id);
    if (!existing) return null;

    const now = Date.now();
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.name !== undefined) {
      fields.push("name = ?");
      values.push(updates.name);
    }
    if (updates.ip !== undefined) {
      fields.push("ip = ?");
      values.push(updates.ip);
    }
    if (updates.port !== undefined) {
      fields.push("port = ?");
      values.push(updates.port);
    }
    if (updates.username !== undefined) {
      fields.push("username = ?");
      values.push(updates.username);
    }
    if (updates.password !== undefined) {
      fields.push("password = ?");
      values.push(updates.password ? encrypt(updates.password) : null);
    }
    if (updates.privateKey !== undefined) {
      fields.push("privateKey = ?");
      values.push(updates.privateKey);
    }
    if (updates.description !== undefined) {
      fields.push("description = ?");
      values.push(updates.description);
    }
    if (updates.tags !== undefined) {
      fields.push("tags = ?");
      values.push(JSON.stringify(updates.tags));
    }
    if (updates.lastConnected !== undefined) {
      fields.push("lastConnected = ?");
      values.push(updates.lastConnected);
    }
    if (updates.lastSeen !== undefined) {
      fields.push("lastSeen = ?");
      values.push(updates.lastSeen);
    }
    if (updates.isOnline !== undefined) {
      fields.push("isOnline = ?");
      values.push(updates.isOnline ? 1 : 0);
    }
    if (updates.hostname !== undefined) {
      fields.push("hostname = ?");
      values.push(updates.hostname);
    }
    if (updates.osType !== undefined) {
      fields.push("osType = ?");
      values.push(updates.osType);
    }

    if (fields.length === 0) return existing;

    fields.push("updatedAt = ?");
    values.push(now);
    values.push(id);

    this.db.prepare(`UPDATE ssh_devices SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    log.info("SSH device updated", { id, fields: fields.length });
    return this.get(id);
  }

  delete(id: string): boolean {
    const result = this.db.prepare("DELETE FROM ssh_devices WHERE id = ?").run(id);
    if (result.changes > 0) {
      log.info("SSH device deleted", { id });
      return true;
    }
    return false;
  }

  // ── Active Device ───────────────────────────────────────

  getActiveDeviceId(): string | null {
    const row = this.db
      .prepare("SELECT value FROM ssh_device_config WHERE key = 'activeDeviceId'")
      .get() as any;
    return row?.value || null;
  }

  setActiveDevice(deviceId: string | null): void {
    if (deviceId) {
      this.db
        .prepare(
          "INSERT OR REPLACE INTO ssh_device_config (key, value) VALUES ('activeDeviceId', ?)",
        )
        .run(deviceId);
      log.info("Active device set", { deviceId });
    } else {
      this.db.prepare("DELETE FROM ssh_device_config WHERE key = 'activeDeviceId'").run();
      log.info("Active device cleared");
    }
  }

  getActiveDevice(): SSHDevice | null {
    const id = this.getActiveDeviceId();
    return id ? this.get(id) : null;
  }

  // ── Helpers ─────────────────────────────────────────────

  private rowToDevice(row: any): SSHDevice {
    return {
      id: row.id,
      name: row.name,
      ip: row.ip,
      port: row.port || 22,
      username: row.username,
      password: row.password ? decrypt(row.password) : undefined,
      privateKey: row.privateKey || undefined,
      description: row.description || undefined,
      tags: row.tags ? JSON.parse(row.tags) : undefined,
      lastConnected: row.lastConnected || undefined,
      lastSeen: row.lastSeen || undefined,
      isOnline: !!row.isOnline,
      discoveredAt: row.discoveredAt || undefined,
      hostname: row.hostname || undefined,
      osType: row.osType || undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // ── Search ──────────────────────────────────────────────

  search(query: string): SSHDevice[] {
    const pattern = `%${query}%`;
    const rows = this.db
      .prepare(`
      SELECT * FROM ssh_devices 
      WHERE name LIKE ? OR ip LIKE ? OR description LIKE ? OR hostname LIKE ?
      ORDER BY name
    `)
      .all(pattern, pattern, pattern, pattern) as any[];
    return rows.map((r) => this.rowToDevice(r));
  }

  // Get device password (decrypted) for connection
  getCredentials(id: string): { username: string; password?: string; privateKey?: string } | null {
    const device = this.get(id);
    if (!device) return null;
    return {
      username: device.username,
      password: device.password,
      privateKey: device.privateKey,
    };
  }
}

// Singleton
let _store: SSHDeviceStore | null = null;

export function getSSHDeviceStore(stateDir?: string): SSHDeviceStore {
  if (!_store) {
    const dir = stateDir || process.env.INFINIBOT_STATE_DIR || "state";
    _store = new SSHDeviceStore(dir);
  }
  return _store;
}
