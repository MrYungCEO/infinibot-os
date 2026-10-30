/**
 * Plugin rooms on the Galactic HQ map — pure model (no Pixi).
 *
 * Every enabled manifest-v2 plugin with a page gets a ROOM in the "Plugin
 * District": a ring of iso blocks around the 24×24 core station. This module
 * owns everything that can be unit-tested without a renderer:
 *
 *   - `roomSpecsFromPluginList`  plugins.list → PluginRoomSpec[] (theme,
 *                                accent, monogram, props, size, placement)
 *   - `THEME_DECOR`              the prop set each theme is built from
 *   - `planDistrict`             deterministic, sticky, no-overlap placement
 *                                on ring slots that grow with more plugins
 *   - `districtConduits`         the transit loop + per-room stubs + trunk
 *                                to the Gateway Concourse
 *
 * Tile space matches sector-layout.ts: the core station occupies c,r ∈ [0,24).
 * The renderer (plugin-district.ts) turns these tile rects into iso platforms.
 */

// ── Types ─────────────────────────────────────────────────────────────────

export type RoomTheme =
  | 'generic'
  | 'fleet'
  | 'voice-studio'
  | 'clinic'
  | 'media-studio'
  | 'trading-floor'
  | 'terminal-vault'
  | 'dojo'
  | 'content-lab'
  | 'showroom'
  | 'drawing-studio'
  | 'holo-gallery'
  | 'boardroom';

export type RoomSize = 'S' | 'M' | 'L';
export type RoomSide = 'north' | 'east' | 'south' | 'west';
export type RoomPlacement = 'auto' | RoomSide;

/** A prop placed in a room, in room-relative tile coords (8×8 reference). */
export interface RoomDecorItem {
  t: string;
  c: number;
  r: number;
  s?: number;
}

export interface PluginRoomSpec {
  /** Sector id used by the engine: `plugin:<pluginId>`. */
  id: string;
  pluginId: string;
  title: string;
  /** Label subtitle ("plugin · trading floor"). */
  subtitle: string;
  theme: RoomTheme;
  size: RoomSize;
  placement: RoomPlacement;
  /** 0xRRGGBB accent for trim, sign, floor tint, in-room FX. */
  accent: number;
  /** 1–3 letter sign text. */
  monogram: string;
  /** Props in room-relative tile coords, already scaled to the room size. */
  decor: RoomDecorItem[];
  /** Control-UI tab the room opens on click (first nav entry, else first page). */
  openTab?: string;
  /** Page routes the plugin owns (activity → room mapping + click fallback). */
  routes: string[];
}

/** Subset of a plugins.list item the room model reads. */
export interface PluginRoomSource {
  id: string;
  name: string;
  status?: string;
  enabled?: boolean;
  manifestVersion?: number;
  disabledContributions?: string[];
  contributes?: {
    pages?: Array<{ tab: string; route: string }>;
    nav?: Array<{ tab: string }>;
    mapRoom?: {
      title?: string;
      theme?: string;
      accent?: string;
      props?: string[];
      size?: string;
      placement?: string;
    };
  };
  appearance?: {
    monogram?: string;
    themes?: { dark?: { vars?: Record<string, string> } };
  };
}

// ── Sizes, themes, accents ───────────────────────────────────────────────

export const ROOM_TILES: Record<RoomSize, number> = { S: 6, M: 8, L: 10 };

export const THEME_LABEL: Record<RoomTheme, string> = {
  generic: 'plugin',
  fleet: 'fleet ops',
  'voice-studio': 'voice studio',
  clinic: 'clinic + lab',
  'media-studio': 'photo + video',
  'trading-floor': 'trading floor',
  'terminal-vault': 'solana terminal',
  dojo: 'focus dojo',
  'content-lab': 'content lab',
  showroom: 'showroom',
  'drawing-studio': 'drawing studio',
  'holo-gallery': 'holo gallery',
  boardroom: 'boardroom',
};

/** Per-theme accent — deliberately distinct from every core district accent
 *  (iso/district-accents.ts) so a plugin room never reads as a core sector. */
