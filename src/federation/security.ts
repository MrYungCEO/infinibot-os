/**
 * Federation Security Layer
 *
 * Provides E2E encryption and per-satellite permission management for federation.
 * Features:
 * - Asymmetric key exchange on satellite connection
 * - Symmetric encryption for sensitive payloads
 * - Permission-based access control
 * - Secure token validation
 */

import {
  randomBytes,
  createHash,
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  publicDecrypt,
  privateDecrypt,
  publicEncrypt,
  privateEncrypt,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveSharedDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("federation:security");

// ============================================================
// Permission System
// ============================================================

/**
 * Permission levels for satellites
 */
export type PermissionLevel =
  | "full" // Full access to all operations
  | "spawn-only" // Can only spawn agents, no state access
  | "read-only"; // Can only read state, no modifications

export interface SatellitePermissions {
  level: PermissionLevel;
  allowedOperations: OperationType[];
  maxSessions?: number;
  workspaceRestrictions?: string[];
  ratelimit?: {
    operationsPerMinute: number;
    sessionsPerHour: number;
  };
}

export type OperationType =
  | "session.spawn"
  | "session.send"
  | "session.complete"
  | "state.sync"
  | "compute.route"
  | "mcp.invoke"
  | "memory.update"
  | "memory.broadcast"
  | "peer.discovery"
  | "transcript.request";

/**
 * Satellite authentication token containing permissions
 */
export interface SatelliteToken {
  satelliteId: string;
  permissions: SatellitePermissions;
  issuedAt: number;
  expiresAt?: number;
  signature: string;
}

// ============================================================
// Encryption System
// ============================================================

/**
 * Key pair for asymmetric encryption
 */
export interface FederationKeyPair {
  publicKey: string;
  privateKey: string;
}

/**
 * Session encryption context for a satellite connection
 */
export interface EncryptionSession {
  sessionId: string;
  satellitePublicKey: string;
  sharedSecret: Buffer;
  symmetricKey: Buffer;
  iv: Buffer;
  createdAt: number;
}

/**
 * Encrypted payload wrapper
 */
export interface EncryptedPayload {
  encrypted: string; // Base64 encoded encrypted data
  iv: string; // Base64 encoded initialization vector
  sessionId: string; // Reference to encryption session
}

// ============================================================
// Security Manager
// ============================================================

export class FederationSecurity {
  private hubKeyPair: FederationKeyPair;
  private encryptionSessions = new Map<string, EncryptionSession>();
  private satelliteTokens = new Map<string, SatelliteToken>();
  private permissionCache = new Map<string, SatellitePermissions>();
  private operationCounters = new Map<string, { count: number; resetTime: number }>();
  /**
   * In-memory revocation set. Tokens whose `satelliteId` appears here are
   * rejected by {@link validateSatelliteToken} regardless of signature/expiry.
   * Populated by {@link revokeSatelliteToken} (called from
   * `infinibot federation invites revoke`).
   */
  private revokedSatelliteIds = new Set<string>();

  /**
   * @param opts.keyPairPath  When set, the hub key pair is loaded from (or
   *   created at) this file, so tokens it signed — invites and the durable
   *   per-device credentials minted at first registration — stay valid across
   *   gateway restarts. Without it a restart silently invalidated every
   *   invite and every paired satellite.
   */
  constructor(opts: { keyPairPath?: string } = {}) {
    const persisted = opts.keyPairPath
      ? loadOrCreateKeyPair(opts.keyPairPath, () => this.generateKeyPair())
      : null;
    this.hubKeyPair = persisted ?? this.generateKeyPair();
    log.info(
      persisted
        ? "Federation security initialized with persisted key pair"
        : "Federation security initialized with fresh key pair",
    );
  }

  // ============================================================
  // Key Management
  // ============================================================

  /**
   * Generate a new RSA key pair for asymmetric encryption
   */
  generateKeyPair(): FederationKeyPair {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    return { publicKey, privateKey };
  }

  /**
   * Get hub's public key for sharing with satellites
   */
  getHubPublicKey(): string {
    return this.hubKeyPair.publicKey;
  }

  /**
   * Get a short, stable fingerprint of the hub's public key. Satellites can
   * pin this to detect key changes / MITM without transmitting the full PEM.
   * SHA-256 over the PEM, hex-encoded, truncated to 32 hex chars (16 bytes).
   */
  getHubPublicKeyFingerprint(): string {
    return createHash("sha256").update(this.hubKeyPair.publicKey).digest("hex").slice(0, 32);
  }

  /**
   * Establish encryption session with satellite during handshake
   */
  establishEncryptionSession(satelliteId: string, satellitePublicKey: string): EncryptionSession {
    const sessionId = this.generateSessionId();

    // Generate shared secret (random 32 bytes)
    const sharedSecret = randomBytes(32);

    // Derive symmetric key and IV from shared secret
    const symmetricKey = createHash("sha256").update(sharedSecret).digest();
    const iv = createHash("md5").update(sharedSecret).digest();

    const session: EncryptionSession = {
      sessionId,
      satellitePublicKey,
      sharedSecret,
      symmetricKey,
      iv,
      createdAt: Date.now(),
    };

    this.encryptionSessions.set(satelliteId, session);
    log.info(`Established encryption session for satellite: ${satelliteId}`, { sessionId });

    return session;
  }

  /**
   * Get encrypted shared secret to send to satellite
   */
  getEncryptedSharedSecret(satelliteId: string): string {
    const session = this.encryptionSessions.get(satelliteId);
    if (!session) {
      throw new Error(`No encryption session found for satellite: ${satelliteId}`);
    }

    // Encrypt shared secret with satellite's public key
    const encrypted = publicEncrypt(session.satellitePublicKey, session.sharedSecret);
    return encrypted.toString("base64");
  }

  // ============================================================
  // Encryption/Decryption
  // ============================================================

  /**
   * Encrypt sensitive payload using symmetric encryption
   */
  encryptPayload(satelliteId: string, payload: any): EncryptedPayload {
    const session = this.encryptionSessions.get(satelliteId);
    if (!session) {
      throw new Error(`No encryption session for satellite: ${satelliteId}`);
    }

    const plaintext = JSON.stringify(payload);
    const cipher = createCipheriv("aes-256-cbc", session.symmetricKey, session.iv);

    let encrypted = cipher.update(plaintext, "utf8", "base64");
    encrypted += cipher.final("base64");

    return {
      encrypted,
      iv: session.iv.toString("base64"),
      sessionId: session.sessionId,
    };
  }

  /**
   * Decrypt payload from satellite
   */
  decryptPayload(satelliteId: string, encryptedPayload: EncryptedPayload): any {
    const session = this.encryptionSessions.get(satelliteId);
    if (!session) {
      throw new Error(`No encryption session for satellite: ${satelliteId}`);
    }

    if (session.sessionId !== encryptedPayload.sessionId) {
      throw new Error("Session ID mismatch in encrypted payload");
    }

    const decipher = createDecipheriv("aes-256-cbc", session.symmetricKey, session.iv);

    let decrypted = decipher.update(encryptedPayload.encrypted, "base64", "utf8");
    decrypted += decipher.final("utf8");

    return JSON.parse(decrypted);
  }

  /**
   * Check if payload should be encrypted based on message type
   */
  shouldEncryptPayload(messageType: string): boolean {
    const sensitiveTypes = [
      "session.spawn",
      "session.send",
      "mcp.invoke",
      "memory.update",
      "memory.broadcast",
    ];

    return sensitiveTypes.includes(messageType);
  }

  // ============================================================
  // Permission Management
  // ============================================================

  /**
   * Create satellite token with permissions
   */
  createSatelliteToken(
    satelliteId: string,
    permissions: SatellitePermissions,
    expiresInHours?: number,
  ): SatelliteToken {
    const now = Date.now();
    const token: SatelliteToken = {
      satelliteId,
      permissions,
      issuedAt: now,
      expiresAt: expiresInHours ? now + expiresInHours * 60 * 60 * 1000 : undefined,
      signature: "",
    };

    // Sign token with hub's private key
    token.signature = this.signToken(token);

    this.satelliteTokens.set(satelliteId, token);
    this.permissionCache.set(satelliteId, permissions);

    log.info(`Created satellite token: ${satelliteId}`, {
      level: permissions.level,
      operations: permissions.allowedOperations.length,
    });

    return token;
  }

  /**
   * Explain why a token would be rejected, in words an operator can act on.
   * Returns null when the token is valid.
   */
  diagnoseSatelliteToken(token: SatelliteToken): { code: TokenRejectCode; message: string } | null {
    if (!token || typeof token !== "object" || typeof token.satelliteId !== "string") {
      return {
        code: "malformed",
        message: "The invite code is damaged. Copy the whole code again from the master.",
      };
    }
    if (this.revokedSatelliteIds.has(token.satelliteId)) {
      return {
        code: "revoked",
        message:
          "This device was removed from the master. Generate a new invite on the master to join again.",
      };
    }
    if (token.expiresAt && Date.now() > token.expiresAt) {
      return {
        code: "expired",
        message:
          "This invite has expired. Generate a new one on the master (Fleet › Share Invite) and paste it within 15 minutes.",
      };
    }
    const { signature: _sig, ...rest } = token;
    if (token.signature !== this.signToken(rest)) {
      return {
        code: "unknown_signer",
        message:
          "The master did not recognise this invite. It was made by a different master, or the master was reset. Generate a new invite on the master you want to join.",
      };
    }
    return null;
  }

  /**
   * Grant an already-validated permission set to another id (the node id a
   * satellite registers under can differ from the token's satelliteId).
   */
  grantPermissions(nodeId: string, permissions: SatellitePermissions): void {
    this.permissionCache.set(nodeId, permissions);
  }

  /**
   * Validate satellite token and return permissions
   */
  validateSatelliteToken(token: SatelliteToken): SatellitePermissions | null {
    if (this.revokedSatelliteIds.has(token.satelliteId)) {
      log.warn(`Token revoked for satellite: ${token.satelliteId}`);
      return null;
    }
    // Check expiration
    if (token.expiresAt && Date.now() > token.expiresAt) {
      log.warn(`Token expired for satellite: ${token.satelliteId}`);
      return null;
    }

    // Verify signature
    const { signature: _, ...tokenWithoutSignature } = token;
    const expectedSignature = this.signToken(tokenWithoutSignature);
    if (token.signature !== expectedSignature) {
      log.warn(`Invalid token signature for satellite: ${token.satelliteId}`);
      return null;
    }

    this.permissionCache.set(token.satelliteId, token.permissions);
    return token.permissions;
  }

  /**
   * Check if satellite has permission for operation
   */
  checkPermission(satelliteId: string, operation: OperationType): boolean {
    const permissions = this.permissionCache.get(satelliteId);
    if (!permissions) {
      log.warn(`No permissions found for satellite: ${satelliteId}`);
      return false;
    }

    // Check rate limiting
    if (!this.checkRateLimit(satelliteId, permissions)) {
      return false;
    }

    // Check operation permission
    const hasPermission = permissions.allowedOperations.includes(operation);

    if (!hasPermission) {
      log.warn(`Permission denied: ${satelliteId} -> ${operation}`, {
        level: permissions.level,
        allowed: permissions.allowedOperations,
      });
    }

    return hasPermission;
  }

  /**
   * Get permissions for satellite
   */
  getPermissions(satelliteId: string): SatellitePermissions | null {
    return this.permissionCache.get(satelliteId) || null;
  }

  /**
   * Revoke a satellite token. Adds the satelliteId to an in-memory revocation
   * set so future {@link validateSatelliteToken} calls reject it, and removes
   * any cached permissions / live token entry. Persistent revocation lives in
   * `federation-invites.json` on disk (see `invite-store.ts`).
   */
  revokeSatelliteToken(satelliteId: string): boolean {
    const wasKnown = this.satelliteTokens.has(satelliteId) || this.permissionCache.has(satelliteId);
    this.revokedSatelliteIds.add(satelliteId);
    this.satelliteTokens.delete(satelliteId);
    this.permissionCache.delete(satelliteId);
    log.info(`Revoked satellite token: ${satelliteId}`);
    return wasKnown;
  }

  /** True if a satellite id has been revoked in this process. */
  isSatelliteRevoked(satelliteId: string): boolean {
    return this.revokedSatelliteIds.has(satelliteId);
  }

  // ============================================================
  // Rate Limiting
  // ============================================================

  private checkRateLimit(satelliteId: string, permissions: SatellitePermissions): boolean {
    if (!permissions.ratelimit) return true;

    const now = Date.now();
    const key = satelliteId;
    const counter = this.operationCounters.get(key);

    // Reset counter every minute
    if (!counter || now - counter.resetTime > 60000) {
      this.operationCounters.set(key, { count: 1, resetTime: now });
      return true;
    }

    counter.count++;

    if (counter.count > permissions.ratelimit.operationsPerMinute) {
      log.warn(`Rate limit exceeded for satellite: ${satelliteId}`, {
        count: counter.count,
        limit: permissions.ratelimit.operationsPerMinute,
      });
      return false;
    }

    return true;
  }

  // ============================================================
  // Utility Methods
  // ============================================================

  private signToken(token: Omit<SatelliteToken, "signature">): string {
    const data = JSON.stringify({
      satelliteId: token.satelliteId,
      permissions: token.permissions,
      issuedAt: token.issuedAt,
      expiresAt: token.expiresAt,
    });

    return createHash("sha256")
      .update(data + this.hubKeyPair.privateKey)
      .digest("hex");
  }

  private generateSessionId(): string {
    return randomBytes(16).toString("hex");
  }

  /**
   * Clean up expired sessions and tokens
   */
  cleanup(): void {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours

    // Clean up old encryption sessions
    for (const [satelliteId, session] of this.encryptionSessions.entries()) {
      if (now - session.createdAt > maxAge) {
        this.encryptionSessions.delete(satelliteId);
        log.debug(`Cleaned up encryption session for: ${satelliteId}`);
      }
    }

    // Clean up expired tokens
    for (const [satelliteId, token] of this.satelliteTokens.entries()) {
      if (token.expiresAt && now > token.expiresAt) {
        this.satelliteTokens.delete(satelliteId);
        this.permissionCache.delete(satelliteId);
        log.debug(`Cleaned up expired token for: ${satelliteId}`);
      }
    }

    // Clean up rate limit counters
    for (const [key, counter] of this.operationCounters.entries()) {
      if (now - counter.resetTime > 60000) {
        this.operationCounters.delete(key);
      }
    }
  }
}

// ============================================================
// Default Permission Configurations
// ============================================================

export const DEFAULT_PERMISSIONS: Record<PermissionLevel, SatellitePermissions> = {
  full: {
    level: "full",
    allowedOperations: [
      "session.spawn",
      "session.send",
      "session.complete",
      "state.sync",
      "compute.route",
      "mcp.invoke",
      "memory.update",
      "memory.broadcast",
      "peer.discovery",
      "transcript.request",
    ],
  },

  "spawn-only": {
    level: "spawn-only",
    allowedOperations: ["session.spawn", "session.send", "session.complete", "compute.route"],
    maxSessions: 10,
    ratelimit: {
      operationsPerMinute: 60,
      sessionsPerHour: 50,
    },
  },

  "read-only": {
    level: "read-only",
    allowedOperations: ["state.sync", "peer.discovery"],
    ratelimit: {
      operationsPerMinute: 30,
      sessionsPerHour: 0,
    },
  },
};

// ============================================================
// Helper Functions
// ============================================================

/**
 * Create security manager instance (singleton)
 */
let securityInstance: FederationSecurity | null = null;

export type TokenRejectCode = "malformed" | "revoked" | "expired" | "unknown_signer";

/** `<state>/federation/hub-keypair.json` — the hub signing key (mode 0600). */
export function resolveHubKeyPairPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveSharedDir(env), "federation", "hub-keypair.json");
}

