/**
 * File Watcher for Memory Sync
 *
 * Watches identity files (MEMORY.md, daily notes) for changes
 * and triggers bidirectional sync to the federation master.
 *
 * Files watched:
 * - MEMORY.md - Long-term memory
 * - memory/YYYY-MM-DD.md - Daily notes
 * - TOOLS.md - Tool configurations
 * - HEARTBEAT.md - Heartbeat tasks
 */

import { watch, type FSWatcher } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { EventEmitter } from "node:events";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("federation").child("file-watcher");

// =============================================================================
// Types
// =============================================================================

/** Files to watch for changes */
export const WATCHABLE_FILES = [
  "SOUL.md",
  "USER.md",
  "AGENTS.md",
  "IDENTITY.md",
  "MEMORY.md",
  "TOOLS.md",
  "HEARTBEAT.md",
] as const;

/** Daily notes pattern (memory/YYYY-MM-DD.md) */
export const DAILY_NOTES_PATTERN = /^memory\/\d{4}-\d{2}-\d{2}\.md$/;

/** File change event */
export interface FileChangeEvent {
  /** File path relative to workspace */
  filePath: string;
  /** Full absolute path */
  fullPath: string;
  /** Change type */
  changeType: "created" | "modified" | "deleted";
  /** File content (undefined for deleted files) */
  content?: string;
  /** File modification timestamp */
  timestamp: number;
  /** File size in bytes */
  size?: number;
}

/** File watcher configuration */
export interface FileWatcherConfig {
  /** Workspace root to watch */
  workspace: string;
  /** Debounce delay in ms to avoid rapid fire events (default: 500ms) */
  debounceMs?: number;
  /** Whether to watch daily notes in memory/ directory (default: true) */
  watchDailyNotes?: boolean;
  /** Additional files to watch beyond the defaults */
  additionalFiles?: string[];
}

/** File watcher events */
export interface FileWatcherEvents {
  "file:changed": [event: FileChangeEvent];
  "identity:changed": [event: FileChangeEvent];
  "soul:changed": [event: FileChangeEvent];
  "user:changed": [event: FileChangeEvent];
  "agents:changed": [event: FileChangeEvent];
  "memory:changed": [event: FileChangeEvent];
  "daily:changed": [event: FileChangeEvent];
  "tools:changed": [event: FileChangeEvent];
  "heartbeat:changed": [event: FileChangeEvent];
  error: [error: Error];
}

// =============================================================================
// File Watcher
// =============================================================================

export class MemoryFileWatcher extends EventEmitter<FileWatcherEvents> {
  private workspace: string;
  private debounceMs: number;
  private watchDailyNotes: boolean;
  private additionalFiles: string[];
  private watchers: Map<string, FSWatcher> = new Map();
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private isWatching: boolean = false;

  constructor(config: FileWatcherConfig) {
    super();
    this.workspace = config.workspace;
    this.debounceMs = config.debounceMs ?? 500;
    this.watchDailyNotes = config.watchDailyNotes ?? true;
    this.additionalFiles = config.additionalFiles ?? [];

    log.info(`MemoryFileWatcher initialized for: ${this.workspace}`);
  }

  /**
   * Start watching files for changes.
   */
  async start(): Promise<void> {
    if (this.isWatching) {
      log.warn("File watcher is already running");
      return;
    }

    try {
      // Watch main identity files
      for (const filename of [...WATCHABLE_FILES, ...this.additionalFiles]) {
        await this.watchFile(filename);
      }

      // Watch memory directory for daily notes if enabled
      if (this.watchDailyNotes) {
        await this.watchMemoryDirectory();
      }

      this.isWatching = true;
      log.info(`Started watching ${this.watchers.size} file paths`);
    } catch (err) {
      log.error("Failed to start file watcher:", err as Record<string, unknown>);
      throw err;
    }
  }

