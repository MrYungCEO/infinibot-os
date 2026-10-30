/**
 * Agent spread: spread working agents across the whole Galactic HQ office
 * instead of letting them bunch up in Agent Quarters / Engineering Bay.
 *
 * Pure logic, no Pixi, so it can be unit-tested in node. Four parts:
 *
 *  1. classifyAgentDomain: what kind of work an agent is doing (coding,
 *     research, planning, comms, media, files, design, orchestration), read
 *     from its recent tool calls, its task label, its agent id and whether
 *     it is a coder CLI run.
 *  2. SpreadPlanner: gives each working agent a sector (domain → sector,
 *     soft capacity per sector, overflow to the nearest sector with room)
 *     and a distinct workstation slot inside it. Assignments are sticky: an
 *     agent only moves when it has wanted another sector for `dwellMs` and
 *     has stayed at least `minStayMs` where it is, so agents don't bounce
 *     between sectors on every tool call.
 *  3. computeWorkSlots: workstation slots per sector: the seat in front of
 *     every desk/console first, then free floor away from the props, ordered
 *     so the first few agents in a sector sit far apart.
 *  4. separationOffsets / relaxPoints: spatial-hash separation, so sprites
 *     never overlap even while walking or when a sector overflows its slots.
 *
 * The engine glue lives in agent-spread-driver.ts.
 */

// ── Domains ────────────────────────────────────────────────────────────────

export type WorkDomain =
  | 'code'
  | 'research'
  | 'planning'
  | 'comms'
  | 'media'
  | 'files'
  | 'design'
  | 'orchestration'
  | 'agents';

/** Domain → home sector on the station floorplan (iso/sector-layout.ts). */
export const DOMAIN_SECTOR: Record<WorkDomain, string> = {
  code: 'engineering-bay',
  research: 'observatory',
  planning: 'mission-control',
  comms: 'comms-deck',
  media: 'broadcast-studio',
  files: 'the-vault',
  design: 'canvas-atrium',
  orchestration: 'command-atrium',
  agents: 'agent-quarters',
};

/** Sectors agents can work in. The Gateway Concourse is the rest area (beds). */
export const WORK_SECTOR_IDS: readonly string[] = [
  'engineering-bay',
  'observatory',
  'mission-control',
  'comms-deck',
  'broadcast-studio',
  'the-vault',
  'canvas-atrium',
  'command-atrium',
  'agent-quarters',
];

// Ordered: the first matching rule wins, so narrower domains come first.
const TEXT_RULES: Array<[WorkDomain, RegExp]> = [
  ['orchestration', /\b(orchestrat\w*|coordinat\w*|delegat\w*|dispatch\w*|supervis\w*|federat\w*|overseer|fan[- ]?out)\b/],
  ['planning', /\b(plan|plans|planning|roadmap|kanban|backlog|schedul\w*|cron|sprint|triage|prioriti\w*|standup|milestone|okrs?)\b/],
  ['media', /\b(video|voice|audio|tts|stt|podcast|reels?|broadcast\w*|music|sound|narrat\w*|transcri\w*|hyperframes?|remotion)\b/],
  ['design', /\b(design\w*|ui|ux|css|styl\w*|canvas|figma|logos?|images?|visuals?|layout|mockups?|brand\w*|landing|carousel|thumbnails?|restyle|theme)\b/],
  ['comms', /\b(telegram|whatsapp|e-?mails?|inbox|slack|discord|messag\w*|outreach|repl(y|ies)|dms?|notif\w*|sms|leads?|crm|clients?|newsletter)\b/],
  ['research', /\b(research\w*|search\w*|scrap\w*|crawl\w*|brows\w*|web|investigat\w*|analy\w*|reports?|benchmark\w*|compar\w*|stud(y|ies)|metrics|insights?|dossier|intel)\b/],
  ['files', /\b(docs?|documentation|files?|configs?|secrets?|vault|backups?|archiv\w*|logs?|migrat\w*|database|db|audit\w*|security|cleanup|clean up|notes?)\b/],
  ['code', /\b(fix\w*|bugs?|refactor\w*|tests?|build\w*|deploy\w*|ship\w*|implement\w*|code|coding|compil\w*|lint\w*|typescript|api|endpoints?|features?|merge|prs?|commits?|release\w*|port|rpc)\b/],
  ['agents', /\b(prompts?|agents?|sessions?|persona|skills?|memory|tun(e|ing))\b/],
];

