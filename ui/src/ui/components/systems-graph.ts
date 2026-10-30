/**
 * SystemsGraph — Interactive Ecosystem Graph for Systems Intelligence
 * 
 * Force-directed graph visualization using D3.js v7
 * Features:
 * - Draggable nodes with position persistence
 * - Zoom and pan
 * - Node styling by type (business, project, person, asset, revenue_stream)
 * - Edge styling by relationship type
 * - Hover tooltips and click interactions
 * - Highlighting connected nodes/edges on selection
 */

// ============================================================
// Types
// ============================================================

export type SystemNodeType = "business" | "project" | "person" | "asset" | "revenue_stream" | "task" | "goal" | "priority" | "value" | "note" | "income";

export type RelationshipType = "feeds" | "depends_on" | "synergy" | "resource_flow" | "attention_flow" | "contains" | "supports" | "enables" | "implements" | "references";

/**
 * Shapes a node can be drawn as. `card` and `pill` are additive; every existing
 * caller keeps the shape its `type` already mapped to.
 */
export type SystemNodeShape = "hexagon" | "roundedRect" | "circle" | "diamond" | "card" | "pill";

export interface SystemNode {
  id: string;
  name: string;
  type: SystemNodeType;
  description?: string;
  metadata?: Record<string, unknown>;
  // Position (saved when dragged)
  x?: number;
  y?: number;
  fx?: number | null; // Fixed position for D3
  fy?: number | null;

  // ── Optional presentation overrides ────────────────────────
  // All optional: a node that sets none of these renders exactly as its `type`
  // always did. They exist so a caller can encode data (revenue, utilisation,
  // health) in size and colour instead of only entity type.
  /** Fill colour. Any CSS colour, including `var(--g-*)` / `color-mix()`. */
  color?: string;
  /** Stroke colour of the shape outline. */
  accent?: string;
  /** Radius-equivalent. Shapes derive their geometry from this. */
  size?: number;
  shape?: SystemNodeShape;
  /** Short text drawn inside the shape (1–3 chars, or a % for a card). */
  glyph?: string;
  /** Label text; defaults to `name`. */
  label?: string;
  /** Second, dimmer line under the label. */
  sublabel?: string;
  /** Where the label sits relative to the shape. Default `below`. */
  labelPlacement?: "below" | "right" | "none";
  /** Per-node truncation budget for the label. */
  labelMaxChars?: number;
}

export interface Relationship {
  id: string;
  source: string; // Node ID
  target: string; // Node ID
  type: RelationshipType;
  label?: string;
  weight?: number;
  // ── Optional presentation overrides ────────────────────────
  color?: string;
  width?: number;
  dash?: string;
  /**
   * `elbow` draws an orthogonal connector (the readable org-chart form);
   * `arc` a gentle quadratic curve. Default `straight` — what edges always were.
   */
  curve?: "straight" | "elbow" | "arc";
  opacity?: number;
}

/** A labelled backdrop drawn behind the graph, used to group a band of nodes. */
export interface GraphRegion {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Fill of the backdrop. Default: a barely-there plate. */
  tone?: string;
  /** Border colour. */
  border?: string;
  /** Colour of the region caption. */
  labelColor?: string;
}

export interface SystemsGraphConfig {
  containerId: string;
  nodes: SystemNode[];
  relationships: Relationship[];
  onNodeClick?: (node: SystemNode) => void;
  onNodeDrag?: (node: SystemNode) => void;
  width?: number;
  height?: number;
  /** Labelled backdrops drawn behind the edges. */
  regions?: GraphRegion[];
  /** SVG plate colour. Default `#0a0a0a`. */
  background?: string;
  /**
   * Skip the force simulation entirely and honour the caller's coordinates.
   * The viewBox is then left fixed so the whole layout always scales into the
   * container instead of being clipped when it resizes.
   */
  staticLayout?: boolean;
  /** Default label truncation budget. */
  labelMaxChars?: number;
}

// ============================================================
// Node Shape Definitions
// ============================================================

