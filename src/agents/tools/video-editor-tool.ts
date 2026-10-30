/**
 * Agent tool — InfiniBot's native video editor.
 *
 * Single tool with an `action` switch that exposes the entire composition
 * editor surface to the in-process agent: comps, tracks, clips, blocks,
 * templates, assets, animations, captions, silence cutting, snapshots, and
 * render. Mirrors the `databases` tool ergonomics — friendly value
 * shorthand (color names, percentage strings, kind names) is coerced into
 * the canonical store shape so an LLM can write
 *   { "color": "gold", "x": "10%", "fontSize": 96 }
 * instead of memorising every union and unit.
 *
 * The tool does NOT proxy to gateway RPCs — it calls the same in-process
 * stores those RPCs use. That keeps tool latency to a single function call
 * and avoids the JSON-RPC round-trip for every clip edit.
 */

import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema/typebox.js";
import {
  type AnyAgentTool,
  jsonResult,
  imageResult,
  readStringParam,
  readNumberParam,
} from "./common.js";
import { STATE_DIR } from "../../config/paths.js";
import { getCompositionsStore, type CompositionsStore } from "../../compositions/store.js";
import {
  ensureProjectDir,
  listAssets,
  findAsset,
  addAsset,
  updateAssetMetadata,
  removeAsset as removeAssetFile,
  projectDir as projectDirPath,
  assetsDir,
  taskPath,
  type AssetMetadata,
} from "../../compositions/project-dir.js";
import { transcribeMedia } from "../../compositions/transcribe.js";
import { CAPTION_PRESETS, findCaptionPreset } from "../../compositions/caption-presets.js";
import {
  ELEMENT_ANIMATION_PRESETS,
  findElementAnimationPreset,
} from "../../compositions/element-animation-presets.js";
import {
  listAllBlocks as listBlockDefs,
  getBlock as getBlockDef,
  createBlock as createBlockDef,
  updateBlockById as updateBlockDef,
  deleteBlockById as deleteBlockDef,
} from "../../compositions/blocks/store.js";
import type {
  CaptionsClipProps,
  Clip,
  ClipEffect,
  ClipEffectKind,
  ClipKind,
  ClipProps,
  CompositionWithChildren,
  Track,
  TrackKind,
} from "../../compositions/types.js";
import {
  readTransitions,
  TRANSITION_DEFAULT_DURATIONS,
  TRANSITION_LABELS,
  type ClipTransition,
  type TransitionKind,
} from "../../compositions/transitions.js";
import { EFFECT_LABELS } from "../../compositions/effects.js";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { join, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { cutSilences } from "../../media/silence-cutter.js";
import { dispatchToUI } from "../../gateway/server-methods/ui-control.js";

type CompositionRenderModule = typeof import("../../compositions/render.js");

let compositionRenderModulePromise: Promise<CompositionRenderModule> | null = null;

async function loadCompositionRenderModule(): Promise<CompositionRenderModule> {
  if (!compositionRenderModulePromise) {
    compositionRenderModulePromise = import("../../compositions/render.js");
  }
  return compositionRenderModulePromise;
}

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Fire-and-forget UI mirror dispatch. After a tool mutation lands in the
 * compositions store, ping the open editor so the user SEES what changed
 * (the new clip becomes selected, the playhead scrubs to it, etc.).
 *
 * Wrapped in a void promise + short timeout so a missing/idle UI client
 * never blocks the tool response. The actual content edits still went
 * through — this is purely about visual sync.
 */
function pushUI(action: string, args?: Record<string, unknown>): void {
  void dispatchToUI("video_editor", action, args, { timeoutMs: 1500 }).catch(() => {
    /* no UI connected, or stale tab — non-fatal */
  });
}

function store(): CompositionsStore {
  return getCompositionsStore(STATE_DIR);
}

/** Resolve a composition by id OR by slug (so the agent can use either). */
function resolveComposition(handle: string): CompositionWithChildren | null {
  const s = store();
  const direct = s.getWithChildren(handle);
  if (direct) return direct;
  const bySlug = s.getBySlug(handle);
  if (bySlug) return s.getWithChildren(bySlug.id);
  return null;
}

/** Color name → hex shorthand for CSS-friendly fields. */
const NAMED_COLORS: Record<string, string> = {
  gold: "#d4af37",
  primary: "#d4af37",
  accent: "#8b5cf6",
  white: "#ffffff",
  black: "#000000",
  red: "#ef4444",
  green: "#22c55e",
  blue: "#3b82f6",
  cyan: "#22d3ee",
  pink: "#f472b6",
  orange: "#f97316",
  yellow: "#fde047",
  purple: "#a855f7",
  emerald: "#10b981",
  amber: "#f59e0b",
  slate: "#94a3b8",
  text: "#e4e4e7",
  muted: "#a1a1aa",
};

function coerceColor(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const lower = v.trim().toLowerCase();
  if (NAMED_COLORS[lower]) return NAMED_COLORS[lower];
  // Allow rgb(...) / rgba(...) / hex / hsl(...) / "transparent" through verbatim.
  return v;
}

/**
 * Coerce a percentage value: "50%", "50", or 50 → 50.
 * Used for x/y/width/height which are 0..100 percentages of the canvas.
 */
function coercePct(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const m = v.trim().match(/^(-?\d+(?:\.\d+)?)\s*%?$/);
    if (m) return parseFloat(m[1]!);
  }
  return undefined;
}

/**
 * Coerce a time value to seconds: "2.5s", "0:02.500", "150" (frames? no — seconds), 2.5.
 */
