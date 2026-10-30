/**
 * <people-network-graph> — the My Network relationship graph.
 *
 * A d3-force SVG graph (not the Knowledge Graph's three.js renderer: this one
 * needs readable edge labels and a pinned "you" node at the centre, and stays
 * small enough — hundreds of people, not thousands — for SVG):
 *
 *   • the owner ("me") pinned at the centre with a gold halo
 *   • contacts sized by value (relationship $ + open pipeline $), coloured by
 *     contact type, with a gold client ring and an open-opportunity badge
 *   • edges weighted by strength 1-5, labelled "value · strength", dashed when
 *     dormant / strained / ended; stale contacts get a dashed outline
 *   • a highlighted warm path, click-to-select nodes and edges, drag, zoom/pan
 *   • RING layout (default): concentric labelled warm-score bands around you —
 *     Inner circle / Active / Warm-able / Dormant — with a radial "magnet" that
 *     pulls each person toward the centre in proportion to their warm score,
 *     so warmer people visibly cluster close. `layout="free"` restores the
 *     plain force layout. Each node carries a gold warm-score arc.
 *   • optional satellites: linked projects / notes / tasks… as small nodes
 *     tethered to the people they are linked to
 *
 * Events: `node-select` {id}, `edge-select` {id}, `background-click`,
 * `satellite-select` {type, id}.
 */

import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceRadial,
  forceSimulation,
  select,
  zoom,
  zoomIdentity,
  drag,
  type BaseType,
  type Selection,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
  type ZoomBehavior,
} from "d3";
import { fmtMoney, ME_ID, typeColor, type NetworkEdge, type NetworkNode } from "../controllers/people-network";

interface GNode extends SimulationNodeDatum {
  id: string;
  r: number;
  data: NetworkNode | null;
  /** Set on satellite nodes (linked workspace objects). */
  sat?: GraphSatellite;
}
interface GLink extends SimulationLinkDatum<GNode> {
  id: string;
  data: NetworkEdge;
  /** Tether from a satellite to its person (no label, no click). */
  tether?: boolean;
}

/** A linked object drawn as a small satellite of the people it is linked to. */
export interface GraphSatellite {
  /** `${type}:${id}` */
  key: string;
  type: string;
  id: string;
  label: string;
  ownerIds: string[];
}

/** Warm bands, outermost boundary last (kept in sync with src/network/warm.ts). */
export const RING_BANDS = [
  { id: "inner", label: "Inner circle", min: 70 },
  { id: "active", label: "Active", min: 45 },
  { id: "warmable", label: "Warm-able", min: 20 },
  { id: "dormant", label: "Dormant", min: 0 },
] as const;

/** Distance from you for a warm score: 100 → hugging you, 0 → the outer ring. */
export function ringRadius(score: number, k = 1): number {
  const s = Math.max(0, Math.min(100, Number.isFinite(score) ? score : 0));
  return (95 + (100 - s) * 2.7) * k;
}

const SAT_R = 8;
const SAT_GLYPH: Record<string, string> = {
  project: "P",
  task: "T",
  note: "N",
  document: "D",
  file: "F",
  idea: "I",
  goal: "G",
  report: "R",
  client: "C",
  event: "E",
};

const ME_R = 30;

export function nodeRadius(n: Pick<NetworkNode, "relationshipValue" | "pipelineValue">): number {
  const v = Math.max(0, (n.relationshipValue || 0) + (n.pipelineValue || 0));
  return 13 + Math.min(23, Math.sqrt(v / 1000) * 2.2);
}

const VALUE_SHORT: Record<string, string> = {
  "intro-access": "intros",
  revenue: "revenue",
  expertise: "expertise",
  capital: "capital",
  distribution: "reach",
  talent: "talent",
  partnership: "partner",
  influence: "influence",
  support: "support",
  other: "value",
};

export function edgeLabel(e: Pick<NetworkEdge, "valueTotal" | "values" | "strength">): string {
  const head = e.valueTotal > 0 ? fmtMoney(e.valueTotal) : e.values[0] ? (VALUE_SHORT[e.values[0].valueType] ?? e.values[0].valueType) : "";
  return head ? `${head} · ${e.strength}★` : `${e.strength}★`;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : (parts[0]?.[1] ?? ""))).toUpperCase() || "?";
}

@customElement("people-network-graph")
export class PeopleNetworkGraph extends LitElement {
  @property({ attribute: false }) nodes: NetworkNode[] = [];
  @property({ attribute: false }) edges: NetworkEdge[] = [];
  @property({ type: String }) meLabel = "You";
  @property({ type: String }) selectedId: string | null = null;
  @property({ type: String }) selectedEdgeId: string | null = null;
  @property({ attribute: false }) pathNodeIds: string[] = [];
  @property({ attribute: false }) pathEdgeIds: string[] = [];
  /** Contacts untouched for longer than this many days render dimmed. */
  @property({ type: Number }) staleAfterDays = 30;
  /** "rings" (warm-score bands around you) or "free" (plain force layout). */
  @property({ type: String }) layout: "rings" | "free" = "rings";
  @property({ attribute: false }) satellites: GraphSatellite[] = [];

