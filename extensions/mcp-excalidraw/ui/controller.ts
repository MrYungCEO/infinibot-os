/**
 * Whiteboard Controller
 * Manages state for the Excalidraw-based whiteboard feature
 * Enhanced with reliable copy/paste and template loading
 */

import type { GatewayBrowserClient } from "../../../ui/src/ui/gateway";

export interface WhiteboardFile {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  thumbnail?: string;
}

export interface WhiteboardTemplate {
  id: string;
  name: string;
  description?: string;
  category: string;
  data: any;
}

export interface WhiteboardState {
  loading: boolean;
  error: string | null;
  boards: WhiteboardFile[];
  currentBoardId: string | null;
  currentBoardData: any | null;
  saving: boolean;
  excalidrawLoaded: boolean;
  templates: WhiteboardTemplate[];
  templatesLoaded: boolean;
  showTemplatePanel: boolean;
  clipboardSupported: boolean;
  // MCP Canvas integration
  mcpMode: boolean;
  mcpCanvasUrl: string;
  mcpConnected: boolean;
}

export function createWhiteboardState(): WhiteboardState {
  return {
    loading: false,
    error: null,
    boards: [],
    currentBoardId: null,
    currentBoardData: null,
    saving: false,
    excalidrawLoaded: false,
    templates: [],
    templatesLoaded: false,
    showTemplatePanel: false,
    clipboardSupported: typeof navigator?.clipboard?.readText === "function",
    // MCP Canvas - default to MCP mode for AI-controlled canvas
    mcpMode: true,
    // Kept for backward-compat with persisted state. The canvas now
    // lives in the React bundle; this URL is no longer fetched.
    mcpCanvasUrl: "",
    mcpConnected: false,
  };
}

/**
 * Toggle between MCP Canvas mode and local whiteboard mode
 */
export function toggleMcpMode(state: { whiteboardState: WhiteboardState | null }, requestUpdate: () => void): void {
  if (!state.whiteboardState) return;
  state.whiteboardState.mcpMode = !state.whiteboardState.mcpMode;
  requestUpdate();
}

/**
 * "Is the canvas available?" check.
 *
 * The dead Express server at localhost:3000 is gone — the canvas now
 * lives in the React bundle. The bundle is always present once the
 * Control UI loads, so this returns true unconditionally and exists
 * only for backward-compat with callers that still poll for state.
 *
 * The actual mount status is tracked in the whiteboard view itself
 * (`whiteboardCanvasDisposer`) and surfaced to the operator via the
 * surface-specific `isLoading` / `isConnected` flags.
 */
export async function checkMcpConnection(state: { whiteboardState: WhiteboardState | null }, requestUpdate: () => void): Promise<boolean> {
  if (!state.whiteboardState) return false;
  state.whiteboardState.mcpConnected = true;
  requestUpdate();
  return true;
}

