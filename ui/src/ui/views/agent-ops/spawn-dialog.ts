/**
 * Spawn Dialog — Modal to spawn new agents
 * Select agent type, target node, and task description
 */

import { html, nothing } from 'lit';
import type { GatewayBrowserClient } from '../../gateway';
import type { AppViewState } from '../../app-view-state';
import {
  getMeshState,
  toggleSpawnDialog,
  spawnAgent,
  getFilteredNodes,
} from '../../controllers/agent-mesh';
import { nodeStatusGlyph, nodeStatusColor } from '../../components/node-status-style.js';

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
  border: '#1a1a1a',
  error: '#ef4444',
  success: '#22c55e',
  mono: "'JetBrains Mono','SF Mono','Consolas',monospace",
};

// ════════════════════════════════════════════════════════════════
// AGENT TYPES
// ════════════════════════════════════════════════════════════════

const AGENT_TYPES = [
  { id: 'coder', name: 'Code Architect', emoji: '⚡', description: 'Full-stack development, code review, refactoring' },
  { id: 'opus', name: 'Deep Thinker', emoji: '🎭', description: 'Complex analysis, research, strategic planning' },
  { id: 'tester', name: 'QA Tester', emoji: '🧪', description: 'Testing, bug hunting, quality assurance' },
  { id: 'architect', name: 'System Architect', emoji: '🏗️', description: 'System design, architecture decisions' },
  { id: 'backend', name: 'Backend Dev', emoji: '💻', description: 'API development, database, server-side logic' },
  { id: 'reviewer', name: 'Code Reviewer', emoji: '👁️', description: 'Pull request review, code quality analysis' },
  { id: 'doc', name: 'Documentation', emoji: '📝', description: 'Technical writing, docs, READMEs' },
];

// ════════════════════════════════════════════════════════════════
// LOCAL STATE
// ════════════════════════════════════════════════════════════════

let selectedAgentType = 'coder';
// Sentinel so we can tell "operator hasn't picked yet" from "operator
// explicitly picked local". When this stays null, every render reads the
// global `currentNodeId` from federationState so the spawn dialog opens
// pre-selected to whatever device the operator picked elsewhere (chat,
// terminals). Once the operator changes the dropdown, we lock the
// selection so global navigation doesn't yank it out from under them.
let selectedNodeId: string | null = null;
let taskDescription = '';
let customLabel = '';
let spawning = false;
let spawnError: string | null = null;

/** Resolve the current spawn target — explicit picker selection wins, then
 *  the global currentNodeId from federation state, then "local" as a
 *  final fallback. */
function resolveSpawnTarget(state: AppViewState): string {
  if (selectedNodeId !== null) return selectedNodeId;
  const fed = state.federationState;
  if (fed?.currentNodeId) return fed.currentNodeId;
  return 'local';
}

// ════════════════════════════════════════════════════════════════
// RENDER
// ════════════════════════════════════════════════════════════════

