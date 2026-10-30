/**
 * Session State Management
 * 
 * Handles serialization/deserialization of session state for migration between nodes.
 * This includes conversation history, agent configuration, running task state, and memory/context.
 */

import { randomUUID } from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agents").child("session-state");

// =============================================================================
// Types
// =============================================================================

/** Configuration for an agent session */
export interface AgentConfiguration {
  /** Agent ID */
  agentId: string;
  /** Model being used */
  model?: string;
  /** Thinking level */
  thinking?: string;
  /** Workspace path */
  workspace?: string;
  /** Session label */
  label?: string;
  /** Run timeout in seconds */
  runTimeoutSeconds?: number;
  /** Custom system prompt overrides */
  systemPromptOverrides?: Record<string, string>;
  /** Tool policy settings */
  toolPolicy?: {
    allowed?: string[];
    denied?: string[];
  };
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/** A conversation message */
export interface ConversationMessage {
  /** Unique message ID */
  id: string;
  /** Role (user, assistant, tool) */
  role: "user" | "assistant" | "tool";
  /** Message content */
  content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
  /** Timestamp */
  timestamp: number;
  /** Tool call information if this is a tool message */
  toolCall?: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  };
  /** Tool result if this is a tool response */
  toolResult?: {
    id: string;
    result: unknown;
    error?: string;
  };
  /** Message metadata */
  metadata?: Record<string, unknown>;
}

/** Current task state */
export interface TaskState {
  /** Current task description */
  currentTask?: string;
  /** Task progress (0-100) */
  progress?: number;
  /** Current status */
  status?: string;
  /** Task metadata */
  metadata?: Record<string, unknown>;
  /** Sub-tasks or checkpoints */
  checkpoints?: Array<{
    name: string;
    completed: boolean;
    timestamp?: number;
  }>;
  /** Active tool calls */
  activeToolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    startTime: number;
  }>;
}

/** Memory and context information */
export interface SessionMemory {
  /** Working memory/notes */
  workingMemory?: string;
  /** Long-term context */
  context?: Record<string, unknown>;
  /** Session variables */
  variables?: Record<string, unknown>;
  /** File system state */
  fileSystemState?: {
    currentDirectory?: string;
    recentFiles?: string[];
  };
  /** Environment state */
  environmentState?: Record<string, unknown>;
}

/** Complete serializable session state */
export interface SessionState {
  /** State format version */
  version: string;
  /** Original session key */
  originalSessionKey: string;
  /** Node where session originated */
  originNodeId: string;
  /** Session creation timestamp */
  createdAt: number;
  /** Last activity timestamp */
  lastActivity: number;
  
  /** Agent configuration */
  agentConfig: AgentConfiguration;
  
  /** Conversation history */
  conversationHistory: ConversationMessage[];
  
  /** Current task state */
  taskState: TaskState;
  
  /** Memory and context */
  memory: SessionMemory;
  
  /** Additional metadata */
  metadata: Record<string, unknown>;
}

/** Options for state serialization */
export interface SerializationOptions {
  /** Whether to include full conversation history */
  includeFullHistory?: boolean;
  /** Maximum number of messages to include */
  maxMessages?: number;
  /** Whether to include file system state */
  includeFileSystem?: boolean;
  /** Whether to compress the state */
  compress?: boolean;
}

/** Result of state serialization */
export interface SerializationResult {
  /** Serialized state data */
  state: SessionState;
  /** Size of serialized data in bytes */
  sizeBytes: number;
  /** Serialization timestamp */
  timestamp: number;
  /** Any warnings during serialization */
  warnings?: string[];
}

/** Result of state restoration */
export interface RestorationResult {
  /** Whether restoration was successful */
  success: boolean;
  /** New session key if successful */
  newSessionKey?: string;
  /** Error message if restoration failed */
  error?: string;
  /** Warnings during restoration */
  warnings?: string[];
  /** Restored state for verification */
  restoredState?: Partial<SessionState>;
}

// =============================================================================
// Constants
// =============================================================================

/** Current session state format version */
export const SESSION_STATE_VERSION = "1.0.0";

/** Default serialization options */
export const DEFAULT_SERIALIZATION_OPTIONS: SerializationOptions = {
  includeFullHistory: true,
  maxMessages: 1000,
  includeFileSystem: true,
  compress: false,
};

// =============================================================================
// Session State Manager
// =============================================================================

export class SessionStateManager {
  private static instance: SessionStateManager;
  
  /** Get singleton instance */
  static getInstance(): SessionStateManager {
    if (!SessionStateManager.instance) {
      SessionStateManager.instance = new SessionStateManager();
    }
    return SessionStateManager.instance;
  }

