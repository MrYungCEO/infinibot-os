/**
 * Hover card shared by the 2D and 3D constellation engines: same DOM, same
 * classes (`agp-cx-tip-*`, styled in views/agents-premium.ts), so switching
 * renderer never changes what the operator reads on hover.
 */

import type { CxNode } from "./agents-constellation-engine";

export function fillConstellationTip(tip: HTMLElement, n: CxNode) {
  const el = (tag: string, cls: string, text?: string) => {
    const e = document.createElement(tag);
    e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  tip.replaceChildren();
  const head = el("div", "agp-cx-tip-head");
  head.append(el("span", `agp-dot agp-dot--${n.state}`), el("strong", "", n.name));
  head.append(el("span", `agp-pill agp-pill--${n.state}`, n.state));
  tip.append(head);
  if (n.hover.role) tip.append(el("div", "agp-cx-tip-role", n.hover.role));
  const grid = el("dl", "agp-cx-tip-grid");
  const row = (k: string, v: string, cls = "") => {
    grid.append(el("dt", "", k), el("dd", cls, v || "—"));
  };
  row("Model", n.hover.model);
  row("Backend", n.hover.backend);
  row("Now", n.hover.task);
  row("Last verdict", n.hover.verdict, `agp-tone--${n.hover.verdictTone}`);
  row("Runs today", n.hover.runsToday);
  row("Verified", n.hover.successRate);
  row("Last active", n.hover.lastActive);
  if (n.running) row("Sub-agents", `${n.running} running`);
  tip.append(grid, el("div", "agp-cx-tip-hint", "Click to open details"));
}

/** Place the tip beside the pointer inside a host of size w×h (CSS px). */
export function placeConstellationTip(tip: HTMLElement, sx: number, sy: number, w: number, h: number) {
  const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
  const tw = tip.offsetWidth || 240;
  const th = tip.offsetHeight || 150;
  let x = sx + 18;
  let y = sy - th / 2;
  if (x + tw > w - 8) x = sx - tw - 18;
  y = clamp(y, 8, Math.max(8, h - th - 8));
  x = clamp(x, 8, Math.max(8, w - tw - 8));
  tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}
