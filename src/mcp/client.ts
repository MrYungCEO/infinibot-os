/**
 * MCP Client - Spawns and manages external MCP servers
 *
 * This module:
 * 1. Reads MCP configs from ~/.claude/mcp.json and state/mcp-servers.json
 * 2. Spawns MCP servers as child processes (command + args)
 * 3. Connects via stdio using MCP protocol
 * 4. Registers them with the federation mcp-proxy for routing
 * 5. Exposes tools to agents
 */

import { spawn, ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  discoverLocalMCPServers,
  type LocalMCPServer,
  type MCPServerConfig,
} from "./local-discovery.js";
import { registerLocalMCP, unregisterLocalMCP } from "../federation/mcp-proxy.js";

const log = createSubsystemLogger("mcp").child("client");

// ══════════════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════════════

export interface MCPToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface MCPClientInstance {
  id: string;
  name: string;
  config: MCPServerConfig;
  process: ChildProcess | null;
  status: "starting" | "running" | "stopped" | "error";
  tools: MCPToolDefinition[];
  error?: string;
  startedAt?: number;
}

interface MCPMessage {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ══════════════════════════════════════════════════════════════════════════════
// MCP Client Manager (Singleton)
// ══════════════════════════════════════════════════════════════════════════════

class MCPClientManager extends EventEmitter {
  private instances = new Map<string, MCPClientInstance>();
  private pendingRequests = new Map<
    string,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private messageBuffers = new Map<string, string>();

  /**
   * Start all configured MCP servers
   */
  async startAll(): Promise<void> {
    const servers = discoverLocalMCPServers();
    log.info(`discovered ${servers.length} MCP servers to start`);

    for (const server of servers) {
      // Skip HTTP-based servers (like supabase, infranodus)
      if (server.config.url || (server.config as any).type === "http") {
        log.info(`skipping HTTP MCP: ${server.name}`);
        continue;
      }

      try {
        await this.start(server);
      } catch (err) {
        log.error(`failed to start MCP ${server.name}: ${err}`);
      }
    }
  }

  /**
   * Start a single MCP server
   */
  async start(server: LocalMCPServer): Promise<MCPClientInstance> {
    const { name, config } = server;

    if (this.instances.has(name)) {
      const existing = this.instances.get(name)!;
      if (existing.status === "running") {
        log.debug(`MCP ${name} already running`);
        return existing;
      }
    }

    log.info(`starting MCP: ${name} (${config.command})`);

    const instance: MCPClientInstance = {
      id: randomUUID(),
      name,
      config,
      process: null,
      status: "starting",
      tools: [],
      startedAt: Date.now(),
    };

    this.instances.set(name, instance);

    try {
      // Resolve environment variables
      const env = { ...process.env };
      if (config.env) {
        for (const [key, value] of Object.entries(config.env)) {
          // Replace ${VAR} with actual env value
          env[key] = value.replace(/\$\{(\w+)\}/g, (_, varName) => process.env[varName] || "");
        }
      }

      // Spawn the process
      // Windows quirk: passing args with `shell: true` triggers DEP0190 and,
      // worse, breaks when `command` is an absolute path containing spaces
      // (e.g. "C:\Program Files\nodejs\node.exe") — cmd.exe parses the path
      // up to the first space as the executable and treats the rest as args,
      // so the child dies with exit code 1 before we ever read its stdout.
      // Only opt into `shell: true` when we *need* PATHEXT resolution: a bare
      // command like "npx" or "uvx" with no path separator and no extension.
      const cmd = config.command ?? "";
      const looksLikeAbsolutePath = /^[a-zA-Z]:[\\/]/.test(cmd) || cmd.startsWith("/");
      const hasPathSeparator = cmd.includes("/") || cmd.includes("\\");
      const hasExtension = /\.[a-z0-9]+$/i.test(cmd);
      const useShell =
        process.platform === "win32" &&
        !looksLikeAbsolutePath &&
        !hasPathSeparator &&
        !hasExtension;
      const proc = spawn(cmd, config.args || [], {
        cwd: config.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: useShell,
      });

      instance.process = proc;

      // Handle stdout (MCP responses)
      proc.stdout?.on("data", (data: Buffer) => {
        this.handleStdout(name, data.toString());
      });

      // Handle stderr (logging)
      proc.stderr?.on("data", (data: Buffer) => {
        log.debug(`[${name}] stderr: ${data.toString().trim()}`);
      });

      // Handle process exit
      proc.on("exit", (code) => {
        log.info(`MCP ${name} exited with code ${code}`);
        instance.status = "stopped";
        instance.process = null;
        unregisterLocalMCP(name);
      });

      proc.on("error", (err) => {
        log.error(`MCP ${name} process error: ${err.message}`);
        instance.status = "error";
        instance.error = err.message;
      });

      // Wait for process to be ready
      await this.waitForReady(name, 5000);

      // Initialize MCP protocol
      await this.initialize(name);

      // Discover tools
      const tools = await this.listTools(name);
      instance.tools = tools;
      instance.status = "running";

      // Register with federation proxy
      registerLocalMCP(
        name,
        tools.map((t) => t.name),
        async (tool: string, args: Record<string, unknown>) => {
          return this.callTool(name, tool, args);
        },
      );

      log.info(
        `MCP ${name} started with ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`,
      );
      this.emit("started", { name, tools });

      return instance;
    } catch (err) {
      instance.status = "error";
      instance.error = err instanceof Error ? err.message : String(err);
      log.error(`failed to start MCP ${name}: ${instance.error}`);
      throw err;
    }
  }

