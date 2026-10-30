/**
 * Terminal Theme
 * Black & gold color scheme for xterm.js matching infinibot's aesthetic
 */

import type { ITheme } from '@xterm/xterm';

export const TERMINAL_THEME: ITheme = {
    background: '#040404',
    foreground: '#a1a1aa',
    cursor: 'var(--g-primary)',
    cursorAccent: '#040404',
    selectionBackground: 'color-mix(in srgb, var(--g-primary) 20%, transparent)',
    selectionForeground: '#fafafa',
    selectionInactiveBackground: 'color-mix(in srgb, var(--g-primary) 10%, transparent)',

    // Standard colors
    black: '#0a0a0a',
    red: '#f87171',
    green: '#4ade80',
    yellow: 'var(--g-primary)',
    blue: '#60a5fa',
    magenta: '#c084fc',
    cyan: '#22d3ee',
    white: '#e4e4e7',

    // Bright colors
    brightBlack: '#3f3f46',
    brightRed: '#fca5a5',
    brightGreen: '#86efac',
    brightYellow: '#fcd34d',
    brightBlue: '#93c5fd',
    brightMagenta: '#d8b4fe',
    brightCyan: '#67e8f9',
    brightWhite: '#fafafa',
};

export const TERMINAL_OPTIONS = {
    fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace",
    fontSize: 13,
    lineHeight: 1.2,
    letterSpacing: 0,
    cursorBlink: true,
    cursorStyle: 'block' as const,
    scrollback: 10000,
    tabStopWidth: 4,
    theme: TERMINAL_THEME,
    allowProposedApi: true,
};
