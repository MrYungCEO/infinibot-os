/**
 * Video Feed HUD Component
 * Real-time webcam feed with camera selection and capture controls
 */

import { LitElement, html, css, unsafeCSS } from "lit";
import { customElement, state, property } from "lit/decorators.js";
import { GatewayBrowserClient } from "../gateway";
import {
  makeDraggableOverlay,
  draggableOverlayStyles,
  type DraggableOverlayHandle,
} from "../lib/draggable-overlay";

type CameraDevice = {
  deviceId: string;
  label: string;
};

@customElement("video-feed-hud")
export class VideoFeedHUD extends LitElement {
  @property({ type: Boolean }) active = false;
  @property({ type: Boolean }) minimized = false;
  @property({ type: String }) position: "top-right" | "top-left" | "bottom-right" | "bottom-left" = "top-right";
  
  @state() private cameras: CameraDevice[] = [];
  @state() private selectedCamera: string = "";
  @state() private stream: MediaStream | null = null;
  @state() private isConnecting = false;
  @state() private error: string | null = null;
  @state() private showSettings = false;
  @state() private frameCount = 0;
  @state() private lastCaptureTime = 0;
  @state() private isCapturing = false;
  @state() private captureInterval: number | null = null;
  @state() private autoCapture = false;
  @state() private captureRate = 2; // seconds between captures
  @state() private hudSize: "small" | "medium" | "large" = "medium";
  
  private videoRef: HTMLVideoElement | null = null;
  private canvasRef: HTMLCanvasElement | null = null;
  private _drag: DraggableOverlayHandle | null = null;

