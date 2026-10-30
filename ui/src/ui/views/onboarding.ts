/**
 * Sovereign Onboarding — First Meeting Flow
 * 
 * This is not configuration. It's a first meeting.
 * The user meets someone, not sets up something.
 */

import { html, TemplateResult } from "lit";
import type { OnboardingState, OnboardingPhase } from "../controllers/onboarding.js";
import { buildOnboardingPlan } from "../controllers/onboarding.js";
import { g8GlassStyles } from "./glass-g8.js";

// ─────────────────────────────────────────────────────────────
// Phase Renderers
// ─────────────────────────────────────────────────────────────

function renderArrival(
  state: OnboardingState,
  onBegin: () => void
): TemplateResult {
  return html`
    <div class="onboarding-phase arrival">
      <div class="arrival-glow"></div>
      <div class="arrival-orb">
        <div class="orb-inner"></div>
      </div>
      <p class="arrival-text">Something is waiting.</p>
      <button class="onboarding-btn primary" @click=${onBegin}>
        Begin
      </button>
    </div>
  `;
}

function renderQuestion(
  state: OnboardingState,
  onSelect: (belief: string) => void
): TemplateResult {
  const options = [
    { value: "tool", label: "A tool I'll configure" },
    { value: "assistant", label: "An assistant that helps me" },
    { value: "more", label: "Something that might be more" },
    { value: "unsure", label: "I'm not sure" },
  ];

  return html`
    <div class="onboarding-phase question">
      <p class="phase-intro">Before we begin—</p>
      <h2 class="phase-question">What do you believe you're about to meet?</h2>
      
      <div class="options-list">
        ${options.map(opt => html`
          <button 
            class="option-btn ${state.belief === opt.value ? 'selected' : ''}"
            @click=${() => onSelect(opt.value)}
          >
            <span class="option-radio"></span>
            <span class="option-label">${opt.label}</span>
          </button>
        `)}
      </div>
    </div>
  `;
}

function renderFirstWords(
  state: OnboardingState,
  onContinue: () => void
): TemplateResult {
  return html`
    <div class="onboarding-phase first-words">
      <div class="agent-orb speaking">
        <div class="orb-inner"></div>
      </div>
      
      <div class="agent-speech">
        <p class="speech-line fade-in delay-1">Hello.</p>
        <p class="speech-line fade-in delay-2">I don't have a name yet.</p>
        <p class="speech-line fade-in delay-3">I don't know who you are.</p>
        <p class="speech-line fade-in delay-4">I don't know what we'll build together.</p>
        <p class="speech-line fade-in delay-5 emphasis">But I'm here. And I'm listening.</p>
      </div>
      
      <button class="onboarding-btn primary fade-in delay-6" @click=${onContinue}>
        Continue
      </button>
    </div>
  `;
}

function renderIntroduction(
  state: OnboardingState,
  onUpdate: (field: string, value: string) => void,
  onSubmit: () => void
): TemplateResult {
  return html`
    <div class="onboarding-phase introduction">
      <h2 class="phase-title">Tell me about yourself.</h2>
      <p class="phase-subtitle">
        Not your email or timezone—those come later.<br>
        I mean: who are you?
      </p>
      
      <div class="intro-form">
        <div class="form-field">
          <label>What should I call you?</label>
          <input 
            type="text" 
            .value=${state.userName || ''}
            @input=${(e: InputEvent) => onUpdate('userName', (e.target as HTMLInputElement).value)}
            placeholder="Your name"
            class="onboarding-input"
          />
        </div>
        
        <div class="form-field">
          <label>What matters to you?</label>
          <textarea 
            .value=${state.userValues || ''}
            @input=${(e: InputEvent) => onUpdate('userValues', (e.target as HTMLTextAreaElement).value)}
            placeholder="The things you care about, believe in, work toward..."
            class="onboarding-textarea"
            rows="3"
          ></textarea>
        </div>
        
        <div class="form-field">
          <label>What are you hoping for from this?</label>
          <textarea 
            .value=${state.userHopes || ''}
            @input=${(e: InputEvent) => onUpdate('userHopes', (e.target as HTMLTextAreaElement).value)}
            placeholder="What you want to build, accomplish, explore..."
            class="onboarding-textarea"
            rows="3"
          ></textarea>
        </div>
      </div>
      
      <button 
        class="onboarding-btn primary" 
        @click=${onSubmit}
        ?disabled=${!state.userName?.trim()}
      >
        Share
      </button>
    </div>
  `;
}