  /**
   * Stop a specific MCP server
   */
  async stop(name: string): Promise<void> {
    const instance = this.instances.get(name);
    if (!instance) return;

    if (instance.process) {
      instance.process.kill();
    }
    instance.status = "stopped";
    unregisterLocalMCP(name);
    this.instances.delete(name);
    log.info(`stopped MCP: ${name}`);
  }

  /**
   * Stop all MCP servers
   */
  async stopAll(): Promise<void> {
    for (const name of this.instances.keys()) {
      await this.stop(name);
    }
  }

  /**
   * Get status of all MCP instances
   */
  getStatus(): MCPClientInstance[] {
    return Array.from(this.instances.values());
  }

  /**
   * Get tools from a specific MCP
   */
  getTools(name: string): MCPToolDefinition[] {
    return this.instances.get(name)?.tools || [];
  }

  /**
   * Get all tools from all MCPs
   */
  getAllTools(): Array<{ mcp: string; tool: MCPToolDefinition }> {
    const allTools: Array<{ mcp: string; tool: MCPToolDefinition }> = [];
    for (const [name, instance] of this.instances) {
      for (const tool of instance.tools) {
        allTools.push({ mcp: name, tool });
      }
    }
    return allTools;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // MCP Protocol Implementation
  // ════════════════════════════════════════════════════════════════════════════

  private async waitForReady(name: string, _timeoutMs: number): Promise<void> {
    const instance = this.instances.get(name);
    const initialProc = instance?.process;
    if (!instance || !initialProc) throw new Error(`MCP ${name} not started`);

    // Give process time to start
    await new Promise((resolve) => setTimeout(resolve, 500));

    // The 'exit' handler nulls out instance.process when the child dies, so
    // re-read state defensively here. If we lost the reference, the process
    // already exited; report it without dereferencing null.
    const proc = instance.process;
    if (!proc) {
      throw new Error(`MCP ${name} exited during startup (process terminated before ready)`);
    }
    if (proc.exitCode !== null) {
      throw new Error(`MCP ${name} exited during startup with code ${proc.exitCode}`);
    }
  }

  private async initialize(name: string): Promise<void> {
    const result = await this.sendRequest(name, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "infinibot",
        version: "1.0.0",
      },
    });

