/**
 * Viral-format intelligence subsystem — public barrel.
 *
 * A self-contained subsystem that detects a content niche + subniches, mines the
 * top viral formats per (sub)niche from a watched corpus, and maintains a rolling
 * historical benchmark base so our own content can be scored RELATIVE to what
 * actually wins in the niche (not on an absolute scale) and adapts over time.
 */

export * from "./taxonomy.js";
export * from "./format-framework.js";
export * from "./benchmark-store.js";
export * from "./watcher.js";
export * from "./relative-scoring.js";
