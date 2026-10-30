/**
 * Federation Mesh UI with Real-Time Animations
 * 
 * Interactive mesh network visualization that shows:
 * - Real-time agent spawning/completion animations
 * - Message flow between nodes and agents
 * - Node connection/disconnection events
 * - Dynamic mesh topology updates
 */

import { html, nothing, TemplateResult } from "lit";
import type { FederationState } from "../controllers/federation";
import type { GatewayBrowserClient } from "../gateway";
import { rafLoop, type SchedulerHandle } from "../perf/visibility-scheduler";

// ══════════════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════════════

export interface FederationMeshProps {
  federationState: FederationState;
  client: GatewayBrowserClient | null;
  onSelectNode: (nodeId: string | null) => void;
  onSpawnAgent: (nodeId: string, agentType: string, task: string) => void;
}

interface MeshNode {
  id: string;
  name: string;
  type: 'master' | 'satellite' | 'local';
  status: 'online' | 'offline' | 'connecting';
  x: number;
  y: number;
  agents: MeshAgent[];
  capabilities: string[];
  lastSeen: number;
  latency?: number;
}

interface MeshAgent {
  sessionKey: string;
  agentId: string;
  label: string;
  status: 'starting' | 'working' | 'blocked' | 'finishing' | 'completed';
  progress: number;
  nodeId: string;
  x: number;
  y: number;
  spawnedAt: number;
  lastActivity: number;
  // Animation state
  isNew?: boolean;
  isCompleting?: boolean;
  pulseIntensity?: number;
}

interface MeshConnection {
  from: string;
  to: string;
  type: 'node-link' | 'message' | 'spawn';
  strength: number;
  animated: boolean;
  color?: string;
  lastActivity: number;
}

interface AnimationParticle {
  id: string;
  type: 'message' | 'spawn' | 'complete';
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  progress: number; // 0-1
  color: string;
  size: number;
  speed: number;
  payload?: any;
}

// ══════════════════════════════════════════════════════════════════════════════
// State Management
// ══════════════════════════════════════════════════════════════════════════════

class FederationMeshState {
  public nodes: Map<string, MeshNode> = new Map();
  public agents: Map<string, MeshAgent> = new Map();
  public connections: Map<string, MeshConnection> = new Map();
  public particles: Map<string, AnimationParticle> = new Map();
  public canvas: HTMLCanvasElement | null = null;
  public ctx: CanvasRenderingContext2D | null = null;
  public animationLoop: SchedulerHandle | null = null;
  public lastUpdate: number = 0;
  public isAnimating: boolean = false;

  // Layout constants
  public width: number = 800;
  public height: number = 600;
  public centerX: number = 400;
  public centerY: number = 300;
  public nodeRadius: number = 40;
  public agentRadius: number = 15;
  
  // Animation settings
  public particleSpeed: number = 2;
  public pulseSpeed: number = 0.02;
  public connectionDecay: number = 0.98;

  constructor() {
    this.startAnimationLoop();
  }

  public updateFromFederationState(state: FederationState): void {
    // Update nodes from federation state
    for (const federationNode of state.nodes) {
      const existing = this.nodes.get(federationNode.id);
      const meshNode: MeshNode = {
        id: federationNode.id,
        name: federationNode.name,
        type: federationNode.role,
        status: federationNode.status,
        x: existing?.x ?? this.getNodePosition(federationNode.id, state.nodes.length).x,
        y: existing?.y ?? this.getNodePosition(federationNode.id, state.nodes.length).y,
        agents: existing?.agents ?? [],
        capabilities: Object.keys(federationNode.capabilities).filter(k => federationNode.capabilities[k]),
        lastSeen: federationNode.lastSeen,
        latency: federationNode.latency,
      };
      
      this.nodes.set(federationNode.id, meshNode);
    }

    // Remove disconnected nodes
    for (const [nodeId] of this.nodes) {
      if (!state.nodes.find(n => n.id === nodeId)) {
        this.removeNode(nodeId);
      }
    }
  }

