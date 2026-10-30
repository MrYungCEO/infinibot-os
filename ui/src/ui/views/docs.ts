/**
 * In-app docs viewer — three-pane glass-HUD layout.
 *
 * Layout:
 *   ┌────────────┬────────────────────────────┬──────────────┐
 *   │  Tree      │  Article (markdown render) │  Section TOC │
 *   │  + search  │                            │  (scroll-    │
 *   │  + recents │                            │   tracked)   │
 *   │  + pinned  │                            │              │
 *   └────────────┴────────────────────────────┴──────────────┘
 *
 * Backend endpoints (handleDocsRequest):
 *   GET /api/docs/tree           → { tree: DocNode[] }
 *   GET /api/docs/file?path=…    → text/markdown body
 *
 * Theme: reuses the global `--g-*` design tokens so the appearance picker
 * still recolors everything in place. Within Shadow DOM we recreate the
 * look of the new HUD primitives (glass-deep / glass-edge / glass-noise /
 * hud-title / lift-on-hover) since global classes don't pierce shadow.
 *
 * UX features:
 *   - Search filter that auto-expands matching categories.
 *   - Pinned docs section (localStorage-persisted star toggle).
 *   - Recent docs list (last 5 viewed, persisted).
 *   - Right-side TOC built from H2/H3 in the rendered article, scroll-tracked.
 *   - Code blocks get a copy button on hover.
 *   - Heading anchors with click-to-copy permalinks.
 *   - Keyboard: `/` focus search, `Esc` clear/blur, `j`/`k` next/prev doc,
 *     `t` toggle TOC, `[`/`]` collapse/expand sidebar.
 *   - Search-query terms get highlighted inline in the rendered MD.
 *   - Loading skeleton + retry button on error.
 *   - Smooth fade between docs.
 */

