/**
 * Room Canvas Editor
 * Interactive canvas for placing, moving, and editing elements
 * Uses HTML/CSS with drag-and-drop (PixiJS integration in future)
 */

import { html, nothing } from 'lit';
import type { TemplateResult } from 'lit';
import {
  type PlacedElement,
  type RoomSettings,
  type RoomConfiguration,
  type Vector2D,
  getElementDefinition,
  getCategoryIcon,
} from '../../types/room-elements';
import {
  type RoomCustomizerState,
  addElement,
  moveElement,
  selectElement,
  clearSelection,
  setHoveredElement,
  endDragFromLibrary,
  updateDragPreview,
  cancelDrag,
  getRoomCustomizerState,
  undo,
  redo,
  canUndo,
  canRedo,
  toggleGrid,
  toggleSnapToGrid,
  setZoom,
  resetViewport,
  saveCurrentRoom,
} from '../../controllers/room-customizer';

// ════════════════════════════════════════════════════════════════
// THEME
// ════════════════════════════════════════════════════════════════

const THEME = {
  bg: '#121212',
  bgCanvas: '#1a1a1a',
  grid: 'rgba(255,255,255,0.03)',
  gridMajor: 'rgba(255,255,255,0.06)',
  gold: 'var(--g-primary)',
  goldDim: 'var(--g-primary)',
  goldBorder: 'color-mix(in srgb, var(--g-primary) 50%, transparent)',
  goldGlow: 'color-mix(in srgb, var(--g-primary) 30%, transparent)',
  text: '#e4e4e7',
  textMuted: '#71717a',
  selection: 'color-mix(in srgb, var(--g-primary) 30%, transparent)',
  selectionBorder: 'var(--g-primary)',
  hover: 'rgba(100,200,255,0.2)',
  hoverBorder: '#64c8ff',
};

// ════════════════════════════════════════════════════════════════
// STYLES
// ════════════════════════════════════════════════════════════════

