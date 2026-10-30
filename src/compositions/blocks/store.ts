/**
 * Persistence for user-added blocks and saved templates.
 *
 * Built-in blocks live in code (catalog.ts). User-added blocks and templates
 * live in `<CONFIG_DIR>/compositions/blocks-catalog.json` so they survive
 * restarts and can be moved between machines.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { CONFIG_DIR } from "../../utils.js";
import { BUILT_IN_BLOCKS } from "./catalog.js";
import type { BlockDefinition, BlocksCatalogFile, CompositionTemplate } from "./types.js";

const STORE_DIR = path.join(CONFIG_DIR, "compositions");
const STORE_PATH = path.join(STORE_DIR, "blocks-catalog.json");

let cache: BlocksCatalogFile | null = null;
let writeQueue: Promise<void> = Promise.resolve();

async function load(): Promise<BlocksCatalogFile> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(STORE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<BlocksCatalogFile>;
    cache = {
      version: 1,
      customBlocks: Array.isArray(parsed.customBlocks) ? parsed.customBlocks! : [],
      templates: Array.isArray(parsed.templates) ? parsed.templates! : [],
    };
  } catch {
    cache = { version: 1, customBlocks: [], templates: [] };
  }
  return cache!;
}

async function save(): Promise<void> {
  const data = cache;
  if (!data) return;
  const next = writeQueue
    .catch(() => undefined)
    .then(async () => {
      await fs.mkdir(STORE_DIR, { recursive: true });
      const tmp = `${STORE_PATH}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
      await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
      await fs.rename(tmp, STORE_PATH);
    });
  writeQueue = next;
  await next;
}

// ── Blocks ──────────────────────────────────────────────────

export async function listAllBlocks(): Promise<BlockDefinition[]> {
  const file = await load();
  // Built-ins first, then user customs (which can shadow if id matches).
  const customIds = new Set(file.customBlocks.map((b) => b.id));
  const merged: BlockDefinition[] = [
    ...BUILT_IN_BLOCKS.filter((b) => !customIds.has(b.id)),
    ...file.customBlocks,
  ];
  return merged;
}

export async function getBlock(id: string): Promise<BlockDefinition | null> {
  const blocks = await listAllBlocks();
  return blocks.find((b) => b.id === id) ?? null;
}

export async function upsertCustomBlock(block: BlockDefinition): Promise<BlockDefinition> {
  const file = await load();
  const now = Date.now();
  const next = { ...block, builtIn: false, updatedAt: now, createdAt: block.createdAt ?? now };
  const i = file.customBlocks.findIndex((b) => b.id === block.id);
  if (i === -1) file.customBlocks.push(next);
  else file.customBlocks[i] = next;
  await save();
  return next;
}

export async function deleteCustomBlock(id: string): Promise<boolean> {
  const file = await load();
  const before = file.customBlocks.length;
  file.customBlocks = file.customBlocks.filter((b) => b.id !== id);
  const removed = file.customBlocks.length !== before;
  if (removed) await save();
  return removed;
}

// ── Agent-friendly helpers ──────────────────────────────────
// These are thin sugar over upsertCustomBlock/deleteCustomBlock so the
// `video_editor` tool's block.* actions can call create/update/delete
// without rebuilding a full BlockDefinition each time.

export interface BlockCreateInput {
  id?: string;
  name: string;
  description?: string;
  icon?: string;
  durationSec?: number;
  defaults?: Record<string, unknown>;
  slots?: Array<{ key: string; label?: string; default?: string }>;
  template: string;
  css?: string;
  tags?: string[];
}

export async function createBlock(input: BlockCreateInput): Promise<BlockDefinition> {
  const id =
    input.id || `block_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const existing = await getBlock(id);
  if (existing && existing.builtIn) {
    throw new Error(`Block id "${id}" collides with a built-in. Pick a different id.`);
  }
  const now = Date.now();
  const placement =
    input.defaults && typeof input.defaults === "object"
      ? {
          x: typeof input.defaults["x"] === "number" ? (input.defaults["x"] as number) : 5,
          y: typeof input.defaults["y"] === "number" ? (input.defaults["y"] as number) : 30,
          width:
            typeof input.defaults["width"] === "number" ? (input.defaults["width"] as number) : 90,
          height:
            typeof input.defaults["height"] === "number"
              ? (input.defaults["height"] as number)
              : 40,
        }
      : { x: 5, y: 30, width: 90, height: 40 };
  const block: BlockDefinition = {
    id,
    label: input.name,
    description: input.description ?? "",
    tags: input.tags ?? ["custom"],
    defaultDurationSec: input.durationSec ?? 4,
    slots: (input.slots ?? []).map((s) => ({
      key: s.key,
      label: s.label ?? s.key,
      default: s.default ?? "",
    })),
    styleSchema: [],
    presets: [],
    defaultPlacement: placement,
    builtIn: false,
    template: input.template,
    css: input.css,
    icon: input.icon ?? "sparkles",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  return upsertCustomBlock(block);
}

export interface BlockUpdateInput {
  name?: string;
  description?: string;
  icon?: string;
  durationSec?: number;
  defaults?: Record<string, unknown>;
  slots?: Array<{ key: string; label?: string; default?: string }>;
  template?: string;
  css?: string;
  tags?: string[];
}

export async function updateBlockById(
  id: string,
  patch: BlockUpdateInput,
): Promise<BlockDefinition | null> {
  const existing = await getBlock(id);
  if (!existing) return null;
  if (existing.builtIn && patch.template !== undefined) {
    throw new Error(
      `Cannot replace template on built-in block "${id}". Clone it via blocks.create with a new id instead.`,
    );
  }
  const next: BlockDefinition = {
    ...existing,
    label: patch.name ?? existing.label,
    description: patch.description ?? existing.description,
    icon: patch.icon ?? existing.icon,
    defaultDurationSec: patch.durationSec ?? existing.defaultDurationSec,
    slots: patch.slots
      ? patch.slots.map((s) => ({ key: s.key, label: s.label ?? s.key, default: s.default ?? "" }))
      : existing.slots,
    template: patch.template ?? existing.template,
    css: patch.css ?? existing.css,
    tags: patch.tags ?? existing.tags,
    updatedAt: Date.now(),
  };
  if (patch.defaults && typeof patch.defaults === "object") {
    next.defaultPlacement = {
      x:
        typeof patch.defaults["x"] === "number"
          ? (patch.defaults["x"] as number)
          : (existing.defaultPlacement?.x ?? 5),
      y:
        typeof patch.defaults["y"] === "number"
          ? (patch.defaults["y"] as number)
          : (existing.defaultPlacement?.y ?? 30),
      width:
        typeof patch.defaults["width"] === "number"
          ? (patch.defaults["width"] as number)
          : (existing.defaultPlacement?.width ?? 90),
      height:
        typeof patch.defaults["height"] === "number"
          ? (patch.defaults["height"] as number)
          : (existing.defaultPlacement?.height ?? 40),
    };
  }
  return upsertCustomBlock(next);
}

export async function deleteBlockById(id: string): Promise<boolean> {
  const existing = await getBlock(id);
  if (!existing) return false;
  if (existing.builtIn) {
    throw new Error(
      `Cannot delete built-in block "${id}". Customise via blocks.update or clone via blocks.create.`,
    );
  }
  return deleteCustomBlock(id);
}

// ── Template engine ─────────────────────────────────────────

/**
 * Substitute `{{slotKey}}` placeholders with the provided slot values.
 * Falls back to the slot's default (defined on the block) and then to "".
 * No HTML escaping — block authors can include rich markup.
 */
