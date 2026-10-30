/**
 * Preset Builder Controller — State management for custom effect presets
 */

import type { AppViewState } from "../app-view-state.js";
import type { GatewayBrowserClient } from "../gateway.js";

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export interface EffectPreset {
  id: string;
  name: string;
  description: string;
  category: "zoom" | "pan" | "transition" | "stylized" | "custom";
  isBuiltIn: boolean;
  params: EffectParams;
  previewUrl?: string;
  createdAt: number;
  updatedAt: number;
}

export interface EffectParams {
  // Zoom
  zoomStart: number;      // 1.0 = 100%
  zoomEnd: number;
  zoomEasing: EasingType;
  
  // Pan
  panX: number;           // -100 to 100 (percentage)
  panY: number;
  panEasing: EasingType;
  
  // Rotation
  rotationStart: number;  // degrees
  rotationEnd: number;
  rotationEasing: EasingType;
  
  // Effects
  blur: number;           // 0-20 px
  vignette: number;       // 0-1 opacity
  scanlines: boolean;
  rgbSplit: number;       // 0-10 px
  flash: boolean;
  flashFrame: number;     // frame to flash on
  shake: number;          // 0-10 intensity
  
  // Timing
  speedRamp: boolean;     // ease-in-out timing
  holdStart: number;      // frames to hold at start
  holdEnd: number;        // frames to hold at end
}

export type EasingType = 
  | "linear" 
  | "ease-in" 
  | "ease-out" 
  | "ease-in-out" 
  | "spring" 
  | "bounce"
  | "elastic";

export interface PresetBuilderState {
  // Presets library
  presets: EffectPreset[];
  selectedPresetId: string | null;
  
  // Editor state
  isEditing: boolean;
  editingPreset: EffectPreset | null;
  hasUnsavedChanges: boolean;
  
  // Preview
  previewPlaying: boolean;
  previewProgress: number;
  previewImageUrl: string | null;
  
  // UI state
  showDeleteConfirm: boolean;
  filterCategory: string | null;
  searchQuery: string;
  
  // Loading states
  loading: boolean;
  saving: boolean;
  rendering: boolean;
  error: string | null;
}

// ═══════════════════════════════════════════════════════════════
// DEFAULT PARAMS
// ═══════════════════════════════════════════════════════════════

export const DEFAULT_PARAMS: EffectParams = {
  zoomStart: 1.0,
  zoomEnd: 1.1,
  zoomEasing: "ease-out",
  panX: 0,
  panY: 0,
  panEasing: "linear",
  rotationStart: 0,
  rotationEnd: 0,
  rotationEasing: "linear",
  blur: 0,
  vignette: 0.3,
  scanlines: false,
  rgbSplit: 0,
  flash: false,
  flashFrame: 5,
  shake: 0,
  speedRamp: false,
  holdStart: 0,
  holdEnd: 0,
};

// ═══════════════════════════════════════════════════════════════
// BUILT-IN PRESETS
// ═══════════════════════════════════════════════════════════════