export function renderSpawnDialog(
  state: AppViewState,
  client: GatewayBrowserClient
) {
  const meshState = getMeshState();
  if (!meshState.showSpawnDialog) return nothing;

  const nodes = getFilteredNodes();

  return html`
    <div 
      style="
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0,0,0,0.85);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
        backdrop-filter: blur(4px);
      "
      @click=${(e: Event) => {
        if (e.target === e.currentTarget) {
          toggleSpawnDialog(state);
        }
      }}
    >
      <div style="
        background: ${HUD.bgCard};
        border: 1px solid ${HUD.goldBorder};
        border-radius: 16px;
        width: 500px;
        max-width: 90vw;
        max-height: 85vh;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        box-shadow: 0 20px 60px rgba(0,0,0,0.5);
      ">
        <!-- Header -->
        <div style="
          padding: 20px 24px;
          border-bottom: 1px solid ${HUD.border};
          display: flex;
          align-items: center;
          justify-content: space-between;
        ">
          <div style="display: flex; align-items: center; gap: 12px;">
            <span style="font-size: 24px;">🚀</span>
            <div>
              <h2 style="
                margin: 0;
                font-size: 18px;
                font-weight: 600;
                color: ${HUD.gold};
                font-family: ${HUD.mono};
              ">Spawn Agent</h2>
              <p style="
                margin: 4px 0 0;
                font-size: 12px;
                color: ${HUD.textMuted};
                font-family: ${HUD.mono};
              ">Create a specialized sub-agent for a task</p>
            </div>
          </div>
          <button
            style="
              background: transparent;
              border: none;
              color: ${HUD.textMuted};
              font-size: 20px;
              cursor: pointer;
              padding: 4px 8px;
            "
            @click=${() => toggleSpawnDialog(state)}
          >✕</button>
        </div>

        <!-- Body -->
        <div style="
          padding: 24px;
          overflow-y: auto;
          flex: 1;
        ">
          <!-- Agent Type Selection -->
          <div style="margin-bottom: 24px;">
            <label style="
              display: block;
              font-size: 12px;
              color: ${HUD.textMuted};
              margin-bottom: 10px;
              text-transform: uppercase;
              letter-spacing: 0.5px;
              font-family: ${HUD.mono};
            ">Agent Type</label>
            <div style="
              display: grid;
              grid-template-columns: repeat(2, 1fr);
              gap: 8px;
            ">
              ${AGENT_TYPES.map(agent => html`
                <button
                  style="
                    background: ${selectedAgentType === agent.id ? HUD.goldSubtle : 'transparent'};
                    border: 1px solid ${selectedAgentType === agent.id ? HUD.goldBorder : HUD.border};
                    border-radius: 8px;
                    padding: 12px;
                    cursor: pointer;
                    text-align: left;
                    transition: all 0.2s;
                  "
                  @click=${() => {
                    selectedAgentType = agent.id;
                    state.requestUpdate?.();
                  }}
                >
                  <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="font-size: 18px;">${agent.emoji}</span>
                    <span style="
                      font-size: 13px;
                      font-weight: 500;
                      color: ${selectedAgentType === agent.id ? HUD.gold : HUD.text};
                      font-family: ${HUD.mono};
                    ">${agent.name}</span>
                  </div>
                  <p style="
                    margin: 6px 0 0 26px;
                    font-size: 10px;
                    color: ${HUD.textMuted};
                    font-family: ${HUD.mono};
                  ">${agent.description}</p>
                </button>
              `)}
            </div>
          </div>

          <!-- Target Node -->
          <div style="margin-bottom: 24px;">
            <label style="
              display: block;
              font-size: 12px;
              color: ${HUD.textMuted};
              margin-bottom: 10px;
              text-transform: uppercase;
              letter-spacing: 0.5px;
              font-family: ${HUD.mono};
            ">Target Node</label>
            <select
              style="
                width: 100%;
                background: ${HUD.bgSurface};
                border: 1px solid ${HUD.border};
                border-radius: 8px;
                padding: 12px 14px;
                color: ${HUD.text};
                font-family: ${HUD.mono};
                font-size: 13px;
                cursor: pointer;
              "
              @change=${(e: Event) => {
                selectedNodeId = (e.target as HTMLSelectElement).value;
                state.requestUpdate?.();
              }}
            >
              ${nodes.map(node => html`
                <option
                  value=${node.id}
                  ?selected=${resolveSpawnTarget(state) === node.id}
                  style="color: ${nodeStatusColor({ online: node.status === 'online', isLocal: node.id === 'local' })}"
                >
                  ${nodeStatusGlyph({ online: node.status === 'online', isLocal: node.id === 'local' })} ${node.name} (${node.role})
                </option>
              `)}
            </select>
          </div>

          <!-- Task Description -->
          <div style="margin-bottom: 24px;">
            <label style="
              display: block;
              font-size: 12px;
              color: ${HUD.textMuted};
              margin-bottom: 10px;
              text-transform: uppercase;
              letter-spacing: 0.5px;
              font-family: ${HUD.mono};
            ">Task Description *</label>
            <textarea
              placeholder="Describe the task for this agent..."
              style="
                width: 100%;
                background: ${HUD.bgSurface};
                border: 1px solid ${HUD.border};
                border-radius: 8px;
                padding: 12px 14px;
                color: ${HUD.text};
                font-family: ${HUD.mono};
                font-size: 13px;
                min-height: 100px;
                resize: vertical;
                outline: none;
              "
              .value=${taskDescription}
              @input=${(e: Event) => {
                taskDescription = (e.target as HTMLTextAreaElement).value;
              }}
            ></textarea>
          </div>

          <!-- Custom Label (Optional) -->
          <div style="margin-bottom: 24px;">
            <label style="
              display: block;
              font-size: 12px;
              color: ${HUD.textMuted};
              margin-bottom: 10px;
              text-transform: uppercase;
              letter-spacing: 0.5px;
              font-family: ${HUD.mono};
            ">Custom Label (optional)</label>
            <input
              type="text"
              placeholder="e.g., 'Fix Auth Bug' or 'API Refactor'"
              style="
                width: 100%;
                background: ${HUD.bgSurface};
                border: 1px solid ${HUD.border};
                border-radius: 8px;
                padding: 12px 14px;
                color: ${HUD.text};
                font-family: ${HUD.mono};
                font-size: 13px;
                outline: none;
              "
              .value=${customLabel}
              @input=${(e: Event) => {
                customLabel = (e.target as HTMLInputElement).value;
              }}
            />
          </div>

          <!-- Error Message -->
          ${spawnError ? html`
            <div style="
              background: rgba(239,68,68,0.1);
              border: 1px solid rgba(239,68,68,0.3);
              border-radius: 8px;
              padding: 12px;
              margin-bottom: 16px;
              color: ${HUD.error};
              font-size: 12px;
              font-family: ${HUD.mono};
            ">
              ⚠️ ${spawnError}
            </div>
          ` : nothing}
        </div>

        <!-- Footer -->
        <div style="
          padding: 16px 24px;
          border-top: 1px solid ${HUD.border};
          display: flex;
          justify-content: flex-end;
          gap: 12px;
        ">
          <button
            style="
              background: transparent;
              border: 1px solid ${HUD.border};
              color: ${HUD.textMuted};
              padding: 10px 20px;
              border-radius: 8px;
              cursor: pointer;
              font-family: ${HUD.mono};
              font-size: 13px;
            "
            @click=${() => toggleSpawnDialog(state)}
          >Cancel</button>
          <button
            style="
              background: ${HUD.goldSubtle};
              border: 1px solid ${HUD.goldBorder};
              color: ${HUD.gold};
              padding: 10px 24px;
              border-radius: 8px;
              cursor: pointer;
              font-family: ${HUD.mono};
              font-size: 13px;
              font-weight: 500;
              display: flex;
              align-items: center;
              gap: 8px;
              opacity: ${!taskDescription.trim() || spawning ? 0.5 : 1};
            "
            ?disabled=${!taskDescription.trim() || spawning}
            @click=${async () => {
              if (!taskDescription.trim()) return;
              
              spawning = true;
              spawnError = null;
              state.requestUpdate?.();

              const target = resolveSpawnTarget(state);
              const result = await spawnAgent(client, {
                agentId: selectedAgentType,
                task: taskDescription,
                label: customLabel || undefined,
                // "local" → omit node so the gateway uses the local runner.
                // Anything else (including the global currentNodeId) is
                // forwarded as the federation target.
                node: target !== 'local' ? target : undefined,
              }, state);

              spawning = false;

              if (result.success) {
                // Reset form and close. Clearing selectedNodeId here means
                // the next time the dialog opens it picks up the global
                // currentNodeId again — operator's "I want everything on
                // robo1" intent persists across spawns until they change
                // it elsewhere.
                taskDescription = '';
                customLabel = '';
                selectedNodeId = null;
                toggleSpawnDialog(state);
              } else {
                spawnError = result.error || 'Failed to spawn agent';
              }
              
              state.requestUpdate?.();
            }}
          >
            ${spawning ? html`
              <span style="
                display: inline-block;
                width: 14px;
                height: 14px;
                border: 2px solid ${HUD.gold};
                border-top-color: transparent;
                border-radius: 50%;
                animation: spin 1s linear infinite;
              "></span>
            ` : html`<span>🚀</span>`}
            ${spawning ? 'Spawning...' : 'Spawn Agent'}
          </button>
        </div>
      </div>
    </div>

    <style>
      @keyframes spin {
        to { transform: rotate(360deg); }
      }
    </style>
  `;
}
