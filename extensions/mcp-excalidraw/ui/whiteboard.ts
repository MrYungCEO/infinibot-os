/**
 * Whiteboard View
 * Renders the Excalidraw-based whiteboard with board management
 */

import { html, nothing } from "lit";
import type { TemplateResult } from "lit";
import { icons } from "../../../ui/src/ui/icons";
import "../../../ui/src/ui/components/doc-agent-panel";
import type { WhiteboardState, WhiteboardFile, WhiteboardTemplate } from "./controller";
import { 
  BUILTIN_TEMPLATES, 
  loadTemplateToMcpCanvas, 
  clearMcpCanvas,
  loadBoardToMcpCanvas,
  saveMcpCanvasToBoard,
  loadWhiteboardList
} from "./controller";

// Excalidraw and React type declarations
declare global {
  interface Window {
    React: any;
    ReactDOM: any;
    ReactDOMClient: any;
    ExcalidrawLib: any;
    EXCALIDRAW_ASSET_PATH: string;
  }
}

export interface WhiteboardViewProps {
  state: WhiteboardState;
  app?: any; // App context for MCP Canvas board loading (includes client)
  onLoadList: () => void;
  onLoadBoard: (id: string) => void;
  onSaveBoard: (id: string, data: any, silent?: boolean) => void;
  onCreateBoard: (name: string) => Promise<string | null>;
  onDeleteBoard: (id: string) => void;
  onRenameBoard: (id: string, newName: string) => void;
  onBack: () => void;
  onToggleTemplates: () => void;
  onApplyTemplate: (templateId: string, name?: string) => Promise<string | null>;
  onImportFile: (file: File) => Promise<string | null>;
  onImportClipboard: () => Promise<boolean>;
  onExport: () => void;
  onSaveAsTemplate: (name: string) => Promise<boolean>;
  requestUpdate: () => void;
}

let excalidrawRoot: any = null;
let excalidrawAPI: any = null;
let saveDebounceTimer: number | null = null;
let loadedScripts = false;
let currentMountedBoardId: string | null = null;
let isInitializing = false;
let initialElementCount: number = 0; // Track elements loaded to prevent saving empty on init
let hasMadeChanges = false; // Track if user actually made changes

/** Add the runtime fields Excalidraw 0.18 reads before conversion. */
function prepareElementsForExcalidraw(elements: unknown[]): any[] {
  return (Array.isArray(elements) ? elements : []).map((value, position) => {
    const element = value && typeof value === "object" ? value as Record<string, any> : {};
    const width = typeof element.width === "number" ? element.width : 0;
    const height = typeof element.height === "number" ? element.height : 0;
    const linear = element.type === "arrow" || element.type === "line";
    return {
      groupIds: [],
      boundElements: null,
      link: null,
      locked: false,
      isDeleted: false,
      roundness: null,
      seed: 1_000_003 + position,
      version: 1,
      versionNonce: 2_000_003 + position,
      updated: Date.now(),
      customData: null,
      index: null,
      ...element,
      ...(linear && !Array.isArray(element.points)
        ? { points: [[0, 0], [width, height]] }
        : {}),
    };
  });
}

function convertElementsForExcalidraw(elements: unknown[]): any[] {
  const prepared = prepareElementsForExcalidraw(elements);
  const convert = window.ExcalidrawLib?.convertToExcalidrawElements;
  return convert ? convert(prepared, { regenerateIds: false }) : prepared;
}

/**
 * Load React + Excalidraw from the bundled package.
 *
 * Previously this loaded everything from esm.sh via an injected
 * `<script type="module">`, which downloaded ~2 MB across many CDN
 * round-trips and parsed inline on the main thread — locking the page
 * for seconds whenever a canvas panel mounted. The npm package is
 * already installed; Vite code-splits it into a same-origin chunk that
 * the browser parses off the critical paint path.
 */
async function loadExcalidrawScripts(): Promise<boolean> {
  if (loadedScripts && window.ExcalidrawLib) return true;
  // Excalidraw resolves fonts/icons via this global. Keep pointing at the
  // CDN — small async asset loads, no main-thread parse cost.
  if (!window.EXCALIDRAW_ASSET_PATH) {
    window.EXCALIDRAW_ASSET_PATH = "https://esm.sh/@excalidraw/excalidraw@0.18.0/dist/prod/";
  }
  try {
    const [reactMod, reactDomMod, reactDomClientMod, excalidrawMod] = await Promise.all([
      import("react"),
      import("react-dom"),
      import("react-dom/client"),
      import("@excalidraw/excalidraw"),
      import("@excalidraw/excalidraw/index.css"),
    ]);
    const React = (reactMod as any).default ?? reactMod;
    const ReactDOM = (reactDomMod as any).default ?? reactDomMod;
    const { createRoot } = reactDomClientMod as { createRoot: (c: Element) => unknown };
    const { Excalidraw, convertToExcalidrawElements } = excalidrawMod as {
      Excalidraw: unknown;
      convertToExcalidrawElements: unknown;
    };
    window.React = React;
    window.ReactDOM = ReactDOM;
    window.ReactDOMClient = { createRoot } as any;
    window.ExcalidrawLib = { Excalidraw, convertToExcalidrawElements } as any;
    loadedScripts = true;
    return true;
  } catch (err) {
    console.error("[loadExcalidrawScripts] failed to load bundled excalidraw:", err);
    return false;
  }
}

/**
 * Mount Excalidraw React component into a container
 */