  static styles = css`
    :host {
      display: block;
      position: relative;
      width: 100%;
      height: 100%;
      min-height: 320px;
      --pn-fg: var(--glass-fg, #f4f1ea);
      --pn-fg-3: var(--glass-fg-3, #8f897c);
      --pn-gold: var(--glass-gold, #d9b45f);
      --pn-gold-hi: var(--glass-gold-hi, #f1d38a);
      --pn-line: var(--glass-stroke-gold, rgba(217, 180, 95, 0.34));
      --pn-bg: var(--glass-1, rgba(255, 255, 255, 0.03));
    }
    svg { width: 100%; height: 100%; display: block; touch-action: none; cursor: grab; user-select: none; }
    svg:active { cursor: grabbing; }
    .edge { stroke: var(--pn-line); fill: none; transition: stroke 160ms, opacity 160ms; }
    .edge.dashed { stroke-dasharray: 5 5; }
    .edge.hit { stroke: transparent; cursor: pointer; }
    .edge.path { stroke: var(--pn-gold-hi); }
    .edge.sel { stroke: var(--pn-gold-hi); }
    .elabel { font: 600 10px/1 var(--font-ui, system-ui, sans-serif); fill: var(--pn-fg); paint-order: stroke; stroke: var(--pn-label-halo, rgba(10, 9, 7, 0.85)); stroke-width: 3px; pointer-events: none; }
    .elabel.muted { fill: var(--pn-fg-3); }
    .node { cursor: pointer; }
    .node circle.body { stroke: rgba(0, 0, 0, 0.35); stroke-width: 1.5; transition: opacity 160ms; }
    /* Stale: keep the colour readable, mark it with a dashed outline + softer fill. */
    .node.stale circle.body { fill-opacity: 0.72; stroke: var(--pn-fg-3); stroke-width: 1.6; stroke-dasharray: 3 3; }
    .node .ring { fill: none; stroke: var(--pn-gold); stroke-width: 2.4; }
    .node .selring { fill: none; stroke: var(--pn-gold-hi); stroke-width: 2.5; stroke-dasharray: 3 3; }
    .node .ini { font: 700 11px/1 var(--font-ui, system-ui, sans-serif); fill: rgba(12, 10, 6, 0.86); text-anchor: middle; dominant-baseline: central; pointer-events: none; }
    .node .name { font: 600 11.5px/1 var(--font-ui, system-ui, sans-serif); fill: var(--pn-fg); text-anchor: middle; paint-order: stroke; stroke: var(--pn-label-halo, rgba(10, 9, 7, 0.85)); stroke-width: 3px; pointer-events: none; }
    .node .badge circle { fill: #e05a4f; stroke: rgba(0, 0, 0, 0.5); stroke-width: 1; }
    .node .badge text { font: 700 9.5px/1 var(--font-ui, system-ui, sans-serif); fill: #fff; text-anchor: middle; dominant-baseline: central; pointer-events: none; }
    .node .cbadge circle { fill: var(--pn-gold); stroke: rgba(0, 0, 0, 0.5); stroke-width: 1; }
    .node .cbadge text { font: 800 8.5px/1 var(--font-ui, system-ui, sans-serif); fill: #1a1408; text-anchor: middle; dominant-baseline: central; pointer-events: none; }
    .me circle.body { fill: url(#pn-me-grad); stroke: var(--pn-gold-hi); stroke-width: 2; }
    .me .halo { fill: var(--pn-gold); opacity: 0.12; }
    .me .ini { fill: #1a1408; font-size: 12px; }
    .ringband { fill: var(--pn-gold); pointer-events: none; }
    .ringline { fill: none; stroke: var(--pn-line); stroke-width: 1; stroke-dasharray: 2 6; pointer-events: none; }
    .ringline.inner { stroke: color-mix(in srgb, var(--pn-gold) 60%, transparent); stroke-dasharray: none; }
    .ringlabel { font: 750 12px/1 var(--font-ui, system-ui, sans-serif); letter-spacing: 0.14em; text-transform: uppercase; fill: var(--pn-gold-hi); text-anchor: middle; paint-order: stroke; stroke: var(--pn-label-halo, rgba(10, 9, 7, 0.9)); stroke-width: 4px; pointer-events: none; }
    .ringlabel.sub { font-size: 10.5px; font-weight: 600; letter-spacing: 0.06em; text-transform: none; fill: var(--pn-fg); opacity: 0.72; }
    .node .warm { fill: none; stroke: var(--pn-gold-hi); stroke-width: 2.6; stroke-linecap: round; transition: stroke-dasharray 500ms ease; }
    .node .warmtrack { fill: none; stroke: rgba(255, 255, 255, 0.08); stroke-width: 2.6; }
    .edge.tether { stroke: var(--pn-fg-3); stroke-width: 1; stroke-dasharray: 2 3; opacity: 0.6; }
    .sat { cursor: pointer; }
    .sat rect { fill: #2a2112; stroke: var(--pn-gold-hi); stroke-width: 1.4; }
    .sat text.g { font: 800 10px/1 var(--font-ui, system-ui, sans-serif); fill: var(--pn-gold-hi); text-anchor: middle; dominant-baseline: central; pointer-events: none; }
    .sat text.l { display: none; font: 600 10px/1 var(--font-ui, system-ui, sans-serif); fill: var(--pn-fg); text-anchor: middle; paint-order: stroke; stroke: var(--pn-label-halo, rgba(10, 9, 7, 0.85)); stroke-width: 3px; pointer-events: none; }
    .sat.named text.l, .sat:hover text.l, .sat:focus text.l { display: block; }
    :host([compact]) .ringlabel { font-size: 14px; }
    :host([compact]) .ringlabel.sub { font-size: 12px; }

    .zoombar { position: absolute; right: 10px; bottom: 10px; display: flex; gap: 6px; }
    .zoombar button {
      width: 34px; height: 34px; border-radius: 10px; border: 1px solid var(--pn-line);
      background: var(--glass-2, rgba(20, 18, 14, 0.72)); color: var(--pn-fg); font: 600 15px/1 system-ui; cursor: pointer;
      backdrop-filter: blur(10px);
    }
    .zoombar button:hover { border-color: var(--pn-gold); }
    :host-context([data-theme="light"]) { --pn-label-halo: rgba(255, 255, 255, 0.9); }
    :host([compact]) .node .name { font-size: 15px; }
    :host([compact]) .elabel { font-size: 13px; }
    :host([compact]) .node .ini { font-size: 13px; }
  `;

