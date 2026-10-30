/**
 * Dynamic block + template catalog client.
 *
 * Loads the production block definitions (with style schemas + presets) and
 * saved templates from the gateway. Caches in app state so the inspector and
 * template gallery can read synchronously after the first load.
 */

import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";

// Mirror server-side shapes (kept loose — UI doesn't need full structural typing).

export type BlockStyleField =
  | { id: string; label: string; kind: "color"; group?: string; default: string; help?: string }
  | { id: string; label: string; kind: "font"; group?: string; default: string; suggestions?: string[]; help?: string }
  | { id: string; label: string; kind: "number"; group?: string; default: number; min?: number; max?: number; step?: number; unit?: string; help?: string }
  | { id: string; label: string; kind: "select"; group?: string; default: string; options: Array<{ value: string; label: string }>; help?: string }
  | { id: string; label: string; kind: "text"; group?: string; default: string; multiline?: boolean; help?: string }
  | { id: string; label: string; kind: "boolean"; group?: string; default: boolean; help?: string }
  | { id: string; label: string; kind: "shadow"; group?: string; default: string; help?: string }
  | { id: string; label: string; kind: "gradient"; group?: string; default: string; help?: string };

export interface BlockSlot { key: string; label: string; default: string; multiline?: boolean; maxChars?: number }
export interface BlockPreset { id: string; label: string; description?: string; values: Record<string, string | number | boolean> }

export interface BlockDefinition {
  id: string;
  label: string;
  description: string;
  tags: string[];
  aspect?: string;
  defaultDurationSec: number;
  slots: BlockSlot[];
  styleSchema: BlockStyleField[];
  presets: BlockPreset[];
  defaultAnimateIn?: { kind: string; durationSec: number };
  defaultAnimateOut?: { kind: string; durationSec: number };
  defaultPlacement?: { x: number; y: number; width: number; height: number };
  builtIn: boolean;
  /** Agent-authored raw HTML template with `{{slot}}` placeholders. */
  template?: string;
  /** Agent-authored CSS, scoped to `.veblk-<id>` at render time. */
  css?: string;
  /** Optional palette icon name (Lucide). */
  icon?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface CompositionTemplate {
  id: string;
  name: string;
  description?: string;
  thumbnail?: string;
  tags: string[];
  composition: { name: string; widthPx: number; heightPx: number; fps: number; durationSec: number; bgColor: string };
  tracks: Array<{ name: string; kind: string; sortOrder: number }>;
  clips: Array<{ trackIndex: number; kind: string; label?: string; startSec: number; durationSec: number; z: number; props: Record<string, unknown> }>;
  builtIn: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface VideoBlocksCatalogState {
  loading: boolean;
  loadedAt: number | null;
  error: string | null;
  blocks: BlockDefinition[];
  templates: CompositionTemplate[];
  galleryOpen: boolean;
  saveTemplateOpen: boolean;
  /** Active block id whose inspector is being edited. */
  activeBlockId: string | null;
}

export function createInitialBlocksCatalogState(): VideoBlocksCatalogState {
  return {
    loading: false,
    loadedAt: null,
    error: null,
    blocks: [],
    templates: [],
    galleryOpen: false,
    saveTemplateOpen: false,
    activeBlockId: null,
  };
}

function getCatalog(state: AppViewState): VideoBlocksCatalogState {
  const s = state as unknown as { videoBlocksCatalog?: VideoBlocksCatalogState };
  if (!s.videoBlocksCatalog) s.videoBlocksCatalog = createInitialBlocksCatalogState();
  return s.videoBlocksCatalog;
}

export async function loadBlocksCatalog(state: AppViewState, client: GatewayBrowserClient): Promise<void> {
  const cat = getCatalog(state);
  cat.loading = true;
  cat.error = null;
  state.requestUpdate?.();
  try {
    const [blocksRes, templatesRes] = await Promise.all([
      client.request("composition.blocks.list", {}) as Promise<{ blocks?: BlockDefinition[] }>,
      client.request("composition.templates.list", {}) as Promise<{ templates?: CompositionTemplate[] }>,
    ]);
    cat.blocks = blocksRes?.blocks ?? [];
    cat.templates = templatesRes?.templates ?? [];
    cat.loadedAt = Date.now();
  } catch (e) {
    cat.error = e instanceof Error ? e.message : String(e);
  } finally {
    cat.loading = false;
    state.requestUpdate?.();
  }
}

export function getBlockDef(state: AppViewState, blockId: string): BlockDefinition | null {
  const cat = getCatalog(state);
  return cat.blocks.find((b) => b.id === blockId) ?? null;
}

/**
 * Resolve the effective style value for a clip's style field, considering:
 *   1. explicit per-instance style override (clip.props.style[fieldId])
 *   2. preset bundle (clip.props.presetId → presets[].values[fieldId])
 *   3. block schema default
 */
export function resolveStyleValue(
  block: BlockDefinition,
  field: BlockStyleField,
  clipProps: { style?: Record<string, unknown>; presetId?: string },
): string | number | boolean {
  const override = clipProps.style?.[field.id];
  if (override !== undefined) return override as string | number | boolean;
  if (clipProps.presetId) {
    const preset = block.presets.find((p) => p.id === clipProps.presetId);
    if (preset && preset.values[field.id] !== undefined) return preset.values[field.id];
  }
  return field.default;
}

/** Group fields by `group` for a tidy inspector layout. */
export function groupFields(schema: BlockStyleField[]): Map<string, BlockStyleField[]> {
  const groups = new Map<string, BlockStyleField[]>();
  for (const f of schema) {
    const g = f.group ?? "Style";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(f);
  }
  return groups;
}

export async function saveCurrentAsTemplate(
  state: AppViewState,
  client: GatewayBrowserClient,
  payload: { name: string; description?: string; tags?: string[]; composition: Record<string, unknown>; tracks: unknown[]; clips: unknown[] },
): Promise<CompositionTemplate | null> {
  const cat = getCatalog(state);
  try {
    const r = (await client.request("composition.templates.save", payload)) as { template?: CompositionTemplate };
    if (r?.template) {
      cat.templates = [r.template, ...cat.templates.filter((t) => t.id !== r.template!.id)];
      state.requestUpdate?.();
      return r.template;
    }
    return null;
  } catch (e) {
    cat.error = e instanceof Error ? e.message : String(e);
    state.requestUpdate?.();
    return null;
  }
}

export async function deleteTemplate(state: AppViewState, client: GatewayBrowserClient, id: string): Promise<boolean> {
  const cat = getCatalog(state);
  try {
    await client.request("composition.templates.delete", { id });
    cat.templates = cat.templates.filter((t) => t.id !== id);
    state.requestUpdate?.();
    return true;
  } catch (e) {
    cat.error = e instanceof Error ? e.message : String(e);
    state.requestUpdate?.();
    return false;
  }
}
