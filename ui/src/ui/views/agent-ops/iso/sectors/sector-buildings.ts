/**
 * sector-buildings.ts — monoline iso building SVGs, one archetype per tool sector.
 *
 * Pure presentation: every export is a function (palette) → Lit `svg` fragment
 * drawn around a local origin of (0,0) = the building's GROUND-CONTACT point,
 * rising in the -Y direction. <world-sectors> translates each fragment to its
 * sector's iso position. No DOM, no engine, no PIXI — just paths.
 *
 * Archetypes are mapped from activity-map.ts `sectorForToolKind()` (READ-ONLY
 * reference) so the city reads as an honest systems diagram:
 *   the-vault         → dataVault        (read/list/search   → DB / archives)
 *   comms-deck        → commsTower       (web/fetch/http/api  → MCP / comms)
 *   mission-control   → bulletinPlaza    (autonomy + cron     → kanban board)
 *   broadcast-studio  → waveAmphitheater (media + voice       → voice)
 *   command-atrium    → orbitalRing      (federation hub)
 *   gateway-concourse → centralHub       (gateway             → ornate centre)
 *   observatory       → observatoryDome  (think/plan/analyse)
 *   agent-quarters    → residentialPods  (agents + sessions)
 *   engineering-bay   → reactorBay       (bash/exec/terminal)
 *   canvas-atrium     → forgeWorkshop    (write/edit/create   → forge)
 *
 * Window/lamp elements carry class `sector-window` so <world-sectors> can light
 * them at dusk. `glow` strokes use the gold accent; night glow is a CSS filter.
 */
import { svg, type SVGTemplateResult } from "lit";

export interface BuildingPalette {
  /** Primary monoline stroke (cool structural lines). */
  line: string;
  /** Gold accent for highlights + lit windows. */
  gold: string;
  /** Faint glass fill at the base of volumes. */
  glass: string;
}

export const DEFAULT_PALETTE: BuildingPalette = {
  line: "#7da2c8",
  gold: "#fbbf24",
  glass: "rgba(125,162,200,0.10)",
};

/** Each archetype keyed by sector id, plus a friendly label for the SVG title. */
export interface BuildingDef {
  sectorId: string;
  label: string;
  archetype: string;
  draw: (p: BuildingPalette) => SVGTemplateResult;
}

// ── shared helpers ────────────────────────────────────────────────────────────

/** An iso diamond footprint centred on (0,0). hw = half-width in px. */
const pad = (hw: number, line: string, glass: string) =>
  svg`<path d="M ${-hw} 0 L 0 ${hw * 0.5} L ${hw} 0 L 0 ${-hw * 0.5} Z"
        fill="${glass}" stroke="${line}" stroke-width="1.5" opacity="0.9"/>`;

const win = (x: number, y: number, w: number, h: number, gold: string) =>
  svg`<rect class="sector-window" x="${x}" y="${y}" width="${w}" height="${h}"
        rx="0.8" fill="${gold}" stroke="none" opacity="0.0"/>`;

// ── archetypes ────────────────────────────────────────────────────────────────

/** DB → cylindrical data vault: stacked stripes + a glowing core slit. */
function dataVault(p: BuildingPalette): SVGTemplateResult {
  const stripes = [-18, -34, -50, -66];
  return svg`
    ${pad(40, p.line, p.glass)}
    <g fill="none" stroke="${p.line}" stroke-width="1.6">
      <!-- cylinder body: two verticals + elliptical caps -->
      <path d="M -28 -6 L -28 -74" />
      <path d="M 28 -6 L 28 -74" />
      <ellipse cx="0" cy="-74" rx="28" ry="11" />
      <path d="M -28 -6 A 28 11 0 0 0 28 -6" />
      ${stripes.map(
        (y) => svg`<path d="M -28 ${y} A 28 11 0 0 0 28 ${y}" opacity="0.55"/>`,
      )}
    </g>
    <!-- glowing core slit -->
    <rect class="sector-window" x="-3" y="-70" width="6" height="58" rx="3"
      fill="${p.gold}" opacity="0" />
    <ellipse cx="0" cy="-74" rx="28" ry="11" fill="none" stroke="${p.gold}" stroke-width="1.4" opacity="0.85"/>
  `;
}