export function renderBlockTemplate(
  block: BlockDefinition,
  slots: Record<string, string> = {},
): string {
  if (!block.template) return "";
  return block.template.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_, key: string) => {
    if (key in slots && slots[key] !== undefined) return String(slots[key]);
    const def = block.slots.find((s) => s.key === key)?.default;
    return def ?? "";
  });
}

/**
 * Wrap a block's CSS so each selector is prefixed with `.veblk-<id>` to
 * isolate it from other clips on the stage. Selectors that already mention
 * the scope are passed through untouched.
 */
export function scopeBlockCss(block: BlockDefinition): string {
  if (!block.css) return "";
  const scope = `.veblk-${block.id}`;
  return block.css.replace(/(^|})\s*([^@}{][^{]*)\{/g, (_match, brace, sel: string) => {
    const scopedSelectors = sel
      .split(",")
      .map((s) => {
        const trimmed = s.trim();
        if (!trimmed) return trimmed;
        if (trimmed.startsWith(scope) || trimmed === scope) return trimmed;
        if (/^(:root|html|body)\b/.test(trimmed)) return scope;
        return `${scope} ${trimmed}`;
      })
      .filter(Boolean)
      .join(", ");
    return `${brace} ${scopedSelectors} {`;
  });
}

// ── Templates ───────────────────────────────────────────────

export async function listTemplates(): Promise<CompositionTemplate[]> {
  const file = await load();
  // Built-ins are computed at runtime (no persistence cost), then
  // user-saved ones are layered on top sorted newest-first. A user-saved
  // template with the same id as a built-in wins (the operator may
  // intentionally override one).
  const { listBuiltInTemplates } = await import("./built-in-templates.js");
  const builtIns = listBuiltInTemplates();
  const userById = new Map(file.templates.map((t) => [t.id, t]));
  const merged: CompositionTemplate[] = [];
  for (const b of builtIns) {
    merged.push(userById.get(b.id) ?? b);
  }
  for (const u of file.templates) {
    if (!builtIns.find((b) => b.id === u.id)) merged.push(u);
  }
  return merged.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getTemplate(id: string): Promise<CompositionTemplate | null> {
  const file = await load();
  const user = file.templates.find((t) => t.id === id);
  if (user) return user;
  const { listBuiltInTemplates } = await import("./built-in-templates.js");
  return listBuiltInTemplates().find((t) => t.id === id) ?? null;
}

export async function saveTemplate(
  input: Omit<CompositionTemplate, "id" | "builtIn" | "createdAt" | "updatedAt"> & { id?: string },
): Promise<CompositionTemplate> {
  const file = await load();
  const now = Date.now();
  const id = input.id || `tpl-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const existing = file.templates.find((t) => t.id === id);
  const tpl: CompositionTemplate = {
    id,
    name: input.name,
    description: input.description,
    thumbnail: input.thumbnail,
    tags: input.tags ?? [],
    composition: input.composition,
    tracks: input.tracks ?? [],
    clips: input.clips ?? [],
    builtIn: false,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  if (existing) {
    file.templates = file.templates.map((t) => (t.id === id ? tpl : t));
  } else {
    file.templates.push(tpl);
  }
  await save();
  return tpl;
}

export async function deleteTemplate(id: string): Promise<boolean> {
  const file = await load();
  const before = file.templates.length;
  file.templates = file.templates.filter((t) => t.id !== id);
  const removed = file.templates.length !== before;
  if (removed) await save();
  return removed;
}