    log.debug(`MCP ${name} initialized: ${JSON.stringify(result)}`);

    // Send initialized notification
    this.sendNotification(name, "notifications/initialized", {});
  }

  private async listTools(name: string): Promise<MCPToolDefinition[]> {
    const result = (await this.sendRequest(name, "tools/list", {})) as {
      tools?: MCPToolDefinition[];
    };
    return result.tools || [];
  }

  async callTool(name: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    log.debug(`calling MCP tool: ${name}.${toolName}`);
    const result = await this.sendRequest(name, "tools/call", {
      name: toolName,
      arguments: args,
    });
    return result;
  }

  private sendRequest(name: string, method: string, params: unknown): Promise<unknown> {
    const instance = this.instances.get(name);
    if (!instance?.process?.stdin) {
      return Promise.reject(new Error(`MCP ${name} not available`));
    }

    const id = randomUUID();
    const message: MCPMessage = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`MCP ${name} request timeout: ${method}`));
      }, 30000);

      this.pendingRequests.set(id, { resolve, reject, timer });

      const line = JSON.stringify(message) + "\n";
      log.debug(`[${name}] >>> ${line.trim()}`);
      instance.process!.stdin!.write(line);
    });
  }

  private sendNotification(name: string, method: string, params: unknown): void {
    const instance = this.instances.get(name);
    if (!instance?.process?.stdin) return;

    const message: MCPMessage = {
      jsonrpc: "2.0",
      method,
      params,
    };

    const line = JSON.stringify(message) + "\n";
    log.debug(`[${name}] >>> ${line.trim()}`);
    instance.process.stdin.write(line);
  }

  private handleStdout(name: string, data: string): void {
    // Buffer partial messages
    const buffer = (this.messageBuffers.get(name) || "") + data;
    const lines = buffer.split("\n");

    // Keep incomplete last line in buffer
    this.messageBuffers.set(name, lines.pop() || "");

    for (const line of lines) {
      if (!line.trim()) continue;

      log.debug(`[${name}] <<< ${line}`);

      try {
        const msg: MCPMessage = JSON.parse(line);
        this.handleMessage(name, msg);
      } catch {
        log.debug(`[${name}] non-JSON output: ${line}`);
      }
    }
  }

  private handleMessage(name: string, msg: MCPMessage): void {
    // Response to a request
    if (msg.id !== undefined) {
      const pending = this.pendingRequests.get(String(msg.id));
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(String(msg.id));

        if (msg.error) {
          pending.reject(new Error(`MCP error: ${msg.error.message}`));
        } else {
          pending.resolve(msg.result);
        }
      }
    }

    // Notification from server
    if (msg.method && !msg.id) {
      log.debug(`[${name}] notification: ${msg.method}`);
      this.emit("notification", { name, method: msg.method, params: msg.params });
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Singleton Export
// ══════════════════════════════════════════════════════════════════════════════

let mcpClientManager: MCPClientManager | null = null;

export function getMCPClientManager(): MCPClientManager {
  if (!mcpClientManager) {
    mcpClientManager = new MCPClientManager();
  }
  return mcpClientManager;
}

/**
 * Start all configured MCP servers.
 * Call this during gateway startup.
 */
export async function startMCPServers(): Promise<void> {
  const manager = getMCPClientManager();
  await manager.startAll();
}

/**
 * Stop all MCP servers.
 * Call this during gateway shutdown.
 */
export async function stopMCPServers(): Promise<void> {
  const manager = getMCPClientManager();
  await manager.stopAll();
}

/**
 * Get all available MCP tools for agent prompts.
 */
export function getMCPToolsForAgent(): Array<{ mcp: string; tool: MCPToolDefinition }> {
  const manager = getMCPClientManager();
  return manager.getAllTools();
}

/**
 * Call an MCP tool directly.
 */
export async function callMCPTool(
  mcpName: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const manager = getMCPClientManager();
  return manager.callTool(mcpName, toolName, args);
}