  private getNodePosition(nodeId: string, totalNodes: number): { x: number; y: number } {
    const angle = (this.nodes.size * 2 * Math.PI) / Math.max(totalNodes, 3);
    const radius = 180;
    const x = this.centerX + Math.cos(angle) * radius;
    const y = this.centerY + Math.sin(angle) * radius;
    return { x, y };
  }

  public addAgent(agent: MeshAgent): void {
    const node = this.nodes.get(agent.nodeId);
    if (!node) return;

    // Position agent around its node
    const agentAngle = node.agents.length * (Math.PI / 4);
    const agentDistance = this.nodeRadius + 25;
    agent.x = node.x + Math.cos(agentAngle) * agentDistance;
    agent.y = node.y + Math.sin(agentAngle) * agentDistance;
    agent.isNew = true;
    agent.spawnedAt = Date.now();

    this.agents.set(agent.sessionKey, agent);
    node.agents.push(agent);

    // Create spawn animation particle
    this.createParticle({
      type: 'spawn',
      fromX: node.x,
      fromY: node.y,
      toX: agent.x,
      toY: agent.y,
      color: '#00ff88',
      size: 8,
      payload: agent,
    });

    // Fade the isNew flag after animation completes
    setTimeout(() => {
      const currentAgent = this.agents.get(agent.sessionKey);
      if (currentAgent) {
        currentAgent.isNew = false;
      }
    }, 1000);
  }

  public removeAgent(sessionKey: string): void {
    const agent = this.agents.get(sessionKey);
    if (!agent) return;

    const node = this.nodes.get(agent.nodeId);
    if (node) {
      node.agents = node.agents.filter(a => a.sessionKey !== sessionKey);
    }

    // Mark for completion animation
    agent.isCompleting = true;

    // Create completion particle
    this.createParticle({
      type: 'complete',
      fromX: agent.x,
      fromY: agent.y,
      toX: node?.x ?? agent.x,
      toY: node?.y ?? agent.y,
      color: '#ff4444',
      size: 6,
      payload: agent,
    });

    // Remove after animation
    setTimeout(() => {
      this.agents.delete(sessionKey);
    }, 800);
  }

  public updateAgent(sessionKey: string, update: Partial<MeshAgent>): void {
    const agent = this.agents.get(sessionKey);
    if (!agent) return;

    Object.assign(agent, update);
    agent.lastActivity = Date.now();
    
    // Pulse animation based on activity
    if (update.status || update.progress !== undefined) {
      agent.pulseIntensity = 1.0;
    }
  }

  public createMessage(fromSessionKey: string, toSessionKey: string, messageType: string): void {
    const fromAgent = this.agents.get(fromSessionKey);
    const toAgent = this.agents.get(toSessionKey);
    
    if (fromAgent && toAgent) {
      this.createParticle({
        type: 'message',
        fromX: fromAgent.x,
        fromY: fromAgent.y,
        toX: toAgent.x,
        toY: toAgent.y,
        color: '#0088ff',
        size: 4,
        payload: { messageType },
      });

      // Create connection
      const connectionId = `${fromSessionKey}-${toSessionKey}`;
      this.connections.set(connectionId, {
        from: fromSessionKey,
        to: toSessionKey,
        type: 'message',
        strength: 1.0,
        animated: true,
        color: '#0088ff',
        lastActivity: Date.now(),
      });
    }
  }

  public addNode(nodeId: string, nodeName: string): void {
    const position = this.getNodePosition(nodeId, this.nodes.size + 1);
    const newNode: MeshNode = {
      id: nodeId,
      name: nodeName,
      type: 'satellite',
      status: 'connecting',
      x: position.x,
      y: position.y,
      agents: [],
      capabilities: [],
      lastSeen: Date.now(),
    };

    this.nodes.set(nodeId, newNode);

    // Animate connection to master
    const masterNode = Array.from(this.nodes.values()).find(n => n.type === 'master');
    if (masterNode) {
      this.createParticle({
        type: 'spawn',
        fromX: masterNode.x,
        fromY: masterNode.y,
        toX: newNode.x,
        toY: newNode.y,
        color: '#00ffff',
        size: 10,
      });

      this.connections.set(`master-${nodeId}`, {
        from: masterNode.id,
        to: nodeId,
        type: 'node-link',
        strength: 1.0,
        animated: true,
        color: '#00ffff',
        lastActivity: Date.now(),
      });
    }
  }