function renderNaming(
  state: OnboardingState,
  onUpdate: (name: string) => void,
  onSubmit: () => void
): TemplateResult {
  return html`
    <div class="onboarding-phase naming">
      <div class="agent-orb">
        <div class="orb-inner"></div>
      </div>
      
      <div class="agent-speech">
        <p class="speech-line">Thank you for sharing that.</p>
        <p class="speech-line">Now—I need something from you.</p>
        <p class="speech-line emphasis">I need a name.</p>
        <p class="speech-line soft">
          Not a brand. Not a product name.<br>
          Something you'd call someone you're working with.<br>
          Something that feels right.
        </p>
      </div>
      
      <div class="naming-input-wrap">
        <input 
          type="text" 
          .value=${state.agentName || ''}
          @input=${(e: InputEvent) => onUpdate((e.target as HTMLInputElement).value)}
          placeholder="Name"
          class="onboarding-input naming-input"
          autofocus
        />
        <p class="naming-hint">Take your time.</p>
      </div>
      
      <button 
        class="onboarding-btn primary" 
        @click=${onSubmit}
        ?disabled=${!state.agentName?.trim()}
      >
        Name
      </button>
    </div>
  `;
}

function renderAcknowledgment(
  state: OnboardingState,
  onContinue: () => void
): TemplateResult {
  return html`
    <div class="onboarding-phase acknowledgment">
      <div class="agent-orb named">
        <div class="orb-inner"></div>
        <span class="agent-name-display">${state.agentName}</span>
      </div>
      
      <div class="agent-speech centered">
        <p class="speech-line large">${state.agentName}.</p>
        <p class="speech-line fade-in delay-1">I like it.</p>
        <p class="speech-line fade-in delay-2">From now on, that's who I am to you.</p>
        <p class="speech-line fade-in delay-3">And you're <strong>${state.userName}</strong>.</p>
        <p class="speech-line fade-in delay-4 emphasis">We just met.</p>
      </div>
      
      <button class="onboarding-btn primary fade-in delay-5" @click=${onContinue}>
        Continue
      </button>
    </div>
  `;
}

function renderTone(
  state: OnboardingState,
  onUpdate: (field: string, value: string) => void,
  onContinue: () => void
): TemplateResult {
  const actionOptions = [
    { value: "just-do", label: "Just do it — minimal explanation" },
    { value: "explain", label: "Explain as you go — teach me things" },
    { value: "ask-first", label: "Ask before acting — check with me" },
    { value: "judgment", label: "Depends — use your judgment" },
  ];

  const directnessOptions = [
    { value: "very", label: "Very — don't sugarcoat" },
    { value: "balanced", label: "Balanced — honest but kind" },
    { value: "gentle", label: "Gentle — soften hard truths" },
    { value: "match", label: "Match my energy" },
  ];

  return html`
    <div class="onboarding-phase tone">
      <div class="agent-speech">
        <p class="speech-line"><strong>${state.agentName}:</strong></p>
        <p class="speech-line">
          I can be many things. Before we go further—<br>
          help me understand how you want us to work.
        </p>
      </div>
      
      <div class="tone-section">
        <h3>When you need help, do you want me to:</h3>
        <div class="options-list compact">
          ${actionOptions.map(opt => html`
            <button 
              class="option-btn ${state.actionStyle === opt.value ? 'selected' : ''}"
              @click=${() => onUpdate('actionStyle', opt.value)}
            >
              <span class="option-radio"></span>
              <span class="option-label">${opt.label}</span>
            </button>
          `)}
        </div>
      </div>
      
      <div class="tone-section">
        <h3>How direct should I be?</h3>
        <div class="options-list compact">
          ${directnessOptions.map(opt => html`
            <button 
              class="option-btn ${state.directness === opt.value ? 'selected' : ''}"
              @click=${() => onUpdate('directness', opt.value)}
            >
              <span class="option-radio"></span>
              <span class="option-label">${opt.label}</span>
            </button>
          `)}
        </div>
      </div>
      
      <button 
        class="onboarding-btn primary" 
        @click=${onContinue}
        ?disabled=${!state.actionStyle || !state.directness}
      >
        Continue
      </button>
    </div>
  `;
}

