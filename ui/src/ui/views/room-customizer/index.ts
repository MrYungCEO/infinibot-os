/**
 * Room Customizer - Main View
 * Full room customization UI for agent visualization system
 * 
 * Features:
 * - Element library with drag-and-drop
 * - Interactive room canvas editor
 * - Properties panel for element editing
 * - Room settings configuration
 * - Undo/redo, copy/paste
 * - Save/load room configurations
 * - Agent assignment
 */

import { html, nothing } from 'lit';
import { g8GlassStyles } from '../glass-g8.js';
import type { TemplateResult } from 'lit';
import type { GatewayBrowserClient } from '../../gateway';
import type { AppViewState } from '../../app-view-state';
import { icons } from '../../icons';

// Import components
import { renderElementLibrary, getLibraryStyles } from './element-library';
import { renderRoomCanvas, getCanvasStyles } from './room-canvas';
import { renderPropertiesPanel, getPropertiesStyles } from './properties-panel';
import { renderRoomSettings, getSettingsStyles } from './room-settings';

// Import controller
import {
  type RoomCustomizerState,
  initRoomCustomizer,
  cleanupRoomCustomizer,
  getRoomCustomizerState,
  createNewRoom,
  loadRoom,
  deleteRoom,
  duplicateRoom,
  toggleSettingsPanel,
  handleKeyDown,
} from '../../controllers/room-customizer';

// ════════════════════════════════════════════════════════════════
// THEME
// ════════════════════════════════════════════════════════════════

const THEME = {
  bg: '#050505',
  bgCard: '#0a0a0a',
  bgSurface: '#0f0f0f',
  gold: 'var(--g-primary)',
  goldDim: 'var(--g-primary)',
  goldBorder: 'color-mix(in srgb, var(--g-primary) 20%, transparent)',
  text: '#e4e4e7',
  textMuted: '#71717a',
  textDim: '#52525b',
  border: '#1a1a1a',
  mono: "'JetBrains Mono', monospace",
};

// ════════════════════════════════════════════════════════════════
// STYLES
// ════════════════════════════════════════════════════════════════