/** MCP → comms tower: slender shaft, lattice, pulsing antenna beacon. */
function commsTower(p: BuildingPalette): SVGTemplateResult {
  return svg`
    ${pad(30, p.line, p.glass)}
    <g fill="none" stroke="${p.line}" stroke-width="1.5">
      <path d="M -14 -2 L -8 -96 L 8 -96 L 14 -2 Z" />
      <path d="M -12 -28 L 12 -28 M -10 -54 L 10 -54 M -9 -76 L 9 -76" opacity="0.5"/>
      <path d="M -8 -96 L 8 -96 M 0 -96 L 0 -116" />
      <!-- dish -->
      <path d="M 8 -82 q 22 -6 26 -22" stroke-width="1.3"/>
    </g>
    <!-- antenna beacon (pulses via .sector-beacon) -->
    <circle class="sector-beacon sector-window" cx="0" cy="-118" r="3.4" fill="${p.gold}" opacity="0"/>
    <circle cx="0" cy="-118" r="6.5" fill="none" stroke="${p.gold}" stroke-width="1.1" opacity="0.7"/>
    ${win(-4, -90, 8, 5, p.gold)}
  `;
}

/** Kanban → bulletin plaza: low wide structure, column lights, board face. */
function bulletinPlaza(p: BuildingPalette): SVGTemplateResult {
  const cols = [-44, -22, 0, 22, 44];
  return svg`
    ${pad(58, p.line, p.glass)}
    <g fill="none" stroke="${p.line}" stroke-width="1.5">
      <!-- wide low roof slab -->
      <path d="M -56 -30 L 0 -42 L 56 -30 L 0 -18 Z" />
      <path d="M -56 -30 L -56 -8 L 0 4 L 0 -18 Z" opacity="0.85"/>
      <path d="M 56 -30 L 56 -8 L 0 4 L 0 -18 Z" opacity="0.85"/>
      <!-- bulletin board face -->
      <path d="M -34 -22 L 0 -29 L 0 -10 L -34 -3 Z" opacity="0.6"/>
    </g>
    <!-- column lights along the colonnade -->
    ${cols.map((x, i) => win(x - 1.4, -30 + Math.abs(x) * 0.14, 3, 22, p.gold))}
    <!-- pinned cards -->
    ${[0, 1, 2].map((i) => win(-30 + i * 9, -25 + i * 2, 6, 5, p.gold))}
  `;
}

/** Voice → wave amphitheater: concentric arc seating + radiating wave lines. */
function waveAmphitheater(p: BuildingPalette): SVGTemplateResult {
  const arcs = [16, 28, 40, 52];
  return svg`
    ${pad(54, p.line, p.glass)}
    <g fill="none" stroke="${p.line}" stroke-width="1.5">
      ${arcs.map(
        (r) =>
          svg`<path d="M ${-r} -6 A ${r} ${r * 0.5} 0 0 1 ${r} -6" opacity="${0.4 + (52 - r) / 120}"/>`,
      )}
      <!-- stage -->
      <ellipse cx="0" cy="-6" rx="12" ry="6" />
    </g>
    <!-- radiating sound waves from the stage (lit) -->
    <g class="sector-window" opacity="0">
      ${[20, 34, 48].map(
        (r) => svg`<path d="M ${-r} -10 A ${r} ${r * 0.5} 0 0 1 ${r} -10"
            fill="none" stroke="${p.gold}" stroke-width="1.3"/>`,
      )}
    </g>
    <circle cx="0" cy="-8" r="3" fill="${p.gold}" opacity="0.85"/>
  `;
}