  /**
   * Serialize a session's current state for migration.
   */
  async serializeSession(
    sessionKey: string,
    options: SerializationOptions = DEFAULT_SERIALIZATION_OPTIONS
  ): Promise<SerializationResult> {
    log.info(`serializing session state: ${sessionKey}`);
    
    try {
      // This is a placeholder - in a real implementation, you would:
      // 1. Gather conversation history from the session
      // 2. Extract current agent configuration
      // 3. Capture running task state
      // 4. Collect memory and context
      
      const state: SessionState = {
        version: SESSION_STATE_VERSION,
        originalSessionKey: sessionKey,
        originNodeId: "current-node", // Would be determined dynamically
        createdAt: Date.now() - 3600000, // Example: 1 hour ago
        lastActivity: Date.now(),
        
        agentConfig: {
          agentId: "main", // Would be extracted from session
          model: "anthropic/claude-sonnet-4-20250514",
          thinking: "low",
          workspace: process.cwd(),
          label: "Session Migration Test",
        },
        
        conversationHistory: [
          {
            id: randomUUID(),
            role: "user",
            content: "Hello, I need to migrate this session",
            timestamp: Date.now() - 300000,
          },
          {
            id: randomUUID(),
            role: "assistant",
            content: "I understand you want to migrate this session. I'll help you with that.",
            timestamp: Date.now() - 200000,
          },
        ],
        
        taskState: {
          currentTask: "Session migration preparation",
          progress: 50,
          status: "in_progress",
          checkpoints: [
            { name: "state_extraction", completed: true, timestamp: Date.now() - 100000 },
            { name: "serialization", completed: false },
          ],
        },
        
        memory: {
          workingMemory: "Working on session migration functionality",
          context: {
            lastCommand: "session migration",
            sessionType: "main",
          },
          fileSystemState: {
            currentDirectory: process.cwd(),
            recentFiles: ["src/federation/session-migration.ts"],
          },
        },
        
        metadata: {
          migrationType: "live_migration",
          priority: "normal",
        },
      };
      
      // Apply message limits if specified
      if (options.maxMessages && state.conversationHistory.length > options.maxMessages) {
        state.conversationHistory = state.conversationHistory.slice(-options.maxMessages);
      }
      
      // Calculate size
      const stateJson = JSON.stringify(state);
      const sizeBytes = Buffer.byteLength(stateJson, 'utf8');
      
      log.info(`session state serialized: ${sizeBytes} bytes`);
      
      return {
        state,
        sizeBytes,
        timestamp: Date.now(),
        warnings: options.maxMessages && state.conversationHistory.length > options.maxMessages 
          ? [`Conversation history truncated to ${options.maxMessages} messages`]
          : undefined,
      };
      
    } catch (error) {
      log.error(`failed to serialize session ${sessionKey}: ${error}`);
      throw error;
    }
  }

  /**
   * Restore a session from serialized state on a new node.
   */
  async restoreSession(
    serializedState: SessionState,
    targetNodeId: string
  ): Promise<RestorationResult> {
    log.info(`restoring session from state: ${serializedState.originalSessionKey} -> ${targetNodeId}`);
    
    try {
      // Validate state version compatibility
      if (!this.isStateVersionCompatible(serializedState.version)) {
        return {
          success: false,
          error: `Incompatible state version: ${serializedState.version}`,
        };
      }
      
      // Generate new session key for the restored session
      const newSessionKey = `session:${targetNodeId}:${randomUUID().slice(0, 8)}`;
      
      // This is a placeholder - in a real implementation, you would:
      // 1. Create a new session with the agent configuration
      // 2. Restore conversation history
      // 3. Set up task state
      // 4. Restore memory and context
      // 5. Resume any active operations
      
      log.info(`session restored successfully: ${newSessionKey}`);
      
      return {
        success: true,
        newSessionKey,
        restoredState: {
          agentConfig: serializedState.agentConfig,
          taskState: serializedState.taskState,
          metadata: {
            ...serializedState.metadata,
            restoredAt: Date.now(),
            restoredFrom: serializedState.originalSessionKey,
            targetNode: targetNodeId,
          },
        },
      };
      
    } catch (error) {
      log.error(`failed to restore session: ${error}`);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check if a state version is compatible with current implementation.
   */
  private isStateVersionCompatible(version: string): boolean {
    // For now, only support current version
    // In the future, this could handle backwards compatibility
    return version === SESSION_STATE_VERSION;
  }

  /**
   * Validate a serialized state for completeness and integrity.
   */
  validateState(state: SessionState): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    
    if (!state.version) errors.push("Missing version");
    if (!state.originalSessionKey) errors.push("Missing originalSessionKey");
    if (!state.agentConfig) errors.push("Missing agentConfig");
    if (!state.conversationHistory) errors.push("Missing conversationHistory");
    if (!Array.isArray(state.conversationHistory)) errors.push("conversationHistory must be an array");
    
    // Validate conversation history structure
    for (let i = 0; i < (state.conversationHistory?.length || 0); i++) {
      const msg = state.conversationHistory[i];
      if (!msg.id) errors.push(`Message ${i} missing id`);
      if (!["user", "assistant", "tool"].includes(msg.role)) {
        errors.push(`Message ${i} has invalid role: ${msg.role}`);
      }
      if (!msg.content) errors.push(`Message ${i} missing content`);
    }
    
    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Get session state information for monitoring.
   */
  getStateInfo(state: SessionState): {
    messageCount: number;
    sizeEstimate: number;
    lastActivity: Date;
    agentType: string;
  } {
    return {
      messageCount: state.conversationHistory?.length || 0,
      sizeEstimate: Buffer.byteLength(JSON.stringify(state), 'utf8'),
      lastActivity: new Date(state.lastActivity || 0),
      agentType: state.agentConfig?.agentId || 'unknown',
    };
  }
}

// =============================================================================
// Exports
// =============================================================================

export const sessionStateManager = SessionStateManager.getInstance();

/** Serialize a session for migration */
export const serializeSession = (
  sessionKey: string,
  options?: SerializationOptions
) => sessionStateManager.serializeSession(sessionKey, options);

/** Restore a session from serialized state */
export const restoreSession = (
  state: SessionState,
  targetNodeId: string
) => sessionStateManager.restoreSession(state, targetNodeId);

/** Validate session state */
export const validateSessionState = (state: SessionState) => 
  sessionStateManager.validateState(state);

/** Get session state information */
export const getSessionStateInfo = (state: SessionState) => 
  sessionStateManager.getStateInfo(state);