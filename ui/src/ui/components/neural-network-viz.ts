/**
 * Neural Network 3D Visualization
 * 
 * A stunning 3D neural network sphere visualization using Three.js
 * Features:
 * - Rotating sphere of interconnected nodes
 * - Glowing pink/magenta connections
 * - Pulse animations showing activity
 * - Node labels
 * - Dark backdrop with depth
 */

import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import * as THREE from "three";
import { createCanvasPause, type CanvasPause } from "../lib/canvas-pause";

interface NeuralNode {
  id: string;
  position: THREE.Vector3;
  connections: number[];
  layer: number;
  label?: string;
}

@customElement("neural-network-viz")
export class NeuralNetworkViz extends LitElement {
  @property({ type: Boolean }) active: boolean = true;
  @property({ type: Number }) nodeCount: number = 80;
  @property({ type: Number }) connectionDensity: number = 0.15;
  @property({ type: String }) colorScheme: 'pink' | 'gold' | 'cyan' = 'pink';
  
  @state() private fps: number = 60;
  @state() private isThinking: boolean = false;
  
  private container: HTMLDivElement | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private nodes: THREE.Mesh[] = [];
  private edges: THREE.Line[] = [];
  private nodeData: NeuralNode[] = [];
  private animationId: number | null = null;
  private pauseCtrl: CanvasPause | null = null;
  private clock: THREE.Clock = new THREE.Clock();
  private sphereGroup: THREE.Group | null = null;
  private pulsePhase: number = 0;
  private frameCount: number = 0;
  private lastFpsUpdate: number = 0;

