/**
 * Federation Audit Logger
 *
 * Comprehensive audit logging for all federation operations.
 * Provides tamper-resistant, append-only logging with structured data.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { hostname } from "node:os";

const log = createSubsystemLogger("federation:audit");

// ============================================================
// Audit Event Types
// ============================================================

export type AuditEventType =
  | "node.connect"
  | "node.register"
  | "node.disconnect"
  | "node.auth"
  | "session.spawn"
  | "session.send"
  | "session.complete"
  | "session.migrate"
  | "permission.check"
  | "permission.deny"
  | "encryption.establish"
  | "encryption.error"
  | "state.sync"
  | "compute.route"
  | "mcp.invoke"
  | "ui.control"
  | "memory.update"
  | "error"
  | "security.violation";

export type AuditResult = "success" | "failure" | "blocked" | "error" | "timeout";

export interface AuditEvent {
  timestamp: number;
  hostname: string;
  eventType: AuditEventType;
  result: AuditResult;

  // Core identifiers
  nodeId?: string;
  satelliteId?: string;
  sessionKey?: string;
  messageId?: string;

  // Operation details
  operation?: string;
  resource?: string;
  workspace?: string;

  // Security context
  permissionLevel?: string;
  encrypted?: boolean;

  // Result details
  errorMessage?: string;
  errorCode?: string;
  durationMs?: number;
  dataSize?: number;

  // Additional context
  metadata?: Record<string, unknown>;

  // Integrity protection
  sequenceNumber: number;
  checksum: string;
  prevChecksum?: string;
}

export interface AuditLogConfig {
  logDir: string;
  maxFileSize: number; // bytes
  rotateDaily: boolean;
  enableIntegrityChecking: boolean;
  includeMetadata: boolean;
}

// ============================================================
// Audit Logger
// ============================================================

export class FederationAuditLogger {
  private config: AuditLogConfig;
  private currentLogFile: string = "";
  private sequenceNumber: number = 0;
  private lastChecksum: string = "";
  private hostname: string;

  constructor(config?: Partial<AuditLogConfig>) {
    this.config = {
      logDir: "logs/federation-audit",
      maxFileSize: 10 * 1024 * 1024, // 10MB
      rotateDaily: true,
      enableIntegrityChecking: true,
      includeMetadata: true,
      ...config,
    };

    this.hostname = hostname();
    this.ensureLogDirectory();
    this.initializeLog();

    log.info("Federation audit logger initialized", {
      logDir: this.config.logDir,
      hostname: this.hostname,
    });
  }

  // ============================================================
  // Core Logging Methods
  // ============================================================

  /**
   * Log a federation audit event
   */
  logEvent(
    eventType: AuditEventType,
    result: AuditResult,
    context: Partial<
      Omit<
        AuditEvent,
        "timestamp" | "hostname" | "eventType" | "result" | "sequenceNumber" | "checksum"
      >
    > = {},
  ): void {
    const event: AuditEvent = {
      timestamp: Date.now(),
      hostname: this.hostname,
      eventType,
      result,
      sequenceNumber: ++this.sequenceNumber,
      checksum: "",
      prevChecksum: this.lastChecksum || undefined,
      ...context,
    };

    // Calculate checksum for integrity
    if (this.config.enableIntegrityChecking) {
      event.checksum = this.calculateChecksum(event);
      this.lastChecksum = event.checksum;
    }

    this.writeEvent(event);
  }

  /**
   * Log successful operations
   */
  logSuccess(eventType: AuditEventType, context: Partial<AuditEvent> = {}): void {
    this.logEvent(eventType, "success", context);
  }

  /**
   * Log failures and errors
   */
  logFailure(
    eventType: AuditEventType,
    error: string | Error,
    context: Partial<AuditEvent> = {},
  ): void {
    const errorMessage = error instanceof Error ? error.message : error;
    this.logEvent(eventType, "failure", {
      ...context,
      errorMessage,
    });
  }

  /**
   * Log blocked operations (permission denied)
   */
  logBlocked(eventType: AuditEventType, reason: string, context: Partial<AuditEvent> = {}): void {
    this.logEvent(eventType, "blocked", {
      ...context,
      errorMessage: reason,
    });
  }

  /**
   * Log security violations
   */
  logSecurityViolation(description: string, context: Partial<AuditEvent> = {}): void {
    this.logEvent("security.violation", "blocked", {
      ...context,
      errorMessage: description,
      operation: "security_check",
    });

    // Also log to main logger for immediate attention
    log.error(`SECURITY VIOLATION: ${description}`, context);
  }

  // ============================================================
  // Specific Operation Loggers
  // ============================================================

  /**
   * Log node connection events
   */
  logNodeConnection(nodeId: string, success: boolean, error?: string): void {
    this.logEvent("node.connect", success ? "success" : "failure", {
      nodeId,
      errorMessage: error,
    });
  }

  /**
   * Log node registration events
   */
  logNodeRegistration(
    nodeId: string,
    satelliteId: string,
    permissionLevel: string,
    success: boolean,
    error?: string,
  ): void {
    this.logEvent("node.register", success ? "success" : "failure", {
      nodeId,
      satelliteId,
      permissionLevel,
      errorMessage: error,
    });
  }

  /**
   * Log permission check events
   */
  logPermissionCheck(
    satelliteId: string,
    operation: string,
    allowed: boolean,
    permissionLevel?: string,
    reason?: string,
  ): void {
    this.logEvent("permission.check", allowed ? "success" : "blocked", {
      satelliteId,
      operation,
      permissionLevel,
      errorMessage: reason,
    });
  }

  /**
   * Log session operations
   */
  logSessionOperation(
    operation: "spawn" | "send" | "complete" | "migrate",
    sessionKey: string,
    nodeId?: string,
    success: boolean = true,
    metadata?: Record<string, unknown>,
  ): void {
    const eventType = `session.${operation}` as AuditEventType;
    this.logEvent(eventType, success ? "success" : "failure", {
      sessionKey,
      nodeId,
      metadata: this.config.includeMetadata ? metadata : undefined,
    });
  }

  /**
   * Log encryption establishment
   */
  logEncryptionEstablishment(
    satelliteId: string,
    sessionId: string,
    success: boolean,
    error?: string,
  ): void {
    this.logEvent("encryption.establish", success ? "success" : "failure", {
      satelliteId,
      resource: sessionId,
      errorMessage: error,
      encrypted: true,
    });
  }

  /**
   * Log MCP operations
   */
  logMCPOperation(
    satelliteId: string,
    mcpServer: string,
    tool: string,
    success: boolean,
    durationMs?: number,
    error?: string,
  ): void {
    this.logEvent("mcp.invoke", success ? "success" : "failure", {
      satelliteId,
      operation: `${mcpServer}.${tool}`,
      resource: mcpServer,
      durationMs,
      errorMessage: error,
    });
  }

  // ============================================================
  // File Management
  // ============================================================

  private ensureLogDirectory(): void {
    if (!existsSync(this.config.logDir)) {
      mkdirSync(this.config.logDir, { recursive: true });
    }
  }

  private initializeLog(): void {
    this.currentLogFile = this.getLogFileName();

    // Write header if new file
    if (!existsSync(this.currentLogFile)) {
      this.writeHeader();
    }
  }

  private getLogFileName(): string {
    const now = new Date();
    const dateStr = this.config.rotateDaily
      ? now.toISOString().split("T")[0] // YYYY-MM-DD
      : "current";

    return join(this.config.logDir, `federation-audit-${dateStr}.jsonl`);
  }

  private writeHeader(): void {
    const header = {
      type: "audit_log_header",
      version: "1.0",
      hostname: this.hostname,
      started: new Date().toISOString(),
      config: this.config,
    };

    appendFileSync(this.currentLogFile, JSON.stringify(header) + "\n", "utf8");
  }

  private writeEvent(event: AuditEvent): void {
    try {
      // Check if we need to rotate the log
      if (this.shouldRotateLog()) {
        this.rotateLog();
      }

      const line = JSON.stringify(event) + "\n";
      appendFileSync(this.currentLogFile, line, "utf8");
    } catch (error) {
      log.error("Failed to write audit event", { error, event });

      // Try to log the error to a fallback location
      try {
        const fallbackFile = join(this.config.logDir, "audit-errors.log");
        const errorEntry = {
          timestamp: Date.now(),
          error: error instanceof Error ? error.message : String(error),
          originalEvent: event,
        };
        appendFileSync(fallbackFile, JSON.stringify(errorEntry) + "\n", "utf8");
      } catch (fallbackError) {
        // If we can't even log to fallback, just console.error
        console.error("Critical audit logging failure:", fallbackError);
      }
    }
  }

  private shouldRotateLog(): boolean {
    if (!existsSync(this.currentLogFile)) {
      return false;
    }

    // Check daily rotation
    if (this.config.rotateDaily) {
      const currentFile = this.currentLogFile;
      const expectedFile = this.getLogFileName();
      if (currentFile !== expectedFile) {
        return true;
      }
    }

    // Check file size
    try {
      const stats = require("fs").statSync(this.currentLogFile);
      return stats.size >= this.config.maxFileSize;
    } catch {
      return false;
    }
  }

  private rotateLog(): void {
    log.info("Rotating audit log", {
      currentFile: this.currentLogFile,
      sequenceNumber: this.sequenceNumber,
    });

    this.currentLogFile = this.getLogFileName();
    this.writeHeader();
  }

  private calculateChecksum(event: Omit<AuditEvent, "checksum">): string {
    // Create deterministic string representation
    const dataToHash = JSON.stringify({
      timestamp: event.timestamp,
      hostname: event.hostname,
      eventType: event.eventType,
      result: event.result,
      sequenceNumber: event.sequenceNumber,
      prevChecksum: event.prevChecksum,
      // Include key fields that should be integrity-protected
      nodeId: event.nodeId,
      satelliteId: event.satelliteId,
      operation: event.operation,
    });

    return createHash("sha256").update(dataToHash).digest("hex").substring(0, 16);
  }

  // ============================================================
  // Query and Reporting
  // ============================================================

  /**
   * Get audit statistics
   */
  getStats(): AuditStats {
    return {
      totalEvents: this.sequenceNumber,
      currentFile: this.currentLogFile,
      hostname: this.hostname,
      lastEventTime: Date.now(),
    };
  }

  /**
   * Clean up old log files
   */
  cleanup(retentionDays: number = 30): void {
    // This would implement log file cleanup logic
    // For now, just log the intent
    log.info(`Audit log cleanup requested`, { retentionDays });
  }
}