function mountExcalidraw(
  container: HTMLElement,
  initialData: any,
  onChange: (elements: any[], appState: any, files: any) => void
): void {
  if (!window.React || !window.ReactDOM || !window.ExcalidrawLib) {
    console.error("Excalidraw dependencies not loaded");
    return;
  }

  const React = window.React;
  const ReactDOM = window.ReactDOM;
  const { Excalidraw, convertToExcalidrawElements } = window.ExcalidrawLib;

  // Create the Excalidraw component
  const ExcalidrawWrapper = () => {
    const [excalidrawAPIRef, setExcalidrawAPI] = React.useState(null);

    // Use light theme with white background (matching Docker canvas exactly)
    const appStateConfig = {
      theme: "light",
      viewBackgroundColor: "#ffffff",
    };

    // Ensure files is a proper object
    const loadedFiles = initialData?.files || {};
    const rawElements = initialData?.elements || [];
    
    // Clean elements (remove server metadata) and convert to Excalidraw format
    const cleanedElements = rawElements.map((el: any) => {
      const { createdAt, updatedAt, syncedAt, source, syncTimestamp, ...clean } = el;
      return clean;
    });
    
    // Use convertToExcalidrawElements to properly format elements (like Docker canvas does)
    const preparedElements = prepareElementsForExcalidraw(cleanedElements);
    const loadedElements = convertToExcalidrawElements ?
      convertToExcalidrawElements(preparedElements, { regenerateIds: false }) :
      preparedElements;
    
    console.log("[Whiteboard] Loading with files:", Object.keys(loadedFiles).length, "files");
    console.log("[Whiteboard] Loading with elements:", loadedElements.length, "elements (converted)");

    // Listen for external update events (clipboard import + MCP canvas push)
    React.useEffect(() => {
      const handleExternalUpdate = (e: CustomEvent) => {
        if (excalidrawAPI && e.detail) {
          const { elements, files } = e.detail;
          if (elements) {
            // Strip server-only metadata, then run through
            // convertToExcalidrawElements so bound text ↔ container
            // wiring, defaults, and any other internal fields the
            // canvas pipeline expects are populated. Without this the
            // text labels of shape-with-text pairs don't render (the
            // boxes appear empty), because the runtime path doesn't
            // re-derive bidirectional bindings from raw input.
            const incoming = (Array.isArray(elements) ? elements : []).map((el: any) => {
              const { createdAt, updatedAt, syncedAt, source, syncTimestamp, ...clean } = el;
              return clean;
            });
            const prepared = prepareElementsForExcalidraw(incoming);
            const converted = convertToExcalidrawElements
              ? convertToExcalidrawElements(prepared, { regenerateIds: false })
              : prepared;
            const currentElements = excalidrawAPI.getSceneElements() || [];
            excalidrawAPI.updateScene({
              elements: [...currentElements, ...converted],
            });
          }
          if (files && Object.keys(files).length > 0) {
            excalidrawAPI.addFiles(Object.values(files));
          }
        }
      };

      window.addEventListener("excalidraw-update", handleExternalUpdate as EventListener);
      return () => {
        window.removeEventListener("excalidraw-update", handleExternalUpdate as EventListener);
      };
    }, [excalidrawAPIRef]);

    // Use updateScene after mount if we have initial elements
    React.useEffect(() => {
      if (excalidrawAPIRef && loadedElements.length > 0) {
        console.log("[Whiteboard] Using updateScene to load", loadedElements.length, "elements");
        excalidrawAPIRef.updateScene({
          elements: loadedElements,
          appState: appStateConfig,
        });
        // Scroll to content
        excalidrawAPIRef.scrollToContent(undefined, { fitToViewport: true });
      }
    }, [excalidrawAPIRef]);

    return React.createElement(Excalidraw, {
      excalidrawAPI: (api: any) => {
        excalidrawAPI = api;
        setExcalidrawAPI(api);
        console.log("[Whiteboard] Excalidraw API ready, loadedElements:", loadedElements.length);
        // Load elements after API ready (matching Docker canvas pattern exactly)
        if (api && loadedElements.length > 0) {
          console.log("[Whiteboard] Calling updateScene with converted elements");
          api.updateScene({ elements: loadedElements });
        }
      },
      // Start empty, load via updateScene (like Docker canvas)
      initialData: {
        elements: [],
        appState: {
          theme: "light",
          viewBackgroundColor: "#ffffff"
        }
      },
      onChange: (elements: any, appState: any, files: any) => {
        onChange(elements, appState, files);
      },
      langCode: "en",
      UIOptions: {
        canvasActions: {
          loadScene: true,  // Enable load scene for importing
          export: { saveFileToDisk: true },
          saveToActiveFile: false,
        },
      },
    });
  };

  // Mount with createRoot (React 18+)
  if (excalidrawRoot) {
    excalidrawRoot.unmount();
  }

  // Get createRoot from ReactDOMClient (loaded separately from react-dom/client)
  const createRoot = window.ReactDOMClient?.createRoot || window.ReactDOM?.createRoot;
  if (!createRoot) {
    console.error("createRoot not available - React 18+ required");
    container.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: center; height: 100%; color: #e74c3c;">
        <div style="text-align: center;">
          <div style="font-size: 24px; margin-bottom: 8px;">❌</div>
          <div>Failed to mount Excalidraw. createRoot not found.</div>
        </div>
      </div>
    `;
    return;
  }

  excalidrawRoot = createRoot(container);
  excalidrawRoot.render(React.createElement(ExcalidrawWrapper));
}

/**
 * Unmount Excalidraw when leaving the view
 */
export function unmountExcalidraw(): void {
  if (excalidrawRoot) {
    excalidrawRoot.unmount();
    excalidrawRoot = null;
  }
  excalidrawAPI = null;
  currentMountedBoardId = null;
  isInitializing = false;
  if (saveDebounceTimer) {
    clearTimeout(saveDebounceTimer);
    saveDebounceTimer = null;
  }
}

/**
 * Read the current scene from whichever surface has the React canvas
 * mounted right now. Returns [] if no canvas is mounted.
 *
 * Used by the whiteboard controller for "save board" — we used to GET
 * /api/elements from the dead Express server; now we read directly
 * from the in-app React canvas's API.
 */
export function getMountedSceneElements(): unknown[] {
  if (!excalidrawAPI) return [];
  try {
    return excalidrawAPI.getSceneElements() ?? [];
  } catch {
    return [];
  }
}

/**
 * Push elements into whichever surface has the React canvas mounted.
 * If no canvas is mounted, falls back to dispatching the same
 * `excalidraw-update` event the gateway uses — so when a surface
 * eventually mounts, it'll see the scene.
 *
 * Used by the whiteboard controller for "load board" / "load template"
 * / "clear" — replaces the dead-Express HTTP POSTs.
 */
export function pushSceneToMounted(elements: unknown[], files?: Record<string, unknown>): void {
  if (excalidrawAPI) {
    try {
      excalidrawAPI.updateScene({ elements: convertElementsForExcalidraw(elements) });
      if (files && Object.keys(files).length > 0) {
        excalidrawAPI.addFiles(Object.values(files));
      }
      return;
    } catch (err) {
      console.warn("[whiteboard] direct push failed; falling back to event:", err);
    }
  }
  window.dispatchEvent(
    new CustomEvent("excalidraw-update", {
      detail: { elements, files: files ?? {} },
    }),
  );
}

/** Center a freshly loaded scene without forcing the camera on every live edit. */
export function fitMountedScene(): void {
  requestAnimationFrame(() => {
    try {
      excalidrawAPI?.scrollToContent(undefined, {
        fitToViewport: true,
        viewportZoomFactor: 0.82,
      });
    } catch {
      // The route may unmount the canvas between scheduling and execution.
    }
  });
}

/**
 * Mount the MCP-driven Excalidraw canvas into an arbitrary container.
 *
 * Used by canvas-overlay (floating window) and the masonry-grid
 * CanvasGridPanel (dock-tile). Both surfaces show the SAME canvas: the
 * MCP server pushes scene updates via `excalidraw-update` DOM events
 * and any mounted React root applies them.
 *
 * Re-entrant: if the canvas is already mounted somewhere else, that
 * mount is unmounted first and the React root re-renders into the new
 * container. Operators can only have one live React canvas at a time
 * (singleton root); whichever surface called this helper most recently
 * "owns" the canvas. The other surface goes blank until it calls again.
 *
 * Returns a disposer the caller invokes on unmount (close button, view
 * navigation, etc.) so the singleton is freed for the next mount.
 */
export async function mountMcpCanvas(container: HTMLElement): Promise<() => void> {
  console.log("[mountMcpCanvas] start; container size:", container.clientWidth, "x", container.clientHeight);

  // Belt-and-braces: if the container has zero height, force a fallback
  // pixel height so Excalidraw has somewhere to render. The flex chain
  // SHOULD provide height (we set flex:1 on .mcp-canvas-mount in CSS),
  // but if a parent is `display:block` instead of `display:flex` the
  // child won't grow. 600px is a sane minimum for a usable canvas.
  if (container.clientHeight === 0) {
    container.style.height = "70vh";
    container.style.minHeight = "500px";
    console.warn("[mountMcpCanvas] container had height 0; forced fallback height");
  }
  if (container.clientWidth === 0) {
    container.style.width = "100%";
    container.style.minWidth = "600px";
  }

  // Force a clean slate so re-mounting in a different container works
  // even if the previous container was destroyed without calling the
  // returned disposer.
  if (excalidrawRoot) {
    try { excalidrawRoot.unmount(); } catch { /* node detached already */ }
    excalidrawRoot = null;
  }
  excalidrawAPI = null;
  currentMountedBoardId = "mcp-canvas";
  isInitializing = true;

  const loaded = await loadExcalidrawScripts();
  if (!loaded) {
    isInitializing = false;
    console.error("[mountMcpCanvas] loadExcalidrawScripts failed");
    container.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#e74c3c">' +
      '<div style="text-align:center"><div style="font-size:24px;margin-bottom:8px">❌</div>' +
      '<div>Failed to load Excalidraw runtime.</div>' +
      '<div style="font-size:11px;opacity:0.7;margin-top:6px">Check console + network tab for esm.sh blocked</div></div></div>';
    return () => { /* nothing to dispose */ };
  }

  const createRoot = window.ReactDOMClient?.createRoot || window.ReactDOM?.createRoot;
  const React = window.React;
  const ReactDOM = window.ReactDOM;
  const ExcalidrawLib = window.ExcalidrawLib;
  if (!createRoot || !React || !ReactDOM || !ExcalidrawLib) {
    isInitializing = false;
    console.error("[mountMcpCanvas] runtime not on window", {
      hasReact: !!React,
      hasReactDOM: !!ReactDOM,
      hasReactDOMClient: !!window.ReactDOMClient,
      hasExcalidrawLib: !!ExcalidrawLib,
    });
    container.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#e74c3c">' +
      '<div style="text-align:center"><div style="font-size:24px;margin-bottom:8px">❌</div>' +
      '<div>Excalidraw runtime missing on window.</div></div></div>';
    return () => { /* nothing to dispose */ };
  }

  // Inline ExcalidrawWrapper — the one in initExcalidraw lives inside
  // that function's closure (which captures initialData / onChange /
  // boardId), so we can't reuse it here. This minimal wrapper just
  // mounts an empty canvas, exposes the API to module scope, and
  // listens for `excalidraw-update` DOM events broadcast by the gateway
  // when the MCP server pushes scene changes.
  const { Excalidraw } = ExcalidrawLib as { Excalidraw: unknown };
  // Coalesce + queue early updates: if the MCP server pushes a scene
  // before the React Excalidraw component has assigned excalidrawAPI,
  // the update is dropped on the floor (the old listener bailed out
  // when API was null). Keep the latest snapshot pending and replay it
  // when the API arrives. Multiple updates within a single frame
  // collapse to the most recent one — Excalidraw replaces the scene
  // wholesale, so intermediate states aren't observable anyway.
  let pendingScene: { elements: unknown[]; files: Record<string, unknown> } | null = null;
  let pendingTimer: ReturnType<typeof requestAnimationFrame> | null = null;

  const applyPending = (api: unknown) => {
    if (!pendingScene || !api) return;
    const snapshot = pendingScene;
    pendingScene = null;
    pendingTimer = null;
    try {
      if (Array.isArray(snapshot.elements)) {
        (api as { updateScene: (s: { elements: unknown[] }) => void }).updateScene({
          elements: convertElementsForExcalidraw(snapshot.elements),
        });
      }
      if (snapshot.files && Object.keys(snapshot.files).length > 0) {
        (api as { addFiles: (f: unknown[]) => void }).addFiles(Object.values(snapshot.files));
      }
    } catch (err) {
      console.warn("[McpCanvasWrapper] updateScene failed:", err);
    }
  };

  const scheduleApply = () => {
    if (pendingTimer !== null) return;
    pendingTimer = requestAnimationFrame(() => {
      pendingTimer = null;
      if (excalidrawAPI) applyPending(excalidrawAPI);
    });
  };

  const McpCanvasWrapper = () => {
    React.useEffect(() => {
      const handle = (e: Event) => {
        const detail = (e as CustomEvent).detail;
        if (!detail) return;
        // Always merge into pendingScene; the next animation frame (or
        // the API-ready callback, whichever comes first) flushes it.
        // This protects against three races at once:
        //  - update arrives before React mount finishes
        //  - update arrives while the canvas is being re-mounted in
        //    a different surface (overlay → grid panel)
        //  - bursty agent batches that fire 10 updates in the same
        //    tick (last-wins is correct because MCP sends full scenes)
        const prev = pendingScene ?? { elements: [], files: {} };
        pendingScene = {
          elements: Array.isArray(detail.elements) ? detail.elements : prev.elements,
          files:
            detail.files && typeof detail.files === "object"
              ? { ...prev.files, ...detail.files }
              : prev.files,
        };
        scheduleApply();
      };
      window.addEventListener("excalidraw-update", handle);
      return () => {
        window.removeEventListener("excalidraw-update", handle);
        if (pendingTimer !== null) {
          cancelAnimationFrame(pendingTimer);
          pendingTimer = null;
        }
      };
    }, []);

    return React.createElement(Excalidraw as never, {
      excalidrawAPI: (api: unknown) => {
        excalidrawAPI = api;
        console.log("[McpCanvasWrapper] API ready");
        // Flush any updates that arrived before the API was ready.
        if (pendingScene) applyPending(api);
      },
      initialData: {
        elements: [],
        appState: { theme: "light", viewBackgroundColor: "#ffffff" },
      },
      langCode: "en",
      UIOptions: {
        canvasActions: {
          loadScene: true,
          export: { saveFileToDisk: true },
          saveToActiveFile: false,
        },
      },
    });
  };

  excalidrawRoot = createRoot(container);
  excalidrawRoot.render(React.createElement(McpCanvasWrapper));
  isInitializing = false;
  console.log("[mountMcpCanvas] mounted; container size now:", container.clientWidth, "x", container.clientHeight);

  return () => {
    if (excalidrawRoot) {
      try { excalidrawRoot.unmount(); } catch { /* already detached */ }
      excalidrawRoot = null;
    }
    excalidrawAPI = null;
    currentMountedBoardId = null;
  };
}

/**
 * Initialize Excalidraw in a container
 */
export async function initExcalidraw(
  containerId: string,
  boardId: string,
  initialData: any,
  onSave: (data: any) => void,
  onReady: () => void
): Promise<void> {
  // Prevent duplicate initializations
  if (isInitializing || currentMountedBoardId === boardId) {
    return;
  }

  const container = document.getElementById(containerId);
  if (!container) return;

  isInitializing = true;

  // Show loading state
  container.innerHTML = `
    <div style="display: flex; align-items: center; justify-content: center; height: 100%; color: #888;">
      <div style="text-align: center;">
        <div style="font-size: 24px; margin-bottom: 8px;">⏳</div>
        <div>Loading Excalidraw...</div>
      </div>
    </div>
  `;

  const loaded = await loadExcalidrawScripts();
  if (!loaded) {
    isInitializing = false;
    container.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: center; height: 100%; color: #e74c3c;">
        <div style="text-align: center;">
          <div style="font-size: 24px; margin-bottom: 8px;">❌</div>
          <div>Failed to load Excalidraw. Please refresh.</div>
        </div>
      </div>
    `;
    return;
  }

  // Clear container
  container.innerHTML = "";

  // Track initial element count to prevent saving empty canvas on init
  initialElementCount = initialData?.elements?.length || 0;
  hasMadeChanges = false;
  console.log("[Whiteboard] Initial element count:", initialElementCount);

  // Mount Excalidraw with auto-save on change
  mountExcalidraw(container, initialData, (elements, appState, files) => {
    // Debounce save to avoid too many writes
    if (saveDebounceTimer) {
      clearTimeout(saveDebounceTimer);
    }
    
    // Detect if this is a meaningful change (not just initial mount)
    const currentCount = elements?.length || 0;
    if (!hasMadeChanges && currentCount === 0 && initialElementCount > 0) {
      console.log("[Whiteboard] Skipping save - would overwrite data (init:", initialElementCount, "current:", currentCount, ")");
      return; // Don't save empty canvas if we loaded data
    }
    if (currentCount !== initialElementCount) {
      hasMadeChanges = true;
    }
    
    saveDebounceTimer = window.setTimeout(() => {
      // Convert files to plain object (Excalidraw's BinaryFiles might not serialize properly)
      const filesObj: Record<string, any> = {};
      if (files) {
        // Handle both Map-like and plain object formats
        const entries = typeof files.entries === 'function' 
          ? Array.from(files.entries()) 
          : Object.entries(files);
        for (const [key, value] of entries) {
          filesObj[key] = value;
        }
      }

      const data = {
        type: "excalidraw",
        version: 2,
        source: "infinibot-whiteboard",
        elements,
        appState: {
          viewBackgroundColor: appState.viewBackgroundColor,
          gridSize: appState.gridSize,
          theme: "dark",
        },
        files: filesObj,
      };
      onSave(data);
    }, 2000);
  });

  // Mark as initialized
  currentMountedBoardId = boardId;
  isInitializing = false;
  onReady();
}

/**
 * Render the board list (gallery view)
 */
function renderBoardList(props: WhiteboardViewProps): TemplateResult {
  const { state, onLoadBoard, onCreateBoard, onDeleteBoard, onToggleTemplates, onImportFile, onImportClipboard, requestUpdate } = props;

  const handleCreate = async () => {
    const name = prompt("Enter whiteboard name:");
    if (name?.trim()) {
      const id = await onCreateBoard(name.trim());
      if (id) {
        onLoadBoard(id);
      }
    }
  };

  const handleFileImport = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".excalidraw,.json";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        const id = await onImportFile(file);
        if (id) {
          onLoadBoard(id);
        }
      }
    };
    input.click();
  };

  const handleMcpMode = () => {
    state.mcpMode = true;
    state.mcpConnected = false; // Will check on render
    requestUpdate();
  };

  return html`
    <div class="whiteboard-gallery">
      <div class="whiteboard-gallery__header">
        <h2>📋 Whiteboards</h2>
        <div class="whiteboard-gallery__actions">
          <button class="whiteboard-btn whiteboard-btn--primary" @click=${handleMcpMode} title="MCP-controlled canvas for AI drawing">
            🎨 MCP Canvas
          </button>
          <button class="whiteboard-btn" @click=${onToggleTemplates} title="Choose from templates">
            📐 Templates
          </button>
          <button class="whiteboard-btn" @click=${handleFileImport} title="Import .excalidraw file">
            📂 Import
          </button>
          <button class="whiteboard-btn" @click=${onImportClipboard} title="Paste from clipboard">
            📋 Paste
          </button>
          <button class="whiteboard-btn" @click=${handleCreate}>
            ${icons.plus} New Board
          </button>
        </div>
      </div>

      ${state.showTemplatePanel ? renderTemplatePanel(props) : nothing}

      ${state.loading ? html`
        <div class="whiteboard-gallery__loading">
          <div class="spinner"></div>
          <span>Loading whiteboards...</span>
        </div>
      ` : state.boards.length === 0 ? html`
        <div class="whiteboard-gallery__empty">
          <div class="whiteboard-gallery__empty-icon">🎨</div>
          <h3>No whiteboards yet</h3>
          <p>Create your first whiteboard to start sketching ideas!</p>
          <div class="whiteboard-gallery__empty-actions">
            <button class="whiteboard-btn whiteboard-btn--primary" @click=${handleCreate}>
              ${icons.plus} Create Blank
            </button>
            <button class="whiteboard-btn" @click=${onToggleTemplates}>
              📐 From Template
            </button>
            <button class="whiteboard-btn" @click=${handleFileImport}>
              📂 Import File
            </button>
          </div>
        </div>
      ` : html`
        <div class="whiteboard-gallery__grid">
          ${state.boards.map(board => renderBoardCard(board, props))}
        </div>
      `}

      ${state.error ? html`
        <div class="whiteboard-error">${state.error}</div>
      ` : nothing}
    </div>
  `;
}

/**
 * Render the template selection panel
 */
function renderTemplatePanel(props: WhiteboardViewProps): TemplateResult {
  const { state, onToggleTemplates, onApplyTemplate, onLoadBoard } = props;
  
  // Group templates by category
  const categories = new Map<string, WhiteboardTemplate[]>();
  for (const template of state.templates) {
    const cat = template.category || "Other";
    if (!categories.has(cat)) {
      categories.set(cat, []);
    }
    categories.get(cat)!.push(template);
  }

  const handleSelectTemplate = async (template: WhiteboardTemplate) => {
    const name = prompt(`Name for new board (from "${template.name}"):`, template.name);
    if (name?.trim()) {
      const id = await onApplyTemplate(template.id, name.trim());
      if (id) {
        onLoadBoard(id);
      }
    }
  };

  return html`
    <div class="template-panel">
      <div class="template-panel__header">
        <h3>📐 Choose a Template</h3>
        <button class="whiteboard-btn whiteboard-btn--small" @click=${onToggleTemplates}>
          ✕ Close
        </button>
      </div>
      <div class="template-panel__content">
        ${Array.from(categories.entries()).map(([category, templates]) => html`
          <div class="template-category">
            <h4>${category}</h4>
            <div class="template-grid">
              ${templates.map(template => html`
                <div class="template-card" @click=${() => handleSelectTemplate(template)}>
                  <div class="template-card__preview">
                    ${template.id === "blank" ? "⬜" : 
                      template.id === "flowchart" ? "📊" :
                      template.id === "mindmap" ? "🧠" :
                      template.id === "wireframe" ? "📱" :
                      template.id === "kanban" ? "📋" : "📄"}
                  </div>
                  <div class="template-card__info">
                    <div class="template-card__name">${template.name}</div>
                    ${template.description ? html`
                      <div class="template-card__desc">${template.description}</div>
                    ` : nothing}
                  </div>
                </div>
              `)}
            </div>
          </div>
        `)}
      </div>
    </div>
  `;
}