export const THEME_ACCENT: Record<RoomTheme, number> = {
  generic: 0x94a3b8,       // steel
  fleet: 0x5eead4,         // aqua
  'voice-studio': 0xf0abfc, // orchid
  clinic: 0x6ee7b7,        // mint
  'media-studio': 0xfdba74, // apricot
  'trading-floor': 0xfacc15, // trading amber
  'terminal-vault': 0x818cf8, // indigo
  dojo: 0x7dd3fc,          // sky
  'content-lab': 0xf9a8d4, // pink
  showroom: 0xbef264,      // lime
  'drawing-studio': 0xfda4af, // rose
  'holo-gallery': 0xd8b4fe, // lavender
  boardroom: 0xfde68a,     // pale gold
};

/** Design tokens a manifest accent may name (dark-theme values, mirrors
 *  src/plugins/appearance.ts APPEARANCE_TOKENS). */
export const ACCENT_TOKENS: Record<string, number> = {
  primary: 0xfbbf24,
  accent: 0xa855f7,
  info: 0x38bdf8,
  success: 0x22c55e,
  warning: 0xf59e0b,
  danger: 0xef4444,
  neutral: 0x94a3b8,
  text: 0xf5f5f4,
  muted: 0xa1a1aa,
};

const THEMES: readonly RoomTheme[] = Object.keys(THEME_LABEL) as RoomTheme[];

/**
 * Prop layouts per theme on an 8×8 reference room (room-relative tiles). The
 * back corner is (0,0); agents approach from +c/+r. Every theme keeps at least
 * two workstation props so `computeWorkSlots` yields seats.
 */
