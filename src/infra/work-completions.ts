/**
 * Work-completion events (core seam).
 *
 * Core emits one event whenever a unit of real work finishes: a kanban task
 * moves to done, or an agent run completes. Core never cares who listens.
 * Plugins subscribe through `api.runtime.host.onWorkCompleted` (the Discipline
 * plugin uses it to auto-log and auto-complete the active time block); nothing
 * in core imports a plugin to deliver these.
 *
 * Previously `src/discipline/completion-bus.ts`, which made kanban and the
 * agent runner import the Discipline feature directly.
 */

import { EventEmitter } from "node:events";

export interface WorkCompletedEvent {
  source: "kanban" | "agent";
  sourceId: string;
  title: string;
  completedAt: number;
}

const bus = new EventEmitter();
// Many plugin services may subscribe; don't warn at the default of 10.
bus.setMaxListeners(100);

export function emitWorkCompleted(evt: WorkCompletedEvent): void {
  bus.emit("completion", evt);
}

export function onWorkCompleted(handler: (evt: WorkCompletedEvent) => void): () => void {
  bus.on("completion", handler);
  return () => {
    bus.off("completion", handler);
  };
}