/**
 * Render a board card in the gallery
 */
function renderBoardCard(board: WhiteboardFile, props: WhiteboardViewProps): TemplateResult {
  const { onLoadBoard, onDeleteBoard } = props;

  const handleDelete = (e: Event) => {
    e.stopPropagation();
    if (confirm(`Delete "${board.name}"?`)) {
      onDeleteBoard(board.id);
    }
  };

  return html`
    <div class="whiteboard-card" @click=${() => onLoadBoard(board.id)}>
      <div class="whiteboard-card__preview">
        ${board.thumbnail ? html`
          <img src=${board.thumbnail} alt=${board.name} />
        ` : html`
          <div class="whiteboard-card__placeholder">🎨</div>
        `}
      </div>
      <div class="whiteboard-card__info">
        <div class="whiteboard-card__name">${board.name}</div>
        <div class="whiteboard-card__date">
          ${new Date(board.updatedAt).toLocaleDateString()}
        </div>
      </div>
      <button 
        class="whiteboard-card__delete" 
        @click=${handleDelete}
        title="Delete whiteboard"
      >
        ${icons.trash}
      </button>
    </div>
  `;
}

/**
 * Render the editor view (Excalidraw canvas)
 */
function renderEditor(props: WhiteboardViewProps): TemplateResult {
  const { state, onBack, onSaveBoard, onExport, onSaveAsTemplate, onImportClipboard, requestUpdate } = props;
  const boardId = state.currentBoardId;
  const board = state.boards.find(b => b.id === boardId);

  // Initialize Excalidraw after render (only if not already mounted for this board)
  // IMPORTANT: Wait for data to be loaded before initializing (state.loading must be false)
  const dataReady = !state.loading && (state.currentBoardData !== null || state.error);
  if (boardId && !state.excalidrawLoaded && currentMountedBoardId !== boardId && !isInitializing && dataReady) {
    console.log("[Whiteboard] renderEditor: dataReady, currentBoardData elements:", state.currentBoardData?.elements?.length);
    requestAnimationFrame(() => {
      initExcalidraw(
        "excalidraw-container",
        boardId,
        state.currentBoardData,
        (data) => onSaveBoard(boardId, data, true),
        () => {
          state.excalidrawLoaded = true;
          requestUpdate();
        }
      );
    });
  }

  const handleSaveAsTemplate = async () => {
    const name = prompt("Template name:");
    if (name?.trim()) {
      const success = await onSaveAsTemplate(name.trim());
      if (success) {
        alert("Template saved!");
      }
    }
  };

  const handlePaste = async () => {
    const success = await onImportClipboard();
    if (success) {
      // Reload the board to show pasted elements
      // The excalidraw-update event should handle this
    }
  };

  return html`
    <div class="whiteboard-editor">
      <div class="whiteboard-editor__toolbar">
        <button class="whiteboard-btn" @click=${onBack}>
          ← Back
        </button>
        <div class="whiteboard-editor__title">
          ${board?.name || boardId}
        </div>
        <div class="whiteboard-editor__actions">
          <button class="whiteboard-btn whiteboard-btn--small" @click=${handlePaste} title="Paste from clipboard (Ctrl+V also works)">
            ${icons.copy} Paste
          </button>
          <button class="whiteboard-btn whiteboard-btn--small" @click=${onExport} title="Download as .excalidraw file">
            ${icons.folder} Export
          </button>
          <button class="whiteboard-btn whiteboard-btn--small" @click=${handleSaveAsTemplate} title="Save as reusable template">
            ${icons.fileText} Template
          </button>
        </div>
        <div class="whiteboard-editor__status">
          ${state.saving ? html`
            <span class="saving">Saving...</span>
          ` : html`
            <span class="saved">✓ Saved</span>
          `}
        </div>
      </div>
      <div id="excalidraw-container" class="whiteboard-editor__canvas"></div>
    </div>
  `;
}

/**
 * Main render function for the whiteboard view
 */
