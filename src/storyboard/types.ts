/**
 * Storyboard Automation System — Types
 *
 * Full pipeline: Script Generation → Scene Splitting → Image Generation
 */

// ═══════════════════════════════════════════════════════════════
// CORE TYPES
// ═══════════════════════════════════════════════════════════════

export type Platform = "youtube" | "tiktok" | "shorts" | "instagram" | "custom";
export type ProjectStatus =
  | "draft"
  | "scripting"
  | "splitting"
  | "generating"
  | "complete"
  | "failed";
export type SceneStatus = "pending" | "generating" | "complete" | "failed";
/** Built-ins plus plugin media-provider ids. */
export type ImageBackend = "local" | "auto" | (string & {});

// ═══════════════════════════════════════════════════════════════
// EFFECT PRESETS (Remotion-based)
// ═══════════════════════════════════════════════════════════════

export type EffectPreset =
  | "none"
  // Motion effects
  | "ken-burns"
  | "dramatic-push"
  | "parallax"
  | "punch-zoom"
  | "slow-drift"
  // Transitions
  | "pull-back"
  | "spin-reveal"
  // Overlays
  | "glitch"
  | "atmospheric-mist"
  | "cinematic-grain"
  | "light-leak"
  | "dust-particles";

export type EffectCategory = "motion" | "transition" | "overlay";

export interface EffectPresetInfo {
  id: EffectPreset;
  label: string;
  description: string;
  icon: string;
  compositionId: string;
  category: EffectCategory;
}

export const EFFECT_PRESETS: EffectPresetInfo[] = [
  // None
  {
    id: "none",
    label: "None",
    description: "No effect (static or basic FFmpeg)",
    icon: "⏹️",
    compositionId: "",
    category: "motion",
  },

  // ═══ MOTION EFFECTS ═══
  {
    id: "ken-burns",
    label: "Ken Burns",
    description: "Classic documentary zoom & pan",
    icon: "🎬",
    compositionId: "KenBurnsZoom",
    category: "motion",
  },
  {
    id: "dramatic-push",
    label: "Dramatic Push",
    description: "Cinematic forward motion with speed ramp",
    icon: "🚀",
    compositionId: "DramaticPush",
    category: "motion",
  },
  {
    id: "parallax",
    label: "Parallax Drift",
    description: "Subtle side drift with depth",
    icon: "🌊",
    compositionId: "ParallaxDrift",
    category: "motion",
  },
  {
    id: "punch-zoom",
    label: "Punch Zoom",
    description: "Fast impact zoom (TikTok style)",
    icon: "💥",
    compositionId: "PunchZoom",
    category: "motion",
  },
  {
    id: "slow-drift",
    label: "Slow Drift",
    description: "Very subtle constant movement",
    icon: "🍃",
    compositionId: "SlowDrift",
    category: "motion",
  },

  // ═══ TRANSITIONS ═══
  {
    id: "pull-back",
    label: "Pull Back Reveal",
    description: "Start tight, expand outward - great for reveals",
    icon: "🔭",
    compositionId: "PullBackReveal",
    category: "transition",
  },
  {
    id: "spin-reveal",
    label: "Spin Reveal",
    description: "Rotate in with scale - great for intros",
    icon: "🌀",
    compositionId: "SpinReveal",
    category: "transition",
  },

  // ═══ OVERLAYS ═══
  {
    id: "glitch",
    label: "Glitch Flash",
    description: "Cyberpunk style with glitch effects",
    icon: "⚡",
    compositionId: "GlitchFlash",
    category: "overlay",
  },
  {
    id: "atmospheric-mist",
    label: "Atmospheric Mist",
    description: "Dreamy fog with breathing motion",
    icon: "🌫️",
    compositionId: "AtmosphericMist",
    category: "overlay",
  },
  {
    id: "cinematic-grain",
    label: "Cinematic Grain",
    description: "Film grain with teal/orange grade",
    icon: "🎞️",
    compositionId: "CinematicGrain",
    category: "overlay",
  },
  {
    id: "light-leak",
    label: "Light Leak",
    description: "Analog film light leaks and flares",
    icon: "☀️",
    compositionId: "LightLeak",
    category: "overlay",
  },
  {
    id: "dust-particles",
    label: "Dust Particles",
    description: "Floating dust motes with ambient light",
    icon: "✨",
    compositionId: "DustParticles",
    category: "overlay",
  },
];

// Helper to get presets by category
export const MOTION_PRESETS = EFFECT_PRESETS.filter(
  (p) => p.category === "motion" && p.id !== "none",
);
export const TRANSITION_PRESETS = EFFECT_PRESETS.filter((p) => p.category === "transition");
export const OVERLAY_PRESETS = EFFECT_PRESETS.filter((p) => p.category === "overlay");

