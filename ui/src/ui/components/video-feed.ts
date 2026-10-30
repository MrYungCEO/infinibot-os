/**
 * Video Feed Component
 * Live webcam stream with:
 * - Screenshot capability
 * - Vision MCP integration  
 * - OpenCV-style detection overlays with bounding boxes
 * - HUD overlay like the voice page
 */

import { html, css, LitElement, nothing } from "lit";
import { customElement, state, query } from "lit/decorators.js";

// ============================================================
// Types
// ============================================================

export interface VideoFeedState {
  streaming: boolean;
  error: string | null;
  deviceId: string | null;
  devices: MediaDeviceInfo[];
  lastCapture: string | null;
}

export interface DetectionBox {
  label: string;
  confidence: number;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
}

export interface DetectionResult {
  boxes: DetectionBox[];
  description: string;
  timestamp: number;
}

// Global video stream manager (singleton for efficiency)
let globalStream: MediaStream | null = null;
let globalCanvas: HTMLCanvasElement | null = null;
let globalVideo: HTMLVideoElement | null = null;
const streamListeners = new Set<(frame: string) => void>();

// Frame push interval
let framePushInterval: number | null = null;
const FRAME_PUSH_INTERVAL_MS = 1000;

// Detection interval
let detectionInterval: number | null = null;
const DETECTION_INTERVAL_MS = 2500;

// ============================================================
// Public API for Vision MCP
// ============================================================

export function captureVideoFrame(): string | null {
  if (!globalVideo || !globalCanvas || !globalStream) return null;
  
  const ctx = globalCanvas.getContext('2d');
  if (!ctx) return null;
  
  globalCanvas.width = globalVideo.videoWidth || 640;
  globalCanvas.height = globalVideo.videoHeight || 480;
  ctx.drawImage(globalVideo, 0, 0);
  
  return globalCanvas.toDataURL('image/jpeg', 0.9);
}

export function isVideoFeedActive(): boolean {
  return globalStream !== null && globalStream.active;
}

export async function getVideoDevices(): Promise<MediaDeviceInfo[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d => d.kind === 'videoinput');
  } catch {
    return [];
  }
}

export function onFrameCapture(callback: (frame: string) => void): () => void {
  streamListeners.add(callback);
  return () => streamListeners.delete(callback);
}

// Color palette for detection boxes
const BOX_COLORS = ['#22c55e', '#3b82f6', '#f59e0b', '#ec4899', '#8b5cf6', '#06b6d4', '#ef4444', '#84cc16'];
function getBoxColor(index: number): string {
  return BOX_COLORS[index % BOX_COLORS.length];
}

// ============================================================
// Video Feed Component
// ============================================================