export function renderWhiteboard(props: WhiteboardViewProps): TemplateResult {
  const { state } = props;
  const client = props.app?.client ?? null;
  const board = state.currentBoardId
    ? state.boards.find((b) => b.id === state.currentBoardId)
    : null;

  return html`
    ${board && client
      ? html`<doc-agent-panel
          .client=${client}
          docType="whiteboard_doc"
          .documentId=${board.id}
          .title=${board.name ?? board.id}
          .extra=${`Excalidraw scene; elements=${state.currentBoardData?.elements?.length ?? 0}. Use excalidraw_* tools.`}
        ></doc-agent-panel>`
      : nothing}
    <style>
      .whiteboard-gallery {
        padding: 24px;
        max-width: 1400px;
        margin: 0 auto;
      }

      .whiteboard-gallery__header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 24px;
        flex-wrap: wrap;
        gap: 12px;
      }

      .whiteboard-gallery__header h2 {
        margin: 0;
        font-size: 24px;
        font-weight: 600;
      }

      .whiteboard-gallery__actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }

      .whiteboard-gallery__empty-actions {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        justify-content: center;
      }

      .whiteboard-gallery__loading,
      .whiteboard-gallery__empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 64px 24px;
        text-align: center;
        color: #888;
      }

      .whiteboard-gallery__empty-icon {
        font-size: 64px;
        margin-bottom: 16px;
      }

      .whiteboard-gallery__empty h3 {
        margin: 0 0 8px;
        color: #ccc;
      }

      .whiteboard-gallery__empty p {
        margin: 0 0 24px;
      }

      .whiteboard-gallery__grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: 20px;
      }

      .whiteboard-card {
        background: #1a1a2e;
        border: 1px solid #2a2a4e;
        border-radius: 12px;
        overflow: hidden;
        cursor: pointer;
        transition: all 0.2s ease;
        position: relative;
      }

      .whiteboard-card:hover {
        border-color: #4a4a8e;
        transform: translateY(-2px);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
      }

      .whiteboard-card__preview {
        aspect-ratio: 16/10;
        background: #0f0f1a;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
      }

      .whiteboard-card__preview img {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }

      .whiteboard-card__placeholder {
        font-size: 48px;
        opacity: 0.3;
      }

      .whiteboard-card__info {
        padding: 16px;
      }

      .whiteboard-card__name {
        font-weight: 600;
        margin-bottom: 4px;
        color: #fff;
      }

      .whiteboard-card__date {
        font-size: 12px;
        color: #888;
      }

      .whiteboard-card__delete {
        position: absolute;
        top: 8px;
        right: 8px;
        background: rgba(0, 0, 0, 0.7);
        border: none;
        border-radius: 6px;
        padding: 8px;
        cursor: pointer;
        opacity: 0;
        transition: opacity 0.2s;
        color: #e74c3c;
      }

      .whiteboard-card__delete svg {
        width: 16px;
        height: 16px;
        stroke: currentColor;
        fill: none;
        stroke-width: 2;
      }

      .whiteboard-card:hover .whiteboard-card__delete {
        opacity: 1;
      }

      .whiteboard-card__delete:hover {
        background: rgba(231, 76, 60, 0.3);
      }

      .whiteboard-btn {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 10px 20px;
        border: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
        border-radius: 4px;
        background: rgba(20, 20, 30, 0.9);
        color: #e4e4e7;
        font-size: 14px;
        cursor: pointer;
        transition: all 0.2s;
        font-family: 'JetBrains Mono', monospace;
      }

      .whiteboard-btn svg {
        width: 16px;
        height: 16px;
        stroke: currentColor;
        fill: none;
        stroke-width: 2;
      }

      .whiteboard-btn:hover {
        background: color-mix(in srgb, var(--g-primary) 10%, transparent);
        border-color: color-mix(in srgb, var(--g-primary) 50%, transparent);
        color: var(--g-primary);
      }

      .whiteboard-btn--primary {
        background: linear-gradient(135deg, var(--g-primary) 0%, var(--g-primary) 100%);
        border-color: var(--g-primary);
        color: #000;
      }

      .whiteboard-btn--primary:hover {
        background: linear-gradient(135deg, var(--g-primary) 0%, #FDB931 100%);
        border-color: var(--g-primary);
        box-shadow: 0 0 15px color-mix(in srgb, var(--g-primary) 30%, transparent);
      }

      .whiteboard-btn--small {
        padding: 6px 12px;
        font-size: 12px;
      }

      .whiteboard-btn--small svg {
        width: 14px;
        height: 14px;
      }

      .whiteboard-error {
        margin-top: 16px;
        padding: 12px 16px;
        background: rgba(231, 76, 60, 0.1);
        border: 1px solid rgba(231, 76, 60, 0.3);
        border-radius: 8px;
        color: #e74c3c;
      }

      /* Template Panel */
      .template-panel {
        background: #1a1a2e;
        border: 1px solid #3a3a5e;
        border-radius: 12px;
        margin-bottom: 24px;
        overflow: hidden;
      }

      .template-panel__header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 16px 20px;
        background: #0f0f1a;
        border-bottom: 1px solid #2a2a4e;
      }

      .template-panel__header h3 {
        margin: 0;
        font-size: 18px;
        font-weight: 600;
      }

      .template-panel__content {
        padding: 20px;
        max-height: 400px;
        overflow-y: auto;
      }

      .template-category {
        margin-bottom: 20px;
      }

      .template-category:last-child {
        margin-bottom: 0;
      }

      .template-category h4 {
        margin: 0 0 12px;
        font-size: 14px;
        font-weight: 600;
        color: #888;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }

      .template-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
        gap: 12px;
      }

      .template-card {
        background: #0f0f1a;
        border: 1px solid #2a2a4e;
        border-radius: 10px;
        padding: 16px;
        cursor: pointer;
        transition: all 0.2s ease;
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
      }

      .template-card:hover {
        border-color: #6366f1;
        background: #1a1a3e;
        transform: translateY(-2px);
      }

      .template-card__preview {
        font-size: 36px;
        margin-bottom: 12px;
        width: 60px;
        height: 60px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #1a1a2e;
        border-radius: 8px;
      }

      .template-card__info {
        width: 100%;
      }

      .template-card__name {
        font-weight: 600;
        font-size: 14px;
        color: #fff;
        margin-bottom: 4px;
      }

      .template-card__desc {
        font-size: 12px;
        color: #888;
        line-height: 1.3;
      }

      .whiteboard-editor {
        display: flex;
        flex-direction: column;
        height: 100%;
        background: #0f0f1a;
      }

      .whiteboard-editor__toolbar {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 16px;
        background: #1a1a2e;
        border-bottom: 1px solid #2a2a4e;
        flex-wrap: wrap;
      }

      .whiteboard-editor__title {
        flex: 1;
        font-weight: 600;
        font-size: 16px;
        min-width: 100px;
      }

      .whiteboard-editor__actions {
        display: flex;
        gap: 8px;
        align-items: center;
      }

      .whiteboard-editor__status {
        font-size: 12px;
        color: #888;
        margin-left: auto;
      }

      .whiteboard-editor__status .saving {
        color: #f39c12;
      }

      .whiteboard-editor__status .saved {
        color: #2ecc71;
      }

      .whiteboard-editor__canvas {
        flex: 1;
        min-height: 0;
        background: #1a1a2e;
        position: relative;
      }

      /* Prevent flicker during load */
      .whiteboard-editor__canvas > div {
        opacity: 1 !important;
        background: #1a1a2e !important;
      }

      /* Override Excalidraw styles for dark theme */
      .whiteboard-editor__canvas .excalidraw {
        --color-primary: #6366f1;
        --color-surface-high: #1a1a2e;
        --color-surface-low: #0f0f1a;
        --color-surface-lowest: #0f0f1a;
        --color-on-surface: #ffffff;
        --island-bg-color: #1a1a2e;
        background: #1a1a2e !important;
      }

      /* Prevent opacity flicker on Excalidraw elements */
      .whiteboard-editor__canvas .excalidraw,
      .whiteboard-editor__canvas .excalidraw * {
        transition: none !important;
      }

      .whiteboard-editor__canvas .excalidraw .layer-ui__wrapper {
        background: transparent !important;
      }

      .whiteboard-editor__canvas .excalidraw .App-menu,
      .whiteboard-editor__canvas .excalidraw .Island {
        background: #1a1a2e !important;
        border-color: #3a3a5e !important;
        opacity: 1 !important;
      }

      .whiteboard-editor__canvas .excalidraw canvas {
        opacity: 1 !important;
      }

      /* Ensure stable canvas background */
      .whiteboard-editor__canvas .excalidraw .excalidraw__canvas-wrapper {
        background: #121212 !important;
      }

      /* Force dark canvas background on the actual drawing surface */
      .whiteboard-editor__canvas .excalidraw .excalidraw__canvas {
        background: #121212 !important;
      }

      .whiteboard-editor__canvas .excalidraw [class*="canvas"] {
        background: #121212 !important;
      }

      /* Remove any overlay/fade effects */
      .whiteboard-editor__canvas::before,
      .whiteboard-editor__canvas::after {
        display: none !important;
      }

      .whiteboard-editor__canvas .excalidraw .layer-ui__wrapper__top-right,
      .whiteboard-editor__canvas .excalidraw .layer-ui__wrapper__footer {
        opacity: 1 !important;
      }

      .spinner {
        width: 24px;
        height: 24px;
        border: 2px solid #3a3a5e;
        border-top-color: #6366f1;
        border-radius: 50%;
        animation: spin 1s linear infinite;
        margin-bottom: 12px;
      }

      @keyframes spin {
        to { transform: rotate(360deg); }
      }
      /* MCP Canvas styles */
      .mcp-canvas-container {
        display: flex;
        flex-direction: column;
        height: 100%;
        background: transparent;
      }

      .mcp-canvas-toolbar {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 6px 12px;
        background: linear-gradient(180deg, rgba(18, 18, 24, 0.98) 0%, rgba(12, 12, 16, 0.98) 100%);
        border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
        backdrop-filter: blur(12px);
        min-height: 36px;
      }

      .mcp-canvas-toolbar__title {
        font-size: 13px;
        font-weight: 600;
        color: var(--g-primary);
        display: flex;
        align-items: center;
        gap: 6px;
        text-shadow: 0 0 20px color-mix(in srgb, var(--g-primary) 30%, transparent);
      }

      .toolbar-icon, .btn-icon, .header-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }

      .toolbar-icon svg, .btn-icon svg, .header-icon svg {
        width: 14px;
        height: 14px;
        stroke: currentColor;
        stroke-width: 2;
        fill: none;
      }

      .btn-icon svg {
        width: 12px;
        height: 12px;
      }

      .mcp-canvas-toolbar__title .toolbar-icon svg {
        color: var(--g-primary);
        filter: drop-shadow(0 0 4px color-mix(in srgb, var(--g-primary) 40%, transparent));
      }

      .whiteboard-btn .btn-icon svg {
        opacity: 0.7;
      }

      .whiteboard-btn:hover .btn-icon svg {
        opacity: 1;
        color: var(--g-primary);
      }

      .mcp-template-panel__header h3 {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .mcp-template-panel__header .header-icon svg {
        color: var(--g-primary);
      }

      .mcp-canvas-toolbar__status {
        display: flex;
        align-items: center;
        gap: 5px;
        font-size: 11px;
        color: rgba(255, 255, 255, 0.5);
        padding: 3px 8px;
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 255, 255, 0.06);
        border-radius: 4px;
      }

      .mcp-canvas-toolbar__dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        box-shadow: 0 0 6px currentColor;
      }

      .mcp-canvas-toolbar__dot--connected {
        background: #50fa7b;
        box-shadow: 0 0 8px rgba(80, 250, 123, 0.6);
      }

      .mcp-canvas-toolbar__dot--disconnected {
        background: #ff5555;
        box-shadow: 0 0 8px rgba(255, 85, 85, 0.6);
      }

      .mcp-canvas-toolbar__actions {
        margin-left: auto;
        display: flex;
        gap: 6px;
      }

      /* Gold terminal theme buttons */
      .mcp-canvas-toolbar .whiteboard-btn {
        padding: 4px 10px;
        font-size: 11px;
        background: color-mix(in srgb, var(--g-primary) 5%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
        color: rgba(255, 255, 255, 0.7);
        border-radius: 4px;
        transition: all 0.2s ease;
      }

      .mcp-canvas-toolbar .whiteboard-btn:hover {
        background: color-mix(in srgb, var(--g-primary) 12%, transparent);
        border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
        color: var(--g-primary);
        box-shadow: 0 0 12px color-mix(in srgb, var(--g-primary) 15%, transparent);
      }

      .mcp-canvas-toolbar .whiteboard-btn--primary {
        background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 20%, transparent) 0%, color-mix(in srgb, var(--g-primary) 10%, transparent) 100%);
        border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
        color: var(--g-primary);
      }

      .mcp-canvas-toolbar .whiteboard-btn--primary:hover {
        background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 30%, transparent) 0%, color-mix(in srgb, var(--g-primary) 15%, transparent) 100%);
        border-color: color-mix(in srgb, var(--g-primary) 50%, transparent);
        box-shadow: 0 0 16px color-mix(in srgb, var(--g-primary) 25%, transparent);
      }

      .mcp-canvas-toolbar .whiteboard-btn--danger {
        background: rgba(255, 85, 85, 0.08);
        border-color: rgba(255, 85, 85, 0.2);
        color: rgba(255, 85, 85, 0.8);
      }

      .mcp-canvas-toolbar .whiteboard-btn--danger:hover {
        background: rgba(255, 85, 85, 0.15);
        border-color: rgba(255, 85, 85, 0.4);
        color: #ff5555;
        box-shadow: 0 0 12px rgba(255, 85, 85, 0.2);
      }

      .mcp-canvas-iframe {
        flex: 1;
        border: none;
        width: 100%;
        height: 100%;
        background: #ffffff;
      }

      /* The in-app Excalidraw mount target. Matches the iframe's
         flex sizing so the React canvas inherits the wrapper's full
         height — without flex: 1 the div collapses to 0px (the canvas
         renders into nothing and the page looks blank). */
      .mcp-canvas-mount {
        flex: 1;
        width: 100%;
        height: 100%;
        min-height: 0;
        background: #ffffff;
        position: relative;
        overflow: hidden;
      }
      .mcp-canvas-wrapper.has-agent-panel .mcp-canvas-mount {
        width: calc(100% - 380px);
      }
      @media (max-width: 768px) {
        .mcp-canvas-wrapper.has-agent-panel .mcp-canvas-mount {
          width: 100%;
          height: calc(45vh - 48px);
        }
      }

      .mcp-canvas-error {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        color: #888;
        text-align: center;
        padding: 40px;
      }

      .mcp-canvas-error__icon {
        font-size: 48px;
        margin-bottom: 16px;
      }

      .mcp-canvas-error__title {
        font-size: 20px;
        font-weight: 600;
        color: #fff;
        margin-bottom: 8px;
      }

      .mcp-canvas-error__hint {
        margin-top: 16px;
        padding: 12px 16px;
        background: #1a1a2e;
        border-radius: 8px;
        font-family: monospace;
        font-size: 13px;
        color: #888;
      }

      /* MCP Template Panel */
      .mcp-template-panel {
        background: #1a1a2e;
        border-bottom: 1px solid #2a2a4e;
        max-height: 300px;
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }

      .mcp-template-panel__header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 16px;
        background: #0f0f1a;
        border-bottom: 1px solid #2a2a4e;
      }

      .mcp-template-panel__header h3 {
        margin: 0;
        font-size: 16px;
        font-weight: 600;
        color: #fff;
      }

      .mcp-template-panel__content {
        padding: 16px;
        overflow-y: auto;
        flex: 1;
      }

      .mcp-template-category {
        margin-bottom: 16px;
      }

      .mcp-template-category:last-child {
        margin-bottom: 0;
      }

      .mcp-template-category h4 {
        margin: 0 0 10px;
        font-size: 12px;
        font-weight: 600;
        color: #888;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }

      .mcp-template-grid {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }

      .mcp-template-card {
        background: rgba(10, 10, 15, 0.9);
        border: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
        border-radius: 4px;
        padding: 12px 16px;
        cursor: pointer;
        transition: all 0.2s ease;
        display: flex;
        align-items: center;
        gap: 10px;
        min-width: 160px;
      }

      .mcp-template-card:hover {
        border-color: color-mix(in srgb, var(--g-primary) 50%, transparent);
        background: color-mix(in srgb, var(--g-primary) 8%, transparent);
        transform: translateY(-1px);
      }

      .mcp-template-card__icon {
        font-size: 24px;
        width: 36px;
        height: 36px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: color-mix(in srgb, var(--g-primary) 10%, transparent);
        border-radius: 4px;
        color: var(--g-primary);
      }

      .mcp-template-card__name {
        font-weight: 600;
        font-size: 14px;
        color: #fff;
      }

      .mcp-template-card__desc {
        font-size: 11px;
        color: #888;
        margin-top: 2px;
      }

      .whiteboard-btn--active {
        background: color-mix(in srgb, var(--g-primary) 20%, transparent) !important;
        border-color: var(--g-primary) !important;
        color: var(--g-primary) !important;
      }

      .mcp-template-card--active {
        border-color: var(--g-primary) !important;
        background: color-mix(in srgb, var(--g-primary) 15%, transparent) !important;
      }

      .mcp-template-card {
        position: relative;
      }

      .mcp-board-delete {
        position: absolute;
        top: 4px;
        right: 4px;
        background: transparent;
        border: none;
        cursor: pointer;
        opacity: 0;
        transition: opacity 0.2s;
        padding: 4px;
        border-radius: 4px;
        color: #888;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .mcp-board-delete svg {
        width: 14px;
        height: 14px;
        stroke: currentColor;
        stroke-width: 2;
        fill: none;
      }

      .mcp-template-card:hover .mcp-board-delete {
        opacity: 1;
      }

      .mcp-board-delete:hover {
        background: rgba(231, 76, 60, 0.3);
        color: #ef4444;
      }

      /* In-UI Test Runner */
      .wb-test-panel {
        background: rgba(8, 8, 12, 0.97);
        border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
        font-family: 'JetBrains Mono', monospace;
      }
      .wb-test-panel__header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 16px;
        border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 10%, transparent);
        background: rgba(255,255,255,0.02);
      }
      .wb-test-panel__body {
        padding: 8px 0;
        max-height: 260px;
        overflow-y: auto;
      }
      .wb-test-row {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
        padding: 7px 16px;
        font-size: 12px;
        border-left: 2px solid transparent;
      }
      .wb-test-row--pass { border-left-color: #22c55e; background: rgba(34,197,94,0.03); }
      .wb-test-row--fail { border-left-color: #ef4444; background: rgba(239,68,68,0.05); }
      .wb-test-row--running { border-left-color: var(--g-primary); background: color-mix(in srgb, var(--g-primary) 4%, transparent); }
      .wb-test-row--pending { border-left-color: transparent; }
      .wb-test-dot {
        width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
        background: rgba(255,255,255,0.2);
      }
      .wb-test-dot--pass { background: #22c55e; box-shadow: 0 0 6px rgba(34,197,94,0.5); }
      .wb-test-dot--fail { background: #ef4444; box-shadow: 0 0 6px rgba(239,68,68,0.5); }
      .wb-test-dot--running { background: var(--g-primary); animation: wb-pulse 1s ease-in-out infinite; }
      .wb-test-dot--pending { background: rgba(255,255,255,0.15); }
      @keyframes wb-pulse { 0%,100%{opacity:0.4;transform:scale(1)} 50%{opacity:1;transform:scale(1.3)} }
      .wb-test-name { flex: 1; color: rgba(255,255,255,0.8); }
      .wb-test-duration { font-size: 10px; color: rgba(255,255,255,0.3); margin-left: auto; }
      .wb-test-error { width: 100%; font-size: 11px; color: #ef4444; padding: 4px 16px 4px 24px; font-style: italic; }
      .wb-test-spinner { width: 12px; height: 12px; border: 2px solid rgba(255,255,255,0.1); border-top-color: var(--g-primary); border-radius: 50%; animation: spin 0.8s linear infinite; }
    </style>

    ${renderMcpCanvasOnly(props)}
  `;
}

/**
 * UNIFIED MCP Canvas View - Local boards and templates all load into MCP Canvas
 * The grey broken local Excalidraw is deprecated.
 */
let mcpShowPanel: 'none' | 'templates' | 'boards' = 'none';
let mcpBoardsLoaded = false;
// Module-level state for the MCP-driven canvas mount on the /whiteboard
// route. Held outside renderMcpCanvasOnly so the mount survives lit
// re-renders and the disposer can be invoked when the user leaves the
// route or reloads.
const WHITEBOARD_MOUNT_ID = "infinibot-whiteboard-mount";
let whiteboardMountInFlight = false;
let whiteboardCanvasDisposer: (() => void) | null = null;

// --- In-UI Test Runner state ---
let testPanelOpen = false;
let testsRunning = false;
interface TestResult { name: string; status: 'pending' | 'running' | 'pass' | 'fail'; error?: string; duration?: number; }
let testResults: TestResult[] = [];

const WHITEBOARD_TESTS: Array<{ name: string; run: (client?: any) => Promise<void> }> = [
  {
    name: "1. Create element",
    run: async () => {
      const el = { type: "rectangle", x: 50, y: 50, width: 120, height: 70, id: "wb-test-create", strokeColor: "#6366f1", backgroundColor: "#1a1a3e", fillStyle: "solid", roughness: 0, opacity: 100, strokeWidth: 2 };
      pushSceneToMounted([el]);
      await new Promise(r => setTimeout(r, 300));
      const els = getMountedSceneElements() as { id: string }[];
      if (!els.find(e => e.id === "wb-test-create")) throw new Error("Element not found in scene after create");
    },
  },
  {
    name: "2. Update element",
    run: async () => {
      const updated = { type: "rectangle", x: 50, y: 50, width: 120, height: 70, id: "wb-test-create", strokeColor: "#10b981", backgroundColor: "#1a2e2a", fillStyle: "solid", roughness: 0, opacity: 100, strokeWidth: 2 };
      pushSceneToMounted([updated]);
      await new Promise(r => setTimeout(r, 300));
      const els = getMountedSceneElements() as { id: string; strokeColor?: string }[];
      const found = els.find(e => e.id === "wb-test-create");
      if (!found) throw new Error("Element disappeared after update");
      if (found.strokeColor !== "#10b981") throw new Error(`strokeColor not updated: got "${found.strokeColor}"`);
    },
  },
  {
    name: "3. Delete element",
    run: async () => {
      pushSceneToMounted([]);
      await new Promise(r => setTimeout(r, 300));
      const els = getMountedSceneElements() as { id: string }[];
      if (els.find(e => e.id === "wb-test-create")) throw new Error("Element still present after clear");
    },
  },
  {
    name: "4. Query elements (multi-type)",
    run: async () => {
      const batch = [
        { type: "rectangle", x: 100, y: 100, width: 100, height: 60, id: "wb-test-q1", strokeColor: "#6366f1", fillStyle: "solid", roughness: 0, opacity: 100, strokeWidth: 2 },
        { type: "ellipse", x: 280, y: 100, width: 100, height: 60, id: "wb-test-q2", strokeColor: "#f59e0b", fillStyle: "solid", roughness: 0, opacity: 100, strokeWidth: 2 },
      ];
      pushSceneToMounted(batch);
      await new Promise(r => setTimeout(r, 300));
      const els = getMountedSceneElements() as { type: string }[];
      if (!els.find(e => e.type === "rectangle")) throw new Error("No rectangle found");
      if (!els.find(e => e.type === "ellipse")) throw new Error("No ellipse found");
      pushSceneToMounted([]);
    },
  },
  {
    name: "5. Gateway roundtrip",
    run: async (client?: any) => {
      if (!client) throw new Error("No gateway client — open this test from the whiteboard page");
      const el = { type: "rectangle", x: 200, y: 200, width: 100, height: 60, id: "wb-test-gw", strokeColor: "#ec4899", fillStyle: "solid", roughness: 0, opacity: 100, strokeWidth: 2 };
      await client.request("whiteboard.canvas.update", { elements: [el] });
      await new Promise(r => setTimeout(r, 400));
      const els = getMountedSceneElements() as { id: string }[];
      if (!els.find(e => e.id === "wb-test-gw")) throw new Error("Gateway broadcast not received by canvas");
      await client.request("whiteboard.canvas.clear", {});
    },
  },
];