const NODE_STYLES: Record<SystemNodeType, {
  color: string;
  shape: SystemNodeShape;
  size: number;
  glow: string;
}> = {
  business: { color: "var(--g-primary)", shape: "hexagon", size: 40, glow: "color-mix(in srgb, var(--g-primary) 40%, transparent)" },
  project: { color: "#22C55E", shape: "roundedRect", size: 35, glow: "rgba(34, 197, 94, 0.4)" },
  person: { color: "#22C55E", shape: "circle", size: 30, glow: "rgba(34, 197, 94, 0.4)" },
  asset: { color: "#8B5CF6", shape: "diamond", size: 32, glow: "rgba(139, 92, 246, 0.4)" },
  revenue_stream: { color: "#10B981", shape: "circle", size: 28, glow: "rgba(16, 185, 129, 0.4)" },
  // Systems map aggregate types
  task: { color: "#3B82F6", shape: "circle", size: 20, glow: "rgba(59, 130, 246, 0.4)" },
  goal: { color: "#F59E0B", shape: "hexagon", size: 38, glow: "rgba(245, 158, 11, 0.4)" },
  priority: { color: "var(--g-primary)", shape: "diamond", size: 32, glow: "color-mix(in srgb, var(--g-primary) 40%, transparent)" },
  value: { color: "#6366F1", shape: "hexagon", size: 45, glow: "rgba(99, 102, 241, 0.4)" },
  note: { color: "#A855F7", shape: "circle", size: 18, glow: "rgba(168, 85, 247, 0.4)" },
  income: { color: "#F59E0B", shape: "diamond", size: 28, glow: "rgba(245, 158, 11, 0.4)" },
};

const EDGE_STYLES: Record<RelationshipType, {
  strokeDasharray: string;
  strokeWidth: number;
  markerStart: boolean;
  markerEnd: boolean;
  color: string;
}> = {
  feeds: { strokeDasharray: "none", strokeWidth: 2, markerStart: false, markerEnd: true, color: "#6b7280" },
  depends_on: { strokeDasharray: "6,4", strokeWidth: 2, markerStart: false, markerEnd: true, color: "#9ca3af" },
  synergy: { strokeDasharray: "none", strokeWidth: 2, markerStart: true, markerEnd: true, color: "var(--g-primary)" },
  resource_flow: { strokeDasharray: "none", strokeWidth: 4, markerStart: false, markerEnd: true, color: "#60a5fa" },
  attention_flow: { strokeDasharray: "2,4", strokeWidth: 2, markerStart: false, markerEnd: true, color: "#a78bfa" },
  // Systems map aggregate relationship types
  contains: { strokeDasharray: "none", strokeWidth: 1, markerStart: false, markerEnd: false, color: "#4b5563" },
  supports: { strokeDasharray: "none", strokeWidth: 2, markerStart: false, markerEnd: true, color: "var(--g-primary)" },
  enables: { strokeDasharray: "none", strokeWidth: 2, markerStart: false, markerEnd: true, color: "#22C55E" },
  implements: { strokeDasharray: "4,2", strokeWidth: 2, markerStart: false, markerEnd: true, color: "#3B82F6" },
  references: { strokeDasharray: "2,2", strokeWidth: 1, markerStart: false, markerEnd: false, color: "#9ca3af" },
};

// ============================================================
// D3
// ============================================================

/*
 * This module used to read a global `d3` supplied by a <script> tag pointing at
 * d3js.org. That CDN tag was removed (it blocked first paint on a third-party
 * round-trip and broke the app offline), which left this file — and only this
 * file — reading a global that no longer exists, so the Agency Topology graph
 * silently failed to render. Import the bundled package like the other D3
 * consumers do; Vite puts it in the shared d3-vendor chunk, so this adds no
 * additional download for a session that opens any graph surface.
 */
import * as d3Namespace from "d3";

const d3: any = d3Namespace;

// ============================================================
// SVG Path Generators
// ============================================================

function hexagonPath(cx: number, cy: number, size: number): string {
  const points: [number, number][] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i - Math.PI / 2;
    points.push([cx + size * Math.cos(angle), cy + size * Math.sin(angle)]);
  }
  return `M ${points.map(p => p.join(",")).join(" L ")} Z`;
}

function diamondPath(cx: number, cy: number, size: number): string {
  const s = size * 1.2;
  return `M ${cx},${cy - s} L ${cx + s},${cy} L ${cx},${cy + s} L ${cx - s},${cy} Z`;
}

function roundedRectPath(cx: number, cy: number, width: number, height: number, radius: number): string {
  const x = cx - width / 2;
  const y = cy - height / 2;
  return `
    M ${x + radius},${y}
    h ${width - 2 * radius}
    a ${radius},${radius} 0 0 1 ${radius},${radius}
    v ${height - 2 * radius}
    a ${radius},${radius} 0 0 1 ${-radius},${radius}
    h ${-(width - 2 * radius)}
    a ${radius},${radius} 0 0 1 ${-radius},${-radius}
    v ${-(height - 2 * radius)}
    a ${radius},${radius} 0 0 1 ${radius},${-radius}
    Z
  `;
}

function truncate(value: string, max: number): string {
  const text = value ?? "";
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

/**
 * Edge geometry. `elbow` is the org-chart connector — out of the parent, across
 * a shared spine, into the child — which is what makes a reporting line
 * traceable at a glance instead of one straight ray in a fan of straight rays.
 */
function edgePath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  curve: Relationship["curve"],
): string {
  if (curve === "elbow") {
    const mid = x1 + (x2 - x1) * 0.42;
    return `M ${x1},${y1} H ${mid} V ${y2} H ${x2}`;
  }
  if (curve === "arc") {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const bend = Math.hypot(dx, dy) * 0.16;
    return `M ${x1},${y1} Q ${(x1 + x2) / 2 + dy * 0.001 * bend},${(y1 + y2) / 2 - bend} ${x2},${y2}`;
  }
  return `M ${x1},${y1} L ${x2},${y2}`;
}