// Roster agent ids → domain (agent ids are short slugs: main, cmo, scout …).
const AGENT_ID_RULES: Array<[WorkDomain, RegExp]> = [
  ['orchestration', /^(main|overseer|orchestrator|opus|head-of-dev)$/],
  ['comms', /(cmo|outreach|inbox|client|telegram)/],
  ['research', /(scout|monitor|research|analyst)/],
  ['design', /(design|brand|graphic|webdev)/],
  ['media', /(video|script|content|voice)/],
  ['files', /(archivist|ledger|vault)/],
  ['code', /(coder|dev|qa|engineer)/],
];

/** Tool kind → domain. Coder CLI runs read/edit/run code all day, so for them
 *  file tools count as coding rather than vault / canvas work. */
export function domainForToolKind(kind: string, isCoder: boolean): WorkDomain | null {
  const k = (kind || '').toLowerCase();
  if (!k) return null;
  if (/web|fetch|http|url|curl|download|browser|search_web|websearch/.test(k)) return 'research';
  if (/think|reason|plan|todo|analy/.test(k)) return 'planning';
  if (/telegram|message|send|email|notify|slack|discord|whatsapp/.test(k)) return 'comms';
  if (/image|video|tts|speech|audio|render/.test(k)) return 'media';
  if (/spawn|subagent|delegate|claude_coder|sessions_/.test(k)) return 'orchestration';
  if (/bash|exec|shell|run|command|terminal|\bcmd\b|script|test|build/.test(k)) return 'code';
  if (/read|list|cat|grep|glob|search|view|\bls\b|find/.test(k)) return isCoder ? 'code' : 'files';
  if (/write|edit|multiedit|create|update|patch|apply|insert|mkdir|notebook/.test(k)) return isCoder ? 'code' : 'files';
  return null;
}

export function domainForText(text: string | undefined | null): WorkDomain | null {
  const t = (text || '').toLowerCase();
  if (!t.trim()) return null;
  for (const [domain, re] of TEXT_RULES) if (re.test(t)) return domain;
  return null;
}

export function domainForAgentId(agentId: string | undefined | null): WorkDomain | null {
  const id = (agentId || '').toLowerCase();
  if (!id) return null;
  for (const [domain, re] of AGENT_ID_RULES) if (re.test(id)) return domain;
  return null;
}

export interface SpreadAgentInput {
  key: string;
  label?: string;
  currentTask?: string;
  agentId?: string;
  /** Coder CLI backend, when this is a coder run. */
  backend?: string | null;
  /** Latest tool kind + when it fired (ms, same clock as `now`). */
  toolKind?: string;
  toolAt?: number;
  /** Explicit target sector (a plugin room, `plugin:<id>`): overrides the
   *  domain → core-sector mapping while the sector exists in the planner. */
  wantSector?: string | null;
}

/** A tool call counts as "what the agent is doing now" for this long. */
export const TOOL_SIGNAL_TTL_MS = 20_000;

/**
 * What kind of work is this agent doing? Recent tool calls win (live signal),
 * then the task label, then the agent's roster id, then "coder runs code".
 * Null = no signal, so the planner places it wherever there is most room.
 */
export function classifyAgentDomain(a: SpreadAgentInput, now: number): WorkDomain | null {
  const isCoder = !!a.backend;
  if (a.toolKind && a.toolAt !== undefined && now - a.toolAt <= TOOL_SIGNAL_TTL_MS) {
    const d = domainForToolKind(a.toolKind, isCoder);
    if (d) return d;
  }
  const fromText = domainForText(a.currentTask) ?? domainForText(a.label);
  if (fromText) return fromText;
  const fromId = a.agentId && a.agentId !== 'main' ? domainForAgentId(a.agentId) : null;
  if (fromId) return fromId;
  if (isCoder) return 'code';
  return null;
}

// ── Sectors + capacity ─────────────────────────────────────────────────────

/** Tile-space rect of a sector (same shape as SectorDef in sector-layout.ts). */
export interface SpreadSectorDef {
  id: string;
  c: number;
  r: number;
  w: number;
  h: number;
}