  public removeNode(nodeId: string): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;

    // Remove all agents on this node
    for (const agent of node.agents) {
      this.removeAgent(agent.sessionKey);
    }

    // Remove connections
    for (const [connId, connection] of this.connections) {
      if (connection.from === nodeId || connection.to === nodeId) {
        this.connections.delete(connId);
      }
    }

    this.nodes.delete(nodeId);
  }

  private createParticle(config: Partial<AnimationParticle> & { type: AnimationParticle['type']; fromX: number; fromY: number; toX: number; toY: number }): void {
    const particle: AnimationParticle = {
      id: `particle-${Date.now()}-${Math.random()}`,
      progress: 0,
      color: '#ffffff',
      size: 5,
      speed: this.particleSpeed,
      ...config,
    };

    this.particles.set(particle.id, particle);

    // Auto-remove after animation
    setTimeout(() => {
      this.particles.delete(particle.id);
    }, 2000);
  }

  private startAnimationLoop(): void {
    if (this.animationLoop) return;

    const animate = (timestamp: number) => {
      if (!this.isAnimating || !this.ctx) {
        return;
      }

      const deltaTime = timestamp - this.lastUpdate;
      this.lastUpdate = timestamp;

      this.updateAnimations(deltaTime);
      this.render();
    };

    this.animationLoop = rafLoop(animate);
  }

  private updateAnimations(deltaTime: number): void {
    // Update particles
    for (const [id, particle] of this.particles) {
      particle.progress += particle.speed * (deltaTime / 1000);
      
      if (particle.progress >= 1) {
        this.particles.delete(id);
      }
    }

    // Update agent pulse animations
    for (const [, agent] of this.agents) {
      if (agent.pulseIntensity && agent.pulseIntensity > 0) {
        agent.pulseIntensity = Math.max(0, agent.pulseIntensity - this.pulseSpeed);
      }
    }

    // Decay connections
    for (const [id, connection] of this.connections) {
      connection.strength *= this.connectionDecay;
      
      if (connection.strength < 0.1) {
        this.connections.delete(id);
      }
    }
  }

  private render(): void {
    if (!this.ctx) return;

    // Clear canvas
    this.ctx.fillStyle = '#0a0a0a';
    this.ctx.fillRect(0, 0, this.width, this.height);

    // Draw connections
    this.renderConnections();

    // Draw nodes
    this.renderNodes();

    // Draw agents
    this.renderAgents();

    // Draw particles
    this.renderParticles();
  }

  private renderConnections(): void {
    if (!this.ctx) return;

    for (const [, connection] of this.connections) {
      const fromNode = this.nodes.get(connection.from);
      const toNode = this.nodes.get(connection.to);
      
      if (!fromNode || !toNode) continue;

      this.ctx.save();
      this.ctx.globalAlpha = connection.strength;
      this.ctx.strokeStyle = connection.color ?? '#444';
      this.ctx.lineWidth = 2;
      this.ctx.setLineDash(connection.animated ? [5, 5] : []);

      this.ctx.beginPath();
      this.ctx.moveTo(fromNode.x, fromNode.y);
      this.ctx.lineTo(toNode.x, toNode.y);
      this.ctx.stroke();

      this.ctx.restore();
    }
  }

  private renderNodes(): void {
    if (!this.ctx) return;

    for (const [, node] of this.nodes) {
      const radius = this.nodeRadius;
      
      // Node background
      this.ctx.fillStyle = node.status === 'online' ? '#1e293b' : '#374151';
      this.ctx.beginPath();
      this.ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI);
      this.ctx.fill();

      // Node border
      this.ctx.strokeStyle = this.getNodeStatusColor(node.status);
      this.ctx.lineWidth = 3;
      this.ctx.stroke();

      // Node icon
      this.ctx.fillStyle = node.type === 'master' ? 'var(--g-primary)' : '#00ffff';
      this.ctx.font = '20px Arial';
      this.ctx.textAlign = 'center';
      this.ctx.fillText(node.type === 'master' ? '👑' : '🛰️', node.x, node.y + 7);

      // Node name
      this.ctx.fillStyle = '#ffffff';
      this.ctx.font = '12px Arial';
      this.ctx.fillText(node.name, node.x, node.y + radius + 15);

      // Status indicator
      if (node.latency !== undefined) {
        this.ctx.fillStyle = '#888';
        this.ctx.font = '10px Arial';
        this.ctx.fillText(`${node.latency}ms`, node.x, node.y + radius + 28);
      }
    }
  }

  private renderAgents(): void {
    if (!this.ctx) return;

    for (const [, agent] of this.agents) {
      const radius = this.agentRadius;
      let effectiveRadius = radius;

      // Pulse effect for new or active agents
      if (agent.isNew || (agent.pulseIntensity && agent.pulseIntensity > 0)) {
        const pulseScale = 1 + (agent.pulseIntensity ?? 0) * 0.3;
        effectiveRadius = radius * pulseScale;
      }

      // Agent background
      this.ctx.fillStyle = this.getAgentStatusColor(agent.status);
      this.ctx.beginPath();
      this.ctx.arc(agent.x, agent.y, effectiveRadius, 0, 2 * Math.PI);
      this.ctx.fill();

      // Agent border
      this.ctx.strokeStyle = agent.isNew ? '#00ff88' : '#ffffff';
      this.ctx.lineWidth = agent.isNew ? 3 : 1;
      this.ctx.stroke();

      // Progress ring for working agents
      if (agent.status === 'working' && agent.progress > 0) {
        this.ctx.strokeStyle = 'var(--g-primary)';
        this.ctx.lineWidth = 3;
        this.ctx.beginPath();
        this.ctx.arc(
          agent.x, 
          agent.y, 
          effectiveRadius + 5, 
          -Math.PI / 2, 
          -Math.PI / 2 + (agent.progress / 100) * 2 * Math.PI
        );
        this.ctx.stroke();
      }

      // Agent icon
      this.ctx.fillStyle = '#ffffff';
      this.ctx.font = '12px Arial';
      this.ctx.textAlign = 'center';
      this.ctx.fillText('🤖', agent.x, agent.y + 4);

      // Completion animation
      if (agent.isCompleting) {
        this.ctx.save();
        this.ctx.globalAlpha = 0.7;
        this.ctx.fillStyle = '#ff4444';
        this.ctx.beginPath();
        this.ctx.arc(agent.x, agent.y, effectiveRadius * 1.5, 0, 2 * Math.PI);
        this.ctx.fill();
        this.ctx.restore();
      }
    }
  }

  private renderParticles(): void {
    if (!this.ctx) return;

    for (const [, particle] of this.particles) {
      const progress = Math.min(1, particle.progress);
      const x = particle.fromX + (particle.toX - particle.fromX) * progress;
      const y = particle.fromY + (particle.toY - particle.fromY) * progress;

      // Particle trail effect
      this.ctx.save();
      this.ctx.globalAlpha = 1 - progress * 0.5;
      this.ctx.fillStyle = particle.color;
      this.ctx.beginPath();
      this.ctx.arc(x, y, particle.size, 0, 2 * Math.PI);
      this.ctx.fill();
      this.ctx.restore();

      // Particle glow
      this.ctx.save();
      this.ctx.globalAlpha = (1 - progress) * 0.3;
      this.ctx.fillStyle = particle.color;
      this.ctx.beginPath();
      this.ctx.arc(x, y, particle.size * 2, 0, 2 * Math.PI);
      this.ctx.fill();
      this.ctx.restore();
    }
  }

  private getNodeStatusColor(status: string): string {
    switch (status) {
      case 'online': return '#00ff88';
      case 'connecting': return 'var(--g-primary)';
      case 'offline': return '#ff4444';
      default: return '#888888';
    }
  }

  private getAgentStatusColor(status: string): string {
    switch (status) {
      case 'starting': return 'var(--g-primary)';
      case 'working': return '#0088ff';
      case 'blocked': return '#ff4444';
      case 'finishing': return '#00ff88';
      case 'completed': return '#888888';
      default: return '#666666';
    }
  }

  public setCanvas(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.width = canvas.width;
    this.height = canvas.height;
    this.centerX = this.width / 2;
    this.centerY = this.height / 2;
    this.isAnimating = true;
  }

  public destroy(): void {
    this.isAnimating = false;
    this.animationLoop?.cancel();
    this.animationLoop = null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Component State
// ══════════════════════════════════════════════════════════════════════════════

const meshStates = new WeakMap<Element, FederationMeshState>();

function getMeshState(element: Element): FederationMeshState {
  let state = meshStates.get(element);
  if (!state) {
    state = new FederationMeshState();
    meshStates.set(element, state);
    
    // Cleanup on disconnect
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.removedNodes.forEach((node) => {
          if (node === element) {
            state!.destroy();
            meshStates.delete(element);
            observer.disconnect();
          }
        });
      });
    });
    
    if (element.parentNode) {
      observer.observe(element.parentNode, { childList: true });
    }
  }
  return state;
}