export const BUILT_IN_PRESETS: EffectPreset[] = [
  {
    id: "ken-burns",
    name: "Ken Burns Zoom",
    description: "Classic documentary style - slow zoom with subtle pan",
    category: "zoom",
    isBuiltIn: true,
    params: {
      ...DEFAULT_PARAMS,
      zoomStart: 1.0,
      zoomEnd: 1.15,
      panX: -30,
      panY: -15,
      zoomEasing: "linear",
    },
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "dramatic-push",
    name: "Dramatic Push",
    description: "Cinematic forward motion with vignette",
    category: "zoom",
    isBuiltIn: true,
    params: {
      ...DEFAULT_PARAMS,
      zoomStart: 1.0,
      zoomEnd: 1.25,
      zoomEasing: "ease-in-out",
      vignette: 0.5,
      speedRamp: true,
    },
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "pull-back-reveal",
    name: "Pull Back Reveal",
    description: "Start tight, expand out - great for reveals",
    category: "zoom",
    isBuiltIn: true,
    params: {
      ...DEFAULT_PARAMS,
      zoomStart: 1.4,
      zoomEnd: 1.0,
      zoomEasing: "ease-out",
      blur: 2,
    },
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "parallax-drift",
    name: "Parallax Drift",
    description: "Horizontal movement with depth feel",
    category: "pan",
    isBuiltIn: true,
    params: {
      ...DEFAULT_PARAMS,
      zoomStart: 1.08,
      zoomEnd: 1.12,
      panX: 60,
      panY: 0,
      panEasing: "linear",
    },
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "punch-zoom",
    name: "Punch Zoom",
    description: "TikTok/Shorts style impact zoom with flash",
    category: "stylized",
    isBuiltIn: true,
    params: {
      ...DEFAULT_PARAMS,
      zoomStart: 1.0,
      zoomEnd: 1.12,
      zoomEasing: "spring",
      flash: true,
      flashFrame: 5,
      shake: 5,
    },
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "slow-drift",
    name: "Slow Drift",
    description: "Very subtle constant movement - keeps image alive",
    category: "pan",
    isBuiltIn: true,
    params: {
      ...DEFAULT_PARAMS,
      zoomStart: 1.02,
      zoomEnd: 1.05,
      panX: 10,
      panY: 6,
    },
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "glitch-flash",
    name: "Glitch Flash",
    description: "Cyberpunk style with scanlines and RGB split",
    category: "stylized",
    isBuiltIn: true,
    params: {
      ...DEFAULT_PARAMS,
      zoomStart: 1.05,
      zoomEnd: 1.1,
      scanlines: true,
      rgbSplit: 4,
      flash: true,
      flashFrame: 30,
    },
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "spin-reveal",
    name: "Spin Reveal",
    description: "Rotate in with scale - great for intros",
    category: "transition",
    isBuiltIn: true,
    params: {
      ...DEFAULT_PARAMS,
      zoomStart: 0.5,
      zoomEnd: 1.1,
      zoomEasing: "spring",
      rotationStart: 360,
      rotationEnd: 0,
      rotationEasing: "ease-out",
    },
    createdAt: 0,
    updatedAt: 0,
  },
];

// ═══════════════════════════════════════════════════════════════
// STATE INITIALIZATION
// ═══════════════════════════════════════════════════════════════

const initialState: PresetBuilderState = {
  presets: [...BUILT_IN_PRESETS],
  selectedPresetId: null,
  isEditing: false,
  editingPreset: null,
  hasUnsavedChanges: false,
  previewPlaying: false,
  previewProgress: 0,
  previewImageUrl: null,
  showDeleteConfirm: false,
  filterCategory: null,
  searchQuery: "",
  loading: false,
  saving: false,
  rendering: false,
  error: null,
};

// ═══════════════════════════════════════════════════════════════
// STATE ACCESS
// ═══════════════════════════════════════════════════════════════

export function getPresetBuilderState(state: AppViewState): PresetBuilderState {
  if (!state.presetBuilder) {
    state.presetBuilder = { ...initialState };
  }
  return state.presetBuilder as PresetBuilderState;
}

// ═══════════════════════════════════════════════════════════════
// PRESET LIBRARY ACTIONS
// ═══════════════════════════════════════════════════════════════

export async function loadPresets(
  state: AppViewState,
  client: GatewayBrowserClient
): Promise<void> {
  const pb = getPresetBuilderState(state);
  pb.loading = true;
  state.requestUpdate?.();
  
  try {
    const result = await client.call("storyboard.listEffectPresets", {}) as any;
    if (result.presets) {
      // Merge built-in with custom presets
      pb.presets = [...BUILT_IN_PRESETS, ...result.presets];
    }
    pb.loading = false;
  } catch (err) {
    pb.error = err instanceof Error ? err.message : String(err);
    pb.loading = false;
  }
  
  state.requestUpdate?.();
}