// Built-in templates
const BUILTIN_TEMPLATES: WhiteboardTemplate[] = [
  {
    id: "blank",
    name: "Blank Canvas",
    description: "Start with a clean slate",
    category: "Basic",
    data: {
      type: "excalidraw",
      version: 2,
      source: "infinibot-template",
      elements: [],
      appState: { viewBackgroundColor: "#121212", theme: "dark" },
      files: {},
    },
  },
  {
    id: "flowchart",
    name: "Flowchart",
    description: "Basic flowchart structure",
    category: "Diagrams",
    data: {
      type: "excalidraw",
      version: 2,
      source: "infinibot-template",
      elements: [
        { type: "rectangle", x: 200, y: 100, width: 150, height: 60, strokeColor: "#6366f1", backgroundColor: "#1a1a3e", fillStyle: "solid", id: "start", roughness: 0 },
        { type: "text", x: 230, y: 120, text: "Start", fontSize: 20, fontFamily: 1, id: "start-text" },
        { type: "arrow", x: 275, y: 160, width: 0, height: 60, strokeColor: "#6366f1", id: "arrow1" },
        { type: "rectangle", x: 200, y: 230, width: 150, height: 60, strokeColor: "#6366f1", backgroundColor: "#1a1a3e", fillStyle: "solid", id: "process", roughness: 0 },
        { type: "text", x: 220, y: 250, text: "Process", fontSize: 20, fontFamily: 1, id: "process-text" },
        { type: "arrow", x: 275, y: 290, width: 0, height: 60, strokeColor: "#6366f1", id: "arrow2" },
        { type: "diamond", x: 200, y: 360, width: 150, height: 80, strokeColor: "#f59e0b", backgroundColor: "#2a2a1e", fillStyle: "solid", id: "decision", roughness: 0 },
        { type: "text", x: 230, y: 390, text: "Decision", fontSize: 18, fontFamily: 1, id: "decision-text" },
      ],
      appState: { viewBackgroundColor: "#121212", theme: "dark" },
      files: {},
    },
  },
  {
    id: "mindmap",
    name: "Mind Map",
    description: "Central idea with branches",
    category: "Brainstorming",
    data: {
      type: "excalidraw",
      version: 2,
      source: "infinibot-template",
      elements: [
        { type: "ellipse", x: 350, y: 250, width: 200, height: 100, strokeColor: "#6366f1", backgroundColor: "#1a1a3e", fillStyle: "solid", id: "center", roughness: 0 },
        { type: "text", x: 400, y: 285, text: "Main Idea", fontSize: 24, fontFamily: 1, id: "center-text" },
        { type: "line", x: 450, y: 250, width: -150, height: -100, strokeColor: "#6366f1", id: "branch1" },
        { type: "ellipse", x: 200, y: 100, width: 120, height: 60, strokeColor: "#10b981", backgroundColor: "#1a2e2a", fillStyle: "solid", id: "node1", roughness: 0 },
        { type: "text", x: 225, y: 120, text: "Topic 1", fontSize: 16, fontFamily: 1, id: "node1-text" },
        { type: "line", x: 450, y: 250, width: 150, height: -100, strokeColor: "#6366f1", id: "branch2" },
        { type: "ellipse", x: 530, y: 100, width: 120, height: 60, strokeColor: "#f59e0b", backgroundColor: "#2a2a1e", fillStyle: "solid", id: "node2", roughness: 0 },
        { type: "text", x: 555, y: 120, text: "Topic 2", fontSize: 16, fontFamily: 1, id: "node2-text" },
        { type: "line", x: 450, y: 350, width: -150, height: 100, strokeColor: "#6366f1", id: "branch3" },
        { type: "ellipse", x: 200, y: 400, width: 120, height: 60, strokeColor: "#ec4899", backgroundColor: "#2a1a2a", fillStyle: "solid", id: "node3", roughness: 0 },
        { type: "text", x: 225, y: 420, text: "Topic 3", fontSize: 16, fontFamily: 1, id: "node3-text" },
        { type: "line", x: 450, y: 350, width: 150, height: 100, strokeColor: "#6366f1", id: "branch4" },
        { type: "ellipse", x: 530, y: 400, width: 120, height: 60, strokeColor: "#3b82f6", backgroundColor: "#1a1a3e", fillStyle: "solid", id: "node4", roughness: 0 },
        { type: "text", x: 555, y: 420, text: "Topic 4", fontSize: 16, fontFamily: 1, id: "node4-text" },
      ],
      appState: { viewBackgroundColor: "#121212", theme: "dark" },
      files: {},
    },
  },
  {
    id: "wireframe",
    name: "Wireframe",
    description: "Basic UI wireframe layout",
    category: "Design",
    data: {
      type: "excalidraw",
      version: 2,
      source: "infinibot-template",
      elements: [
        { type: "rectangle", x: 100, y: 50, width: 600, height: 500, strokeColor: "#6366f1", backgroundColor: "transparent", fillStyle: "solid", id: "frame", roughness: 0 },
        { type: "rectangle", x: 100, y: 50, width: 600, height: 60, strokeColor: "#6366f1", backgroundColor: "#1a1a3e", fillStyle: "solid", id: "header", roughness: 0 },
        { type: "text", x: 120, y: 70, text: "Header / Navigation", fontSize: 18, fontFamily: 1, id: "header-text" },
        { type: "rectangle", x: 100, y: 120, width: 150, height: 430, strokeColor: "#6366f1", backgroundColor: "#0f0f1a", fillStyle: "solid", id: "sidebar", roughness: 0 },
        { type: "text", x: 130, y: 150, text: "Sidebar", fontSize: 16, fontFamily: 1, id: "sidebar-text" },
        { type: "rectangle", x: 260, y: 120, width: 440, height: 350, strokeColor: "#6366f1", backgroundColor: "transparent", fillStyle: "solid", id: "content", roughness: 0 },
        { type: "text", x: 420, y: 280, text: "Main Content", fontSize: 20, fontFamily: 1, id: "content-text" },
        { type: "rectangle", x: 260, y: 480, width: 440, height: 70, strokeColor: "#6366f1", backgroundColor: "#1a1a3e", fillStyle: "solid", id: "footer", roughness: 0 },
        { type: "text", x: 430, y: 505, text: "Footer", fontSize: 16, fontFamily: 1, id: "footer-text" },
      ],
      appState: { viewBackgroundColor: "#121212", theme: "dark" },
      files: {},
    },
  },
  {
    id: "kanban",
    name: "Kanban Board",
    description: "Task board with columns",
    category: "Project Management",
    data: {
      type: "excalidraw",
      version: 2,
      source: "infinibot-template",
      elements: [
        { type: "rectangle", x: 50, y: 50, width: 200, height: 400, strokeColor: "#6366f1", backgroundColor: "#1a1a3e", fillStyle: "solid", id: "col1", roughness: 0 },
        { type: "text", x: 110, y: 70, text: "To Do", fontSize: 20, fontFamily: 1, id: "col1-title" },
        { type: "rectangle", x: 70, y: 110, width: 160, height: 50, strokeColor: "#3b82f6", backgroundColor: "#0f0f1a", fillStyle: "solid", id: "task1", roughness: 0 },
        { type: "text", x: 90, y: 125, text: "Task 1", fontSize: 14, fontFamily: 1, id: "task1-text" },
        { type: "rectangle", x: 70, y: 170, width: 160, height: 50, strokeColor: "#3b82f6", backgroundColor: "#0f0f1a", fillStyle: "solid", id: "task2", roughness: 0 },
        { type: "text", x: 90, y: 185, text: "Task 2", fontSize: 14, fontFamily: 1, id: "task2-text" },
        { type: "rectangle", x: 270, y: 50, width: 200, height: 400, strokeColor: "#f59e0b", backgroundColor: "#2a2a1e", fillStyle: "solid", id: "col2", roughness: 0 },
        { type: "text", x: 310, y: 70, text: "In Progress", fontSize: 20, fontFamily: 1, id: "col2-title" },
        { type: "rectangle", x: 290, y: 110, width: 160, height: 50, strokeColor: "#f59e0b", backgroundColor: "#0f0f1a", fillStyle: "solid", id: "task3", roughness: 0 },
        { type: "text", x: 310, y: 125, text: "Task 3", fontSize: 14, fontFamily: 1, id: "task3-text" },
        { type: "rectangle", x: 490, y: 50, width: 200, height: 400, strokeColor: "#10b981", backgroundColor: "#1a2e2a", fillStyle: "solid", id: "col3", roughness: 0 },
        { type: "text", x: 555, y: 70, text: "Done", fontSize: 20, fontFamily: 1, id: "col3-title" },
        { type: "rectangle", x: 510, y: 110, width: 160, height: 50, strokeColor: "#10b981", backgroundColor: "#0f0f1a", fillStyle: "solid", id: "task4", roughness: 0 },
        { type: "text", x: 530, y: 125, text: "Task 4 ✓", fontSize: 14, fontFamily: 1, id: "task4-text" },
      ],
      appState: { viewBackgroundColor: "#121212", theme: "dark" },
      files: {},
    },
  },
];

