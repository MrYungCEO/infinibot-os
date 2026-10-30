/**
 * Mesh Sidebar — Tabbed panel showing Agents, Nodes, MCPs, Tasks
 */

import { html, nothing } from 'lit';
import type { GatewayBrowserClient } from '../../gateway';
import type { AppViewState } from '../../app-view-state';
import {
  getMeshState,
  getFilteredAgents,
  getFilteredNodes,
  setActiveTab,
  setSelectedAgent,
  setSelectedNode,
  killAgent,
  type MeshAgent,
  type MeshNode,
  type MCPServer,
  type KanbanTask,
} from '../../controllers/agent-mesh';

// ════════════════════════════════════════════════════════════════
// THEME
// ════════════════════════════════════════════════════════════════

const HUD = {
  bg: '#050505',
  bgCard: '#0a0a0a',
  bgSurface: '#0f0f0f',
  bgHover: '#141414',
  gold: 'var(--g-primary)',
  goldDim: 'var(--g-primary)',
  goldSubtle: 'color-mix(in srgb, var(--g-primary) 8%, transparent)',
  goldBorder: 'color-mix(in srgb, var(--g-primary) 20%, transparent)',
  text: '#e4e4e7',
  textMuted: '#71717a',
  textDim: '#52525b',
  border: '#1a1a1a',
  success: '#22c55e',
  error: '#ef4444',
  warning: '#f59e0b',
  info: '#3b82f6',
  mono: "'JetBrains Mono','SF Mono','Consolas',monospace",
};

const STATUS_COLORS: Record<string, string> = {
  starting: HUD.info,
  idle: HUD.textMuted,
  working: HUD.gold,
  blocked: HUD.error,
  finishing: HUD.warning,
  completed: HUD.success,
  failed: HUD.error,
};

const AGENT_EMOJIS: Record<string, string> = {
  main: '🔥',
  coder: '⚡',
  opus: '🎭',
  tester: '🧪',
  architect: '🏗️',
  backend: '💻',
  reviewer: '👁️',
  doc: '📝',
  default: '🤖',
};

// ════════════════════════════════════════════════════════════════
// MAIN RENDER
// ════════════════════════════════════════════════════════════════

export function renderMeshSidebar(
  state: AppViewState,
  client: GatewayBrowserClient
) {
  const meshState = getMeshState();

  return html`
    <div style="
      display: flex;
      flex-direction: column;
      height: 100%;
      font-family: ${HUD.mono};
    ">
      <!-- Tab Bar -->
      <div style="
        display: flex;
        border-bottom: 1px solid ${HUD.border};
        padding: 0 8px;
      ">
        ${renderTab('agents', 'Agents', `${meshState.stats.activeAgents}/${meshState.stats.totalAgents}`, meshState, state)}
        ${renderTab('nodes', 'Nodes', `${meshState.stats.onlineNodes}/${meshState.stats.totalNodes}`, meshState, state)}
        ${renderTab('mcps', 'MCPs', `${meshState.mcpServers.length}`, meshState, state)}
        ${renderTab('tasks', 'Tasks', `${meshState.tasks.length}`, meshState, state)}
      </div>

      <!-- Content -->
      <div style="
        flex: 1;
        overflow-y: auto;
        padding: 12px;
      ">
        ${meshState.activeTab === 'agents' ? renderAgentsList(state, client) : nothing}
        ${meshState.activeTab === 'nodes' ? renderNodesList(state, client) : nothing}
        ${meshState.activeTab === 'mcps' ? renderMCPsList(state) : nothing}
        ${meshState.activeTab === 'tasks' ? renderTasksList(state) : nothing}
      </div>
    </div>
  `;
}

function renderTab(
  id: 'agents' | 'nodes' | 'mcps' | 'tasks',
  label: string,
  badge: string,
  meshState: ReturnType<typeof getMeshState>,
  state: AppViewState
) {
  const isActive = meshState.activeTab === id;

  return html`
    <button
      style="
        background: transparent;
        border: none;
        border-bottom: 2px solid ${isActive ? HUD.gold : 'transparent'};
        padding: 10px 12px;
        color: ${isActive ? HUD.gold : HUD.textMuted};
        font-family: ${HUD.mono};
        font-size: 11px;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 6px;
        transition: all 0.2s;
      "
      @click=${() => setActiveTab(id, state)}
    >
      ${label}
      <span style="
        background: ${isActive ? HUD.goldSubtle : HUD.bgSurface};
        border: 1px solid ${isActive ? HUD.goldBorder : HUD.border};
        border-radius: 10px;
        padding: 2px 6px;
        font-size: 10px;
      ">${badge}</span>
    </button>
  `;
}

