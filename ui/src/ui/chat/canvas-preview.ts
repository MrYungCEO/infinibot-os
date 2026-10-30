/**
 * Canvas Preview Component
 * Stylish preview modal for Excalidraw MCP tool results in chat
 */

import { html, nothing } from "lit";
import type { TemplateResult } from "lit";

// The dead Express server at localhost:3000 is gone. Canvas now lives
// in the React bundle at the /whiteboard route. We read element counts
// from gateway events the MCP server emits and link the operator to
// the in-app whiteboard for any actual viewing.
const WHITEBOARD_ROUTE_HASH = "#/whiteboard";

interface CanvasPreviewState {
  loading: boolean;
  error: string | null;
  imageUrl: string | null;
  elementCount: number;
  expanded: boolean;
}

// Global state for the preview
let previewState: CanvasPreviewState = {
  loading: false,
  error: null,
  imageUrl: null,
  elementCount: 0,
  expanded: false,
};

/**
 * Check if a tool result is from Excalidraw/Canvas MCP
 */
export function isCanvasToolResult(toolName: string): boolean {
  const canvasTools = [
    "canvas",
    "excalidraw",
    "mcp_excalidraw",
    "create_element",
    "update_element",
    "delete_element",
    "clear_canvas",
    "get_elements",
    "create_rectangle",
    "create_ellipse",
    "create_diamond",
    "create_text",
    "create_arrow",
    "create_line",
    "create_freedraw",
    "create_image",
    "batch_create_elements",
    "update_element",
    "delete_element",
    "move_element",
    "resize_element",
    "group_elements",
    "ungroup_elements",
    "create_frame",
    "create_from_mermaid",
    "export_to_svg",
    "export_to_png",
    "get_canvas_state",
    "set_canvas_state",
  ];
  return canvasTools.some(t => toolName.toLowerCase().includes(t.toLowerCase()));
}

/**
 * Fetch canvas preview from MCP server
 */
async function fetchCanvasPreview(): Promise<void> {
  // The element count is now derived from the most recent canvas.update
  // event the MCP server fires (cached on window for this preview).
  // We don't poll the dead Express server anymore.
  previewState.loading = false;
  previewState.error = null;
  const cached = (window as any).__infinibotCanvasElementCount;
  if (typeof cached === "number") {
    previewState.elementCount = cached;
  }
}

/**
 * Save current canvas to local board
 */
async function saveCanvasToBoard(): Promise<void> {
  const name = prompt("Save canvas as:", "my-drawing");
  if (!name?.trim()) return;
  
  try {
    // Read elements directly from the in-app React canvas — same
    // source used by the whiteboard's "Save board" button.
    const wb = await import("../../../../extensions/mcp-excalidraw/ui/whiteboard");
    const elements = wb.getMountedSceneElements();
    if (!Array.isArray(elements) || elements.length === 0) {
      alert("Canvas is empty (or not currently mounted in this tab).");
      return;
    }

    const boardData = {
      type: "excalidraw",
      version: 2,
      source: "infinibot-mcp-canvas",
      elements,
      appState: {
        viewBackgroundColor: "#ffffff",
        theme: "light",
      },
      files: {},
    };
    
    // Save via gateway
    const boardId = name.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    
    // Use the gateway client if available
    const client = (window as any).__infinibotGatewayClient;
    if (client) {
      await client.request("whiteboard.boards.save", { id: boardId, data: boardData });
      alert(`Saved as "${name.trim()}"!`);
    } else {
      alert("Gateway not available - open in Whiteboard tab to save");
    }
  } catch (err) {
    alert(`Failed to save: ${err}`);
  }
}

/**
 * Open canvas in Whiteboard tab
 */
function openInWhiteboard(): void {
  // Navigate to whiteboard tab
  window.location.hash = "#/whiteboard";
}

/**
 * Open the whiteboard route in a new window — used by the chat preview's
 * "open externally" affordance. Same hash route as openInWhiteboard but
 * in a new tab.
 */
function openExternal(): void {
  window.open(`${window.location.pathname}${WHITEBOARD_ROUTE_HASH}`, "_blank");
}

/**
 * Toggle expanded view
 */
function toggleExpanded(requestUpdate: () => void): void {
  previewState.expanded = !previewState.expanded;
  requestUpdate();
}

/**
 * Render the canvas preview card for chat
 */
