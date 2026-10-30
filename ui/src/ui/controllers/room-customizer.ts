/**
 * Room Customizer Controller
 * State management for the room customization editor
 * Handles CRUD operations, undo/redo, persistence, and selection
 */

import type { GatewayBrowserClient } from '../gateway';
import type { AppViewState } from '../app-view-state';
import {
  type RoomConfiguration,
  type RoomSettings,
  type PlacedElement,
  type RoomElementDefinition,
  type SelectionState,
  type HistoryEntry,
  type ClipboardState,
  type EditorTool,
  type ElementCategory,
  type Vector2D,
  createDefaultRoomConfiguration,
  createDefaultRoomSettings,
  createPlacedElement,
  getElementDefinition,
  ELEMENT_DEFINITIONS,
  searchElements,
} from '../types/room-elements';

// ════════════════════════════════════════════════════════════════
// STATE INTERFACE
// ════════════════════════════════════════════════════════════════

export interface RoomCustomizerState {
  // Loading states
  loading: boolean;
  saving: boolean;
  error: string | null;
  
  // Room configurations (saved rooms)
  savedRooms: RoomConfiguration[];
  
  // Current room being edited
  currentRoom: RoomConfiguration | null;
  isDirty: boolean;
  
  // Editor state
  activeTool: EditorTool;
  selection: SelectionState;
  
  // Library panel
  librarySearchQuery: string;
  libraryCategory: ElementCategory | 'all';
  libraryCollapsed: boolean;
  
  // Properties panel
  propertiesPanelCollapsed: boolean;
  
  // Settings panel
  settingsPanelOpen: boolean;
  
  // History (undo/redo)
  history: HistoryEntry[];
  historyIndex: number;
  maxHistorySize: number;
  
  // Clipboard
  clipboard: ClipboardState | null;
  
  // Drag from library
  draggingElement: RoomElementDefinition | null;
  dragPreviewPosition: Vector2D | null;
  
  // Agent assignment
  agents: { id: string; name: string; avatar?: string }[];
  
  // Canvas interaction state
  isPanning: boolean;
  lastMousePosition: Vector2D | null;
}

// ════════════════════════════════════════════════════════════════
// STORAGE KEYS
// ════════════════════════════════════════════════════════════════

const STORAGE_KEY_ROOMS = 'infinibot:room-customizer:rooms';
const STORAGE_KEY_PREFERENCES = 'infinibot:room-customizer:prefs';

// ════════════════════════════════════════════════════════════════
// GLOBAL STATE
// ════════════════════════════════════════════════════════════════

let state: RoomCustomizerState | null = null;
let requestUpdate: (() => void) | null = null;

// ════════════════════════════════════════════════════════════════
// INITIALIZATION
// ════════════════════════════════════════════════════════════════

export function createRoomCustomizerState(): RoomCustomizerState {
  return {
    loading: false,
    saving: false,
    error: null,
    savedRooms: [],
    currentRoom: null,
    isDirty: false,
    activeTool: 'select',
    selection: {
      selectedIds: new Set(),
      hoveredId: null,
      isDragging: false,
      isResizing: false,
      isRotating: false,
    },
    librarySearchQuery: '',
    libraryCategory: 'all',
    libraryCollapsed: false,
    propertiesPanelCollapsed: false,
    settingsPanelOpen: false,
    history: [],
    historyIndex: -1,
    maxHistorySize: 50,
    clipboard: null,
    draggingElement: null,
    dragPreviewPosition: null,
    agents: [],
    isPanning: false,
    lastMousePosition: null,
  };
}

export async function initRoomCustomizer(
  client: GatewayBrowserClient,
  viewState: AppViewState
): Promise<void> {
  state = createRoomCustomizerState();
  requestUpdate = () => viewState.requestUpdate?.();
  
  // Load saved rooms from storage
  await loadSavedRooms();
  
  // Load agents from gateway
  await loadAgents(client);
  
  requestUpdate?.();
}

export function cleanupRoomCustomizer(): void {
  // Auto-save if dirty
  if (state?.isDirty && state.currentRoom) {
    saveCurrentRoom();
  }
  
  state = null;
  requestUpdate = null;
}

export function getRoomCustomizerState(): RoomCustomizerState {
  if (!state) {
    state = createRoomCustomizerState();
  }
  return state;
}

// ════════════════════════════════════════════════════════════════
// PERSISTENCE
// ════════════════════════════════════════════════════════════════

