/**
 * Solana Token Chart Overlay (control-bar CHART panel)
 * Draggable/resizable chart with a shared watchlist sidebar and a SOURCE switch:
 *   • "Solatrix" — the native chart ported from the Solatrix desktop app
 *     (candles, timeframes, indicators, drawings, levels). Needs the Solatrix
 *     plugin; lazy-loaded from extensions/solatrix/ui/chart.
 *   • "DexScreener" — the embed (always available; the fallback when the
 *     plugin is disabled).
 * The watchlist is the app-wide store in ../solana/watchlist.ts (also used by
 * the Solatrix plugin pages). Legacy saved coins are migrated into it.
 */

import { html, nothing } from "lit";
import type { TemplateResult } from "lit";
import { icons } from "../icons";
import { isTabAvailable } from "../plugin-host";
import { solanaWatchlist, type ChartSource, type RpcClient, type WatchItem } from "../solana/watchlist";
import { g8GlassStyles } from "./glass-g8.js";

// Storage keys
const POSITION_KEY = "infinibot-chart-position";

/** @deprecated kept for callers typed against the pre-watchlist panel. */
export interface SavedCoin {
  address: string;
  name: string;
  symbol?: string;
  addedAt: number;
}

export interface ChartPosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SolanaChartState {
  isOpen: boolean;
  currentAddress: string;
  savedCoins: SavedCoin[];
  inputAddress: string;
  inputName: string;
  showAddForm: boolean;
  isLoading: boolean;
  isDragging: boolean;
  isResizing: boolean;
  resizeEdge: string | null;
  position: ChartPosition;
  isMinimized: boolean;
  /** Watchlist sidebar visible (auto-collapsed on narrow panels). */
  showWatchlist?: boolean;
  /** Last add/remove error shown under the form. */
  formError?: string;
}

export type SolanaChartOptions = {
  /** Gateway client — needed for the native Solatrix chart + plugin sync. */
  client?: RpcClient | null;
  /** Re-render the host when the shared watchlist or prices change. */
  requestUpdate?: () => void;
};

const MOBILE_BREAKPOINT = 640;
const isMobileViewport = () => typeof window !== "undefined" && window.innerWidth <= MOBILE_BREAKPOINT;

const DEFAULT_POSITION: ChartPosition = {
  x: Math.max(8, (typeof window !== "undefined" ? window.innerWidth : 1280) - 700),
  y: 120,
  width: 660,
  height: 560,
};

const toSaved = (i: WatchItem): SavedCoin => ({ address: i.mint, name: i.name, symbol: i.symbol, addedAt: i.addedAt });

// Create initial state
export function createSolanaChartState(): SolanaChartState {
  const items = solanaWatchlist.items();
  const position = loadPosition();
  return {
    isOpen: false,
    currentAddress: items[0]?.mint || "",
    savedCoins: items.map(toSaved),
    inputAddress: "",
    inputName: "",
    showAddForm: false,
    isLoading: false,
    isDragging: false,
    isResizing: false,
    resizeEdge: null,
    position,
    isMinimized: false,
    showWatchlist: position.width >= 520,
  };
}

function loadPosition(): ChartPosition {
  try {
    const data = localStorage.getItem(POSITION_KEY);
    if (data) {
      const pos = JSON.parse(data);
      // Validate position is within viewport
      return {
        x: Math.max(0, Math.min(pos.x, window.innerWidth - 200)),
        y: Math.max(0, Math.min(pos.y, window.innerHeight - 100)),
        width: Math.max(320, Math.min(pos.width, window.innerWidth - 40)),
        height: Math.max(300, Math.min(pos.height, window.innerHeight - 100)),
      };
    }
  } catch (e) {}
  return { ...DEFAULT_POSITION };
}

function savePosition(pos: ChartPosition): void {
  try {
    localStorage.setItem(POSITION_KEY, JSON.stringify(pos));
  } catch (e) {}
}

// Chart button for topbar - glassmorphism style
export function renderChartButton(
  state: SolanaChartState,
  onToggle: () => void
): TemplateResult {
  return html`
    <button 
      class="topbar-glass-btn ${state.isOpen ? 'active' : ''}" 
      @click=${onToggle}
      title="Solana Charts"
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <line x1="12" x2="12" y1="20" y2="10"/>
        <line x1="18" x2="18" y1="20" y2="4"/>
        <line x1="6" x2="6" y1="20" y2="16"/>
      </svg>
      Chart
    </button>
  `;
}

// Drag/resize handlers
let dragStartX = 0;
let dragStartY = 0;
let dragStartPosX = 0;
let dragStartPosY = 0;
let resizeStartWidth = 0;
let resizeStartHeight = 0;
let resizeStartX = 0;
let resizeStartY = 0;
let activeResizeEdge = "";