/** Soft capacity: one agent per 4×4 tiles (8×8 sector → 4, 8×4 → 2). */
export function softCapacity(def: SpreadSectorDef): number {
  return Math.max(2, Math.floor((def.w * def.h) / 16));
}

function sectorCenterTile(def: SpreadSectorDef): { c: number; r: number } {
  return { c: def.c + def.w / 2, r: def.r + def.h / 2 };
}

// ── Planner ────────────────────────────────────────────────────────────────

export interface SpreadAssignment {
  sectorId: string;
  /** Workstation slot index inside the sector (≥ slot count = overflow ring). */
  slot: number;
  domain: WorkDomain | null;
}

export interface SpreadPlannerOptions {
  sectors: SpreadSectorDef[];
  /** Workstation slot count per sector (from computeWorkSlots). */
  slotCounts?: Record<string, number>;
  /** Per-sector capacity override. Defaults to softCapacity(def). */
  capacity?: Record<string, number>;
  /** How long an agent must keep wanting another sector before it moves. */
  dwellMs?: number;
  /** Minimum time an agent stays in a sector after arriving. */
  minStayMs?: number;
}

interface AgentState {
  sectorId: string;
  slot: number;
  domain: WorkDomain | null;
  since: number;
  pendingSector: string | null;
  pendingSince: number;
}