  static styles = css`
    :host {
      display: block;
      position: fixed;
      z-index: 1000;
      font-family: 'Inter', system-ui, sans-serif;
    }

    :host([position="top-right"]) { top: 1rem; right: 1rem; }
    :host([position="top-left"]) { top: 1rem; left: 1rem; }
    :host([position="bottom-right"]) { bottom: 1rem; right: 1rem; }
    :host([position="bottom-left"]) { bottom: 1rem; left: 1rem; }

    .hud-container {
      background: rgba(10, 10, 15, 0.95);
      backdrop-filter: blur(20px);
      border: 1px solid rgba(138, 43, 226, 0.4);
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 
        0 0 30px rgba(138, 43, 226, 0.3),
        0 10px 40px rgba(0, 0, 0, 0.5);
      transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .hud-container.minimized {
      width: 60px !important;
      height: 60px !important;
      border-radius: 50%;
      cursor: pointer;
    }

    .hud-container.small { width: 200px; }
    .hud-container.medium { width: 320px; }
    .hud-container.large { width: 480px; }

    /* Header */
    .hud-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.75rem 1rem;
      background: linear-gradient(135deg, rgba(138, 43, 226, 0.2) 0%, transparent 100%);
      border-bottom: 1px solid rgba(138, 43, 226, 0.3);
    }

    .hud-container.minimized .hud-header {
      display: none;
    }

    .hud-title {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #8a2be2;
      font-weight: 600;
    }

    .hud-title svg {
      filter: drop-shadow(0 0 4px #8a2be2);
    }

    .live-badge {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      background: rgba(0, 255, 136, 0.2);
      border: 1px solid rgba(0, 255, 136, 0.4);
      border-radius: 10px;
      font-size: 0.65rem;
      color: #00ff88;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .live-dot {
      width: 6px;
      height: 6px;
      background: #00ff88;
      border-radius: 50%;
      animation: pulse-live 1.5s ease-in-out infinite;
    }

    @keyframes pulse-live {
      0%, 100% { opacity: 1; box-shadow: 0 0 4px #00ff88; }
      50% { opacity: 0.5; box-shadow: 0 0 8px #00ff88; }
    }

    .hud-controls {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .hud-btn {
      width: 28px;
      height: 28px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: #888;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.2s;
    }

    .hud-btn:hover {
      background: rgba(138, 43, 226, 0.2);
      border-color: rgba(138, 43, 226, 0.4);
      color: #8a2be2;
    }

    .hud-btn.active {
      background: rgba(138, 43, 226, 0.3);
      border-color: #8a2be2;
      color: #8a2be2;
    }

    /* Video Container */
    .video-container {
      position: relative;
      background: #000;
      aspect-ratio: 4/3;
    }

    .hud-container.minimized .video-container {
      width: 60px;
      height: 60px;
      border-radius: 50%;
      overflow: hidden;
    }

    video {
      width: 100%;
      height: 100%;
      object-fit: cover;
      transform: scaleX(-1); /* Mirror for selfie view */
    }

    .video-overlay {
      position: absolute;
      inset: 0;
      pointer-events: none;
    }

    /* Scan lines effect */
    .scanlines {
      position: absolute;
      inset: 0;
      background: repeating-linear-gradient(
        0deg,
        transparent,
        transparent 2px,
        rgba(0, 0, 0, 0.1) 2px,
        rgba(0, 0, 0, 0.1) 4px
      );
      opacity: 0.3;
    }

    /* Corner brackets */
    .corner-bracket {
      position: absolute;
      width: 20px;
      height: 20px;
      border: 2px solid rgba(138, 43, 226, 0.6);
    }
    .corner-bracket.tl { top: 8px; left: 8px; border-right: none; border-bottom: none; }
    .corner-bracket.tr { top: 8px; right: 8px; border-left: none; border-bottom: none; }
    .corner-bracket.bl { bottom: 8px; left: 8px; border-right: none; border-top: none; }
    .corner-bracket.br { bottom: 8px; right: 8px; border-left: none; border-top: none; }

    /* Capture flash effect */
    .capture-flash {
      position: absolute;
      inset: 0;
      background: white;
      opacity: 0;
      transition: opacity 0.1s;
    }

    .capture-flash.active {
      animation: flash 0.2s ease-out;
    }

    @keyframes flash {
      0% { opacity: 0.8; }
      100% { opacity: 0; }
    }

    /* Frame counter */
    .frame-counter {
      position: absolute;
      bottom: 8px;
      left: 8px;
      padding: 2px 8px;
      background: rgba(0, 0, 0, 0.7);
      border-radius: 4px;
      font-size: 0.65rem;
      color: #00ff88;
      font-family: 'JetBrains Mono', monospace;
    }

    /* Status indicator */
    .status-indicator {
      position: absolute;
      top: 8px;
      right: 8px;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 0.65rem;
      font-weight: 600;
      text-transform: uppercase;
    }

    .status-indicator.capturing {
      background: rgba(255, 0, 0, 0.8);
      color: white;
      animation: blink 0.5s ease-in-out infinite;
    }

    @keyframes blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    /* No camera state */
    .no-camera {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      min-height: 180px;
      color: #666;
      gap: 1rem;
    }

    .no-camera svg {
      opacity: 0.5;
    }

    .connect-btn {
      padding: 0.5rem 1.5rem;
      background: linear-gradient(135deg, #8a2be2 0%, #6a1bb2 100%);
      border: none;
      border-radius: 8px;
      color: white;
      font-size: 0.8rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s;
    }

    .connect-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 15px rgba(138, 43, 226, 0.4);
    }

    .connect-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none;
    }

    /* Footer controls */
    .hud-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.75rem 1rem;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(0, 0, 0, 0.3);
    }

    .hud-container.minimized .hud-footer {
      display: none;
    }

    .footer-left {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .capture-btn {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: linear-gradient(135deg, #8a2be2 0%, #6a1bb2 100%);
      border: 3px solid rgba(255, 255, 255, 0.2);
      color: white;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.2s;
    }

    .capture-btn:hover {
      transform: scale(1.1);
      box-shadow: 0 0 20px rgba(138, 43, 226, 0.5);
    }

    .capture-btn:active {
      transform: scale(0.95);
    }

    .auto-toggle {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.7rem;
      color: #888;
    }

    .toggle-switch {
      position: relative;
      width: 36px;
      height: 20px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 10px;
      cursor: pointer;
      transition: background 0.3s;
    }

    .toggle-switch.active {
      background: rgba(138, 43, 226, 0.5);
    }

    .toggle-switch::after {
      content: '';
      position: absolute;
      top: 2px;
      left: 2px;
      width: 16px;
      height: 16px;
      background: #fff;
      border-radius: 50%;
      transition: transform 0.3s;
    }

    .toggle-switch.active::after {
      transform: translateX(16px);
      background: #8a2be2;
      box-shadow: 0 0 8px #8a2be2;
    }

    /* Settings panel */
    .settings-panel {
      padding: 1rem;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
      display: none;
    }

    .settings-panel.open {
      display: block;
    }

    .setting-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 0.75rem;
    }

    .setting-row:last-child {
      margin-bottom: 0;
    }

    .setting-label {
      font-size: 0.75rem;
      color: #888;
    }

    .setting-select {
      padding: 0.4rem 0.75rem;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 6px;
      color: #fff;
      font-size: 0.75rem;
      cursor: pointer;
      max-width: 150px;
    }

    .setting-select:focus {
      outline: none;
      border-color: #8a2be2;
    }

    /* Size buttons */
    .size-buttons {
      display: flex;
      gap: 4px;
    }

    .size-btn {
      padding: 4px 8px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 4px;
      color: #666;
      font-size: 0.65rem;
      cursor: pointer;
      transition: all 0.2s;
    }

    .size-btn:hover, .size-btn.active {
      background: rgba(138, 43, 226, 0.2);
      border-color: #8a2be2;
      color: #8a2be2;
    }

    /* Minimized state */
    .minimized-indicator {
      display: none;
      width: 100%;
      height: 100%;
      align-items: center;
      justify-content: center;
      color: #8a2be2;
    }

    .hud-container.minimized .minimized-indicator {
      display: flex;
    }

    .hud-container.minimized .minimized-indicator svg {
      filter: drop-shadow(0 0 6px #8a2be2);
    }

    /* Hidden canvas for capture */
    .hidden-canvas {
      display: none;
    }

    /* Drag-by-header — header strip shows grab/grabbing. */
    .hud-header { cursor: grab; touch-action: none; }
    .hud-header:active { cursor: grabbing; }
    ${unsafeCSS(draggableOverlayStyles)}
  `;

