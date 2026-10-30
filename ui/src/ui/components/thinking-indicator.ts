/**
 * ThinkingIndicator — Premium GPU-Accelerated Loading State
 * 
 * Features:
 * - LOW GPU Mode: Optimized animations for older/weaker hardware
 * - HIGH GPU Mode: Full particle effects, flowing gold gradients, 3D transforms
 * - Animated glowing gold flowing animation
 * - Status text with phases
 * - Elapsed time counter
 */

import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";

export type GPUMode = 'low' | 'high';

const THINKING_PHASES = [
  { label: "Thinking", sublabel: "Processing your request..." },
  { label: "Analyzing", sublabel: "Understanding context..." },
  { label: "Reasoning", sublabel: "Connecting ideas..." },
  { label: "Generating", sublabel: "Crafting response..." },
] as const;

// Check for reduced motion preference
const prefersReducedMotion = typeof window !== 'undefined' 
  ? window.matchMedia('(prefers-reduced-motion: reduce)').matches 
  : false;

// Detect GPU capability (simple heuristic)
function detectGPUCapability(): GPUMode {
  if (prefersReducedMotion) return 'low';
  
  // Check for WebGL support as GPU indicator
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return 'low';
    
    // Check for hardware acceleration indicators
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    if (debugInfo) {
      const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
      // Detect software renderers or very old GPUs
      if (renderer.includes('SwiftShader') || renderer.includes('llvmpipe')) {
        return 'low';
      }
    }
    return 'high';
  } catch {
    return 'low';
  }
}

@customElement("thinking-indicator")
export class ThinkingIndicator extends LitElement {
  @property({ type: Number }) startedAt: number = Date.now();
  @property({ type: Boolean }) extended: boolean = false;
  @property({ type: Boolean }) streaming: boolean = false;
  @property({ type: String }) gpuMode: GPUMode = 'high'; // 'low' | 'high'
  
  @state() private elapsed: string = "0s";
  @state() private phaseIndex: number = 0;
  @state() private autoGpuMode: GPUMode = 'high';
  
  private timerInterval: number | null = null;
  private phaseInterval: number | null = null;

  static styles = css`
    :host {
      display: block;
      --gold: var(--g-primary);
      --gold-light: #FFEC8B;
      --gold-dark: #DAA520;
      --gold-glow: color-mix(in srgb, var(--g-primary) 60%, transparent);
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.autoGpuMode = detectGPUCapability();
    this.startTimers();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.stopTimers();
  }

  private get effectiveGpuMode(): GPUMode {
    return this.gpuMode || this.autoGpuMode;
  }

  private startTimers() {
    this.timerInterval = window.setInterval(() => {
      this.updateElapsed();
    }, 1000);
    this.updateElapsed();

    this.phaseInterval = window.setInterval(() => {
      this.phaseIndex = (this.phaseIndex + 1) % THINKING_PHASES.length;
    }, 3000);
  }

  private stopTimers() {
    if (this.timerInterval !== null) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
    if (this.phaseInterval !== null) {
      clearInterval(this.phaseInterval);
      this.phaseInterval = null;
    }
  }

  private updateElapsed() {
    const ms = Date.now() - this.startedAt;
    const secs = Math.floor(ms / 1000);
    
    if (secs < 60) {
      this.elapsed = `${secs}s`;
    } else {
      const mins = Math.floor(secs / 60);
      const remSecs = secs % 60;
      this.elapsed = `${mins}m ${remSecs}s`;
    }
  }

  private renderBrainIcon() {
    return html`
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-1.04"/>
        <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-1.04"/>
      </svg>
    `;
  }

  private renderFlameIcon() {
    return html`
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>
      </svg>
    `;
  }

  private renderSparkleIcon() {
    return html`
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2L13.09 8.26L18 6L15.74 10.91L22 12L15.74 13.09L18 18L13.09 15.74L12 22L10.91 15.74L6 18L8.26 13.09L2 12L8.26 10.91L6 6L10.91 8.26L12 2Z"/>
      </svg>
    `;
  }

  private renderClockIcon() {
    return html`
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"/>
        <polyline points="12 6 12 12 16 14"/>
      </svg>
    `;
  }

  // High GPU Mode: Full particle effects
  private renderHighGpuParticles() {
    const particles = [];
    for (let i = 0; i < 12; i++) {
      particles.push(html`<div class="thinking-gold__particle" style="--i: ${i}"></div>`);
    }
    return html`<div class="thinking-gold__particles">${particles}</div>`;
  }

  // Render flowing energy lines (high GPU)
  private renderEnergyLines() {
    return html`
      <div class="thinking-gold__energy-lines">
        <div class="thinking-gold__energy-line" style="--delay: 0s"></div>
        <div class="thinking-gold__energy-line" style="--delay: 0.3s"></div>
        <div class="thinking-gold__energy-line" style="--delay: 0.6s"></div>
      </div>
    `;
  }

  private renderStreamingIndicator() {
    const isHigh = this.effectiveGpuMode === 'high';
    return html`
      <div class="streaming-gold ${isHigh ? 'streaming-gold--high' : 'streaming-gold--low'}">
        ${isHigh ? html`
          <div class="streaming-gold__glow-ring"></div>
          <div class="streaming-gold__glow-ring streaming-gold__glow-ring--delay"></div>
        ` : ''}
        <div class="streaming-gold__wave">
          <div class="streaming-gold__bar"></div>
          <div class="streaming-gold__bar"></div>
          <div class="streaming-gold__bar"></div>
          <div class="streaming-gold__bar"></div>
          <div class="streaming-gold__bar"></div>
        </div>
        <span class="streaming-gold__label">
          ${this.renderFlameIcon()}
          Generating
        </span>
        <span class="streaming-gold__timer">${this.elapsed}</span>
      </div>
    `;
  }

  private renderExtendedThinking() {
    const phase = THINKING_PHASES[this.phaseIndex];
    const isHigh = this.effectiveGpuMode === 'high';
    
    return html`
      <div class="extended-thinking-gold ${isHigh ? 'extended-thinking-gold--high' : 'extended-thinking-gold--low'}">
        ${isHigh ? html`
          <div class="extended-thinking-gold__orb-container">
            <div class="extended-thinking-gold__orb">
              <div class="extended-thinking-gold__orb-core"></div>
              <div class="extended-thinking-gold__orb-ring"></div>
              <div class="extended-thinking-gold__orb-ring extended-thinking-gold__orb-ring--reverse"></div>
              ${this.renderHighGpuParticles()}
            </div>
          </div>
        ` : html`
          <div class="extended-thinking-gold__icon">
            ${this.renderBrainIcon()}
          </div>
        `}
        <div class="extended-thinking-gold__content">
          <div class="extended-thinking-gold__title">
            ${phase.label}
            <span class="extended-thinking-gold__badge">
              ${this.renderSparkleIcon()}
              Extended
            </span>
          </div>
          <div class="extended-thinking-gold__subtitle">${phase.sublabel}</div>
        </div>
        <div class="extended-thinking-gold__timer">
          ${this.renderClockIcon()}
          ${this.elapsed}
        </div>
        ${isHigh ? html`<div class="extended-thinking-gold__flowing-border"></div>` : ''}
      </div>
    `;
  }

  private renderStandardThinking() {
    const phase = THINKING_PHASES[this.phaseIndex];
    const isHigh = this.effectiveGpuMode === 'high';
    
    return html`
      <div class="thinking-gold ${isHigh ? 'thinking-gold--high' : 'thinking-gold--low'}">
        <!-- Flowing border (high GPU only) -->
        ${isHigh ? html`<div class="thinking-gold__flowing-border"></div>` : ''}
        
