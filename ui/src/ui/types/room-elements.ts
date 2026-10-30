/**
 * Room Elements Type Definitions
 * Complete type system for the room customization editor
 */

// ════════════════════════════════════════════════════════════════
// ELEMENT CATEGORIES
// ════════════════════════════════════════════════════════════════

export type ElementCategory =
  | 'furniture'
  | 'decorations'
  | 'tech'
  | 'plants'
  | 'lighting'
  | 'carpets'
  | 'wall'
  | 'windows'
  | 'storage';

// ════════════════════════════════════════════════════════════════
// BASE ELEMENT TYPES
// ════════════════════════════════════════════════════════════════

export interface Vector2D {
  x: number;
  y: number;
}

export interface Vector3D {
  x: number;
  y: number;
  z: number;
}

export interface Size2D {
  width: number;
  height: number;
}

export interface Transform {
  position: Vector3D;
  rotation: number; // degrees
  scale: number;
}

export interface ColorVariant {
  id: string;
  name: string;
  previewColor: string; // CSS color for preview
  spriteKey?: string; // Key to use in sprite sheet
}

// ════════════════════════════════════════════════════════════════
// ELEMENT DEFINITION (Library item)
// ════════════════════════════════════════════════════════════════

export interface RoomElementDefinition {
  id: string;
  name: string;
  category: ElementCategory;
  description?: string;
  
  // Sprite info
  spriteSheet: string; // Key from ASSET_PATHS
  defaultFrame?: string; // Default frame in sprite sheet
  
  // Default dimensions
  baseSize: Size2D;
  
  // Interaction properties
  canRotate: boolean;
  canResize: boolean;
  canRecolor: boolean;
  
  // Available variants (colors, styles)
  variants?: ColorVariant[];
  
  // Z-index range (for layering)
  defaultZIndex: number;
  zIndexRange: [number, number];
  
  // Anchor point (0-1)
  anchor: Vector2D;
  
  // Tags for search/filter
  tags: string[];
  
  // Placement rules
  isWallMounted?: boolean;
  isFloorItem?: boolean;
  
  // Custom properties this element supports
  customProperties?: ElementPropertyDefinition[];
}

export interface ElementPropertyDefinition {
  key: string;
  name: string;
  type: 'number' | 'boolean' | 'string' | 'select';
  defaultValue: any;
  options?: { value: any; label: string }[]; // For select type
  min?: number;
  max?: number;
  step?: number;
}

// ════════════════════════════════════════════════════════════════
// PLACED ELEMENT (Instance in room)
// ════════════════════════════════════════════════════════════════

export interface PlacedElement {
  instanceId: string; // Unique instance ID
  definitionId: string; // Reference to RoomElementDefinition.id
  
  // Transform
  transform: Transform;
  
  // Current size (may differ from base if resized)
  size: Size2D;
  
  // Visual state
  variant?: string; // Which color/style variant
  frameKey?: string; // Override sprite frame
  opacity: number;
  visible: boolean;
  locked: boolean;
  
  // Custom property values
  customValues?: Record<string, any>;
  
  // Metadata
  name?: string; // Custom name for this instance
  createdAt: number;
  updatedAt: number;
}

// ════════════════════════════════════════════════════════════════
// ROOM CONFIGURATION
// ════════════════════════════════════════════════════════════════

export type RoomBackgroundType = 'room1' | 'room2' | 'custom' | 'none';
export type CarpetColor = 'default' | 'blue' | 'green' | 'red' | 'purple' | 'yellow' | 'white' | 'none';

export interface RoomSettings {
  // Dimensions
  width: number;
  height: number;
  
  // Background
  backgroundType: RoomBackgroundType;
  customBackgroundUrl?: string;
  backgroundColor: string;
  
  // Floor/carpet
  carpetColor: CarpetColor;
  carpetScale: number;
  carpetOffset: Vector2D;
  
  // Grid
  gridSize: number;
  gridVisible: boolean;
  snapToGrid: boolean;
  
  // Lighting/ambiance
  ambientLight: number; // 0-1
  tintColor?: string;
  
  // Viewport
  zoom: number;
  pan: Vector2D;
}

// ════════════════════════════════════════════════════════════════
// ROOM CONFIGURATION (Full room save)
// ════════════════════════════════════════════════════════════════

export interface RoomConfiguration {
  id: string;
  name: string;
  description?: string;
  
  // Settings
  settings: RoomSettings;
  
  // Placed elements
  elements: PlacedElement[];
  
  // Agent assignment
  agentId?: string;
  agentTheme?: string;
  