export { BUILTIN_TEMPLATES };

/**
 * Load a local board file INTO the MCP Canvas (not the broken local Excalidraw)
 */
export async function loadBoardToMcpCanvas(
  app: { client: GatewayBrowserClient | null; whiteboardState: WhiteboardState | null; requestUpdate?: () => void },
  boardId: string
): Promise<boolean> {
  if (!app.client || !app.whiteboardState) return false;
  
  const state = app.whiteboardState;
  
  try {
    // Read the local board file
    const res = await app.client.request("whiteboard.boards.get", { id: boardId }) as { data?: any };
    if (!res?.data) {
      console.error("No content in board file");
      return false;
    }
    
    const boardData = res.data;
    const elements = boardData.elements || [];
    
    if (elements.length === 0) {
      console.log("Board has no elements - keeping canvas as-is");
      // DON'T clear - preserve existing canvas content
      // The user might have drawn directly on the canvas
    } else {
      const cleanedElements = elements.map((el: any) => ({
        ...el,
        fillStyle: el.fillStyle || "solid",
        roughness: el.roughness ?? 0,
        opacity: el.opacity ?? 100,
        strokeWidth: el.strokeWidth ?? 2,
      }));

      // Push to whichever surface has the React canvas mounted (the
      // helper falls back to the excalidraw-update event if nothing's
      // mounted yet).
      const wb = await import("./whiteboard");
      wb.pushSceneToMounted(cleanedElements, boardData.files);
      wb.fitMountedScene();

      // Also broadcast through the gateway so the MCP server's canvas
      // state stays in sync with what the operator just loaded — agent
      // edits won't clobber the loaded board next time it appends.
      try {
        await app.client.request("whiteboard.canvas.update", { elements: cleanedElements });
      } catch (err) {
        console.warn("[whiteboard] canvas.update broadcast failed:", err);
      }
    }

    // Update state to show we're viewing this board
    state.currentBoardId = boardId;
    app.requestUpdate?.();
    return true;
  } catch (err) {
    console.error("Error loading board:", err);
    return false;
  }
}