function getStyles(): string {
  return `
    .room-customizer {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: ${THEME.bg};
      color: ${THEME.text};
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    }
    
    .customizer-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 20px;
      background: ${THEME.bgCard};
      border-bottom: 1px solid ${THEME.border};
    }
    
    .customizer-title {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    
    .customizer-title h1 {
      font-size: 18px;
      font-weight: 600;
      color: ${THEME.text};
      margin: 0;
    }
    
    .customizer-title-icon {
      font-size: 24px;
    }
    
    .room-selector {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    
    .room-select {
      padding: 8px 12px;
      background: ${THEME.bgSurface};
      border: 1px solid ${THEME.border};
      border-radius: 6px;
      color: ${THEME.text};
      font-size: 13px;
      min-width: 180px;
      cursor: pointer;
    }
    
    .room-select:focus {
      outline: none;
      border-color: ${THEME.goldBorder};
    }
    
    .header-btn {
      padding: 8px 12px;
      background: ${THEME.bgSurface};
      border: 1px solid ${THEME.border};
      border-radius: 6px;
      color: ${THEME.textMuted};
      font-size: 12px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: all 0.15s;
    }
    
    .header-btn:hover {
      background: #1a1a1a;
      border-color: ${THEME.gold};
      color: ${THEME.gold};
    }
    
    .header-btn.primary {
      background: color-mix(in srgb, var(--g-primary) 10%, transparent);
      border-color: ${THEME.goldBorder};
      color: ${THEME.gold};
    }
    
    .header-btn.primary:hover {
      background: color-mix(in srgb, var(--g-primary) 20%, transparent);
    }
    
    .header-btn svg {
      width: 16px;
      height: 16px;
    }
    
    .customizer-body {
      flex: 1;
      display: flex;
      overflow: hidden;
    }
    
    .no-room-state {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 16px;
      color: ${THEME.textMuted};
    }
    
    .no-room-icon {
      font-size: 64px;
      opacity: 0.3;
    }
    
    .no-room-text {
      font-size: 18px;
      color: ${THEME.text};
    }
    
    .no-room-hint {
      font-size: 14px;
      color: ${THEME.textDim};
    }
    
    .room-cards {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 16px;
      max-width: 800px;
      margin-top: 24px;
    }
    
    .room-card {
      background: ${THEME.bgCard};
      border: 1px solid ${THEME.border};
      border-radius: 12px;
      padding: 20px;
      cursor: pointer;
      transition: all 0.15s;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    
    .room-card:hover {
      border-color: ${THEME.goldBorder};
      transform: translateY(-2px);
      box-shadow: 0 4px 16px rgba(0,0,0,0.3);
    }
    
    .room-card-icon {
      font-size: 32px;
    }
    
    .room-card-name {
      font-size: 14px;
      font-weight: 500;
      color: ${THEME.text};
    }
    
    .room-card-meta {
      font-size: 11px;
      color: ${THEME.textDim};
    }
    
    .room-card-actions {
      display: flex;
      gap: 4px;
      margin-top: auto;
    }
    
    .room-card-btn {
      padding: 4px 8px;
      background: transparent;
      border: 1px solid ${THEME.border};
      border-radius: 4px;
      color: ${THEME.textMuted};
      font-size: 10px;
      cursor: pointer;
      transition: all 0.15s;
    }
    
    .room-card-btn:hover {
      background: ${THEME.bgSurface};
      border-color: ${THEME.gold};
      color: ${THEME.gold};
    }
    
    .room-card-btn.danger:hover {
      border-color: #ef4444;
      color: #ef4444;
    }
    
    .new-room-card {
      background: transparent;
      border: 2px dashed ${THEME.border};
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 150px;
    }
    
    .new-room-card:hover {
      border-color: ${THEME.gold};
      background: color-mix(in srgb, var(--g-primary) 5%, transparent);
    }
    
    .new-room-icon {
      font-size: 32px;
      color: ${THEME.textDim};
    }
    
    .new-room-text {
      font-size: 13px;
      color: ${THEME.textMuted};
    }
    
    /* Import component styles */
    ${getLibraryStyles()}
    ${getCanvasStyles()}
    ${getPropertiesStyles()}
    ${getSettingsStyles()}
  `;
}

// ════════════════════════════════════════════════════════════════
// LIFECYCLE
// ════════════════════════════════════════════════════════════════

let keydownHandler: ((e: KeyboardEvent) => void) | null = null;

export async function initRoomCustomizerView(
  client: GatewayBrowserClient,
  state: AppViewState
): Promise<void> {
  await initRoomCustomizer(client, state);
  
  // Set up keyboard shortcuts
  keydownHandler = (e: KeyboardEvent) => {
    handleKeyDown(e);
  };
  document.addEventListener('keydown', keydownHandler);
}

export function cleanupRoomCustomizerView(): void {
  if (keydownHandler) {
    document.removeEventListener('keydown', keydownHandler);
    keydownHandler = null;
  }
  cleanupRoomCustomizer();
}

// ════════════════════════════════════════════════════════════════
// ROOM LIST RENDER
// ════════════════════════════════════════════════════════════════