/** Federation → orbital ring: a pylon with a tilted halo ring + orbiting node. */
function orbitalRing(p: BuildingPalette): SVGTemplateResult {
  return svg`
    ${pad(46, p.line, p.glass)}
    <g fill="none" stroke="${p.line}" stroke-width="1.6">
      <!-- core pylon -->
      <path d="M -8 -4 L -5 -60 L 5 -60 L 8 -4 Z" />
      <!-- tilted orbital ring -->
      <ellipse cx="0" cy="-64" rx="42" ry="16" transform="rotate(-18 0 -64)" />
      <ellipse cx="0" cy="-64" rx="30" ry="10" transform="rotate(-18 0 -64)" opacity="0.6"/>
    </g>
    <!-- orbiting satellite node (lit) -->
    <circle class="sector-window" cx="38" cy="-58" r="3.6" fill="${p.gold}" opacity="0"/>
    <circle class="sector-window" cx="-34" cy="-72" r="2.6" fill="${p.gold}" opacity="0"/>
    <circle cx="0" cy="-62" r="4" fill="none" stroke="${p.gold}" stroke-width="1.3" opacity="0.85"/>
  `;
}

/** Gateway → ornate central hub: stepped ziggurat + crown spire + ringed base. */
function centralHub(p: BuildingPalette): SVGTemplateResult {
  return svg`
    ${pad(60, p.line, p.glass)}
    <g fill="none" stroke="${p.line}" stroke-width="1.7">
      <!-- ringed plaza base -->
      <ellipse cx="0" cy="-2" rx="52" ry="22" opacity="0.45"/>
      <!-- stepped tiers -->
      <path d="M -40 -10 L 0 -24 L 40 -10 L 0 4 Z" />
      <path d="M -30 -26 L 0 -38 L 30 -26 L 0 -14 Z" />
      <path d="M -18 -44 L 0 -52 L 18 -44 L 0 -36 Z" />
      <!-- crown spire -->
      <path d="M 0 -52 L 0 -88" />
      <path d="M -8 -64 L 0 -88 L 8 -64" />
    </g>
    <!-- crown beacon + tier windows -->
    <circle class="sector-window sector-beacon" cx="0" cy="-90" r="3.6" fill="${p.gold}" opacity="0"/>
    ${[-24, -8, 8, 24].map((x) => win(x - 1.4, -30 + Math.abs(x) * 0.2, 3, 9, p.gold))}
    <path d="M -40 -10 L 0 -24 L 40 -10" fill="none" stroke="${p.gold}" stroke-width="1.2" opacity="0.8"/>
  `;
}

/** Analytics → observatory dome: telescope dome on a drum, sky slit. */
function observatoryDome(p: BuildingPalette): SVGTemplateResult {
  return svg`
    ${pad(40, p.line, p.glass)}
    <g fill="none" stroke="${p.line}" stroke-width="1.6">
      <!-- drum -->
      <path d="M -26 -6 L -26 -38" />
      <path d="M 26 -6 L 26 -38" />
      <path d="M -26 -6 A 26 10 0 0 0 26 -6" />
      <!-- dome -->
      <path d="M -26 -38 A 26 26 0 0 1 26 -38" />
      <path d="M -26 -38 A 26 8 0 0 0 26 -38" opacity="0.5"/>
      <!-- sky slit + telescope -->
      <path d="M -4 -62 L 22 -78" stroke-width="1.4"/>
    </g>
    <rect class="sector-window" x="-3" y="-62" width="6" height="22" rx="3" fill="${p.gold}" opacity="0"/>
    ${[-18, 0, 18].map((x) => win(x - 1.2, -20, 2.4, 8, p.gold))}
  `;
}

/** Agents → residential pods: cluster of capsule habitats with porthole lights. */
function residentialPods(p: BuildingPalette): SVGTemplateResult {
  const pods: Array<[number, number, number]> = [
    [-26, -2, 18],
    [10, 2, 22],
    [30, -8, 14],
    [-4, -14, 16],
  ];
  return svg`
    ${pad(48, p.line, p.glass)}
    <g fill="none" stroke="${p.line}" stroke-width="1.5">
      ${pods.map(
        ([x, y, r]) => svg`
        <path d="M ${x - r} ${y} A ${r} ${r} 0 0 1 ${x + r} ${y} Z" />
        <path d="M ${x - r} ${y} A ${r} ${r * 0.35} 0 0 0 ${x + r} ${y}" opacity="0.5"/>`,
      )}
    </g>
    <!-- porthole lights -->
    ${pods.map(([x, y, r]) => win(x - 2.5, y - r * 0.6, 5, 5, p.gold))}
  `;
}