export const THEME_DECOR: Record<RoomTheme, RoomDecorItem[]> = {
  generic: [
    { t: 'commsBoard', c: 1.4, r: 1.4, s: 0.9 },
    { t: 'consoleWide', c: 3.4, r: 1.6 },
    { t: 'desk', c: 5.8, r: 2.4 },
    { t: 'holoTable', c: 3.2, r: 4.6, s: 0.9 },
    { t: 'plantHolo', c: 6.6, r: 5.6 },
    { t: 'bench', c: 5.2, r: 6.4, s: 0.9 },
    { t: 'crate', c: 1.4, r: 6.2 },
  ],
  fleet: [
    { t: 'server', c: 1.4, r: 1.2 },
    { t: 'server', c: 2.6, r: 1.2 },
    { t: 'server', c: 3.8, r: 1.2 },
    { t: 'server', c: 5.0, r: 1.2 },
    { t: 'bigDisplay', c: 6.4, r: 2.2, s: 0.9 },
    { t: 'consoleWide', c: 2.6, r: 4.2 },
    { t: 'roboArm', c: 6.0, r: 4.6, s: 0.9 },
    { t: 'crate', c: 1.4, r: 6.4 },
  ],
  'voice-studio': [
    { t: 'waveformWall', c: 3.2, r: 1.2 },
    { t: 'micBooth', c: 1.8, r: 3.2 },
    { t: 'micBooth', c: 5.6, r: 2.8 },
    { t: 'consoleWide', c: 3.6, r: 4.4 },
    { t: 'speaker', c: 6.6, r: 4.8 },
    { t: 'speaker', c: 1.2, r: 5.6 },
    { t: 'couch', c: 5.4, r: 6.2, s: 0.9 },
  ],
  clinic: [
    { t: 'labBench', c: 2.4, r: 1.4 },
    { t: 'labBench', c: 5.2, r: 1.4 },
    { t: 'gateArch', c: 6.4, r: 3.4, s: 0.8 },
    { t: 'bed', c: 1.8, r: 4.0, s: 0.8 },
    { t: 'bed', c: 3.4, r: 4.8, s: 0.8 },
    { t: 'desk', c: 5.8, r: 5.4 },
    { t: 'crystal', c: 1.2, r: 6.6, s: 0.8 },
    { t: 'plantHolo', c: 6.8, r: 6.8 },
  ],
  'media-studio': [
    { t: 'softbox', c: 1.6, r: 1.4 },
    { t: 'bigDisplay', c: 4.2, r: 1.2 },
    { t: 'softbox', c: 6.6, r: 1.8 },
    { t: 'cameraRig', c: 3.6, r: 4.0 },
    { t: 'holoTable', c: 5.8, r: 4.4, s: 0.85 },
    { t: 'couch', c: 1.8, r: 5.6, s: 0.9 },
    { t: 'crate', c: 6.6, r: 6.4 },
  ],
  'trading-floor': [
    { t: 'tickerBoard', c: 3.6, r: 1.0 },
    { t: 'consoleWide', c: 1.8, r: 3.2 },
    { t: 'consoleWide', c: 4.2, r: 3.2 },
    { t: 'consoleWide', c: 6.4, r: 3.4, s: 0.9 },
    { t: 'desk', c: 2.4, r: 5.6 },
    { t: 'desk', c: 5.2, r: 5.6 },
    { t: 'bigDisplay', c: 7.0, r: 5.8, s: 0.75 },
  ],
  'terminal-vault': [
    { t: 'coinPillar', c: 4.0, r: 1.0 },
    { t: 'safe', c: 1.6, r: 1.8 },
    { t: 'safe', c: 6.4, r: 1.8 },
    { t: 'consoleWide', c: 2.6, r: 3.8 },
    { t: 'consoleWide', c: 5.4, r: 3.8 },
    { t: 'ingots', c: 1.2, r: 5.4 },
    { t: 'crystal', c: 6.8, r: 5.6, s: 0.9 },
    { t: 'desk', c: 4.0, r: 6.2 },
  ],
  dojo: [
    { t: 'dojoMat', c: 4.0, r: 3.6 },
    { t: 'bonsai', c: 1.4, r: 1.4 },
    { t: 'bonsai', c: 6.6, r: 1.4 },
    { t: 'bench', c: 2.0, r: 6.2 },
    { t: 'bench', c: 6.0, r: 6.2 },
    { t: 'pedestal', c: 4.0, r: 0.9, s: 0.9 },
    { t: 'desk', c: 6.6, r: 3.8, s: 0.9 },
  ],
  'content-lab': [
    { t: 'commsBoard', c: 2.6, r: 1.2 },
    { t: 'bigDisplay', c: 5.6, r: 1.4, s: 0.9 },
    { t: 'desk', c: 1.8, r: 3.6 },
    { t: 'desk', c: 4.2, r: 3.6 },
    { t: 'easel', c: 6.6, r: 3.8 },
    { t: 'speaker', c: 1.2, r: 5.8 },
    { t: 'holoTable', c: 4.6, r: 5.8, s: 0.8 },
    { t: 'plantHolo', c: 6.8, r: 6.6 },
  ],
  showroom: [
    { t: 'shelfRack', c: 1.6, r: 1.2 },
    { t: 'shelfRack', c: 3.8, r: 1.2 },
    { t: 'shelfRack', c: 6.0, r: 1.2 },
    { t: 'pedestal', c: 2.2, r: 4.0 },
    { t: 'pedestal', c: 5.8, r: 4.0 },
    { t: 'holoTable', c: 4.0, r: 4.6, s: 0.85 },
    { t: 'crate', c: 1.4, r: 6.4 },
    { t: 'crate', c: 2.2, r: 6.8 },
    { t: 'desk', c: 6.2, r: 6.2, s: 0.9 },
  ],
  'drawing-studio': [
    { t: 'drawingBoard', c: 3.4, r: 1.0 },
    { t: 'easel', c: 1.6, r: 3.4 },
    { t: 'easel', c: 6.4, r: 3.0 },
    { t: 'desk', c: 4.0, r: 4.4 },
    { t: 'holoTable', c: 6.0, r: 5.6, s: 0.8 },
    { t: 'pedestal', c: 1.4, r: 6.0, s: 0.9 },
    { t: 'bench', c: 3.0, r: 6.6, s: 0.9 },
    { t: 'plantHolo', c: 6.8, r: 6.8 },
  ],
  'holo-gallery': [
    { t: 'holoFrame', c: 1.6, r: 1.0 },
    { t: 'holoFrame', c: 3.8, r: 1.0 },
    { t: 'holoFrame', c: 6.0, r: 1.0 },
    { t: 'pedestal', c: 2.2, r: 3.6 },
    { t: 'pedestal', c: 5.8, r: 3.6 },
    { t: 'crystal', c: 4.0, r: 4.4, s: 1.1 },
    { t: 'easel', c: 1.2, r: 5.4 },
    { t: 'holoTable', c: 6.4, r: 5.6, s: 0.8 },
    { t: 'couch', c: 4.0, r: 6.6, s: 0.9 },
  ],
  boardroom: [
    { t: 'bigDisplay', c: 4.0, r: 1.0 },
    { t: 'boardTable', c: 4.0, r: 3.8, s: 1.3 },
    { t: 'consoleWide', c: 1.3, r: 2.4, s: 0.9 },
    { t: 'commsBoard', c: 6.6, r: 2.4, s: 0.9 },
    { t: 'plantHolo', c: 1.2, r: 5.0 },
    { t: 'couch', c: 2.4, r: 6.4, s: 0.9 },
    { t: 'holoTable', c: 6.0, r: 5.8, s: 0.85 },
    { t: 'pedestal', c: 6.9, r: 4.4, s: 0.9 },
  ],
};

