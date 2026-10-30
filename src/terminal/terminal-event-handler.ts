/**
 * Terminal Event Handler
 * Manages terminal data output events and processing
 */

import * as OutputParser from './output-parser.js';
import * as ClaudeIntegration from './claude-integration-handler.js';
import type { TerminalProcess } from './types.js';

export type BroadcastFn = (event: string, payload: any) => void;

/**
 * Event handler callbacks
 */
export interface EventHandlerCallbacks {
    onClaudeSessionId: (terminal: TerminalProcess, sessionId: string) => void;
    onRateLimit: (terminal: TerminalProcess, data: string) => void;
    onOAuthToken: (terminal: TerminalProcess, data: string) => void;
    onOnboardingComplete: (terminal: TerminalProcess, data: string) => void;
    onClaudeBusyChange: (terminal: TerminalProcess, isBusy: boolean) => void;
    onClaudeExit: (terminal: TerminalProcess) => void;
}

// Track the last known busy state per terminal to avoid duplicate events
const lastBusyState = new Map<string, boolean>();

/**
 * Handle terminal data output
 */
export function handleTerminalData(
    terminal: TerminalProcess,
    data: string,
    callbacks: EventHandlerCallbacks
): void {
    // Try to extract Claude session ID
    if (terminal.isClaudeMode && !terminal.claudeSessionId) {
        const sessionId = OutputParser.extractClaudeSessionId(data);
        if (sessionId) {
            callbacks.onClaudeSessionId(terminal, sessionId);
        }
    }

    // Check for rate limit messages
    if (terminal.isClaudeMode) {
        callbacks.onRateLimit(terminal, data);
    }

    // Check for OAuth token
    callbacks.onOAuthToken(terminal, data);

    // Check for onboarding complete (after login, Claude shows ready state)
    callbacks.onOnboardingComplete(terminal, data);

    // Detect Claude busy state changes (only when in Claude mode)
    if (terminal.isClaudeMode) {
        const busyState = OutputParser.detectClaudeBusyState(data);
        if (busyState !== null) {
            const isBusy = busyState === 'busy';
            const lastState = lastBusyState.get(terminal.id);

            // Only emit if state actually changed
            if (lastState !== isBusy) {
                lastBusyState.set(terminal.id, isBusy);
                callbacks.onClaudeBusyChange(terminal, isBusy);
            }
        }

        // Detect Claude exit (returned to shell prompt)
        // Only check if not busy - busy output takes precedence
        if (busyState !== 'busy' && OutputParser.detectClaudeExit(data)) {
            callbacks.onClaudeExit(terminal);
            // Clear busy state tracking since Claude has exited
            lastBusyState.delete(terminal.id);
        }
    }
}

/**
 * Clear busy state tracking for a terminal (call on terminal destruction)
 */
export function clearBusyState(terminalId: string): void {
    lastBusyState.delete(terminalId);
}

/**
 * Create event handler callbacks from TerminalManager context
 */
export function createEventCallbacks(
    broadcast: BroadcastFn,
    lastNotifiedRateLimitReset: Map<string, string>
): EventHandlerCallbacks {
    return {
        onClaudeSessionId: (terminal, sessionId) => {
            ClaudeIntegration.handleClaudeSessionId(terminal, sessionId, broadcast);
        },
        onRateLimit: (terminal, data) => {
            ClaudeIntegration.handleRateLimit(
                terminal,
                data,
                lastNotifiedRateLimitReset,
                broadcast
            );
        },
        onOAuthToken: (terminal, data) => {
            ClaudeIntegration.handleOAuthToken(terminal, data, broadcast);
        },
        onOnboardingComplete: (terminal, data) => {
            ClaudeIntegration.handleOnboardingComplete(terminal, data, broadcast);
        },
        onClaudeBusyChange: (terminal, isBusy) => {
            broadcast('terminal.claudeBusy', {
                terminalId: terminal.id,
                isBusy,
            });
        },
        onClaudeExit: (terminal) => {
            ClaudeIntegration.handleClaudeExit(terminal, broadcast);
        },
    };
}
