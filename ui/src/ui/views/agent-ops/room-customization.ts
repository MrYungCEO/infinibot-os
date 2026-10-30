/**
 * Room Customization UI for Agent Visualization
 * Full editor for customizing agent rooms with drag-drop furniture,
 * themes/presets, agent assignments, and save/load functionality.
 * 
 * Integrates with activity-map.ts PixiJS renderer and cozy-room-assets.ts
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { styleMap } from 'lit/directives/style-map.js';
import * as PIXI from 'pixi.js';
import gsap from 'gsap';
import { rafLoop, type SchedulerHandle } from '../../perf/visibility-scheduler';
import { icons } from '../../icons';

import {
  loadCozyRoomAssets,
  areTexturesLoaded,
  getCozyTextures,
  createRoomSprite,
  createDeskSprite,
  createChairSprite,
  createSofaSprite,
  createLaptopSprite,
  createPlantSprite,
  createCarpetSprite,
  createCoffeeSprite,
  createTeddySprite,
  createBookcaseSprite,
  createTelevisionSprite,
  createWindowSprite,
  createLittleTableSprite,
  createCandleSprite,
  createDecorativeLampSprite,
  createDecorativeLightSprite,
  createDogSprite,
  createWallPaintingSprite,
  createLampSprite,
  DESK_FRAMES,
  CHAIR_FRAMES,
  SOFA_FRAMES,
  PLANT_FRAMES,
  LAPTOP_FRAMES,
  COFFEE_FRAMES,
  LITTLE_TABLE_FRAMES,
  WINDOW_FRAMES,
  TEDDY_FRAMES,
  type DeskColor,
  type ChairColor,
  type SofaColor,
  type PlantVariant,
} from './cozy-room-assets';

// ════════════════════════════════════════════════════════════════
// TYPES & INTERFACES
// ════════════════════════════════════════════════════════════════

export type FurnitureCategory = 'desks' | 'chairs' | 'sofas' | 'plants' | 'decorations' | 'carpets' | 'all';

export interface FurnitureItem {
  id: string;
  category: FurnitureCategory;
  type: string;       // e.g., 'desk', 'chair', 'sofa'
  variant: string;    // e.g., 'beige', 'blue', 'plant1'
  x: number;
  y: number;
  scale: number;
  rotation: number;
  zIndex: number;
  locked?: boolean;
}

export interface AgentAssignment {
  agentId: string;
  label: string;
  workspaceId: string; // Links to a furniture item (usually a desk)
  position: 'desk' | 'sofa' | 'standing';
}

export interface RoomTheme {
  id: string;
  name: string;
  description: string;
  icon: string;
  roomVariant: 'room1' | 'room2';
  carpetColor: string;
  defaultFurniture: Omit<FurnitureItem, 'id'>[];
  premium?: boolean;
  floorStyle?: FloorStyle;
  wallStyle?: WallStyle;
}

export interface RoomConfiguration {
  id: string;
  name: string;
  theme: string;
  roomVariant: 'room1' | 'room2';
  carpetColor: string;
  furniture: FurnitureItem[];
  agentAssignments: AgentAssignment[];
  createdAt: number;
  updatedAt: number;
}

// ════════════════════════════════════════════════════════════════
// ROOM THEMES/PRESETS
// ════════════════════════════════════════════════════════════════

const ROOM_THEMES: RoomTheme[] = [
  {
    id: 'office',
    name: 'Professional Office',
    description: 'Clean workspace with multiple desks for productivity',
    icon: '🏢',
    roomVariant: 'room1',
    carpetColor: 'blue',
    defaultFurniture: [
      { category: 'desks', type: 'desk', variant: 'beige', x: -40, y: 20, scale: 1.2, rotation: 0, zIndex: 20 },
      { category: 'desks', type: 'desk', variant: 'gray', x: 40, y: 20, scale: 1.2, rotation: 0, zIndex: 20 },
      { category: 'chairs', type: 'chair', variant: 'black', x: -40, y: 40, scale: 1.2, rotation: 0, zIndex: 15 },
      { category: 'chairs', type: 'chair', variant: 'black', x: 40, y: 40, scale: 1.2, rotation: 0, zIndex: 15 },
      { category: 'decorations', type: 'laptop', variant: 'silver', x: -45, y: 5, scale: 0.8, rotation: 0, zIndex: 25 },
      { category: 'decorations', type: 'laptop', variant: 'dark', x: 35, y: 5, scale: 0.8, rotation: 0, zIndex: 25 },
      { category: 'plants', type: 'plant', variant: 'plant1', x: 60, y: 35, scale: 1.3, rotation: 0, zIndex: 30 },
      { category: 'decorations', type: 'bookcase', variant: 'default', x: -65, y: -20, scale: 1.0, rotation: 0, zIndex: 5 },
      { category: 'decorations', type: 'window', variant: 'brown', x: 70, y: -35, scale: 0.9, rotation: 0, zIndex: 2 },
      { category: 'decorations', type: 'littleTable', variant: 'white', x: 70, y: 20, scale: 1.1, rotation: 0, zIndex: 22 },
      { category: 'decorations', type: 'coffee', variant: 'cup1', x: 63, y: 14, scale: 0.9, rotation: 0, zIndex: 26 },
      { category: 'decorations', type: 'teddy', variant: 'cream', x: -75, y: 30, scale: 1.0, rotation: 0, zIndex: 32 },
      { category: 'plants', type: 'plant', variant: 'plant5', x: -75, y: -5, scale: 1.1, rotation: 0, zIndex: 31 },
    ],
  },
  {
    id: 'lounge',
    name: 'Cozy Lounge',
    description: 'Relaxed environment with sofas and entertainment',
    icon: '🛋️',
    roomVariant: 'room2',
    carpetColor: 'purple',
    defaultFurniture: [
      { category: 'sofas', type: 'sofa', variant: 'brown', x: -35, y: 25, scale: 1.3, rotation: 0, zIndex: 20 },
      { category: 'sofas', type: 'sofa', variant: 'gray', x: 35, y: 25, scale: 1.3, rotation: 0, zIndex: 20 },
      { category: 'decorations', type: 'littleTable', variant: 'brown', x: 0, y: 35, scale: 1.5, rotation: 0, zIndex: 15 },
      { category: 'decorations', type: 'television', variant: 'default', x: 0, y: -30, scale: 1.2, rotation: 0, zIndex: 10 },
      { category: 'decorations', type: 'coffee', variant: 'cup1', x: 5, y: 30, scale: 1.2, rotation: 0, zIndex: 25 },
      { category: 'plants', type: 'plant', variant: 'plant3', x: -60, y: 10, scale: 1.4, rotation: 0, zIndex: 30 },
      { category: 'plants', type: 'plant', variant: 'plant5', x: 60, y: 10, scale: 1.4, rotation: 0, zIndex: 30 },
      { category: 'decorations', type: 'teddy', variant: 'cream', x: 50, y: 45, scale: 1.5, rotation: 0, zIndex: 35 },
      { category: 'decorations', type: 'window', variant: 'curtain', x: -70, y: -30, scale: 0.9, rotation: 0, zIndex: 3 },
      { category: 'decorations', type: 'coffee', variant: 'cup2', x: -5, y: 32, scale: 0.9, rotation: 0, zIndex: 26 },
      { category: 'decorations', type: 'littleTable', variant: 'purple', x: -60, y: 35, scale: 1.0, rotation: 0, zIndex: 18 },
      { category: 'plants', type: 'plant', variant: 'plant7', x: 68, y: -10, scale: 1.1, rotation: 0, zIndex: 28 },
    ],
  },
  {
    id: 'cozy',
    name: 'Cozy Home',
    description: 'Warm and inviting personal workspace',
    icon: '🏠',
    roomVariant: 'room1',
    carpetColor: 'red',
    defaultFurniture: [
      { category: 'desks', type: 'desk', variant: 'pink', x: 0, y: 15, scale: 1.3, rotation: 0, zIndex: 20 },
      { category: 'chairs', type: 'chair', variant: 'red', x: 0, y: 35, scale: 1.3, rotation: 0, zIndex: 15 },
      { category: 'decorations', type: 'laptop', variant: 'silver', x: -5, y: 0, scale: 0.8, rotation: 0, zIndex: 25 },
      { category: 'decorations', type: 'coffee', variant: 'cup2', x: 20, y: 5, scale: 1.0, rotation: 0, zIndex: 25 },
      { category: 'sofas', type: 'sofa', variant: 'red', x: 45, y: 10, scale: 1.0, rotation: 0, zIndex: 18 },
      { category: 'plants', type: 'plant', variant: 'plant2', x: -55, y: 30, scale: 1.4, rotation: 0, zIndex: 30 },
      { category: 'plants', type: 'plant', variant: 'plant6', x: 55, y: 30, scale: 1.2, rotation: 0, zIndex: 30 },
      { category: 'decorations', type: 'teddy', variant: 'brown', x: 60, y: 45, scale: 1.3, rotation: 0, zIndex: 35 },
      { category: 'decorations', type: 'bookcase', variant: 'default', x: -60, y: -15, scale: 0.9, rotation: 0, zIndex: 5 },
      { category: 'decorations', type: 'window', variant: 'pink', x: 65, y: -30, scale: 0.9, rotation: 0, zIndex: 3 },
      { category: 'decorations', type: 'littleTable', variant: 'pink', x: 50, y: 20, scale: 0.9, rotation: 0, zIndex: 17 },
      { category: 'decorations', type: 'coffee', variant: 'cup3', x: 48, y: 15, scale: 0.85, rotation: 0, zIndex: 26 },
      { category: 'plants', type: 'plant', variant: 'plant4', x: -70, y: -5, scale: 1.1, rotation: 0, zIndex: 29 },
    ],
  },
  {
    id: 'minimal',
    name: 'Minimalist',
    description: 'Clean and focused with only essentials',
    icon: '✨',
    roomVariant: 'room1',
    carpetColor: 'default',
    defaultFurniture: [
      { category: 'desks', type: 'desk', variant: 'gray', x: 0, y: 20, scale: 1.4, rotation: 0, zIndex: 20 },
      { category: 'chairs', type: 'chair', variant: 'white', x: 0, y: 40, scale: 1.4, rotation: 0, zIndex: 15 },
      { category: 'decorations', type: 'laptop', variant: 'silver', x: -5, y: 5, scale: 0.9, rotation: 0, zIndex: 25 },
      { category: 'plants', type: 'plant', variant: 'plant4', x: 55, y: 35, scale: 1.5, rotation: 0, zIndex: 30 },
      { category: 'decorations', type: 'window', variant: 'teal', x: -65, y: -30, scale: 0.85, rotation: 0, zIndex: 3 },
      { category: 'decorations', type: 'littleTable', variant: 'gray', x: 50, y: 25, scale: 0.9, rotation: 0, zIndex: 19 },
      { category: 'decorations', type: 'coffee', variant: 'cup4', x: 47, y: 20, scale: 0.8, rotation: 0, zIndex: 26 },
    ],
  },
  {
    id: 'tech-hub',
    name: 'Tech Hub',
    description: 'High-tech setup for the AI operations center',
    icon: '🤖',
    roomVariant: 'room2',
    carpetColor: 'green',
    defaultFurniture: [
      { category: 'desks', type: 'desk', variant: 'blue', x: -40, y: 15, scale: 1.2, rotation: 0, zIndex: 20 },
      { category: 'desks', type: 'desk', variant: 'purple', x: 40, y: 15, scale: 1.2, rotation: 0, zIndex: 20 },
      { category: 'desks', type: 'desk', variant: 'yellow', x: 0, y: 35, scale: 1.2, rotation: 0, zIndex: 22 },
      { category: 'chairs', type: 'chair', variant: 'blue', x: -40, y: 35, scale: 1.2, rotation: 0, zIndex: 15 },
      { category: 'chairs', type: 'chair', variant: 'purple', x: 40, y: 35, scale: 1.2, rotation: 0, zIndex: 15 },
      { category: 'chairs', type: 'chair', variant: 'green', x: 0, y: 55, scale: 1.2, rotation: 0, zIndex: 17 },
      { category: 'decorations', type: 'laptop', variant: 'silver', x: -45, y: 0, scale: 0.7, rotation: 0, zIndex: 25 },
      { category: 'decorations', type: 'laptop', variant: 'dark', x: 35, y: 0, scale: 0.7, rotation: 0, zIndex: 25 },
      { category: 'decorations', type: 'laptop', variant: 'silver', x: -5, y: 20, scale: 0.7, rotation: 0, zIndex: 27 },
      { category: 'decorations', type: 'television', variant: 'default', x: 0, y: -35, scale: 1.3, rotation: 0, zIndex: 8 },
      { category: 'plants', type: 'plant', variant: 'plant7', x: -60, y: 45, scale: 1.2, rotation: 0, zIndex: 30 },
      { category: 'plants', type: 'plant', variant: 'plant8', x: 60, y: 45, scale: 1.2, rotation: 0, zIndex: 30 },
      { category: 'decorations', type: 'window', variant: 'brown', x: 75, y: -25, scale: 0.9, rotation: 0, zIndex: 3 },
      { category: 'decorations', type: 'bookcase', variant: 'default', x: -70, y: -15, scale: 0.85, rotation: 0, zIndex: 6 },
      { category: 'decorations', type: 'coffee', variant: 'cup1', x: -50, y: 8, scale: 0.7, rotation: 0, zIndex: 26 },
      { category: 'decorations', type: 'coffee', variant: 'cup3', x: 45, y: 8, scale: 0.7, rotation: 0, zIndex: 26 },
    ],
  },
  {
    id: 'art-deco-office',
    name: 'Art Deco Office',
    description: 'Rich gold and black with geometric patterns and ornate details',
    icon: '🏛️',
    roomVariant: 'room2',
    carpetColor: 'purple',
    premium: true,
    floorStyle: 'carpet-artdeco',
    wallStyle: 'accent-stripes',
    defaultFurniture: [
      { category: 'desks', type: 'desk', variant: 'yellow', x: 0, y: 20, scale: 1.3, rotation: 0, zIndex: 20 },
      { category: 'chairs', type: 'chair', variant: 'brown', x: 0, y: 40, scale: 1.1, rotation: 0, zIndex: 15 },
      { category: 'decorations', type: 'laptop', variant: 'dark', x: -5, y: 5, scale: 0.85, rotation: 0, zIndex: 25 },
      { category: 'decorations', type: 'bookcase', variant: 'default', x: -65, y: -15, scale: 1.1, rotation: 0, zIndex: 5 },
      { category: 'decorations', type: 'television', variant: 'default', x: 60, y: -25, scale: 1.0, rotation: 0, zIndex: 8 },
      { category: 'plants', type: 'plant', variant: 'plant6', x: -72, y: 25, scale: 1.3, rotation: 0, zIndex: 30 },
      { category: 'plants', type: 'plant', variant: 'plant8', x: 68, y: 25, scale: 1.2, rotation: 0, zIndex: 30 },
      { category: 'decorations', type: 'window', variant: 'curtain', x: 75, y: -30, scale: 0.85, rotation: 0, zIndex: 3 },
      { category: 'decorations', type: 'littleTable', variant: 'brown', x: 55, y: 30, scale: 1.0, rotation: 0, zIndex: 18 },
      { category: 'decorations', type: 'coffee', variant: 'cup1', x: 52, y: 25, scale: 0.85, rotation: 0, zIndex: 26 },
      { category: 'chairs', type: 'chair', variant: 'brown', x: -30, y: 50, scale: 0.9, rotation: 0, zIndex: 16 },
      { category: 'decorations', type: 'teddy', variant: 'cream', x: -68, y: 40, scale: 1.0, rotation: 0, zIndex: 33 },
    ],
  },
  {
    id: 'cyberpunk-den',
    name: 'Cyberpunk Den',
    description: 'Neon-lit dark room with cyan/magenta accents and holographic displays',
    icon: '🌃',
    roomVariant: 'room2',
    carpetColor: 'default',
    premium: true,
    floorStyle: 'concrete',
    wallStyle: 'space-panel',
    defaultFurniture: [
      { category: 'desks', type: 'desk', variant: 'purple', x: -35, y: 15, scale: 1.3, rotation: 0, zIndex: 20 },
      { category: 'desks', type: 'desk', variant: 'blue', x: 35, y: 15, scale: 1.3, rotation: 0, zIndex: 20 },
      { category: 'chairs', type: 'chair', variant: 'purple', x: -35, y: 35, scale: 1.2, rotation: 0, zIndex: 15 },
      { category: 'chairs', type: 'chair', variant: 'blue', x: 35, y: 35, scale: 1.2, rotation: 0, zIndex: 15 },
      { category: 'decorations', type: 'laptop', variant: 'dark', x: -40, y: 0, scale: 0.8, rotation: 0, zIndex: 25 },
      { category: 'decorations', type: 'laptop', variant: 'silver', x: 30, y: 0, scale: 0.8, rotation: 0, zIndex: 25 },
      { category: 'decorations', type: 'television', variant: 'default', x: 0, y: -30, scale: 1.4, rotation: 0, zIndex: 8 },
      { category: 'plants', type: 'plant', variant: 'plant7', x: -65, y: 30, scale: 1.1, rotation: 0, zIndex: 30 },
      { category: 'plants', type: 'plant', variant: 'plant8', x: 65, y: 30, scale: 1.1, rotation: 0, zIndex: 30 },
      { category: 'decorations', type: 'coffee', variant: 'cup1', x: -50, y: 5, scale: 0.7, rotation: 0, zIndex: 26 },
      { category: 'decorations', type: 'window', variant: 'teal', x: 75, y: -25, scale: 0.9, rotation: 0, zIndex: 3 },
      { category: 'decorations', type: 'bookcase', variant: 'default', x: -70, y: -10, scale: 0.9, rotation: 0, zIndex: 6 },
      { category: 'decorations', type: 'teddy', variant: 'gray', x: 70, y: 45, scale: 1.0, rotation: 0, zIndex: 33 },
    ],
  },
  {
    id: 'japanese-zen',
    name: 'Japanese Zen',
    description: 'Minimal tatami floor, low desk, zabuton cushions, and shoji screens',
    icon: '⛩️',
    roomVariant: 'room1',
    carpetColor: 'default',
    premium: true,
    floorStyle: 'tatami',
    wallStyle: 'shoji',
    defaultFurniture: [
      { category: 'desks', type: 'desk', variant: 'beige', x: 0, y: 25, scale: 1.1, rotation: 0, zIndex: 20 },
      { category: 'chairs', type: 'chair', variant: 'brown', x: 0, y: 42, scale: 0.9, rotation: 0, zIndex: 15 },
      { category: 'decorations', type: 'laptop', variant: 'silver', x: -5, y: 12, scale: 0.7, rotation: 0, zIndex: 25 },
      { category: 'plants', type: 'plant', variant: 'plant7', x: -60, y: 30, scale: 1.5, rotation: 0, zIndex: 30 },
      { category: 'plants', type: 'plant', variant: 'plant4', x: 60, y: 20, scale: 1.2, rotation: 0, zIndex: 30 },
      { category: 'decorations', type: 'coffee', variant: 'cup2', x: 20, y: 18, scale: 0.85, rotation: 0, zIndex: 26 },
      { category: 'decorations', type: 'window', variant: 'brown', x: 70, y: -30, scale: 0.9, rotation: 0, zIndex: 3 },
      { category: 'decorations', type: 'littleTable', variant: 'brown', x: 55, y: 35, scale: 0.9, rotation: 0, zIndex: 18 },
      { category: 'decorations', type: 'bookcase', variant: 'default', x: -65, y: -15, scale: 0.85, rotation: 0, zIndex: 5 },
      { category: 'decorations', type: 'teddy', variant: 'cream', x: -50, y: 45, scale: 0.9, rotation: 0, zIndex: 33 },
      { category: 'plants', type: 'plant', variant: 'plant2', x: 70, y: 0, scale: 1.1, rotation: 0, zIndex: 28 },
    ],
  },
  {
    id: 'victorian-library',
    name: 'Victorian Library',
    description: 'Dark wood paneling, wingback chair, mahogany desk, and Persian carpet',
    icon: '📚',
    roomVariant: 'room2',
    carpetColor: 'red',
    premium: true,
    floorStyle: 'parquet',
    wallStyle: 'dark-paneling',
    defaultFurniture: [
      { category: 'desks', type: 'desk', variant: 'beige', x: 0, y: 20, scale: 1.3, rotation: 0, zIndex: 20 },
      { category: 'chairs', type: 'chair', variant: 'brown', x: 0, y: 40, scale: 1.2, rotation: 0, zIndex: 15 },
      { category: 'decorations', type: 'bookcase', variant: 'default', x: -60, y: -15, scale: 1.2, rotation: 0, zIndex: 5 },
      { category: 'decorations', type: 'bookcase', variant: 'default', x: 60, y: -15, scale: 1.0, rotation: 0, zIndex: 5 },
      { category: 'decorations', type: 'laptop', variant: 'dark', x: -5, y: 5, scale: 0.8, rotation: 0, zIndex: 25 },
      { category: 'decorations', type: 'coffee', variant: 'cup2', x: 25, y: 10, scale: 0.9, rotation: 0, zIndex: 26 },
      { category: 'plants', type: 'plant', variant: 'plant2', x: -70, y: 30, scale: 1.3, rotation: 0, zIndex: 30 },
      { category: 'plants', type: 'plant', variant: 'plant6', x: 68, y: 30, scale: 1.1, rotation: 0, zIndex: 30 },
      { category: 'decorations', type: 'window', variant: 'curtain', x: -75, y: -30, scale: 0.9, rotation: 0, zIndex: 3 },
      { category: 'decorations', type: 'television', variant: 'default', x: -35, y: -25, scale: 0.9, rotation: 0, zIndex: 8 },
      { category: 'sofas', type: 'sofa', variant: 'brown', x: 40, y: 35, scale: 0.9, rotation: 0, zIndex: 18 },
      { category: 'decorations', type: 'teddy', variant: 'brown', x: 50, y: 50, scale: 1.1, rotation: 0, zIndex: 33 },
      { category: 'decorations', type: 'littleTable', variant: 'brown', x: 55, y: 30, scale: 0.85, rotation: 0, zIndex: 17 },
    ],
  },
  {
    id: 'space-station',
    name: 'Space Station',
    description: 'Metallic floors, zero-G indicators, viewport with stars, and control panels',
    icon: '🚀',
    roomVariant: 'room2',
    carpetColor: 'default',
    premium: true,
    floorStyle: 'metal-grate',
    wallStyle: 'space-panel',
    defaultFurniture: [
      { category: 'desks', type: 'desk', variant: 'gray', x: -35, y: 15, scale: 1.2, rotation: 0, zIndex: 20 },
      { category: 'desks', type: 'desk', variant: 'blue', x: 35, y: 15, scale: 1.2, rotation: 0, zIndex: 20 },
      { category: 'chairs', type: 'chair', variant: 'black', x: -35, y: 35, scale: 1.2, rotation: 0, zIndex: 15 },
      { category: 'chairs', type: 'chair', variant: 'blue', x: 35, y: 35, scale: 1.2, rotation: 0, zIndex: 15 },
      { category: 'decorations', type: 'laptop', variant: 'silver', x: -40, y: 0, scale: 0.8, rotation: 0, zIndex: 25 },
      { category: 'decorations', type: 'laptop', variant: 'dark', x: 30, y: 0, scale: 0.8, rotation: 0, zIndex: 25 },
      { category: 'decorations', type: 'television', variant: 'default', x: 0, y: -30, scale: 1.5, rotation: 0, zIndex: 8 },
      { category: 'decorations', type: 'window', variant: 'teal', x: 75, y: -25, scale: 0.9, rotation: 0, zIndex: 3 },
      { category: 'plants', type: 'plant', variant: 'plant7', x: -65, y: 35, scale: 1.0, rotation: 0, zIndex: 30 },
      { category: 'plants', type: 'plant', variant: 'plant8', x: 65, y: 35, scale: 1.0, rotation: 0, zIndex: 30 },
      { category: 'decorations', type: 'bookcase', variant: 'default', x: -70, y: -10, scale: 0.85, rotation: 0, zIndex: 6 },
      { category: 'decorations', type: 'coffee', variant: 'cup3', x: -50, y: 5, scale: 0.7, rotation: 0, zIndex: 26 },
      { category: 'decorations', type: 'littleTable', variant: 'gray', x: 0, y: 40, scale: 1.0, rotation: 0, zIndex: 22 },
      { category: 'chairs', type: 'chair', variant: 'white', x: 0, y: 58, scale: 1.0, rotation: 0, zIndex: 16 },
      { category: 'decorations', type: 'teddy', variant: 'gray', x: 70, y: 50, scale: 0.9, rotation: 0, zIndex: 33 },
    ],
  },
];

// ════════════════════════════════════════════════════════════════
// FURNITURE PALETTE - Available items for drag-drop
// ════════════════════════════════════════════════════════════════

interface PaletteItem {
  type: string;
  variant: string;
  category: FurnitureCategory;
  name: string;
  icon: string;
}

const FURNITURE_PALETTE: PaletteItem[] = [
  // Desks
  { type: 'desk', variant: 'beige', category: 'desks', name: 'Beige Desk', icon: '🪵' },
  { type: 'desk', variant: 'gray', category: 'desks', name: 'Gray Desk', icon: '⬜' },
  { type: 'desk', variant: 'blue', category: 'desks', name: 'Blue Desk', icon: '🔵' },
  { type: 'desk', variant: 'purple', category: 'desks', name: 'Purple Desk', icon: '🟣' },
  { type: 'desk', variant: 'pink', category: 'desks', name: 'Pink Desk', icon: '🩷' },
  { type: 'desk', variant: 'yellow', category: 'desks', name: 'Yellow Desk', icon: '🟡' },
  
  // Chairs
  { type: 'chair', variant: 'black', category: 'chairs', name: 'Black Chair', icon: '⬛' },
  { type: 'chair', variant: 'red', category: 'chairs', name: 'Red Chair', icon: '🔴' },
  { type: 'chair', variant: 'blue', category: 'chairs', name: 'Blue Chair', icon: '🔵' },
  { type: 'chair', variant: 'green', category: 'chairs', name: 'Green Chair', icon: '🟢' },
  { type: 'chair', variant: 'purple', category: 'chairs', name: 'Purple Chair', icon: '🟣' },
  { type: 'chair', variant: 'brown', category: 'chairs', name: 'Brown Chair', icon: '🟤' },
  { type: 'chair', variant: 'white', category: 'chairs', name: 'White Chair', icon: '⬜' },
  { type: 'chair', variant: 'olive', category: 'chairs', name: 'Olive Chair', icon: '🫒' },
  
  // Sofas
  { type: 'sofa', variant: 'brown', category: 'sofas', name: 'Brown Sofa', icon: '🟤' },
  { type: 'sofa', variant: 'gray', category: 'sofas', name: 'Gray Sofa', icon: '⬜' },
  { type: 'sofa', variant: 'purple', category: 'sofas', name: 'Purple Sofa', icon: '🟣' },
  { type: 'sofa', variant: 'beige', category: 'sofas', name: 'Beige Sofa', icon: '🪵' },
  { type: 'sofa', variant: 'red', category: 'sofas', name: 'Red Sofa', icon: '🔴' },
  { type: 'sofa', variant: 'teal', category: 'sofas', name: 'Teal Sofa', icon: '🩵' },
  
  // Plants
  { type: 'plant', variant: 'plant1', category: 'plants', name: 'Small Fern', icon: '🌱' },
  { type: 'plant', variant: 'plant2', category: 'plants', name: 'Potted Palm', icon: '🌴' },
  { type: 'plant', variant: 'plant3', category: 'plants', name: 'Snake Plant', icon: '🌿' },
  { type: 'plant', variant: 'plant4', category: 'plants', name: 'Cactus', icon: '🌵' },
  { type: 'plant', variant: 'plant5', category: 'plants', name: 'Succulent', icon: '🪴' },
  { type: 'plant', variant: 'plant6', category: 'plants', name: 'Monstera', icon: '🌿' },
  { type: 'plant', variant: 'plant7', category: 'plants', name: 'Bamboo', icon: '🎋' },
  { type: 'plant', variant: 'plant8', category: 'plants', name: 'Ficus', icon: '🌳' },
  
  // Decorations
  { type: 'laptop', variant: 'silver', category: 'decorations', name: 'Silver Laptop', icon: '💻' },
  { type: 'laptop', variant: 'dark', category: 'decorations', name: 'Dark Laptop', icon: '🖥️' },
  { type: 'coffee', variant: 'cup1', category: 'decorations', name: 'Coffee Cup', icon: '☕' },
  { type: 'coffee', variant: 'cup2', category: 'decorations', name: 'Tea Cup', icon: '🍵' },
  { type: 'coffee', variant: 'cup3', category: 'decorations', name: 'Mug', icon: '🫖' },
  { type: 'bookcase', variant: 'default', category: 'decorations', name: 'Bookcase', icon: '📚' },
  { type: 'television', variant: 'default', category: 'decorations', name: 'TV', icon: '📺' },
  { type: 'littleTable', variant: 'brown', category: 'decorations', name: 'Coffee Table', icon: '🪵' },
  { type: 'littleTable', variant: 'white', category: 'decorations', name: 'Side Table', icon: '⬜' },
  { type: 'teddy', variant: 'brown', category: 'decorations', name: 'Brown Teddy', icon: '🧸' },
  { type: 'teddy', variant: 'cream', category: 'decorations', name: 'Cream Teddy', icon: '🧸' },
  { type: 'teddy', variant: 'gray', category: 'decorations', name: 'Gray Teddy', icon: '🧸' },
  { type: 'window', variant: 'brown', category: 'decorations', name: 'Window', icon: '🪟' },
  { type: 'window', variant: 'curtain', category: 'decorations', name: 'Curtain Window', icon: '🪟' },
  { type: 'wallpainting', variant: 'default', category: 'decorations', name: 'Wall Painting', icon: '🖼️' },
  { type: 'candle', variant: 'default', category: 'decorations', name: 'Candle', icon: '🕯️' },
  { type: 'decorativeLamp', variant: 'default', category: 'decorations', name: 'Deco Lamp', icon: '💡' },
  { type: 'decorativeLight', variant: 'default', category: 'decorations', name: 'Deco Light', icon: '✨' },
  { type: 'lamp', variant: 'default', category: 'decorations', name: 'Lamp', icon: '🔦' },
  { type: 'dog', variant: 'default', category: 'decorations', name: 'Dog', icon: '🐕' },
];

// ════════════════════════════════════════════════════════════════
// CARPET OPTIONS
// ════════════════════════════════════════════════════════════════

const CARPET_OPTIONS = [
  { id: 'default', name: 'Natural', icon: '🪵', color: '#c4a574' },
  { id: 'blue', name: 'Blue', icon: '🔵', color: '#4a90d9' },
  { id: 'green', name: 'Green', icon: '🟢', color: '#5ab55a' },
  { id: 'red', name: 'Red', icon: '🔴', color: '#d94a4a' },
  { id: 'purple', name: 'Purple', icon: '🟣', color: '#9b59b6' },
];

// ════════════════════════════════════════════════════════════════
// STORAGE KEYS
// ════════════════════════════════════════════════════════════════

const STORAGE_KEY_CONFIGS = 'infinibot-room-configurations';
const STORAGE_KEY_ACTIVE = 'infinibot-active-room-config';

// ════════════════════════════════════════════════════════════════
// ROOM CUSTOMIZATION COMPONENT
// ════════════════════════════════════════════════════════════════

@customElement('room-customization')
export class RoomCustomization extends LitElement {
  static styles = css`
    :host {
      display: block;
      font-family: 'JetBrains Mono', 'SF Mono', 'Consolas', monospace;
      color: #e4e4e7;
    }

    .editor-container {
      display: grid;
      grid-template-columns: 280px 1fr 240px;
      grid-template-rows: auto 1fr;
      gap: 16px;
      height: 100%;
      min-height: 600px;
      background: #050505;
      padding: 16px;
      box-sizing: border-box;
    }

    /* Header */
    .header {
      grid-column: 1 / -1;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      background: #0a0a0a;
      border: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
      border-radius: 10px;
    }

    .header-title {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .header-title h2 {
      margin: 0;
      font-size: 18px;
      font-weight: 600;
      color: var(--g-primary);
    }

    .header-actions {
      display: flex;
      gap: 10px;
    }

    /* Panels */
    .panel {
      background: #0a0a0a;
      border: 1px solid #1a1a1a;
      border-radius: 10px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 14px;
      background: #0f0f0f;
      border-bottom: 1px solid #1a1a1a;
    }

    .panel-title {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--g-primary);
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .panel-content {
      flex: 1;
      padding: 12px;
      overflow-y: auto;
    }

    /* Furniture Palette */
    .category-tabs {
      display: flex;
      gap: 4px;
      margin-bottom: 12px;
      flex-wrap: wrap;
    }

    .category-tab {
      padding: 6px 10px;
      background: transparent;
      border: 1px solid #27272a;
      border-radius: 6px;
      color: #71717a;
      font-size: 10px;
      text-transform: uppercase;
      cursor: pointer;
      transition: all 0.2s;
      font-family: inherit;
    }

    .category-tab:hover {
      border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
      color: #e4e4e7;
    }

    .category-tab.active {
      background: color-mix(in srgb, var(--g-primary) 10%, transparent);
      border-color: color-mix(in srgb, var(--g-primary) 40%, transparent);
      color: var(--g-primary);
    }

    .furniture-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 8px;
    }

    .furniture-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      padding: 10px 6px;
      background: #0f0f0f;
      border: 1px solid #1a1a1a;
      border-radius: 8px;
      cursor: grab;
      transition: all 0.2s;
    }

    .furniture-item:hover {
      background: #141414;
      border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
      transform: translateY(-2px);
    }

    .furniture-item:active {
      cursor: grabbing;
      transform: scale(0.95);
    }

    .furniture-item .icon {
      font-size: 24px;
    }

    .furniture-item .name {
      font-size: 9px;
      color: #71717a;
      text-align: center;
      line-height: 1.2;
    }

    /* Preview Canvas */
    .preview-panel {
      position: relative;
    }

    .preview-canvas-container {
      flex: 1;
      position: relative;
      background: #87ceeb;
      border-radius: 6px;
      overflow: hidden;
      min-height: 400px;
    }

    .preview-canvas-container canvas {
      width: 100% !important;
      height: 100% !important;
    }

    .preview-overlay {
      position: absolute;
      bottom: 12px;
      left: 12px;
      right: 12px;
      display: flex;
      justify-content: space-between;
      pointer-events: none;
    }

    .preview-info {
      padding: 8px 12px;
      background: rgba(0, 0, 0, 0.7);
      border-radius: 6px;
      font-size: 11px;
      color: #e4e4e7;
      pointer-events: auto;
    }

    .preview-controls {
      display: flex;
      gap: 8px;
      pointer-events: auto;
    }

    /* Properties Panel */
    .properties-section {
      margin-bottom: 16px;
    }

    .properties-section-title {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #71717a;
      margin-bottom: 8px;
    }

    /* Theme selector */
    .theme-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 8px;
    }

    .theme-card {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      padding: 12px 8px;
      background: #0f0f0f;
      border: 2px solid #1a1a1a;
      border-radius: 10px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .theme-card:hover {
      background: #141414;
      border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
    }

    .theme-card.active {
      border-color: var(--g-primary);
      background: color-mix(in srgb, var(--g-primary) 8%, transparent);
    }

    .theme-card.premium {
      border-color: color-mix(in srgb, #d4af37 40%, transparent);
      background: color-mix(in srgb, #d4af37 5%, transparent);
    }

    .theme-card.premium .premium-badge {
      font-size: 8px;
      color: #d4af37;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .theme-card .icon {
      font-size: 28px;
    }

    .theme-card .name {
      font-size: 10px;
      font-weight: 500;
      color: #e4e4e7;
      text-align: center;
    }

    /* Carpet selector */
    .carpet-grid {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .carpet-option {
      width: 36px;
      height: 36px;
      border-radius: 8px;
      border: 2px solid transparent;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
      transition: all 0.2s;
    }

    .carpet-option:hover {
      transform: scale(1.1);
    }

    .carpet-option.active {
      border-color: var(--g-primary);
      box-shadow: 0 0 12px color-mix(in srgb, var(--g-primary) 40%, transparent);
    }

    /* Selected item properties */
    .item-props {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .prop-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .prop-label {
      font-size: 11px;
      color: #71717a;
    }

    .prop-value {
      font-size: 11px;
      color: #e4e4e7;
    }

    .prop-slider {
      width: 100px;
      height: 4px;
      -webkit-appearance: none;
      background: #27272a;
      border-radius: 2px;
      outline: none;
    }

    .prop-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 14px;
      height: 14px;
      background: var(--g-primary);
      border-radius: 50%;
      cursor: pointer;
    }

    /* Agent assignments */
    .assignment-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .assignment-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      background: #0f0f0f;
      border: 1px solid #1a1a1a;
      border-radius: 8px;
    }

    .assignment-item .agent-icon {
      width: 32px;
      height: 32px;
      background: color-mix(in srgb, var(--g-primary) 10%, transparent);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
    }

    .assignment-item .agent-info {
      flex: 1;
    }

    .assignment-item .agent-name {
      font-size: 12px;
      font-weight: 500;
      color: #e4e4e7;
    }

    .assignment-item .agent-workspace {
      font-size: 10px;
      color: #71717a;
    }

    /* Saved configs */
    .config-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .config-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 12px;
      background: #0f0f0f;
      border: 1px solid #1a1a1a;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .config-item:hover {
      background: #141414;
      border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
    }

    .config-item.active {
      border-color: var(--g-primary);
      background: color-mix(in srgb, var(--g-primary) 8%, transparent);
    }

    .config-item .config-name {
      font-size: 12px;
      font-weight: 500;
      color: #e4e4e7;
    }

    .config-item .config-date {
      font-size: 10px;
      color: #52525b;
    }

    .config-actions {
      display: flex;
      gap: 4px;
    }

    /* Buttons */
    .btn {
      padding: 8px 14px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
      font-family: inherit;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .btn-primary {
      background: color-mix(in srgb, var(--g-primary) 15%, transparent);
      border: 1px solid color-mix(in srgb, var(--g-primary) 40%, transparent);
      color: var(--g-primary);
    }

    .btn-primary:hover {
      background: color-mix(in srgb, var(--g-primary) 25%, transparent);
      border-color: var(--g-primary);
    }

    .btn-secondary {
      background: transparent;
      border: 1px solid #27272a;
      color: #71717a;
    }

    .btn-secondary:hover {
      background: #141414;
      border-color: #3f3f46;
      color: #e4e4e7;
    }

    .btn-danger {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #ef4444;
    }

    .btn-danger:hover {
      background: rgba(239, 68, 68, 0.2);
      border-color: #ef4444;
    }

    .btn-small {
      padding: 4px 8px;
      font-size: 10px;
    }

    .btn-icon {
      width: 28px;
      height: 28px;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    /* Empty state */
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px;
      text-align: center;
      color: #52525b;
    }

    .empty-state .icon {
      font-size: 32px;
      margin-bottom: 12px;
    }

    .empty-state .message {
      font-size: 12px;
    }

    /* Input */
    .input {
      width: 100%;
      padding: 8px 12px;
      background: #0f0f0f;
      border: 1px solid #27272a;
      border-radius: 6px;
      color: #e4e4e7;
      font-size: 12px;
      font-family: inherit;
      outline: none;
      transition: border-color 0.2s;
    }

    .input:focus {
      border-color: color-mix(in srgb, var(--g-primary) 50%, transparent);
    }

    /* Scrollbar */
    .panel-content::-webkit-scrollbar {
      width: 6px;
    }

    .panel-content::-webkit-scrollbar-track {
      background: transparent;
    }

    .panel-content::-webkit-scrollbar-thumb {
      background: #27272a;
      border-radius: 3px;
    }

    .panel-content::-webkit-scrollbar-thumb:hover {
      background: #3f3f46;
    }

    /* Drop zone indicator */
    .drop-zone-active {
      outline: 2px dashed var(--g-primary);
      outline-offset: -2px;
    }

    /* Modal */
    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.8);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }

    .modal {
      background: #0a0a0a;
      border: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
      border-radius: 12px;
      padding: 20px;
      min-width: 320px;
      max-width: 90vw;
    }

    .modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }

    .modal-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--g-primary);
    }

    .modal-body {
      margin-bottom: 20px;
    }

    .modal-footer {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
    }
  `;

  // ══════════════════════════════════════════════════════════════
  // PROPERTIES
  // ══════════════════════════════════════════════════════════════

  @property({ type: Array })
  agents: { agentId: string; label: string; sessionKey: string }[] = [];

  @property({ type: Function })
  onConfigChange?: (config: RoomConfiguration) => void;

  @property({ type: Function })
  onClose?: () => void;

  // ══════════════════════════════════════════════════════════════
  // STATE
  // ══════════════════════════════════════════════════════════════

  @state() private activeTheme: string = 'office';
  @state() private carpetColor: string = 'blue';
  @state() private roomVariant: 'room1' | 'room2' = 'room1';
  @state() private furniture: FurnitureItem[] = [];
  @state() private agentAssignments: AgentAssignment[] = [];
  @state() private selectedItemId: string | null = null;
  @state() private furnitureCategory: FurnitureCategory = 'all';
  @state() private savedConfigs: RoomConfiguration[] = [];
  @state() private activeConfigId: string | null = null;
  @state() private isDragging = false;
  @state() private dragItem: PaletteItem | null = null;
  @state() private showSaveModal = false;
  @state() private saveConfigName = '';
  @state() private texturesLoaded = false;

  // PixiJS refs
  private pixiApp: PIXI.Application | null = null;
  private roomContainer: PIXI.Container | null = null;
  private furnitureSprites: Map<string, PIXI.Sprite> = new Map();
  private proceduralRoomLayer: PIXI.Container | null = null;
  private ambianceState: AmbianceState | null = null;
  private dustAnimFrame: SchedulerHandle | null = null;

  @query('.preview-canvas-container')
  private canvasContainer!: HTMLDivElement;

  // ══════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ══════════════════════════════════════════════════════════════

  connectedCallback() {
    super.connectedCallback();
    this.loadSavedConfigs();
    this.loadActiveConfig();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.destroyPixi();
  }

  firstUpdated() {
    this.initPixi();
  }

  // ══════════════════════════════════════════════════════════════
  // PIXI INITIALIZATION
  // ══════════════════════════════════════════════════════════════

  private async initPixi() {
    if (!this.canvasContainer || this.pixiApp) return;

    const width = this.canvasContainer.clientWidth || 500;
    const height = this.canvasContainer.clientHeight || 400;

    this.pixiApp = new PIXI.Application({
      width,
      height,
      backgroundColor: 0x87ceeb,
      antialias: false,
      resolution: 1,
    });

    PIXI.settings.SCALE_MODE = PIXI.SCALE_MODES.NEAREST;
    PIXI.settings.ROUND_PIXELS = true;

    this.canvasContainer.appendChild(this.pixiApp.view as HTMLCanvasElement);

    // Setup room container
    this.roomContainer = new PIXI.Container();
    this.roomContainer.sortableChildren = true;
    this.roomContainer.position.set(width / 2, height / 2);
    this.pixiApp.stage.addChild(this.roomContainer);

    // Load textures
    await this.loadTextures();
    
    // Apply initial theme
    this.applyTheme(this.activeTheme);
  }

  private async loadTextures() {
    try {
      await loadCozyRoomAssets();
      this.texturesLoaded = true;
      this.renderRoom();
    } catch (err) {
      console.warn('[RoomCustomization] Failed to load textures:', err);
    }
  }

  private destroyPixi() {
    if (this.dustAnimFrame != null) {
      this.dustAnimFrame.cancel();
      this.dustAnimFrame = null;
    }
    if (this.pixiApp) {
      this.pixiApp.destroy(true, { children: true, texture: false, baseTexture: false });
      this.pixiApp = null;
      this.roomContainer = null;
      this.furnitureSprites.clear();
      this.proceduralRoomLayer = null;
    }
  }

  private startDustAnimation() {
    if (!this.proceduralRoomLayer || !this.pixiApp) return;
    const canvasW = 240;
    const canvasH = 180;
    if (!this.ambianceState) {
      this.ambianceState = {
        dustParticles: generateDustParticles(canvasW, canvasH, 15),
      };
    }
    const animate = () => {
      this.ambianceState!.dustParticles = updateDustParticles(
        this.ambianceState!.dustParticles,
        canvasW,
        canvasH
      );
      if (this.pixiApp) {
        this.pixiApp.renderer.render(this.pixiApp.stage);
      }
    };
    this.dustAnimFrame = rafLoop(animate);
  }

  // ══════════════════════════════════════════════════════════════
  // ROOM RENDERING
  // ══════════════════════════════════════════════════════════════

  private renderRoom() {
    if (!this.roomContainer || !this.texturesLoaded) return;

    this.roomContainer.removeChildren();
    this.furnitureSprites.clear();

    if (this.dustAnimFrame != null) {
      this.dustAnimFrame.cancel();
      this.dustAnimFrame = null;
    }

    const scale = 1.5;
    const currentTheme = ROOM_THEMES.find(t => t.id === this.activeTheme);

    if (currentTheme?.floorStyle || currentTheme?.wallStyle) {
      const canvasW = 240;
      const canvasH = 180;
      const procContainer = createProceduralRoomGraphics(canvasW, canvasH, {
        floorStyle: currentTheme.floorStyle ?? 'parquet',
        wallStyle: currentTheme.wallStyle ?? 'wainscoting',
        ambiance: true,
      });
      procContainer.scale.set(scale * 2);
      procContainer.position.set(-canvasW * scale, -canvasH * scale * 0.6);
      procContainer.zIndex = -2;
      this.roomContainer.addChild(procContainer);
      this.proceduralRoomLayer = procContainer;
    } else {
      this.proceduralRoomLayer = null;
    }

    const roomSprite = createRoomSprite(this.roomVariant);
    if (roomSprite) {
      roomSprite.scale.set(scale);
      roomSprite.zIndex = 0;
      this.roomContainer.addChild(roomSprite);
    }

    const carpetSprite = createCarpetSprite(this.carpetColor as any);
    if (carpetSprite) {
      carpetSprite.scale.set(scale * 1.2);
      carpetSprite.position.set(0, 25);
      carpetSprite.zIndex = 1;
      this.roomContainer.addChild(carpetSprite);
    }

    for (const item of this.furniture) {
      this.renderFurnitureItem(item, scale);
    }

    if (currentTheme?.premium) {
      this.startDustAnimation();
    }
  }

  private renderFurnitureItem(item: FurnitureItem, baseScale: number = 1.5) {
    if (!this.roomContainer) return;

    let sprite: PIXI.Sprite | null = null;

    switch (item.type) {
      case 'desk':
        sprite = createDeskSprite(item.variant as DeskColor);
        break;
      case 'chair':
        sprite = createChairSprite(item.variant as ChairColor);
        break;
      case 'sofa':
        sprite = createSofaSprite(item.variant as SofaColor);
        break;
      case 'plant':
        sprite = createPlantSprite(item.variant as PlantVariant);
        break;
      case 'laptop':
        sprite = createLaptopSprite(item.variant as any);
        break;
      case 'coffee':
        sprite = createCoffeeSprite(item.variant as any);
        break;
      case 'bookcase':
        sprite = createBookcaseSprite();
        break;
      case 'television':
        sprite = createTelevisionSprite();
        break;
      case 'littleTable':
        sprite = createLittleTableSprite(item.variant as any);
        break;
      case 'teddy':
        sprite = createTeddySprite(item.variant as any);
        break;
      case 'window':
        sprite = createWindowSprite(item.variant as any);
        break;
      case 'wallpainting':
        sprite = createWallPaintingSprite();
        break;
      case 'candle':
        sprite = createCandleSprite();
        break;
      case 'decorativeLamp':
        sprite = createDecorativeLampSprite();
        break;
      case 'decorativeLight':
        sprite = createDecorativeLightSprite();
        break;
      case 'dog':
        sprite = createDogSprite();
        break;
      case 'lamp':
        sprite = createLampSprite();
        break;
      case 'littletable':
        sprite = createLittleTableSprite(item.variant as any);
        break;
      case 'carpet':
        sprite = createCarpetSprite(item.variant as any);
        break;
    }

    if (sprite) {
      sprite.scale.set(baseScale * item.scale);
      sprite.position.set(item.x, item.y);
      sprite.rotation = item.rotation;
      sprite.zIndex = item.zIndex;

      // Make interactive for selection
      (sprite as any).interactive = true;
      (sprite as any).buttonMode = true;
      (sprite as any).on('pointerdown', () => this.selectItem(item.id));

      // Highlight selected
      if (item.id === this.selectedItemId) {
        sprite.tint = 0xffff88;
      }

      this.roomContainer.addChild(sprite);
      this.furnitureSprites.set(item.id, sprite);
    }
  }

  // ══════════════════════════════════════════════════════════════
  // THEME MANAGEMENT
  // ══════════════════════════════════════════════════════════════

  private applyTheme(themeId: string) {
    const theme = ROOM_THEMES.find(t => t.id === themeId);
    if (!theme) return;

    this.activeTheme = themeId;
    this.roomVariant = theme.roomVariant;
    this.carpetColor = theme.carpetColor;
    this.ambianceState = null;
    
    this.furniture = theme.defaultFurniture.map((f, i) => ({
      ...f,
      id: `item-${Date.now()}-${i}`,
    }));

    this.selectedItemId = null;
    this.renderRoom();
    this.notifyChange();
  }

  // ══════════════════════════════════════════════════════════════
  // FURNITURE MANAGEMENT
  // ══════════════════════════════════════════════════════════════

  private addFurniture(paletteItem: PaletteItem, x: number = 0, y: number = 20) {
    const newItem: FurnitureItem = {
      id: `item-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      category: paletteItem.category,
      type: paletteItem.type,
      variant: paletteItem.variant,
      x,
      y,
      scale: 1.0,
      rotation: 0,
      zIndex: this.getDefaultZIndex(paletteItem.type),
    };

    this.furniture = [...this.furniture, newItem];
    this.selectedItemId = newItem.id;
    this.renderRoom();
    this.notifyChange();
  }

  private getDefaultZIndex(type: string): number {
    switch (type) {
      case 'bookcase':
      case 'television':
      case 'window':
      case 'wallpainting':
        return 5;
      case 'sofa':
      case 'chair':
      case 'dog':
        return 15;
      case 'desk':
      case 'littleTable':
      case 'littletable':
      case 'carpet':
        return 20;
      case 'laptop':
      case 'coffee':
      case 'candle':
        return 25;
      case 'plant':
      case 'teddy':
      case 'decorativeLamp':
      case 'decorativeLight':
      case 'lamp':
        return 30;
      default:
        return 10;
    }
  }

  private selectItem(itemId: string) {
    this.selectedItemId = this.selectedItemId === itemId ? null : itemId;
    this.renderRoom();
  }

  private updateSelectedItem(updates: Partial<FurnitureItem>) {
    if (!this.selectedItemId) return;

    this.furniture = this.furniture.map(item =>
      item.id === this.selectedItemId ? { ...item, ...updates } : item
    );
    this.renderRoom();
    this.notifyChange();
  }

  private deleteSelectedItem() {
    if (!this.selectedItemId) return;

    this.furniture = this.furniture.filter(item => item.id !== this.selectedItemId);
    this.selectedItemId = null;
    this.renderRoom();
    this.notifyChange();
  }

  private duplicateSelectedItem() {
    if (!this.selectedItemId) return;

    const original = this.furniture.find(item => item.id === this.selectedItemId);
    if (!original) return;

    const duplicate: FurnitureItem = {
      ...original,
      id: `item-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      x: original.x + 15,
      y: original.y + 15,
    };

    this.furniture = [...this.furniture, duplicate];
    this.selectedItemId = duplicate.id;
    this.renderRoom();
    this.notifyChange();
  }

  // ══════════════════════════════════════════════════════════════
  // DRAG & DROP
  // ══════════════════════════════════════════════════════════════

  private handleDragStart(e: DragEvent, item: PaletteItem) {
    this.isDragging = true;
    this.dragItem = item;
    e.dataTransfer?.setData('text/plain', JSON.stringify(item));
  }

  private handleDragEnd() {
    this.isDragging = false;
    this.dragItem = null;
  }

  private handleDragOver(e: DragEvent) {
    e.preventDefault();
  }

  private handleDrop(e: DragEvent) {
    e.preventDefault();
    if (!this.dragItem || !this.canvasContainer) return;

    const rect = this.canvasContainer.getBoundingClientRect();
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    
    const x = (e.clientX - rect.left - centerX) / 1.5;
    const y = (e.clientY - rect.top - centerY) / 1.5;

    this.addFurniture(this.dragItem, x, y);
    this.handleDragEnd();
  }

  // ══════════════════════════════════════════════════════════════
  // SAVE/LOAD CONFIGURATIONS
  // ══════════════════════════════════════════════════════════════

  private loadSavedConfigs() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY_CONFIGS);
      this.savedConfigs = stored ? JSON.parse(stored) : [];
    } catch {
      this.savedConfigs = [];
    }
  }

  private loadActiveConfig() {
    try {
      const activeId = localStorage.getItem(STORAGE_KEY_ACTIVE);
      if (activeId) {
        const config = this.savedConfigs.find(c => c.id === activeId);
        if (config) {
          this.applyConfig(config);
        }
      }
    } catch {
      // Ignore
    }
  }

  private saveConfigs() {
    localStorage.setItem(STORAGE_KEY_CONFIGS, JSON.stringify(this.savedConfigs));
  }

  private saveCurrentConfig() {
    if (!this.saveConfigName.trim()) return;

    const config: RoomConfiguration = {
      id: `config-${Date.now()}`,
      name: this.saveConfigName.trim(),
      theme: this.activeTheme,
      roomVariant: this.roomVariant,
      carpetColor: this.carpetColor,
      furniture: [...this.furniture],
      agentAssignments: [...this.agentAssignments],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.savedConfigs = [...this.savedConfigs, config];
    this.activeConfigId = config.id;
    this.saveConfigs();
    localStorage.setItem(STORAGE_KEY_ACTIVE, config.id);

    this.showSaveModal = false;
    this.saveConfigName = '';
  }

  private applyConfig(config: RoomConfiguration) {
    this.activeConfigId = config.id;
    this.activeTheme = config.theme;
    this.roomVariant = config.roomVariant;
    this.carpetColor = config.carpetColor;
    this.furniture = [...config.furniture];
    this.agentAssignments = [...config.agentAssignments];
    this.selectedItemId = null;

    localStorage.setItem(STORAGE_KEY_ACTIVE, config.id);
    this.renderRoom();
    this.notifyChange();
  }

  private deleteConfig(configId: string) {
    this.savedConfigs = this.savedConfigs.filter(c => c.id !== configId);
    if (this.activeConfigId === configId) {
      this.activeConfigId = null;
      localStorage.removeItem(STORAGE_KEY_ACTIVE);
    }
    this.saveConfigs();
  }

  private notifyChange() {
    if (this.onConfigChange) {
      this.onConfigChange({
        id: this.activeConfigId || 'current',
        name: 'Current Room',
        theme: this.activeTheme,
        roomVariant: this.roomVariant,
        carpetColor: this.carpetColor,
        furniture: this.furniture,
        agentAssignments: this.agentAssignments,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  }

  // ══════════════════════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════════════════════

  render() {
    const selectedItem = this.furniture.find(f => f.id === this.selectedItemId);
    const filteredPalette = this.furnitureCategory === 'all'
      ? FURNITURE_PALETTE
      : FURNITURE_PALETTE.filter(p => p.category === this.furnitureCategory);

    return html`
      <div class="editor-container">
        <!-- Header -->
        <header class="header">
          <div class="header-title">
            <span style="font-size: 24px;">${icons.house}</span>
            <h2>Room Customization</h2>
          </div>
          <div class="header-actions">
            <button class="btn btn-secondary" @click=${() => this.applyTheme(this.activeTheme)}>
              ${icons.refresh} Reset
            </button>
            <button class="btn btn-primary" @click=${() => this.showSaveModal = true}>
              ${icons.download} Save Layout
            </button>
            ${this.onClose ? html`
              <button class="btn btn-secondary btn-icon" @click=${this.onClose}>
                ${icons.x}
              </button>
            ` : nothing}
          </div>
        </header>

        <!-- Furniture Palette -->
        <div class="panel">
          <div class="panel-header">
            <span class="panel-title">
              <span>${icons.grid}</span>
              Furniture
            </span>
          </div>
          <div class="panel-content">
            <!-- Category tabs -->
            <div class="category-tabs">
              ${(['all', 'desks', 'chairs', 'sofas', 'plants', 'decorations'] as FurnitureCategory[]).map(cat => html`
                <button
                  class="category-tab ${classMap({ active: this.furnitureCategory === cat })}"
                  @click=${() => this.furnitureCategory = cat}
                >
                  ${cat === 'all' ? '📦' : cat === 'desks' ? '🪵' : cat === 'chairs' ? '🪑' : cat === 'sofas' ? '🛋️' : cat === 'plants' ? '🌿' : '✨'}
                  ${cat}
                </button>
              `)}
            </div>

            <!-- Items grid -->
            <div class="furniture-grid">
              ${filteredPalette.map(item => html`
                <div
                  class="furniture-item"
                  draggable="true"
                  @dragstart=${(e: DragEvent) => this.handleDragStart(e, item)}
                  @dragend=${this.handleDragEnd}
                  @click=${() => this.addFurniture(item)}
                >
                  <span class="icon">${item.icon}</span>
                  <span class="name">${item.name}</span>
                </div>
              `)}
            </div>
          </div>
        </div>

        <!-- Preview Canvas -->
        <div class="panel preview-panel">
          <div class="panel-header">
            <span class="panel-title">
              <span>${icons.eye}</span>
              Preview
            </span>
            <div style="display: flex; gap: 6px;">
              <button class="btn btn-secondary btn-small" @click=${() => this.renderRoom()}>
                ${icons.refresh}
              </button>
            </div>
          </div>
          <div
            class="preview-canvas-container ${classMap({ 'drop-zone-active': this.isDragging })}"
            @dragover=${this.handleDragOver}
            @drop=${this.handleDrop}
          >
            <!-- PixiJS canvas renders here -->
          </div>
          <div class="preview-overlay">
            <div class="preview-info">
              ${this.furniture.length} items • ${ROOM_THEMES.find(t => t.id === this.activeTheme)?.name || 'Custom'}
            </div>
          </div>
        </div>

        <!-- Properties Panel -->
        <div class="panel">
          <div class="panel-header">
            <span class="panel-title">
              <span>${icons.settings}</span>
              Properties
            </span>
          </div>
          <div class="panel-content">
            <!-- Theme selector -->
            <div class="properties-section">
              <div class="properties-section-title">Room Theme</div>
              <div class="theme-grid">
                ${ROOM_THEMES.map(theme => html`
                  <div
                    class="theme-card ${classMap({ active: this.activeTheme === theme.id, premium: !!theme.premium })}"
                    @click=${() => this.applyTheme(theme.id)}
                  >
                    <span class="icon">${theme.icon}</span>
                    <span class="name">${theme.name}</span>
                    ${theme.premium ? html`<span class="premium-badge">Premium</span>` : nothing}
                  </div>
                `)}
              </div>
            </div>

            <!-- Carpet selector -->
            <div class="properties-section">
              <div class="properties-section-title">Carpet Color</div>
              <div class="carpet-grid">
                ${CARPET_OPTIONS.map(carpet => html`
                  <div
                    class="carpet-option ${classMap({ active: this.carpetColor === carpet.id })}"
                    style="background: ${carpet.color};"
                    title="${carpet.name}"
                    @click=${() => {
                      this.carpetColor = carpet.id;
                      this.renderRoom();
                      this.notifyChange();
                    }}
                  >
                    ${carpet.icon}
                  </div>
                `)}
              </div>
            </div>

            <!-- Selected item properties -->
            ${selectedItem ? html`
              <div class="properties-section">
                <div class="properties-section-title">Selected: ${selectedItem.type}</div>
                <div class="item-props">
                  <div class="prop-row">
                    <span class="prop-label">Scale</span>
                    <input
                      type="range"
                      class="prop-slider"
                      min="0.5"
                      max="2"
                      step="0.1"
                      .value=${String(selectedItem.scale)}
                      @input=${(e: Event) => this.updateSelectedItem({ scale: parseFloat((e.target as HTMLInputElement).value) })}
                    />
                  </div>
                  <div class="prop-row">
                    <span class="prop-label">Layer (Z)</span>
                    <input
                      type="range"
                      class="prop-slider"
                      min="0"
                      max="50"
                      step="1"
                      .value=${String(selectedItem.zIndex)}
                      @input=${(e: Event) => this.updateSelectedItem({ zIndex: parseInt((e.target as HTMLInputElement).value) })}
                    />
                  </div>
                  <div class="prop-row">
                    <span class="prop-label">Position</span>
                    <span class="prop-value">${Math.round(selectedItem.x)}, ${Math.round(selectedItem.y)}</span>
                  </div>
                  <div style="display: flex; gap: 6px; margin-top: 8px;">
                    <button class="btn btn-secondary btn-small" @click=${this.duplicateSelectedItem}>
                      ${icons.copy} Duplicate
                    </button>
                    <button class="btn btn-danger btn-small" @click=${this.deleteSelectedItem}>
                      ${icons.trash} Delete
                    </button>
                  </div>
                </div>
              </div>
            ` : html`
              <div class="properties-section">
                <div class="empty-state">
                  <span class="icon">${icons.target}</span>
                  <span class="message">Click a furniture item to select</span>
                </div>
              </div>
            `}

            <!-- Saved configurations -->
            <div class="properties-section">
              <div class="properties-section-title">Saved Layouts</div>
              ${this.savedConfigs.length > 0 ? html`
                <div class="config-list">
                  ${this.savedConfigs.map(config => html`
                    <div
                      class="config-item ${classMap({ active: this.activeConfigId === config.id })}"
                      @click=${() => this.applyConfig(config)}
                    >
                      <div>
                        <div class="config-name">${config.name}</div>
                        <div class="config-date">${new Date(config.updatedAt).toLocaleDateString()}</div>
                      </div>
                      <div class="config-actions">
                        <button
                          class="btn btn-danger btn-icon btn-small"
                          @click=${(e: Event) => {
                            e.stopPropagation();
                            this.deleteConfig(config.id);
                          }}
                        >
                          ${icons.trash}
                        </button>
                      </div>
                    </div>
                  `)}
                </div>
              ` : html`
                <div class="empty-state">
                  <span class="icon">${icons.folder}</span>
                  <span class="message">No saved layouts yet</span>
                </div>
              `}
            </div>
          </div>
        </div>
      </div>

      <!-- Save Modal -->
      ${this.showSaveModal ? html`
        <div class="modal-overlay" @click=${() => this.showSaveModal = false}>
          <div class="modal" @click=${(e: Event) => e.stopPropagation()}>
            <div class="modal-header">
              <span class="modal-title">${icons.download} Save Layout</span>
              <button class="btn btn-secondary btn-icon btn-small" @click=${() => this.showSaveModal = false}>
                ${icons.x}
              </button>
            </div>
            <div class="modal-body">
              <input
                type="text"
                class="input"
                placeholder="Layout name..."
                .value=${this.saveConfigName}
                @input=${(e: Event) => this.saveConfigName = (e.target as HTMLInputElement).value}
                @keyup=${(e: KeyboardEvent) => e.key === 'Enter' && this.saveCurrentConfig()}
              />
            </div>
            <div class="modal-footer">
              <button class="btn btn-secondary" @click=${() => this.showSaveModal = false}>
                Cancel
              </button>
              <button class="btn btn-primary" @click=${this.saveCurrentConfig}>
                Save
              </button>
            </div>
          </div>
        </div>
      ` : nothing}
    `;
  }
}

// ════════════════════════════════════════════════════════════════
// EXPORTS
// ════════════════════════════════════════════════════════════════

export { ROOM_THEMES, FURNITURE_PALETTE, CARPET_OPTIONS };

declare global {
  interface HTMLElementTagNameMap {
    'room-customization': RoomCustomization;
  }
}
