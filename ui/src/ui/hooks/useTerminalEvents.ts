/**
 * Terminal Event Handlers
 * Manages WebSocket events for terminal output and lifecycle
 */

import type { GatewayEventFrame } from '../gateway.js';

export interface TerminalEventHandlers {
    onOutput?: (terminalId: string, data: string) => void;
    onExit?: (terminalId: string, exitCode: number) => void;
}

/**
 * Create terminal event handler function
 * This returns a function that can be passed to gateway's onEvent callback
 */
export function createTerminalEventHandler(
    handlers: TerminalEventHandlers
): (evt: GatewayEventFrame) => void {
    return (evt: GatewayEventFrame) => {
        if (evt.event === 'terminal.output' && evt.payload) {
            const payload = evt.payload as { terminalId?: string; data?: string };
            if (payload.terminalId && payload.data) {
                handlers.onOutput?.(payload.terminalId, payload.data);
            }
        }

        if (evt.event === 'terminal.exit' && evt.payload) {
            const payload = evt.payload as { terminalId?: string; exitCode?: number };
            if (payload.terminalId && typeof payload.exitCode === 'number') {
                handlers.onExit?.(payload.terminalId, payload.exitCode);
            }
        }
    };
}
