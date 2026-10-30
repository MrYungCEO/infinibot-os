/**
 * useXterm Hook
 * Manages xterm.js terminal lifecycle, rendering, and interaction
 */

import { ref, Ref } from 'lit/directives/ref.js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { TERMINAL_OPTIONS } from '../lib/terminal-theme.js';

export interface UseXtermOptions {
    terminalId: string;
    onData?: (data: string) => void;
    onResize?: (cols: number, rows: number) => void;
    onDimensionsReady?: (cols: number, rows: number) => void;
}

export interface UseXtermReturn {
    terminalRef: Ref<HTMLDivElement>;
    xtermInstance: Terminal | null;
    write: (data: string) => void;
    writeln: (data: string) => void;
    fit: () => boolean;
    focus: () => void;
    dispose: () => void;
    cols: number;
    rows: number;
}

/**
 * Create and manage an xterm.js terminal instance
 */
export function createXtermManager(options: UseXtermOptions): UseXtermReturn {
    let terminal: Terminal | null = null;
    let fitAddon: FitAddon | null = null;
    let containerElement: HTMLDivElement | null = null;
    let isDisposed = false;
    let currentCols = 80;
    let currentRows = 24;

    const terminalRef = ref((el?: Element) => {
        if (!el || isDisposed) return;

        const container = el as HTMLDivElement;
        if (container === containerElement) return; // Already initialized

        containerElement = container;

        // Create terminal instance
        terminal = new Terminal({
            ...TERMINAL_OPTIONS,
            allowProposedApi: true,
        });

        // Create and load fit addon
        fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);

        // Load web links addon
        const webLinksAddon = new WebLinksAddon();
        terminal.loadAddon(webLinksAddon);

        // Open terminal in container
        terminal.open(container);

        // Handle user input
        if (options.onData) {
            terminal.onData(options.onData);
        }

        // Handle resize
        if (options.onResize) {
            terminal.onResize(({ cols, rows }) => {
                currentCols = cols;
                currentRows = rows;
                options.onResize?.(cols, rows);
            });
        }

        // Initial fit
        setTimeout(() => {
            if (fitAddon && !isDisposed) {
                try {
                    fitAddon.fit();
                    currentCols = terminal?.cols ?? 80;
                    currentRows = terminal?.rows ?? 24;

                    // Notify dimensions are ready
                    if (options.onDimensionsReady && currentCols >= 10 && currentRows >= 3) {
                        options.onDimensionsReady(currentCols, currentRows);
                    }
                } catch (e) {
                    console.warn('[useXterm] Initial fit failed:', e);
                }
            }
        }, 0);
    });

    const write = (data: string) => {
        if (terminal && !isDisposed) {
            terminal.write(data);
        }
    };

    const writeln = (data: string) => {
        if (terminal && !isDisposed) {
            terminal.writeln(data);
        }
    };

    const fit = (): boolean => {
        if (fitAddon && terminal && !isDisposed) {
            try {
                fitAddon.fit();
                currentCols = terminal.cols;
                currentRows = terminal.rows;
                return true;
            } catch (e) {
                console.warn('[useXterm] Fit failed:', e);
                return false;
            }
        }
        return false;
    };

    const focus = () => {
        if (terminal && !isDisposed) {
            terminal.focus();
        }
    };

    const dispose = () => {
        if (isDisposed) return;
        isDisposed = true;

        if (terminal) {
            terminal.dispose();
            terminal = null;
        }

        fitAddon = null;
        containerElement = null;
    };

    return {
        terminalRef,
        get xtermInstance() { return terminal; },
        write,
        writeln,
        fit,
        focus,
        dispose,
        get cols() { return currentCols; },
        get rows() { return currentRows; },
    };
}
