/**
 * Federation Module
 * 
 * Exports all federation-related components for InfiniBot's multi-node network.
 * 
 * Components:
 * - Controller: State management for federation (nodes, mode, connections)
 * - Settings View: Full settings page for federation configuration
 * - Node Selector: Dropdown component for chat header
 * - Integration: Helpers for wiring into existing UI
 * 
 * @example
 * ```typescript
 * import {
 *   createFederationState,
 *   loadFederationState,
 *   renderFederationSettings,
 *   renderNodeSelector,
 * } from "../federation";
 * ```
 */

// Controller
export {
  createFederationState,
  loadFederationState,
  loadNodes,
  setCurrentNode,
  loadPersistedNodeSelection,
  saveFederationConfig,
  connectToMaster,
  disconnectFromMaster,
  addNode,
  removeNode,
  scanNetwork,
  getCurrentNode,
  getOnlineNodes,
  formatCapabilities,
  isFederationEnabled,
} from "../controllers/federation";

export type {
  FederationMode,
  FederationNode,
  FederationState,
  FederationConfig,
  NodeCapabilities,
} from "../controllers/federation";

// Views
export { renderFederationSettings } from "../views/federation-settings";
export type { FederationSettingsProps } from "../views/federation-settings";

export { renderNodeSelector, NodeSelectorElement } from "../views/node-selector";
export type { NodeSelectorProps } from "../views/node-selector";

// Integration helpers
export {
  initializeFederationState,
  renderFederationTab,
  renderChatNodeSelector,
  loadFederation,
  subscribeFederationEvents,
  FEDERATION_NAV_CONFIG,
} from "../views/federation-integration";

export type { FederationViewState } from "../views/federation-integration";