export function getCanvasStyles(): string {
  return `
    .canvas-container {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: ${THEME.bg};
    }
    
    .canvas-toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: #0f0f0f;
      border-bottom: 1px solid #1f1f1f;
    }
    
    .toolbar-group {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    
    .toolbar-divider {
      width: 1px;
      height: 24px;
      background: #2a2a2a;
      margin: 0 8px;
    }
    
    .toolbar-btn {
      padding: 6px 10px;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 4px;
      color: ${THEME.textMuted};
      font-size: 12px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: all 0.15s;
    }
    
    .toolbar-btn:hover {
      background: #1a1a1a;
      border-color: #2a2a2a;
      color: ${THEME.text};
    }
    
    .toolbar-btn.active {
      background: color-mix(in srgb, var(--g-primary) 10%, transparent);
      border-color: ${THEME.goldBorder};
      color: ${THEME.gold};
    }
    
    .toolbar-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    
    .toolbar-btn svg {
      width: 16px;
      height: 16px;
    }
    
    .zoom-display {
      font-size: 11px;
      color: ${THEME.textMuted};
      min-width: 50px;
      text-align: center;
      padding: 4px 8px;
      background: #0a0a0a;
      border-radius: 4px;
    }
    
    .canvas-viewport {
      flex: 1;
      position: relative;
      overflow: hidden;
      cursor: crosshair;
      touch-action: none;
      -webkit-user-select: none;
      user-select: none;
    }
    
    .canvas-viewport.panning {
      cursor: grabbing;
    }
    
    /* Mobile touch support */
    @media (pointer: coarse) {
      .canvas-element {
        min-width: 44px;
        min-height: 44px;
      }
      .element-resize-handle {
        width: 20px;
        height: 20px;
      }
    }
    
    .canvas-viewport.dragging-element {
      cursor: copy;
    }
    
    .canvas-scroll {
      position: absolute;
      inset: 0;
      overflow: auto;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    
    .canvas-content {
      position: relative;
      background: ${THEME.bgCanvas};
      border: 2px dashed #2a2a2a;
      border-radius: 8px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.5);
      transform-origin: center;
      transition: transform 0.1s ease-out;
    }
    
    .canvas-grid {
      position: absolute;
      inset: 0;
      pointer-events: none;
      opacity: 0.5;
    }
    
    .canvas-elements {
      position: absolute;
      inset: 0;
    }
    
    .canvas-element {
      position: absolute;
      cursor: pointer;
      transition: box-shadow 0.15s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
      user-select: none;
    }
    
    .canvas-element:hover {
      z-index: 9999 !important;
    }
    
    .canvas-element.selected {
      outline: 2px solid ${THEME.selectionBorder};
      outline-offset: 2px;
      box-shadow: 0 0 12px ${THEME.goldGlow};
    }
    
    .canvas-element.hovered:not(.selected) {
      outline: 1px dashed ${THEME.hoverBorder};
      outline-offset: 2px;
    }
    
    .canvas-element.locked {
      opacity: 0.6;
      cursor: not-allowed;
    }
    
    .canvas-element.hidden {
      opacity: 0.3;
      pointer-events: none;
    }
    
    .canvas-element.dragging {
      opacity: 0.8;
      cursor: grabbing;
      z-index: 10000 !important;
    }
    
    .element-resize-handle {
      position: absolute;
      width: 8px;
      height: 8px;
      background: ${THEME.gold};
      border: 1px solid ${THEME.bgCanvas};
      border-radius: 50%;
      cursor: nwse-resize;
      opacity: 0;
      transition: opacity 0.15s;
    }
    
    .canvas-element.selected .element-resize-handle {
      opacity: 1;
    }
    
    .element-resize-handle.nw { top: -4px; left: -4px; cursor: nwse-resize; }
    .element-resize-handle.ne { top: -4px; right: -4px; cursor: nesw-resize; }
    .element-resize-handle.sw { bottom: -4px; left: -4px; cursor: nesw-resize; }
    .element-resize-handle.se { bottom: -4px; right: -4px; cursor: nwse-resize; }
    
    .drag-preview {
      position: absolute;
      pointer-events: none;
      opacity: 0.6;
      z-index: 10001;
      font-size: 32px;
      transform: translate(-50%, -50%);
      filter: drop-shadow(0 2px 8px rgba(0,0,0,0.5));
    }
    
    .canvas-empty {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      color: ${THEME.textMuted};
      pointer-events: none;
    }
    
    .canvas-empty-icon {
      font-size: 48px;
      margin-bottom: 16px;
      opacity: 0.4;
    }
    
    .canvas-empty-text {
      font-size: 14px;
      margin-bottom: 4px;
    }
    
    .canvas-empty-hint {
      font-size: 12px;
      color: #52525b;
    }
    
    .selection-box {
      position: absolute;
      border: 1px dashed ${THEME.gold};
      background: ${THEME.selection};
      pointer-events: none;
    }
    
    .canvas-room-bg {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 120px;
      opacity: 0.2;
      pointer-events: none;
    }
  `;
}

// ════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ════════════════════════════════════════════════════════════════

function getElementEmoji(definitionId: string): string {
  const emojis: Record<string, string> = {
    desk: '🪑',
    chair: '💺',
    sofa: '🛋️',
    littleTable: '🪵',
    bed: '🛏️',
    laptop: '💻',
    television: '📺',
    bookcase: '📚',
    coffee: '☕',
    teddy: '🧸',
    plant: '🌿',
    lamp: '💡',
    window: '🪟',
    drawers: '🗄️',
  };
  
  const def = getElementDefinition(definitionId);
  return emojis[definitionId] || getCategoryIcon(def?.category || 'decorations');
}

