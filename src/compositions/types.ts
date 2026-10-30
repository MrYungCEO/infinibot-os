/**
 * Composition data model — InfiniBot's native video editor.
 *
 * A `Composition` is the top-level video project: width, height, fps,
 * duration, and a list of Tracks. Each Track holds an ordered list of
 * `Clip`s with timeline placement (`startSec` + `durationSec`). Clip
 * kinds cover the basics — video, image, text overlay, audio, shape, and
 * "block" (preset HTML composition from the block catalog).
 *
 * Clip props are stored as JSON so we can evolve clip shapes without
 * schema migrations. Render code reads `kind` to decide how to interpret
 * props; the UI's properties panel reads the same to know which fields to
 * show.
 */

export type ClipKind =
  | "video"
  | "image"
  | "text"
  | "audio"
  | "shape"
  | "block"
  | "captions"
  | "subcomp"
  | "null";

export type TrackKind = "video" | "overlay" | "audio";

export type EasingName = "linear" | "easeInOut" | "easeOut" | "easeIn" | "spring";

export type AnimationKind =
  | "none"
  | "fade"
  | "slideUp"
  | "slideDown"
  | "slideLeft"
  | "slideRight"
  | "scale"
  | "blur";

export interface ClipAnimation {
  kind: AnimationKind;
  durationSec: number;
  easing: EasingName;
}

/** Common clip props all kinds share. */
export interface ClipBaseProps {
  /** % of canvas — 0..100 */
  x?: number;
  y?: number;
  /** % of canvas */
  width?: number;
  height?: number;
  /** 0..1 */
  opacity?: number;
  /** Degrees, 0..360 */
  rotation?: number;
  animateIn?: ClipAnimation;
  animateOut?: ClipAnimation;
  /**
   * Optional preset id from `ELEMENT_ANIMATION_PRESETS` — when set, the
   * renderer applies the preset's full in/out + continuous emphasis loop
   * instead of the lower-level `animateIn`/`animateOut` triplet. Lets the
   * UI surface a one-click "Pop In" / "Kinetic Title" / "Glitch" / etc.
   * dropdown for any visual clip (text / shape / block / image).
   */
  animationPresetId?: string;
  /**
   * Per-clip custom keyframes layered ON TOP of whatever the preset /
   * animateIn / animateOut emits. Each entry follows `@hyperframes/core`'s
   * `Keyframe` shape — `{ id, time, properties: {x?,y?,opacity?,scale?,
   * scaleX?,scaleY?,rotation?,width?,height?}, ease? }`. `time` is in
   * absolute composition seconds. Authored either by hand in the
   * Keyframes panel or programmatically by the agent via the
   * `clip.keyframes.*` actions on the video editor tool.
   *
   * Deprecated in favour of `keyframeLanes` — keyframeLanes is the
   * structured "After Effects per-property lane" representation; we
   * still read this for back-compat.
   */
  customKeyframes?: Array<{
    id: string;
    time: number;
    properties: Partial<KeyframeNumericProps>;
    ease?: string;
  }>;
  /**
   * After-Effects-style per-property keyframe lanes. Each lane carries
   * a sequence of time→value points for a single animatable property,
   * each point with its own ease. The translator emits one GSAP tween
   * per consecutive pair on the lane, so the keyframe interpolation
   * curves the operator authors render bit-identical to a real AE
   * dope-sheet.
   *
   * `interp` controls how the lane interpolates between the previous
   * keyframe and this one:
   *   - "hold": no interp — value snaps at the keyframe's time
   *   - "linear" | "easeIn" | "easeOut" | "easeInOut": canned curves
   *   - "bezier": custom cubic-bezier with the four control points in
   *     `bezier: [x1, y1, x2, y2]` (CSS cubic-bezier shape)
   */
  keyframeLanes?: ClipKeyframeLane[];
  /**
   * Effects stack — applied as a CSS filter chain at render time, in
   * order. Each entry is `{kind, intensity, params?}`; the translator
   * folds them into a single `filter:` rule per clip + optional SVG
   * overlay (used for grain / vignette).
   *
   * Stack order matters: rendering goes top-of-array first, so a
   * `[blur, brightness]` chain blurs THEN brightens.
   */
  effects?: ClipEffect[];
  /**
   * Parent clip id — when set, this clip's transform (x, y, rotation,
   * scale) inherits from the parent. The translator walks the parent
   * chain at emit time and pre-multiplies; parents propagate but their
   * own visual content stays decoupled (so e.g. a "null" parent has no
   * visual but moves all its children).
   *
   * Cycle protection: if the parent chain loops back to this clip we
   * silently drop the parent link at emit time.
   */
  parentClipId?: string;
}