@customElement("video-feed-panel")
export class VideoFeedPanel extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      background: #0a0a0a;
      border-radius: 8px;
      overflow: hidden;
    }

    .video-container {
      flex: 1;
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #0a0a0a 0%, #1a1a1a 100%);
      overflow: hidden;
    }

    video {
      width: 100%;
      height: 100%;
      object-fit: contain;
      transform: scaleX(-1);
    }

    canvas.capture-canvas { display: none; }

    canvas.overlay-canvas {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      transform: scaleX(-1);
    }

    /* ============================================ */
    /* HUD Overlay - Voice Page Style */
    /* ============================================ */
    
    .hud-overlay {
      position: absolute;
      inset: 0;
      pointer-events: none;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      padding: 12px;
    }

    .hud-top {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 8px;
    }

    .hud-bottom {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    /* Status badges */
    .hud-status {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(8px);
      border-radius: 20px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .hud-status.live {
      color: #22c55e;
      border-color: rgba(34, 197, 94, 0.3);
    }

    .hud-status.ai-active {
      color: #3b82f6;
      border-color: rgba(59, 130, 246, 0.3);
      animation: hud-pulse 2s ease-in-out infinite;
    }

    .hud-status.analyzing {
      color: #f59e0b;
      border-color: rgba(245, 158, 11, 0.3);
    }

    @keyframes hud-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }

    .hud-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: currentColor;
    }

    .hud-dot.pulse {
      animation: dot-pulse 1.5s ease-in-out infinite;
    }

    @keyframes dot-pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(0.8); }
    }

    /* Detection labels - floating tags */
    .hud-labels {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      max-width: 70%;
    }

    .hud-label {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 4px 10px;
      background: rgba(0, 0, 0, 0.8);
      backdrop-filter: blur(8px);
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      border-left: 3px solid;
    }

    .hud-label__text { color: #fff; }
    .hud-label__conf { color: rgba(255, 255, 255, 0.5); font-size: 10px; }

    /* Description bar */
    .hud-description {
      padding: 10px 14px;
      background: linear-gradient(135deg, rgba(0, 0, 0, 0.85) 0%, rgba(0, 0, 0, 0.75) 100%);
      backdrop-filter: blur(12px);
      border-radius: 8px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
      color: #fff;
      font-size: 12px;
      line-height: 1.5;
      max-height: 80px;
      overflow: hidden;
    }

    .hud-description__prefix {
      color: var(--g-primary);
      font-weight: 600;
      margin-right: 6px;
    }

    /* Analyzing spinner overlay */
    .hud-analyzing {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 20px;
      background: rgba(0, 0, 0, 0.85);
      backdrop-filter: blur(12px);
      border-radius: 24px;
      border: 1px solid rgba(59, 130, 246, 0.3);
      opacity: 0;
      transition: opacity 0.2s;
    }

    .hud-analyzing.visible { opacity: 1; }

    .hud-spinner {
      width: 18px;
      height: 18px;
      border: 2px solid rgba(59, 130, 246, 0.3);
      border-top-color: #3b82f6;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin { to { transform: rotate(360deg); } }

    .hud-analyzing__text {
      font-size: 12px;
      font-weight: 600;
      color: #3b82f6;
    }

    /* Controls bar */
    .controls {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      background: rgba(0, 0, 0, 0.6);
      backdrop-filter: blur(8px);
      border-top: 1px solid color-mix(in srgb, var(--g-primary) 10%, transparent);
      flex-wrap: wrap;
    }

    .control-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 8px 14px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
      border-radius: 8px;
      background: color-mix(in srgb, var(--g-primary) 10%, transparent);
      color: var(--g-primary);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .control-btn:hover {
      background: color-mix(in srgb, var(--g-primary) 20%, transparent);
      border-color: var(--g-primary);
    }

    .control-btn.active {
      background: linear-gradient(135deg, rgba(34, 197, 94, 0.2) 0%, rgba(59, 130, 246, 0.2) 100%);
      border-color: #22c55e;
      color: #22c55e;
    }

    .control-btn.stop {
      border-color: rgba(239, 68, 68, 0.5);
      background: rgba(239, 68, 68, 0.1);
      color: #ef4444;
    }

    .control-btn.stop:hover {
      background: rgba(239, 68, 68, 0.2);
      border-color: #ef4444;
    }

    .control-btn svg {
      width: 16px;
      height: 16px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .device-select {
      flex: 1;
      min-width: 100px;
      background: rgba(0, 0, 0, 0.5);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 6px;
      padding: 6px 10px;
      color: #ccc;
      font-size: 12px;
      cursor: pointer;
    }

    .device-select:focus {
      outline: none;
      border-color: var(--g-primary);
    }

    /* Placeholder & Error states */
    .placeholder, .error-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      gap: 16px;
      padding: 20px;
      text-align: center;
    }

    .placeholder { color: color-mix(in srgb, var(--g-primary) 40%, transparent); }
    .error-state { color: #ef4444; }

    .placeholder svg, .error-state svg {
      width: 64px;
      height: 64px;
      opacity: 0.3;
    }

    .placeholder p, .error-state p {
      font-size: 14px;
      max-width: 280px;
      line-height: 1.5;
    }

    /* Capture flash */
    .capture-flash {
      position: absolute;
      inset: 0;
      background: white;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.1s;
    }
    .capture-flash.active { opacity: 0.5; }

    /* Capture preview */
    .capture-preview {
      position: absolute;
      bottom: 70px;
      right: 12px;
      width: 100px;
      border: 2px solid var(--g-primary);
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
      opacity: 0;
      transform: scale(0.8) translateY(10px);
      transition: all 0.3s ease;
    }
    .capture-preview.visible {
      opacity: 1;
      transform: scale(1) translateY(0);
    }
    .capture-preview img { width: 100%; display: block; }
  `;

  @state() streaming = false;
  @state() error: string | null = null;
  @state() devices: MediaDeviceInfo[] = [];
  @state() selectedDeviceId: string | null = null;
  @state() showCaptureFlash = false;
  @state() lastCaptureUrl: string | null = null;
  @state() showCapturePreview = false;
  
  // Detection state
  @state() detectionEnabled = false;
  @state() isAnalyzing = false;
  @state() detectionResult: DetectionResult | null = null;
  @state() detectionError: string | null = null;

  @query('video') videoEl!: HTMLVideoElement;
  @query('canvas.capture-canvas') canvasEl!: HTMLCanvasElement;
  @query('canvas.overlay-canvas') overlayEl!: HTMLCanvasElement;

  connectedCallback() {
    super.connectedCallback();
    this.loadDevices();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.stopDetection();
  }

  async loadDevices() {
    try {
      await navigator.mediaDevices.getUserMedia({ video: true });
      this.devices = await getVideoDevices();
      if (this.devices.length > 0 && !this.selectedDeviceId) {
        this.selectedDeviceId = this.devices[0].deviceId;
      }
    } catch (e: any) {
      console.warn('[VideoFeed] Failed to get devices:', e);
      this.error = e.message || 'Failed to access camera';
    }
  }

  async startStream() {
    if (this.streaming) return;
    
    try {
      this.error = null;
      
      const constraints: MediaStreamConstraints = {
        video: this.selectedDeviceId 
          ? { deviceId: { exact: this.selectedDeviceId } }
          : { facingMode: 'user' },
        audio: false
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      
      globalStream = stream;
      globalVideo = this.videoEl;
      globalCanvas = this.canvasEl;
      
      this.videoEl.srcObject = stream;
      await this.videoEl.play();
      
      this.streaming = true;
      this.startFramePush();
      
      console.log('[VideoFeed] Stream started');
    } catch (e: any) {
      console.error('[VideoFeed] Failed to start stream:', e);
      this.error = e.message || 'Failed to start video stream';
    }
  }

  private startFramePush() {
    this.stopFramePush();
    this.pushFrameToGateway();
    framePushInterval = window.setInterval(() => this.pushFrameToGateway(), FRAME_PUSH_INTERVAL_MS);
  }

  private stopFramePush() {
    if (framePushInterval) {
      clearInterval(framePushInterval);
      framePushInterval = null;
    }
  }

  private async pushFrameToGateway() {
    const frame = captureVideoFrame();
    if (!frame) return;
    
    try {
      const win = window as any;
      const client = win.__infinibotGatewayClient;
      
      if (client?.request) {
        await client.request('vision.pushFrame', { dataUrl: frame });
        return;
      }
      
      win.__lastVideoFrame = { dataUrl: frame, timestamp: Date.now() };
    } catch (e) {
      console.debug('[VideoFeed] Frame push failed:', e);
    }
  }

  stopStream() {
    this.stopFramePush();
    this.stopDetection();
    
    if (globalStream) {
      globalStream.getTracks().forEach(track => track.stop());
      globalStream = null;
    }
    
    if (this.videoEl) {
      this.videoEl.srcObject = null;
    }
    
    globalVideo = null;
    globalCanvas = null;
    this.streaming = false;
    this.detectionResult = null;
    this.clearOverlay();
    
    console.log('[VideoFeed] Stream stopped');
  }

  captureFrame() {
    const frame = captureVideoFrame();
    if (frame) {
      this.lastCaptureUrl = frame;
      this.showCaptureFlash = true;
      setTimeout(() => { this.showCaptureFlash = false; }, 100);
      this.showCapturePreview = true;
      setTimeout(() => { this.showCapturePreview = false; }, 2000);
      streamListeners.forEach(cb => cb(frame));
      console.log('[VideoFeed] Frame captured');
    }
  }

  // ============================================================
  // Detection Methods
  // ============================================================

  toggleDetection() {
    if (this.detectionEnabled) {
      this.stopDetection();
    } else {
      this.startDetection();
    }
  }

  private startDetection() {
    if (!this.streaming) return;
    
    this.detectionEnabled = true;
    this.detectionError = null;
    this.runDetection();
    
    detectionInterval = window.setInterval(() => this.runDetection(), DETECTION_INTERVAL_MS);
    console.log('[VideoFeed] Detection started');
  }

  private stopDetection() {
    this.detectionEnabled = false;
    
    if (detectionInterval) {
      clearInterval(detectionInterval);
      detectionInterval = null;
    }
    
    this.detectionResult = null;
    this.clearOverlay();
    console.log('[VideoFeed] Detection stopped');
  }

  private async runDetection() {
    if (!this.streaming || this.isAnalyzing) return;
    
    const frame = captureVideoFrame();
    if (!frame) return;
    
    this.isAnalyzing = true;
    this.detectionError = null;
    
    try {
      const win = window as any;
      const client = win.__infinibotGatewayClient;
      
      if (!client?.request) {
        throw new Error('Gateway not connected');
      }

      // Call vision.detect
      const result = await client.request('vision.detect', { 
        dataUrl: frame,
        mode: 'objects'
      });
      
      console.log('[VideoFeed] Detection result:', result);
      
      if (result && typeof result === 'object') {
        this.detectionResult = {
          boxes: (result as any).boxes || [],
          description: (result as any).description || '',
          timestamp: Date.now()
        };
        this.drawDetectionOverlay();
      }
    } catch (e: any) {
      console.warn('[VideoFeed] Detection failed:', e);
      this.detectionError = e.message || 'Detection failed';
      
      // Still show a description if available
      this.detectionResult = {
        boxes: [],
        description: `⚠️ ${this.detectionError}`,
        timestamp: Date.now()
      };
    } finally {
      this.isAnalyzing = false;
    }
  }

  private drawDetectionOverlay() {
    if (!this.overlayEl || !this.detectionResult) return;
    
    const ctx = this.overlayEl.getContext('2d');
    if (!ctx) return;
    
    const videoWidth = this.videoEl?.videoWidth || 640;
    const videoHeight = this.videoEl?.videoHeight || 480;
    this.overlayEl.width = videoWidth;
    this.overlayEl.height = videoHeight;
    
    ctx.clearRect(0, 0, videoWidth, videoHeight);
    
    // Draw each detection box
    this.detectionResult.boxes.forEach((box, index) => {
      const color = box.color || getBoxColor(index);
      
      // Draw box
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.strokeRect(box.x, box.y, box.width, box.height);
      
      // Draw corner accents (OpenCV style)
      const cornerLen = Math.min(20, box.width / 4, box.height / 4);
      ctx.lineWidth = 4;
      
      // Top-left
      ctx.beginPath();
      ctx.moveTo(box.x, box.y + cornerLen);
      ctx.lineTo(box.x, box.y);
      ctx.lineTo(box.x + cornerLen, box.y);
      ctx.stroke();
      
      // Top-right
      ctx.beginPath();
      ctx.moveTo(box.x + box.width - cornerLen, box.y);
      ctx.lineTo(box.x + box.width, box.y);
      ctx.lineTo(box.x + box.width, box.y + cornerLen);
      ctx.stroke();
      
      // Bottom-left
      ctx.beginPath();
      ctx.moveTo(box.x, box.y + box.height - cornerLen);
      ctx.lineTo(box.x, box.y + box.height);
      ctx.lineTo(box.x + cornerLen, box.y + box.height);
      ctx.stroke();
      
      // Bottom-right
      ctx.beginPath();
      ctx.moveTo(box.x + box.width - cornerLen, box.y + box.height);
      ctx.lineTo(box.x + box.width, box.y + box.height);
      ctx.lineTo(box.x + box.width, box.y + box.height - cornerLen);
      ctx.stroke();
    });
  }

  private clearOverlay() {
    if (!this.overlayEl) return;
    const ctx = this.overlayEl.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, this.overlayEl.width, this.overlayEl.height);
    }
  }

  handleDeviceChange(e: Event) {
    const select = e.target as HTMLSelectElement;
    this.selectedDeviceId = select.value;
    
    if (this.streaming) {
      this.stopStream();
      this.startStream();
    }
  }

  render() {
    return html`
      <div class="video-container">
        ${this.error ? html`
          <div class="error-state">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <path d="M15 9l-6 6M9 9l6 6"/>
            </svg>
            <p>${this.error}</p>
            <button class="control-btn" @click=${this.startStream}>Retry</button>
          </div>
        ` : !this.streaming ? html`
          <div class="placeholder">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M15.6 11.6L22 7v10l-6.4-4.6a1 1 0 0 1 0-1.8z"/>
              <rect x="2" y="6" width="14" height="12" rx="2"/>
            </svg>
            <p>Click Start to enable video feed</p>
          </div>
        ` : nothing}
        
        <video 
          playsinline 
          muted
          style="display: ${this.streaming && !this.error ? 'block' : 'none'}"
        ></video>
        <canvas class="capture-canvas"></canvas>
        <canvas class="overlay-canvas"></canvas>
        
        <div class="capture-flash ${this.showCaptureFlash ? 'active' : ''}"></div>
        
        ${this.lastCaptureUrl ? html`
          <div class="capture-preview ${this.showCapturePreview ? 'visible' : ''}">
            <img src="${this.lastCaptureUrl}" alt="Last capture"/>
          </div>
        ` : nothing}

        <!-- HUD Overlay -->
        ${this.streaming ? html`
          <div class="hud-overlay">
            <div class="hud-top">
              <!-- Status badges -->
              <div style="display: flex; gap: 6px; flex-wrap: wrap;">
                <div class="hud-status live">
                  <span class="hud-dot pulse"></span>
                  LIVE
                </div>
                ${this.detectionEnabled ? html`
                  <div class="hud-status ${this.isAnalyzing ? 'analyzing' : 'ai-active'}">
                    <span class="hud-dot ${this.isAnalyzing ? '' : 'pulse'}"></span>
                    ${this.isAnalyzing ? 'SCANNING' : 'AI ACTIVE'}
                  </div>
                ` : nothing}
              </div>
              
              <!-- Detection labels -->
              ${this.detectionEnabled && this.detectionResult?.boxes.length ? html`
                <div class="hud-labels">
                  ${this.detectionResult.boxes.map((box, i) => html`
                    <div class="hud-label" style="border-color: ${box.color || getBoxColor(i)}">
                      <span class="hud-label__text">${box.label}</span>
                      <span class="hud-label__conf">${Math.round(box.confidence * 100)}%</span>
                    </div>
                  `)}
                </div>
              ` : nothing}
            </div>

            <div class="hud-bottom">
              <!-- Description -->
              ${this.detectionEnabled && this.detectionResult?.description ? html`
                <div class="hud-description">
                  <span class="hud-description__prefix">🔍</span>
                  ${this.detectionResult.description}
                </div>
              ` : nothing}
            </div>
          </div>

          <!-- Analyzing spinner (centered) -->
          <div class="hud-analyzing ${this.isAnalyzing ? 'visible' : ''}">
            <div class="hud-spinner"></div>
            <span class="hud-analyzing__text">Analyzing...</span>
          </div>
        ` : nothing}
      </div>
      
      <div class="controls">
        ${this.streaming ? html`
          <button class="control-btn stop" @click=${this.stopStream}>
            <svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>
            Stop
          </button>
          <button class="control-btn" @click=${this.captureFrame}>
            <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>
            Capture
          </button>
          <button 
            class="control-btn ${this.detectionEnabled ? 'active' : ''}" 
            @click=${this.toggleDetection}
            title="Toggle AI detection overlay"
          >
            <svg viewBox="0 0 24 24">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <circle cx="12" cy="12" r="3"/>
              <path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>
            </svg>
            ${this.detectionEnabled ? '🔍 AI On' : 'AI Off'}
          </button>
        ` : html`
          <button class="control-btn" @click=${this.startStream}>
            <svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            Start
          </button>
        `}
        
        ${this.devices.length > 1 ? html`
          <select 
            class="device-select"
            .value=${this.selectedDeviceId || ''}
            @change=${this.handleDeviceChange}
          >
            ${this.devices.map(d => html`
              <option value="${d.deviceId}">
                ${d.label || `Camera ${this.devices.indexOf(d) + 1}`}
              </option>
            `)}
          </select>
        ` : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'video-feed-panel': VideoFeedPanel;
  }
}
