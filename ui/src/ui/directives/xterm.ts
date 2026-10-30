/**
 * Xterm Directive for Lit
 * Manages xterm.js lifecycle in declarative Lit templates
 */

import { directive, Directive, PartInfo, PartType } from 'lit/directive.js';
import { noChange } from 'lit';
// Type-only imports — erased at runtime, breaking the static import chain
// that was pulling the 336KB xterm-vendor into the main bundle on every
// page load. The actual classes are loaded lazily on first terminal mount.
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { TERMINAL_OPTIONS } from '../lib/terminal-theme.js';
import type { AppViewState } from '../app-view-state.js';
import { registerXtermInstance, handleTerminalReady, handleTerminalInput, handleTerminalResize, unregisterXtermInstance } from '../controllers/terminals.js';

export interface XtermDirectiveOptions {
    terminalId: string;
    state: AppViewState;
    isActive: boolean;
}

// ── Lazy xterm loader ────────────────────────────────────────────────
// Shared singleton — first mount kicks off the download; subsequent mounts
// wait on the same promise. The classes are only resolved once.
let _xtermLibs: {
    Terminal: typeof import('@xterm/xterm').Terminal;
    FitAddon: typeof import('@xterm/addon-fit').FitAddon;
    WebLinksAddon: typeof import('@xterm/addon-web-links').WebLinksAddon;
} | null = null;
let _xtermLoadPromise: Promise<NonNullable<typeof _xtermLibs>> | null = null;

function loadXtermLibs(): Promise<NonNullable<typeof _xtermLibs>> {
    if (_xtermLibs) return Promise.resolve(_xtermLibs);
    if (_xtermLoadPromise) return _xtermLoadPromise;
    _xtermLoadPromise = Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/addon-web-links'),
    ]).then(([xt, fa, wl]) => {
        _xtermLibs = {
            Terminal: xt.Terminal,
            FitAddon: fa.FitAddon,
            WebLinksAddon: wl.WebLinksAddon,
        };
        return _xtermLibs;
    });
    return _xtermLoadPromise;
}

class XtermDirective extends Directive {
    private terminal: Terminal | null = null;
    private fitAddon: FitAddon | null = null;
    private currentTerminalId: string | null = null;
    private container: HTMLDivElement | null = null;
    private resizeObserver: ResizeObserver | null = null;
    private mutationObserver: MutationObserver | null = null;
    private observedResizeElements: Element[] = [];
    private readyFired = false;
    private lastCols = 0;
    private lastRows = 0;
    private readyFitFrame: number | null = null;
    /** Prevents multiple concurrent RAF + async-import init chains from racing.
     *  Set to true before the RAF is queued; cleared as soon as the libs.then
     *  callback starts (so cleanup() can reset it on disconnect mid-flight). */
    private _initPending = false;

    constructor(partInfo: PartInfo) {
        super(partInfo);
        if (partInfo.type !== PartType.ELEMENT) {
            throw new Error('xterm directive can only be used on elements');
        }
    }

    render(_options: XtermDirectiveOptions) {
        return noChange;
    }

