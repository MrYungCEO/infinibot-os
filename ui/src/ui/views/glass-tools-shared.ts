/**
 * Shared "luxury glass" primitives for the tools pages
 * (MCP, Skills, Sessions, Integrations, Exec approvals).
 *
 * Everything is scoped under `.gt-scope` (or a `gt-*` class) so it can't leak
 * into other views, and every colour is derived from tokens that already exist
 * in base.css / theme-glass.ts (--g-*, --bg, --text, --muted, --ok …). The
 * `--gt-*` custom properties below are local aliases only, set on `.gt-scope`.
 * They read the shared glass system's `--glass-*` tokens first (docs/ui/GLASS.md
 * on feat/glass-shell) and fall back to the older tokens when it isn't loaded.
 *
 * Fallbacks:
 *   • :root.perf-mode / prefers-reduced-transparency → opaque surfaces, no blur
 *   • prefers-reduced-motion → no aurora drift, shimmer, pulse or lift
 *   • :root[data-theme="light"] → warm porcelain glass with darker gold ink
 */
import { html } from "lit";

export const GLASS_TOOLS_CSS = /* css */ `
.gt-scope {
  --gt-gold: var(--glass-gold, var(--g-primary, #fbbf24));
  --gt-gold-ink: color-mix(in srgb, var(--gt-gold) 88%, #fff 12%);
  --gt-gold-hair: color-mix(in srgb, var(--gt-gold) 55%, transparent);
  --gt-gold-faint: color-mix(in srgb, var(--gt-gold) 10%, transparent);
  --gt-fg: var(--glass-fg, var(--g-fg, var(--text-strong)));
  --gt-dim: var(--glass-fg-2, var(--g-fg-dim, var(--muted)));
  --gt-faint: var(--glass-fg-3, var(--g-fg-faint, var(--muted-strong)));
  --gt-surface:
    linear-gradient(160deg, rgba(255, 255, 255, 0.075) 0%, rgba(255, 255, 255, 0.02) 42%, rgba(255, 255, 255, 0.035) 100%);
  --gt-surface-solid: var(--glass-solid, color-mix(in srgb, var(--bg-elevated, #111) 92%, var(--gt-gold) 8%));
  --gt-line: rgba(255, 255, 255, 0.07);
  --gt-shadow:
    0 1px 0 rgba(255, 255, 255, 0.06) inset,
    0 1px 2px rgba(0, 0, 0, 0.4),
    0 8px 24px -8px rgba(0, 0, 0, 0.55),
    0 28px 64px -24px rgba(0, 0, 0, 0.7);
  --gt-shadow-hover:
    0 1px 0 rgba(255, 255, 255, 0.09) inset,
    0 2px 4px rgba(0, 0, 0, 0.4),
    0 16px 40px -10px rgba(0, 0, 0, 0.6),
    0 40px 90px -30px color-mix(in srgb, var(--gt-gold) 22%, transparent);
  --gt-radius: var(--glass-radius-lg, 18px);
  --gt-radius-sm: var(--glass-radius-sm, 12px);
  --gt-blur: blur(22px) saturate(165%);
  --gt-ease: var(--glass-ease, cubic-bezier(0.16, 1, 0.3, 1));
  --gt-focus: var(--glass-focus-ring, 0 0 0 2px var(--bg, #050505), 0 0 0 4px color-mix(in srgb, var(--gt-gold) 70%, transparent));
  position: relative;
  isolation: isolate;
  color: var(--text);
  font-family: var(--glass-font, var(--g-font-family, inherit));
}
:root[data-theme="light"] .gt-scope {
  --gt-fg: var(--glass-fg, var(--text-strong, #18181b));
  --gt-dim: var(--glass-fg-2, var(--muted-strong, #52525b));
  --gt-faint: var(--glass-fg-3, var(--muted, #71717a));
  --gt-gold: var(--glass-gold, color-mix(in srgb, var(--g-primary, #fbbf24) 70%, #7c4a03 30%));
  --gt-gold-ink: color-mix(in srgb, var(--g-primary, #fbbf24) 45%, #5b3a06 55%);
  --gt-gold-hair: color-mix(in srgb, var(--g-primary, #fbbf24) 60%, transparent);
  --gt-surface:
    linear-gradient(160deg, rgba(255, 255, 255, 0.92) 0%, rgba(255, 255, 255, 0.66) 50%, rgba(255, 252, 245, 0.8) 100%);
  --gt-surface-solid: var(--glass-solid, #fffdf8);
  --gt-line: rgba(24, 24, 27, 0.08);
  --gt-shadow:
    0 1px 0 rgba(255, 255, 255, 0.9) inset,
    0 1px 2px rgba(24, 24, 27, 0.06),
    0 10px 28px -12px rgba(24, 24, 27, 0.16),
    0 28px 60px -30px rgba(120, 80, 10, 0.18);
  --gt-shadow-hover:
    0 1px 0 rgba(255, 255, 255, 1) inset,
    0 2px 4px rgba(24, 24, 27, 0.06),
    0 18px 40px -14px rgba(24, 24, 27, 0.2),
    0 40px 80px -36px color-mix(in srgb, var(--gt-gold) 40%, transparent);
}

/* ── Aurora backdrop ─────────────────────────────────────────── */
.gt-aurora {
  position: absolute;
  inset: -40px 0 auto;
  height: 520px;
  z-index: -1;
  pointer-events: none;
  overflow: hidden;
  -webkit-mask-image: linear-gradient(180deg, #000 30%, transparent);
  mask-image: linear-gradient(180deg, #000 30%, transparent);
}
.gt-aurora::before,
.gt-aurora::after {
  content: "";
  position: absolute;
  border-radius: 50%;
  filter: blur(70px);
  opacity: 0.55;
  animation: gt-drift 22s ease-in-out infinite alternate;
}
.gt-aurora::before {
  width: 62%; height: 340px; left: 4%; top: -80px;
  background: radial-gradient(closest-side, color-mix(in srgb, var(--gt-gold) 34%, transparent), transparent);
}
.gt-aurora::after {
  width: 48%; height: 300px; right: 2%; top: -40px;
  background: radial-gradient(closest-side, color-mix(in srgb, var(--g-accent, #a855f7) 16%, transparent), transparent);
  /* Right-anchored: scale from the right edge and drift inward, so the glow
     never moves past the page's right edge. */
  transform-origin: right top;
  animation-name: gt-drift-in;
  animation-duration: 28s;
  animation-direction: alternate-reverse;
}
:root[data-theme="light"] .gt-aurora::before,
:root[data-theme="light"] .gt-aurora::after { opacity: 0.4; }
@keyframes gt-drift {
  0% { transform: translate3d(0, 0, 0) scale(1); }
  100% { transform: translate3d(6%, 26px, 0) scale(1.12); }
}
@keyframes gt-drift-in {
  0% { transform: translate3d(0, 0, 0) scale(1); }
  100% { transform: translate3d(-6%, 26px, 0) scale(1.12); }
}

/* ── Hero header ─────────────────────────────────────────────── */
.gt-hero {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  flex-wrap: wrap;
  padding: 6px 2px 22px;
}
.gt-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font: 600 10.5px/1 var(--mono);
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--gt-gold-ink);
}
.gt-eyebrow::before {
  content: "";
  width: 18px; height: 1px;
  background: linear-gradient(90deg, transparent, var(--gt-gold));
}
.gt-title {
  margin: 10px 0 6px;
  font-size: clamp(26px, 3.2vw, 38px);
  line-height: 1.05;
  font-weight: 650;
  letter-spacing: -0.025em;
  background: linear-gradient(180deg, var(--gt-fg) 30%, color-mix(in srgb, var(--gt-fg) 55%, var(--gt-gold)) 120%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.gt-sub { margin: 0; max-width: 62ch; color: var(--gt-dim); font-size: 13.5px; line-height: 1.55; }
.gt-stats { display: flex; gap: 10px; flex-wrap: wrap; }
.gt-stat {
  min-width: 96px;
  padding: 10px 14px;
  border-radius: 14px;
}
.gt-stat-value {
  display: block;
  font: 600 22px/1.1 var(--g-font-family, inherit);
  letter-spacing: -0.02em;
  color: var(--gt-fg);
  font-variant-numeric: tabular-nums;
}
.gt-stat-label {
  display: block;
  margin-top: 3px;
  font: 500 10px/1 var(--mono);
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--gt-faint);
}

/* ── Glass surface ───────────────────────────────────────────── */
.gt-glass {
  position: relative;
  background: var(--gt-surface);
  -webkit-backdrop-filter: var(--gt-blur);
  backdrop-filter: var(--gt-blur);
  border: 1px solid transparent;
  border-radius: var(--gt-radius);
  box-shadow: var(--gt-shadow);
  transition: transform 420ms var(--gt-ease), box-shadow 420ms var(--gt-ease), background 260ms ease;
}
/* hairline gold gradient border */
.gt-glass::before {
  content: "";
  position: absolute;
  inset: -1px;
  border-radius: inherit;
  padding: 1px;
  background: linear-gradient(140deg,
    var(--gt-gold-hair) 0%,
    color-mix(in srgb, var(--gt-gold) 8%, transparent) 30%,
    var(--gt-line) 55%,
    color-mix(in srgb, var(--gt-gold) 26%, transparent) 100%);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask-composite: exclude;
  pointer-events: none;
}
/* specular top edge */
.gt-glass::after {
  content: "";
  position: absolute;
  left: 14%; right: 14%; top: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.55), transparent);
  opacity: 0.55;
  pointer-events: none;
}
:root[data-theme="light"] .gt-glass::after { background: linear-gradient(90deg, transparent, #fff, transparent); opacity: 1; }
.gt-lift:hover { transform: translateY(-3px); box-shadow: var(--gt-shadow-hover); }
.gt-lift:focus-within { box-shadow: var(--gt-shadow-hover), 0 0 0 2px var(--gt-gold-faint); }

/* ── Status light ────────────────────────────────────────────── */
.gt-light {
  --gt-l: var(--g-neutral, #94a3b8);
  position: relative;
  display: inline-block;
  flex: none;
  width: 8px; height: 8px;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 30%, #fff 0 12%, var(--gt-l) 45%);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--gt-l) 16%, transparent), 0 0 12px var(--gt-l);
}
.gt-light[data-state="ok"] { --gt-l: var(--ok, #22c55e); }
.gt-light[data-state="warn"] { --gt-l: var(--warn, #f59e0b); }
.gt-light[data-state="danger"] { --gt-l: var(--danger, #ef4444); }
.gt-light[data-state="gold"] { --gt-l: var(--gt-gold); }
.gt-light[data-state="idle"] { --gt-l: var(--muted-strong, #71717a); box-shadow: 0 0 0 3px color-mix(in srgb, var(--gt-l) 14%, transparent); }
.gt-light[data-pulse]::after {
  content: "";
  position: absolute; inset: -4px;
  border-radius: 50%;
  border: 1px solid var(--gt-l);
  animation: gt-ping 2.2s var(--gt-ease) infinite;
}
@keyframes gt-ping { 0% { transform: scale(0.6); opacity: 0.9; } 100% { transform: scale(2.1); opacity: 0; } }

/* ── Chips / pills ───────────────────────────────────────────── */
.gt-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  font: 500 11px/1 var(--mono);
  letter-spacing: 0.02em;
  color: var(--gt-dim);
  background: color-mix(in srgb, var(--gt-fg) 5%, transparent);
  border: 1px solid var(--gt-line);
  white-space: nowrap;
}
.gt-chip[data-tone="gold"] { color: var(--gt-gold-ink); background: var(--gt-gold-faint); border-color: color-mix(in srgb, var(--gt-gold) 30%, transparent); }
.gt-chip[data-tone="ok"] { color: var(--ok); background: var(--ok-subtle); border-color: color-mix(in srgb, var(--ok) 30%, transparent); }
.gt-chip[data-tone="warn"] { color: var(--warn); background: var(--warn-subtle); border-color: color-mix(in srgb, var(--warn) 30%, transparent); }
.gt-chip[data-tone="danger"] { color: var(--danger); background: var(--danger-subtle); border-color: color-mix(in srgb, var(--danger) 30%, transparent); }

/* ── Segmented filter ────────────────────────────────────────── */
.gt-seg {
  display: inline-flex;
  padding: 3px;
  gap: 2px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--gt-fg) 4%, transparent);
  border: 1px solid var(--gt-line);
}
.gt-seg button {
  all: unset;
  cursor: pointer;
  padding: 6px 12px;
  border-radius: 999px;
  font: 500 11.5px/1 var(--g-font-family, inherit);
  color: var(--gt-dim);
  transition: color 200ms ease, background 260ms var(--gt-ease), box-shadow 260ms ease;
}
.gt-seg button:hover { color: var(--gt-fg); }
.gt-seg button[aria-pressed="true"] {
  color: var(--gt-fg);
  background: linear-gradient(180deg, color-mix(in srgb, var(--gt-gold) 22%, transparent), color-mix(in srgb, var(--gt-gold) 8%, transparent));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--gt-gold) 40%, transparent), 0 4px 14px -6px color-mix(in srgb, var(--gt-gold) 60%, transparent);
}
.gt-seg button:focus-visible { outline: none; box-shadow: var(--gt-focus); }

/* ── Inputs ──────────────────────────────────────────────────── */
.gt-input {
  height: 38px;
  padding: 0 14px;
  border-radius: 12px;
  border: 1px solid var(--gt-line);
  background: color-mix(in srgb, var(--bg, #050505) 55%, transparent);
  color: var(--gt-fg);
  font: 13px var(--g-font-family, inherit);
  transition: border-color 200ms ease, box-shadow 260ms ease, background 200ms ease;
}
:root[data-theme="light"] .gt-input { background: rgba(255, 255, 255, 0.8); }
.gt-input::placeholder { color: var(--gt-faint); }
.gt-input:focus { outline: none; border-color: color-mix(in srgb, var(--gt-gold) 55%, transparent); box-shadow: 0 0 0 4px var(--gt-gold-faint); }

/* ── Buttons ─────────────────────────────────────────────────── */
.gt-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 36px;
  padding: 0 16px;
  border-radius: 12px;
  border: 1px solid var(--gt-line);
  background: color-mix(in srgb, var(--gt-fg) 5%, transparent);
  color: var(--gt-fg);
  font: 550 12.5px/1 var(--g-font-family, inherit);
  cursor: pointer;
  transition: transform 160ms ease, background 220ms ease, border-color 220ms ease, box-shadow 260ms ease;
}
.gt-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--gt-fg) 9%, transparent); border-color: color-mix(in srgb, var(--gt-gold) 30%, transparent); }
.gt-btn:active:not(:disabled) { transform: scale(0.97); }
.gt-btn:focus-visible { outline: none; box-shadow: var(--gt-focus); }
.gt-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.gt-btn.gt-primary {
  color: #120c00;
  border-color: transparent;
  background: linear-gradient(180deg, color-mix(in srgb, var(--gt-gold) 80%, #fff 20%), var(--gt-gold) 55%, color-mix(in srgb, var(--gt-gold) 80%, #7a4b00 20%));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.5), 0 8px 22px -8px color-mix(in srgb, var(--gt-gold) 70%, transparent);
}
.gt-btn.gt-primary:hover:not(:disabled) { filter: brightness(1.06); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.55), 0 12px 30px -8px color-mix(in srgb, var(--gt-gold) 80%, transparent); }
.gt-btn.gt-danger { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 35%, transparent); background: var(--danger-subtle); }
.gt-btn.gt-danger:hover:not(:disabled) { background: color-mix(in srgb, var(--danger) 18%, transparent); border-color: var(--danger); }

/* ── Skeleton shimmer ────────────────────────────────────────── */
.gt-skel {
  position: relative;
  overflow: hidden;
  border-radius: 8px;
  background: color-mix(in srgb, var(--gt-fg) 6%, transparent);
}
.gt-skel::after {
  content: "";
  position: absolute; inset: 0;
  transform: translateX(-100%);
  background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--gt-gold) 14%, transparent), transparent);
  animation: gt-shimmer 1.6s ease-in-out infinite;
}
@keyframes gt-shimmer { to { transform: translateX(100%); } }

/* ── Empty state ─────────────────────────────────────────────── */
.gt-empty {
  display: grid;
  justify-items: center;
  gap: 10px;
  padding: 48px 24px;
  text-align: center;
}
.gt-empty-orb {
  width: 64px; height: 64px;
  display: grid; place-items: center;
  border-radius: 20px;
  color: var(--gt-gold-ink);
  background: radial-gradient(circle at 30% 25%, color-mix(in srgb, var(--gt-gold) 30%, transparent), color-mix(in srgb, var(--gt-gold) 6%, transparent) 70%);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--gt-gold) 32%, transparent), 0 18px 40px -16px color-mix(in srgb, var(--gt-gold) 55%, transparent);
}
.gt-empty-orb svg { width: 28px; height: 28px; }
.gt-empty-title { font-size: 15px; font-weight: 600; color: var(--gt-fg); }
.gt-empty-sub { max-width: 44ch; font-size: 12.5px; color: var(--gt-dim); line-height: 1.55; }

/* ── Entrance (rest state is visible; animation only enhances) ─ */
.gt-rise { animation: gt-rise 620ms var(--gt-ease) both; animation-delay: calc(var(--gt-i, 0) * 40ms); }
@keyframes gt-rise { from { opacity: 0; transform: translateY(10px); } }

/* ── Fallbacks ───────────────────────────────────────────────── */
:root.perf-mode .gt-glass,
:root.perf-mode .gt-scope .gt-sheet-panel { -webkit-backdrop-filter: none; backdrop-filter: none; background: var(--gt-surface-solid); }
:root.perf-mode .gt-aurora { display: none; }
@media (prefers-reduced-transparency: reduce) {
  .gt-glass, .gt-scope .gt-sheet-panel { -webkit-backdrop-filter: none !important; backdrop-filter: none !important; background: var(--gt-surface-solid) !important; }
  .gt-aurora { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .gt-aurora::before, .gt-aurora::after,
  .gt-skel::after, .gt-light[data-pulse]::after, .gt-rise { animation: none !important; }
  .gt-glass, .gt-btn, .gt-seg button { transition: none !important; }
  .gt-lift:hover { transform: none; }
}
@media (max-width: 640px) {
  .gt-scope { --gt-radius: 16px; }
  .gt-hero { padding-bottom: 16px; gap: 14px; }
  .gt-stats { width: 100%; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .gt-stat { min-width: 0; padding: 9px 11px; }
  .gt-stat-value { font-size: 18px; }
  .gt-aurora { height: 340px; }
}
`;