  async connectedCallback() {
    super.connectedCallback();
    await this.loadCameras();
  }

  firstUpdated() {
    // Drag the whole HUD by its header. The header carries settings/minimize/
    // close buttons — the helper ignores pointerdowns that land on those, so
    // they keep working. Persisted per-component via localStorage.
    const header = this.shadowRoot?.querySelector(".hud-header") as HTMLElement | null;
    this._drag = makeDraggableOverlay(this, "video-feed-hud", { handle: header });
  }

  updated() {
    this._drag?.refresh();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.stopStream();
    this.stopAutoCapture();
    this._drag?.destroy();
    this._drag = null;
  }

  private async loadCameras() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.cameras = devices
        .filter(d => d.kind === "videoinput")
        .map(d => ({
          deviceId: d.deviceId,
          label: d.label || `Camera ${d.deviceId.slice(0, 8)}`,
        }));
      
      if (this.cameras.length > 0 && !this.selectedCamera) {
        this.selectedCamera = this.cameras[0].deviceId;
      }
    } catch (e) {
      console.error("[VideoFeedHUD] Failed to enumerate devices:", e);
    }
  }

  private async startStream() {
    if (this.stream) return;
    
    this.isConnecting = true;
    this.error = null;

    try {
      // Request camera permission first
      await navigator.mediaDevices.getUserMedia({ video: true });
      await this.loadCameras();

      const constraints: MediaStreamConstraints = {
        video: this.selectedCamera
          ? { deviceId: { exact: this.selectedCamera } }
          : true,
      };

      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      
      // Wait for video element to be available
      await this.updateComplete;
      this.videoRef = this.shadowRoot?.querySelector("video") as HTMLVideoElement;
      
      if (this.videoRef) {
        this.videoRef.srcObject = this.stream;
        await this.videoRef.play();
      }

      this.dispatchEvent(new CustomEvent("camera-connected", {
        bubbles: true,
        composed: true,
      }));

    } catch (e: any) {
      this.error = e.message || "Failed to access camera";
      console.error("[VideoFeedHUD] Camera error:", e);
    } finally {
      this.isConnecting = false;
    }
  }

  private stopStream() {
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
    if (this.videoRef) {
      this.videoRef.srcObject = null;
    }
  }

  private async switchCamera(deviceId: string) {
    this.selectedCamera = deviceId;
    this.stopStream();
    await this.startStream();
  }

  async captureFrame(): Promise<string | null> {
    if (!this.videoRef || !this.stream) return null;

    this.canvasRef = this.shadowRoot?.querySelector(".hidden-canvas") as HTMLCanvasElement;
    if (!this.canvasRef) return null;

    const video = this.videoRef;
    const canvas = this.canvasRef;
    
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    // Mirror the image to match video display
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0);

    // Flash effect
    this.isCapturing = true;
    this.frameCount++;
    this.lastCaptureTime = Date.now();
    
    const flashEl = this.shadowRoot?.querySelector(".capture-flash");
    flashEl?.classList.add("active");
    setTimeout(() => {
      flashEl?.classList.remove("active");
      this.isCapturing = false;
    }, 200);

    // Get base64 image
    const base64 = canvas.toDataURL("image/jpeg", 0.8);
    
    // Dispatch event with the captured frame
    this.dispatchEvent(new CustomEvent("frame-captured", {
      bubbles: true,
      composed: true,
      detail: { 
        base64,
        timestamp: Date.now(),
        frameNumber: this.frameCount,
      },
    }));

    return base64;
  }

  private toggleAutoCapture() {
    this.autoCapture = !this.autoCapture;
    
    if (this.autoCapture) {
      this.startAutoCapture();
    } else {
      this.stopAutoCapture();
    }
  }

  private startAutoCapture() {
    if (this.captureInterval) return;
    
    this.captureInterval = window.setInterval(() => {
      if (this.stream && this.active) {
        this.captureFrame();
      }
    }, this.captureRate * 1000);
  }

  private stopAutoCapture() {
    if (this.captureInterval) {
      clearInterval(this.captureInterval);
      this.captureInterval = null;
    }
  }

  private toggleMinimize() {
    this.minimized = !this.minimized;
  }

  private toggleSettings() {
    this.showSettings = !this.showSettings;
  }

  private setSize(size: "small" | "medium" | "large") {
    this.hudSize = size;
  }

  render() {
    return html`
      <div class="hud-container ${this.minimized ? 'minimized' : ''} ${this.hudSize}"
           @click=${this.minimized ? () => this.minimized = false : undefined}>
        
        <!-- Minimized indicator -->
        <div class="minimized-indicator">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
            <circle cx="12" cy="13" r="4"></circle>
          </svg>
        </div>

        <!-- Header -->
        <div class="hud-header">
          <div class="hud-title">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
              <circle cx="12" cy="12" r="3"></circle>
            </svg>
            Vision Feed
            ${this.stream ? html`
              <div class="live-badge">
                <div class="live-dot"></div>
                LIVE
              </div>
            ` : ''}
          </div>
          <div class="hud-controls">
            <button class="hud-btn ${this.showSettings ? 'active' : ''}" 
                    @click=${this.toggleSettings}
                    title="Settings">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="3"></circle>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
              </svg>
            </button>
            <button class="hud-btn" @click=${this.toggleMinimize} title="Minimize">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="5" y1="12" x2="19" y2="12"></line>
              </svg>
            </button>
            <button class="hud-btn" @click=${() => this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }))} title="Close">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        </div>

        <!-- Video -->
        <div class="video-container">
          ${this.stream ? html`
            <video autoplay playsinline muted></video>
            <div class="video-overlay">
              <div class="scanlines"></div>
              <div class="corner-bracket tl"></div>
              <div class="corner-bracket tr"></div>
              <div class="corner-bracket bl"></div>
              <div class="corner-bracket br"></div>
              <div class="capture-flash"></div>
              <div class="frame-counter">
                FRM: ${String(this.frameCount).padStart(4, '0')}
              </div>
              ${this.isCapturing ? html`
                <div class="status-indicator capturing">REC</div>
              ` : ''}
            </div>
          ` : html`
            <div class="no-camera">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
                <circle cx="12" cy="13" r="4"></circle>
              </svg>
              <button class="connect-btn" 
                      ?disabled=${this.isConnecting}
                      @click=${this.startStream}>
                ${this.isConnecting ? 'Connecting...' : 'Connect Camera'}
              </button>
              ${this.error ? html`
                <div style="color: #ff5555; font-size: 0.75rem;">${this.error}</div>
              ` : ''}
            </div>
          `}
        </div>

        <!-- Settings -->
        <div class="settings-panel ${this.showSettings ? 'open' : ''}">
          <div class="setting-row">
            <span class="setting-label">Camera</span>
            <select class="setting-select" 
                    .value=${this.selectedCamera}
                    @change=${(e: Event) => this.switchCamera((e.target as HTMLSelectElement).value)}>
              ${this.cameras.map(cam => html`
                <option value=${cam.deviceId}>${cam.label}</option>
              `)}
            </select>
          </div>
          <div class="setting-row">
            <span class="setting-label">Capture Rate</span>
            <select class="setting-select"
                    .value=${String(this.captureRate)}
                    @change=${(e: Event) => this.captureRate = Number((e.target as HTMLSelectElement).value)}>
              <option value="1">Every 1s</option>
              <option value="2">Every 2s</option>
              <option value="5">Every 5s</option>
              <option value="10">Every 10s</option>
            </select>
          </div>
          <div class="setting-row">
            <span class="setting-label">HUD Size</span>
            <div class="size-buttons">
              <button class="size-btn ${this.hudSize === 'small' ? 'active' : ''}" 
                      @click=${() => this.setSize('small')}>S</button>
              <button class="size-btn ${this.hudSize === 'medium' ? 'active' : ''}" 
                      @click=${() => this.setSize('medium')}>M</button>
              <button class="size-btn ${this.hudSize === 'large' ? 'active' : ''}" 
                      @click=${() => this.setSize('large')}>L</button>
            </div>
          </div>
        </div>

        <!-- Footer -->
        <div class="hud-footer">
          <div class="footer-left">
            <div class="auto-toggle">
              <div class="toggle-switch ${this.autoCapture ? 'active' : ''}"
                   @click=${this.toggleAutoCapture}></div>
              <span>Auto</span>
            </div>
          </div>
          <button class="capture-btn" 
                  ?disabled=${!this.stream}
                  @click=${this.captureFrame}
                  title="Capture Frame">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"></circle>
              <circle cx="12" cy="12" r="4" fill="currentColor"></circle>
            </svg>
          </button>
        </div>

        <!-- Hidden canvas for capture -->
        <canvas class="hidden-canvas"></canvas>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "video-feed-hud": VideoFeedHUD;
  }
}