// ============================================================
// SystemsGraph Class
// ============================================================

export class SystemsGraph {
  private container: HTMLElement;
  private svg: any;
  private g: any; // Main group for zoom/pan
  private simulation: any;
  private nodes: SystemNode[];
  private relationships: Relationship[];
  private onNodeClick?: (node: SystemNode) => void;
  private onNodeDrag?: (node: SystemNode) => void;
  private width: number;
  private height: number;
  private selectedNodeId: string | null = null;
  private tooltip: HTMLElement | null = null;
  private zoom: any;
  private resizeObserver: ResizeObserver | null = null;
  private regions: GraphRegion[];
  private background: string;
  private staticLayout: boolean;
  private labelMaxChars: number;
  /** When set, nodes outside the set are dimmed (search / focus preview). */
  private emphasis: Set<string> | null = null;

  constructor(config: SystemsGraphConfig) {
    const container = document.getElementById(config.containerId);
    if (!container) {
      throw new Error(`Container #${config.containerId} not found`);
    }
    this.container = container;
    this.nodes = config.nodes.map(n => ({ ...n }));
    this.relationships = config.relationships.map(r => ({ ...r }));
    this.onNodeClick = config.onNodeClick;
    this.onNodeDrag = config.onNodeDrag;
    this.width = config.width || container.clientWidth || 800;
    this.height = config.height || container.clientHeight || 600;
    this.regions = (config.regions ?? []).map(r => ({ ...r }));
    this.background = config.background ?? "#0a0a0a";
    this.staticLayout = config.staticLayout === true;
    this.labelMaxChars = config.labelMaxChars ?? 15;
  }

  /** Merges a node's optional overrides over the defaults for its type. */
  private styleFor(node: SystemNode): {
    color: string;
    shape: SystemNodeShape;
    size: number;
    glow: string;
    stroke: string;
  } {
    const base = NODE_STYLES[node.type] ?? NODE_STYLES.note;
    return {
      color: node.color ?? base.color,
      shape: node.shape ?? base.shape,
      size: node.size ?? base.size,
      glow: base.glow,
      stroke: node.accent ?? "#1f2937",
    };
  }

  render(): void {
    if (typeof d3 === "undefined") {
      console.error("D3.js not loaded! Add <script src=\"https://d3js.org/d3.v7.min.js\"></script> to index.html");
      return;
    }

    // Clear container
    this.container.innerHTML = "";

    // Create tooltip
    this.createTooltip();

    // Create SVG with touch support
    this.svg = d3.select(this.container)
      .append("svg")
      .attr("width", "100%")
      .attr("height", "100%")
      .attr("viewBox", `0 0 ${this.width} ${this.height}`)
      .attr("preserveAspectRatio", "xMidYMid meet")
      .style("background", this.background)
      .style("cursor", "grab")
      .style("touch-action", "none")
      .style("-webkit-user-select", "none")
      .style("user-select", "none");

    // Create defs for markers, filters, gradients
    this.createDefs();

    // Create main group for zoom/pan
    this.g = this.svg.append("g").attr("class", "graph-main");

    // Setup zoom with touch support
    this.zoom = d3.zoom()
      .scaleExtent([0.1, 4])
      .filter((event: any) => {
        // Allow all touch events + mouse events (but not secondary click)
        return !event.ctrlKey && !event.button;
      })
      .touchable(() => true) // Ensure touch is enabled
      .on("zoom", (event: any) => {
        this.g.attr("transform", event.transform);
      });
    this.svg.call(this.zoom);

    // Double-click on background to reset zoom
    this.svg.on("dblclick.zoom", null);
    this.svg.on("dblclick", () => {
      this.svg.transition()
        .duration(750)
        .call(this.zoom.transform, d3.zoomIdentity);
    });

    // Create force simulation
    this.createSimulation();

    // Render regions (backdrop), then edges and nodes
    this.renderRegions();
    this.renderEdges();
    this.renderNodes();

    if (this.staticLayout) {
      // No simulation means no tick; place everything once from the caller's
      // coordinates. The viewBox is deliberately left fixed so the layout
      // scales into the container rather than being cropped by it.
      this.tick();
    } else {
      this.setupResizeObserver();
    }
  }