    update(part: any, [options]: [XtermDirectiveOptions]) {
        const element = part.element as HTMLElement;

        // If terminal ID changed, cleanup old instance
        if (this.currentTerminalId && this.currentTerminalId !== options.terminalId) {
            this.cleanup();
        }

        // Initialize xterm if not already done.
        // Guard: !this._initPending prevents queuing multiple overlapping RAFs
        // when Lit re-renders rapidly (every gateway event) before the first RAF
        // fires and sets this.terminal. Without this, each render queued a new
        // RAF, all racing to open() a terminal in the same container.
        if ((!this.terminal && !this._initPending) || this.currentTerminalId !== options.terminalId) {
            this.currentTerminalId = options.terminalId;
            this.readyFired = false;
            this.lastCols = 0;
            this.lastRows = 0;
            this._initPending = true;

            // Capture id so stale closures don't initialise the wrong terminal.
            const expectedId = options.terminalId;

            // Wait for element to be in DOM, then lazy-load xterm and mount.
            requestAnimationFrame(() => {
                if (!element.isConnected || this.currentTerminalId !== expectedId) {
                    this._initPending = false;
                    return;
                }
                if (this.terminal) {
                    // A previous (stale) RAF already completed init — bail out.
                    this._initPending = false;
                    return;
                }
                void loadXtermLibs().then((libs) => {
                    // Clear pending flag early so cleanup() on disconnect during
                    // the async gap can take effect without being blocked.
                    this._initPending = false;
                    if (!element.isConnected || this.currentTerminalId !== expectedId) return;
                    if (this.terminal) return; // double-init guard after async gap

                    // Create container
                    this.container = document.createElement('div');
                    this.container.className = 'xterm-container';
                    this.container.style.width = '100%';
                    this.container.style.height = '100%';
                    element.appendChild(this.container);

                    // Create terminal
                    this.terminal = new libs.Terminal({
                        ...TERMINAL_OPTIONS,
                        allowProposedApi: true,
                    });

                    // Create and load addons
                    this.fitAddon = new libs.FitAddon();
                    this.terminal.loadAddon(this.fitAddon);

                    const webLinksAddon = new libs.WebLinksAddon();
                    this.terminal.loadAddon(webLinksAddon);

                    // Open terminal
                    this.terminal.open(this.container);

                    // Handle user input
                    this.terminal.onData((data) => {
                        handleTerminalInput(options.state, options.terminalId, data);
                    });

                    // Handle dimension changes that originate inside xterm itself
                    // (font load, manual reflow). For container-driven resizes we
                    // use the ResizeObserver below — onResize will fire as a
                    // consequence of fit() and we forward to the PTY there.
                    this.terminal.onResize(({ cols, rows }) => {
                        if (cols === this.lastCols && rows === this.lastRows) return;
                        this.lastCols = cols;
                        this.lastRows = rows;
                        handleTerminalResize(options.state, options.terminalId, cols, rows);
                    });

                    // Capture refs so closures don't fight `this`
                    const terminalInstance = this.terminal;
                    const fitAddonInstance = this.fitAddon;
                    const cleanupFn = () => this.cleanup();

                    // Register with controller — pending broadcast output is
                    // flushed inside registerXtermInstance immediately, so any
                    // chars that arrived between page-load and now appear before
                    // we replay the gateway buffer.
                    registerXtermInstance(options.terminalId, {
                        terminalRef: null as any,
                        xtermInstance: terminalInstance,
                        write: (data: string) => terminalInstance?.write(data),
                        writeln: (data: string) => terminalInstance?.writeln(data),
                        fit: () => {
                            if (fitAddonInstance && terminalInstance) {
                                try {
                                    fitAddonInstance.fit();
                                    return true;
                                } catch {
                                    return false;
                                }
                            }
                            return false;
                        },
                        focus: () => terminalInstance?.focus(),
                        dispose: cleanupFn,
                        get cols() { return terminalInstance?.cols ?? 80; },
                        get rows() { return terminalInstance?.rows ?? 24; },
                    });

                    this.startLayoutObservers(element, options);
                    this.startReadyFitLoop(options);
                });
            });
        }

        // Handle focus
        if (options.isActive && this.terminal) {
            requestAnimationFrame(() => {
                this.terminal?.focus();
            });
        }

        return noChange;
    }

    /**
     * Try to fit, then call handleTerminalReady once cols/rows look usable.
     * Idempotent — if ready already fired, only updates the PTY size.
     */
    private tryFitAndReady(options: XtermDirectiveOptions) {
        if (!this.fitAddon || !this.terminal || !this.container) return;

        // Skip when the container hasn't been laid out yet (e.g. it's inside
        // a hidden tab). Calling fit() on a 0x0 element corrupts xterm's
        // internal cursor state.
        const rect = this.container.getBoundingClientRect();
        if (rect.width < 20 || rect.height < 20) return;

        try {
            this.fitAddon.fit();
        } catch (e) {
            console.warn('[xterm] fit failed:', e);
            return;
        }

        const cols = this.terminal.cols;
        const rows = this.terminal.rows;
        if (cols < 10 || rows < 3) return;

        if (!this.readyFired) {
            this.readyFired = true;
            this.lastCols = cols;
            this.lastRows = rows;
            handleTerminalReady(options.state, options.terminalId, cols, rows);
        }
        // onResize handler above forwards subsequent size changes to the PTY.
    }

