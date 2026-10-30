/**
 * Storyboard View — Black & Gold Futuristic Terminal UI
 * 
 * Full storyboard automation dashboard with project management,
 * script generation, scene editing, and image generation.
 */

import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import type { AppViewState } from "../app-view-state.js";
import type { GatewayBrowserClient } from "../gateway.js";
import { icons } from "../icons.js";
import { g8GlassStyles } from "./glass-g8.js";
import "../components/doc-agent-panel.js";
import "../components/timeline-prompt-composer.js";
import "../components/mention-input-fallback.js";
import {
  resolveTimelinePrompts,
  validateBeats,
  estimatePlanCost,
  describePlan,
  emptyTimelinePlan,
  newBeat,
} from "../controllers/timeline-prompt-resolver.js";
import {
  getStoryboardState,
  getSelectedProject,
  loadProjects,
  selectProject,
  openCreateDialog,
  closeCreateDialog,
  updateCreateForm,
  createProject,
  deleteProject,
  runPipeline,
  regenerateScript,
  regenerateScenes,
  generateAllImages,
  regenerateSceneImage,
  openCharacterDialog,
  closeCharacterDialog,
  updateCharacterForm,
  saveCharacter,
  deleteCharacter,
  selectScene,
  updateScene,
  openExportDialog,
  closeExportDialog,
  updateExportSettings,
  exportVideo,
  formatDuration,
  getStatusColor,
  getStatusLabel,
  // Scene Editor Modal
  openSceneEditor,
  closeSceneEditor,
  updateSceneField,
  saveSceneChanges,
  deleteScene,
  navigateScene,
  // Regenerate Modal
  openRegenerateModal,
  closeRegenerateModal,
  selectRegenerateModel,
  setRegeneratePrompt,
  selectSuggestedPrompt,
  generateSuggestedPrompts,
  executeRegenerate,
  // Image Preview
  openImagePreview,
  closeImagePreview,
  // Video Preview
  setVideoPreviewUrl,
  updateVideoTime,
  setVideoHoveredScene,
  setVideoDuration,
  getSceneAtTime,
  getSceneStartTime,
  // Slideshow Playback
  startPlayback,
  stopPlayback,
  togglePlayback,
  seekToScene,
  getPlaybackSceneIndex,
  toggleMute,
  setPlaybackVolume,
  // Voice Regeneration
  openVoiceRegenModal,
  closeVoiceRegenModal,
  selectKokoroVoice,
  regenerateVoiceover,
  regenerateAllVoiceovers,
  // Voiceover Generation
  generateVoiceovers,
  generateSingleVoiceover,
  playPreviewAudio,
  PLATFORM_OPTIONS,
  STYLE_OPTIONS,
  BACKEND_OPTIONS,
  MODEL_OPTIONS,
  LANGUAGE_OPTIONS,
  THAI_EDGE_VOICES,
  toggleCharacterSelection,
  fetchAvailableCharacters,
  addLibraryCharacterToProject,
  // Script editing
  startEditingScript,
  cancelEditingScript,
  updateScriptDraft,
  saveScript,
  // Step-by-step workflow
  generateScriptOnly,
  splitScenesOnly,
  // Workflow tracking
  toggleWorkflowLog,
  cancelWorkflow,
  getWorkflowElapsed,
  type WorkflowStep,
  type WorkflowLogEntry,
  // Tab navigation
  setActiveTab,
  // View mode
  togglePresetBuilder,
  setStoryboardMode,
  setTimelinePlan,
  openPreGenModal,
  closePreGenModal,
  // Effect presets
  applyEffectToAllScenes,
  randomizeEffects,
  clearAllEffects,
  EFFECT_PRESETS,
  MOTION_PRESETS,
  TRANSITION_PRESETS,
  OVERLAY_PRESETS,
  type StoryboardProject,
  type Scene,
  type CharacterRef,
  type Platform,
  type EffectPreset,
  type EffectCategory,
  // Prompt-based entry — generation mode & character slots
  setCreateGenerationMode,
  bindCharacterSlot,
  getBoundSlotCharacters,
  setAssetChip,
  setLocationChip,
} from "../controllers/storyboard.js";
import { renderCharactersPanel, initializeCharacters } from "./characters.js";
import { renderPresetBuilder } from "./preset-builder.js";
import { 
  getCharactersState, 
  getImageUrl, 
  loadCharacter,
  openCreateDialog as openCharCreateDialog 
} from "../controllers/characters.js";
import { gatewayHttpUrl } from "../gateway-endpoint";

// ═══════════════════════════════════════════════════════════════
// TIMELINE PROMPTING (Phase 8 addendum)
// ═══════════════════════════════════════════════════════════════

/**
 * Mount the TimelinePromptComposer above any generation surface.
 * `mode` controls validation + plan-summary copy; `compact` collapses by default
 * (used inline next to per-scene Regenerate buttons).
 */
function renderTimelineComposer(
  state: AppViewState,
  project: StoryboardProject,
  mode: "image" | "video" | "sequential" | "timeline-prompting" | "recreate",
  opts: { compact?: boolean; sceneId?: string } = {}
): ReturnType<typeof html> {
  const sb = getStoryboardState(state);
  const plan = sb.timelinePlan ?? project.timelinePrompting ?? emptyTimelinePlan();
  // For per-scene compact composers, scope to that single scene's time range
  let scopedPlan = plan;
  let scopedScenes: Scene[] = project.scenes;
  if (opts.sceneId) {
    const scene = project.scenes.find(s => s.id === opts.sceneId);
    if (scene) {
      scopedScenes = [scene];
      scopedPlan = {
        ...plan,
        beats: plan.beats.filter(b => b.startSec < scene.durationSeconds * (scene.index + 1)),
      };
    }
  }
  return html`
    <timeline-prompt-composer
      .projectId=${project.id}
      .mode=${mode}
      .scenes=${scopedScenes}
      .value=${scopedPlan}
      .project=${project}
      ?compact=${opts.compact === true}
      @timeline-beats-changed=${(e: CustomEvent) => setTimelinePlan(state, e.detail.value)}
    ></timeline-prompt-composer>
  `;
}

/**
 * Pre-generation review modal — fires when the user clicks a Generate-all
 * button and beats are authored. Shows resolved prompt, ref chips, cost
 * estimate, and per-mode plan summary before committing.
 */
function renderPreGenModal(
  state: AppViewState,
  client: GatewayBrowserClient,
  project: StoryboardProject
): ReturnType<typeof html> {
  const sb = getStoryboardState(state);
  const mode = sb.preGenMode || "image";
  const plan = sb.timelinePlan ?? project.timelinePrompting ?? emptyTimelinePlan();
  const cost = estimatePlanCost(plan.beats, sb.preGenResolvedRefs.length, "auto");
  const summary = describePlan(plan.beats, mode);
  return html`
    <div class="sb-modal-overlay" @click=${() => closePreGenModal(state)}>
      <div class="sb-modal" style="max-width: 720px;" @click=${(e: Event) => e.stopPropagation()}>
        <div class="sb-modal-header">
          <h3>Review timeline plan</h3>
          <button class="sb-btn sb-btn-ghost" @click=${() => closePreGenModal(state)}>${icons.x}</button>
        </div>
        <div class="sb-modal-body">
          <div style="color: #d4af37; font-size: 12px; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px;">Plan summary</div>
          <div style="color: rgba(245,245,245,0.85); margin-bottom: 12px;">${summary}</div>

          <div style="color: #d4af37; font-size: 12px; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px;">Resolved prompt</div>
          <pre style="background: rgba(0,0,0,0.4); padding: 10px; border-radius: 6px; max-height: 240px; overflow:auto; font-size: 11px; white-space: pre-wrap;">${sb.preGenResolvedPrompt || project.prompt}</pre>

          <div style="color: #d4af37; font-size: 12px; margin: 12px 0 6px; text-transform: uppercase; letter-spacing: 0.5px;">Collected refs (${sb.preGenResolvedRefs.length})</div>
          <div style="display:flex; flex-wrap:wrap; gap:6px;">
            ${sb.preGenResolvedRefs.map(r => html`
              <span style="background: rgba(212,175,55,0.15); border:1px solid rgba(212,175,55,0.4); color:#d4af37; padding:3px 8px; border-radius: 12px; font-size: 11px;">${r}</span>
            `)}
            ${sb.preGenResolvedRefs.length === 0 ? html`<span style="color: rgba(245,245,245,0.4); font-size: 11px;">No refs collected.</span>` : nothing}
          </div>

          <div style="margin-top: 12px; display:flex; justify-content: space-between; align-items: center;">
            <div style="color: rgba(245,245,245,0.7); font-size: 11px;">
              ${cost.beatCount} beats · ${cost.refCount} refs · ${cost.estimateLabel}
            </div>
          </div>
        </div>
        <div class="sb-modal-footer">
          <button class="sb-btn sb-btn-ghost" @click=${() => closePreGenModal(state)}>Cancel</button>
          <button class="sb-btn sb-btn-gold" @click=${async () => {
            closePreGenModal(state);
            if (mode === "image" || mode === "recreate") {
              await generateAllImages(state, client, project.id);
            } else if (mode === "sequential") {
              await generateAllImages(state, client, project.id);
            } else if (mode === "video") {
              await generateAllImages(state, client, project.id);
            }
          }}>Confirm & generate</button>
        </div>
      </div>
    </div>
  `;
}

/**
 * Gate Generate-all: if beats are authored, open the pre-gen modal instead of
 * jumping straight to generation. Otherwise fall through to existing flow.
 */
function gatedGenerateAll(
  state: AppViewState,
  client: GatewayBrowserClient,
  project: StoryboardProject,
  mode: "image" | "video" | "sequential" | "recreate"
): void {
  const sb = getStoryboardState(state);
  const plan = sb.timelinePlan ?? project.timelinePrompting;
  if (plan && plan.beats.length > 0) {
    const slots = {
      characters: plan.characterSlots,
      assets: plan.assetSlots,
      locations: plan.locationSlots,
    };
    const totalDuration = plan.totalDurationSec
      || project.scenes.reduce((s, sc) => s + sc.durationSeconds, 0);
    const { valid, errors } = validateBeats(plan.beats, slots, project.scenes, totalDuration, mode);
    if (!valid) {
      alert(`Cannot generate: ${errors[0].message}`);
      return;
    }
    const { prompt, refs } = resolveTimelinePrompts(plan.beats, project);
    openPreGenModal(state, mode, prompt, refs);
    return;
  }
  // No beats → preserve existing flow
  generateAllImages(state, client, project.id);
}

// ═══════════════════════════════════════════════════════════════
// STYLE INJECTION
// ═══════════════════════════════════════════════════════════════

let stylesInjected = false;

function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  
  const style = document.createElement("style");
  style.textContent = storyboardStyles;
  document.head.appendChild(style);
}

// ═══════════════════════════════════════════════════════════════
// MAIN RENDER
// ═══════════════════════════════════════════════════════════════

export async function initializeStoryboard(
  state: AppViewState,
  client: GatewayBrowserClient
): Promise<void> {
  await Promise.all([
    loadProjects(state, client),
    initializeCharacters(state, client),
    fetchAvailableCharacters(state, client), // Load characters for project selection
  ]);
}