export interface StoryboardProject {
  id: string;
  name: string;
  prompt: string;
  targetDuration: number; // minutes
  platform: Platform;
  aspectRatio: string; // "16:9", "9:16", "1:1"
  imageStyle: string; // "realistic", "anime", "illustrated", "cinematic"
  imageBackend: ImageBackend;
  language: string; // "en", "th", etc.
  ttsProvider: string; // "kokoro", "edge", "elevenlabs", "openai"
  ttsVoice: string; // Voice ID for the provider
  script?: string;
  scenes: Scene[];
  characters: CharacterRef[];
  status: ProjectStatus;
  error?: string;
  progress: number; // 0-100
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  timelinePrompting?: TimelinePromptingProject;
}

// ═══════════════════════════════════════════════════════════════
// TIMELINE PROMPTING (Phase 8 Addendum)
// ═══════════════════════════════════════════════════════════════

export type StoryboardMode =
  | "projects"
  | "presets"
  | "image"
  | "video"
  | "sequential"
  | "timeline-prompting"
  | "recreate";

export interface TimelineBeat {
  id: string;
  startSec: number;
  endSec: number;
  action: string;
  camera: string;
  audioNotes: string;
  manualOverride: string;
  subjects: string[]; // character slot keys (e.g. "@founder")
  assets: string[]; // asset slot keys (e.g. "@shea-bottle")
  locations: string[]; // location slot keys (e.g. "@kitchen")
  onScreenText?: string;
  transition?: string;
}

export interface TimelinePromptingProject {
  beats: TimelineBeat[];
  totalDurationSec: number;
  characterSlots: Record<string, string | null>;
  assetSlots: Record<string, string | null>;
  locationSlots: Record<string, string | null>;
}

export interface ValidationError {
  beatId?: string;
  field?: string;
  code: "unbound-slot" | "overflow" | "gap-crossing-boundary" | "invalid-range";
  message: string;
}

export interface Scene {
  id: string;
  projectId: string;
  index: number;
  title: string;
  description: string;
  dialogue?: string;
  voiceover?: string;
  durationSeconds: number;
  imagePrompt: string;
  imageUrl?: string;
  thumbnailUrl?: string;
  audioUrl?: string; // Voiceover audio file URL
  imageStatus: SceneStatus;
  imageError?: string;
  effectPreset?: EffectPreset; // Motion/transition effect preset
  overlayPreset?: EffectPreset; // Overlay effect preset (can combine with motion)
  metadata?: Record<string, unknown>;
  timelineBeats?: TimelineBeat[];
}

export interface CharacterRef {
  id: string;
  name: string;
  description: string;
  referenceImageUrl?: string;
  referenceImagePath?: string;
  styleTokens?: string; // For consistency prompts
  color?: string; // UI display color
}

// ═══════════════════════════════════════════════════════════════
// CUSTOM EFFECT PRESETS
// ═══════════════════════════════════════════════════════════════

export type EasingType =
  | "linear"
  | "ease-in"
  | "ease-out"
  | "ease-in-out"
  | "spring"
  | "bounce"
  | "elastic";

export interface EffectParams {
  // Zoom
  zoomStart: number; // 1.0 = 100%
  zoomEnd: number;
  zoomEasing: EasingType;

  // Pan
  panX: number; // -100 to 100 (percentage)
  panY: number;
  panEasing: EasingType;

  // Rotation
  rotationStart: number; // degrees
  rotationEnd: number;
  rotationEasing: EasingType;

  // Effects
  blur: number; // 0-20 px
  vignette: number; // 0-1 opacity
  scanlines: boolean;
  rgbSplit: number; // 0-10 px
  flash: boolean;
  flashFrame: number; // frame to flash on
  shake: number; // 0-10 intensity

  // Timing
  speedRamp: boolean; // ease-in-out timing
  holdStart: number; // frames to hold at start
  holdEnd: number; // frames to hold at end
}

