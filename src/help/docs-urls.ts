// Single source of truth for public documentation URLs.
//
// The canonical docs domain lives here only: keeping it in one constant stops the
// literal host string from being scattered (or even appearing verbatim) across
// the CLI/wizard layer, so every help link routes through `docsUrl()` here.
// keep: this is the ONE place that knows the docs host — do not inline it elsewhere.
const DOCS_HOST = "infinibotos.com";

/** Marketing landing root (e.g. `https://<docs-host>`). */
export const DOCS_SITE = `https://${DOCS_HOST}`;

/** Canonical base for every documentation page (e.g. `https://<docs-host>/docs`). */
export const DOCS_BASE = `${DOCS_SITE}/docs`;

// Old mintlify paths that need a different shape under the static /docs tree.
const PATH_ALIASES: Record<string, string> = {
  "/mcp.SearchInfiniBot": "/mcp/search-infinibot",
};

/**
 * Build a canonical documentation URL for a docs path.
 *
 * `docsUrl("/security")` -> `<DOCS_BASE>/security`
 * `docsUrl("/")`         -> `<DOCS_BASE>/`
 * `docsUrl("/a#frag")`   -> `<DOCS_BASE>/a#frag`
 *
 * Absolute URLs are returned unchanged.
 */
export function docsUrl(path = "/"): string {
  let p = (path ?? "/").trim();
  if (/^https?:\/\//i.test(p)) return p;
  if (!p.startsWith("/")) p = `/${p}`;
  const match = p.match(/^([^#?]*)([#?].*)?$/);
  const rawPath = match?.[1] || "/";
  const suffix = match?.[2] ?? "";
  const mapped = PATH_ALIASES[rawPath] ?? rawPath;
  const joined = mapped === "/" ? "/" : mapped.replace(/\/+$/, "");
  return `${DOCS_BASE}${joined}${suffix}`;
}

/** Display label for a docs link (URL without the scheme). */
export function docsLabel(path = "/"): string {
  return docsUrl(path).replace(/^https?:\/\//i, "");
}
