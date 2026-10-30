/**
 * Storyboard Controller — State management for storyboard automation
 */

import type { AppViewState } from "../app-view-state.js";
import type { GatewayBrowserClient } from "../gateway.js";
import { gatewayHttpUrl } from "../gateway-endpoint";

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export type Platform = "youtube" | "tiktok" | "shorts" | "instagram" | "custom";
export type ProjectStatus = "draft" | "scripting" | "splitting" | "generating" | "complete" | "failed";
export type SceneStatus = "pending" | "generating" | "complete" | "failed";
export type ImageBackend = "local" | "auto";

export interface StoryboardProject {
  id: string;
  name: string;
  prompt: string;
  targetDuration: number;
  platform: Platform;
  aspectRatio: string;
  imageStyle: string;
  imageBackend: ImageBackend;
  language: string;
  ttsProvider: string;
  ttsVoice: string;
  script?: string;
  scenes: Scene[];
  characters: CharacterRef[];
  status: ProjectStatus;
  error?: string;
  progress: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  timelinePrompting?: import("../../../../src/storyboard/types.js").TimelinePromptingProject;
}

// Effect presets for Remotion rendering
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
  category: EffectCategory;
}

export const EFFECT_PRESETS: EffectPresetInfo[] = [
  // None
  { id: "none", label: "None", description: "No effect (static)", icon: "⏹️", category: "motion" },
  
  // ═══ MOTION EFFECTS ═══
  { id: "ken-burns", label: "Ken Burns", description: "Classic documentary zoom & pan", icon: "🎬", category: "motion" },
  { id: "dramatic-push", label: "Dramatic Push", description: "Cinematic forward motion", icon: "🚀", category: "motion" },
  { id: "parallax", label: "Parallax Drift", description: "Subtle side drift with depth", icon: "🌊", category: "motion" },
  { id: "punch-zoom", label: "Punch Zoom", description: "Fast impact zoom (TikTok)", icon: "💥", category: "motion" },
  { id: "slow-drift", label: "Slow Drift", description: "Very subtle constant movement", icon: "🍃", category: "motion" },
  
  // ═══ TRANSITIONS ═══
  { id: "pull-back", label: "Pull Back Reveal", description: "Start tight, expand outward", icon: "🔭", category: "transition" },
  { id: "spin-reveal", label: "Spin Reveal", description: "Rotate in with scale", icon: "🌀", category: "transition" },
  
  // ═══ OVERLAYS ═══
  { id: "glitch", label: "Glitch Flash", description: "Cyberpunk glitch effects", icon: "⚡", category: "overlay" },
  { id: "atmospheric-mist", label: "Atmospheric Mist", description: "Dreamy fog with breathing", icon: "🌫️", category: "overlay" },
  { id: "cinematic-grain", label: "Cinematic Grain", description: "Film grain + color grade", icon: "🎞️", category: "overlay" },
  { id: "light-leak", label: "Light Leak", description: "Analog film light flares", icon: "☀️", category: "overlay" },
  { id: "dust-particles", label: "Dust Particles", description: "Floating dust motes", icon: "✨", category: "overlay" },
];

// Helper to get presets by category
export const MOTION_PRESETS = EFFECT_PRESETS.filter(p => p.category === "motion" && p.id !== "none");
export const TRANSITION_PRESETS = EFFECT_PRESETS.filter(p => p.category === "transition");
export const OVERLAY_PRESETS = EFFECT_PRESETS.filter(p => p.category === "overlay");

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
  audioUrl?: string;
  imageStatus: SceneStatus;
  imageError?: string;
  effectPreset?: EffectPreset;
  overlayPreset?: EffectPreset;
}

export interface CharacterRef {
  id: string;
  name: string;
  description: string;
  referenceImageUrl?: string;
  referenceImagePath?: string;
  styleTokens?: string;
  color?: string;
}

export interface ImageBackendInfo {
  name: string;
  backend: ImageBackend;
  supportsCharacterRef: boolean;
  supportsStyleTransfer: boolean;
}

export interface KenBurnsOptions {
  zoomDirection: "in" | "out" | "random";
  zoomAmount: number;
  panDirection: "left" | "right" | "up" | "down" | "random" | "none";
  panAmount: number;
}

export type TtsProvider = "elevenlabs" | "edge" | "kokoro" | "local";

// Enhanced workflow tracking types
export type WorkflowStepStatus = "pending" | "running" | "complete" | "error" | "skipped";

export interface WorkflowStep {
  id: string;
  label: string;
  status: WorkflowStepStatus;
  progress: number;
  startTime?: number;
  endTime?: number;
  error?: string;
}

export interface WorkflowLogEntry {
  timestamp: number;
  level: "info" | "success" | "warning" | "error";
  message: string;
  details?: string;
}

export interface VoiceInfo {
  id: string;
  name: string;
  provider: TtsProvider;
  previewUrl?: string;
  category?: string;
}

export interface StoryboardState {
  projects: StoryboardProject[];
  selectedProjectId: string | null;
  loading: boolean;
  error: string | null;
  availableBackends: ImageBackendInfo[];
  
  // Create dialog
  showCreateDialog: boolean;
  createForm: {
    name: string;
    prompt: string;
    targetDuration: number;
    platform: Platform;
    aspectRatio: string;
    imageStyle: string;
    imageBackend: ImageBackend;
    imageModel: string;
    language: string;
    ttsProvider: string;
    ttsVoice: string;
    // Generation mode (Image / Video / Sequential / Timeline Prompting / Recreate)
    generationMode: "image" | "video" | "sequential" | "timeline-prompting" | "recreate";
    // Character slot bindings (Lead, Supporting, Cameo)
    characterSlotLead: string | null;
    characterSlotSupporting: string | null;
    characterSlotCameo: string | null;
    // Optional asset & location chips
    assetChip: string | null;
    locationChip: string | null;
  };
  
  // Character dialog
  showCharacterDialog: boolean;
  characterForm: {
    name: string;
    description: string;
    referenceImageUrl: string;
    styleTokens: string;
    color: string;
  };
  editingCharacterId: string | null;
  
  // Scene editing
  editingSceneId: string | null;
  
  // Scene Editor Modal
  showSceneEditor: boolean;
  sceneEditorForm: {
    imagePrompt: string;
    voiceover: string;
    durationSeconds: number;
    title: string;
    description: string;
    effectPreset: EffectPreset;
  };
  sceneEditorIndex: number;
  
  // Script editing
  editingScript: boolean;
  scriptDraft: string;
  
  // Pipeline running - Enhanced workflow tracking
  pipelineRunning: boolean;
  pipelineProgress: number;
  pipelineMessage: string;
  pipelineCurrentStep: number;
  pipelineSteps: WorkflowStep[];
  pipelineLog: WorkflowLogEntry[];
  pipelineLogExpanded: boolean;
  pipelineStartTime: number | null;
  pipelineTimeoutId: number | null;
  pipelineStuck: boolean;
  
  // Export dialog
  showExportDialog: boolean;
  exportSettings: {
    fps: number;
    fadeTransition: number;
    kenBurns: KenBurnsOptions;
  };
  exporting: boolean;
  exportResult: { success: boolean; outputPath?: string; error?: string } | null;
  
  // Voice settings
  voices: VoiceInfo[];
  selectedVoiceId: string | null;
  selectedProvider: TtsProvider;
  voiceSettings: {
    stability: number;
    similarityBoost: number;
    speed: number;
  };
  showVoiceDialog: boolean;
  generatingVoiceovers: boolean;
  
  // Voice cloning
  showCloneDialog: boolean;
  cloneForm: {
    name: string;
    description: string;
    audioFiles: string[];
  };
  cloning: boolean;
  
  // Regenerate modal
  showRegenerateModal: boolean;
  regenerateSceneId: string | null;
  regenerateBackend: ImageBackend;
  regenerateModel: string;
  regeneratePrompt: string; // Custom prompt for regeneration
  availableModels: { id: string; name: string; backend: ImageBackend }[];
  regenerating: boolean;
  suggestedPrompts: string[]; // AI-generated prompt suggestions
  loadingSuggestedPrompts: boolean;
  
  // Image preview modal
  showImagePreview: boolean;
  previewSceneId: string | null;
  previewImageUrl: string | null;
  
  // Local API models
  localApiModels: LocalApiModel[];
  localApiAvailable: boolean;
  loadingLocalModels: boolean;
  
  // Character selection
  availableCharacters: { id: string; name: string; slug: string; primaryImage: string | null }[];
  selectedCharacterIds: string[];
  
  // Real-time generation tracking
  generatingSceneIds: Set<string>;
  generationPollInterval: number | null;
  
  // Video preview
  videoPreviewUrl: string | null;
  videoCurrentTime: number;
  videoHoveredSceneIndex: number | null;
  videoDuration: number;
  
  // Slideshow playback
  isPlaying: boolean;
  playbackSceneIndex: number;
  playbackProgress: number;
  playbackIntervalId: number | null;
  playbackAudio: HTMLAudioElement | null;
  playbackMuted: boolean;
  playbackVolume: number; // 0-1
  playbackAudioDuration: number; // Current scene's audio duration
  playbackWaitingForAudio: boolean; // Wait for audio to load duration
  
  // Preview audio (for voiceover timeline clicks)
  previewAudio: HTMLAudioElement | null;
  
  // Voice regeneration
  showVoiceRegenModal: boolean;
  voiceRegenSceneId: string | null;
  selectedKokoroVoice: string;
  regeneratingVoice: boolean;
  availableKokoroVoices: { id: string; name: string; gender: string }[];
  
  // Tab navigation
  activeTab: "scenes" | "script" | "characters" | "settings";
  
  // View mode (projects, preset builder, or one of the Phase 8 generation modes)
  viewMode: "projects" | "presets" | "image" | "video" | "sequential" | "timeline-prompting" | "recreate";

  // Phase 8 addendum — Timeline Prompting per-project beat plan & pre-gen modal
  timelinePlan: import("../../../../src/storyboard/types.js").TimelinePromptingProject | null;
  showPreGenModal: boolean;
  preGenMode: "image" | "video" | "sequential" | "recreate" | null;
  preGenResolvedPrompt: string;
  preGenResolvedRefs: string[];
}