export interface CustomEffectPreset {
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

// ═══════════════════════════════════════════════════════════════
// IMAGE GENERATION
// ═══════════════════════════════════════════════════════════════

export interface ImageGenOptions {
  prompt: string;
  characterRefs?: CharacterRef[];
  style?: string;
  aspectRatio?: string;
  negativePrompt?: string;
  seed?: number;
  steps?: number;
  guidance?: number;
  model?: string; // Specific model ID to use
}

export interface ImageGenResult {
  success: boolean;
  imageUrl?: string;
  thumbnailUrl?: string;
  error?: string;
  backend: ImageBackend;
  duration?: number;
}

export interface ImageGenerator {
  name: string;
  backend: ImageBackend;
  generate(options: ImageGenOptions): Promise<ImageGenResult>;
  isAvailable(): Promise<boolean>;
  supportsCharacterRef: boolean;
  supportsStyleTransfer: boolean;
}

// ═══════════════════════════════════════════════════════════════
// SCRIPT & SCENE GENERATION
// ═══════════════════════════════════════════════════════════════

export interface ScriptExemplar {
  title: string;
  platform: string;
  hook: string;
  excerpt: string;
  structureNotes?: string;
  tags: string[];
}

export interface ScriptGenOptions {
  prompt: string;
  platform: Platform;
  targetDuration: number; // minutes
  style?: string; // "educational", "entertaining", "dramatic", "documentary"
  tone?: string; // "serious", "casual", "humorous", "inspirational"
  includeVoiceover?: boolean;
  /** Optional viral-video exemplars the LLM should imitate in cadence/structure. */
  exemplars?: ScriptExemplar[];
}

export interface ScriptGenResult {
  success: boolean;
  script?: string;
  estimatedDuration?: number;
  error?: string;
}

export interface SceneSplitOptions {
  script: string;
  targetDuration: number; // minutes
  platform: Platform;
  minSceneDuration?: number; // seconds
  maxSceneDuration?: number; // seconds
  characters?: CharacterRef[];
}

export interface SceneSplitResult {
  success: boolean;
  scenes?: Omit<Scene, "id" | "projectId" | "imageUrl" | "thumbnailUrl" | "imageStatus">[];
  error?: string;
}

// ═══════════════════════════════════════════════════════════════
// CRON / AUTOMATION
// ═══════════════════════════════════════════════════════════════

export interface StoryboardCronJob {
  id: string;
  projectId?: string; // Template project to use
  prompt: string;
  platform: Platform;
  targetDuration: number;
  imageBackend: ImageBackend;
  schedule: string; // Cron expression
  enabled: boolean;
  lastRun?: number;
  lastStatus?: "success" | "failed";
  createdAt: number;
}

// ═══════════════════════════════════════════════════════════════
// PLATFORM PRESETS
// ═══════════════════════════════════════════════════════════════

export const PLATFORM_PRESETS: Record<
  Platform,
  {
    label: string;
    aspectRatio: string;
    defaultDuration: number; // minutes
    minDuration: number;
    maxDuration: number;
    sceneDuration: { min: number; max: number }; // seconds
  }
> = {
  youtube: {
    label: "YouTube",
    aspectRatio: "16:9",
    defaultDuration: 10,
    minDuration: 1,
    maxDuration: 60,
    sceneDuration: { min: 3, max: 30 },
  },
  tiktok: {
    label: "TikTok",
    aspectRatio: "9:16",
    defaultDuration: 1,
    minDuration: 0.25,
    maxDuration: 10,
    sceneDuration: { min: 2, max: 10 },
  },
  shorts: {
    label: "YouTube Shorts",
    aspectRatio: "9:16",
    defaultDuration: 1,
    minDuration: 0.25,
    maxDuration: 1,
    sceneDuration: { min: 2, max: 10 },
  },
  instagram: {
    label: "Instagram Reels",
    aspectRatio: "9:16",
    defaultDuration: 1,
    minDuration: 0.25,
    maxDuration: 1.5,
    sceneDuration: { min: 2, max: 10 },
  },
  custom: {
    label: "Custom",
    aspectRatio: "16:9",
    defaultDuration: 5,
    minDuration: 0.25,
    maxDuration: 120,
    sceneDuration: { min: 2, max: 60 },
  },
};

export const IMAGE_STYLES = [
  { id: "cinematic", label: "Cinematic", description: "Film-quality, dramatic lighting" },
  { id: "realistic", label: "Realistic", description: "Photorealistic imagery" },
  { id: "anime", label: "Anime", description: "Japanese animation style" },
  { id: "illustrated", label: "Illustrated", description: "Digital illustration" },
  { id: "3d-render", label: "3D Render", description: "CGI/3D rendered scenes" },
  { id: "watercolor", label: "Watercolor", description: "Soft watercolor painting" },
  { id: "comic", label: "Comic Book", description: "Bold lines, comic panels" },
  { id: "minimalist", label: "Minimalist", description: "Clean, simple visuals" },
];

export const IMAGE_BACKENDS = [
  { id: "auto", label: "Auto (ComfyUI)", description: "Use the local ComfyUI server" },
  { id: "local", label: "ComfyUI", description: "Local ComfyUI server (default port 8899)" },
] as const;