async function runWhiteboardTests(client: any | undefined, requestUpdate: () => void): Promise<void> {
  if (testsRunning) return;
  testsRunning = true;
  testResults = WHITEBOARD_TESTS.map(t => ({ name: t.name, status: "pending" as const }));
  requestUpdate();

  for (let i = 0; i < WHITEBOARD_TESTS.length; i++) {
    testResults[i] = { name: WHITEBOARD_TESTS[i].name, status: "running" };
    requestUpdate();
    const start = Date.now();
    try {
      await WHITEBOARD_TESTS[i].run(client);
      testResults[i] = { name: WHITEBOARD_TESTS[i].name, status: "pass", duration: Date.now() - start };
    } catch (err: unknown) {
      testResults[i] = { name: WHITEBOARD_TESTS[i].name, status: "fail", error: err instanceof Error ? err.message : String(err), duration: Date.now() - start };
    }
    requestUpdate();
  }
  // Cleanup: ensure canvas is clear after all tests
  try { pushSceneToMounted([]); } catch { /* ignore */ }
  testsRunning = false;
  requestUpdate();
}

function renderTestPanel(requestUpdate: () => void, client?: any): TemplateResult {
  const passed = testResults.filter(r => r.status === "pass").length;
  const failed = testResults.filter(r => r.status === "fail").length;
  const total = WHITEBOARD_TESTS.length;
  const allDone = testResults.length > 0 && testResults.every(r => r.status === "pass" || r.status === "fail");

  return html`
    <div class="wb-test-panel">
      <div class="wb-test-panel__header">
        <span style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;color:var(--g-primary)">
          🧪 Whiteboard Tests
          ${allDone ? html`<span style="font-size:11px;color:${failed === 0 ? '#22c55e' : '#ef4444'}">${passed}/${total} passed</span>` : nothing}
        </span>
        <div style="display:flex;gap:8px;align-items:center">
          <button
            class="whiteboard-btn whiteboard-btn--small ${testsRunning ? '' : 'whiteboard-btn--primary'}"
            ?disabled=${testsRunning}
            @click=${() => runWhiteboardTests(client, requestUpdate)}
            style="font-size:11px;padding:4px 12px"
          >${testsRunning ? "Running…" : testResults.length === 0 ? "▶ Run All" : "↺ Re-run"}</button>
          <button class="whiteboard-btn whiteboard-btn--small" @click=${() => { testPanelOpen = false; requestUpdate(); }} style="font-size:11px;padding:4px 8px">${icons.x}</button>
        </div>
      </div>
      <div class="wb-test-panel__body">
        ${testResults.length === 0 ? html`
          <div style="color:rgba(255,255,255,0.35);font-size:12px;padding:12px 16px">
            ${WHITEBOARD_TESTS.map(t => html`
              <div class="wb-test-row wb-test-row--pending">
                <span class="wb-test-dot"></span>
                <span>${t.name}</span>
              </div>
            `)}
          </div>
        ` : testResults.map(r => html`
          <div class="wb-test-row wb-test-row--${r.status}">
            <span class="wb-test-dot wb-test-dot--${r.status}"></span>
            <span class="wb-test-name">${r.name}</span>
            ${r.duration !== undefined ? html`<span class="wb-test-duration">${r.duration}ms</span>` : nothing}
            ${r.status === "running" ? html`<span class="wb-test-spinner"></span>` : nothing}
            ${r.error ? html`<div class="wb-test-error">${r.error}</div>` : nothing}
          </div>
        `)}
      </div>
    </div>
  `;
}