export type ClipEffectKind =
  | "blur"
  | "glow"
  | "brightness"
  | "contrast"
  | "saturate"
  | "hue"
  | "vignette"
  | "grain"
  | "chromatic"
  | "invert";

export interface ClipEffect {
  id: string;
  kind: ClipEffectKind;
  /** 0..1 — overall strength. Per-kind interpretation in `effects.ts`. */
  intensity: number;
  /** Optional per-kind params — for example `{ color: "#d4a02b" }` on glow. */
  params?: Record<string, string | number>;
  /** Whether the effect is enabled (lets the operator toggle without removing). */
  enabled?: boolean;
}

/** Properties a keyframe lane can target (the GSAP-supported set). */
export interface KeyframeNumericProps {
  x: number;
  y: number;
  opacity: number;
  scale: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  width: number;
  height: number;
}

export type KeyframeProperty = keyof KeyframeNumericProps;
export type KeyframeInterp = "hold" | "linear" | "easeIn" | "easeOut" | "easeInOut" | "bezier";

export interface ClipKeyframePoint {
  /** Stable id. */
  id: string;
  /** Absolute composition seconds. */
  time: number;
  /** Property value at this time. */
  value: number;
  /** How to interpolate FROM the previous keyframe on this lane TO here. */
  interp: KeyframeInterp;
  /** Optional cubic-bezier control points when interp === "bezier". */
  bezier?: [number, number, number, number];
}

export interface ClipKeyframeLane {
  /** Which property this lane drives. */
  property: KeyframeProperty;
  /** Ordered keyframes (by `time`). The translator sorts before emit. */
  points: ClipKeyframePoint[];
}

export interface VideoClipProps extends ClipBaseProps {
  src: string;
  /** Trim-in seconds within the source video. */
  trimStart?: number;
  /** Volume 0..1. */
  volume?: number;
  loop?: boolean;
}

export interface ImageClipProps extends ClipBaseProps {
  src: string;
  /** "cover" | "contain" | "fill" */
  fit?: "cover" | "contain" | "fill";
}

export interface TextClipProps extends ClipBaseProps {
  text: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  color?: string;
  /** Background tint behind the text (CSS color or transparent). */
  background?: string;
  /** "left" | "center" | "right" */
  align?: "left" | "center" | "right";
  /** Letter spacing in em. */
  letterSpacing?: number;
  /** "none" | "outline" | "glow" — quick style preset. */
  effect?: "none" | "outline" | "glow";
  /**
   * Auto-fit: shrink `fontSize` until the text lays out on one line
   * inside the clip's bounding box. Resolved server-side by
   * `fitTextFontSize` from `@hyperframes/core`. `fontSize` becomes the
   * upper bound — we never grow past what the operator authored.
   */
  autoFit?: boolean;
  /** Floor for auto-fit. Defaults to ~35% of `fontSize` when omitted. */
  minFontSize?: number;
  /**
   * After-Effects-style text animators — each animator splits the text
   * into chars/words/lines and applies a per-element transform offset
   * with stagger. Multiple animators stack (additive), so an operator
   * can author "characters fade in from below" + "every other character
   * rotates +5°" by adding two animators.
   */
  animators?: TextAnimator[];
}

export type TextSplitUnit = "char" | "word" | "line";

export interface TextAnimator {
  /** Stable id. */
  id: string;
  /** Human label (shown in the right rail). */
  label?: string;
  /** Split granularity. */
  splitBy: TextSplitUnit;
  /** Per-element stagger in seconds. */
  staggerSec: number;
  /** When the animation starts, relative to the clip's startSec. */
  startSec: number;
  /** Per-element animation duration. */
  durationSec: number;
  /** Curve. Same vocabulary as KeyframeInterp ("hold" excluded). */
  ease?: "linear" | "easeIn" | "easeOut" | "easeInOut" | "back" | "spring";
  /** Range selector — only elements at indices in [startPct, endPct] of
   *  the split list animate. 0..1. */
  rangeStart?: number;
  rangeEnd?: number;
  /** Property offsets — the starting values; the element settles to
   *  zero / identity at `startSec + durationSec`. */
  offset?: Partial<{
    x: number; // px
    y: number; // px
    opacity: number; // 0..1
    scale: number; // 1 = identity
    rotation: number; // degrees
    blur: number; // px (CSS filter blur)
  }>;
}