async function loadSavedRooms(): Promise<void> {
  if (!state) return;
  
  try {
    const stored = localStorage.getItem(STORAGE_KEY_ROOMS);
    if (stored) {
      const rooms = JSON.parse(stored) as RoomConfiguration[];
      state.savedRooms = rooms;
    }
  } catch (err) {
    console.error('[RoomCustomizer] Failed to load saved rooms:', err);
    state.error = 'Failed to load saved rooms';
  }
}

export function saveRoomsToStorage(): void {
  if (!state) return;
  
  try {
    localStorage.setItem(STORAGE_KEY_ROOMS, JSON.stringify(state.savedRooms));
  } catch (err) {
    console.error('[RoomCustomizer] Failed to save rooms:', err);
  }
}

async function loadAgents(client: GatewayBrowserClient): Promise<void> {
  if (!state) return;
  
  try {
    // Try to load agents from gateway
    const result = await client.request('agents.list', {});
    if (result && Array.isArray((result as any).agents)) {
      state.agents = ((result as any).agents || []).map((a: any) => ({
        id: a.id || a.agentId,
        name: a.name || a.label || a.agentId,
        avatar: a.avatar,
      }));
    }
  } catch {
    // Silently fail - agents aren't critical
    state.agents = [];
  }
}

// ════════════════════════════════════════════════════════════════
// ROOM CRUD OPERATIONS
// ════════════════════════════════════════════════════════════════

export function createNewRoom(name?: string): RoomConfiguration {
  const room = createDefaultRoomConfiguration();
  room.name = name || `Room ${(state?.savedRooms.length || 0) + 1}`;
  
  if (state) {
    state.savedRooms.push(room);
    state.currentRoom = room;
    state.isDirty = false;
    pushHistoryState('Create room');
    saveRoomsToStorage();
    requestUpdate?.();
  }
  
  return room;
}

export function loadRoom(roomId: string): boolean {
  if (!state) return false;
  
  const room = state.savedRooms.find(r => r.id === roomId);
  if (!room) return false;
  
  // Auto-save current if dirty
  if (state.isDirty && state.currentRoom) {
    saveCurrentRoom();
  }
  
  state.currentRoom = JSON.parse(JSON.stringify(room)); // Deep clone
  state.isDirty = false;
  state.selection.selectedIds.clear();
  state.history = [];
  state.historyIndex = -1;
  pushHistoryState('Load room');
  
  requestUpdate?.();
  return true;
}

export function saveCurrentRoom(): boolean {
  if (!state?.currentRoom) return false;
  
  state.currentRoom.updatedAt = Date.now();
  state.currentRoom.version++;
  
  // Update in saved rooms
  const index = state.savedRooms.findIndex(r => r.id === state!.currentRoom!.id);
  if (index >= 0) {
    state.savedRooms[index] = JSON.parse(JSON.stringify(state.currentRoom));
  } else {
    state.savedRooms.push(JSON.parse(JSON.stringify(state.currentRoom)));
  }
  
  state.isDirty = false;
  saveRoomsToStorage();
  requestUpdate?.();
  return true;
}

export function deleteRoom(roomId: string): boolean {
  if (!state) return false;
  
  const index = state.savedRooms.findIndex(r => r.id === roomId);
  if (index < 0) return false;
  
  state.savedRooms.splice(index, 1);
  
  if (state.currentRoom?.id === roomId) {
    state.currentRoom = null;
    state.isDirty = false;
  }
  
  saveRoomsToStorage();
  requestUpdate?.();
  return true;
}