  private renderRegions(): void {
    if (!this.regions.length) return;
    const group = this.g.append("g").attr("class", "regions").style("pointer-events", "none");
    const entries = group.selectAll("g").data(this.regions).enter().append("g");
    entries
      .append("rect")
      .attr("x", (d: GraphRegion) => d.x)
      .attr("y", (d: GraphRegion) => d.y)
      .attr("width", (d: GraphRegion) => Math.max(0, d.width))
      .attr("height", (d: GraphRegion) => Math.max(0, d.height))
      .attr("rx", 8)
      .attr("fill", (d: GraphRegion) => d.tone ?? "rgba(255,255,255,0.014)")
      .attr("stroke", (d: GraphRegion) => d.border ?? "rgba(255,255,255,0.10)")
      .attr("stroke-width", 1)
      .attr("stroke-dasharray", "3,5");
    entries
      .append("text")
      .attr("x", (d: GraphRegion) => d.x + 12)
      .attr("y", (d: GraphRegion) => d.y + 17)
      .attr("fill", (d: GraphRegion) => d.labelColor ?? "rgba(255,255,255,0.42)")
      .attr("font-size", "10px")
      .attr("font-weight", "600")
      .attr("letter-spacing", "0.16em")
      .attr("font-family", "ui-monospace, SFMono-Regular, monospace")
      .text((d: GraphRegion) => d.label.toUpperCase());
  }

  private createTooltip(): void {
    this.tooltip = document.createElement("div");
    this.tooltip.className = "systems-graph-tooltip";
    this.tooltip.style.cssText = `
      position: absolute;
      padding: 8px 12px;
      background: rgba(10, 10, 10, 0.95);
      border: 1px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
      border-radius: 6px;
      color: #e5e7eb;
      font-size: 13px;
      font-family: system-ui, -apple-system, sans-serif;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.15s ease;
      z-index: 1000;
      max-width: 250px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
    `;
    this.container.style.position = "relative";
    this.container.appendChild(this.tooltip);
  }

  private showTooltip(node: SystemNode, event: MouseEvent): void {
    if (!this.tooltip) return;
    const style = this.styleFor(node);
    this.tooltip.innerHTML = `
      <div style="font-weight: 600; color: ${style.color}; margin-bottom: 4px;">${node.name}</div>
      <div style="font-size: 11px; color: #9ca3af; text-transform: capitalize;">${node.type.replace("_", " ")}</div>
      ${node.description ? `<div style="margin-top: 6px; font-size: 12px; color: #d1d5db;">${node.description}</div>` : ""}
    `;
    
    const rect = this.container.getBoundingClientRect();
    const x = event.clientX - rect.left + 15;
    const y = event.clientY - rect.top - 10;
    
    this.tooltip.style.left = `${x}px`;
    this.tooltip.style.top = `${y}px`;
    this.tooltip.style.opacity = "1";
  }

  private hideTooltip(): void {
    if (this.tooltip) {
      this.tooltip.style.opacity = "0";
    }
  }

  private createDefs(): void {
    const defs = this.svg.append("defs");

    // Create arrow markers for each edge type
    Object.entries(EDGE_STYLES).forEach(([type, style]) => {
      // End marker (arrow pointing to target)
      defs.append("marker")
        .attr("id", `arrow-${type}`)
        .attr("viewBox", "0 -5 10 10")
        .attr("refX", 20)
        .attr("refY", 0)
        .attr("markerWidth", 6)
        .attr("markerHeight", 6)
        .attr("orient", "auto")
        .append("path")
        .attr("d", "M0,-5L10,0L0,5")
        .attr("fill", style.color);

      // Start marker (arrow pointing to source, for synergy)
      defs.append("marker")
        .attr("id", `arrow-start-${type}`)
        .attr("viewBox", "0 -5 10 10")
        .attr("refX", -10)
        .attr("refY", 0)
        .attr("markerWidth", 6)
        .attr("markerHeight", 6)
        .attr("orient", "auto-start-reverse")
        .append("path")
        .attr("d", "M10,-5L0,0L10,5")
        .attr("fill", style.color);
    });

    // Glow filter
    const glow = defs.append("filter")
      .attr("id", "glow")
      .attr("x", "-50%")
      .attr("y", "-50%")
      .attr("width", "200%")
      .attr("height", "200%");
    
    glow.append("feGaussianBlur")
      .attr("stdDeviation", "3")
      .attr("result", "coloredBlur");
    
    const feMerge = glow.append("feMerge");
    feMerge.append("feMergeNode").attr("in", "coloredBlur");
    feMerge.append("feMergeNode").attr("in", "SourceGraphic");

    // Selection ring filter
    const selectionGlow = defs.append("filter")
      .attr("id", "selection-glow")
      .attr("x", "-100%")
      .attr("y", "-100%")
      .attr("width", "300%")
      .attr("height", "300%");
    
    selectionGlow.append("feGaussianBlur")
      .attr("stdDeviation", "4")
      .attr("result", "blur");
    
    selectionGlow.append("feFlood")
      .attr("flood-color", "var(--g-primary)")
      .attr("result", "color");
    
    selectionGlow.append("feComposite")
      .attr("in", "color")
      .attr("in2", "blur")
      .attr("operator", "in")
      .attr("result", "coloredBlur");
    
    const selMerge = selectionGlow.append("feMerge");
    selMerge.append("feMergeNode").attr("in", "coloredBlur");
    selMerge.append("feMergeNode").attr("in", "SourceGraphic");
  }

