/**
 * Documents dialect → editor HTML.
 *
 * Renders the markdown dialect described in `src/documents/DIALECT.md` into
 * stable, serializer-friendly markup for the `<ib-doc-editor>` contenteditable
 * surface. Every construct maps to a single, attribute-tagged shape so that
 * `editorHtmlToMarkdown` (html-to-md.ts) can read it back losslessly:
 *
 *   callout      <div data-callout="NOTE" class="callout">
 *                  <div class="callout-label" data-ui contenteditable="false">Note</div>
 *                  <div class="callout-body">…blocks…</div></div>
 *   toggle       <details data-toggle><summary>inline</summary><div class="toggle-body">…</div></details>
 *   task item    <li data-checked="false|true">
 *   code block   <pre data-lang="ts" spellcheck="false"><code>…highlight spans…\n</code></pre>
 *                (textContent is the code + ONE trailing sentinel newline)
 *   math         <span data-math class="math">TeX</span> / <div data-math-block class="math-block">TeX</div>
 *   wiki link    <a data-wiki="Title">label</a>
 *   doc link     <a href="doc:<id>" data-doc="<id>">label</a>
 *   highlight    <mark>…</mark>, underline <u>…</u>
 *   embed        <figure data-embed="iframe" data-src="https://…" contenteditable="false">
 *                  <iframe src sandbox …></iframe><figcaption data-ui>…</figcaption></figure>
 *   media        <figure data-media="video|audio" data-src="…" contenteditable="false">…</figure>
 *   frontmatter  <pre data-frontmatter contenteditable="false">raw yaml</pre>
 *
 * Anything carrying a `data-ui` attribute is editor chrome and is skipped by
 * the serializer.
 */

import DOMPurify from "dompurify";
import { Marked } from "marked";
import type { MarkedExtension, Tokens } from "marked";

// ── Small helpers ────────────────────────────────────────────────────────

export function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const CALLOUT_KINDS = ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"] as const;
export type CalloutKind = (typeof CALLOUT_KINDS)[number];

const CALLOUT_LABEL: Record<CalloutKind, string> = {
  NOTE: "Note",
  TIP: "Tip",
  IMPORTANT: "Important",
  WARNING: "Warning",
  CAUTION: "Caution",
};

function normalizeCalloutKind(kind: string): CalloutKind {
  const k = kind.toUpperCase();
  return (CALLOUT_KINDS as readonly string[]).includes(k) ? (k as CalloutKind) : "NOTE";
}

