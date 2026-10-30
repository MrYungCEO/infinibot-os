/**
 * Voice duck bus — broadcast duck events when proactive narration overlays
 * start/stop playing so the voice-chat session can mute/unmute TTS + STT.
 *
 * Server-side: call duckStart/duckEnd from bakeScenesNarration or the overlay
 * renderer when narration is live-synthed.
 * Client-side: the overlay fires window events; grid-voice.ts listens for them.
 */

export interface DuckStartEvent {
  sourceId: string; // eventId from the popup
  eventId: string;
}
export interface DuckEndEvent {
  sourceId: string;
  eventId: string;
}

// ── Server-side helpers (used when gateway narration streams) ─────────────────
// These emit into the realtime WS bridge if available. Import lazily to avoid
// pulling the WS layer into lightweight callers.

let _broadcastFn: ((channel: string, payload: unknown) => void) | null = null;

/** Register the WS broadcast function (called once at gateway boot). */
export function registerDuckBroadcast(fn: (channel: string, payload: unknown) => void): void {
  _broadcastFn = fn;
}

export function broadcastDuckStart(sourceId: string, eventId: string): void {
  _broadcastFn?.("voice.duck:start", { sourceId, eventId });
}

export function broadcastDuckEnd(sourceId: string, eventId: string): void {
  _broadcastFn?.("voice.duck:end", { sourceId, eventId });
}