  private createSimulation(): void {
    // A caller that placed every node itself does not want a physics pass at
    // all — running one only fights the layout and burns frames.
    if (this.staticLayout) return;
    // Build node and link data for D3
    const nodeMap = new Map(this.nodes.map(n => [n.id, n]));
    
    // Convert relationships to D3 link format with object references
    const links = this.relationships.map(r => ({
      ...r,
      source: nodeMap.get(r.source) || r.source,
      target: nodeMap.get(r.target) || r.target,
    })).filter(l => typeof l.source === "object" && typeof l.target === "object");

    // Record which nodes arrived with caller-supplied coordinates BEFORE the
    // simulation runs. d3.forceSimulation() seeds x/y on every node it is
    // given (a phyllotaxis spiral), so checking `node.x !== undefined`
    // afterwards is true for all of them — which pinned every node at its
    // seed position and stopped the layout from ever running.
    const preplaced = new Set(
      this.nodes.filter((node) => node.x !== undefined && node.y !== undefined).map((node) => node.id),
    );

    this.simulation = d3.forceSimulation(this.nodes)
      .force("link", d3.forceLink(links)
        .id((d: any) => d.id)
        .distance(150)
        .strength(0.5))
      .force("charge", d3.forceManyBody().strength(-400))
      .force("center", d3.forceCenter(this.width / 2, this.height / 2))
      .force("collision", d3.forceCollide().radius(50))
      .on("tick", () => this.tick());

    // Only pin the positions the caller actually chose; everything else is
    // free to be laid out by the force simulation.
    for (const node of this.nodes) {
      if (!preplaced.has(node.id)) continue;
      node.fx = node.x;
      node.fy = node.y;
    }
  }

  private renderEdges(): void {
    const linkData = this.relationships.map(r => {
      const source = this.nodes.find(n => n.id === r.source);
      const target = this.nodes.find(n => n.id === r.target);
      return { ...r, sourceNode: source, targetNode: target };
    }).filter(l => l.sourceNode && l.targetNode);

    const edgeGroup = this.g.append("g").attr("class", "edges");

    // Edges are <path>, not <line>, so an edge can be an orthogonal elbow or a
    // curve. A `straight` edge draws the identical two-point geometry it did
    // as a <line>, so existing callers are unaffected.
    edgeGroup.selectAll("path")
      .data(linkData)
      .enter()
      .append("path")
      .attr("class", "edge")
      .attr("data-id", (d: any) => d.id)
      .attr("data-source", (d: any) => d.source)
      .attr("data-target", (d: any) => d.target)
      .attr("fill", "none")
      .attr("stroke", (d: any) => d.color || EDGE_STYLES[d.type as RelationshipType]?.color || "#6b7280")
      .attr("stroke-width", (d: any) => d.width || EDGE_STYLES[d.type as RelationshipType]?.strokeWidth || 2)
      .attr("stroke-linecap", "round")
      .attr("stroke-linejoin", "round")
      .attr("stroke-dasharray", (d: any) => d.dash || EDGE_STYLES[d.type as RelationshipType]?.strokeDasharray || "none")
      .attr("marker-end", (d: any) => {
        const style = EDGE_STYLES[d.type as RelationshipType];
        return style?.markerEnd ? `url(#arrow-${d.type})` : null;
      })
      .attr("marker-start", (d: any) => {
        const style = EDGE_STYLES[d.type as RelationshipType];
        return style?.markerStart ? `url(#arrow-start-${d.type})` : null;
      })
      .style("opacity", (d: any) => d.opacity ?? 0.7)
      .style("transition", "opacity 0.2s ease");
  }