function renderMcpCanvasOnly(props: WhiteboardViewProps): TemplateResult {
  const { state, onLoadList, onDeleteBoard, requestUpdate } = props;

  // The whiteboard now renders the in-app Excalidraw React canvas via
  // mountMcpCanvas. We mount lazily into the wrapper div once it's in
  // the DOM. Two situations trigger a (re-)mount:
  //   1. First render of the route — `mcpConnected` is false.
  //   2. The operator opened a competing surface (overlay / grid panel)
  //      which moved the singleton React root elsewhere and left this
  //      route's container empty. We detect that on every render by
  //      checking whether the container has any child nodes. If empty,
  //      re-mount so navigating back to the route restores the canvas.
  if (!whiteboardMountInFlight) {
    queueMicrotask(() => {
      const container = document.getElementById(WHITEBOARD_MOUNT_ID);
      if (!container) return;
      // If the container has children, the React canvas is already
      // here — skip. (When the canvas moves elsewhere, React's unmount
      // empties the container.)
      if (container.children.length > 0 && state.mcpConnected) return;
      whiteboardMountInFlight = true;
      void mountMcpCanvas(container)
        .then((dispose) => {
          whiteboardCanvasDisposer = dispose;
          state.mcpConnected = true;
          requestUpdate();
        })
        .catch((err) => {
          console.error("[whiteboard] mount failed:", err);
          state.mcpConnected = false;
        })
        .finally(() => {
          whiteboardMountInFlight = false;
        });
    });
  }
  
  // Load boards list if not loaded
  if (!mcpBoardsLoaded && state.boards.length === 0 && !state.loading) {
    mcpBoardsLoaded = true;
    onLoadList();
  }

  const handleRefresh = () => {
    const iframe = document.querySelector('.mcp-canvas-iframe') as HTMLIFrameElement;
    if (iframe) {
      iframe.src = iframe.src;
    }
  };

  const handleOpenExternal = () => {
    window.open(state.mcpCanvasUrl, '_blank');
  };

  const handleToggleTemplates = () => {
    mcpShowPanel = mcpShowPanel === 'templates' ? 'none' : 'templates';
    requestUpdate();
  };

  const handleToggleBoards = () => {
    mcpShowPanel = mcpShowPanel === 'boards' ? 'none' : 'boards';
    if (mcpShowPanel === 'boards') {
      onLoadList(); // Refresh boards list
    }
    requestUpdate();
  };

  const handleSelectTemplate = async (templateId: string) => {
    const app = (props as any).app;
    const success = await loadTemplateToMcpCanvas(state, templateId, requestUpdate, app?.client);
    if (success) {
      mcpShowPanel = 'none';
      state.currentBoardId = null; // Clear current board since we loaded a template
      requestUpdate();
      handleRefresh();
    }
  };

  const handleSelectBoard = async (boardId: string) => {
    // Get the app context from props (we need the client)
    const app = (props as any).app;
    if (app) {
      const success = await loadBoardToMcpCanvas(app, boardId);
      if (success) {
        mcpShowPanel = 'none';
        requestUpdate();
      }
    }
  };

  const handleToggleTests = () => {
    testPanelOpen = !testPanelOpen;
    requestUpdate();
  };

  const handleSaveBoard = async () => {
    const name = prompt("Save canvas as:", state.currentBoardId || "my-drawing");
    if (name?.trim()) {
      const app = (props as any).app;
      if (app) {
        const boardId = await saveMcpCanvasToBoard(app, name.trim());
        if (boardId) {
          alert(`Saved as "${name.trim()}"`);
          mcpShowPanel = 'none';
          requestUpdate();
        }
      }
    }
  };

  const handleDeleteBoard = async (boardId: string, e: Event) => {
    e.stopPropagation();
    if (confirm(`Delete "${boardId}"?`)) {
      onDeleteBoard(boardId);
      if (state.currentBoardId === boardId) {
        state.currentBoardId = null;
      }
      requestUpdate();
    }
  };

  const handleClearCanvas = async () => {
    if (confirm("Clear the entire canvas?")) {
      const app = (props as any).app;
      await clearMcpCanvas(state, app?.client);
      state.currentBoardId = null;
      handleRefresh();
      requestUpdate();
    }
  };

  // Group templates by category
  const templateCategories = new Map<string, typeof BUILTIN_TEMPLATES>();
  for (const template of BUILTIN_TEMPLATES) {
    const cat = template.category || "Other";
    if (!templateCategories.has(cat)) {
      templateCategories.set(cat, []);
    }
    templateCategories.get(cat)!.push(template);
  }

  // Canvas Agent Panel Styles - Injected inline
  const canvasAgentStyles = `
    .canvas-agent-toggle{position:absolute;right:16px;top:60px;width:52px;height:52px;border-radius:14px;border:2px solid color-mix(in srgb, var(--g-primary) 40%, transparent);background:linear-gradient(135deg,rgba(15,15,20,0.95) 0%,rgba(25,25,35,0.95) 100%);color:var(--g-primary);font-size:22px;cursor:pointer;display:flex;align-items:center;justify-content:center;z-index:100;transition:all 0.3s;backdrop-filter:blur(16px);box-shadow:0 4px 20px rgba(0,0,0,0.4),0 0 30px color-mix(in srgb, var(--g-primary) 10%, transparent)}
    .canvas-agent-toggle:hover{border-color:var(--g-primary);transform:scale(1.08);box-shadow:0 6px 30px rgba(0,0,0,0.5),0 0 40px color-mix(in srgb, var(--g-primary) 25%, transparent)}
    .canvas-agent-toggle--closed{animation:agent-pulse 3s ease-in-out infinite}
    @keyframes agent-pulse{0%,100%{box-shadow:0 4px 20px rgba(0,0,0,0.4),0 0 30px color-mix(in srgb, var(--g-primary) 10%, transparent)}50%{box-shadow:0 4px 20px rgba(0,0,0,0.4),0 0 40px color-mix(in srgb, var(--g-primary) 30%, transparent)}}
    .canvas-agent-panel{position:absolute;right:0;top:48px;bottom:0;width:380px;background:linear-gradient(180deg,rgba(8,8,12,0.98) 0%,rgba(12,12,18,0.98) 100%);border-left:1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);display:flex;flex-direction:column;z-index:100;backdrop-filter:blur(24px);font-family:'JetBrains Mono','SF Mono','Consolas',monospace;box-shadow:-8px 0 40px rgba(0,0,0,0.5);animation:agent-slide-in 0.3s ease}
    @keyframes agent-slide-in{from{transform:translateX(100%);opacity:0}to{transform:translateX(0);opacity:1}}
    .canvas-agent-header{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;background:linear-gradient(180deg,color-mix(in srgb, var(--g-primary) 6%, transparent) 0%,transparent 100%);border-bottom:1px solid color-mix(in srgb, var(--g-primary) 12%, transparent)}
    .canvas-agent-header__left{display:flex;align-items:center;gap:12px}
    .canvas-agent-header__icon{width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,color-mix(in srgb, var(--g-primary) 20%, transparent) 0%,color-mix(in srgb, var(--g-primary) 5%, transparent) 100%);border:1px solid color-mix(in srgb, var(--g-primary) 25%, transparent);display:flex;align-items:center;justify-content:center;font-size:18px;box-shadow:0 2px 8px color-mix(in srgb, var(--g-primary) 15%, transparent)}
    .canvas-agent-header__info{display:flex;flex-direction:column;gap:2px}
    .canvas-agent-header__title{font-size:13px;font-weight:700;color:var(--g-primary);letter-spacing:0.03em}
    .canvas-agent-header__subtitle{font-size:10px;color:rgba(255,255,255,0.4);display:flex;align-items:center;gap:6px}
    .canvas-agent-header__led{width:6px;height:6px;border-radius:50%;background:#22c55e;box-shadow:0 0 8px rgba(34,197,94,0.6)}
    .canvas-agent-header__close{width:32px;height:32px;border:1px solid rgba(255,255,255,0.1);border-radius:8px;background:transparent;color:rgba(255,255,255,0.4);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.2s}
    .canvas-agent-header__close:hover{background:rgba(255,255,255,0.05);border-color:color-mix(in srgb, var(--g-primary) 30%, transparent);color:var(--g-primary)}
    .canvas-agent-header__close svg{width:16px;height:16px}
    .canvas-agent-messages{flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:16px}
    .canvas-agent-welcome{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:32px 24px}
    .canvas-agent-welcome__icon{width:80px;height:80px;border-radius:20px;background:linear-gradient(135deg,color-mix(in srgb, var(--g-primary) 15%, transparent) 0%,color-mix(in srgb, var(--g-primary) 5%, transparent) 100%);border:1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);display:flex;align-items:center;justify-content:center;font-size:36px;margin-bottom:16px;box-shadow:0 8px 32px rgba(0,0,0,0.3),0 0 60px color-mix(in srgb, var(--g-primary) 10%, transparent)}
    .canvas-agent-welcome__title{font-size:16px;font-weight:700;color:var(--g-primary);margin-bottom:4px}
    .canvas-agent-welcome__subtitle{font-size:11px;color:rgba(255,255,255,0.35);margin-bottom:28px;font-style:italic}
    .canvas-agent-welcome__hints{display:flex;flex-direction:column;gap:10px;width:100%}
    .canvas-agent-hint{padding:12px 16px;background:color-mix(in srgb, var(--g-primary) 3%, transparent);border:1px solid color-mix(in srgb, var(--g-primary) 8%, transparent);border-radius:10px;font-size:11px;color:rgba(255,255,255,0.5);cursor:pointer;transition:all 0.2s;text-align:left}
    .canvas-agent-hint:hover{background:color-mix(in srgb, var(--g-primary) 8%, transparent);border-color:color-mix(in srgb, var(--g-primary) 20%, transparent);color:var(--g-primary);transform:translateX(4px)}
    .canvas-agent-msg{display:flex;gap:12px;align-items:flex-start;animation:msg-fade-in 0.3s ease}
    @keyframes msg-fade-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
    .canvas-agent-msg--user{flex-direction:row-reverse}
    .canvas-agent-msg__avatar{width:32px;height:32px;border-radius:8px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0}
    .canvas-agent-msg--assistant .canvas-agent-msg__avatar{background:linear-gradient(135deg,color-mix(in srgb, var(--g-primary) 15%, transparent) 0%,color-mix(in srgb, var(--g-primary) 5%, transparent) 100%);border-color:color-mix(in srgb, var(--g-primary) 20%, transparent)}
    .canvas-agent-msg__content{max-width:80%}
    .canvas-agent-msg__text{padding:12px 16px;border-radius:14px;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
    .canvas-agent-msg--user .canvas-agent-msg__text{background:linear-gradient(135deg,color-mix(in srgb, var(--g-primary) 20%, transparent) 0%,color-mix(in srgb, var(--g-primary) 10%, transparent) 100%);color:#fff;border-bottom-right-radius:4px;border:1px solid color-mix(in srgb, var(--g-primary) 15%, transparent)}
    .canvas-agent-msg--assistant .canvas-agent-msg__text{background:rgba(255,255,255,0.03);color:rgba(255,255,255,0.85);border-bottom-left-radius:4px;border:1px solid rgba(255,255,255,0.05)}
    .canvas-agent-typing{display:flex;gap:5px;padding:14px 18px;background:rgba(255,255,255,0.03);border-radius:14px}
    .canvas-agent-typing span{width:7px;height:7px;background:var(--g-primary);border-radius:50%;animation:canvas-typing 1.4s ease-in-out infinite}
    .canvas-agent-typing span:nth-child(2){animation-delay:0.2s}
    .canvas-agent-typing span:nth-child(3){animation-delay:0.4s}
    @keyframes canvas-typing{0%,60%,100%{transform:translateY(0);opacity:0.3}30%{transform:translateY(-6px);opacity:1}}
    .canvas-agent-input-area{display:flex;gap:10px;padding:16px 18px;border-top:1px solid color-mix(in srgb, var(--g-primary) 8%, transparent);background:rgba(0,0,0,0.2)}
    .canvas-agent-input{flex:1;padding:12px 16px;border:1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);border-radius:10px;background:rgba(0,0,0,0.3);color:#fff;font-size:12px;font-family:inherit;outline:none;transition:all 0.2s}
    .canvas-agent-input::placeholder{color:rgba(255,255,255,0.25)}
    .canvas-agent-input:focus{border-color:color-mix(in srgb, var(--g-primary) 50%, transparent);background:rgba(0,0,0,0.4);box-shadow:0 0 0 3px color-mix(in srgb, var(--g-primary) 8%, transparent)}
    .canvas-agent-send{width:44px;height:44px;border:none;border-radius:10px;background:linear-gradient(135deg,var(--g-primary) 0%,#FFA500 100%);color:#000;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.2s;box-shadow:0 2px 12px color-mix(in srgb, var(--g-primary) 30%, transparent)}
    .canvas-agent-send:hover:not(:disabled){transform:scale(1.05);box-shadow:0 4px 20px color-mix(in srgb, var(--g-primary) 40%, transparent)}
    .canvas-agent-send:disabled{background:color-mix(in srgb, var(--g-primary) 20%, transparent);box-shadow:none;cursor:not-allowed}
    .canvas-agent-send svg{width:18px;height:18px}
    .mcp-canvas-wrapper{display:flex;flex:1;position:relative;overflow:hidden;min-height:70vh}
    .mcp-canvas-wrapper.has-agent-panel .mcp-canvas-iframe{width:calc(100% - 380px)}
    @media(max-width:768px){.canvas-agent-panel{width:100%;position:fixed;top:auto;bottom:0;height:55vh;border-left:none;border-top:1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);border-radius:20px 20px 0 0}.mcp-canvas-wrapper.has-agent-panel .mcp-canvas-iframe{width:100%;height:calc(45vh - 48px)}.canvas-agent-toggle{right:12px;top:auto;bottom:12px;width:56px;height:56px}}
  `;

  return html`
    <style>${canvasAgentStyles}</style>
    <div class="mcp-canvas-container">
      <div class="mcp-canvas-toolbar" data-learn-id="whiteboard-toolbar">
        <div class="mcp-canvas-toolbar__title"><span class="toolbar-icon">${icons.penTool}</span> Excalidraw Canvas</div>
        <div class="mcp-canvas-toolbar__status" data-learn-id="whiteboard-status">
          <div class="mcp-canvas-toolbar__dot ${state.mcpConnected ? 'mcp-canvas-toolbar__dot--connected' : 'mcp-canvas-toolbar__dot--disconnected'}"></div>
          <span>${state.mcpConnected ? 'Connected' : 'Disconnected'}</span>
          ${state.currentBoardId ? html`<span style="margin-left: 8px; color: var(--g-primary);">• ${state.currentBoardId}</span>` : nothing}
        </div>
        <div class="mcp-canvas-toolbar__actions">
          <button class="whiteboard-btn whiteboard-btn--small ${mcpShowPanel === 'boards' ? 'whiteboard-btn--active' : ''}" data-learn-id="whiteboard-boards" @click=${handleToggleBoards} title="Load a saved board">
            <span class="btn-icon">${icons.folder}</span> Boards
          </button>
          <button class="whiteboard-btn whiteboard-btn--small ${mcpShowPanel === 'templates' ? 'whiteboard-btn--active' : ''}" data-learn-id="whiteboard-templates" @click=${handleToggleTemplates} title="Load a template">
            <span class="btn-icon">${icons.layout}</span> Templates
          </button>
          <button class="whiteboard-btn whiteboard-btn--small whiteboard-btn--primary" data-learn-id="whiteboard-save" @click=${handleSaveBoard} title="Save current canvas to Boards" style="background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%); border-color: #16a34a;">
            <span class="btn-icon">${icons.save || icons.folder}</span> Save to Boards
          </button>
          <button class="whiteboard-btn whiteboard-btn--small whiteboard-btn--danger" data-learn-id="whiteboard-clear" @click=${handleClearCanvas} title="Clear canvas">
            <span class="btn-icon">${icons.trash}</span> Clear Canvas
          </button>
          <button class="whiteboard-btn whiteboard-btn--small" @click=${handleRefresh} title="Refresh canvas">
            <span class="btn-icon">${icons.refresh}</span>
          </button>
          <button class="whiteboard-btn whiteboard-btn--small" data-learn-id="whiteboard-external" @click=${handleOpenExternal} title="Open in new tab">
            <span class="btn-icon">${icons.globe}</span>
          </button>
          <button class="whiteboard-btn whiteboard-btn--small ${testPanelOpen ? 'whiteboard-btn--active' : ''}" @click=${handleToggleTests} title="Run whiteboard tests">
            🧪 Tests
          </button>
        </div>
      </div>

      ${testPanelOpen ? renderTestPanel(requestUpdate, (props as any).app?.client) : nothing}

      ${mcpShowPanel === 'templates' ? html`
        <div class="mcp-template-panel" data-learn-id="whiteboard-templates-panel">
          <div class="mcp-template-panel__header">
            <h3><span class="header-icon">${icons.layout}</span> Templates</h3>
            <button class="whiteboard-btn whiteboard-btn--small" @click=${handleToggleTemplates}>${icons.x}</button>
          </div>
          <div class="mcp-template-panel__content">
            ${Array.from(templateCategories.entries()).map(([category, templates]) => html`
              <div class="mcp-template-category">
                <h4>${category}</h4>
                <div class="mcp-template-grid">
                  ${templates.map(template => html`
                    <div class="mcp-template-card" @click=${() => handleSelectTemplate(template.id)}>
                      <div class="mcp-template-card__icon">
                        ${template.id === "blank" ? "□" : 
                          template.id === "flowchart" ? "◇" :
                          template.id === "mindmap" ? "◎" :
                          template.id === "wireframe" ? "▢" :
                          template.id === "kanban" ? "▤" : "◈"}
                      </div>
                      <div class="mcp-template-card__name">${template.name}</div>
                    </div>
                  `)}
                </div>
              </div>
            `)}
          </div>
        </div>
      ` : nothing}

      ${mcpShowPanel === 'boards' ? html`
        <div class="mcp-template-panel" data-learn-id="whiteboard-boards-panel">
          <div class="mcp-template-panel__header">
            <h3><span class="header-icon">${icons.folder}</span> Saved Boards</h3>
            <button class="whiteboard-btn whiteboard-btn--small" @click=${handleToggleBoards}>${icons.x}</button>
          </div>
          <div class="mcp-template-panel__content">
            ${state.loading ? html`<div style="text-align: center; padding: 20px; color: #888;">Loading...</div>` :
              state.boards.length === 0 ? html`
                <div style="text-align: center; padding: 20px; color: #888;">
                  <div style="font-size: 32px; margin-bottom: 8px;">—</div>
                  <div>No saved boards yet</div>
                  <div style="font-size: 12px; margin-top: 8px;">Draw something and click Save!</div>
                </div>
              ` : html`
                <div class="mcp-template-grid">
                  ${state.boards.map(board => html`
                    <div class="mcp-template-card ${state.currentBoardId === board.id ? 'mcp-template-card--active' : ''}" @click=${() => handleSelectBoard(board.id)}>
                      <div class="mcp-template-card__icon">◈</div>
                      <div class="mcp-template-card__name">${board.name}</div>
                      <button class="mcp-board-delete" @click=${(e: Event) => handleDeleteBoard(board.id, e)} title="Delete board">${icons.trash}</button>
                    </div>
                  `)}
                </div>
              `}
          </div>
        </div>
      ` : nothing}
      
      <div class="mcp-canvas-wrapper ${canvasAgentPanelOpen ? 'has-agent-panel' : ''}" data-learn-id="whiteboard-canvas">
        <!-- In-app Excalidraw React canvas. mountMcpCanvas attaches once
             this div is in the DOM (see the queueMicrotask above). The
             MCP server (extensions/mcp-excalidraw) drives the scene via
             the gateway's canvas.update broadcast — no Docker needed. -->
        <div
          id="${WHITEBOARD_MOUNT_ID}"
          class="mcp-canvas-mount"
          style="width:100%;height:100%;background:#ffffff"
        ></div>
        <!-- Canvas Agent Chat Panel -->
        ${renderCanvasAgentPanel(props)}
      </div>
    </div>
  `;
}

/**
 * OLD: Render the MCP Canvas mode (iframe to Docker canvas server)
 * @deprecated Use renderMcpCanvasOnly instead
 */
// Track MCP template panel state locally (not in WhiteboardState to avoid type changes)
let mcpShowTemplates = false;

// Canvas Agent chat panel state
let canvasAgentPanelOpen = true;
let canvasAgentMessages: Array<{role: 'user' | 'assistant', content: string, timestamp: number}> = [];
let canvasAgentInput = '';
let canvasAgentLoading = false;
let canvasAgentSessionKey: string | null = null;