const initialState: StoryboardState = {
  projects: [],
  selectedProjectId: null,
  loading: false,
  error: null,
  availableBackends: [],
  showCreateDialog: false,
  createForm: {
    name: "",
    prompt: "",
    targetDuration: 5,
    platform: "youtube",
    aspectRatio: "16:9",
    imageStyle: "cinematic",
    imageBackend: "local",
    imageModel: "",
    language: "en",
    ttsProvider: "elevenlabs",
    ttsVoice: "",
    generationMode: "sequential",
    characterSlotLead: null,
    characterSlotSupporting: null,
    characterSlotCameo: null,
    assetChip: null,
    locationChip: null,
  },
  showCharacterDialog: false,
  characterForm: {
    name: "",
    description: "",
    referenceImageUrl: "",
    styleTokens: "",
    color: "#a855f7",
  },
  editingCharacterId: null,
  editingSceneId: null,
  
  // Scene Editor Modal
  showSceneEditor: false,
  sceneEditorForm: {
    imagePrompt: "",
    voiceover: "",
    durationSeconds: 5,
    title: "",
    description: "",
    effectPreset: "none",
  },
  sceneEditorIndex: 0,
  
  // Script editing
  editingScript: false,
  scriptDraft: "",
  
  pipelineRunning: false,
  pipelineProgress: 0,
  pipelineMessage: "",
  pipelineCurrentStep: 0,
  pipelineSteps: [],
  pipelineLog: [],
  pipelineLogExpanded: false,
  pipelineStartTime: null,
  pipelineTimeoutId: null,
  pipelineStuck: false,
  showExportDialog: false,
  exportSettings: {
    fps: 30,
    fadeTransition: 0.3,
    kenBurns: {
      zoomDirection: "random",
      zoomAmount: 1.08,
      panDirection: "random",
      panAmount: 30,
    },
  },
  exporting: false,
  exportResult: null,
  
  // Voice settings
  voices: [],
  selectedVoiceId: "af_nova", // Kokoro default voice
  selectedProvider: "kokoro",
  voiceSettings: {
    stability: 0.5,
    similarityBoost: 0.75,
    speed: 1.0,
  },
  showVoiceDialog: false,
  generatingVoiceovers: false,
  
  // Voice cloning
  showCloneDialog: false,
  cloneForm: {
    name: "",
    description: "",
    audioFiles: [],
  },
  cloning: false,
  
  // Regenerate modal
  showRegenerateModal: false,
  regenerateSceneId: null,
  regenerateBackend: "local",
  regenerateModel: "gemini-2.0-flash-preview-image-generation",
  regeneratePrompt: "", // Custom prompt, populated from scene's imagePrompt
  availableModels: [
    // ComfyUI models are populated dynamically via fetchLocalApiModels().
  ],
  regenerating: false,
  suggestedPrompts: [],
  loadingSuggestedPrompts: false,
  
  // Image preview modal
  showImagePreview: false,
  previewSceneId: null,
  previewImageUrl: null,
  
  // Local API models
  localApiModels: [],
  localApiAvailable: false,
  loadingLocalModels: false,
  
  // Character selection
  availableCharacters: [],
  selectedCharacterIds: [],
  
  // Real-time generation tracking
  generatingSceneIds: new Set<string>(),
  generationPollInterval: null,
  
  // Video preview
  videoPreviewUrl: null,
  videoCurrentTime: 0,
  videoHoveredSceneIndex: null,
  videoDuration: 0,
  
  // Slideshow playback
  isPlaying: false,
  playbackSceneIndex: 0,
  playbackProgress: 0,
  playbackIntervalId: null,
  playbackAudio: null,
  playbackMuted: false,
  playbackVolume: 0.8, // Default 80% volume
  playbackAudioDuration: 0, // Duration of current audio
  playbackWaitingForAudio: false,
  previewAudio: null,
  
  // Voice regeneration
  showVoiceRegenModal: false,
  voiceRegenSceneId: null,
  selectedKokoroVoice: "am_adam",
  regeneratingVoice: false,
  availableKokoroVoices: [
    { id: "am_adam", name: "Adam", gender: "Male" },
    { id: "am_michael", name: "Michael", gender: "Male" },
    { id: "af_bella", name: "Bella", gender: "Female" },
    { id: "af_nicole", name: "Nicole", gender: "Female" },
    { id: "af_sarah", name: "Sarah", gender: "Female" },
    { id: "af_nova", name: "Nova", gender: "Female" },
  ],
  
  // Tab navigation
  activeTab: "scenes",
  
  // View mode
  viewMode: "projects",

  // Timeline Prompting (Phase 8 addendum)
  timelinePlan: null,
  showPreGenModal: false,
  preGenMode: null,
  preGenResolvedPrompt: "",
  preGenResolvedRefs: [],
};

// ═══════════════════════════════════════════════════════════════
// TIMELINE PROMPTING (Phase 8 addendum)
// ═══════════════════════════════════════════════════════════════

export function setStoryboardMode(state: AppViewState, mode: StoryboardState["viewMode"]): void {
  const sb = getStoryboardState(state);
  sb.viewMode = mode;
  state.requestUpdate?.();
}

export function setTimelinePlan(
  state: AppViewState,
  plan: import("../../../../src/storyboard/types.js").TimelinePromptingProject | null
): void {
  const sb = getStoryboardState(state);
  sb.timelinePlan = plan;
  state.requestUpdate?.();
}

export function openPreGenModal(
  state: AppViewState,
  mode: "image" | "video" | "sequential" | "recreate",
  prompt: string,
  refs: string[]
): void {
  const sb = getStoryboardState(state);
  sb.showPreGenModal = true;
  sb.preGenMode = mode;
  sb.preGenResolvedPrompt = prompt;
  sb.preGenResolvedRefs = refs;
  state.requestUpdate?.();
}

export function closePreGenModal(state: AppViewState): void {
  const sb = getStoryboardState(state);
  sb.showPreGenModal = false;
  sb.preGenMode = null;
  state.requestUpdate?.();
}

// Toggle preset builder view
export function togglePresetBuilder(state: AppViewState): void {
  const sb = getStoryboardState(state);
  sb.viewMode = sb.viewMode === "presets" ? "projects" : "presets";
  state.requestUpdate?.();
}

// Set generation mode for create dialog
export function setCreateGenerationMode(
  state: AppViewState,
  mode: "image" | "video" | "sequential" | "timeline-prompting" | "recreate"
): void {
  const sb = getStoryboardState(state);
  sb.createForm.generationMode = mode;
  state.requestUpdate?.();
}

// Bind a character to a slot (lead, supporting, cameo)
export function bindCharacterSlot(
  state: AppViewState,
  slot: "lead" | "supporting" | "cameo",
  charName: string | null
): void {
  const sb = getStoryboardState(state);
  const field = slot === "lead" ? "characterSlotLead"
    : slot === "supporting" ? "characterSlotSupporting"
    : "characterSlotCameo";
  (sb.createForm as any)[field] = charName;
  state.requestUpdate?.();
}

// Get all bound character names from slots (non-null)
export function getBoundSlotCharacters(state: AppViewState): string[] {
  const sb = getStoryboardState(state);
  const names: string[] = [];
  if (sb.createForm.characterSlotLead) names.push(sb.createForm.characterSlotLead);
  if (sb.createForm.characterSlotSupporting) names.push(sb.createForm.characterSlotSupporting);
  if (sb.createForm.characterSlotCameo) names.push(sb.createForm.characterSlotCameo);
  return names;
}

// Set asset chip name
export function setAssetChip(state: AppViewState, name: string | null): void {
  const sb = getStoryboardState(state);
  sb.createForm.assetChip = name;
  state.requestUpdate?.();
}

// Set location chip name
export function setLocationChip(state: AppViewState, name: string | null): void {
  const sb = getStoryboardState(state);
  sb.createForm.locationChip = name;
  state.requestUpdate?.();
}

// ═══════════════════════════════════════════════════════════════
// STATE ACCESS
// ═══════════════════════════════════════════════════════════════

export function getStoryboardState(state: AppViewState): StoryboardState {
  if (!state._storyboard) {
    state._storyboard = { ...initialState };
  }
  return state._storyboard as StoryboardState;
}

export function getSelectedProject(state: AppViewState): StoryboardProject | null {
  const sb = getStoryboardState(state);
  if (!sb.selectedProjectId) return null;
  return sb.projects.find(p => p.id === sb.selectedProjectId) || null;
}

// ═══════════════════════════════════════════════════════════════
// WORKFLOW TRACKING HELPERS
// ═══════════════════════════════════════════════════════════════

const WORKFLOW_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes default timeout
const STUCK_CHECK_INTERVAL_MS = 30 * 1000; // Check every 30 seconds

/** Initialize workflow steps for a pipeline run */
export function initWorkflowSteps(
  state: AppViewState, 
  steps: { id: string; label: string }[]
): void {
  const sb = getStoryboardState(state);
  sb.pipelineSteps = steps.map(s => ({
    ...s,
    status: "pending" as WorkflowStepStatus,
    progress: 0,
  }));
  sb.pipelineCurrentStep = 0;
  sb.pipelineLog = [];
  sb.pipelineStartTime = Date.now();
  sb.pipelineStuck = false;
  state.requestUpdate?.();
}

/** Add a log entry */
export function addWorkflowLog(
  state: AppViewState,
  level: WorkflowLogEntry["level"],
  message: string,
  details?: string
): void {
  const sb = getStoryboardState(state);
  sb.pipelineLog.push({
    timestamp: Date.now(),
    level,
    message,
    details,
  });
  // Keep only last 100 entries
  if (sb.pipelineLog.length > 100) {
    sb.pipelineLog = sb.pipelineLog.slice(-100);
  }
  state.requestUpdate?.();
}

/** Toggle log panel expansion */
export function toggleWorkflowLog(state: AppViewState): void {
  const sb = getStoryboardState(state);
  sb.pipelineLogExpanded = !sb.pipelineLogExpanded;
  state.requestUpdate?.();
}

/** Update step status */
export function updateWorkflowStep(
  state: AppViewState,
  stepId: string,
  updates: Partial<WorkflowStep>
): void {
  const sb = getStoryboardState(state);
  const step = sb.pipelineSteps.find(s => s.id === stepId);
  if (step) {
    Object.assign(step, updates);
    if (updates.status === "running" && !step.startTime) {
      step.startTime = Date.now();
    }
    if (updates.status === "complete" || updates.status === "error") {
      step.endTime = Date.now();
    }
  }
  state.requestUpdate?.();
}

/** Start workflow timeout detection */
export function startWorkflowTimeout(state: AppViewState, timeoutMs = WORKFLOW_TIMEOUT_MS): void {
  const sb = getStoryboardState(state);
  
  // Clear any existing timeout
  if (sb.pipelineTimeoutId !== null) {
    window.clearTimeout(sb.pipelineTimeoutId);
  }
  
  sb.pipelineTimeoutId = window.setTimeout(() => {
    if (sb.pipelineRunning) {
      sb.pipelineStuck = true;
      addWorkflowLog(state, "warning", "Workflow appears stuck", 
        `No progress for ${Math.round(timeoutMs / 1000)}s. You can cancel and retry.`);
      state.requestUpdate?.();
    }
  }, timeoutMs);
}

/** Reset stuck status when progress is made */
export function resetWorkflowStuck(state: AppViewState): void {
  const sb = getStoryboardState(state);
  sb.pipelineStuck = false;
  // Reset timeout
  startWorkflowTimeout(state);
}

/** Clean up workflow state */
export function cleanupWorkflow(state: AppViewState): void {
  const sb = getStoryboardState(state);
  if (sb.pipelineTimeoutId !== null) {
    window.clearTimeout(sb.pipelineTimeoutId);
    sb.pipelineTimeoutId = null;
  }
  sb.pipelineRunning = false;
  sb.pipelineStartTime = null;
  state.requestUpdate?.();
}

/** Cancel a stuck workflow */
export function cancelWorkflow(state: AppViewState): void {
  const sb = getStoryboardState(state);
  addWorkflowLog(state, "warning", "Workflow cancelled by user");
  cleanupWorkflow(state);
  
  // Mark current step as error
  const currentStep = sb.pipelineSteps[sb.pipelineCurrentStep];
  if (currentStep && currentStep.status === "running") {
    currentStep.status = "error";
    currentStep.error = "Cancelled";
    currentStep.endTime = Date.now();
  }
  state.requestUpdate?.();
}