/** Generic filler placed in the extra floor of an L room (10×10). The east
 *  and west corners stay clear — the monogram sign hangs at one of them. */
const L_FILLER: RoomDecorItem[] = [
  { t: 'plantHolo', c: 0.9, r: 0.9 },
  { t: 'crate', c: 9.0, r: 2.6, s: 0.9 },
  { t: 'crate', c: 9.1, r: 9.0 },
  { t: 'plantHolo', c: 2.6, r: 9.0 },
];

function isTheme(v: unknown): v is RoomTheme {
  return typeof v === 'string' && (THEMES as string[]).includes(v);
}

function isSize(v: unknown): v is RoomSize {
  return v === 'S' || v === 'M' || v === 'L';
}

function isPlacement(v: unknown): v is RoomPlacement {
  return v === 'auto' || v === 'north' || v === 'east' || v === 'south' || v === 'west';
}

/** Parse "#rrggbb" → number, else null. */
export function parseHexColor(v: string | undefined | null): number | null {
  if (!v) return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(v.trim());
  return m ? parseInt(m[1], 16) : null;
}

/**
 * Accent for a room: explicit manifest accent (token or hex) → theme accent.
 * The plugin's appearance accent is NOT used by default: most first-party
 * plugins declare `token:primary`, which would paint every room gold.
 */
export function resolveRoomAccent(theme: RoomTheme, declared?: string): number {
  if (declared) {
    const hex = parseHexColor(declared);
    if (hex !== null) return hex;
    if (declared.startsWith('token:')) {
      const tok = ACCENT_TOKENS[declared.slice(6).toLowerCase()];
      if (tok !== undefined) return tok;
    }
  }
  return THEME_ACCENT[theme];
}

