/**
 * Canvas Overlay - Draggable/Resizable MCP Excalidraw Canvas
 * Floating whiteboard that can be positioned anywhere
 */

import { html, nothing } from "lit";
import type { TemplateResult } from "lit";
import { icons } from "../icons";
import { isCanvasProEnabled } from "./canvas-pro/feature-flag";
import { mountCanvasProShell } from "./canvas-pro/shell";
import { g8GlassStyles } from "./glass-g8.js";

const POSITION_KEY = "infinibot-canvas-position";
// The canvas now mounts the in-app Excalidraw React canvas directly via
// `mountMcpCanvas`; the MCP server (extensions/mcp-excalidraw) drives
// scene mutations through the gateway's `canvas.update` events. No
// external server, no iframe, no port 3000.
const MOUNT_CONTAINER_ID = "infinibot-canvas-overlay-mount";
let activeDisposer: (() => void) | null = null;

export interface CanvasPosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasOverlayState {
  isOpen: boolean;
  isConnected: boolean;
  isLoading: boolean;
  isDragging: boolean;
  isResizing: boolean;
  resizeEdge: string | null;
  position: CanvasPosition;
  isMinimized: boolean;
}

const DEFAULT_POSITION: CanvasPosition = {
  x: 60,
  y: 80,
  width: 700,
  height: 500,
};

export function createCanvasOverlayState(): CanvasOverlayState {
  const position = loadPosition();
  return {
    isOpen: false,
    isConnected: false,
    isLoading: true,
    isDragging: false,
    isResizing: false,
    resizeEdge: null,
    position,
    isMinimized: false,
  };
}

function loadPosition(): CanvasPosition {
  try {
    const data = localStorage.getItem(POSITION_KEY);
    if (data) {
      const pos = JSON.parse(data);
      return {
        x: Math.max(0, Math.min(pos.x, window.innerWidth - 200)),
        y: Math.max(0, Math.min(pos.y, window.innerHeight - 100)),
        width: Math.max(400, Math.min(pos.width, window.innerWidth - 40)),
        height: Math.max(300, Math.min(pos.height, window.innerHeight - 100)),
      };
    }
  } catch (e) {}
  return { ...DEFAULT_POSITION };
}

function savePosition(pos: CanvasPosition): void {
  try {
    localStorage.setItem(POSITION_KEY, JSON.stringify(pos));
  } catch (e) {}
}

// Canvas button for topbar
export function renderCanvasButton(
  state: CanvasOverlayState,
  onToggle: () => void
): TemplateResult {
  return html`
    <button 
      class="topbar-glass-btn ${state.isOpen ? 'active' : ''}" 
      data-learn-id="whiteboard-floater-btn"
      @click=${onToggle}
      title="Canvas Whiteboard"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="m12 19 7-7 3 3-7 7-3-3z"/>
        <path d="m18 13-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/>
        <path d="m2 2 7.586 7.586"/>
        <circle cx="11" cy="11" r="2"/>
      </svg>
      Canvas
    </button>
  `;
}

// Connection check state
let _healthCheckInProgress = false;

// Drag/resize state
let dragStartX = 0;
let dragStartY = 0;
let dragStartPosX = 0;
let dragStartPosY = 0;
let resizeStartWidth = 0;
let resizeStartHeight = 0;
let resizeStartX = 0;
let resizeStartY = 0;
let activeResizeEdge = "";

