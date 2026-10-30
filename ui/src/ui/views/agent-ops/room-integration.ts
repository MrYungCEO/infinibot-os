/**
 * Room Integration — Connects Room Customization UI with Activity Map
 * 
 * This module provides:
 * - Loading/applying room configs to activity map agent rooms
 * - Agent-to-workspace assignment management
 * - Real-time room configuration sync
 */

import type { ActivityMap, MeshAgent, MeshNode } from './activity-map';
import type { RoomConfiguration, FurnitureItem, AgentAssignment } from './room-customization';

// ════════════════════════════════════════════════════════════════
// STORAGE
// ════════════════════════════════════════════════════════════════

const STORAGE_KEY_AGENT_ROOMS = 'infinibot-agent-room-assignments';
const STORAGE_KEY_NODE_ROOMS = 'infinibot-node-room-configs';

export interface AgentRoomAssignment {
  agentId: string;
  sessionKey: string;
  roomConfigId: string;
  workspaceIndex: number;  // Which desk/workspace in the room
}

export interface NodeRoomConfig {
  nodeId: string;
  roomConfigId: string;
  agentAssignments: AgentRoomAssignment[];
}

// ════════════════════════════════════════════════════════════════
// ROOM CONFIGURATION MANAGER
// ════════════════════════════════════════════════════════════════

export class RoomConfigurationManager {
  private nodeRoomConfigs: Map<string, NodeRoomConfig> = new Map();
  private roomConfigurations: Map<string, RoomConfiguration> = new Map();
  private activityMap: ActivityMap | null = null;
  private onChangeCallbacks: Set<(nodeId: string, config: NodeRoomConfig) => void> = new Set();

  constructor() {
    this.loadFromStorage();
  }

  /**
   * Connect to an activity map instance for real-time updates
   */
  setActivityMap(map: ActivityMap) {
    this.activityMap = map;
    // Apply any existing configurations
    this.applyAllConfigurations();
  }

  /**
   * Load configurations from localStorage
   */
  private loadFromStorage() {
    try {
      // Load node room configs
      const nodeConfigsJson = localStorage.getItem(STORAGE_KEY_NODE_ROOMS);
      if (nodeConfigsJson) {
        const configs = JSON.parse(nodeConfigsJson) as NodeRoomConfig[];
        configs.forEach(c => this.nodeRoomConfigs.set(c.nodeId, c));
      }

      // Load room configurations
      const roomConfigsJson = localStorage.getItem('infinibot-room-configurations');
      if (roomConfigsJson) {
        const configs = JSON.parse(roomConfigsJson) as RoomConfiguration[];
        configs.forEach(c => this.roomConfigurations.set(c.id, c));
      }
    } catch (err) {
      console.warn('[RoomIntegration] Failed to load from storage:', err);
    }
  }

  /**
   * Save configurations to localStorage
   */
  private saveToStorage() {
    try {
      const nodeConfigs = Array.from(this.nodeRoomConfigs.values());
      localStorage.setItem(STORAGE_KEY_NODE_ROOMS, JSON.stringify(nodeConfigs));
    } catch (err) {
      console.warn('[RoomIntegration] Failed to save to storage:', err);
    }
  }

  /**
   * Assign a room configuration to a node
   */
  setNodeRoomConfig(nodeId: string, roomConfigId: string) {
    const config: NodeRoomConfig = {
      nodeId,
      roomConfigId,
      agentAssignments: this.nodeRoomConfigs.get(nodeId)?.agentAssignments || [],
    };
    this.nodeRoomConfigs.set(nodeId, config);
    this.saveToStorage();
    this.notifyChange(nodeId, config);
    
    // Apply to activity map if connected
    if (this.activityMap) {
      this.applyNodeConfiguration(nodeId);
    }
  }

  /**
   * Assign an agent to a workspace within a node's room
   */
  assignAgentToWorkspace(
    nodeId: string,
    agentSessionKey: string,
    agentId: string,
    workspaceIndex: number
  ) {
    const config = this.nodeRoomConfigs.get(nodeId);
    if (!config) return;

    // Remove existing assignment for this agent
    config.agentAssignments = config.agentAssignments.filter(
      a => a.sessionKey !== agentSessionKey
    );

    // Add new assignment
    config.agentAssignments.push({
      agentId,
      sessionKey: agentSessionKey,
      roomConfigId: config.roomConfigId,
      workspaceIndex,
    });

    this.saveToStorage();
    this.notifyChange(nodeId, config);
  }

  /**
   * Remove an agent's workspace assignment
   */
  unassignAgent(nodeId: string, agentSessionKey: string) {
    const config = this.nodeRoomConfigs.get(nodeId);
    if (!config) return;

    config.agentAssignments = config.agentAssignments.filter(
      a => a.sessionKey !== agentSessionKey
    );

    this.saveToStorage();
    this.notifyChange(nodeId, config);
  }

  /**
   * Get the room configuration for a node
   */
  getNodeRoomConfig(nodeId: string): NodeRoomConfig | undefined {
    return this.nodeRoomConfigs.get(nodeId);
  }