  private renderNodes(): void {
    const nodeGroup = this.g.append("g").attr("class", "nodes");

    const nodeElements = nodeGroup.selectAll("g.node")
      .data(this.nodes)
      .enter()
      .append("g")
      .attr("class", "node")
      .attr("data-id", (d: any) => d.id)
      .style("cursor", "pointer")
      .call(this.drag())
      .on("mouseover", (event: MouseEvent, d: SystemNode) => {
        this.showTooltip(d, event);
        d3.select(event.currentTarget).select(".node-shape")
          .style("filter", "url(#glow)");
      })
      .on("mousemove", (event: MouseEvent, d: SystemNode) => {
        this.showTooltip(d, event);
      })
      .on("mouseout", (event: MouseEvent) => {
        this.hideTooltip();
        if (!this.selectedNodeId || (event.currentTarget as HTMLElement).dataset.id !== this.selectedNodeId) {
          d3.select(event.currentTarget).select(".node-shape")
            .style("filter", null);
        }
      })
      .on("click", (event: MouseEvent, d: SystemNode) => {
        event.stopPropagation();
        this.selectNode(d.id);
        if (this.onNodeClick) {
          this.onNodeClick(d);
        }
      });

    // Add shapes based on node type
    nodeElements.each((d: SystemNode, i: number, nodes: any) => {
      const g = d3.select(nodes[i]);
      const style = this.styleFor(d);

      // Native tooltip so a truncated label is never the only identification.
      g.append("title").text(d.description ? `${d.name} — ${d.description}` : d.name);

      // Selection ring (hidden by default)
      g.append("circle")
        .attr("class", "selection-ring")
        .attr("r", style.size + 8)
        .attr("fill", "none")
        .attr("stroke", "var(--g-primary)")
        .attr("stroke-width", 3)
        .style("opacity", 0)
        .style("filter", "url(#selection-glow)");

      // Draw shape based on type
      if (style.shape === "circle") {
        g.append("circle")
          .attr("class", "node-shape")
          .attr("r", style.size)
          .attr("fill", style.color)
          .attr("stroke", style.stroke)
          .attr("stroke-width", 2);
      } else if (style.shape === "hexagon") {
        g.append("path")
          .attr("class", "node-shape")
          .attr("d", hexagonPath(0, 0, style.size))
          .attr("fill", style.color)
          .attr("stroke", style.stroke)
          .attr("stroke-width", 2);
      } else if (style.shape === "diamond") {
        g.append("path")
          .attr("class", "node-shape")
          .attr("d", diamondPath(0, 0, style.size))
          .attr("fill", style.color)
          .attr("stroke", style.stroke)
          .attr("stroke-width", 2);
      } else if (style.shape === "roundedRect") {
        g.append("path")
          .attr("class", "node-shape")
          .attr("d", roundedRectPath(0, 0, style.size * 2.2, style.size * 1.5, 8))
          .attr("fill", style.color)
          .attr("stroke", style.stroke)
          .attr("stroke-width", 2);
      } else if (style.shape === "card") {
        g.append("path")
          .attr("class", "node-shape")
          .attr("d", roundedRectPath(0, 0, style.size * 3.4, style.size * 1.5, 5))
          .attr("fill", style.color)
          .attr("stroke", style.stroke)
          .attr("stroke-width", 2);
      } else if (style.shape === "pill") {
        g.append("path")
          .attr("class", "node-shape")
          .attr("d", roundedRectPath(0, 0, style.size * 3.6, style.size * 1.4, style.size * 0.7))
          .attr("fill", style.color)
          .attr("stroke", style.stroke)
          .attr("stroke-width", 2);
      }

      // Glyph inside the shape. `revenue_stream` keeps its historical "$" when
      // the caller does not say otherwise.
      const glyph = d.glyph ?? (d.type === "revenue_stream" ? "$" : "");
      if (glyph) {
        g.append("text")
          .attr("class", "node-icon")
          .attr("text-anchor", "middle")
          .attr("dy", "0.35em")
          .attr("fill", "#0a0a0a")
          .attr("font-size", `${Math.max(9, Math.min(18, style.size * 0.75))}px`)
          .attr("font-weight", "bold")
          .attr("font-family", "ui-monospace, SFMono-Regular, monospace")
          .style("pointer-events", "none")
          .text(glyph);
      }

      const placement = d.labelPlacement ?? "below";
      if (placement !== "none") {
        const right = placement === "right";
        const max = d.labelMaxChars ?? this.labelMaxChars;
        const label = g.append("text")
          .attr("class", "node-label")
          .attr("text-anchor", right ? "start" : "middle")
          .attr("x", right ? style.size + 9 : 0)
          .attr("dy", right ? "0.32em" : style.size + 15)
          .attr("fill", "#e8e8ee")
          .attr("font-size", "11.5px")
          .attr("font-weight", "500")
          .attr("font-family", "ui-monospace, SFMono-Regular, monospace")
          .style("pointer-events", "none")
          // A dark halo behind the glyphs: labels stay readable when they pass
          // over an edge or a region backdrop.
          .attr("stroke", "#050505")
          .attr("stroke-width", 3.2)
          .attr("stroke-linejoin", "round")
          .style("paint-order", "stroke fill")
          .text(truncate(d.label ?? d.name, max));
        if (right) label.attr("y", d.sublabel ? -5 : 0);

        if (d.sublabel) {
          g.append("text")
            .attr("class", "node-sublabel")
            .attr("text-anchor", right ? "start" : "middle")
            .attr("x", right ? style.size + 9 : 0)
            .attr("y", right ? 8 : 0)
            .attr("dy", right ? "0.32em" : style.size + 27)
            .attr("fill", "#9aa0aa")
            .attr("font-size", "9.5px")
            .attr("font-family", "ui-monospace, SFMono-Regular, monospace")
            .style("pointer-events", "none")
            .attr("stroke", "#050505")
            .attr("stroke-width", 2.8)
            .attr("stroke-linejoin", "round")
            .style("paint-order", "stroke fill")
            .text(truncate(d.sublabel, max));
        }
      }
    });

    // Deselect when clicking background
    this.svg.on("click", () => {
      this.selectNode(null);
    });
  }