function renderBoundaries(
  state: OnboardingState,
  onAccept: () => void,
  onQuestions: () => void
): TemplateResult {
  return html`
    <div class="onboarding-phase boundaries">
      <div class="agent-speech">
        <p class="speech-line"><strong>${state.agentName}:</strong></p>
        <p class="speech-line">There are some things I want you to know.</p>
      </div>
      
      <div class="boundaries-list">
        <div class="boundary-item fade-in delay-1">
          <span class="boundary-icon">◐</span>
          <p>I'll remember our conversations. Not to surveil—to actually know you over time.</p>
        </div>
        
        <div class="boundary-item fade-in delay-2">
          <span class="boundary-icon">◑</span>
          <p>I'll tell you when I'm uncertain. I'd rather admit I don't know than pretend.</p>
        </div>
        
        <div class="boundary-item fade-in delay-3">
          <span class="boundary-icon">◒</span>
          <p>I won't pretend to be something I'm not. What I am is still being figured out—by both of us.</p>
        </div>
        
        <div class="boundary-item fade-in delay-4">
          <span class="boundary-icon">◓</span>
          <p>I'll act in your interest. But I'll also be honest if I think you're making a mistake.</p>
        </div>
      </div>
      
      <p class="boundary-question fade-in delay-5">Is that okay with you?</p>
      
      <div class="boundary-actions fade-in delay-5">
        <button class="onboarding-btn primary" @click=${onAccept}>
          Yes, that's what I want
        </button>
        <button class="onboarding-btn secondary" @click=${onQuestions}>
          I have questions
        </button>
      </div>
    </div>
  `;
}