export const SPREAD_DWELL_MS = 8_000;
export const SPREAD_MIN_STAY_MS = 6_000;

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class SpreadPlanner {
  private readonly sectors = new Map<string, SpreadSectorDef>();
  private readonly capacity = new Map<string, number>();
  private readonly slotCounts: Record<string, number>;
  private readonly dwellMs: number;
  private readonly minStayMs: number;
  private readonly state = new Map<string, AgentState>();

  constructor(opts: SpreadPlannerOptions) {
    for (const def of opts.sectors) {
      if (!WORK_SECTOR_IDS.includes(def.id)) continue;
      this.sectors.set(def.id, def);
      this.capacity.set(def.id, opts.capacity?.[def.id] ?? softCapacity(def));
    }
    this.slotCounts = opts.slotCounts ?? {};
    this.dwellMs = opts.dwellMs ?? SPREAD_DWELL_MS;
    this.minStayMs = opts.minStayMs ?? SPREAD_MIN_STAY_MS;
  }

  /**
   * Add (or update) a dynamic work sector — a plugin room. Agents whose
   * `wantSector` names it are routed there; unclassified agents may also
   * overflow into it. Capacity defaults to the room's soft capacity.
   */
  addSector(def: SpreadSectorDef, capacity?: number): void {
    this.sectors.set(def.id, def);
    this.capacity.set(def.id, capacity ?? softCapacity(def));
  }

  /** Remove a dynamic sector; its occupants are re-planned on the next update. */
  removeSector(id: string): void {
    if (WORK_SECTOR_IDS.includes(id)) return;
    this.sectors.delete(id);
    this.capacity.delete(id);
    for (const [key, s] of this.state) if (s.sectorId === id) this.state.delete(key);
  }

  hasSector(id: string): boolean {
    return this.sectors.has(id);
  }

  sectorIds(): string[] {
    return [...this.sectors.keys()];
  }

  /** Where the agent wants to be: explicit plugin room first, then its domain's core sector. */
  private wantedSector(a: SpreadAgentInput, domain: WorkDomain | null): string | null {
    if (a.wantSector && this.sectors.has(a.wantSector)) return a.wantSector;
    return domain ? DOMAIN_SECTOR[domain] : null;
  }

  /** Current assignment for an agent, if it has one. */
  get(key: string): SpreadAssignment | undefined {
    const s = this.state.get(key);
    return s ? { sectorId: s.sectorId, slot: s.slot, domain: s.domain } : undefined;
  }

  /** Occupant count per sector. */
  loads(): Map<string, number> {
    const m = new Map<string, number>();
    for (const id of this.sectors.keys()) m.set(id, 0);
    this.state.forEach((s) => m.set(s.sectorId, (m.get(s.sectorId) ?? 0) + 1));
    return m;
  }

  forget(key: string): void {
    this.state.delete(key);
  }

  clear(): void {
    this.state.clear();
  }

  /**
   * Reconcile assignments with the current set of working agents. Agents not
   * in `agents` are dropped (their slots free up). Returns every assignment.
   */
  update(agents: SpreadAgentInput[], now: number): Map<string, SpreadAssignment> {
    const live = new Set(agents.map((a) => a.key));
    for (const key of [...this.state.keys()]) if (!live.has(key)) this.state.delete(key);

    const loads = this.loads();
    // Stable order: identical input → identical layout across refreshes.
    const ordered = [...agents].sort((a, b) => hash32(a.key) - hash32(b.key) || (a.key < b.key ? -1 : 1));

    // 1) Existing agents: sticky, with hysteresis before any move.
    for (const a of ordered) {
      const s = this.state.get(a.key);
      if (!s) continue;
      // Sector vanished (plugin room dissolved) → treat as a new arrival.
      if (!this.sectors.has(s.sectorId)) { this.state.delete(a.key); continue; }
      const domain = classifyAgentDomain(a, now);
      const want = this.wantedSector(a, domain);
      if (!want || want === s.sectorId || !this.sectors.has(want)) {
        s.pendingSector = null;
        if (domain) s.domain = domain;
        continue;
      }
      if (s.pendingSector !== want) {
        s.pendingSector = want;
        s.pendingSince = now;
        continue;
      }
      // A plugin-room target is an explicit work signal: move after the
      // minimum stay, without the extra domain-flap dwell.
      const explicit = a.wantSector === want;
      if ((!explicit && now - s.pendingSince < this.dwellMs) || now - s.since < this.minStayMs) continue;
      // Only move into the sector it actually wants, and only if there's room
      // there — never bounce to a third "overflow" sector mid-task.
      s.pendingSector = null;
      if ((loads.get(want) ?? 0) >= (this.capacity.get(want) ?? 0)) continue;
      const target = want;
      loads.set(s.sectorId, (loads.get(s.sectorId) ?? 1) - 1);
      loads.set(target, (loads.get(target) ?? 0) + 1);
      s.sectorId = target;
      s.slot = this.freeSlot(target, a.key);
      s.domain = domain;
      s.since = now;
    }

    // 2) New agents: domain sector if it has room, else the nearest one that does.
    for (const a of ordered) {
      if (this.state.has(a.key)) continue;
      const domain = classifyAgentDomain(a, now);
      const want = this.wantedSector(a, domain);
      const target = want && this.sectors.has(want) ? this.pickSector(want, loads, null) : this.leastLoaded(loads, a.key);
      loads.set(target, (loads.get(target) ?? 0) + 1);
      this.state.set(a.key, {
        sectorId: target,
        slot: this.freeSlot(target, a.key),
        domain,
        since: now,
        pendingSector: null,
        pendingSince: now,
      });
    }

    const out = new Map<string, SpreadAssignment>();
    this.state.forEach((s, key) => out.set(key, { sectorId: s.sectorId, slot: s.slot, domain: s.domain }));
    return out;
  }

  /** `want` if under capacity, else the nearest sector with room, else the
   *  least-full one. `current` counts as having room for the agent itself. */
  private pickSector(want: string, loads: Map<string, number>, current: string | null): string {
    const hasRoom = (id: string) => (loads.get(id) ?? 0) - (id === current ? 1 : 0) < (this.capacity.get(id) ?? 0);
    if (hasRoom(want)) return want;
    const wantDef = this.sectors.get(want)!;
    const wc = sectorCenterTile(wantDef);
    const byDistance = [...this.sectors.values()]
      .filter((d) => d.id !== want && WORK_SECTOR_IDS.includes(d.id))
      .map((d) => {
        const c = sectorCenterTile(d);
        return { id: d.id, dist: Math.hypot(c.c - wc.c, c.r - wc.r) };
      })
      .sort((a, b) => a.dist - b.dist || (a.id < b.id ? -1 : 1));
    for (const { id } of byDistance) if (hasRoom(id)) return id;
    // Everything is at capacity: least full relative to its capacity.
    if (current) return current;
    return this.leastLoaded(loads, want);
  }

  /** Sector with the lowest load / capacity ratio (ties broken by a hash of the
   *  agent key, so unclassified agents fan out instead of all picking one). */
  private leastLoaded(loads: Map<string, number>, key: string): string {
    // Unclassified agents fan out across the CORE sectors only — a plugin
    // room should never fill up with agents that have nothing to do there.
    const core = [...this.sectors.keys()].filter((id) => WORK_SECTOR_IDS.includes(id));
    const ids = core.length ? core : [...this.sectors.keys()];
    const h = hash32(key);
    let best = ids[0];
    let bestScore = Infinity;
    ids.forEach((id, i) => {
      const ratio = (loads.get(id) ?? 0) / Math.max(1, this.capacity.get(id) ?? 1);
      const tie = ((h + i * 2654435761) >>> 0) / 2 ** 32 / 1000;
      const score = ratio + tie;
      if (score < bestScore) {
        bestScore = score;
        best = id;
      }
    });
    return best;
  }

  /** Lowest workstation slot in `sectorId` not held by another agent. */
  private freeSlot(sectorId: string, key: string): number {
    const taken = new Set<number>();
    this.state.forEach((s, k) => {
      if (k !== key && s.sectorId === sectorId) taken.add(s.slot);
    });
    let i = 0;
    while (taken.has(i)) i++;
    return i;
  }
}

