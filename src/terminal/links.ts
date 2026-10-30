import { formatTerminalLink } from "../utils.js";
import { DOCS_BASE, docsUrl } from "../help/docs-urls.js";

// Legacy alias — points at the canonical docs base. Prefer `docsUrl()` directly.
export const DOCS_ROOT = DOCS_BASE;

export function formatDocsLink(
  path: string,
  label?: string,
  opts?: { fallback?: string; force?: boolean },
): string {
  const url = docsUrl(path);
  return formatTerminalLink(label ?? url.replace(/^https?:\/\//i, ""), url, {
    fallback: opts?.fallback ?? url,
    force: opts?.force,
  });
}

export function formatDocsRootLink(label?: string): string {
  const url = docsUrl("/");
  return formatTerminalLink(label ?? url.replace(/^https?:\/\//i, ""), url, {
    fallback: url,
  });
}