export function renderCanvasOverlay(
  state: CanvasOverlayState,
  onClose: () => void,
  onStateChange: (newState: Partial<CanvasOverlayState>) => void
): TemplateResult {
  if (!state.isOpen) return html``;

  const { position } = state;

  // The MCP-driven canvas mounts directly into the overlay's body once
  // the lit template is in the DOM. Two re-mount triggers:
  //   1. First render — `isConnected` is false.
  //   2. The container is empty because another surface (whiteboard
  //      route / grid panel) stole the singleton React root. Re-mount
  //      so the operator's view stays live regardless of order.
  if (!_healthCheckInProgress) {
    queueMicrotask(() => {
      const container = document.getElementById(MOUNT_CONTAINER_ID);
      if (!container) return;
      if (container.children.length > 0 && state.isConnected) return;
      _healthCheckInProgress = true;
      // Pro shell wraps the same Excalidraw mount with layers/pages/
      // templates/brand kit. Flag-gated so default behavior is unchanged.
      void (isCanvasProEnabled()
        ? Promise.resolve(mountCanvasProShell)
        : import("../../../../extensions/mcp-excalidraw/ui/whiteboard").then((m) => m.mountMcpCanvas))
        .then((mount) => mount(container))
        .then((dispose) => {
          activeDisposer = dispose;
          onStateChange({ isConnected: true, isLoading: false });
        })
        .catch((err) => {
          console.error("[canvas-overlay] mount failed:", err);
          onStateChange({ isConnected: false, isLoading: false });
        })
        .finally(() => {
          _healthCheckInProgress = false;
        });
    });
  }

  // Drag handlers
  const handleDragStart = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('.canvas-header__btn, button')) return;
    e.preventDefault();
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartPosX = position.x;
    dragStartPosY = position.y;
    onStateChange({ isDragging: true });

    const handleDrag = (e: MouseEvent) => {
      const newX = Math.max(0, Math.min(dragStartPosX + (e.clientX - dragStartX), window.innerWidth - 100));
      const newY = Math.max(0, Math.min(dragStartPosY + (e.clientY - dragStartY), window.innerHeight - 50));
      onStateChange({ position: { ...position, x: newX, y: newY } });
    };

    const handleDragEnd = () => {
      onStateChange({ isDragging: false });
      savePosition(state.position);
      document.removeEventListener('mousemove', handleDrag);
      document.removeEventListener('mouseup', handleDragEnd);
    };

    document.addEventListener('mousemove', handleDrag);
    document.addEventListener('mouseup', handleDragEnd);
  };

  // Resize handlers
  const handleResizeStart = (e: MouseEvent, edge: string) => {
    e.preventDefault();
    e.stopPropagation();
    resizeStartWidth = position.width;
    resizeStartHeight = position.height;
    resizeStartX = e.clientX;
    resizeStartY = e.clientY;
    dragStartPosX = position.x;
    dragStartPosY = position.y;
    activeResizeEdge = edge;
    onStateChange({ isResizing: true, resizeEdge: edge });

    const handleResize = (e: MouseEvent) => {
      const dx = e.clientX - resizeStartX;
      const dy = e.clientY - resizeStartY;
      let newWidth = resizeStartWidth;
      let newHeight = resizeStartHeight;
      let newX = dragStartPosX;
      let newY = dragStartPosY;

      if (activeResizeEdge.includes('e')) newWidth = Math.max(400, resizeStartWidth + dx);
      if (activeResizeEdge.includes('w')) {
        newWidth = Math.max(400, resizeStartWidth - dx);
        newX = dragStartPosX + (resizeStartWidth - newWidth);
      }
      if (activeResizeEdge.includes('s')) newHeight = Math.max(300, resizeStartHeight + dy);
      if (activeResizeEdge.includes('n')) {
        newHeight = Math.max(300, resizeStartHeight - dy);
        newY = dragStartPosY + (resizeStartHeight - newHeight);
      }

      onStateChange({ position: { x: newX, y: newY, width: newWidth, height: newHeight } });
    };

    const handleResizeEnd = () => {
      onStateChange({ isResizing: false, resizeEdge: null });
      savePosition(state.position);
      document.removeEventListener('mousemove', handleResize);
      document.removeEventListener('mouseup', handleResizeEnd);
    };

    document.addEventListener('mousemove', handleResize);
    document.addEventListener('mouseup', handleResizeEnd);
  };

  const handleMinimize = () => {
    onStateChange({ isMinimized: !state.isMinimized });
  };

  const handleRefresh = () => {
    // Tear down the current React mount (if any) and let the next
    // render cycle remount via the queueMicrotask above.
    if (activeDisposer) {
      try { activeDisposer(); } catch { /* already disposed */ }
      activeDisposer = null;
    }
    _healthCheckInProgress = false;
    onStateChange({ isLoading: true, isConnected: false });
  };

  const handleOpenExternal = () => {
    // No external URL anymore — open the in-app whiteboard route in a
    // new tab so the operator can use it full-screen.
    window.open(`${window.location.pathname}#whiteboard`, "_blank");
  };

  return html`
    <style>
      .canvas-overlay {
        position: fixed;
        background: linear-gradient(145deg, rgba(6,6,10,0.98) 0%, rgba(12,12,18,0.98) 100%);
        border: 1px solid color-mix(in srgb, var(--g-primary) 25%, transparent);
        border-radius: 12px;
        z-index: 999;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        box-shadow: 
          0 25px 80px rgba(0,0,0,0.7),
          0 0 1px color-mix(in srgb, var(--g-primary) 50%, transparent),
          inset 0 1px 0 rgba(255,255,255,0.03);
        backdrop-filter: blur(24px);
        font-family: 'JetBrains Mono', 'SF Mono', monospace;
        user-select: none;
        transition: box-shadow 0.2s, border-color 0.2s;
      }
      .canvas-overlay.dragging {
        box-shadow: 0 30px 100px rgba(0,0,0,0.8), 0 0 60px color-mix(in srgb, var(--g-primary) 15%, transparent);
        border-color: color-mix(in srgb, var(--g-primary) 50%, transparent);
      }
      .canvas-overlay.resizing { transition: none; }
      .canvas-overlay.minimized { height: 44px !important; }
      .canvas-overlay.minimized .canvas-body { display: none; }

      /* Resize handles */
      .canvas-resize {
        position: absolute;
        z-index: 10;
      }
      .canvas-resize--n { top: -4px; left: 8px; right: 8px; height: 8px; cursor: n-resize; }
      .canvas-resize--s { bottom: -4px; left: 8px; right: 8px; height: 8px; cursor: s-resize; }
      .canvas-resize--e { right: -4px; top: 8px; bottom: 8px; width: 8px; cursor: e-resize; }
      .canvas-resize--w { left: -4px; top: 8px; bottom: 8px; width: 8px; cursor: w-resize; }
      .canvas-resize--ne { top: -4px; right: -4px; width: 16px; height: 16px; cursor: ne-resize; }
      .canvas-resize--nw { top: -4px; left: -4px; width: 16px; height: 16px; cursor: nw-resize; }
      .canvas-resize--se { bottom: -4px; right: -4px; width: 16px; height: 16px; cursor: se-resize; }
      .canvas-resize--sw { bottom: -4px; left: -4px; width: 16px; height: 16px; cursor: sw-resize; }

      /* Header */
      .canvas-header {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 12px;
        background: linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 6%, transparent) 0%, transparent 100%);
        border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 12%, transparent);
        cursor: grab;
        flex-shrink: 0;
      }
      .canvas-header:active { cursor: grabbing; }
      .canvas-header__icon {
        width: 26px;
        height: 26px;
        border-radius: 6px;
        background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 25%, transparent) 0%, color-mix(in srgb, var(--g-primary) 8%, transparent) 100%);
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--g-primary);
        flex-shrink: 0;
      }
      .canvas-header__icon svg { width: 13px; height: 13px; stroke: currentColor; stroke-width: 2.5; fill: none; }
      .canvas-header__info { flex: 1; min-width: 0; }
      .canvas-header__title {
        font-size: 11px;
        font-weight: 700;
        color: var(--g-primary);
        letter-spacing: 0.05em;
        text-transform: uppercase;
      }
      .canvas-header__status {
        display: flex;
        align-items: center;
        gap: 5px;
        font-size: 9px;
        color: rgba(255,255,255,0.35);
      }
      .canvas-header__dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #ef4444;
      }
      .canvas-header__dot.connected { background: #22c55e; box-shadow: 0 0 6px rgba(34,197,94,0.5); }
      .canvas-header__actions { display: flex; gap: 4px; }
      .canvas-header__btn {
        width: 24px;
        height: 24px;
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 5px;
        background: transparent;
        color: rgba(255,255,255,0.4);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.15s;
      }
      .canvas-header__btn:hover {
        background: color-mix(in srgb, var(--g-primary) 10%, transparent);
        border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
        color: var(--g-primary);
      }
      .canvas-header__btn svg { width: 11px; height: 11px; stroke: currentColor; stroke-width: 2; fill: none; }

      .canvas-body {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-height: 0;
        background: #0a0a0f;
      }

      .canvas-iframe {
        flex: 1;
        width: 100%;
        border: none;
        background: #fff;
      }

      /* Excalidraw React canvas mount target. Matches the iframe's
         flex sizing so the canvas fills the overlay body. Without
         flex: 1 the div collapses to 0px and the canvas renders
         into nothing — page appears blank. */
      .canvas-mount {
        flex: 1;
        width: 100%;
        min-height: 0;
        background: #fff;
        position: relative;
        overflow: hidden;
      }

      .canvas-loading,
      .canvas-error {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 12px;
        background: rgba(6,6,10,0.98);
        padding: 30px;
        text-align: center;
      }
      .canvas-spinner {
        width: 28px;
        height: 28px;
        border: 2px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
        border-top-color: var(--g-primary);
        border-radius: 50%;
        animation: canvas-spin 0.8s linear infinite;
      }
      @keyframes canvas-spin { to { transform: rotate(360deg); } }
      .canvas-loading__text,
      .canvas-error__text { font-size: 10px; color: rgba(255,255,255,0.35); }
      .canvas-error__icon {
        width: 40px;
        height: 40px;
        border-radius: 10px;
        background: color-mix(in srgb, var(--g-primary) 8%, transparent);
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--g-primary);
      }
      .canvas-error__icon svg { width: 20px; height: 20px; stroke: currentColor; stroke-width: 2; fill: none; }
      .canvas-error__title { font-size: 12px; font-weight: 600; color: #fff; }
      .canvas-error__hint {
        font-size: 9px;
        color: rgba(255,255,255,0.3);
        background: rgba(0,0,0,0.3);
        padding: 6px 10px;
        border-radius: 4px;
        font-family: monospace;
      }
      .canvas-retry-btn {
        padding: 8px 16px;
        border: 1px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
        border-radius: 6px;
        background: color-mix(in srgb, var(--g-primary) 10%, transparent);
        color: var(--g-primary);
        font-size: 10px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.15s;
        margin-top: 8px;
      }
      .canvas-retry-btn:hover {
        background: color-mix(in srgb, var(--g-primary) 20%, transparent);
        border-color: var(--g-primary);
      }

      .canvas-resize-indicator {
        position: absolute;
        bottom: 5px;
        right: 5px;
        width: 10px;
        height: 10px;
        opacity: 0.25;
        pointer-events: none;
      }
      .canvas-resize-indicator::before,
      .canvas-resize-indicator::after {
        content: '';
        position: absolute;
        background: var(--g-primary);
        border-radius: 1px;
      }
      .canvas-resize-indicator::before { width: 7px; height: 2px; bottom: 0; right: 0; }
      .canvas-resize-indicator::after { width: 2px; height: 7px; bottom: 0; right: 0; }
    </style>

    ${g8GlassStyles}
    <div 
      data-learn-id="whiteboard-floater"
      class="canvas-overlay g8-page ${state.isDragging ? 'dragging' : ''} ${state.isResizing ? 'resizing' : ''} ${state.isMinimized ? 'minimized' : ''}"
      style="left: ${position.x}px; top: ${position.y}px; width: ${position.width}px; height: ${state.isMinimized ? 44 : position.height}px;"
    >
      <!-- Resize handles -->
      ${!state.isMinimized ? html`
        <div class="canvas-resize canvas-resize--n" @mousedown=${(e: MouseEvent) => handleResizeStart(e, 'n')}></div>
        <div class="canvas-resize canvas-resize--s" @mousedown=${(e: MouseEvent) => handleResizeStart(e, 's')}></div>
        <div class="canvas-resize canvas-resize--e" @mousedown=${(e: MouseEvent) => handleResizeStart(e, 'e')}></div>
        <div class="canvas-resize canvas-resize--w" @mousedown=${(e: MouseEvent) => handleResizeStart(e, 'w')}></div>
        <div class="canvas-resize canvas-resize--ne" @mousedown=${(e: MouseEvent) => handleResizeStart(e, 'ne')}></div>
        <div class="canvas-resize canvas-resize--nw" @mousedown=${(e: MouseEvent) => handleResizeStart(e, 'nw')}></div>
        <div class="canvas-resize canvas-resize--se" @mousedown=${(e: MouseEvent) => handleResizeStart(e, 'se')}></div>
        <div class="canvas-resize canvas-resize--sw" @mousedown=${(e: MouseEvent) => handleResizeStart(e, 'sw')}></div>
      ` : nothing}

      <div class="canvas-header" @mousedown=${handleDragStart}>
        <div class="canvas-header__icon">${icons.penTool}</div>
        <div class="canvas-header__info">
          <div class="canvas-header__title">Canvas</div>
          <div class="canvas-header__status">
            <span class="canvas-header__dot ${state.isConnected ? 'connected' : ''}"></span>
            ${state.isConnected ? 'Connected' : 'Disconnected'}
          </div>
        </div>
        <div class="canvas-header__actions">
          <button class="canvas-header__btn" @click=${handleRefresh} title="Refresh">${icons.refresh}</button>
          <button class="canvas-header__btn" @click=${handleOpenExternal} title="Open External">${icons.globe}</button>
          <button class="canvas-header__btn" @click=${handleMinimize} title="${state.isMinimized ? 'Expand' : 'Minimize'}">
            ${state.isMinimized ? icons.maximize : icons.minus}
          </button>
          <button class="canvas-header__btn" data-learn-id="whiteboard-floater-close" @click=${() => {
            // Tear down the React mount before the overlay disappears so
            // the next surface (whiteboard route, grid panel) can claim
            // the singleton root cleanly.
            if (activeDisposer) {
              try { activeDisposer(); } catch { /* already disposed */ }
              activeDisposer = null;
            }
            onClose();
          }} title="Close">${icons.x}</button>
        </div>
      </div>

      <div class="canvas-body">
        ${state.isLoading ? html`
          <div class="canvas-loading">
            <div class="canvas-spinner"></div>
            <div class="canvas-loading__text">Loading Excalidraw…</div>
          </div>
        ` : nothing}
        <!-- Mount target for the in-app Excalidraw React canvas. The mount
             effect (above) calls mountMcpCanvas on this div once it's in
             the DOM. The MCP server (extensions/mcp-excalidraw) drives the
             scene through the gateway's canvas.update broadcast. -->
        <div
          id="${MOUNT_CONTAINER_ID}"
          class="canvas-mount"
          style="width:100%;height:100%;display:${state.isLoading ? "none" : "block"}"
        ></div>
        ${!state.isConnected && !state.isLoading ? html`
          <div class="canvas-error">
            <div class="canvas-error__icon">${icons.plug}</div>
            <div class="canvas-error__title">Couldn't load Excalidraw</div>
            <div class="canvas-error__text">React runtime didn't load. Check the browser console.</div>
            <button class="canvas-retry-btn" @click=${handleRefresh}>Retry</button>
          </div>
        ` : nothing}
      </div>

      <div class="canvas-resize-indicator"></div>
    </div>
  `;
}