/**
 * Save current MCP Canvas to a local board file
 */
export async function saveMcpCanvasToBoard(
  app: { client: GatewayBrowserClient | null; whiteboardState: WhiteboardState | null; requestUpdate?: () => void },
  boardName: string
): Promise<string | null> {
  if (!app.client || !app.whiteboardState) return null;
  
  const state = app.whiteboardState;
  
  try {
    // Read the current scene directly from the in-app React canvas.
    // The dead Express server's GET /api/elements is gone; the live
    // mount is the source of truth for "what does the operator see
    // right now."
    const wb = await import("./whiteboard");
    const elements = wb.getMountedSceneElements();

    if (!Array.isArray(elements)) {
      console.error("Failed to read elements from mounted canvas");
      return null;
    }

    // Create the board data
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
    
    // Generate board ID from name
    const boardId = boardName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    
    await app.client.request("whiteboard.boards.save", { id: boardId, data: boardData });
    
    // Update state
    state.currentBoardId = boardId;
    
    // Reload board list
    const res = await app.client.request("whiteboard.boards.list", {}) as { boards?: WhiteboardFile[] };
    state.boards = res?.boards ?? [];
    
    app.requestUpdate?.();
    return boardId;
  } catch (err) {
    console.error("Error saving MCP Canvas to board:", err);
    return null;
  }
}

/**
 * Load a template into the MCP Canvas server
 */