export function renderCanvasPreview(
  toolName: string,
  toolResult: string | undefined,
  requestUpdate: () => void
): TemplateResult {
  // Parse result to get element info
  let resultInfo = "";
  let success = true;
  
  if (toolResult) {
    try {
      const parsed = JSON.parse(toolResult);
      if (parsed.success === false) {
        success = false;
        resultInfo = parsed.error || "Operation failed";
      } else if (parsed.elements) {
        resultInfo = `${parsed.elements.length} elements`;
      } else if (parsed.element) {
        resultInfo = `Created ${parsed.element.type || "element"}`;
      } else if (parsed.count !== undefined) {
        resultInfo = `${parsed.count} elements`;
      } else if (parsed.message) {
        resultInfo = parsed.message;
      }
    } catch {
      // Not JSON, use as-is
      if (toolResult.length < 100) {
        resultInfo = toolResult;
      }
    }
  }

  // Fetch preview on first render
  if (!previewState.loading && previewState.elementCount === 0 && !previewState.error) {
    fetchCanvasPreview().then(requestUpdate);
  }

  return html`
    <style>
      .canvas-preview {
        background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
        border: 1px solid #2a2a4e;
        border-radius: 12px;
        overflow: hidden;
        margin: 8px 0;
        width: 100%;
        max-width: 100%;
        min-width: 300px;
      }

      @media (min-width: 600px) {
        .canvas-preview {
          max-width: 700px;
        }
      }

      @media (min-width: 900px) {
        .canvas-preview {
          max-width: 850px;
        }
      }

      .canvas-preview__body {
        padding: 12px;
      }

      .canvas-preview__thumbnail {
        background: #ffffff;
        border-radius: 8px;
        height: ${previewState.expanded ? "600px" : "350px"};
        display: flex;
        align-items: center;
        justify-content: center;
        margin-bottom: 12px;
        overflow: hidden;
        transition: height 0.3s ease;
        position: relative;
      }

      @media (max-width: 500px) {
        .canvas-preview__thumbnail {
          height: ${previewState.expanded ? "450px" : "250px"};
        }
      }

      .canvas-preview__thumbnail iframe {
        width: 200%;
        height: 200%;
        border: none;
        pointer-events: ${previewState.expanded ? "auto" : "none"};
        transform: scale(0.5);
        transform-origin: top left;
      }

      .canvas-preview__overlay {
        position: absolute;
        inset: 0;
        background: rgba(0,0,0,0.02);
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: background 0.2s;
      }

      .canvas-preview__overlay:hover {
        background: rgba(99, 102, 241, 0.1);
      }

      .canvas-preview__overlay-text {
        background: rgba(0,0,0,0.7);
        color: white;
        padding: 8px 16px;
        border-radius: 20px;
        font-size: 12px;
        font-weight: 500;
        opacity: 0;
        transition: opacity 0.2s;
      }

      .canvas-preview__overlay:hover .canvas-preview__overlay-text {
        opacity: 1;
      }

      .canvas-preview__info {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 12px;
        color: #a0a0a0;
        font-size: 13px;
        flex-wrap: wrap;
      }

      .canvas-preview__info-item {
        display: flex;
        align-items: center;
        gap: 4px;
      }

      .canvas-preview__actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }

      .canvas-preview__btn {
        flex: 1;
        min-width: 70px;
        padding: 10px 12px;
        border: none;
        border-radius: 8px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        transition: all 0.2s;
      }

      @media (max-width: 360px) {
        .canvas-preview__btn {
          padding: 8px 10px;
          font-size: 12px;
        }
      }

      .canvas-preview__btn--primary {
        background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
        color: white;
      }

      .canvas-preview__btn--primary:hover {
        transform: translateY(-1px);
        box-shadow: 0 4px 12px rgba(99, 102, 241, 0.4);
      }

      .canvas-preview__btn--secondary {
        background: #2a2a4e;
        color: #a0a0a0;
      }

      .canvas-preview__btn--secondary:hover {
        background: #3a3a5e;
        color: #fff;
      }

      .canvas-preview__result {
        margin-top: 8px;
        padding: 8px 12px;
        background: rgba(0,0,0,0.2);
        border-radius: 6px;
        font-size: 12px;
        color: #888;
        font-family: monospace;
      }
    </style>

    <div class="canvas-preview">
      <div class="canvas-preview__body">
        <div
          class="canvas-preview__thumbnail"
          @click=${() => openInWhiteboard()}
          style="cursor:pointer;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#1f2937,#0f172a);min-height:120px"
          title="Open the whiteboard"
        >
          <!-- The dead-Express preview iframe is gone — embedding the
               full /whiteboard React tree as a thumbnail is too heavy.
               Show a glanceable summary card; click navigates to the
               full canvas. -->
          <div style="text-align:center;color:#a3a3ad">
            <div style="font-size:32px;margin-bottom:6px">🎨</div>
            <div style="font-size:13px;font-weight:600;color:#e5e5e5">
              ${previewState.elementCount} element${previewState.elementCount === 1 ? "" : "s"}
            </div>
            <div style="font-size:11px;margin-top:2px;opacity:0.7">Click to open whiteboard</div>
          </div>
        </div>
        
        <div class="canvas-preview__info">
          <span class="canvas-preview__info-item">
            🎨 ${previewState.elementCount} elements
          </span>
          ${resultInfo ? html`
            <span class="canvas-preview__info-item">
              • ${resultInfo}
            </span>
          ` : nothing}
        </div>
        
        <div class="canvas-preview__actions">
          <button class="canvas-preview__btn canvas-preview__btn--primary" @click=${openInWhiteboard}>
            ↗️ Open
          </button>
          <button class="canvas-preview__btn canvas-preview__btn--secondary" @click=${saveCanvasToBoard}>
            💾 Save
          </button>
          <button class="canvas-preview__btn canvas-preview__btn--secondary" @click=${openExternal}>
            🔗 Full
          </button>
        </div>
      </div>
    </div>
  `;
}

/**
 * Reset preview state (call when navigating away)
 */
export function resetCanvasPreviewState(): void {
  previewState = {
    loading: false,
    error: null,
    imageUrl: null,
    elementCount: 0,
    expanded: false,
  };
}
