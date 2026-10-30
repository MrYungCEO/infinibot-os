/**
 * Autopilot Subscribers
 *
 * Centralised translation layer between bus commands and the moltbot
 * controllers/state. This is the page-by-page execution surface — one
 * function per command kind, picking the right controller based on the
 * payload. The sidebar fires bus commands; this file applies them.
 *
 * Installed once at app boot via `installAutopilotSubscribers(state)`.
 * Returns an unsubscribe fn for tests / hot-reload.
 */

import type { AppViewState } from "../app-view-state";
import { subscribeCommands, type AutonomyCommand } from "../lib/autonomy-bus";
import {
  applyPreset as applyDisciplinePreset,
  markBlockDone as markDisciplineBlockDone,
} from "./discipline";
import { addPanel as addGridPanel, removePanel as removeGridPanel } from "./masonry-grid";
import { switchBusiness, createBusiness } from "./business";

export function installAutopilotSubscribers(state: AppViewState): () => void {
  const unsubs: Array<() => void> = [];

  // ── Navigation ──────────────────────────────────────────────────
  unsubs.push(
    subscribeCommands(["navigate"], async ({ command, ack }) => {
      if (command.kind !== "navigate") return ack(false);
      try {
        state.setTab(command.tab);
        state.requestUpdate?.();
        ack(true);
      } catch (err) {
        ack(false, err instanceof Error ? err.message : "navigate failed");
      }
    }, "app"),
  );

  // ── Generic UI helpers (best-effort DOM lookups) ────────────────
  unsubs.push(
    subscribeCommands(["focus", "click", "setFormField"], ({ command, ack }) => {
      try {
        if (command.kind === "focus") {
          const el = document.querySelector<HTMLElement>(command.target);
          if (!el) return ack(false, `target not found: ${command.target}`);
          el.focus();
          return ack(true);
        }
        if (command.kind === "click") {
          const el = document.querySelector<HTMLElement>(command.target);
          if (!el) return ack(false, `target not found: ${command.target}`);
          el.click();
          return ack(true);
        }
        if (command.kind === "setFormField") {
          const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
            `[data-field="${command.field}"]`,
          );
          if (!el) return ack(false, `field not found: ${command.field}`);
          el.value = String(command.value);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return ack(true);
        }
        ack(false);
      } catch (err) {
        ack(false, err instanceof Error ? err.message : "ui command failed");
      }
    }, "app"),
  );

  // ── Business page ───────────────────────────────────────────────
  unsubs.push(
    subscribeCommands(
      ["business.activate", "business.create", "business.section"],
      async ({ command, ack }) => {
        if (!state.client || !state.businessState) {
          return ack(false, "business state not ready");
        }
        try {
          if (command.kind === "business.activate") {
            await switchBusiness(state, state.client, command.businessId);
            state.requestUpdate?.();
            return ack(true);
          }
          if (command.kind === "business.create") {
            await createBusiness(state, state.client, command.name);
            state.requestUpdate?.();
            return ack(true);
          }
          if (command.kind === "business.section") {
            state.businessState.activeSection = command.section;
            state.requestUpdate?.();
            return ack(true);
          }
          ack(false);
        } catch (err) {
          ack(false, err instanceof Error ? err.message : "business command failed");
        }
      },
      "business",
    ),
  );

  // ── Agents page ─────────────────────────────────────────────────
  unsubs.push(
    subscribeCommands(["agents.select", "agents.openConfig"], ({ command, ack }) => {
      if (!state.agentsManagerState) return ack(false, "agents state not ready");
      try {
        if (command.kind === "agents.select") {
          (state.agentsManagerState as { selectedId?: string }).selectedId = command.agentId;
          state.requestUpdate?.();
          return ack(true);
        }
        if (command.kind === "agents.openConfig") {
          (state.agentsManagerState as { selectedId?: string; configOpen?: boolean }).selectedId = command.agentId;
          (state.agentsManagerState as { configOpen?: boolean }).configOpen = true;
          state.requestUpdate?.();
          return ack(true);
        }
        ack(false);
      } catch (err) {
        ack(false, err instanceof Error ? err.message : "agents command failed");
      }
    }, "agents"),
  );

  // ── Discipline page ─────────────────────────────────────────────
  unsubs.push(
    subscribeCommands(
      [
        "discipline.subView",
        "discipline.startBlock",
        "discipline.completeBlock",
        "discipline.applyPreset",
      ],
      async ({ command, ack }) => {
        if (!state.disciplineState || !state.client) {
          return ack(false, "discipline state not ready");
        }
        try {
          if (command.kind === "discipline.subView") {
            state.disciplineState.subView = command.subView;
            state.requestUpdate?.();
            return ack(true);
          }
          if (command.kind === "discipline.completeBlock") {
            await markDisciplineBlockDone(
              state.disciplineState,
              state.client,
              command.blockId,
            );
            state.requestUpdate?.();
            return ack(true);
          }
          if (command.kind === "discipline.applyPreset") {
            await applyDisciplinePreset(
              state.disciplineState,
              state.client,
              command.presetId,
            );
            state.requestUpdate?.();
            return ack(true);
          }
          if (command.kind === "discipline.startBlock") {
            // Best-effort: switch to timeline + scroll the block into view.
            state.disciplineState.subView = "timeline";
            state.requestUpdate?.();
            return ack(true);
          }
          ack(false);
        } catch (err) {
          ack(false, err instanceof Error ? err.message : "discipline command failed");
        }
      },
      "discipline",
    ),
  );

  // ── Grid (multi-panel chat) ─────────────────────────────────────
  unsubs.push(
    subscribeCommands(
      ["grid.addPanel", "grid.send", "grid.removePanel"],
      async ({ command, ack }) => {
        try {
          if (!state.masonryGridState) {
            return ack(false, "grid not ready");
          }
          if (command.kind === "grid.addPanel") {
            const sessionKey =
              command.sessionKey ?? `agent:main:webchat-${Date.now().toString(36)}`;
            const title = command.title ?? "💬 New Chat";
            state.masonryGridState = addGridPanel(
              state.masonryGridState,
              sessionKey,
              title,
            );
            state.requestUpdate?.();
            return ack(true);
          }
          if (command.kind === "grid.removePanel") {
            state.masonryGridState = removeGridPanel(
              state.masonryGridState,
              command.panelId,
            );
            state.requestUpdate?.();
            return ack(true);
          }
          if (command.kind === "grid.send") {
            await state.client?.request("session.send", {
              sessionKey: command.sessionKey,
              message: command.message,
            });
            return ack(true);
          }
          ack(false);
        } catch (err) {
          ack(false, err instanceof Error ? err.message : "grid command failed");
        }
      },
      "grid",
    ),
  );

  return () => {
    for (const u of unsubs) u();
  };
}

/** Helper for tests / debugging — manually drive the bus from console. */
export type { AutonomyCommand };