function attrValue(attrs: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = re.exec(attrs);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? "";
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function isSafeMediaUrl(src: string): boolean {
  return /^(https?:\/\/|\/(?!\/)|\.\.?\/|blob:|data:(video|audio)\/)/i.test(src.trim());
}

// ── Markup builders (shared with the editor's insert commands) ───────────

export function calloutHtml(kind: string, bodyHtml: string): string {
  const k = normalizeCalloutKind(kind);
  return (
    `<div data-callout="${k}" class="callout">` +
    `<div class="callout-label" data-ui="" contenteditable="false">${CALLOUT_LABEL[k]}</div>` +
    `<div class="callout-body">${bodyHtml || "<p><br></p>"}</div></div>`
  );
}

export function calloutLabel(kind: string): string {
  return CALLOUT_LABEL[normalizeCalloutKind(kind)];
}

export function toggleHtml(summaryHtml: string, bodyHtml: string, open = false): string {
  return (
    `<details data-toggle=""${open ? " open" : ""}><summary>${summaryHtml || "<br>"}</summary>` +
    `<div class="toggle-body">${bodyHtml || "<p><br></p>"}</div></details>`
  );
}

export function codeBlockHtml(code: string, lang: string): string {
  const l = (lang || "").trim().split(/\s+/)[0] ?? "";
  return (
    `<pre data-lang="${escapeHtml(l)}" spellcheck="false"><code>${highlightCode(code, l)}\n</code></pre>`
  );
}

export function mathBlockHtml(tex: string): string {
  return `<div data-math-block="" class="math-block" spellcheck="false">${escapeHtml(tex)}</div>`;
}

export function inlineMathHtml(tex: string): string {
  return `<span data-math="" class="math" spellcheck="false">${escapeHtml(tex)}</span>`;
}

export function embedHtml(src: string): string {
  const s = escapeHtml(src);
  const frame = /^https:\/\//i.test(src)
    ? `<iframe src="${s}" sandbox="allow-scripts allow-same-origin allow-popups" loading="lazy" referrerpolicy="no-referrer" allowfullscreen=""></iframe>`
    : `<div class="embed-blocked" data-ui="">Embed blocked: only https:// sources can be framed</div>`;
  return (
    `<figure data-embed="iframe" data-src="${s}" class="embed" contenteditable="false">${frame}` +
    `<figcaption data-ui="">${s}</figcaption>` +
    `<button class="fig-remove" data-ui="" data-action="remove" title="Remove embed">×</button></figure>`
  );
}

export function mediaHtml(kind: "video" | "audio", src: string): string {
  const s = escapeHtml(src);
  return (
    `<figure data-media="${kind}" data-src="${s}" class="media media-${kind}" contenteditable="false">` +
    `<${kind} src="${s}" controls="" preload="metadata"></${kind}>` +
    `<button class="fig-remove" data-ui="" data-action="remove" title="Remove ${kind}">×</button></figure>`
  );
}

export function frontmatterHtml(raw: string): string {
  return `<pre data-frontmatter="" class="frontmatter" contenteditable="false" spellcheck="false">${escapeHtml(raw)}</pre>`;
}

// ── Syntax highlighter (dependency-free) ─────────────────────────────────

type LangSpec = { re: RegExp; classes: string[] };

const JS_KW =
  "break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return super switch this throw try typeof var void while with yield async await static get set true false null undefined NaN Infinity";
const TS_KW =
  JS_KW + " interface type enum implements private protected public readonly abstract declare namespace keyof infer is as satisfies never unknown any string number boolean symbol bigint object";
const PY_KW =
  "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield True False None self print len range";
const BASH_KW =
  "if then else elif fi case esac for while until do done in function return local export readonly declare unset shift exit echo cd source alias set sudo";
const SQL_KW =
  "select from where and or not insert into values update set delete create table drop alter add index primary key foreign references join left right inner outer full on as group by order having limit offset distinct union all case when then else end null is in like between exists count sum avg min max returning with default constraint unique check cascade begin commit rollback view";
const GO_KW =
  "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil iota string int int64 int32 uint byte rune float64 bool error any make new len cap append";
const RUST_KW =
  "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while Some None Ok Err Box Vec String Option Result i32 i64 u8 u32 u64 usize f64 bool str";
const GENERIC_KW =
  "if else for while do return function func fn def class struct enum import export from const let var new true false null nil none switch case break continue try catch throw public private static void int string bool";
const CSS_KW = "important inherit initial unset auto none";

const STR_DQ = `"(?:\\\\.|[^"\\\\\\n])*"`;
const STR_SQ = `'(?:\\\\.|[^'\\\\\\n])*'`;
const STR_BT = "`(?:\\\\.|[^`\\\\])*`";
const NUM = `\\b(?:0[xX][\\da-fA-F_]+|0[bB][01_]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)[nNuUlLfF]?\\b`;
const C_COMMENT = `\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/`;
const HASH_COMMENT = `#[^\\n]*`;

function kwRe(words: string, flags = ""): string {
  const list = words.split(/\s+/).filter(Boolean);
  const body = list.map((w) => w.replace(/[$]/g, "\\$")).join("|");
  return flags.includes("i") ? `\\b(?:${body})\\b` : `\\b(?:${body})\\b`;
}

function build(parts: Array<[string, string]>, flags = "g"): LangSpec {
  return {
    re: new RegExp(parts.map(([, src]) => `(${src})`).join("|"), flags),
    classes: parts.map(([cls]) => cls),
  };
}

const LANG_ALIASES: Record<string, string> = {
  js: "js", javascript: "js", jsx: "js", mjs: "js", cjs: "js",
  ts: "ts", typescript: "ts", tsx: "ts", mts: "ts",
  py: "py", python: "py", python3: "py",
  json: "json", jsonc: "json", json5: "json",
  bash: "bash", sh: "bash", shell: "bash", zsh: "bash", console: "bash", shellscript: "bash",
  css: "css", scss: "css", less: "css",
  html: "html", xml: "html", svg: "html", vue: "html", svelte: "html",
  sql: "sql", postgres: "sql", postgresql: "sql", mysql: "sql", sqlite: "sql",
  go: "go", golang: "go",
  rust: "rust", rs: "rust",
};

const specCache = new Map<string, LangSpec>();

function specFor(lang: string): LangSpec {
  const key = LANG_ALIASES[lang.toLowerCase()] ?? "generic";
  const hit = specCache.get(key);
  if (hit) return hit;
  let spec: LangSpec;
  const fn: [string, string] = ["tok-fn", `\\b[A-Za-z_$][\\w$]*(?=\\s*\\()`];
  switch (key) {
    case "js":
    case "ts":
      spec = build([
        ["tok-com", C_COMMENT],
        ["tok-str", `${STR_DQ}|${STR_SQ}|${STR_BT}`],
        ["tok-num", NUM],
        ["tok-kw", kwRe(key === "ts" ? TS_KW : JS_KW)],
        fn,
      ]);
      break;
    case "py":
      spec = build([
        ["tok-com", HASH_COMMENT],
        ["tok-str", `[rRbBfFuU]{0,2}(?:"""[\\s\\S]*?"""|'''[\\s\\S]*?'''|${STR_DQ}|${STR_SQ})`],
        ["tok-num", NUM],
        ["tok-kw", kwRe(PY_KW)],
        ["tok-attr", `@[\\w.]+`],
        fn,
      ]);
      break;
    case "json":
      spec = build([
        ["tok-com", C_COMMENT],
        ["tok-prop", `${STR_DQ}(?=\\s*:)`],
        ["tok-str", STR_DQ],
        ["tok-num", `-?${NUM}`],
        ["tok-kw", kwRe("true false null")],
      ]);
      break;
    case "bash":
      spec = build([
        ["tok-com", `(?:^|(?<=\\s))#[^\\n]*`],
        ["tok-str", `${STR_DQ}|${STR_SQ}`],
        ["tok-var", `\\$\\{[^}\\n]*\\}|\\$[\\w@#?*!-]+`],
        ["tok-num", NUM],
        ["tok-kw", kwRe(BASH_KW)],
        ["tok-attr", `(?<=\\s)--?[\\w-]+`],
      ], "gm");
      break;
    case "css":
      spec = build([
        ["tok-com", `\\/\\*[\\s\\S]*?\\*\\/`],
        ["tok-str", `${STR_DQ}|${STR_SQ}`],
        ["tok-kw", `@[\\w-]+|!important|${kwRe(CSS_KW)}`],
        ["tok-prop", `[\\w-]+(?=\\s*:(?!:))`],
        ["tok-num", `#[\\da-fA-F]{3,8}\\b|-?\\d*\\.?\\d+(?:px|em|rem|%|vh|vw|vmin|vmax|s|ms|deg|fr|ch|ex|pt)?\\b`],
        ["tok-fn", `[\\w-]+(?=\\()`],
      ]);
      break;
    case "html":
      spec = build([
        ["tok-com", `<!--[\\s\\S]*?-->`],
        ["tok-tag", `<\\/?[A-Za-z][\\w:-]*|\\/?>`],
        ["tok-attr", `[\\w:@.-]+(?==)`],
        ["tok-str", `${STR_DQ}|${STR_SQ}`],
      ]);
      break;
    case "sql":
      spec = build([
        ["tok-com", `--[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/`],
        ["tok-str", `${STR_SQ}|${STR_DQ}`],
        ["tok-num", NUM],
        ["tok-kw", kwRe(SQL_KW)],
        fn,
      ], "gi");
      break;
    case "go":
      spec = build([
        ["tok-com", C_COMMENT],
        ["tok-str", `${STR_DQ}|${STR_BT}|'(?:\\\\.|[^'\\\\\\n])'`],
        ["tok-num", NUM],
        ["tok-kw", kwRe(GO_KW)],
        fn,
      ]);
      break;
    case "rust":
      spec = build([
        ["tok-com", C_COMMENT],
        ["tok-str", `r#*"[\\s\\S]*?"#*|${STR_DQ}|'(?:\\\\.|[^'\\\\\\n])'(?!\\w)`],
        ["tok-num", NUM],
        ["tok-kw", kwRe(RUST_KW)],
        ["tok-attr", `#!?\\[[^\\]\\n]*\\]|[a-z_]\\w*!`],
        fn,
      ]);
      break;
    default:
      spec = build([
        ["tok-com", `${C_COMMENT}|(?:^|(?<=\\s))#[^\\n]*`],
        ["tok-str", `${STR_DQ}|${STR_SQ}|${STR_BT}`],
        ["tok-num", NUM],
        ["tok-kw", kwRe(GENERIC_KW)],
        fn,
      ], "gm");
  }
  specCache.set(key, spec);
  return spec;
}

/**
 * Tiny regex highlighter. Output is escaped HTML with `<span class="tok-*">`
 * wrappers only — the text content is exactly `code`, so serialization (which
 * reads textContent) is unaffected.
 */
export function highlightCode(code: string, lang: string): string {
  const src = String(code ?? "");
  if (!src) return "";
  if (!lang || /^(text|plain|plaintext|txt|md|markdown)$/i.test(lang) || src.length > 200_000) {
    return escapeHtml(src);
  }
  const { re, classes } = specFor(lang);
  re.lastIndex = 0;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m[0] === "") {
      re.lastIndex++;
      continue;
    }
    const gi = m.findIndex((g, i) => i > 0 && g !== undefined);
    if (gi <= 0) continue;
    out += escapeHtml(src.slice(last, m.index));
    out += `<span class="${classes[gi - 1]}">${escapeHtml(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  out += escapeHtml(src.slice(last));
  return out;
}

// ── Marked extensions ────────────────────────────────────────────────────

type AnyToken = Tokens.Generic;

const calloutExt = {
  name: "callout",
  level: "block" as const,
  start(src: string) {
    const m = /^ {0,3}> ?\[!/m.exec(src);
    return m ? m.index : undefined;
  },
  tokenizer(this: any, src: string) {
    const m = /^ {0,3}> ?\[!(note|tip|important|warning|caution)\][ \t]*([^\n]*)(?:\n|$)((?: {0,3}>[^\n]*(?:\n|$))*)/i.exec(src);
    if (!m) return undefined;
    const firstRest = m[2] ?? "";
    const lines = (m[3] ?? "").split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    const bodyLines = lines.map((l) => l.replace(/^ {0,3}> ?/, ""));
    if (firstRest.trim()) bodyLines.unshift(firstRest.trim());
    const body = bodyLines.join("\n");
    const token: AnyToken = {
      type: "callout",
      raw: m[0],
      kind: normalizeCalloutKind(m[1]!),
      tokens: [],
    };
    this.lexer.blockTokens(body, token.tokens);
    return token;
  },
  renderer(this: any, token: AnyToken) {
    return calloutHtml(token.kind, this.parser.parse(token.tokens ?? []));
  },
};

function findDetailsEnd(src: string, from: number): number {
  const re = /<details\b[^>]*>|<\/details\s*>/gi;
  re.lastIndex = from;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m[0][1] === "/") {
      depth--;
      if (depth === 0) return m.index;
    } else depth++;
  }
  return -1;
}

const toggleExt = {
  name: "toggle",
  level: "block" as const,
  start(src: string) {
    const m = /^ {0,3}<details\b/im.exec(src);
    return m ? m.index : undefined;
  },
  tokenizer(this: any, src: string) {
    const open = /^ {0,3}<details\b[^>]*>\s*(?:<summary\b[^>]*>([\s\S]*?)<\/summary\s*>)?/i.exec(src);
    if (!open) return undefined;
    const end = findDetailsEnd(src, open[0].length);
    if (end < 0) return undefined;
    const closeM = /^<\/details\s*>[ \t]*(?:\n|$)/i.exec(src.slice(end));
    if (!closeM) return undefined;
    const raw = src.slice(0, end + closeM[0].length);
    const body = src.slice(open[0].length, end).replace(/^\s*\n/, "").replace(/\s+$/, "");
    const summary = (open[1] ?? "").trim();
    const token: AnyToken = {
      type: "toggle",
      raw,
      summary,
      open: /^ {0,3}<details\b[^>]*\bopen\b/i.test(src),
      summaryTokens: [],
      tokens: [],
    };
    this.lexer.inline(summary, token.summaryTokens);
    this.lexer.blockTokens(body, token.tokens);
    return token;
  },
  renderer(this: any, token: AnyToken) {
    return toggleHtml(
      this.parser.parseInline(token.summaryTokens ?? []),
      this.parser.parse(token.tokens ?? []),
      false,
    );
  },
  childTokens: ["summaryTokens", "tokens"],
};

const embedExt = {
  name: "embed",
  level: "block" as const,
  start(src: string) {
    const m = /^ {0,3}<(?:iframe|video|audio)\b/im.exec(src);
    return m ? m.index : undefined;
  },
  tokenizer(src: string) {
    const m = /^ {0,3}<(iframe|video|audio)\b([^>]*)>\s*((?:<source\b[^>]*>\s*)*)<\/\1\s*>[ \t]*(?:\n|$)/i.exec(src);
    if (!m) return undefined;
    const tag = m[1]!.toLowerCase();
    let srcAttr = attrValue(m[2] ?? "", "src");
    if (srcAttr == null && m[3]) srcAttr = attrValue(m[3], "src");
    return { type: "embed", raw: m[0], tag, src: decodeEntities(srcAttr ?? "") };
  },
  renderer(token: AnyToken) {
    const src = String(token.src ?? "");
    if (token.tag === "iframe") {
      if (!/^https?:\/\//i.test(src)) return "";
      return embedHtml(src);
    }
    if (!isSafeMediaUrl(src)) return "";
    return mediaHtml(token.tag as "video" | "audio", src);
  },
};

const mathBlockExt = {
  name: "mathBlock",
  level: "block" as const,
  start(src: string) {
    const m = /^ {0,3}\$\$/m.exec(src);
    return m ? m.index : undefined;
  },
  tokenizer(src: string) {
    let m = /^ {0,3}\$\$[ \t]*\n([\s\S]*?)\n? {0,3}\$\$[ \t]*(?:\n|$)/.exec(src);
    if (!m) m = /^ {0,3}\$\$([^\n]+?)\$\$[ \t]*(?:\n|$)/.exec(src);
    if (!m) return undefined;
    return { type: "mathBlock", raw: m[0], text: (m[1] ?? "").trim() };
  },
  renderer(token: AnyToken) {
    return mathBlockHtml(String(token.text ?? ""));
  },
};

const inlineMathExt = {
  name: "inlineMath",
  level: "inline" as const,
  start(src: string) {
    const i = src.indexOf("$");
    return i < 0 ? undefined : i;
  },
  tokenizer(src: string) {
    const m = /^\$(?![\s$])((?:\\.|[^\\$\n])+?)(?<![\s\\])\$(?!\d)/.exec(src);
    if (!m) return undefined;
    return { type: "inlineMath", raw: m[0], text: m[1] };
  },
  renderer(token: AnyToken) {
    return inlineMathHtml(String(token.text ?? ""));
  },
};

const highlightExt = {
  name: "highlight",
  level: "inline" as const,
  start(src: string) {
    const i = src.indexOf("==");
    return i < 0 ? undefined : i;
  },
  tokenizer(this: any, src: string) {
    const m = /^==(?![\s=])([\s\S]*?[^\s\\])==(?!=)/.exec(src);
    if (!m) return undefined;
    return { type: "highlight", raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) };
  },
  renderer(this: any, token: AnyToken) {
    return `<mark>${this.parser.parseInline(token.tokens ?? [])}</mark>`;
  },
};

const wikiExt = {
  name: "wikiLink",
  level: "inline" as const,
  start(src: string) {
    const i = src.indexOf("[[");
    return i < 0 ? undefined : i;
  },
  tokenizer(src: string) {
    const m = /^\[\[([^\[\]\n|]+?)(?:\|([^\[\]\n]+?))?\]\]/.exec(src);
    if (!m) return undefined;
    return { type: "wikiLink", raw: m[0], title: m[1]!.trim(), label: (m[2] ?? "").trim() };
  },
  renderer(token: AnyToken) {
    const title = String(token.title);
    const label = String(token.label || title);
    return `<a data-wiki="${escapeHtml(title)}" class="wiki">${escapeHtml(label)}</a>`;
  },
};

const rendererOverrides: MarkedExtension["renderer"] = {
  code(token: Tokens.Code) {
    return codeBlockHtml(token.text ?? "", token.lang ?? "");
  },
  listitem(this: any, item: Tokens.ListItem) {
    const task = item.task ? ` data-checked="${item.checked ? "true" : "false"}"` : "";
    return `<li${task}>${this.parser.parse(item.tokens)}</li>\n`;
  },
  checkbox() {
    return "";
  },
  link(this: any, token: Tokens.Link) {
    const inner = this.parser.parseInline(token.tokens);
    const href = String(token.href ?? "");
    const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
    const doc = /^doc:(.+)$/i.exec(href);
    if (doc) {
      return `<a href="${escapeHtml(href)}" data-doc="${escapeHtml(doc[1]!)}"${title}>${inner}</a>`;
    }
    return `<a href="${escapeHtml(href)}"${title}>${inner}</a>`;
  },
};

let markedInstance: Marked | null = null;
function getMarked(): Marked {
  if (markedInstance) return markedInstance;
  const m = new Marked({ gfm: true, breaks: false, async: false });
  m.use({
    extensions: [calloutExt, toggleExt, embedExt, mathBlockExt, inlineMathExt, highlightExt, wikiExt] as any,
    renderer: rendererOverrides,
  });
  markedInstance = m;
  return m;
}

// ── Frontmatter ──────────────────────────────────────────────────────────

export function splitFrontmatter(md: string): { frontmatter: string | null; body: string } {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(md);
  if (!m) return { frontmatter: null, body: md };
  const inner = m[1] ?? "";
  const first = inner.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  if (!/^[\w$.-][\w$. -]*\s*:/.test(first) && !/^#/.test(first)) return { frontmatter: null, body: md };
  return { frontmatter: inner, body: md.slice(m[0].length) };
}

// ── Sanitizer ────────────────────────────────────────────────────────────

type Purifier = ReturnType<typeof DOMPurify>;

const ALLOWED_TAGS = [
  "p", "br", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "u", "s", "del", "strike",
  "mark", "code", "pre", "span", "a", "img", "ul", "ol", "li", "blockquote", "div", "details",
  "summary", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "hr", "figure", "figcaption",
  "iframe", "video", "audio", "source", "sub", "sup", "kbd", "input", "button", "caption", "ins",
];
const ALLOWED_ATTR = [
  "href", "src", "alt", "title", "align", "start", "colspan", "rowspan", "open", "controls", "type",
  "checked", "disabled", "contenteditable", "spellcheck", "class", "sandbox", "loading",
  "referrerpolicy", "allowfullscreen", "preload", "role", "aria-checked",
];
const ALLOWED_URI_REGEXP =
  /^(?:(?:https?|mailto|tel|doc|blob):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

let purifier: Purifier | null = null;

function installHooks(p: Purifier) {
  p.addHook("afterSanitizeAttributes", (node: Element) => {
    const tag = node.nodeName;
    if (tag === "IFRAME") {
      const src = node.getAttribute("src") ?? "";
      if (!/^https:\/\//i.test(src)) node.removeAttribute("src");
      node.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups");
      node.setAttribute("referrerpolicy", "no-referrer");
      node.setAttribute("loading", "lazy");
    } else if (tag === "INPUT") {
      node.setAttribute("type", "checkbox");
      node.setAttribute("disabled", "");
    } else if (tag === "BUTTON") {
      node.setAttribute("type", "button");
    }
    for (const name of ["data-src", "data-doc"]) {
      const v = node.getAttribute?.(name);
      if (v && /^\s*(javascript|vbscript|data:text)/i.test(v)) node.removeAttribute(name);
    }
  });
}

/**
 * Bind the sanitizer to a specific window (tests pass a linkedom window).
 * In the browser it lazily binds to the global `window`.
 */
export function setSanitizerWindow(win: unknown): void {
  const p = (DOMPurify as unknown as (w: unknown) => Purifier)(win);
  installHooks(p);
  purifier = p;
}

function getPurifier(): Purifier | null {
  if (!purifier && typeof window !== "undefined") setSanitizerWindow(window);
  return purifier && purifier.isSupported ? purifier : null;
}

/** Sanitize editor HTML: only the tags/attributes the editor emits survive. */
export function sanitizeEditorHtml(html: string, opts: { allowStyle?: boolean } = {}): string {
  if (!html || !html.trim()) return "";
  const p = getPurifier();
  if (!p) return html;
  return p.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: opts.allowStyle ? [...ALLOWED_ATTR, "style"] : ALLOWED_ATTR,
    ALLOW_DATA_ATTR: true,
    ALLOWED_URI_REGEXP,
    ADD_URI_SAFE_ATTR: ["data-src", "data-doc", "data-wiki", "data-lang", "data-callout"],
    RETURN_TRUSTED_TYPE: false,
  }) as unknown as string;
}

// ── Public API ───────────────────────────────────────────────────────────

export interface MarkdownToHtmlOptions {
  /** Skip DOMPurify (tests only). */
  sanitize?: boolean;
}

// ── Stored document assets on another origin (hosted cloud) ─────────────
//
// Embedded images are stored as gateway-relative paths
// (/api/documents/assets/<hash>.<ext>). When the UI is served from another
// site than the gateway (hosted cloud), the Documents workspace installs a
// resolver that turns them into absolute, ticketed URLs for display. The
// stored path is kept in data-asset-src, which html-to-md writes back, so a
// ticket or tenant host never ends up in the saved markdown.

const DOC_ASSET_IMG_RE = /<img\b([^>]*?)\ssrc="(\/api\/documents\/assets\/[^"?#]+)"/g;
let assetResolver: ((path: string) => string | null) | null = null;

export function setDocAssetResolver(fn: ((path: string) => string | null) | null): void {
  assetResolver = fn;
}

/** Rewrite stored-asset <img> src attributes through the active resolver. */
export function resolveDocAssetImages(html: string): string {
  const resolve = assetResolver;
  if (!resolve || !html.includes("/api/documents/assets/")) return html;
  return html.replace(DOC_ASSET_IMG_RE, (whole, pre: string, path: string) => {
    const url = resolve(path);
    return url ? `<img${pre} src="${escapeHtml(url)}" data-asset-src="${path}"` : whole;
  });
}

/** Render the Documents dialect into editor HTML (sanitized). */
export function markdownToEditorHtml(md: string, opts: MarkdownToHtmlOptions = {}): string {
  const source = String(md ?? "").replace(/\r\n?/g, "\n");
  const { frontmatter, body } = splitFrontmatter(source);
  let html = frontmatter != null ? frontmatterHtml(frontmatter) : "";
  html += getMarked().parse(body, { async: false }) as string;
  // Block-level newlines between tags are noise in a contenteditable surface.
  // (Never touch newlines inside <pre>: only strip after block-level tags.)
  html = html
    .replace(
      /(<\/(?:p|h[1-6]|ul|ol|li|blockquote|table|thead|tbody|tfoot|tr|th|td|pre|div|details|figure|summary)>|<(?:ul|ol|table|thead|tbody|tr|hr)\b[^>]*>)\n+/g,
      "$1",
    )
    .trim();
  return resolveDocAssetImages(opts.sanitize === false ? html : sanitizeEditorHtml(html));
}
