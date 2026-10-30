/**
 * UI target registry — public API.
 *
 * Stable ids for every navigable place and highlightable control in the
 * control UI (pages, host sub-tabs, plugin pages/settings, sidebar entries,
 * topbar controls, modals, setup checks). Agents drive them through
 * `ui_control` (navigate / highlight / guide); other modules (e.g. InfiniBot
 * self-knowledge) can import this API or read the static dump
 * `src/ui-targets/ui-targets.json` (regenerate: `pnpm ui-targets:gen`).
 *
 * Design: docs/gateway/ui-targets.md.
 */

export type {
  HighlightStyle,
  OpenableSurface,
  RevealPlan,
  RevealStep,
  UiTarget,
  UiTargetAvailability,
  UiTargetEnv,
  UiTargetKind,
  UiTargetMatch,
  UiTargetResolution,
  UiTargetSource,
} from "./types.js";
export { HIGHLIGHT_STYLES, TARGET_ATTR, targetAttrSelector, learnAttrSelector } from "./types.js";
export {
  buildRevealPlan,
  evaluateAvailability,
  findTargetById,
  normalizeText,
  resolveTarget,
  searchTargets,
  summarizeTarget,
} from "./resolve.js";
export {
  derivePluginTargets,
  deriveLearnTargets,
  deriveSetupCheckTargets,
  setupCheckTargetId,
} from "./derive.js";
export { assembleTargets } from "./assemble.js";
export { CURATED_TARGETS } from "./curated.js";
export {
  buildUiTargets,
  getUiTarget,
  getUiTargetRegistry,
  listUiTargets,
  resolveUiTarget,
  searchUiTargets,
  setUiTargetSourcesProvider,
} from "./registry.js";
