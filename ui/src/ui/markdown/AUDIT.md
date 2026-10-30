# Markdown System Audit

**Date:** 2026-06-17  
**Canonical renderer:** `ui/src/ui/markdown/render.ts` → `toSanitizedMarkdownHtml()`  
**Re-export shim:** `ui/src/ui/markdown.ts` (all existing imports remain valid)

---

## 1. Surface Inventory

| Surface | File | Pre-unification renderer | Status |
|---------|------|--------------------------|--------|
| Chat messages | `ui/src/ui/chat/grouped-render.ts:375,379` | `toSanitizedMarkdownHtml` | ✅ Already canonical |
| Tool output sidebar | `ui/src/ui/views/markdown-sidebar.ts:32` | `toSanitizedMarkdownHtml` | ✅ Already canonical |
| Notes editor preview | `ui/src/ui/components/markdown-editor.ts:395` | `marked.parse()` bare (no DOMPurify!) | ✅ **Migrated** → `toSanitizedMarkdownHtml` |
| Kanban file preview | `ui/src/ui/views/kanban.ts:3911` | local `renderPreviewMarkdownHtml()` duplicate | ✅ **Migrated** → `toSanitizedMarkdownHtml` |
| Learn / InfiniLearn step bodies | `ui/src/ui/views/learn.ts:499` | custom hand-rolled parser (bold/italic/code/h2-h4/ul only) | ✅ **Migrated** → `toSanitizedMarkdownHtml` |
| Docs page content | `ui/src/ui/views/docs.ts:1099` | `marked.parse()` + `enrichHtml()` + DOMPurify (custom opts) | ✅ **Fixed** global options pollution; retains custom enrichHtml post-processor |
| Workflows editor preview | `ui/src/ui/views/workflows.ts:236` | `toSanitizedMarkdownHtml` | ✅ Already canonical |
| Product descriptions | `ui/src/ui/views/products.ts:1290` | `toSanitizedMarkdownHtml` | ✅ Already canonical |
| Prompt templates preview | `ui/src/ui/views/prompt-templates.ts:437` | `toSanitizedMarkdownHtml` | ✅ Already canonical |
| Business / proposal bodies | `ui/src/ui/views/business.ts:4912` | `toSanitizedMarkdownHtml` | ✅ Already canonical |
| Grid streaming content | `ui/src/ui/views/masonry-grid.ts:11178,11492` | `toSanitizedMarkdownHtml` | ✅ Already canonical |
| CRM client note preview | `ui/src/ui/views/clients.ts:3697` | `toSanitizedMarkdownHtml` | ✅ Already canonical |
| Notion block renderer | `ui/src/ui/views/kanban.ts:4005` | Custom `renderNotionBlock()` | ⬜ Intentionally kept — renders Notion block JSON, not markdown strings |

---

## 2. Critical Bug Fixed

### `docs.ts` global `marked.setOptions()` pollution

**Before:** `docs.ts:66` called `marked.setOptions({ gfm: true, breaks: false })` at module scope.  
`marked.setOptions()` mutates global parser state, so any module loaded after `docs.ts` that called `marked.parse()` without explicit options would inherit `breaks: false`, silently breaking line-break rendering in chat, notes, kanban, etc.

**After:** Removed the global `setOptions` call. `docs.ts` now passes `{ gfm: true, breaks: false }` directly to its `marked.parse()` call. All other surfaces were already passing `{ gfm: true, breaks: true }` through the canonical renderer.

---

## 3. Supported Element Matrix

| Element | Canonical renderer | Notes editor | Docs | Learn (pre) | Notes |
|---------|-------------------|--------------|------|------------|-------|
| GFM tables (scrollable) | ✅ | ✅ | ✅ | ❌→✅ | Wrapped in `.table-wrap` for overflow |
| Task lists `[ ]` / `[x]` | ✅ | ✅ | ✅ | ❌→✅ | `input[type=checkbox]` with `checked` |
| Footnotes `[^n]` | ✅ | ✅ | ✅ | ❌→✅ | Custom preprocessor (no extra lib) |
| Fenced code blocks + lang class | ✅ | ✅ | ✅ | partial→✅ | `class="language-*"` for future syntax hl |
| Inline code | ✅ | ✅ | ✅ | ✅→✅ | |
| `<kbd>` elements | ✅ | ✅ | ✅ | ❌→✅ | In ALLOWED_TAGS |
| Blockquotes | ✅ | ✅ | ✅ | ❌→✅ | |
| Callout blocks `:::note` | ✅ | ✅ | ✅ | ❌→✅ | Custom marked block extension |
| Headings H1–H6 | ✅ | ✅ | ✅ | partial→✅ | H5/H6 added to ALLOWED_TAGS |
| Images (lazy-load) | ✅ | ✅ | ✅ | ❌→✅ | `loading="lazy"` injected by post-processor |
| External links (target=_blank) | ✅ | ✅ | ✅ | ❌→✅ | DOMPurify hook |
| Internal `moltbot://` links | ✅ | ✅ | n/a | ❌→✅ | ALLOWED_URI_REGEXP includes `moltbot:` |
| Fragment links (no new tab) | ✅ | ✅ | ✅ | n/a | |
| Horizontal rules | ✅ | ✅ | ✅ | ❌→✅ | |
| Hard/soft line breaks | ✅ (breaks:true) | ✅ | ✅ (breaks:false) | ❌→✅ | Docs keeps breaks:false intentionally |
| Mermaid placeholders | ✅ | ✅ | ✅ | ❌→✅ | `.mermaid-block[data-mermaid]` div; runtime JS opt-in |
| `<details>` / `<summary>` | ✅ | ✅ | ✅ | ❌→✅ | In ALLOWED_TAGS |
| `<mark>` / `<sub>` / `<sup>` | ✅ | ✅ | ✅ | ❌→✅ | |
| Inline LaTeX/math | ❌ | ❌ | ❌ | ❌ | No math library installed; see §6 |
| Syntax highlighting | ❌ | ❌ | ❌ | ❌ | No hljs/shiki installed; see §6 |