/** `<style>` tag for the shared primitives. Safe to render more than once. */
export const glassToolsStyle = () => html`<style>${GLASS_TOOLS_CSS}</style>`;

/** Decorative aurora layer; place as the first child of a `.gt-scope`. */
export const glassAurora = () => html`<div class="gt-aurora" aria-hidden="true"></div>`;

/** Hero header used at the top of each tools page. */
export function glassHero(opts: {
  eyebrow: string;
  title: string;
  sub?: string;
  stats?: Array<{ value: string | number; label: string }>;
  trailing?: unknown;
}) {
  return html`
    <header class="gt-hero">
      <div>
        <span class="gt-eyebrow">${opts.eyebrow}</span>
        <h1 class="gt-title">${opts.title}</h1>
        ${opts.sub ? html`<p class="gt-sub">${opts.sub}</p>` : null}
      </div>
      ${opts.stats?.length || opts.trailing
        ? html`<div class="gt-stats">
            ${(opts.stats ?? []).map(
              (s) => html`<div class="gt-stat gt-glass">
                <span class="gt-stat-value">${s.value}</span>
                <span class="gt-stat-label">${s.label}</span>
              </div>`,
            )}
            ${opts.trailing ?? null}
          </div>`
        : null}
    </header>
  `;
}

/** Inline SVG sparkline from a numeric series (0..n values). */
export function glassSparkline(values: number[], opts: { width?: number; height?: number; label?: string } = {}) {
  const w = opts.width ?? 84;
  const h = opts.height ?? 24;
  const pts = values.length > 1 ? values : [0, ...(values.length ? values : [0])];
  const max = Math.max(1, ...pts);
  const step = w / (pts.length - 1);
  const coords = pts.map((v, i) => [i * step, h - 2 - (v / max) * (h - 4)] as const);
  const line = coords.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const area = `${line} L${w} ${h} L0 ${h} Z`;
  const [lx, ly] = coords[coords.length - 1];
  return html`<svg class="gt-spark" viewBox="0 0 ${w} ${h}" width=${w} height=${h} preserveAspectRatio="none" role="img" aria-label=${opts.label ?? "activity"}>
    <path d=${area} style="fill: color-mix(in srgb, var(--gt-gold) 16%, transparent)"></path>
    <path d=${line} style="fill: none; stroke: var(--gt-gold)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"></path>
    <circle cx=${lx} cy=${ly} r="2.2" style="fill: var(--gt-gold)"></circle>
  </svg>`;
}
