/**
 * <ib-guide-layer> — the live highlight overlay agents draw on the user's
 * screen (ui_control highlight / guide).
 *
 *   • Glow ring that tracks the element every frame (scroll, resize, layout
 *     shifts, shadow-DOM hosts, modals, the collapsed sidebar rail).
 *   • Styles: pulse (breathing ring + ripple), spotlight (dims everything
 *     else), outline (quiet), arrow (bouncing pointer).
 *   • Callout bubble with the guiding agent's avatar + name, the message, and
 *     step controls for guides. Bottom sheet on phones.
 *   • Never blocks the page: the ring and the dim are pointer-events:none, so
 *     the highlighted control stays clickable; only the callout takes input.
 *   • Esc / ✕ dismiss. aria-live announces every callout. Reduced motion →
 *     no animation.
 *
 * Mounted on <html> (outside the zoomed <body>) so fixed coordinates equal
 * getBoundingClientRect() pixels — same approach as <guided-tour-overlay>.
 */

import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, state } from "lit/decorators.js";

import type { ActiveHighlight, GuideController, GuideState } from "./runner";

type Box = { top: number; left: number; width: number; height: number; radius: number };

const PAD = 6;
const BASE_GAP = 14;
const ARROW_GAP = 48;
/** Gap used for dialog-side placement (the notch points across it). */
const GAP = 16;
const CARD_W = 320;
const SHEET_BP = 640;

