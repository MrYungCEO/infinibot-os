/**
 * voice-world-ambient/index.ts — registration entry for the in-world ambient
 * visual layer.
 *
 * Side-effect import that registers <voice-world-connectors> and
 * <voice-world-graph>. These are mounted as siblings of <agency-world-viz>
 * inside the voice page's `.vc-world` host (see voice-chat.ts), so they share
 * the iso map's exact box and anchor to the same `window.__agentFxState` coords
 * — one world-space, never a second plane.
 *
 * (They live in the voice-chat shadow DOM, so they're placed in the template
 * directly rather than auto-injected from the light DOM.)
 */

import "../voice-world-connectors.js";
import "../voice-world-graph.js";