import DOMPurify from "dompurify";
import { html, css, LitElement, type PropertyValues, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { marked } from "marked";

interface DocFile {
    type: "file";
    path: string;
    title: string;
    bytes: number;
}
interface DocCategory {
    type: "category";
    path: string;
    title: string;
    children: DocNode[];
}
type DocNode = DocFile | DocCategory;

interface TocItem {
    id: string;
    text: string;
    level: 2 | 3;
}

const STORAGE_LAST = "infinibot:docs:last-path";
const STORAGE_PINNED = "infinibot:docs:pinned";
const STORAGE_RECENT = "infinibot:docs:recent";
const STORAGE_TOC_OPEN = "infinibot:docs:toc-open";
const STORAGE_SIDEBAR_OPEN = "infinibot:docs:sidebar-open";

// Do NOT call marked.setOptions() here — it mutates global state and breaks
// every other markdown surface that relies on breaks: true.
// Instead pass options per-call (see loadFile).

@customElement("docs-view")
export class DocsView extends LitElement {
    @state() private tree: DocNode[] = [];
    @state() private flatFiles: DocFile[] = [];
    @state() private treeLoading = true;
    @state() private treeError: string | null = null;

    @state() private currentPath: string | null = null;
    @state() private currentTitle: string = "";
    @state() private contentHtml: string = "";
    @state() private contentLoading = false;
    @state() private contentError: string | null = null;
    @state() private contentFadeKey = 0;

    @state() private query: string = "";
    @state() private expanded: Set<string> = new Set();

    @state() private pinned: Set<string> = new Set();
    @state() private recents: string[] = [];

    @state() private toc: TocItem[] = [];
    @state() private activeTocId: string | null = null;
    @state() private tocOpen: boolean = true;
    @state() private sidebarOpen: boolean = true;

    private articleEl: HTMLElement | null = null;
    private scrollSpyHandler: (() => void) | null = null;
    private keyHandler: ((e: KeyboardEvent) => void) | null = null;

    static styles = css`
        /* ── Glass G1 ─────────────────────────────────────────────────
         * Two floating frosted panels (library · reader+TOC) over a slow
         * gold aurora. Everything reads the global --glass-* tokens (custom
         * properties pierce the shadow root), so dark / light / palette /
         * reduced-transparency / perf-mode follow automatically.
         * ──────────────────────────────────────────────────────────── */
        :host {
            --dv-gold: var(--glass-gold, #d9b45f);
            --dv-gold-hi: var(--glass-gold-hi, #f1d38a);
            --dv-gold-deep: var(--glass-gold-deep, #a8762c);
            --dv-fg: var(--glass-fg, #f4f1ea);
            --dv-fg-2: var(--glass-fg-2, rgba(244, 241, 234, 0.72));
            --dv-fg-3: var(--glass-fg-3, rgba(244, 241, 234, 0.5));
            --dv-fg-4: var(--glass-fg-4, rgba(244, 241, 234, 0.32));
            --dv-line: var(--glass-stroke, rgba(255, 255, 255, 0.075));
            --dv-line-strong: var(--glass-stroke-strong, rgba(255, 255, 255, 0.13));
            --dv-recess: color-mix(in srgb, var(--glass-base, #07070a) 58%, transparent);
            --dv-hairline: linear-gradient(135deg, var(--glass-gold-a40, rgba(241, 211, 138, 0.5)), var(--glass-gold-a06, rgba(217, 180, 95, 0.06)) 38%, transparent 62%, var(--glass-gold-a24, rgba(241, 211, 138, 0.28)));
            --dv-ease: var(--glass-ease, cubic-bezier(0.22, 1, 0.36, 1));
            --dv-spring: var(--glass-spring, cubic-bezier(0.34, 1.36, 0.64, 1));
            --dv-mono: var(--glass-font-mono, "JetBrains Mono", ui-monospace, monospace);
            --dv-ok: #4cc98a;
            --dv-bad: #ff8a7a;
            display: flex;
            gap: 12px;
            height: 100%;
            min-height: 0;
            width: 100%;
            padding: 4px 2px 8px;
            box-sizing: border-box;
            color: var(--dv-fg);
            font-family: var(--glass-font, "Inter", "SF Pro Text", system-ui, -apple-system, sans-serif);
            -webkit-font-smoothing: antialiased;
            background: transparent;
            position: relative;
            isolation: isolate;
        }
        :host-context([data-theme="light"]) {
            --dv-ok: #1f9a5c;
            --dv-bad: #b4372a;
        }
        * { box-sizing: border-box; }
        button { font: inherit; }
        :is(button, a, input, [tabindex]):focus-visible {
            outline: none;
            box-shadow: var(--glass-focus-ring, 0 0 0 2px var(--dv-gold));
        }

        /* ── Aurora ── */
        .aurora {
            position: absolute;
            inset: 0;
            overflow: hidden;
            pointer-events: none;
            z-index: -1;
        }
        .aurora::before,
        .aurora::after {
            content: "";
            position: absolute;
            width: 56vmax;
            height: 56vmax;
            border-radius: 50%;
            filter: blur(90px);
            background: radial-gradient(circle, var(--glass-gold-a40, rgba(217, 180, 95, 0.4)), transparent 62%);
            top: -38vmax;
            left: -16vmax;
            opacity: 0.34;
            animation: dv-drift 40s var(--dv-ease) infinite alternate;
        }
        .aurora::after {
            background: radial-gradient(circle, var(--glass-gold-a24, rgba(168, 118, 44, 0.3)), transparent 60%);
            top: auto;
            left: auto;
            bottom: -44vmax;
            right: -22vmax;
            opacity: 0.26;
            animation-duration: 52s;
        }
        :host-context([data-theme="light"]) .aurora::before { opacity: 0.2; }
        :host-context([data-theme="light"]) .aurora::after { opacity: 0.14; }
        @keyframes dv-drift {
            from { transform: translate3d(0, 0, 0) scale(1); }
            to { transform: translate3d(7vmax, 4vmax, 0) scale(1.1); }
        }

        /* ── Panels: frosted, gold hairline, specular top ── */
        .sidebar,
        .viewer {
            position: relative;
            isolation: isolate;
            border-radius: var(--glass-radius-lg, 20px);
            background: var(--glass-sheen), var(--glass-2, rgba(24, 22, 19, 0.56));
            backdrop-filter: var(--glass-blur, blur(20px) saturate(170%));
            -webkit-backdrop-filter: var(--glass-blur, blur(20px) saturate(170%));
            box-shadow: var(--glass-elev-2, 0 18px 44px -18px rgba(0, 0, 0, 0.7));
            overflow: hidden;
        }
        .sidebar::before,
        .viewer::before {
            content: "";
            position: absolute;
            inset: 0;
            border-radius: inherit;
            padding: 1px;
            background: var(--dv-hairline);
            -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
            -webkit-mask-composite: xor;
            mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0);
            pointer-events: none;
            z-index: 3;
        }
        .viewer::before { background: var(--glass-edge-soft, var(--dv-hairline)); }

        .hud-title {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            font: 600 11px/1 var(--glass-font, inherit);
            letter-spacing: 0.18em;
            text-transform: uppercase;
            color: var(--dv-gold);
        }
        .hud-title::before {
            content: "";
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: var(--dv-gold);
            box-shadow: 0 0 10px var(--dv-gold);
        }

        /* ── Sidebar ─────────────────────────────────────── */
        .sidebar {
            width: 300px;
            min-width: 264px;
            max-width: 360px;
            display: flex;
            flex-direction: column;
            transition: width var(--glass-dur, 0.24s) var(--dv-ease), min-width var(--glass-dur, 0.24s) var(--dv-ease);
        }
        :host([data-sidebar-collapsed]) .sidebar {
            width: 56px;
            min-width: 56px;
            max-width: 56px;
        }
        :host([data-sidebar-collapsed]) .sidebar > *:not(.sidebar__rail-toggle) {
            display: none;
        }
        .sidebar__rail-toggle {
            position: absolute;
            top: 14px;
            left: 50%;
            transform: translateX(-50%);
            width: 32px;
            height: 32px;
            display: none;
            align-items: center;
            justify-content: center;
            border-radius: 10px;
            background: var(--glass-gold-a10, rgba(217, 180, 95, 0.1));
            color: var(--dv-gold);
            cursor: pointer;
            border: 1px solid var(--glass-stroke-gold, rgba(217, 180, 95, 0.3));
            z-index: 4;
        }
        :host([data-sidebar-collapsed]) .sidebar__rail-toggle { display: flex; }

        .sidebar__header {
            padding: 18px 16px 14px;
            border-bottom: 1px solid var(--dv-line);
            display: flex;
            flex-direction: column;
            gap: 12px;
        }
        .sidebar__title-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
        }
        .sidebar__heading {
            margin: 8px 0 0;
            font: 650 22px/1.1 var(--font-ui-display, var(--glass-font, inherit));
            letter-spacing: -0.025em;
            color: var(--dv-fg);
        }
        .sidebar__heading .gold {
            background: linear-gradient(120deg, var(--dv-gold-hi), var(--dv-gold) 45%, var(--dv-gold-deep));
            -webkit-background-clip: text;
            background-clip: text;
            color: transparent;
        }
        .sidebar__collapse {
            width: 28px;
            height: 28px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: transparent;
            border: 1px solid transparent;
            color: var(--dv-fg-3);
            cursor: pointer;
            border-radius: 8px;
            font-size: 13px;
            transition: background var(--glass-dur-fast, 0.14s) var(--dv-ease), color var(--glass-dur-fast, 0.14s) var(--dv-ease);
        }
        .sidebar__collapse:hover {
            background: var(--glass-hover);
            border-color: var(--dv-line);
            color: var(--dv-gold);
        }

        .search { position: relative; }
        .search__input {
            width: 100%;
            height: 36px;
            padding: 0 32px 0 34px;
            background: var(--dv-recess);
            border: 1px solid var(--dv-line-strong);
            border-radius: var(--glass-radius-sm, 10px);
            color: var(--dv-fg);
            font: 400 13px/1 var(--glass-font, inherit);
            outline: none;
            box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.2);
            transition: border-color var(--glass-dur-fast, 0.14s) var(--dv-ease), box-shadow var(--glass-dur, 0.24s) var(--dv-ease);
        }
        .search__input::placeholder { color: var(--dv-fg-4); }
        .search__input:focus,
        .search__input:focus-visible {
            border-color: var(--glass-stroke-gold, rgba(217, 180, 95, 0.4));
            box-shadow: var(--glass-focus-ring, 0 0 0 3px rgba(217, 180, 95, 0.15));
        }
        .search__icon {
            position: absolute;
            left: 11px;
            top: 50%;
            transform: translateY(-50%);
            display: inline-grid;
            color: var(--dv-fg-3);
            pointer-events: none;
        }
        .search__icon svg { width: 14px; height: 14px; }
        .search__clear {
            position: absolute;
            right: 6px;
            top: 50%;
            transform: translateY(-50%);
            width: 24px;
            height: 24px;
            display: grid;
            place-items: center;
            background: transparent;
            border: 0;
            color: var(--dv-fg-3);
            cursor: pointer;
            font-size: 15px;
            border-radius: 7px;
        }
        .search__clear:hover {
            background: var(--glass-hover);
            color: var(--dv-gold);
        }
        .search__hint {
            font-size: 11px;
            color: var(--dv-fg-3);
            display: flex;
            justify-content: space-between;
            gap: 6px;
        }
        kbd {
            display: inline-block;
            min-width: 18px;
            padding: 2px 5px;
            border: 1px solid var(--dv-line-strong);
            border-bottom-width: 2px;
            border-radius: 5px;
            background: var(--glass-hover);
            color: var(--dv-fg-2);
            font: 500 10px/1 var(--dv-mono);
            text-align: center;
        }

        .tree {
            flex: 1;
            overflow-y: auto;
            padding: 10px 8px 24px;
        }
        .tree::-webkit-scrollbar,
        .article::-webkit-scrollbar,
        .toc::-webkit-scrollbar { width: 8px; }
        .tree::-webkit-scrollbar-thumb,
        .article::-webkit-scrollbar-thumb,
        .toc::-webkit-scrollbar-thumb {
            background: var(--glass-gold-a16, rgba(217, 180, 95, 0.16));
            border-radius: 6px;
        }
        .tree::-webkit-scrollbar-track,
        .article::-webkit-scrollbar-track,
        .toc::-webkit-scrollbar-track { background: transparent; }

        .tree-section { margin: 4px 2px 14px; }
        .tree-section__head {
            font: 600 10.5px/1 var(--glass-font, inherit);
            letter-spacing: 0.16em;
            text-transform: uppercase;
            color: var(--dv-fg-3);
            padding: 6px 8px 8px;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .tree-section__head::after {
            content: "";
            flex: 1;
            height: 1px;
            background: linear-gradient(90deg, var(--glass-gold-a24, rgba(217, 180, 95, 0.24)), transparent);
        }

        .tree-cat { margin: 2px 0; }
        .tree-cat__head {
            display: flex;
            align-items: center;
            gap: 8px;
            min-height: 32px;
            padding: 0 10px;
            border-radius: 9px;
            cursor: pointer;
            color: var(--dv-fg);
            font-size: 12.5px;
            font-weight: 600;
            user-select: none;
            transition: background var(--glass-dur-fast, 0.14s) var(--dv-ease);
        }
        .tree-cat__head:hover { background: var(--glass-hover); }
        .tree-cat__chev {
            font-size: 8px;
            color: var(--dv-fg-3);
            transition: transform var(--glass-dur, 0.24s) var(--dv-spring);
        }
        .tree-cat__head.is-open .tree-cat__chev {
            transform: rotate(90deg);
            color: var(--dv-gold);
        }
        .tree-cat__count {
            margin-left: auto;
            min-width: 22px;
            text-align: center;
            font-size: 11px;
            font-weight: 500;
            font-variant-numeric: tabular-nums;
            color: var(--dv-fg-3);
            padding: 2px 7px;
            background: var(--glass-hover);
            border-radius: 999px;
        }
        .tree-cat__children {
            padding-left: 10px;
            margin: 2px 0 6px 13px;
            border-left: 1px solid var(--dv-line);
        }

        .tree-file {
            display: flex;
            align-items: center;
            gap: 6px;
            min-height: 30px;
            padding: 0 6px 0 12px;
            border-radius: 9px;
            cursor: pointer;
            color: var(--dv-fg-2);
            font-size: 13px;
            line-height: 1.35;
            position: relative;
            transition: background var(--glass-dur-fast, 0.14s) var(--dv-ease), color var(--glass-dur-fast, 0.14s) var(--dv-ease), transform var(--glass-dur, 0.24s) var(--dv-spring);
        }
        .tree-file:hover {
            background: var(--glass-hover);
            color: var(--dv-fg);
            transform: translateX(2px);
        }
        .tree-file.is-active {
            background: var(--glass-gold-a10, rgba(217, 180, 95, 0.1));
            color: var(--dv-fg);
            font-weight: 560;
            box-shadow: inset 0 0 0 1px var(--glass-gold-a16, rgba(217, 180, 95, 0.16));
        }
        .tree-file.is-active::before {
            content: "";
            position: absolute;
            left: 0;
            top: 7px;
            bottom: 7px;
            width: 2px;
            border-radius: 2px;
            background: var(--dv-gold);
            box-shadow: 0 0 8px var(--dv-gold);
        }
        .tree-file__title {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .tree-file__pin {
            opacity: 0;
            width: 24px;
            height: 24px;
            display: grid;
            place-items: center;
            background: transparent;
            border: 0;
            color: var(--dv-fg-3);
            cursor: pointer;
            font-size: 13px;
            border-radius: 7px;
            transition: opacity var(--glass-dur-fast, 0.14s) var(--dv-ease), color var(--glass-dur-fast, 0.14s) var(--dv-ease), transform var(--glass-dur, 0.24s) var(--dv-spring);
        }
        .tree-file:hover .tree-file__pin,
        .tree-file__pin:focus-visible,
        .tree-file__pin.is-active { opacity: 1; }
        .tree-file__pin.is-active { color: var(--dv-gold); }
        .tree-file__pin:hover { color: var(--dv-gold); transform: scale(1.15); }

        .tree-empty {
            display: grid;
            justify-items: center;
            gap: 6px;
            padding: 22px 14px;
            font-size: 12.5px;
            color: var(--dv-fg-3);
            text-align: center;
        }
        .tree-skel { display: grid; gap: 10px; padding: 10px 12px; }
        .tree-skel span { height: 12px; }

        /* ── Article viewer ──────────────────────────────── */
        .viewer {
            flex: 1;
            min-width: 0;
            display: flex;
            min-height: 0;
        }
        .viewer__main {
            flex: 1;
            min-width: 0;
            display: flex;
            flex-direction: column;
            min-height: 0;
        }
        .viewer__bar {
            display: flex;
            align-items: center;
            gap: 8px;
            min-height: 56px;
            padding: 10px 18px;
            border-bottom: 1px solid var(--dv-line);
            background: color-mix(in srgb, var(--dv-fg) 1.5%, transparent);
        }
        .viewer__crumbs {
            flex: 1;
            min-width: 0;
            font-size: 12.5px;
            color: var(--dv-fg-3);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            padding-left: 4px;
        }
        .viewer__crumbs strong {
            color: var(--dv-fg);
            font-weight: 620;
        }
        .viewer__crumbs .crumb-path {
            margin-left: 8px;
            font: 400 11px/1 var(--dv-mono);
            color: var(--dv-fg-4);
        }
        .viewer__nav-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            flex: none;
            width: 32px;
            height: 32px;
            background: var(--glass-sheen), var(--glass-hover);
            border: 1px solid var(--dv-line-strong);
            color: var(--dv-fg-2);
            border-radius: var(--glass-radius-sm, 10px);
            cursor: pointer;
            font-size: 15px;
            box-shadow: var(--glass-specular, inset 0 1px 0 rgba(255, 255, 255, 0.06));
            transition: transform var(--glass-dur-fast, 0.14s) var(--dv-spring), border-color var(--glass-dur-fast, 0.14s) var(--dv-ease), color var(--glass-dur-fast, 0.14s) var(--dv-ease);
        }
        .viewer__nav-btn:hover:not(:disabled) {
            border-color: var(--glass-stroke-gold, rgba(217, 180, 95, 0.3));
            color: var(--dv-gold);
            transform: var(--glass-lift, translateY(-1px));
        }
        .viewer__nav-btn:active:not(:disabled) { transform: scale(0.95); }
        .viewer__nav-btn.is-active { color: var(--dv-gold); border-color: var(--glass-stroke-gold, rgba(217, 180, 95, 0.3)); }
        .viewer__nav-btn:disabled { opacity: 0.35; cursor: not-allowed; }

        .article {
            flex: 1;
            min-height: 0;
            overflow-y: auto;
            padding: 36px 48px 88px;
            scroll-behavior: smooth;
            position: relative;
        }
        .article__inner {
            max-width: 760px;
            margin: 0 auto;
            line-height: 1.72;
            font-size: 15px;
            color: var(--dv-fg-2);
            opacity: 1;
            transition: opacity 0.22s ease;
            animation: dv-rise 0.5s var(--dv-ease) both;
        }
        @keyframes dv-rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
        .article__inner.is-fading { opacity: 0; }
        .article__inner h1,
        .article__inner h2,
        .article__inner h3,
        .article__inner h4 {
            color: var(--dv-fg);
            font-family: var(--font-ui-display, var(--glass-font, inherit));
            font-weight: 650;
            letter-spacing: -0.02em;
            line-height: 1.2;
            margin: 1.8em 0 0.6em;
            scroll-margin-top: 16px;
        }
        .article__inner h1 {
            font-size: clamp(28px, 3vw, 36px);
            letter-spacing: -0.03em;
            margin-top: 0;
            padding-bottom: 18px;
            position: relative;
            background: linear-gradient(120deg, var(--dv-fg) 55%, var(--dv-gold));
            -webkit-background-clip: text;
            background-clip: text;
            color: transparent;
        }
        .article__inner h1::after {
            content: "";
            position: absolute;
            left: 0;
            right: 0;
            bottom: 0;
            height: 1px;
            background: linear-gradient(90deg, var(--dv-gold), var(--glass-gold-a16, rgba(217, 180, 95, 0.16)) 40%, transparent);
        }
        .article__inner h2 {
            font-size: 22px;
            padding-top: 6px;
        }
        .article__inner h3 {
            font-size: 17px;
            color: var(--dv-fg);
        }
        .article__inner h2,
        .article__inner h3 { position: relative; }
        .article__inner .heading-anchor {
            position: absolute;
            left: -1.2em;
            top: 0.1em;
            opacity: 0;
            color: var(--dv-gold);
            font-weight: 400;
            text-decoration: none;
            border: 0;
            transition: opacity var(--glass-dur-fast, 0.14s) var(--dv-ease);
            font-size: 0.8em;
        }
        .article__inner h2:hover .heading-anchor,
        .article__inner h3:hover .heading-anchor { opacity: 0.75; }
        .article__inner strong { color: var(--dv-fg); font-weight: 620; }
        .article__inner p,
        .article__inner ul,
        .article__inner ol,
        .article__inner blockquote,
        .article__inner pre { margin: 0.9em 0; }
        .article__inner ul,
        .article__inner ol { padding-left: 1.4em; }
        .article__inner li { margin: 0.35em 0; }
        .article__inner li::marker { color: var(--dv-gold); }
        .article__inner a {
            color: var(--dv-gold);
            text-decoration: none;
            border-bottom: 1px solid var(--glass-gold-a40, rgba(217, 180, 95, 0.4));
            transition: border-color var(--glass-dur-fast, 0.14s) var(--dv-ease), color var(--glass-dur-fast, 0.14s) var(--dv-ease);
        }
        .article__inner a:hover {
            color: var(--dv-gold-hi);
            border-bottom-color: var(--dv-gold);
        }
        :host-context([data-theme="light"]) .article__inner a:hover { color: var(--dv-gold-deep); }
        .article__inner code {
            font-family: var(--dv-mono);
            font-size: 0.86em;
            padding: 2px 6px;
            background: var(--glass-gold-a06, rgba(217, 180, 95, 0.06));
            border: 1px solid var(--glass-gold-a16, rgba(217, 180, 95, 0.16));
            border-radius: 6px;
            color: var(--dv-fg);
        }
        .article__inner pre {
            position: relative;
            background: var(--dv-recess);
            border: 1px solid var(--dv-line);
            border-radius: 14px;
            padding: 16px 18px;
            overflow-x: auto;
            box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.22), var(--glass-specular, inset 0 1px 0 rgba(255, 255, 255, 0.05));
        }
        .article__inner pre code {
            background: transparent;
            border: 0;
            padding: 0;
            color: var(--dv-fg);
            font-size: 12.5px;
            line-height: 1.6;
        }
        .article__inner pre .copy-btn {
            position: absolute;
            top: 8px;
            right: 8px;
            height: 26px;
            background: var(--glass-sheen), var(--glass-3, rgba(30, 27, 23, 0.66));
            border: 1px solid var(--dv-line-strong);
            color: var(--dv-fg-2);
            font: 500 11px/1 var(--glass-font, inherit);
            padding: 0 10px;
            border-radius: 8px;
            cursor: pointer;
            opacity: 0;
            transition: opacity var(--glass-dur-fast, 0.14s) var(--dv-ease), transform var(--glass-dur-fast, 0.14s) var(--dv-spring), color var(--glass-dur-fast, 0.14s) var(--dv-ease);
        }
        .article__inner pre:hover .copy-btn,
        .article__inner pre .copy-btn:focus-visible { opacity: 1; }
        .article__inner pre .copy-btn:hover {
            color: var(--dv-gold);
            border-color: var(--glass-stroke-gold, rgba(217, 180, 95, 0.3));
            transform: translateY(-1px);
        }
        .article__inner pre .copy-btn.is-copied {
            color: var(--dv-ok);
            border-color: color-mix(in srgb, var(--dv-ok) 40%, transparent);
        }
        .article__inner blockquote {
            margin: 1.2em 0;
            padding: 12px 18px;
            border-left: 2px solid var(--dv-gold);
            background: linear-gradient(90deg, var(--glass-gold-a10, rgba(217, 180, 95, 0.1)), transparent 80%);
            border-radius: 0 12px 12px 0;
            color: var(--dv-fg-2);
        }
        .article__inner table {
            width: 100%;
            border-collapse: separate;
            border-spacing: 0;
            margin: 1.2em 0;
            font-size: 13.5px;
            border: 1px solid var(--dv-line);
            border-radius: 12px;
            overflow: hidden;
            display: block;
            overflow-x: auto;
        }
        .article__inner th,
        .article__inner td {
            padding: 10px 14px;
            border-bottom: 1px solid var(--dv-line);
            text-align: left;
        }
        .article__inner tr:last-child td { border-bottom: 0; }
        .article__inner tbody tr:hover td { background: var(--glass-gold-a06, rgba(217, 180, 95, 0.06)); }
        .article__inner th {
            background: var(--glass-hover);
            color: var(--dv-fg-3);
            font-size: 10.5px;
            font-weight: 600;
            letter-spacing: 0.12em;
            text-transform: uppercase;
        }
        .article__inner td { font-variant-numeric: tabular-nums; }
        .article__inner hr {
            border: 0;
            height: 1px;
            background: linear-gradient(90deg, transparent, var(--glass-gold-a24, rgba(217, 180, 95, 0.24)), transparent);
            margin: 2.4em 0;
        }
        .article__inner img {
            max-width: 100%;
            border-radius: 12px;
            border: 1px solid var(--dv-line);
            box-shadow: var(--glass-elev-1, 0 8px 24px -12px rgba(0, 0, 0, 0.55));
        }
        .article__inner mark {
            background: var(--glass-gold-a40, rgba(217, 180, 95, 0.4));
            color: var(--dv-fg);
            padding: 0 3px;
            border-radius: 4px;
        }

        .empty {
            flex: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 10px;
            padding: 32px 20px;
            text-align: center;
            color: var(--dv-fg-2);
        }
        .empty__icon {
            display: grid;
            place-items: center;
            width: 54px;
            height: 54px;
            border-radius: 16px;
            color: var(--dv-gold);
            background: radial-gradient(circle at 30% 20%, var(--glass-gold-a24, rgba(217, 180, 95, 0.24)), var(--glass-gold-a06, rgba(217, 180, 95, 0.06)));
            box-shadow: inset 0 0 0 1px var(--glass-stroke-gold, rgba(217, 180, 95, 0.3)), var(--glass-glow-soft, 0 0 22px -6px rgba(217, 180, 95, 0.4));
            font-size: 22px;
        }
        .empty__icon--bad {
            color: var(--dv-bad);
            background: color-mix(in srgb, var(--dv-bad) 10%, transparent);
            box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--dv-bad) 32%, transparent);
        }
        .empty__title {
            font: 620 16px/1.3 var(--font-ui-display, var(--glass-font, inherit));
            letter-spacing: -0.01em;
            color: var(--dv-fg);
        }
        .empty__hint {
            font-size: 12.5px;
            line-height: 1.5;
            max-width: 380px;
            color: var(--dv-fg-3);
            word-break: break-word;
        }
        .empty__btn {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            height: 32px;
            padding: 0 14px;
            margin-top: 4px;
            border: 1px solid color-mix(in srgb, var(--dv-gold) 60%, transparent);
            background: var(--glass-gold-fill, var(--dv-gold));
            color: var(--glass-ink, #0b0906);
            border-radius: var(--glass-radius-sm, 10px);
            cursor: pointer;
            font: 600 12.5px/1 var(--glass-font, inherit);
            box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.45), 0 6px 20px -8px var(--glass-gold-a40, rgba(217, 180, 95, 0.4));
            transition: transform var(--glass-dur-fast, 0.14s) var(--dv-spring), box-shadow var(--glass-dur, 0.24s) var(--dv-ease);
        }
        .empty__btn:hover { transform: var(--glass-lift, translateY(-1px)); }
        .empty__btn:active { transform: scale(0.97); }

        /* Skeleton loading state — shimmer on placeholder bars. */
        .skeleton {
            display: flex;
            flex-direction: column;
            gap: 14px;
            max-width: 760px;
            margin: 0 auto;
            animation: none;
        }
        .skeleton__bar,
        .tree-skel span {
            height: 12px;
            border-radius: 8px;
            background: linear-gradient(90deg, var(--glass-hover) 0%, var(--glass-gold-a10, rgba(217, 180, 95, 0.1)) 50%, var(--glass-hover) 100%);
            background-size: 200% 100%;
            animation: skeleton-shimmer 1.4s linear infinite;
        }
        .skeleton__bar.tall {
            height: 30px;
            width: 60%;
            margin-bottom: 10px;
        }
        @keyframes skeleton-shimmer {
            0% { background-position: 200% 0; }
            100% { background-position: -200% 0; }
        }

        .spinner {
            width: 18px;
            height: 18px;
            border: 2px solid var(--glass-gold-a24, rgba(217, 180, 95, 0.24));
            border-top-color: var(--dv-gold);
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        /* ── Right TOC ───────────────────────────────────── */
        .toc {
            width: 236px;
            min-width: 216px;
            max-width: 260px;
            border-left: 1px solid var(--dv-line);
            padding: 24px 14px;
            overflow-y: auto;
            background: color-mix(in srgb, var(--dv-fg) 1.5%, transparent);
            transition: width var(--glass-dur, 0.24s) var(--dv-ease), padding var(--glass-dur, 0.24s) var(--dv-ease);
        }
        :host([data-toc-collapsed]) .toc {
            width: 0;
            min-width: 0;
            padding: 0;
            border-left: 0;
            overflow: hidden;
        }
        .toc__head {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 0 6px 12px;
            margin-bottom: 8px;
            border-bottom: 1px solid var(--dv-line);
        }
        .toc__head .hud-title { font-size: 10.5px; }
        .toc__list {
            display: flex;
            flex-direction: column;
            gap: 1px;
        }
        .toc__link {
            display: block;
            padding: 6px 8px 6px 12px;
            border-left: 2px solid transparent;
            cursor: pointer;
            color: var(--dv-fg-3);
            font-size: 12.5px;
            line-height: 1.4;
            text-decoration: none;
            border-radius: 0 8px 8px 0;
            transition: background var(--glass-dur-fast, 0.14s) var(--dv-ease), color var(--glass-dur-fast, 0.14s) var(--dv-ease), border-color var(--glass-dur-fast, 0.14s) var(--dv-ease);
        }
        .toc__link:hover {
            background: var(--glass-hover);
            color: var(--dv-fg);
        }
        .toc__link.is-active {
            border-left-color: var(--dv-gold);
            color: var(--dv-fg);
            font-weight: 560;
            background: linear-gradient(90deg, var(--glass-gold-a10, rgba(217, 180, 95, 0.1)), transparent);
        }
        .toc__link.lvl-3 {
            padding-left: 24px;
            font-size: 12px;
        }
        .toc__empty {
            padding: 0 6px;
            font-size: 12px;
            color: var(--dv-fg-4);
        }

        @media (max-width: 1100px) {
            .toc { display: none; }
        }
        @media (max-width: 760px) {
            :host {
                flex-direction: column;
                gap: 10px;
                height: auto;
                min-height: 100%;
            }
            .sidebar {
                width: 100%;
                min-width: 0;
                max-width: none;
                max-height: 46vh;
            }
            :host([data-sidebar-collapsed]) .sidebar {
                width: 100%;
                max-width: none;
                min-width: 0;
                height: 56px;
            }
            .sidebar__heading { font-size: 20px; }
            .search__hint { display: none; }
            .viewer { min-height: 70vh; }
            .viewer__bar { padding: 8px 12px; min-height: 50px; }
            .viewer__crumbs .crumb-path { display: none; }
            .article { padding: 24px 18px 64px; }
            .article__inner { font-size: 14.5px; }
            .article__inner .heading-anchor { display: none; }
        }

        @media (prefers-reduced-motion: reduce) {
            .article { scroll-behavior: auto; }
            .aurora::before,
            .aurora::after,
            .skeleton__bar,
            .tree-skel span,
            .article__inner { animation: none; }
            .tree-file:hover { transform: none; }
            .spinner { animation-duration: 2s; }
        }
        @media (prefers-reduced-transparency: reduce) {
            .sidebar,
            .viewer {
                backdrop-filter: none;
                -webkit-backdrop-filter: none;
                background: var(--glass-solid, #121110);
            }
            .aurora { display: none; }
        }
        :host-context(.perf-mode) .sidebar,
        :host-context(.perf-mode) .viewer {
            backdrop-filter: none;
            -webkit-backdrop-filter: none;
        }
        :host-context(.perf-mode) .aurora::before,
        :host-context(.perf-mode) .aurora::after { animation: none; }
    `;

    // ── Lifecycle ─────────────────────────────────────────────

    connectedCallback(): void {
        super.connectedCallback();
        this.loadFromStorage();
        this.applyAttributes();
        this.installKeyboardHandler();
        void this.loadTree();
    }

    disconnectedCallback(): void {
        super.disconnectedCallback();
        if (this.keyHandler) {
            document.removeEventListener("keydown", this.keyHandler);
            this.keyHandler = null;
        }
        if (this.scrollSpyHandler && this.articleEl) {
            this.articleEl.removeEventListener("scroll", this.scrollSpyHandler);
        }
    }

    private loadFromStorage(): void {
        try {
            const pinned = localStorage.getItem(STORAGE_PINNED);
            if (pinned) this.pinned = new Set(JSON.parse(pinned));
            const recent = localStorage.getItem(STORAGE_RECENT);
            if (recent) this.recents = JSON.parse(recent);
            const tocOpen = localStorage.getItem(STORAGE_TOC_OPEN);
            if (tocOpen != null) this.tocOpen = tocOpen !== "false";
            const sidebarOpen = localStorage.getItem(STORAGE_SIDEBAR_OPEN);
            if (sidebarOpen != null) this.sidebarOpen = sidebarOpen !== "false";
        } catch {
            /* ignore */
        }
    }

    private persistPinned(): void {
        try {
            localStorage.setItem(STORAGE_PINNED, JSON.stringify(Array.from(this.pinned)));
        } catch {
            /* ignore */
        }
    }
    private persistRecents(): void {
        try {
            localStorage.setItem(STORAGE_RECENT, JSON.stringify(this.recents));
        } catch {
            /* ignore */
        }
    }

    private applyAttributes(): void {
        if (this.tocOpen) this.removeAttribute("data-toc-collapsed");
        else this.setAttribute("data-toc-collapsed", "");
        if (this.sidebarOpen) this.removeAttribute("data-sidebar-collapsed");
        else this.setAttribute("data-sidebar-collapsed", "");
    }

    private installKeyboardHandler(): void {
        const handler = (e: KeyboardEvent) => {
            // Don't capture when the user is typing somewhere else.
            const target = e.target as HTMLElement | null;
            const tag = target?.tagName ?? "";
            const isTyping = ["INPUT", "TEXTAREA"].includes(tag) || target?.isContentEditable;
            // `/` always focuses search even from inputs in our shadow root.
            if (e.key === "/" && !isTyping) {
                const input = this.shadowRoot?.querySelector(".search__input") as
                    | HTMLInputElement
                    | null;
                if (input) {
                    e.preventDefault();
                    input.focus();
                    input.select();
                }
                return;
            }
            if (isTyping) {
                if (e.key === "Escape") {
                    (target as HTMLInputElement).blur();
                    if (this.query) this.query = "";
                }
                return;
            }
            if (e.key === "j" || e.key === "ArrowDown") {
                e.preventDefault();
                this.stepFile(1);
            } else if (e.key === "k" || e.key === "ArrowUp") {
                e.preventDefault();
                this.stepFile(-1);
            } else if (e.key === "t") {
                this.toggleToc();
            } else if (e.key === "[") {
                this.toggleSidebar();
            } else if (e.key === "Escape") {
                if (this.query) this.query = "";
            }
        };
        this.keyHandler = handler;
        document.addEventListener("keydown", handler);
    }

    // ── Data loading ──────────────────────────────────────────

    private async loadTree(): Promise<void> {
        this.treeLoading = true;
        this.treeError = null;
        try {
            const resp = await fetch("/api/docs/tree");
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = (await resp.json()) as { tree?: DocNode[] };
            const tree = Array.isArray(data.tree) ? data.tree : [];
            this.tree = tree;
            this.flatFiles = this.flatten(tree);
            const firstCat = tree.find((n): n is DocCategory => n.type === "category");
            if (firstCat) this.expanded.add(firstCat.path);
            const persisted = (() => {
                try {
                    return localStorage.getItem(STORAGE_LAST);
                } catch {
                    return null;
                }
            })();
            if (persisted && this.findFile(tree, persisted)) {
                await this.loadDoc(persisted);
            } else {
                const first = this.flatFiles[0];
                if (first) await this.loadDoc(first.path);
            }
        } catch (err) {
            this.treeError = (err as Error).message;
        } finally {
            this.treeLoading = false;
        }
    }

    private flatten(nodes: DocNode[]): DocFile[] {
        const out: DocFile[] = [];
        const walk = (arr: DocNode[]) => {
            for (const n of arr) {
                if (n.type === "file") out.push(n);
                else walk(n.children);
            }
        };
        walk(nodes);
        return out;
    }

    private findFile(nodes: DocNode[], targetPath: string): DocFile | null {
        for (const n of nodes) {
            if (n.type === "file" && n.path === targetPath) return n;
            if (n.type === "category") {
                const found = this.findFile(n.children, targetPath);
                if (found) return found;
            }
        }
        return null;
    }

    private async loadDoc(relPath: string): Promise<void> {
        this.contentLoading = true;
        this.contentError = null;
        const fileNode = this.findFile(this.tree, relPath);
        this.currentPath = relPath;
        this.currentTitle = fileNode?.title ?? relPath;
        // Trigger fade-out
        this.contentFadeKey += 1;
        try {
            try {
                localStorage.setItem(STORAGE_LAST, relPath);
            } catch {
                /* ignore */
            }
            this.pushRecent(relPath);
            const resp = await fetch(`/api/docs/file?path=${encodeURIComponent(relPath)}`);
            if (!resp.ok) {
                const errBody = await resp.text().catch(() => "");
                throw new Error(`HTTP ${resp.status}: ${errBody.slice(0, 120)}`);
            }
            const md = await resp.text();
            const stripped = this.stripFrontmatter(md);
            // Pass gfm+breaks per-call (no global setOptions — see top of file).
            const rawHtml = await marked.parse(stripped, { gfm: true, breaks: false });
            // Inject heading anchors + code-copy buttons + search highlight.
            const enriched = this.enrichHtml(String(rawHtml));
            const safeHtml = DOMPurify.sanitize(enriched, {
                ADD_TAGS: ["details", "summary"],
                ADD_ATTR: ["target", "rel", "id", "data-copy"],
            });
            this.contentHtml = safeHtml;
        } catch (err) {
            this.contentError = (err as Error).message;
            this.contentHtml = "";
            this.toc = [];
        } finally {
            this.contentLoading = false;
            await this.updateComplete;
            const article = this.shadowRoot?.querySelector(".article") as HTMLElement | null;
            if (article) article.scrollTop = 0;
            this.buildTocFromDom();
            this.attachCodeCopyHandlers();
            this.attachScrollSpy();
        }
    }

    private pushRecent(p: string): void {
        const filtered = this.recents.filter((r) => r !== p);
        filtered.unshift(p);
        this.recents = filtered.slice(0, 5);
        this.persistRecents();
    }

    private stripFrontmatter(md: string): string {
        const fm = md.match(/^---[\r\n]+[\s\S]*?^---[\r\n]+/m);
        if (fm && md.startsWith(fm[0])) return md.slice(fm[0].length);
        return md;
    }

    /**
     * Add `id` to h2/h3 (slugified text), append a `¶` permalink anchor,
     * and append a copy button to every `<pre>`. Also wraps search-query
     * matches in `<mark>` if a query is set.
     */
    private enrichHtml(htmlStr: string): string {
        let out = htmlStr;
        // Heading anchors — attach an id matching the slugified text.
        const usedIds = new Set<string>();
        out = out.replace(/<(h[23])>([\s\S]*?)<\/\1>/g, (_full, tag: string, body: string) => {
            const text = body.replace(/<[^>]+>/g, "");
            let id = text
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-|-$/g, "")
                .slice(0, 80);
            if (!id) id = `h-${usedIds.size}`;
            // Disambiguate dupes.
            let unique = id;
            let i = 2;
            while (usedIds.has(unique)) {
                unique = `${id}-${i++}`;
            }
            usedIds.add(unique);
            return `<${tag} id="${unique}">${body}<a class="heading-anchor" href="#${unique}">¶</a></${tag}>`;
        });
        // Code-block copy button.
        out = out.replace(/<pre>([\s\S]*?)<\/pre>/g, (_m, inner: string) => {
            return `<pre>${inner}<button class="copy-btn" data-copy="1" type="button">copy</button></pre>`;
        });
        // Search-term highlighting (case-insensitive, all matches).
        const q = this.query.trim();
        if (q && q.length >= 2) {
            const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            // Don't replace inside tags or inside <pre> blocks (would break them).
            out = out.replace(/<pre[\s\S]*?<\/pre>|<[^>]+>|([^<]+)/g, (m, text: string) => {
                if (!text) return m;
                return text.replace(new RegExp(escaped, "gi"), (hit) => `<mark>${hit}</mark>`);
            });
        }
        return out;
    }

    private buildTocFromDom(): void {
        const root = this.shadowRoot?.querySelector(".article__inner") as HTMLElement | null;
        if (!root) {
            this.toc = [];
            return;
        }
        const headings = Array.from(root.querySelectorAll("h2[id], h3[id]")) as HTMLElement[];
        this.toc = headings.map((h) => ({
            id: h.id,
            text: h.textContent?.replace(/¶$/, "").trim() ?? h.id,
            level: (h.tagName === "H2" ? 2 : 3) as 2 | 3,
        }));
        this.activeTocId = this.toc[0]?.id ?? null;
    }

    private attachCodeCopyHandlers(): void {
        const root = this.shadowRoot?.querySelector(".article__inner") as HTMLElement | null;
        if (!root) return;
        root.querySelectorAll<HTMLButtonElement>("button.copy-btn").forEach((btn) => {
            btn.onclick = (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                const pre = btn.closest("pre");
                const code = pre?.querySelector("code")?.textContent ?? "";
                if (!code) return;
                navigator.clipboard
                    .writeText(code)
                    .then(() => {
                        btn.textContent = "copied";
                        btn.classList.add("is-copied");
                        setTimeout(() => {
                            btn.textContent = "copy";
                            btn.classList.remove("is-copied");
                        }, 1300);
                    })
                    .catch(() => {
                        btn.textContent = "err";
                        setTimeout(() => (btn.textContent = "copy"), 1300);
                    });
            };
        });
    }

    private attachScrollSpy(): void {
        const article = this.shadowRoot?.querySelector(".article") as HTMLElement | null;
        if (!article) return;
        if (this.scrollSpyHandler) {
            article.removeEventListener("scroll", this.scrollSpyHandler);
        }
        const handler = () => {
            const rect = article.getBoundingClientRect();
            const headings = Array.from(
                article.querySelectorAll<HTMLElement>("h2[id], h3[id]"),
            );
            let active: string | null = null;
            for (const h of headings) {
                const top = h.getBoundingClientRect().top - rect.top;
                if (top - 80 <= 0) active = h.id;
                else break;
            }
            if (active && active !== this.activeTocId) {
                this.activeTocId = active;
            }
        };
        this.articleEl = article;
        this.scrollSpyHandler = handler;
        article.addEventListener("scroll", handler, { passive: true });
        handler();
    }

    // ── Click delegation in article (relative .md links) ─────

    private onArticleClick = (e: MouseEvent) => {
        const target = (e.target as HTMLElement)?.closest("a") as HTMLAnchorElement | null;
        if (!target) return;
        const href = target.getAttribute("href") ?? "";
        if (!href) return;
        if (href.startsWith("#")) {
            // In-page anchor — let smooth scroll happen, but use shadow-rooted lookup.
            e.preventDefault();
            const id = href.slice(1);
            const el = this.shadowRoot?.getElementById(id);
            if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
            return;
        }
        if (/^[a-z]+:/i.test(href) || href.startsWith("//")) {
            target.setAttribute("target", "_blank");
            target.setAttribute("rel", "noreferrer noopener");
            return;
        }
        if (href.toLowerCase().endsWith(".md") || href.toLowerCase().includes(".md#")) {
            e.preventDefault();
            const [pathOnly, hash] = href.split("#");
            const baseDir = this.currentPath
                ? this.currentPath.split("/").slice(0, -1).join("/")
                : "";
            const joined = this.normalizeRelative(baseDir ? `${baseDir}/${pathOnly}` : pathOnly);
            void this.loadDoc(joined).then(async () => {
                if (hash) {
                    await this.updateComplete;
                    const el = this.shadowRoot?.getElementById(hash);
                    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
                }
            });
        }
    };

    private normalizeRelative(p: string): string {
        const segs: string[] = [];
        for (const seg of p.split("/")) {
            if (!seg || seg === ".") continue;
            if (seg === "..") {
                segs.pop();
                continue;
            }
            segs.push(seg);
        }
        return segs.join("/");
    }

    // ── Navigation actions ────────────────────────────────────

    private togglePin(p: string, ev: MouseEvent): void {
        ev.stopPropagation();
        if (this.pinned.has(p)) this.pinned.delete(p);
        else this.pinned.add(p);
        this.persistPinned();
        this.requestUpdate();
    }

    private toggleCategory(path: string): void {
        if (this.expanded.has(path)) this.expanded.delete(path);
        else this.expanded.add(path);
        this.requestUpdate();
    }

    private toggleToc(): void {
        this.tocOpen = !this.tocOpen;
        try {
            localStorage.setItem(STORAGE_TOC_OPEN, String(this.tocOpen));
        } catch {
            /* ignore */
        }
        this.applyAttributes();
        this.requestUpdate();
    }

    private toggleSidebar(): void {
        this.sidebarOpen = !this.sidebarOpen;
        try {
            localStorage.setItem(STORAGE_SIDEBAR_OPEN, String(this.sidebarOpen));
        } catch {
            /* ignore */
        }
        this.applyAttributes();
        this.requestUpdate();
    }

    private stepFile(delta: number): void {
        if (this.flatFiles.length === 0) return;
        const idx = this.flatFiles.findIndex((f) => f.path === this.currentPath);
        const next = (idx + delta + this.flatFiles.length) % this.flatFiles.length;
        const target = this.flatFiles[next];
        if (target) void this.loadDoc(target.path);
    }

    /** Filter visible tree based on query, auto-expanding matching categories. */
    private filterAndAutoExpand(nodes: DocNode[], q: string): DocNode[] {
        if (!q) return nodes;
        const lo = q.toLowerCase();
        const filtered: DocNode[] = [];
        for (const n of nodes) {
            if (n.type === "file") {
                if (n.title.toLowerCase().includes(lo) || n.path.toLowerCase().includes(lo)) {
                    filtered.push(n);
                }
            } else {
                const subs = this.filterAndAutoExpand(n.children, q);
                if (subs.length > 0 || n.title.toLowerCase().includes(lo)) {
                    this.expanded.add(n.path);
                    filtered.push({ ...n, children: subs });
                }
            }
        }
        return filtered;
    }

    private countFiles(node: DocNode): number {
        if (node.type === "file") return 1;
        let n = 0;
        for (const c of node.children) n += this.countFiles(c);
        return n;
    }

    // ── Render ────────────────────────────────────────────────

    private renderTreeNodes(nodes: DocNode[]): TemplateResult {
        if (nodes.length === 0) {
            return html`<div class="tree-empty">No matches.</div>`;
        }
        return html`
            ${nodes.map((n) => {
                if (n.type === "category") {
                    const open = this.expanded.has(n.path);
                    return html`
                        <div class="tree-cat">
                            <div
                                class="tree-cat__head ${open ? "is-open" : ""}"
                                @click=${() => this.toggleCategory(n.path)}
                            >
                                <span class="tree-cat__chev">▶</span>
                                <span>${n.title}</span>
                                <span class="tree-cat__count">${this.countFiles(n)}</span>
                            </div>
                            ${open
                                ? html`<div class="tree-cat__children">
                                      ${this.renderTreeNodes(n.children)}
                                  </div>`
                                : null}
                        </div>
                    `;
                }
                return this.renderFileRow(n);
            })}
        `;
    }

    private renderFileRow(n: DocFile): TemplateResult {
        const active = n.path === this.currentPath;
        const isPinned = this.pinned.has(n.path);
        return html`
            <div
                class="tree-file ${active ? "is-active" : ""}"
                @click=${() => void this.loadDoc(n.path)}
                title=${n.path}
            >
                <span class="tree-file__title">${n.title}</span>
                <button
                    class="tree-file__pin ${isPinned ? "is-active" : ""}"
                    title=${isPinned ? "Unpin" : "Pin"}
                    @click=${(e: MouseEvent) => this.togglePin(n.path, e)}
                >
                    ${isPinned ? "★" : "☆"}
                </button>
            </div>
        `;
    }

    private renderPinnedSection(): TemplateResult | null {
        if (this.pinned.size === 0) return null;
        const files = Array.from(this.pinned)
            .map((p) => this.findFile(this.tree, p))
            .filter((f): f is DocFile => !!f);
        if (files.length === 0) return null;
        return html`
            <div class="tree-section">
                <div class="tree-section__head">★ Pinned</div>
                ${files.map((f) => this.renderFileRow(f))}
            </div>
        `;
    }

    private renderRecentSection(): TemplateResult | null {
        if (this.recents.length === 0) return null;
        const files = this.recents
            .filter((p) => p !== this.currentPath)
            .map((p) => this.findFile(this.tree, p))
            .filter((f): f is DocFile => !!f)
            .slice(0, 5);
        if (files.length === 0) return null;
        return html`
            <div class="tree-section">
                <div class="tree-section__head">Recent</div>
                ${files.map((f) => this.renderFileRow(f))}
            </div>
        `;
    }

    private renderToc(): TemplateResult {
        if (this.toc.length === 0) {
            return html`
                <div class="toc">
                    <div class="toc__head">
                        <div class="hud-title">On This Page</div>
                    </div>
                    <div class="toc__empty">No sections.</div>
                </div>
            `;
        }
        return html`
            <div class="toc">
                <div class="toc__head">
                    <div class="hud-title">On This Page</div>
                </div>
                <div class="toc__list">
                    ${this.toc.map(
                        (item) => html`
                            <a
                                class="toc__link lvl-${item.level} ${item.id === this.activeTocId
                                    ? "is-active"
                                    : ""}"
                                href="#${item.id}"
                                @click=${(e: MouseEvent) => {
                                    e.preventDefault();
                                    const el = this.shadowRoot?.getElementById(item.id);
                                    if (el)
                                        el.scrollIntoView({ behavior: "smooth", block: "start" });
                                    this.activeTocId = item.id;
                                }}
                            >
                                ${item.text}
                            </a>
                        `,
                    )}
                </div>
            </div>
        `;
    }

    private renderSkeleton(): TemplateResult {
        return html`
            <div class="article">
                <div class="article__inner skeleton">
                    <div class="skeleton__bar tall"></div>
                    <div class="skeleton__bar" style="width:90%"></div>
                    <div class="skeleton__bar" style="width:70%"></div>
                    <div class="skeleton__bar" style="width:80%"></div>
                    <div class="skeleton__bar" style="width:50%"></div>
                    <div class="skeleton__bar" style="width:85%"></div>
                </div>
            </div>
        `;
    }

    render() {
        const visibleTree = this.filterAndAutoExpand(this.tree, this.query);

        const idx = this.flatFiles.findIndex((f) => f.path === this.currentPath);
        const hasPrev = idx > 0;
        const hasNext = idx >= 0 && idx < this.flatFiles.length - 1;

        return html`
            <div class="aurora" aria-hidden="true"></div>
            <aside class="sidebar" aria-label="Documentation library">
                <button
                    class="sidebar__rail-toggle"
                    title="Expand sidebar"
                    @click=${() => this.toggleSidebar()}
                >→</button>
                <div class="sidebar__header">
                    <div class="sidebar__title-row">
                        <div class="hud-title">InfiniBot Docs</div>
                        <button
                            class="sidebar__collapse"
                            title="Collapse sidebar (])"
                            @click=${() => this.toggleSidebar()}
                        >
                            ←
                        </button>
                    </div>
                    <h1 class="sidebar__heading">The <span class="gold">handbook</span></h1>
                    <div class="search">
                        <span class="search__icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7.5"/><path d="m20.5 20.5-4.2-4.2"/></svg></span>
                        <input
                            class="search__input"
                            type="text"
                            placeholder="Filter docs…"
                            aria-label="Filter docs"
                            .value=${this.query}
                            @input=${(e: Event) => (this.query = (e.target as HTMLInputElement).value)}
                        />
                        ${this.query
                            ? html`<button
                                  class="search__clear"
                                  title="Clear (Esc)"
                                  @click=${() => (this.query = "")}
                              >
                                  ×
                              </button>`
                            : null}
                    </div>
                    <div class="search__hint">
                        <span><kbd>/</kbd> search</span>
                        <span><kbd>j</kbd>/<kbd>k</kbd> next/prev</span>
                        <span><kbd>t</kbd> toc</span>
                    </div>
                </div>
                <div class="tree">
                    ${this.treeLoading
                        ? html`<div class="tree-skel" aria-busy="true" aria-label="Loading docs">
                              ${[72, 56, 64, 48, 60, 40].map((w) => html`<span style="width:${w}%"></span>`)}
                          </div>`
                        : this.treeError
                          ? html`
                                <div class="tree-empty">
                                    <div class="empty__icon empty__icon--bad" aria-hidden="true">!</div>
                                    <div class="empty__title">Couldn’t load the docs</div>
                                    <div class="empty__hint">${this.treeError}</div>
                                    <button
                                        class="empty__btn"
                                        @click=${() => void this.loadTree()}
                                    >
                                        ↻ Retry
                                    </button>
                                </div>
                            `
                          : html`
                                ${this.renderPinnedSection()}
                                ${this.renderRecentSection()}
                                ${this.renderTreeNodes(visibleTree)}
                            `}
                </div>
            </aside>
            <main class="viewer">
                <div class="viewer__main">
                    <div class="viewer__bar">
                        <button
                            class="viewer__nav-btn"
                            ?disabled=${!hasPrev}
                            title="Previous doc (k)"
                            @click=${() => this.stepFile(-1)}
                        >‹</button>
                        <button
                            class="viewer__nav-btn"
                            ?disabled=${!hasNext}
                            title="Next doc (j)"
                            @click=${() => this.stepFile(1)}
                        >›</button>
                        <div class="viewer__crumbs">
                            ${this.currentPath
                                ? html`Docs / <strong>${this.currentTitle}</strong
                                      ><span class="crumb-path">${this.currentPath}</span>`
                                : html`No document selected`}
                        </div>
                        ${this.currentPath
                            ? html`<button
                                  class="viewer__nav-btn ${this.pinned.has(this.currentPath)
                                      ? "is-active"
                                      : ""}"
                                  title=${this.pinned.has(this.currentPath) ? "Unpin" : "Pin"}
                                  @click=${(e: MouseEvent) =>
                                      this.togglePin(this.currentPath!, e)}
                              >
                                  ${this.pinned.has(this.currentPath) ? "★" : "☆"}
                              </button>`
                            : null}
                        <button
                            class="viewer__nav-btn"
                            title="Toggle TOC (t)"
                            @click=${() => this.toggleToc()}
                        >
                            ☰
                        </button>
                    </div>
                    ${this.contentLoading
                        ? this.renderSkeleton()
                        : this.contentError
                          ? html`
                                <div class="empty">
                                    <div class="empty__icon empty__icon--bad" aria-hidden="true">!</div>
                                    <div class="empty__title">This doc didn’t load</div>
                                    <div class="empty__hint">${this.contentError}</div>
                                    <button
                                        class="empty__btn"
                                        @click=${() =>
                                            this.currentPath && void this.loadDoc(this.currentPath)}
                                    >
                                        ↻ Retry
                                    </button>
                                </div>
                            `
                          : this.contentHtml
                            ? html`<div class="article" @click=${this.onArticleClick}>
                                  <div
                                      class="article__inner"
                                      .innerHTML=${this.contentHtml}
                                  ></div>
                              </div>`
                            : html`
                                  <div class="empty">
                                      <div class="empty__icon" aria-hidden="true">❖</div>
                                      <div class="empty__title">Pick a doc to start reading</div>
                                      <div class="empty__hint">
                                          Use <kbd>/</kbd> to filter or <kbd>j</kbd>/<kbd>k</kbd>
                                          to step through.
                                      </div>
                                  </div>
                              `}
                </div>
                ${this.contentHtml ? this.renderToc() : null}
            </main>
        `;
    }

    protected updated(_changed: PropertyValues): void {
        this.applyAttributes();
    }
}

export function renderDocs() {
    return html`<docs-view></docs-view>`;
}