// ════════════════════════════════════════════════════════════════
// AGENTS LIST
// ════════════════════════════════════════════════════════════════

function renderAgentsList(state: AppViewState, client: GatewayBrowserClient) {
  const agents = getFilteredAgents();
  const meshState = getMeshState();

  if (agents.length === 0) {
    return html`
      <div style="
        text-align: center;
        padding: 40px 20px;
        color: ${HUD.textMuted};
      ">
        <div style="font-size: 32px; margin-bottom: 12px;">🤖</div>
        <div style="font-size: 12px;">No agents running</div>
        <div style="font-size: 11px; margin-top: 4px; color: ${HUD.textDim};">
          Click "Spawn Agent" to create one
        </div>
      </div>
    `;
  }

  return html`
    <div style="display: flex; flex-direction: column; gap: 8px;">
      ${agents.map(agent => renderAgentCard(agent, meshState, state, client))}
    </div>
  `;
}

function renderAgentCard(
  agent: MeshAgent,
  meshState: ReturnType<typeof getMeshState>,
  state: AppViewState,
  client: GatewayBrowserClient
) {
  const isSelected = meshState.selectedAgentKey === agent.sessionKey;
  const statusColor = STATUS_COLORS[agent.status] || HUD.textMuted;
  // Orchestrators get a control-deck glyph; everything else falls back to the
  // agent-id avatar map. This makes UI-spawned Claude terminals and MCP-
  // connected 3rd-party AIs (Claude Desktop, Codex CLI, Cursor, …) immediately
  // distinguishable in the sidebar from the worker sub-agents they spawn.
  const emoji =
    agent.role === 'orchestrator'
      ? '🎛'
      : (AGENT_EMOJIS[agent.agentId] || AGENT_EMOJIS.default);
  // Short surface tag rendered next to the status line so the operator can
  // tell "Claude Desktop orchestrator on local" from "Cursor orchestrator on
  // sat-1" without opening the row.
  const surfaceTag =
    agent.role === 'orchestrator'
      ? (agent.originSurface || agent.coderBackend || agent.channel || 'mcp').toUpperCase()
      : null;

  return html`
    <div
      style="
        background: ${isSelected ? HUD.goldSubtle : HUD.bgSurface};
        border: 1px solid ${isSelected ? HUD.goldBorder : HUD.border};
        border-radius: 8px;
        padding: 12px;
        cursor: pointer;
        transition: all 0.15s;
      "
      @click=${() => setSelectedAgent(agent.sessionKey, state)}
    >
      <!-- Header -->
      <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px;">
        <!-- Avatar -->
        <span style="font-size: 20px;">${emoji}</span>
        
        <!-- Info -->
        <div style="flex: 1; min-width: 0;">
          <div style="
            font-size: 12px;
            font-weight: 500;
            color: ${HUD.text};
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            display: flex;
            align-items: center;
            gap: 6px;
          ">
            <span style="
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: nowrap;
              min-width: 0;
            ">${agent.label}</span>
            ${agent.role === 'orchestrator' ? html`
              <span style="
                flex: none;
                font-size: 8.5px;
                font-weight: 700;
                letter-spacing: 0.1em;
                padding: 2px 5px;
                border-radius: 3px;
                color: var(--g-primary, ${HUD.gold});
                background: color-mix(in srgb, var(--g-primary, ${HUD.gold}) 12%, transparent);
                border: 1px solid color-mix(in srgb, var(--g-primary, ${HUD.gold}) 38%, transparent);
                text-transform: uppercase;
              " title="MCP / UI orchestrator session — delegates to InfiniBot sub-agents">ORCH</span>
            ` : nothing}
          </div>
          <div style="
            font-size: 10px;
            color: ${HUD.textMuted};
            display: flex;
            align-items: center;
            gap: 6px;
          ">
            <span style="
              width: 6px;
              height: 6px;
              border-radius: 50%;
              background: ${statusColor};
            "></span>
            ${agent.status}
            <span style="color: ${HUD.textDim};">•</span>
            ${agent.nodeName}
            ${surfaceTag ? html`
              <span style="color: ${HUD.textDim};">•</span>
              <span style="
                font-family: ${HUD.mono};
                font-size: 9px;
                letter-spacing: 0.06em;
                color: ${HUD.textMuted};
              ">${surfaceTag}</span>
            ` : nothing}
          </div>
        </div>

        <!-- Progress Ring (if working) -->
        ${agent.status === 'working' && agent.progress > 0 ? html`
          <div style="
            width: 28px;
            height: 28px;
            position: relative;
          ">
            <svg viewBox="0 0 36 36" style="transform: rotate(-90deg);">
              <path
                d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                fill="none"
                stroke="${HUD.border}"
                stroke-width="3"
              />
              <path
                d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                fill="none"
                stroke="${HUD.gold}"
                stroke-width="3"
                stroke-dasharray="${agent.progress}, 100"
              />
            </svg>
            <span style="
              position: absolute;
              top: 50%;
              left: 50%;
              transform: translate(-50%, -50%);
              font-size: 8px;
              color: ${HUD.gold};
            ">${agent.progress}%</span>
          </div>
        ` : nothing}
      </div>

      <!-- Task Preview -->
      ${agent.currentTask ? html`
        <div style="
          font-size: 11px;
          color: ${HUD.textMuted};
          background: ${HUD.bgCard};
          border-radius: 4px;
          padding: 8px;
          margin-bottom: 8px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        ">${agent.currentTask}</div>
      ` : nothing}

      <!-- Actions (when selected) -->
      ${isSelected ? html`
        <div style="
          display: flex;
          gap: 6px;
          margin-top: 8px;
          padding-top: 8px;
          border-top: 1px solid ${HUD.border};
        ">
          <button
            style="
              flex: 1;
              background: ${HUD.bgCard};
              border: 1px solid ${HUD.border};
              border-radius: 4px;
              padding: 6px;
              color: ${HUD.textMuted};
              font-size: 10px;
              cursor: pointer;
              font-family: ${HUD.mono};
            "
            @click=${(e: Event) => {
              e.stopPropagation();
              // TODO: View transcript
            }}
          >📜 Transcript</button>
          
          ${agent.status === 'working' ? html`
            <button
              style="
                flex: 1;
                background: rgba(239,68,68,0.1);
                border: 1px solid rgba(239,68,68,0.3);
                border-radius: 4px;
                padding: 6px;
                color: ${HUD.error};
                font-size: 10px;
                cursor: pointer;
                font-family: ${HUD.mono};
              "
              @click=${async (e: Event) => {
                e.stopPropagation();
                await killAgent(client, agent.sessionKey, state);
              }}
            >⏹ Kill</button>
          ` : nothing}
        </div>
      ` : nothing}
    </div>
  `;
}

