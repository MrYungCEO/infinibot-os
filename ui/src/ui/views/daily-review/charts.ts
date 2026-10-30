/**
 * Daily Review charts — small hand-rolled SVG marks (no chart dependency) plus
 * d3's treemap layout. Conventions (dataviz method):
 *  - categorical colours follow the ENTITY (fixed project/category slots),
 *    never rank; extra entities fold into "Other";
 *  - one axis per chart, thin marks, 2px surface gaps between fills;
 *  - sequential = one gold hue light→dark for magnitude (heatmaps, calendar);
 *  - status colours (verified / needs you / failed) always ship with a label;
 *  - every mark carries `data-tip` for the shared hover tooltip.
 */
import { hierarchy, treemap, treemapSquarify } from "d3";
import { html, svg, nothing, type TemplateResult } from "lit";

// ── Colour slots (validated reference palette, dark + light steps) ──────────

const SLOTS = ["--dr-s1", "--dr-s2", "--dr-s3", "--dr-s4", "--dr-s5", "--dr-s6", "--dr-s7", "--dr-s8"] as const;

const PROJECT_SLOT: Record<string, number> = {
  InfiniBot: 0,
  KinglyVault: 1,
  VectorGames: 2,
  FlyPic: 3,
  Robovoice: 4,
};
const dynamicSlots = new Map<string, number>();

/** Stable colour for a project: known products have fixed slots. */
export function projectColor(name: string): string {
  if (name === "Other") return "var(--dr-other)";
  const fixed = PROJECT_SLOT[name];
  if (fixed !== undefined) return `var(${SLOTS[fixed]})`;
  let slot = dynamicSlots.get(name);
  if (slot === undefined) {
    // Slots 6-8 for everything else, by first appearance (stable per session).
    slot = dynamicSlots.size < 3 ? 5 + dynamicSlots.size : -1;
    dynamicSlots.set(name, slot);
  }
  return slot < 0 ? "var(--dr-other)" : `var(${SLOTS[slot]})`;
}

const CATEGORY_SLOT: Record<string, number> = { code: 0, video: 1, deploy: 2, research: 3, design: 4, ops: 5 };
export const CATEGORY_ORDER = ["code", "video", "deploy", "research", "design", "ops", "other"] as const;

export function categoryColor(name: string): string {
  const s = CATEGORY_SLOT[name];
  return s === undefined ? "var(--dr-other)" : `var(${SLOTS[s]})`;
}

export const OUTCOME_META: Record<string, { label: string; color: string }> = {
  verified: { label: "Verified", color: "var(--dr-good)" },
  unverified: { label: "Not verified", color: "var(--dr-muted)" },
  needs_you: { label: "Needs you", color: "var(--dr-warn)" },
  failed: { label: "Failed", color: "var(--dr-crit)" },
  running: { label: "Running", color: "var(--dr-gold)" },
};

/** Sequential gold ramp step (0..1) — CSS variables --dr-q0..--dr-q5. */
export function seq(v: number, max: number): string {
  if (!(v > 0) || !(max > 0)) return "var(--dr-q0)";
  const step = Math.min(5, 1 + Math.floor((v / max) * 4.999));
  return `var(--dr-q${step})`;
}

// ── Formatting ────────────────────────────────────────────────────────────────