  // Metadata
  createdAt: number;
  updatedAt: number;
  version: number;
  
  // Tags for organization
  tags?: string[];
  
  // Thumbnail (base64 or URL)
  thumbnail?: string;
}

// ════════════════════════════════════════════════════════════════
// EDITOR STATE
// ════════════════════════════════════════════════════════════════

export type EditorTool = 'select' | 'move' | 'rotate' | 'resize' | 'delete';

export interface SelectionState {
  selectedIds: Set<string>;
  hoveredId: string | null;
  dragStartPosition?: Vector2D;
  isDragging: boolean;
  isResizing: boolean;
  isRotating: boolean;
  resizeHandle?: 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w';
}

export interface HistoryEntry {
  timestamp: number;
  action: string;
  elements: PlacedElement[];
  settings: RoomSettings;
}

export interface ClipboardState {
  elements: PlacedElement[];
  copiedAt: number;
}

// ════════════════════════════════════════════════════════════════
// ELEMENT LIBRARY CATALOG
// ════════════════════════════════════════════════════════════════

// Pre-built element definitions based on cozy-room-assets
export const ELEMENT_DEFINITIONS: RoomElementDefinition[] = [
  // ─────────────────── FURNITURE ───────────────────
  {
    id: 'desk',
    name: 'Desk',
    category: 'furniture',
    description: 'Work desk with multiple color options',
    spriteSheet: 'desks',
    defaultFrame: 'beige',
    baseSize: { width: 70, height: 50 },
    canRotate: true,
    canResize: true,
    canRecolor: true,
    variants: [
      { id: 'purple', name: 'Purple', previewColor: '#9333ea', spriteKey: 'purple' },
      { id: 'beige', name: 'Beige', previewColor: '#d4a574', spriteKey: 'beige' },
      { id: 'pink', name: 'Pink', previewColor: '#ec4899', spriteKey: 'pink' },
      { id: 'gray', name: 'Gray', previewColor: '#6b7280', spriteKey: 'gray' },
      { id: 'yellow', name: 'Yellow', previewColor: '#eab308', spriteKey: 'yellow' },
      { id: 'blue', name: 'Blue', previewColor: '#3b82f6', spriteKey: 'blue' },
    ],
    defaultZIndex: 20,
    zIndexRange: [10, 50],
    anchor: { x: 0.5, y: 0.8 },
    tags: ['work', 'office', 'furniture'],
    isFloorItem: true,
  },
  {
    id: 'chair',
    name: 'Chair',
    category: 'furniture',
    description: 'Office chair in various colors',
    spriteSheet: 'chairs',
    defaultFrame: 'black',
    baseSize: { width: 42, height: 28 },
    canRotate: true,
    canResize: true,
    canRecolor: true,
    variants: [
      { id: 'red', name: 'Red', previewColor: '#ef4444', spriteKey: 'red' },
      { id: 'blue', name: 'Blue', previewColor: '#3b82f6', spriteKey: 'blue' },
      { id: 'brown', name: 'Brown', previewColor: '#92400e', spriteKey: 'brown' },
      { id: 'purple', name: 'Purple', previewColor: '#9333ea', spriteKey: 'purple' },
      { id: 'green', name: 'Green', previewColor: '#22c55e', spriteKey: 'green' },
      { id: 'black', name: 'Black', previewColor: '#1f2937', spriteKey: 'black' },
      { id: 'white', name: 'White', previewColor: '#f3f4f6', spriteKey: 'white' },
      { id: 'olive', name: 'Olive', previewColor: '#65a30d', spriteKey: 'olive' },
    ],
    defaultZIndex: 25,
    zIndexRange: [15, 55],
    anchor: { x: 0.5, y: 0.85 },
    tags: ['seating', 'office', 'furniture'],
    isFloorItem: true,
  },
  {
    id: 'sofa',
    name: 'Sofa',
    category: 'furniture',
    description: 'Comfortable sofa for relaxing',
    spriteSheet: 'bigSofas',
    defaultFrame: 'brown',
    baseSize: { width: 88, height: 46 },
    canRotate: true,
    canResize: true,
    canRecolor: true,
    variants: [
      { id: 'brown', name: 'Brown', previewColor: '#92400e', spriteKey: 'brown' },
      { id: 'purple', name: 'Purple', previewColor: '#9333ea', spriteKey: 'purple' },
      { id: 'gray', name: 'Gray', previewColor: '#6b7280', spriteKey: 'gray' },
      { id: 'beige', name: 'Beige', previewColor: '#d4a574', spriteKey: 'beige' },
      { id: 'red', name: 'Red', previewColor: '#ef4444', spriteKey: 'red' },
      { id: 'teal', name: 'Teal', previewColor: '#14b8a6', spriteKey: 'teal' },
    ],
    defaultZIndex: 30,
    zIndexRange: [20, 60],
    anchor: { x: 0.5, y: 0.85 },
    tags: ['seating', 'lounge', 'furniture'],
    isFloorItem: true,
  },
  {
    id: 'littleTable',
    name: 'Round Table',
    category: 'furniture',
    description: 'Small round side table',
    spriteSheet: 'littleTables',
    defaultFrame: 'brown',
    baseSize: { width: 24, height: 20 },
    canRotate: false,
    canResize: true,
    canRecolor: true,
    variants: [
      { id: 'purple', name: 'Purple', previewColor: '#9333ea', spriteKey: 'purple' },
      { id: 'gray', name: 'Gray', previewColor: '#6b7280', spriteKey: 'gray' },
      { id: 'white', name: 'White', previewColor: '#f3f4f6', spriteKey: 'white' },
      { id: 'brown', name: 'Brown', previewColor: '#92400e', spriteKey: 'brown' },
      { id: 'pink', name: 'Pink', previewColor: '#ec4899', spriteKey: 'pink' },
      { id: 'beige', name: 'Beige', previewColor: '#d4a574', spriteKey: 'beige' },
    ],
    defaultZIndex: 25,
    zIndexRange: [15, 50],
    anchor: { x: 0.5, y: 0.8 },
    tags: ['table', 'furniture'],
    isFloorItem: true,
  },
  {
    id: 'bed',
    name: 'Bed',
    category: 'furniture',
    description: 'Comfortable bed',
    spriteSheet: 'beds',
    baseSize: { width: 80, height: 60 },
    canRotate: true,
    canResize: true,
    canRecolor: false,
    defaultZIndex: 15,
    zIndexRange: [10, 40],
    anchor: { x: 0.5, y: 0.8 },
    tags: ['bedroom', 'furniture'],
    isFloorItem: true,
  },
  
  // ─────────────────── TECH ───────────────────
  {
    id: 'laptop',
    name: 'Laptop',
    category: 'tech',
    description: 'Laptop computer',
    spriteSheet: 'laptops',
    defaultFrame: 'silver',
    baseSize: { width: 48, height: 28 },
    canRotate: true,
    canResize: true,
    canRecolor: true,
    variants: [
      { id: 'silver', name: 'Silver', previewColor: '#9ca3af', spriteKey: 'silver' },
      { id: 'dark', name: 'Dark', previewColor: '#1f2937', spriteKey: 'dark' },
    ],
    defaultZIndex: 35,
    zIndexRange: [30, 60],
    anchor: { x: 0.5, y: 0.8 },
    tags: ['computer', 'tech', 'work'],
    isFloorItem: false,
    customProperties: [
      { key: 'isOn', name: 'Screen On', type: 'boolean', defaultValue: true },
    ],
  },
  {
    id: 'television',
    name: 'Television',
    category: 'tech',
    description: 'Flat screen TV',
    spriteSheet: 'television',
    baseSize: { width: 64, height: 48 },
    canRotate: false,
    canResize: true,
    canRecolor: false,
    defaultZIndex: 10,
    zIndexRange: [5, 30],
    anchor: { x: 0.5, y: 0.85 },
    tags: ['entertainment', 'tech'],
    isFloorItem: true,
  },
  
  // ─────────────────── DECORATIONS ───────────────────
  {
    id: 'bookcase',
    name: 'Bookcase',
    category: 'storage',
    description: 'Tall bookcase with shelves',
    spriteSheet: 'bookCase',
    baseSize: { width: 48, height: 80 },
    canRotate: false,
    canResize: true,
    canRecolor: false,
    defaultZIndex: 5,
    zIndexRange: [3, 20],
    anchor: { x: 0.5, y: 0.95 },
    tags: ['storage', 'books', 'furniture'],
    isFloorItem: true,
  },
  {
    id: 'coffee',
    name: 'Coffee Cup',
    category: 'decorations',
    description: 'Hot coffee mug',
    spriteSheet: 'coffeeCups',
    defaultFrame: 'cup1',
    baseSize: { width: 16, height: 16 },
    canRotate: false,
    canResize: true,
    canRecolor: true,
    variants: [
      { id: 'cup1', name: 'White Cup', previewColor: '#f3f4f6', spriteKey: 'cup1' },
      { id: 'cup2', name: 'Gray Cup', previewColor: '#6b7280', spriteKey: 'cup2' },
      { id: 'cup3', name: 'Brown Cup', previewColor: '#92400e', spriteKey: 'cup3' },
      { id: 'cup4', name: 'Blue Cup', previewColor: '#3b82f6', spriteKey: 'cup4' },
    ],
    defaultZIndex: 40,
    zIndexRange: [35, 70],
    anchor: { x: 0.5, y: 0.8 },
    tags: ['drink', 'decorations'],
    isFloorItem: false,
  },
  {
    id: 'teddy',
    name: 'Teddy Bear',
    category: 'decorations',
    description: 'Cute teddy bear',
    spriteSheet: 'teddyBears',
    defaultFrame: 'brown',
    baseSize: { width: 16, height: 20 },
    canRotate: false,
    canResize: true,
    canRecolor: true,
    variants: [
      { id: 'brown', name: 'Brown', previewColor: '#92400e', spriteKey: 'brown' },
      { id: 'cream', name: 'Cream', previewColor: '#fef3c7', spriteKey: 'cream' },
      { id: 'gray', name: 'Gray', previewColor: '#6b7280', spriteKey: 'gray' },
    ],
    defaultZIndex: 40,
    zIndexRange: [30, 60],
    anchor: { x: 0.5, y: 0.9 },
    tags: ['toy', 'decorations', 'cute'],
    isFloorItem: true,
  },
  
  // ─────────────────── PLANTS ───────────────────
  {
    id: 'plant',
    name: 'Potted Plant',
    category: 'plants',
    description: 'Indoor plant in pot',
    spriteSheet: 'plants',
    defaultFrame: 'plant1',
    baseSize: { width: 24, height: 32 },
    canRotate: false,
    canResize: true,
    canRecolor: true,
    variants: [
      { id: 'plant1', name: 'Fern', previewColor: '#22c55e', spriteKey: 'plant1' },
      { id: 'plant2', name: 'Palm', previewColor: '#16a34a', spriteKey: 'plant2' },
      { id: 'plant3', name: 'Cactus', previewColor: '#84cc16', spriteKey: 'plant3' },
      { id: 'plant4', name: 'Succulent', previewColor: '#4ade80', spriteKey: 'plant4' },
      { id: 'plant5', name: 'Ivy', previewColor: '#15803d', spriteKey: 'plant5' },
      { id: 'plant6', name: 'Monstera', previewColor: '#166534', spriteKey: 'plant6' },
      { id: 'plant7', name: 'Snake Plant', previewColor: '#14532d', spriteKey: 'plant7' },
      { id: 'plant8', name: 'Pothos', previewColor: '#65a30d', spriteKey: 'plant8' },
    ],
    defaultZIndex: 35,
    zIndexRange: [20, 60],
    anchor: { x: 0.5, y: 0.9 },
    tags: ['nature', 'plants', 'green'],
    isFloorItem: true,
  },
  
  // ─────────────────── LIGHTING ───────────────────
  {
    id: 'lamp',
    name: 'Floor Lamp',
    category: 'lighting',
    description: 'Standing floor lamp',
    spriteSheet: 'lamps',
    baseSize: { width: 24, height: 48 },
    canRotate: false,
    canResize: true,
    canRecolor: false,
    defaultZIndex: 35,
    zIndexRange: [25, 60],
    anchor: { x: 0.5, y: 0.95 },
    tags: ['lighting', 'lamp'],
    isFloorItem: true,
    customProperties: [
      { key: 'isOn', name: 'Light On', type: 'boolean', defaultValue: true },
      { key: 'brightness', name: 'Brightness', type: 'number', defaultValue: 1, min: 0, max: 1, step: 0.1 },
    ],
  },
  
  // ─────────────────── WINDOWS ───────────────────
  {
    id: 'window',
    name: 'Window',
    category: 'windows',
    description: 'Window with curtains',
    spriteSheet: 'windows',
    defaultFrame: 'brown',
    baseSize: { width: 48, height: 80 },
    canRotate: false,
    canResize: true,
    canRecolor: true,
    variants: [
      { id: 'pink', name: 'Pink Curtains', previewColor: '#ec4899', spriteKey: 'pink' },
      { id: 'curtain', name: 'Sheer Curtains', previewColor: '#f3f4f6', spriteKey: 'curtain' },
      { id: 'brown', name: 'Brown Frame', previewColor: '#92400e', spriteKey: 'brown' },
      { id: 'teal', name: 'Teal Curtains', previewColor: '#14b8a6', spriteKey: 'teal' },
    ],
    defaultZIndex: 2,
    zIndexRange: [1, 10],
    anchor: { x: 0.5, y: 0.9 },
    tags: ['window', 'wall'],
    isWallMounted: true,
  },
  
  // ─────────────────── STORAGE ───────────────────
  {
    id: 'drawers',
    name: 'Drawers',
    category: 'storage',
    description: 'Storage drawers',
    spriteSheet: 'drawers',
    baseSize: { width: 48, height: 40 },
    canRotate: false,
    canResize: true,
    canRecolor: true,
    variants: [
      { id: 'default', name: 'Natural', previewColor: '#d4a574' },
      { id: 'black', name: 'Black', previewColor: '#1f2937' },
      { id: 'brown', name: 'Brown', previewColor: '#92400e' },
      { id: 'green', name: 'Green', previewColor: '#22c55e' },
      { id: 'pink', name: 'Pink', previewColor: '#ec4899' },
      { id: 'white', name: 'White', previewColor: '#f3f4f6' },
    ],
    defaultZIndex: 15,
    zIndexRange: [10, 40],
    anchor: { x: 0.5, y: 0.85 },
    tags: ['storage', 'furniture'],
    isFloorItem: true,
  },
];