  private drag(): any {
    return d3.drag()
      .on("start", (event: any, d: any) => {
        if (!event.active && this.simulation) this.simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
        this.svg.style("cursor", "grabbing");
      })
      .on("drag", (event: any, d: any) => {
        d.fx = event.x;
        d.fy = event.y;
        if (!this.simulation) {
          d.x = event.x;
          d.y = event.y;
          this.tick();
        }
      })
      .on("end", (event: any, d: any) => {
        if (!event.active && this.simulation) this.simulation.alphaTarget(0);
        // Keep fixed position (save it)
        d.x = d.fx;
        d.y = d.fy;
        this.svg.style("cursor", "grab");
        if (this.onNodeDrag) {
          this.onNodeDrag(d);
        }
      });
  }

  private tick(): void {
    const byId = new Map(this.nodes.map(n => [n.id, n] as const));
    // Update edge geometry
    this.g.selectAll(".edge").attr("d", (d: any) => {
      const source = byId.get(typeof d.source === "object" ? d.source.id : d.source);
      const target = byId.get(typeof d.target === "object" ? d.target.id : d.target);
      if (!source || !target) return "M 0,0";
      let x1 = source.x || 0;
      let x2 = target.x || 0;
      if (d.curve === "elbow") {
        // Leave the parent at its edge and arrive at the child's edge, so the
        // connector never disappears underneath a shape.
        x1 += this.styleFor(source).size * 0.9;
        x2 -= this.styleFor(target).size * 0.9;
      }
      return edgePath(x1, source.y || 0, x2, target.y || 0, d.curve);
    });

    // Update node positions
    this.g.selectAll(".node")
      .attr("transform", (d: any) => `translate(${d.x || 0}, ${d.y || 0})`);
  }

  /**
   * Dims every node outside `ids` without rebuilding the graph — used for
   * search, where the answer is "where is it", not "remove everything else".
   * Pass `null` to clear.
   */
  setEmphasis(ids: Set<string> | null): void {
    this.emphasis = ids && ids.size ? ids : null;
    if (!this.g) return;
    if (this.selectedNodeId) this.selectNode(this.selectedNodeId);
    else this.applyEmphasis();
  }

  private applyEmphasis(): void {
    const emphasis = this.emphasis;
    this.g.selectAll(".node").style("opacity", (d: any) =>
      !emphasis || emphasis.has(d.id) ? 1 : 0.12,
    );
    this.g.selectAll(".edge").style("opacity", (d: any) => {
      const base = d.opacity ?? 0.7;
      if (!emphasis) return base;
      const source = typeof d.source === "object" ? d.source.id : d.source;
      const target = typeof d.target === "object" ? d.target.id : d.target;
      return emphasis.has(source) && emphasis.has(target) ? base : 0.05;
    });
  }

  /** Frames the whole layout (nodes + regions) inside the viewport. */
  zoomToFit(padding = 40): void {
    if (!this.svg || !this.zoom || typeof d3 === "undefined") return;
    const xs: number[] = [];
    const ys: number[] = [];
    for (const node of this.nodes) {
      if (typeof node.x !== "number" || typeof node.y !== "number") continue;
      const size = this.styleFor(node).size;
      xs.push(node.x - size, node.x + size);
      ys.push(node.y - size, node.y + size);
    }
    for (const region of this.regions) {
      xs.push(region.x, region.x + region.width);
      ys.push(region.y, region.y + region.height);
    }
    if (xs.length < 2) return;
    const minX = Math.min(...xs) - padding;
    const maxX = Math.max(...xs) + padding;
    const minY = Math.min(...ys) - padding;
    const maxY = Math.max(...ys) + padding;
    const scale = Math.max(
      0.1,
      Math.min(4, this.width / Math.max(1, maxX - minX), this.height / Math.max(1, maxY - minY)),
    );
    const transform = d3.zoomIdentity
      .translate(this.width / 2 - (scale * (minX + maxX)) / 2, this.height / 2 - (scale * (minY + maxY)) / 2)
      .scale(scale);
    this.svg.transition().duration(400).call(this.zoom.transform, transform);
  }