function coerceTime(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const trimmed = v.trim();
    // "MM:SS.mmm"
    const m = trimmed.match(/^(\d+):(\d+(?:\.\d+)?)$/);
    if (m) return parseInt(m[1]!, 10) * 60 + parseFloat(m[2]!);
    // "2.5s" or "2.5"
    const n = parseFloat(trimmed.replace(/s$/, ""));
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * Recursively walk a `props` object the agent passed and coerce any color
 * / percentage / time-shaped values to their canonical numeric form.
 * Field-name guided so we don't touch unrelated strings.
 */
function coerceProps(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (
      lower === "color" ||
      lower === "fill" ||
      lower === "background" ||
      lower === "active" ||
      lower === "border" ||
      lower === "bordercolor" ||
      lower === "gradientfrom" ||
      lower === "gradientto"
    ) {
      out[key] = coerceColor(val) ?? val;
    } else if (
      lower === "x" ||
      lower === "y" ||
      lower === "width" ||
      lower === "height" ||
      lower === "opacity" ||
      lower === "rotation" ||
      lower === "padx" ||
      lower === "pady"
    ) {
      const n = coercePct(val);
      out[key] = n !== undefined ? n : val;
    } else if (
      lower === "startsec" ||
      lower === "durationsec" ||
      lower === "trimstart" ||
      lower === "fadein" ||
      lower === "fadeout" ||
      lower === "wordanimsec"
    ) {
      const t = coerceTime(val);
      out[key] = t !== undefined ? t : val;
    } else if (val && typeof val === "object" && !Array.isArray(val)) {
      out[key] = coerceProps(val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

/** Build a compact clip summary for read-actions — keeps responses light. */
function summarizeClip(c: Clip): Record<string, unknown> {
  const propsObj = (c.props ?? {}) as unknown as Record<string, unknown>;
  return {
    id: c.id,
    trackId: c.trackId,
    kind: c.kind,
    label: c.label,
    startSec: c.startSec,
    durationSec: c.durationSec,
    z: c.z,
    propsKeys: Object.keys(propsObj),
  };
}

function summarizeComp(c: CompositionWithChildren): Record<string, unknown> {
  // Surface `meta.style` (the /watch-skill output) verbatim — this is the
  // primary mechanism by which the AI motion designer agent picks fonts,
  // pacing, palette, and preset families for new clips. When unset the
  // field is omitted so the agent isn't tempted to invent a style.
  const meta = (c.meta ?? {}) as Record<string, unknown>;
  const style = meta.style as Record<string, unknown> | undefined;
  const variables = Array.isArray(meta.variables)
    ? (meta.variables as Record<string, unknown>[])
    : [];
  const variableValues = (meta.variableValues as Record<string, unknown> | undefined) ?? {};
  const rawContext = meta.context as
    | {
        referenceDir?: string;
        workingDir?: string;
        referenceSites?: Array<{ url: string; label?: string }>;
        notes?: string;
      }
    | undefined;
  // Normalize legacy `workingDir` → `referenceDir` so the agent sees one
  // canonical field regardless of when the comp was authored.
  const context = rawContext
    ? {
        referenceDir: rawContext.referenceDir ?? rawContext.workingDir,
        referenceSites: rawContext.referenceSites,
        notes: rawContext.notes,
      }
    : undefined;
  const hasContext = !!(
    context &&
    (context.referenceDir ||
      (context.referenceSites && context.referenceSites.length > 0) ||
      context.notes)
  );
  return {
    id: c.id,
    slug: c.slug,
    name: c.name,
    widthPx: c.widthPx,
    heightPx: c.heightPx,
    fps: c.fps,
    durationSec: c.durationSec,
    bgColor: c.bgColor,
    ...(style ? { projectStyle: style } : {}),
    ...(variables.length ? { variables, variableValues } : {}),
    ...(hasContext ? { projectContext: context } : {}),
    tracks: c.tracks.map((t) => ({
      id: t.id,
      kind: t.kind,
      name: t.name,
      muted: t.muted,
      hidden: t.hidden,
      locked: t.locked,
    })),
    clips: c.clips.map(summarizeClip),
  };
}

// ── Tool schema ──────────────────────────────────────────────────

const VideoEditorSchema = Type.Object({
  action: stringEnum([
    // Composition
    "list",
    "get",
    "create",
    "update",
    "delete",
    // Tracks
    "track.add",
    "track.update",
    "track.delete",
    // Clips
    "clip.add",
    "clip.move",
    "clip.resize",
    "clip.delete",
    "clip.set_props",
    "clip.apply_animation",
    "clip.list",
    "clip.get",
    // Captions
    "captions.transcribe",
    "captions.set_preset",
    "captions.edit_cue",
    "captions.preset.list",
    // Silence
    "silence.cut",
    // Assets
    "asset.list",
    "asset.get",
    "asset.update_metadata",
    "asset.delete",
    // Brief
    "brief.read",
    "brief.write",
    "brief.append",
    // Library introspection
    "animation.preset.list",
    // Composition blocks (HTML/CSS clip templates)
    "block.list",
    "block.get",
    "block.create",
    "block.update",
    "block.delete",
    "block.insert",
    "block.set_element_stagger",
    // Render
    "render.start",
    "render.status",
    "render.list",
    "render.cancel",
    // Multimodal grounding
    "frame.snapshot",
    // Hyperframes-aware composition + render — orchestrates create/edit
    // from a natural-language brief and kicks off a render through the
    // phase-2 hyperframes pipeline in a single call.
    "compose_with_hyperframes",
    // Inspect the translator output (TimelineElement[] + HTML preview)
    // without rendering — useful for debugging the hyperframes mapping.
    "hyperframes.inspect",
    // Clip-to-clip transitions (stored in comp.meta.transitions)
    "transition.list",
    "transition.add",
    "transition.update",
    "transition.delete",
    // Per-clip effects stack (blur, glow, grain, chromatic, etc.)
    "clip.effects.add",
    "clip.effects.update",
    "clip.effects.remove",
    // Composition variables — typed inputs that drive clip props via {{id}}
    "variables.list",
    "variables.declare",
    "variables.set",
    "variables.delete",
    // Segment export — render only a time window of the composition.
    "render.segment",
  ]),

  // Common
  composition: Type.Optional(Type.String()),

  // Composition lifecycle
  name: Type.Optional(Type.String()),
  slug: Type.Optional(Type.String()),
  width_px: Type.Optional(Type.Number()),
  height_px: Type.Optional(Type.Number()),
  aspect_ratio: Type.Optional(Type.String()),
  fps: Type.Optional(Type.Number()),
  duration_sec: Type.Optional(Type.Number()),
  bg_color: Type.Optional(Type.String()),

  // Track
  track_id: Type.Optional(Type.String()),
  track_kind: Type.Optional(stringEnum(["video", "overlay", "audio"])),
  track_name: Type.Optional(Type.String()),
  muted: Type.Optional(Type.Boolean()),
  hidden: Type.Optional(Type.Boolean()),
  locked: Type.Optional(Type.Boolean()),

  // Clip
  clip_id: Type.Optional(Type.String()),
  clip_kind: Type.Optional(
    stringEnum(["video", "image", "text", "audio", "shape", "block", "captions"]),
  ),
  start_sec: Type.Optional(Type.Number()),
  duration_sec_clip: Type.Optional(Type.Number()),
  z: Type.Optional(Type.Number()),
  label: Type.Optional(Type.String()),
  props: Type.Optional(Type.Unknown()),
  /** Friendly preset id from element-animation-presets. */
  animation_preset_id: Type.Optional(Type.String()),

  // Captions
  cue_index: Type.Optional(Type.Number()),
  cue_text: Type.Optional(Type.String()),
  preset_id: Type.Optional(Type.String()),
  language: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),

  // Silence
  threshold_db: Type.Optional(Type.Number()),
  min_silence_sec: Type.Optional(Type.Number()),

  // Assets
  asset_filename: Type.Optional(Type.String()),
  metadata_patch: Type.Optional(Type.Unknown()),

  // Brief
  brief_text: Type.Optional(Type.String()),

  // compose_with_hyperframes — natural-language description of the
  // composition. Used to seed a fresh comp's title text or appended to
  // an existing comp as an overlay caption.
  hyperframes_brief: Type.Optional(Type.String()),

  // Render
  job_id: Type.Optional(Type.String()),
  format: Type.Optional(stringEnum(["mp4", "webm"])),
  /** Segment render: start time in seconds (inclusive). */
  segment_start_sec: Type.Optional(Type.Number()),
  /** Segment render: end time in seconds (inclusive). */
  segment_end_sec: Type.Optional(Type.Number()),

  // Frame snapshot
  at_sec: Type.Optional(Type.Number()),
  max_width: Type.Optional(Type.Number()),

  // Block CRUD
  block_id: Type.Optional(Type.String()),
  block_name: Type.Optional(Type.String()),
  block_description: Type.Optional(Type.String()),
  block_icon: Type.Optional(Type.String()),
  block_duration_sec: Type.Optional(Type.Number()),
  block_defaults: Type.Optional(Type.Unknown()),
  block_slots: Type.Optional(
    Type.Array(
      Type.Object({
        key: Type.String(),
        label: Type.String(),
        default: Type.Optional(Type.String()),
      }),
    ),
  ),
  block_template: Type.Optional(Type.String()),
  block_css: Type.Optional(Type.String()),
  /** For block.insert — slot value overrides for this clip instance. */
  slot_values: Type.Optional(Type.Unknown()),

  // Element-stagger animation (per-child keyframe timing for block clips)
  /** Element animation preset id (from animation.preset.list) for entrance. */
  stagger_preset_id: Type.Optional(Type.String()),
  /** Delay between successive items in seconds (default 0.15). */
  stagger_step_sec: Type.Optional(Type.Number()),
  /** Offset before the first item starts, relative to clip start. */
  stagger_start_sec: Type.Optional(Type.Number()),
  /** Optional out-animation preset id (defaults to the entrance preset's out triplet). */
  stagger_out_preset_id: Type.Optional(Type.String()),
  /** Optional reverse step for the out cascade (defaults to step_sec). */
  stagger_out_step_sec: Type.Optional(Type.Number()),
  /** Per-element overrides keyed by data-anim-key, e.g. { item1: { atSec: 0.4 } }. */
  stagger_per_key: Type.Optional(Type.Unknown()),
  /** Pass true to remove any existing elementStagger from the clip. */
  stagger_clear: Type.Optional(Type.Boolean()),

  // Transitions
  /** Stable id — returned by transition.add / transition.list; required for transition.update / transition.delete. */
  transition_id: Type.Optional(Type.String()),
  /** Transition style (from transition.list available_kinds). */
  transition_kind: Type.Optional(Type.String()),
  /** Outgoing clip id (the clip that plays before the cut). */
  from_clip_id: Type.Optional(Type.String()),
  /** Incoming clip id (the clip that plays after the cut). */
  to_clip_id: Type.Optional(Type.String()),
  /** Transition duration in seconds (default varies by kind, typically 0.4–0.6). */
  transition_duration_sec: Type.Optional(Type.Number()),
  /** Optional easing override. Defaults are tuned per-kind. */
  transition_ease: Type.Optional(Type.String()),

  // Effects stack
  /** Stable effect id — returned by clip.effects.add; required for clip.effects.update / clip.effects.remove. */
  effect_id: Type.Optional(Type.String()),
  /** Effect kind: blur, glow, brightness, contrast, saturate, hue, vignette, grain, chromatic, invert. */
  effect_kind: Type.Optional(Type.String()),
  /** Effect intensity 0..1. */
  effect_intensity: Type.Optional(Type.Number()),
  /** Optional per-kind params: { color: "#d4a02b" } for glow, { degrees: 180 } for hue. */
  effect_params: Type.Optional(Type.Unknown()),
  /** false to disable the effect without removing it. */
  effect_enabled: Type.Optional(Type.Boolean()),

  // Variables
  /** Variable id (alphanumeric + underscore). Used as the substitution key in {{id}} bindings. */
  variable_id: Type.Optional(Type.String()),
  /** Variable type: string | number | color | boolean | enum. */
  variable_type: Type.Optional(Type.String()),
  /** Human label shown in the editor UI. */
  variable_label: Type.Optional(Type.String()),
  /** Default value for this variable (type-matched to variable_type). */
  variable_default: Type.Optional(Type.Unknown()),
  /** Current bound value for variables.set. */
  variable_value: Type.Optional(Type.Unknown()),
  /** Min bound for number variables. */
  variable_min: Type.Optional(Type.Number()),
  /** Max bound for number variables. */
  variable_max: Type.Optional(Type.Number()),
  /** Allowed values for enum variables. */
  variable_options: Type.Optional(Type.Array(Type.String())),
});

// ── Tool factory ─────────────────────────────────────────────────

export function createVideoEditorTool(_options?: { agentId?: string }): AnyAgentTool {
  return {
    label: "Video Editor",
    name: "video_editor",
    description:
      `Full read/write access to InfiniBot's native video editor — compositions, ` +
      `tracks, clips, captions, animations, silence cutting, assets, render.\n\n` +
      `Lifecycle: "list", "get" (returns full timeline + clips — call first), ` +
      `"create" (name + width_px/height_px/fps/duration_sec/bg_color OR aspect_ratio shorthand "16:9"), ` +
      `"update", "delete".\n\n` +
      `Tracks: "track.add" (track_kind: video|overlay|audio + optional track_name), ` +
      `"track.update" (toggle muted/hidden/locked), "track.delete".\n\n` +
      `Clips: "clip.add" (clip_kind + track_id + start_sec + duration_sec_clip + props), ` +
      `"clip.move" (start_sec / track_id), "clip.resize" (duration_sec_clip), ` +
      `"clip.delete", "clip.set_props" (patch only the keys you change), ` +
      `"clip.apply_animation" (animation_preset_id from animation.preset.list), ` +
      `"clip.list", "clip.get".\n\n` +
      `Captions: "captions.transcribe" (asset_filename → drops a captions clip ` +
      `with word-level cues via faster-whisper), "captions.set_preset" (preset_id ` +
      `from captions.preset.list — TikTok highlight, Hormozi keywords, broadcast, ` +
      `glitch, neon-pop, etc.), "captions.edit_cue" (cue_index + cue_text — fix typos).\n\n` +
      `Silence: "silence.cut" on a video clip — runs the silence cutter on its src, ` +
      `replaces with the trimmed result.\n\n` +
      `Assets: "asset.list", "asset.get", "asset.update_metadata" (patch tags / mood / ` +
      `scene / colorPalette / energy / suggestedUses / description / notes — agent ` +
      `populates these so future sessions reason better), "asset.delete".\n\n` +
      `Brief: "brief.read" / "brief.write" / "brief.append" — the TASK.md scratchpad ` +
      `the operator + agent share for this composition.\n\n` +
      `Library introspection: "animation.preset.list" returns the 15 element ` +
      `animation presets (Pop In, Kinetic Title, Glitch In, Pulse CTA, etc.); ` +
      `"captions.preset.list" returns the 8 caption presets.\n\n` +
      `Project style context: every "get" response includes a "projectStyle" ` +
      `field when the operator has dropped a reference video into the editor's ` +
      `Style Reference slot. The shape is the /watch-skill JSON — ` +
      `{description, tags, mood, scene, colorPalette[], energy, suggestedUses[], ` +
      `transcript, notes}. Treat it as authoritative: pick fonts, animation ` +
      `presets, pacing, and color palette to match. If projectStyle is missing, ` +
      `say so before generating any clips — never invent a style direction.\n\n` +
      `Project context: every "get" response carries "projectContext" with ` +
      `{referenceDir, referenceSites[], notes} when the operator has filled ` +
      `out the editor's Context tab. referenceDir is an ADDITIONAL folder ` +
      `the operator points at as reference material (brand kit, asset ` +
      `library, prior projects) — it does NOT change the composition's ` +
      `working directory; the gateway-managed project dir is still ` +
      `state/compositions/<id>/. Read files from referenceDir for context ` +
      `(don't write into it unless the operator asks). referenceSites is a ` +
      `curated URL list to study (brand pages, style references, example ` +
      `videos). notes is free-form text. Read these every time you fetch a ` +
      `composition — the operator puts them there specifically so you ` +
      `don't have to ask.\n\n` +
      `Variables: compositions can declare typed inputs (string / number / ` +
      `color / boolean / enum) via the "variables.*" actions. Clip props ` +
      `substitute "{{varId}}" anywhere in string-valued fields (text, color, ` +
      `background) and "{$var: 'varId'}" for non-string props (fontSize, ` +
      `opacity, durationSec). When you author a template-ish composition, ` +
      `prefer declaring 3-6 well-labelled variables (e.g. heroText, ` +
      `accentColor, runtimeSec) and binding the static props to them — this ` +
      `lets the operator re-skin without editing clips. The "get" response ` +
      `includes "variables[]" and "variableValues" so you can see what's ` +
      `already declared before writing more.\n\n` +
      `Transitions (Phase 6): "transition.list" (returns all transitions on the comp ` +
      `+ available_kinds catalogue), "transition.add" (from_clip_id + to_clip_id + ` +
      `transition_kind + optional transition_duration_sec), "transition.update" ` +
      `(transition_id + any fields to change), "transition.delete" (transition_id). ` +
      `Transitions are stored in comp.meta.transitions and resolved at render time — ` +
      `the outgoing clip's exit and incoming clip's entrance are overridden to produce ` +
      `the blend. Available kinds: crossDissolve, wipeLeft, wipeRight, wipeUp, ` +
      `wipeDown, zoomBlur, glitch, slideLeft, slideRight, fadeBlack, fadeWhite.\n\n` +
      `Effects stack (Phase 6): "clip.effects.add" (clip_id + effect_kind + ` +
      `effect_intensity 0..1 + optional effect_params + effect_enabled), ` +
      `"clip.effects.update" (clip_id + effect_id + any field), ` +
      `"clip.effects.remove" (clip_id + effect_id). ` +
      `Effects are CSS filter chains applied at render time in stack order. ` +
      `Available kinds: blur, glow (params.color), brightness, contrast, saturate, ` +
      `hue (params.degrees), vignette, grain, chromatic, invert. ` +
      `Use clip.get to read the current effects[] on a clip.\n\n` +
      `Variables: "variables.list" (show declared variables + current values), ` +
      `"variables.declare" (variable_id + variable_type [string/number/color/boolean/enum] ` +
      `+ variable_label + variable_default + variable_min/max/options for numeric/enum), ` +
      `"variables.set" (variable_id + variable_value — sets the bound value), ` +
      `"variables.delete" (variable_id — removes declaration + value). ` +
      `Clip props reference variables via {{varId}} in string fields or ` +
      `{\\$var: 'varId'} for numeric/boolean props.\n\n` +
      `Render: "render.start" → returns job_id; "render.status" / "render.list" / ` +
      `"render.cancel".\n\n` +
      `Friendly value shorthand: colors accept names ("gold", "accent", "cyan"), ` +
      `x/y/width/height accept "50%" or 50, time accepts "2.5s" or "0:02.5" or 2.5. ` +
      `Coordinates are percentages of the canvas (NOT pixels).`,
    parameters: VideoEditorSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      try {
        switch (action) {
          // ── Composition lifecycle ───────────────────────────────

          case "list": {
            return jsonResult({ compositions: store().list() });
          }

          case "get": {
            const handle = readStringParam(params, "composition", { required: true });
            const comp = resolveComposition(handle);
            if (!comp) return jsonResult({ error: `Composition ${handle} not found` });
            return jsonResult({ composition: summarizeComp(comp) });
          }

          case "create": {
            const name = readStringParam(params, "name", { required: true });
            // Aspect-ratio shorthand: "16:9", "9:16", etc. → widthPx/heightPx defaults.
            const aspect = readStringParam(params, "aspect_ratio");
            let widthPx = readNumberParam(params, "width_px");
            let heightPx = readNumberParam(params, "height_px");
            if (aspect && (widthPx === undefined || heightPx === undefined)) {
              const m = aspect.match(/^(\d+):(\d+)$/);
              if (m) {
                const ar = parseInt(m[1]!, 10) / parseInt(m[2]!, 10);
                if (ar >= 1) {
                  widthPx = widthPx ?? 1920;
                  heightPx = heightPx ?? Math.round(1920 / ar);
                } else {
                  heightPx = heightPx ?? 1920;
                  widthPx = widthPx ?? Math.round(1920 * ar);
                }
              }
            }
            const comp = store().create({
              name,
              slug: readStringParam(params, "slug"),
              widthPx,
              heightPx,
              fps: readNumberParam(params, "fps"),
              durationSec: readNumberParam(params, "duration_sec"),
              bgColor: coerceColor(params.bg_color) ?? readStringParam(params, "bg_color"),
            });
            try {
              ensureProjectDir(comp.id, comp.name);
            } catch {
              /* best effort */
            }
            pushUI("list_compositions");
            pushUI("select_composition", { id: comp.id });
            return jsonResult({ composition: comp, projectDir: projectDirPath(comp.id) });
          }

          case "update": {
            const handle = readStringParam(params, "composition", { required: true });
            const comp = resolveComposition(handle);
            if (!comp) return jsonResult({ error: `Composition ${handle} not found` });
            const patch: Record<string, unknown> = {};
            if (params.name !== undefined) patch.name = params.name;
            if (params.width_px !== undefined) patch.widthPx = params.width_px;
            if (params.height_px !== undefined) patch.heightPx = params.height_px;
            if (params.fps !== undefined) patch.fps = params.fps;
            if (params.duration_sec !== undefined) patch.durationSec = params.duration_sec;
            if (params.bg_color !== undefined) {
              patch.bgColor = coerceColor(params.bg_color) ?? params.bg_color;
            }
            // aspect_ratio shorthand: also flips dims if either width_px / height_px not given
            const aspect = readStringParam(params, "aspect_ratio");
            if (aspect) {
              const m = aspect.match(/^(\d+):(\d+)$/);
              if (m) {
                const ar = parseInt(m[1]!, 10) / parseInt(m[2]!, 10);
                if (ar >= 1) {
                  patch.widthPx = patch.widthPx ?? comp.widthPx;
                  patch.heightPx = patch.heightPx ?? Math.round(Number(patch.widthPx) / ar);
                } else {
                  patch.heightPx = patch.heightPx ?? comp.heightPx;
                  patch.widthPx = patch.widthPx ?? Math.round(Number(patch.heightPx) * ar);
                }
              }
            }
            const updated = store().update(
              comp.id,
              patch as Parameters<CompositionsStore["update"]>[1],
            );
            return jsonResult({ composition: updated });
          }

          case "delete": {
            const handle = readStringParam(params, "composition", { required: true });
            const comp = resolveComposition(handle);
            if (!comp) return jsonResult({ error: `Composition ${handle} not found` });
            return jsonResult({ deleted: store().delete(comp.id) });
          }

          // ── Tracks ──────────────────────────────────────────────

          case "track.add": {
            const handle = readStringParam(params, "composition", { required: true });
            const comp = resolveComposition(handle);
            if (!comp) return jsonResult({ error: `Composition ${handle} not found` });
            const kind = readStringParam(params, "track_kind", { required: true }) as TrackKind;
            const track = store().createTrack({
              compositionId: comp.id,
              kind,
              name: readStringParam(params, "track_name"),
            });
            return jsonResult({ track });
          }

          case "track.update": {
            const trackId = readStringParam(params, "track_id", { required: true });
            const patch: Partial<Track> = {};
            if (params.track_name !== undefined) patch.name = params.track_name as string;
            if (params.track_kind !== undefined) patch.kind = params.track_kind as TrackKind;
            if (params.muted !== undefined) patch.muted = !!params.muted;
            if (params.hidden !== undefined) patch.hidden = !!params.hidden;
            if (params.locked !== undefined) patch.locked = !!params.locked;
            const updated = store().updateTrack(trackId, patch);
            if (!updated) return jsonResult({ error: `Track ${trackId} not found` });
            return jsonResult({ track: updated });
          }

          case "track.delete": {
            const trackId = readStringParam(params, "track_id", { required: true });
            return jsonResult({ deleted: store().deleteTrack(trackId) });
          }

          // ── Clips ───────────────────────────────────────────────

          case "clip.add": {
            const handle = readStringParam(params, "composition", { required: true });
            const comp = resolveComposition(handle);
            if (!comp) return jsonResult({ error: `Composition ${handle} not found` });
            const kind = readStringParam(params, "clip_kind", { required: true }) as ClipKind;
            let trackId = readStringParam(params, "track_id");
            // Auto-pick a track of the matching kind (or auto-create one).
            if (!trackId) {
              const wantedTrackKind: TrackKind =
                kind === "audio"
                  ? "audio"
                  : kind === "video" || kind === "image"
                    ? "video"
                    : "overlay";
              const matching = comp.tracks.find((t) => t.kind === wantedTrackKind);
              if (matching) {
                trackId = matching.id;
              } else {
                const tr = store().createTrack({
                  compositionId: comp.id,
                  kind: wantedTrackKind,
                  name:
                    wantedTrackKind === "video"
                      ? "Video"
                      : wantedTrackKind === "audio"
                        ? "Audio"
                        : "Overlay",
                });
                trackId = tr.id;
              }
            }
            const startSec = coerceTime(params.start_sec) ?? 0;
            const durationSec = coerceTime(params.duration_sec_clip) ?? 4;
            const props = coerceProps(params.props) as unknown as ClipProps;
            const clip = store().createClip({
              compositionId: comp.id,
              trackId,
              kind,
              label: readStringParam(params, "label"),
              startSec,
              durationSec,
              z: readNumberParam(params, "z"),
              props,
            });
            // Show the user what just landed: switch to this comp if it
            // isn't the active one, then scrub the playhead to the new
            // clip's start + select it.
            pushUI("select_composition", { id: comp.id });
            pushUI("clip.scrub_to", { id: clip.id });
            return jsonResult({ clip });
          }

          case "clip.move": {
            const id = readStringParam(params, "clip_id", { required: true });
            const patch: Partial<Pick<Clip, "trackId" | "startSec">> = {};
            if (params.track_id !== undefined) patch.trackId = params.track_id as string;
            if (params.start_sec !== undefined) {
              patch.startSec = coerceTime(params.start_sec) ?? 0;
            }
            const updated = store().updateClip(id, patch);
            if (!updated) return jsonResult({ error: `Clip ${id} not found` });
            pushUI("clip.scrub_to", { id });
            return jsonResult({ clip: updated });
          }

          case "clip.resize": {
            const id = readStringParam(params, "clip_id", { required: true });
            const dur = coerceTime(params.duration_sec_clip);
            if (dur === undefined) return jsonResult({ error: "duration_sec_clip required" });
            const updated = store().updateClip(id, { durationSec: Math.max(0.05, dur) });
            if (!updated) return jsonResult({ error: `Clip ${id} not found` });
            pushUI("clip.scrub_to", { id });
            return jsonResult({ clip: updated });
          }

          case "clip.delete": {
            const id = readStringParam(params, "clip_id", { required: true });
            const deleted = store().deleteClip(id);
            if (deleted) pushUI("clip.select", { id: null });
            return jsonResult({ deleted });
          }

          case "clip.set_props": {
            const id = readStringParam(params, "clip_id", { required: true });
            const cur = store().getClip(id);
            if (!cur) return jsonResult({ error: `Clip ${id} not found` });
            const incoming = coerceProps(params.props);
            const merged: ClipProps = { ...cur.props, ...incoming } as ClipProps;
            const patch: Partial<Pick<Clip, "label" | "z" | "props">> = { props: merged };
            if (params.label !== undefined) patch.label = params.label as string;
            if (params.z !== undefined) patch.z = Number(params.z) || 0;
            const updated = store().updateClip(id, patch);
            pushUI("clip.scrub_to", { id });
            return jsonResult({ clip: updated });
          }

          case "clip.apply_animation": {
            const id = readStringParam(params, "clip_id", { required: true });
            const presetId = readStringParam(params, "animation_preset_id", { required: true });
            const preset = findElementAnimationPreset(presetId);
            if (preset.id !== presetId) {
              return jsonResult({
                error: `Unknown preset "${presetId}". Available: ${ELEMENT_ANIMATION_PRESETS.map((p) => p.id).join(", ")}`,
              });
            }
            const cur = store().getClip(id);
            if (!cur) return jsonResult({ error: `Clip ${id} not found` });
            const updated = store().updateClip(id, {
              props: { ...cur.props, animationPresetId: presetId } as ClipProps,
            });
            pushUI("clip.scrub_to", { id });
            return jsonResult({ clip: updated, preset });
          }

          case "clip.list": {
            const handle = readStringParam(params, "composition", { required: true });
            const comp = resolveComposition(handle);
            if (!comp) return jsonResult({ error: `Composition ${handle} not found` });
            return jsonResult({ clips: comp.clips.map(summarizeClip) });
          }

          case "clip.get": {
            const id = readStringParam(params, "clip_id", { required: true });
            const clip = store().getClip(id);
            if (!clip) return jsonResult({ error: `Clip ${id} not found` });
            return jsonResult({ clip });
          }

          // ── Captions ─────────────────────────────────────────────

          case "captions.preset.list": {
            return jsonResult({ presets: CAPTION_PRESETS });
          }

          case "captions.transcribe": {
            const handle = readStringParam(params, "composition", { required: true });
            const comp = resolveComposition(handle);
            if (!comp) return jsonResult({ error: `Composition ${handle} not found` });
            const filename = readStringParam(params, "asset_filename", { required: true });
            const asset = findAsset(comp.id, filename);
            if (!asset) return jsonResult({ error: `Asset ${filename} not found` });
            if (asset.kind !== "video" && asset.kind !== "audio") {
              return jsonResult({ error: "Asset must be video or audio to transcribe" });
            }
            const filePath = join(projectDirPath(comp.id), "assets", filename);
            if (!existsSync(filePath)) return jsonResult({ error: "Asset file missing on disk" });
            const presetId = readStringParam(params, "preset_id") ?? "tiktok-highlight";
            const result = await transcribeMedia({
              filePath,
              model: readStringParam(params, "model"),
              language: readStringParam(params, "language"),
            });
            // Mirror onto asset metadata for context across sessions.
            try {
              updateAssetMetadata(comp.id, filename, {
                transcript: result.cues.map((c) => c.text).join(" "),
              });
            } catch {
              /* best-effort */
            }
            const preset = findCaptionPreset(presetId);
            const captionsProps: CaptionsClipProps = {
              presetId: preset.id,
              cues: result.cues,
              sourceAsset: filename,
              lang: result.language,
              x: preset.layout.x,
              y: preset.layout.y,
              width: preset.layout.width,
              height: preset.layout.height,
              opacity: 1,
            };
            // Auto-create captions clip on the first overlay track.
            let track = comp.tracks.find((t) => t.kind === "overlay");
            if (!track) {
              track = store().createTrack({
                compositionId: comp.id,
                kind: "overlay",
                name: "Captions",
              });
            }
            const cues = result.cues;
            const startSec = cues[0]?.start ?? 0;
            const endSec = cues[cues.length - 1]?.end ?? result.duration ?? 5;
            const clip = store().createClip({
              compositionId: comp.id,
              trackId: track.id,
              kind: "captions",
              label: `Captions · ${asset.name}`,
              startSec,
              durationSec: Math.max(0.5, endSec - startSec),
              z: 50,
              props: captionsProps,
            });
            pushUI("select_composition", { id: comp.id });
            pushUI("clip.scrub_to", { id: clip.id });
            return jsonResult({
              clip,
              cueCount: cues.length,
              language: result.language,
              durationSec: result.duration,
            });
          }

          case "captions.set_preset": {
            const id = readStringParam(params, "clip_id", { required: true });
            const presetId = readStringParam(params, "preset_id", { required: true });
            const cur = store().getClip(id);
            if (!cur || cur.kind !== "captions") {
              return jsonResult({ error: "Provide a captions clip_id" });
            }
            const preset = findCaptionPreset(presetId);
            const updated = store().updateClip(id, {
              props: {
                ...cur.props,
                presetId: preset.id,
                x: preset.layout.x,
                y: preset.layout.y,
                width: preset.layout.width,
                height: preset.layout.height,
              } as ClipProps,
            });
            pushUI("clip.scrub_to", { id });
            return jsonResult({ clip: updated, preset });
          }

          case "captions.edit_cue": {
            const id = readStringParam(params, "clip_id", { required: true });
            const cueIndex = readNumberParam(params, "cue_index", { required: true }) as number;
            const text = readStringParam(params, "cue_text", { required: true });
            const cur = store().getClip(id);
            if (!cur || cur.kind !== "captions") {
              return jsonResult({ error: "Provide a captions clip_id" });
            }
            const cues = ((cur.props as CaptionsClipProps).cues ?? []).slice();
            if (cueIndex < 0 || cueIndex >= cues.length) {
              return jsonResult({ error: `cue_index out of range (0..${cues.length - 1})` });
            }
            cues[cueIndex] = { ...cues[cueIndex]!, text };
            const updated = store().updateClip(id, {
              props: { ...cur.props, cues } as ClipProps,
            });
            pushUI("clip.scrub_to", { id });
            return jsonResult({ clip: updated });
          }

          // ── Silence cutter ───────────────────────────────────────

          case "silence.cut": {
            const handle = readStringParam(params, "composition", { required: true });
            const comp = resolveComposition(handle);
            if (!comp) return jsonResult({ error: `Composition ${handle} not found` });
            const clipId = readStringParam(params, "clip_id", { required: true });
            const clip = comp.clips.find((c) => c.id === clipId);
            if (!clip) return jsonResult({ error: `Clip ${clipId} not found` });
            if (clip.kind !== "video" && clip.kind !== "audio") {
              return jsonResult({ error: "silence.cut only works on video or audio clips" });
            }
            const clipProps = clip.props as { src?: string; trimStart?: number };
            const srcRef = clipProps.src ?? "";
            if (!srcRef) return jsonResult({ error: "Clip has no src — upload an asset first" });
            const compAssetsDir = assetsDir(comp.id);
            let srcPath: string | undefined;
            const srcBasename = decodeURIComponent(srcRef.split("/").pop() ?? "");
            for (const c of [
              join(compAssetsDir, srcBasename),
              srcRef.startsWith("/") ? srcRef : undefined,
            ].filter(Boolean) as string[]) {
              if (existsSync(c)) {
                srcPath = c;
                break;
              }
            }
            if (!srcPath) {
              return jsonResult({
                error: `Source file not on disk for src="${srcRef}". Put the asset in the composition's assets dir first.`,
              });
            }
            const thresholdDb = readNumberParam(params, "threshold_db") ?? -35;
            const minSilenceSec = readNumberParam(params, "min_silence_sec") ?? 0.5;
            const ext = extname(srcPath) || ".mp4";
            const outFilename = `silence-cut-${Date.now()}${ext}`;
            const tmpDir = mkdtempSync(join(tmpdir(), `infinibot-silence-`));
            const tmpOut = join(tmpDir, outFilename);
            try {
              const result = await cutSilences(srcPath, tmpOut, {
                thresholdDb,
                minSilenceLen: minSilenceSec,
              });
              const outPath = join(compAssetsDir, outFilename);
              copyFileSync(tmpOut, outPath);
              const newSrc = `/media/assets/${encodeURIComponent(comp.id)}/${encodeURIComponent(outFilename)}`;
              try {
                addAsset(comp.id, {
                  filename: outFilename,
                  name: outFilename,
                  url: newSrc,
                  kind: clip.kind as "video" | "audio",
                  size: 0,
                  uploadedAt: Date.now(),
                  durationSec: result.durationOut,
                });
              } catch {
                /* best-effort */
              }
              const updated = store().updateClip(clipId, {
                durationSec: Math.max(0.05, result.durationOut),
                props: { ...clip.props, src: newSrc, trimStart: 0 } as ClipProps,
              });
              pushUI("clip.scrub_to", { id: clipId });
              return jsonResult({
                clip: updated,
                durationIn: result.durationIn,
                durationOut: result.durationOut,
                silencesCut: result.silences.length,
                newSrc,
              });
            } finally {
              try {
                rmSync(tmpDir, { recursive: true, force: true });
              } catch {
                /* ignore */
              }
            }
          }

          // ── Assets ───────────────────────────────────────────────

          case "asset.list": {
            const handle = readStringParam(params, "composition", { required: true });
            const comp = resolveComposition(handle);
            if (!comp) return jsonResult({ error: `Composition ${handle} not found` });
            return jsonResult({ assets: listAssets(comp.id) });
          }

          case "asset.get": {
            const handle = readStringParam(params, "composition", { required: true });
            const filename = readStringParam(params, "asset_filename", { required: true });
            const comp = resolveComposition(handle);
            if (!comp) return jsonResult({ error: `Composition ${handle} not found` });
            const asset = findAsset(comp.id, filename);
            if (!asset) return jsonResult({ error: `Asset ${filename} not found` });
            return jsonResult({ asset });
          }

          case "asset.update_metadata": {
            const handle = readStringParam(params, "composition", { required: true });
            const filename = readStringParam(params, "asset_filename", { required: true });
            const comp = resolveComposition(handle);
            if (!comp) return jsonResult({ error: `Composition ${handle} not found` });
            const patch = (params.metadata_patch ?? {}) as Partial<AssetMetadata>;
            const asset = updateAssetMetadata(comp.id, filename, patch);
            if (!asset) return jsonResult({ error: `Asset ${filename} not found` });
            pushUI("library.refresh_assets");
            return jsonResult({ asset });
          }

          case "asset.delete": {
            const handle = readStringParam(params, "composition", { required: true });
            const filename = readStringParam(params, "asset_filename", { required: true });
            const comp = resolveComposition(handle);
            if (!comp) return jsonResult({ error: `Composition ${handle} not found` });
            const deleted = removeAssetFile(comp.id, filename);
            if (deleted) pushUI("library.refresh_assets");
            return jsonResult({ deleted });
          }

          // ── Brief (TASK.md) ──────────────────────────────────────

          case "brief.read": {
            const handle = readStringParam(params, "composition", { required: true });
            const comp = resolveComposition(handle);
            if (!comp) return jsonResult({ error: `Composition ${handle} not found` });
            const tp = taskPath(comp.id);
            if (!existsSync(tp)) return jsonResult({ brief: "" });
            return jsonResult({ brief: readFileSync(tp, "utf-8") });
          }

          case "brief.write": {
            const handle = readStringParam(params, "composition", { required: true });
            const comp = resolveComposition(handle);
            if (!comp) return jsonResult({ error: `Composition ${handle} not found` });
            const text = readStringParam(params, "brief_text", { required: true });
            ensureProjectDir(comp.id, comp.name);
            writeFileSync(taskPath(comp.id), text, "utf-8");
            return jsonResult({ ok: true });
          }

          case "brief.append": {
            const handle = readStringParam(params, "composition", { required: true });
            const comp = resolveComposition(handle);
            if (!comp) return jsonResult({ error: `Composition ${handle} not found` });
            const text = readStringParam(params, "brief_text", { required: true });
            ensureProjectDir(comp.id, comp.name);
            const tp = taskPath(comp.id);
            const existing = existsSync(tp) ? readFileSync(tp, "utf-8") : "";
            writeFileSync(tp, existing + (existing.endsWith("\n") ? "" : "\n") + text, "utf-8");
            return jsonResult({ ok: true });
          }

          // ── Library introspection ────────────────────────────────

          case "animation.preset.list": {
            return jsonResult({ presets: ELEMENT_ANIMATION_PRESETS });
          }

          // ── Render ───────────────────────────────────────────────

          case "render.start": {
            const handle = readStringParam(params, "composition", { required: true });
            const comp = resolveComposition(handle);
            if (!comp) return jsonResult({ error: `Composition ${handle} not found` });
            const { startRender } = await loadCompositionRenderModule();
            const job = await startRender({
              compositionId: comp.id,
              fps: readNumberParam(params, "fps"),
              format: (readStringParam(params, "format") as "mp4" | "webm" | undefined) ?? "mp4",
            });
            return jsonResult({
              job: {
                id: job.id,
                status: job.status,
                progress: job.progress,
                frame: job.frame,
                totalFrames: job.totalFrames,
              },
            });
          }

          case "render.status": {
            const id = readStringParam(params, "job_id", { required: true });
            const { getJob: getRenderJob } = await loadCompositionRenderModule();
            const job = getRenderJob(id);
            if (!job) return jsonResult({ error: `Job ${id} not found` });
            return jsonResult({
              job: {
                id: job.id,
                status: job.status,
                progress: job.progress,
                frame: job.frame,
                totalFrames: job.totalFrames,
                outputUrl: job.outputUrl,
                error: job.error,
              },
            });
          }

          case "render.list": {
            return jsonResult({
              jobs: (await loadCompositionRenderModule()).listJobs().map((j) => ({
                id: j.id,
                compositionId: j.compositionId,
                status: j.status,
                progress: j.progress,
                outputUrl: j.outputUrl,
                error: j.error,
              })),
            });
          }

          case "render.cancel": {
            const id = readStringParam(params, "job_id", { required: true });
            const { cancelJob: cancelRenderJob } = await loadCompositionRenderModule();
            return jsonResult({ cancelled: cancelRenderJob(id) });
          }

          case "render.segment": {
            const handle = readStringParam(params, "composition", { required: true });
            const comp = resolveComposition(handle);
            if (!comp) return jsonResult({ error: `Composition ${handle} not found` });
            const segStart = readNumberParam(params, "segment_start_sec") ?? 0;
            const segEnd = readNumberParam(params, "segment_end_sec") ?? comp.durationSec;
            if (segEnd <= segStart) {
              return jsonResult({
                error: `segment_end_sec (${segEnd}) must be > segment_start_sec (${segStart})`,
              });
            }
            // Create a truncated view of the composition: keep clips that overlap
            // [segStart, segEnd], shift their startSec to 0-base within the window,
            // and clamp durations to the segment boundary.
            const segDur = segEnd - segStart;
            const clipsInWindow = comp.clips
              .filter((c) => c.startSec < segEnd && c.startSec + c.durationSec > segStart)
              .map((c) => {
                const clampedStart = Math.max(c.startSec, segStart) - segStart;
                const clampedEnd = Math.min(c.startSec + c.durationSec, segEnd) - segStart;
                return {
                  ...c,
                  startSec: clampedStart,
                  durationSec: Math.max(0.05, clampedEnd - clampedStart),
                };
              });
            const segComp = {
              ...comp,
              durationSec: segDur,
              clips: clipsInWindow,
            };
            // We start a normal render job but pass the segment comp directly.
            // startRender reads from the store, so we temporarily create a
            // standalone job by calling the render pipeline manually.
            const { buildRenderHtml } = await import("../../compositions/render.js");
            // Use the regular startRender but clone the composition in the store temporarily.
            // Simpler: serialize the segment as a new short-lived composition.
            const segSlug = `${comp.slug || comp.id}-seg-${Date.now()}`;
            const segCompRecord = store().create({
              name: `${comp.name} [segment ${segStart.toFixed(1)}–${segEnd.toFixed(1)}s]`,
              slug: segSlug,
              widthPx: comp.widthPx,
              heightPx: comp.heightPx,
              fps: comp.fps,
              durationSec: segDur,
              bgColor: comp.bgColor,
            });
            // Write all the clipped clips into the segment comp.
            let segTrackId: string | null = null;
            const trackMap = new Map<string, string>();
            for (const origTrack of comp.tracks) {
              const segTrack = store().createTrack({
                compositionId: segCompRecord.id,
                kind: origTrack.kind,
                name: origTrack.name,
              });
              trackMap.set(origTrack.id, segTrack.id);
              if (!segTrackId) segTrackId = segTrack.id;
            }
            for (const c of clipsInWindow) {
              const trackId = trackMap.get(c.trackId) ?? segTrackId ?? undefined;
              if (!trackId) continue;
              store().createClip({
                compositionId: segCompRecord.id,
                trackId,
                kind: c.kind,
                label: c.label,
                startSec: c.startSec,
                durationSec: c.durationSec,
                z: c.z,
                props: c.props,
              });
            }
            try {
              const { startRender } = await loadCompositionRenderModule();
              const job = await startRender({
                compositionId: segCompRecord.id,
                fps: readNumberParam(params, "fps"),
                format: (readStringParam(params, "format") as "mp4" | "webm" | undefined) ?? "mp4",
              });
              // Clean up the ephemeral segment composition when done (after a delay).
              void (async () => {
                await new Promise<void>((r) => setTimeout(r, 600_000)); // 10min window
                try {
                  store().delete(segCompRecord.id);
                } catch {
                  /* ignore */
                }
              })();
              return jsonResult({
                job: {
                  id: job.id,
                  status: job.status,
                  progress: job.progress,
                  totalFrames: job.totalFrames,
                },
                segmentCompositionId: segCompRecord.id,
                segmentSec: [segStart, segEnd],
              });
            } catch (e) {
              try {
                store().delete(segCompRecord.id);
              } catch {
                /* ignore */
              }
              throw e;
            }
          }

          // ── Composition blocks (HTML/CSS clip templates) ─────────

          case "block.list": {
            return jsonResult({ blocks: await listBlockDefs() });
          }

          case "block.get": {
            const id = readStringParam(params, "block_id", { required: true });
            const block = await getBlockDef(id);
            if (!block) return jsonResult({ error: `Block ${id} not found` });
            return jsonResult({ block });
          }

          case "block.create": {
            const name = readStringParam(params, "block_name", { required: true });
            const template = readStringParam(params, "block_template", { required: true });
            const block = await createBlockDef({
              id: readStringParam(params, "block_id"),
              name,
              description: readStringParam(params, "block_description"),
              icon: readStringParam(params, "block_icon"),
              durationSec: readNumberParam(params, "block_duration_sec"),
              defaults: (params.block_defaults as Record<string, unknown>) ?? undefined,
              slots:
                (params.block_slots as Array<{ key: string; label?: string; default?: string }>) ??
                undefined,
              template,
              css: readStringParam(params, "block_css"),
            });
            return jsonResult({ block });
          }

          case "block.update": {
            const id = readStringParam(params, "block_id", { required: true });
            const patch: Record<string, unknown> = {};
            if (params.block_name !== undefined) patch.name = params.block_name;
            if (params.block_description !== undefined)
              patch.description = params.block_description;
            if (params.block_icon !== undefined) patch.icon = params.block_icon;
            if (params.block_duration_sec !== undefined)
              patch.durationSec = params.block_duration_sec;
            if (params.block_defaults !== undefined) patch.defaults = params.block_defaults;
            if (params.block_slots !== undefined) patch.slots = params.block_slots;
            if (params.block_template !== undefined) patch.template = params.block_template;
            if (params.block_css !== undefined) patch.css = params.block_css;
            const block = await updateBlockDef(id, patch as Parameters<typeof updateBlockDef>[1]);
            if (!block) return jsonResult({ error: `Block ${id} not found` });
            return jsonResult({ block });
          }

          case "block.delete": {
            const id = readStringParam(params, "block_id", { required: true });
            return jsonResult({ deleted: await deleteBlockDef(id) });
          }

          /**
           * Drop a block clip onto the timeline. Resolves the block by id,
           * applies its defaults + slot overrides, lands on the first
           * overlay track (creates one if needed) at the given start_sec
           * (defaults to playhead-equivalent: 0 if not given).
           */
          case "block.insert": {
            const handle = readStringParam(params, "composition", { required: true });
            const comp = resolveComposition(handle);
            if (!comp) return jsonResult({ error: `Composition ${handle} not found` });
            const blockId = readStringParam(params, "block_id", { required: true });
            const def = await getBlockDef(blockId);
            if (!def) return jsonResult({ error: `Block ${blockId} not found` });
            // Pick / create overlay track
            let track = comp.tracks.find((t) => t.kind === "overlay");
            if (!track) {
              track = store().createTrack({
                compositionId: comp.id,
                kind: "overlay",
                name: "Overlay",
              });
            }
            const slotValues = (params.slot_values as Record<string, string>) ?? {};
            const placement = def.defaultPlacement ?? { x: 5, y: 30, width: 90, height: 40 };
            const props: ClipProps = {
              ...placement,
              blockId: def.id,
              slots: slotValues,
            } as unknown as ClipProps;
            const clip = store().createClip({
              compositionId: comp.id,
              trackId: track.id,
              kind: "block",
              label: def.label,
              startSec: coerceTime(params.start_sec) ?? 0,
              durationSec: coerceTime(params.duration_sec_clip) ?? def.defaultDurationSec,
              z: readNumberParam(params, "z") ?? 10,
              props,
            });
            return jsonResult({ clip, block: def });
          }

          /**
           * Set (or clear) per-element stagger animations on an existing
           * block clip. Reads the clip's current props, merges the stagger
           * spec, and writes back. Pass `stagger_clear: true` to wipe.
           */
          case "block.set_element_stagger": {
            const handle = readStringParam(params, "composition", { required: true });
            const comp = resolveComposition(handle);
            if (!comp) return jsonResult({ error: `Composition ${handle} not found` });
            const clipId = readStringParam(params, "clip_id", { required: true });
            const clip = comp.clips.find((c) => c.id === clipId);
            if (!clip) return jsonResult({ error: `Clip ${clipId} not found` });
            if (clip.kind !== "block") {
              return jsonResult({ error: `Clip ${clipId} is a ${clip.kind} clip, not a block` });
            }
            const currentProps = (clip.props ?? {}) as unknown as Record<string, unknown>;
            let nextProps: Record<string, unknown>;
            if (params.stagger_clear === true) {
              const { elementStagger: _, ...rest } = currentProps;
              void _;
              nextProps = rest;
            } else {
              const stagger: Record<string, unknown> = {
                ...((currentProps.elementStagger as Record<string, unknown>) ?? {}),
              };
              if (params.stagger_preset_id !== undefined)
                stagger.presetId = params.stagger_preset_id;
              if (params.stagger_step_sec !== undefined) stagger.stepSec = params.stagger_step_sec;
              if (params.stagger_start_sec !== undefined)
                stagger.startSec = params.stagger_start_sec;
              if (params.stagger_out_preset_id !== undefined)
                stagger.outPresetId = params.stagger_out_preset_id;
              if (params.stagger_out_step_sec !== undefined)
                stagger.outStepSec = params.stagger_out_step_sec;
              if (params.stagger_per_key !== undefined) stagger.perKey = params.stagger_per_key;
              nextProps = { ...currentProps, elementStagger: stagger };
            }
            const updated = store().updateClip(clipId, {
              props: nextProps as unknown as ClipProps,
            });
            return jsonResult({ clip: updated });
          }

          // ── Hyperframes-aware composition + render ───────────────
          // One-shot orchestration: take a natural-language brief, build
          // (or extend) a Composition with a title overlay, then kick
          // off a render through the phase-2 hyperframes pipeline. The
          // existing JSON-manipulation actions stay — this is a
          // convenience wrapper for "give me a video from this brief"
          // intents.

          case "compose_with_hyperframes": {
            const brief =
              readStringParam(params, "hyperframes_brief") ??
              readStringParam(params, "brief_text") ??
              "";
            const handle = readStringParam(params, "composition");
            const s = store();
            let comp = handle ? resolveComposition(handle) : null;
            if (!comp) {
              const name =
                readStringParam(params, "name") ?? (brief.slice(0, 60) || "Hyperframes scene");
              const newComp = s.create({
                name,
                widthPx: readNumberParam(params, "width_px") ?? 1080,
                heightPx: readNumberParam(params, "height_px") ?? 1920,
                fps: readNumberParam(params, "fps") ?? 30,
                durationSec: readNumberParam(params, "duration_sec") ?? 6,
                bgColor: readStringParam(params, "bg_color") ?? "#050514",
              });
              try {
                ensureProjectDir(newComp.id, newComp.name);
              } catch {
                /* best-effort */
              }
              comp = s.getWithChildren(newComp.id);
            }
            if (!comp) {
              return jsonResult({ error: "failed to resolve or create composition" });
            }
            // Make sure the comp has at least a video + overlay track so
            // the title clip lands somewhere reasonable.
            let overlayTrack = comp.tracks.find((t) => t.kind === "overlay");
            if (!overlayTrack) {
              overlayTrack = s.createTrack({
                compositionId: comp.id,
                kind: "overlay",
                name: "Title",
              });
            }
            // Append a title-card clip if the brief is non-empty.
            if (brief.trim().length > 0) {
              s.createClip({
                compositionId: comp.id,
                trackId: overlayTrack.id,
                kind: "text",
                label: "Brief title",
                startSec: 0.5,
                durationSec: Math.max(3, Math.min(comp.durationSec - 0.5, brief.length * 0.08)),
                z: 10,
                props: {
                  text: brief,
                  fontFamily: "Inter, system-ui, sans-serif",
                  fontSize: 72,
                  fontWeight: 800,
                  color: "#f4f4f5",
                  align: "center",
                  x: 5,
                  y: 38,
                  width: 90,
                  height: 24,
                  opacity: 1,
                  animateIn: { kind: "fade", durationSec: 0.6, easing: "easeOut" },
                  animateOut: { kind: "fade", durationSec: 0.5, easing: "easeIn" },
                },
              });
            }
            const refreshed = s.getWithChildren(comp.id)!;
            const { startRender } = await loadCompositionRenderModule();
            const job = await startRender({
              compositionId: refreshed.id,
              fps: readNumberParam(params, "fps"),
              format: (readStringParam(params, "format") as "mp4" | "webm" | undefined) ?? "mp4",
            });
            pushUI("comp.opened", { id: refreshed.id });
            return jsonResult({
              composition: summarizeComp(refreshed),
              render: {
                id: job.id,
                status: job.status,
                progress: job.progress,
                totalFrames: job.totalFrames,
              },
              note: "Rendered via the hyperframes producer pipeline.",
            });
          }

          case "hyperframes.inspect": {
            const handle = readStringParam(params, "composition", { required: true });
            const comp = resolveComposition(handle);
            if (!comp) return jsonResult({ error: `Composition ${handle} not found` });
            const { compositionToHyperframes } =
              await import("../../compositions/hyperframes-translator.js");
            const { generateHyperframesHtml } = await import("@hyperframes/core");
            const t = compositionToHyperframes(comp);
            const html = generateHyperframesHtml(t.elements, t.totalDuration, t.options);
            return jsonResult({
              compositionId: comp.id,
              elements: t.elements,
              totalDuration: t.totalDuration,
              resolution: t.options.resolution,
              keyframeCount: Object.keys(t.options.keyframes ?? {}).length,
              htmlBytes: html.length,
              htmlHead: html.slice(0, 600),
            });
          }

          // ── Frame snapshot — multimodal grounding ────────────────

          case "frame.snapshot": {
            const handle = readStringParam(params, "composition", { required: true });
            const comp = resolveComposition(handle);
            if (!comp) return jsonResult({ error: `Composition ${handle} not found` });
            const atSec = readNumberParam(params, "at_sec") ?? 0;
            const maxWidth = readNumberParam(params, "max_width");
            const { captureFrame } = await loadCompositionRenderModule();
            const frame = await captureFrame({
              compositionId: comp.id,
              atSec,
              maxWidth,
            });
            return await imageResult({
              label: "video-editor frame.snapshot",
              path: `composition:${comp.id}@${frame.atSec}s`,
              base64: frame.base64,
              mimeType: frame.mime,
              extraText: `Frame at ${frame.atSec}s (${frame.widthPx}×${frame.heightPx}) — composition "${comp.name}"`,
              details: {
                compositionId: comp.id,
                atSec: frame.atSec,
                widthPx: frame.widthPx,
                heightPx: frame.heightPx,
              },
            });
          }

          // ── Transitions ──────────────────────────────────────────

          case "transition.list": {
            const handle = readStringParam(params, "composition", { required: true });
            const comp = resolveComposition(handle);
            if (!comp) return jsonResult({ error: `Composition ${handle} not found` });
            const transitions = readTransitions(comp.meta as Record<string, unknown> | undefined);
            const availableKinds = Object.entries(TRANSITION_LABELS).map(([kind, label]) => ({
              kind,
              label,
              defaultDurationSec: TRANSITION_DEFAULT_DURATIONS[kind as TransitionKind],
            }));
            return jsonResult({ transitions, availableKinds });
          }

          case "transition.add": {
            const handle = readStringParam(params, "composition", { required: true });
            const comp = resolveComposition(handle);
            if (!comp) return jsonResult({ error: `Composition ${handle} not found` });
            const kind = readStringParam(params, "transition_kind", {
              required: true,
            }) as TransitionKind;
            if (!(kind in TRANSITION_DEFAULT_DURATIONS)) {
              return jsonResult({
                error: `Unknown transition_kind "${kind}". Available: ${Object.keys(TRANSITION_DEFAULT_DURATIONS).join(", ")}`,
              });
            }
            const fromClipId = readStringParam(params, "from_clip_id", { required: true });
            const toClipId = readStringParam(params, "to_clip_id", { required: true });
            const existing = readTransitions(comp.meta as Record<string, unknown> | undefined);
            const conflict = existing.find(
              (t) => t.fromClipId === fromClipId && t.toClipId === toClipId,
            );
            if (conflict) {
              return jsonResult({
                error: `A transition already exists between those clips (id: ${conflict.id}). Use transition.update to modify it.`,
              });
            }
            const newTransition: ClipTransition = {
              id: `tr-${randomUUID().slice(0, 8)}`,
              fromClipId,
              toClipId,
              kind,
              durationSec:
                readNumberParam(params, "transition_duration_sec") ??
                TRANSITION_DEFAULT_DURATIONS[kind],
              ease: readStringParam(params, "transition_ease") ?? undefined,
            };
            store().update(comp.id, {
              meta: { ...comp.meta, transitions: [...existing, newTransition] },
            });
            return jsonResult({ transition: newTransition });
          }

          case "transition.update": {
            const handle = readStringParam(params, "composition", { required: true });
            const comp = resolveComposition(handle);
            if (!comp) return jsonResult({ error: `Composition ${handle} not found` });
            const transitionId = readStringParam(params, "transition_id", { required: true });
            const existing = readTransitions(comp.meta as Record<string, unknown> | undefined);
            const idx = existing.findIndex((t) => t.id === transitionId);
            if (idx === -1) return jsonResult({ error: `Transition ${transitionId} not found` });
            const tr = { ...existing[idx]! };
            const newKind = readStringParam(params, "transition_kind");
            if (newKind && newKind in TRANSITION_DEFAULT_DURATIONS) {
              tr.kind = newKind as TransitionKind;
            }
            const dur = readNumberParam(params, "transition_duration_sec");
            if (dur !== undefined && dur > 0) tr.durationSec = dur;
            const ease = readStringParam(params, "transition_ease");
            if (ease !== undefined) tr.ease = ease;
            existing[idx] = tr;
            store().update(comp.id, { meta: { ...comp.meta, transitions: existing } });
            return jsonResult({ transition: tr });
          }

          case "transition.delete": {
            const handle = readStringParam(params, "composition", { required: true });
            const comp = resolveComposition(handle);
            if (!comp) return jsonResult({ error: `Composition ${handle} not found` });
            const transitionId = readStringParam(params, "transition_id", { required: true });
            const existing = readTransitions(comp.meta as Record<string, unknown> | undefined);
            const next = existing.filter((t) => t.id !== transitionId);
            const deleted = next.length < existing.length;
            if (deleted) {
              store().update(comp.id, { meta: { ...comp.meta, transitions: next } });
            }
            return jsonResult({ deleted });
          }

          // ── Effects stack ────────────────────────────────────────

          case "clip.effects.add": {
            const id = readStringParam(params, "clip_id", { required: true });
            const cur = store().getClip(id);
            if (!cur) return jsonResult({ error: `Clip ${id} not found` });
            const kind = readStringParam(params, "effect_kind", {
              required: true,
            }) as ClipEffectKind;
            if (!EFFECT_LABELS[kind]) {
              return jsonResult({
                error: `Unknown effect_kind "${kind}". Available: ${Object.keys(EFFECT_LABELS).join(", ")}`,
              });
            }
            const effect: ClipEffect = {
              id: `fx-${randomUUID().slice(0, 8)}`,
              kind,
              intensity: readNumberParam(params, "effect_intensity") ?? 0.5,
              ...(params.effect_params !== undefined && {
                params: params.effect_params as Record<string, string | number>,
              }),
              enabled: params.effect_enabled !== false,
            };
            const curProps = cur.props as Record<string, unknown>;
            const effects = Array.isArray(curProps.effects)
              ? [...(curProps.effects as ClipEffect[]), effect]
              : [effect];
            const updated = store().updateClip(id, {
              props: { ...cur.props, effects } as ClipProps,
            });
            pushUI("clip.scrub_to", { id });
            return jsonResult({ effect, clip: updated });
          }

          case "clip.effects.update": {
            const id = readStringParam(params, "clip_id", { required: true });
            const effectId = readStringParam(params, "effect_id", { required: true });
            const cur = store().getClip(id);
            if (!cur) return jsonResult({ error: `Clip ${id} not found` });
            const curProps = cur.props as Record<string, unknown>;
            const effects = Array.isArray(curProps.effects)
              ? [...(curProps.effects as ClipEffect[])]
              : [];
            const idx = effects.findIndex((e) => e.id === effectId);
            if (idx === -1) {
              return jsonResult({ error: `Effect ${effectId} not found on clip ${id}` });
            }
            const e = { ...effects[idx]! };
            const newIntensity = readNumberParam(params, "effect_intensity");
            if (newIntensity !== undefined) e.intensity = Math.max(0, Math.min(1, newIntensity));
            if (params.effect_params !== undefined) {
              e.params = params.effect_params as Record<string, string | number>;
            }
            if (params.effect_enabled !== undefined) e.enabled = !!params.effect_enabled;
            effects[idx] = e;
            const updated = store().updateClip(id, {
              props: { ...cur.props, effects } as ClipProps,
            });
            pushUI("clip.scrub_to", { id });
            return jsonResult({ effect: e, clip: updated });
          }

          case "clip.effects.remove": {
            const id = readStringParam(params, "clip_id", { required: true });
            const effectId = readStringParam(params, "effect_id", { required: true });
            const cur = store().getClip(id);
            if (!cur) return jsonResult({ error: `Clip ${id} not found` });
            const curProps = cur.props as Record<string, unknown>;
            const effects = Array.isArray(curProps.effects)
              ? (curProps.effects as ClipEffect[])
              : [];
            const next = effects.filter((e) => e.id !== effectId);
            const deleted = next.length < effects.length;
            if (deleted) {
              store().updateClip(id, { props: { ...cur.props, effects: next } as ClipProps });
              pushUI("clip.scrub_to", { id });
            }
            return jsonResult({ deleted });
          }

          // ── Variables ────────────────────────────────────────────

          case "variables.list": {
            const handle = readStringParam(params, "composition", { required: true });
            const comp = resolveComposition(handle);
            if (!comp) return jsonResult({ error: `Composition ${handle} not found` });
            const meta = (comp.meta ?? {}) as Record<string, unknown>;
            const variables = Array.isArray(meta.variables) ? meta.variables : [];
            const variableValues =
              (meta.variableValues as Record<string, unknown> | undefined) ?? {};
            return jsonResult({ variables, variableValues });
          }

          case "variables.declare": {
            const handle = readStringParam(params, "composition", { required: true });
            const comp = resolveComposition(handle);
            if (!comp) return jsonResult({ error: `Composition ${handle} not found` });
            const varId = readStringParam(params, "variable_id", { required: true });
            if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(varId)) {
              return jsonResult({
                error: `variable_id "${varId}" is invalid — use alphanumeric + underscore only`,
              });
            }
            const varType = readStringParam(params, "variable_type", { required: true });
            const validTypes = ["string", "number", "color", "boolean", "enum"];
            if (!validTypes.includes(varType)) {
              return jsonResult({
                error: `Invalid variable_type "${varType}". Must be one of: ${validTypes.join(", ")}`,
              });
            }
            const meta = { ...((comp.meta ?? {}) as Record<string, unknown>) };
            const variables = Array.isArray(meta.variables)
              ? [...(meta.variables as Record<string, unknown>[])]
              : [];
            const idx = variables.findIndex((v) => (v as Record<string, unknown>).id === varId);
            const decl: Record<string, unknown> = idx >= 0 ? { ...variables[idx] } : { id: varId };
            decl.type = varType;
            if (params.variable_label !== undefined) decl.label = params.variable_label;
            if (params.variable_default !== undefined) decl.default = params.variable_default;
            if (params.variable_min !== undefined) decl.min = params.variable_min;
            if (params.variable_max !== undefined) decl.max = params.variable_max;
            if (params.variable_options !== undefined) decl.options = params.variable_options;
            if (idx >= 0) variables[idx] = decl;
            else variables.push(decl);
            meta.variables = variables;
            store().update(comp.id, { meta });
            return jsonResult({ variable: decl });
          }

          case "variables.set": {
            const handle = readStringParam(params, "composition", { required: true });
            const comp = resolveComposition(handle);
            if (!comp) return jsonResult({ error: `Composition ${handle} not found` });
            const varId = readStringParam(params, "variable_id", { required: true });
            if (params.variable_value === undefined) {
              return jsonResult({ error: "variable_value required" });
            }
            const meta = { ...((comp.meta ?? {}) as Record<string, unknown>) };
            const variableValues = {
              ...((meta.variableValues as Record<string, unknown> | undefined) ?? {}),
            };
            variableValues[varId] = params.variable_value;
            meta.variableValues = variableValues;
            store().update(comp.id, { meta });
            return jsonResult({ variableId: varId, value: params.variable_value });
          }

          case "variables.delete": {
            const handle = readStringParam(params, "composition", { required: true });
            const comp = resolveComposition(handle);
            if (!comp) return jsonResult({ error: `Composition ${handle} not found` });
            const varId = readStringParam(params, "variable_id", { required: true });
            const meta = { ...((comp.meta ?? {}) as Record<string, unknown>) };
            const variables = Array.isArray(meta.variables)
              ? (meta.variables as Record<string, unknown>[])
              : [];
            const next = variables.filter((v) => (v as Record<string, unknown>).id !== varId);
            const deleted = next.length < variables.length;
            meta.variables = next;
            if (meta.variableValues) {
              const vals = { ...(meta.variableValues as Record<string, unknown>) };
              delete vals[varId];
              meta.variableValues = vals;
            }
            if (deleted) store().update(comp.id, { meta });
            return jsonResult({ deleted });
          }

          default:
            return jsonResult({ error: `Unknown action "${action}"` });
        }
      } catch (e) {
        return jsonResult({ error: e instanceof Error ? e.message : String(e) });
      }
    },
  };
}
