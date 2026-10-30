/**
 * Secure Mode (control UI). Importing this module registers the shared
 * elements: <ib-secure-toggle>, <ib-secure-badge>, <ib-secure-board>,
 * <ib-secure-docs>.
 */
export * from "./session-key";
export * from "./store";
export { ensureSecureGlobalStyles } from "./styles";
export { SECURE_HINT } from "./secure-toggle";
export { parseResearchResult, formatRange } from "./secure-research";
export { normalizeSecureModels, type SecureModelCandidate, type SecureModelsResponse } from "./secure-model";
import "./secure-toggle";
import "./secure-board";
import "./secure-docs";
import "./secure-research";
