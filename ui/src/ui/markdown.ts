/**
 * Backward-compat re-export.
 * All new code should import directly from ./markdown/render.
 */
export { toSanitizedMarkdownHtml, escapeHtml } from "./markdown/render";
export type { MarkdownRenderOptions } from "./markdown/render";