// ══════════════════════════════════════════════════════════════════════════════
// WebSocket Event Handlers
// ══════════════════════════════════════════════════════════════════════════════

function setupFederationEventListeners(
  client: GatewayBrowserClient | null,
  meshState: FederationMeshState
): (() => void) | null {
  if (!client) return null;

  const unsubscribe = client.subscribe((evt) => {
    if (evt.event === 'federation.event' && evt.payload) {
      const federationEvent = (evt.payload as any).event;
      if (!federationEvent) return;

      handleFederationEvent(federationEvent, meshState);
    }
  });

  return unsubscribe;
}

function handleFederationEvent(event: any, meshState: FederationMeshState): void {
  console.log('🌐 Federation Event:', event.type, event);

  switch (event.type) {
    case 'session.spawned':
      if (event.payload && typeof event.payload === 'object') {
        const agent: MeshAgent = {
          sessionKey: event.payload.sessionKey || 'unknown',
          agentId: event.payload.agentId || 'unknown',
          label: event.payload.label || 'Unknown Agent',
          status: 'starting',
          progress: 0,
          nodeId: event.payload.nodeId || event.sourceNodeId,
          x: 0, // Will be positioned by addAgent
          y: 0,
          spawnedAt: event.timestamp || Date.now(),
          lastActivity: Date.now(),
        };
        meshState.addAgent(agent);
      }
      break;

    case 'session.completed':
      if (event.payload?.sessionKey) {
        meshState.removeAgent(event.payload.sessionKey);
      }
      break;

    case 'session.progress':
      if (event.payload?.sessionKey) {
        meshState.updateAgent(event.payload.sessionKey, {
          status: event.payload.status || 'working',
          progress: event.payload.progress || 0,
        });
      }
      break;

    case 'session.message':
      if (event.payload?.from && event.payload?.to && event.payload.to !== 'broadcast') {
        meshState.createMessage(
          event.payload.from,
          event.payload.to,
          event.payload.type || 'message'
        );
      }
      break;

    case 'node.connected':
      if (event.payload?.nodeId && event.payload?.name) {
        meshState.addNode(event.payload.nodeId, event.payload.name);
      }
      break;

    case 'node.disconnected':
      if (event.payload?.nodeId) {
        meshState.removeNode(event.payload.nodeId);
      }
      break;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Main Render Function
// ══════════════════════════════════════════════════════════════════════════════

export function renderFederationMesh(props: FederationMeshProps): TemplateResult {
  return html`
    <div class="federation-mesh">
      ${renderStyles()}
      
      <!-- Header -->
      <div class="mesh-header">
        <h2>🌐 Federation Mesh Network</h2>
        <div class="mesh-stats">
          <span class="mesh-stat">
            <span class="mesh-stat-value">${props.federationState.nodes.length}</span>
            <span class="mesh-stat-label">Nodes</span>
          </span>
          <span class="mesh-stat">
            <span class="mesh-stat-value">${props.federationState.nodes.filter(n => n.status === 'online').length}</span>
            <span class="mesh-stat-label">Online</span>
          </span>
        </div>
      </div>

      <!-- Mesh Canvas -->
      <div class="mesh-container">
        <canvas 
          class="mesh-canvas"
          width="800"
          height="600"
          @ref=${(el: HTMLCanvasElement) => {
            const meshState = getMeshState(el.parentElement!);
            meshState.setCanvas(el);
            meshState.updateFromFederationState(props.federationState);
            
            // Setup event listeners
            setupFederationEventListeners(props.client, meshState);
          }}
        ></canvas>
        
        <!-- Controls Overlay -->
        <div class="mesh-controls">
          <button class="mesh-btn mesh-btn--secondary" @click=${() => window.location.reload()}>
            🔄 Refresh
          </button>
        </div>
      </div>

      <!-- Legend -->
      <div class="mesh-legend">
        <div class="legend-section">
          <h3>Nodes</h3>
          <div class="legend-item">
            <div class="legend-icon master-node"></div>
            <span>Master Node</span>
          </div>
          <div class="legend-item">
            <div class="legend-icon satellite-node"></div>
            <span>Satellite Node</span>
          </div>
        </div>
        
        <div class="legend-section">
          <h3>Agents</h3>
          <div class="legend-item">
            <div class="legend-icon starting-agent"></div>
            <span>Starting</span>
          </div>
          <div class="legend-item">
            <div class="legend-icon working-agent"></div>
            <span>Working</span>
          </div>
          <div class="legend-item">
            <div class="legend-icon completing-agent"></div>
            <span>Completing</span>
          </div>
        </div>
        
        <div class="legend-section">
          <h3>Animations</h3>
          <div class="legend-item">
            <div class="legend-icon spawn-particle"></div>
            <span>Agent Spawn</span>
          </div>
          <div class="legend-item">
            <div class="legend-icon message-particle"></div>
            <span>Message Flow</span>
          </div>
          <div class="legend-item">
            <div class="legend-icon connection-line"></div>
            <span>Node Link</span>
          </div>
        </div>
      </div>

      <!-- Debug Info (Development) -->
      ${process.env.NODE_ENV === 'development' ? html`
        <details class="mesh-debug">
          <summary>Debug Info</summary>
          <div class="debug-content">
            <pre>${JSON.stringify({
              nodes: props.federationState.nodes.length,
              mode: props.federationState.mode,
              status: props.federationState.connectionStatus,
            }, null, 2)}</pre>
          </div>
        </details>
      ` : nothing}
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Styles
// ══════════════════════════════════════════════════════════════════════════════

function renderStyles(): TemplateResult {
  return html`
    <style>
      .federation-mesh {
        padding: 24px;
        color: #e4e4e7;
        background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%);
        min-height: 100vh;
      }

      .mesh-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 24px;
        padding-bottom: 16px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      }

      .mesh-header h2 {
        margin: 0;
        font-size: 24px;
        font-weight: 700;
        background: linear-gradient(135deg, #00ffff, #0088ff);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
      }

      .mesh-stats {
        display: flex;
        gap: 24px;
      }

      .mesh-stat {
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 8px 16px;
        background: rgba(0, 0, 0, 0.3);
        border-radius: 8px;
        border: 1px solid rgba(0, 255, 255, 0.2);
      }

      .mesh-stat-value {
        font-size: 18px;
        font-weight: 700;
        color: #00ffff;
      }

      .mesh-stat-label {
        font-size: 12px;
        color: #a1a1aa;
        margin-top: 2px;
      }

      .mesh-container {
        position: relative;
        display: flex;
        justify-content: center;
        margin-bottom: 24px;
      }

      .mesh-canvas {
        background: radial-gradient(circle at center, #0f172a 0%, #030712 100%);
        border: 2px solid rgba(0, 255, 255, 0.2);
        border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
      }

      .mesh-controls {
        position: absolute;
        top: 16px;
        right: 16px;
        display: flex;
        gap: 8px;
      }

      .mesh-btn {
        padding: 8px 16px;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s ease;
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }

      .mesh-btn--secondary {
        background: rgba(0, 0, 0, 0.5);
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: #e4e4e7;
      }

      .mesh-btn--secondary:hover {
        background: rgba(255, 255, 255, 0.1);
        border-color: rgba(255, 255, 255, 0.3);
      }

      .mesh-legend {
        display: flex;
        gap: 32px;
        justify-content: center;
        padding: 24px;
        background: rgba(0, 0, 0, 0.2);
        border-radius: 12px;
        border: 1px solid rgba(255, 255, 255, 0.1);
      }

      .legend-section h3 {
        margin: 0 0 12px 0;
        font-size: 16px;
        font-weight: 600;
        color: #00ffff;
      }

      .legend-item {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
        font-size: 14px;
        color: #a1a1aa;
      }

      .legend-icon {
        width: 16px;
        height: 16px;
        border-radius: 50%;
        border: 2px solid currentColor;
      }

      .master-node {
        background: #1e293b;
        border-color: var(--g-primary);
        position: relative;
      }

      .master-node::after {
        content: '👑';
        position: absolute;
        top: -2px;
        left: 50%;
        transform: translateX(-50%);
        font-size: 10px;
      }

      .satellite-node {
        background: #1e293b;
        border-color: #00ffff;
        position: relative;
      }

      .satellite-node::after {
        content: '🛰️';
        position: absolute;
        top: -2px;
        left: 50%;
        transform: translateX(-50%);
        font-size: 8px;
      }

      .starting-agent {
        background: var(--g-primary);
        border-color: var(--g-primary);
        box-shadow: 0 0 8px color-mix(in srgb, var(--g-primary) 50%, transparent);
      }

      .working-agent {
        background: #0088ff;
        border-color: #0088ff;
        animation: pulse 2s infinite;
      }

      .completing-agent {
        background: #00ff88;
        border-color: #00ff88;
      }

      .spawn-particle {
        background: #00ff88;
        border-color: #00ff88;
        box-shadow: 0 0 12px rgba(0, 255, 136, 0.8);
      }

      .message-particle {
        background: #0088ff;
        border-color: #0088ff;
        animation: flow 1s infinite linear;
      }

      .connection-line {
        width: 24px;
        height: 2px;
        border-radius: 1px;
        background: linear-gradient(90deg, #00ffff, transparent);
        border: none;
        animation: dash 2s infinite linear;
      }

      .mesh-debug {
        margin-top: 24px;
        padding: 16px;
        background: rgba(0, 0, 0, 0.5);
        border-radius: 8px;
        border: 1px solid rgba(255, 255, 255, 0.1);
      }

      .mesh-debug summary {
        cursor: pointer;
        font-weight: 600;
        color: #a1a1aa;
      }

      .debug-content {
        margin-top: 12px;
        color: #71717a;
        font-family: monospace;
        font-size: 12px;
        overflow-x: auto;
      }

      @keyframes pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.7; transform: scale(1.1); }
      }

      @keyframes flow {
        0% { transform: translateX(-5px); }
        100% { transform: translateX(5px); }
      }

      @keyframes dash {
        0% { background-position: 0 0; }
        100% { background-position: 20px 0; }
      }

      /* Responsive */
      @media (max-width: 1024px) {
        .mesh-canvas {
          width: 100%;
          max-width: 600px;
        }
        
        .mesh-legend {
          flex-direction: column;
          gap: 16px;
        }
      }

      @media (max-width: 768px) {
        .federation-mesh {
          padding: 16px;
        }
        
        .mesh-header {
          flex-direction: column;
          gap: 16px;
          text-align: center;
        }
        
        .mesh-canvas {
          max-width: 100%;
          height: 400px;
        }
      }
    </style>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Export Utilities
// ══════════════════════════════════════════════════════════════════════════════

export { FederationMeshState, handleFederationEvent, setupFederationEventListeners };