function renderGridPattern(settings: RoomSettings): TemplateResult {
  if (!settings.gridVisible) return html``;
  
  const gridSize = settings.gridSize;
  
  return html`
    <svg class="canvas-grid" width="100%" height="100%">
      <defs>
        <pattern id="small-grid" width="${gridSize}" height="${gridSize}" patternUnits="userSpaceOnUse">
          <path d="M ${gridSize} 0 L 0 0 0 ${gridSize}" fill="none" stroke="${THEME.grid}" stroke-width="0.5"/>
        </pattern>
        <pattern id="large-grid" width="${gridSize * 4}" height="${gridSize * 4}" patternUnits="userSpaceOnUse">
          <rect width="${gridSize * 4}" height="${gridSize * 4}" fill="url(#small-grid)"/>
          <path d="M ${gridSize * 4} 0 L 0 0 0 ${gridSize * 4}" fill="none" stroke="${THEME.gridMajor}" stroke-width="1"/>
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#large-grid)"/>
    </svg>
  `;
}

// ════════════════════════════════════════════════════════════════
// ELEMENT RENDERING
// ════════════════════════════════════════════════════════════════

function renderElement(
  element: PlacedElement,
  state: RoomCustomizerState,
  requestUpdate: () => void
): TemplateResult {
  const isSelected = state.selection.selectedIds.has(element.instanceId);
  const isHovered = state.selection.hoveredId === element.instanceId;
  const definition = getElementDefinition(element.definitionId);
  
  const style = `
    left: ${element.transform.position.x}px;
    top: ${element.transform.position.y}px;
    width: ${element.size.width * element.transform.scale}px;
    height: ${element.size.height * element.transform.scale}px;
    z-index: ${element.transform.position.z};
    transform: rotate(${element.transform.rotation}deg);
    opacity: ${element.opacity};
  `;
  
  const classes = [
    'canvas-element',
    isSelected ? 'selected' : '',
    isHovered ? 'hovered' : '',
    element.locked ? 'locked' : '',
    !element.visible ? 'hidden' : '',
  ].filter(Boolean).join(' ');
  
  let dragStartX = 0;
  let dragStartY = 0;
  let elementStartX = 0;
  let elementStartY = 0;
  
  // Unified drag handler for both mouse and touch
  const startDrag = (clientX: number, clientY: number, target: HTMLElement, isMultiSelect: boolean) => {
    if (element.locked) return;
    
    // Select element
    selectElement(element.instanceId, isMultiSelect);
    
    // Start drag
    dragStartX = clientX;
    dragStartY = clientY;
    elementStartX = element.transform.position.x;
    elementStartY = element.transform.position.y;
    
    target.classList.add('dragging');
    
    const handleMove = (clientX: number, clientY: number) => {
      const dx = clientX - dragStartX;
      const dy = clientY - dragStartY;
      
      const zoom = state.currentRoom?.settings.zoom || 1;
      element.transform.position.x = elementStartX + dx / zoom;
      element.transform.position.y = elementStartY + dy / zoom;
      
      // Snap to grid
      const settings = state.currentRoom?.settings;
      if (settings?.snapToGrid) {
        const gridSize = settings.gridSize;
        element.transform.position.x = Math.round(element.transform.position.x / gridSize) * gridSize;
        element.transform.position.y = Math.round(element.transform.position.y / gridSize) * gridSize;
      }
      
      requestUpdate();
    };
    
    const handleMouseMove = (moveEvent: MouseEvent) => {
      handleMove(moveEvent.clientX, moveEvent.clientY);
    };
    
    const handleTouchMove = (moveEvent: TouchEvent) => {
      if (moveEvent.touches.length === 1) {
        moveEvent.preventDefault();
        handleMove(moveEvent.touches[0].clientX, moveEvent.touches[0].clientY);
      }
    };
    
    const handleEnd = () => {
      target.classList.remove('dragging');
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleEnd);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleEnd);
      document.removeEventListener('touchcancel', handleEnd);
    };
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleEnd);
    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleEnd);
    document.addEventListener('touchcancel', handleEnd);
  };
  
  const handleMouseDown = (e: MouseEvent) => {
    if (element.locked) return;
    e.stopPropagation();
    startDrag(e.clientX, e.clientY, e.currentTarget as HTMLElement, e.shiftKey || e.ctrlKey);
  };
  
  const handleTouchStart = (e: TouchEvent) => {
    if (element.locked) return;
    e.stopPropagation();
    if (e.touches.length === 1) {
      e.preventDefault();
      startDrag(e.touches[0].clientX, e.touches[0].clientY, e.currentTarget as HTMLElement, false);
    }
  };
  
  return html`
    <div 
      class="${classes}"
      style="${style}"
      @mousedown=${handleMouseDown}
      @touchstart=${handleTouchStart}
      @mouseenter=${() => { setHoveredElement(element.instanceId); requestUpdate(); }}
      @mouseleave=${() => { setHoveredElement(null); requestUpdate(); }}
      title="${element.name || definition?.name || 'Element'}"
    >
      ${getElementEmoji(element.definitionId)}
      
      ${isSelected ? html`
        <div class="element-resize-handle nw"></div>
        <div class="element-resize-handle ne"></div>
        <div class="element-resize-handle sw"></div>
        <div class="element-resize-handle se"></div>
      ` : nothing}
    </div>
  `;
}