  private sim: Simulation<GNode, GLink> | null = null;
  private gNodes = new Map<string, GNode>();
  private svgSel: Selection<SVGSVGElement, unknown, null, undefined> | null = null;
  private zoomer: ZoomBehavior<SVGSVGElement, unknown> | null = null;
  private fitted = false;
  /** Set once the user zooms/pans/drags; until then the view keeps auto-fitting. */
  private userMoved = false;
  /** Narrow container (phones): tighter layout + bigger text. */
  private compact = false;
  private resizeObs: ResizeObserver | null = null;

  render() {
    return html`
      <svg role="img" aria-label="Relationship network graph">
        <defs>
          <radialGradient id="pn-me-grad" cx="38%" cy="32%" r="70%">
            <stop offset="0%" stop-color="#fbe7b0"></stop>
            <stop offset="60%" stop-color="#d9b45f"></stop>
            <stop offset="100%" stop-color="#9c6f27"></stop>
          </radialGradient>
        </defs>
        <g class="viewport"><g class="rings"></g><g class="edges"></g><g class="elabels"></g><g class="nodes"></g></g>
      </svg>
      <div class="zoombar">
        <button title="Zoom in" aria-label="Zoom in" @click=${() => this.zoomBy(1.3)}>+</button>
        <button title="Zoom out" aria-label="Zoom out" @click=${() => this.zoomBy(1 / 1.3)}>−</button>
        <button title="Fit to view" aria-label="Fit to view" @click=${() => { this.userMoved = false; this.fit(true); }}>⤢</button>
      </div>
    `;
  }