export const fmtMoney = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`);
export const fmtHours = (min: number) => (min >= 60 ? `${(min / 60).toFixed(min >= 600 ? 0 : 1)} h` : `${Math.round(min)} min`);
export const fmtNum = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
export const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * ViewBox width for a chart that spans `fraction` of the viewport, so axis
 * text renders near its CSS size at every breakpoint instead of shrinking.
 */
export function vbw(fraction: number): number {
  const vw = typeof window === "undefined" ? 1440 : window.innerWidth;
  return Math.max(340, Math.min(1000, Math.round(vw * fraction)));
}

function esc(s: string): string {
  return s.replace(/\s+/g, " ").slice(0, 220);
}

// ── Sparkline (score vs trailing average) ─────────────────────────────────────

export function sparkline(values: number[], opts: { avg?: number; w?: number; h?: number; label: string }): TemplateResult {
  const w = opts.w ?? 220;
  const h = opts.h ?? 48;
  const n = values.length;
  if (n < 2) return html`<div class="dr-empty-mini">Not enough history yet</div>`;
  const max = Math.max(100, ...values);
  const x = (i: number) => 2 + (i * (w - 4)) / (n - 1);
  const y = (v: number) => h - 4 - (v / max) * (h - 8);
  const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const last = values[n - 1]!;
  return html`<svg class="dr-spark" viewBox="0 0 ${w} ${h}" role="img" aria-label=${opts.label}>
    ${opts.avg !== undefined
      ? svg`<line x1="0" x2=${w} y1=${y(opts.avg)} y2=${y(opts.avg)} class="dr-spark-avg" data-tip=${`Trailing average ${Math.round(opts.avg)}`}></line>`
      : nothing}
    <path d=${d} class="dr-spark-line"></path>
    ${values.map((v, i) => svg`<circle cx=${x(i)} cy=${y(v)} r="6" class="dr-hit" data-tip=${`Score ${v}`}></circle>`)}
    <circle cx=${x(n - 1)} cy=${y(last)} r="4" class="dr-spark-dot"></circle>
  </svg>`;
}

// ── Gantt / timeline ──────────────────────────────────────────────────────────

export interface GanttRun {
  runId: string;
  label: string;
  project: string;
  backend: string;
  outcome: string;
  start: number;
  end?: number;
  costUsd: number;
}

export function gantt(runs: GanttRun[], ds: number, de: number, now: number): TemplateResult {
  const W = 1000;
  const lanePad = 4;
  const laneH = 16;
  const top = 22;
  const sorted = [...runs].sort((a, b) => a.start - b.start);
  const lanes: number[] = [];
  const placed = sorted.map((r) => {
    const s = Math.max(r.start, ds);
    const e = Math.min(r.end ?? now, de);
    let lane = lanes.findIndex((endAt) => endAt <= s);
    if (lane < 0) {
      lane = lanes.length;
      lanes.push(0);
    }
    lanes[lane] = Math.max(e, s + 6 * 60_000); // minimum visual width before reuse
    return { r, s, e, lane };
  });
  const H = top + Math.max(1, lanes.length) * (laneH + lanePad) + 6;
  const x = (t: number) => ((t - ds) / (de - ds)) * W;
  const ticks = Array.from({ length: 9 }, (_, i) => i * 3);
  const showNow = now > ds && now < de;
  return html`<div class="dr-scroll"><svg class="dr-gantt" viewBox="0 0 ${W} ${H}" style="min-width:720px" role="img"
      aria-label="Timeline of agent runs, one lane per concurrent agent">
    ${ticks.map(
      (h) => svg`<line x1=${x(ds + h * 3600_000)} x2=${x(ds + h * 3600_000)} y1="16" y2=${H} class="dr-grid"></line>
        <text x=${x(ds + h * 3600_000) + 3} y="11" class="dr-axis">${String(h).padStart(2, "0")}:00</text>`,
    )}
    ${placed.map(({ r, s, e, lane }) => {
      const y = top + lane * (laneH + lanePad);
      const bw = Math.max(3, x(e) - x(s));
      const meta = OUTCOME_META[r.outcome] ?? OUTCOME_META.unverified!;
      const tip = `${esc(r.label)}\n${r.project} · ${r.backend} · ${meta.label}\n${fmtTime(r.start)}–${r.end ? fmtTime(r.end) : "now"} · ${fmtMoney(r.costUsd)}`;
      return svg`<g class="dr-bar" data-run=${r.runId} data-tip=${tip}>
        <rect x=${x(s)} y=${y} width=${bw} height=${laneH} rx="4" fill=${projectColor(r.project)}
          class=${r.outcome === "running" ? "dr-bar-running" : ""}></rect>
        <rect x=${x(s)} y=${y + laneH - 3} width=${bw} height="3" rx="1.5" fill=${meta.color}></rect>
        ${bw > 120 ? svg`<text x=${x(s) + 6} y=${y + 11} class="dr-bar-label">${r.label.slice(0, Math.floor(bw / 6.4))}</text>` : nothing}
      </g>`;
    })}
    ${showNow ? svg`<line x1=${x(now)} x2=${x(now)} y1="14" y2=${H} class="dr-now"></line><text x=${x(now) + 4} y=${H - 4} class="dr-axis dr-axis-now">now</text>` : nothing}
  </svg></div>`;
}

// ── Treemap: project → task ───────────────────────────────────────────────────

export interface TreeProject {
  name: string;
  minutes: number;
  tasks: Array<{ label: string; minutes: number; outcome: string; runId: string }>;
}

export function projectTreemap(projects: TreeProject[], w = 1000, h = 420): TemplateResult {
  const data = {
    name: "root",
    children: projects
      .filter((p) => p.minutes > 0)
      .map((p) => {
        const known = p.tasks.reduce((a, t) => a + t.minutes, 0);
        const children = p.tasks.filter((t) => t.minutes > 0).map((t) => ({ ...t, name: t.label, value: t.minutes }));
        if (p.minutes - known > 1) children.push({ name: "Other tasks", label: "Other tasks", minutes: p.minutes - known, outcome: "", runId: "", value: p.minutes - known });
        return { name: p.name, children };
      }),
  };
  if (!data.children.length) return html`<div class="dr-empty">No agent time recorded for this day.</div>`;
  const root = hierarchy<any>(data)
    .sum((d) => d.value ?? 0)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  treemap<any>().tile(treemapSquarify).size([w, h]).paddingInner(2).paddingOuter(2).paddingTop(20).round(true)(root);
  const groups = (root.children ?? []) as any[];
  return html`<svg class="dr-treemap" viewBox="0 0 ${w} ${h}" role="img" aria-label="Agent time by project and task">
    ${groups.map((g) => {
      const color = projectColor(g.data.name);
      const gw = g.x1 - g.x0;
      return svg`<g>
        <rect x=${g.x0} y=${g.y0} width=${gw} height=${g.y1 - g.y0} rx="6" class="dr-tm-group"
          data-tip=${`${g.data.name}\n${fmtHours(g.value ?? 0)} of agent time`}></rect>
        ${gw > 60 ? svg`<text x=${g.x0 + 6} y=${g.y0 + 13} class="dr-tm-head">${g.data.name.slice(0, Math.floor(gw / 7))} · ${fmtHours(g.value ?? 0)}</text>` : nothing}
        ${(g.children ?? []).map((leaf: any) => {
          const lw = leaf.x1 - leaf.x0;
          const lh = leaf.y1 - leaf.y0;
          const meta = OUTCOME_META[leaf.data.outcome];
          return svg`<g class=${leaf.data.runId ? "dr-tm-leaf dr-click" : "dr-tm-leaf"} data-run=${leaf.data.runId || ""}
              data-tip=${`${esc(leaf.data.label)}\n${g.data.name} · ${fmtHours(leaf.value ?? 0)}${meta ? ` · ${meta.label}` : ""}`}>
            <rect x=${leaf.x0} y=${leaf.y0} width=${lw} height=${lh} rx="4" fill=${color} fill-opacity="0.82"></rect>
            ${lw > 70 && lh > 26 ? svg`<text x=${leaf.x0 + 5} y=${leaf.y0 + 14} class="dr-tm-label">${leaf.data.label.slice(0, Math.floor(lw / 6.6))}</text>` : nothing}
          </g>`;
        })}
      </g>`;
    })}
  </svg>`;
}

// ── Stacked columns (24 hours × categories) ───────────────────────────────────

export function stackedHours(rows: Array<Record<string, number>>, keys: readonly string[], colorOf: (k: string) => string, unit: (v: number) => string, W = 1000): TemplateResult {
  const H = 220;
  const pad = { l: 40, b: 22, t: 8 };
  const totals = rows.map((r) => keys.reduce((a, k) => a + (r[k] ?? 0), 0));
  const max = Math.max(1, ...totals);
  const bw = (W - pad.l) / 24;
  const y = (v: number) => ((H - pad.b - pad.t) * v) / max;
  const ticks = [0, max / 2, max];
  return html`<svg class="dr-cols" viewBox="0 0 ${W} ${H}" role="img" aria-label="Stacked agent time per hour by type">
    ${ticks.map((t) => svg`<line x1=${pad.l} x2=${W} y1=${H - pad.b - y(t)} y2=${H - pad.b - y(t)} class="dr-grid"></line>
      <text x=${pad.l - 6} y=${H - pad.b - y(t) + 4} class="dr-axis" text-anchor="end">${unit(t)}</text>`)}
    ${rows.map((r, h) => {
      let acc = 0;
      return svg`<g>${keys.map((k) => {
        const v = r[k] ?? 0;
        if (v <= 0) return nothing;
        const hh = y(v);
        const yy = H - pad.b - y(acc) - hh;
        acc += v;
        return svg`<rect x=${pad.l + h * bw + 2} y=${yy + 1} width=${bw - 4} height=${Math.max(1, hh - 2)} rx="2" fill=${colorOf(k)}
          data-tip=${`${String(h).padStart(2, "0")}:00 · ${k}\n${unit(v)}`}></rect>`;
      })}${h % 3 === 0 ? svg`<text x=${pad.l + h * bw + bw / 2} y=${H - 6} class="dr-axis" text-anchor="middle">${String(h).padStart(2, "0")}</text>` : nothing}</g>`;
    })}
  </svg>`;
}

// ── Horizontal bars ───────────────────────────────────────────────────────────

export function hBars(items: Array<{ name: string; value: number; sub?: string; color: string }>, unit: (v: number) => string): TemplateResult {
  const max = Math.max(1, ...items.map((i) => i.value));
  if (!items.length) return html`<div class="dr-empty">Nothing recorded.</div>`;
  return html`<div class="dr-hbars">
    ${items.map(
      (i) => html`<div class="dr-hbar" data-tip=${`${i.name}\n${unit(i.value)}${i.sub ? ` · ${i.sub}` : ""}`}>
        <span class="dr-hbar-name">${i.name}</span>
        <span class="dr-hbar-track"><span class="dr-hbar-fill" style="width:${Math.max(1.5, (100 * i.value) / max)}%;background:${i.color}"></span></span>
        <span class="dr-hbar-val">${unit(i.value)}</span>
      </div>`,
    )}
  </div>`;
}

// ── Hour-of-day heatmap ───────────────────────────────────────────────────────

export function hourHeatmap(rows: Array<{ label: string; values: number[]; unit: (v: number) => string }>): TemplateResult {
  return html`<div class="dr-scroll"><div class="dr-heat" style="min-width:640px">
    <div class="dr-heat-row dr-heat-head"><span></span>${Array.from({ length: 24 }, (_, h) => html`<span class="dr-axis-html">${h % 3 === 0 ? String(h).padStart(2, "0") : ""}</span>`)}</div>
    ${rows.map((row) => {
      const max = Math.max(...row.values, 0);
      return html`<div class="dr-heat-row"><span class="dr-heat-label">${row.label}</span>${row.values.map(
        (v, h) => html`<span class="dr-heat-cell" style="background:${seq(v, max)}" data-tip=${`${String(h).padStart(2, "0")}:00 · ${row.label}\n${row.unit(v)}`}></span>`,
      )}</div>`;
    })}
  </div></div>`;
}

// ── Columns (single series per hour or per bucket) ────────────────────────────

export function columns(values: Array<{ label: string; value: number; tick?: string }>, opts: { unit: (v: number) => string; color?: string; h?: number; avg?: number; w?: number; onPick?: (i: number) => void }): TemplateResult {
  const W = opts.w ?? 1000;
  const H = opts.h ?? 160;
  const pad = { l: 44, b: 20, t: 6 };
  const n = Math.max(1, values.length);
  const max = Math.max(1e-9, ...values.map((v) => v.value), opts.avg ?? 0);
  const bw = (W - pad.l) / n;
  const y = (v: number) => ((H - pad.b - pad.t) * v) / max;
  const gap = n > 60 ? 0.5 : 2;
  return html`<svg class="dr-cols" viewBox="0 0 ${W} ${H}" role="img">
    ${[0, max / 2, max].map((t) => svg`<line x1=${pad.l} x2=${W} y1=${H - pad.b - y(t)} y2=${H - pad.b - y(t)} class="dr-grid"></line>
      <text x=${pad.l - 6} y=${H - pad.b - y(t) + 4} class="dr-axis" text-anchor="end">${opts.unit(t)}</text>`)}
    ${values.map((v, i) => {
      const hh = y(v.value);
      return svg`<g class=${opts.onPick ? "dr-click" : ""} @click=${opts.onPick ? () => opts.onPick!(i) : null}>
        <rect x=${pad.l + i * bw} y=${pad.t} width=${bw} height=${H - pad.b - pad.t} fill="transparent" data-tip=${`${v.label}\n${opts.unit(v.value)}`}></rect>
        ${v.value > 0 ? svg`<rect x=${pad.l + i * bw + gap} y=${H - pad.b - hh} width=${Math.max(1, bw - gap * 2)} height=${hh} rx=${bw > 10 ? 3 : 1}
          fill=${opts.color ?? "var(--dr-s1)"} pointer-events="none"></rect>` : nothing}
        ${v.tick ? svg`<text x=${pad.l + i * bw + bw / 2} y=${H - 5} class="dr-axis" text-anchor="middle">${v.tick}</text>` : nothing}
      </g>`;
    })}
    ${opts.avg !== undefined ? svg`<line x1=${pad.l} x2=${W} y1=${H - pad.b - y(opts.avg)} y2=${H - pad.b - y(opts.avg)} class="dr-spark-avg"></line>` : nothing}
  </svg>`;
}

// ── Line (score trend) with crosshair-sized hit columns ──────────────────────

export function lineTrend(values: Array<{ label: string; value: number; tick?: string }>, opts: { unit: (v: number) => string; max?: number; avgLine?: number[]; w?: number; onPick?: (i: number) => void }): TemplateResult {
  const W = opts.w ?? 1000;
  const H = 180;
  const pad = { l: 40, b: 20, t: 8 };
  const n = values.length;
  if (n < 2) return html`<div class="dr-empty">Not enough days in this range.</div>`;
  const max = opts.max ?? Math.max(1, ...values.map((v) => v.value));
  const x = (i: number) => pad.l + (i * (W - pad.l - 6)) / (n - 1);
  const y = (v: number) => H - pad.b - ((H - pad.b - pad.t) * v) / max;
  const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v.value).toFixed(1)}`).join("");
  const avg = opts.avgLine;
  const dAvg = avg ? avg.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("") : "";
  const colW = (W - pad.l) / n;
  return html`<svg class="dr-line" viewBox="0 0 ${W} ${H}" role="img">
    ${[0, max / 2, max].map((t) => svg`<line x1=${pad.l} x2=${W} y1=${y(t)} y2=${y(t)} class="dr-grid"></line>
      <text x=${pad.l - 6} y=${y(t) + 4} class="dr-axis" text-anchor="end">${opts.unit(t)}</text>`)}
    ${dAvg ? svg`<path d=${dAvg} class="dr-line-avg"></path>` : nothing}
    <path d=${d} class="dr-line-main"></path>
    ${values.map((v, i) => svg`<g class=${opts.onPick ? "dr-click" : ""} @click=${opts.onPick ? () => opts.onPick!(i) : null}>
      <rect x=${x(i) - colW / 2} y=${pad.t} width=${colW} height=${H - pad.b - pad.t} fill="transparent"
        data-tip=${`${v.label}\n${opts.unit(v.value)}${avg ? ` · 7-day avg ${opts.unit(avg[i] ?? 0)}` : ""}`}></rect>
      ${n <= 45 ? svg`<circle cx=${x(i)} cy=${y(v.value)} r="3" class="dr-line-dot" pointer-events="none"></circle>` : nothing}
      ${v.tick ? svg`<text x=${x(i)} y=${H - 5} class="dr-axis" text-anchor="middle">${v.tick}</text>` : nothing}
    </g>`)}
  </svg>`;
}