  static styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      background: #000;
      position: relative;
      overflow: hidden;
    }

    .viz-container {
      width: 100%;
      height: 100%;
    }

    .viz-overlay {
      position: absolute;
      bottom: 16px;
      left: 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      pointer-events: none;
    }

    .viz-stat {
      display: flex;
      align-items: center;
      gap: 8px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: rgba(255, 255, 255, 0.5);
    }

    .viz-stat-value {
      color: #ff69b4;
      font-weight: 600;
    }

    .viz-controls {
      position: absolute;
      top: 16px;
      right: 16px;
      display: flex;
      gap: 8px;
    }

    .viz-btn {
      padding: 8px 14px;
      border: 1px solid rgba(255, 105, 180, 0.3);
      border-radius: 6px;
      background: rgba(255, 105, 180, 0.1);
      color: #ff69b4;
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .viz-btn:hover {
      background: rgba(255, 105, 180, 0.2);
      border-color: rgba(255, 105, 180, 0.5);
    }

    .viz-btn.active {
      background: rgba(255, 105, 180, 0.3);
      border-color: #ff69b4;
    }

    .thinking-indicator {
      position: absolute;
      top: 16px;
      left: 16px;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      background: rgba(255, 105, 180, 0.15);
      border: 1px solid rgba(255, 105, 180, 0.3);
      border-radius: 8px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: #ff69b4;
    }

    .thinking-dot {
      width: 8px;
      height: 8px;
      background: #ff69b4;
      border-radius: 50%;
      animation: pulse 1s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 0.5; transform: scale(0.8); }
      50% { opacity: 1; transform: scale(1.2); }
    }

    .title-overlay {
      position: absolute;
      bottom: 60px;
      left: 50%;
      transform: translateX(-50%);
      font-family: 'JetBrains Mono', monospace;
      font-size: 14px;
      color: rgba(255, 255, 255, 0.6);
      text-align: center;
      pointer-events: none;
    }

    .title-overlay .subtitle {
      font-size: 11px;
      color: rgba(255, 105, 180, 0.7);
      margin-top: 4px;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    // Wait for first render
    this.updateComplete.then(() => {
      this.initThreeJS();
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.cleanup();
  }

  private cleanup() {
    this.pauseCtrl?.stop();
    this.pauseCtrl = null;
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = null;
    }
    this.scene = null;
    this.camera = null;
  }

  private getColorPalette() {
    switch (this.colorScheme) {
      case 'gold':
        return {
          primary: 0xFFD700,
          secondary: 0xFFA500,
          glow: 0xFFEC8B,
          ambient: 0x332200,
        };
      case 'cyan':
        return {
          primary: 0x00FFFF,
          secondary: 0x0088FF,
          glow: 0x88FFFF,
          ambient: 0x002233,
        };
      case 'pink':
      default:
        return {
          primary: 0xFF69B4,
          secondary: 0xFF1493,
          glow: 0xFFB6C1,
          ambient: 0x330022,
        };
    }
  }

  private initThreeJS() {
    this.container = this.shadowRoot?.querySelector('.viz-container') as HTMLDivElement;
    if (!this.container) return;

    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const colors = this.getColorPalette();

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);
    this.scene.fog = new THREE.Fog(0x000000, 5, 15);

    // Camera
    this.camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1000);
    this.camera.position.z = 5;

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ 
      antialias: true,
      alpha: true,
    });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.container.appendChild(this.renderer.domElement);

    // Create sphere group for rotation
    this.sphereGroup = new THREE.Group();
    this.scene.add(this.sphereGroup);

    // Generate neural network
    this.generateNetwork();

    // Ambient light
    const ambientLight = new THREE.AmbientLight(colors.ambient, 0.5);
    this.scene.add(ambientLight);

    // Point lights for glow effect
    const light1 = new THREE.PointLight(colors.primary, 1, 10);
    light1.position.set(2, 2, 2);
    this.scene.add(light1);

    const light2 = new THREE.PointLight(colors.secondary, 0.5, 10);
    light2.position.set(-2, -2, 2);
    this.scene.add(light2);

    // Handle resize
    const resizeObserver = new ResizeObserver(() => this.handleResize());
    resizeObserver.observe(this.container);

    // Pause the loop when offscreen / tab hidden; throttle to 30fps when the
    // window is blurred. Resume re-kicks the rAF loop.
    this.pauseCtrl = createCanvasPause(this.container, { throttleWhenBlurred: true });
    this.pauseCtrl.onChange = (active) => {
      if (active && this.animationId == null) this.animate();
    };
    this.pauseCtrl.start();

    // Start animation
    this.animate();
  }

  private generateNetwork() {
    if (!this.sphereGroup) return;
    const colors = this.getColorPalette();

    // Clear existing
    while (this.sphereGroup.children.length > 0) {
      this.sphereGroup.remove(this.sphereGroup.children[0]);
    }
    this.nodes = [];
    this.edges = [];
    this.nodeData = [];

    // Generate nodes on sphere surface
    const radius = 2;
    
    for (let i = 0; i < this.nodeCount; i++) {
      // Fibonacci sphere distribution for even spacing
      const phi = Math.acos(1 - 2 * (i + 0.5) / this.nodeCount);
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;
      
      const x = radius * Math.sin(phi) * Math.cos(theta);
      const y = radius * Math.sin(phi) * Math.sin(theta);
      const z = radius * Math.cos(phi);

      const position = new THREE.Vector3(x, y, z);
      
      // Determine layer based on position
      const layer = Math.floor((phi / Math.PI) * 4);
      
      this.nodeData.push({
        id: `n${i}`,
        position,
        connections: [],
        layer,
        label: layer === 0 ? 'Input' : layer === 3 ? 'Output' : `L${layer}`,
      });

      // Create node mesh
      const nodeGeometry = new THREE.SphereGeometry(0.04, 16, 16);
      const nodeMaterial = new THREE.MeshBasicMaterial({
        color: colors.glow,
        transparent: true,
        opacity: 0.9,
      });
      const nodeMesh = new THREE.Mesh(nodeGeometry, nodeMaterial);
      nodeMesh.position.copy(position);
      this.sphereGroup.add(nodeMesh);
      this.nodes.push(nodeMesh);
    }

    // Generate connections
    const edgeMaterial = new THREE.LineBasicMaterial({
      color: colors.primary,
      transparent: true,
      opacity: 0.3,
    });

    for (let i = 0; i < this.nodeCount; i++) {
      for (let j = i + 1; j < this.nodeCount; j++) {
        const distance = this.nodeData[i].position.distanceTo(this.nodeData[j].position);
        
        // Connect nearby nodes
        if (distance < 0.8 && Math.random() < this.connectionDensity) {
          this.nodeData[i].connections.push(j);
          this.nodeData[j].connections.push(i);

          const points = [
            this.nodeData[i].position,
            this.nodeData[j].position,
          ];
          const geometry = new THREE.BufferGeometry().setFromPoints(points);
          const line = new THREE.Line(geometry, edgeMaterial.clone());
          this.sphereGroup.add(line);
          this.edges.push(line);
        }
      }
    }
  }

  private handleResize() {
    if (!this.container || !this.camera || !this.renderer) return;
    
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  private animate = () => {
    // Stop the loop entirely while offscreen / tab hidden — resume re-kicks it.
    if (this.pauseCtrl && !this.pauseCtrl.isActive()) {
      this.animationId = null;
      return;
    }
    this.animationId = requestAnimationFrame(this.animate);

    // Throttle gate: skip this frame's work when the window is blurred.
    if (this.pauseCtrl && !this.pauseCtrl.wantsFrame(performance.now())) return;

    const delta = this.clock.getDelta();
    const elapsed = this.clock.getElapsedTime();
    
    // FPS counter
    this.frameCount++;
    if (elapsed - this.lastFpsUpdate >= 1) {
      this.fps = Math.round(this.frameCount / (elapsed - this.lastFpsUpdate));
      this.frameCount = 0;
      this.lastFpsUpdate = elapsed;
    }

    if (!this.sphereGroup || !this.renderer || !this.scene || !this.camera) return;

    // Rotate sphere
    this.sphereGroup.rotation.y += delta * 0.2;
    this.sphereGroup.rotation.x = Math.sin(elapsed * 0.3) * 0.1;

    // Pulse animation
    this.pulsePhase += delta * 2;
    const colors = this.getColorPalette();
    
    // Animate edges (neural activity)
    this.edges.forEach((edge, i) => {
      const material = edge.material as THREE.LineBasicMaterial;
      const phase = (this.pulsePhase + i * 0.1) % (Math.PI * 2);
      const intensity = this.isThinking 
        ? 0.3 + Math.sin(phase) * 0.4 
        : 0.2 + Math.sin(phase * 0.5) * 0.1;
      material.opacity = intensity;
      
      // Color shift for active connections
      if (this.isThinking && Math.random() < 0.02) {
        material.color.setHex(colors.glow);
        setTimeout(() => material.color.setHex(colors.primary), 100);
      }
    });

    // Animate nodes
    this.nodes.forEach((node, i) => {
      const material = node.material as THREE.MeshBasicMaterial;
      const phase = (this.pulsePhase + i * 0.2) % (Math.PI * 2);
      
      // Pulse size
      const scale = this.isThinking
        ? 1 + Math.sin(phase) * 0.3
        : 1 + Math.sin(phase * 0.3) * 0.1;
      node.scale.setScalar(scale);
      
      // Brightness pulse
      material.opacity = this.isThinking
        ? 0.7 + Math.sin(phase) * 0.3
        : 0.8 + Math.sin(phase * 0.5) * 0.1;
    });

    this.renderer.render(this.scene, this.camera);
  };

  private toggleThinking = () => {
    this.isThinking = !this.isThinking;
  };

  private cycleColorScheme = () => {
    const schemes: Array<'pink' | 'gold' | 'cyan'> = ['pink', 'gold', 'cyan'];
    const currentIndex = schemes.indexOf(this.colorScheme);
    this.colorScheme = schemes[(currentIndex + 1) % schemes.length];
    this.generateNetwork();
  };

  render() {
    return html`
      <div class="viz-container"></div>
      
      ${this.isThinking ? html`
        <div class="thinking-indicator">
          <div class="thinking-dot"></div>
          Processing...
        </div>
      ` : ''}
      
      <div class="viz-controls">
        <button 
          class="viz-btn ${this.isThinking ? 'active' : ''}"
          @click=${this.toggleThinking}
        >
          ${this.isThinking ? '⏹ Stop' : '▶ Simulate'}
        </button>
        <button class="viz-btn" @click=${this.cycleColorScheme}>
          🎨 ${this.colorScheme.toUpperCase()}
        </button>
      </div>
      
      <div class="viz-overlay">
        <div class="viz-stat">
          <span>NODES</span>
          <span class="viz-stat-value">${this.nodeCount}</span>
        </div>
        <div class="viz-stat">
          <span>EDGES</span>
          <span class="viz-stat-value">${this.edges.length}</span>
        </div>
        <div class="viz-stat">
          <span>FPS</span>
          <span class="viz-stat-value">${this.fps}</span>
        </div>
      </div>
      
      <div class="title-overlay">
        Neural Network
        <div class="subtitle">>>> Local LLM Visualization</div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "neural-network-viz": NeuralNetworkViz;
  }
}