/** Terminals → reactor bay: angular hall + vented core that pulses. */
function reactorBay(p: BuildingPalette): SVGTemplateResult {
  return svg`
    ${pad(46, p.line, p.glass)}
    <g fill="none" stroke="${p.line}" stroke-width="1.6">
      <!-- hall box -->
      <path d="M -40 -8 L -40 -40 L 0 -54 L 0 -22 Z" />
      <path d="M 40 -8 L 40 -40 L 0 -54 L 0 -22 Z" />
      <path d="M -40 -40 L 0 -54 L 40 -40 L 0 -26 Z" />
      <!-- exhaust stacks -->
      <path d="M 18 -47 L 18 -66 M 26 -49 L 26 -62" />
    </g>
    <!-- reactor core slit (pulsing) -->
    <rect class="sector-window sector-beacon" x="-3" y="-44" width="6" height="20" rx="2" fill="${p.gold}" opacity="0"/>
    <!-- vent louvres -->
    ${[-30, -22, -14].map((x, i) => win(x, -30 - i * 4, 5, 2.4, p.gold))}
    ${[14, 22, 30].map((x, i) => win(x, -30 - (2 - i) * 4, 5, 2.4, p.gold))}
  `;
}

/** Write/design → forge workshop: pitched roof, chimney, glowing forge mouth. */
function forgeWorkshop(p: BuildingPalette): SVGTemplateResult {
  return svg`
    ${pad(44, p.line, p.glass)}
    <g fill="none" stroke="${p.line}" stroke-width="1.6">
      <!-- gabled body -->
      <path d="M -36 -6 L -36 -30 L 0 -34 L 0 -10 Z" />
      <path d="M 36 -6 L 36 -30 L 0 -34 L 0 -10 Z" />
      <!-- pitched roof -->
      <path d="M -36 -30 L 0 -50 L 36 -30 L 0 -34 Z" />
      <!-- chimney -->
      <path d="M 18 -42 L 18 -60 L 26 -62 L 26 -45" />
    </g>
    <!-- forge mouth (warm, lit) + sparks -->
    <path class="sector-window" d="M -22 -10 L -8 -12 L -8 -22 L -22 -20 Z" fill="${p.gold}" opacity="0"/>
    ${win(24, -64, 3, 4, p.gold)}
    ${[6, 16].map((x, i) => win(x - 14, -22 - i * 5, 2, 2, p.gold))}
  `;
}

/**
 * Building registry, keyed to the SECTORS floorplan (sector-layout.ts).
 * Order is back-to-front agnostic; <world-sectors> sorts by iso depth.
 */
export const BUILDINGS: BuildingDef[] = [
  { sectorId: "the-vault", label: "DATA VAULT", archetype: "data-vault", draw: dataVault },
  { sectorId: "comms-deck", label: "COMMS TOWER", archetype: "comms-tower", draw: commsTower },
  { sectorId: "mission-control", label: "BULLETIN PLAZA", archetype: "bulletin-plaza", draw: bulletinPlaza },
  { sectorId: "broadcast-studio", label: "WAVE AMPHITHEATER", archetype: "amphitheater", draw: waveAmphitheater },
  { sectorId: "command-atrium", label: "ORBITAL RING", archetype: "orbital-ring", draw: orbitalRing },
  { sectorId: "gateway-concourse", label: "GATEWAY HUB", archetype: "central-hub", draw: centralHub },
  { sectorId: "observatory", label: "OBSERVATORY", archetype: "observatory-dome", draw: observatoryDome },
  { sectorId: "agent-quarters", label: "AGENT QUARTERS", archetype: "residential-pods", draw: residentialPods },
  { sectorId: "engineering-bay", label: "REACTOR BAY", archetype: "reactor-bay", draw: reactorBay },
  { sectorId: "canvas-atrium", label: "FORGE WORKSHOP", archetype: "forge-workshop", draw: forgeWorkshop },
];