export function duplicateRoom(roomId: string): RoomConfiguration | null {
  if (!state) return null;
  
  const room = state.savedRooms.find(r => r.id === roomId);
  if (!room) return null;
  
  const newRoom: RoomConfiguration = {
    ...JSON.parse(JSON.stringify(room)),
    id: crypto.randomUUID ? crypto.randomUUID() : `room-${Date.now()}`,
    name: `${room.name} (Copy)`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    version: 1,
  };
  
  // Regenerate element instance IDs
  newRoom.elements = newRoom.elements.map(el => ({
    ...el,
    instanceId: crypto.randomUUID ? crypto.randomUUID() : `elem-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  }));
  
  state.savedRooms.push(newRoom);
  saveRoomsToStorage();
  requestUpdate?.();
  
  return newRoom;
}

export function renameRoom(roomId: string, newName: string): boolean {
  if (!state) return false;
  
  const room = state.savedRooms.find(r => r.id === roomId);
  if (!room) return false;
  
  room.name = newName;
  room.updatedAt = Date.now();
  
  if (state.currentRoom?.id === roomId) {
    state.currentRoom.name = newName;
    state.currentRoom.updatedAt = Date.now();
  }
  
  saveRoomsToStorage();
  requestUpdate?.();
  return true;
}

// ════════════════════════════════════════════════════════════════
// ELEMENT OPERATIONS
// ════════════════════════════════════════════════════════════════

export function addElement(definitionId: string, position: Vector2D): PlacedElement | null {
  if (!state?.currentRoom) return null;
  
  const definition = getElementDefinition(definitionId);
  if (!definition) return null;
  
  const element = createPlacedElement(definition, position);
  
  // Snap to grid if enabled
  if (state.currentRoom.settings.snapToGrid) {
    const gridSize = state.currentRoom.settings.gridSize;
    element.transform.position.x = Math.round(position.x / gridSize) * gridSize;
    element.transform.position.y = Math.round(position.y / gridSize) * gridSize;
  }
  
  state.currentRoom.elements.push(element);
  state.isDirty = true;
  
  // Select the new element
  state.selection.selectedIds.clear();
  state.selection.selectedIds.add(element.instanceId);
  
  pushHistoryState(`Add ${definition.name}`);
  requestUpdate?.();
  
  return element;
}

export function removeElement(instanceId: string): boolean {
  if (!state?.currentRoom) return false;
  
  const index = state.currentRoom.elements.findIndex(e => e.instanceId === instanceId);
  if (index < 0) return false;
  
  const element = state.currentRoom.elements[index];
  const definition = getElementDefinition(element.definitionId);
  
  state.currentRoom.elements.splice(index, 1);
  state.selection.selectedIds.delete(instanceId);
  state.isDirty = true;
  
  pushHistoryState(`Delete ${definition?.name || 'element'}`);
  requestUpdate?.();
  return true;
}

export function removeSelectedElements(): number {
  if (!state?.currentRoom) return 0;
  
  const count = state.selection.selectedIds.size;
  if (count === 0) return 0;
  
  state.currentRoom.elements = state.currentRoom.elements.filter(
    e => !state!.selection.selectedIds.has(e.instanceId)
  );
  
  state.selection.selectedIds.clear();
  state.isDirty = true;
  
  pushHistoryState(`Delete ${count} element(s)`);
  requestUpdate?.();
  return count;
}

export function updateElement(instanceId: string, updates: Partial<PlacedElement>): boolean {
  if (!state?.currentRoom) return false;
  
  const element = state.currentRoom.elements.find(e => e.instanceId === instanceId);
  if (!element) return false;
  
  Object.assign(element, updates, { updatedAt: Date.now() });
  state.isDirty = true;
  requestUpdate?.();
  return true;
}

export function moveElement(instanceId: string, deltaX: number, deltaY: number): boolean {
  if (!state?.currentRoom) return false;
  
  const element = state.currentRoom.elements.find(e => e.instanceId === instanceId);
  if (!element || element.locked) return false;
  
  element.transform.position.x += deltaX;
  element.transform.position.y += deltaY;
  
  // Snap to grid if enabled
  if (state.currentRoom.settings.snapToGrid) {
    const gridSize = state.currentRoom.settings.gridSize;
    element.transform.position.x = Math.round(element.transform.position.x / gridSize) * gridSize;
    element.transform.position.y = Math.round(element.transform.position.y / gridSize) * gridSize;
  }
  
  element.updatedAt = Date.now();
  state.isDirty = true;
  requestUpdate?.();
  return true;
}

export function moveSelectedElements(deltaX: number, deltaY: number): void {
  if (!state?.currentRoom) return;
  
  state.selection.selectedIds.forEach(id => {
    moveElement(id, deltaX, deltaY);
  });
}

export function setElementPosition(instanceId: string, x: number, y: number): boolean {
  if (!state?.currentRoom) return false;
  
  const element = state.currentRoom.elements.find(e => e.instanceId === instanceId);
  if (!element || element.locked) return false;
  
  element.transform.position.x = x;
  element.transform.position.y = y;
  element.updatedAt = Date.now();
  state.isDirty = true;
  requestUpdate?.();
  return true;
}

export function setElementZIndex(instanceId: string, zIndex: number): boolean {
  if (!state?.currentRoom) return false;
  
  const element = state.currentRoom.elements.find(e => e.instanceId === instanceId);
  if (!element) return false;
  
  element.transform.position.z = zIndex;
  element.updatedAt = Date.now();
  state.isDirty = true;
  requestUpdate?.();
  return true;
}

export function rotateElement(instanceId: string, angle: number): boolean {
  if (!state?.currentRoom) return false;
  
  const element = state.currentRoom.elements.find(e => e.instanceId === instanceId);
  if (!element || element.locked) return false;
  
  const definition = getElementDefinition(element.definitionId);
  if (!definition?.canRotate) return false;
  
  element.transform.rotation = (element.transform.rotation + angle) % 360;
  element.updatedAt = Date.now();
  state.isDirty = true;
  requestUpdate?.();
  return true;
}

export function scaleElement(instanceId: string, scale: number): boolean {
  if (!state?.currentRoom) return false;
  
  const element = state.currentRoom.elements.find(e => e.instanceId === instanceId);
  if (!element || element.locked) return false;
  
  const definition = getElementDefinition(element.definitionId);
  if (!definition?.canResize) return false;
  
  element.transform.scale = Math.max(0.1, Math.min(5, scale));
  element.updatedAt = Date.now();
  state.isDirty = true;
  requestUpdate?.();
  return true;
}

export function setElementVariant(instanceId: string, variant: string): boolean {
  if (!state?.currentRoom) return false;
  
  const element = state.currentRoom.elements.find(e => e.instanceId === instanceId);
  if (!element) return false;
  
  const definition = getElementDefinition(element.definitionId);
  if (!definition?.canRecolor || !definition.variants) return false;
  
  const validVariant = definition.variants.find(v => v.id === variant);
  if (!validVariant) return false;
  
  element.variant = variant;
  element.frameKey = validVariant.spriteKey || variant;
  element.updatedAt = Date.now();
  state.isDirty = true;
  requestUpdate?.();
  return true;
}

export function toggleElementLock(instanceId: string): boolean {
  if (!state?.currentRoom) return false;
  
  const element = state.currentRoom.elements.find(e => e.instanceId === instanceId);
  if (!element) return false;
  
  element.locked = !element.locked;
  element.updatedAt = Date.now();
  state.isDirty = true;
  requestUpdate?.();
  return true;
}

export function toggleElementVisibility(instanceId: string): boolean {
  if (!state?.currentRoom) return false;
  
  const element = state.currentRoom.elements.find(e => e.instanceId === instanceId);
  if (!element) return false;
  
  element.visible = !element.visible;
  element.updatedAt = Date.now();
  state.isDirty = true;
  requestUpdate?.();
  return true;
}

export function bringToFront(instanceId: string): void {
  if (!state?.currentRoom) return;
  
  const maxZ = Math.max(...state.currentRoom.elements.map(e => e.transform.position.z), 0);
  setElementZIndex(instanceId, maxZ + 1);
  pushHistoryState('Bring to front');
}

export function sendToBack(instanceId: string): void {
  if (!state?.currentRoom) return;
  
  const minZ = Math.min(...state.currentRoom.elements.map(e => e.transform.position.z), 0);
  setElementZIndex(instanceId, minZ - 1);
  pushHistoryState('Send to back');
}

// ════════════════════════════════════════════════════════════════
// SELECTION
// ════════════════════════════════════════════════════════════════

export function selectElement(instanceId: string, addToSelection = false): void {
  if (!state) return;
  
  if (!addToSelection) {
    state.selection.selectedIds.clear();
  }
  
  state.selection.selectedIds.add(instanceId);
  requestUpdate?.();
}

export function deselectElement(instanceId: string): void {
  if (!state) return;
  state.selection.selectedIds.delete(instanceId);
  requestUpdate?.();
}

export function clearSelection(): void {
  if (!state) return;
  state.selection.selectedIds.clear();
  requestUpdate?.();
}

export function selectAll(): void {
  if (!state?.currentRoom) return;
  state.selection.selectedIds.clear();
  state.currentRoom.elements.forEach(e => {
    if (!e.locked) {
      state!.selection.selectedIds.add(e.instanceId);
    }
  });
  requestUpdate?.();
}

export function setHoveredElement(instanceId: string | null): void {
  if (!state) return;
  state.selection.hoveredId = instanceId;
  requestUpdate?.();
}

export function getSelectedElements(): PlacedElement[] {
  if (!state?.currentRoom) return [];
  return state.currentRoom.elements.filter(e => state!.selection.selectedIds.has(e.instanceId));
}

// ════════════════════════════════════════════════════════════════
// ROOM SETTINGS
// ════════════════════════════════════════════════════════════════

export function updateRoomSettings(updates: Partial<RoomSettings>): void {
  if (!state?.currentRoom) return;
  
  Object.assign(state.currentRoom.settings, updates);
  state.isDirty = true;
  requestUpdate?.();
}

export function toggleGrid(): void {
  if (!state?.currentRoom) return;
  state.currentRoom.settings.gridVisible = !state.currentRoom.settings.gridVisible;
  state.isDirty = true;
  requestUpdate?.();
}

export function toggleSnapToGrid(): void {
  if (!state?.currentRoom) return;
  state.currentRoom.settings.snapToGrid = !state.currentRoom.settings.snapToGrid;
  state.isDirty = true;
  requestUpdate?.();
}

export function setZoom(zoom: number): void {
  if (!state?.currentRoom) return;
  state.currentRoom.settings.zoom = Math.max(0.25, Math.min(4, zoom));
  requestUpdate?.();
}

export function setPan(x: number, y: number): void {
  if (!state?.currentRoom) return;
  state.currentRoom.settings.pan = { x, y };
  requestUpdate?.();
}

export function resetViewport(): void {
  if (!state?.currentRoom) return;
  state.currentRoom.settings.zoom = 1;
  state.currentRoom.settings.pan = { x: 0, y: 0 };
  requestUpdate?.();
}

// ════════════════════════════════════════════════════════════════
// TOOLS
// ════════════════════════════════════════════════════════════════

export function setActiveTool(tool: EditorTool): void {
  if (!state) return;
  state.activeTool = tool;
  requestUpdate?.();
}

// ════════════════════════════════════════════════════════════════
// LIBRARY
// ════════════════════════════════════════════════════════════════

export function setLibrarySearch(query: string): void {
  if (!state) return;
  state.librarySearchQuery = query;
  requestUpdate?.();
}

export function setLibraryCategory(category: ElementCategory | 'all'): void {
  if (!state) return;
  state.libraryCategory = category;
  requestUpdate?.();
}

export function toggleLibraryPanel(): void {
  if (!state) return;
  state.libraryCollapsed = !state.libraryCollapsed;
  requestUpdate?.();
}

export function getFilteredElements(): RoomElementDefinition[] {
  if (!state) return ELEMENT_DEFINITIONS;
  
  let elements = ELEMENT_DEFINITIONS;
  
  // Filter by category
  if (state.libraryCategory !== 'all') {
    elements = elements.filter(e => e.category === state!.libraryCategory);
  }
  
  // Filter by search
  if (state.librarySearchQuery) {
    elements = searchElements(state.librarySearchQuery).filter(
      e => state!.libraryCategory === 'all' || e.category === state!.libraryCategory
    );
  }
  
  return elements;
}

// ════════════════════════════════════════════════════════════════
// DRAG & DROP
// ════════════════════════════════════════════════════════════════

export function startDragFromLibrary(definition: RoomElementDefinition): void {
  if (!state) return;
  state.draggingElement = definition;
  requestUpdate?.();
}

export function updateDragPreview(position: Vector2D): void {
  if (!state) return;
  state.dragPreviewPosition = position;
  requestUpdate?.();
}

export function endDragFromLibrary(position: Vector2D | null): PlacedElement | null {
  if (!state) return null;
  
  let element: PlacedElement | null = null;
  
  if (state.draggingElement && position) {
    element = addElement(state.draggingElement.id, position);
  }
  
  state.draggingElement = null;
  state.dragPreviewPosition = null;
  requestUpdate?.();
  
  return element;
}

export function cancelDrag(): void {
  if (!state) return;
  state.draggingElement = null;
  state.dragPreviewPosition = null;
  requestUpdate?.();
}

// ════════════════════════════════════════════════════════════════
// CLIPBOARD (Copy/Paste)
// ════════════════════════════════════════════════════════════════

export function copySelectedElements(): boolean {
  if (!state?.currentRoom) return false;
  
  const selected = getSelectedElements();
  if (selected.length === 0) return false;
  
  state.clipboard = {
    elements: JSON.parse(JSON.stringify(selected)),
    copiedAt: Date.now(),
  };
  
  requestUpdate?.();
  return true;
}

export function cutSelectedElements(): boolean {
  if (!copySelectedElements()) return false;
  removeSelectedElements();
  return true;
}

export function pasteElements(offset = { x: 20, y: 20 }): PlacedElement[] {
  if (!state?.currentRoom || !state.clipboard) return [];
  
  const newElements: PlacedElement[] = [];
  
  for (const copiedEl of state.clipboard.elements) {
    const newEl: PlacedElement = {
      ...JSON.parse(JSON.stringify(copiedEl)),
      instanceId: crypto.randomUUID ? crypto.randomUUID() : `elem-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    
    // Offset position
    newEl.transform.position.x += offset.x;
    newEl.transform.position.y += offset.y;
    
    state.currentRoom.elements.push(newEl);
    newElements.push(newEl);
  }
  
  // Select pasted elements
  state.selection.selectedIds.clear();
  newElements.forEach(el => state!.selection.selectedIds.add(el.instanceId));
  
  state.isDirty = true;
  pushHistoryState(`Paste ${newElements.length} element(s)`);
  requestUpdate?.();
  
  return newElements;
}

// ════════════════════════════════════════════════════════════════
// HISTORY (Undo/Redo)
// ════════════════════════════════════════════════════════════════

function pushHistoryState(action: string): void {
  if (!state?.currentRoom) return;
  
  // Remove any future history if we're not at the end
  if (state.historyIndex < state.history.length - 1) {
    state.history = state.history.slice(0, state.historyIndex + 1);
  }
  
  // Add new state
  state.history.push({
    timestamp: Date.now(),
    action,
    elements: JSON.parse(JSON.stringify(state.currentRoom.elements)),
    settings: JSON.parse(JSON.stringify(state.currentRoom.settings)),
  });
  
  // Limit history size
  if (state.history.length > state.maxHistorySize) {
    state.history.shift();
  }
  
  state.historyIndex = state.history.length - 1;
}

export function undo(): boolean {
  if (!state?.currentRoom || state.historyIndex <= 0) return false;
  
  state.historyIndex--;
  const entry = state.history[state.historyIndex];
  
  state.currentRoom.elements = JSON.parse(JSON.stringify(entry.elements));
  state.currentRoom.settings = JSON.parse(JSON.stringify(entry.settings));
  state.isDirty = true;
  state.selection.selectedIds.clear();
  
  requestUpdate?.();
  return true;
}

export function redo(): boolean {
  if (!state?.currentRoom || state.historyIndex >= state.history.length - 1) return false;
  
  state.historyIndex++;
  const entry = state.history[state.historyIndex];
  
  state.currentRoom.elements = JSON.parse(JSON.stringify(entry.elements));
  state.currentRoom.settings = JSON.parse(JSON.stringify(entry.settings));
  state.isDirty = true;
  state.selection.selectedIds.clear();
  
  requestUpdate?.();
  return true;
}

export function canUndo(): boolean {
  return state ? state.historyIndex > 0 : false;
}

export function canRedo(): boolean {
  return state ? state.historyIndex < state.history.length - 1 : false;
}

// ════════════════════════════════════════════════════════════════
// AGENT ASSIGNMENT
// ════════════════════════════════════════════════════════════════

export function assignRoomToAgent(roomId: string, agentId: string | undefined): boolean {
  if (!state) return false;
  
  const room = state.savedRooms.find(r => r.id === roomId);
  if (!room) return false;
  
  room.agentId = agentId;
  room.updatedAt = Date.now();
  
  if (state.currentRoom?.id === roomId) {
    state.currentRoom.agentId = agentId;
    state.currentRoom.updatedAt = Date.now();
  }
  
  saveRoomsToStorage();
  requestUpdate?.();
  return true;
}

export function getRoomForAgent(agentId: string): RoomConfiguration | null {
  return state?.savedRooms.find(r => r.agentId === agentId) || null;
}

// ════════════════════════════════════════════════════════════════
// IMPORT / EXPORT
// ════════════════════════════════════════════════════════════════

export function exportRoom(roomId: string): string | null {
  if (!state) return null;
  
  const room = state.savedRooms.find(r => r.id === roomId);
  if (!room) return null;
  
  return JSON.stringify(room, null, 2);
}

export function exportCurrentRoom(): string | null {
  if (!state?.currentRoom) return null;
  return JSON.stringify(state.currentRoom, null, 2);
}

export function importRoom(json: string): RoomConfiguration | null {
  if (!state) return null;
  
  try {
    const room = JSON.parse(json) as RoomConfiguration;
    
    // Validate basic structure
    if (!room.id || !room.name || !room.settings || !Array.isArray(room.elements)) {
      throw new Error('Invalid room configuration');
    }
    
    // Generate new ID to avoid conflicts
    room.id = crypto.randomUUID ? crypto.randomUUID() : `room-${Date.now()}`;
    room.name = `${room.name} (Imported)`;
    room.createdAt = Date.now();
    room.updatedAt = Date.now();
    
    // Regenerate element IDs
    room.elements = room.elements.map(el => ({
      ...el,
      instanceId: crypto.randomUUID ? crypto.randomUUID() : `elem-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }));
    
    state.savedRooms.push(room);
    saveRoomsToStorage();
    requestUpdate?.();
    
    return room;
  } catch (err) {
    console.error('[RoomCustomizer] Failed to import room:', err);
    state.error = 'Failed to import room: Invalid JSON';
    requestUpdate?.();
    return null;
  }
}

// ════════════════════════════════════════════════════════════════
// KEYBOARD SHORTCUTS
// ════════════════════════════════════════════════════════════════

export function handleKeyDown(e: KeyboardEvent): boolean {
  if (!state?.currentRoom) return false;
  
  const isCtrl = e.ctrlKey || e.metaKey;
  
  // Undo: Ctrl+Z
  if (isCtrl && e.key === 'z' && !e.shiftKey) {
    e.preventDefault();
    return undo();
  }
  
  // Redo: Ctrl+Shift+Z or Ctrl+Y
  if ((isCtrl && e.key === 'z' && e.shiftKey) || (isCtrl && e.key === 'y')) {
    e.preventDefault();
    return redo();
  }
  
  // Copy: Ctrl+C
  if (isCtrl && e.key === 'c') {
    e.preventDefault();
    return copySelectedElements();
  }
  
  // Cut: Ctrl+X
  if (isCtrl && e.key === 'x') {
    e.preventDefault();
    return cutSelectedElements();
  }
  
  // Paste: Ctrl+V
  if (isCtrl && e.key === 'v') {
    e.preventDefault();
    return pasteElements().length > 0;
  }
  
  // Select All: Ctrl+A
  if (isCtrl && e.key === 'a') {
    e.preventDefault();
    selectAll();
    return true;
  }
  
  // Delete: Delete or Backspace
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (state.selection.selectedIds.size > 0) {
      e.preventDefault();
      removeSelectedElements();
      return true;
    }
  }
  
  // Escape: Clear selection
  if (e.key === 'Escape') {
    clearSelection();
    cancelDrag();
    return true;
  }
  
  // Arrow keys: Move selected elements
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
    if (state.selection.selectedIds.size > 0) {
      e.preventDefault();
      const delta = e.shiftKey ? 10 : 1;
      const gridSize = state.currentRoom.settings.snapToGrid ? state.currentRoom.settings.gridSize : 1;
      const step = e.shiftKey ? gridSize : 1;
      
      let dx = 0, dy = 0;
      if (e.key === 'ArrowUp') dy = -step;
      if (e.key === 'ArrowDown') dy = step;
      if (e.key === 'ArrowLeft') dx = -step;
      if (e.key === 'ArrowRight') dx = step;
      
      moveSelectedElements(dx, dy);
      return true;
    }
  }
  
  // Save: Ctrl+S
  if (isCtrl && e.key === 's') {
    e.preventDefault();
    saveCurrentRoom();
    return true;
  }
  
  // Toggle grid: G
  if (e.key === 'g' && !isCtrl && !e.shiftKey) {
    toggleGrid();
    return true;
  }
  
  return false;
}

// ════════════════════════════════════════════════════════════════
// PANEL TOGGLES
// ════════════════════════════════════════════════════════════════

export function togglePropertiesPanel(): void {
  if (!state) return;
  state.propertiesPanelCollapsed = !state.propertiesPanelCollapsed;
  requestUpdate?.();
}

export function toggleSettingsPanel(): void {
  if (!state) return;
  state.settingsPanelOpen = !state.settingsPanelOpen;
  requestUpdate?.();
}