// ════════════════════════════════════════════════════════════════
// TOOLBAR
// ════════════════════════════════════════════════════════════════

function renderToolbar(
  state: RoomCustomizerState,
  requestUpdate: () => void
): TemplateResult {
  const settings = state.currentRoom?.settings;
  if (!settings) return html``;
  
  // Import these at the top of file and use them directly
  // For now, we'll import from the already imported controller
  // (the functions are already imported at the top)
  
  return html`
    <div class="canvas-toolbar">
      <div class="toolbar-group">
        <button 
          class="toolbar-btn"
          ?disabled=${!canUndo()}
          @click=${() => { undo(); requestUpdate(); }}
          title="Undo (Ctrl+Z)"
        >
          ↩️ Undo
        </button>
        <button 
          class="toolbar-btn"
          ?disabled=${!canRedo()}
          @click=${() => { redo(); requestUpdate(); }}
          title="Redo (Ctrl+Shift+Z)"
        >
          ↪️ Redo
        </button>
      </div>
      
      <div class="toolbar-divider"></div>
      
      <div class="toolbar-group">
        <button 
          class="toolbar-btn ${settings.gridVisible ? 'active' : ''}"
          @click=${() => { toggleGrid(); requestUpdate(); }}
          title="Toggle Grid (G)"
        >
          📐 Grid
        </button>
        <button 
          class="toolbar-btn ${settings.snapToGrid ? 'active' : ''}"
          @click=${() => { toggleSnapToGrid(); requestUpdate(); }}
          title="Toggle Snap to Grid"
        >
          🧲 Snap
        </button>
      </div>
      
      <div class="toolbar-divider"></div>
      
      <div class="toolbar-group">
        <button 
          class="toolbar-btn"
          @click=${() => { setZoom(settings.zoom - 0.25); requestUpdate(); }}
          title="Zoom Out"
        >
          ➖
        </button>
        <span class="zoom-display">${Math.round(settings.zoom * 100)}%</span>
        <button 
          class="toolbar-btn"
          @click=${() => { setZoom(settings.zoom + 0.25); requestUpdate(); }}
          title="Zoom In"
        >
          ➕
        </button>
        <button 
          class="toolbar-btn"
          @click=${() => { resetViewport(); requestUpdate(); }}
          title="Reset View"
        >
          🔄
        </button>
      </div>
      
      <div style="flex: 1"></div>
      
      <div class="toolbar-group">
        ${state.isDirty ? html`
          <button 
            class="toolbar-btn"
            @click=${() => { saveCurrentRoom(); requestUpdate(); }}
            title="Save Room (Ctrl+S)"
          >
            💾 Save
          </button>
        ` : html`
          <span style="font-size: 11px; color: #52525b">✓ Saved</span>
        `}
      </div>
    </div>
  `;
}