// Shared-store wiring (one subscription per page, live prices while open).
let storeUnsub: (() => void) | null = null;
let stopPrices: (() => void) | null = null;
let hostUpdate: (() => void) | null = null;
let dragMint: string | null = null;
let solatrixChartLoaded = false;

/** Which source the panel actually renders (plugin off ⇒ DexScreener). */
export function effectiveChartSource(pref: ChartSource, pluginAvailable: boolean): ChartSource {
  return pref === "solatrix" && pluginAvailable ? "solatrix" : "dexscreener";
}

function syncStore(open: boolean, opts: SolanaChartOptions) {
  hostUpdate = opts.requestUpdate ?? hostUpdate;
  if (!storeUnsub) storeUnsub = solanaWatchlist.subscribe(() => hostUpdate?.());
  const pluginOn = isTabAvailable("solatrix");
  void solanaWatchlist.setBackend(pluginOn && opts.client ? opts.client : null);
  if (open && !stopPrices) stopPrices = solanaWatchlist.watchPrices();
  if (!open && stopPrices) {
    stopPrices();
    stopPrices = null;
  }
}

const fmtPrice = (v: number | null | undefined) => {
  if (v == null) return "—";
  if (v >= 1000) return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  if (v >= 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toPrecision(3)}`;
};
const fmtPct = (v: number | null | undefined) => (v == null ? "" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);

export function renderSolanaChartOverlay(
  state: SolanaChartState,
  onClose: () => void,
  onStateChange: (newState: Partial<SolanaChartState>) => void,
  opts: SolanaChartOptions = {}
): TemplateResult {
  syncStore(state.isOpen, opts);
  if (!state.isOpen) return html``;

  const mobile = isMobileViewport();
  const position = mobile
    ? { x: 6, y: 64, width: window.innerWidth - 12, height: Math.max(360, window.innerHeight - 76) }
    : state.position;
  const items = solanaWatchlist.items();
  const pluginOn = isTabAvailable("solatrix");
  const pref = solanaWatchlist.chartSource();
  const source = effectiveChartSource(pref, pluginOn);
  const currentAddress = items.some((i) => i.mint === state.currentAddress) ? state.currentAddress : items[0]?.mint || "";
  const showWatchlist = state.showWatchlist ?? position.width >= 520;
  if (source === "solatrix" && !solatrixChartLoaded) {
    solatrixChartLoaded = true;
    void import("../../../../extensions/solatrix/ui/chart/solatrix-chart.js");
  }
  // Drag handlers
  const handleDragStart = (e: MouseEvent) => {
    if (mobile) return;
    if ((e.target as HTMLElement).closest('.chart-header__close, .chart-controls, .chart-add-form, select, input, button')) return;
    e.preventDefault();
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartPosX = position.x;
    dragStartPosY = position.y;
    onStateChange({ isDragging: true });

    const handleDrag = (e: MouseEvent) => {
      const newX = Math.max(0, Math.min(dragStartPosX + (e.clientX - dragStartX), window.innerWidth - 100));
      const newY = Math.max(0, Math.min(dragStartPosY + (e.clientY - dragStartY), window.innerHeight - 50));
      onStateChange({ position: { ...position, x: newX, y: newY } });
    };

    const handleDragEnd = () => {
      onStateChange({ isDragging: false });
      savePosition(state.position);
      document.removeEventListener('mousemove', handleDrag);
      document.removeEventListener('mouseup', handleDragEnd);
    };

    document.addEventListener('mousemove', handleDrag);
    document.addEventListener('mouseup', handleDragEnd);
  };

  // Resize handlers
  const handleResizeStart = (e: MouseEvent, edge: string) => {
    e.preventDefault();
    e.stopPropagation();
    resizeStartWidth = position.width;
    resizeStartHeight = position.height;
    resizeStartX = e.clientX;
    resizeStartY = e.clientY;
    dragStartPosX = position.x;
    dragStartPosY = position.y;
    activeResizeEdge = edge;
    onStateChange({ isResizing: true, resizeEdge: edge });

    const handleResize = (e: MouseEvent) => {
      const dx = e.clientX - resizeStartX;
      const dy = e.clientY - resizeStartY;
      let newWidth = resizeStartWidth;
      let newHeight = resizeStartHeight;
      let newX = dragStartPosX;
      let newY = dragStartPosY;

      if (activeResizeEdge.includes('e')) newWidth = Math.max(320, resizeStartWidth + dx);
      if (activeResizeEdge.includes('w')) {
        newWidth = Math.max(320, resizeStartWidth - dx);
        newX = dragStartPosX + (resizeStartWidth - newWidth);
      }
      if (activeResizeEdge.includes('s')) newHeight = Math.max(300, resizeStartHeight + dy);
      if (activeResizeEdge.includes('n')) {
        newHeight = Math.max(300, resizeStartHeight - dy);
        newY = dragStartPosY + (resizeStartHeight - newHeight);
      }

      onStateChange({ position: { x: newX, y: newY, width: newWidth, height: newHeight } });
    };

    const handleResizeEnd = () => {
      onStateChange({ isResizing: false, resizeEdge: null });
      savePosition(state.position);
      document.removeEventListener('mousemove', handleResize);
      document.removeEventListener('mouseup', handleResizeEnd);
    };

    document.addEventListener('mousemove', handleResize);
    document.addEventListener('mouseup', handleResizeEnd);
  };

  const handleSelectCoin = (address: string) => {
    if (address === currentAddress) return;
    onStateChange({ currentAddress: address, isLoading: source === "dexscreener" });
    if (source === "dexscreener") setTimeout(() => onStateChange({ isLoading: false }), 2000);
  };

  const handleAddCoin = () => {
    const address = state.inputAddress.trim();
    if (!address) return;
    try {
      const item = solanaWatchlist.add({ mint: address, name: state.inputName.trim() || undefined, symbol: state.inputName.trim() || undefined });
      onStateChange({
        savedCoins: solanaWatchlist.items().map(toSaved),
        inputAddress: "",
        inputName: "",
        showAddForm: false,
        formError: "",
        currentAddress: item.mint,
      });
    } catch (err) {
      onStateChange({ formError: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleRemoveCoin = (address: string, e: Event) => {
    e.stopPropagation();
    solanaWatchlist.remove(address);
    const next = solanaWatchlist.items();
    onStateChange({
      savedCoins: next.map(toSaved),
      currentAddress: address === currentAddress ? next[0]?.mint || "" : currentAddress,
    });
  };

  const handleMove = (address: string, delta: number, e?: Event) => {
    e?.stopPropagation();
    const idx = items.findIndex((i) => i.mint === address);
    if (idx < 0) return;
    solanaWatchlist.move(address, idx + delta);
    onStateChange({ savedCoins: solanaWatchlist.items().map(toSaved) });
  };

  const handleMinimize = () => {
    onStateChange({ isMinimized: !state.isMinimized });
  };

  const setSource = (next: ChartSource) => {
    if (next === "solatrix" && !pluginOn) return;
    solanaWatchlist.setChartSource(next);
    onStateChange({ isLoading: next === "dexscreener" && Boolean(currentAddress) });
    if (next === "dexscreener") setTimeout(() => onStateChange({ isLoading: false }), 2000);
  };

  // Embed the best pair when known (the embed does not always resolve a bare token mint).
  const embedTarget = (currentAddress && solanaWatchlist.price(currentAddress)?.pairAddress) || currentAddress;
  const chartUrl = embedTarget
    ? `https://dexscreener.com/solana/${embedTarget}?embed=1&theme=dark&trades=0&info=0`
    : "";

  const currentCoin = items.find(c => c.mint === currentAddress);
  const currentPrice = currentCoin ? solanaWatchlist.price(currentCoin.mint) : undefined;

  const watchRow = (it: WatchItem, i: number) => {
    const p = solanaWatchlist.price(it.mint);
    const up = (p?.change24h ?? 0) >= 0;
    return html`
      <div
        class="sol-watch__row ${it.mint === currentAddress ? "active" : ""}"
        role="option"
        tabindex="0"
        aria-selected=${it.mint === currentAddress ? "true" : "false"}
        draggable="true"
        data-mint=${it.mint}
        title=${it.mint}
        @click=${() => handleSelectCoin(it.mint)}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleSelectCoin(it.mint); }
          else if (e.altKey && e.key === "ArrowUp") { e.preventDefault(); handleMove(it.mint, -1); }
          else if (e.altKey && e.key === "ArrowDown") { e.preventDefault(); handleMove(it.mint, 1); }
          else if (e.key === "Delete") handleRemoveCoin(it.mint, e);
        }}
        @dragstart=${(e: DragEvent) => { dragMint = it.mint; e.dataTransfer?.setData("text/plain", it.mint); }}
        @dragover=${(e: DragEvent) => { e.preventDefault(); }}
        @drop=${(e: DragEvent) => {
          e.preventDefault();
          const mint = dragMint ?? e.dataTransfer?.getData("text/plain");
          dragMint = null;
          if (mint && mint !== it.mint) { solanaWatchlist.move(mint, i); onStateChange({ savedCoins: solanaWatchlist.items().map(toSaved) }); }
        }}
      >
        <span class="sol-watch__grip" aria-hidden="true">⋮⋮</span>
        ${it.imageUrl ? html`<img class="sol-watch__img" src=${it.imageUrl} alt="" loading="lazy" referrerpolicy="no-referrer" />` : html`<span class="sol-watch__img sol-watch__img--mono">${it.symbol.slice(0, 1)}</span>`}
        <span class="sol-watch__sym">${it.symbol}</span>
        <span class="sol-watch__px">${fmtPrice(p?.priceUsd)}</span>
        <span class="sol-watch__chg ${up ? "up" : "down"}">${fmtPct(p?.change24h)}</span>
        <button class="sol-watch__rm" title="Remove ${it.symbol}" aria-label="Remove ${it.symbol}" @click=${(e: Event) => handleRemoveCoin(it.mint, e)}>×</button>
      </div>`;
  };

  const narrow = mobile || position.width < 520;
  return html`
    <style>
      .sol-chart {
        position: fixed;
        background: linear-gradient(145deg, rgba(6,6,10,0.98) 0%, rgba(12,12,18,0.98) 100%);
        border: 1px solid color-mix(in srgb, var(--g-primary) 25%, transparent);
        border-radius: 12px;
        /* Floating window: above page toolbars (grid toolbar is 10000). */
        z-index: 10050;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        box-shadow: 
          0 25px 80px rgba(0,0,0,0.7),
          0 0 1px color-mix(in srgb, var(--g-primary) 50%, transparent),
          inset 0 1px 0 rgba(255,255,255,0.03);
        backdrop-filter: blur(24px);
        font-family: 'JetBrains Mono', 'SF Mono', monospace;
        user-select: none;
        transition: box-shadow 0.2s, border-color 0.2s;
      }
      .sol-chart.dragging {
        box-shadow: 0 30px 100px rgba(0,0,0,0.8), 0 0 60px color-mix(in srgb, var(--g-primary) 15%, transparent);
        border-color: color-mix(in srgb, var(--g-primary) 50%, transparent);
      }
      .sol-chart.resizing {
        transition: none;
      }
      .sol-chart.minimized {
        height: 48px !important;
      }
      .sol-chart.minimized .sol-chart__body {
        display: none;
      }

      /* Resize handles */
      .sol-resize {
        position: absolute;
        z-index: 10;
      }
      .sol-resize--n { top: -4px; left: 8px; right: 8px; height: 8px; cursor: n-resize; }
      .sol-resize--s { bottom: -4px; left: 8px; right: 8px; height: 8px; cursor: s-resize; }
      .sol-resize--e { right: -4px; top: 8px; bottom: 8px; width: 8px; cursor: e-resize; }
      .sol-resize--w { left: -4px; top: 8px; bottom: 8px; width: 8px; cursor: w-resize; }
      .sol-resize--ne { top: -4px; right: -4px; width: 16px; height: 16px; cursor: ne-resize; }
      .sol-resize--nw { top: -4px; left: -4px; width: 16px; height: 16px; cursor: nw-resize; }
      .sol-resize--se { bottom: -4px; right: -4px; width: 16px; height: 16px; cursor: se-resize; }
      .sol-resize--sw { bottom: -4px; left: -4px; width: 16px; height: 16px; cursor: sw-resize; }

      /* Header */
      .sol-header {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 14px;
        background: linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 6%, transparent) 0%, transparent 100%);
        border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 12%, transparent);
        cursor: grab;
        flex-shrink: 0;
      }
      .sol-header:active { cursor: grabbing; }
      .sol-header__icon {
        width: 28px;
        height: 28px;
        border-radius: 6px;
        background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 25%, transparent) 0%, color-mix(in srgb, var(--g-primary) 8%, transparent) 100%);
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--g-primary);
        flex-shrink: 0;
      }
      .sol-header__icon svg { width: 14px; height: 14px; stroke: currentColor; stroke-width: 2.5; fill: none; }
      .sol-header__info { flex: 1; min-width: 0; }
      .sol-header__title {
        font-size: 12px;
        font-weight: 700;
        color: var(--g-primary);
        letter-spacing: 0.04em;
        line-height: 1.2;
      }
      .sol-header__sub {
        font-size: 9px;
        color: rgba(255,255,255,0.35);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .sol-header__actions {
        display: flex;
        gap: 4px;
      }
      .sol-header__btn {
        width: 26px;
        height: 26px;
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 6px;
        background: transparent;
        color: rgba(255,255,255,0.4);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.15s;
      }
      .sol-header__btn:hover {
        background: color-mix(in srgb, var(--g-primary) 10%, transparent);
        border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
        color: var(--g-primary);
      }
      .sol-header__btn svg { width: 12px; height: 12px; stroke: currentColor; stroke-width: 2; fill: none; }

      .sol-chart__body {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
      }

      /* Controls */
      .sol-controls {
        display: flex;
        gap: 6px;
        padding: 8px 12px;
        background: rgba(0,0,0,0.25);
        border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 8%, transparent);
        align-items: center;
        flex-shrink: 0;
      }
      .sol-select {
        flex: 1;
        padding: 8px 32px 8px 10px;
        border: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
        border-radius: 6px;
        background: rgba(0,0,0,0.4);
        color: #fff;
        font-size: 11px;
        font-family: inherit;
        cursor: pointer;
        outline: none;
        appearance: none;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%23D4AF37' stroke-width='2.5'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
        background-repeat: no-repeat;
        background-position: right 10px center;
        transition: all 0.15s;
      }
      .sol-select:hover { border-color: color-mix(in srgb, var(--g-primary) 35%, transparent); }
      .sol-select:focus { border-color: var(--g-primary); box-shadow: 0 0 0 2px color-mix(in srgb, var(--g-primary) 12%, transparent); }
      .sol-select option { background: #0a0a0f; color: #fff; }

      .sol-btn-icon {
        width: 32px;
        height: 32px;
        border: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
        border-radius: 6px;
        background: color-mix(in srgb, var(--g-primary) 6%, transparent);
        color: var(--g-primary);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.15s;
        flex-shrink: 0;
      }
      .sol-btn-icon:hover {
        background: color-mix(in srgb, var(--g-primary) 15%, transparent);
        border-color: var(--g-primary);
        transform: scale(1.05);
      }
      .sol-btn-icon svg { width: 14px; height: 14px; stroke: currentColor; stroke-width: 2; fill: none; }

      /* Add form */
      .sol-form {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 10px 12px;
        background: rgba(0,0,0,0.35);
        border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 8%, transparent);
        animation: sol-expand 0.2s ease;
        flex-shrink: 0;
      }
      @keyframes sol-expand {
        from { opacity: 0; transform: translateY(-8px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .sol-form__row { display: flex; gap: 6px; }
      .sol-input {
        flex: 1;
        padding: 8px 10px;
        border: 1px solid color-mix(in srgb, var(--g-primary) 12%, transparent);
        border-radius: 6px;
        background: rgba(0,0,0,0.35);
        color: #fff;
        font-size: 10px;
        font-family: inherit;
        outline: none;
        transition: all 0.15s;
      }
      .sol-input::placeholder { color: rgba(255,255,255,0.2); }
      .sol-input:focus { border-color: color-mix(in srgb, var(--g-primary) 40%, transparent); background: rgba(0,0,0,0.5); }
      .sol-btn-add {
        padding: 8px 14px;
        border: none;
        border-radius: 6px;
        background: linear-gradient(135deg, var(--g-primary) 0%, #B8962E 100%);
        color: #000;
        font-size: 10px;
        font-weight: 700;
        font-family: inherit;
        cursor: pointer;
        transition: all 0.15s;
        letter-spacing: 0.02em;
      }
      .sol-btn-add:hover { transform: scale(1.02); box-shadow: 0 4px 12px color-mix(in srgb, var(--g-primary) 25%, transparent); }
      .sol-btn-add:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }
      .sol-btn-cancel {
        padding: 8px 12px;
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 6px;
        background: transparent;
        color: rgba(255,255,255,0.4);
        font-size: 10px;
        font-family: inherit;
        cursor: pointer;
        transition: all 0.15s;
      }
      .sol-btn-cancel:hover { background: rgba(255,255,255,0.05); color: #fff; }

      /* Chart area */
      .sol-chart-area {
        flex: 1;
        position: relative;
        background: #070709;
        overflow: hidden;
        min-height: 0;
      }
      .sol-iframe {
        width: 100%;
        height: 100%;
        border: none;
        display: block;
      }
      .sol-loading {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 12px;
        background: rgba(6,6,10,0.95);
        z-index: 5;
      }
      .sol-spinner {
        width: 32px;
        height: 32px;
        border: 2px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
        border-top-color: var(--g-primary);
        border-radius: 50%;
        animation: sol-spin 0.8s linear infinite;
      }
      @keyframes sol-spin { to { transform: rotate(360deg); } }
      .sol-loading__text { font-size: 10px; color: rgba(255,255,255,0.3); }

      .sol-empty {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 12px;
        color: rgba(255,255,255,0.3);
        padding: 30px;
        text-align: center;
      }
      .sol-empty__icon {
        width: 48px;
        height: 48px;
        border-radius: 12px;
        background: color-mix(in srgb, var(--g-primary) 8%, transparent);
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--g-primary);
      }
      .sol-empty__icon svg { width: 24px; height: 24px; stroke: currentColor; stroke-width: 2; fill: none; }
      .sol-empty__text { font-size: 11px; }

      /* Footer */
      .sol-footer {
        padding: 6px 12px;
        background: rgba(0,0,0,0.2);
        border-top: 1px solid color-mix(in srgb, var(--g-primary) 6%, transparent);
        font-size: 9px;
        color: rgba(255,255,255,0.2);
        text-align: center;
        flex-shrink: 0;
      }
      .sol-footer a { color: color-mix(in srgb, var(--g-primary) 60%, transparent); text-decoration: none; }
      .sol-footer a:hover { color: var(--g-primary); }

      /* Resize indicator */
      .sol-resize-indicator {
        position: absolute;
        bottom: 6px;
        right: 6px;
        width: 12px;
        height: 12px;
        opacity: 0.3;
        pointer-events: none;
      }
      .sol-resize-indicator::before,
      .sol-resize-indicator::after {
        content: '';
        position: absolute;
        background: var(--g-primary);
        border-radius: 1px;
      }
      .sol-resize-indicator::before {
        width: 8px;
        height: 2px;
        bottom: 0;
        right: 0;
      }
      .sol-resize-indicator::after {
        width: 2px;
        height: 8px;
        bottom: 0;
        right: 0;
      }


      /* Source switch */
      .sol-source { display: inline-flex; border: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent); border-radius: 7px; overflow: hidden; flex-shrink: 0; }
      .sol-source button { border: 0; background: transparent; color: rgba(255,255,255,0.5); font: inherit; font-size: 9px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; padding: 0 10px; height: 30px; cursor: pointer; }
      .sol-source button + button { border-left: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent); }
      .sol-source button.on { background: color-mix(in srgb, var(--g-primary) 16%, transparent); color: var(--g-primary); }
      .sol-source button:disabled { opacity: .35; cursor: not-allowed; }
      .sol-note { padding: 6px 12px; font-size: 9px; color: rgba(255,255,255,0.45); background: rgba(212,175,55,0.05); border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 8%, transparent); }
      .sol-form__err { color: #ff6b81; font-size: 10px; }

      /* Body split: watchlist | chart */
      .sol-main { flex: 1; display: flex; min-height: 0; }
      .sol-watch { width: 190px; flex-shrink: 0; display: flex; flex-direction: column; border-right: 1px solid color-mix(in srgb, var(--g-primary) 10%, transparent); background: rgba(0,0,0,0.3); min-height: 0; }
      .sol-watch__head { display: flex; align-items: center; justify-content: space-between; padding: 7px 10px; font-size: 9px; font-weight: 700; letter-spacing: .14em; color: color-mix(in srgb, var(--g-primary) 80%, transparent); text-transform: uppercase; border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 8%, transparent); }
      .sol-watch__list { flex: 1; overflow-y: auto; min-height: 0; }
      .sol-watch__row { display: grid; grid-template-columns: 10px 18px 1fr auto 16px; grid-template-rows: auto auto; column-gap: 6px; align-items: center; padding: 6px 8px; cursor: pointer; border-bottom: 1px solid rgba(255,255,255,0.03); border-left: 2px solid transparent; outline: none; }
      .sol-watch__row:hover, .sol-watch__row:focus-visible { background: color-mix(in srgb, var(--g-primary) 6%, transparent); }
      .sol-watch__row.active { background: color-mix(in srgb, var(--g-primary) 10%, transparent); border-left-color: var(--g-primary); }
      .sol-watch__grip { grid-row: 1 / 3; color: rgba(255,255,255,0.18); font-size: 9px; cursor: grab; letter-spacing: -2px; }
      .sol-watch__img { grid-row: 1 / 3; width: 18px; height: 18px; border-radius: 50%; object-fit: cover; }
      .sol-watch__img--mono { display: grid; place-items: center; background: color-mix(in srgb, var(--g-primary) 18%, transparent); color: var(--g-primary); font-size: 9px; font-weight: 800; }
      .sol-watch__sym { font-size: 11px; font-weight: 700; color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .sol-watch__px { font-size: 10px; color: rgba(255,255,255,0.8); text-align: right; font-variant-numeric: tabular-nums; }
      .sol-watch__chg { grid-column: 3 / 5; font-size: 9px; text-align: right; font-variant-numeric: tabular-nums; }
      .sol-watch__chg.up { color: #00ff88; } .sol-watch__chg.down { color: #ff3366; }
      .sol-watch__rm { grid-row: 1 / 3; grid-column: 5; width: 16px; height: 16px; border: 0; background: transparent; color: rgba(255,255,255,0.25); cursor: pointer; font-size: 13px; line-height: 1; padding: 0; opacity: 0; }
      .sol-watch__row:hover .sol-watch__rm, .sol-watch__row:focus-visible .sol-watch__rm { opacity: 1; }
      .sol-watch__rm:hover { color: #ff3366; }
      .sol-watch__empty { padding: 16px 10px; font-size: 10px; color: rgba(255,255,255,0.35); text-align: center; }
      .sol-native { display: block; width: 100%; height: 100%; }
      .sol-price { margin-left: auto; text-align: right; flex-shrink: 0; }
      .sol-price__v { font-size: 12px; font-weight: 700; color: #fff; font-variant-numeric: tabular-nums; }
      .sol-price__c { font-size: 9px; } .sol-price__c.up { color: #00ff88; } .sol-price__c.down { color: #ff3366; }

      /* Narrow panel / phone: watchlist becomes a horizontal strip */
      .sol-chart.narrow .sol-main { flex-direction: column; }
      .sol-chart.narrow .sol-watch { width: auto; max-height: 92px; border-right: 0; border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 10%, transparent); }
      .sol-chart.narrow .sol-watch__head { display: none; }
      .sol-chart.narrow .sol-watch__list { display: flex; overflow-x: auto; overflow-y: hidden; }
      .sol-chart.narrow .sol-watch__row { min-width: 128px; border-bottom: 0; border-left: 0; border-bottom: 2px solid transparent; }
      .sol-chart.narrow .sol-watch__row.active { border-bottom-color: var(--g-primary); }
      .sol-chart.narrow .sol-watch__rm { opacity: .6; }
      .sol-chart.mobile { border-radius: 10px; }
      .sol-chart.mobile .sol-header { cursor: default; }
      @media (max-width: 640px) {
        .sol-controls { flex-wrap: wrap; }
        .sol-source { order: 3; width: 100%; }
        .sol-source button { flex: 1; height: 34px; }
      }
    </style>

    ${g8GlassStyles}
    <div
      class="sol-chart g8-page ${state.isDragging ? 'dragging' : ''} ${state.isResizing ? 'resizing' : ''} ${state.isMinimized ? 'minimized' : ''} ${narrow ? 'narrow' : ''} ${mobile ? 'mobile' : ''}"
      style="left: ${position.x}px; top: ${position.y}px; width: ${position.width}px; height: ${state.isMinimized ? 48 : position.height}px;"
      role="dialog"
      aria-label="Solana chart"
      data-ib-target="modal:chart"
    >
      <!-- Resize handles -->
      ${!state.isMinimized && !mobile ? html`
        <div class="sol-resize sol-resize--n" @mousedown=${(e: MouseEvent) => handleResizeStart(e, 'n')}></div>
        <div class="sol-resize sol-resize--s" @mousedown=${(e: MouseEvent) => handleResizeStart(e, 's')}></div>
        <div class="sol-resize sol-resize--e" @mousedown=${(e: MouseEvent) => handleResizeStart(e, 'e')}></div>
        <div class="sol-resize sol-resize--w" @mousedown=${(e: MouseEvent) => handleResizeStart(e, 'w')}></div>
        <div class="sol-resize sol-resize--ne" @mousedown=${(e: MouseEvent) => handleResizeStart(e, 'ne')}></div>
        <div class="sol-resize sol-resize--nw" @mousedown=${(e: MouseEvent) => handleResizeStart(e, 'nw')}></div>
        <div class="sol-resize sol-resize--se" @mousedown=${(e: MouseEvent) => handleResizeStart(e, 'se')}></div>
        <div class="sol-resize sol-resize--sw" @mousedown=${(e: MouseEvent) => handleResizeStart(e, 'sw')}></div>
      ` : nothing}

      <!-- Header (drag handle) -->
      <div class="sol-header" @mousedown=${handleDragStart}>
        <div class="sol-header__icon">${icons.barChart}</div>
        <div class="sol-header__info">
          <div class="sol-header__title">${currentCoin?.symbol || currentCoin?.name || "SOLANA"}</div>
          <div class="sol-header__sub">${currentCoin ? `${currentCoin.name} · ${currentCoin.mint.slice(0, 6)}…${currentCoin.mint.slice(-4)}` : "Select token"}</div>
        </div>
        ${currentCoin && currentPrice ? html`<div class="sol-price">
          <div class="sol-price__v">${fmtPrice(currentPrice.priceUsd)}</div>
          <div class="sol-price__c ${(currentPrice.change24h ?? 0) >= 0 ? "up" : "down"}">${fmtPct(currentPrice.change24h)} 24h</div>
        </div>` : nothing}
        <div class="sol-header__actions">
          <button class="sol-header__btn" @click=${handleMinimize} title="${state.isMinimized ? 'Expand' : 'Minimize'}" aria-label="${state.isMinimized ? 'Expand' : 'Minimize'}">
            ${state.isMinimized ? icons.maximize : icons.minus}
          </button>
          <button class="sol-header__btn" @click=${onClose} title="Close" aria-label="Close chart">${icons.x}</button>
        </div>
      </div>

      <div class="sol-chart__body">
        <!-- Controls -->
        <div class="sol-controls">
          <button
            class="sol-btn-icon"
            @click=${() => onStateChange({ showWatchlist: !showWatchlist })}
            title="${showWatchlist ? 'Hide watchlist' : 'Show watchlist'}"
            aria-pressed=${showWatchlist ? "true" : "false"}
          >
            ${icons.star}
          </button>
          <select 
            class="sol-select" 
            aria-label="Token"
            .value=${currentAddress}
            @change=${(e: Event) => handleSelectCoin((e.target as HTMLSelectElement).value)}
          >
            ${items.length === 0 
              ? html`<option value="">No coins saved</option>`
              : items.map(coin => html`
                  <option value=${coin.mint} ?selected=${coin.mint === currentAddress}>${coin.symbol || coin.name}</option>
                `)
            }
          </select>
          <div class="sol-source" role="group" aria-label="Chart source" data-ib-target="control:chart/source">
            <button
              class=${source === "solatrix" ? "on" : ""}
              ?disabled=${!pluginOn}
              title=${pluginOn ? "Native Solatrix chart (indicators, drawings, levels)" : "Enable the Solatrix plugin to use its native chart"}
              aria-pressed=${source === "solatrix" ? "true" : "false"}
              @click=${() => setSource("solatrix")}
            >Solatrix</button>
            <button
              class=${source === "dexscreener" ? "on" : ""}
              aria-pressed=${source === "dexscreener" ? "true" : "false"}
              @click=${() => setSource("dexscreener")}
            >DexScreener</button>
          </div>
          <button 
            class="sol-btn-icon" 
            @click=${() => onStateChange({ showAddForm: !state.showAddForm, formError: "" })}
            title="${state.showAddForm ? 'Cancel' : 'Add Token'}"
          >
            ${state.showAddForm ? icons.x : icons.plus}
          </button>
          <button 
            class="sol-btn-icon" 
            @click=${() => {
              void solanaWatchlist.refreshPrices();
              if (source === "solatrix") {
                (document.querySelector("solatrix-chart") as (HTMLElement & { refresh?: () => void }) | null)?.refresh?.();
              } else {
                onStateChange({ isLoading: true }); setTimeout(() => onStateChange({ isLoading: false }), 1500);
              }
            }}
            title="Refresh"
          >
            ${icons.refresh}
          </button>
        </div>
        ${pref === "solatrix" && !pluginOn ? html`<div class="sol-note">Solatrix plugin is off — showing DexScreener. Enable Solatrix in Setup › Plugins for the native chart.</div>` : nothing}

        <!-- Add form -->
        ${state.showAddForm ? html`
          <div class="sol-form">
            <input 
              type="text" 
              class="sol-input" 
              placeholder="Token mint address..."
              aria-label="Token mint address"
              .value=${state.inputAddress}
              @input=${(e: Event) => onStateChange({ inputAddress: (e.target as HTMLInputElement).value })}
              @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && handleAddCoin()}
            />
            <div class="sol-form__row">
              <input 
                type="text" 
                class="sol-input" 
                placeholder="Name (optional)"
                aria-label="Name"
                .value=${state.inputName}
                @input=${(e: Event) => onStateChange({ inputName: (e.target as HTMLInputElement).value })}
                @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && handleAddCoin()}
              />
              <button class="sol-btn-add" @click=${handleAddCoin} ?disabled=${!state.inputAddress.trim()}>ADD</button>
              <button class="sol-btn-cancel" @click=${() => onStateChange({ showAddForm: false, inputAddress: "", inputName: "", formError: "" })}>×</button>
            </div>
            ${state.formError ? html`<div class="sol-form__err" role="alert">${state.formError}</div>` : nothing}
          </div>
        ` : nothing}

        <div class="sol-main">
          ${showWatchlist ? html`
            <div class="sol-watch">
              <div class="sol-watch__head"><span>Watchlist</span><span>${items.length}</span></div>
              <div class="sol-watch__list" role="listbox" aria-label="Watchlist">
                ${items.length ? items.map(watchRow) : html`<div class="sol-watch__empty">No tokens yet — add one with +</div>`}
              </div>
            </div>
          ` : nothing}

          <!-- Chart -->
          <div class="sol-chart-area">
            ${state.isLoading && source === "dexscreener" ? html`
              <div class="sol-loading">
                <div class="sol-spinner"></div>
                <div class="sol-loading__text">Loading chart...</div>
              </div>
            ` : nothing}
            
            ${!currentAddress ? html`
              <div class="sol-empty">
                <div class="sol-empty__icon">${icons.barChart}</div>
                <div class="sol-empty__text">Add a token to view chart</div>
              </div>
            ` : source === "solatrix" ? html`
              <solatrix-chart
                class="sol-native"
                variant="compact"
                .client=${opts.client ?? null}
                .mint=${currentAddress}
                .symbol=${currentCoin?.symbol ?? ""}
              ></solatrix-chart>
            ` : html`
              <iframe 
                class="sol-iframe" 
                title="DexScreener chart"
                src=${chartUrl}
                @load=${() => onStateChange({ isLoading: false })}
              ></iframe>
            `}
          </div>
        </div>

        <div class="sol-footer">
          ${source === "solatrix"
            ? html`Solatrix chart · <a href="https://dexscreener.com/solana/${currentAddress}" target="_blank" rel="noopener">Open in DexScreener</a>`
            : html`<a href="https://dexscreener.com" target="_blank" rel="noopener">DexScreener</a>`}
        </div>
      </div>

      <div class="sol-resize-indicator"></div>
    </div>
  `;
}