export async function loadTemplateToMcpCanvas(
  state: WhiteboardState,
  templateId: string,
  requestUpdate: () => void,
  client?: GatewayBrowserClient | null,
): Promise<boolean> {
  const template = BUILTIN_TEMPLATES.find(t => t.id === templateId);
  if (!template) return false;

  try {
    const wb = await import("./whiteboard");
    const elements = (template.data.elements ?? []).map((el: any) => ({
      ...el,
      fillStyle: el.fillStyle || "solid",
      roughness: el.roughness ?? 0,
      opacity: el.opacity ?? 100,
      strokeWidth: el.strokeWidth ?? 2,
    }));

    // Push directly to the mounted React canvas — instant feedback
    // for the operator without round-tripping through the gateway.
    wb.pushSceneToMounted(elements);
    wb.fitMountedScene();

    // Also broadcast through the gateway so the MCP server's canvas
    // state matches what the operator just loaded — agent edits won't
    // clobber the loaded template on the next canvas.update.
    const c = client ?? (window as any).__infinibotGatewayClient ?? null;
    if (c) {
      try {
        await c.request("whiteboard.canvas.update", { elements });
      } catch (err) {
        console.warn("[whiteboard] canvas.update broadcast failed:", err);
      }
    }

    requestUpdate();
    return true;
  } catch (err) {
    console.error("Error loading template:", err);
    return false;
  }
}

/**
 * Clear the canvas everywhere it's visible AND wipe the MCP server's
 * in-memory scene so the next agent edit starts from an empty board.
 *
 * Local-first: empty the React canvas immediately so the operator sees
 * the result without waiting for a network round-trip. Then broadcast
 * canvas.clear so the MCP server (extensions/mcp-excalidraw) drops its
 * cached elements too.
 */
export async function clearMcpCanvas(
  _state: WhiteboardState,
  client?: GatewayBrowserClient | null,
): Promise<boolean> {
  try {
    const wb = await import("./whiteboard");
    wb.pushSceneToMounted([]);
    const c = client ?? (window as any).__infinibotGatewayClient ?? null;
    if (c) {
      try {
        await c.request("whiteboard.canvas.clear", {});
      } catch (err) {
        console.warn("[whiteboard] canvas.clear broadcast failed:", err);
      }
    }
    return true;
  } catch {
    return false;
  }
}

interface AppState {
  client: GatewayBrowserClient | null;
  whiteboardState: WhiteboardState | null;
  requestUpdate?: () => void;
}

/**
 * Load the list of whiteboard files
 */
export async function loadWhiteboardList(app: AppState): Promise<void> {
  if (!app.client || !app.whiteboardState) return;

  const state = app.whiteboardState;
  state.loading = true;
  state.error = null;
  app.requestUpdate?.();

  try {
    const res = await app.client.request("whiteboard.boards.list", {}) as { boards?: WhiteboardFile[] };
    state.boards = res?.boards ?? [];
    state.loading = false;
  } catch (err) {
    state.boards = [];
    state.loading = false;
    state.error = `Failed to load whiteboards: ${err}`;
  }
  app.requestUpdate?.();
}

/**
 * Load a specific whiteboard
 */
export async function loadWhiteboard(app: AppState, boardId: string): Promise<void> {
  if (!app.client || !app.whiteboardState) return;

  const state = app.whiteboardState;
  state.loading = true;
  state.error = null;
  state.currentBoardId = boardId;
  app.requestUpdate?.();

  try {
    const res = await app.client.request("whiteboard.boards.get", { id: boardId }) as { data?: any };
    if (res?.data) {
      state.currentBoardData = res.data;
      loadedElementCount = state.currentBoardData?.elements?.length || 0;
      console.log("[Whiteboard] Parsed data, elements:", loadedElementCount, "- set loadedElementCount");
    } else {
      console.log("[Whiteboard] No content in response");
      state.currentBoardData = null;
      loadedElementCount = 0;
    }
    state.loading = false;
  } catch (err) {
    console.error("[Whiteboard] Load error:", err);
    state.error = `Failed to load whiteboard: ${err}`;
    state.loading = false;
    state.currentBoardData = null;
  }
  app.requestUpdate?.();
}

// Track loaded element count to prevent overwriting with empty data
let loadedElementCount = 0;