// ════════════════════════════════════════════════════════════════
// MAIN RENDER
// ════════════════════════════════════════════════════════════════

export function renderRoomCanvas(
  state: RoomCustomizerState,
  requestUpdate: () => void
): TemplateResult {
  const room = state.currentRoom;
  
  if (!room) {
    return html`
      <div class="canvas-container">
        <div class="canvas-empty">
          <div class="canvas-empty-icon">🏠</div>
          <div class="canvas-empty-text">No room loaded</div>
          <div class="canvas-empty-hint">Create or select a room to start editing</div>
        </div>
      </div>
    `;
  }
  
  const settings = room.settings;
  const elements = room.elements;
  
  // Sort elements by z-index for proper layering
  const sortedElements = [...elements].sort((a, b) => 
    a.transform.position.z - b.transform.position.z
  );
  
  const canvasStyle = `
    width: ${settings.width}px;
    height: ${settings.height}px;
    transform: scale(${settings.zoom}) translate(${settings.pan.x}px, ${settings.pan.y}px);
    background-color: ${settings.backgroundColor};
  `;
  
  // Handle drop from library
  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
    
    // Update preview position
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const zoom = settings.zoom;
    const x = (e.clientX - rect.left) / zoom - settings.pan.x;
    const y = (e.clientY - rect.top) / zoom - settings.pan.y;
    
    updateDragPreview({ x, y });
    requestUpdate();
  };
  
  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    
    const definitionId = e.dataTransfer?.getData('application/x-room-element');
    if (!definitionId) return;
    
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const zoom = settings.zoom;
    const x = (e.clientX - rect.left) / zoom - settings.pan.x;
    const y = (e.clientY - rect.top) / zoom - settings.pan.y;
    
    addElement(definitionId, { x, y });
    cancelDrag();
    requestUpdate();
  };
  
  const handleDragLeave = () => {
    cancelDrag();
    requestUpdate();
  };
  
  const handleCanvasClick = (e: MouseEvent) => {
    // Clear selection when clicking empty canvas
    if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('canvas-content')) {
      clearSelection();
      requestUpdate();
    }
  };
  
  return html`
    <div class="canvas-container">
      ${renderToolbar(state, requestUpdate)}
      
      <div 
        class="canvas-viewport ${state.draggingElement ? 'dragging-element' : ''}"
        @click=${handleCanvasClick}
        @dragover=${handleDragOver}
        @drop=${handleDrop}
        @dragleave=${handleDragLeave}
      >
        <div class="canvas-scroll">
          <div class="canvas-content" style="${canvasStyle}">
            ${renderGridPattern(settings)}
            
            ${settings.backgroundType !== 'none' ? html`
              <div class="canvas-room-bg">🏠</div>
            ` : nothing}
            
            <div class="canvas-elements">
              ${sortedElements.map(el => renderElement(el, state, requestUpdate))}
            </div>
            
            ${elements.length === 0 ? html`
              <div class="canvas-empty">
                <div class="canvas-empty-icon">📦</div>
                <div class="canvas-empty-text">Room is empty</div>
                <div class="canvas-empty-hint">Drag elements from the library to add them</div>
              </div>
            ` : nothing}
            
            ${state.draggingElement && state.dragPreviewPosition ? html`
              <div 
                class="drag-preview"
                style="left: ${state.dragPreviewPosition.x}px; top: ${state.dragPreviewPosition.y}px"
              >
                ${getElementEmoji(state.draggingElement.id)}
              </div>
            ` : nothing}
          </div>
        </div>
      </div>
    </div>
  `;
}