// ── Workstation slots ──────────────────────────────────────────────────────

/** Minimal prop shape (zone-relative tile coords) — see DECOR in sector-layout. */
export interface SpreadDecorItem {
  t: string;
  c: number;
  r: number;
}

/** Props an agent can work at: the seat is just in front of them. */
const WORKSTATION_PROPS = new Set([
  'desk', 'consoleWide', 'holoTable', 'commsBoard', 'micBooth', 'easel', 'server', 'telescope', 'bigDisplay', 'safe',
  // Plugin-room props (iso/plugin-rooms.ts themes)
  'tickerBoard', 'coinPillar', 'labBench', 'cameraRig', 'dojoMat', 'shelfRack', 'drawingBoard', 'holoFrame', 'boardTable', 'waveformWall',
]);

export interface WorkSlotOptions {
  /** Keep slots this far (tiles) inside the sector edge. */
  inset?: number;
  /** Minimum distance (tiles) between a slot and a prop centre. */
  propClearance?: number;
  /** Minimum distance (tiles) between two slots. */
  slotSpacing?: number;
  /** Cap on slots returned per sector. */
  max?: number;
}

/**
 * Workstation slots for one sector, in zone-relative tile coords, ordered so
 * the first N slots are spread as far apart as possible (farthest-point
 * order). Seats in front of desks/consoles come first, then open floor.
 */
export function computeWorkSlots(
  def: Pick<SpreadSectorDef, 'w' | 'h'>,
  decor: SpreadDecorItem[],
  opts: WorkSlotOptions = {},
): Array<{ c: number; r: number }> {
  const inset = opts.inset ?? 0.9;
  const clear = opts.propClearance ?? 0.95;
  const spacing = opts.slotSpacing ?? 1.35;
  const max = opts.max ?? 10;
  const inside = (c: number, r: number) => c >= inset && r >= inset && c <= def.w - inset && r <= def.h - inset;
  const clearOfProps = (c: number, r: number, own?: SpreadDecorItem) =>
    decor.every((d) => d === own || Math.hypot(d.c - c, d.r - r) >= clear);

  const candidates: Array<{ c: number; r: number; seat: boolean }> = [];
  // Seats: in front of (toward the viewer: +c,+r) each workstation prop.
  for (const d of decor) {
    if (!WORKSTATION_PROPS.has(d.t)) continue;
    for (const [dc, dr] of [[0.95, 0.95], [1.2, 0.2], [0.2, 1.2]] as const) {
      const c = d.c + dc;
      const r = d.r + dr;
      if (inside(c, r) && clearOfProps(c, r, d)) {
        candidates.push({ c, r, seat: true });
        break;
      }
    }
  }
  // Open floor on a half-tile lattice.
  for (let r = inset; r <= def.h - inset + 1e-6; r += 0.75) {
    for (let c = inset; c <= def.w - inset + 1e-6; c += 0.75) {
      if (clearOfProps(c, r)) candidates.push({ c, r, seat: false });
    }
  }

  // Farthest-point ordering, seats first, enforcing min spacing.
  const picked: Array<{ c: number; r: number }> = [];
  const pool = (seat: boolean) => candidates.filter((p) => p.seat === seat);
  const center = { c: def.w / 2, r: def.h / 2 };
  for (const seat of [true, false]) {
    const list = pool(seat);
    while (picked.length < max) {
      let best: { c: number; r: number } | null = null;
      let bestD = -1;
      for (const p of list) {
        const dMin = picked.length
          ? Math.min(...picked.map((q) => Math.hypot(q.c - p.c, q.r - p.r)))
          : 100 - Math.hypot(p.c - center.c, p.r - center.r); // first: nearest the centre
        if (picked.length && dMin < spacing) continue;
        if (dMin > bestD) {
          bestD = dMin;
          best = p;
        }
      }
      if (!best) break;
      picked.push({ c: best.c, r: best.r });
    }
  }
  return picked;
}

