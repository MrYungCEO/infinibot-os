/**
 * Focus board agent tool — slot.
 *
 * The implementation lives in the Discipline plugin
 * (extensions/discipline/src/focus-tool.ts), which fills this slot while
 * enabled. Plugin off → an invisible stub (see src/plugins/core-tool-slots.ts).
 */

import { createSlotTool } from "../../plugins/core-tool-slots.js";
import type { AnyAgentTool } from "./common.js";

export function createFocusTool(): AnyAgentTool {
  return createSlotTool("focus", "Discipline");
}
