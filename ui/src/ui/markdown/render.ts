import DOMPurify from "dompurify";
import { marked } from "marked";
import type { MarkedExtension } from "marked";
import { truncateText } from "../format";

// ── Limits & cache ────────────────────────────────────────────────────────────

const MARKDOWN_CHAR_LIMIT = 140_000;
const MARKDOWN_PARSE_LIMIT = 40_000;
const MARKDOWN_CACHE_LIMIT = 200;
const MARKDOWN_CACHE_MAX_CHARS = 50_000;

const markdownCache = new Map<string, string>();

function getCached(key: string): string | null {
  const v = markdownCache.get(key);
  if (v === undefined) return null;
  markdownCache.delete(key);
  markdownCache.set(key, v);
  return v;
}

function setCached(key: string, value: string) {
  markdownCache.set(key, value);
  if (markdownCache.size <= MARKDOWN_CACHE_LIMIT) return;
  const oldest = markdownCache.keys().next().value;
  if (oldest) markdownCache.delete(oldest);
}

// ── DOMPurify allowed elements ────────────────────────────────────────────────

const ALLOWED_TAGS = [
  "a", "b", "blockquote", "br", "caption", "code", "col", "colgroup",
  "del", "details", "div", "em", "figcaption", "figure",
  "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "iframe",
  "img", "input", "kbd", "li", "mark", "ol", "p", "pre",
  "s", "small", "span", "strong", "sub", "summary", "sup",
  "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul", "video",
];

const ALLOWED_ATTRS = [
  "align", "alt", "allow", "allowfullscreen", "checked",
  "class", "controls", "disabled", "frameborder", "height",
  "href", "id", "loading", "name", "open", "rel", "src", "start",
  "target", "title", "type", "width",
];

// Allow moltbot:// app-internal links to survive sanitization
const ALLOWED_URI_REGEXP =
  /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|cid|xmpp|moltbot):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

// ── DOMPurify hooks (installed once) ─────────────────────────────────────────

let hooksInstalled = false;
function installHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (!(node instanceof HTMLAnchorElement)) return;
    const href = node.getAttribute("href") ?? "";
    // Internal links (fragment or moltbot://) stay in-app; all others open in a new tab.
    if (href.startsWith("#") || href.startsWith("moltbot://")) return;
    node.setAttribute("rel", "noreferrer noopener");
    if (!node.getAttribute("target")) node.setAttribute("target", "_blank");
  });
}

// ── Callout / admonition block extension  :::note Title\nbody\n::: ──────────

let extensionsInstalled = false;
function installExtensions() {
  if (extensionsInstalled) return;
  extensionsInstalled = true;

  marked.use({
    extensions: [
      {
        name: "callout",
        level: "block",
        start(src: string) {
          return src.indexOf(":::");
        },
        tokenizer(src: string) {
          const match = /^:::[ \t]*(\w+)[ \t]*([^\n]*)\n([\s\S]*?)\n[ \t]*:::[ \t]*(?:\n|$)/.exec(src);
          if (!match) return undefined;
          const token: Record<string, unknown> = {
            type: "callout",
            raw: match[0],
            kind: (match[1] ?? "note").toLowerCase(),
            title: (match[2] ?? "").trim(),
            tokens: [],
          };
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (this as any).lexer.blockTokens(match[3] ?? "", token.tokens as unknown[]);
          return token;
        },
        renderer(token: Record<string, unknown>) {
          const kind = escapeHtml(String(token.kind ?? "note"));
          const title = String(token.title ?? "");
          const titleHtml = title ? `<div class="callout-title">${escapeHtml(title)}</div>` : "";
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const body = (this as any).parser.parse((token.tokens as unknown[]) ?? []) as string;
          return `<div class="callout callout-${kind}">${titleHtml}<div class="callout-body">${body}</div></div>\n`;
        },
      },
    ],
  } as MarkedExtension);
}

// ── Footnote preprocessor ─────────────────────────────────────────────────────
// Handles [^id] references and [^id]: text definitions. The resulting HTML
// fragments go through DOMPurify along with the rest of the rendered output.