// ════════════════════════════════════════════════════════════════
// NODES LIST
// ════════════════════════════════════════════════════════════════

function renderNodesList(state: AppViewState, client: GatewayBrowserClient) {
  const nodes = getFilteredNodes();
  const meshState = getMeshState();

  if (nodes.length === 0) {
    return html`
      <div style="
        text-align: center;
        padding: 40px 20px;
        color: ${HUD.textMuted};
      ">
        <div style="font-size: 32px; margin-bottom: 12px;">🌐</div>
        <div style="font-size: 12px;">No nodes found</div>
      </div>
    `;
  }

  return html`
    <div style="display: flex; flex-direction: column; gap: 8px;">
      ${nodes.map(node => renderNodeCard(node, meshState, state))}
    </div>
  `;
}

function renderNodeCard(
  node: MeshNode,
  meshState: ReturnType<typeof getMeshState>,
  state: AppViewState
) {
  const isSelected = meshState.selectedNodeId === node.id;
  const statusColor = node.status === 'online' ? HUD.success : 
                      node.status === 'connecting' ? HUD.warning : 
                      HUD.error;

  const roleEmoji = node.role === 'hub' ? '🏠' : 
                    node.role === 'satellite' ? '🛰️' : 
                    '💻';

  return html`
    <div
      style="
        background: ${isSelected ? HUD.goldSubtle : HUD.bgSurface};
        border: 1px solid ${isSelected ? HUD.goldBorder : HUD.border};
        border-radius: 8px;
        padding: 12px;
        cursor: pointer;
        transition: all 0.15s;
      "
      @click=${() => setSelectedNode(node.id, state)}
    >
      <div style="display: flex; align-items: center; gap: 10px;">
        <!-- Icon -->
        <span style="font-size: 20px;">${roleEmoji}</span>
        
        <!-- Info -->
        <div style="flex: 1; min-width: 0;">
          <div style="
            font-size: 12px;
            font-weight: 500;
            color: ${HUD.text};
          ">${node.name}</div>
          <div style="
            font-size: 10px;
            color: ${HUD.textMuted};
            display: flex;
            align-items: center;
            gap: 6px;
          ">
            <span style="
              width: 6px;
              height: 6px;
              border-radius: 50%;
              background: ${statusColor};
            "></span>
            ${node.status}
            <span style="color: ${HUD.textDim};">•</span>
            ${node.role}
          </div>
        </div>

        <!-- Agent Count Badge -->
        <div style="
          background: ${HUD.bgCard};
          border: 1px solid ${HUD.border};
          border-radius: 12px;
          padding: 4px 10px;
          font-size: 11px;
          color: ${HUD.textMuted};
        ">
          ${node.agentCount} 🤖
        </div>
      </div>
    </div>
  `;
}