export interface AudioClipProps extends ClipBaseProps {
  src: string;
  trimStart?: number;
  volume?: number;
  loop?: boolean;
  /** Linear fade in/out in seconds. */
  fadeIn?: number;
  fadeOut?: number;
}

export interface ShapeClipProps extends ClipBaseProps {
  shape: "rect" | "circle" | "line" | "gradient";
  fill?: string;
  /** For gradient: from + to colors, angle in degrees. */
  gradientFrom?: string;
  gradientTo?: string;
  gradientAngle?: number;
  borderColor?: string;
  borderWidth?: number;
  borderRadius?: number;
}

/**
 * Per-child stagger animation for a block clip. The renderer queries the
 * block's mounted DOM for elements carrying `[data-anim-item]` (built-in
 * blocks tag list items / lines / features; agent-authored templates can
 * add the same attribute to mark animatable children).
 *
 * `presetId` references an entry in ELEMENT_ANIMATION_PRESETS — the same
 * library used for whole-clip animations — so authors can pick familiar
 * looks ("rise-fade", "pop-in", "slide-from-right", "kinetic-title").
 *
 * Timing model:
 *   itemStartLocal = startSec + index * stepSec     (or perKey[key].atSec)
 *   itemDuration   = perKey[key].durationSec        (or preset's in/out duration)
 *
 * Both editor preview and Playwright export read the same shape so what
 * the user sees on stage matches the exported MP4 frame-for-frame.
 */
export interface BlockElementStagger {
  /** Element animation preset id for entrance (from ELEMENT_ANIMATION_PRESETS). */
  presetId?: string;
  /** Delay between successive items in seconds. */
  stepSec?: number;
  /** Offset before the first item starts, relative to clip start. */
  startSec?: number;
  /** Optional out-animation preset (defaults to in's preset's `out` triplet). */
  outPresetId?: string;
  /** Optional reverse step for the out-cascade. Defaults to `stepSec`. */
  outStepSec?: number;
  /**
   * Per-element overrides keyed by `data-anim-key` value (e.g. "item1",
   * "feature2"). Lets the agent pin one element to a specific time without
   * disturbing the auto-stagger of the rest.
   */
  perKey?: Record<string, { presetId?: string; atSec?: number; durationSec?: number }>;
}

/**
 * Sub-composition clip — embeds the rendered output of one composition
 * inside another. The referenced composition is materialized via the
 * gateway's `/api/compositions/<id>/preview.html` endpoint (which the
 * hyperframes generator wraps in an iframe at render time), so any edit
 * to the referenced comp ripples into every parent that includes it.
 *
 * `variableValues` are per-instance overrides — they win over the
 * referenced comp's `meta.variableValues`. This is the mechanism for
 * "branded intro" sub-comps that get dropped into many parent videos
 * with different `heroText` / `accentColor` bindings each time.
 */
export interface SubCompClipProps extends ClipBaseProps {
  /** Composition id this clip embeds. */
  referencedCompositionId: string;
  /** Per-instance variable overrides. Keys match `meta.variables[].id`
   *  on the referenced composition. */
  variableValues?: Record<string, string | number | boolean>;
  /** Optional source-comp duration cache (in seconds) for the editor's
   *  timeline pill — refreshed lazily; the gateway is the source of
   *  truth at render time. */
  sourceDurationSec?: number;
  /** Optional source-comp canvas dimensions cache for editor preview. */
  sourceWidthPx?: number;
  sourceHeightPx?: number;
}

/** Block clips render a saved HTML/CSS preset (lower-third, kinetic title, etc). */
export interface BlockClipProps extends ClipBaseProps {
  blockId: string;
  /** Override slots — e.g. text fields the block exposes. */
  slots?: Record<string, string>;
  /** Theme overrides for primary/accent on the block. */
  primary?: string;
  accent?: string;
  /**
   * Typed style overrides per the block's `styleSchema`. Each key matches
   * a field id from the BlockDefinition.styleSchema; values are the
   * user-edited override (CSS color string, font family, number, etc.).
   * Renderer falls back to the block's default for any field absent here.
   */
  style?: Record<string, string | number | boolean>;
  /** Optional preset id from the block's `presets` list — applies a bundle of style values at once. */
  presetId?: string;
  /** Stagger animations applied to child elements tagged `[data-anim-item]`. */
  elementStagger?: BlockElementStagger;
}

/**
 * One caption cue — a span of time with a phrase and optional word-level
 * sub-timing for TikTok / Hormozi / OpusClip-style word-by-word emphasis.
 *
 * `text` is the full phrase that lands on screen for [start, end).
 * `words[]` lets the renderer highlight one word at a time as the playhead
 * crosses each word's timestamp. When `words` is empty the entire phrase
 * is highlighted/animated as a unit (classic broadcast captions).
 */