function preprocessFootnotes(src: string): string {
  // Collect definitions – [^id]: text (may span indented continuation lines)
  const defs = new Map<string, string>();
  const cleaned = src.replace(
    /^\[\^([^\]\n]+)\]:[ \t]+(.*(?:\n[ \t]+.+)*)/gm,
    (_full: string, id: string, text: string) => {
      defs.set(id.trim(), text.replace(/\n[ \t]+/g, " ").trim());
      return "";
    },
  );
  if (defs.size === 0) return src;

  let counter = 0;
  const order = new Map<string, number>();
  const processed = cleaned.replace(/\[\^([^\]\n]+)\]/g, (full: string, id: string) => {
    const key = id.trim();
    if (!defs.has(key)) return full;
    if (!order.has(key)) order.set(key, ++counter);
    const n = order.get(key)!;
    return `<sup class="footnote-ref" id="fnref-${n}"><a href="#fn-${n}">[${n}]</a></sup>`;
  });

  if (order.size === 0) return processed;

  const items = Array.from(order.entries())
    .sort((a, b) => a[1] - b[1])
    .map(
      ([id, n]) =>
        `<li id="fn-${n}">${escapeHtml(defs.get(id) ?? "")} <a href="#fnref-${n}" class="footnote-back" aria-label="Back to content">↩</a></li>`,
    )
    .join("\n");

  return `${processed}\n\n<div class="footnotes" role="doc-endnotes"><hr><ol>\n${items}\n</ol></div>`;
}

// ── Post-processors ───────────────────────────────────────────────────────────

function wrapTables(html: string): string {
  // Make tables scrollable on small viewports.
  return html.replace(/<table(\s[^>]*)?>([\s\S]*?)<\/table>/g, (_m, attrs: string, body: string) =>
    `<div class="table-wrap"><table${attrs ?? ""}>${body}</table></div>`,
  );
}

function addImageAttributes(html: string): string {
  // Inject loading="lazy" on every <img> that doesn't already have it.
  return html.replace(/<img\b([^>]*?)>/g, (m: string, attrs: string) => {
    if (/\bloading\b/.test(attrs)) return m;
    return `<img${attrs} loading="lazy">`;
  });
}

function wrapMermaid(html: string): string {
  // Transform mermaid code blocks into lazy-load placeholders.
  return html.replace(
    /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
    (_full: string, rawCode: string) => {
      const attrSafe = rawCode.replace(/"/g, "&quot;");
      return (
        `<div class="mermaid-block" data-mermaid="${attrSafe}">` +
        `<div class="mermaid-placeholder" aria-label="Mermaid diagram">⬡ Diagram (Mermaid)</div>` +
        `<pre class="mermaid-source"><code class="language-mermaid">${rawCode}</code></pre>` +
        `</div>`
      );
    },
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface MarkdownRenderOptions {
  /**
   * Convert single line breaks to <br> (default: true).
   * Set to false for documentation pages where hard wraps are not desired.
   */
  breaks?: boolean;
}

/**
 * The single canonical markdown renderer for every InfiniBot surface.
 *
 * Features: GFM tables (scrollable), task lists, footnotes, fenced code blocks
 * with language class, inline code, kbd, blockquotes, callout blocks
 * (:::note/:::warning/:::tip/:::danger), mermaid placeholders, headings 1–6,
 * images (lazy-load), links (safe/external), HR, line breaks.
 *
 * Output is always DOMPurify-sanitized. Results are LRU-cached.
 */
export function toSanitizedMarkdownHtml(markdown: string, opts: MarkdownRenderOptions = {}): string {
  installHooks();
  installExtensions();

  const breaks = opts.breaks ?? true;
  const input = markdown.trim();
  if (!input) return "";

  const cacheKey = `${breaks ? "1" : "0"}:${input}`;
  if (cacheKey.length <= MARKDOWN_CACHE_MAX_CHARS) {
    const cached = getCached(cacheKey);
    if (cached !== null) return cached;
  }

  const truncated = truncateText(input, MARKDOWN_CHAR_LIMIT);
  const suffix = truncated.truncated
    ? `\n\n… truncated (${truncated.total} chars, showing first ${String(truncated.text.length)}).`
    : "";

  const src = preprocessFootnotes(`${truncated.text}${suffix}`);

  let sanitized: string;
  if (src.length > MARKDOWN_PARSE_LIMIT) {
    const html = `<pre class="code-block">${escapeHtml(src)}</pre>`;
    sanitized = doSanitize(html);
  } else {
    const rawHtml = marked.parse(src, { gfm: true, breaks, async: false }) as string;
    const postHtml = wrapMermaid(addImageAttributes(wrapTables(rawHtml)));
    sanitized = doSanitize(postHtml);
  }

  if (cacheKey.length <= MARKDOWN_CACHE_MAX_CHARS) setCached(cacheKey, sanitized);
  return sanitized;
}

function doSanitize(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ALLOWED_ATTRS,
    ALLOW_DATA_ATTR: true,
    ALLOWED_URI_REGEXP,
  });
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