---

## 4. Storage Unification

### Current state

Markdown content is stored in **one place: the InfiniBot SQLite database** (accessed via gateway RPCs). There are no shadow stores of raw markdown content discovered during this audit.

- Notes: stored as `body` text field in the `notes` table, returned by `mcp__infinibot__notes` / `ui_control dispatch view=notes`. ✅ Single source.
- Kanban tasks/projects: stored as `description`/`body` in kanban tables. ✅ Single source.
- Workflows: stored in `workflows` table, `body` field. ✅ Single source.
- Learn tracks: stored in the `learn_tracks` JSON config (server-side); the `body` field per step is the markdown source. ✅ Single source.

**Shadow stores identified and left in place (intentionally):**
- `src/markdown/ir.ts` — backend (non-browser) markdown-to-IR parser using `markdown-it`. Used for Slack/Telegram export formatting. Not a shadow store of content; it's a transformation pipeline. **Do not merge** — it has a different output format (IR JSON, not HTML).
- `src/markdown/render.ts` — backend text renderer for CLI/export. Same reason. **Do not merge**.

### Read path
All surfaces read via gateway RPC → database. There are no known "stale cache return paths" — the gateway does not cache markdown strings server-side at the application layer (only normal HTTP/WS transport buffering).

---

## 5. Docs View — Intentional Divergence

`docs.ts` retains its own `marked.parse()` call with `enrichHtml()` post-processing because it needs:
1. `breaks: false` — doc pages use explicit line breaks, not soft-wrap paragraphs
2. Custom heading anchors (`id` attrs + `¶` permalink) for in-page TOC
3. Code-block copy buttons (DOM event handlers, can't be in static HTML)
4. Runtime search-term `<mark>` injection based on `this.query`

These are all post-render DOM concerns that go beyond what a pure string→HTML renderer can provide. The fix applied here removes the global options pollution while keeping the custom pipeline intact.

---

## 6. Known Gaps (future work)

### Syntax highlighting
No highlight library (`shiki`, `hljs`, `prism`) is installed. Code blocks emit `<code class="language-*">` which enables future integration. To add:
```
pnpm add --filter ui highlight.js
```
Then import in `render.ts` and use `marked.use({ renderer: { code(token) { ... } } })`.

### Inline LaTeX / math
No KaTeX or MathJax installed. Add `katex` + a marked extension when needed.

### Embed cards
Partial implementation exists in `kanban.ts`'s `renderNotionBlock()` for Notion bookmark blocks. Canonical string-markdown renderer does not generate embed cards (links are rendered as `<a>`). To add rich previews, use a link-preview API + a custom marked link renderer extension.

### Mermaid runtime rendering
The renderer emits `.mermaid-block[data-mermaid]` placeholder divs. To activate:
```typescript
import mermaid from "mermaid";
document.querySelectorAll(".mermaid-block").forEach((el) => {
  el.classList.add("mermaid-rendered");
  mermaid.render("id-" + Math.random(), el.dataset.mermaid).then(({ svg }) => {
    el.insertAdjacentHTML("afterbegin", svg);
  });
});
```

---

## 7. CSS / Styling

### Canonical styles
Exported from `ui/src/ui/markdown/styles.ts` as a Lit `CSSResult` (`markdownStyles`).

Apply by:
1. Adding `markdownStyles` to a component's `static styles` array.
2. Wrapping rendered HTML in `<div class="md-body">`.

### Per-surface status

| Surface | Shared `markdownStyles`? | Notes |
|---------|-------------------------|-------|
| `markdown-editor.ts` | ❌ (has equivalent `.me-preview` CSS) | Functionally equivalent; `.me-preview` predates `markdownStyles`. Migrate in a follow-up. |
| `kanban.ts` | ❌ (`.kb-preview-markdown` CSS) | Added `md-body` class to the wrapper div for future migration. |
| `learn.ts` | ❌ (`.learn-md` CSS, minimal) | Added `md-body` class to wrapper; `.learn-md` styles will need augmenting. |
| All other surfaces | n/a (no markdown-specific CSS) | Use global stylesheet or component-scoped generic styles. |

Full visual parity requires migrating each Lit component's shadow DOM styles to import `markdownStyles`. This is a follow-up task — the rendering pipeline is now unified; only CSS import is outstanding.