function loadOrCreateKeyPair(
  file: string,
  generate: () => FederationKeyPair,
): FederationKeyPair | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<FederationKeyPair>;
    if (typeof raw.publicKey === "string" && typeof raw.privateKey === "string") {
      return { publicKey: raw.publicKey, privateKey: raw.privateKey };
    }
  } catch {
    /* missing or unreadable — create below */
  }
  try {
    const pair = generate();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(pair), { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmp, file);
    return pair;
  } catch (err) {
    log.warn(
      `could not persist hub key pair (${err instanceof Error ? err.message : String(err)}); using an in-memory key`,
    );
    return null;
  }
}

export function getFederationSecurity(): FederationSecurity {
  if (!securityInstance) {
    // Unit tests get an in-memory key unless they opt in, so a test run can
    // never write a key file into a real state dir.
    const persist = !process.env.VITEST || process.env.INFINIBOT_FEDERATION_PERSIST_KEYS === "1";
    securityInstance = new FederationSecurity(
      persist ? { keyPairPath: resolveHubKeyPairPath() } : {},
    );
  }
  return securityInstance;
}

/** Test seam: drop the singleton so the next call re-reads the key file. */
export function resetFederationSecurityForTests(): void {
  securityInstance = null;
}

/**
 * Check if operation requires encryption
 */
export function isOperationSensitive(operation: OperationType): boolean {
  return getFederationSecurity().shouldEncryptPayload(operation);
}

/**
 * Validate permission level string
 */
export function isValidPermissionLevel(level: string): level is PermissionLevel {
  return ["full", "spawn-only", "read-only"].includes(level);
}

/**
 * The signed token persisted in `federation.authToken`, when it has the
 * SatelliteToken shape (the config schema keeps it as a loose record).
 */
export function satelliteTokenFromConfig(raw: unknown): SatelliteToken | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const t = raw as Record<string, unknown>;
  if (
    typeof t.satelliteId !== "string" ||
    typeof t.signature !== "string" ||
    typeof t.issuedAt !== "number" ||
    !t.permissions ||
    typeof t.permissions !== "object"
  ) {
    return undefined;
  }
  return t as unknown as SatelliteToken;
}