    private getLayoutObserverTargets(host: HTMLElement): Element[] {
        const targets: Element[] = [];
        let node: Element | null = this.container;
        while (node && node !== document.body && node !== document.documentElement) {
            targets.push(node);
            if (node.parentElement) {
                node = node.parentElement;
                continue;
            }
            const root = node.getRootNode();
            node = root instanceof ShadowRoot ? root.host : null;
        }
        if (!targets.includes(host)) targets.push(host);
        return targets;
    }

    private startLayoutObservers(host: HTMLElement, options: XtermDirectiveOptions) {
        this.stopLayoutObservers();

        const scheduleFit = () => this.startReadyFitLoop(options);

        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(scheduleFit);
            this.observedResizeElements = this.getLayoutObserverTargets(host);
            for (const target of this.observedResizeElements) {
                this.resizeObserver.observe(target);
            }
        }

        if (typeof MutationObserver !== 'undefined') {
            this.mutationObserver = new MutationObserver(scheduleFit);
            for (const target of this.getLayoutObserverTargets(host)) {
                this.mutationObserver.observe(target, {
                    attributes: true,
                    attributeFilter: ['class', 'style', 'hidden'],
                    childList: true,
                });
            }
        }
    }

    private startReadyFitLoop(options: XtermDirectiveOptions) {
        if (this.readyFitFrame !== null) return;

        const tick = () => {
            this.readyFitFrame = null;
            if (!this.fitAddon || !this.terminal || !this.container) return;

            // xterm can mis-measure when any ancestor is still collapsed, so
            // wait for the whole parent chain to have non-zero layout.
            for (const target of this.getLayoutObserverTargets(this.container)) {
                const rect = target.getBoundingClientRect();
                if (rect.width < 20 || rect.height < 20) {
                    this.readyFitFrame = requestAnimationFrame(tick);
                    return;
                }
            }

            this.tryFitAndReady(options);
            if (!this.readyFired) {
                this.readyFitFrame = requestAnimationFrame(tick);
            }
        };

        this.readyFitFrame = requestAnimationFrame(tick);
    }

    private stopLayoutObservers() {
        if (this.resizeObserver) {
            try { this.resizeObserver.disconnect(); } catch { /* ignore */ }
            this.resizeObserver = null;
        }
        if (this.mutationObserver) {
            try { this.mutationObserver.disconnect(); } catch { /* ignore */ }
            this.mutationObserver = null;
        }
        this.observedResizeElements = [];
    }

    private cleanup() {
        const tid = this.currentTerminalId;
        this.currentTerminalId = null;
        this.readyFired = false;
        this._initPending = false;

        if (this.readyFitFrame !== null) {
            cancelAnimationFrame(this.readyFitFrame);
            this.readyFitFrame = null;
        }
        this.stopLayoutObservers();

        if (tid) {
            // unregisterXtermInstance handles dispose + map removal safely
            unregisterXtermInstance(tid);
        }

        // Only dispose terminal directly if unregister didn't already handle it
        if (this.terminal) {
            try { this.terminal.dispose(); } catch { /* already disposed */ }
            this.terminal = null;
        }

        this.fitAddon = null;

        if (this.container && this.container.parentNode) {
            this.container.parentNode.removeChild(this.container);
        }
        this.container = null;
    }

    disconnected() {
        this.cleanup();
    }

    reconnected() {
        // Terminal will be reinitialized on next update
    }
}

export const xterm = directive(XtermDirective);