export interface CaptionWord {
  start: number; // seconds (composition-relative)
  end: number;
  word: string;
  /** Tag the agent or user can set for keyword emphasis ("hot", "money"). */
  emphasis?: boolean;
}
export interface CaptionCue {
  id?: string;
  start: number; // seconds (composition-relative)
  end: number;
  text: string;
  words?: CaptionWord[];
}

/**
 * Captions clip — one clip carries the entire caption track for a section
 * of the composition. Visual style comes from `presetId` (matches one of
 * the entries in CAPTION_PRESETS) plus optional `style` overrides.
 *
 * Source-of-truth lives here on the clip rather than on an asset because
 * captions are first-class timeline objects: trimmable, restyleable,
 * editable per-cue, exportable to WebVTT/SRT.
 */
export interface CaptionsClipProps extends ClipBaseProps {
  /** Active preset id from CAPTION_PRESETS — drives the visual style + animation. */
  presetId?: string;
  /** Per-field style overrides on top of the preset (color, fontSize, etc.). */
  style?: Record<string, string | number | boolean>;
  /** Cue list, sorted by start. */
  cues: CaptionCue[];
  /**
   * Asset filename this caption track was generated from (so the UI can
   * re-run transcription if the source changes).
   */
  sourceAsset?: string;
  /** Locale of the text (BCP-47), e.g. "en", "es-MX". Stored for SRT/VTT export. */
  lang?: string;
  /** Cap rendered lines at this many words per line (preset-overridable). */
  maxWordsPerLine?: number;
}

/**
 * Null clip — invisible control layer used as a parent for other clips.
 * Has the standard `ClipBaseProps` transforms but emits no element at
 * render time. Carries no kind-specific props beyond the base set.
 */
export interface NullClipProps extends ClipBaseProps {
  /** Optional human label shown in the layer list. */
  controlLabel?: string;
}

export type ClipProps =
  | VideoClipProps
  | ImageClipProps
  | TextClipProps
  | AudioClipProps
  | ShapeClipProps
  | BlockClipProps
  | CaptionsClipProps
  | SubCompClipProps
  | NullClipProps;

export interface Clip {
  id: string;
  compositionId: string;
  trackId: string;
  kind: ClipKind;
  /** Optional human label shown on the timeline pill. */
  label?: string;
  startSec: number;
  durationSec: number;
  /** Higher z is rendered above lower z within the same track. */
  z: number;
  props: ClipProps;
  createdAt: number;
  updatedAt: number;
}

export interface Track {
  id: string;
  compositionId: string;
  kind: TrackKind;
  name: string;
  sortOrder: number;
  muted: boolean;
  locked: boolean;
  hidden: boolean;
}

export interface Composition {
  id: string;
  name: string;
  slug: string;
  /** Pixels — output dimensions. */
  widthPx: number;
  heightPx: number;
  fps: number;
  /** Total composition duration. */
  durationSec: number;
  /** CSS background color of the canvas. */
  bgColor: string;
  /** Free metadata for templates / cover image / palette overrides. */
  meta: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface CompositionWithChildren extends Composition {
  tracks: Track[];
  clips: Clip[];
}

/** Block catalog entry — surfaces in the Library panel. */
export interface CompositionBlock {
  id: string;
  name: string;
  description: string;
  /** Lucide icon name in icons.ts. */
  icon: string;
  /** Default duration when dragged onto the timeline. */
  durationSec: number;
  /** Default clip props (with __FORM_ACTION__-style placeholders allowed). */
  defaults: BlockClipProps;
  /** Slot keys the block honours; UI shows inputs for these in the
   *  properties panel. */
  slots: Array<{ key: string; label: string; default?: string }>;
}

/** Template = full-composition seed (tracks + clips). */
export interface CompositionTemplate {
  id: string;
  name: string;
  description: string;
  /** Lucide icon name. */
  icon: string;
  composition: Pick<
    Composition,
    "name" | "widthPx" | "heightPx" | "fps" | "durationSec" | "bgColor"
  >;
  tracks: Array<Pick<Track, "kind" | "name" | "sortOrder">>;
  /** Clips tied to a track by sortOrder index of the tracks array. */
  clips: Array<{
    trackIndex: number;
    kind: ClipKind;
    label?: string;
    startSec: number;
    durationSec: number;
    z: number;
    props: ClipProps;
  }>;
}
