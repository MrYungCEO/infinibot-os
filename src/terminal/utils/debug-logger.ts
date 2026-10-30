/**
 * Debug Logger Utilities
 * Conditional logging for terminal debugging
 */

const DEBUG_ENABLED = process.env.DEBUG_TERMINAL === 'true';

export function debugLog(...args: any[]): void {
    if (DEBUG_ENABLED) {
        console.log('[Terminal Debug]', ...args);
    }
}

export function debugError(...args: any[]): void {
    if (DEBUG_ENABLED) {
        console.error('[Terminal Error]', ...args);
    }
}