  selectNode(nodeId: string | null): void {
    this.selectedNodeId = nodeId;

    // Reset all nodes and edges
    this.g.selectAll(".node .selection-ring").style("opacity", 0);
    this.g.selectAll(".node .node-shape").style("filter", null);
    this.g.selectAll(".edge").style("opacity", 0.3);
    this.g.selectAll(".node").style("opacity", 0.5);

    if (nodeId === null) {
      this.applyEmphasis();
      return;
    }

    // Highlight selected node
    const selectedGroup = this.g.select(`.node[data-id="${nodeId}"]`);
    selectedGroup.select(".selection-ring").style("opacity", 1);
    selectedGroup.select(".node-shape").style("filter", "url(#glow)");
    selectedGroup.style("opacity", 1);

    // Find connected nodes
    const connectedNodeIds = new Set<string>([nodeId]);
    this.relationships.forEach(r => {
      if (r.source === nodeId) connectedNodeIds.add(r.target);
      if (r.target === nodeId) connectedNodeIds.add(r.source);
    });

    // Highlight connected nodes
    connectedNodeIds.forEach(id => {
      this.g.select(`.node[data-id="${id}"]`).style("opacity", 1);
    });

    // Highlight connected edges
    this.g.selectAll(".edge")
      .style("opacity", (d: any) => {
        return (d.source === nodeId || d.target === nodeId) ? 1 : 0.15;
      });
  }

  highlightConnections(nodeId: string): void {
    this.selectNode(nodeId);
  }

  centerOn(nodeId: string): void {
    const node = this.nodes.find(n => n.id === nodeId);
    if (!node || node.x === undefined || node.y === undefined) return;

    const transform = d3.zoomIdentity
      .translate(this.width / 2 - node.x, this.height / 2 - node.y);
    
    this.svg.transition()
      .duration(500)
      .call(this.zoom.transform, transform);
    
    this.selectNode(nodeId);
  }

  update(nodes: SystemNode[], relationships: Relationship[]): void {
    // Update data
    this.nodes = nodes.map(n => ({ ...n }));
    this.relationships = relationships.map(r => ({ ...r }));

    // Re-render
    this.render();
  }

  private setupResizeObserver(): void {
    this.resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          this.width = width;
          this.height = height;
          this.svg.attr("viewBox", `0 0 ${width} ${height}`);
          
          // Update center force
          if (this.simulation) {
            this.simulation.force("center", d3.forceCenter(width / 2, height / 2));
            this.simulation.alpha(0.3).restart();
          }
        }
      }
    });
    this.resizeObserver.observe(this.container);
  }

  destroy(): void {
    if (this.simulation) {
      this.simulation.stop();
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    if (this.tooltip && this.tooltip.parentNode) {
      this.tooltip.parentNode.removeChild(this.tooltip);
    }
    this.container.innerHTML = "";
  }
}

// ============================================================
// Mock Data for Testing
// ============================================================

export const MOCK_NODES: SystemNode[] = [
  { id: "kk-studio", name: "KK Studio", type: "business", description: "Main creative agency" },
  { id: "kingly-vault", name: "Kingly Vault", type: "project", description: "Premium membership community" },
  { id: "infinibot", name: "InfiniBot", type: "project", description: "AI Agent Infrastructure" },
  { id: "founder", name: "Founder", type: "person", description: "Founder & Lead" },
  { id: "servers", name: "GPU Servers", type: "asset", description: "RTX 4090 compute cluster" },
  { id: "subscriptions", name: "Subscriptions", type: "revenue_stream", description: "Recurring MRR" },
];

export const MOCK_RELATIONSHIPS: Relationship[] = [
  { id: "r1", source: "kk-studio", target: "kingly-vault", type: "feeds", label: "produces content for" },
  { id: "r2", source: "kingly-vault", target: "subscriptions", type: "resource_flow", label: "generates" },
  { id: "r3", source: "ra-kaiun", target: "kk-studio", type: "attention_flow", label: "leads" },
  { id: "r4", source: "infinibot", target: "kingly-vault", type: "feeds", label: "powers automation" },
  { id: "r5", source: "servers", target: "infinibot", type: "resource_flow", label: "runs on" },
  { id: "r6", source: "kk-studio", target: "infinibot", type: "synergy", label: "develops together" },
  { id: "r7", source: "ra-kaiun", target: "infinibot", type: "attention_flow", label: "builds" },
];

// ============================================================
// Helper: Initialize with Mock Data
// ============================================================

export function createDemoGraph(containerId: string): SystemsGraph {
  const graph = new SystemsGraph({
    containerId,
    nodes: MOCK_NODES,
    relationships: MOCK_RELATIONSHIPS,
    onNodeClick: (node) => {
      console.log("Node clicked:", node);
    },
    onNodeDrag: (node) => {
      console.log("Node dragged to:", { id: node.id, x: node.x, y: node.y });
    },
  });
  graph.render();
  return graph;
}