export function renderStoryboard(
  state: AppViewState,
  client: GatewayBrowserClient
): ReturnType<typeof html> {
  injectStyles();
  
  const sb = getStoryboardState(state);
  const selectedProject = getSelectedProject(state);
  
  // Show preset builder if in presets mode
  if (sb.viewMode === "presets") {
    return html`
      ${g8GlassStyles}
      <div class="sb-container g8-page">
        <!-- Animated Background -->
        <div class="sb-bg-effects">
          <div class="sb-glow-orb orb-gold"></div>
          <div class="sb-glow-orb orb-purple"></div>
          <div class="sb-grid-pattern"></div>
        </div>
        
        <!-- Header with back button -->
        <div class="sb-header">
          <div class="sb-header-left">
            <button 
              class="sb-btn sb-btn-ghost"
              @click=${() => togglePresetBuilder(state)}
              title="Back to Projects"
            >
              <span class="sb-btn-icon">${icons.arrowLeft}</span> Back
            </button>
            <div class="sb-logo">
              <span class="sb-logo-icon">${icons.palette}</span>
              <span class="sb-logo-text">Effect Preset Builder</span>
            </div>
          </div>
        </div>
        
        <!-- Preset Builder Content -->
        <div class="sb-preset-wrapper">
          ${renderPresetBuilder(state, client)}
        </div>
      </div>
    `;
  }
  
  return html`
    ${g8GlassStyles}
    <div class="sb-container g8-page">
      <!-- Animated Background -->
      <div class="sb-bg-effects">
        <div class="sb-glow-orb orb-gold"></div>
        <div class="sb-glow-orb orb-purple"></div>
        <div class="sb-grid-pattern"></div>
      </div>
      
      <!-- Header -->
      ${renderHeader(state, client)}
      
      <!-- Main Layout -->
      <div class="sb-layout">
        <!-- Project List Sidebar -->
        <div class="sb-sidebar">
          <div class="sb-sidebar-section sb-projects-section">
            <div class="sb-section-header">
              <span class="sb-section-title"><span class="sb-section-icon">${icons.folder}</span> Projects</span>
            </div>
            ${renderProjectList(state, client)}
          </div>
          <!-- Characters Library Panel -->
          <div class="sb-sidebar-section sb-characters-section">
            ${renderCharactersPanel(state, client)}
          </div>
        </div>
        
        <!-- Main Content -->
        <div class="sb-main">
          ${selectedProject
            ? renderProjectDetail(state, client, selectedProject)
            : renderEmptyState(state, client)
          }
        </div>
      </div>
      
      <!-- Dialogs -->
      ${sb.showCreateDialog ? renderCreateDialog(state, client) : nothing}
      ${sb.showCharacterDialog && selectedProject ? renderCharacterDialog(state, client, selectedProject.id) : nothing}
      ${sb.showExportDialog && selectedProject ? renderExportDialog(state, client, selectedProject) : nothing}
      ${sb.showSceneEditor && selectedProject ? renderSceneEditorModal(state, client, selectedProject) : nothing}
      ${sb.showRegenerateModal && selectedProject ? renderRegenerateModal(state, client, selectedProject) : nothing}
      ${sb.showVoiceRegenModal && selectedProject ? renderVoiceRegenModal(state, client, selectedProject) : nothing}
      ${sb.showImagePreview ? renderImagePreviewModal(state) : nothing}
      ${sb.showPreGenModal && selectedProject ? renderPreGenModal(state, client, selectedProject) : nothing}

      ${selectedProject
        ? html`<doc-agent-panel
            .client=${client as any}
            docType="storyboard"
            .documentId=${selectedProject.id}
            .title=${(selectedProject as any).name ?? selectedProject.id}
            .extra=${`scenes=${(selectedProject as any).scenes?.length ?? 0} status=${(selectedProject as any).status ?? "unknown"}`}
          ></doc-agent-panel>`
        : nothing}
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════
// HEADER
// ═══════════════════════════════════════════════════════════════

function renderHeader(state: AppViewState, client: GatewayBrowserClient): ReturnType<typeof html> {
  const sb = getStoryboardState(state);
  
  return html`
    <div class="sb-header">
      <div class="sb-header-left">
        <div class="sb-logo">
          <span class="sb-logo-icon">${icons.clapperboard}</span>
          <span class="sb-logo-text">Storyboard Studio</span>
        </div>
        <div class="sb-header-stats">
          <span class="sb-stat">${sb.projects.length} Projects</span>
          <span class="sb-stat-divider">•</span>
          <span class="sb-stat">${sb.availableBackends.length} Backends</span>
        </div>
      </div>
      
      <div class="sb-header-right">
        <button 
          class="sb-btn ${sb.viewMode === 'presets' ? 'sb-btn-gold' : 'sb-btn-ghost'}"
          @click=${() => togglePresetBuilder(state)}
          title="Effect Preset Builder"
        >
          <span class="sb-btn-icon">${icons.palette}</span>
          Presets
        </button>
        <button 
          class="sb-btn sb-btn-primary"
          @click=${() => openCreateDialog(state, client)}
        >
          <span class="sb-btn-icon">${icons.plus}</span>
          New Project
        </button>
        <button 
          class="sb-btn sb-btn-ghost"
          @click=${() => loadProjects(state, client)}
        >
          ${icons.refresh}
        </button>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════
// PROJECT LIST
// ═══════════════════════════════════════════════════════════════

function renderProjectList(state: AppViewState, client: GatewayBrowserClient): ReturnType<typeof html> {
  const sb = getStoryboardState(state);
  
  if (sb.loading) {
    return html`
      <div class="sb-sidebar-loading">
        <div class="sb-spinner"></div>
        <span>Loading projects...</span>
      </div>
    `;
  }
  
  if (sb.projects.length === 0) {
    return html`
      <div class="sb-sidebar-empty">
        <span class="sb-empty-icon">${icons.folder}</span>
        <p>No projects yet</p>
        <button class="sb-btn sb-btn-sm" @click=${() => openCreateDialog(state, client)}>
          Create First Project
        </button>
      </div>
    `;
  }
  
  return html`
    <div class="sb-project-list">
      ${sb.projects.map(project => renderProjectCard(state, project))}
    </div>
  `;
}

function renderProjectCard(state: AppViewState, project: StoryboardProject): ReturnType<typeof html> {
  const sb = getStoryboardState(state);
  const isSelected = sb.selectedProjectId === project.id;
  const statusColor = getStatusColor(project.status);
  const platformInfo = PLATFORM_OPTIONS.find(p => p.id === project.platform);
  
  return html`
    <div 
      class="sb-project-card ${isSelected ? 'selected' : ''}"
      @click=${() => selectProject(state, project.id)}
    >
      <div class="sb-project-card-header">
        <span class="sb-project-platform">${platformInfo?.icon || "🎬"}</span>
        <span class="sb-project-name">${project.name}</span>
      </div>
      
      <div class="sb-project-card-meta">
        <span class="sb-project-duration">${project.targetDuration}min</span>
        <span 
          class="sb-project-status"
          style="--status-color: ${statusColor}"
        >
          ${getStatusLabel(project.status)}
        </span>
      </div>
      
      ${project.status === "generating" || project.status === "scripting" || project.status === "splitting" ? html`
        <div class="sb-project-progress">
          <div class="sb-progress-bar">
            <div class="sb-progress-fill" style="width: ${project.progress}%"></div>
          </div>
          <span class="sb-progress-text">${project.progress}%</span>
        </div>
      ` : nothing}
      
      <div class="sb-project-card-footer">
        <span class="sb-project-scenes">${project.scenes.length} scenes</span>
        <span class="sb-project-chars">${project.characters.length} chars</span>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════
// PROJECT DETAIL
// ═══════════════════════════════════════════════════════════════

function renderProjectDetail(
  state: AppViewState,
  client: GatewayBrowserClient,
  project: StoryboardProject
): ReturnType<typeof html> {
  const sb = getStoryboardState(state);
  
  return html`
    <div class="sb-detail">
      <!-- Project Header -->
      <div class="sb-detail-header">
        <div class="sb-detail-title-row">
          <h2 class="sb-detail-title">${project.name}</h2>
          <div class="sb-detail-actions">
            <!-- Step-by-step workflow buttons -->
            ${project.status === "draft" && !project.script ? html`
              <button 
                class="sb-btn sb-btn-gold"
                ?disabled=${sb.pipelineRunning}
                @click=${() => generateScriptOnly(state, client, project.id)}
              >
                ${sb.pipelineRunning ? html`<span class="sb-spinner-sm"></span>` : html`<span class="sb-btn-icon">${icons.fileText}</span>`}
                Step 1: Generate Script
              </button>
            ` : nothing}
            
            ${project.script && project.scenes.length === 0 ? html`
              <button 
                class="sb-btn sb-btn-gold"
                ?disabled=${sb.pipelineRunning}
                @click=${() => splitScenesOnly(state, client, project.id)}
              >
                ${sb.pipelineRunning ? html`<span class="sb-spinner-sm"></span>` : html`<span class="sb-btn-icon">${icons.scissors}</span>`}
                Step 2: Split into Scenes
              </button>
            ` : nothing}
            
            ${project.scenes.length > 0 && project.scenes.some(s => s.imageStatus === "pending") ? html`
              <button
                class="sb-btn sb-btn-gold"
                ?disabled=${sb.pipelineRunning}
                @click=${() => gatedGenerateAll(state, client, project, "image")}
              >
                ${sb.pipelineRunning ? html`<span class="sb-spinner-sm"></span>` : html`<span class="sb-btn-icon">${icons.image}</span>`}
                Step 3: Generate Images
              </button>
            ` : nothing}
            
            ${project.scenes.length > 0 && project.scenes.some(s => !s.audioUrl) ? html`
              <button 
                class="sb-btn sb-btn-outline"
                ?disabled=${sb.pipelineRunning}
                @click=${() => regenerateAllVoiceovers(state, client, project.id)}
              >
                ${sb.pipelineRunning ? html`<span class="sb-spinner-sm"></span>` : html`<span class="sb-btn-icon">${icons.voiceover}</span>`}
                Generate Voiceovers
              </button>
            ` : nothing}
            
            ${project.status === "complete" ? html`
              <button 
                class="sb-btn sb-btn-gold"
                @click=${() => openExportDialog(state)}
              >
                <span class="sb-btn-icon">${icons.exportVideo}</span> Export Video
              </button>
            ` : nothing}
            
            <button 
              class="sb-btn sb-btn-ghost sb-btn-danger"
              @click=${() => {
                if (confirm("Delete this project?")) {
                  deleteProject(state, client, project.id);
                }
              }}
            >
              ${icons.trash}
            </button>
          </div>
        </div>
        
        <div class="sb-detail-meta">
          <span class="sb-meta-item">
            ${PLATFORM_OPTIONS.find(p => p.id === project.platform)?.icon} ${PLATFORM_OPTIONS.find(p => p.id === project.platform)?.label}
          </span>
          <span class="sb-meta-divider">•</span>
          <span class="sb-meta-item">${project.targetDuration} min</span>
          <span class="sb-meta-divider">•</span>
          <span class="sb-meta-item">${project.aspectRatio}</span>
          <span class="sb-meta-divider">•</span>
          <span class="sb-meta-item">${STYLE_OPTIONS.find(s => s.id === project.imageStyle)?.label || project.imageStyle}</span>
        </div>
        
        ${project.error ? html`
          <div class="sb-error-banner">
            <span class="sb-error-icon">${icons.alertCircle}</span> ${project.error}
          </div>
        ` : nothing}
        
        ${sb.pipelineRunning || sb.pipelineSteps.length > 0 ? renderWorkflowProgress(state) : nothing}

        <!-- Phase 8: Timeline Prompting composer (pre-generation step for all generate-all flows) -->
        ${project.scenes.length > 0 ? renderTimelineComposer(
          state,
          project,
          sb.viewMode === "video" ? "video"
            : sb.viewMode === "sequential" ? "sequential"
            : sb.viewMode === "recreate" ? "recreate"
            : sb.viewMode === "timeline-prompting" ? "timeline-prompting"
            : "image"
        ) : nothing}
      </div>

      <!-- Video Preview with Timeline -->
      ${project.scenes.length > 0 ? renderVideoPreview(state, client, project) : nothing}
      
      <!-- Tabs -->
      <div class="sb-tabs">
        <button 
          class="sb-tab ${sb.activeTab === 'scenes' ? 'active' : ''}"
          @click=${() => setActiveTab(state, 'scenes')}
        ><span class="sb-tab-icon">${icons.layers}</span> Scenes</button>
        <button 
          class="sb-tab ${sb.activeTab === 'script' ? 'active' : ''}"
          @click=${() => setActiveTab(state, 'script')}
        ><span class="sb-tab-icon">${icons.fileText}</span> Script</button>
        <button 
          class="sb-tab ${sb.activeTab === 'characters' ? 'active' : ''}"
          @click=${() => setActiveTab(state, 'characters')}
        ><span class="sb-tab-icon">${icons.users}</span> Characters</button>
        <button 
          class="sb-tab ${sb.activeTab === 'settings' ? 'active' : ''}"
          @click=${() => setActiveTab(state, 'settings')}
        ><span class="sb-tab-icon">${icons.settings}</span> Settings</button>
      </div>
      
      <!-- Tab Content -->
      ${sb.activeTab === 'scenes' ? html`
        <!-- Scenes Tab -->
        <div class="sb-prompt-section">
          <h3>Prompt</h3>
          <p class="sb-prompt-text">${project.prompt}</p>
        </div>
        ${renderScenesGrid(state, client, project)}
      ` : nothing}
      
      ${sb.activeTab === 'script' ? html`
        <!-- Script Tab -->
        ${renderScriptSection(state, client, project)}
      ` : nothing}
      
      ${sb.activeTab === 'characters' ? html`
        <!-- Characters Tab -->
        ${renderProjectCharactersPanel(state, client, project)}
      ` : nothing}
      
      ${sb.activeTab === 'settings' ? html`
        <!-- Settings Tab -->
        ${renderSettingsPanel(state, client, project)}
      ` : nothing}
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════
// WORKFLOW PROGRESS - Enhanced pipeline visualization
// ═══════════════════════════════════════════════════════════════

function renderWorkflowProgress(state: AppViewState): ReturnType<typeof html> {
  const sb = getStoryboardState(state);
  const elapsed = getWorkflowElapsed(state);
  const elapsedStr = formatElapsedTime(elapsed);
  
  return html`
    <div class="wf-progress ${sb.pipelineStuck ? 'wf-stuck' : ''} ${sb.pipelineRunning ? 'wf-running' : 'wf-complete'}">
      <!-- Header with status and controls -->
      <div class="wf-header">
        <div class="wf-header-left">
          <div class="wf-status-indicator ${sb.pipelineRunning ? 'wf-pulse' : ''}">
            ${sb.pipelineStuck 
              ? html`<span class="wf-stuck-icon">${icons.alert}</span>`
              : sb.pipelineRunning
                ? html`<span class="wf-spinner"></span>`
                : html`<span class="wf-done-icon">${icons.check}</span>`
            }
          </div>
          <div class="wf-status-text">
            <span class="wf-message">${sb.pipelineMessage}</span>
            ${sb.pipelineRunning ? html`<span class="wf-elapsed">${elapsedStr}</span>` : nothing}
          </div>
        </div>
        <div class="wf-header-right">
          ${sb.pipelineStuck ? html`
            <button class="wf-btn wf-btn-cancel" @click=${() => cancelWorkflow(state)}>
              ${icons.x} Cancel
            </button>
          ` : nothing}
          <button 
            class="wf-btn wf-btn-log ${sb.pipelineLogExpanded ? 'wf-active' : ''}"
            @click=${() => toggleWorkflowLog(state)}
          >
            ${icons.scrollText} Log ${sb.pipelineLog.length > 0 ? `(${sb.pipelineLog.length})` : ''}
          </button>
        </div>
      </div>
      
      <!-- Overall progress bar with animation -->
      <div class="wf-progress-bar">
        <div 
          class="wf-progress-fill ${sb.pipelineRunning ? 'wf-animated' : ''}"
          style="width: ${sb.pipelineProgress}%"
        ></div>
        <span class="wf-progress-text">${sb.pipelineProgress}%</span>
      </div>
      
      <!-- Step indicators -->
      ${sb.pipelineSteps.length > 0 ? html`
        <div class="wf-steps ${sb.pipelineSteps.length > 5 ? 'wf-steps-compact' : ''}">
          ${sb.pipelineSteps.map((step, index) => renderWorkflowStep(step, index, sb.pipelineSteps.length))}
        </div>
      ` : nothing}
      
      <!-- Collapsible log panel -->
      ${sb.pipelineLogExpanded ? html`
        <div class="wf-log-panel">
          <div class="wf-log-header">
            <span class="wf-log-title">Activity Log</span>
            <span class="wf-log-count">${sb.pipelineLog.length} entries</span>
          </div>
          <div class="wf-log-entries">
            ${sb.pipelineLog.length === 0 
              ? html`<div class="wf-log-empty">No activity yet...</div>`
              : sb.pipelineLog.slice().reverse().map(entry => html`
                  <div class="wf-log-entry wf-log-${entry.level}">
                    <span class="wf-log-time">${formatLogTime(entry.timestamp)}</span>
                    <span class="wf-log-icon">${getLogIcon(entry.level)}</span>
                    <span class="wf-log-message">${entry.message}</span>
                    ${entry.details ? html`
                      <span class="wf-log-details">${entry.details}</span>
                    ` : nothing}
                  </div>
                `)
            }
          </div>
        </div>
      ` : nothing}
    </div>
  `;
}

function renderWorkflowStep(step: WorkflowStep, index: number, total: number): ReturnType<typeof html> {
  const statusClass = `wf-step-${step.status}`;
  const duration = step.startTime && step.endTime 
    ? formatElapsedTime(step.endTime - step.startTime)
    : step.startTime 
      ? formatElapsedTime(Date.now() - step.startTime)
      : null;
  
  return html`
    <div class="wf-step ${statusClass}">
      <div class="wf-step-indicator">
        ${step.status === "running" 
          ? html`<span class="wf-step-spinner"></span>`
          : step.status === "complete"
            ? html`<span class="wf-step-check">${icons.check}</span>`
            : step.status === "error"
              ? html`<span class="wf-step-error">${icons.x}</span>`
              : html`<span class="wf-step-num">${index + 1}</span>`
        }
      </div>
      <div class="wf-step-content">
        <span class="wf-step-label">${step.label}</span>
        ${duration ? html`<span class="wf-step-duration">${duration}</span>` : nothing}
        ${step.error ? html`<span class="wf-step-error-msg">${step.error}</span>` : nothing}
      </div>
      ${step.status === "running" && step.progress > 0 ? html`
        <div class="wf-step-progress">
          <div class="wf-step-progress-fill" style="width: ${step.progress}%"></div>
        </div>
      ` : nothing}
    </div>
  `;
}

function formatElapsedTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${seconds}s`;
}

function formatLogTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function getLogIcon(level: WorkflowLogEntry["level"]): string {
  switch (level) {
    case "success": return "✓";
    case "warning": return "⚠";
    case "error": return "✕";
    default: return "•";
  }
}

// ═══════════════════════════════════════════════════════════════
// CHARACTERS PANEL - Uses shared Characters Library components
// ═══════════════════════════════════════════════════════════════

function renderProjectCharactersPanel(
  state: AppViewState,
  client: GatewayBrowserClient,
  project: StoryboardProject
): ReturnType<typeof html> {
  const cs = getCharactersState(state);
  
  // Build a set of character names already in project for quick lookup
  const projectCharNames = new Set(project.characters.map(c => c.name.toLowerCase()));
  
  // Split library characters into "in project" and "available to add"
  const inProject = cs.characters.filter(c => projectCharNames.has(c.name.toLowerCase()));
  const availableToAdd = cs.characters.filter(c => !projectCharNames.has(c.name.toLowerCase()));
  
  return html`
    <div class="sb-proj-chars">
      <!-- Section: Characters in Project -->
      <div class="sb-proj-chars-section">
        <div class="sb-proj-chars-header">
          <span class="sb-proj-chars-title"><span class="sb-icon-inline">${icons.checkCircle}</span> In This Project (${inProject.length})</span>
        </div>
        
        ${inProject.length > 0 ? html`
          <div class="sb-proj-chars-grid">
            ${inProject.map(char => renderProjectCharCard(state, client, char, project, true))}
          </div>
        ` : html`
          <div class="sb-proj-chars-empty">
            <span>No characters added yet</span>
            <span class="sb-proj-chars-hint">Add from library below ↓</span>
          </div>
        `}
      </div>
      
      <!-- Section: Available from Library -->
      <div class="sb-proj-chars-section">
        <div class="sb-proj-chars-header">
          <span class="sb-proj-chars-title"><span class="sb-icon-inline">${icons.book}</span> Character Library (${availableToAdd.length})</span>
        </div>
        
        ${availableToAdd.length > 0 ? html`
          <div class="sb-proj-chars-grid">
            ${availableToAdd.map(char => renderProjectCharCard(state, client, char, project, false))}
          </div>
        ` : html`
          <div class="sb-proj-chars-empty">
            <span>All library characters are in project</span>
          </div>
        `}
      </div>
      
      <!-- Quick Actions -->
      <div class="sb-proj-chars-actions">
        <button 
          class="sb-proj-chars-btn"
          @click=${() => { 
            openCharCreateDialog(state);
            state.requestUpdate?.();
          }}
        >
          <span>+</span> New Character
        </button>
      </div>
    </div>
  `;
}

// Render a character card for the project panel
// Uses same styling as sidebar but with add/remove actions
function renderProjectCharCard(
  state: AppViewState,
  client: GatewayBrowserClient,
  char: { id: string; name: string; slug: string; primaryImage: string | null; tags: string[]; imageCount: number },
  project: StoryboardProject,
  inProject: boolean
): ReturnType<typeof html> {
  const imgUrl = char.primaryImage ? getImageUrl(char.primaryImage, char.slug) : null;
  
  return html`
    <div class="sb-proj-char-card ${inProject ? 'in-project' : 'available'}">
      <!-- Image -->
      <div class="sb-proj-char-img-wrap">
        ${imgUrl ? html`
          <img 
            class="sb-proj-char-img" 
            src="${imgUrl}" 
            alt="${char.name}"
            @click=${() => {
              loadCharacter(state, client, char.slug);
              state.requestUpdate?.();
            }}
          />
        ` : html`
          <div class="sb-proj-char-placeholder">${icons.masks}</div>
        `}
        
        <!-- Status badge -->
        ${inProject ? html`
          <span class="sb-proj-char-badge sb-badge-in">${icons.check}</span>
        ` : html`
          <span class="sb-proj-char-badge sb-badge-add">+</span>
        `}
        
        <!-- Image count badge -->
        ${char.imageCount > 1 ? html`
          <span class="sb-proj-char-count">${char.imageCount}</span>
        ` : nothing}
        
        <!-- Hover overlay with actions -->
        <div class="sb-proj-char-overlay">
          <div class="sb-proj-char-actions">
            <button 
              class="sb-proj-char-action"
              title="View details"
              @click=${(e: Event) => {
                e.stopPropagation();
                loadCharacter(state, client, char.slug);
                state.requestUpdate?.();
              }}
            >${icons.eye}</button>

            ${inProject ? html`
              <button 
                class="sb-proj-char-action sb-action-remove"
                title="Remove from project"
                @click=${async (e: Event) => {
                  e.stopPropagation();
                  // Find the project character ref and remove it
                  const projChar = project.characters.find(c => c.name.toLowerCase() === char.name.toLowerCase());
                  if (projChar) {
                    await deleteCharacter(state, client, projChar.id, project.id);
                  }
                }}
              >${icons.x}</button>
            ` : html`
              <button 
                class="sb-proj-char-action sb-action-add"
                title="Add to project"
                @click=${async (e: Event) => {
                  e.stopPropagation();
                  await addLibraryCharacterToProject(state, client, char.id, project.id);
                }}
              >+</button>
            `}
          </div>
        </div>
      </div>
      
      <!-- Info -->
      <div class="sb-proj-char-info">
        <span class="sb-proj-char-name">${char.name}</span>
        <span class="sb-proj-char-meta">
          ${char.tags.slice(0, 2).join(', ')}${char.tags.length > 2 ? '...' : ''}
        </span>
      </div>
      
      <!-- Quick action button (visible on mobile/touch) -->
      <button 
        class="sb-proj-char-quick-btn ${inProject ? 'remove' : 'add'}"
        @click=${async (e: Event) => {
          e.stopPropagation();
          if (inProject) {
            const projChar = project.characters.find(c => c.name.toLowerCase() === char.name.toLowerCase());
            if (projChar) {
              await deleteCharacter(state, client, projChar.id, project.id);
            }
          } else {
            await addLibraryCharacterToProject(state, client, char.id, project.id);
          }
        }}
      >
        ${inProject ? html`${icons.x} Remove` : html`${icons.plus} Add`}
      </button>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════
// SCRIPT SECTION
// ═══════════════════════════════════════════════════════════════

function renderScriptSection(
  state: AppViewState,
  client: GatewayBrowserClient,
  project: StoryboardProject
): ReturnType<typeof html> {
  const sb = getStoryboardState(state);
  
  // Don't show if no script yet
  if (!project.script) {
    return html`
      <div class="sb-script-section sb-script-empty">
        <div class="sb-script-header">
          <h3><span class="sb-icon-inline">${icons.fileText}</span> Script</h3>
        </div>
        <div class="sb-script-placeholder">
          <p>No script yet. Click "Step 1: Generate Script" to create one based on your prompt.</p>
        </div>
      </div>
    `;
  }
  
  const isEditing = sb.editingScript;
  
  return html`
    <div class="sb-script-section">
      <div class="sb-script-header">
        <h3><span class="sb-icon-inline">${icons.fileText}</span> Script</h3>
        <div class="sb-script-actions">
          ${!isEditing ? html`
            <button class="sb-btn sb-btn-sm sb-btn-outline" @click=${() => startEditingScript(state, project.script || "")}>
              <span class="sb-btn-icon">${icons.edit}</span> Edit Script
            </button>
            ${project.scenes.length === 0 ? html`
              <button 
                class="sb-btn sb-btn-sm sb-btn-gold"
                ?disabled=${sb.pipelineRunning}
                @click=${() => splitScenesOnly(state, client, project.id)}
              >
                <span class="sb-btn-icon">${icons.scissors}</span> Split into Scenes
              </button>
            ` : html`
              <button 
                class="sb-btn sb-btn-sm sb-btn-outline"
                ?disabled=${sb.pipelineRunning}
                @click=${() => {
                  if (confirm("This will replace existing scenes. Continue?")) {
                    splitScenesOnly(state, client, project.id);
                  }
                }}
              >
                <span class="sb-btn-icon">${icons.refresh}</span> Re-split Scenes
              </button>
            `}
          ` : html`
            <button class="sb-btn sb-btn-sm sb-btn-gold" @click=${() => saveScript(state, client, project.id)}>
              <span class="sb-btn-icon">${icons.check}</span> Save Script
            </button>
            <button class="sb-btn sb-btn-sm sb-btn-ghost" @click=${() => cancelEditingScript(state)}>
              Cancel
            </button>
          `}
        </div>
      </div>
      
      <div class="sb-script-content">
        ${isEditing ? html`
          <textarea 
            class="sb-script-editor"
            .value=${sb.scriptDraft}
            @input=${(e: Event) => updateScriptDraft(state, (e.target as HTMLTextAreaElement).value)}
            rows="20"
            placeholder="Write your script here...

[SCENE 1: Title]
VISUAL: Description of what appears on screen
VOICEOVER: Narration text
DURATION: 5 seconds"
          ></textarea>
          <div class="sb-script-help">
            <p>Format each scene with:</p>
            <code>[SCENE X: Title]</code><br>
            <code>VISUAL: What appears on screen</code><br>
            <code>VOICEOVER: Narration text</code><br>
            <code>DURATION: X seconds</code>
          </div>
        ` : html`
          <pre class="sb-script-display">${project.script}</pre>
        `}
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════
// SCENES GRID
// ═══════════════════════════════════════════════════════════════

function renderScenesGrid(
  state: AppViewState,
  client: GatewayBrowserClient,
  project: StoryboardProject
): ReturnType<typeof html> {
  if (project.scenes.length === 0) {
    return html`
      <div class="sb-scenes-empty">
        <div class="sb-empty-icon">${icons.clapperboard}</div>
        <h3>No Scenes Yet</h3>
        <p>Click "Generate All" to create the storyboard</p>
      </div>
    `;
  }
  
  return html`
    <div class="sb-scenes-section">
      <div class="sb-scenes-header">
        <h3>Scenes (${project.scenes.length})</h3>
        <div class="sb-scenes-actions">
          <button 
            class="sb-btn sb-btn-sm sb-btn-outline"
            @click=${() => regenerateScenes(state, client, project.id)}
          >
            <span class="sb-btn-icon">${icons.refresh}</span> Re-split
          </button>
          <button
            class="sb-btn sb-btn-sm sb-btn-outline"
            @click=${() => gatedGenerateAll(state, client, project, "image")}
          >
            <span class="sb-btn-icon">${icons.image}</span> Generate Missing
          </button>
        </div>
      </div>
      
      <div class="sb-scenes-grid">
        ${project.scenes.map(scene => renderSceneCard(state, client, project, scene))}
      </div>
    </div>
  `;
}

function renderSceneCard(
  state: AppViewState,
  client: GatewayBrowserClient,
  project: StoryboardProject,
  scene: Scene
): ReturnType<typeof html> {
  const sb = getStoryboardState(state);
  const isEditing = sb.editingSceneId === scene.id;
  const isHovered = sb.videoHoveredSceneIndex === scene.index;
  const isActive = sb.videoCurrentTime > 0 && 
    sb.videoCurrentTime >= getSceneStartTime(state, scene.index) &&
    sb.videoCurrentTime < getSceneStartTime(state, scene.index) + scene.durationSeconds;
  const isGenerating = sb.generatingSceneIds.has(scene.id) || scene.imageStatus === "generating";
  
  return html`
    <div 
      class="sb-scene-card ${scene.imageStatus} ${isHovered ? 'timeline-hover' : ''} ${isActive ? 'timeline-active' : ''} ${isGenerating ? 'generating-active' : ''}"
      @mouseenter=${() => setVideoHoveredScene(state, scene.index)}
      @mouseleave=${() => setVideoHoveredScene(state, null)}
    >
      <div class="sb-scene-number">${scene.index + 1}</div>
      
      <div class="sb-scene-image" @click=${scene.imageUrl ? (e: Event) => {
        e.stopPropagation();
        openImagePreview(state, scene.id, scene.imageUrl!);
      } : null} style="${scene.imageUrl ? 'cursor: pointer;' : ''}">
        ${scene.imageUrl ? html`
          <img src="${scene.imageUrl}" alt="${scene.title}" title="Click to preview" />
        ` : html`
          <div class="sb-scene-placeholder ${scene.imageStatus} ${isGenerating ? 'generating-anim' : ''}">
            ${isGenerating ? html`
              <div class="sb-gen-animation">
                <div class="sb-gen-pulse"></div>
                <div class="sb-gen-ring"></div>
                <span class="sb-gen-icon">${icons.palette}</span>
              </div>
              <span class="sb-gen-text">Generating...</span>
            ` : scene.imageStatus === "failed" ? html`
              <span class="sb-error-icon">${icons.alertCircle}</span>
              <span>Generation Failed</span>
              ${scene.imageError ? html`
                <span class="sb-scene-error" title="${scene.imageError}">
                  ${scene.imageError.length > 140 ? scene.imageError.slice(0, 137) + "…" : scene.imageError}
                </span>
              ` : nothing}
              <button
                class="sb-retry-btn"
                @click=${(e: Event) => {
                  e.stopPropagation();
                  regenerateSceneImage(state, client, scene.id, project.imageBackend);
                }}
              >
                <span class="sb-btn-icon">${icons.refresh}</span> Retry
              </button>
            ` : html`
              <span class="sb-pending-icon">${icons.image}</span>
              <span>Pending</span>
            `}
          </div>
        `}
        
        <div class="sb-scene-overlay">
          <button
            class="sb-scene-btn"
            @click=${() => openRegenerateModal(state, scene.id, client)}
          >
            <span class="sb-btn-icon">${icons.refresh}</span> Regenerate
          </button>
        </div>
      </div>
      
      <div class="sb-scene-content">
        <div class="sb-scene-title">${scene.title}</div>
        <div class="sb-scene-duration">${formatDuration(scene.durationSeconds)}</div>
        <p class="sb-scene-description">${scene.description.slice(0, 100)}...</p>
        
        ${scene.voiceover ? html`
          <div class="sb-scene-voiceover">
            <span class="sb-vo-icon">${icons.voiceover}</span>
            <span class="sb-vo-text">${scene.voiceover.slice(0, 50)}...</span>
          </div>
        ` : nothing}
      </div>
      
      <div class="sb-scene-actions">
        <button 
          class="sb-scene-action"
          @click=${() => openSceneEditor(state, scene.id)}
        >
          <span class="sb-btn-icon">${icons.edit}</span> Edit
        </button>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════
// SETTINGS PANEL
// ═══════════════════════════════════════════════════════════════

function renderSettingsPanel(
  state: AppViewState,
  client: GatewayBrowserClient,
  project: StoryboardProject
): ReturnType<typeof html> {
  const sb = getStoryboardState(state);
  
  // ComfyUI models come from the local server and are populated dynamically
  // into sb.localApiModels at runtime via fetchLocalApiModels().
  const localModels = sb.localApiModels.map(m => ({
    id: m.id,
    name: m.name,
    backend: "local" as const,
    badge: m.type || "",
    icon: "🎨",
  }));
  
  return html`
    <div class="sb-settings-panel">
      <!-- Image Generation Settings -->
      <div class="sb-settings-section sb-settings-hero">
        <div class="sb-settings-header">
          <span class="sb-settings-icon">${icons.image}</span>
          <h3>Image Generation</h3>
        </div>
        
        <!-- Backend Selection -->
        <div class="sb-settings-group">
          <label class="sb-settings-label">Generation Backend</label>
          <div class="sb-backend-grid">
            ${BACKEND_OPTIONS.map(opt => html`
              <button 
                class="sb-backend-card ${project.imageBackend === opt.id ? 'selected' : ''}"
                @click=${async () => {
                  await client.call("storyboard.update", { 
                    id: project.id, 
                    imageBackend: opt.id 
                  });
                  await loadProjects(state, client);
                }}
              >
                <span class="sb-backend-icon">${opt.icon}</span>
                <div class="sb-backend-info">
                  <span class="sb-backend-name">${opt.label}</span>
                  <span class="sb-backend-desc">Local ComfyUI server (default :8899)</span>
                </div>
                ${project.imageBackend === opt.id ? html`<span class="sb-check">${icons.check}</span>` : nothing}
              </button>
            `)}
          </div>
        </div>
        
        <!-- Model Selection based on Backend -->
        <div class="sb-settings-group">
          <label class="sb-settings-label">Model</label>
          ${project.imageBackend === 'local' ? html`
            ${localModels.length > 0 ? html`
              <div class="sb-model-grid">
                ${localModels.map(model => html`
                  <button
                    class="sb-model-card ${sb.regenerateModel === model.id ? 'selected' : ''}"
                    @click=${() => selectRegenerateModel(state, model.id)}
                  >
                    <span class="sb-model-icon">${model.icon}</span>
                    <span class="sb-model-name">${model.name}</span>
                    ${model.badge ? html`<span class="sb-model-badge">${model.badge}</span>` : nothing}
                  </button>
                `)}
              </div>
            ` : html`
              <p class="sb-help-text">
                No ComfyUI checkpoints found. Start ComfyUI (default <code>http://127.0.0.1:8000</code>) and refresh.
              </p>
            `}
          ` : nothing}
        </div>
        
        <!-- Image Style -->
        <div class="sb-settings-group">
          <label class="sb-settings-label">Image Style</label>
          <div class="sb-style-grid">
            ${STYLE_OPTIONS.map(opt => html`
              <button 
                class="sb-style-chip ${project.imageStyle === opt.id ? 'selected' : ''}"
                @click=${async () => {
                  await client.call("storyboard.update", { 
                    id: project.id, 
                    imageStyle: opt.id 
                  });
                  await loadProjects(state, client);
                }}
              >
                ${opt.label}
              </button>
            `)}
          </div>
        </div>
      </div>
      
      <!-- Audio Settings -->
      <div class="sb-settings-section">
        <div class="sb-settings-header">
          <span class="sb-settings-icon">${icons.voiceover}</span>
          <h3>Voice & Audio</h3>
        </div>
        
        <div class="sb-settings-row-grid">
          <div class="sb-settings-group">
            <label class="sb-settings-label">TTS Provider</label>
            <div class="sb-provider-cards">
              <button 
                class="sb-provider-card ${project.ttsProvider === 'elevenlabs' ? 'selected' : ''}"
                @click=${async () => {
                  await client.call("storyboard.update", { id: project.id, ttsProvider: 'elevenlabs' });
                  await loadProjects(state, client);
                }}
              >
                <span class="sb-provider-icon">${icons.mic}</span>
                <span class="sb-provider-name">ElevenLabs</span>
                <span class="sb-provider-tag sb-tag-pro">Pro</span>
              </button>
              <button 
                class="sb-provider-card ${project.ttsProvider === 'edge' ? 'selected' : ''}"
                @click=${async () => {
                  await client.call("storyboard.update", { id: project.id, ttsProvider: 'edge' });
                  await loadProjects(state, client);
                }}
              >
                <span class="sb-provider-icon">${icons.globe}</span>
                <span class="sb-provider-name">Edge TTS</span>
                <span class="sb-provider-tag sb-tag-free">Free</span>
              </button>
            </div>
          </div>
          
          <div class="sb-settings-group">
            <label class="sb-settings-label">Voice</label>
            ${project.ttsProvider === 'edge' ? html`
              <select 
                class="sb-select sb-select-lg"
                .value=${project.ttsVoice}
                @change=${async (e: Event) => {
                  const value = (e.target as HTMLSelectElement).value;
                  await client.call("storyboard.update", { id: project.id, ttsVoice: value });
                  await loadProjects(state, client);
                }}
              >
                ${THAI_EDGE_VOICES.map(v => html`
                  <option value=${v.id}>${v.name}</option>
                `)}
              </select>
            ` : html`
              <div class="sb-elevenlabs-hint">
                <span class="sb-hint-icon">${icons.sparkles}</span>
                <span>Configure voice cloning and settings in the Voices panel</span>
              </div>
            `}
          </div>
        </div>
      </div>
      
      <!-- Project Settings -->
      <div class="sb-settings-section">
        <div class="sb-settings-header">
          <span class="sb-settings-icon">${icons.sliders}</span>
          <h3>Project Settings</h3>
        </div>
        
        <div class="sb-settings-row-grid sb-settings-3col">
          <div class="sb-settings-group">
            <label class="sb-settings-label">Duration</label>
            <div class="sb-duration-control">
              <button 
                class="sb-duration-btn"
                @click=${async () => {
                  const newVal = Math.max(1, project.targetDuration - 1);
                  await client.call("storyboard.update", { id: project.id, targetDuration: newVal });
                  await loadProjects(state, client);
                }}
              >−</button>
              <span class="sb-duration-value">${project.targetDuration} min</span>
              <button 
                class="sb-duration-btn"
                @click=${async () => {
                  const newVal = Math.min(30, project.targetDuration + 1);
                  await client.call("storyboard.update", { id: project.id, targetDuration: newVal });
                  await loadProjects(state, client);
                }}
              >+</button>
            </div>
          </div>
          
          <div class="sb-settings-group">
            <label class="sb-settings-label">Platform</label>
            <div class="sb-platform-grid">
              ${PLATFORM_OPTIONS.map(opt => html`
                <button 
                  class="sb-platform-chip ${project.platform === opt.id ? 'selected' : ''}"
                  @click=${async () => {
                    await client.call("storyboard.update", { id: project.id, platform: opt.id });
                    await loadProjects(state, client);
                  }}
                  title="${opt.label}"
                >
                  ${opt.icon}
                </button>
              `)}
            </div>
          </div>
          
          <div class="sb-settings-group">
            <label class="sb-settings-label">Aspect Ratio</label>
            <div class="sb-aspect-options">
              ${[
                { id: '16:9', label: '16:9', icon: '▬' },
                { id: '9:16', label: '9:16', icon: '▮' },
                { id: '1:1', label: '1:1', icon: '■' },
              ].map(opt => html`
                <button 
                  class="sb-aspect-chip ${project.aspectRatio === opt.id ? 'selected' : ''}"
                  @click=${async () => {
                    await client.call("storyboard.update", { id: project.id, aspectRatio: opt.id });
                    await loadProjects(state, client);
                  }}
                >
                  <span class="sb-aspect-icon">${opt.icon}</span>
                  <span>${opt.label}</span>
                </button>
              `)}
            </div>
          </div>
        </div>
      </div>
      
      <!-- Danger Zone -->
      <div class="sb-settings-section sb-settings-danger">
        <div class="sb-settings-header">
          <span class="sb-settings-icon">${icons.alert}</span>
          <h3>Danger Zone</h3>
        </div>
        <div class="sb-danger-actions">
          <button 
            class="sb-btn sb-btn-danger-outline"
            @click=${async () => {
              if (confirm("This will regenerate ALL images. Continue?")) {
                await generateAllImages(state, client, project.id);
              }
            }}
          >
            ${icons.refresh} Regenerate All Images
          </button>
          <button 
            class="sb-btn sb-btn-danger-outline"
            @click=${async () => {
              if (confirm("This will regenerate the script. Continue?")) {
                await regenerateScript(state, client, project.id);
              }
            }}
          >
            ${icons.penLine} Regenerate Script
          </button>
          <button 
            class="sb-btn sb-btn-danger"
            @click=${() => {
              if (confirm("Delete this project? This cannot be undone.")) {
                deleteProject(state, client, project.id);
              }
            }}
          >
            ${icons.trash} Delete Project
          </button>
        </div>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════
// EMPTY STATE
// ═══════════════════════════════════════════════════════════════

function renderEmptyState(state: AppViewState, client: GatewayBrowserClient): ReturnType<typeof html> {
  const sb = getStoryboardState(state);
  const noBackends = sb.availableBackends.length === 0;
  return html`
    <div class="sb-empty-state">
      ${noBackends ? html`
        <div class="sb-setup-card" role="alert">
          <div class="sb-setup-card-icon">${icons.alertCircle}</div>
          <div class="sb-setup-card-body">
            <div class="sb-setup-card-title">ComfyUI not reachable</div>
            <p class="sb-setup-card-text">
              Storyboard generates images through your local ComfyUI server.
              Default URL is <code>http://127.0.0.1:8000</code>. If yours
              binds elsewhere, set
              <code>localStorage.comfyuiUrl</code> in the browser (or
              <code>COMFY_URL</code> on the gateway), then refresh. See
              <code>docs/storyboard.md</code> for full setup.
            </p>
          </div>
        </div>
      ` : nothing}
      <div class="sb-empty-icon-large">${icons.clapperboard}</div>
      <h2>Select a Project</h2>
      <p>Choose a project from the sidebar or create a new one</p>
      <button
        class="sb-btn sb-btn-gold sb-btn-lg"
        @click=${() => openCreateDialog(state, client)}
      >
        <span class="sb-btn-icon">${icons.plus}</span> Create New Storyboard
      </button>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════
// CREATE DIALOG
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// MODE CHOOSER — Compact horizontal segmented control
// ═══════════════════════════════════════════════════════════════

const GENERATION_MODES = [
  { id: "image" as const, label: "Image", icon: "🖼️", desc: "Generate a single mood-board image from your prompt." },
  { id: "video" as const, label: "Video", icon: "🎬", desc: "Full video ad — script, scenes, voiceover, export." },
  { id: "sequential" as const, label: "Sequential", icon: "📜", desc: "Multi-scene storyboard, step-by-step. Recommended." },
  { id: "timeline-prompting" as const, label: "Timeline Prompting", icon: "⏱️", desc: "Per-second beat sheet for long-form control." },
  { id: "recreate" as const, label: "Recreate", icon: "🔄", desc: "Upload a reference image/video to recreate its style." },
];

const MODE_PLACEHOLDERS: Record<string, string> = {
  image: "A cinematic mood board for a calm shea-butter brand…",
  video: "30s product reveal ad for a luxury skincare line starring a confident founder…",
  sequential: "5-scene tutorial for a new product with the founder demonstrating each step…",
  "timeline-prompting": "10s hook: 0–2s founder opens box, 3–6s reveal product, 7–10s tagline…",
  recreate: "", // textarea hidden — source picker visible
};

type GenerationMode = "image" | "video" | "sequential" | "timeline-prompting" | "recreate";

function renderCreateDialog(state: AppViewState, client: GatewayBrowserClient): ReturnType<typeof html> {
  const sb = getStoryboardState(state);
  const form = sb.createForm;
  const mode = form.generationMode as GenerationMode;
  const isRecreate = mode === "recreate";
  const cs = getCharactersState(state);
  
  // Collect bound slot characters and their images
  const boundSlots = [
    { key: "lead" as const, label: "Lead", value: form.characterSlotLead },
    { key: "supporting" as const, label: "Supporting", value: form.characterSlotSupporting },
    { key: "cameo" as const, label: "Cameo", value: form.characterSlotCameo },
  ];
  
  const getCharImage = (name: string | null): string | null => {
    if (!name) return null;
    const found = cs.characters.find(c => c.name.toLowerCase() === name.toLowerCase());
    return found?.primaryImage ? getImageUrl(found.primaryImage, found.slug) : null;
  };

  const canGenerate = isRecreate ? true : form.prompt.trim().length > 0;

  // Cost preview: use mode-based defaults
  const costLabel = mode === "video" ? "~$0.40/beat" : mode === "timeline-prompting" ? "Pay-per-second" : "Free / Local";

  return html`
    <div class="sb-modal-overlay" @click=${() => closeCreateDialog(state)}>
      <div class="sb-modal sb-modal-wide" @click=${(e: Event) => e.stopPropagation()}>
        <div class="sb-modal-header">
          <h2>Start a storyboard from a prompt</h2>
          <button class="sb-modal-close" @click=${() => closeCreateDialog(state)}>${icons.x}</button>
        </div>
        
        <div class="sb-modal-body">
          <!-- ── Mode segmented control ── -->
          <div class="sb-form-group">
            <label>Generation Mode</label>
            <div class="sb-mode-segmented">
              ${GENERATION_MODES.map(m => html`
                <button
                  class="sb-mode-seg-btn ${mode === m.id ? 'active' : ''}"
                  @click=${() => setCreateGenerationMode(state, m.id)}
                  title=${m.desc}
                >
                  <span class="sb-mode-seg-icon">${m.icon}</span>
                  <span class="sb-mode-seg-label">${m.label}</span>
                </button>
              `)}
            </div>
            <div class="sb-mode-desc">${GENERATION_MODES.find(m => m.id === mode)?.desc || ""}</div>
          </div>
          
          <!-- ── Project name ── -->
          <div class="sb-form-group">
            <label>Project Name <span class="sb-label-hint">(optional — auto-generated from prompt)</span></label>
            <input
              type="text"
              class="sb-input"
              placeholder="My Awesome Video"
              .value=${form.name}
              @input=${(e: Event) => updateCreateForm(state, "name", (e.target as HTMLInputElement).value)}
            />
          </div>

          <!-- ── Prompt textarea (hidden in Recreate mode) ── -->
          ${isRecreate ? nothing : html`
            <div class="sb-form-group">
              <label>Prompt</label>
              <mention-input-fallback
                .value=${form.prompt}
                .placeholder=${MODE_PLACEHOLDERS[mode] || "Describe your video concept..."}
                .rows=${5}
                field="prompt"
                @value-changed=${(e: CustomEvent) => updateCreateForm(state, "prompt", e.detail.value)}
              ></mention-input-fallback>
              ${form.prompt ? html`
                <div class="sb-prompt-mention-hint">
                  ${icons.sparkles} Tip: type <code>@lead</code>, <code>@supporting</code>, or <code>@cameo</code> to reference bound characters in your prompt.
                </div>
              ` : nothing}
            </div>
          `}

          <!-- ── Recreate mode: source picker ── -->
          ${isRecreate ? html`
            <div class="sb-form-group">
              <label>Source Image / Video URL</label>
              <div class="sb-recreate-source">
                <input
                  type="text"
                  class="sb-input"
                  placeholder="https://example.com/reference.mp4 or paste local path…"
                  @input=${(e: Event) => updateCreateForm(state, "prompt", (e.target as HTMLInputElement).value)}
                />
                <span class="sb-recreate-hint">Paste a URL or drag-and-drop a reference file here.</span>
              </div>
              <!-- Optional context note -->
              <textarea
                class="sb-textarea"
                rows="2"
                placeholder="Optional: add context notes (e.g. 'keep the lighting and color grade but make it cyberpunk')"
                style="margin-top: 8px;"
                @input=${(e: Event) => {/* context-only: stored in prompt but treated as optional */}}
              ></textarea>
            </div>
          ` : nothing}

          <!-- ── Character slot row ── -->
          <div class="sb-form-group">
            <label>Character Slots</label>
            <div class="sb-slot-row">
              ${boundSlots.map(slot => {
                const img = getCharImage(slot.value);
                return html`
                  <div class="sb-slot-chip ${slot.value ? 'filled' : 'empty'}">
                    <span class="sb-slot-label">${slot.label}</span>
                    ${slot.value ? html`
                      ${img ? html`<img class="sb-slot-thumb" src=${img} alt=${slot.value} />` : nothing}
                      <span class="sb-slot-name">${slot.value}</span>
                      <button
                        class="sb-slot-clear"
                        @click=${() => bindCharacterSlot(state, slot.key, null)}
                        title="Remove"
                      >${icons.x}</button>
                    ` : html`
                      <span class="sb-slot-placeholder">—</span>
                    `}
                    <button
                      class="sb-slot-pick"
                      @click=${() => openSlotPicker(state, slot.key)}
                      title="Pick character"
                    >+</button>
                  </div>
                `;
              })}
            </div>
          </div>

          <!-- ── Asset + Location quick-add row ── -->
          <div class="sb-form-group">
            <div class="sb-extras-row">
              ${form.assetChip ? html`
                <span class="sb-extra-chip">
                  ${icons.folder} ${form.assetChip}
                  <button class="sb-extra-clear" @click=${() => setAssetChip(state, null)}>${icons.x}</button>
                </span>
              ` : html`
                <button class="sb-extra-btn" @click=${() => openAssetPicker(state)} title="Add product/prop asset">
                  + Asset
                </button>
              `}
              ${form.locationChip ? html`
                <span class="sb-extra-chip">
                  ${icons.target} ${form.locationChip}
                  <button class="sb-extra-clear" @click=${() => setLocationChip(state, null)}>${icons.x}</button>
                </span>
              ` : html`
                <button class="sb-extra-btn" @click=${() => openLocationPicker(state)} title="Add location">
                  + Location
                </button>
              `}
            </div>
          </div>

          <!-- ── Cost preview chip ── -->
          <div class="sb-cost-preview">
            <span class="sb-cost-icon">${icons.dollarSign}</span>
            <span class="sb-cost-text">Est. cost: <strong>${costLabel}</strong></span>
            <span class="sb-cost-mode">· ${GENERATION_MODES.find(m => m.id === mode)?.label} mode</span>
          </div>

          <!-- ── Advanced settings (collapsible) ── -->
          <details class="sb-advanced-toggle">
            <summary class="sb-advanced-summary">
              <span>${icons.settings} Advanced settings</span>
              <span class="sb-advanced-hint">Platform, duration, style, model, language</span>
            </summary>
            <div class="sb-advanced-body">
              <!-- Language & TTS -->
              <div class="sb-form-row">
                <div class="sb-form-group">
                  <label>Language <span class="sb-label-hint">(script & voiceover)</span></label>
                  <div class="sb-select-grid sb-select-grid-2">
                    ${LANGUAGE_OPTIONS.map(opt => html`
                      <button 
                        class="sb-select-btn sb-lang-btn ${form.language === opt.id ? 'selected' : ''}"
                        @click=${() => updateCreateForm(state, "language", opt.id)}
                      >
                        <span class="sb-select-icon">${opt.flag}</span>
                        <span>${opt.label}</span>
                      </button>
                    `)}
                  </div>
                </div>
                <div class="sb-form-group">
                  <label>TTS Voice</label>
                  ${form.language === "th" ? html`
                    <div class="sb-voice-select">
                      <select class="sb-input" .value=${form.ttsVoice}
                        @change=${(e: Event) => updateCreateForm(state, "ttsVoice", (e.target as HTMLSelectElement).value)}>
                        ${THAI_EDGE_VOICES.map(v => html`<option value="${v.id}">${v.name} (${v.gender})</option>`)}
                      </select>
                      <span class="sb-voice-provider">Edge TTS • Free</span>
                    </div>
                  ` : html`
                    <div class="sb-voice-select">
                      <span class="sb-elevenlabs-info"><span class="sb-info-icon">${icons.mic}</span><span>ElevenLabs voices configured in Voices panel</span></span>
                    </div>
                  `}
                </div>
              </div>

              <!-- Platform & Duration -->
              <div class="sb-form-row">
                <div class="sb-form-group">
                  <label>Platform <span class="sb-label-hint">(sets aspect ratio)</span></label>
                  <div class="sb-select-grid">
                    ${PLATFORM_OPTIONS.map(opt => html`
                      <button class="sb-select-btn ${form.platform === opt.id ? 'selected' : ''}"
                        @click=${() => updateCreateForm(state, "platform", opt.id)}>
                        <span class="sb-select-icon">${opt.icon}</span><span>${opt.label}</span>
                        <span class="sb-select-ratio">${opt.aspectRatio}</span>
                      </button>
                    `)}
                  </div>
                </div>
                <div class="sb-form-group">
                  <label>Duration (minutes)</label>
                  <input type="number" class="sb-input" min="0.25" max="60" step="0.5"
                    .value=${String(form.targetDuration)}
                    @input=${(e: Event) => updateCreateForm(state, "targetDuration", parseFloat((e.target as HTMLInputElement).value))}
                  />
                  <div class="sb-aspect-display">${icons.crop} Aspect Ratio: <strong>${form.aspectRatio}</strong></div>
                </div>
              </div>

              <!-- Visual Style -->
              <div class="sb-form-row">
                <div class="sb-form-group">
                  <label>Visual Style</label>
                  <div class="sb-select-grid sb-select-grid-4">
                    ${STYLE_OPTIONS.map(opt => html`
                      <button class="sb-select-btn ${form.imageStyle === opt.id ? 'selected' : ''}"
                        @click=${() => updateCreateForm(state, "imageStyle", opt.id)}>
                        <span class="sb-select-icon">${opt.icon}</span><span>${opt.label}</span>
                      </button>
                    `)}
                  </div>
                </div>
              </div>

              <!-- Image Generation Model -->
              <div class="sb-form-group">
                <label>Image Generation Model</label>
                ${sb.localApiAvailable && sb.localApiModels.length > 0 ? html`
                  <div class="sb-model-group">
                    <div class="sb-model-group-header">
                      <span class="sb-model-icon">${icons.palette}</span><span>ComfyUI</span>
                      <span class="sb-model-badge sb-badge-fast">On-device</span>
                    </div>
                    <div class="sb-model-options-row">
                      ${sb.localApiModels.map(model => html`
                        <button class="sb-model-btn ${form.imageModel === model.id ? 'selected' : ''}"
                          @click=${() => updateCreateForm(state, "imageModel", model.id)}>
                          <span class="sb-model-name">${model.name}</span>
                          ${model.type ? html`<span class="sb-model-tag">${model.type}</span>` : nothing}
                        </button>
                      `)}
                    </div>
                  </div>
                ` : html`
                  <p class="sb-help-text">No ComfyUI checkpoints found. Start ComfyUI on the configured URL (default <code>http://127.0.0.1:8000</code>) and reopen this dialog.</p>
                `}
              </div>

              <!-- Character Library selector (original multi-select for project binding) -->
              ${cs.characters.length > 0 ? html`
                <div class="sb-form-group">
                  <label>Project Characters <span class="sb-label-hint">(from Character Library)</span></label>
                  <div class="sb-char-select-grid">
                    ${cs.characters.map(char => {
                      const imgUrl = getImageUrl(char.primaryImage, char.slug);
                      return html`
                        <button class="sb-char-select-btn ${sb.selectedCharacterIds.includes(char.id) ? 'selected' : ''}"
                          @click=${() => toggleCharacterSelection(state, char.id)} title="${char.name}">
                          ${imgUrl ? html`
                            <img class="sb-char-select-img" src="${imgUrl}" alt="${char.name}"
                              @error=${(e: Event) => { const img = e.target as HTMLImageElement; img.style.display = 'none'; (img.nextElementSibling as HTMLElement)?.classList.remove('sb-hidden'); }}/>
                            <span class="sb-char-select-fallback sb-hidden">${char.name.charAt(0)}</span>
                          ` : html`<span class="sb-char-select-fallback">${char.name.charAt(0)}</span>`}
                          <span class="sb-char-select-name">${char.name}</span>
                          ${sb.selectedCharacterIds.includes(char.id) ? html`<span class="sb-char-select-check">${icons.check}</span>` : nothing}
                        </button>
                      `;
                    })}
                  </div>
                  ${sb.selectedCharacterIds.length > 0 ? html`
                    <div class="sb-char-selected-count">${sb.selectedCharacterIds.length} character${sb.selectedCharacterIds.length > 1 ? 's' : ''} selected</div>
                  ` : nothing}
                </div>
              ` : html`
                <div class="sb-form-group">
                  <label>Characters <span class="sb-label-hint">(optional)</span></label>
                  <div class="sb-char-empty-hint"><span>${icons.masks}</span> No characters in library. Create one from the sidebar.</div>
                </div>
              `}
            </div>
          </details>
        </div>
        
        <div class="sb-modal-footer">
          ${!canGenerate ? html`
            <span class="sb-footer-hint">${icons.alert} Enter a prompt${isRecreate ? " or paste a source URL" : ""} to create project</span>
          ` : nothing}
          <button class="sb-btn sb-btn-ghost" @click=${() => closeCreateDialog(state)}>Cancel</button>
          <button class="sb-btn sb-btn-gold" ?disabled=${!canGenerate}
            @click=${() => createProject(state, client)}>
            ${icons.sparkles} Create Project
          </button>
        </div>
      </div>
    </div>
  `;
}

// ── Helper: open a quick name-picker for character slot binding ──
function openSlotPicker(state: AppViewState, slot: "lead" | "supporting" | "cameo"): void {
  const cs = getCharactersState(state);
  const names = cs.characters.map(c => c.name);
  const current = state.storyboard?.createForm
    ? (slot === "lead" ? state.storyboard.createForm.characterSlotLead
        : slot === "supporting" ? state.storyboard.createForm.characterSlotSupporting
        : state.storyboard.createForm.characterSlotCameo)
    : null;
  const promptText = current
    ? `Character "${current}" is bound to ${slot}. Type a new name (or blank to clear):`
    : `Pick a character name for "${slot}":\nAvailable: ${names.join(", ") || "(none)"}`;
  const input = prompt(promptText, current || "");
  if (input !== null) {
    const trimmed = input.trim();
    bindCharacterSlot(state, slot, trimmed || null);
  }
}

// ── Helpers: simple text-prompt pickers for asset and location ──
function openAssetPicker(state: AppViewState): void {
  const input = prompt("Enter asset name (product, prop, object):");
  if (input !== null) {
    setAssetChip(state, input.trim() || null);
  }
}

function openLocationPicker(state: AppViewState): void {
  const input = prompt("Enter location name:");
  if (input !== null) {
    setLocationChip(state, input.trim() || null);
  }
}

// ═══════════════════════════════════════════════════════════════
// CHARACTER DIALOG
// ═══════════════════════════════════════════════════════════════

function renderCharacterDialog(
  state: AppViewState,
  client: GatewayBrowserClient,
  projectId: string
): ReturnType<typeof html> {
  const sb = getStoryboardState(state);
  const form = sb.characterForm;
  const isEditing = !!sb.editingCharacterId;
  
  return html`
    <div class="sb-modal-overlay" @click=${() => closeCharacterDialog(state)}>
      <div class="sb-modal sb-modal-sm" @click=${(e: Event) => e.stopPropagation()}>
        <div class="sb-modal-header">
          <h2>${isEditing ? "Edit Character" : "Add Character"}</h2>
          <button class="sb-modal-close" @click=${() => closeCharacterDialog(state)}>${icons.x}</button>
        </div>
        
        <div class="sb-modal-body">
          <div class="sb-form-group">
            <label>Name</label>
            <input 
              type="text"
              class="sb-input"
              placeholder="Character name"
              .value=${form.name}
              @input=${(e: Event) => updateCharacterForm(state, "name", (e.target as HTMLInputElement).value)}
            />
          </div>
          
          <div class="sb-form-group">
            <label>Description</label>
            <textarea 
              class="sb-textarea"
              rows="3"
              placeholder="Physical appearance, clothing, distinguishing features..."
              .value=${form.description}
              @input=${(e: Event) => updateCharacterForm(state, "description", (e.target as HTMLTextAreaElement).value)}
            ></textarea>
          </div>
          
          <div class="sb-form-group">
            <label>Style Tokens (optional)</label>
            <input 
              type="text"
              class="sb-input"
              placeholder="e.g., anime style, pixar-like, realistic"
              .value=${form.styleTokens}
              @input=${(e: Event) => updateCharacterForm(state, "styleTokens", (e.target as HTMLInputElement).value)}
            />
          </div>
          
          <div class="sb-form-group">
            <label>Reference Image URL (optional)</label>
            <input 
              type="url"
              class="sb-input"
              placeholder="https://... or /media/..."
              .value=${form.referenceImageUrl}
              @input=${(e: Event) => updateCharacterForm(state, "referenceImageUrl", (e.target as HTMLInputElement).value)}
            />
            ${form.referenceImageUrl ? html`
              <div class="sb-char-preview">
                <img 
                  src="${form.referenceImageUrl}" 
                  alt="Preview"
                  @error=${(e: Event) => {
                    const img = e.target as HTMLImageElement;
                    img.style.display = 'none';
                  }}
                />
              </div>
            ` : nothing}
          </div>
          
          <div class="sb-form-group">
            <label>Color</label>
            <input 
              type="color"
              class="sb-color-input"
              .value=${form.color}
              @input=${(e: Event) => updateCharacterForm(state, "color", (e.target as HTMLInputElement).value)}
            />
          </div>
        </div>
        
        <div class="sb-modal-footer">
          <button class="sb-btn sb-btn-ghost" @click=${() => closeCharacterDialog(state)}>
            Cancel
          </button>
          <button 
            class="sb-btn sb-btn-gold"
            ?disabled=${!form.name || !form.description}
            @click=${() => saveCharacter(state, client, projectId)}
          >
            ${isEditing ? "Save Changes" : "Add Character"}
          </button>
        </div>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════
// VIDEO PREVIEW WITH TIMELINE
// ═══════════════════════════════════════════════════════════════

function renderVideoPreview(
  state: AppViewState,
  client: GatewayBrowserClient,
  project: StoryboardProject
): ReturnType<typeof html> {
  const sb = getStoryboardState(state);
  
  // Calculate total duration and scene positions
  const totalDuration = project.scenes.reduce((sum, s) => sum + s.durationSeconds, 0);
  
  // Check for video file - look for common patterns
  const possibleVideoUrl = gatewayHttpUrl(`/media/storyboard/${project.id}/video.mp4`);
  
  return html`
    <div class="sb-video-preview">
      <div class="sb-video-header">
        <h3><span class="sb-icon-inline">${icons.video}</span> Video Preview</h3>
        <div class="sb-video-effects-toolbar">
          <!-- Motion Effects -->
          <select 
            class="sb-effects-select sb-select-motion"
            title="Motion Effects"
            @change=${(e: Event) => {
              const effect = (e.target as HTMLSelectElement).value;
              if (effect) {
                applyEffectToAllScenes(state, client, project.id, effect as EffectPreset);
                (e.target as HTMLSelectElement).value = "";
              }
            }}
          >
            <option value="">Motion...</option>
            ${MOTION_PRESETS.map(preset => html`
              <option value="${preset.id}">${preset.icon} ${preset.label}</option>
            `)}
          </select>
          
          <!-- Transition Effects -->
          <select 
            class="sb-effects-select sb-select-transition"
            title="Transition Effects"
            @change=${(e: Event) => {
              const effect = (e.target as HTMLSelectElement).value;
              if (effect) {
                applyEffectToAllScenes(state, client, project.id, effect as EffectPreset);
                (e.target as HTMLSelectElement).value = "";
              }
            }}
          >
            <option value="">Transitions...</option>
            ${TRANSITION_PRESETS.map(preset => html`
              <option value="${preset.id}">${preset.icon} ${preset.label}</option>
            `)}
          </select>
          
          <!-- Overlay Effects -->
          <select 
            class="sb-effects-select sb-select-overlay"
            title="Overlay Effects"
            @change=${(e: Event) => {
              const effect = (e.target as HTMLSelectElement).value;
              if (effect) {
                applyEffectToAllScenes(state, client, project.id, effect as EffectPreset);
                (e.target as HTMLSelectElement).value = "";
              }
            }}
          >
            <option value="">Overlays...</option>
            ${OVERLAY_PRESETS.map(preset => html`
              <option value="${preset.id}">${preset.icon} ${preset.label}</option>
            `)}
          </select>
          
          <!-- Randomize Button -->
          <button 
            class="sb-btn sb-btn-sm sb-btn-randomize"
            title="Randomize effects for all scenes"
            @click=${() => randomizeEffects(state, client, project.id, ["motion", "overlay"])}
          >
            ${icons.sparkles} Random
          </button>
          
          <!-- Clear Button -->
          <button 
            class="sb-btn sb-btn-sm sb-btn-ghost"
            title="Clear all effects"
            @click=${() => clearAllEffects(state, client, project.id)}
          >
            ${icons.x}
          </button>
        </div>
        <span class="sb-video-duration">${formatDuration(totalDuration)}</span>
      </div>
      
      <!-- Video Player Placeholder / First Scene Preview -->
      <div class="sb-video-player">
        ${sb.videoPreviewUrl ? html`
          <video
            class="sb-video-element"
            src="${sb.videoPreviewUrl}"
            controls
            @timeupdate=${(e: Event) => {
              const video = e.target as HTMLVideoElement;
              updateVideoTime(state, video.currentTime);
            }}
            @loadedmetadata=${(e: Event) => {
              const video = e.target as HTMLVideoElement;
              setVideoDuration(state, video.duration);
            }}
          ></video>
        ` : html`
          <div class="sb-video-placeholder">
            <div class="sb-video-hero">
              ${(() => {
                const currentSceneIndex = sb.isPlaying ? sb.playbackSceneIndex : (sb.videoHoveredSceneIndex ?? 0);
                const currentScene = project.scenes[currentSceneIndex] || project.scenes[0];
                // Motion/transition effect class
                const effectClass = currentScene?.effectPreset && currentScene.effectPreset !== 'none' 
                  ? `effect-${currentScene.effectPreset}` 
                  : '';
                // Overlay effect class (pairs with motion)
                const overlayClass = currentScene?.overlayPreset && currentScene.overlayPreset !== 'none'
                  ? `effect-${currentScene.overlayPreset}`
                  : '';
                const effectPreset = EFFECT_PRESETS.find(p => p.id === currentScene?.effectPreset);
                const overlayPreset = EFFECT_PRESETS.find(p => p.id === currentScene?.overlayPreset);
                
                // Use scene index as key to restart animation on scene change
                const animationKey = sb.isPlaying ? `playing-${currentSceneIndex}` : 'paused';
                // Use audio duration if available, otherwise scene duration
                const sceneDuration = (sb.playbackAudioDuration > 0 && sb.isPlaying) 
                  ? sb.playbackAudioDuration 
                  : (currentScene?.durationSeconds || 5);
                
                return currentScene?.imageUrl ? html`
                  <!-- Effect wrapper for live CSS animation - keyed forces element recreation to restart animations -->
                  ${keyed(`scene-${currentSceneIndex}-${currentScene.effectPreset || 'none'}-${currentScene.overlayPreset || 'none'}`, html`
                    <div 
                      class="sb-hero-effect-wrapper ${sb.isPlaying ? effectClass : ''} ${sb.isPlaying ? overlayClass : ''} ${sb.isPlaying ? 'playing' : ''}"
                      data-scene-key="${animationKey}"
                      style="--scene-duration: ${sceneDuration}s;"
                    >
                      <img 
                        class="sb-hero-image" 
                        src="${currentScene.imageUrl}" 
                        alt="Preview"
                      />
                      ${sb.isPlaying && currentScene.effectPreset === 'glitch' ? html`
                        <div class="sb-effect-overlay-scanlines"></div>
                      ` : nothing}
                      ${sb.isPlaying && (currentScene.effectPreset === 'glitch' || currentScene.effectPreset === 'punch-zoom' || currentScene.effectPreset === 'dramatic-push') ? html`
                        <div class="sb-effect-overlay-vignette"></div>
                      ` : nothing}
                    </div>
                  `)}
                  <div class="sb-hero-play-btn ${sb.isPlaying ? 'playing' : ''}" @click=${() => togglePlayback(state)}>
                    <span class="sb-play-icon">${sb.isPlaying ? icons.pause : icons.play}</span>
                  </div>
                  ${sb.isPlaying ? html`
                    <div class="sb-playback-progress">
                      <div class="sb-progress-bar" style="width: ${(sb.playbackProgress / currentScene.durationSeconds) * 100}%"></div>
                    </div>
                  ` : nothing}
                  <div class="sb-hero-overlay">
                    <div class="sb-hero-scene-num">Scene ${currentSceneIndex + 1} of ${project.scenes.length}</div>
                    <div class="sb-hero-title">${currentScene.title}</div>
                    ${effectPreset && effectPreset.id !== 'none' ? html`
                      <div class="sb-hero-effect-badge">
                        ${effectPreset.icon} ${effectPreset.label}
                        ${overlayPreset && overlayPreset.id !== 'none' ? html`
                          <span class="sb-effect-plus">+</span> ${overlayPreset.icon} ${overlayPreset.label}
                        ` : nothing}
                      </div>
                    ` : nothing}
                    ${!sb.isPlaying ? html`
                      <div class="sb-hero-hint">Click play for slideshow • Hover timeline to preview</div>
                    ` : nothing}
                  </div>
                  ${sb.isPlaying ? html`
                    <div class="sb-volume-control" @click=${(e: Event) => e.stopPropagation()}>
                      <button class="sb-mute-btn" @click=${() => toggleMute(state)}>
                        ${sb.playbackMuted ? icons.volumeMute : sb.playbackVolume > 0.5 ? icons.volumeUp : icons.volumeUp}
                      </button>
                      <input 
                        type="range"
                        class="sb-volume-slider"
                        min="0"
                        max="1"
                        step="0.05"
                        .value=${String(sb.playbackMuted ? 0 : sb.playbackVolume)}
                        @input=${(e: Event) => setPlaybackVolume(state, parseFloat((e.target as HTMLInputElement).value))}
                      />
                    </div>
                  ` : nothing}
                ` : html`
                  <div class="sb-hero-empty">
                    <span>${icons.clapperboard}</span>
                    <p>Generate images to preview</p>
                  </div>
                `;
              })()}
            </div>
          </div>
        `}
      </div>
      
      <!-- Timeline -->
      <div class="sb-timeline">
        <div class="sb-timeline-track">
          ${project.scenes.map((scene, index) => {
            const startTime = getSceneStartTime(state, index);
            const widthPercent = (scene.durationSeconds / totalDuration) * 100;
            const isActive = sb.videoHoveredSceneIndex === index || 
              (sb.videoCurrentTime >= startTime && sb.videoCurrentTime < startTime + scene.durationSeconds);
            
            return html`
              <div 
                class="sb-timeline-segment ${isActive ? 'active' : ''} ${scene.imageStatus} ${sb.isPlaying && sb.playbackSceneIndex === index ? 'playing' : ''}"
                style="width: ${widthPercent}%"
                title="${scene.title} (${formatDuration(scene.durationSeconds)})${scene.effectPreset && scene.effectPreset !== 'none' ? ` • Effect: ${scene.effectPreset}` : ''}"
                @mouseenter=${() => !sb.isPlaying && setVideoHoveredScene(state, index)}
                @mouseleave=${() => !sb.isPlaying && setVideoHoveredScene(state, null)}
                @click=${() => sb.isPlaying ? seekToScene(state, index) : openSceneEditor(state, scene.id)}
              >
                <span class="sb-segment-label">${index + 1}</span>
                ${scene.effectPreset && scene.effectPreset !== 'none' ? html`
                  <span class="sb-segment-effect" title="${EFFECT_PRESETS.find(p => p.id === scene.effectPreset)?.label || scene.effectPreset}${scene.overlayPreset && scene.overlayPreset !== 'none' ? ` + ${EFFECT_PRESETS.find(p => p.id === scene.overlayPreset)?.label}` : ''}">
                    ${EFFECT_PRESETS.find(p => p.id === scene.effectPreset)?.icon || '🎬'}${scene.overlayPreset && scene.overlayPreset !== 'none' ? EFFECT_PRESETS.find(p => p.id === scene.overlayPreset)?.icon : ''}
                  </span>
                ` : nothing}
              </div>
            `;
          })}
        </div>
        
        <!-- Playhead -->
        ${sb.videoPreviewUrl && sb.videoDuration > 0 ? html`
          <div 
            class="sb-timeline-playhead"
            style="left: ${(sb.videoCurrentTime / sb.videoDuration) * 100}%"
          ></div>
        ` : nothing}
        
        <!-- Time markers -->
        <div class="sb-timeline-markers">
          <span class="sb-time-marker">0:00</span>
          <span class="sb-time-marker">${formatDuration(totalDuration / 2)}</span>
          <span class="sb-time-marker">${formatDuration(totalDuration)}</span>
        </div>
      </div>
      
      <!-- Voiceover Timeline -->
      <div class="sb-voiceover-timeline">
        <div class="sb-voiceover-header">
          <span class="sb-voiceover-label"><span class="sb-icon-inline">${icons.mic}</span> Voiceover</span>
          <button 
            class="sb-voiceover-generate-btn ${sb.generatingVoiceovers ? 'generating' : ''}"
            @click=${() => generateVoiceovers(state, client, project.id)}
            ?disabled=${sb.generatingVoiceovers}
          >
            ${sb.generatingVoiceovers ? html`<span class="spinner"></span> Generating...` : html`${icons.mic} Generate All`}
          </button>
        </div>
        <div class="sb-voiceover-track">
          ${project.scenes.map((scene, index) => {
            const widthPercent = (scene.durationSeconds / totalDuration) * 100;
            const hasAudio = !!scene.audioUrl;
            const hasVoiceoverText = !!(scene.voiceover || scene.description);
            
            return html`
              <div 
                class="sb-voiceover-segment ${hasAudio ? 'has-audio' : ''} ${hasVoiceoverText ? 'has-text' : 'no-text'}"
                style="width: ${widthPercent}%"
                title="${hasAudio ? 'Click to play' : hasVoiceoverText ? 'Click to generate' : 'No voiceover text'}"
                @click=${() => hasAudio ? playPreviewAudio(state, scene.audioUrl!) : hasVoiceoverText ? generateSingleVoiceover(state, client, project.id, scene.id) : null}
              >
                ${hasAudio ? html`<span class="sb-vo-icon">${icons.volumeUp}</span>` :
                  hasVoiceoverText ? html`<span class="sb-vo-icon">${icons.penLine}</span>` :
                  html`<span class="sb-vo-icon">—</span>`}
              </div>
            `;
          })}
        </div>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════
// REGENERATE MODAL (WITH MODEL SELECTION)
// ═══════════════════════════════════════════════════════════════

function renderRegenerateModal(
  state: AppViewState,
  client: GatewayBrowserClient,
  project: StoryboardProject
): ReturnType<typeof html> {
  const sb = getStoryboardState(state);
  const scene = project.scenes.find(s => s.id === sb.regenerateSceneId);
  
  if (!scene) return nothing;
  
  // ComfyUI models live in sb.localApiModels (advertised via /models).
  const localModels = sb.localApiModels;
  
  return html`
    <div class="sb-modal-overlay" @click=${() => closeRegenerateModal(state)}>
      <div class="sb-modal sb-modal-md sb-regenerate-modal ${sb.regenerating ? 'is-generating' : ''}" @click=${(e: Event) => e.stopPropagation()}>
        ${sb.regenerating ? html`
          <div class="sb-modal-loading-overlay">
            <div class="sb-spinner"></div>
            <div class="sb-loading-text">Generating image...</div>
            <div class="sb-loading-subtext">This may take 30-90 seconds</div>
          </div>
        ` : nothing}
        <div class="sb-modal-header">
          <h2><span class="sb-icon-inline">${icons.refresh}</span> Regenerate Image</h2>
          <button class="sb-modal-close" @click=${() => closeRegenerateModal(state)} ?disabled=${sb.regenerating}>${icons.x}</button>
        </div>
        
        <div class="sb-modal-body">
          <!-- Current Image Preview -->
          <div class="sb-regen-preview">
            ${scene.imageUrl ? html`
              <img src="${scene.imageUrl}" alt="${scene.title}" @click=${() => openImagePreview(state, scene.id, scene.imageUrl!)} style="cursor: pointer;" />
            ` : html`
              <div class="sb-regen-placeholder">No current image</div>
            `}
            <div class="sb-regen-scene-info">
              <strong>${scene.title}</strong>
            </div>
          </div>
          
          <!-- Phase 8: Per-scene timeline composer (compact) -->
          ${renderTimelineComposer(state, project, "image", { compact: true, sceneId: scene.id })}

          <!-- Custom Prompt -->
          <div class="sb-regen-prompt">
            <div class="sb-prompt-header">
              <h4><span class="sb-icon-inline">${icons.penLine}</span> Image Prompt</h4>
              <button 
                class="sb-btn sb-btn-sm sb-btn-outline sb-btn-magic"
                ?disabled=${sb.regenerating || sb.loadingSuggestedPrompts}
                @click=${() => generateSuggestedPrompts(state, client, project.id)}
              >
                ${sb.loadingSuggestedPrompts ? html`<span class="sb-spinner-sm"></span>` : icons.sparkles}
                ${sb.loadingSuggestedPrompts ? "Generating..." : "Surprise Me"}
              </button>
            </div>
            <textarea
              class="sb-textarea"
              rows="4"
              .value=${sb.regeneratePrompt}
              @input=${(e: Event) => setRegeneratePrompt(state, (e.target as HTMLTextAreaElement).value)}
              placeholder="Describe the image you want to generate..."
              ?disabled=${sb.regenerating}
            ></textarea>
            <div class="sb-prompt-hint">Edit the prompt to customize the generated image</div>
            
            <!-- Suggested Prompts -->
            ${sb.suggestedPrompts.length > 0 ? html`
              <div class="sb-suggested-prompts">
                <div class="sb-suggested-header">
                  <span class="sb-suggested-icon">${icons.sparkles}</span>
                  <span>Unexpected Scene Ideas</span>
                </div>
                <div class="sb-suggested-list">
                  ${sb.suggestedPrompts.map((prompt, idx) => html`
                    <button 
                      class="sb-suggested-item"
                      @click=${() => selectSuggestedPrompt(state, prompt)}
                      ?disabled=${sb.regenerating}
                    >
                      <span class="sb-suggested-num">${idx + 1}</span>
                      <span class="sb-suggested-text">${prompt}</span>
                    </button>
                  `)}
                </div>
              </div>
            ` : nothing}
          </div>
          
          <!-- Model Selection -->
          <div class="sb-regen-models">
            <h4>Select Model</h4>

            <!-- ComfyUI server -->
            ${localModels.length > 0 ? html`
              <div class="sb-model-group">
                <div class="sb-model-group-header">
                  <span class="sb-model-icon">${icons.palette}</span>
                  <span>ComfyUI</span>
                  <span class="sb-model-badge sb-badge-fast">On-device</span>
                </div>
                <div class="sb-model-options">
                  ${localModels.map(model => html`
                    <label class="sb-model-option ${sb.regenerateModel === model.id ? 'selected' : ''}">
                      <input
                        type="radio"
                        name="model"
                        .checked=${sb.regenerateModel === model.id}
                        @change=${() => selectRegenerateModel(state, model.id)}
                      />
                      <span class="sb-model-name">${model.name}</span>
                    </label>
                  `)}
                </div>
              </div>
            ` : nothing}
          </div>
        </div>
        
        <div class="sb-modal-footer">
          <button class="sb-btn sb-btn-ghost" @click=${() => closeRegenerateModal(state)}>
            Cancel
          </button>
          <button 
            class="sb-btn sb-btn-gold"
            ?disabled=${sb.regenerating}
            @click=${() => {
              console.log("[Storyboard] Regenerate button clicked!", { 
                sceneId: sb.regenerateSceneId,
                model: sb.regenerateModel,
                backend: sb.regenerateBackend,
                projectId: project.id
              });
              executeRegenerate(state, client, project.id);
            }}
          >
            ${sb.regenerating ? html`<span class="sb-spinner-sm"></span> Generating...` : html`${icons.refresh} Regenerate`}
          </button>
        </div>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════
// IMAGE PREVIEW MODAL
// ═══════════════════════════════════════════════════════════════

function renderImagePreviewModal(state: AppViewState): ReturnType<typeof html> {
  const sb = getStoryboardState(state);
  
  if (!sb.previewImageUrl) return nothing;
  
  // Find the scene for title
  const project = sb.projects.find(p => p.id === sb.selectedProjectId);
  const scene = project?.scenes.find(s => s.id === sb.previewSceneId);
  
  return html`
    <div class="sb-modal-overlay sb-preview-overlay" @click=${() => closeImagePreview(state)}>
      <div class="sb-preview-container" @click=${(e: Event) => e.stopPropagation()}>
        <button class="sb-preview-close" @click=${() => closeImagePreview(state)}>${icons.x}</button>
        <img 
          class="sb-preview-image" 
          src="${sb.previewImageUrl}" 
          alt="${scene?.title || 'Scene preview'}"
        />
        ${scene ? html`
          <div class="sb-preview-info">
            <h3>${scene.title}</h3>
            <p>${scene.imagePrompt}</p>
          </div>
        ` : nothing}
      </div>
    </div>
    
    <style>
      .sb-preview-overlay {
        background: rgba(0, 0, 0, 0.9);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
      }
      
      .sb-preview-container {
        position: relative;
        max-width: 90vw;
        max-height: 90vh;
        display: flex;
        flex-direction: column;
        align-items: center;
      }
      
      .sb-preview-close {
        position: absolute;
        top: -40px;
        right: 0;
        width: 36px;
        height: 36px;
        border: none;
        background: rgba(255, 255, 255, 0.1);
        color: white;
        border-radius: 50%;
        font-size: 18px;
        cursor: pointer;
        transition: background 0.2s;
      }
      
      .sb-preview-close:hover {
        background: rgba(255, 255, 255, 0.2);
      }
      
      .sb-preview-image {
        max-width: 100%;
        max-height: 80vh;
        object-fit: contain;
        border-radius: 8px;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
      }
      
      .sb-preview-info {
        margin-top: 16px;
        text-align: center;
        color: white;
        max-width: 600px;
      }
      
      .sb-preview-info h3 {
        margin: 0 0 8px 0;
        font-size: 18px;
        color: #f5c518;
      }
      
      .sb-preview-info p {
        margin: 0;
        font-size: 14px;
        color: rgba(255, 255, 255, 0.7);
        line-height: 1.5;
      }
    </style>
  `;
}

// ═══════════════════════════════════════════════════════════════
// VOICE REGENERATION MODAL
// ═══════════════════════════════════════════════════════════════

function renderVoiceRegenModal(
  state: AppViewState,
  client: GatewayBrowserClient,
  project: StoryboardProject
): ReturnType<typeof html> {
  const sb = getStoryboardState(state);
  const scene = project.scenes.find(s => s.id === sb.voiceRegenSceneId);
  
  if (!scene) return nothing;
  
  return html`
    <div class="sb-modal-overlay" @click=${() => closeVoiceRegenModal(state)}>
      <div class="sb-modal sb-modal-md" @click=${(e: Event) => e.stopPropagation()}>
        <div class="sb-modal-header">
          <h2><span class="sb-icon-inline">${icons.mic}</span> Generate Voiceover</h2>
          <button class="sb-modal-close" @click=${() => closeVoiceRegenModal(state)}>${icons.x}</button>
        </div>
        
        <div class="sb-modal-body">
          <!-- Voiceover Text Preview -->
          <div class="sb-voice-preview">
            <h4>Voiceover Text</h4>
            <p class="sb-voice-text">${scene.voiceover || "No voiceover text set. Add text in the scene editor first."}</p>
          </div>
          
          <!-- Voice Info -->
          <div class="sb-voice-selection">
            <div class="sb-elevenlabs-info" style="padding: 1rem; background: rgba(139, 92, 246, 0.1); border-radius: 8px; text-align: center;">
              <span class="sb-info-icon" style="font-size: 2rem; display: block; margin-bottom: 0.5rem;">${icons.mic}</span>
              <span>Voice settings are configured in the project's Voice & Audio settings panel.<br/>Using ElevenLabs voices.</span>
            </div>
          </div>
        </div>
        
        <div class="sb-modal-footer">
          <button 
            class="sb-btn sb-btn-outline"
            ?disabled=${sb.regeneratingVoice}
            @click=${() => regenerateAllVoiceovers(state, client, project.id)}
          >
            ${icons.volumeUp} Generate All Scenes
          </button>
          <div class="sb-footer-right">
            <button class="sb-btn sb-btn-ghost" @click=${() => closeVoiceRegenModal(state)}>
              Cancel
            </button>
            <button 
              class="sb-btn sb-btn-gold"
              ?disabled=${sb.regeneratingVoice || !scene.voiceover}
              @click=${() => regenerateVoiceover(state, client, project.id)}
            >
              ${sb.regeneratingVoice ? html`<span class="sb-spinner-sm"></span> Generating...` : html`${icons.mic} Generate This Scene`}
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════
// EXPORT DIALOG
// ═══════════════════════════════════════════════════════════════

function renderExportDialog(
  state: AppViewState,
  client: GatewayBrowserClient,
  project: StoryboardProject
): ReturnType<typeof html> {
  const sb = getStoryboardState(state);
  const settings = sb.exportSettings;
  const completedScenes = project.scenes.filter(s => s.imageStatus === "complete");
  
  // Count effects used across scenes
  const effectCounts: Record<string, number> = {};
  const overlayCounts: Record<string, number> = {};
  for (const scene of completedScenes) {
    if (scene.effectPreset && scene.effectPreset !== "none") {
      effectCounts[scene.effectPreset] = (effectCounts[scene.effectPreset] || 0) + 1;
    }
    if (scene.overlayPreset && scene.overlayPreset !== "none") {
      overlayCounts[scene.overlayPreset] = (overlayCounts[scene.overlayPreset] || 0) + 1;
    }
  }
  const hasSceneEffects = Object.keys(effectCounts).length > 0 || Object.keys(overlayCounts).length > 0;
  const scenesWithEffects = completedScenes.filter(s => 
    (s.effectPreset && s.effectPreset !== "none") || (s.overlayPreset && s.overlayPreset !== "none")
  ).length;
  
  return html`
    <div class="sb-modal-overlay" @click=${() => closeExportDialog(state)}>
      <div class="sb-modal" @click=${(e: Event) => e.stopPropagation()}>
        <div class="sb-modal-header">
          <h2><span class="sb-icon-inline">${icons.clapperboard}</span> Export Video</h2>
          <button class="sb-modal-close" @click=${() => closeExportDialog(state)}>${icons.x}</button>
        </div>
        
        <div class="sb-modal-body">
          ${sb.exportResult ? html`
            <div class="sb-export-result ${sb.exportResult.success ? 'success' : 'error'}">
              ${sb.exportResult.success ? html`
                <div class="sb-result-icon">${icons.checkCircle}</div>
                <h3>Export Complete!</h3>
                <p class="sb-result-path">${sb.exportResult.outputPath}</p>
              ` : html`
                <div class="sb-result-icon">${icons.xCircle}</div>
                <h3>Export Failed</h3>
                <p class="sb-result-error">${sb.exportResult.error}</p>
              `}
            </div>
          ` : html`
            <div class="sb-export-info">
              <p><span class="sb-icon-inline">${icons.barChart}</span> ${completedScenes.length} scenes ready for export</p>
              <p><span class="sb-icon-inline">${icons.clock}</span> Total duration: ${formatDuration(completedScenes.reduce((sum, s) => sum + s.durationSeconds, 0))}</p>
            </div>
            
            <div class="sb-export-section">
              <h3><span class="sb-icon-inline">${icons.video}</span> Video Settings</h3>
              
              <div class="sb-form-row">
                <div class="sb-form-group">
                  <label>Frame Rate (FPS)</label>
                  <select 
                    class="sb-input"
                    .value=${String(settings.fps)}
                    @change=${(e: Event) => updateExportSettings(state, "fps", parseInt((e.target as HTMLSelectElement).value))}
                  >
                    <option value="24">24 fps (Film)</option>
                    <option value="30">30 fps (Standard)</option>
                    <option value="60">60 fps (Smooth)</option>
                  </select>
                </div>
                
                <div class="sb-form-group">
                  <label>Fade Transition (seconds)</label>
                  <input 
                    type="number"
                    class="sb-input"
                    min="0"
                    max="2"
                    step="0.1"
                    .value=${String(settings.fadeTransition)}
                    @input=${(e: Event) => updateExportSettings(state, "fadeTransition", parseFloat((e.target as HTMLInputElement).value))}
                  />
                </div>
              </div>
            </div>
            
            <!-- Scene Effects Summary -->
            <div class="sb-export-section sb-effects-summary">
              <h3><span class="sb-icon-inline">${icons.sparkles}</span> Scene Effects</h3>
              ${hasSceneEffects ? html`
                <p class="sb-section-desc sb-effects-active">
                  <span class="sb-check-icon">${icons.check}</span>
                  ${scenesWithEffects} of ${completedScenes.length} scenes have custom effects
                </p>
                
                <div class="sb-effects-preview">
                  <!-- Motion/Transition Effects -->
                  ${Object.keys(effectCounts).length > 0 ? html`
                    <div class="sb-effects-row">
                      <span class="sb-effects-label">Motion:</span>
                      <div class="sb-effects-tags">
                        ${Object.entries(effectCounts).map(([effect, count]) => {
                          const preset = EFFECT_PRESETS.find(p => p.id === effect);
                          return html`
                            <span class="sb-effect-tag">
                              ${preset?.icon || "🎬"} ${preset?.label || effect}
                              ${count > 1 ? html`<span class="sb-effect-count">×${count}</span>` : nothing}
                            </span>
                          `;
                        })}
                      </div>
                    </div>
                  ` : nothing}
                  
                  <!-- Overlay Effects -->
                  ${Object.keys(overlayCounts).length > 0 ? html`
                    <div class="sb-effects-row">
                      <span class="sb-effects-label">Overlays:</span>
                      <div class="sb-effects-tags">
                        ${Object.entries(overlayCounts).map(([effect, count]) => {
                          const preset = EFFECT_PRESETS.find(p => p.id === effect);
                          return html`
                            <span class="sb-effect-tag sb-effect-overlay">
                              ${preset?.icon || "✨"} ${preset?.label || effect}
                              ${count > 1 ? html`<span class="sb-effect-count">×${count}</span>` : nothing}
                            </span>
                          `;
                        })}
                      </div>
                    </div>
                  ` : nothing}
                </div>
                
                <p class="sb-effects-note">
                  All effects will be rendered with Remotion using your per-scene settings.
                </p>
              ` : html`
                <p class="sb-section-desc sb-effects-none">
                  No custom effects applied. Default Ken Burns zoom will be used.
                </p>
                <p class="sb-effects-hint">
                  <span class="sb-icon-inline">${icons.sparkles}</span> Tip: Add effects from the timeline toolbar (Motion, Transitions, Overlays)
                </p>
              `}
            </div>
          `}
        </div>
        
        <div class="sb-modal-footer">
          <button class="sb-btn sb-btn-ghost" @click=${() => closeExportDialog(state)}>
            ${sb.exportResult ? "Close" : "Cancel"}
          </button>
          ${!sb.exportResult ? html`
            <button 
              class="sb-btn sb-btn-gold"
              ?disabled=${sb.exporting || completedScenes.length === 0}
              @click=${() => exportVideo(state, client, project.id)}
            >
              ${sb.exporting ? html`<span class="sb-spinner-sm"></span> Exporting...` : html`${icons.clapperboard} Export Video`}
            </button>
          ` : nothing}
        </div>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════
// SCENE EDITOR MODAL
// ═══════════════════════════════════════════════════════════════

function renderSceneEditorModal(
  state: AppViewState,
  client: GatewayBrowserClient,
  project: StoryboardProject
): ReturnType<typeof html> {
  const sb = getStoryboardState(state);
  const scene = project.scenes[sb.sceneEditorIndex];
  
  if (!scene) return nothing;
  
  const isFirst = sb.sceneEditorIndex === 0;
  const isLast = sb.sceneEditorIndex === project.scenes.length - 1;
  const totalScenes = project.scenes.length;
  
  return html`
    <div class="sb-modal-overlay" @click=${() => closeSceneEditor(state)}>
      <div class="sb-modal sb-modal-lg sb-scene-editor-modal" @click=${(e: Event) => e.stopPropagation()}>
        <!-- Header with Navigation -->
        <div class="sb-modal-header sb-scene-editor-header">
          <div class="sb-scene-nav">
            <button 
              class="sb-nav-btn ${isFirst ? 'disabled' : ''}"
              ?disabled=${isFirst}
              @click=${() => navigateScene(state, "prev")}
              title="Previous Scene"
            >
              ${icons.arrowLeft}
            </button>
            <span class="sb-scene-counter">
              Scene ${sb.sceneEditorIndex + 1} of ${totalScenes}
            </span>
            <button 
              class="sb-nav-btn ${isLast ? 'disabled' : ''}"
              ?disabled=${isLast}
              @click=${() => navigateScene(state, "next")}
              title="Next Scene"
            >
              ${icons.arrowRight}
            </button>
          </div>
          <button class="sb-modal-close" @click=${() => closeSceneEditor(state)}>${icons.x}</button>
        </div>
        
        <div class="sb-modal-body sb-scene-editor-body">
          <!-- Left: Image Preview -->
          <div class="sb-scene-preview">
            <div class="sb-scene-preview-image">
              ${scene.imageUrl ? html`
                <img src="${scene.imageUrl}" alt="${scene.title}" />
              ` : html`
                <div class="sb-scene-preview-placeholder">
                  ${scene.imageStatus === "generating" ? html`
                    <div class="sb-spinner"></div>
                    <span>Generating...</span>
                  ` : scene.imageStatus === "failed" ? html`
                    <span class="sb-error-icon">${icons.alertCircle}</span>
                    <span>Generation Failed</span>
                  ` : html`
                    <span class="sb-pending-icon">${icons.image}</span>
                    <span>No Image Yet</span>
                  `}
                </div>
              `}
            </div>
            
            <button
              class="sb-btn sb-btn-outline sb-regenerate-btn"
              @click=${() => openRegenerateModal(state, scene.id, client)}
            >
              ${icons.refresh} Regenerate Image
            </button>
          </div>
          
          <!-- Right: Form -->
          <div class="sb-scene-form">
            <!-- Title -->
            <div class="sb-form-group">
              <label>Title</label>
              <input 
                type="text"
                class="sb-input"
                placeholder="Scene title"
                .value=${sb.sceneEditorForm.title}
                @input=${(e: Event) => updateSceneField(state, "title", (e.target as HTMLInputElement).value)}
              />
            </div>
            
            <!-- Duration -->
            <div class="sb-form-group">
              <label>Duration (seconds)</label>
              <div class="sb-duration-input">
                <input 
                  type="number"
                  class="sb-input"
                  min="1"
                  max="60"
                  step="0.5"
                  .value=${String(sb.sceneEditorForm.durationSeconds)}
                  @input=${(e: Event) => updateSceneField(state, "durationSeconds", parseFloat((e.target as HTMLInputElement).value))}
                />
                <span class="sb-duration-label">${formatDuration(sb.sceneEditorForm.durationSeconds)}</span>
              </div>
            </div>
            
            <!-- Effect Preset (Remotion) with Live Preview -->
            <div class="sb-form-group">
              <label><span class="sb-icon-inline">${icons.clapperboard}</span> Video Effect</label>
              <select 
                class="sb-select"
                .value=${sb.sceneEditorForm.effectPreset || "none"}
                @change=${(e: Event) => updateSceneField(state, "effectPreset", (e.target as HTMLSelectElement).value)}
              >
                ${EFFECT_PRESETS.map(preset => html`
                  <option value="${preset.id}" title="${preset.description}">
                    ${preset.icon} ${preset.label}
                  </option>
                `)}
              </select>
              <span class="sb-form-hint">
                ${(() => {
                  const preset = EFFECT_PRESETS.find(p => p.id === (sb.sceneEditorForm.effectPreset || "none"));
                  return preset?.description || "No effect - uses basic Ken Burns";
                })()}
              </span>
              
              <!-- Live Effect Preview -->
              ${scene.imageUrl ? html`
                <div class="sb-effect-preview">
                  <div class="sb-effect-preview-label">
                    <span><span class="sb-icon-inline">${icons.play}</span> Live Preview</span>
                    <span class="sb-effect-preview-hint">(CSS simulation)</span>
                  </div>
                  <div class="sb-effect-preview-container">
                    <div class="sb-effect-preview-wrapper effect-${sb.sceneEditorForm.effectPreset || 'none'}">
                      <img src="${scene.imageUrl}" alt="Preview" />
                      ${(sb.sceneEditorForm.effectPreset === 'glitch' || sb.sceneEditorForm.effectPreset === 'punch-zoom') ? html`
                        <div class="sb-effect-overlay-vignette"></div>
                      ` : nothing}
                      ${sb.sceneEditorForm.effectPreset === 'glitch' ? html`
                        <div class="sb-effect-overlay-scanlines"></div>
                      ` : nothing}
                    </div>
                  </div>
                </div>
              ` : nothing}
            </div>
            
            <!-- Image Prompt -->
            <div class="sb-form-group">
              <label>Image Prompt</label>
              <textarea 
                class="sb-textarea"
                rows="3"
                placeholder="Describe the image to generate..."
                .value=${sb.sceneEditorForm.imagePrompt}
                @input=${(e: Event) => updateSceneField(state, "imagePrompt", (e.target as HTMLTextAreaElement).value)}
              ></textarea>
            </div>
            
            <!-- Voiceover -->
            <div class="sb-form-group">
              <div class="sb-form-label-row">
                <label><span class="sb-icon-inline">${icons.mic}</span> Voiceover Text</label>
                <button 
                  class="sb-btn sb-btn-sm sb-btn-outline"
                  @click=${() => openVoiceRegenModal(state, scene.id)}
                  title="Regenerate voiceover with ElevenLabs"
                >
                  ${icons.volumeUp} Generate Voice
                </button>
              </div>
              <textarea 
                class="sb-textarea"
                rows="3"
                placeholder="Narration for this scene..."
                .value=${sb.sceneEditorForm.voiceover}
                @input=${(e: Event) => updateSceneField(state, "voiceover", (e.target as HTMLTextAreaElement).value)}
              ></textarea>
            </div>
            
            <!-- Description -->
            <div class="sb-form-group">
              <label>Description</label>
              <textarea 
                class="sb-textarea"
                rows="2"
                placeholder="Scene description..."
                .value=${sb.sceneEditorForm.description}
                @input=${(e: Event) => updateSceneField(state, "description", (e.target as HTMLTextAreaElement).value)}
              ></textarea>
            </div>
          </div>
        </div>
        
        <div class="sb-modal-footer sb-scene-editor-footer">
          <button 
            class="sb-btn sb-btn-ghost sb-btn-danger"
            @click=${() => {
              if (confirm("Delete this scene? This cannot be undone.")) {
                deleteScene(state, client, scene.id, project.id);
              }
            }}
          >
            ${icons.trash} Delete Scene
          </button>
          
          <div class="sb-footer-right">
            <button class="sb-btn sb-btn-ghost" @click=${() => closeSceneEditor(state)}>
              Cancel
            </button>
            <button 
              class="sb-btn sb-btn-gold"
              @click=${() => saveSceneChanges(state, client, project.id)}
            >
              ${icons.check} Save Changes
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════════════════════

const storyboardStyles = `
/* ═══════════════════════════════════════════════════════════════
   STORYBOARD STUDIO — Enhanced Black & Gold Theme
   v2.0 — Purple AI States + Card Gradients + Text Hierarchy
   ═══════════════════════════════════════════════════════════════ */

/* ═══ DESIGN TOKENS ═══
   Map storyboard tokens onto the global glass theme so palette swaps cascade.
   Gold = primary, Purple = accent (AI/generating states).            */
.sb-container {
  /* Gold accent (primary) */
  --sb-gold: var(--g-primary);
  --sb-gold-hover: color-mix(in srgb, var(--g-primary) 80%, white 20%);
  --sb-gold-muted: var(--g-primary-muted);
  --sb-gold-glow: var(--g-primary-strong);

  /* Purple accent (AI/generating states) */
  --sb-purple: var(--g-accent);
  --sb-purple-hover: color-mix(in srgb, var(--g-accent) 80%, white 20%);
  --sb-purple-muted: var(--g-accent-muted);
  --sb-purple-glow: var(--g-accent-strong);

  /* Text hierarchy */
  --sb-text-primary: var(--g-fg);
  --sb-text-secondary: color-mix(in srgb, var(--g-fg) 85%, transparent);
  --sb-text-muted: var(--g-fg-dim);
  --sb-text-dim: var(--g-fg-faint);
  --sb-text-ghost: color-mix(in srgb, var(--g-fg) 25%, transparent);

  /* Surfaces — derived from the global glass surface so the page reads as one material */
  --sb-bg-base: transparent;
  --sb-bg-elevated: color-mix(in srgb, var(--g-surface) 90%, transparent);
  --sb-bg-card: var(--g-surface);
  --sb-bg-card-hover: var(--g-surface-hover);

  /* Borders */
  --sb-border-subtle: color-mix(in srgb, var(--g-fg) 6%, transparent);
  --sb-border-muted: color-mix(in srgb, var(--g-fg) 12%, transparent);
  --sb-border-accent: var(--g-primary-muted);

  /* Transitions */
  --sb-transition-fast: 0.15s ease;
  --sb-transition-normal: 0.25s ease;
  --sb-transition-slow: 0.4s ease;
}

.sb-container {
  position: relative;
  min-height: 100vh;
  /* Inherit the shell background — never paint our own page color. */
  background: transparent;
  color: var(--sb-text-secondary);
  overflow: hidden;
}

/* ═══ BACKGROUND EFFECTS ═══
   Page-level orbs/grid removed: the global shell already provides the
   ambient gradient. Local orbs would double-up and clash on palette swap. */
.sb-bg-effects { display: none; }
.sb-glow-orb { display: none; }
.sb-grid-pattern { display: none; }

/* ═══ HEADER ═══
   Translucent so the shell background reads through, matching other pages. */
.sb-header {
  position: relative;
  z-index: 10;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 20px;
  background: color-mix(in srgb, var(--g-bg) 55%, transparent);
  border-bottom: 1px solid var(--sb-border-subtle);
  backdrop-filter: blur(14px) saturate(140%);
  -webkit-backdrop-filter: blur(14px) saturate(140%);
}

.sb-header-left {
  display: flex;
  align-items: center;
  gap: 20px;
}

.sb-logo {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sb-logo-icon {
  font-size: 22px;
  filter: drop-shadow(0 0 8px var(--sb-gold-glow));
}

.sb-logo-text {
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.02em;
  background: linear-gradient(135deg, var(--sb-gold) 0%, var(--sb-gold-hover) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

.sb-header-stats {
  display: flex;
  gap: 6px;
  color: var(--sb-text-dim);
  font-size: 12px;
  font-weight: 500;
}

.sb-stat {
  padding: 4px 10px;
  background: var(--sb-bg-card);
  border-radius: 6px;
  border: 1px solid var(--sb-border-subtle);
}

.sb-stat-divider {
  color: var(--sb-text-ghost);
  display: none;
}

.sb-header-right {
  display: flex;
  gap: 6px;
}

/* ═══ LAYOUT ═══ */
.sb-layout {
  position: relative;
  z-index: 5;
  display: flex;
  height: calc(100vh - 57px);
}

/* Preset Builder Wrapper */
.sb-preset-wrapper {
  position: relative;
  z-index: 5;
  flex: 1;
  height: calc(100vh - 57px);
  overflow: hidden;
}

/* ═══ SIDEBAR — Priority 7: Collapsibles ═══ */
.sb-sidebar {
  width: 280px;
  min-width: 280px;
  /* Translucent so the shell background reads through. The sidebar reads
     as a glass panel rather than a hard column. */
  background: color-mix(in srgb, var(--g-surface) 65%, transparent);
  border-right: 1px solid var(--sb-border-subtle, rgba(255, 255, 255, 0.06));
  backdrop-filter: blur(12px) saturate(140%);
  -webkit-backdrop-filter: blur(12px) saturate(140%);
  overflow-y: auto;
  padding: 0;
  display: flex !important;
  flex-direction: column;
  visibility: visible !important;
}

.sb-sidebar::-webkit-scrollbar {
  width: 6px;
}

.sb-sidebar::-webkit-scrollbar-track {
  background: transparent;
}

.sb-sidebar::-webkit-scrollbar-thumb {
  background: var(--sb-border-muted);
  border-radius: 3px;
}

.sb-sidebar::-webkit-scrollbar-thumb:hover {
  background: var(--sb-border-accent);
}

.sb-sidebar-section {
  padding: 12px 14px;
  border-bottom: 1px solid var(--sb-border-subtle);
}

.sb-sidebar-section:last-child {
  border-bottom: none;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* Collapsible Section Animation */
.sb-sidebar-section[data-collapsed="true"] .sb-project-list,
.sb-sidebar-section[data-collapsed="true"] .char-grid {
  display: none;
}

.sb-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  cursor: pointer;
  padding: 4px 0;
  border-radius: 4px;
  transition: var(--sb-transition-fast);
}

.sb-section-header:hover {
  background: var(--sb-bg-card);
  margin-left: -8px;
  margin-right: -8px;
  padding-left: 8px;
  padding-right: 8px;
}

.sb-section-toggle {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--sb-text-dim);
  font-size: 10px;
  transition: transform var(--sb-transition-fast);
}

.sb-section-toggle.collapsed {
  transform: rotate(-90deg);
}

.sb-projects-section {
  flex-shrink: 0;
  max-height: 45%;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.sb-characters-section {
  flex: 1;
  min-height: 200px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.sb-characters-section .char-panel {
  height: 100%;
  padding: 0;
  border: none;
  border-radius: 0;
  background: transparent;
}

.sb-characters-section .char-header {
  padding: 0 0 10px 0;
  margin-bottom: 10px;
}

.sb-characters-section .char-grid {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.sb-section-title {
  font-size: 11px;
  font-weight: 700;
  color: var(--sb-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  display: flex;
  align-items: center;
  gap: 6px;
}

.sb-section-title::before {
  content: '';
  width: 3px;
  height: 14px;
  background: var(--sb-gold);
  border-radius: 2px;
}

.sb-main {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
}

.sb-main::-webkit-scrollbar {
  width: 8px;
}

.sb-main::-webkit-scrollbar-track {
  background: transparent;
}

.sb-main::-webkit-scrollbar-thumb {
  background: var(--sb-border-muted);
  border-radius: 4px;
}

/* ═══ PROJECT CARDS — Priority 2: Scene Card Simplification ═══ */
.sb-project-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sb-project-card {
  position: relative;
  background: var(--sb-bg-card);
  border: 1px solid var(--sb-border-subtle);
  border-radius: 10px;
  padding: 12px;
  cursor: pointer;
  transition: all var(--sb-transition-normal);
  overflow: hidden;
}

/* Subtle top-left gold glow gradient */
.sb-project-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  width: 100px;
  height: 100px;
  background: radial-gradient(circle at top left, var(--sb-gold-muted) 0%, transparent 70%);
  opacity: 0;
  transition: opacity var(--sb-transition-normal);
  pointer-events: none;
}

.sb-project-card:hover {
  border-color: var(--sb-border-accent);
  transform: translateY(-1px);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
}

.sb-project-card:hover::before {
  opacity: 1;
}

.sb-project-card.selected {
  border-color: var(--sb-gold);
  background: linear-gradient(135deg, rgba(245, 158, 11, 0.08) 0%, var(--sb-bg-card) 50%);
}

.sb-project-card.selected::before {
  opacity: 1;
}

/* Generating state with purple glow */
.sb-project-card.generating {
  border-color: var(--sb-purple);
  background: linear-gradient(135deg, var(--sb-purple-muted) 0%, var(--sb-bg-card) 50%);
}

.sb-project-card.generating::before {
  background: radial-gradient(circle at top left, var(--sb-purple-muted) 0%, transparent 70%);
  opacity: 1;
  animation: sb-pulse-glow 2s ease-in-out infinite;
}

@keyframes sb-pulse-glow {
  0%, 100% { opacity: 0.7; }
  50% { opacity: 1; }
}

.sb-project-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.sb-project-platform {
  font-size: 16px;
  opacity: 0.9;
}

.sb-project-name {
  font-weight: 600;
  font-size: 13px;
  color: var(--sb-text-primary);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sb-project-card-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--sb-text-dim);
  margin-bottom: 6px;
}

.sb-project-status {
  padding: 2px 8px;
  border-radius: 8px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  background: color-mix(in srgb, var(--status-color) 15%, transparent);
  color: var(--status-color);
}

/* Purple status for generating/AI states */
.sb-project-status.generating,
.sb-project-status.scripting,
.sb-project-status.splitting {
  --status-color: var(--sb-purple) !important;
  background: var(--sb-purple-muted);
  color: var(--sb-purple);
}

.sb-project-progress {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.sb-progress-bar {
  flex: 1;
  height: 3px;
  background: rgba(255, 255, 255, 0.08);
  border-radius: 2px;
  overflow: hidden;
}

.sb-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--sb-gold), var(--sb-gold-hover));
  transition: width 0.3s ease;
}

/* Purple progress for generating states */
.sb-project-card.generating .sb-progress-fill {
  background: linear-gradient(90deg, var(--sb-purple), var(--sb-purple-hover));
}

.sb-progress-text {
  font-size: 10px;
  font-weight: 600;
  color: var(--sb-gold);
}

.sb-project-card.generating .sb-progress-text {
  color: var(--sb-purple);
}

.sb-project-card-footer {
  display: flex;
  gap: 10px;
  font-size: 10px;
  color: var(--sb-text-ghost);
}

/* ═══ DETAIL VIEW ═══ */
.sb-detail {
  max-width: 1200px;
  margin: 0 auto;
}

.sb-detail-header {
  margin-bottom: 20px;
}

.sb-detail-title-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}

.sb-detail-title {
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.02em;
  background: linear-gradient(135deg, var(--sb-gold) 0%, var(--sb-gold-hover) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

.sb-detail-actions {
  display: flex;
  gap: 6px;
}

.sb-detail-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--sb-text-muted);
  font-size: 13px;
}

.sb-meta-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  background: var(--sb-bg-card);
  border-radius: 6px;
  border: 1px solid var(--sb-border-subtle);
}

.sb-meta-divider {
  color: var(--sb-text-ghost);
  display: none;
}

/* ═══ TABS — Priority 4: Tab Styling ═══ */
.sb-tabs {
  display: flex;
  gap: 2px;
  margin-bottom: 20px;
  padding: 4px;
  background: var(--sb-bg-card);
  border-radius: 12px;
  border: 1px solid var(--sb-border-subtle);
  width: fit-content;
}

.sb-tab {
  position: relative;
  background: transparent;
  border: none;
  color: var(--sb-text-muted);
  padding: 10px 18px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  border-radius: 8px;
  transition: all var(--sb-transition-fast);
  display: flex;
  align-items: center;
  gap: 6px;
}

.sb-tab:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--sb-text-secondary);
}

.sb-tab.active {
  background: linear-gradient(135deg, var(--sb-gold-muted) 0%, rgba(245, 158, 11, 0.08) 100%);
  color: var(--sb-gold);
  box-shadow: 0 2px 8px rgba(245, 158, 11, 0.15);
}

.sb-tab.active::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 20px;
  height: 2px;
  background: var(--sb-gold);
  border-radius: 1px;
}

/* Tab notification dot */
.sb-tab-dot {
  width: 6px;
  height: 6px;
  background: var(--sb-purple);
  border-radius: 50%;
  animation: sb-dot-pulse 2s ease-in-out infinite;
}

@keyframes sb-dot-pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.2); opacity: 0.7; }
}

/* ══════════════════════════════════════════════════════════════
   PROJECT CHARACTERS PANEL - Optimized & Unified
   ══════════════════════════════════════════════════════════════ */
.sb-proj-chars {
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding: 20px 0;
}

.sb-proj-chars-section {
  background: rgba(20, 20, 30, 0.5);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  padding: 16px;
}

.sb-proj-chars-header {
  display: flex;
  align-items: center;
  margin-bottom: 16px;
  padding-bottom: 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.sb-proj-chars-title {
  font-size: 14px;
  font-weight: 600;
  color: #d1d5db;
}

.sb-proj-chars-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 12px;
}

.sb-proj-chars-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px;
  color: #6b7280;
  font-size: 13px;
  text-align: center;
  gap: 4px;
}

.sb-proj-chars-hint {
  font-size: 11px;
  color: #f59e0b;
  opacity: 0.7;
}

.sb-proj-chars-actions {
  display: flex;
  justify-content: center;
  padding-top: 8px;
}

.sb-proj-chars-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 20px;
  background: linear-gradient(135deg, rgba(245, 158, 11, 0.15) 0%, rgba(245, 158, 11, 0.08) 100%);
  border: 1px solid rgba(245, 158, 11, 0.4);
  border-radius: 8px;
  color: #f59e0b;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.sb-proj-chars-btn:hover {
  background: linear-gradient(135deg, rgba(245, 158, 11, 0.25) 0%, rgba(245, 158, 11, 0.15) 100%);
  transform: translateY(-1px);
}

/* Project Character Card */
.sb-proj-char-card {
  position: relative;
  background: rgba(25, 25, 35, 0.8);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  overflow: hidden;
  transition: all 0.2s ease;
  display: flex;
  flex-direction: column;
}

.sb-proj-char-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 25px rgba(0, 0, 0, 0.4);
}

.sb-proj-char-card.in-project {
  border-color: rgba(16, 185, 129, 0.4);
}

.sb-proj-char-card.in-project:hover {
  border-color: #10b981;
  box-shadow: 0 8px 25px rgba(16, 185, 129, 0.15);
}

.sb-proj-char-card.available {
  border-color: rgba(245, 158, 11, 0.3);
  opacity: 0.85;
}

.sb-proj-char-card.available:hover {
  opacity: 1;
  border-color: #f59e0b;
  box-shadow: 0 8px 25px rgba(245, 158, 11, 0.15);
}

/* Card Image */
.sb-proj-char-img-wrap {
  position: relative;
  width: 100%;
  aspect-ratio: 1;
  background: rgba(0, 0, 0, 0.4);
  overflow: hidden;
}

.sb-proj-char-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 0.3s ease;
  cursor: pointer;
}

.sb-proj-char-card:hover .sb-proj-char-img {
  transform: scale(1.05);
}

.sb-proj-char-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 32px;
  color: #4b5563;
}

/* Badges */
.sb-proj-char-badge {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
}

.sb-badge-in {
  background: #10b981;
  color: white;
}

.sb-badge-add {
  background: rgba(245, 158, 11, 0.9);
  color: black;
}

.sb-proj-char-count {
  position: absolute;
  top: 8px;
  left: 8px;
  background: rgba(0, 0, 0, 0.7);
  color: #d1d5db;
  font-size: 10px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
}

/* Hover Overlay */
.sb-proj-char-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.75);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.2s ease;
}

.sb-proj-char-card:hover .sb-proj-char-overlay {
  opacity: 1;
}

.sb-proj-char-actions {
  display: flex;
  gap: 8px;
}

.sb-proj-char-action {
  width: 36px;
  height: 36px;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 50%;
  color: white;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
}

.sb-proj-char-action:hover {
  background: rgba(255, 255, 255, 0.2);
  transform: scale(1.1);
}

.sb-action-add:hover {
  background: rgba(245, 158, 11, 0.5);
  border-color: #f59e0b;
}

.sb-action-remove:hover {
  background: rgba(239, 68, 68, 0.5);
  border-color: #ef4444;
}

/* Card Info */
.sb-proj-char-info {
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sb-proj-char-name {
  font-size: 13px;
  font-weight: 600;
  color: #f5f5f5;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sb-proj-char-meta {
  font-size: 10px;
  color: #6b7280;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Quick action button (mobile/touch) */
.sb-proj-char-quick-btn {
  width: 100%;
  padding: 8px;
  border: none;
  border-top: 1px solid rgba(255, 255, 255, 0.05);
  background: transparent;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.sb-proj-char-quick-btn.add {
  color: #f59e0b;
}

.sb-proj-char-quick-btn.add:hover {
  background: rgba(245, 158, 11, 0.1);
}

.sb-proj-char-quick-btn.remove {
  color: #ef4444;
}

.sb-proj-char-quick-btn.remove:hover {
  background: rgba(239, 68, 68, 0.1);
}

/* Legacy styles for backwards compat */
.sb-characters-panel {
  background: rgba(20, 20, 30, 0.6);
  border: 1px solid rgba(245, 158, 11, 0.15);
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 24px;
}

.sb-panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.sb-panel-header h3 {
  font-size: 14px;
  font-weight: 500;
  color: #e5e5e5;
}

.sb-char-image-container {
  position: relative;
}

/* Available library character - can be added */
.sb-char-available {
  border-color: rgba(168, 85, 247, 0.4);
  cursor: pointer;
  opacity: 0.85;
}

.sb-char-available:hover {
  border-color: #a855f7;
  opacity: 1;
  box-shadow: 0 4px 20px rgba(168, 85, 247, 0.3);
}

.sb-char-add-badge {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 24px;
  height: 24px;
  background: rgba(168, 85, 247, 0.9);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  color: #fff;
  font-weight: 600;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  transition: transform 0.2s;
}

.sb-char-available:hover .sb-char-add-badge {
  transform: scale(1.1);
  background: #a855f7;
}

.sb-char-click-hint {
  color: #a855f7;
  font-style: italic;
}

/* Legacy chip style for inline use */
.sb-character-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(20, 20, 30, 0.8);
  border: 1px solid var(--char-color, #a855f7);
  border-radius: 20px;
  padding: 4px 10px;
  font-size: 13px;
}

.sb-char-avatar {
  width: 22px;
  height: 22px;
  background: var(--char-color, #a855f7);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 600;
  color: #000;
}

.sb-char-edit, .sb-char-delete {
  background: none;
  border: none;
  padding: 2px;
  cursor: pointer;
  opacity: 0.5;
  transition: opacity 0.2s;
}

.sb-char-edit:hover, .sb-char-delete:hover {
  opacity: 1;
}

/* Prompt Section */
.sb-prompt-section {
  background: rgba(20, 20, 30, 0.6);
  border: 1px solid rgba(245, 158, 11, 0.15);
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 24px;
}

.sb-prompt-section h3 {
  font-size: 14px;
  font-weight: 500;
  color: #9ca3af;
  margin-bottom: 8px;
}

.sb-prompt-text {
  color: #e5e5e5;
  line-height: 1.6;
}

/* Script Section */
.sb-script-section {
  background: rgba(20, 20, 30, 0.6);
  border: 1px solid rgba(168, 85, 247, 0.2);
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 24px;
}

.sb-script-empty {
  border-style: dashed;
  opacity: 0.7;
}

.sb-script-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.sb-script-header h3 {
  font-size: 16px;
  font-weight: 500;
  color: #a855f7;
  margin: 0;
}

.sb-script-actions {
  display: flex;
  gap: 8px;
}

.sb-script-placeholder {
  color: #9ca3af;
  text-align: center;
  padding: 40px 20px;
}

.sb-script-placeholder p {
  margin: 0;
}

.sb-script-content {
  position: relative;
}

.sb-script-editor {
  width: 100%;
  min-height: 400px;
  background: rgba(0, 0, 0, 0.4);
  border: 1px solid rgba(168, 85, 247, 0.3);
  border-radius: 8px;
  padding: 16px;
  color: #e5e5e5;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 13px;
  line-height: 1.6;
  resize: vertical;
}

.sb-script-editor:focus {
  outline: none;
  border-color: #a855f7;
}

.sb-script-editor::placeholder {
  color: #6b7280;
}

.sb-script-display {
  background: rgba(0, 0, 0, 0.3);
  border-radius: 8px;
  padding: 16px;
  color: #e5e5e5;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 400px;
  overflow-y: auto;
  margin: 0;
}

.sb-script-help {
  margin-top: 12px;
  padding: 12px;
  background: rgba(168, 85, 247, 0.1);
  border-radius: 8px;
  font-size: 12px;
  color: #9ca3af;
}

.sb-script-help p {
  margin: 0 0 8px 0;
  color: #a855f7;
}

.sb-script-help code {
  display: inline-block;
  background: rgba(0, 0, 0, 0.3);
  padding: 2px 6px;
  border-radius: 4px;
  margin: 2px 0;
  color: #f59e0b;
}

/* ═══ SCENES GRID — Priority 2: Scene Card Simplification ═══ */
.sb-scenes-section {
  margin-bottom: 20px;
}

.sb-scenes-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
}

.sb-scenes-header h3 {
  font-size: 16px;
  font-weight: 600;
  color: var(--sb-text-primary);
}

.sb-scenes-actions {
  display: flex;
  gap: 6px;
}

.sb-scenes-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 14px;
}

.sb-scene-card {
  position: relative;
  background: var(--sb-bg-card);
  border: 1px solid var(--sb-border-subtle);
  border-radius: 10px;
  overflow: hidden;
  transition: all var(--sb-transition-normal);
}

/* Subtle top-left gold glow on cards */
.sb-scene-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  width: 80px;
  height: 80px;
  background: radial-gradient(circle at top left, var(--sb-gold-muted) 0%, transparent 70%);
  opacity: 0;
  transition: opacity var(--sb-transition-normal);
  pointer-events: none;
  z-index: 1;
}

.sb-scene-card:hover {
  border-color: var(--sb-border-accent);
  transform: translateY(-2px);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.4);
}

.sb-scene-card:hover::before {
  opacity: 1;
}

.sb-scene-card.timeline-hover {
  border-color: rgba(245, 158, 11, 0.5);
  box-shadow: 0 0 25px var(--sb-gold-glow);
}

.sb-scene-card.timeline-active {
  border-color: var(--sb-gold);
  box-shadow: 0 0 30px var(--sb-gold-glow);
}

.sb-scene-card.complete {
  border-color: rgba(16, 185, 129, 0.3);
}

.sb-scene-card.complete::before {
  background: radial-gradient(circle at top left, rgba(16, 185, 129, 0.15) 0%, transparent 70%);
  opacity: 1;
}

.sb-scene-card.failed {
  border-color: rgba(239, 68, 68, 0.3);
}

/* Generating state with PURPLE accent */
.sb-scene-card.generating-active {
  border-color: var(--sb-purple) !important;
  box-shadow: 0 0 30px var(--sb-purple-glow);
  animation: sb-purple-pulse 2s ease-in-out infinite;
}

.sb-scene-card.generating-active::before {
  background: radial-gradient(circle at top left, var(--sb-purple-muted) 0%, transparent 70%);
  opacity: 1;
}

@keyframes sb-purple-pulse {
  0%, 100% { box-shadow: 0 0 25px var(--sb-purple-glow); }
  50% { box-shadow: 0 0 40px rgba(168, 85, 247, 0.5); }
}

.sb-scene-number {
  position: absolute;
  top: 8px;
  left: 8px;
  width: 26px;
  height: 26px;
  background: rgba(0, 0, 0, 0.75);
  backdrop-filter: blur(4px);
  border: 1px solid var(--sb-border-accent);
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  color: var(--sb-gold);
  z-index: 5;
}

.sb-scene-image {
  position: relative;
  aspect-ratio: 16/9;
  background: rgba(10, 10, 15, 0.9);
  overflow: hidden;
}

.sb-scene-image img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform var(--sb-transition-slow);
}

.sb-scene-card:hover .sb-scene-image img {
  transform: scale(1.02);
}

.sb-scene-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--sb-text-ghost);
  gap: 8px;
}

/* Purple generating state */
.sb-scene-placeholder.generating {
  color: var(--sb-purple);
  background: linear-gradient(135deg, var(--sb-purple-muted) 0%, transparent 50%);
}

.sb-scene-placeholder.failed {
  color: #ef4444;
}

.sb-scene-error {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 11px;
  line-height: 1.35;
  color: var(--sb-text-muted);
  text-align: center;
  padding: 0 10px;
  margin-top: 4px;
  max-width: 220px;
}

.sb-scene-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.75);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity var(--sb-transition-fast);
}

.sb-scene-card:hover .sb-scene-overlay {
  opacity: 1;
}

.sb-scene-btn {
  background: var(--sb-gold-muted);
  border: 1px solid var(--sb-gold);
  color: var(--sb-gold);
  padding: 8px 14px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  transition: all var(--sb-transition-fast);
}

.sb-scene-btn:hover {
  background: rgba(245, 158, 11, 0.25);
  transform: scale(1.02);
}

.sb-scene-content {
  padding: 12px;
}

.sb-scene-title {
  font-weight: 600;
  font-size: 13px;
  color: var(--sb-text-primary);
  margin-bottom: 3px;
}

.sb-scene-duration {
  font-size: 11px;
  font-weight: 600;
  color: var(--sb-gold);
  margin-bottom: 6px;
}

.sb-scene-description {
  font-size: 12px;
  color: var(--sb-text-muted);
  line-height: 1.5;
  margin-bottom: 6px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.sb-scene-voiceover {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 11px;
  color: var(--sb-purple);
  background: var(--sb-purple-muted);
  padding: 6px 8px;
  border-radius: 5px;
  border: 1px solid rgba(168, 85, 247, 0.2);
}

.sb-scene-actions {
  padding: 0 12px 12px;
}

.sb-scene-action {
  background: transparent;
  border: 1px solid var(--sb-border-muted);
  color: var(--sb-text-muted);
  padding: 5px 10px;
  border-radius: 5px;
  cursor: pointer;
  font-size: 11px;
  font-weight: 500;
  transition: all var(--sb-transition-fast);
}

.sb-scene-action:hover {
  border-color: var(--sb-gold);
  color: var(--sb-gold);
  background: var(--sb-gold-muted);
}

/* ═══ EMPTY STATES ═══ */
.sb-empty-state, .sb-scenes-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 60px 20px;
  color: var(--sb-text-ghost);
}

.sb-empty-icon-large {
  font-size: 56px;
  margin-bottom: 20px;
  opacity: 0.4;
  filter: grayscale(50%);
}

.sb-empty-state h2, .sb-scenes-empty h3 {
  font-size: 20px;
  font-weight: 600;
  color: var(--sb-text-secondary);
  margin-bottom: 6px;
}

.sb-empty-state p, .sb-scenes-empty p {
  margin-bottom: 20px;
  color: var(--sb-text-muted);
}

/* Setup-warning card surfaced when no image backend is configured. Uses
   the global glass tokens so the warning blends with the rest of the UI. */
.sb-setup-card {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  text-align: left;
  max-width: 520px;
  width: 100%;
  margin: 0 auto 28px;
  padding: 14px 16px;
  border-radius: 12px;
  border: 1px solid var(--sb-border-accent);
  background: color-mix(in srgb, var(--g-primary) 8%, var(--g-surface) 92%);
  backdrop-filter: blur(14px) saturate(140%);
  -webkit-backdrop-filter: blur(14px) saturate(140%);
  color: var(--sb-text-secondary);
  box-shadow:
    0 1px 0 color-mix(in srgb, var(--g-fg) 8%, transparent) inset,
    0 8px 24px color-mix(in srgb, var(--g-primary) 18%, transparent);
}
.sb-setup-card-icon {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  color: var(--sb-gold);
  filter: drop-shadow(0 0 6px var(--sb-gold-glow));
}
.sb-setup-card-body { flex: 1 1 auto; min-width: 0; }
.sb-setup-card-title {
  font-weight: 600;
  font-size: 13px;
  letter-spacing: 0.01em;
  color: var(--sb-text-primary);
  margin-bottom: 4px;
}
.sb-setup-card-text {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--sb-text-muted);
}
.sb-setup-card-text code {
  padding: 1px 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--g-fg) 8%, transparent);
  font-size: 11.5px;
  color: var(--sb-text-secondary);
}

/* ═══ BUTTONS — Enhanced with micro-interactions ═══ */
.sb-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 9px 16px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all var(--sb-transition-fast);
  border: none;
  position: relative;
  overflow: hidden;
}

/* Micro-interaction: ripple effect */
.sb-btn::after {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(circle at center, rgba(255, 255, 255, 0.2) 0%, transparent 70%);
  opacity: 0;
  transform: scale(0);
  transition: all 0.3s ease;
}

.sb-btn:active::after {
  opacity: 1;
  transform: scale(2);
  transition: all 0s;
}

.sb-btn-sm {
  padding: 5px 10px;
  font-size: 12px;
  border-radius: 6px;
}

.sb-btn-lg {
  padding: 12px 24px;
  font-size: 15px;
}

.sb-btn-primary {
  background: linear-gradient(135deg, #3b82f6, #2563eb);
  color: white;
  box-shadow: 0 2px 10px rgba(59, 130, 246, 0.3);
}

.sb-btn-primary:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 15px rgba(59, 130, 246, 0.4);
}

.sb-btn-gold {
  background: linear-gradient(135deg, var(--sb-gold), #d97706);
  color: #000;
  box-shadow: 0 2px 10px var(--sb-gold-glow);
}

.sb-btn-gold:hover:not(:disabled) {
  transform: translateY(-1px);
  filter: brightness(1.1);
  box-shadow: 0 4px 20px var(--sb-gold-glow);
}

.sb-btn-gold:disabled {
  background: linear-gradient(135deg, #4a4a4a, #3a3a3a);
  color: #666;
  cursor: not-allowed;
  box-shadow: none;
  opacity: 0.6;
}

/* Purple button for AI/generating actions */
.sb-btn-purple {
  background: linear-gradient(135deg, var(--sb-purple), #9333ea);
  color: white;
  box-shadow: 0 2px 10px var(--sb-purple-glow);
}

.sb-btn-purple:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 20px var(--sb-purple-glow);
}

.sb-btn-ghost {
  background: transparent;
  color: var(--sb-text-muted);
  border: 1px solid var(--sb-border-muted);
}

.sb-btn-ghost:hover {
  border-color: var(--sb-border-accent);
  color: var(--sb-text-secondary);
  background: var(--sb-bg-card);
}

.sb-btn-outline {
  background: transparent;
  color: var(--sb-gold);
  border: 1px solid rgba(245, 158, 11, 0.4);
}

.sb-btn-outline:hover {
  background: var(--sb-gold-muted);
  border-color: var(--sb-gold);
}

.sb-btn-danger:hover {
  border-color: #ef4444;
  color: #ef4444;
  background: rgba(239, 68, 68, 0.1);
}

.sb-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none !important;
}

.sb-btn-icon {
  font-size: 14px;
}

/* ═══ MODALS — Priority 6: Modal Frame Styling ═══ */
.sb-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  backdrop-filter: blur(8px);
  animation: sb-fade-in 0.2s ease;
}

@keyframes sb-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

.sb-modal {
  background: linear-gradient(180deg, rgba(21, 21, 31, 0.98) 0%, rgba(15, 15, 22, 0.98) 100%);
  border: 1px solid var(--sb-border-accent);
  border-radius: 14px;
  width: 100%;
  max-width: 600px;
  max-height: 90vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: 
    0 0 0 1px var(--sb-border-subtle),
    0 25px 50px rgba(0, 0, 0, 0.5),
    0 0 100px var(--sb-gold-glow);
  animation: sb-modal-in 0.25s ease;
}

@keyframes sb-modal-in {
  from { 
    opacity: 0; 
    transform: scale(0.95) translateY(10px); 
  }
  to { 
    opacity: 1; 
    transform: scale(1) translateY(0); 
  }
}

.sb-modal-sm {
  max-width: 420px;
}

.sb-modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--sb-border-subtle);
  background: linear-gradient(90deg, var(--sb-gold-muted) 0%, transparent 50%);
}

.sb-modal-header h2 {
  font-size: 17px;
  font-weight: 700;
  background: linear-gradient(135deg, var(--sb-gold) 0%, var(--sb-gold-hover) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

.sb-modal-close {
  background: var(--sb-bg-card);
  border: 1px solid var(--sb-border-muted);
  color: var(--sb-text-muted);
  width: 32px;
  height: 32px;
  border-radius: 8px;
  font-size: 16px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--sb-transition-fast);
}

.sb-modal-close:hover {
  color: var(--sb-text-primary);
  border-color: var(--sb-border-accent);
  background: var(--sb-bg-card-hover);
}

.sb-modal-body {
  padding: 20px;
  overflow-y: auto;
}

.sb-modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 20px;
  border-top: 1px solid var(--sb-border-subtle);
  background: rgba(0, 0, 0, 0.2);
}

/* Forms */
.sb-form-group {
  margin-bottom: 20px;
}

.sb-form-group label {
  display: block;
  font-size: 13px;
  color: #9ca3af;
  margin-bottom: 8px;
}

.sb-form-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.sb-input, .sb-textarea {
  width: 100%;
  background: rgba(20, 20, 30, 0.8);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 10px;
  padding: 12px 16px;
  color: #e5e5e5;
  font-size: 14px;
  transition: all 0.2s;
}

.sb-input:focus, .sb-textarea:focus {
  outline: none;
  border-color: #f59e0b;
  box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.1);
}

.sb-textarea {
  resize: vertical;
  min-height: 80px;
}

.sb-color-input {
  width: 60px;
  height: 36px;
  padding: 2px;
  background: transparent;
  border: 1px solid rgba(255,255,255,0.2);
  border-radius: 8px;
  cursor: pointer;
}

.sb-char-preview {
  margin-top: 12px;
  border: 1px solid rgba(245, 158, 11, 0.3);
  border-radius: 8px;
  overflow: hidden;
  max-width: 200px;
}

.sb-char-preview img {
  width: 100%;
  height: auto;
  display: block;
}

.sb-select-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.sb-select-grid-2 {
  grid-template-columns: repeat(2, 1fr);
}

.sb-select-grid-4 {
  grid-template-columns: repeat(4, 1fr);
}

.sb-select-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 12px 8px;
  background: rgba(20, 20, 30, 0.8);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 10px;
  color: #9ca3af;
  cursor: pointer;
  font-size: 12px;
  transition: all 0.2s;
}

.sb-select-btn:hover {
  border-color: rgba(245, 158, 11, 0.5);
  color: #e5e5e5;
}

.sb-select-btn.selected {
  border-color: #f59e0b;
  background: rgba(245, 158, 11, 0.15);
  color: #f59e0b;
}

.sb-select-icon {
  font-size: 20px;
}

.sb-select-ratio {
  font-size: 10px;
  opacity: 0.6;
  font-family: monospace;
}

.sb-label-hint {
  font-size: 11px;
  color: #6b7280;
  font-weight: normal;
}

.sb-aspect-display {
  margin-top: 8px;
  font-size: 12px;
  color: #9ca3af;
  padding: 8px 12px;
  background: rgba(20, 20, 30, 0.6);
  border-radius: 6px;
  border: 1px solid rgba(255,255,255,0.05);
}

.sb-aspect-display strong {
  color: #f59e0b;
}

/* Model Selection (Create Dialog) */
.sb-model-group {
  margin-bottom: 12px;
  padding: 12px;
  background: rgba(20, 20, 30, 0.6);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 10px;
}

.sb-model-group-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  font-size: 13px;
  color: #e5e5e5;
}

.sb-model-icon {
  font-size: 16px;
}

.sb-model-badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 500;
  margin-left: auto;
}

.sb-badge-fast {
  background: rgba(16, 185, 129, 0.2);
  color: #10b981;
}

.sb-badge-quality {
  background: rgba(139, 92, 246, 0.2);
  color: #a78bfa;
}

.sb-badge-local {
  background: rgba(59, 130, 246, 0.2);
  color: #60a5fa;
}

.sb-model-options-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.sb-model-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  background: rgba(30, 30, 45, 0.8);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px;
  color: #9ca3af;
  cursor: pointer;
  font-size: 12px;
  transition: all 0.2s;
}

.sb-model-btn:hover {
  border-color: rgba(245, 158, 11, 0.5);
  color: #e5e5e5;
  background: rgba(40, 40, 55, 0.8);
}

.sb-model-btn.selected {
  border-color: #f59e0b;
  background: rgba(245, 158, 11, 0.15);
  color: #f59e0b;
}

.sb-model-name {
  font-weight: 500;
}

.sb-model-tag {
  font-size: 9px;
  padding: 2px 5px;
  background: rgba(255,255,255,0.1);
  border-radius: 3px;
  color: #6b7280;
}

.sb-model-btn.selected .sb-model-tag {
  background: rgba(245, 158, 11, 0.2);
  color: var(--g-primary);
}

/* Language Selection */
.sb-lang-btn {
  flex-direction: row !important;
  gap: 8px !important;
  justify-content: center;
}

.sb-voice-select {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sb-voice-provider {
  font-size: 11px;
  color: #6b7280;
  padding-left: 4px;
}

/* Local API Models */
.sb-model-grid {
  display: grid !important;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.sb-model-btn-local {
  flex-direction: column !important;
  align-items: flex-start !important;
  padding: 10px 12px !important;
}

.sb-model-type {
  font-size: 10px;
  color: #6b7280;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.sb-model-btn-local.selected .sb-model-type {
  color: var(--g-primary);
}

.sb-model-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  color: #9ca3af;
  font-size: 13px;
}

.sb-model-offline {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px;
  color: #6b7280;
  font-size: 13px;
}

.sb-model-hint {
  font-size: 11px;
  font-family: monospace;
  color: #4b5563;
}

.sb-badge-offline {
  background: rgba(107, 114, 128, 0.2);
  color: #9ca3af;
}

/* Character Selection in Create Dialog */
.sb-char-select-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(80px, 1fr));
  gap: 10px;
  max-height: 200px;
  overflow-y: auto;
  padding: 8px;
  background: rgba(20, 20, 30, 0.5);
  border-radius: 8px;
}

.sb-char-select-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 10px 8px;
  background: rgba(30, 30, 45, 0.8);
  border: 2px solid transparent;
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.2s;
  position: relative;
}

.sb-char-select-btn:hover {
  border-color: rgba(245, 158, 11, 0.5);
  background: rgba(40, 40, 55, 0.8);
}

.sb-char-select-btn.selected {
  border-color: #f59e0b;
  background: rgba(245, 158, 11, 0.15);
}

.sb-char-select-img {
  width: 50px;
  height: 50px;
  border-radius: 50%;
  object-fit: cover;
  border: 2px solid rgba(255,255,255,0.1);
}

.sb-char-select-btn.selected .sb-char-select-img {
  border-color: #f59e0b;
}

.sb-char-select-fallback {
  width: 50px;
  height: 50px;
  border-radius: 50%;
  background: linear-gradient(135deg, #8b5cf6, #7c3aed);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  font-weight: bold;
  color: white;
}

.sb-char-select-name {
  font-size: 11px;
  color: #9ca3af;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 70px;
}

.sb-char-select-btn.selected .sb-char-select-name {
  color: #f59e0b;
}

.sb-char-select-check {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 18px;
  height: 18px;
  background: #f59e0b;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  color: black;
  font-weight: bold;
}

.sb-char-selected-count {
  margin-top: 8px;
  font-size: 12px;
  color: #f59e0b;
  text-align: center;
}

.sb-char-empty-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 20px;
  background: rgba(20, 20, 30, 0.5);
  border-radius: 8px;
  color: #6b7280;
  font-size: 13px;
}

.sb-char-empty-hint span:first-child {
  font-size: 24px;
  opacity: 0.5;
}

.sb-hidden {
  display: none !important;
}

/* Project list styles in sidebar */
.sb-project-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* Generation Animation */
.sb-scene-card.generating-active {
  border-color: #f59e0b;
  box-shadow: 0 0 20px rgba(245, 158, 11, 0.3);
  animation: sb-card-pulse 2s ease-in-out infinite;
}

@keyframes sb-card-pulse {
  0%, 100% { box-shadow: 0 0 20px rgba(245, 158, 11, 0.3); }
  50% { box-shadow: 0 0 35px rgba(245, 158, 11, 0.5); }
}

.sb-scene-placeholder.generating-anim {
  background: linear-gradient(135deg, rgba(139, 92, 246, 0.2), rgba(245, 158, 11, 0.2));
}

.sb-gen-animation {
  position: relative;
  width: 60px;
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.sb-gen-pulse {
  position: absolute;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  background: rgba(245, 158, 11, 0.3);
  animation: sb-gen-pulse 1.5s ease-out infinite;
}

.sb-gen-ring {
  position: absolute;
  width: 100%;
  height: 100%;
  border: 3px solid transparent;
  border-top-color: #f59e0b;
  border-radius: 50%;
  animation: sb-gen-spin 1s linear infinite;
}

.sb-gen-icon {
  font-size: 24px;
  z-index: 1;
  animation: sb-gen-bounce 0.5s ease-in-out infinite alternate;
}

.sb-gen-text {
  color: #f59e0b;
  font-size: 12px;
  font-weight: 500;
  animation: sb-gen-fade 1s ease-in-out infinite;
}

@keyframes sb-gen-pulse {
  0% { transform: scale(1); opacity: 0.6; }
  100% { transform: scale(1.8); opacity: 0; }
}

@keyframes sb-gen-spin {
  to { transform: rotate(360deg); }
}

@keyframes sb-gen-bounce {
  from { transform: scale(1); }
  to { transform: scale(1.1); }
}

@keyframes sb-gen-fade {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}

/* Error Banner */
.sb-error-banner {
  background: rgba(239, 68, 68, 0.15);
  border: 1px solid rgba(239, 68, 68, 0.3);
  color: #ef4444;
  padding: 12px 16px;
  border-radius: 10px;
  margin-top: 12px;
  font-size: 14px;
}

/* Pipeline Status */
.sb-pipeline-status {
  background: rgba(245, 158, 11, 0.1);
  border: 1px solid rgba(245, 158, 11, 0.3);
  border-radius: 10px;
  padding: 12px 16px;
  margin-top: 12px;
}

.sb-pipeline-message {
  font-size: 13px;
  color: #f59e0b;
  margin-bottom: 8px;
}

.sb-pipeline-bar {
  height: 6px;
  background: rgba(255,255,255,0.1);
  border-radius: 3px;
  overflow: hidden;
}

.sb-pipeline-fill {
  height: 100%;
  background: linear-gradient(90deg, #f59e0b, var(--g-primary));
  transition: width 0.3s;
}

/* ═══════════════════════════════════════════════════════════════
   ENHANCED WORKFLOW PROGRESS COMPONENT
   ═══════════════════════════════════════════════════════════════ */

.wf-progress {
  background: linear-gradient(135deg, rgba(15, 15, 25, 0.95), rgba(25, 25, 40, 0.95));
  border: 1px solid rgba(245, 158, 11, 0.3);
  border-radius: 12px;
  padding: 16px;
  margin-top: 12px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  backdrop-filter: blur(10px);
}

.wf-progress.wf-running {
  border-color: rgba(245, 158, 11, 0.5);
  box-shadow: 0 4px 20px rgba(245, 158, 11, 0.15);
}

.wf-progress.wf-stuck {
  border-color: rgba(239, 68, 68, 0.5);
  animation: wf-stuck-pulse 2s ease-in-out infinite;
}

@keyframes wf-stuck-pulse {
  0%, 100% { box-shadow: 0 4px 20px rgba(239, 68, 68, 0.15); }
  50% { box-shadow: 0 4px 30px rgba(239, 68, 68, 0.3); }
}

.wf-progress.wf-complete {
  border-color: rgba(52, 211, 153, 0.3);
}

/* Header */
.wf-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.wf-header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.wf-status-indicator {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: rgba(245, 158, 11, 0.2);
}

.wf-status-indicator.wf-pulse {
  animation: wf-indicator-pulse 1.5s ease-in-out infinite;
}

@keyframes wf-indicator-pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.1); opacity: 0.8; }
}

.wf-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(245, 158, 11, 0.3);
  border-top-color: #f59e0b;
  border-radius: 50%;
  animation: wf-spin 0.8s linear infinite;
}

@keyframes wf-spin {
  to { transform: rotate(360deg); }
}

.wf-done-icon {
  color: #34d399;
  font-size: 14px;
  font-weight: bold;
}

.wf-stuck-icon {
  font-size: 14px;
}

.wf-status-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.wf-message {
  font-size: 14px;
  font-weight: 600;
  color: #f59e0b;
}

.wf-elapsed {
  font-size: 11px;
  color: #6b7280;
  font-family: 'JetBrains Mono', monospace;
}

.wf-header-right {
  display: flex;
  gap: 8px;
}

.wf-btn {
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.05);
  color: #9ca3af;
  transition: all 0.2s;
}

.wf-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #e5e7eb;
}

.wf-btn-log.wf-active {
  background: rgba(245, 158, 11, 0.2);
  border-color: rgba(245, 158, 11, 0.3);
  color: #f59e0b;
}

.wf-btn-cancel {
  background: rgba(239, 68, 68, 0.2);
  border-color: rgba(239, 68, 68, 0.3);
  color: #ef4444;
}

.wf-btn-cancel:hover {
  background: rgba(239, 68, 68, 0.3);
}

/* Progress Bar */
.wf-progress-bar {
  position: relative;
  height: 8px;
  background: rgba(255, 255, 255, 0.08);
  border-radius: 4px;
  overflow: hidden;
  margin-bottom: 16px;
}

.wf-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #f59e0b, var(--g-primary), #f59e0b);
  background-size: 200% 100%;
  transition: width 0.3s ease;
  border-radius: 4px;
}

.wf-progress-fill.wf-animated {
  animation: wf-progress-shimmer 2s linear infinite;
}

@keyframes wf-progress-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

.wf-progress-text {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 10px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.9);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
}

/* Steps */
.wf-steps {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.wf-steps-compact .wf-step {
  padding: 6px 10px;
}

.wf-step {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: 8px;
  transition: all 0.2s;
}

.wf-step-pending {
  opacity: 0.5;
}

.wf-step-running {
  background: rgba(245, 158, 11, 0.1);
  border-color: rgba(245, 158, 11, 0.3);
  animation: wf-step-glow 2s ease-in-out infinite;
}

@keyframes wf-step-glow {
  0%, 100% { box-shadow: 0 0 10px rgba(245, 158, 11, 0.1); }
  50% { box-shadow: 0 0 20px rgba(245, 158, 11, 0.2); }
}

.wf-step-complete {
  background: rgba(52, 211, 153, 0.1);
  border-color: rgba(52, 211, 153, 0.2);
}

.wf-step-error {
  background: rgba(239, 68, 68, 0.1);
  border-color: rgba(239, 68, 68, 0.3);
}

.wf-step-indicator {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.1);
  flex-shrink: 0;
}

.wf-step-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid rgba(245, 158, 11, 0.3);
  border-top-color: #f59e0b;
  border-radius: 50%;
  animation: wf-spin 0.6s linear infinite;
}

.wf-step-check {
  color: #34d399;
  font-size: 12px;
  font-weight: bold;
}

.wf-step-error {
  color: #ef4444;
  font-size: 12px;
  font-weight: bold;
}

.wf-step-num {
  font-size: 11px;
  font-weight: 600;
  color: #6b7280;
}

.wf-step-content {
  flex: 1;
  min-width: 0;
}

.wf-step-label {
  font-size: 13px;
  color: #e5e7eb;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: block;
}

.wf-step-duration {
  font-size: 10px;
  color: #6b7280;
  font-family: 'JetBrains Mono', monospace;
  margin-left: 8px;
}

.wf-step-error-msg {
  display: block;
  font-size: 11px;
  color: #ef4444;
  margin-top: 2px;
}

.wf-step-progress {
  width: 100%;
  height: 3px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 2px;
  margin-top: 6px;
  overflow: hidden;
}

.wf-step-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #f59e0b, var(--g-primary));
  transition: width 0.2s;
}

/* Log Panel */
.wf-log-panel {
  margin-top: 12px;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  overflow: hidden;
  animation: wf-log-slide 0.2s ease-out;
}

@keyframes wf-log-slide {
  from { opacity: 0; transform: translateY(-10px); }
  to { opacity: 1; transform: translateY(0); }
}

.wf-log-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.03);
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.wf-log-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #9ca3af;
}

.wf-log-count {
  font-size: 10px;
  color: #6b7280;
}

.wf-log-entries {
  max-height: 200px;
  overflow-y: auto;
  padding: 8px;
}

.wf-log-entries::-webkit-scrollbar {
  width: 6px;
}

.wf-log-entries::-webkit-scrollbar-track {
  background: transparent;
}

.wf-log-entries::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.1);
  border-radius: 3px;
}

.wf-log-empty {
  padding: 20px;
  text-align: center;
  color: #4b5563;
  font-size: 12px;
  font-style: italic;
}

.wf-log-entry {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 4px;
  margin-bottom: 4px;
  font-size: 12px;
  background: rgba(255, 255, 255, 0.02);
}

.wf-log-entry:hover {
  background: rgba(255, 255, 255, 0.05);
}

.wf-log-time {
  font-size: 10px;
  font-family: 'JetBrains Mono', monospace;
  color: #4b5563;
  flex-shrink: 0;
}

.wf-log-icon {
  flex-shrink: 0;
  width: 14px;
  text-align: center;
}

.wf-log-info .wf-log-icon { color: #60a5fa; }
.wf-log-success .wf-log-icon { color: #34d399; }
.wf-log-warning .wf-log-icon { color: var(--g-primary); }
.wf-log-error .wf-log-icon { color: #ef4444; }

.wf-log-message {
  color: #d1d5db;
  flex: 1;
}

.wf-log-details {
  display: block;
  font-size: 11px;
  color: #6b7280;
  margin-top: 2px;
  padding-left: 22px;
  font-family: 'JetBrains Mono', monospace;
}

/* Spinner */
.sb-spinner {
  width: 24px;
  height: 24px;
  border: 2px solid rgba(245, 158, 11, 0.2);
  border-top-color: #f59e0b;
  border-radius: 50%;
  animation: sb-spin 1s linear infinite;
}

.sb-spinner-sm {
  display: inline-block;
  width: 16px;
  height: 16px;
  border: 2px solid rgba(245, 158, 11, 0.2);
  border-top-color: #f59e0b;
  border-radius: 50%;
  animation: sb-spin 1s linear infinite;
  vertical-align: middle;
  margin-right: 6px;
}

@keyframes sb-spin {
  to { transform: rotate(360deg); }
}

/* Sidebar Loading/Empty */
.sb-sidebar-loading, .sb-sidebar-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  text-align: center;
  color: #6b7280;
  gap: 12px;
}

.sb-empty-icon {
  font-size: 32px;
  opacity: 0.5;
}

.sb-empty-chars {
  color: #6b7280;
  font-size: 13px;
  padding: 8px;
}

/* Export Dialog */
.sb-export-info {
  background: rgba(245, 158, 11, 0.1);
  border: 1px solid rgba(245, 158, 11, 0.3);
  border-radius: 10px;
  padding: 16px;
  margin-bottom: 20px;
}

.sb-export-info p {
  margin: 4px 0;
  color: #f59e0b;
}

.sb-export-section {
  margin-bottom: 24px;
}

.sb-export-section h3 {
  font-size: 15px;
  font-weight: 500;
  color: #e5e5e5;
  margin-bottom: 8px;
}

.sb-section-desc {
  font-size: 12px;
  color: #6b7280;
  margin-bottom: 12px;
}

.sb-slider-group {
  display: flex;
  align-items: center;
  gap: 12px;
}

.sb-slider {
  flex: 1;
  -webkit-appearance: none;
  appearance: none;
  height: 6px;
  background: rgba(255,255,255,0.1);
  border-radius: 3px;
  outline: none;
}

.sb-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 16px;
  height: 16px;
  background: linear-gradient(135deg, #f59e0b, #d97706);
  border-radius: 50%;
  cursor: pointer;
}

.sb-slider::-moz-range-thumb {
  width: 16px;
  height: 16px;
  background: linear-gradient(135deg, #f59e0b, #d97706);
  border-radius: 50%;
  cursor: pointer;
  border: none;
}

.sb-slider-value {
  min-width: 45px;
  text-align: right;
  font-size: 13px;
  color: #f59e0b;
  font-weight: 500;
}

.sb-export-result {
  text-align: center;
  padding: 24px;
}

.sb-export-result.success {
  color: #10b981;
}

.sb-export-result.error {
  color: #ef4444;
}

.sb-result-icon {
  font-size: 48px;
  margin-bottom: 16px;
}

.sb-export-result h3 {
  font-size: 20px;
  margin-bottom: 12px;
}

.sb-result-path {
  font-family: monospace;
  font-size: 12px;
  background: rgba(16, 185, 129, 0.1);
  padding: 12px;
  border-radius: 8px;
  word-break: break-all;
}

.sb-result-error {
  font-size: 14px;
  background: rgba(239, 68, 68, 0.1);
  padding: 12px;
  border-radius: 8px;
}

/* ═══ Export Effects Summary ═══ */
.sb-effects-summary {
  background: rgba(30, 30, 45, 0.5);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  padding: 16px;
}

.sb-effects-summary h3 {
  margin-bottom: 12px;
}

.sb-effects-active {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #10b981 !important;
  font-weight: 500;
}

.sb-effects-active .sb-check-icon {
  width: 18px;
  height: 18px;
  background: rgba(16, 185, 129, 0.2);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
}

.sb-effects-none {
  color: #6b7280;
  font-style: italic;
}

.sb-effects-hint {
  font-size: 12px;
  color: #9ca3af;
  margin-top: 8px;
  padding: 10px;
  background: rgba(245, 158, 11, 0.08);
  border-radius: 8px;
  border-left: 3px solid #f59e0b;
}

.sb-effects-preview {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 12px;
  padding: 12px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 8px;
}

.sb-effects-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.sb-effects-label {
  flex-shrink: 0;
  width: 70px;
  font-size: 11px;
  font-weight: 600;
  color: #9ca3af;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding-top: 6px;
}

.sb-effects-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.sb-effect-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  background: linear-gradient(135deg, rgba(245, 158, 11, 0.15) 0%, rgba(245, 158, 11, 0.08) 100%);
  border: 1px solid rgba(245, 158, 11, 0.3);
  border-radius: 20px;
  font-size: 12px;
  color: #f59e0b;
  font-weight: 500;
}

.sb-effect-tag.sb-effect-overlay {
  background: linear-gradient(135deg, rgba(168, 85, 247, 0.15) 0%, rgba(168, 85, 247, 0.08) 100%);
  border-color: rgba(168, 85, 247, 0.3);
  color: #a855f7;
}

.sb-effect-count {
  font-size: 10px;
  padding: 1px 5px;
  background: rgba(255, 255, 255, 0.15);
  border-radius: 10px;
  font-weight: 600;
}

.sb-effects-note {
  font-size: 11px;
  color: #6b7280;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

/* ═══════════════════════════════════════════════════════════════
   SCENE EDITOR MODAL
   ═══════════════════════════════════════════════════════════════ */

.sb-modal-lg {
  max-width: 900px;
}

.sb-scene-editor-modal {
  max-height: 85vh;
}

.sb-scene-editor-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.sb-scene-nav {
  display: flex;
  align-items: center;
  gap: 12px;
}

.sb-nav-btn {
  background: rgba(245, 158, 11, 0.15);
  border: 1px solid rgba(245, 158, 11, 0.4);
  color: #f59e0b;
  width: 36px;
  height: 36px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
}

.sb-nav-btn:hover:not(:disabled) {
  background: rgba(245, 158, 11, 0.25);
  border-color: #f59e0b;
}

.sb-nav-btn:disabled, .sb-nav-btn.disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.sb-scene-counter {
  font-size: 16px;
  font-weight: 500;
  color: #e5e5e5;
  min-width: 120px;
  text-align: center;
}

.sb-scene-editor-body {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 24px;
  padding: 24px;
}

.sb-scene-preview {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.sb-scene-preview-image {
  aspect-ratio: 16/9;
  background: rgba(10, 10, 15, 0.9);
  border: 1px solid rgba(245, 158, 11, 0.2);
  border-radius: 12px;
  overflow: hidden;
}

.sb-scene-preview-image img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.sb-scene-preview-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #6b7280;
  gap: 12px;
  font-size: 14px;
}

.sb-scene-preview-placeholder .sb-spinner {
  width: 32px;
  height: 32px;
}

.sb-regenerate-btn {
  width: 100%;
}

.sb-scene-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
  overflow-y: auto;
  max-height: 450px;
  padding-right: 8px;
}

.sb-scene-form::-webkit-scrollbar {
  width: 6px;
}

.sb-scene-form::-webkit-scrollbar-track {
  background: rgba(255,255,255,0.05);
  border-radius: 3px;
}

.sb-scene-form::-webkit-scrollbar-thumb {
  background: rgba(245, 158, 11, 0.3);
  border-radius: 3px;
}

.sb-scene-form::-webkit-scrollbar-thumb:hover {
  background: rgba(245, 158, 11, 0.5);
}

.sb-duration-input {
  display: flex;
  align-items: center;
  gap: 12px;
}

.sb-duration-input .sb-input {
  max-width: 100px;
}

.sb-duration-label {
  color: #f59e0b;
  font-weight: 500;
  font-size: 14px;
}

.sb-scene-editor-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.sb-footer-right {
  display: flex;
  gap: 12px;
}

/* Mobile responsiveness for Scene Editor */
@media (max-width: 768px) {
  .sb-scene-editor-body {
    grid-template-columns: 1fr;
    gap: 16px;
  }
  
  .sb-scene-form {
    max-height: none;
  }
  
  .sb-scene-editor-modal {
    max-height: 95vh;
  }
}

/* ══════════════════════════════════════════════════════════════
   EFFECT PREVIEW (CSS Animation)
   ══════════════════════════════════════════════════════════════ */

.sb-effect-preview {
  margin-top: 16px;
  border: 1px solid rgba(245, 158, 11, 0.2);
  border-radius: 12px;
  overflow: hidden;
  background: rgba(0, 0, 0, 0.4);
}

.sb-effect-preview-label {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: rgba(245, 158, 11, 0.1);
  font-size: 12px;
  color: #f59e0b;
}

.sb-effect-preview-hint {
  font-size: 10px;
  color: #6b7280;
}

.sb-effect-preview-container {
  aspect-ratio: 16/9;
  overflow: hidden;
  position: relative;
  border-radius: 8px; /* Clip corners */
}

.sb-effect-preview-wrapper {
  width: 100%;
  height: 100%;
  position: relative;
  overflow: hidden;
  isolation: isolate; /* Create stacking context */
}

.sb-effect-preview-wrapper img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  will-change: transform;
}

.sb-effect-overlay-vignette {
  position: absolute;
  inset: 0;
  background: radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.7) 100%);
  pointer-events: none;
}

.sb-effect-overlay-scanlines {
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(
    0deg,
    transparent,
    transparent 2px,
    rgba(0, 0, 0, 0.2) 2px,
    rgba(0, 0, 0, 0.2) 4px
  );
  pointer-events: none;
  animation: scanline-move 0.5s linear infinite;
}

@keyframes scanline-move {
  0% { transform: translateY(0); }
  100% { transform: translateY(4px); }
}

/* Effect: None - static */
.effect-none img {
  animation: none;
}

/* Effect: Ken Burns - slow zoom and pan */
.effect-ken-burns img {
  animation: effect-ken-burns 6s ease-in-out infinite alternate;
}

@keyframes effect-ken-burns {
  0% { transform: scale(1) translate(0, 0); }
  100% { transform: scale(1.15) translate(-3%, -2%); }
}

/* Effect: Dramatic Push - forward zoom with speed ramp */
.effect-dramatic-push img {
  animation: effect-dramatic-push 4s ease-in-out infinite;
}

@keyframes effect-dramatic-push {
  0% { transform: scale(1); }
  50% { transform: scale(1.12); }
  100% { transform: scale(1.25); }
}

/* Effect: Pull Back Reveal - quick transition at END of scene */
.effect-pull-back img {
  /* Stays zoomed for 2.2s, then 0.8s transition, loops for preview */
  animation: effect-pull-back-hold 3s ease-out infinite;
}

@keyframes effect-pull-back-hold {
  0%, 73% { transform: scale(1.4); filter: blur(2px); } /* Hold zoomed until end */
  100% { transform: scale(1); filter: blur(0); } /* Quick pull-back in last 0.8s */
}

/* Effect: Parallax - horizontal drift */
.effect-parallax img {
  animation: effect-parallax 6s ease-in-out infinite alternate;
}

@keyframes effect-parallax {
  0% { transform: scale(1.1) translateX(-5%); }
  100% { transform: scale(1.1) translateX(5%); }
}

/* Effect: Punch Zoom - quick impact zoom */
.effect-punch-zoom img {
  animation: effect-punch-zoom 3s ease-out infinite;
}

@keyframes effect-punch-zoom {
  0% { transform: scale(1); }
  5% { transform: scale(1.05); }
  10% { transform: scale(1.02); }
  100% { transform: scale(1.15); }
}

/* Effect: Slow Drift - very subtle movement */
.effect-slow-drift img {
  animation: effect-slow-drift 8s linear infinite alternate;
}

@keyframes effect-slow-drift {
  0% { transform: scale(1.02) translate(0, 0); }
  100% { transform: scale(1.05) translate(1%, 1%); }
}

/* Effect: Glitch - with shake and color shift */
.effect-glitch img {
  animation: effect-glitch 4s ease-in-out infinite;
}

@keyframes effect-glitch {
  0%, 100% { transform: scale(1.05) translate(0, 0); filter: hue-rotate(0deg); }
  10% { transform: scale(1.06) translate(1px, 0); filter: hue-rotate(10deg); }
  20% { transform: scale(1.05) translate(-1px, 0); filter: hue-rotate(0deg); }
  50% { transform: scale(1.08) translate(0, 0); filter: hue-rotate(0deg); }
  51% { transform: scale(1.08) translate(2px, 0); filter: hue-rotate(-20deg); }
  52% { transform: scale(1.08) translate(-2px, 0); filter: hue-rotate(20deg); }
  53% { transform: scale(1.08) translate(0, 0); filter: hue-rotate(0deg); }
  100% { transform: scale(1.1) translate(0, 0); filter: hue-rotate(0deg); }
}

/* Effect: Spin Reveal - quick transition at END of scene */
.effect-spin-reveal img {
  /* Stays hidden/small for 2.3s, then 0.7s spin-in, loops for preview */
  animation: effect-spin-reveal-hold 3s ease-out infinite;
}

@keyframes effect-spin-reveal-hold {
  0%, 77% { transform: scale(0.5) rotate(180deg); opacity: 0.5; } /* Hold until end */
  100% { transform: scale(1.05) rotate(0deg); opacity: 1; } /* Quick spin-in in last 0.7s */
}

/* ═══ OVERLAY EFFECTS ═══ */

/* Effect: Atmospheric Mist - breathing fog overlay */
.effect-atmospheric-mist {
  position: relative;
  overflow: hidden;
}

.effect-atmospheric-mist img {
  animation: effect-mist-breathe 6s ease-in-out infinite;
}

.effect-atmospheric-mist::before,
.effect-atmospheric-mist::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 2;
}

/* Mist layer - fades from bottom up */
.effect-atmospheric-mist::before {
  background: linear-gradient(
    0deg,
    rgba(180, 200, 220, 0.2) 0%,
    rgba(180, 200, 220, 0.12) 25%,
    transparent 50%
  );
  animation: effect-mist-drift 8s ease-in-out infinite alternate;
}

/* Floating mist at bottom + vignette */
.effect-atmospheric-mist::after {
  background: 
    radial-gradient(
      ellipse 150% 50% at 50% 85%,
      rgba(200, 210, 230, 0.18) 0%,
      transparent 70%
    ),
    radial-gradient(
      ellipse at center,
      transparent 40%,
      rgba(0, 0, 0, 0.4) 100%
    );
  animation: effect-mist-pulse 6s ease-in-out infinite alternate-reverse;
}

@keyframes effect-mist-breathe {
  0%, 100% { transform: scale(1.02) translateY(0%); }
  50% { transform: scale(1.05) translateY(-0.5%); }
}

@keyframes effect-mist-drift {
  0% { transform: translateX(-10px); opacity: 0.8; }
  100% { transform: translateX(10px); opacity: 1; }
}

@keyframes effect-mist-pulse {
  0% { opacity: 0.7; }
  100% { opacity: 1; }
}

/* Effect: Cinematic Grain - film texture overlay */
.effect-cinematic-grain {
  position: relative;
  overflow: hidden;
}

.effect-cinematic-grain img {
  animation: effect-grain-flicker 0.1s steps(1) infinite;
  filter: contrast(1.05) saturate(0.9) sepia(0.1);
}

.effect-cinematic-grain::before {
  content: '';
  position: absolute;
  inset: 0;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");
  opacity: 0.08;
  pointer-events: none;
  z-index: 2;
  mix-blend-mode: overlay;
  animation: effect-grain-shift 0.3s steps(2) infinite;
}

@keyframes effect-grain-flicker {
  0%, 50% { filter: contrast(1.05) saturate(0.9) sepia(0.1) brightness(1); }
  25% { filter: contrast(1.06) saturate(0.88) sepia(0.12) brightness(1.01); }
  75% { filter: contrast(1.04) saturate(0.92) sepia(0.08) brightness(0.99); }
}

@keyframes effect-grain-shift {
  0% { transform: translate(0, 0); }
  50% { transform: translate(-1px, 1px); }
  100% { transform: translate(1px, -1px); }
}

/* Effect: Light Leak - analog flare overlay */
.effect-light-leak {
  position: relative;
  overflow: hidden;
}

.effect-light-leak img {
  animation: effect-leak-base 8s ease-in-out infinite;
}

.effect-light-leak::before,
.effect-light-leak::after {
  content: '';
  position: absolute;
  /* Extend beyond container to hide edges during animation */
  top: -50%;
  left: -50%;
  width: 200%;
  height: 200%;
  pointer-events: none;
  z-index: 2;
  mix-blend-mode: screen;
}

.effect-light-leak::before {
  background: radial-gradient(
    ellipse 40% 60% at 30% 40%,
    rgba(255, 180, 100, 0.35) 0%,
    rgba(255, 140, 80, 0.15) 40%,
    transparent 70%
  );
  animation: effect-leak-sweep 6s ease-in-out infinite;
}

.effect-light-leak::after {
  background: radial-gradient(
    ellipse 35% 45% at 70% 30%,
    rgba(255, 200, 150, 0.25) 0%,
    rgba(255, 160, 100, 0.1) 50%,
    transparent 70%
  );
  animation: effect-leak-pulse 5s ease-in-out infinite alternate;
}

@keyframes effect-leak-base {
  0%, 100% { filter: brightness(1) saturate(1.1); }
  50% { filter: brightness(1.05) saturate(1.15); }
}

@keyframes effect-leak-sweep {
  0% { opacity: 0.5; transform: translate(-10%, -5%) rotate(-3deg); }
  50% { opacity: 0.9; transform: translate(5%, 5%) rotate(2deg); }
  100% { opacity: 0.5; transform: translate(-10%, -5%) rotate(-3deg); }
}

@keyframes effect-leak-pulse {
  0% { opacity: 0.4; transform: translate(0%, 0%) scale(1); }
  100% { opacity: 0.7; transform: translate(-5%, 5%) scale(1.1); }
}

/* Effect: Dust Particles - floating motes */
.effect-dust-particles {
  position: relative;
  overflow: hidden;
}

.effect-dust-particles img {
  animation: effect-dust-base 10s linear infinite alternate;
}

.effect-dust-particles::before {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 2;
  background-image: 
    radial-gradient(circle at 20% 30%, rgba(255,255,255,0.6) 1px, transparent 1px),
    radial-gradient(circle at 80% 20%, rgba(255,255,255,0.5) 1px, transparent 1px),
    radial-gradient(circle at 40% 70%, rgba(255,255,255,0.4) 1.5px, transparent 1.5px),
    radial-gradient(circle at 70% 60%, rgba(255,255,255,0.5) 1px, transparent 1px),
    radial-gradient(circle at 10% 80%, rgba(255,255,255,0.3) 1px, transparent 1px),
    radial-gradient(circle at 90% 50%, rgba(255,255,255,0.4) 1px, transparent 1px),
    radial-gradient(circle at 50% 10%, rgba(255,255,255,0.5) 1.5px, transparent 1.5px),
    radial-gradient(circle at 30% 50%, rgba(255,255,255,0.3) 1px, transparent 1px);
  background-size: 100% 100%;
  animation: effect-dust-float 12s ease-in-out infinite;
}

.effect-dust-particles::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 2;
  background-image: 
    radial-gradient(circle at 60% 40%, rgba(255,255,255,0.4) 1px, transparent 1px),
    radial-gradient(circle at 25% 60%, rgba(255,255,255,0.3) 1.5px, transparent 1.5px),
    radial-gradient(circle at 85% 75%, rgba(255,255,255,0.5) 1px, transparent 1px),
    radial-gradient(circle at 15% 25%, rgba(255,255,255,0.4) 1px, transparent 1px),
    radial-gradient(circle at 75% 85%, rgba(255,255,255,0.3) 1px, transparent 1px);
  background-size: 100% 100%;
  animation: effect-dust-float-alt 15s ease-in-out infinite reverse;
}

@keyframes effect-dust-base {
  0% { transform: scale(1.02); }
  100% { transform: scale(1.05); }
}

@keyframes effect-dust-float {
  0% { transform: translateY(5%) translateX(2%); opacity: 0.6; }
  50% { transform: translateY(-3%) translateX(-1%); opacity: 0.9; }
  100% { transform: translateY(5%) translateX(2%); opacity: 0.6; }
}

@keyframes effect-dust-float-alt {
  0% { transform: translateY(-3%) translateX(-2%); opacity: 0.5; }
  50% { transform: translateY(4%) translateX(3%); opacity: 0.8; }
  100% { transform: translateY(-3%) translateX(-2%); opacity: 0.5; }
}

/* ══════════════════════════════════════════════════════════════
   VIDEO PREVIEW WITH TIMELINE
   ══════════════════════════════════════════════════════════════ */

/* ═══ VIDEO PREVIEW ═══ */
.sb-video-preview {
  background: linear-gradient(180deg, var(--sb-bg-elevated) 0%, var(--sb-bg-card) 100%);
  border: 1px solid var(--sb-border-subtle);
  border-radius: 14px;
  padding: 0;
  margin-bottom: 20px;
  overflow: hidden;
  box-shadow: 
    0 4px 20px rgba(0, 0, 0, 0.3),
    inset 0 1px 0 rgba(255, 255, 255, 0.02);
}

.sb-video-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0.25) 0%, rgba(0, 0, 0, 0.15) 100%);
  border-bottom: 1px solid var(--sb-border-subtle);
}

/* ═══ EFFECTS TOOLBAR — Priority 3: Consolidation ═══ */
.sb-video-effects-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  justify-content: center;
  padding: 4px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 8px;
  border: 1px solid var(--sb-border-subtle);
}

.sb-effects-label {
  font-size: 10px;
  font-weight: 600;
  color: var(--sb-text-dim);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 0 6px;
}

.sb-effects-select {
  background: var(--sb-gold-muted);
  border: 1px solid rgba(245, 158, 11, 0.25);
  border-radius: 5px;
  padding: 5px 10px;
  color: var(--sb-gold);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--sb-transition-fast);
}

.sb-effects-select:hover {
  background: rgba(245, 158, 11, 0.2);
  border-color: rgba(245, 158, 11, 0.4);
}

.sb-effects-select:focus {
  outline: none;
  border-color: var(--sb-gold);
  box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.1);
}

.sb-select-motion {
  border-color: rgba(59, 130, 246, 0.25);
  background: rgba(59, 130, 246, 0.1);
  color: #60a5fa;
}

.sb-select-motion:hover {
  background: rgba(59, 130, 246, 0.18);
}

.sb-select-transition {
  border-color: rgba(168, 85, 247, 0.25);
  background: var(--sb-purple-muted);
  color: var(--sb-purple-hover);
}

.sb-select-transition:hover {
  background: rgba(168, 85, 247, 0.2);
}

.sb-select-overlay {
  border-color: rgba(34, 197, 94, 0.25);
  background: rgba(34, 197, 94, 0.1);
  color: #4ade80;
}

.sb-select-overlay:hover {
  background: rgba(34, 197, 94, 0.18);
}

/* Effects toolbar quick action buttons */
.sb-btn-randomize {
  background: linear-gradient(135deg, var(--sb-gold-muted) 0%, var(--sb-purple-muted) 100%);
  border: 1px solid rgba(245, 158, 11, 0.3);
  color: var(--sb-gold-hover);
  font-weight: 600;
  font-size: 11px;
  padding: 5px 10px;
}

.sb-btn-randomize:hover {
  background: linear-gradient(135deg, rgba(245, 158, 11, 0.25) 0%, rgba(168, 85, 247, 0.25) 100%);
  border-color: var(--sb-gold);
  transform: translateY(-1px);
}

.sb-segment-effect {
  position: absolute;
  bottom: 2px;
  right: 2px;
  font-size: 10px;
  background: rgba(0, 0, 0, 0.6);
  border-radius: 3px;
  padding: 1px 3px;
  line-height: 1;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.sb-video-header h3 {
  font-size: 13px;
  font-weight: 600;
  color: var(--sb-text-muted);
  display: flex;
  align-items: center;
  gap: 6px;
}

.sb-video-duration {
  font-size: 12px;
  color: var(--sb-gold);
  font-family: 'JetBrains Mono', monospace;
  font-weight: 700;
  padding: 3px 8px;
  background: var(--sb-gold-muted);
  border-radius: 5px;
}

.sb-video-player {
  background: linear-gradient(180deg, rgba(0, 0, 0, 0.6) 0%, rgba(0, 0, 0, 0.4) 100%);
  overflow: hidden;
  position: relative;
  aspect-ratio: 16/9;
}

.sb-video-element {
  width: 100%;
  height: 100%;
  aspect-ratio: 16/9;
  object-fit: contain;
  display: block;
}

.sb-video-placeholder {
  padding: 40px 24px;
  text-align: center;
  color: #6b7280;
  aspect-ratio: 16/9;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.sb-video-placeholder p {
  margin-top: 16px;
  font-size: 12px;
  color: #4b5563;
}

.sb-video-scenes-preview {
  display: flex;
  justify-content: center;
  gap: 12px;
  flex-wrap: wrap;
  max-width: 700px;
}

.sb-video-thumb {
  width: 100px;
  height: 56px;
  border-radius: 8px;
  overflow: hidden;
  border: 2px solid rgba(255, 255, 255, 0.1);
  transition: all 0.25s ease;
  cursor: pointer;
  position: relative;
}

.sb-video-thumb:hover {
  border-color: rgba(245, 158, 11, 0.5);
  transform: scale(1.05);
}

.sb-video-thumb.active {
  border-color: #f59e0b;
  box-shadow: 0 0 20px rgba(245, 158, 11, 0.5);
  transform: scale(1.08);
}

.sb-video-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.sb-thumb-pending {
  width: 100%;
  height: 100%;
  background: rgba(100, 100, 100, 0.2);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  color: #4b5563;
}

.sb-thumb-more {
  background: linear-gradient(135deg, rgba(245, 158, 11, 0.15), rgba(245, 158, 11, 0.05));
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 600;
  color: #f59e0b;
}

/* Hero Preview - 16:9 aspect ratio container */
.sb-video-hero {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  max-height: 500px;
  overflow: hidden;
  background: #0a0a0f;
}

.sb-hero-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: opacity 0.3s ease;
}

/* Effect wrapper for live CSS animations in main preview */
.sb-hero-effect-wrapper {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.sb-hero-effect-wrapper img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  will-change: transform;
}

/* Only animate when playing - run once per scene using scene duration */
.sb-hero-effect-wrapper {
  --scene-duration: 5s; /* Default, overridden by inline style */
}

.sb-hero-effect-wrapper.playing.effect-ken-burns img {
  animation: hero-ken-burns var(--scene-duration) ease-in-out forwards;
}

.sb-hero-effect-wrapper.playing.effect-dramatic-push img {
  animation: hero-dramatic-push var(--scene-duration) ease-in-out forwards;
}

.sb-hero-effect-wrapper.playing.effect-pull-back img {
  animation: hero-pull-back var(--scene-duration) ease-out forwards;
}

.sb-hero-effect-wrapper.playing.effect-parallax img {
  animation: hero-parallax var(--scene-duration) ease-in-out forwards;
}

.sb-hero-effect-wrapper.playing.effect-punch-zoom img {
  animation: hero-punch-zoom var(--scene-duration) ease-out forwards;
}

.sb-hero-effect-wrapper.playing.effect-slow-drift img {
  animation: hero-slow-drift var(--scene-duration) linear forwards;
}

.sb-hero-effect-wrapper.playing.effect-glitch img {
  animation: hero-glitch var(--scene-duration) ease-in-out forwards;
}

.sb-hero-effect-wrapper.playing.effect-spin-reveal img {
  animation: hero-spin-reveal var(--scene-duration) ease-out forwards;
}

/* Hero-specific animations (run once, match scene duration) */
@keyframes hero-ken-burns {
  0% { transform: scale(1) translate(0, 0); }
  100% { transform: scale(1.15) translate(-3%, -2%); }
}

@keyframes hero-dramatic-push {
  0% { transform: scale(1); }
  100% { transform: scale(1.25); }
}

@keyframes hero-pull-back {
  0% { transform: scale(1.4); filter: blur(2px); }
  100% { transform: scale(1); filter: blur(0); }
}

@keyframes hero-parallax {
  0% { transform: scale(1.1) translateX(-5%); }
  100% { transform: scale(1.1) translateX(5%); }
}

@keyframes hero-punch-zoom {
  0% { transform: scale(1); }
  10% { transform: scale(1.08); }
  20% { transform: scale(1.04); }
  100% { transform: scale(1.15); }
}

@keyframes hero-slow-drift {
  0% { transform: scale(1.02) translate(0, 0); }
  100% { transform: scale(1.05) translate(1%, 1%); }
}

@keyframes hero-glitch {
  0%, 100% { transform: scale(1.05) translate(0, 0); filter: hue-rotate(0deg); }
  25% { transform: scale(1.06) translate(2px, 0); filter: hue-rotate(15deg); }
  50% { transform: scale(1.08) translate(-2px, 0); filter: hue-rotate(-15deg); }
  75% { transform: scale(1.1) translate(1px, 0); filter: hue-rotate(10deg); }
}

@keyframes hero-spin-reveal {
  0% { transform: scale(0.5) rotate(180deg); opacity: 0.5; }
  40% { transform: scale(1.05) rotate(0deg); opacity: 1; }
  100% { transform: scale(1.1) rotate(0deg); opacity: 1; }
}

/* Effect badge in overlay */
.sb-hero-effect-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  padding: 4px 10px;
  background: rgba(245, 158, 11, 0.2);
  border: 1px solid rgba(245, 158, 11, 0.4);
  border-radius: 12px;
  font-size: 12px;
  color: #f59e0b;
}

.sb-hero-play-btn {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 80px;
  height: 80px;
  background: rgba(245, 158, 11, 0.9);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.25s ease;
  box-shadow: 0 4px 30px rgba(245, 158, 11, 0.4);
  z-index: 10;
}

.sb-hero-play-btn:hover {
  transform: translate(-50%, -50%) scale(1.1);
  background: #f59e0b;
  box-shadow: 0 6px 40px rgba(245, 158, 11, 0.6);
}

.sb-play-icon {
  font-size: 32px;
  color: #000;
  margin-left: 6px;
}

.sb-hero-overlay {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  padding: 50px 24px 20px;
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.95));
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sb-hero-title {
  font-size: 20px;
  font-weight: 600;
  color: #f5f5f5;
}

.sb-hero-hint {
  font-size: 13px;
  color: #9ca3af;
}

.sb-hero-empty {
  width: 100%;
  height: 100%;
  min-height: 250px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: #4b5563;
}

.sb-hero-empty span {
  font-size: 56px;
  opacity: 0.5;
}

.sb-hero-empty p {
  font-size: 14px;
}

/* Playback Progress */
.sb-playback-progress {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 4px;
  background: rgba(0, 0, 0, 0.5);
  z-index: 15;
}

.sb-progress-bar {
  height: 100%;
  background: linear-gradient(90deg, #f59e0b, var(--g-primary));
  transition: width 0.1s linear;
}

.sb-hero-play-btn.playing {
  background: rgba(0, 0, 0, 0.7);
  border: 2px solid rgba(245, 158, 11, 0.6);
}

.sb-hero-play-btn.playing:hover {
  background: rgba(0, 0, 0, 0.8);
}

.sb-hero-play-btn.playing .sb-play-icon {
  color: #f59e0b;
  margin-left: 0;
}

.sb-hero-image.playing {
  animation: fadeInScene 0.3s ease;
}

@keyframes fadeInScene {
  from { opacity: 0.7; }
  to { opacity: 1; }
}

.sb-hero-scene-num {
  font-size: 12px;
  color: #f59e0b;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1px;
}

.sb-timeline-segment.playing {
  background: linear-gradient(180deg, rgba(245, 158, 11, 0.8) 0%, rgba(245, 158, 11, 0.5) 100%) !important;
  box-shadow: 0 0 15px rgba(245, 158, 11, 0.5);
}

/* Volume Control */
.sb-volume-control {
  position: absolute;
  top: 16px;
  right: 16px;
  display: flex;
  align-items: center;
  gap: 8px;
  background: rgba(0, 0, 0, 0.8);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 24px;
  padding: 6px 12px 6px 6px;
  z-index: 20;
  transition: all 0.2s ease;
}

.sb-volume-control:hover {
  background: rgba(0, 0, 0, 0.95);
  border-color: rgba(245, 158, 11, 0.5);
}

.sb-mute-btn {
  width: 36px;
  height: 36px;
  background: transparent;
  border: none;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 18px;
  transition: all 0.2s ease;
}

.sb-mute-btn:hover {
  background: rgba(245, 158, 11, 0.2);
}

.sb-volume-slider {
  width: 80px;
  height: 4px;
  -webkit-appearance: none;
  appearance: none;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 2px;
  cursor: pointer;
}

.sb-volume-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 14px;
  height: 14px;
  background: #f59e0b;
  border-radius: 50%;
  cursor: pointer;
  transition: transform 0.15s ease;
}

.sb-volume-slider::-webkit-slider-thumb:hover {
  transform: scale(1.2);
}

.sb-volume-slider::-moz-range-thumb {
  width: 14px;
  height: 14px;
  background: #f59e0b;
  border-radius: 50%;
  cursor: pointer;
  border: none;
}

/* Form Label Row */
.sb-form-label-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.sb-form-label-row label {
  margin-bottom: 0;
}

/* Voice Modal Styles */
.sb-voice-preview {
  background: rgba(0, 0, 0, 0.3);
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 20px;
}

.sb-voice-preview h4 {
  font-size: 12px;
  color: #9ca3af;
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.sb-voice-text {
  color: #e5e5e5;
  font-size: 14px;
  line-height: 1.6;
  font-style: italic;
}

.sb-voice-selection h4 {
  font-size: 14px;
  color: #9ca3af;
  margin-bottom: 12px;
}

.sb-voice-group {
  margin-bottom: 16px;
}

.sb-voice-group-label {
  display: block;
  font-size: 12px;
  color: #6b7280;
  margin-bottom: 8px;
}

.sb-voice-options {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.sb-voice-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.sb-voice-option:hover {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(245, 158, 11, 0.3);
}

.sb-voice-option.selected {
  background: rgba(245, 158, 11, 0.1);
  border-color: rgba(245, 158, 11, 0.5);
}

.sb-voice-option input[type="radio"] {
  accent-color: #f59e0b;
}

.sb-voice-name {
  font-size: 14px;
  color: #e5e5e5;
}

/* ═══ TIMELINE — Priority 1: Timeline Redesign ═══ */
.sb-timeline {
  position: relative;
  padding: 14px 16px 10px;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0.25) 0%, rgba(0, 0, 0, 0.15) 100%);
  border-top: 1px solid var(--sb-border-subtle);
}

.sb-timeline-track {
  display: flex;
  height: 44px;
  background: rgba(0, 0, 0, 0.35);
  border-radius: 10px;
  overflow: hidden;
  box-shadow: 
    inset 0 2px 6px rgba(0, 0, 0, 0.4),
    0 1px 0 rgba(255, 255, 255, 0.02);
  border: 1px solid var(--sb-border-subtle);
}

.sb-timeline-segment {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all var(--sb-transition-fast);
  border-right: 1px solid rgba(0, 0, 0, 0.4);
  position: relative;
  min-width: 12px;
}

.sb-timeline-segment:last-child {
  border-right: none;
}

.sb-timeline-segment.complete {
  background: linear-gradient(180deg, rgba(16, 185, 129, 0.45) 0%, rgba(16, 185, 129, 0.2) 100%);
}

.sb-timeline-segment.pending {
  background: linear-gradient(180deg, rgba(75, 85, 99, 0.3) 0%, rgba(55, 65, 81, 0.15) 100%);
}

/* Purple generating state on timeline */
.sb-timeline-segment.generating {
  background: linear-gradient(180deg, rgba(168, 85, 247, 0.5) 0%, rgba(168, 85, 247, 0.25) 100%);
  animation: sb-timeline-pulse 1.5s ease-in-out infinite;
}

@keyframes sb-timeline-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.7; }
}

.sb-timeline-segment.failed {
  background: linear-gradient(180deg, rgba(239, 68, 68, 0.45) 0%, rgba(239, 68, 68, 0.2) 100%);
}

.sb-timeline-segment.active {
  background: linear-gradient(180deg, rgba(245, 158, 11, 0.65) 0%, rgba(245, 158, 11, 0.35) 100%);
  box-shadow: inset 0 0 12px var(--sb-gold-glow);
}

.sb-timeline-segment.playing {
  background: linear-gradient(180deg, rgba(245, 158, 11, 0.75) 0%, rgba(245, 158, 11, 0.45) 100%) !important;
  box-shadow: 0 0 15px var(--sb-gold-glow);
}

.sb-timeline-segment:hover {
  background: linear-gradient(180deg, rgba(245, 158, 11, 0.55) 0%, rgba(245, 158, 11, 0.25) 100%);
  z-index: 5;
}

.sb-segment-label {
  font-size: 9px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.85);
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);
}

.sb-timeline-playhead {
  position: absolute;
  top: 14px;
  width: 2px;
  height: 44px;
  background: var(--sb-gold);
  box-shadow: 
    0 0 8px var(--sb-gold-glow),
    0 0 20px var(--sb-gold-glow);
  pointer-events: none;
  z-index: 10;
  border-radius: 1px;
}

/* Playhead top indicator */
.sb-timeline-playhead::before {
  content: '';
  position: absolute;
  top: -4px;
  left: 50%;
  transform: translateX(-50%);
  width: 0;
  height: 0;
  border-left: 5px solid transparent;
  border-right: 5px solid transparent;
  border-top: 5px solid var(--sb-gold);
}

.sb-timeline-markers {
  display: flex;
  justify-content: space-between;
  margin-top: 6px;
  padding: 0 2px;
}

.sb-time-marker {
  font-size: 9px;
  color: var(--sb-text-ghost);
  font-family: 'JetBrains Mono', monospace;
  font-weight: 500;
}

/* ═══ VOICEOVER TIMELINE ═══ */
.sb-voiceover-timeline {
  padding: 8px 16px 14px;
  background: rgba(0, 0, 0, 0.12);
  border-top: 1px solid var(--sb-border-subtle);
}

.sb-voiceover-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.sb-voiceover-label {
  font-size: 10px;
  font-weight: 700;
  color: var(--sb-text-dim);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  display: flex;
  align-items: center;
  gap: 6px;
}

.sb-voiceover-label::before {
  content: '🎙️';
  font-size: 11px;
}

.sb-voiceover-generate-btn {
  padding: 4px 10px;
  font-size: 10px;
  font-weight: 600;
  background: linear-gradient(135deg, rgba(16, 185, 129, 0.25) 0%, rgba(16, 185, 129, 0.1) 100%);
  border: 1px solid rgba(16, 185, 129, 0.35);
  border-radius: 5px;
  color: #10b981;
  cursor: pointer;
  transition: all var(--sb-transition-fast);
  display: flex;
  align-items: center;
  gap: 5px;
}

.sb-voiceover-generate-btn:hover:not(:disabled) {
  background: linear-gradient(135deg, rgba(16, 185, 129, 0.4) 0%, rgba(16, 185, 129, 0.25) 100%);
  transform: translateY(-1px);
}

.sb-voiceover-generate-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Purple generating state */
.sb-voiceover-generate-btn.generating {
  background: linear-gradient(135deg, var(--sb-purple-muted) 0%, rgba(168, 85, 247, 0.1) 100%);
  border-color: rgba(168, 85, 247, 0.4);
  color: var(--sb-purple);
  animation: sb-btn-pulse 1.5s ease-in-out infinite;
}

@keyframes sb-btn-pulse {
  0%, 100% { box-shadow: 0 0 0 rgba(168, 85, 247, 0); }
  50% { box-shadow: 0 0 12px var(--sb-purple-glow); }
}

.sb-voiceover-track {
  display: flex;
  height: 24px;
  background: rgba(0, 0, 0, 0.25);
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--sb-border-subtle);
}

.sb-voiceover-segment {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all var(--sb-transition-fast);
  border-right: 1px solid rgba(0, 0, 0, 0.3);
  min-width: 12px;
  background: rgba(75, 85, 99, 0.15);
}

.sb-voiceover-segment:last-child {
  border-right: none;
}

.sb-voiceover-segment.has-audio {
  background: linear-gradient(180deg, rgba(16, 185, 129, 0.35) 0%, rgba(16, 185, 129, 0.15) 100%);
}

.sb-voiceover-segment.has-text:not(.has-audio) {
  background: linear-gradient(180deg, rgba(245, 158, 11, 0.2) 0%, rgba(245, 158, 11, 0.08) 100%);
}

.sb-voiceover-segment.no-text {
  background: rgba(55, 65, 81, 0.15);
  cursor: default;
}

.sb-voiceover-segment:hover:not(.no-text) {
  background: linear-gradient(180deg, rgba(245, 158, 11, 0.45) 0%, rgba(245, 158, 11, 0.2) 100%);
}

.sb-vo-icon {
  font-size: 11px;
  opacity: 0.75;
}

.sb-voiceover-segment.has-audio .sb-vo-icon {
  animation: sb-vo-pulse 2s ease-in-out infinite;
}

@keyframes sb-vo-pulse {
  0%, 100% { opacity: 0.75; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.1); }
}

/* ══════════════════════════════════════════════════════════════
   REGENERATE MODAL
   ══════════════════════════════════════════════════════════════ */

.sb-regenerate-modal {
  max-width: 600px;
  position: relative;
}

.sb-regenerate-modal.is-generating {
  pointer-events: none;
}

.sb-regenerate-modal.is-generating .sb-modal-close {
  pointer-events: auto;
}

.sb-modal-loading-overlay {
  position: absolute;
  inset: 0;
  background: rgba(15, 15, 15, 0.95);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  z-index: 100;
  border-radius: 12px;
  gap: 16px;
}

.sb-modal-loading-overlay .sb-spinner {
  width: 48px;
  height: 48px;
  border-width: 3px;
}

/* Purple loading state for AI/generating */
.sb-loading-text {
  color: var(--sb-purple);
  font-size: 17px;
  font-weight: 700;
}

.sb-loading-subtext {
  color: var(--sb-text-dim);
  font-size: 13px;
}

.sb-regen-preview {
  display: flex;
  gap: 16px;
  padding: 16px;
  background: rgba(0, 0, 0, 0.3);
  border-radius: 8px;
  margin-bottom: 20px;
}

.sb-regen-preview img {
  width: 120px;
  height: 90px;
  object-fit: cover;
  border-radius: 6px;
}

.sb-regen-placeholder {
  width: 120px;
  height: 90px;
  background: rgba(100, 100, 100, 0.2);
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #6b7280;
  font-size: 12px;
}

.sb-regen-scene-info {
  flex: 1;
}

.sb-regen-scene-info strong {
  display: block;
  color: #f5f5f5;
  margin-bottom: 6px;
}

.sb-regen-scene-info p {
  font-size: 12px;
  color: #9ca3af;
  line-height: 1.5;
}

.sb-regen-models h4 {
  font-size: 14px;
  font-weight: 500;
  color: #9ca3af;
  margin-bottom: 12px;
}

/* Prompt editing */
.sb-regen-prompt {
  margin-bottom: 20px;
  padding: 16px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.sb-regen-prompt h4 {
  font-size: 14px;
  font-weight: 500;
  color: #f5c518;
  margin-bottom: 12px;
}

.sb-regen-prompt .sb-textarea {
  width: 100%;
  padding: 12px;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 6px;
  color: #f5f5f5;
  font-size: 13px;
  line-height: 1.5;
  resize: vertical;
  min-height: 80px;
  font-family: inherit;
}

.sb-regen-prompt .sb-textarea:focus {
  outline: none;
  border-color: #f5c518;
  box-shadow: 0 0 0 2px rgba(245, 197, 24, 0.15);
}

.sb-regen-prompt .sb-textarea:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.sb-prompt-hint {
  font-size: 11px;
  color: #6b7280;
  margin-top: 8px;
}

/* Prompt header with button */
.sb-prompt-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.sb-prompt-header h4 {
  font-size: 14px;
  font-weight: 500;
  color: #f5c518;
  margin: 0;
}

/* AI Magic button with purple accent */
.sb-btn-magic {
  background: linear-gradient(135deg, var(--sb-purple-muted), rgba(245, 197, 24, 0.15));
  border: 1px solid rgba(168, 85, 247, 0.35);
  color: var(--sb-purple-hover);
  transition: all var(--sb-transition-fast);
}

.sb-btn-magic:hover:not(:disabled) {
  background: linear-gradient(135deg, rgba(168, 85, 247, 0.3), rgba(245, 197, 24, 0.3));
  border-color: rgba(168, 85, 247, 0.6);
}

/* ═══ AI SUGGESTED PROMPTS ═══ */
.sb-suggested-prompts {
  margin-top: 14px;
  padding: 12px;
  background: var(--sb-purple-muted);
  border-radius: 8px;
  border: 1px solid rgba(168, 85, 247, 0.2);
}

.sb-suggested-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
  font-size: 10px;
  font-weight: 700;
  color: var(--sb-purple-hover);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.sb-suggested-icon {
  font-size: 13px;
}

.sb-suggested-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sb-suggested-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid var(--sb-border-subtle);
  border-radius: 6px;
  text-align: left;
  cursor: pointer;
  transition: all var(--sb-transition-fast);
  color: var(--sb-text-secondary);
}

.sb-suggested-item:hover:not(:disabled) {
  background: var(--sb-gold-muted);
  border-color: rgba(245, 158, 11, 0.3);
  transform: translateX(2px);
}

.sb-suggested-item:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.sb-suggested-num {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(168, 85, 247, 0.25);
  border-radius: 50%;
  font-size: 10px;
  font-weight: 700;
  color: var(--sb-purple-hover);
}

.sb-suggested-text {
  font-size: 11px;
  line-height: 1.45;
  color: var(--sb-text-secondary);
}

.sb-model-group {
  margin-bottom: 16px;
}

.sb-model-group-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.sb-model-icon {
  font-size: 16px;
}

.sb-model-group-header span:nth-child(2) {
  font-weight: 500;
  color: #e5e5e5;
}

.sb-model-badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 600;
  text-transform: uppercase;
}

.sb-badge-fast {
  background: rgba(16, 185, 129, 0.2);
  color: #10b981;
}

.sb-badge-quality {
  background: rgba(99, 102, 241, 0.2);
  color: #818cf8;
}

.sb-badge-local {
  background: rgba(245, 158, 11, 0.2);
  color: #f59e0b;
}

.sb-model-options {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 8px;
}

.sb-model-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.sb-model-option:hover {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(245, 158, 11, 0.3);
}

.sb-model-option.selected {
  background: rgba(245, 158, 11, 0.1);
  border-color: rgba(245, 158, 11, 0.5);
}

.sb-model-option input[type="radio"] {
  accent-color: #f59e0b;
}

.sb-model-name {
  font-size: 13px;
  color: #e5e5e5;
}

.sb-model-vram {
  font-size: 10px;
  color: #6b7280;
  margin-left: auto;
}

.sb-badge-offline {
  background: rgba(239, 68, 68, 0.2);
  color: #fca5a5;
}

.sb-local-offline-hint {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  background: rgba(0, 0, 0, 0.2);
  border: 1px dashed rgba(255, 255, 255, 0.15);
  border-radius: 8px;
  font-size: 12px;
  color: #9ca3af;
}

.sb-local-offline-hint code {
  background: rgba(0, 0, 0, 0.4);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: monospace;
  font-size: 11px;
  color: #f59e0b;
}

.sb-offline-icon {
  font-size: 16px;
}

/* ══════════════════════════════════════════════════════════════
   RETRY BUTTON (Failed Generations)
   ══════════════════════════════════════════════════════════════ */

.sb-retry-btn {
  margin-top: 10px;
  padding: 8px 16px;
  background: linear-gradient(135deg, #f59e0b, #d97706);
  color: #000;
  border: none;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.sb-retry-btn:hover {
  transform: scale(1.05);
  box-shadow: 0 0 20px rgba(245, 158, 11, 0.5);
}

/* ══════════════════════════════════════════════════════════════
   ENHANCED SETTINGS PANEL
   ══════════════════════════════════════════════════════════════ */

.sb-settings-panel {
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding: 20px 0;
}

.sb-settings-section {
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  padding: 20px;
}

.sb-settings-hero {
  background: linear-gradient(135deg, rgba(245, 158, 11, 0.05) 0%, rgba(139, 92, 246, 0.03) 100%);
  border-color: rgba(245, 158, 11, 0.15);
}

.sb-settings-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 20px;
  padding-bottom: 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.sb-settings-icon {
  font-size: 20px;
}

.sb-settings-header h3 {
  font-size: 16px;
  font-weight: 600;
  color: #f5f5f5;
  margin: 0;
}

.sb-settings-group {
  margin-bottom: 20px;
}

.sb-settings-group:last-child {
  margin-bottom: 0;
}

.sb-settings-label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: #9ca3af;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 10px;
}

/* Backend Grid */
.sb-backend-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}

.sb-backend-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.2s ease;
  text-align: left;
}

.sb-backend-card:hover {
  background: rgba(255, 255, 255, 0.05);
  border-color: rgba(245, 158, 11, 0.3);
  transform: translateY(-2px);
}

.sb-backend-card.selected {
  background: rgba(245, 158, 11, 0.1);
  border-color: rgba(245, 158, 11, 0.5);
  box-shadow: 0 0 20px rgba(245, 158, 11, 0.15);
}

.sb-backend-card .sb-backend-icon {
  font-size: 24px;
}

.sb-backend-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sb-backend-card .sb-backend-name {
  font-size: 14px;
  font-weight: 600;
  color: #f5f5f5;
}

.sb-backend-desc {
  font-size: 11px;
  color: #6b7280;
}

.sb-check {
  color: #f59e0b;
  font-size: 16px;
  font-weight: bold;
}

/* Model Grid */
.sb-model-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 10px;
}

.sb-model-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 12px;
  background: rgba(0, 0, 0, 0.2);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.sb-model-card:hover {
  background: rgba(255, 255, 255, 0.05);
  border-color: rgba(245, 158, 11, 0.3);
}

.sb-model-card.selected {
  background: rgba(245, 158, 11, 0.15);
  border-color: rgba(245, 158, 11, 0.5);
}

.sb-model-card .sb-model-icon {
  font-size: 20px;
}

.sb-model-card .sb-model-name {
  font-size: 12px;
  color: #e5e5e5;
  text-align: center;
}

.sb-model-card .sb-model-badge {
  font-size: 9px;
  padding: 2px 6px;
  background: rgba(245, 158, 11, 0.2);
  color: #f59e0b;
  border-radius: 4px;
}

/* Style Grid */
.sb-style-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.sb-style-chip {
  padding: 8px 16px;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 20px;
  font-size: 13px;
  color: #d1d5db;
  cursor: pointer;
  transition: all 0.2s ease;
}

.sb-style-chip:hover {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(245, 158, 11, 0.3);
}

.sb-style-chip.selected {
  background: linear-gradient(135deg, #f59e0b, #d97706);
  border-color: transparent;
  color: #000;
  font-weight: 600;
}

/* Local Status */
.sb-local-status {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  background: rgba(0, 0, 0, 0.3);
  border-radius: 8px;
  font-size: 13px;
  color: #9ca3af;
}

.sb-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.sb-status-online {
  background: #10b981;
  box-shadow: 0 0 10px rgba(16, 185, 129, 0.5);
}

.sb-status-offline {
  background: #ef4444;
  box-shadow: 0 0 10px rgba(239, 68, 68, 0.5);
}

/* Provider Cards */
.sb-provider-cards {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}

.sb-provider-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 14px 12px;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.sb-provider-card:hover {
  background: rgba(255, 255, 255, 0.05);
  border-color: rgba(245, 158, 11, 0.3);
}

.sb-provider-card.selected {
  background: rgba(245, 158, 11, 0.1);
  border-color: rgba(245, 158, 11, 0.5);
}

.sb-provider-icon {
  font-size: 20px;
}

.sb-provider-name {
  font-size: 12px;
  font-weight: 600;
  color: #e5e5e5;
}

.sb-provider-tag {
  font-size: 9px;
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 600;
  text-transform: uppercase;
}

.sb-tag-free {
  background: rgba(16, 185, 129, 0.2);
  color: #10b981;
}

.sb-tag-pro {
  background: rgba(139, 92, 246, 0.2);
  color: #a78bfa;
}

/* Voice Grid */
.sb-voice-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
  gap: 8px;
}

.sb-voice-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  font-size: 12px;
  color: #d1d5db;
  cursor: pointer;
  transition: all 0.2s ease;
}

.sb-voice-chip:hover {
  background: rgba(255, 255, 255, 0.05);
  border-color: rgba(245, 158, 11, 0.3);
}

.sb-voice-chip.selected {
  background: rgba(245, 158, 11, 0.15);
  border-color: rgba(245, 158, 11, 0.5);
  color: #f5f5f5;
}

/* Settings Row Grid */
.sb-settings-row-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
}

.sb-settings-3col {
  grid-template-columns: repeat(3, 1fr);
}

/* Duration Control */
.sb-duration-control {
  display: flex;
  align-items: center;
  gap: 0;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  overflow: hidden;
}

.sb-duration-btn {
  width: 40px;
  height: 40px;
  background: transparent;
  border: none;
  color: #f59e0b;
  font-size: 18px;
  font-weight: bold;
  cursor: pointer;
  transition: all 0.2s ease;
}

.sb-duration-btn:hover {
  background: rgba(245, 158, 11, 0.2);
}

.sb-duration-value {
  flex: 1;
  text-align: center;
  font-size: 14px;
  font-weight: 600;
  color: #f5f5f5;
}

/* Platform Grid */
.sb-platform-grid {
  display: flex;
  gap: 8px;
}

.sb-platform-chip {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  font-size: 18px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.sb-platform-chip:hover {
  background: rgba(255, 255, 255, 0.05);
  border-color: rgba(245, 158, 11, 0.3);
  transform: scale(1.1);
}

.sb-platform-chip.selected {
  background: rgba(245, 158, 11, 0.2);
  border-color: rgba(245, 158, 11, 0.5);
  box-shadow: 0 0 15px rgba(245, 158, 11, 0.3);
}

/* Aspect Options */
.sb-aspect-options {
  display: flex;
  gap: 8px;
}

.sb-aspect-chip {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 10px 16px;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  font-size: 11px;
  color: #9ca3af;
  cursor: pointer;
  transition: all 0.2s ease;
}

.sb-aspect-chip:hover {
  background: rgba(255, 255, 255, 0.05);
  border-color: rgba(245, 158, 11, 0.3);
}

.sb-aspect-chip.selected {
  background: rgba(245, 158, 11, 0.15);
  border-color: rgba(245, 158, 11, 0.5);
  color: #f5f5f5;
}

.sb-aspect-icon {
  font-size: 16px;
  color: #f59e0b;
}

/* ElevenLabs Hint */
.sb-elevenlabs-hint {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  background: rgba(139, 92, 246, 0.1);
  border: 1px solid rgba(139, 92, 246, 0.2);
  border-radius: 8px;
  font-size: 13px;
  color: #a78bfa;
}

.sb-hint-icon {
  font-size: 16px;
}

/* Select Large */
.sb-select-lg {
  width: 100%;
  padding: 12px 16px;
  font-size: 14px;
}

/* Danger Zone */
.sb-settings-danger {
  background: rgba(239, 68, 68, 0.05);
  border-color: rgba(239, 68, 68, 0.2);
}

.sb-settings-danger .sb-settings-header {
  border-bottom-color: rgba(239, 68, 68, 0.15);
}

.sb-settings-danger h3 {
  color: #fca5a5;
}

.sb-danger-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.sb-btn-danger-outline {
  padding: 10px 20px;
  background: transparent;
  border: 1px solid rgba(239, 68, 68, 0.4);
  border-radius: 8px;
  color: #fca5a5;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.sb-btn-danger-outline:hover {
  background: rgba(239, 68, 68, 0.1);
  border-color: rgba(239, 68, 68, 0.6);
}

.sb-btn-danger {
  padding: 10px 20px;
  background: linear-gradient(135deg, #ef4444, #dc2626);
  border: none;
  border-radius: 8px;
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.sb-btn-danger:hover {
  transform: scale(1.02);
  box-shadow: 0 0 20px rgba(239, 68, 68, 0.4);
}
`;