/**
 * Save the current whiteboard
 */
export async function saveWhiteboard(
  app: AppState, 
  boardId: string, 
  data: any,
  silent = false
): Promise<boolean> {
  if (!app.client || !app.whiteboardState) return false;

  const state = app.whiteboardState;
  
  // Guard: Don't save empty data if we had loaded elements (prevents overwrite on init)
  const newElementCount = data?.elements?.length || 0;
  if (newElementCount === 0 && loadedElementCount > 0) {
    console.log("[Whiteboard] BLOCKED save - would overwrite", loadedElementCount, "elements with empty data");
    return false;
  }
  
  if (!silent) {
    state.saving = true;
    app.requestUpdate?.();
  }

  try {
    await app.client.request("whiteboard.boards.save", { id: boardId, data });

    if (!silent) {
      state.saving = false;
    }
    state.currentBoardData = data;
    
    // Update the boards list
    const existingBoard = state.boards.find(b => b.id === boardId);
    if (existingBoard) {
      existingBoard.updatedAt = Date.now();
    } else {
      state.boards.unshift({
        id: boardId,
        name: boardId.replace(/-/g, " ").replace(/^\w/, c => c.toUpperCase()),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    
    app.requestUpdate?.();
    return true;
  } catch (err) {
    state.error = `Failed to save whiteboard: ${err}`;
    if (!silent) {
      state.saving = false;
    }
    app.requestUpdate?.();
    return false;
  }
}

/**
 * Create a new whiteboard
 */
export async function createWhiteboard(app: AppState, name: string): Promise<string | null> {
  if (!app.client || !app.whiteboardState) return null;

  const id = name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  const initialData = {
    type: "excalidraw",
    version: 2,
    source: "infinibot-whiteboard",
    elements: [],
    appState: {
      viewBackgroundColor: "#1a1a2e",
      gridSize: null,
    },
    files: {},
  };

  const success = await saveWhiteboard(app, id, initialData);
  if (success) {
    app.whiteboardState.currentBoardId = id;
    app.whiteboardState.currentBoardData = initialData;
    return id;
  }
  return null;
}

/**
 * Delete a whiteboard
 */
export async function deleteWhiteboard(app: AppState, boardId: string): Promise<boolean> {
  if (!app.client || !app.whiteboardState) return false;

  try {
    await app.client.request("whiteboard.boards.delete", { id: boardId });

    const state = app.whiteboardState;
    state.boards = state.boards.filter(b => b.id !== boardId);
    
    if (state.currentBoardId === boardId) {
      state.currentBoardId = null;
      state.currentBoardData = null;
    }
    
    app.requestUpdate?.();
    return true;
  } catch (err) {
    app.whiteboardState.error = `Failed to delete whiteboard: ${err}`;
    app.requestUpdate?.();
    return false;
  }
}

/**
 * Rename a whiteboard
 */
export async function renameWhiteboard(
  app: AppState, 
  boardId: string, 
  newName: string
): Promise<string | null> {
  if (!app.client || !app.whiteboardState) return null;

  const newId = newName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  if (newId === boardId) return boardId;

  try {
    await app.client.request("whiteboard.boards.rename", { id: boardId, newId });

    // Update state
    const state = app.whiteboardState;
    const board = state.boards.find(b => b.id === boardId);
    if (board) {
      board.id = newId;
      board.name = newName;
      board.updatedAt = Date.now();
    }

    if (state.currentBoardId === boardId) {
      state.currentBoardId = newId;
    }

    app.requestUpdate?.();
    return newId;
  } catch (err) {
    app.whiteboardState.error = `Failed to rename whiteboard: ${err}`;
    app.requestUpdate?.();
    return null;
  }
}

/**
 * Load templates (built-in + custom from templates directory)
 */
export async function loadTemplates(app: AppState): Promise<void> {
  if (!app.client || !app.whiteboardState) return;

  const state = app.whiteboardState;
  
  // Start with built-in templates
  const templates: WhiteboardTemplate[] = [...BUILTIN_TEMPLATES];

  try {
    const res = await app.client.request("whiteboard.templates.list", {}) as { templates?: WhiteboardFile[] };
    for (const entry of res?.templates ?? []) {
      const content = await app.client.request("whiteboard.templates.get", { id: entry.id }) as { data?: any };
      if (content?.data) templates.push({ id: `custom-${entry.id}`, name: entry.name, description: "Custom template", category: "Custom", data: content.data });
    }
  } catch (e) {
    // Templates directory might not exist - that's fine
    console.log("No custom templates directory found");
  }

  state.templates = templates;
  state.templatesLoaded = true;
  app.requestUpdate?.();
}

/**
 * Apply a template to create a new board
 */
export async function applyTemplate(
  app: AppState, 
  templateId: string,
  boardName?: string
): Promise<string | null> {
  if (!app.client || !app.whiteboardState) return null;

  const state = app.whiteboardState;
  const template = state.templates.find(t => t.id === templateId);
  if (!template) {
    state.error = `Template not found: ${templateId}`;
    app.requestUpdate?.();
    return null;
  }

  const name = boardName || `${template.name} ${new Date().toLocaleDateString()}`;
  const id = name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");

  // Clone template data with new IDs for elements
  const clonedData = JSON.parse(JSON.stringify(template.data));
  if (clonedData.elements) {
    clonedData.elements = clonedData.elements.map((el: any) => ({
      ...el,
      id: `${el.id || "el"}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      seed: Math.floor(Math.random() * 2000000000),
      version: 1,
      versionNonce: Math.floor(Math.random() * 2000000000),
    }));
  }

  const success = await saveWhiteboard(app, id, clonedData);
  if (success) {
    state.currentBoardId = id;
    state.currentBoardData = clonedData;
    state.showTemplatePanel = false;
    return id;
  }
  return null;
}

/**
 * Import elements from clipboard (Excalidraw JSON format)
 */
export async function importFromClipboard(app: AppState): Promise<boolean> {
  if (!app.whiteboardState) return false;

  const state = app.whiteboardState;

  try {
    // Request clipboard permission if needed
    if (navigator.permissions) {
      try {
        const result = await navigator.permissions.query({ name: "clipboard-read" as PermissionName });
        if (result.state === "denied") {
          state.error = "Clipboard access denied. Please allow clipboard permissions.";
          app.requestUpdate?.();
          return false;
        }
      } catch (e) {
        // Some browsers don't support clipboard permission query - continue anyway
      }
    }

    const text = await navigator.clipboard.readText();
    if (!text) {
      state.error = "Clipboard is empty";
      app.requestUpdate?.();
      return false;
    }

    // Try to parse as Excalidraw JSON
    const data = JSON.parse(text);
    
    // Validate it's Excalidraw data
    if (data.type !== "excalidraw" && !data.elements) {
      state.error = "Clipboard doesn't contain valid Excalidraw data";
      app.requestUpdate?.();
      return false;
    }

    // If we have a current board, merge elements
    if (state.currentBoardId && state.currentBoardData) {
      const newElements = (data.elements || []).map((el: any) => ({
        ...el,
        id: `imported-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        x: (el.x || 0) + 50, // Offset to avoid overlap
        y: (el.y || 0) + 50,
        seed: Math.floor(Math.random() * 2000000000),
        version: 1,
        versionNonce: Math.floor(Math.random() * 2000000000),
      }));

      state.currentBoardData = {
        ...state.currentBoardData,
        elements: [...(state.currentBoardData.elements || []), ...newElements],
        files: { ...(state.currentBoardData.files || {}), ...(data.files || {}) },
      };

      // Trigger save
      if (app.client) {
        await saveWhiteboard(app, state.currentBoardId, state.currentBoardData, true);
      }

      // Notify Excalidraw to update
      window.dispatchEvent(new CustomEvent("excalidraw-update", { 
        detail: { elements: state.currentBoardData.elements, files: state.currentBoardData.files }
      }));

      app.requestUpdate?.();
      return true;
    } else {
      state.error = "Open a board first to paste elements";
      app.requestUpdate?.();
      return false;
    }
  } catch (err) {
    if (String(err).includes("JSON")) {
      state.error = "Clipboard doesn't contain valid JSON. Copy elements from Excalidraw first.";
    } else {
      state.error = `Failed to import from clipboard: ${err}`;
    }
    app.requestUpdate?.();
    return false;
  }
}

/**
 * Copy current selection to clipboard
 */
export async function copyToClipboard(app: AppState, elements?: any[]): Promise<boolean> {
  if (!app.whiteboardState) return false;

  const state = app.whiteboardState;

  try {
    const data = {
      type: "excalidraw/clipboard",
      elements: elements || state.currentBoardData?.elements || [],
      files: state.currentBoardData?.files || {},
    };

    await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    state.error = `Failed to copy to clipboard: ${err}`;
    app.requestUpdate?.();
    return false;
  }
}

/**
 * Import from .excalidraw file
 */
export async function importFromFile(app: AppState, file: File): Promise<string | null> {
  if (!app.client || !app.whiteboardState) return null;

  const state = app.whiteboardState;

  try {
    const text = await file.text();
    const data = JSON.parse(text);

    // Validate
    if (data.type !== "excalidraw" && !data.elements) {
      state.error = "Invalid Excalidraw file format";
      app.requestUpdate?.();
      return null;
    }

    // Create board from file
    const name = file.name.replace(".excalidraw", "").replace(/[^a-zA-Z0-9\s-]/g, "");
    const id = name.toLowerCase().replace(/\s+/g, "-");

    // Ensure proper structure
    const boardData = {
      type: "excalidraw",
      version: data.version || 2,
      source: "infinibot-import",
      elements: data.elements || [],
      appState: {
        viewBackgroundColor: data.appState?.viewBackgroundColor || "#121212",
        theme: "dark",
        gridSize: data.appState?.gridSize || null,
      },
      files: data.files || {},
    };

    const success = await saveWhiteboard(app, id, boardData);
    if (success) {
      state.currentBoardId = id;
      state.currentBoardData = boardData;
      return id;
    }
    return null;
  } catch (err) {
    state.error = `Failed to import file: ${err}`;
    app.requestUpdate?.();
    return null;
  }
}

/**
 * Export current board to downloadable file
 */
export function exportToFile(app: AppState): void {
  if (!app.whiteboardState) return;

  const state = app.whiteboardState;
  if (!state.currentBoardId || !state.currentBoardData) {
    state.error = "No board open to export";
    app.requestUpdate?.();
    return;
  }

  const data = JSON.stringify(state.currentBoardData, null, 2);
  const blob = new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement("a");
  a.href = url;
  a.download = `${state.currentBoardId}.excalidraw`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Toggle template panel visibility
 */
export function toggleTemplatePanel(app: AppState): void {
  if (!app.whiteboardState) return;
  app.whiteboardState.showTemplatePanel = !app.whiteboardState.showTemplatePanel;
  
  // Load templates if not already loaded
  if (app.whiteboardState.showTemplatePanel && !app.whiteboardState.templatesLoaded) {
    loadTemplates(app);
  }
  
  app.requestUpdate?.();
}

/**
 * Save current board as a template
 */
export async function saveAsTemplate(app: AppState, templateName: string): Promise<boolean> {
  if (!app.client || !app.whiteboardState) return false;

  const state = app.whiteboardState;
  if (!state.currentBoardData) {
    state.error = "No board open to save as template";
    app.requestUpdate?.();
    return false;
  }

  try {
    const id = templateName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    await app.client.request("whiteboard.templates.save", { id, data: state.currentBoardData });

    // Reload templates
    await loadTemplates(app);
    return true;
  } catch (err) {
    state.error = `Failed to save template: ${err}`;
    app.requestUpdate?.();
    return false;
  }
}