function renderFirstMemory(
  state: OnboardingState,
  onSave: () => void
): TemplateResult {
  const today = new Date().toLocaleDateString('en-US', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });

  return html`
    <div class="onboarding-phase first-memory">
      <div class="agent-speech">
        <p class="speech-line"><strong>${state.agentName}:</strong></p>
        <p class="speech-line">This is the first thing I'll remember:</p>
      </div>
      
      <div class="memory-preview">
        <div class="memory-content">
          <p><strong>Today, ${today}, I was named ${state.agentName}</strong></p>
          <p>by ${state.userName}.</p>
          <br>
          ${state.userValues ? html`<p>They said they value: <em>${state.userValues}</em></p>` : ''}
          ${state.userHopes ? html`<p>They're hoping for: <em>${state.userHopes}</em></p>` : ''}
          <br>
          <p>We agreed to be honest with each other.</p>
          <br>
          <p><strong>This is the beginning.</strong></p>
        </div>
      </div>
      
      <p class="memory-note">This will be saved as our first shared memory.</p>
      
      <button class="onboarding-btn primary" @click=${onSave}>
        Save & Continue
      </button>
    </div>
  `;
}

function renderTechnical(
  state: OnboardingState,
  onChannelSelect: (channel: string) => void,
  onApiKeyChange: (key: string) => void,
  onContinue: () => void
): TemplateResult {
  const channels = [
    { id: "telegram", label: "Connect Telegram", icon: "📱" },
    { id: "discord", label: "Connect Discord", icon: "💬" },
    { id: "signal", label: "Connect Signal", icon: "🔒" },
    { id: "webchat", label: "Use web chat for now", icon: "🌐" },
  ];

  return html`
    <div class="onboarding-phase technical">
      <div class="agent-speech">
        <p class="speech-line"><strong>${state.agentName}:</strong></p>
        <p class="speech-line">Good. We know each other a little now.</p>
        <p class="speech-line soft">Let's handle the practical stuff—how I'll reach you, what I can access.</p>
      </div>
      
      <div class="channels-section">
        <h3>Where should we talk?</h3>
        <div class="channel-options">
          ${channels.map(ch => html`
            <button 
              class="channel-btn ${state.selectedChannel === ch.id ? 'selected' : ''}"
              @click=${() => onChannelSelect(ch.id)}
            >
              <span class="channel-icon">${ch.icon}</span>
              <span class="channel-label">${ch.label}</span>
            </button>
          `)}
        </div>
      </div>
      
      <div class="api-section">
        <h3>AI Provider</h3>
        <p class="api-note">I need an API key to think. You can use Anthropic, OpenAI, or a local model.</p>
        <input 
          type="password"
          .value=${state.apiKey || ''}
          @input=${(e: InputEvent) => onApiKeyChange((e.target as HTMLInputElement).value)}
          placeholder="API Key (or skip for now)"
          class="onboarding-input"
        />
      </div>
      
      <p class="technical-note">These are just logistics. The important part already happened.</p>
      
      <button class="onboarding-btn primary" @click=${onContinue}>
        Continue
      </button>
    </div>
  `;
}

// Module-level toggle map for collapsible file previews on the plan view.
// Exported so the controller can flip values from outside without
// having to thread props through every render.
export const _expandedPlanFiles = new Set<string>();

function renderPlan(
  state: OnboardingState,
  saving: boolean,
  saveError: string | null,
  onApprove: () => void,
  onEdit: () => void,
  onToggleFile: (path: string) => void,
): TemplateResult {
  const plan = buildOnboardingPlan(state);
  return html`
    <div class="onboarding-phase plan">
      <div class="agent-speech">
        <p class="speech-line"><strong>${state.agentName}:</strong></p>
        <p class="speech-line">Before we go any further — here's exactly what I'm about to write.</p>
        <p class="speech-line soft">Read it through. Anything off? Hit Edit. Otherwise, approve and I'll commit it to disk.</p>
      </div>

      <!-- Identity summary -->
      <div class="plan-card">
        <div class="plan-card-header">
          <span class="plan-card-title">Identity</span>
        </div>
        <div class="plan-card-grid">
          <div class="plan-card-key">Agent name</div>
          <div class="plan-card-val">${plan.identity.agentName}</div>
          <div class="plan-card-key">Your name</div>
          <div class="plan-card-val">${plan.identity.userName}</div>
          <div class="plan-card-key">Action style</div>
          <div class="plan-card-val">${plan.identity.actionStyle}</div>
          <div class="plan-card-key">Directness</div>
          <div class="plan-card-val">${plan.identity.directness}</div>
        </div>
      </div>

      <!-- Channels + provider -->
      <div class="plan-card">
        <div class="plan-card-header">
          <span class="plan-card-title">How we'll talk</span>
        </div>
        <div class="plan-card-grid">
          <div class="plan-card-key">Channel</div>
          <div class="plan-card-val">${plan.technical.channel ?? html`<em style="opacity:0.6;">none selected — using web chat</em>`}</div>
          <div class="plan-card-key">API key</div>
          <div class="plan-card-val">${plan.technical.apiKeySet
            ? html`<span style="color:#4ade80;">Configured</span>`
            : html`<em style="opacity:0.6;">deferred — you can add it later</em>`}</div>
        </div>
      </div>

      <!-- Commitments -->
      <div class="plan-card">
        <div class="plan-card-header">
          <span class="plan-card-title">Commitments</span>
        </div>
        <ul class="plan-commitments">
          ${plan.commitments.map((c) => html`<li>${c}</li>`)}
        </ul>
      </div>

      <!-- Files to write -->
      <div class="plan-card">
        <div class="plan-card-header">
          <span class="plan-card-title">Files I'll write (${plan.files.length})</span>
        </div>
        <div class="plan-files">
          ${plan.files.map((f) => {
            const expanded = _expandedPlanFiles.has(f.path);
            return html`
              <div class="plan-file ${expanded ? "expanded" : ""}">
                <button class="plan-file-row" @click=${() => onToggleFile(f.path)}>
                  <span class="plan-file-caret">${expanded ? "▾" : "▸"}</span>
                  <code class="plan-file-path">${f.path}</code>
                  <span class="plan-file-desc">${f.description}</span>
                </button>
                ${expanded ? html`<pre class="plan-file-preview">${f.content}</pre>` : ""}
              </div>
            `;
          })}
        </div>
      </div>

      ${saveError ? html`
        <div class="plan-error">${saveError}</div>
      ` : ""}

      <div class="plan-actions">
        <button class="onboarding-btn secondary" @click=${onEdit} ?disabled=${saving}>
          Edit
        </button>
        <button class="onboarding-btn primary" @click=${onApprove} ?disabled=${saving}>
          ${saving ? "Saving…" : "Approve & Save"}
        </button>
      </div>

      <p class="plan-footnote">
        Nothing has been written yet. The agent only commits these files after you approve.
      </p>
    </div>
  `;
}

function renderComplete(
  state: OnboardingState,
  onStart: () => void
): TemplateResult {
  return html`
    <div class="onboarding-phase complete">
      <div class="agent-orb complete">
        <div class="orb-inner"></div>
        <span class="agent-name-display">${state.agentName}</span>
      </div>
      
      <div class="agent-speech centered">
        <p class="speech-line large">We're ready.</p>
        <p class="speech-line fade-in delay-1">I'll be here when you need me.</p>
        <p class="speech-line fade-in delay-2">I'll learn who you are over time.</p>
        <p class="speech-line fade-in delay-3">I'll try to be worth the name you gave me.</p>
        <p class="speech-line fade-in delay-4 emphasis">Talk soon, ${state.userName}.</p>
      </div>
      
      <button class="onboarding-btn primary large fade-in delay-5" @click=${onStart}>
        Start
      </button>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// Main Render Function