function renderRoomList(
  state: RoomCustomizerState,
  requestUpdate: () => void
): TemplateResult {
  const formatDate = (ts: number) => {
    return new Date(ts).toLocaleDateString('en-US', { 
      month: 'short', 
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };
  
  return html`
    <div class="no-room-state">
      <div class="no-room-icon">🏠</div>
      <div class="no-room-text">Room Customizer</div>
      <div class="no-room-hint">Create or select a room to start decorating</div>
      
      <div class="room-cards">
        ${state.savedRooms.map(room => html`
          <div 
            class="room-card"
            @click=${(e: MouseEvent) => {
              if ((e.target as HTMLElement).closest('.room-card-btn')) return;
              loadRoom(room.id);
              requestUpdate();
            }}
          >
            <div class="room-card-icon">🏠</div>
            <div class="room-card-name">${room.name}</div>
            <div class="room-card-meta">
              ${room.elements.length} elements • ${formatDate(room.updatedAt)}
              ${room.agentId ? html`<br>🤖 Agent assigned` : ''}
            </div>
            <div class="room-card-actions">
              <button 
                class="room-card-btn"
                @click=${(e: MouseEvent) => {
                  e.stopPropagation();
                  duplicateRoom(room.id);
                  requestUpdate();
                }}
              >
                📋 Duplicate
              </button>
              <button 
                class="room-card-btn danger"
                @click=${(e: MouseEvent) => {
                  e.stopPropagation();
                  if (confirm(`Delete "${room.name}"?`)) {
                    deleteRoom(room.id);
                    requestUpdate();
                  }
                }}
              >
                🗑️ Delete
              </button>
            </div>
          </div>
        `)}
        
        <div 
          class="room-card new-room-card"
          @click=${() => {
            const room = createNewRoom();
            loadRoom(room.id);
            requestUpdate();
          }}
        >
          <div class="new-room-icon">➕</div>
          <div class="new-room-text">Create New Room</div>
        </div>
      </div>
    </div>
  `;
}

// ════════════════════════════════════════════════════════════════
// HEADER
// ════════════════════════════════════════════════════════════════

function renderHeader(
  state: RoomCustomizerState,
  requestUpdate: () => void
): TemplateResult {
  return html`
    <div class="customizer-header">
      <div class="customizer-title">
        <span class="customizer-title-icon">🏠</span>
        <h1>Room Customizer</h1>
      </div>
      
      <div class="room-selector">
        ${state.savedRooms.length > 0 ? html`
          <select 
            class="room-select"
            .value=${state.currentRoom?.id || ''}
            @change=${(e: Event) => {
              const id = (e.target as HTMLSelectElement).value;
              if (id) {
                loadRoom(id);
              } else {
                // Close current room
                state.currentRoom = null;
              }
              requestUpdate();
            }}
          >
            <option value="">— Select Room —</option>
            ${state.savedRooms.map(room => html`
              <option value="${room.id}" ?selected=${state.currentRoom?.id === room.id}>
                ${room.name}
              </option>
            `)}
          </select>
        ` : nothing}
        
        <button 
          class="header-btn primary"
          @click=${() => {
            const room = createNewRoom();
            loadRoom(room.id);
            requestUpdate();
          }}
        >
          ➕ New Room
        </button>
        
        ${state.currentRoom ? html`
          <button 
            class="header-btn"
            @click=${() => {
              toggleSettingsPanel();
              requestUpdate();
            }}
          >
            ⚙️ Settings
          </button>
        ` : nothing}
      </div>
    </div>
  `;
}

// ════════════════════════════════════════════════════════════════
// MAIN RENDER
// ════════════════════════════════════════════════════════════════

export function renderRoomCustomizer(
  state: AppViewState,
  requestUpdate: () => void
): TemplateResult {
  const customizerState = getRoomCustomizerState();
  
  return html`
    <style>${getStyles()}</style>
    ${g8GlassStyles}
    
    <div class="room-customizer g8-page">
      ${renderHeader(customizerState, requestUpdate)}
      
      <div class="customizer-body">
        ${customizerState.currentRoom ? html`
          ${renderElementLibrary(customizerState, requestUpdate)}
          ${renderRoomCanvas(customizerState, requestUpdate)}
          ${renderPropertiesPanel(customizerState, requestUpdate)}
        ` : html`
          ${renderRoomList(customizerState, requestUpdate)}
        `}
      </div>
      
      ${renderRoomSettings(customizerState, requestUpdate)}
    </div>
  `;
}

// ════════════════════════════════════════════════════════════════
// EXPORTS
// ════════════════════════════════════════════════════════════════

export { 
  getRoomCustomizerState,
  createNewRoom,
  loadRoom,
  deleteRoom,
} from '../../controllers/room-customizer';

export type { RoomCustomizerState } from '../../controllers/room-customizer';