function renderMcpCanvas(props: WhiteboardViewProps): TemplateResult {
  const { state, requestUpdate } = props;
  
  // Check connection on first render
  if (!state.mcpConnected) {
    fetch(`${state.mcpCanvasUrl}/health`)
      .then(r => r.json())
      .then(data => {
        if (data.status === "healthy") {
          state.mcpConnected = true;
          requestUpdate();
        }
      })
      .catch(() => {});
  }

  const handleToggleMode = () => {
    state.mcpMode = false;
    mcpShowTemplates = false;
    requestUpdate();
  };

  const handleRefresh = () => {
    const iframe = document.querySelector('.mcp-canvas-iframe') as HTMLIFrameElement;
    if (iframe) {
      iframe.src = iframe.src;
    }
  };

  const handleOpenExternal = () => {
    window.open(state.mcpCanvasUrl, '_blank');
  };

  const handleToggleTemplates = () => {
    mcpShowTemplates = !mcpShowTemplates;
    requestUpdate();
  };

  const handleSelectTemplate = async (templateId: string) => {
    const success = await loadTemplateToMcpCanvas(state, templateId, requestUpdate);
    if (success) {
      mcpShowTemplates = false;
      requestUpdate();
    }
  };

  const handleClearCanvas = async () => {
    if (confirm("Clear the entire canvas?")) {
      await clearMcpCanvas(state);
      handleRefresh();
    }
  };

  // Group templates by category
  const templateCategories = new Map<string, typeof BUILTIN_TEMPLATES>();
  for (const template of BUILTIN_TEMPLATES) {
    const cat = template.category || "Other";
    if (!templateCategories.has(cat)) {
      templateCategories.set(cat, []);
    }
    templateCategories.get(cat)!.push(template);
  }

  return html`
    <div class="mcp-canvas-container">
      <div class="mcp-canvas-toolbar">
        <div class="mcp-canvas-toolbar__title"><span class="toolbar-icon">${icons.penTool}</span> Excalidraw Canvas</div>
        <div class="mcp-canvas-toolbar__status">
          <div class="mcp-canvas-toolbar__dot ${state.mcpConnected ? 'mcp-canvas-toolbar__dot--connected' : 'mcp-canvas-toolbar__dot--disconnected'}"></div>
          <span>${state.mcpConnected ? 'Connected' : 'Disconnected'}</span>
        </div>
        <div class="mcp-canvas-toolbar__actions">
          <button class="whiteboard-btn whiteboard-btn--small ${mcpShowTemplates ? 'whiteboard-btn--active' : ''}" @click=${handleToggleTemplates} title="Load a template">
            <span class="btn-icon">${icons.layout}</span> Templates
          </button>
          <button class="whiteboard-btn whiteboard-btn--small whiteboard-btn--danger" @click=${handleClearCanvas} title="Clear canvas">
            <span class="btn-icon">${icons.trash}</span> Clear Canvas
          </button>
          <button class="whiteboard-btn whiteboard-btn--small" @click=${handleRefresh} title="Refresh canvas">
            <span class="btn-icon">${icons.refresh}</span> Refresh
          </button>
          <button class="whiteboard-btn whiteboard-btn--small" @click=${handleOpenExternal} title="Open in new tab">
            <span class="btn-icon">${icons.globe}</span> External
          </button>
          <button class="whiteboard-btn whiteboard-btn--small" @click=${handleToggleMode} title="Switch to local whiteboards">
            <span class="btn-icon">${icons.folder}</span> Local Boards
          </button>
        </div>
      </div>

      ${mcpShowTemplates ? html`
        <div class="mcp-template-panel">
          <div class="mcp-template-panel__header">
            <h3><span class="header-icon">${icons.layout}</span> Choose a Template</h3>
            <button class="whiteboard-btn whiteboard-btn--small" @click=${handleToggleTemplates}>${icons.x} Close</button>
          </div>
          <div class="mcp-template-panel__content">
            ${Array.from(templateCategories.entries()).map(([category, templates]) => html`
              <div class="mcp-template-category">
                <h4>${category}</h4>
                <div class="mcp-template-grid">
                  ${templates.map(template => html`
                    <div class="mcp-template-card" @click=${() => handleSelectTemplate(template.id)}>
                      <div class="mcp-template-card__icon">
                        ${template.id === "blank" ? "□" : 
                          template.id === "flowchart" ? "◇" :
                          template.id === "mindmap" ? "◎" :
                          template.id === "wireframe" ? "▢" :
                          template.id === "kanban" ? "▤" : "◈"}
                      </div>
                      <div class="mcp-template-card__name">${template.name}</div>
                      ${template.description ? html`<div class="mcp-template-card__desc">${template.description}</div>` : nothing}
                    </div>
                  `)}
                </div>
              </div>
            `)}
          </div>
        </div>
      ` : nothing}
      
      ${state.mcpConnected ? html`
        <iframe 
          class="mcp-canvas-iframe" 
          src="${state.mcpCanvasUrl}"
          allow="clipboard-read; clipboard-write"
        ></iframe>
      ` : html`
        <div class="mcp-canvas-error">
          <div class="mcp-canvas-error__icon">${icons.plug}</div>
          <div class="mcp-canvas-error__title">MCP Canvas Server Not Running</div>
          <p>Start the Docker canvas server to use MCP-controlled drawing.</p>
          <div class="mcp-canvas-error__hint">
            docker start mcp-excalidraw-canvas
          </div>
          <button class="whiteboard-btn whiteboard-btn--primary" style="margin-top: 20px" @click=${() => { state.mcpConnected = false; requestUpdate(); }}>
            <span class="btn-icon">${icons.refresh}</span> Retry Connection
          </button>
          <button class="whiteboard-btn" style="margin-top: 12px" @click=${handleToggleMode}>
            <span class="btn-icon">${icons.folder}</span> Use Local Boards Instead
          </button>
        </div>
      `}
    </div>
  `;
}

/**
 * Render Canvas Agent chat panel
 */
function renderCanvasAgentPanel(props: WhiteboardViewProps): TemplateResult {
  const { requestUpdate } = props;
  const app = (props as any).app;

  const handleTogglePanel = () => {
    canvasAgentPanelOpen = !canvasAgentPanelOpen;
    requestUpdate();
  };

  const handleInputChange = (e: Event) => {
    canvasAgentInput = (e.target as HTMLInputElement).value;
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && canvasAgentInput.trim() && !canvasAgentLoading) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleSendMessage = async () => {
    if (!canvasAgentInput.trim() || canvasAgentLoading || !app?.client) return;
    
    const userMessage = canvasAgentInput.trim();
    canvasAgentInput = '';
    canvasAgentLoading = true;
    
    // Add user message
    canvasAgentMessages = [...canvasAgentMessages, {
      role: 'user',
      content: userMessage,
      timestamp: Date.now()
    }];
    requestUpdate();
    
    try {
      // Use sessions.spawn to create a canvas agent task
      const response = await app.client.request("sessions.spawn", {
        agentId: "canvas",
        task: userMessage,
        label: "Canvas Request",
        cleanup: "keep",
        runTimeoutSeconds: 120
      });
      
      // Spawn returns immediately with status: "accepted"
      if (response?.status === "accepted" && response?.runId) {
        // Show working message with loading indicator
        canvasAgentMessages = [...canvasAgentMessages, {
          role: 'assistant',
          content: `__LOADING__`,
          timestamp: Date.now(),
          isLoading: true,
          runId: response.runId
        }];
        requestUpdate();
        
        // Poll for completion (check every 3 seconds for up to 2 minutes)
        const pollForResult = async () => {
          const maxAttempts = 40;
          for (let i = 0; i < maxAttempts; i++) {
            await new Promise(r => setTimeout(r, 3000));
            try {
              // `sessions.transcript` is the served method (`sessions.history`
              // never existed). It answers `{ ok, turns: [{ role, text }] }`.
              const history = await app.client.request<{
                turns?: Array<{ role?: string; text?: string }>;
              }>("sessions.transcript", {
                sessionKey: response.childSessionKey,
                limit: 5,
              });

              // Check if there's an assistant message (completion)
              const messages = (history?.turns ?? []).map((t) => ({
                role: t.role,
                content: t.text,
              }));
              const assistantMsg = messages.find((m: any) => m.role === 'assistant' && m.content);
              if (assistantMsg) {
                // Update the last message with the actual response
                canvasAgentMessages = canvasAgentMessages.slice(0, -1);
                canvasAgentMessages = [...canvasAgentMessages, {
                  role: 'assistant',
                  content: `✅ ${typeof assistantMsg.content === 'string' ? assistantMsg.content : 'Diagram created! Check the canvas.'}`,
                  timestamp: Date.now()
                }];
                requestUpdate();
                return;
              }
            } catch (e) {
              // Session might not be ready yet, keep polling
            }
          }
          // Timeout - update message
          canvasAgentMessages = canvasAgentMessages.slice(0, -1);
          canvasAgentMessages = [...canvasAgentMessages, {
            role: 'assistant',
            content: `⏱️ Canvas Architect is still working. Check the canvas - your diagram may already be there!`,
            timestamp: Date.now()
          }];
          requestUpdate();
        };
        
        // Start polling in background (don't await)
        pollForResult();
      } else {
        // Unexpected response format
        const assistantContent = response?.result?.reply || response?.reply || 
          "🎨 Request sent to Canvas Architect! The diagram will appear on the canvas shortly.";
        canvasAgentMessages = [...canvasAgentMessages, {
          role: 'assistant',
          content: assistantContent,
          timestamp: Date.now()
        }];
      }
    } catch (err: any) {
      console.error("Canvas Agent spawn error:", err);
      // Show actual error for debugging, with fallback suggestion
      canvasAgentMessages = [...canvasAgentMessages, {
        role: 'assistant',
        content: `⚠️ Canvas Agent unavailable: ${err.message || 'Unknown error'}\n\nTry asking Infini (main chat) instead:\n"Draw a flowchart for ${userMessage.slice(0, 30)}..."`,
        timestamp: Date.now()
      }];
    }
    
    canvasAgentLoading = false;
    requestUpdate();
    
    // Scroll to bottom
    setTimeout(() => {
      const msgContainer = document.querySelector('.canvas-agent-messages');
      if (msgContainer) msgContainer.scrollTop = msgContainer.scrollHeight;
    }, 50);
  };

  if (!canvasAgentPanelOpen) {
    return html`
      <button class="canvas-agent-toggle canvas-agent-toggle--closed" data-learn-id="whiteboard-agent-toggle" @click=${handleTogglePanel} title="Open Canvas Agent">
        🎨
      </button>
    `;
  }

  return html`
    <div class="canvas-agent-panel" data-learn-id="whiteboard-agent-panel">
      <div class="canvas-agent-header">
        <div class="canvas-agent-header__left">
          <div class="canvas-agent-header__icon">🎨</div>
          <div class="canvas-agent-header__info">
            <span class="canvas-agent-header__title">Canvas Architect</span>
            <span class="canvas-agent-header__subtitle">
              <span class="canvas-agent-header__led"></span>
              Diagram specialist online
            </span>
          </div>
        </div>
        <button class="canvas-agent-header__close" @click=${handleTogglePanel} title="Minimize">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
        </button>
      </div>
      
      <div class="canvas-agent-messages">
        ${canvasAgentMessages.length === 0 ? html`
          <div class="canvas-agent-welcome">
            <div class="canvas-agent-welcome__icon">🎨</div>
            <div class="canvas-agent-welcome__title">Canvas Architect</div>
            <div class="canvas-agent-welcome__subtitle">I create beautiful diagrams</div>
            <div class="canvas-agent-welcome__hints" data-learn-id="whiteboard-agent-hints">
              <div class="canvas-agent-hint" @click=${() => { canvasAgentInput = "Draw a flowchart for user login"; requestUpdate(); }}>"Draw a flowchart for user login"</div>
              <div class="canvas-agent-hint" @click=${() => { canvasAgentInput = "Create an architecture diagram"; requestUpdate(); }}>"Create an architecture diagram"</div>
              <div class="canvas-agent-hint" @click=${() => { canvasAgentInput = "Add a database node connected to API"; requestUpdate(); }}>"Add a database node connected to API"</div>
            </div>
          </div>
        ` : canvasAgentMessages.map(msg => html`
          <div class="canvas-agent-msg canvas-agent-msg--${msg.role} ${(msg as any).isLoading ? 'canvas-agent-msg--loading' : ''}">
            <div class="canvas-agent-msg__avatar">
              ${msg.role === 'user' ? '👤' : '🎨'}
            </div>
            <div class="canvas-agent-msg__content">
              ${(msg as any).isLoading ? html`
                <div class="canvas-agent-loading-card">
                  <div class="canvas-agent-loading-animation">
                    <div class="canvas-drawing-icon">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M12 19l7-7 3 3-7 7-3-3z"></path>
                        <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"></path>
                        <path d="M2 2l7.586 7.586"></path>
                        <circle cx="11" cy="11" r="2"></circle>
                      </svg>
                    </div>
                    <div class="canvas-loading-dots">
                      <span></span><span></span><span></span><span></span>
                    </div>
                  </div>
                  <div class="canvas-loading-text">
                    <span class="canvas-loading-title">Canvas Architect is drawing...</span>
                    <span class="canvas-loading-subtitle">Creating your diagram</span>
                  </div>
                  <div class="canvas-loading-progress">
                    <div class="canvas-loading-progress-bar"></div>
                  </div>
                </div>
              ` : html`
                <div class="canvas-agent-msg__text">${msg.content}</div>
              `}
            </div>
          </div>
        `)}
        ${canvasAgentLoading ? html`
          <div class="canvas-agent-msg canvas-agent-msg--assistant">
            <div class="canvas-agent-msg__avatar">🎨</div>
            <div class="canvas-agent-msg__content">
              <div class="canvas-agent-typing">
                <span></span><span></span><span></span>
              </div>
            </div>
          </div>
        ` : nothing}
      </div>
      
      <div class="canvas-agent-input-area">
        <input 
          type="text" 
          class="canvas-agent-input"
          data-learn-id="whiteboard-agent-input"
          placeholder="Describe what to draw..."
          .value=${canvasAgentInput}
          @input=${handleInputChange}
          @keydown=${handleKeyDown}
          ?disabled=${canvasAgentLoading}
        />
        <button 
          class="canvas-agent-send"
          @click=${handleSendMessage}
          ?disabled=${!canvasAgentInput.trim() || canvasAgentLoading}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="22" y1="2" x2="11" y2="13"></line>
            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
          </svg>
        </button>
      </div>
    </div>
  `;
}

