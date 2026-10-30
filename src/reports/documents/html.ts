/**
 * HTML escaping helpers.
 *
 * Client names, line-item descriptions, notes and terms all originate from
 * user or third-party input (parsed inbound invoices, CRM imports). Every
 * interpolation into a template MUST go through `esc` (text/attribute) or one
 * of the strict validators below. There is no "trusted" string in a document.
 */

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
  "=": "&#61;",
};

/** Escape for both text nodes and quoted attribute values. */
export function esc(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"'`=]/g, (char) => HTML_ESCAPES[char] ?? char);
}

/** Escape, then convert newlines to `<br>` — for multi-line notes/scope text. */
export function escMultiline(value: unknown): string {
  return esc(value).replace(/\r\n|\r|\n/g, "<br>");
}

/**
 * Escape prose the way the report template does: blank lines separate
 * paragraphs, and a block whose lines all start with a bullet marker becomes a
 * list.
 *
 * Scope, notes and section bodies are typed by a human into a textarea, and
 * people write bullet lists with hyphens. Rendering those as literal "- " lines
 * in a client-facing proposal looks like a bug.
 */
export function escProse(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const out: string[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split("\n").map((line) => line.trimEnd());
    const bulletLines = lines.filter((line) => /^\s*[-*•]\s+/.test(line));
    const isList = bulletLines.length > 0 && bulletLines.length === lines.filter(Boolean).length;
    if (isList) {
      const items = bulletLines
        .map((line) => `<li>${esc(line.replace(/^\s*[-*•]\s+/, ""))}</li>`)
        .join("");
      out.push(`<ul>${items}</ul>`);
    } else {
      const body = escMultiline(block.trim());
      if (body) out.push(`<p>${body}</p>`);
    }
  }
  return out.join("");
}

/**
 * Escape a URL that has ALREADY been validated by `safeUrl` / `embeddableLogo`
 * for use in a quoted `src`/`href`.
 *
 * `esc` escapes `=` and backtick as defence for unquoted-attribute contexts.
 * That is harmless for prose but wrecks readability of the two places we emit a
 * URL: base64 padding (`iVBORw0KGgo=`) and query strings become entity soup.
 * Browsers decode it correctly either way, but the HTML is then unreadable when
 * debugging a document, and the base64 is no longer greppable. So for values
 * that are already restricted to a known-safe URL grammar, escape only what can
 * terminate the attribute or start a tag.
 *
 * Never call this on unvalidated input.
 */
export function escUrl(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * A CSS colour we are willing to inline into a `<style>` block. Anything that
 * is not an exact hex / rgb() / hsl() / plain keyword is rejected, so branding
 * values from the database cannot break out of the declaration and inject
 * rules (e.g. `red; } body { background: url(https://evil) `).
 */
export function safeColor(value: unknown, fallback: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw || raw.length > 32) return fallback;
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(raw)) return raw;
  if (/^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(?:,\s*[\d.]+\s*)?\)$/i.test(raw)) return raw;
  if (/^hsla?\(\s*[\d.]+\s*,\s*[\d.]+%\s*,\s*[\d.]+%\s*(?:,\s*[\d.]+\s*)?\)$/i.test(raw))
    return raw;
  if (/^[a-z]{3,20}$/i.test(raw)) return raw.toLowerCase();
  return fallback;
}

/**
 * A URL we are willing to place in `src`/`href`. Only `data:` images and
 * http(s) links survive; `javascript:` and friends are dropped. Note that an
 * http(s) *image* is still refused by {@link isEmbeddableImage} because
 * documents must render with no network access.
 */
export function safeUrl(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  if (/^data:image\/(png|jpe?g|gif|svg\+xml|webp);base64,[a-z0-9+/=\s]+$/i.test(raw)) return raw;
  if (/^https?:\/\/[^\s<>"']+$/i.test(raw)) return raw;
  if (/^mailto:[^\s<>"']+$/i.test(raw)) return raw;
  return null;
}

/** Only inline images that carry their own bytes — no network fetch at render time. */
export function isEmbeddableImage(value: string | null): value is string {
  return typeof value === "string" && value.startsWith("data:image/");
}

/** Join template fragments, dropping empties, so callers can use `cond && fragment`. */
export function joinHtml(parts: Array<string | false | null | undefined>): string {
  return parts
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("");
}