/** Get elapsed time for current workflow */
export function getWorkflowElapsed(state: AppViewState): number {
  const sb = getStoryboardState(state);
  if (!sb.pipelineStartTime) return 0;
  return Date.now() - sb.pipelineStartTime;
}

// ═══════════════════════════════════════════════════════════════
// TAB NAVIGATION
// ═══════════════════════════════════════════════════════════════

export function setActiveTab(
  state: AppViewState,
  tab: "scenes" | "script" | "characters" | "settings"
): void {
  const sb = getStoryboardState(state);
  sb.activeTab = tab;
  state.requestUpdate?.();
}

// ═══════════════════════════════════════════════════════════════
// DATA LOADING
// ═══════════════════════════════════════════════════════════════

export async function loadProjects(
  state: AppViewState,
  client: GatewayBrowserClient
): Promise<void> {
  const sb = getStoryboardState(state);
  sb.loading = true;
  sb.error = null;
  state.requestUpdate?.();
  
  try {
    const [projectsRes, backendsRes] = await Promise.all([
      client.call("storyboard.list", {}),
      client.call("storyboard.backends", {}),
    ]);
    
    sb.projects = (projectsRes as any).projects || [];
    sb.availableBackends = (backendsRes as any).available || [];
    sb.loading = false;
  } catch (err) {
    sb.error = err instanceof Error ? err.message : String(err);
    sb.loading = false;
  }
  
  state.requestUpdate?.();
}

export async function refreshProject(
  state: AppViewState,
  client: GatewayBrowserClient,
  projectId: string
): Promise<void> {
  try {
    const res = await client.call("storyboard.get", { id: projectId });
    const project = (res as any).project;
    
    const sb = getStoryboardState(state);
    const idx = sb.projects.findIndex(p => p.id === projectId);
    if (idx >= 0) {
      sb.projects[idx] = project;
    } else {
      sb.projects.unshift(project);
    }
    state.requestUpdate?.();
  } catch (err) {
    console.error("Failed to refresh project:", err);
  }
}

// ═══════════════════════════════════════════════════════════════
// PROJECT OPERATIONS
// ═══════════════════════════════════════════════════════════════

export function selectProject(state: AppViewState, projectId: string | null): void {
  const sb = getStoryboardState(state);
  sb.selectedProjectId = projectId;
  sb.editingSceneId = null;
  state.requestUpdate?.();
}

export function openCreateDialog(state: AppViewState, client?: GatewayBrowserClient): void {
  const sb = getStoryboardState(state);
  sb.showCreateDialog = true;
  sb.selectedCharacterIds = []; // Reset character selection
  sb.createForm = {
    name: "",
    prompt: "",
    targetDuration: 5,
    platform: "youtube",
    aspectRatio: "16:9",
    imageStyle: "cinematic",
    imageBackend: "local",
    imageModel: "",
    language: "en",
    ttsProvider: "elevenlabs",
    ttsVoice: "",
  };
  // Discover local ComfyUI models via the gateway (CORS-safe).
  fetchLocalApiModels(state, client);
  // Refresh characters from shared state (in case new ones were added)
  if (client) {
    refreshCharactersFromSharedState(state, client);
  }
  state.requestUpdate?.();
}

// Refresh characters from the shared CharactersState (characters controller)
// This ensures both storyboard and sidebar stay in sync
async function refreshCharactersFromSharedState(
  state: AppViewState,
  client: GatewayBrowserClient
): Promise<void> {
  // Import dynamically to avoid circular deps
  const { loadCharacters } = await import("./characters.js");
  await loadCharacters(state, client);
  state.requestUpdate?.();
}

// Fetch available characters from the library
export async function fetchAvailableCharacters(
  state: AppViewState,
  client: GatewayBrowserClient
): Promise<void> {
  const sb = getStoryboardState(state);
  
  try {
    const res = await client.call("characters.list", {});
    const characters = (res as any).characters || [];
    sb.availableCharacters = characters.map((c: any) => {
      // Convert local file path to HTTP URL
      // e.g., "C:\\Users\\you\\.infinibot\\characters\\sf-bear\\reference_001.jpg"
      //    -> "/media/characters/sf-bear/reference_001.jpg"
      let primaryImage: string | null = null;
      if (c.primaryImage) {
        // Extract just the filename from the full path
        const filename = c.primaryImage.split(/[\\/]/).pop() || "reference_001.jpg";
        primaryImage = gatewayHttpUrl(`/media/characters/${c.slug}/${filename}`);
      }
      return {
        id: c.id,
        name: c.name,
        slug: c.slug,
        primaryImage,
      };
    });
  } catch (err) {
    // Characters not available, that's ok
    console.error("[Storyboard] Failed to fetch characters:", err);
    sb.availableCharacters = [];
  }
  
  state.requestUpdate?.();
}

// Toggle character selection
export function toggleCharacterSelection(state: AppViewState, characterId: string): void {
  const sb = getStoryboardState(state);
  const idx = sb.selectedCharacterIds.indexOf(characterId);
  if (idx >= 0) {
    sb.selectedCharacterIds.splice(idx, 1);
  } else {
    sb.selectedCharacterIds.push(characterId);
  }
  state.requestUpdate?.();
}

/**
 * Discover available checkpoints from the local ComfyUI install.
 *
 * The dashboard origin can't talk to ComfyUI directly — ComfyUI Desktop
 * doesn't ship CORS headers, so cross-origin browser fetches get
 * blocked. We proxy through the gateway's `storyboard.models` method,
 * which makes the call server-side and returns the checkpoint list.
 */
export async function fetchLocalApiModels(
  state: AppViewState,
  client?: GatewayBrowserClient,
): Promise<void> {
  const sb = getStoryboardState(state);
  sb.loadingLocalModels = true;
  state.requestUpdate?.();

  // Resolve the client from state if the caller didn't pass one.
  const c = client ?? (state as unknown as { client?: GatewayBrowserClient }).client;
  if (!c) {
    sb.loadingLocalModels = false;
    state.requestUpdate?.();
    return;
  }

  try {
    const res = (await c.request("storyboard.models", {})) as {
      available?: boolean;
      checkpoints?: string[];
    };
    const checkpoints = Array.isArray(res?.checkpoints) ? res.checkpoints : [];
    sb.localApiAvailable = !!res?.available && checkpoints.length > 0;
    sb.localApiModels = checkpoints.map((name) => ({
      id: name,
      name: prettifyCheckpointName(name),
      type: "checkpoint",
      description: "",
      supports_img2img: true,
      supports_inpaint: false,
      vram_gb: 0,
    }));

    // Mirror into availableModels so the regenerate modal sees them.
    sb.availableModels = [
      ...sb.availableModels.filter((m) => m.backend !== "local"),
      ...sb.localApiModels.map((m) => ({
        id: m.id,
        name: m.name,
        backend: "local" as ImageBackend,
      })),
    ];
  } catch (err) {
    console.warn("[storyboard] storyboard.models failed:", err);
    sb.localApiAvailable = false;
    sb.localApiModels = [];
  }

  sb.loadingLocalModels = false;
  state.requestUpdate?.();
}

/** Strip extension + replace separators so checkpoint filenames render cleanly. */
function prettifyCheckpointName(filename: string): string {
  return filename.replace(/\.(safetensors|ckpt|sft)$/i, "").replace(/[_/]+/g, " ");
}

export function closeCreateDialog(state: AppViewState): void {
  const sb = getStoryboardState(state);
  sb.showCreateDialog = false;
  state.requestUpdate?.();
}

export function updateCreateForm(
  state: AppViewState,
  field: keyof StoryboardState["createForm"],
  value: any
): void {
  const sb = getStoryboardState(state);
  (sb.createForm as any)[field] = value;
  
  // Auto-update aspect ratio based on platform
  if (field === "platform") {
    const platform = PLATFORM_OPTIONS.find(p => p.id === value);
    if (platform) {
      sb.createForm.aspectRatio = platform.aspectRatio;
    }
  }
  
  // Auto-update backend when model changes
  if (field === "imageModel") {
    const model = MODEL_OPTIONS.find(m => m.id === value);
    if (model) {
      sb.createForm.imageBackend = model.backend as ImageBackend;
    }
  }
  
  // Auto-select first model when backend changes
  if (field === "imageBackend") {
    const backend = value as ImageBackend;
    if (backend !== "auto") {
      const firstModel = MODEL_OPTIONS.find(m => m.backend === backend);
      if (firstModel) {
        sb.createForm.imageModel = firstModel.id;
      }
    }
  }
  
  // Auto-select TTS provider and voice when language changes
  if (field === "language") {
    const lang = value as string;
    if (lang === "th") {
      // Thai: use Edge TTS (free Thai voices)
      sb.createForm.ttsProvider = "edge";
      sb.createForm.ttsVoice = "th-TH-PremwadeeNeural";
    } else {
      // English: use ElevenLabs
      sb.createForm.ttsProvider = "elevenlabs";
      sb.createForm.ttsVoice = "";
    }
  }
  
  state.requestUpdate?.();
}

export async function createProject(
  state: AppViewState,
  client: GatewayBrowserClient
): Promise<boolean> {
  const sb = getStoryboardState(state);
  
  try {
    // Build character list from selected IDs using the shared CharactersState
    const selectedCharacters: { name: string; description: string; referenceImageUrl?: string; styleTokens?: string }[] = [];
    
    // Import shared state dynamically to avoid circular deps
    const { getCharactersState: getSharedCharsState, getImageUrl } = await import("./characters.js");
    const cs = getSharedCharsState(state);
    
    for (const charId of sb.selectedCharacterIds) {
      // Find in shared CharactersState
      const basicChar = cs.characters.find(c => c.id === charId);
      if (!basicChar) continue;
      
      // Fetch full character details for image paths
      try {
        const res = await client.call("characters.get", { id: charId });
        const char = (res as any).character;
        if (char) {
          // Get primary image path
          const primaryImg = char.images?.find((i: any) => i.isPrimary) || char.images?.[0];
          const imgPath = primaryImg?.path;
          
          selectedCharacters.push({
            name: char.name,
            description: char.description || `Character: ${char.name}`,
            referenceImageUrl: imgPath 
              ? getImageUrl(imgPath, char.slug)
              : undefined,
            styleTokens: Array.isArray(char.tags) ? char.tags.join(", ") : undefined,
          });
        }
      } catch (e) {
        console.warn("[Storyboard] Failed to fetch character:", charId, e);
        // Fallback to basic data from shared state
        selectedCharacters.push({
          name: basicChar.name,
          description: `Character: ${basicChar.name}`,
          referenceImageUrl: basicChar.primaryImage 
            ? getImageUrl(basicChar.primaryImage, basicChar.slug)
            : undefined,
        });
      }
    }
    
    console.log("[Storyboard] Creating project with characters:", selectedCharacters);
    
    // Auto-generate name if not provided
    let projectName = sb.createForm.name.trim();
    if (!projectName) {
      // Generate name from prompt (first 30 chars) + timestamp
      const promptPreview = sb.createForm.prompt.slice(0, 30).trim();
      const timestamp = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      projectName = promptPreview 
        ? `${promptPreview}${promptPreview.length >= 30 ? '...' : ''}`
        : `Project ${timestamp}`;
    }
    
    const res = await client.call("storyboard.create", {
      ...sb.createForm,
      name: projectName,
      characters: selectedCharacters,
      metadata: {
        generationMode: sb.createForm.generationMode,
        characterSlots: {
          lead: sb.createForm.characterSlotLead,
          supporting: sb.createForm.characterSlotSupporting,
          cameo: sb.createForm.characterSlotCameo,
        },
        assetChip: sb.createForm.assetChip,
        locationChip: sb.createForm.locationChip,
        promptAtCreate: sb.createForm.prompt,
      },
    });
    const project = (res as any).project;
    sb.projects.unshift(project);
    sb.selectedProjectId = project.id;
    sb.showCreateDialog = false;
    sb.selectedCharacterIds = []; // Reset selection
    state.requestUpdate?.();
    return true;
  } catch (err) {
    sb.error = err instanceof Error ? err.message : String(err);
    state.requestUpdate?.();
    return false;
  }
}

