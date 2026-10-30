"use strict";
(() => {
  // src/ui/components/world-minimap.ts
  var COMPACT = { w: 180, h: 120 };
  var EXPANDED = { w: 360, h: 240 };
  var PADDING = 8;
  var GOLD = "#e8c060";
  var GOLD_DIM = "rgba(232,192,96,0.35)";
  var STATUS_COLORS = {
    active: "#6ee7a8",
    working: GOLD,
    busy: GOLD,
    idle: "#7a8290",
    error: "#f0676b",
    alert: "#f59e42",
    offline: "#4a5160"
  };
  var WorldMinimap = class extends HTMLElement {
    constructor() {
      super(...arguments);
      this._source = null;
      this.rafId = null;
      this.expanded = false;
      this.mounted = false;
      this.dpr = 1;
      /** Optional callback alternative to flyTo/window — receives world coords on click. */
      this.onNavigate = null;
    }
    // ── Public API ───────────────────────────────────────────────────────────────
    set source(s) {
      this._source = s;
      if (this.mounted) this.draw();
    }
    get source() {
      return this._source;
    }
    // ── Lifecycle ────────────────────────────────────────────────────────────────
    connectedCallback() {
      if (this.mounted) return;
      this.mounted = true;
      this.attachShadow({ mode: "open" });
      this.dpr = Math.min(2, window.devicePixelRatio || 1);
      this.buildDom();
      this.resizeCanvas();
      this.startLoop();
    }
    disconnectedCallback() {
      this.mounted = false;
      this.stopLoop();
    }
    // ── DOM / styling ──────────────────────────────────────────────────────────────
    buildDom() {
      const root = this.shadowRoot;
      const style = document.createElement("style");
      style.textContent = `
      :host {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 60;
        --mm-w: ${COMPACT.w}px;
        --mm-h: ${COMPACT.h}px;
      }
      .frame {
        width: var(--mm-w);
        height: var(--mm-h);
        border-radius: 12px;
        padding: 6px;
        box-sizing: border-box;
        background: linear-gradient(160deg, rgba(10,12,18,0.82), rgba(6,7,12,0.92));
        border: 1px solid ${GOLD_DIM};
        box-shadow: 0 8px 30px rgba(0,0,0,0.55), inset 0 0 24px rgba(232,192,96,0.05);
        backdrop-filter: blur(10px) saturate(1.1);
        -webkit-backdrop-filter: blur(10px) saturate(1.1);
        transition: width .28s cubic-bezier(.2,.8,.2,1), height .28s cubic-bezier(.2,.8,.2,1), box-shadow .28s;
        cursor: crosshair;
        position: relative;
        overflow: hidden;
      }
      :host(:hover) {
        --mm-w: ${EXPANDED.w}px;
        --mm-h: ${EXPANDED.h}px;
      }
      :host(:hover) .frame {
        box-shadow: 0 12px 44px rgba(0,0,0,0.6), 0 0 0 1px ${GOLD_DIM}, inset 0 0 30px rgba(232,192,96,0.08);
      }
      canvas { display:block; width:100%; height:100%; border-radius:8px; }
      .label {
        position:absolute; top:7px; left:10px;
        font: 600 9px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
        letter-spacing: .14em; text-transform: uppercase;
        color: ${GOLD}; opacity:.55; pointer-events:none; user-select:none;
        text-shadow: 0 1px 3px rgba(0,0,0,.7);
      }
      @media (prefers-reduced-motion: reduce) {
        .frame { transition: none; }
      }
    `;
      const frame = document.createElement("div");
      frame.className = "frame";
      const canvas = document.createElement("canvas");
      const label = document.createElement("div");
      label.className = "label";
      label.textContent = "RADAR";
      frame.appendChild(canvas);
      frame.appendChild(label);
      root.appendChild(style);
      root.appendChild(frame);
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      canvas.addEventListener("click", (e) => this.handleClick(e));
      this.addEventListener("mouseenter", () => {
        this.expanded = true;
        this.deferResize();
      });
      this.addEventListener("mouseleave", () => {
        this.expanded = false;
        this.deferResize();
      });
    }
    deferResize() {
      setTimeout(() => {
        this.resizeCanvas();
        this.draw();
      }, 300);
      requestAnimationFrame(() => {
        this.resizeCanvas();
        this.draw();
      });
    }
    resizeCanvas() {
      if (!this.canvas) return;
      const rect = this.canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round((rect.width || COMPACT.w) * this.dpr));
      const h = Math.max(1, Math.round((rect.height || COMPACT.h) * this.dpr));
      if (this.canvas.width !== w) this.canvas.width = w;
      if (this.canvas.height !== h) this.canvas.height = h;
    }
    // ── Render loop ────────────────────────────────────────────────────────────────
    startLoop() {
      if (this.reducedMotion()) {
        this.draw();
        return;
      }
      if (this.rafId != null) return;
      const loop = () => {
        this.rafId = requestAnimationFrame(loop);
        this.draw();
      };
      this.rafId = requestAnimationFrame(loop);
    }
    stopLoop() {
      if (this.rafId != null) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
    }
    // ── Projection (world ↔ minimap) ─────────────────────────────────────────────
    bounds() {
      const b = this._source?.worldBounds?.() ?? null;
      if (b && b.maxX > b.minX && b.maxY > b.minY) return b;
      const pts = [
        ...this.safe(() => this._source?.agents?.()) ?? [],
        ...this.safe(() => this._source?.sectors?.()) ?? []
      ];
      if (!pts.length) return { minX: 0, minY: 0, maxX: 1600, maxY: 1200 };
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of pts) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
      }
      const padX = (maxX - minX || 400) * 0.15;
      const padY = (maxY - minY || 400) * 0.15;
      return { minX: minX - padX, minY: minY - padY, maxX: maxX + padX, maxY: maxY + padY };
    }
    /** World → canvas (device px), letterboxed to preserve aspect. */
    proj(b) {
      const cw = this.canvas.width;
      const ch = this.canvas.height;
      const pad = PADDING * this.dpr;
      const availW = cw - pad * 2;
      const availH = ch - pad * 2;
      const wW = b.maxX - b.minX;
      const wH = b.maxY - b.minY;
      const s = Math.min(availW / wW, availH / wH);
      const ox = pad + (availW - wW * s) / 2;
      const oy = pad + (availH - wH * s) / 2;
      return { sx: s, sy: s, ox, oy };
    }
    toCanvas(x, y, b, p) {
      return { cx: p.ox + (x - b.minX) * p.sx, cy: p.oy + (y - b.minY) * p.sy };
    }
    // ── Draw ─────────────────────────────────────────────────────────────────────
    draw() {
      const ctx = this.ctx;
      if (!ctx || !this.canvas) return;
      const cw = this.canvas.width;
      const ch = this.canvas.height;
      ctx.clearRect(0, 0, cw, ch);
      ctx.fillStyle = "rgba(8,10,16,0.6)";
      ctx.fillRect(0, 0, cw, ch);
      this.drawGrid(ctx, cw, ch);
      const b = this.bounds();
      const p = this.proj(b);
      for (const sec of this.safe(() => this._source?.sectors?.()) ?? []) {
        const { cx, cy } = this.toCanvas(sec.x, sec.y, b, p);
        const halfW = (sec.w ?? 60) * p.sx;
        const halfH = (sec.h ?? sec.w ?? 60) * p.sy;
        ctx.fillStyle = sec.color ?? "rgba(232,192,96,0.10)";
        ctx.strokeStyle = "rgba(232,192,96,0.22)";
        ctx.lineWidth = 1 * this.dpr;
        ctx.fillRect(cx - halfW, cy - halfH, halfW * 2, halfH * 2);
        ctx.strokeRect(cx - halfW, cy - halfH, halfW * 2, halfH * 2);
      }
      for (const a of this.safe(() => this._source?.agents?.()) ?? []) {
        const { cx, cy } = this.toCanvas(a.x, a.y, b, p);
        const act = Math.max(0, Math.min(1, a.activity ?? 0.6));
        const color = STATUS_COLORS[a.status ?? "idle"] ?? STATUS_COLORS.idle;
        const r = (this.expanded ? 3 : 2) * this.dpr * (0.7 + act * 0.6);
        ctx.globalAlpha = 0.45 + act * 0.55;
        ctx.shadowColor = color;
        ctx.shadowBlur = (this.expanded ? 8 : 4) * act * this.dpr;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
      }
      const cam = this.safe(() => this._source?.camera?.());
      if (cam) {
        const tl = this.toCanvas(cam.x - cam.width / 2, cam.y - cam.height / 2, b, p);
        const w = cam.width * p.sx;
        const h = cam.height * p.sy;
        ctx.strokeStyle = GOLD;
        ctx.lineWidth = 1.4 * this.dpr;
        ctx.shadowColor = GOLD;
        ctx.shadowBlur = 6 * this.dpr;
        ctx.strokeRect(tl.cx, tl.cy, w, h);
        ctx.shadowBlur = 0;
        ctx.fillStyle = "rgba(232,192,96,0.06)";
        ctx.fillRect(tl.cx, tl.cy, w, h);
      }
    }
    drawGrid(ctx, cw, ch) {
      ctx.strokeStyle = "rgba(232,192,96,0.06)";
      ctx.lineWidth = 1;
      const step = 24 * this.dpr;
      for (let x = 0; x <= cw; x += step) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, ch);
        ctx.stroke();
      }
      for (let y = 0; y <= ch; y += step) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(cw, y);
        ctx.stroke();
      }
    }
    // ── Interaction ────────────────────────────────────────────────────────────────
    handleClick(e) {
      const b = this.bounds();
      const p = this.proj(b);
      const rect = this.canvas.getBoundingClientRect();
      const cx = (e.clientX - rect.left) * (this.canvas.width / rect.width);
      const cy = (e.clientY - rect.top) * (this.canvas.height / rect.height);
      const wx = b.minX + (cx - p.ox) / p.sx;
      const wy = b.minY + (cy - p.oy) / p.sy;
      if (this.onNavigate) {
        this.onNavigate(wx, wy);
        return;
      }
      if (this._source?.flyTo) {
        this._source.flyTo(wx, wy);
        return;
      }
      try {
        const cc = window.cinematicCamera;
        if (cc && typeof cc.panTo === "function") {
          cc.panTo(wx, wy);
          return;
        }
      } catch {
      }
      this.dispatchEvent(new CustomEvent("minimap-navigate", {
        detail: { x: wx, y: wy },
        bubbles: true,
        composed: true
      }));
    }
    // ── utils ──────────────────────────────────────────────────────────────────────
    safe(fn) {
      try {
        return fn();
      } catch {
        return void 0;
      }
    }
    reducedMotion() {
      try {
        return !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      } catch {
        return false;
      }
    }
  };
  if (typeof customElements !== "undefined" && !customElements.get("world-minimap")) {
    customElements.define("world-minimap", WorldMinimap);
  }

  // src/ui/components/__minimap_test_entry.ts
  var bounds = { minX: 0, minY: 0, maxX: 1600, maxY: 1e3 };
  var sectors = [
    { id: "build", x: 300, y: 250 },
    { id: "deploy", x: 1200, y: 300 },
    { id: "research", x: 800, y: 750 },
    { id: "comms", x: 1350, y: 820 }
  ];
  var statuses = ["active", "working", "idle", "error", "alert", "idle", "working", "active"];
  var agents = Array.from({ length: 18 }, (_, i) => ({
    id: "a" + i,
    x: 80 + i * 137 % 1500,
    y: 60 + i * 271 % 900,
    status: statuses[i % statuses.length],
    activity: i * 7 % 10 / 10
  }));
  var camera = { x: 700, y: 450, width: 600, height: 380 };
  var mm = document.createElement("world-minimap");
  mm.source = {
    worldBounds: () => bounds,
    sectors: () => sectors,
    agents: () => agents,
    camera: () => camera,
    flyTo: (x, y) => {
      window.__lastNav = { x, y };
    }
  };
  document.body.appendChild(mm);
  window.__minimap = mm;
  window.__moveCamera = (x, y, w, h) => {
    camera.x = x;
    camera.y = y;
    if (w) camera.width = w;
    if (h) camera.height = h;
  };
})();