export function selectPreset(state: AppViewState, presetId: string | null): void {
  const pb = getPresetBuilderState(state);
  pb.selectedPresetId = presetId;
  pb.isEditing = false;
  pb.editingPreset = null;
  state.requestUpdate?.();
}

export function filterByCategory(state: AppViewState, category: string | null): void {
  const pb = getPresetBuilderState(state);
  pb.filterCategory = category;
  state.requestUpdate?.();
}

export function setSearchQuery(state: AppViewState, query: string): void {
  const pb = getPresetBuilderState(state);
  pb.searchQuery = query;
  state.requestUpdate?.();
}

export function getFilteredPresets(state: AppViewState): EffectPreset[] {
  const pb = getPresetBuilderState(state);
  let presets = pb.presets;
  
  if (pb.filterCategory) {
    presets = presets.filter(p => p.category === pb.filterCategory);
  }
  
  if (pb.searchQuery) {
    const query = pb.searchQuery.toLowerCase();
    presets = presets.filter(p => 
      p.name.toLowerCase().includes(query) ||
      p.description.toLowerCase().includes(query)
    );
  }
  
  return presets;
}

// ═══════════════════════════════════════════════════════════════
// EDITOR ACTIONS
// ═══════════════════════════════════════════════════════════════

export function startEditing(state: AppViewState, presetId?: string): void {
  const pb = getPresetBuilderState(state);
  
  if (presetId) {
    const preset = pb.presets.find(p => p.id === presetId);
    if (preset) {
      // Clone for editing
      pb.editingPreset = {
        ...preset,
        id: preset.isBuiltIn ? `custom-${Date.now()}` : preset.id,
        name: preset.isBuiltIn ? `${preset.name} (Custom)` : preset.name,
        isBuiltIn: false,
        params: { ...preset.params },
      };
    }
  } else {
    // New preset
    pb.editingPreset = {
      id: `custom-${Date.now()}`,
      name: "New Preset",
      description: "",
      category: "custom",
      isBuiltIn: false,
      params: { ...DEFAULT_PARAMS },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }
  
  pb.isEditing = true;
  pb.hasUnsavedChanges = false;
  state.requestUpdate?.();
}

export function cancelEditing(state: AppViewState): void {
  const pb = getPresetBuilderState(state);
  pb.isEditing = false;
  pb.editingPreset = null;
  pb.hasUnsavedChanges = false;
  state.requestUpdate?.();
}

export function updatePresetField<K extends keyof EffectPreset>(
  state: AppViewState,
  field: K,
  value: EffectPreset[K]
): void {
  const pb = getPresetBuilderState(state);
  if (pb.editingPreset) {
    (pb.editingPreset as any)[field] = value;
    pb.hasUnsavedChanges = true;
    state.requestUpdate?.();
  }
}

export function updatePresetParam<K extends keyof EffectParams>(
  state: AppViewState,
  param: K,
  value: EffectParams[K]
): void {
  const pb = getPresetBuilderState(state);
  if (pb.editingPreset) {
    pb.editingPreset.params[param] = value;
    pb.hasUnsavedChanges = true;
    state.requestUpdate?.();
  }
}

export async function savePreset(
  state: AppViewState,
  client: GatewayBrowserClient
): Promise<boolean> {
  const pb = getPresetBuilderState(state);
  if (!pb.editingPreset) return false;
  
  pb.saving = true;
  state.requestUpdate?.();
  
  try {
    const result = await client.call("storyboard.saveEffectPreset", {
      preset: pb.editingPreset,
    }) as any;
    
    if (result.success) {
      // Update local list
      const existingIndex = pb.presets.findIndex(p => p.id === pb.editingPreset!.id);
      if (existingIndex >= 0) {
        pb.presets[existingIndex] = { ...pb.editingPreset };
      } else {
        pb.presets.push({ ...pb.editingPreset });
      }
      
      pb.isEditing = false;
      pb.editingPreset = null;
      pb.hasUnsavedChanges = false;
    }
    
    pb.saving = false;
    state.requestUpdate?.();
    return result.success;
  } catch (err) {
    pb.error = err instanceof Error ? err.message : String(err);
    pb.saving = false;
    state.requestUpdate?.();
    return false;
  }
}

export function confirmDelete(state: AppViewState): void {
  const pb = getPresetBuilderState(state);
  pb.showDeleteConfirm = true;
  state.requestUpdate?.();
}

export function cancelDelete(state: AppViewState): void {
  const pb = getPresetBuilderState(state);
  pb.showDeleteConfirm = false;
  state.requestUpdate?.();
}

export async function deletePreset(
  state: AppViewState,
  client: GatewayBrowserClient,
  presetId: string
): Promise<boolean> {
  const pb = getPresetBuilderState(state);
  
  try {
    await client.call("storyboard.deleteEffectPreset", { id: presetId });
    pb.presets = pb.presets.filter(p => p.id !== presetId);
    pb.showDeleteConfirm = false;
    pb.selectedPresetId = null;
    state.requestUpdate?.();
    return true;
  } catch (err) {
    pb.error = err instanceof Error ? err.message : String(err);
    state.requestUpdate?.();
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// PREVIEW ACTIONS
// ═══════════════════════════════════════════════════════════════

export function setPreviewImage(state: AppViewState, imageUrl: string): void {
  const pb = getPresetBuilderState(state);
  pb.previewImageUrl = imageUrl;
  state.requestUpdate?.();
}

export function togglePreview(state: AppViewState): void {
  const pb = getPresetBuilderState(state);
  pb.previewPlaying = !pb.previewPlaying;
  
  if (pb.previewPlaying) {
    pb.previewProgress = 0;
  }
  
  state.requestUpdate?.();
}

export function updatePreviewProgress(state: AppViewState, progress: number): void {
  const pb = getPresetBuilderState(state);
  pb.previewProgress = Math.min(1, Math.max(0, progress));
  state.requestUpdate?.();
}

export async function renderPreview(
  state: AppViewState,
  client: GatewayBrowserClient
): Promise<string | null> {
  const pb = getPresetBuilderState(state);
  if (!pb.editingPreset || !pb.previewImageUrl) return null;
  
  pb.rendering = true;
  state.requestUpdate?.();
  
  try {
    const result = await client.call("storyboard.renderPresetPreview", {
      preset: pb.editingPreset,
      imageUrl: pb.previewImageUrl,
    }) as any;
    
    pb.rendering = false;
    state.requestUpdate?.();
    return result.videoUrl || null;
  } catch (err) {
    pb.error = err instanceof Error ? err.message : String(err);
    pb.rendering = false;
    state.requestUpdate?.();
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// CATEGORY HELPERS
// ═══════════════════════════════════════════════════════════════

export const CATEGORIES = [
  { id: "zoom", label: "🔍 Zoom", description: "Scale effects" },
  { id: "pan", label: "↔️ Pan", description: "Movement effects" },
  { id: "transition", label: "✨ Transition", description: "In/out effects" },
  { id: "stylized", label: "🎨 Stylized", description: "Visual effects" },
  { id: "custom", label: "⚙️ Custom", description: "User presets" },
];

export const EASING_OPTIONS: { value: EasingType; label: string }[] = [
  { value: "linear", label: "Linear" },
  { value: "ease-in", label: "Ease In" },
  { value: "ease-out", label: "Ease Out" },
  { value: "ease-in-out", label: "Ease In-Out" },
  { value: "spring", label: "Spring" },
  { value: "bounce", label: "Bounce" },
  { value: "elastic", label: "Elastic" },
];