// ============================================================
// Types and Interfaces
// ============================================================

export interface AuditStats {
  totalEvents: number;
  currentFile: string;
  hostname: string;
  lastEventTime: number;
}

// ============================================================
// Singleton and Utilities
// ============================================================

let auditLogger: FederationAuditLogger | null = null;

/**
 * Get singleton audit logger instance
 */
export function getFederationAuditLogger(config?: Partial<AuditLogConfig>): FederationAuditLogger {
  if (!auditLogger) {
    auditLogger = new FederationAuditLogger(config);
  }
  return auditLogger;
}

/**
 * Convenience logging functions
 */
export const audit = {
  success: (eventType: AuditEventType, context?: Partial<AuditEvent>) =>
    getFederationAuditLogger().logSuccess(eventType, context),

  failure: (eventType: AuditEventType, error: string | Error, context?: Partial<AuditEvent>) =>
    getFederationAuditLogger().logFailure(eventType, error, context),

  blocked: (eventType: AuditEventType, reason: string, context?: Partial<AuditEvent>) =>
    getFederationAuditLogger().logBlocked(eventType, reason, context),

  security: (description: string, context?: Partial<AuditEvent>) =>
    getFederationAuditLogger().logSecurityViolation(description, context),

  node: {
    connect: (nodeId: string, success: boolean, error?: string) =>
      getFederationAuditLogger().logNodeConnection(nodeId, success, error),

    register: (
      nodeId: string,
      satelliteId: string,
      permissionLevel: string,
      success: boolean,
      error?: string,
    ) =>
      getFederationAuditLogger().logNodeRegistration(
        nodeId,
        satelliteId,
        permissionLevel,
        success,
        error,
      ),
  },

  permission: {
    check: (
      satelliteId: string,
      operation: string,
      allowed: boolean,
      level?: string,
      reason?: string,
    ) =>
      getFederationAuditLogger().logPermissionCheck(satelliteId, operation, allowed, level, reason),
  },

  session: {
    spawn: (
      sessionKey: string,
      nodeId?: string,
      success: boolean = true,
      metadata?: Record<string, unknown>,
    ) =>
      getFederationAuditLogger().logSessionOperation(
        "spawn",
        sessionKey,
        nodeId,
        success,
        metadata,
      ),

    send: (sessionKey: string, nodeId?: string, success: boolean = true) =>
      getFederationAuditLogger().logSessionOperation("send", sessionKey, nodeId, success),

    complete: (sessionKey: string, nodeId?: string, success: boolean = true) =>
      getFederationAuditLogger().logSessionOperation("complete", sessionKey, nodeId, success),
  },

  encryption: {
    establish: (satelliteId: string, sessionId: string, success: boolean, error?: string) =>
      getFederationAuditLogger().logEncryptionEstablishment(satelliteId, sessionId, success, error),
  },

  mcp: {
    invoke: (
      satelliteId: string,
      server: string,
      tool: string,
      success: boolean,
      duration?: number,
      error?: string,
    ) =>
      getFederationAuditLogger().logMCPOperation(
        satelliteId,
        server,
        tool,
        success,
        duration,
        error,
      ),
  },
};
