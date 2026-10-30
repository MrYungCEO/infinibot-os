/**
 * Autonomy Bus
 *
 * Tiny client-side command bus that lets the side-panel agent drive the app
 * UI — navigate tabs, fill forms, click buttons — instead of generating answers
 * inline. Everything flows through `window.dispatchEvent` so any view can
 * subscribe without prop-drilling.
 *
 * Event bus adapted for lit-html/vanilla TS.
 */

import type { Tab } from "../navigation";

// ── Command schema ────────────────────────────────────────────────

export type AutonomyCommand =
  | { kind: "navigate"; tab: Tab }
  | { kind: "setFormField"; field: string; value: string | number | boolean }
  | { kind: "click"; target: string }
  | { kind: "focus"; target: string }
  | { kind: "openModal"; modal: string; payload?: Record<string, unknown> }
  | { kind: "closeModal" }
  // Page-specific high-level intents — pages translate these into local actions.
  | { kind: "business.activate"; businessId: string }
  | { kind: "business.create"; name: string; industry?: string; plan?: string }
  | { kind: "business.section"; section: "profile" | "notion" | "plan" | "clients" | "brand" }
  | { kind: "agents.select"; agentId: string }
  | { kind: "agents.openConfig"; agentId: string }
  | { kind: "discipline.subView"; subView: "timeline" | "blocks" | "score" }
  | { kind: "discipline.startBlock"; blockId: string }
  | { kind: "discipline.completeBlock"; blockId: string }
  | { kind: "discipline.applyPreset"; presetId: string }
  | { kind: "grid.addPanel"; sessionKey?: string; title?: string }
  | { kind: "grid.send"; sessionKey: string; message: string }
  | { kind: "grid.removePanel"; panelId: string };

export type AutonomyCommandKind = AutonomyCommand["kind"];

export type NarrationEvent = {
  kind: "narration";
  message: string;
  tone?: "info" | "success" | "error";
  commandId?: string;
};

export type AckEvent = {
  kind: "ack";
  commandId: string;
  ok: boolean;
  source?: string;
  message?: string;
};

interface EnvelopedCommand {
  id: string;
  command: AutonomyCommand;
}

const COMMAND_CHANNEL = "infinibot:autonomy:command";
const NARRATION_CHANNEL = "infinibot:autonomy:narration";
const ACK_CHANNEL = "infinibot:autonomy:ack";

// ── Public API ────────────────────────────────────────────────────

export const autonomyBus = {
  emit(command: AutonomyCommand, id?: string): string {
    if (typeof window === "undefined") return "";
    const commandId = id ?? generateId();
    const envelope: EnvelopedCommand = { id: commandId, command };
    window.dispatchEvent(new CustomEvent(COMMAND_CHANNEL, { detail: envelope }));
    return commandId;
  },

  narrate(event: Omit<NarrationEvent, "kind">) {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent(NARRATION_CHANNEL, { detail: { kind: "narration", ...event } }),
    );
  },

  ack(event: Omit<AckEvent, "kind">) {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(ACK_CHANNEL, { detail: { kind: "ack", ...event } }));
  },

  /** Emit + wait for ack. Used by the planner so the next step only sends
   *  once the previous one actually landed. */
  emitAndWait(
    command: AutonomyCommand,
    opts: { timeoutMs?: number } = {},
  ): Promise<AckEvent> {
    if (typeof window === "undefined") return Promise.reject(new Error("SSR"));
    const timeoutMs = opts.timeoutMs ?? 8000;
    const commandId = generateId();

    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        window.removeEventListener(ACK_CHANNEL, handler as EventListener);
        reject(new Error(`Autonomy command "${command.kind}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const handler = (evt: Event) => {
        const ack = (evt as CustomEvent<AckEvent>).detail;
        if (ack?.commandId !== commandId) return;
        window.clearTimeout(timer);
        window.removeEventListener(ACK_CHANNEL, handler as EventListener);
        resolve(ack);
      };
      window.addEventListener(ACK_CHANNEL, handler as EventListener);

      this.emit(command, commandId);
    });
  },
};

// ── Subscriber helpers (vanilla, no React) ────────────────────────

export type CommandHandler = (ctx: {
  command: AutonomyCommand;
  id: string;
  ack: (ok: boolean, message?: string) => void;
}) => void | Promise<void>;

/** Subscribe a handler to a set of command kinds. Returns an unsubscribe fn. */
export function subscribeCommands(
  kinds: AutonomyCommandKind[],
  handler: CommandHandler,
  source = "unknown",
): () => void {
  if (typeof window === "undefined") return () => {};
  const kindSet = new Set<AutonomyCommandKind>(kinds);
  const listener = (evt: Event) => {
    const envelope = (evt as CustomEvent<EnvelopedCommand>).detail;
    if (!envelope?.command) return;
    if (!kindSet.has(envelope.command.kind)) return;
    const ack = (ok: boolean, message?: string) =>
      autonomyBus.ack({ commandId: envelope.id, ok, source, message });
    try {
      const r = handler({ command: envelope.command, id: envelope.id, ack });
      if (r && typeof (r as Promise<unknown>).catch === "function") {
        (r as Promise<unknown>).catch((err) =>
          ack(false, err instanceof Error ? err.message : "handler error"),
        );
      }
    } catch (err) {
      ack(false, err instanceof Error ? err.message : "handler error");
    }
  };
  window.addEventListener(COMMAND_CHANNEL, listener as EventListener);
  return () => window.removeEventListener(COMMAND_CHANNEL, listener as EventListener);
}

/** Subscribe to narration events. Returns an unsubscribe fn. */
export function subscribeNarration(handler: (e: NarrationEvent) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (evt: Event) => {
    const n = (evt as CustomEvent<NarrationEvent>).detail;
    if (n?.kind === "narration") handler(n);
  };
  window.addEventListener(NARRATION_CHANNEL, listener as EventListener);
  return () => window.removeEventListener(NARRATION_CHANNEL, listener as EventListener);
}

// ── utils ─────────────────────────────────────────────────────────

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
