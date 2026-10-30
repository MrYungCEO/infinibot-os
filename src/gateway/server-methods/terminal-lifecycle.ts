/**
 * Terminal Lifecycle Gateway Methods
 * WebSocket gateway methods for terminal management
 */

import type { TerminalManager } from "../../terminal/manager.js";
import type { TerminalCreateOptions, TerminalSession } from "../../terminal/types.js";

/**
 * Register terminal lifecycle methods with the gateway
 */
export function registerTerminalMethods(
  manager: TerminalManager,
  registry: Map<string, (params: any, context: any) => Promise<any>>,
): void {
  /**
   * Create a new terminal
   */
  registry.set("terminal.create", async (params: TerminalCreateOptions, context: any) => {
    // Extract agent/session context from gateway
    const options: TerminalCreateOptions = {
      ...params,
      agentId: context.agentId || params.agentId,
      sessionKey: context.sessionKey || params.sessionKey,
    };

    const result = await manager.create(options);
    return result;
  });

  /**
   * Destroy a terminal
   */
  registry.set(
    "terminal.destroy",
    async (params: { id: string; killAgentPane?: boolean; force?: boolean }, context: any) => {
      // Same contract as the main terminal handler: closing a view never kills
      // a live `spawn-*` sub-agent pane unless explicitly asked.
      const killAgentPane = params.killAgentPane === true || params.force === true;
      const result = await manager.destroy(params.id, { killAgentPane });
      return result;
    },
  );

  /**
   * List terminals
   */
  registry.set(
    "terminal.list",
    async (params: { projectPath?: string; agentId?: string }, context: any) => {
      // Use context agent ID if not provided in params
      const agentId = params.agentId || context.agentId;
      const terminals = manager.list(params.projectPath, agentId);
      return { terminals };
    },
  );

  /**
   * Write to a terminal
   */
  registry.set("terminal.write", async (params: { id: string; data: string }, context: any) => {
    manager.write(params.id, params.data);
    return { success: true };
  });

  /**
   * Resize a terminal
   */
  registry.set(
    "terminal.resize",
    async (params: { id: string; cols: number; rows: number }, context: any) => {
      manager.resize(params.id, params.cols, params.rows);
      return { success: true };
    },
  );

  /**
   * Get saved sessions
   */
  registry.set(
    "terminal.sessions.get",
    async (params: { projectPath?: string; agentId?: string }, context: any) => {
      const agentId = params.agentId || context.agentId;
      const sessions = manager.getSavedSessions(params.projectPath, agentId);
      return { sessions };
    },
  );

  /**
   * Restore a terminal session
   */
  registry.set(
    "terminal.sessions.restore",
    async (params: { session: TerminalSession; cols?: number; rows?: number }, context: any) => {
      const result = await manager.restore(params.session, params.cols, params.rows);
      return result;
    },
  );

  /**
   * Clear saved sessions
   */
  registry.set(
    "terminal.sessions.clear",
    async (params: { projectPath?: string; agentId?: string }, context: any) => {
      const agentId = params.agentId || context.agentId;
      manager.clearSavedSessions(params.projectPath, agentId);
      return { success: true };
    },
  );

  /**
   * Update terminal title
   */
  registry.set("terminal.setTitle", async (params: { id: string; title: string }, context: any) => {
    manager.setTitle(params.id, params.title);
    return { success: true };
  });

  /**
   * Update display orders
   */
  registry.set(
    "terminal.updateDisplayOrders",
    async (
      params: {
        projectPath?: string;
        agentId?: string;
        orders: Array<{ terminalId: string; displayOrder: number }>;
      },
      context: any,
    ) => {
      const agentId = params.agentId || context.agentId;
      manager.updateDisplayOrders(params.projectPath, agentId, params.orders);
      return { success: true };
    },
  );

  /**
   * Check if terminal is alive
   */
  registry.set("terminal.isAlive", async (params: { id: string }, context: any) => {
    const alive = manager.isTerminalAlive(params.id);
    return { alive };
  });
}