  /**
   * Get room configuration by ID
   */
  getRoomConfiguration(configId: string): RoomConfiguration | undefined {
    return this.roomConfigurations.get(configId);
  }

  /**
   * Update a room configuration (from the customization UI)
   */
  updateRoomConfiguration(config: RoomConfiguration) {
    this.roomConfigurations.set(config.id, config);
    
    // Re-apply to any nodes using this config
    this.nodeRoomConfigs.forEach((nodeConfig, nodeId) => {
      if (nodeConfig.roomConfigId === config.id) {
        this.applyNodeConfiguration(nodeId);
      }
    });
  }

  /**
   * Apply all configurations to the activity map
   */
  private applyAllConfigurations() {
    this.nodeRoomConfigs.forEach((_, nodeId) => {
      this.applyNodeConfiguration(nodeId);
    });
  }

  /**
   * Apply a node's room configuration to the activity map
   */
  private applyNodeConfiguration(nodeId: string) {
    // This would integrate with ActivityMap's rendering
    // The actual rendering is handled by the PixiJS-based activity-map.ts
    // Here we can trigger updates or emit events
    console.log(`[RoomIntegration] Applying room config to node: ${nodeId}`);
  }

  /**
   * Subscribe to configuration changes
   */
  onChange(callback: (nodeId: string, config: NodeRoomConfig) => void) {
    this.onChangeCallbacks.add(callback);
    return () => this.onChangeCallbacks.delete(callback);
  }

  /**
   * Notify subscribers of changes
   */
  private notifyChange(nodeId: string, config: NodeRoomConfig) {
    this.onChangeCallbacks.forEach(cb => cb(nodeId, config));
  }

  /**
   * Get workspace positions from a room configuration
   * Returns positions where agents can be placed (desks)
   */
  getWorkspacePositions(configId: string): { x: number; y: number; index: number }[] {
    const config = this.roomConfigurations.get(configId);
    if (!config) return [];

    return config.furniture
      .filter(item => item.type === 'desk')
      .map((item, index) => ({
        x: item.x,
        y: item.y,
        index,
      }));
  }

  /**
   * Get the position for an agent based on their assignment
   */
  getAgentPosition(
    nodeId: string,
    agentSessionKey: string
  ): { x: number; y: number } | null {
    const nodeConfig = this.nodeRoomConfigs.get(nodeId);
    if (!nodeConfig) return null;

    const assignment = nodeConfig.agentAssignments.find(
      a => a.sessionKey === agentSessionKey
    );
    if (!assignment) return null;

    const workspaces = this.getWorkspacePositions(nodeConfig.roomConfigId);
    return workspaces[assignment.workspaceIndex] || null;
  }
}

// ════════════════════════════════════════════════════════════════
// SINGLETON INSTANCE
// ════════════════════════════════════════════════════════════════

let _roomConfigManager: RoomConfigurationManager | null = null;

export function getRoomConfigManager(): RoomConfigurationManager {
  if (!_roomConfigManager) {
    _roomConfigManager = new RoomConfigurationManager();
  }
  return _roomConfigManager;
}

// ════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ════════════════════════════════════════════════════════════════

/**
 * Get furniture items that can be used as workspaces (desks, tables)
 */
export function getWorkspaceFurniture(config: RoomConfiguration): FurnitureItem[] {
  return config.furniture.filter(
    item => item.type === 'desk' || item.type === 'littleTable'
  );
}

/**
 * Get rest furniture items (sofas, chairs for idle state)
 */
export function getRestFurniture(config: RoomConfiguration): FurnitureItem[] {
  return config.furniture.filter(
    item => item.type === 'sofa' || item.type === 'chair'
  );
}

/**
 * Calculate agent position based on status and room config
 */
export function calculateAgentPosition(
  config: RoomConfiguration,
  agentStatus: string,
  workspaceIndex: number = 0
): { x: number; y: number } {
  const workspaces = getWorkspaceFurniture(config);
  const restSpots = getRestFurniture(config);

  if (agentStatus === 'working' || agentStatus === 'starting' || agentStatus === 'finishing') {
    // At workspace (desk)
    const workspace = workspaces[workspaceIndex % workspaces.length];
    if (workspace) {
      return { x: workspace.x, y: workspace.y + 10 };
    }
  } else if (agentStatus === 'idle' || agentStatus === 'completed') {
    // On sofa/chair
    const rest = restSpots[0];
    if (rest) {
      return { x: rest.x, y: rest.y - 5 };
    }
  }

  // Default: standing in center
  return { x: 0, y: 35 };
}

/**
 * Export room configuration as JSON
 */
export function exportRoomConfiguration(config: RoomConfiguration): string {
  return JSON.stringify(config, null, 2);
}

/**
 * Import room configuration from JSON
 */
export function importRoomConfiguration(json: string): RoomConfiguration | null {
  try {
    const config = JSON.parse(json) as RoomConfiguration;
    // Validate required fields
    if (!config.id || !config.name || !Array.isArray(config.furniture)) {
      return null;
    }
    return config;
  } catch {
    return null;
  }
}