// ════════════════════════════════════════════════════════════════
// DEFAULT VALUES
// ════════════════════════════════════════════════════════════════

export function createDefaultRoomSettings(): RoomSettings {
  return {
    width: 400,
    height: 300,
    backgroundType: 'room1',
    backgroundColor: '#121212',
    carpetColor: 'default',
    carpetScale: 1.3,
    carpetOffset: { x: 0, y: 20 },
    gridSize: 16,
    gridVisible: true,
    snapToGrid: true,
    ambientLight: 1,
    zoom: 1,
    pan: { x: 0, y: 0 },
  };
}

export function createDefaultRoomConfiguration(): RoomConfiguration {
  return {
    id: crypto.randomUUID ? crypto.randomUUID() : `room-${Date.now()}`,
    name: 'New Room',
    settings: createDefaultRoomSettings(),
    elements: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    version: 1,
  };
}

export function createPlacedElement(
  definition: RoomElementDefinition,
  position: Vector2D
): PlacedElement {
  return {
    instanceId: crypto.randomUUID ? crypto.randomUUID() : `elem-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    definitionId: definition.id,
    transform: {
      position: { ...position, z: definition.defaultZIndex },
      rotation: 0,
      scale: 1,
    },
    size: { ...definition.baseSize },
    variant: definition.defaultFrame,
    frameKey: definition.defaultFrame,
    opacity: 1,
    visible: true,
    locked: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// ════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ════════════════════════════════════════════════════════════════

export function getElementDefinition(id: string): RoomElementDefinition | undefined {
  return ELEMENT_DEFINITIONS.find(def => def.id === id);
}

export function getElementsByCategory(category: ElementCategory): RoomElementDefinition[] {
  return ELEMENT_DEFINITIONS.filter(def => def.category === category);
}

export function searchElements(query: string): RoomElementDefinition[] {
  const q = query.toLowerCase().trim();
  if (!q) return ELEMENT_DEFINITIONS;
  
  return ELEMENT_DEFINITIONS.filter(def =>
    def.name.toLowerCase().includes(q) ||
    def.description?.toLowerCase().includes(q) ||
    def.tags.some(tag => tag.toLowerCase().includes(q)) ||
    def.category.toLowerCase().includes(q)
  );
}

export function getCategoryIcon(category: ElementCategory): string {
  const icons: Record<ElementCategory, string> = {
    furniture: '🪑',
    decorations: '🎨',
    tech: '💻',
    plants: '🌿',
    lighting: '💡',
    carpets: '🟫',
    wall: '🖼️',
    windows: '🪟',
    storage: '📦',
  };
  return icons[category] || '📦';
}

export function getCategoryName(category: ElementCategory): string {
  const names: Record<ElementCategory, string> = {
    furniture: 'Furniture',
    decorations: 'Decorations',
    tech: 'Tech',
    plants: 'Plants',
    lighting: 'Lighting',
    carpets: 'Carpets',
    wall: 'Wall Art',
    windows: 'Windows',
    storage: 'Storage',
  };
  return names[category] || category;
}

export const ALL_CATEGORIES: ElementCategory[] = [
  'furniture',
  'decorations',
  'tech',
  'plants',
  'lighting',
  'windows',
  'storage',
];