function monogram(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "IB";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

/** Minimal inline markdown for callouts: **bold**, `code`. Everything else is text. */
function renderInlineMd(text: string) {
  return text
    .split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
    .filter(Boolean)
    .map((p) =>
      p.startsWith("**") && p.endsWith("**") && p.length > 4
        ? html`<strong>${p.slice(2, -2)}</strong>`
        : p.startsWith("`") && p.endsWith("`") && p.length > 2
          ? html`<code>${p.slice(1, -1)}</code>`
          : html`${p}`,
    );
}

let sheenRegistered = false;
/** `@property` is ignored inside shadow roots — register the animated angle globally. */
function registerSheenAngle(): void {
  if (sheenRegistered) return;
  sheenRegistered = true;
  try {
    (CSS as unknown as { registerProperty?: (d: Record<string, unknown>) => void }).registerProperty?.({
      name: "--ibg-a",
      syntax: "<angle>",
      inherits: false,
      initialValue: "0deg",
    });
  } catch {
    /* already registered (HMR) or unsupported */
  }
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

@customElement("ib-guide-layer")
export class IbGuideLayer extends LitElement {
  controller: GuideController | null = null;

  @state() private hl: ActiveHighlight | null = null;
  @state() private box: Box | null = null;
  @state() private cardPos: { top: number; left: number; place: "top" | "bottom" | "left" | "right" | "sheet" | "sheet-top" | "center" } | null = null;
  @state() private announce = "";

  private unsub: (() => void) | null = null;
  private raf = 0;
  private lastSig = "";
  private refreshAt = 0;
  private needsPlace = true;

  override connectedCallback(): void {
    super.connectedCallback();
    registerSheenAngle();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsub?.();
    cancelAnimationFrame(this.raf);
  }

  attach(controller: GuideController): void {
    this.controller = controller;
    this.unsub?.();
    this.unsub = controller.subscribe((s) => this.onState(s));
    this.onState(controller.state);
  }

  private onState(s: GuideState): void {
    const next = s.highlight;
    if (next?.id !== this.hl?.id) {
      this.hl = next;
      this.box = null;
      this.cardPos = null;
      this.needsPlace = true;
      this.lastSig = "";
      if (next) this.announce = `${next.agent.name}: ${next.missing ? `couldn't find ${next.plan.title} on screen. ` : ""}${next.text || next.plan.title}`;
      if (next) this.scheduleReveal(next.id);
    } else {
      this.hl = next;
    }
    cancelAnimationFrame(this.raf);
    if (this.hl) this.raf = requestAnimationFrame(() => this.track());
    this.requestUpdate();
  }

  /** Per-frame tracking; only re-renders when the element actually moved. */
  private track(): void {
    const h = this.hl;
    if (!h) return;
    const el = h.element;
    let box: Box | null = null;
    if (el && el.isConnected) {
      const r = this.visibleRect(el);
      if (r && r.width >= 2 && r.height >= 2 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth) {
        let radius = 10;
        try {
          radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 8;
        } catch {
          /* ignore */
        }
        box = { top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2, radius: Math.min(radius + PAD, 22) };
      }
    }
    if ((!el || !el.isConnected || !box) && performance.now() > this.refreshAt) {
      this.refreshAt = performance.now() + 400;
      this.controller?.refreshElement();
    }
    const sig = box ? `${Math.round(box.top)}|${Math.round(box.left)}|${Math.round(box.width)}|${Math.round(box.height)}|${window.innerWidth}x${window.innerHeight}` : "none";
    if (sig !== this.lastSig) {
      this.lastSig = sig;
      this.box = box;
      this.needsPlace = true; // re-place after render (needs the card's size)
    }
    this.raf = requestAnimationFrame(() => this.track());
  }

  protected override updated(_changed: PropertyValues): void {
    if (!this.hl || !this.needsPlace) return;
    const card = this.renderRoot.querySelector<HTMLElement>(".card");
    if (!card) return;
    this.needsPlace = false;
    const next = this.place(card.offsetWidth || CARD_W, card.offsetHeight || 140);
    const cur = this.cardPos;
    if (!cur || cur.place !== next.place || Math.abs(cur.top - next.top) > 0.5 || Math.abs(cur.left - next.left) > 0.5) this.cardPos = next;
  }

  private place(cw: number, ch: number): NonNullable<IbGuideLayer["cardPos"]> {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const b = this.box;
    if (!b) return { top: vh / 2 - ch / 2, left: vw / 2 - cw / 2, place: "center" };
    if (vw <= SHEET_BP) {
      const targetLow = b.top + b.height / 2 > vh * 0.55;
      return { top: 0, left: 0, place: targetLow ? "sheet-top" : "sheet" };
    }
    const clampX = (x: number) => Math.max(10, Math.min(vw - cw - 10, x));
    const clampY = (y: number) => Math.max(10, Math.min(vh - ch - 10, y));
    const cx = b.left + b.width / 2;
    const cy = b.top + b.height / 2;
    // Inside a centered dialog: sit beside the dialog, never on top of it
    // (the callout would hide the very fields/buttons it talks about).
    const dlg = this.hl?.element ? this.dialogRect(this.hl.element) : null;
    if (dlg && dlg.width < vw * 0.7) {
      if (dlg.right + GAP + cw <= vw - 8) return { top: clampY(cy - ch / 2), left: dlg.right + GAP, place: "right" };
      if (dlg.left - GAP - cw >= 8) return { top: clampY(cy - ch / 2), left: dlg.left - GAP - cw, place: "left" };
    }
    const gap = this.hl?.style === "arrow" ? ARROW_GAP : BASE_GAP;
    if (b.top + b.height + gap + ch <= vh - 8) return { top: b.top + b.height + gap, left: clampX(cx - cw / 2), place: "bottom" };
    if (b.top - gap - ch >= 8) return { top: b.top - gap - ch, left: clampX(cx - cw / 2), place: "top" };
    if (b.left + b.width + gap + cw <= vw - 8) return { top: clampY(cy - ch / 2), left: b.left + b.width + gap, place: "right" };
    if (b.left - gap - cw >= 8) return { top: clampY(cy - ch / 2), left: b.left - gap - cw, place: "left" };
    return { top: clampY(vh - ch - 16), left: clampX(cx - cw / 2), place: "bottom" };
  }

  private clipFor: { el: Element; chain: Element[]; dialog: Element | null } | null = null;

  /** Ancestors that clip (overflow ≠ visible) and the nearest dialog — computed once per element. */
  private ancestry(el: Element): { chain: Element[]; dialog: Element | null } {
    if (this.clipFor?.el === el) return this.clipFor;
    const chain: Element[] = [];
    let dialog: Element | null = null;
    let node: Element | null = el;
    for (let i = 0; node && i < 60; i++) {
      const parent: Element | null = node.parentElement ?? ((node.getRootNode() as ShadowRoot).host as Element | undefined) ?? null;
      if (!parent || parent === document.documentElement || parent === document.body) break;
      try {
        const cs = getComputedStyle(parent);
        if (cs.overflowX !== "visible" || cs.overflowY !== "visible") chain.push(parent);
      } catch {
        /* ignore */
      }
      if (
        !dialog &&
        (parent.getAttribute("role") === "dialog" || parent.getAttribute("aria-modal") === "true" || parent.tagName === "DIALOG" || parent.classList.contains("dialog"))
      )
        dialog = parent;
      node = parent;
    }
    this.clipFor = { el, chain, dialog };
    return this.clipFor;
  }

  /** The element's rect intersected with every clipping ancestor (scroll areas, dialogs). */
  private visibleRect(el: Element): DOMRect | null {
    const r = el.getBoundingClientRect();
    let top = r.top;
    let left = r.left;
    let right = r.right;
    let bottom = r.bottom;
    for (const a of this.ancestry(el).chain) {
      if (!a.isConnected) continue;
      const c = a.getBoundingClientRect();
      if (c.width < 1 || c.height < 1) continue;
      top = Math.max(top, c.top);
      left = Math.max(left, c.left);
      right = Math.min(right, c.right);
      bottom = Math.min(bottom, c.bottom);
    }
    if (right - left < 1 || bottom - top < 1) return null;
    return new DOMRect(left, top, right - left, bottom - top);
  }

  private dialogRect(el: Element): DOMRect | null {
    const d = this.ancestry(el).dialog;
    return d && d.isConnected ? d.getBoundingClientRect() : null;
  }

  /**
   * Pages may scroll themselves right after a reveal (Setup › Plugins smooth-
   * scrolls to the section it just opened). If the element is still off
   * screen shortly after showing, bring it back into view.
   */
  private scheduleReveal(id: number): void {
    for (const ms of [650, 1400, 2400]) {
      setTimeout(() => {
        const h = this.hl;
        if (!h || h.id !== id || !h.element || !h.element.isConnected) return;
        const r = h.element.getBoundingClientRect();
        const off = r.bottom < 8 || r.top > window.innerHeight - 8 || r.right < 0 || r.left > window.innerWidth;
        if (off) void import("../../learn/guided/resolve-target").then((m) => m.revealElement(h.element!));
      }, ms);
    }
  }

  private dismiss = () => this.controller?.clear();
  private next = () => this.controller?.next();
  private back = () => this.controller?.back();

  static override styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 2147483000;
      pointer-events: none;
      --ibg-gold: var(--g-primary, #d4af37);
      --ibg-gold-2: #f5d97a;
      --ibg-ink: #f4eedc;
      --ibg-mut: rgba(244, 238, 220, 0.66);
      --ibg-glass: rgba(12, 11, 9, 0.93);
      font-family: var(--g-font, "Inter", system-ui, -apple-system, "Segoe UI", sans-serif);
      color: var(--ibg-ink);
    }
    .sr {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
    }
    /* ── ring ───────────────────────────────────────────── */
    .ring {
      position: fixed;
      pointer-events: none;
      box-sizing: border-box;
      border: 2px solid var(--ibg-gold);
      box-shadow:
        0 0 0 1px rgba(0, 0, 0, 0.55),
        0 0 0 5px color-mix(in srgb, var(--ibg-gold) 20%, transparent),
        0 0 28px 4px color-mix(in srgb, var(--ibg-gold) 45%, transparent),
        inset 0 0 18px color-mix(in srgb, var(--ibg-gold) 18%, transparent);
      transition: top 0.18s ease, left 0.18s ease, width 0.18s ease, height 0.18s ease, border-radius 0.18s ease;
    }
    .ring::before {
      /* rotating gold sheen on the border */
      content: "";
      position: absolute;
      inset: -2px;
      border-radius: inherit;
      padding: 2px;
      background: conic-gradient(from var(--ibg-a, 0deg), transparent 0 55%, var(--ibg-gold-2) 70%, #fff8dc 75%, var(--ibg-gold-2) 80%, transparent 95%);
      -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
      -webkit-mask-composite: xor;
      mask-composite: exclude;
      animation: sheen 2.6s linear infinite;
    }
    @keyframes sheen {
      to {
        --ibg-a: 360deg;
      }
    }
    .ring.pulse {
      animation: breathe 1.8s ease-in-out infinite;
    }
    .ring.pulse::after {
      content: "";
      position: absolute;
      inset: -2px;
      border-radius: inherit;
      border: 2px solid var(--ibg-gold);
      animation: ripple 1.8s ease-out infinite;
    }
    @keyframes breathe {
      50% {
        box-shadow:
          0 0 0 1px rgba(0, 0, 0, 0.55),
          0 0 0 9px color-mix(in srgb, var(--ibg-gold) 12%, transparent),
          0 0 40px 8px color-mix(in srgb, var(--ibg-gold) 55%, transparent),
          inset 0 0 22px color-mix(in srgb, var(--ibg-gold) 24%, transparent);
      }
    }
    @keyframes ripple {
      from {
        opacity: 0.85;
        inset: -2px;
      }
      to {
        opacity: 0;
        inset: -16px;
      }
    }
    .ring.spotlight {
      box-shadow:
        0 0 0 200vmax rgba(3, 3, 6, 0.62),
        0 0 0 5px color-mix(in srgb, var(--ibg-gold) 22%, transparent),
        0 0 36px 6px color-mix(in srgb, var(--ibg-gold) 55%, transparent);
    }
    :host-context([data-theme="light"]) .ring.spotlight {
      box-shadow:
        0 0 0 200vmax rgba(18, 16, 28, 0.42),
        0 0 0 5px color-mix(in srgb, var(--ibg-gold) 26%, transparent),
        0 0 32px 6px color-mix(in srgb, var(--ibg-gold) 50%, transparent);
    }
    .ring.outline {
      border-style: solid;
      box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.5), 0 0 16px color-mix(in srgb, var(--ibg-gold) 35%, transparent);
    }
    .ring.outline::before {
      display: none;
    }
    .ring.fallback {
      border-style: dashed;
    }
    .arrow {
      position: fixed;
      width: 34px;
      height: 34px;
      pointer-events: none;
      color: var(--ibg-gold);
      filter: drop-shadow(0 0 8px color-mix(in srgb, var(--ibg-gold) 70%, transparent)) drop-shadow(0 2px 2px rgba(0, 0, 0, 0.6));
      animation: bob 1s ease-in-out infinite;
    }
    @keyframes bob {
      50% {
        translate: var(--bob-x, 0) var(--bob-y, 6px);
      }
    }
    /* ── callout ────────────────────────────────────────── */
    .card {
      position: fixed;
      width: min(${CARD_W}px, calc(100vw - 20px));
      box-sizing: border-box;
      pointer-events: auto;
      background:
        radial-gradient(120% 90% at 0% 0%, color-mix(in srgb, var(--ibg-gold) 13%, transparent), transparent 60%),
        linear-gradient(180deg, rgba(26, 23, 16, 0.96), var(--ibg-glass));
      border: 1px solid color-mix(in srgb, var(--ibg-gold) 55%, transparent);
      border-radius: 16px;
      padding: 13px 14px 12px;
      box-shadow:
        0 1px 0 rgba(255, 240, 200, 0.08) inset,
        0 22px 60px rgba(0, 0, 0, 0.55),
        0 0 0 1px rgba(0, 0, 0, 0.5),
        0 0 34px color-mix(in srgb, var(--ibg-gold) 16%, transparent);
      backdrop-filter: blur(14px) saturate(1.2);
      -webkit-backdrop-filter: blur(14px) saturate(1.2);
      animation: card-in 0.22s cubic-bezier(0.2, 0.9, 0.3, 1.2);
      visibility: hidden;
    }
    .card.placed {
      visibility: visible;
    }
    .card.sheet,
    .card.sheet-top {
      left: 8px !important;
      right: 8px;
      width: auto;
      border-radius: 18px;
    }
    .card.sheet {
      top: auto !important;
      bottom: max(10px, env(safe-area-inset-bottom));
    }
    .card.sheet-top {
      top: max(10px, env(safe-area-inset-top)) !important;
    }
    @keyframes card-in {
      from {
        opacity: 0;
        translate: 0 8px;
        scale: 0.98;
      }
    }
    .notch {
      position: absolute;
      width: 12px;
      height: 12px;
      background: rgba(22, 20, 14, 0.97);
      border: 1px solid color-mix(in srgb, var(--ibg-gold) 55%, transparent);
      rotate: 45deg;
    }
    .card.bottom .notch {
      top: -7px;
      border-right: 0;
      border-bottom: 0;
    }
    .card.top .notch {
      bottom: -7px;
      border-left: 0;
      border-top: 0;
    }
    .card.right .notch {
      left: -7px;
      border-top: 0;
      border-right: 0;
    }
    .card.left .notch {
      right: -7px;
      border-bottom: 0;
      border-left: 0;
    }
    .head {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-right: 22px;
    }
    .avatar {
      flex: none;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.04em;
      color: #1a1408;
      background: radial-gradient(circle at 30% 25%, #fff3c4, var(--ibg-gold-2) 35%, var(--ibg-gold) 70%, #8a6a17);
      box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.6), 0 0 0 3px color-mix(in srgb, var(--ibg-gold) 60%, transparent), 0 0 16px color-mix(in srgb, var(--ibg-gold) 45%, transparent);
      position: relative;
    }
    .avatar::after {
      content: "";
      position: absolute;
      right: -1px;
      bottom: -1px;
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: #3ddc84;
      box-shadow: 0 0 0 2px #0c0b09, 0 0 8px #3ddc84;
    }
    .who {
      min-width: 0;
      display: grid;
      gap: 1px;
    }
    .name {
      font-size: 13px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
    }
    .via {
      font-size: 9.5px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--ibg-gold);
      border: 1px solid color-mix(in srgb, var(--ibg-gold) 45%, transparent);
      border-radius: 999px;
      padding: 1px 6px;
    }
    .sub {
      font-size: 10.5px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--ibg-mut);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .body {
      margin: 10px 0 0;
      font-size: 14px;
      line-height: 1.45;
      color: var(--ibg-ink);
    }
    .body strong {
      color: #fff6d6;
      font-weight: 700;
    }
    .body code {
      font-family: var(--g-mono, ui-monospace, "JetBrains Mono", monospace);
      font-size: 12.5px;
      padding: 1px 5px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(244, 238, 220, 0.14);
    }
    .hint {
      margin-top: 8px;
      font-size: 11.5px;
      color: var(--ibg-mut);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .hint svg {
      color: var(--ibg-gold);
      flex: none;
    }
    .foot {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 12px;
    }
    .dots {
      display: flex;
      gap: 5px;
      flex: 1;
      align-items: center;
    }
    .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: rgba(244, 238, 220, 0.2);
      transition: width 0.2s;
    }
    .dot.on {
      width: 18px;
      border-radius: 999px;
      background: linear-gradient(90deg, var(--ibg-gold), var(--ibg-gold-2));
      box-shadow: 0 0 8px color-mix(in srgb, var(--ibg-gold) 60%, transparent);
    }
    .dot.done {
      background: color-mix(in srgb, var(--ibg-gold) 55%, transparent);
    }
    .count {
      font-size: 11px;
      color: var(--ibg-mut);
      font-variant-numeric: tabular-nums;
    }
    button {
      font: inherit;
      cursor: pointer;
    }
    .btn {
      border-radius: 10px;
      padding: 6px 12px;
      font-size: 12.5px;
      font-weight: 650;
      border: 1px solid rgba(244, 238, 220, 0.18);
      background: rgba(255, 255, 255, 0.04);
      color: var(--ibg-ink);
    }
    .btn:hover {
      border-color: color-mix(in srgb, var(--ibg-gold) 55%, transparent);
    }
    .btn.primary {
      border-color: transparent;
      color: #1a1408;
      background: linear-gradient(180deg, var(--ibg-gold-2), var(--ibg-gold));
      box-shadow: 0 6px 18px color-mix(in srgb, var(--ibg-gold) 30%, transparent), 0 1px 0 rgba(255, 255, 255, 0.4) inset;
    }
    .btn:focus-visible,
    .x:focus-visible {
      outline: 2px solid var(--ibg-gold-2);
      outline-offset: 2px;
    }
    .x {
      position: absolute;
      top: 9px;
      right: 9px;
      width: 24px;
      height: 24px;
      border-radius: 8px;
      border: 0;
      background: transparent;
      color: var(--ibg-mut);
      display: grid;
      place-items: center;
    }
    .x:hover {
      color: var(--ibg-ink);
      background: rgba(255, 255, 255, 0.07);
    }
    .warn {
      color: #ffcf70;
    }
    @media (prefers-reduced-motion: reduce) {
      .ring,
      .ring::before,
      .ring::after,
      .arrow,
      .card {
        animation: none !important;
        transition: none !important;
      }
      .ring.pulse::after {
        display: none;
      }
    }
  `;

  private renderArrow(b: Box) {
    const pos = this.cardPos;
    // Point from the callout's side toward the element.
    const place = pos?.place ?? "bottom";
    let top = b.top + b.height + 4;
    let left = b.left + b.width / 2 - 17;
    let rot = 0; // pointing up
    let bob = "0 -6px";
    if (place === "top" || place === "sheet-top") {
      top = b.top - 38;
      rot = 180;
      bob = "0 6px";
    } else if (place === "right") {
      top = b.top + b.height / 2 - 17;
      left = b.left + b.width + 4;
      rot = -90;
      bob = "-6px 0";
    } else if (place === "left") {
      top = b.top + b.height / 2 - 17;
      left = b.left - 38;
      rot = 90;
      bob = "6px 0";
    }
    const [bx, by] = bob.split(" ");
    return html`<svg class="arrow" viewBox="0 0 24 24" style="top:${top}px;left:${left}px;rotate:${rot}deg;--bob-x:${bx};--bob-y:${by}" aria-hidden="true">
      <path d="M12 3 4 13h5v8h6v-8h5L12 3Z" fill="currentColor" stroke="#1a1408" stroke-width="1.2" stroke-linejoin="round" />
    </svg>`;
  }

  private renderNotch(b: Box | null) {
    const pos = this.cardPos;
    if (!b || !pos || pos.place === "center" || pos.place === "sheet" || pos.place === "sheet-top") return nothing;
    const cw = Math.min(CARD_W, window.innerWidth - 20);
    if (pos.place === "bottom" || pos.place === "top") {
      const x = Math.max(16, Math.min(cw - 28, b.left + b.width / 2 - pos.left - 6));
      return html`<span class="notch" style="left:${x}px"></span>`;
    }
    const card = this.renderRoot.querySelector<HTMLElement>(".card");
    const ch = card?.offsetHeight ?? 140;
    const y = Math.max(14, Math.min(ch - 26, b.top + b.height / 2 - pos.top - 6));
    return html`<span class="notch" style="top:${y}px"></span>`;
  }

  override render() {
    const h = this.hl;
    const live = html`<div class="sr" role="status" aria-live="polite">${this.announce}</div>`;
    if (!h) return live;
    const b = this.box;
    const reduced = prefersReducedMotion();
    const style = h.style;
    const inGuide = h.step !== undefined && (h.total ?? 0) > 0;
    const idx = h.step ?? 0;
    const total = h.total ?? 1;
    const last = idx + 1 >= total;
    const advance = h.advance ?? "next";
    const pos = this.cardPos;
    const placeCls = pos?.place ?? "bottom";
    const text = h.text?.trim() || h.plan.title;
    return html`
      ${live}
      ${b
        ? html`<div
            class="ring ${reduced ? "" : style === "pulse" || style === "arrow" ? "pulse" : ""} ${style === "spotlight" ? "spotlight" : ""} ${style === "outline" ? "outline" : ""} ${h.usedFallback ? "fallback" : ""}"
            style="top:${b.top}px;left:${b.left}px;width:${b.width}px;height:${b.height}px;border-radius:${b.radius}px"
          ></div>`
        : nothing}
      ${b && style === "arrow" ? this.renderArrow(b) : nothing}
      <section
        class="card ${placeCls} ${pos ? "placed" : ""}"
        style=${pos && pos.place !== "sheet" && pos.place !== "sheet-top" ? `top:${pos.top}px;left:${pos.left}px` : ""}
        role="dialog"
        aria-label=${`${h.agent.name} is pointing at ${h.plan.title}`}
      >
        ${this.renderNotch(b)}
        <button class="x" @click=${this.dismiss} aria-label="Dismiss highlight (Esc)" title="Dismiss (Esc)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
        <div class="head">
          <div class="avatar" aria-hidden="true">${monogram(h.agent.name)}</div>
          <div class="who">
            <div class="name">${h.agent.name}${h.agent.via ? html`<span class="via">${h.agent.via}</span>` : nothing}</div>
            <div class="sub">${inGuide ? (h.title ?? h.plan.title) : h.plan.title}</div>
          </div>
        </div>
        <p class="body">
          ${h.missing ? html`<span class="warn">I can't see “${h.plan.title}” on this screen right now.</span> ` : nothing}${h.usedFallback && h.plan.fallbackHint ? html`${h.plan.fallbackHint} ` : nothing}${h.missing ? nothing : renderInlineMd(text)}
        </p>
        ${inGuide && advance === "click" && !h.missing
          ? html`<div class="hint">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 9 5 12 1.8-5.2L21 14Z" /><path d="M7.2 2.2 8 5.1M5.1 8 2.2 7.2M14 4.1 12 6.2M6.2 12l-2.1 2" /></svg>
              Click the highlighted control to continue
            </div>`
          : nothing}
        ${inGuide
          ? html`<div class="foot">
              <div class="dots" aria-hidden="true">${Array.from({ length: total }, (_, i) => html`<span class="dot ${i === idx ? "on" : i < idx ? "done" : ""}"></span>`)}</div>
              <span class="count">${idx + 1} / ${total}</span>
              ${idx > 0 ? html`<button class="btn" @click=${this.back}>Back</button>` : nothing}
              <button class="btn primary" @click=${this.next}>${last ? "Done" : "Next"}</button>
            </div>`
          : html`<div class="foot"><span class="dots"></span><button class="btn primary" @click=${this.dismiss}>Got it</button></div>`}
      </section>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-guide-layer": IbGuideLayer;
  }
}
