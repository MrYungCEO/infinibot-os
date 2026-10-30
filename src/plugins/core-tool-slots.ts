/**
 * Core tool slots — agent tools a first-party plugin supplies under a name
 * core has always listed.
 *
 * `createInfiniBotTools()` still calls `createDisciplineTool()` /
 * `createFocusTool()` (so their long-standing names, prompts and allow-lists
 * keep working), but those are now slots: a plugin fills them from its
 * service while enabled (`api.runtime.host.setCoreToolSlot`). An empty slot
 * yields a marked stub that the tool pipelines drop (`dropEmptyToolSlots`),
 * so a disabled plugin's tools are invisible to agents and MCP clients; a
 * direct invoke of the stub answers "turned off".
 *
 * A fill only counts while its plugin is loaded in the ACTIVE plugin
 * registry: turning a plugin off reloads the gateway in-process, and this
 * module's state outlives that reload.
 */

import { Type } from "@sinclair/typebox";

import type { AnyAgentTool } from "../agents/tools/common.js";
import { getActivePluginRegistry } from "./runtime.js";

type SlotFill = { pluginId: string; pluginName: string; factory: () => AnyAgentTool };

const slots = new Map<string, SlotFill>();

/** True while `pluginId` is loaded in the active plugin registry. */
export function isPluginActive(pluginId: string): boolean {
  return (
    getActivePluginRegistry()?.plugins.some((p) => p.id === pluginId && p.status === "loaded") ??
    false
  );
}

function activeFill(name: string): SlotFill | undefined {
  const fill = slots.get(name);
  return fill && isPluginActive(fill.pluginId) ? fill : undefined;
}
const EMPTY_SLOT = Symbol.for("infinibot.coreToolSlot.empty");

export function setCoreToolSlot(name: string, fill: SlotFill | null): void {
  if (fill) slots.set(name, fill);
  else slots.delete(name);
}

export function isCoreToolSlotFilled(name: string): boolean {
  return Boolean(activeFill(name));
}

/** The plugin's tool when the slot is filled, else an (invisible) stub. */
export function createSlotTool(name: string, pluginName: string): AnyAgentTool {
  const fill = activeFill(name);
  if (fill) {
    try {
      return fill.factory();
    } catch {
      /* fall through to the stub */
    }
  }
  // Exact UI path (matches src/infinibot-knowledge): the PLUGIN itself is off.
  const message = `The ${pluginName} plugin is disabled, so the ${name} tool isn't available. Enable it in Home › Plugins › ${pluginName} (turning a plugin on reloads the gateway).`;
  const stub: AnyAgentTool = {
    name,
    label: pluginName,
    description: message,
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: "text", text: message }],
      details: {
        ok: false,
        error: "plugin_disabled",
        code: "plugin_disabled",
        fix: {
          where: `Home › Plugins › ${pluginName}`,
          tab: "plugins",
          targets: ["page:plugins"],
        },
      },
    }),
  };
  (stub as unknown as Record<symbol, boolean>)[EMPTY_SLOT] = true;
  return stub;
}

export function isEmptyToolSlot(tool: unknown): boolean {
  return Boolean(tool && (tool as Record<symbol, unknown>)[EMPTY_SLOT]);
}

export function dropEmptyToolSlots<T>(tools: T[]): T[] {
  return tools.filter((t) => !isEmptyToolSlot(t));
}