        <!-- Scanning line -->
        <div class="thinking-gold__scan-line"></div>
        
        <!-- Main content -->
        <div class="thinking-gold__header">
          <div class="thinking-gold__icon-container">
            ${isHigh ? html`
              <div class="thinking-gold__icon-glow"></div>
              <div class="thinking-gold__icon-pulse"></div>
            ` : ''}
            <div class="thinking-gold__icon">
              ${this.renderBrainIcon()}
            </div>
          </div>
          <div class="thinking-gold__status">
            <div class="thinking-gold__label">${phase.label}...</div>
            <div class="thinking-gold__sublabel">${phase.sublabel}</div>
          </div>
        </div>
        
        <!-- Progress bar with flowing effect -->
        <div class="thinking-gold__progress">
          <div class="thinking-gold__progress-track"></div>
          <div class="thinking-gold__progress-bar"></div>
          <div class="thinking-gold__progress-glow"></div>
        </div>
        
        <!-- Timer -->
        <div class="thinking-gold__timer">
          ${this.renderClockIcon()}
          <span>${this.elapsed}</span>
        </div>
        
        <!-- Particles (high GPU only) -->
        ${isHigh ? this.renderHighGpuParticles() : ''}
        
        <!-- Energy lines (high GPU only) -->
        ${isHigh ? this.renderEnergyLines() : ''}
      </div>
    `;
  }

  render() {
    if (this.streaming) {
      return this.renderStreamingIndicator();
    }
    
    if (this.extended) {
      return this.renderExtendedThinking();
    }
    
    return this.renderStandardThinking();
  }
}

// Minimal dots version for compact spaces
@customElement("thinking-dots")
export class ThinkingDots extends LitElement {
  @property({ type: String }) gpuMode: GPUMode = 'high';
  
  static styles = css`
    :host {
      display: inline-block;
    }
  `;

  render() {
    const isHigh = this.gpuMode === 'high';
    return html`
      <div class="thinking-dots-gold ${isHigh ? 'thinking-dots-gold--high' : ''}">
        <div class="thinking-dots-gold__dot"></div>
        <div class="thinking-dots-gold__dot"></div>
        <div class="thinking-dots-gold__dot"></div>
      </div>
    `;
  }
}

// Chat loading skeleton
@customElement("chat-loading-skeleton")
export class ChatLoadingSkeleton extends LitElement {
  @property({ type: Number }) count: number = 3;

  static styles = css`
    :host {
      display: block;
    }
  `;

  render() {
    const messages = [];
    for (let i = 0; i < this.count; i++) {
      const isUser = i % 2 === 0;
      messages.push(html`
        <div class="chat-loading-gold__message" style="${isUser ? 'flex-direction: row-reverse;' : ''}">
          <div class="chat-loading-gold__avatar"></div>
          <div class="chat-loading-gold__content">
            <div class="chat-loading-gold__line chat-loading-gold__line--long"></div>
            <div class="chat-loading-gold__line chat-loading-gold__line--medium"></div>
            ${i % 2 === 1 ? html`<div class="chat-loading-gold__line chat-loading-gold__line--short"></div>` : ''}
          </div>
        </div>
      `);
    }

    return html`<div class="chat-loading-gold">${messages}</div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "thinking-indicator": ThinkingIndicator;
    "thinking-dots": ThinkingDots;
    "chat-loading-skeleton": ChatLoadingSkeleton;
  }
}