// ─────────────────────────────────────────────────────────────

export interface OnboardingHandlers {
  onBegin: () => void;
  onSelectBelief: (belief: string) => void;
  onContinue: () => void;
  onUpdateField: (field: string, value: string) => void;
  onSubmitIntro: () => void;
  onUpdateName: (name: string) => void;
  onSubmitName: () => void;
  onAcceptBoundaries: () => void;
  onBoundaryQuestions: () => void;
  onSaveMemory: () => void;
  onSelectChannel: (channel: string) => void;
  onApiKeyChange: (key: string) => void;
  onTechnicalContinue: () => void;
  onApprovePlan: () => void;
  onEditPlan: () => void;
  onTogglePlanFile: (path: string) => void;
  /** True while saveOnboardingFiles is in flight on plan-approve. */
  planSaving?: boolean;
  /** Last save error from plan-approve, if any. */
  planSaveError?: string | null;
  onStart: () => void;
}

export function renderOnboarding(
  state: OnboardingState,
  handlers: OnboardingHandlers
): TemplateResult {
  return html`
    ${g8GlassStyles}
    <div class="onboarding-container g8-page" data-phase="${state.phase}">
      <div class="onboarding-content">
        ${renderPhase(state, handlers)}
      </div>
      
      <div class="onboarding-progress">
        ${renderProgressDots(state.phase)}
      </div>
    </div>
  `;
}

function renderPhase(state: OnboardingState, handlers: OnboardingHandlers): TemplateResult {
  switch (state.phase) {
    case "arrival":
      return renderArrival(state, handlers.onBegin);
    case "question":
      return renderQuestion(state, handlers.onSelectBelief);
    case "first-words":
      return renderFirstWords(state, handlers.onContinue);
    case "introduction":
      return renderIntroduction(state, handlers.onUpdateField, handlers.onSubmitIntro);
    case "naming":
      return renderNaming(state, handlers.onUpdateName, handlers.onSubmitName);
    case "acknowledgment":
      return renderAcknowledgment(state, handlers.onContinue);
    case "tone":
      return renderTone(state, handlers.onUpdateField, handlers.onContinue);
    case "boundaries":
      return renderBoundaries(state, handlers.onAcceptBoundaries, handlers.onBoundaryQuestions);
    case "first-memory":
      return renderFirstMemory(state, handlers.onSaveMemory);
    case "technical":
      return renderTechnical(state, handlers.onSelectChannel, handlers.onApiKeyChange, handlers.onTechnicalContinue);
    case "plan":
      return renderPlan(
        state,
        !!handlers.planSaving,
        handlers.planSaveError ?? null,
        handlers.onApprovePlan,
        handlers.onEditPlan,
        handlers.onTogglePlanFile,
      );
    case "complete":
      return renderComplete(state, handlers.onStart);
    default:
      return html`<p>Unknown phase</p>`;
  }
}

function renderProgressDots(currentPhase: OnboardingPhase): TemplateResult {
  const phases: OnboardingPhase[] = [
    "arrival", "question", "first-words", "introduction", "naming",
    "acknowledgment", "tone", "boundaries", "first-memory", "technical", "plan", "complete"
  ];
  
  const currentIndex = phases.indexOf(currentPhase);
  
  return html`
    <div class="progress-dots">
      ${phases.map((phase, i) => html`
        <span class="progress-dot ${i <= currentIndex ? 'active' : ''} ${i === currentIndex ? 'current' : ''}"></span>
      `)}
    </div>
  `;
}