  /**
   * Stop watching files.
   */
  stop(): void {
    if (!this.isWatching) {
      return;
    }

    // Close all watchers
    for (const [path, watcher] of this.watchers) {
      try {
        watcher.close();
        log.debug(`Stopped watching: ${path}`);
      } catch (err) {
        log.warn(`Failed to close watcher for ${path}:`, err as Record<string, unknown>);
      }
    }

    // Clear debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }

    this.watchers.clear();
    this.debounceTimers.clear();
    this.isWatching = false;

    log.info("File watcher stopped");
  }

  /**
   * Watch a specific file for changes.
   */
  private async watchFile(filename: string): Promise<void> {
    const filePath = join(this.workspace, filename);

    try {
      // Check if file exists
      try {
        await stat(filePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          log.debug(`File does not exist yet: ${filename}`);
          // Still watch the directory in case the file is created
          const dirPath = dirname(filePath);
          if (!this.watchers.has(dirPath)) {
            this.setupDirectoryWatcher(dirPath, filename);
          }
          return;
        }
        throw err;
      }

      // Watch the file directly
      this.setupFileWatcher(filePath, filename);
    } catch (err) {
      log.warn(`Failed to setup watcher for ${filename}:`, err as Record<string, unknown>);
    }
  }

  /**
   * Watch the memory directory for daily notes.
   */
  private async watchMemoryDirectory(): Promise<void> {
    const memoryDir = join(this.workspace, "memory");

    try {
      // Check if memory directory exists
      try {
        await stat(memoryDir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          log.debug("Memory directory does not exist yet");
          // Watch workspace root for memory directory creation
          this.setupDirectoryWatcher(this.workspace, "memory/");
          return;
        }
        throw err;
      }

      // Watch the memory directory
      this.setupDirectoryWatcher(memoryDir, "memory/");
    } catch (err) {
      log.warn("Failed to setup memory directory watcher:", err as Record<string, unknown>);
    }
  }

  /**
   * Setup a file watcher.
   */
  private setupFileWatcher(filePath: string, relativePath: string): void {
    if (this.watchers.has(filePath)) {
      return;
    }

    try {
      const watcher = watch(filePath, (eventType) => {
        this.handleFileEvent(relativePath, filePath, eventType);
      });

      watcher.on("error", (err) => {
        log.error(`Watcher error for ${relativePath}:`, err as unknown as Record<string, unknown>);
        if (this.listenerCount("error") > 0) this.emit("error", err);
      });

      this.watchers.set(filePath, watcher);
      log.debug(`Watching file: ${relativePath}`);
    } catch (err) {
      log.warn(`Failed to watch ${relativePath}:`, err as Record<string, unknown>);
    }
  }

  /**
   * Setup a directory watcher.
   */
  private setupDirectoryWatcher(dirPath: string, contextPath: string): void {
    if (this.watchers.has(dirPath)) {
      return;
    }

    try {
      const watcher = watch(dirPath, (eventType, filename) => {
        if (!filename) return;

        const filePath = join(dirPath, filename);
        const relativePath = contextPath === "memory/" ? `memory/${filename}` : filename;

        // For memory directory, only watch daily notes
        if (contextPath === "memory/" && !DAILY_NOTES_PATTERN.test(relativePath)) {
          return;
        }

        this.handleFileEvent(relativePath, filePath, eventType);
      });

      watcher.on("error", (err) => {
        log.error(
          `Directory watcher error for ${contextPath}:`,
          err as unknown as Record<string, unknown>,
        );
        if (this.listenerCount("error") > 0) this.emit("error", err);
      });

      this.watchers.set(dirPath, watcher);
      log.debug(`Watching directory: ${contextPath}`);
    } catch (err) {
      log.warn(`Failed to watch directory ${contextPath}:`, err as Record<string, unknown>);
    }
  }