// ── Separation ─────────────────────────────────────────────────────────────

export interface Pt {
  x: number;
  y: number;
}

/** Bucket points into a uniform grid (spatial hash) with `cell`-sized cells. */
function buildHash(points: Pt[], cell: number): Map<string, number[]> {
  const grid = new Map<string, number[]>();
  points.forEach((p, i) => {
    const k = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`;
    const b = grid.get(k);
    if (b) b.push(i);
    else grid.set(k, [i]);
  });
  return grid;
}

function forNeighbours(grid: Map<string, number[]>, p: Pt, cell: number, fn: (j: number) => void): void {
  const cx = Math.floor(p.x / cell);
  const cy = Math.floor(p.y / cell);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const b = grid.get(`${cx + dx},${cy + dy}`);
      if (b) for (const j of b) fn(j);
    }
  }
}

/**
 * Per-point push vectors that separate points closer than `minDist`.
 * `ySquash` < 1 measures distance on the iso floor (screen y counts double).
 * Coincident points are split deterministically by index.
 */
export function separationOffsets(points: Pt[], minDist: number, ySquash = 0.6): Pt[] {
  const out = points.map(() => ({ x: 0, y: 0 }));
  if (points.length < 2) return out;
  const sy = 1 / ySquash;
  const scaled = points.map((p) => ({ x: p.x, y: p.y * sy }));
  const grid = buildHash(scaled, minDist);
  scaled.forEach((a, i) => {
    forNeighbours(grid, a, minDist, (j) => {
      if (j <= i) return;
      const b = scaled[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let dist = Math.hypot(dx, dy);
      if (dist >= minDist) return;
      if (dist < 1e-3) {
        const ang = ((i * 7 + j * 13) % 16) * (Math.PI / 8);
        dx = Math.cos(ang);
        dy = Math.sin(ang);
        dist = 1e-3;
      }
      const push = (minDist - dist) / 2;
      const ux = dx / Math.max(dist, 1e-3);
      const uy = dy / Math.max(dist, 1e-3);
      out[i].x -= ux * push;
      out[i].y -= uy * push * ySquash;
      out[j].x += ux * push;
      out[j].y += uy * push * ySquash;
    });
  });
  return out;
}

/** Iteratively push points apart until no pair is closer than `minDist`
 *  (on the squashed iso floor) or `iterations` runs out. Returns new points. */
export function relaxPoints(points: Pt[], minDist: number, iterations = 24, ySquash = 0.6): Pt[] {
  let cur = points.map((p) => ({ ...p }));
  for (let it = 0; it < iterations; it++) {
    const off = separationOffsets(cur, minDist * 1.001, ySquash);
    let moved = false;
    cur = cur.map((p, i) => {
      if (off[i].x !== 0 || off[i].y !== 0) moved = true;
      return { x: p.x + off[i].x, y: p.y + off[i].y };
    });
    if (!moved) break;
  }
  return cur;
}

/** Smallest pairwise distance on the squashed iso floor (for tests / debug). */
export function minPairDistance(points: Pt[], ySquash = 0.6): number {
  let best = Infinity;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      best = Math.min(best, Math.hypot(points[j].x - points[i].x, (points[j].y - points[i].y) / ySquash));
    }
  }
  return best;
}