// ── Stacked area: project share over time ───────────────────────────────────

export function stackedArea(buckets: Array<{ label: string; tick?: string; parts: Record<string, number> }>, keys: string[], W = 1000): TemplateResult {
  const H = 220;
  const pad = { l: 40, b: 20, t: 8 };
  const n = buckets.length;
  if (n < 2 || !keys.length) return html`<div class="dr-empty">Not enough history for a trend.</div>`;
  const x = (i: number) => pad.l + (i * (W - pad.l - 6)) / (n - 1);
  const y = (share: number) => H - pad.b - (H - pad.b - pad.t) * share;
  const shares = buckets.map((b) => {
    const total = keys.reduce((a, k) => a + (b.parts[k] ?? 0), 0);
    return keys.map((k) => (total > 0 ? (b.parts[k] ?? 0) / total : 0));
  });
  const layers = keys.map((k, ki) => {
    const lower = shares.map((s) => s.slice(0, ki).reduce((a, v) => a + v, 0));
    const upper = shares.map((s, i) => lower[i]! + s[ki]!);
    const top = upper.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
    const bottom = lower
      .map((v, i) => [i, v] as const)
      .reverse()
      .map(([i, v]) => `L${x(i).toFixed(1)},${y(v).toFixed(1)}`)
      .join("");
    return { k, d: `${top}${bottom}Z` };
  });
  const colW = (W - pad.l) / n;
  return html`<svg class="dr-area" viewBox="0 0 ${W} ${H}" role="img" aria-label="Share of agent time by project over time">
    ${[0, 0.5, 1].map((t) => svg`<line x1=${pad.l} x2=${W} y1=${y(t)} y2=${y(t)} class="dr-grid"></line>
      <text x=${pad.l - 6} y=${y(t) + 4} class="dr-axis" text-anchor="end">${Math.round(t * 100)}%</text>`)}
    ${layers.map((l) => svg`<path d=${l.d} fill=${projectColor(l.k)} fill-opacity="0.85" class="dr-area-layer"></path>`)}
    ${buckets.map((b, i) => svg`<g>
      <rect x=${x(i) - colW / 2} y=${pad.t} width=${colW} height=${H - pad.b - pad.t} fill="transparent"
        data-tip=${`${b.label}\n${keys
          .map((k, ki) => [k, shares[i]![ki]!] as const)
          .filter(([, s]) => s > 0.005)
          .map(([k, s]) => `${k} ${Math.round(s * 100)}%`)
          .join(" · ") || "no agent time"}`}></rect>
      ${b.tick ? svg`<text x=${x(i)} y=${H - 5} class="dr-axis" text-anchor="middle">${b.tick}</text>` : nothing}
    </g>`)}
  </svg>`;
}