/** Two-letter fallback monogram ("Content Studio" → "CS", "FlyPic" → "FP"). */
export function monogramFor(name: string): string {
  const words = name.trim().split(/[\s_-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const w = words[0] ?? '?';
  const caps = w.match(/[A-Z]/g);
  if (caps && caps.length >= 2) return caps.slice(0, 2).join('');
  return w.slice(0, 2).toUpperCase();
}

/**
 * Props for a room: the theme set (or an explicit manifest prop list laid out
 * on the same grid), scaled from the 8×8 reference to the room's tile size.
 */
export function decorForRoom(theme: RoomTheme, size: RoomSize, props?: string[]): RoomDecorItem[] {
  const tiles = ROOM_TILES[size];
  const k = tiles / 8;
  let base: RoomDecorItem[];
  if (props && props.length) {
    // Explicit props: 3-wide rows from the back corner, generously spaced.
    base = props.slice(0, 12).map((t, i) => ({ t, c: 1.6 + (i % 3) * 2.4, r: 1.4 + Math.floor(i / 3) * 1.9 }));
  } else {
    base = THEME_DECOR[theme] ?? THEME_DECOR.generic;
  }
  const scaled = base.map((d) => ({
    t: d.t,
    c: Math.round(d.c * k * 100) / 100,
    r: Math.round(d.r * k * 100) / 100,
    ...(d.s !== undefined || size === 'S' ? { s: Math.round((d.s ?? 1) * (size === 'S' ? 0.9 : 1) * 100) / 100 } : {}),
  }));
  return size === 'L' ? [...scaled, ...L_FILLER] : scaled;
}

// ── plugins.list → room specs ─────────────────────────────────────────────

/** True when this plugin currently owns a room on the map. */
export function pluginHasRoom(p: PluginRoomSource): boolean {
  if (p.manifestVersion !== 2 || !p.contributes?.mapRoom) return false;
  const loaded = p.status ? p.status === 'loaded' : p.enabled !== false;
  if (!loaded) return false;
  return !(p.disabledContributions ?? []).includes(`mapRoom:${p.id}`);
}

export function roomSpecFromPlugin(p: PluginRoomSource): PluginRoomSpec | null {
  if (!pluginHasRoom(p)) return null;
  const mr = p.contributes!.mapRoom!;
  const theme: RoomTheme = isTheme(mr.theme) ? mr.theme : 'generic';
  const size: RoomSize = isSize(mr.size) ? mr.size : 'M';
  const placement: RoomPlacement = isPlacement(mr.placement) ? mr.placement : 'auto';
  const title = (mr.title ?? p.name ?? p.id).trim().slice(0, 24) || p.id;
  const pages = p.contributes?.pages ?? [];
  const nav = p.contributes?.nav ?? [];
  // The plugin's MAIN page: its root route (`/<id>`), else the shortest
  // route among its nav entries, else the first nav entry / page.
  const root = pages.find((pg) => pg.route === `/${p.id}`);
  const navPages = nav.map((n) => pages.find((pg) => pg.tab === n.tab)).filter((pg): pg is { tab: string; route: string } => !!pg);
  const shortestNav = navPages.slice().sort((a, b) => a.route.length - b.route.length)[0];
  const openTab = root?.tab ?? shortestNav?.tab ?? nav[0]?.tab ?? pages[0]?.tab;
  return {
    id: `plugin:${p.id}`,
    pluginId: p.id,
    title,
    subtitle: `plugin · ${THEME_LABEL[theme]}`,
    theme,
    size,
    placement,
    accent: resolveRoomAccent(theme, mr.accent),
    monogram: (p.appearance?.monogram ?? monogramFor(p.name || p.id)).slice(0, 3).toUpperCase(),
    decor: decorForRoom(theme, size, mr.props),
    ...(openTab ? { openTab } : {}),
    routes: pages.map((pg) => pg.route).filter((r): r is string => typeof r === 'string' && r.startsWith('/')),
  };
}

/** Room specs for a plugins.list response, sorted by plugin id (stable). */
export function roomSpecsFromPluginList(items: readonly PluginRoomSource[]): PluginRoomSpec[] {
  const out: PluginRoomSpec[] = [];
  const seen = new Set<string>();
  for (const p of items) {
    if (!p?.id || seen.has(p.id)) continue;
    const spec = roomSpecFromPlugin(p);
    if (!spec) continue;
    seen.add(p.id);
    out.push(spec);
  }
  return out.sort((a, b) => (a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0));
}

/** Sector id ↔ plugin id helpers. */
export function roomSectorId(pluginId: string): string {
  return `plugin:${pluginId}`;
}
export function pluginIdOfSector(sectorId: string | null | undefined): string | null {
  return sectorId && sectorId.startsWith('plugin:') ? sectorId.slice(7) : null;
}

// ── Placement: the Plugin District ring ───────────────────────────────────

export interface TileRect {
  c: number;
  r: number;
  w: number;
  h: number;
}

/** The core station footprint (sector-layout.ts STATION_GRID). */
export const CORE_GRID = 24;
/** Tiles between the core edge and ring-1 rooms (transit loop runs here). */
export const DISTRICT_GAP = 3;
/** Slot footprint (an M room fills it). */
export const SLOT_TILES = 8;
/** Slot pitch along a side (8 room + 3 gap). L rooms overflow 1 tile each way. */
export const SLOT_PITCH = 11;
/** Rings the planner will grow to before giving up (6 rings ≈ 200 rooms). */
export const MAX_RINGS = 6;

/**
 * Areas the district must keep clear. The Executive Suite pad (sector-
 * layout.ts) floats at world (+640,−330), i.e. grid ≈ (8.7…14.7, −11.3…−5.3),
 * over the north side of ring 1.
 */
export const RESERVED_RECTS: ReadonlyArray<TileRect & { id: string }> = [
  { id: 'executive-suite', c: 8.4, r: -11.6, w: 6.6, h: 6.6 },
];

/** Gateway Concourse centre (sector-layout.ts: c 8–16, r 16–24). */
export const CONCOURSE_CENTER = { c: 12, r: 20 };
/** Where the district trunk meets the concourse (its south-east edge midpoint). */
export const CONCOURSE_GATE = { c: 12, r: 24 };

export interface DistrictSlot {
  /** Fill-order index (0 = nearest the Gateway Concourse). */
  index: number;
  ring: number;
  side: RoomSide;
  /** Top-left tile of the 8×8 slot. */
  c: number;
  r: number;
}

export interface PlacedRoom extends TileRect {
  spec: PluginRoomSpec;
  slot: DistrictSlot;
  side: RoomSide;
  ring: number;
}

/** Rooms overlap when their interiors intersect (touching edges are fine). */
export function rectsOverlap(a: TileRect, b: TileRect): boolean {
  return a.c < b.c + b.w && b.c < a.c + a.w && a.r < b.r + b.h && b.r < a.r + a.h;
}

const round05 = (v: number) => Math.round(v * 2) / 2;

/**
 * Slot positions along one side's interior span [lo, hi] (already clear of
 * the corner slots): as many 8-tile slots as fit at the ring pitch, centred
 * in each free sub-span. `blockers` are reserved intervals (e.g. the
 * Executive Suite pad) — slots keep 1.5 tiles clear of them, so a reserved
 * pad is flanked symmetrically instead of leaving a dead slot.
 */
export function interiorPositions(lo: number, hi: number, blockers: ReadonlyArray<readonly [number, number]>): number[] {
  let spans: Array<[number, number]> = [[lo, hi]];
  for (const [b0, b1] of blockers) {
    const x0 = b0 - 1.5;
    const x1 = b1 + 1.5;
    const next: Array<[number, number]> = [];
    for (const [s0, s1] of spans) {
      if (x1 <= s0 || x0 >= s1) { next.push([s0, s1]); continue; }
      if (x0 > s0) next.push([s0, x0]);
      if (x1 < s1) next.push([x1, s1]);
    }
    spans = next;
  }
  const out: number[] = [];
  const gap = SLOT_PITCH - SLOT_TILES;
  for (const [s0, s1] of spans) {
    const len = s1 - s0;
    if (len < SLOT_TILES) continue;
    const n = Math.floor((len + gap) / SLOT_PITCH);
    const width = n * SLOT_TILES + (n - 1) * gap;
    const start = s0 + (len - width) / 2;
    for (let i = 0; i < n; i++) out.push(round05(start + i * SLOT_PITCH));
  }
  return out;
}

/** Reserved c-intervals (rows) or r-intervals (columns) crossing a band. */
function blockersAcross(axis: 'row' | 'col', band: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const res of RESERVED_RECTS) {
    const crosses = axis === 'row'
      ? res.r < band + SLOT_TILES && res.r + res.h > band
      : res.c < band + SLOT_TILES && res.c + res.w > band;
    if (!crosses) continue;
    out.push(axis === 'row' ? [res.c, res.c + res.w] : [res.r, res.r + res.h]);
  }
  return out;
}

/**
 * Raw slots of one ring, before fill ordering. Each side owns one corner
 * (its clockwise vertex: north→top, east→right, south→bottom, west→left),
 * so ring 1 gives every side the same 3 slots; interiors fill symmetrically
 * about the core centre (ring 1: 2.5 / 13.5 → centred on 12).
 */
function rawRingSlots(ring: number): Array<Omit<DistrictSlot, 'index'>> {
  const outer = CORE_GRID + DISTRICT_GAP + (ring - 1) * SLOT_PITCH;
  const inner = -(DISTRICT_GAP + SLOT_TILES) - (ring - 1) * SLOT_PITCH;
  const lo = inner + SLOT_TILES + 1;
  const hi = outer - 1;
  const out: Array<Omit<DistrictSlot, 'index'>> = [];
  out.push({ ring, side: 'north', c: inner, r: inner }); // top vertex
  out.push({ ring, side: 'east', c: outer, r: inner });  // right vertex
  out.push({ ring, side: 'south', c: outer, r: outer }); // bottom vertex
  out.push({ ring, side: 'west', c: inner, r: outer });  // left vertex
  for (const c of interiorPositions(lo, hi, blockersAcross('row', outer))) out.push({ ring, side: 'south', c, r: outer });
  for (const c of interiorPositions(lo, hi, blockersAcross('row', inner))) out.push({ ring, side: 'north', c, r: inner });
  for (const r of interiorPositions(lo, hi, blockersAcross('col', outer))) out.push({ ring, side: 'east', c: outer, r });
  for (const r of interiorPositions(lo, hi, blockersAcross('col', inner))) out.push({ ring, side: 'west', c: inner, r });
  return out;
}

const SIDE_ORDER: Record<RoomSide, number> = { south: 0, east: 1, west: 2, north: 3 };

/**
 * Every slot of rings 1..maxRing in fill order: nearest the Gateway Concourse
 * first (so the first plugins land next to the fleet's front door), ties by
 * side (S, E, W, N) then position. Deterministic.
 */
export function districtSlots(maxRing = 1): DistrictSlot[] {
  const raw: Array<Omit<DistrictSlot, 'index'>> = [];
  for (let ring = 1; ring <= maxRing; ring++) raw.push(...rawRingSlots(ring));
  const dist = (s: Omit<DistrictSlot, 'index'>) =>
    Math.hypot(s.c + SLOT_TILES / 2 - CONCOURSE_CENTER.c, s.r + SLOT_TILES / 2 - CONCOURSE_CENTER.r);
  raw.sort((a, b) => {
    if (a.ring !== b.ring) return a.ring - b.ring;
    const d = dist(a) - dist(b);
    if (Math.abs(d) > 1e-6) return d;
    if (SIDE_ORDER[a.side] !== SIDE_ORDER[b.side]) return SIDE_ORDER[a.side] - SIDE_ORDER[b.side];
    return a.c - b.c || a.r - b.r;
  });
  return raw.map((s, index) => ({ ...s, index }));
}

/** The tile rect a room of `size` occupies when centred in `slot`. */
export function roomRectInSlot(slot: Pick<DistrictSlot, 'c' | 'r'>, size: RoomSize): TileRect {
  const tiles = ROOM_TILES[size];
  const off = (SLOT_TILES - tiles) / 2;
  return { c: slot.c + off, r: slot.r + off, w: tiles, h: tiles };
}

/**
 * Place rooms on the district ring.
 *
 * Deterministic: the same spec list always yields the same layout. Sticky: a
 * room keeps its slot across re-plans while the slot stays valid (pass the
 * previous plan), so enabling a new plugin never shuffles existing rooms.
 * A room takes the first free slot in fill order — on its preferred side
 * when it has one and that side has room — whose footprint is clear of the
 * core, the reserved pads and every room already placed. Rings are added as
 * needed.
 */
export function planDistrict(
  specs: readonly PluginRoomSpec[],
  previous?: ReadonlyMap<string, PlacedRoom>,
): Map<string, PlacedRoom> {
  const placed = new Map<string, PlacedRoom>();
  const blocked: TileRect[] = [
    { c: 0, r: 0, w: CORE_GRID, h: CORE_GRID },
    ...RESERVED_RECTS.map(({ c, r, w, h }) => ({ c, r, w, h })),
  ];
  const usedSlots = new Set<string>();
  const slotKey = (s: Pick<DistrictSlot, 'ring' | 'side' | 'c' | 'r'>) => `${s.ring}:${s.side}:${s.c}:${s.r}`;
  const ordered = [...specs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const fits = (rect: TileRect) => blocked.every((b) => !rectsOverlap(rect, b));
  const commit = (spec: PluginRoomSpec, slot: DistrictSlot, rect: TileRect) => {
    const room: PlacedRoom = { spec, slot, side: slot.side, ring: slot.ring, ...rect };
    placed.set(spec.id, room);
    blocked.push(rect);
    usedSlots.add(slotKey(slot));
  };

  // 1) Sticky pass: keep valid previous placements (same size + slot free).
  if (previous) {
    for (const spec of ordered) {
      const prev = previous.get(spec.id);
      if (!prev || prev.spec.size !== spec.size || prev.spec.placement !== spec.placement) continue;
      const rect = roomRectInSlot(prev.slot, spec.size);
      if (usedSlots.has(slotKey(prev.slot)) || !fits(rect)) continue;
      commit(spec, prev.slot, rect);
    }
  }

  // 2) Fresh placements: first every room onto its PREFERRED side (id order),
  //    then the rest — so a full side spills over into free slots elsewhere
  //    without stealing a later plugin's preferred slot.
  let slots = districtSlots(1);
  let ring = 1;
  const tryList = (spec: PluginRoomSpec, list: DistrictSlot[]) => {
    for (const slot of list) {
      if (usedSlots.has(slotKey(slot))) continue;
      const rect = roomRectInSlot(slot, spec.size);
      if (!fits(rect)) continue;
      commit(spec, slot, rect);
      return true;
    }
    return false;
  };
  for (const spec of ordered) {
    if (placed.has(spec.id) || spec.placement === 'auto') continue;
    tryList(spec, slots.filter((s) => s.side === spec.placement));
  }
  for (const spec of ordered) {
    if (placed.has(spec.id)) continue;
    let done = false;
    while (!done) {
      if (spec.placement !== 'auto' && tryList(spec, slots.filter((s) => s.side === spec.placement))) {
        done = true;
      } else if (tryList(spec, slots)) {
        done = true;
      } else if (ring < MAX_RINGS) {
        ring++;
        slots = districtSlots(ring);
      } else {
        break; // no room left — the plugin simply has no room on the map
      }
    }
  }
  return placed;
}

// ── Conduits: transit loop + stubs + trunk ────────────────────────────────

export interface TileSegment {
  kind: 'loop' | 'stub' | 'spoke' | 'trunk';
  a: { c: number; r: number };
  b: { c: number; r: number };
  /** Room the stub serves (stubs only). */
  roomId?: string;
}

/** Centre-lines of a ring's transit loop (a diamond in tile space). */
export function loopLines(ring: number): { outer: number; inner: number } {
  return {
    outer: CORE_GRID + DISTRICT_GAP / 2 + (ring - 1) * SLOT_PITCH,
    inner: -DISTRICT_GAP / 2 - (ring - 1) * SLOT_PITCH,
  };
}

/** The point on a room's core-facing edge where its stub starts. */
export function roomDoor(room: PlacedRoom): { c: number; r: number } {
  switch (room.side) {
    case 'east': return { c: room.c, r: room.r + room.h / 2 };
    case 'west': return { c: room.c + room.w, r: room.r + room.h / 2 };
    case 'north': return { c: room.c + room.w / 2, r: room.r + room.h };
    case 'south': return { c: room.c + room.w / 2, r: room.r };
  }
}

/**
 * Corridor geometry for a placed district: one loop per ring in use, a stub
 * from each room's door to its loop, spokes joining consecutive loops at the
 * side midpoints, and the trunk from loop 1 into the Gateway Concourse.
 */
export function districtConduits(rooms: Iterable<PlacedRoom>): TileSegment[] {
  const list = [...rooms];
  const rings = Math.max(1, ...list.map((r) => r.ring));
  const out: TileSegment[] = [];
  for (let ring = 1; ring <= rings; ring++) {
    const { outer, inner } = loopLines(ring);
    const pts = [
      { c: inner, r: inner },
      { c: outer, r: inner },
      { c: outer, r: outer },
      { c: inner, r: outer },
    ];
    for (let i = 0; i < 4; i++) out.push({ kind: 'loop', a: pts[i], b: pts[(i + 1) % 4] });
    if (ring > 1) {
      const prev = loopLines(ring - 1);
      const mid = (prev.inner + prev.outer) / 2;
      out.push({ kind: 'spoke', a: { c: mid, r: prev.outer }, b: { c: mid, r: outer } });
      out.push({ kind: 'spoke', a: { c: prev.outer, r: mid }, b: { c: outer, r: mid } });
      out.push({ kind: 'spoke', a: { c: mid, r: prev.inner }, b: { c: mid, r: inner } });
      out.push({ kind: 'spoke', a: { c: prev.inner, r: mid }, b: { c: inner, r: mid } });
    }
  }
  for (const room of list) {
    const door = roomDoor(room);
    const { outer, inner } = loopLines(room.ring);
    const b =
      room.side === 'east' ? { c: outer, r: door.r }
      : room.side === 'west' ? { c: inner, r: door.r }
      : room.side === 'north' ? { c: door.c, r: inner }
      : { c: door.c, r: outer };
    out.push({ kind: 'stub', a: door, b, roomId: room.spec.id });
  }
  out.push({ kind: 'trunk', a: CONCOURSE_GATE, b: { c: CONCOURSE_GATE.c, r: loopLines(1).outer } });
  return out;
}

/** Tile-space bounds of a placed district (for zoom-to-fit). */
export function districtBounds(rooms: Iterable<PlacedRoom>): TileRect | null {
  let minC = Infinity, minR = Infinity, maxC = -Infinity, maxR = -Infinity;
  for (const room of rooms) {
    minC = Math.min(minC, room.c);
    minR = Math.min(minR, room.r);
    maxC = Math.max(maxC, room.c + room.w);
    maxR = Math.max(maxR, room.r + room.h);
  }
  if (!isFinite(minC)) return null;
  return { c: minC, r: minR, w: maxC - minC, h: maxR - minR };
}