  firstUpdated() {
    const svg = this.renderRoot.querySelector("svg") as SVGSVGElement;
    this.svgSel = select(svg);
    this.zoomer = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 4])
      .on("zoom", (ev) => {
        if (ev.sourceEvent) this.userMoved = true;
        this.svgSel!.select("g.viewport").attr("transform", ev.transform.toString());
      });
    this.svgSel.call(this.zoomer).on("dblclick.zoom", null);
    this.svgSel.on("click", (ev: MouseEvent) => {
      if (ev.target === svg) this.dispatchEvent(new CustomEvent("background-click", { bubbles: true, composed: true }));
    });
    this.resizeObs = new ResizeObserver(() => {
      this.scheduleAutoFit();
    });
    this.resizeObs.observe(this);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.sim?.stop();
    this.resizeObs?.disconnect();
  }

  private signature = "";

  /** Content key of what the layout depends on — the view hands in fresh
   *  arrays on every render, so reference changes alone mean nothing. */
  private graphSignature(): string {
    const n = this.nodes
      .map((d) => `${d.id}|${d.name}|${d.contactType}|${d.isClient}|${d.relationshipValue}|${d.pipelineValue}|${d.openOpportunities}|${d.staleDays}|${d.warmScore}`)
      .join(";");
    const e = this.edges
      .map((d) => `${d.id}|${d.from}|${d.to}|${d.strength}|${d.status}|${d.valueTotal}|${d.values.length}|${d.openOpportunities}`)
      .join(";");
    const sats = this.satellites.map((x) => `${x.key}>${x.ownerIds.join(",")}`).join(";");
    return `${this.meLabel}#${this.layout}#${n}#${e}#${sats}`;
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has("nodes") || changed.has("edges") || changed.has("meLabel") || changed.has("layout") || changed.has("satellites")) {
      const sig = this.graphSignature();
      if (sig !== this.signature) {
        this.signature = sig;
        this.rebuild();
        return;
      }
    }
    this.restyle();
  }

  private zoomBy(k: number) {
    if (this.svgSel && this.zoomer) this.svgSel.transition().duration(220).call(this.zoomer.scaleBy, k);
  }

  /** Fit every node into view (keeps "me" roughly centred). */
  private autoFitTimer: ReturnType<typeof setTimeout> | null = null;

  /** Debounced, non-animated fit after layout settles or the box resizes —
   *  an animated fit could land after a newer one and restore stale bounds. */
  private scheduleAutoFit() {
    if (this.userMoved) return;
    if (this.autoFitTimer) clearTimeout(this.autoFitTimer);
    this.autoFitTimer = setTimeout(() => {
      this.autoFitTimer = null;
      if (!this.userMoved) this.fit(false);
    }, 120);
  }

  fit(animate: boolean) {
    if (!this.svgSel || !this.zoomer) return;
    this.svgSel.interrupt();
    const w = this.clientWidth || 600;
    const h = this.clientHeight || 400;
    if (!this.gNodes.size) return;
    // Measure what is actually drawn (nodes, names, badges, edge labels) in
    // graph space — text widths depend on font and zoom-independent styling.
    const nodesG = this.svgSel.select<SVGGElement>("g.nodes").node();
    const labelsG = this.svgSel.select<SVGGElement>("g.elabels").node();
    const ringsG = this.layout === "rings" ? this.svgSel.select<SVGGElement>("g.rings").node() : null;
    if (!nodesG) return;
    const boxes = [nodesG.getBBox(), labelsG?.getBBox(), ringsG?.getBBox()].filter((b): b is DOMRect => Boolean(b && b.width));
    if (!boxes.length) return;
    const pad = this.compact ? 10 : 18;
    const minX = Math.min(...boxes.map((b) => b.x)) - pad;
    const minY = Math.min(...boxes.map((b) => b.y)) - pad;
    const maxX = Math.max(...boxes.map((b) => b.x + b.width)) + pad;
    const maxY = Math.max(...boxes.map((b) => b.y + b.height)) + pad;
    const k = Math.max(0.25, Math.min(1.6, Math.min(w / (maxX - minX), h / (maxY - minY))));
    const t = zoomIdentity.translate(w / 2 - ((minX + maxX) / 2) * k, h / 2 - ((minY + maxY) / 2) * k).scale(k);
    const target = animate ? this.svgSel.transition().duration(300) : this.svgSel;
    (target as Selection<SVGSVGElement, unknown, null, undefined>).call(this.zoomer.transform, t);
    this.fitted = true;
  }

  private rebuild() {
    if (!this.svgSel) return;
    const prev = this.gNodes;
    const next = new Map<string, GNode>();
    const me: GNode = prev.get(ME_ID) ?? { id: ME_ID, r: ME_R, data: null };
    me.fx = 0;
    me.fy = 0;
    next.set(ME_ID, me);
    const n = this.nodes.length || 1;
    this.nodes.forEach((d, i) => {
      const old = prev.get(d.id);
      const a = (i / n) * Math.PI * 2;
      const g: GNode = old ?? { id: d.id, r: 0, data: d, x: Math.cos(a) * 160, y: Math.sin(a) * 160 };
      g.data = d;
      g.r = nodeRadius(d);
      next.set(d.id, g);
    });
    // Satellites: linked objects tethered to each visible person they belong to.
    const tethers: GLink[] = [];
    for (const sat of this.satellites) {
      const owners = sat.ownerIds.filter((o) => next.has(o));
      if (!owners.length) continue;
      const key = `sat:${sat.key}`;
      const old = prev.get(key);
      const o = next.get(owners[0])!;
      const g: GNode = old ?? { id: key, r: SAT_R, data: null, x: (o.x ?? 0) + 20, y: (o.y ?? 0) + 20 };
      g.sat = sat;
      g.r = SAT_R;
      next.set(key, g);
      for (const owner of owners)
        tethers.push({
          id: `t:${sat.key}:${owner}`,
          source: key,
          target: owner,
          tether: true,
          data: { id: "", from: key, to: owner, relationshipType: "", strength: 3, direction: "", status: "Active", values: [], valueTotal: 0, lastTouchDate: "", openOpportunities: 0 },
        });
    }
    this.gNodes = next;
    const links: GLink[] = this.edges
      .filter((e) => next.has(e.from) && next.has(e.to))
      .map((e) => ({ id: e.id, source: e.from, target: e.to, data: e }));
    const allLinks = [...links, ...tethers];
    const meNeighbours = new Set<string>();
    for (const l of links) {
      if (l.data.from === ME_ID) meNeighbours.add(l.data.to);
      if (l.data.to === ME_ID) meNeighbours.add(l.data.from);
    }

    this.sim?.stop();
    this.compact = (this.clientWidth || 800) < 560;
    this.toggleAttribute("compact", this.compact);
    const k = this.compact ? 0.8 : 1;
    const rings = this.layout === "rings";
    const nodes = [...next.values()];
    const warmOf = (d: GNode) => (d.data ? d.data.warmScore ?? 0 : 0);
    this.sim = forceSimulation<GNode, GLink>(nodes)
      .force(
        "link",
        forceLink<GNode, GLink>(allLinks)
          .id((d) => d.id)
          .distance((l) =>
            l.tether
              ? 46 + ((l.target as GNode).r ?? 0)
              : (70 + (6 - l.data.strength) * 26) * k + ((l.source as GNode).r ?? 0) + ((l.target as GNode).r ?? 0),
          )
          // In rings the bands lead; ties still tug but can't drag people out of their band.
          .strength((l) => (l.tether ? 0.9 : (0.25 + l.data.strength * 0.08) * (rings ? 0.06 : 1))),
      )
      .force("charge", forceManyBody<GNode>().strength((d) => (d.sat ? -30 : (-220 - d.r * 6) * k * (rings ? 0.55 : 1))))
      // Room for the name under each node and the badges on its shoulders.
      .force("collide", forceCollide<GNode>().radius((d) => (d.sat ? SAT_R + 16 : d.r + 30)).strength(0.9))
      // Rings: a magnet toward you scaled by warm score; free: direct ties orbit close.
      .force(
        "radial",
        rings
          ? forceRadial<GNode>((d) => (d.id === ME_ID ? 0 : ringRadius(warmOf(d), k)), 0, 0).strength((d) =>
              d.sat ? 0 : 0.55 + (warmOf(d) / 100) * 0.4,
            )
          : forceRadial<GNode>((d) => (d.id === ME_ID ? 0 : meNeighbours.has(d.id) ? 150 * k : 300 * k), 0, 0).strength((d) =>
              d.sat ? 0 : 0.08,
            ),
      )
      .alpha(prev.size ? 0.35 : 1)
      .alphaDecay(0.035)
      .on("tick", () => this.tick())
      .on("end", () => {
        this.placeRingLabels();
        this.scheduleAutoFit();
      });

    const root = this.svgSel.select<SVGGElement>("g.viewport");
    this.drawRings(rings, k);
    // Edges: a visible line + a wide transparent hit line for clicking.
    const edgeG = root
      .select<SVGGElement>("g.edges")
      .selectAll<SVGGElement, GLink>("g.e")
      .data(allLinks, (d) => d.id)
      .join((enter) => {
        const g = enter.append("g").attr("class", "e");
        g.append("line").attr("class", "edge");
        g.append("line").attr("class", "edge hit").attr("stroke-width", 14);
        return g;
      });
    edgeG.classed("tether", (d) => Boolean(d.tether));
    edgeG.select("line.edge:not(.hit)").classed("tether", (d) => Boolean(d.tether));
    edgeG.select("line.hit").attr("display", (d) => (d.tether ? "none" : null));
    edgeG.select<SVGLineElement>("line.hit").on("click", (ev: MouseEvent, d) => {
      ev.stopPropagation();
      this.dispatchEvent(new CustomEvent("edge-select", { detail: { id: d.id }, bubbles: true, composed: true }));
    });
    root
      .select<SVGGElement>("g.elabels")
      .selectAll<SVGTextElement, GLink>("text.elabel")
      .data(links, (d) => d.id)
      .join("text")
      .attr("class", "elabel")
      .attr("text-anchor", "middle")
      .text((d) => edgeLabel(d.data));

    const people = nodes.filter((d) => !d.sat);
    const sats = nodes.filter((d) => d.sat);
    const satG = root
      .select<SVGGElement>("g.nodes")
      .selectAll<SVGGElement, GNode>("g.sat")
      .data(sats, (d) => d.id)
      .join((enter) => {
        const g = enter.append("g").attr("class", "sat");
        g.append("rect").attr("x", -SAT_R).attr("y", -SAT_R).attr("width", SAT_R * 2).attr("height", SAT_R * 2).attr("rx", 3);
        g.append("text").attr("class", "g");
        g.append("text").attr("class", "l").attr("y", SAT_R + 11);
        g.append("title");
        return g;
      });
    satG
      .attr("role", "button")
      .attr("tabindex", 0)
      .attr("aria-label", (d) => `${d.sat!.type}: ${d.sat!.label}`)
      .on("click", (ev: MouseEvent, d) => {
        ev.stopPropagation();
        this.dispatchEvent(new CustomEvent("satellite-select", { detail: { type: d.sat!.type, id: d.sat!.id }, bubbles: true, composed: true }));
      });
    satG.select("text.g").text((d) => SAT_GLYPH[d.sat!.type] ?? d.sat!.type.charAt(0).toUpperCase());
    satG.select("text.l").text((d) => (d.sat!.label.length > 16 ? `${d.sat!.label.slice(0, 15)}…` : d.sat!.label));
    satG.select("title").text((d) => `${d.sat!.type}: ${d.sat!.label}`);
    const nodeG = root
      .select<SVGGElement>("g.nodes")
      .selectAll<SVGGElement, GNode>("g.node")
      .data(people, (d) => d.id)
      .join((enter) => {
        const g = enter.append("g").attr("class", "node");
        g.append("circle").attr("class", "halo");
        g.append("circle").attr("class", "body");
        g.append("circle").attr("class", "warmtrack");
        g.append("circle").attr("class", "warm");
        g.append("circle").attr("class", "ring");
        g.append("circle").attr("class", "selring");
        g.append("text").attr("class", "ini");
        g.append("text").attr("class", "name");
        const b = g.append("g").attr("class", "badge");
        b.append("circle").attr("r", 8.5);
        b.append("text");
        const c = g.append("g").attr("class", "cbadge");
        c.append("circle").attr("r", 7);
        c.append("text").text("C");
        return g;
      });
    nodeG
      .attr("role", "button")
      .attr("tabindex", 0)
      .attr("aria-label", (d) =>
        d.data
          ? `${d.data.name}, ${d.data.contactType}${d.data.isClient ? ", client" : ""}, warm score ${d.data.warmScore ?? 0}, ${d.data.openOpportunities} open opportunities`
          : this.meLabel,
      )
      .on("click", (ev: MouseEvent, d) => {
        ev.stopPropagation();
        this.dispatchEvent(new CustomEvent("node-select", { detail: { id: d.id }, bubbles: true, composed: true }));
      })
      .on("keydown", (ev: KeyboardEvent, d) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          this.dispatchEvent(new CustomEvent("node-select", { detail: { id: d.id }, bubbles: true, composed: true }));
        }
      })
      .call(
        drag<SVGGElement, GNode>()
          .on("start", (ev, d) => {
            if (d.id === ME_ID) return;
            if (!ev.active) this.sim?.alphaTarget(0.25).restart();
            d.fx = d.x;
            d.fy = d.y;
          })
          .on("drag", (ev, d) => {
            if (d.id === ME_ID) return;
            d.fx = ev.x;
            d.fy = ev.y;
          })
          .on("end", (ev, d) => {
            if (d.id === ME_ID) return;
            if (!ev.active) this.sim?.alphaTarget(0);
            d.fx = null;
            d.fy = null;
          }),
      );
    nodeG.classed("me", (d) => d.id === ME_ID);
    nodeG.select("circle.halo").attr("r", (d) => (d.id === ME_ID ? d.r + 16 : 0));
    nodeG
      .select<SVGCircleElement>("circle.body")
      .attr("r", (d) => d.r)
      .attr("fill", (d) => (d.data ? typeColor(d.data.contactType) : null));
    nodeG.select("circle.ring").attr("r", (d) => d.r + 4).attr("display", (d) => (d.data?.isClient ? null : "none"));
    // Warm-score arc: a gold sweep starting at 12 o'clock, length = score.
    const arcR = (d: GNode) => d.r + (d.data?.isClient ? 7.5 : 3.5);
    nodeG
      .select("circle.warmtrack")
      .attr("r", arcR)
      .attr("display", (d) => (d.data ? null : "none"));
    nodeG
      .select("circle.warm")
      .attr("r", arcR)
      .attr("transform", "rotate(-90)")
      .attr("display", (d) => (d.data && (d.data.warmScore ?? 0) > 0 ? null : "none"))
      .attr("stroke-dasharray", (d) => {
        const c = 2 * Math.PI * arcR(d);
        const f = Math.max(0, Math.min(100, d.data?.warmScore ?? 0)) / 100;
        return `${(c * f).toFixed(1)} ${c.toFixed(1)}`;
      });
    nodeG.select("text.ini").text((d) => (d.data ? initials(d.data.name) : "YOU"));
    nodeG
      .select("text.name")
      .attr("y", (d) => d.r + 15)
      .text((d) => (d.data ? (d.data.name.length > 22 ? `${d.data.name.slice(0, 21)}…` : d.data.name) : this.meLabel));
    nodeG
      .select("g.badge")
      .attr("display", (d) => (d.data && d.data.openOpportunities > 0 ? null : "none"))
      .attr("transform", (d) => `translate(${d.r * 0.74},${-d.r * 0.74})`)
      .select("text")
      .text((d) => String(d.data?.openOpportunities ?? ""));
    nodeG
      .select("g.cbadge")
      .attr("display", (d) => (d.data?.isClient ? null : "none"))
      .attr("transform", (d) => `translate(${-d.r * 0.74},${-d.r * 0.74})`);
    this.restyle();
    if (!prev.size) this.fitted = false;
    // Pre-run so the first paint is already laid out (no fly-in).
    if (!prev.size) {
      this.sim.stop();
      for (let i = 0; i < 180; i++) this.sim.tick();
      this.tick();
      this.placeRingLabels();
      this.fit(false);
      this.sim.alpha(0.05).restart();
    }
  }

  private restyle() {
    if (!this.svgSel) return;
    if (this.compact) this.placeEdgeLabels(this.svgSel.select("g.viewport").selectAll<SVGTextElement, GLink>("text.elabel"));
    const pathE = new Set(this.pathEdgeIds);
    const pathN = new Set(this.pathNodeIds);
    const sel = this.selectedId;
    const root = this.svgSel.select("g.viewport");
    root
      .selectAll<SVGGElement, GLink>("g.e")
      .select<SVGLineElement>("line.edge:not(.hit)")
      .attr("stroke-width", (d) => 0.8 + d.data.strength * 0.75 + (pathE.has(d.id) ? 1.5 : 0))
      .classed("dashed", (d) => d.data.status !== "Active")
      .classed("path", (d) => pathE.has(d.id))
      .classed("sel", (d) => d.id === this.selectedEdgeId)
      .attr("opacity", (d) => {
        if (!sel && !pathE.size) return d.data.status === "Ended" ? 0.35 : 0.85;
        const touches = d.data.from === sel || d.data.to === sel;
        return pathE.has(d.id) || touches || d.id === this.selectedEdgeId ? 1 : 0.22;
      });
    // Satellite names only around the selected person (glyph + tooltip otherwise).
    root
      .selectAll<SVGGElement, GNode>("g.sat")
      .classed("named", (d) => Boolean(sel && d.sat?.ownerIds.includes(sel)))
      .attr("opacity", (d) => (!sel || d.sat?.ownerIds.includes(sel) ? 1 : 0.35));
    root.selectAll<SVGTextElement, GLink>("text.elabel").classed("muted", (d) => {
      if (!sel) return false;
      return !(d.data.from === sel || d.data.to === sel || pathE.has(d.id));
    });
    const stale = this.staleAfterDays;
    root
      .selectAll<SVGGElement, GNode>("g.node")
      .classed("stale", (d) => Boolean(d.data && (d.data.staleDays === null || d.data.staleDays > stale)))
      .attr("opacity", (d) => {
        if (!sel || d.id === sel || d.id === ME_ID || pathN.has(d.id)) return 1;
        const linked = this.edges.some((e) => (e.from === sel && e.to === d.id) || (e.to === sel && e.from === d.id));
        return linked ? 1 : 0.4;
      })
      .select("circle.selring")
      .attr("r", (d) => d.r + 8)
      .attr("display", (d) => (d.id === sel ? null : "none"));
  }

  private tickCount = 0;
  /** Ring label boxes (graph space) — edge labels steer clear of them. */
  private ringBoxes: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];

  private tick() {
    if (!this.svgSel) return;
    if (++this.tickCount % 20 === 0) this.placeRingLabels();
    const root = this.svgSel.select("g.viewport");
    // Nested selectAll doesn't inherit data — read each edge's datum here.
    root.selectAll<SVGGElement, GLink>("g.e").each(function (d) {
      const s = d.source as GNode;
      const t = d.target as GNode;
      select(this)
        .selectAll("line")
        .attr("x1", s.x ?? 0)
        .attr("y1", s.y ?? 0)
        .attr("x2", t.x ?? 0)
        .attr("y2", t.y ?? 0);
    });
    this.placeEdgeLabels(root.selectAll<SVGTextElement, GLink>("text.elabel"));
    root.selectAll<SVGGElement, GNode>("g.node, g.sat").attr("transform", (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
  }

  /** Faint concentric band guides with labels (rings layout only). */
  private drawRings(on: boolean, k: number) {
    if (!this.svgSel) return;
    const g = this.svgSel.select<SVGGElement>("g.rings");
    g.selectAll("*").remove();
    if (!on) return;
    const counts = new Map<string, number>();
    for (const n of this.nodes) counts.set(n.warmBand, (counts.get(n.warmBand) ?? 0) + 1);
    // Outer edge of each band: inner → score 70 boundary … dormant → beyond score 0.
    const outer = RING_BANDS.map((b, i) => ({
      ...b,
      r: i === RING_BANDS.length - 1 ? ringRadius(0, k) + 34 * k : ringRadius(b.min, k),
    }));
    // Soft filled bands, warmest brightest.
    [...outer].reverse().forEach((b, i) => {
      g.append("circle").attr("class", "ringband").attr("r", b.r).attr("opacity", 0.018 + i * 0.012);
    });
    for (const b of outer) g.append("circle").attr("class", `ringline ${b.id}`).attr("r", b.r);
    for (const b of outer) {
      const lg = g.append("g").attr("class", "ringtag").datum({ r: b.r - 16 * k, w: b.label.length * 4.6 + 14 });
      lg.append("text").attr("class", "ringlabel").attr("y", 0).text(b.label);
      lg.append("text")
        .attr("class", "ringlabel sub")
        .attr("y", 13 * (this.compact ? 1.2 : 1))
        .text(`${b.id === "dormant" ? "under 20" : `${b.min}+`} · ${counts.get(b.id) ?? 0}`);
    }
    this.placeRingLabels();
  }

  /**
   * Put each ring's label at the angle on that ring with the least overlap
   * with people, their names and labels already placed (prefers the top).
   */
  private placeRingLabels() {
    if (!this.svgSel || this.layout !== "rings") return;
    type Box = { x0: number; y0: number; x1: number; y1: number };
    const blocks: Box[] = [];
    for (const n of this.gNodes.values()) {
      const x = n.x ?? 0;
      const y = n.y ?? 0;
      const r = n.r + 8;
      blocks.push({ x0: x - r, y0: y - r, x1: x + r, y1: y + r + (n.sat ? 4 : 20) });
    }
    const overlap = (a: Box, b: Box) =>
      Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
    const cs = this.compact ? 1.2 : 1;
    const placed: Box[] = [];
    this.svgSel.selectAll<SVGGElement, { r: number; w: number }>("g.ringtag").each(function (d) {
      let best = { a: -Math.PI / 2, cost: Infinity };
      for (let deg = -90; deg < 270; deg += 12) {
        const a = (deg * Math.PI) / 180;
        const x = Math.cos(a) * d.r;
        const y = Math.sin(a) * d.r;
        const box = { x0: x - d.w * cs, y0: y - 12 * cs, x1: x + d.w * cs, y1: y + 16 * cs };
        let cost = Math.abs(((deg + 90) % 360) - 0) * 0.02; // mild preference for the top
        for (const b of blocks) cost += overlap(box, b);
        if (cost < best.cost) best = { a, cost };
      }
      const x = Math.cos(best.a) * d.r;
      const y = Math.sin(best.a) * d.r;
      const box = { x0: x - d.w * cs, y0: y - 12 * cs, x1: x + d.w * cs, y1: y + 16 * cs };
      blocks.push(box);
      placed.push(box);
      select(this).attr("transform", `translate(${x.toFixed(1)},${y.toFixed(1)})`);
    });
    this.ringBoxes = placed;
  }

  /**
   * Put each edge label at the point along its line that overlaps least with
   * node discs, node name labels and labels already placed (greedy, cheap at
   * network sizes). Labels on very short edges are hidden.
   */
  private placeEdgeLabels(sel: Selection<SVGTextElement, GLink, BaseType, unknown>) {
    type Box = { x0: number; y0: number; x1: number; y1: number };
    const nodes = [...this.gNodes.values()];
    const cw = this.compact ? 1.3 : 1;
    // Phones: label only your direct ties, or the selection's edges + path.
    const focus = this.selectedId;
    const pathE = new Set(this.pathEdgeIds);
    const showLabel = (e: NetworkEdge) =>
      !this.compact ||
      (focus ? e.from === focus || e.to === focus || pathE.has(e.id) : e.from === ME_ID || e.to === ME_ID);
    const blocks: Box[] = [];
    for (const n of nodes) {
      const x = n.x ?? 0;
      const y = n.y ?? 0;
      const r = n.r + 12;
      blocks.push({ x0: x - r, y0: y - r, x1: x + r, y1: y + r });
      const named = !n.sat || Boolean(focus && n.sat.ownerIds.includes(focus));
      const name = n.sat ? (named ? n.sat.label.slice(0, 16) : "") : n.data ? n.data.name : this.meLabel;
      const w = Math.min(22, name.length) * 3.6 * cw + 6;
      blocks.push({ x0: x - w, y0: y + n.r + 4, x1: x + w, y1: y + n.r + 4 + 16 * cw });
    }
    const overlap = (a: Box, b: Box) =>
      Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
    const rings = this.layout === "rings" ? this.ringBoxes : [];
    for (const r of rings) blocks.push(r);
    const compact = this.compact;
    const T = [0.5, 0.4, 0.6, 0.32, 0.68, 0.25, 0.75];
    sel.each(function (d) {
      const s = d.source as GNode;
      const t = d.target as GNode;
      const sx = s.x ?? 0, sy = s.y ?? 0, tx = t.x ?? 0, ty = t.y ?? 0;
      const len = Math.hypot(tx - sx, ty - sy);
      const el = select(this);
      if (len < s.r + t.r + (cw > 1 ? 70 : 40) || !showLabel(d.data)) {
        el.attr("display", "none");
        return;
      }
      const hw = (this.textContent?.length ?? 4) * 2.9 * cw + 3;
      let best: Box | null = null;
      let bestCost = Infinity;
      for (const f of T) {
        const x = sx + (tx - sx) * f;
        const y = sy + (ty - sy) * f;
        const box = { x0: x - hw, y0: y - 9, x1: x + hw, y1: y + 3 };
        let cost = Math.abs(f - 0.5) * 20;
        for (const b of blocks) cost += overlap(box, b);
        if (cost < bestCost) ((bestCost = cost), (best = box));
        if (cost === 0) break;
      }
      const b = best!;
      // Phones: never print an edge label over a ring label.
      if (compact && rings.some((r) => overlap(b, r) > 0)) {
        el.attr("display", "none");
        return;
      }
      blocks.push(b);
      el.attr("display", null)
        .attr("x", (b.x0 + b.x1) / 2)
        .attr("y", b.y1 - 2);
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "people-network-graph": PeopleNetworkGraph;
  }
}