  /**
   * Handle file system events with debouncing.
   */
  private handleFileEvent(relativePath: string, fullPath: string, eventType: string): void {
    // Clear existing debounce timer
    const existingTimer = this.debounceTimers.get(fullPath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set new debounce timer
    const timer = setTimeout(async () => {
      try {
        await this.processFileChange(relativePath, fullPath, eventType);
      } catch (err) {
        log.error(
          `Failed to process file change for ${relativePath}:`,
          err as Record<string, unknown>,
        );
        // An "error" emit with no listener throws, and from this timer that
        // became an unhandled rejection that took the whole gateway down (a
        // fresh satellite died 30s after pairing).
        if (this.listenerCount("error") > 0) this.emit("error", err as Error);
      } finally {
        this.debounceTimers.delete(fullPath);
      }
    }, this.debounceMs);

    this.debounceTimers.set(fullPath, timer);
  }

  /**
   * Process a file change after debouncing.
   */
  private async processFileChange(
    relativePath: string,
    fullPath: string,
    eventType: string,
  ): Promise<void> {
    log.debug(`Processing file change: ${relativePath} (${eventType})`);

    let changeType: FileChangeEvent["changeType"];
    let content: string | undefined;
    let size: number | undefined;

    try {
      // Check if file exists to determine change type
      const stats = await stat(fullPath);
      // fs.watch reports directories too (e.g. a `state/` dir appearing in
      // the workspace); reading one throws EISDIR and, with no "error"
      // listener, the re-emit crashed the whole satellite gateway.
      if (stats.isDirectory()) return;
      changeType = eventType === "rename" ? "created" : "modified";
      size = stats.size;

      // Read file content
      content = await readFile(fullPath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        changeType = "deleted";
        content = undefined;
        size = undefined;
      } else {
        throw err;
      }
    }

    const event: FileChangeEvent = {
      filePath: relativePath,
      fullPath,
      changeType,
      content,
      timestamp: Date.now(),
      size,
    };

    // Emit general file change event
    this.emit("file:changed", event);

    // Emit specific events based on file type
    if (relativePath === "SOUL.md") {
      this.emit("soul:changed", event);
      this.emit("identity:changed", event);
    } else if (relativePath === "USER.md") {
      this.emit("user:changed", event);
      this.emit("identity:changed", event);
    } else if (relativePath === "AGENTS.md") {
      this.emit("agents:changed", event);
      this.emit("identity:changed", event);
    } else if (relativePath === "IDENTITY.md") {
      this.emit("identity:changed", event);
    } else if (relativePath === "MEMORY.md") {
      this.emit("memory:changed", event);
    } else if (relativePath === "TOOLS.md") {
      this.emit("tools:changed", event);
      this.emit("identity:changed", event);
    } else if (relativePath === "HEARTBEAT.md") {
      this.emit("heartbeat:changed", event);
      this.emit("identity:changed", event);
    } else if (DAILY_NOTES_PATTERN.test(relativePath)) {
      this.emit("daily:changed", event);
    }

    log.info(`File ${changeType}: ${relativePath} (${size ?? 0} bytes)`);
  }

  /**
   * Get current watching status.
   */
  isActive(): boolean {
    return this.isWatching;
  }

  /**
   * Get list of files being watched.
   */
  getWatchedFiles(): string[] {
    return Array.from(this.watchers.keys());
  }
}

// =============================================================================
// Singleton
// =============================================================================

let defaultFileWatcher: MemoryFileWatcher | null = null;

/**
 * Get the default file watcher instance.
 */
export function getFileWatcher(): MemoryFileWatcher | null {
  return defaultFileWatcher;
}

/**
 * Initialize the default file watcher.
 */
export function initFileWatcher(config: FileWatcherConfig): MemoryFileWatcher {
  if (defaultFileWatcher) {
    log.warn("File watcher already initialized");
    return defaultFileWatcher;
  }

  defaultFileWatcher = new MemoryFileWatcher(config);
  return defaultFileWatcher;
}

/**
 * Stop the default file watcher.
 */
export function stopFileWatcher(): void {
  if (defaultFileWatcher) {
    defaultFileWatcher.stop();
    defaultFileWatcher = null;
  }
}