// ════════════════════════════════════════════════════════════════
// MCPs LIST
// ════════════════════════════════════════════════════════════════

function renderMCPsList(state: AppViewState) {
  const meshState = getMeshState();
  const servers = meshState.mcpServers;

  if (servers.length === 0) {
    return html`
      <div style="
        text-align: center;
        padding: 40px 20px;
        color: ${HUD.textMuted};
      ">
        <div style="font-size: 32px; margin-bottom: 12px;">⚡</div>
        <div style="font-size: 12px;">No MCP servers</div>
      </div>
    `;
  }

  return html`
    <div style="display: flex; flex-direction: column; gap: 8px;">
      ${servers.map(server => renderMCPCard(server))}
    </div>
  `;
}

function renderMCPCard(server: MCPServer) {
  const statusColor = server.status === 'running' ? HUD.success : 
                      server.status === 'error' ? HUD.error : 
                      HUD.textMuted;

  return html`
    <div style="
      background: ${HUD.bgSurface};
      border: 1px solid ${HUD.border};
      border-radius: 8px;
      padding: 12px;
    ">
      <div style="display: flex; align-items: center; gap: 10px;">
        <span style="font-size: 20px;">⚡</span>
        
        <div style="flex: 1; min-width: 0;">
          <div style="
            font-size: 12px;
            font-weight: 500;
            color: ${HUD.text};
          ">${server.name}</div>
          <div style="
            font-size: 10px;
            color: ${HUD.textMuted};
            display: flex;
            align-items: center;
            gap: 6px;
          ">
            <span style="
              width: 6px;
              height: 6px;
              border-radius: 50%;
              background: ${statusColor};
            "></span>
            ${server.status}
            <span style="color: ${HUD.textDim};">•</span>
            ${server.toolCount} tools
          </div>
        </div>
      </div>
    </div>
  `;
}

// ════════════════════════════════════════════════════════════════
// TASKS LIST
// ════════════════════════════════════════════════════════════════

function renderTasksList(state: AppViewState) {
  const meshState = getMeshState();
  const tasks = meshState.tasks;

  if (tasks.length === 0) {
    return html`
      <div style="
        text-align: center;
        padding: 40px 20px;
        color: ${HUD.textMuted};
      ">
        <div style="font-size: 32px; margin-bottom: 12px;">📋</div>
        <div style="font-size: 12px;">No active tasks</div>
      </div>
    `;
  }

  return html`
    <div style="display: flex; flex-direction: column; gap: 8px;">
      ${tasks.map(task => renderTaskCard(task))}
    </div>
  `;
}

function renderTaskCard(task: KanbanTask) {
  const priorityColor = task.priority === 'critical' ? HUD.error :
                        task.priority === 'high' ? HUD.warning :
                        task.priority === 'medium' ? HUD.gold :
                        HUD.textMuted;

  return html`
    <div style="
      background: ${HUD.bgSurface};
      border: 1px solid ${HUD.border};
      border-radius: 8px;
      padding: 12px;
    ">
      <div style="
        font-size: 12px;
        font-weight: 500;
        color: ${HUD.text};
        margin-bottom: 6px;
      ">${task.title}</div>
      
      <div style="
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 10px;
      ">
        <span style="
          background: ${priorityColor}20;
          border: 1px solid ${priorityColor}40;
          color: ${priorityColor};
          padding: 2px 6px;
          border-radius: 4px;
          text-transform: uppercase;
        ">${task.priority}</span>
        
        <span style="color: ${HUD.textMuted};">${task.status}</span>
        
        ${task.assignee ? html`
          <span style="color: ${HUD.textDim};">•</span>
          <span style="color: ${HUD.textMuted};">👤 ${task.assignee}</span>
        ` : nothing}
      </div>
    </div>
  `;
}