// Export whiteboard styles for app.ts
export const whiteboardStyles = `
  /* Whiteboard tab full height */
  [data-tab="whiteboard"] .tab-content {
    height: 100%;
    overflow: hidden;
  }
  
  /* ============================================================
     Canvas Agent Chat Panel - Terminal Grid Matching Style
     ============================================================ */
  
  /* Floating Agent Icon - Top Right */
  .canvas-agent-toggle {
    position: absolute;
    right: 16px;
    top: 60px;
    width: 52px;
    height: 52px;
    border-radius: 14px;
    border: 2px solid color-mix(in srgb, var(--g-primary) 40%, transparent);
    background: linear-gradient(135deg, rgba(15, 15, 20, 0.95) 0%, rgba(25, 25, 35, 0.95) 100%);
    color: var(--g-primary);
    font-size: 22px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    backdrop-filter: blur(16px);
    box-shadow: 
      0 4px 20px rgba(0, 0, 0, 0.4),
      0 0 30px color-mix(in srgb, var(--g-primary) 10%, transparent),
      inset 0 1px 0 rgba(255, 255, 255, 0.05);
  }
  
  .canvas-agent-toggle::before {
    content: '';
    position: absolute;
    inset: -2px;
    border-radius: 16px;
    background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 30%, transparent), transparent 50%);
    z-index: -1;
    opacity: 0;
    transition: opacity 0.3s;
  }
  
  .canvas-agent-toggle:hover {
    border-color: var(--g-primary);
    transform: scale(1.08);
    box-shadow: 
      0 6px 30px rgba(0, 0, 0, 0.5),
      0 0 40px color-mix(in srgb, var(--g-primary) 25%, transparent);
  }
  
  .canvas-agent-toggle:hover::before {
    opacity: 1;
  }
  
  .canvas-agent-toggle--closed {
    animation: agent-pulse 3s ease-in-out infinite;
  }
  
  @keyframes agent-pulse {
    0%, 100% { box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4), 0 0 30px color-mix(in srgb, var(--g-primary) 10%, transparent); }
    50% { box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4), 0 0 40px color-mix(in srgb, var(--g-primary) 30%, transparent); }
  }
  
  /* Main Panel - Expandable Sidebar */
  .canvas-agent-panel {
    position: absolute;
    right: 0;
    top: 48px;
    bottom: 0;
    width: 400px;
    background: linear-gradient(180deg, rgba(8, 8, 12, 0.98) 0%, rgba(12, 12, 18, 0.98) 100%);
    border-left: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
    display: flex;
    flex-direction: column;
    z-index: 100;
    backdrop-filter: blur(24px);
    font-family: 'JetBrains Mono', 'SF Mono', 'Consolas', monospace;
    box-shadow: -8px 0 40px rgba(0, 0, 0, 0.5);
    animation: agent-slide-in 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  }
  
  @keyframes agent-slide-in {
    from { transform: translateX(100%); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }
  
  /* Header with LED indicator */
  .canvas-agent-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 18px;
    background: linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 6%, transparent) 0%, transparent 100%);
    border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 12%, transparent);
    position: relative;
  }
  
  .canvas-agent-header::after {
    content: '';
    position: absolute;
    bottom: 0;
    left: 18px;
    right: 18px;
    height: 1px;
    background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--g-primary) 30%, transparent), transparent);
  }
  
  .canvas-agent-header__left {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  
  .canvas-agent-header__icon {
    width: 36px;
    height: 36px;
    border-radius: 10px;
    background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 20%, transparent) 0%, color-mix(in srgb, var(--g-primary) 5%, transparent) 100%);
    border: 1px solid color-mix(in srgb, var(--g-primary) 25%, transparent);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    box-shadow: 0 2px 8px color-mix(in srgb, var(--g-primary) 15%, transparent);
  }
  
  .canvas-agent-header__info {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  
  .canvas-agent-header__title {
    font-size: 13px;
    font-weight: 700;
    color: var(--g-primary);
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }
  
  .canvas-agent-header__subtitle {
    font-size: 10px;
    color: rgba(255, 255, 255, 0.4);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  
  .canvas-agent-header__led {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #22c55e;
    box-shadow: 0 0 8px rgba(34, 197, 94, 0.6);
    animation: led-blink 2s ease-in-out infinite;
  }
  
  @keyframes led-blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
  
  .canvas-agent-header__close {
    width: 32px;
    height: 32px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    background: transparent;
    color: rgba(255, 255, 255, 0.4);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
  }
  
  .canvas-agent-header__close:hover {
    background: rgba(255, 255, 255, 0.05);
    border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
    color: var(--g-primary);
  }
  
  .canvas-agent-header__close svg {
    width: 16px;
    height: 16px;
  }
  
  /* Messages Area */
  .canvas-agent-messages {
    flex: 1;
    overflow-y: auto;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    scrollbar-width: thin;
    scrollbar-color: color-mix(in srgb, var(--g-primary) 20%, transparent) transparent;
  }
  
  .canvas-agent-messages::-webkit-scrollbar {
    width: 4px;
  }
  
  .canvas-agent-messages::-webkit-scrollbar-track {
    background: transparent;
  }
  
  .canvas-agent-messages::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--g-primary) 20%, transparent);
    border-radius: 2px;
  }
  
  /* Welcome Screen */
  .canvas-agent-welcome {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 32px 24px;
    color: rgba(255, 255, 255, 0.5);
  }
  
  .canvas-agent-welcome__icon {
    width: 80px;
    height: 80px;
    border-radius: 20px;
    background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 15%, transparent) 0%, color-mix(in srgb, var(--g-primary) 5%, transparent) 100%);
    border: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 36px;
    margin-bottom: 16px;
    box-shadow: 
      0 8px 32px rgba(0, 0, 0, 0.3),
      0 0 60px color-mix(in srgb, var(--g-primary) 10%, transparent);
  }
  
  .canvas-agent-welcome__title {
    font-size: 16px;
    font-weight: 700;
    color: var(--g-primary);
    margin-bottom: 4px;
    letter-spacing: 0.05em;
  }
  
  .canvas-agent-welcome__subtitle {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.35);
    margin-bottom: 28px;
    font-style: italic;
  }
  
  .canvas-agent-welcome__hints {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: 100%;
  }
  
  .canvas-agent-hint {
    padding: 12px 16px;
    background: color-mix(in srgb, var(--g-primary) 3%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-primary) 8%, transparent);
    border-radius: 10px;
    font-size: 11px;
    color: rgba(255, 255, 255, 0.5);
    cursor: pointer;
    transition: all 0.2s;
    text-align: left;
    position: relative;
    overflow: hidden;
  }
  
  .canvas-agent-hint::before {
    content: '→';
    position: absolute;
    right: 14px;
    color: color-mix(in srgb, var(--g-primary) 30%, transparent);
    transition: all 0.2s;
  }
  
  .canvas-agent-hint:hover {
    background: color-mix(in srgb, var(--g-primary) 8%, transparent);
    border-color: color-mix(in srgb, var(--g-primary) 20%, transparent);
    color: var(--g-primary);
    transform: translateX(4px);
  }
  
  .canvas-agent-hint:hover::before {
    color: var(--g-primary);
    transform: translateX(4px);
  }
  
  /* Message Bubbles */
  .canvas-agent-msg {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    animation: msg-fade-in 0.3s ease;
  }
  
  @keyframes msg-fade-in {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  
  .canvas-agent-msg--user {
    flex-direction: row-reverse;
  }
  
  .canvas-agent-msg__avatar {
    width: 32px;
    height: 32px;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.08);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    flex-shrink: 0;
  }
  
  .canvas-agent-msg--assistant .canvas-agent-msg__avatar {
    background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 15%, transparent) 0%, color-mix(in srgb, var(--g-primary) 5%, transparent) 100%);
    border-color: color-mix(in srgb, var(--g-primary) 20%, transparent);
  }
  
  .canvas-agent-msg__content {
    max-width: 80%;
  }
  
  .canvas-agent-msg__text {
    padding: 12px 16px;
    border-radius: 14px;
    font-size: 12px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
  }
  
  .canvas-agent-msg--user .canvas-agent-msg__text {
    background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 20%, transparent) 0%, color-mix(in srgb, var(--g-primary) 10%, transparent) 100%);
    color: #fff;
    border-bottom-right-radius: 4px;
    border: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
  }
  
  .canvas-agent-msg--assistant .canvas-agent-msg__text {
    background: rgba(255, 255, 255, 0.03);
    color: rgba(255, 255, 255, 0.85);
    border-bottom-left-radius: 4px;
    border: 1px solid rgba(255, 255, 255, 0.05);
  }
  
  /* Typing Indicator */
  .canvas-agent-typing {
    display: flex;
    gap: 5px;
    padding: 14px 18px;
    background: rgba(255, 255, 255, 0.03);
    border-radius: 14px;
    border-bottom-left-radius: 4px;
  }
  
  .canvas-agent-typing span {
    width: 7px;
    height: 7px;
    background: var(--g-primary);
    border-radius: 50%;
    animation: canvas-typing 1.4s ease-in-out infinite;
  }
  
  .canvas-agent-typing span:nth-child(2) { animation-delay: 0.2s; }
  .canvas-agent-typing span:nth-child(3) { animation-delay: 0.4s; }
  
  @keyframes canvas-typing {
    0%, 60%, 100% { transform: translateY(0); opacity: 0.3; }
    30% { transform: translateY(-6px); opacity: 1; }
  }
  
  /* Loading Card Animation */
  .canvas-agent-loading-card {
    padding: 20px;
    background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 8%, transparent) 0%, color-mix(in srgb, var(--g-primary) 2%, transparent) 100%);
    border: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
    border-radius: 16px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-width: 220px;
  }
  
  .canvas-agent-loading-animation {
    display: flex;
    align-items: center;
    gap: 16px;
  }
  
  .canvas-drawing-icon {
    width: 48px;
    height: 48px;
    background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 20%, transparent) 0%, color-mix(in srgb, var(--g-primary) 5%, transparent) 100%);
    border-radius: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    animation: icon-pulse 2s ease-in-out infinite;
  }
  
  .canvas-drawing-icon svg {
    width: 24px;
    height: 24px;
    stroke: var(--g-primary);
    animation: icon-draw 3s ease-in-out infinite;
  }
  
  @keyframes icon-pulse {
    0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 color-mix(in srgb, var(--g-primary) 30%, transparent); }
    50% { transform: scale(1.05); box-shadow: 0 0 20px 4px color-mix(in srgb, var(--g-primary) 15%, transparent); }
  }
  
  @keyframes icon-draw {
    0%, 100% { transform: rotate(0deg); }
    25% { transform: rotate(-5deg); }
    75% { transform: rotate(5deg); }
  }
  
  .canvas-loading-dots {
    display: flex;
    gap: 6px;
  }
  
  .canvas-loading-dots span {
    width: 10px;
    height: 10px;
    background: linear-gradient(135deg, var(--g-primary) 0%, #FFA500 100%);
    border-radius: 50%;
    animation: loading-dot 1.4s ease-in-out infinite;
    box-shadow: 0 0 8px color-mix(in srgb, var(--g-primary) 40%, transparent);
  }
  
  .canvas-loading-dots span:nth-child(1) { animation-delay: 0s; }
  .canvas-loading-dots span:nth-child(2) { animation-delay: 0.15s; }
  .canvas-loading-dots span:nth-child(3) { animation-delay: 0.3s; }
  .canvas-loading-dots span:nth-child(4) { animation-delay: 0.45s; }
  
  @keyframes loading-dot {
    0%, 80%, 100% { 
      transform: scale(0.6); 
      opacity: 0.3;
    }
    40% { 
      transform: scale(1.2); 
      opacity: 1;
    }
  }
  
  .canvas-loading-text {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  
  .canvas-loading-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--g-primary);
    animation: text-shimmer 2s ease-in-out infinite;
  }
  
  .canvas-loading-subtitle {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.5);
  }
  
  @keyframes text-shimmer {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.7; }
  }
  
  .canvas-loading-progress {
    height: 4px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 2px;
    overflow: hidden;
  }
  
  .canvas-loading-progress-bar {
    height: 100%;
    width: 30%;
    background: linear-gradient(90deg, var(--g-primary), #FFA500, var(--g-primary));
    background-size: 200% 100%;
    border-radius: 2px;
    animation: progress-slide 2s ease-in-out infinite, progress-gradient 1s linear infinite;
  }
  
  @keyframes progress-slide {
    0% { transform: translateX(-100%); width: 30%; }
    50% { width: 60%; }
    100% { transform: translateX(400%); width: 30%; }
  }
  
  @keyframes progress-gradient {
    0% { background-position: 0% 50%; }
    100% { background-position: 200% 50%; }
  }
  
  /* Input Area */
  .canvas-agent-input-area {
    display: flex;
    gap: 10px;
    padding: 16px 18px;
    border-top: 1px solid color-mix(in srgb, var(--g-primary) 8%, transparent);
    background: rgba(0, 0, 0, 0.2);
  }
  
  .canvas-agent-input {
    flex: 1;
    padding: 12px 16px;
    border: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
    border-radius: 10px;
    background: rgba(0, 0, 0, 0.3);
    color: #fff;
    font-size: 12px;
    font-family: inherit;
    outline: none;
    transition: all 0.2s;
  }
  
  .canvas-agent-input::placeholder {
    color: rgba(255, 255, 255, 0.25);
  }
  
  .canvas-agent-input:focus {
    border-color: color-mix(in srgb, var(--g-primary) 50%, transparent);
    background: rgba(0, 0, 0, 0.4);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--g-primary) 8%, transparent);
  }
  
  .canvas-agent-send {
    width: 44px;
    height: 44px;
    border: none;
    border-radius: 10px;
    background: linear-gradient(135deg, var(--g-primary) 0%, #FFA500 100%);
    color: #000;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
    box-shadow: 0 2px 12px color-mix(in srgb, var(--g-primary) 30%, transparent);
  }
  
  .canvas-agent-send:hover:not(:disabled) {
    transform: scale(1.05);
    box-shadow: 0 4px 20px color-mix(in srgb, var(--g-primary) 40%, transparent);
  }
  
  .canvas-agent-send:active:not(:disabled) {
    transform: scale(0.98);
  }
  
  .canvas-agent-send:disabled {
    background: color-mix(in srgb, var(--g-primary) 20%, transparent);
    box-shadow: none;
    cursor: not-allowed;
  }
  
  .canvas-agent-send svg {
    width: 18px;
    height: 18px;
  }
  
  /* Adjust MCP canvas container when agent panel is open */
  .mcp-canvas-container:has(.canvas-agent-panel) .mcp-canvas-iframe {
    width: calc(100% - 400px);
    transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  }
  
  .mcp-canvas-container:has(.canvas-agent-toggle--closed) .mcp-canvas-iframe {
    width: 100%;
    transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  }
  
  /* Mobile responsive */
  @media (max-width: 900px) {
    .canvas-agent-panel {
      width: 340px;
    }
    
    .mcp-canvas-container:has(.canvas-agent-panel) .mcp-canvas-iframe {
      width: calc(100% - 340px);
    }
  }
  
  @media (max-width: 768px) {
    .canvas-agent-panel {
      width: 100%;
      position: fixed;
      top: auto;
      bottom: 0;
      height: 55vh;
      border-left: none;
      border-top: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
      border-radius: 20px 20px 0 0;
      animation: agent-slide-up 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }
    
    @keyframes agent-slide-up {
      from { transform: translateY(100%); }
      to { transform: translateY(0); }
    }
    
    .mcp-canvas-container:has(.canvas-agent-panel) .mcp-canvas-iframe {
      width: 100%;
      height: calc(45vh - 48px);
    }
    
    .canvas-agent-toggle {
      right: 12px;
      top: auto;
      bottom: 12px;
      width: 56px;
      height: 56px;
      font-size: 24px;
    }
  }
`;