export async function deleteProject(
  state: AppViewState,
  client: GatewayBrowserClient,
  projectId: string
): Promise<boolean> {
  const sb = getStoryboardState(state);
  
  try {
    await client.call("storyboard.delete", { id: projectId });
    sb.projects = sb.projects.filter(p => p.id !== projectId);
    if (sb.selectedProjectId === projectId) {
      sb.selectedProjectId = null;
    }
    state.requestUpdate?.();
    return true;
  } catch (err) {
    sb.error = err instanceof Error ? err.message : String(err);
    state.requestUpdate?.();
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// SCRIPT EDITING
// ═══════════════════════════════════════════════════════════════

export function startEditingScript(state: AppViewState, currentScript: string): void {
  const sb = getStoryboardState(state);
  sb.editingScript = true;
  sb.scriptDraft = currentScript;
  state.requestUpdate?.();
}

export function cancelEditingScript(state: AppViewState): void {
  const sb = getStoryboardState(state);
  sb.editingScript = false;
  sb.scriptDraft = "";
  state.requestUpdate?.();
}

export function updateScriptDraft(state: AppViewState, script: string): void {
  const sb = getStoryboardState(state);
  sb.scriptDraft = script;
  // Don't call requestUpdate here - it's called on every keystroke
}

export async function saveScript(
  state: AppViewState,
  client: GatewayBrowserClient,
  projectId: string
): Promise<boolean> {
  const sb = getStoryboardState(state);
  
  try {
    await client.call("storyboard.update", { 
      id: projectId, 
      script: sb.scriptDraft 
    });
    
    await refreshProject(state, client, projectId);
    sb.editingScript = false;
    sb.scriptDraft = "";
    state.requestUpdate?.();
    return true;
  } catch (err) {
    sb.error = err instanceof Error ? err.message : String(err);
    state.requestUpdate?.();
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// STEP-BY-STEP WORKFLOW
// ═══════════════════════════════════════════════════════════════

/**
 * Step 1: Generate script only (no scene splitting or image generation)
 */
export async function generateScriptOnly(
  state: AppViewState,
  client: GatewayBrowserClient,
  projectId: string
): Promise<boolean> {
  const sb = getStoryboardState(state);
  
  // Initialize workflow tracking
  initWorkflowSteps(state, [
    { id: "script", label: "Generate Script" },
  ]);
  
  sb.pipelineRunning = true;
  sb.pipelineMessage = "Generating script...";
  
  updateWorkflowStep(state, "script", { status: "running", progress: 10 });
  addWorkflowLog(state, "info", "Starting script generation...");
  startWorkflowTimeout(state, 3 * 60 * 1000); // 3 min timeout
  state.requestUpdate?.();
  
  try {
    updateWorkflowStep(state, "script", { progress: 30 });
    addWorkflowLog(state, "info", "Calling AI to generate script");
    
    const res = await client.call("storyboard.generateScript", { id: projectId });
    
    updateWorkflowStep(state, "script", { progress: 80 });
    addWorkflowLog(state, "info", "Refreshing project data...");
    
    await refreshProject(state, client, projectId);
    
    const success = (res as any).success;
    if (success) {
      updateWorkflowStep(state, "script", { status: "complete", progress: 100 });
      addWorkflowLog(state, "success", "Script generated successfully!");
      sb.pipelineMessage = "Script generated!";
    } else {
      updateWorkflowStep(state, "script", { status: "error", error: (res as any).error || "Failed" });
      addWorkflowLog(state, "error", "Script generation failed", (res as any).error);
      sb.pipelineMessage = (res as any).error || "Failed";
    }
    
    cleanupWorkflow(state);
    return success;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    updateWorkflowStep(state, "script", { status: "error", error: errMsg });
    addWorkflowLog(state, "error", "Script generation failed", errMsg);
    sb.error = errMsg;
    cleanupWorkflow(state);
    return false;
  }
}

/**
 * Step 2: Split script into scenes (no image generation)
 */
export async function splitScenesOnly(
  state: AppViewState,
  client: GatewayBrowserClient,
  projectId: string
): Promise<boolean> {
  const sb = getStoryboardState(state);
  
  // Initialize workflow tracking
  initWorkflowSteps(state, [
    { id: "split", label: "Split into Scenes" },
  ]);
  
  sb.pipelineRunning = true;
  sb.pipelineMessage = "Splitting into scenes...";
  
  updateWorkflowStep(state, "split", { status: "running", progress: 10 });
  addWorkflowLog(state, "info", "Starting scene splitting...");
  startWorkflowTimeout(state, 2 * 60 * 1000); // 2 min timeout
  state.requestUpdate?.();
  
  try {
    updateWorkflowStep(state, "split", { progress: 30 });
    addWorkflowLog(state, "info", "Analyzing script structure");
    
    const res = await client.call("storyboard.splitScenes", { id: projectId });
    
    updateWorkflowStep(state, "split", { progress: 80 });
    addWorkflowLog(state, "info", "Refreshing project data...");
    
    await refreshProject(state, client, projectId);
    
    const success = (res as any).success;
    const sceneCount = (res as any).sceneCount || 0;
    
    if (success) {
      updateWorkflowStep(state, "split", { status: "complete", progress: 100 });
      addWorkflowLog(state, "success", `Created ${sceneCount} scenes!`);
      sb.pipelineMessage = `Scenes created! (${sceneCount})`;
    } else {
      updateWorkflowStep(state, "split", { status: "error", error: (res as any).error || "Failed" });
      addWorkflowLog(state, "error", "Scene splitting failed", (res as any).error);
      sb.pipelineMessage = (res as any).error || "Failed";
    }
    
    cleanupWorkflow(state);
    return success;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    updateWorkflowStep(state, "split", { status: "error", error: errMsg });
    addWorkflowLog(state, "error", "Scene splitting failed", errMsg);
    sb.error = errMsg;
    cleanupWorkflow(state);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// PIPELINE OPERATIONS
// ═══════════════════════════════════════════════════════════════

export async function runPipeline(
  state: AppViewState,
  client: GatewayBrowserClient,
  projectId: string
): Promise<boolean> {
  const sb = getStoryboardState(state);
  sb.pipelineRunning = true;
  sb.pipelineProgress = 0;
  sb.pipelineMessage = "Starting pipeline...";
  state.requestUpdate?.();
  
  try {
    const res = await client.call("storyboard.run", { id: projectId });
    await refreshProject(state, client, projectId);
    
    sb.pipelineRunning = false;
    sb.pipelineProgress = 100;
    sb.pipelineMessage = (res as any).success ? "Complete!" : (res as any).error || "Failed";
    state.requestUpdate?.();
    
    return (res as any).success;
  } catch (err) {
    sb.pipelineRunning = false;
    sb.pipelineMessage = err instanceof Error ? err.message : String(err);
    state.requestUpdate?.();
    return false;
  }
}

export async function regenerateScript(
  state: AppViewState,
  client: GatewayBrowserClient,
  projectId: string
): Promise<boolean> {
  const sb = getStoryboardState(state);
  sb.pipelineRunning = true;
  sb.pipelineMessage = "Regenerating script...";
  state.requestUpdate?.();
  
  try {
    await client.call("storyboard.regenerateScript", { id: projectId });
    await refreshProject(state, client, projectId);
    sb.pipelineRunning = false;
    state.requestUpdate?.();
    return true;
  } catch (err) {
    sb.pipelineRunning = false;
    sb.error = err instanceof Error ? err.message : String(err);
    state.requestUpdate?.();
    return false;
  }
}

export async function regenerateScenes(
  state: AppViewState,
  client: GatewayBrowserClient,
  projectId: string
): Promise<boolean> {
  const sb = getStoryboardState(state);
  sb.pipelineRunning = true;
  sb.pipelineMessage = "Splitting into scenes...";
  state.requestUpdate?.();
  
  try {
    await client.call("storyboard.regenerateScenes", { id: projectId });
    await refreshProject(state, client, projectId);
    sb.pipelineRunning = false;
    state.requestUpdate?.();
    return true;
  } catch (err) {
    sb.pipelineRunning = false;
    sb.error = err instanceof Error ? err.message : String(err);
    state.requestUpdate?.();
    return false;
  }
}

export async function generateAllImages(
  state: AppViewState,
  client: GatewayBrowserClient,
  projectId: string
): Promise<boolean> {
  const sb = getStoryboardState(state);
  const project = getSelectedProject(state);
  
  const pendingScenes = project?.scenes.filter(s => s.imageStatus === "pending") || [];
  const sceneCount = pendingScenes.length;
  
  // Initialize workflow tracking with individual scene steps
  const steps = pendingScenes.map((scene, i) => ({
    id: `scene-${scene.id}`,
    label: `Scene ${scene.index + 1}: ${scene.title.slice(0, 30)}${scene.title.length > 30 ? '...' : ''}`,
  }));
  initWorkflowSteps(state, steps);
  
  sb.pipelineRunning = true;
  sb.pipelineMessage = "Generating images...";
  sb.pipelineProgress = 0;
  
  addWorkflowLog(state, "info", `Starting image generation for ${sceneCount} scenes`);
  startWorkflowTimeout(state, sceneCount * 60 * 1000); // 1 min per scene
  
  // Mark all pending scenes as generating
  if (project) {
    sb.generatingSceneIds = new Set(pendingScenes.map(s => s.id));
  }
  
  state.requestUpdate?.();
  
  // Start enhanced polling for real-time updates
  startGenerationPollingEnhanced(state, client, projectId);
  
  try {
    await client.call("storyboard.generateImages", { id: projectId });
    await refreshProject(state, client, projectId);
    
    stopGenerationPolling(state);
    
    // Mark all remaining steps as complete
    for (const scene of pendingScenes) {
      updateWorkflowStep(state, `scene-${scene.id}`, { status: "complete", progress: 100 });
    }
    
    addWorkflowLog(state, "success", `All ${sceneCount} images generated!`);
    sb.pipelineMessage = `All images generated!`;
    sb.generatingSceneIds = new Set();
    sb.pipelineProgress = 100;
    cleanupWorkflow(state);
    return true;
  } catch (err) {
    stopGenerationPolling(state);
    const errMsg = err instanceof Error ? err.message : String(err);
    addWorkflowLog(state, "error", "Image generation failed", errMsg);
    sb.generatingSceneIds = new Set();
    sb.error = errMsg;
    cleanupWorkflow(state);
    return false;
  }
}

/** Enhanced polling with logging */
function startGenerationPollingEnhanced(
  state: AppViewState,
  client: GatewayBrowserClient,
  projectId: string
): void {
  const sb = getStoryboardState(state);
  
  // Clear any existing poll
  if (sb.generationPollInterval !== null) {
    window.clearInterval(sb.generationPollInterval);
  }
  
  let lastCompletedCount = 0;
  
  // Poll every 2 seconds
  sb.generationPollInterval = window.setInterval(async () => {
    try {
      const res = await client.call("storyboard.get", { id: projectId });
      const project = (res as any).project;
      
      if (project) {
        // Update the project in state
        const idx = sb.projects.findIndex(p => p.id === projectId);
        if (idx >= 0) {
          sb.projects[idx] = project;
        }
        
        // Count completed vs total scenes
        const total = project.scenes.length;
        const completed = project.scenes.filter((s: any) => s.imageStatus === "complete").length;
        const generating = project.scenes.filter((s: any) => s.imageStatus === "generating").length;
        const failed = project.scenes.filter((s: any) => s.imageStatus === "failed").length;
        
        // Update workflow steps based on scene status
        for (const scene of project.scenes) {
          const stepId = `scene-${scene.id}`;
          if (scene.imageStatus === "complete") {
            updateWorkflowStep(state, stepId, { status: "complete", progress: 100 });
          } else if (scene.imageStatus === "generating") {
            updateWorkflowStep(state, stepId, { status: "running", progress: 50 });
          } else if (scene.imageStatus === "failed") {
            updateWorkflowStep(state, stepId, { status: "error", error: scene.imageError || "Failed" });
          }
        }
        
        // Log new completions
        if (completed > lastCompletedCount) {
          const newlyCompleted = completed - lastCompletedCount;
          addWorkflowLog(state, "success", `${newlyCompleted} image${newlyCompleted > 1 ? 's' : ''} completed (${completed}/${total})`);
          lastCompletedCount = completed;
          resetWorkflowStuck(state); // Reset stuck detection on progress
        }
        
        // Log failures
        if (failed > 0) {
          const failedScenes = project.scenes.filter((s: any) => s.imageStatus === "failed");
          for (const fs of failedScenes) {
            if (!sb.pipelineLog.some(l => l.message.includes(`Scene ${fs.index + 1} failed`))) {
              addWorkflowLog(state, "error", `Scene ${fs.index + 1} failed`, fs.imageError);
            }
          }
        }
        
        // Update generating set
        sb.generatingSceneIds = new Set(
          project.scenes.filter((s: any) => s.imageStatus === "generating").map((s: any) => s.id)
        );
        
        // Update progress
        sb.pipelineProgress = Math.round((completed / total) * 100);
        sb.pipelineMessage = `Generating images... ${completed}/${total} ${generating > 0 ? `(${generating} in progress)` : ''}`;
        
        state.requestUpdate?.();
        
        // Stop polling if all done
        if (completed + failed === total || project.status === "complete" || project.status === "failed") {
          stopGenerationPolling(state);
        }
      }
    } catch (err) {
      // Ignore poll errors but log them
      console.warn("[Storyboard] Poll error:", err);
    }
  }, 2000);
}

export async function regenerateSceneImage(
  state: AppViewState,
  client: GatewayBrowserClient,
  sceneId: string,
  projectId: string
): Promise<boolean> {
  const sb = getStoryboardState(state);
  
  // Mark scene as generating
  sb.generatingSceneIds.add(sceneId);
  state.requestUpdate?.();
  
  try {
    await client.call("storyboard.regenerateSceneImage", { sceneId });
    await refreshProject(state, client, projectId);
    
    sb.generatingSceneIds.delete(sceneId);
    state.requestUpdate?.();
    return true;
  } catch (err) {
    sb.generatingSceneIds.delete(sceneId);
    sb.error = err instanceof Error ? err.message : String(err);
    state.requestUpdate?.();
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// REAL-TIME GENERATION POLLING
// ═══════════════════════════════════════════════════════════════

function startGenerationPolling(
  state: AppViewState,
  client: GatewayBrowserClient,
  projectId: string
): void {
  const sb = getStoryboardState(state);
  
  // Clear any existing poll
  if (sb.generationPollInterval !== null) {
    window.clearInterval(sb.generationPollInterval);
  }
  
  // Poll every 2 seconds
  sb.generationPollInterval = window.setInterval(async () => {
    try {
      const res = await client.call("storyboard.get", { id: projectId });
      const project = (res as any).project;
      
      if (project) {
        // Update the project in state
        const idx = sb.projects.findIndex(p => p.id === projectId);
        if (idx >= 0) {
          sb.projects[idx] = project;
        }
        
        // Count completed vs total scenes
        const total = project.scenes.length;
        const completed = project.scenes.filter((s: any) => s.imageStatus === "complete").length;
        const generating = project.scenes.filter((s: any) => s.imageStatus === "generating").length;
        
        // Update generating set
        sb.generatingSceneIds = new Set(
          project.scenes.filter((s: any) => s.imageStatus === "generating").map((s: any) => s.id)
        );
        
        // Update progress
        sb.pipelineProgress = Math.round((completed / total) * 100);
        sb.pipelineMessage = `Generating images... ${completed}/${total} ${generating > 0 ? `(${generating} in progress)` : ''}`;
        
        state.requestUpdate?.();
        
        // Stop polling if all done
        if (completed === total || project.status === "complete" || project.status === "failed") {
          stopGenerationPolling(state);
        }
      }
    } catch (err) {
      // Ignore poll errors
    }
  }, 2000);
}

function stopGenerationPolling(state: AppViewState): void {
  const sb = getStoryboardState(state);
  if (sb.generationPollInterval !== null) {
    window.clearInterval(sb.generationPollInterval);
    sb.generationPollInterval = null;
  }
}

// ═══════════════════════════════════════════════════════════════
// REGENERATE MODAL (WITH MODEL SELECTION)
// ═══════════════════════════════════════════════════════════════

export async function openRegenerateModal(
  state: AppViewState,
  sceneId: string,
  client?: GatewayBrowserClient,
): Promise<void> {
  const sb = getStoryboardState(state);

  // Find the scene to get its current imagePrompt
  const project = sb.projects.find(p => p.id === sb.selectedProjectId);
  const scene = project?.scenes.find(s => s.id === sceneId);

  sb.showRegenerateModal = true;
  sb.regenerateSceneId = sceneId;
  sb.regeneratePrompt = scene?.imagePrompt || ""; // Pre-fill with scene's current prompt
  sb.regenerating = false;
  state.requestUpdate?.();

  // Refresh ComfyUI checkpoints via the gateway (CORS-safe).
  await fetchLocalApiModels(state, client);
}

export function closeRegenerateModal(state: AppViewState): void {
  const sb = getStoryboardState(state);
  sb.showRegenerateModal = false;
  sb.regenerateSceneId = null;
  sb.regenerating = false;
  state.requestUpdate?.();
}

export function selectRegenerateModel(state: AppViewState, modelId: string): void {
  const sb = getStoryboardState(state);
  sb.regenerateModel = modelId;
  
  // Check in availableModels first
  const model = sb.availableModels.find(m => m.id === modelId);
  if (model) {
    sb.regenerateBackend = model.backend;
  } else {
    // Check in localApiModels
    const localModel = sb.localApiModels.find(m => m.id === modelId);
    if (localModel) {
      sb.regenerateBackend = "local";
    }
  }
  state.requestUpdate?.();
}

export function setRegeneratePrompt(state: AppViewState, prompt: string): void {
  const sb = getStoryboardState(state);
  sb.regeneratePrompt = prompt;
  state.requestUpdate?.();
}

export function selectSuggestedPrompt(state: AppViewState, prompt: string): void {
  const sb = getStoryboardState(state);
  sb.regeneratePrompt = prompt;
  state.requestUpdate?.();
}

export async function generateSuggestedPrompts(
  state: AppViewState,
  client: GatewayBrowserClient,
  projectId: string
): Promise<void> {
  const sb = getStoryboardState(state);
  
  if (!sb.regenerateSceneId) return;
  
  // Find the scene and project
  const project = sb.projects.find(p => p.id === projectId);
  const scene = project?.scenes.find(s => s.id === sb.regenerateSceneId);
  
  if (!scene || !project) return;
  
  sb.loadingSuggestedPrompts = true;
  sb.suggestedPrompts = [];
  state.requestUpdate?.();
  
  try {
    // Get character info for prompt generation
    const mainChar = project.characters[0];
    const charContext = mainChar 
      ? `Character: ${mainChar.name}${mainChar.description ? ` - ${mainChar.description}` : ''}${mainChar.styleTokens ? `. Style: ${mainChar.styleTokens}` : ''}`
      : '';
    
    const result = await client.call("storyboard.generatePromptSuggestions", {
      sceneId: scene.id,
      sceneTitle: scene.title,
      sceneDescription: scene.description,
      sceneVoiceover: scene.voiceover,
      currentPrompt: scene.imagePrompt,
      characterContext: charContext,
      imageStyle: project.imageStyle,
    }) as { success: boolean; suggestions?: string[]; error?: string };
    
    if (result.success && result.suggestions) {
      sb.suggestedPrompts = result.suggestions;
    }
  } catch (err) {
    console.error("[Storyboard] Failed to generate prompt suggestions:", err);
  }
  
  sb.loadingSuggestedPrompts = false;
  state.requestUpdate?.();
}

// ═══════════════════════════════════════════════════════════════
// IMAGE PREVIEW MODAL
// ═══════════════════════════════════════════════════════════════

export function openImagePreview(state: AppViewState, sceneId: string, imageUrl: string): void {
  const sb = getStoryboardState(state);
  sb.showImagePreview = true;
  sb.previewSceneId = sceneId;
  sb.previewImageUrl = imageUrl;
  state.requestUpdate?.();
}

export function closeImagePreview(state: AppViewState): void {
  const sb = getStoryboardState(state);
  sb.showImagePreview = false;
  sb.previewSceneId = null;
  sb.previewImageUrl = null;
  state.requestUpdate?.();
}

export async function executeRegenerate(
  state: AppViewState,
  client: GatewayBrowserClient,
  projectId: string
): Promise<boolean> {
  const sb = getStoryboardState(state);
  console.log("[Storyboard] executeRegenerate called", { 
    sceneId: sb.regenerateSceneId, 
    backend: sb.regenerateBackend, 
    model: sb.regenerateModel,
    projectId 
  });
  
  if (!sb.regenerateSceneId) {
    console.warn("[Storyboard] No regenerateSceneId set!");
    return false;
  }
  
  sb.regenerating = true;
  state.requestUpdate?.();
  console.log("[Storyboard] Set regenerating=true, calling gateway...");
  
  try {
    const result = await client.call("storyboard.regenerateSceneImage", {
      sceneId: sb.regenerateSceneId,
      backend: sb.regenerateBackend,
      model: sb.regenerateModel,
      customPrompt: sb.regeneratePrompt || undefined, // Only pass if edited
    });
    console.log("[Storyboard] Gateway response:", result);
    
    await refreshProject(state, client, projectId);
    sb.showRegenerateModal = false;
    sb.regenerateSceneId = null;
    sb.regenerating = false;
    state.requestUpdate?.();
    return true;
  } catch (err) {
    sb.regenerating = false;
    sb.error = err instanceof Error ? err.message : String(err);
    state.requestUpdate?.();
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// VIDEO PREVIEW
// ═══════════════════════════════════════════════════════════════

export function setVideoPreviewUrl(state: AppViewState, url: string | null): void {
  const sb = getStoryboardState(state);
  sb.videoPreviewUrl = url;
  state.requestUpdate?.();
}

export function updateVideoTime(state: AppViewState, time: number): void {
  const sb = getStoryboardState(state);
  sb.videoCurrentTime = time;
  state.requestUpdate?.();
}

export function setVideoHoveredScene(state: AppViewState, index: number | null): void {
  const sb = getStoryboardState(state);
  sb.videoHoveredSceneIndex = index;
  state.requestUpdate?.();
}

export function setVideoDuration(state: AppViewState, duration: number): void {
  const sb = getStoryboardState(state);
  sb.videoDuration = duration;
  state.requestUpdate?.();
}

export function getSceneAtTime(state: AppViewState, time: number): number {
  const project = getSelectedProject(state);
  if (!project || project.scenes.length === 0) return -1;
  
  let elapsed = 0;
  for (let i = 0; i < project.scenes.length; i++) {
    const scene = project.scenes[i];
    if (time >= elapsed && time < elapsed + scene.durationSeconds) {
      return i;
    }
    elapsed += scene.durationSeconds;
  }
  return project.scenes.length - 1;
}

export function getSceneStartTime(state: AppViewState, sceneIndex: number): number {
  const project = getSelectedProject(state);
  if (!project || sceneIndex < 0) return 0;
  
  let elapsed = 0;
  for (let i = 0; i < sceneIndex && i < project.scenes.length; i++) {
    elapsed += project.scenes[i].durationSeconds;
  }
  return elapsed;
}

// ═══════════════════════════════════════════════════════════════
// SLIDESHOW PLAYBACK
// ═══════════════════════════════════════════════════════════════

export function startPlayback(state: AppViewState): void {
  const sb = getStoryboardState(state);
  const project = getSelectedProject(state);
  
  if (!project || project.scenes.length === 0) return;
  if (sb.isPlaying) return; // Already playing
  
  sb.isPlaying = true;
  sb.playbackSceneIndex = 0;
  sb.playbackProgress = 0;
  
  // Try to play audio for first scene
  playSceneAudio(state, 0);
  
  // Start the playback interval (update every 100ms for smooth progress)
  const intervalId = window.setInterval(() => {
    advancePlayback(state);
  }, 100);
  
  sb.playbackIntervalId = intervalId;
  state.requestUpdate?.();
}

function playSceneAudio(state: AppViewState, sceneIndex: number): void {
  const sb = getStoryboardState(state);
  const project = getSelectedProject(state);
  
  if (!project || sceneIndex >= project.scenes.length) return;
  
  // Stop current audio if playing
  if (sb.playbackAudio) {
    sb.playbackAudio.pause();
    sb.playbackAudio.onended = null;
    sb.playbackAudio.onloadedmetadata = null;
    sb.playbackAudio = null;
  }
  
  const scene = project.scenes[sceneIndex];
  sb.playbackAudioDuration = scene.durationSeconds; // Default to scene duration
  sb.playbackWaitingForAudio = true;
  
  // Use scene's audioUrl if available, otherwise construct fallback path
  const audioUrl = scene.audioUrl || 
    gatewayHttpUrl(`/media/storyboard-audio/${project.id}/scene_${String(scene.index).padStart(3, '0')}_vo.mp3`);
  
  // Try to load and play
  const audio = new Audio();
  audio.src = audioUrl;
  audio.muted = sb.playbackMuted;
  audio.volume = sb.playbackVolume;
  
  // When audio metadata loads, get the actual duration
  audio.onloadedmetadata = () => {
    if (audio.duration && isFinite(audio.duration)) {
      // Use audio duration + 0.5s buffer
      sb.playbackAudioDuration = audio.duration + 0.5;
      sb.playbackWaitingForAudio = false;
      console.log(`[Storyboard] Scene ${sceneIndex} audio duration: ${audio.duration}s`);
      state.requestUpdate?.();
    }
  };
  
  // When audio ends, ensure we advance (backup to timer)
  audio.onended = () => {
    console.log(`[Storyboard] Scene ${sceneIndex} audio ended`);
    // Give a tiny buffer then force progress to end
    setTimeout(() => {
      if (sb.isPlaying && sb.playbackSceneIndex === sceneIndex) {
        sb.playbackProgress = sb.playbackAudioDuration; // Force completion
        state.requestUpdate?.();
      }
    }, 200);
  };
  
  audio.play().catch(() => {
    // Audio not found or couldn't play - use default scene duration
    console.log(`[Storyboard] No audio found at ${audioUrl}, using scene duration`);
    sb.playbackWaitingForAudio = false;
    sb.playbackAudioDuration = scene.durationSeconds;
  });
  
  sb.playbackAudio = audio;
}

export function stopPlayback(state: AppViewState): void {
  const sb = getStoryboardState(state);
  
  if (sb.playbackIntervalId !== null) {
    window.clearInterval(sb.playbackIntervalId);
    sb.playbackIntervalId = null;
  }
  
  // Stop audio
  if (sb.playbackAudio) {
    sb.playbackAudio.pause();
    sb.playbackAudio = null;
  }
  
  sb.isPlaying = false;
  sb.playbackProgress = 0;
  state.requestUpdate?.();
}

export function toggleMute(state: AppViewState): void {
  const sb = getStoryboardState(state);
  sb.playbackMuted = !sb.playbackMuted;
  
  if (sb.playbackAudio) {
    sb.playbackAudio.muted = sb.playbackMuted;
  }
  
  state.requestUpdate?.();
}

export function setPlaybackVolume(state: AppViewState, volume: number): void {
  const sb = getStoryboardState(state);
  sb.playbackVolume = Math.max(0, Math.min(1, volume));
  
  if (sb.playbackAudio) {
    sb.playbackAudio.volume = sb.playbackVolume;
  }
  
  // Unmute if setting volume
  if (volume > 0 && sb.playbackMuted) {
    sb.playbackMuted = false;
    if (sb.playbackAudio) {
      sb.playbackAudio.muted = false;
    }
  }
  
  state.requestUpdate?.();
}

export function togglePlayback(state: AppViewState): void {
  const sb = getStoryboardState(state);
  if (sb.isPlaying) {
    stopPlayback(state);
  } else {
    startPlayback(state);
  }
}

function advancePlayback(state: AppViewState): void {
  const sb = getStoryboardState(state);
  const project = getSelectedProject(state);
  
  if (!project || !sb.isPlaying) return;
  
  const currentScene = project.scenes[sb.playbackSceneIndex];
  if (!currentScene) {
    stopPlayback(state);
    return;
  }
  
  // Wait for audio duration to be determined
  if (sb.playbackWaitingForAudio) {
    state.requestUpdate?.();
    return;
  }
  
  // Advance progress (100ms = 0.1 seconds)
  sb.playbackProgress += 0.1;
  
  // Use audio duration if available, otherwise fall back to scene duration
  const effectiveDuration = sb.playbackAudioDuration > 0 
    ? sb.playbackAudioDuration 
    : currentScene.durationSeconds;
  
  // Check if we need to move to next scene (when audio finishes)
  if (sb.playbackProgress >= effectiveDuration) {
    sb.playbackProgress = 0;
    sb.playbackSceneIndex++;
    
    // Check if we've reached the end
    if (sb.playbackSceneIndex >= project.scenes.length) {
      sb.playbackSceneIndex = 0; // Loop back to start
      stopPlayback(state);
      return;
    }
    
    // Play audio for new scene (this will set the new duration)
    playSceneAudio(state, sb.playbackSceneIndex);
  }
  
  // Update video current time for timeline sync
  sb.videoCurrentTime = getSceneStartTime(state, sb.playbackSceneIndex) + sb.playbackProgress;
  
  state.requestUpdate?.();
}

export function seekToScene(state: AppViewState, sceneIndex: number): void {
  const sb = getStoryboardState(state);
  const project = getSelectedProject(state);
  
  if (!project || sceneIndex < 0 || sceneIndex >= project.scenes.length) return;
  
  sb.playbackSceneIndex = sceneIndex;
  sb.playbackProgress = 0;
  sb.videoCurrentTime = getSceneStartTime(state, sceneIndex);
  
  state.requestUpdate?.();
}

export function getPlaybackSceneIndex(state: AppViewState): number {
  const sb = getStoryboardState(state);
  return sb.playbackSceneIndex;
}

// ═══════════════════════════════════════════════════════════════
// VOICE REGENERATION
// ═══════════════════════════════════════════════════════════════

export function openVoiceRegenModal(state: AppViewState, sceneId: string): void {
  const sb = getStoryboardState(state);
  sb.showVoiceRegenModal = true;
  sb.voiceRegenSceneId = sceneId;
  sb.regeneratingVoice = false;
  state.requestUpdate?.();
}

export function closeVoiceRegenModal(state: AppViewState): void {
  const sb = getStoryboardState(state);
  sb.showVoiceRegenModal = false;
  sb.voiceRegenSceneId = null;
  state.requestUpdate?.();
}

export function selectKokoroVoice(state: AppViewState, voiceId: string): void {
  const sb = getStoryboardState(state);
  sb.selectedKokoroVoice = voiceId;
  state.requestUpdate?.();
}

export async function regenerateVoiceover(
  state: AppViewState,
  client: GatewayBrowserClient,
  projectId: string
): Promise<boolean> {
  const sb = getStoryboardState(state);
  if (!sb.voiceRegenSceneId) return false;
  
  sb.regeneratingVoice = true;
  state.requestUpdate?.();
  
  try {
    await client.call("storyboard.regenerateVoiceover", {
      sceneId: sb.voiceRegenSceneId,
      voice: sb.selectedKokoroVoice,
      provider: "kokoro",
    });
    
    await refreshProject(state, client, projectId);
    sb.showVoiceRegenModal = false;
    sb.voiceRegenSceneId = null;
    sb.regeneratingVoice = false;
    state.requestUpdate?.();
    return true;
  } catch (err) {
    sb.regeneratingVoice = false;
    sb.error = err instanceof Error ? err.message : String(err);
    state.requestUpdate?.();
    return false;
  }
}

export async function regenerateAllVoiceovers(
  state: AppViewState,
  client: GatewayBrowserClient,
  projectId: string
): Promise<boolean> {
  const sb = getStoryboardState(state);
  
  sb.regeneratingVoice = true;
  state.requestUpdate?.();
  
  try {
    await client.call("storyboard.generateAllVoiceovers", {
      id: projectId,
      voiceId: sb.selectedKokoroVoice,
      provider: "kokoro",
    });
    
    await refreshProject(state, client, projectId);
    sb.regeneratingVoice = false;
    state.requestUpdate?.();
    return true;
  } catch (err) {
    sb.regeneratingVoice = false;
    sb.error = err instanceof Error ? err.message : String(err);
    state.requestUpdate?.();
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// CHARACTER OPERATIONS
// ═══════════════════════════════════════════════════════════════

export function openCharacterDialog(state: AppViewState, character?: CharacterRef): void {
  const sb = getStoryboardState(state);
  sb.showCharacterDialog = true;
  
  if (character) {
    sb.editingCharacterId = character.id;
    sb.characterForm = {
      name: character.name,
      description: character.description,
      referenceImageUrl: character.referenceImageUrl || "",
      styleTokens: character.styleTokens || "",
      color: character.color || "#a855f7",
    };
  } else {
    sb.editingCharacterId = null;
    sb.characterForm = {
      name: "",
      description: "",
      referenceImageUrl: "",
      styleTokens: "",
      color: "#a855f7",
    };
  }
  
  state.requestUpdate?.();
}

export function closeCharacterDialog(state: AppViewState): void {
  const sb = getStoryboardState(state);
  sb.showCharacterDialog = false;
  sb.editingCharacterId = null;
  state.requestUpdate?.();
}

export function updateCharacterForm(
  state: AppViewState,
  field: keyof StoryboardState["characterForm"],
  value: string
): void {
  const sb = getStoryboardState(state);
  sb.characterForm[field] = value;
  state.requestUpdate?.();
}

export async function saveCharacter(
  state: AppViewState,
  client: GatewayBrowserClient,
  projectId: string
): Promise<boolean> {
  const sb = getStoryboardState(state);
  
  try {
    if (sb.editingCharacterId) {
      await client.call("storyboard.updateCharacter", {
        characterId: sb.editingCharacterId,
        ...sb.characterForm,
      });
    } else {
      await client.call("storyboard.addCharacter", {
        projectId,
        ...sb.characterForm,
      });
    }
    
    await refreshProject(state, client, projectId);
    sb.showCharacterDialog = false;
    sb.editingCharacterId = null;
    state.requestUpdate?.();
    return true;
  } catch (err) {
    sb.error = err instanceof Error ? err.message : String(err);
    state.requestUpdate?.();
    return false;
  }
}

export async function deleteCharacter(
  state: AppViewState,
  client: GatewayBrowserClient,
  characterId: string,
  projectId: string
): Promise<boolean> {
  try {
    await client.call("storyboard.deleteCharacter", { characterId });
    await refreshProject(state, client, projectId);
    state.requestUpdate?.();
    return true;
  } catch (err) {
    const sb = getStoryboardState(state);
    sb.error = err instanceof Error ? err.message : String(err);
    state.requestUpdate?.();
    return false;
  }
}

/**
 * Add a character from the library to a storyboard project
 */
export async function addLibraryCharacterToProject(
  state: AppViewState,
  client: GatewayBrowserClient,
  characterId: string,
  projectId: string
): Promise<boolean> {
  const sb = getStoryboardState(state);
  
  try {
    // Fetch full character details from library
    const res = await client.call("characters.get", { id: characterId });
    const char = (res as any).character;
    
    if (!char) {
      throw new Error("Character not found");
    }
    
    // Get primary image path
    const primaryImg = char.images?.find((i: any) => i.isPrimary) || char.images?.[0];
    const imgPath = primaryImg?.path;
    
    // Add to project - use the actual file path for generation
    // The path stored in the character db is the absolute file path
    await client.call("storyboard.addCharacter", {
      projectId,
      name: char.name,
      description: char.description || `Character: ${char.name}`,
      referenceImageUrl: `/characters/${char.slug}/${imgPath?.split(/[\\/]/).pop()}`,
      referenceImagePath: imgPath, // Also pass the actual path for local file access
      styleTokens: Array.isArray(char.tags) ? char.tags.join(", ") : undefined,
      color: "#a855f7",
    });
    
    await refreshProject(state, client, projectId);
    state.requestUpdate?.();
    return true;
  } catch (err) {
    sb.error = err instanceof Error ? err.message : String(err);
    state.requestUpdate?.();
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// SCENE OPERATIONS
// ═══════════════════════════════════════════════════════════════

export function selectScene(state: AppViewState, sceneId: string | null): void {
  const sb = getStoryboardState(state);
  sb.editingSceneId = sceneId;
  state.requestUpdate?.();
}

export async function updateScene(
  state: AppViewState,
  client: GatewayBrowserClient,
  sceneId: string,
  projectId: string,
  patch: Partial<Scene>
): Promise<boolean> {
  try {
    await client.call("storyboard.updateScene", { sceneId, ...patch });
    await refreshProject(state, client, projectId);
    state.requestUpdate?.();
    return true;
  } catch (err) {
    const sb = getStoryboardState(state);
    sb.error = err instanceof Error ? err.message : String(err);
    state.requestUpdate?.();
    return false;
  }
}

/**
 * Apply an effect preset to all scenes in a project
 */
export async function applyEffectToAllScenes(
  state: AppViewState,
  client: GatewayBrowserClient,
  projectId: string,
  effect: EffectPreset
): Promise<boolean> {
  const project = getSelectedProject(state);
  if (!project) return false;
  
  try {
    // Update all scenes in parallel
    const updates = project.scenes.map(scene => 
      client.call("storyboard.updateScene", { 
        sceneId: scene.id, 
        effectPreset: effect 
      })
    );
    
    await Promise.all(updates);
    await refreshProject(state, client, projectId);
    state.requestUpdate?.();
    return true;
  } catch (err) {
    const sb = getStoryboardState(state);
    sb.error = err instanceof Error ? err.message : String(err);
    state.requestUpdate?.();
    return false;
  }
}

/**
 * Randomize effects for all scenes
 * Pairs motion/transition effects with overlay effects for each scene
 */
export async function randomizeEffects(
  state: AppViewState,
  client: GatewayBrowserClient,
  projectId: string,
  categories: EffectCategory[] = ["motion", "overlay"]
): Promise<boolean> {
  const project = getSelectedProject(state);
  if (!project) return false;
  
  // Build separate pools for motion and overlay effects
  const motionPool = EFFECT_PRESETS.filter(p => 
    p.id !== "none" && (p.category === "motion" || p.category === "transition")
  );
  const overlayPool = EFFECT_PRESETS.filter(p => 
    p.id !== "none" && p.category === "overlay"
  );
  
  if (motionPool.length === 0) return false;
  
  try {
    // Assign random motion + overlay effect pair to each scene
    const updates = project.scenes.map(scene => {
      const randomMotion = motionPool[Math.floor(Math.random() * motionPool.length)];
      // 80% chance to pair with an overlay effect
      const shouldAddOverlay = overlayPool.length > 0 && Math.random() < 0.8;
      const randomOverlay = shouldAddOverlay 
        ? overlayPool[Math.floor(Math.random() * overlayPool.length)]
        : null;
      
      return client.call("storyboard.updateScene", { 
        sceneId: scene.id, 
        effectPreset: randomMotion.id,
        overlayPreset: randomOverlay?.id || "none"
      });
    });
    
    await Promise.all(updates);
    await refreshProject(state, client, projectId);
    state.requestUpdate?.();
    return true;
  } catch (err) {
    const sb = getStoryboardState(state);
    sb.error = err instanceof Error ? err.message : String(err);
    state.requestUpdate?.();
    return false;
  }
}

/**
 * Apply effects by category to all scenes
 */
export async function applyEffectsByCategory(
  state: AppViewState,
  client: GatewayBrowserClient,
  projectId: string,
  category: EffectCategory,
  effect: EffectPreset
): Promise<boolean> {
  return applyEffectToAllScenes(state, client, projectId, effect);
}

/**
 * Clear all effects (set to none)
 */
export async function clearAllEffects(
  state: AppViewState,
  client: GatewayBrowserClient,
  projectId: string
): Promise<boolean> {
  return applyEffectToAllScenes(state, client, projectId, "none");
}

// ═══════════════════════════════════════════════════════════════
// SCENE EDITOR MODAL
// ═══════════════════════════════════════════════════════════════

export function openSceneEditor(state: AppViewState, sceneId: string): void {
  const sb = getStoryboardState(state);
  const project = getSelectedProject(state);
  
  if (!project) return;
  
  const sceneIndex = project.scenes.findIndex(s => s.id === sceneId);
  if (sceneIndex < 0) return;
  
  const scene = project.scenes[sceneIndex];
  
  sb.showSceneEditor = true;
  sb.editingSceneId = sceneId;
  sb.sceneEditorIndex = sceneIndex;
  sb.sceneEditorForm = {
    imagePrompt: scene.imagePrompt || "",
    voiceover: scene.voiceover || "",
    durationSeconds: scene.durationSeconds,
    title: scene.title || "",
    description: scene.description || "",
    effectPreset: scene.effectPreset || "none",
  };
  
  state.requestUpdate?.();
}

export function closeSceneEditor(state: AppViewState): void {
  const sb = getStoryboardState(state);
  sb.showSceneEditor = false;
  sb.editingSceneId = null;
  state.requestUpdate?.();
}

export function updateSceneField(
  state: AppViewState,
  field: keyof StoryboardState["sceneEditorForm"],
  value: string | number
): void {
  const sb = getStoryboardState(state);
  (sb.sceneEditorForm as any)[field] = value;
  state.requestUpdate?.();
}

export async function saveSceneChanges(
  state: AppViewState,
  client: GatewayBrowserClient,
  projectId: string
): Promise<boolean> {
  const sb = getStoryboardState(state);
  
  if (!sb.editingSceneId) return false;
  
  try {
    await client.call("storyboard.updateScene", {
      sceneId: sb.editingSceneId,
      title: sb.sceneEditorForm.title,
      description: sb.sceneEditorForm.description,
      imagePrompt: sb.sceneEditorForm.imagePrompt,
      voiceover: sb.sceneEditorForm.voiceover,
      durationSeconds: sb.sceneEditorForm.durationSeconds,
      effectPreset: sb.sceneEditorForm.effectPreset,
    });
    
    await refreshProject(state, client, projectId);
    sb.showSceneEditor = false;
    sb.editingSceneId = null;
    state.requestUpdate?.();
    return true;
  } catch (err) {
    sb.error = err instanceof Error ? err.message : String(err);
    state.requestUpdate?.();
    return false;
  }
}

export async function deleteScene(
  state: AppViewState,
  client: GatewayBrowserClient,
  sceneId: string,
  projectId: string
): Promise<boolean> {
  const sb = getStoryboardState(state);
  
  try {
    await client.call("storyboard.deleteScene", { sceneId });
    await refreshProject(state, client, projectId);
    
    // Close the editor if we just deleted the scene being edited
    if (sb.editingSceneId === sceneId) {
      sb.showSceneEditor = false;
      sb.editingSceneId = null;
    }
    
    state.requestUpdate?.();
    return true;
  } catch (err) {
    sb.error = err instanceof Error ? err.message : String(err);
    state.requestUpdate?.();
    return false;
  }
}

export function navigateScene(state: AppViewState, direction: "prev" | "next"): void {
  const sb = getStoryboardState(state);
  const project = getSelectedProject(state);
  
  if (!project || project.scenes.length === 0) return;
  
  let newIndex = sb.sceneEditorIndex;
  
  if (direction === "prev") {
    newIndex = newIndex > 0 ? newIndex - 1 : project.scenes.length - 1;
  } else {
    newIndex = newIndex < project.scenes.length - 1 ? newIndex + 1 : 0;
  }
  
  const newScene = project.scenes[newIndex];
  
  sb.sceneEditorIndex = newIndex;
  sb.editingSceneId = newScene.id;
  sb.sceneEditorForm = {
    imagePrompt: newScene.imagePrompt || "",
    voiceover: newScene.voiceover || "",
    durationSeconds: newScene.durationSeconds,
    title: newScene.title || "",
    description: newScene.description || "",
  };
  
  state.requestUpdate?.();
}

// ═══════════════════════════════════════════════════════════════
// VIDEO EXPORT
// ═══════════════════════════════════════════════════════════════

export function openExportDialog(state: AppViewState): void {
  const sb = getStoryboardState(state);
  sb.showExportDialog = true;
  sb.exportResult = null;
  state.requestUpdate?.();
}

export function closeExportDialog(state: AppViewState): void {
  const sb = getStoryboardState(state);
  sb.showExportDialog = false;
  state.requestUpdate?.();
}

export function updateExportSettings(
  state: AppViewState,
  field: string,
  value: any
): void {
  const sb = getStoryboardState(state);
  
  if (field.startsWith("kenBurns.")) {
    const kenField = field.replace("kenBurns.", "");
    (sb.exportSettings.kenBurns as any)[kenField] = value;
  } else {
    (sb.exportSettings as any)[field] = value;
  }
  
  state.requestUpdate?.();
}

export async function exportVideo(
  state: AppViewState,
  client: GatewayBrowserClient,
  projectId: string
): Promise<boolean> {
  const sb = getStoryboardState(state);
  sb.exporting = true;
  sb.exportResult = null;
  state.requestUpdate?.();
  
  try {
    const result = await client.call("storyboard.exportVideo", {
      id: projectId,
      fps: sb.exportSettings.fps,
      fadeTransition: sb.exportSettings.fadeTransition,
      // Use per-scene effect presets instead of global Ken Burns
      useSceneEffects: true,
    }) as any;
    
    sb.exporting = false;
    sb.exportResult = result;
    state.requestUpdate?.();
    
    return result.success;
  } catch (err) {
    sb.exporting = false;
    sb.exportResult = { 
      success: false, 
      error: err instanceof Error ? err.message : String(err) 
    };
    state.requestUpdate?.();
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// VOICE OPERATIONS
// ═══════════════════════════════════════════════════════════════

export async function loadVoices(
  state: AppViewState,
  client: GatewayBrowserClient
): Promise<void> {
  const sb = getStoryboardState(state);
  
  try {
    const res = await client.call("storyboard.voices", {}) as any;
    sb.voices = res.voices || [];
    state.requestUpdate?.();
  } catch (err) {
    console.error("Failed to load voices:", err);
  }
}

export function openVoiceDialog(state: AppViewState): void {
  const sb = getStoryboardState(state);
  sb.showVoiceDialog = true;
  state.requestUpdate?.();
}

export function closeVoiceDialog(state: AppViewState): void {
  const sb = getStoryboardState(state);
  sb.showVoiceDialog = false;
  state.requestUpdate?.();
}

export function selectVoice(state: AppViewState, voiceId: string, provider: TtsProvider): void {
  const sb = getStoryboardState(state);
  sb.selectedVoiceId = voiceId;
  sb.selectedProvider = provider;
  state.requestUpdate?.();
}

export function updateVoiceSettings(
  state: AppViewState,
  field: keyof StoryboardState["voiceSettings"],
  value: number
): void {
  const sb = getStoryboardState(state);
  sb.voiceSettings[field] = value;
  state.requestUpdate?.();
}

export async function generateVoiceovers(
  state: AppViewState,
  client: GatewayBrowserClient,
  projectId: string
): Promise<boolean> {
  const sb = getStoryboardState(state);
  sb.generatingVoiceovers = true;
  state.requestUpdate?.();
  
  try {
    const result = await client.call("storyboard.generateAllVoiceovers", {
      id: projectId,
      voiceId: sb.selectedVoiceId,
      provider: sb.selectedProvider,
      ...sb.voiceSettings,
    }) as any;
    
    sb.generatingVoiceovers = false;
    
    // Reload projects to get updated audioUrl fields
    if (result.success) {
      await loadProjects(state, client);
    }
    
    state.requestUpdate?.();
    return result.success;
  } catch (err) {
    sb.generatingVoiceovers = false;
    sb.error = err instanceof Error ? err.message : String(err);
    state.requestUpdate?.();
    return false;
  }
}

export async function generateSingleVoiceover(
  state: AppViewState,
  client: GatewayBrowserClient,
  projectId: string,
  sceneId: string
): Promise<boolean> {
  const sb = getStoryboardState(state);
  
  try {
    const result = await client.call("storyboard.generateVoiceover", {
      sceneId,
      voiceId: sb.selectedVoiceId,
      provider: sb.selectedProvider,
      ...sb.voiceSettings,
    }) as any;
    
    // Reload projects to get updated audioUrl
    if (result.success) {
      await loadProjects(state, client);
    }
    
    state.requestUpdate?.();
    return result.success;
  } catch (err) {
    sb.error = err instanceof Error ? err.message : String(err);
    state.requestUpdate?.();
    return false;
  }
}

export function playPreviewAudio(state: AppViewState, audioUrl: string): void {
  const sb = getStoryboardState(state);
  
  // Stop any current preview audio
  if (sb.previewAudio) {
    sb.previewAudio.pause();
    sb.previewAudio = null;
  }
  
  // Play the new audio
  const audio = new Audio(audioUrl);
  audio.play().catch(err => {
    console.error("[Storyboard] Failed to play audio:", err);
  });
  
  sb.previewAudio = audio;
}

// Voice cloning
export function openCloneDialog(state: AppViewState): void {
  const sb = getStoryboardState(state);
  sb.showCloneDialog = true;
  sb.cloneForm = { name: "", description: "", audioFiles: [] };
  state.requestUpdate?.();
}

export function closeCloneDialog(state: AppViewState): void {
  const sb = getStoryboardState(state);
  sb.showCloneDialog = false;
  state.requestUpdate?.();
}

export function updateCloneForm(
  state: AppViewState,
  field: keyof StoryboardState["cloneForm"],
  value: any
): void {
  const sb = getStoryboardState(state);
  (sb.cloneForm as any)[field] = value;
  state.requestUpdate?.();
}

export async function cloneVoice(
  state: AppViewState,
  client: GatewayBrowserClient
): Promise<boolean> {
  const sb = getStoryboardState(state);
  sb.cloning = true;
  state.requestUpdate?.();
  
  try {
    const result = await client.call("storyboard.cloneVoice", {
      name: sb.cloneForm.name,
      description: sb.cloneForm.description,
      audioFiles: sb.cloneForm.audioFiles,
    }) as any;
    
    sb.cloning = false;
    
    if (result.success && result.voiceId) {
      // Refresh voices list
      await loadVoices(state, client);
      sb.selectedVoiceId = result.voiceId;
      sb.selectedProvider = "elevenlabs";
      sb.showCloneDialog = false;
    }
    
    state.requestUpdate?.();
    return result.success;
  } catch (err) {
    sb.cloning = false;
    sb.error = err instanceof Error ? err.message : String(err);
    state.requestUpdate?.();
    return false;
  }
}

export async function deleteVoice(
  state: AppViewState,
  client: GatewayBrowserClient,
  voiceId: string
): Promise<boolean> {
  try {
    await client.call("storyboard.deleteVoice", { voiceId });
    await loadVoices(state, client);
    
    const sb = getStoryboardState(state);
    if (sb.selectedVoiceId === voiceId) {
      sb.selectedVoiceId = null;
    }
    state.requestUpdate?.();
    return true;
  } catch (err) {
    const sb = getStoryboardState(state);
    sb.error = err instanceof Error ? err.message : String(err);
    state.requestUpdate?.();
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════

export const PLATFORM_OPTIONS = [
  { id: "youtube", label: "YouTube", icon: "📺", aspectRatio: "16:9" },
  { id: "tiktok", label: "TikTok", icon: "📱", aspectRatio: "9:16" },
  { id: "shorts", label: "YouTube Shorts", icon: "📲", aspectRatio: "9:16" },
  { id: "instagram", label: "Instagram Reels", icon: "📷", aspectRatio: "9:16" },
  { id: "custom", label: "Custom", icon: "🎬", aspectRatio: "16:9" },
];

export const STYLE_OPTIONS = [
  { id: "cinematic", label: "Cinematic", icon: "🎥" },
  { id: "realistic", label: "Realistic", icon: "📸" },
  { id: "anime", label: "Anime", icon: "✨" },
  { id: "illustrated", label: "Illustrated", icon: "🎨" },
  { id: "3d-render", label: "3D Render", icon: "🔮" },
  { id: "watercolor", label: "Watercolor", icon: "🖌️" },
  { id: "comic", label: "Comic Book", icon: "💥" },
  { id: "minimalist", label: "Minimalist", icon: "◻️" },
];

export const BACKEND_OPTIONS = [
  { id: "local", label: "ComfyUI", icon: "🎨" },
];

export const LANGUAGE_OPTIONS = [
  { id: "en", label: "English", flag: "🇺🇸", ttsVoices: ["elevenlabs", "edge", "kokoro", "local"] },
  { id: "th", label: "ไทย (Thai)", flag: "🇹🇭", ttsVoices: ["elevenlabs", "edge", "kokoro", "local"] },
];

export const THAI_EDGE_VOICES = [
  { id: "th-TH-PremwadeeNeural", name: "Premwadee", gender: "Female" },
  { id: "th-TH-NiwatNeural", name: "Niwat", gender: "Male" },
];

// All image models are served by the local ComfyUI server. The list is
// populated at runtime from /models — see fetchLocalApiModels().
export const MODEL_OPTIONS: Array<{ id: string; name: string; backend: ImageBackend; badge?: string; icon?: string }> = [];

// Local API models - fetched dynamically
export interface LocalApiModel {
  id: string;
  name: string;
  type: string;
  description: string;
  supports_img2img: boolean;
  supports_inpaint: boolean;
  vram_gb: number;
}

// ComfyUI URL lives server-side now (env COMFY_URL / LOCAL_IMAGE_API_URL);
// the dashboard talks to the gateway, never to ComfyUI directly.

export function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (mins === 0) return `${secs}s`;
  if (secs === 0) return `${mins}m`;
  return `${mins}m ${secs}s`;
}

export function getStatusColor(status: ProjectStatus): string {
  switch (status) {
    case "draft": return "#6b7280";
    case "scripting": return "#3b82f6";
    case "splitting": return "#8b5cf6";
    case "generating": return "#f59e0b";
    case "complete": return "#10b981";
    case "failed": return "#ef4444";
    default: return "#6b7280";
  }
}

export function getStatusLabel(status: ProjectStatus): string {
  switch (status) {
    case "draft": return "Draft";
    case "scripting": return "Writing Script";
    case "splitting": return "Splitting Scenes";
    case "generating": return "Generating Images";
    case "complete": return "Complete";
    case "failed": return "Failed";
    default: return status;
  }
}