// ── Calendar heatmap (GitHub style) ───────────────────────────────────────────

export function calendar(days: Array<{ date: string; score: number; net: number }>, onPick: (date: string) => void, selected?: string): TemplateResult {
  if (!days.length) return html`<div class="dr-empty">No history yet.</div>`;
  const byDate = new Map(days.map((d) => [d.date, d]));
  const first = new Date(`${days[0]!.date}T12:00:00`);
  const last = new Date(`${days[days.length - 1]!.date}T12:00:00`);
  // Start on the Monday on/before the first day.
  const start = new Date(first);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const cells: Array<{ key: string; col: number; row: number; d?: { date: string; score: number; net: number } }> = [];
  const months: Array<{ col: number; label: string }> = [];
  for (let d = new Date(start), i = 0; d <= last; d.setDate(d.getDate() + 1), i++) {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const col = Math.floor(i / 7);
    const row = i % 7;
    if ((d.getDate() === 1 || i === 0) && (!months.length || col - months[months.length - 1]!.col >= 3)) {
      months.push({ col, label: d.toLocaleDateString([], { month: "short" }) });
    }
    cells.push({ key, col, row, d: byDate.get(key) });
  }
  const cols = Math.ceil(cells.length / 7);
  const c = 14;
  const g = 3;
  const W = 28 + cols * (c + g);
  const H = 18 + 7 * (c + g);
  return html`<div class="dr-scroll"><svg class="dr-cal" viewBox="0 0 ${W} ${H}" style="width:${Math.max(W, 300)}px;max-width:100%;min-width:${Math.min(W, 640)}px" role="img" aria-label="Productivity score per day">
    ${months.map((m) => svg`<text x=${28 + m.col * (c + g)} y="10" class="dr-axis">${m.label}</text>`)}
    ${["Mon", "Wed", "Fri"].map((l, i) => svg`<text x="0" y=${18 + (i * 2) * (c + g) + 11} class="dr-axis">${l}</text>`)}
    ${cells.map((cell) => {
      const v = cell.d?.score ?? 0;
      const tip = cell.d ? `${cell.key}\nScore ${v}${cell.d.net ? ` · ${cell.d.net} pts` : ""}` : `${cell.key}\nNo activity`;
      return svg`<rect x=${28 + cell.col * (c + g)} y=${18 + cell.row * (c + g)} width=${c} height=${c} rx="3"
        fill=${seq(v, 100)} class=${`dr-cal-cell dr-click${selected === cell.key ? " dr-cal-sel" : ""}`}
        data-tip=${tip} @click=${() => onPick(cell.key)}></rect>`;
    })}
  </svg></div>`;
}

// ── Legend ────────────────────────────────────────────────────────────────────

export function legend(items: Array<{ label: string; color: string; kind?: "swatch" | "line" }>): TemplateResult {
  return html`<div class="dr-legend">${items.map(
    (i) => html`<span class="dr-legend-item"><span class=${i.kind === "line" ? "dr-legend-line" : "dr-legend-sw"} style="background:${i.color}"></span>${i.label}</span>`,
  )}</div>`;
}
