/**
 * Centralized UI Control Bus registrations for app-level views.
 *
 * Most InfiniBot "views" are render functions that read from AppViewState,
 * not standalone lit elements. To expose them to the agent we register a
 * single set of controllers here, each closing over the host (InfiniBotApp)
 * so it has live access to state and the gateway client.
 *
 * Per-component lit elements (e.g. voice-chat) register themselves in their
 * own connectedCallback for tighter lifecycle coupling.
 *
 * Adding a new view:
 *   1. Add a new entry inside `registerAppViewControllers`.
 *   2. Implement getState() (must return JSON-safe data).
 *   3. Implement dispatch() handling each action type.
 *   4. Implement describeActions() so the agent can discover them.
 */

import { pluginNavSections } from "./plugin-host.js";
import type { AppViewState } from "./app-view-state";
import { attachViewController, UIControlBus, type RegistrationHandle } from "./control-bus";
import { pickScrollTarget, type ScrollTarget } from "./control-bus-helpers";
import * as dbCtrl from "./controllers/databases";
import * as kanbanCtrl from "./controllers/kanban";
import * as chatCtrl from "./controllers/chat";
import * as workflowsCtrl from "./controllers/workflows";
import * as notesCtrl from "./controllers/notes";
import * as agentsMgmtCtrl from "./controllers/agents-management";
import * as mgridCtrl from "./controllers/masonry-grid";
import * as clientsCtrl from "./controllers/clients";
import { registerGridController } from "./control-bus-grid";
import { registerWhiteboardController } from "./control-bus-whiteboard";
import { registerRemoteScreenController } from "./components/remote-screen";
import { NAV_CATALOG_GROUPS, contentTabOf, type Tab, titleForTab, subtitleForTab } from "./navigation";
import { TAB_SYNONYMS } from "./tab-synonyms";

/* ─── tab catalog ─────────────────────────────────────────────────────────
 * Single source of truth for "which tabs exist and what does the user call
 * them." The agent's nav controller advertises this whole list in get_state
 * + describeActions so the model never has to guess at tab names. Synonyms
 * are how natural-language references like "client's page", "the CRM",
 * "command center", "leads page" resolve to canonical Tab ids without the
 * agent ping-ponging through wrong views first.
 */
type TabCatalogEntry = {
    id: Tab;
    title: string;
    subtitle: string;
    group: string;
    synonyms: string[];
};

const CORE_TAB_CATALOG: TabCatalogEntry[] = (() => {
    const out: TabCatalogEntry[] = [];
    const seen = new Set<string>();
    for (const grp of NAV_CATALOG_GROUPS) {
        for (const t of grp.tabs as readonly Tab[]) {
            if (seen.has(t)) continue;
            seen.add(t);
            out.push({
                id: t,
                title: titleForTab(t),
                subtitle: subtitleForTab(t),
                group: grp.label,
                synonyms: TAB_SYNONYMS[t] ?? [],
            });
        }
    }
    return out;
})();
/**
 * Core tabs plus the pages of every loaded plugin section (Business &
 * Agency, Products, …) — a disabled plugin's pages are not switchable.
 */
function tabCatalog(): TabCatalogEntry[] {
    const out = [...CORE_TAB_CATALOG];
    const seen = new Set(out.map((e) => e.id));
    for (const section of pluginNavSections()) {
        for (const it of section.items) {
            if (seen.has(it.tab)) continue;
            seen.add(it.tab);
            out.push({
                id: it.tab,
                title: titleForTab(it.tab),
                subtitle: subtitleForTab(it.tab),
                group: section.title,
                synonyms: [it.label, ...(TAB_SYNONYMS[it.tab] ?? [])],
            });
        }
    }
    return out;
}
const normalize = (s: string) =>
    s.toLowerCase().trim().replace(/['’]s\b/g, "").replace(/\s+page$/, "").replace(/\s+/g, " ");

/* ─── generic name resolver ──────────────────────────────────────────────
 * Shared by kanban / databases find_* and open_*_by_name actions so the
 * agent can hand off natural-language references ("KK Clients", "the kanban
 * project", "customer database") and get a deterministic id back. Same
 * stage ordering as resolveTab: exact id → exact name → exact alias →
 * substring/word overlap with longest-match tiebreak. Returns matches in
 * priority order so find_* can list candidates and open_*_by_name can pick
 * the best one.
 */
type NameMatchItem = { id: string; name: string; aliases?: string[] };
type NameMatch<T extends NameMatchItem> = { item: T; score: number; matchedOn: string };
function matchByName<T extends NameMatchItem>(
    query: string,
    items: readonly T[],
    extraAliases?: (item: T) => string[],
): NameMatch<T>[] {
    if (!query) return [];
    const q = normalize(query);
    const out: NameMatch<T>[] = [];
    for (const item of items) {
        const haystacks = [item.id, item.name, ...(item.aliases ?? []), ...(extraAliases?.(item) ?? [])];
        let best: { score: number; matchedOn: string } | undefined;
        for (const h of haystacks) {
            const n = normalize(String(h ?? ""));
            if (!n) continue;
            let score = 0;
            if (n === q) score = 1000;
            else if (q.includes(n) || n.includes(q)) score = Math.min(n.length, q.length);
            else {
                // Word-overlap fallback: every query word must appear as a
                // substring somewhere in the haystack. Lets "kk clients"
                // match "KK Customer Database" via "kk" + nothing — but
                // "kk customer" must hit "kk" AND "customer". Cheap and
                // good enough for these short labels.
                const words = q.split(" ").filter(Boolean);
                if (words.length > 1 && words.every((w) => n.includes(w))) {
                    score = words.reduce((acc, w) => acc + w.length, 0);
                }
            }
            if (score > 0 && (!best || score > best.score)) best = { score, matchedOn: String(h) };
        }
        if (best) out.push({ item, score: best.score, matchedOn: best.matchedOn });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
}

function resolveTab(query: string): TabCatalogEntry | undefined {
    if (!query) return undefined;
    const q = normalize(query);
    // 1. Exact id (case-insensitive)
    const byId = tabCatalog().find((e) => e.id.toLowerCase() === q);
    if (byId) return byId;
    // 2. Exact title match
    const byTitle = tabCatalog().find((e) => normalize(e.title) === q);
    if (byTitle) return byTitle;
    // 3. Exact synonym match
    const bySyn = tabCatalog().find((e) => e.synonyms.some((s) => normalize(s) === q));
    if (bySyn) return bySyn;
    // 4. Substring/word match against title and synonyms (longest match wins).
    let best: { entry: TabCatalogEntry; score: number } | undefined;
    for (const entry of tabCatalog()) {
        const haystacks = [entry.id, entry.title, ...entry.synonyms];
        for (const h of haystacks) {
            const n = normalize(h);
            if (!n) continue;
            if (q.includes(n) || n.includes(q)) {
                const score = Math.min(n.length, q.length);
                if (!best || score > best.score) best = { entry, score };
            }
        }
    }
    return best?.entry;
}

let registered: RegistrationHandle[] = [];

export function unregisterAppViewControllers(): void {
    for (const h of registered) {
        try { h.unregister(); } catch { /* ignore */ }
    }
    registered = [];
}

function safe<T>(fn: () => T, fallback: T): T {
    try { return fn(); } catch { return fallback; }
}

function reqClient(host: AppViewState) {
    if (!host.client) throw new Error("gateway client not connected");
    return host.client;
}

/* ─── text-search helpers (used by page view) ─────────────────────────── */

/**
 * Walk visible text nodes looking for a substring match. Skips script/style
 * and elements that aren't visible (offsetParent === null). Returns the
 * containing element + a short snippet for context.
 */
function findFirstTextNode(query: string, caseSensitive = false): { element: HTMLElement; snippet: string } | null {
    const needle = caseSensitive ? query : query.toLowerCase();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            const tag = parent.tagName;
            if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return NodeFilter.FILTER_REJECT;
            if (parent.offsetParent === null && tag !== "BODY") return NodeFilter.FILTER_REJECT;
            const text = node.nodeValue ?? "";
            const haystack = caseSensitive ? text : text.toLowerCase();
            return haystack.includes(needle) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
    });
    const first = walker.nextNode();
    if (!first) return null;
    const parent = first.parentElement!;
    const fullText = first.nodeValue ?? "";
    const idx = (caseSensitive ? fullText : fullText.toLowerCase()).indexOf(needle);
    const start = Math.max(0, idx - 20);
    const end = Math.min(fullText.length, idx + needle.length + 40);
    const snippet = (start > 0 ? "…" : "") + fullText.slice(start, end) + (end < fullText.length ? "…" : "");
    return { element: parent, snippet };
}

function findAllTextNodes(query: string, caseSensitive = false, limit = 10): Array<{ element: HTMLElement; snippet: string }> {
    const needle = caseSensitive ? query : query.toLowerCase();
    const out: Array<{ element: HTMLElement; snippet: string }> = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            const tag = parent.tagName;
            if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return NodeFilter.FILTER_REJECT;
            if (parent.offsetParent === null && tag !== "BODY") return NodeFilter.FILTER_REJECT;
            const text = node.nodeValue ?? "";
            const haystack = caseSensitive ? text : text.toLowerCase();
            return haystack.includes(needle) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
    });
    let node: Node | null;
    while ((node = walker.nextNode())) {
        if (out.length >= limit) break;
        const parent = (node as Text).parentElement!;
        const fullText = node.nodeValue ?? "";
        const idx = (caseSensitive ? fullText : fullText.toLowerCase()).indexOf(needle);
        const start = Math.max(0, idx - 20);
        const end = Math.min(fullText.length, idx + needle.length + 40);
        const snippet = (start > 0 ? "…" : "") + fullText.slice(start, end) + (end < fullText.length ? "…" : "");
        out.push({ element: parent, snippet });
    }
    return out;
}

/**
 * Find a clickable element whose text content contains the query. Preferred
 * tags first: button, a, [role=button], [onclick], inputs. Falls back to
 * any element with matching text whose parent chain has a click handler.
 */
function findFirstClickableByText(query: string, role?: string): HTMLElement | null {
    const needle = query.toLowerCase();
    const candidateSelectors = role
        ? [role.toLowerCase()]
        : ["button", "a", '[role="button"]', '[role="link"]', "input[type='submit']", "input[type='button']"];
    for (const sel of candidateSelectors) {
        let els: NodeListOf<Element>;
        try { els = document.querySelectorAll(sel); } catch { continue; }
        for (const el of els) {
            const elHtml = el as HTMLElement;
            if (elHtml.offsetParent === null) continue;
            const text = (elHtml.innerText ?? elHtml.textContent ?? "").toLowerCase();
            if (text.includes(needle)) return elHtml;
        }
    }
    // Fallback: any visible element whose own text (not descendants') contains the query.
    const all = document.querySelectorAll("*");
    for (const el of all) {
        const elHtml = el as HTMLElement;
        if (elHtml.offsetParent === null) continue;
        const tag = elHtml.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") continue;
        const text = (elHtml.innerText ?? "").toLowerCase();
        if (text.includes(needle) && (elHtml.onclick || elHtml.getAttribute("role") === "button")) {
            return elHtml;
        }
    }
    return null;
}

/* ─── editor handle + highlight overlay ──────────────────────────────── */

/**
 * Editor handle — unified interface across two very different editor kinds:
 *
 *   • textarea kind: <moltbot-markdown-editor>, <moltbot-block-editor>
 *     (which itself is a textarea-based markdown editor). Plain text body
 *     stored on element.value; line = `\n`-split text line.
 *
 *   • blocks kind: the Notion-style block editor mounted on a `.bk-host`
 *     element (project content pages). Each block is one "line" for our
 *     purposes — paragraph, heading, bullet, todo, etc. Block text can
 *     include `\n` but typically doesn't.
 *
 * The editor view's dispatcher branches on kind to handle reads and writes
 * appropriately, but exposes the same verbs (get_lines, replace_lines, etc.)
 * so the agent uses one mental model regardless of page.
 */
type TextareaEditorHandle = {
    kind: "textarea";
    element: HTMLElement & { value: string; readOnly?: boolean };
    textarea: HTMLTextAreaElement | null;
};
type BlockEditorBlock = { id: string; type: string; text: string };
type BlockEditorBackend = {
    kind: "blocks";
    getBlocks: () => BlockEditorBlock[];
    applyBlocks: (next: BlockEditorBlock[]) => void;
    setBlockText: (id: string, text: string) => boolean;
    blockElement: (id: string) => HTMLElement | null;
    editorContainer: () => HTMLElement;
    newBlock: (type: string, text: string) => BlockEditorBlock;
};
type BlockEditorHandle = {
    kind: "blocks";
    host: HTMLElement;
    backend: BlockEditorBackend;
};
type EditorHandle = TextareaEditorHandle | BlockEditorHandle;

/**
 * Find the markdown editor the agent should target. Priority:
 *   1. Element ancestor of document.activeElement that is a moltbot
 *      markdown editor, a tagged <textarea data-mb-editor>, or a .bk-host
 *      (user is currently typing in it).
 *   2. First visible <moltbot-markdown-editor> on the page.
 *   3. First visible <moltbot-block-editor>.
 *   4. First visible <textarea data-mb-editor> (notes raw editor, etc.).
 *   5. First visible .bk-host (project content block editor).
 * Returns null if none are mounted.
 */
function findActiveEditor(): EditorHandle | null {
    if (typeof document === "undefined") return null;
    const isVisible = (el: HTMLElement) => el.offsetParent !== null || el === document.body;
    // (1) Walk up from the focused element to see if we're inside an editor.
    let cur: Element | null = document.activeElement;
    while (cur) {
        const el = cur as HTMLElement;
        const tag = el.tagName?.toLowerCase();
        if (tag === "moltbot-markdown-editor" || tag === "moltbot-block-editor") {
            return makeTextareaHandle(el);
        }
        if (tag === "textarea" && el.hasAttribute("data-mb-editor")) {
            return makeBareTextareaHandle(el as HTMLTextAreaElement);
        }
        if (el.classList?.contains?.("bk-host")) {
            const h = tryBlockHandle(el);
            if (h) return h;
        }
        cur = el.parentElement
            ?? ((cur as Element).getRootNode() as ShadowRoot | Document | null && "host" in (cur as Element).getRootNode()
                ? ((cur as Element).getRootNode() as ShadowRoot).host
                : null);
    }
    // (2) First visible markdown-editor.
    const mdEditors = Array.from(document.querySelectorAll("moltbot-markdown-editor")) as HTMLElement[];
    for (const el of mdEditors) {
        if (isVisible(el)) return makeTextareaHandle(el);
    }
    // (3) First visible block-editor.
    const blockEditors = Array.from(document.querySelectorAll("moltbot-block-editor")) as HTMLElement[];
    for (const el of blockEditors) {
        if (isVisible(el)) return makeTextareaHandle(el);
    }
    // (4) Plain textareas opted into the editor surface via data-mb-editor.
    // Views like notes use a vanilla <textarea> for raw markdown editing;
    // marking it with the attribute lets the editor view bind to it without
    // forcing every editing UI to adopt the moltbot-markdown-editor element.
    const bareTextareas = Array.from(document.querySelectorAll("textarea[data-mb-editor]")) as HTMLTextAreaElement[];
    for (const el of bareTextareas) {
        if (isVisible(el)) return makeBareTextareaHandle(el);
    }
    // (5) First visible project block editor (Notion-style).
    const bkHosts = Array.from(document.querySelectorAll(".bk-host")) as HTMLElement[];
    for (const el of bkHosts) {
        if (!isVisible(el)) continue;
        const h = tryBlockHandle(el);
        if (h) return h;
    }
    return null;
}

function makeTextareaHandle(el: HTMLElement): TextareaEditorHandle {
    const textarea =
        (el.shadowRoot?.querySelector("textarea") as HTMLTextAreaElement | null) ?? null;
    return {
        kind: "textarea",
        element: el as TextareaEditorHandle["element"],
        textarea,
    };
}

function makeBareTextareaHandle(ta: HTMLTextAreaElement): TextareaEditorHandle {
    return {
        kind: "textarea",
        element: ta as unknown as TextareaEditorHandle["element"],
        textarea: ta,
    };
}

function tryBlockHandle(host: HTMLElement): BlockEditorHandle | null {
    const backend = (host as unknown as { __blockEditor?: BlockEditorBackend }).__blockEditor;
    if (!backend || backend.kind !== "blocks") return null;
    return { kind: "blocks", host, backend };
}

const HIGHLIGHT_OVERLAY_ID = "infinibot-editor-highlight";
type HighlightState = {
    start: number;
    end: number;
    color: string;
    editorTag: string;
};
let lastHighlight: HighlightState | null = null;
let highlightRepositionAttached = false;

function getCurrentHighlight(): HighlightState | null {
    return lastHighlight;
}

/**
 * Paint a colored band over the textarea covering lines [start..end]. The
 * overlay is a position:fixed div anchored by the textarea's current
 * client rect — repositions on scroll/resize so it tracks the editor.
 *
 * The textarea is inside the editor element's shadow DOM, so the overlay
 * has to live in the LIGHT DOM (under document.body) to be on top of
 * everything. We use getBoundingClientRect() to compute coordinates and
 * line-height from computed style.
 */
function paintEditorHighlight(ed: EditorHandle, start: number, end: number, color: string): void {
    if (typeof document === "undefined") return;
    let overlay = document.getElementById(HIGHLIGHT_OVERLAY_ID) as HTMLDivElement | null;
    if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = HIGHLIGHT_OVERLAY_ID;
        overlay.setAttribute("aria-hidden", "true");
        overlay.style.position = "fixed";
        overlay.style.pointerEvents = "none";
        overlay.style.zIndex = "9999";
        overlay.style.transition = "top 120ms ease, height 120ms ease, opacity 120ms ease";
        overlay.style.borderLeft = "3px solid rgba(255, 200, 40, 0.95)";
        overlay.style.boxShadow = "0 0 0 1px rgba(255,200,40,0.4)";
        document.body.appendChild(overlay);
    }
    const reposition = () => {
        if (!overlay) return;
        let rect: DOMRect;
        let top: number;
        let bottom: number;
        let left: number;
        let width: number;
        if (ed.kind === "textarea") {
            const ta = ed.textarea;
            if (!ta) { overlay.style.display = "none"; return; }
            rect = ta.getBoundingClientRect();
            const style = window.getComputedStyle(ta);
            const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4 || 18;
            const padTop = parseFloat(style.paddingTop) || 0;
            const scrollTop = ta.scrollTop;
            const yStart = (start - 1) * lineHeight + padTop - scrollTop;
            const yEnd = end * lineHeight + padTop - scrollTop;
            top = Math.max(rect.top, rect.top + yStart);
            bottom = Math.min(rect.bottom, rect.top + yEnd);
            left = rect.left;
            width = rect.width;
        } else {
            // Block editor: line N maps to the Nth block element. Highlight
            // spans from the start block's top to the end block's bottom.
            const blocks = ed.backend.getBlocks();
            const startId = blocks[start - 1]?.id;
            const endId = blocks[Math.min(blocks.length - 1, end - 1)]?.id;
            if (!startId) { overlay.style.display = "none"; return; }
            const startEl = ed.backend.blockElement(startId);
            const endEl = endId ? ed.backend.blockElement(endId) ?? startEl : startEl;
            if (!startEl || !endEl) { overlay.style.display = "none"; return; }
            const startRect = startEl.getBoundingClientRect();
            const endRect = endEl.getBoundingClientRect();
            const hostRect = ed.host.getBoundingClientRect();
            rect = hostRect;
            top = startRect.top;
            bottom = endRect.bottom;
            left = hostRect.left;
            width = hostRect.width;
            if (bottom <= hostRect.top || top >= hostRect.bottom) {
                overlay.style.display = "none";
                return;
            }
            // Clamp to host bounds so the overlay doesn't spill outside the
            // visible scroll container.
            top = Math.max(hostRect.top, top);
            bottom = Math.min(hostRect.bottom, bottom);
        }
        if (bottom <= rect.top || top >= rect.bottom) {
            overlay.style.display = "none";
            return;
        }
        overlay.style.display = "block";
        overlay.style.left = `${left}px`;
        overlay.style.width = `${width}px`;
        overlay.style.top = `${top}px`;
        overlay.style.height = `${Math.max(2, bottom - top)}px`;
        overlay.style.background = color;
    };
    reposition();
    if (!highlightRepositionAttached) {
        // One-time listeners — overlay survives until clearEditorHighlight().
        const repaint = () => {
            const cur = document.getElementById(HIGHLIGHT_OVERLAY_ID);
            if (!cur) return;
            const live = findActiveEditor();
            if (live && lastHighlight) paintEditorHighlight(live, lastHighlight.start, lastHighlight.end, lastHighlight.color);
        };
        window.addEventListener("scroll", repaint, { passive: true, capture: true });
        window.addEventListener("resize", repaint);
        // Textarea scroll repaint is wired below the first time we see one.
        if (ed.kind === "textarea" && ed.textarea) {
            ed.textarea.addEventListener("scroll", repaint, { passive: true });
        }
        highlightRepositionAttached = true;
    }
    lastHighlight = {
        start, end, color,
        editorTag: ed.kind === "textarea" ? ed.element.tagName.toLowerCase() : ed.host.tagName.toLowerCase(),
    };
}

function clearEditorHighlight(): void {
    const overlay = document.getElementById(HIGHLIGHT_OVERLAY_ID);
    if (overlay) overlay.remove();
    lastHighlight = null;
}

/**
 * Scroll the editor so a given 1-based line is visible. Works on the
 * textarea (sets scrollTop based on line height) and, when the editor is
 * in preview mode (no textarea), scrolls the element itself into view.
 */
function scrollEditorToLine(ed: EditorHandle, line: number, behavior: ScrollBehavior = "smooth"): void {
    if (ed.kind === "textarea") {
        const ta = ed.textarea;
        if (ta) {
            const style = window.getComputedStyle(ta);
            const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4 || 18;
            const target = Math.max(0, (line - 1) * lineHeight - ta.clientHeight * 0.3);
            ta.scrollTo({ top: target, behavior });
            return;
        }
        // Preview mode (no textarea) — fall back to scrolling the editor
        // element itself into view.
        ed.element.scrollIntoView({ behavior, block: "center" });
        return;
    }
    // Block editor: scroll the Nth block element into view.
    const blocks = ed.backend.getBlocks();
    const target = blocks[Math.max(0, Math.min(blocks.length - 1, line - 1))];
    if (!target) return;
    const el = ed.backend.blockElement(target.id);
    if (el) el.scrollIntoView({ behavior, block: "center" });
    else ed.host.scrollIntoView({ behavior, block: "center" });
}

/**
 * Compute a short, mostly-stable CSS path for an element so the agent can
 * follow up with click_selector / scroll_to_element. Uses id when present,
 * otherwise tag + nth-of-type up to body.
 */
function cssPath(el: Element): string {
    if (!el) return "";
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur.nodeType === Node.ELEMENT_NODE && cur !== document.body) {
        const curEl: Element = cur;
        let part = curEl.tagName.toLowerCase();
        const parentEl: Element | null = curEl.parentElement;
        if (parentEl) {
            const sibs: Element[] = Array.from(parentEl.children).filter(
                (s: Element) => s.tagName === curEl.tagName,
            );
            if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(curEl) + 1})`;
        }
        parts.unshift(part);
        cur = parentEl;
        if (parts.length > 5) break;
    }
    return "body > " + parts.join(" > ");
}

/* ─── lazy loaders ───────────────────────────────────────────────────────
 * The agent often lands on a view via switch_tab and immediately asks for
 * data ("find the X project"). If the view's controller hasn't fetched
 * yet, the in-memory list is empty and find/match returns nothing — the
 * agent reads that as "the UI dropped" and gives up. These helpers ensure
 * the underlying state is loaded before we operate on it. We also accept
 * an explicit `force` to refresh after writes.
 */
async function ensureKanbanLoaded(
    host: AppViewState,
    opts?: { force?: boolean; projectsOnly?: boolean },
): Promise<void> {
    const need = opts?.force || (host.kanbanProjects?.length ?? 0) === 0;
    if (!need) return;
    if (host.kanbanLoading) return;
    // Default to the cheap projects-only load — the heavy paths (refresh,
    // get_project_tasks) explicitly pass projectsOnly:false. Most callers
    // (find_project / open_project_by_name / select_project) only need the
    // project list, so we save the 15-30s tasks fetch on first dispatch.
    if (opts?.projectsOnly !== false && host.client) {
        try {
            const projects = await host.client.request<unknown>("kanban.projects.list");
            host.kanbanProjects = (Array.isArray(projects) ? projects : []) as typeof host.kanbanProjects;
            (host as unknown as { requestUpdate?: () => void }).requestUpdate?.();
            return;
        } catch { /* fall through to full load */ }
    }
    const fn = (kanbanCtrl as { loadKanban?: (s: unknown) => Promise<unknown> }).loadKanban;
    if (typeof fn === "function") await fn(host);
}
async function ensureDatabasesLoaded(
    host: AppViewState,
    client: ReturnType<typeof reqClient>,
    opts?: { force?: boolean },
): Promise<void> {
    const s = dbCtrl.getDatabasesState(host);
    const need = opts?.force || s.databases.length === 0;
    if (!need) return;
    if (s.loading) return;
    await dbCtrl.loadDatabases(host, client);
}

/* ─── file_viewer helpers ────────────────────────────────────────────────
 * The kanban project attachment modal (.kb-preview-modal) renders:
 *   - PDFs into .kb-preview-pdf-host (canvas-per-page via pdf.js, same-origin
 *     — agent can scroll the body AND jump to specific pages via
 *     .kb-pdf-page[data-page=N])
 *   - markdown/text/image into other shapes inside .kb-preview-body
 *   - (legacy) PDF via cross-origin iframe.kb-preview-pdf — kept as fallback
 *
 * Pure DOM queries — no kanban.ts imports.
 */
type FilePreviewKindUI = "markdown" | "pdf" | "image" | "text" | "unknown";
interface FilePreviewElements {
    modal: Element;
    body: HTMLElement | null;
    titleEl: HTMLElement | null;
    iframe: HTMLIFrameElement | null;
    pdfHost: HTMLElement | null;
    pdfPages: HTMLCanvasElement[];
    img: HTMLImageElement | null;
    closeBtn: HTMLButtonElement | null;
    kind: FilePreviewKindUI;
}
function getFilePreviewElements(): FilePreviewElements | null {
    if (typeof document === "undefined") return null;
    const modal = document.querySelector(".kb-preview-modal");
    if (!modal) return null;
    const body = modal.querySelector(".kb-preview-body") as HTMLElement | null;
    const titleEl = modal.querySelector(".kb-preview-title") as HTMLElement | null;
    const iframe = modal.querySelector("iframe.kb-preview-pdf") as HTMLIFrameElement | null;
    const pdfHost = modal.querySelector(".kb-preview-pdf-host") as HTMLElement | null;
    const pdfPages = Array.from(modal.querySelectorAll("canvas.kb-pdf-page")) as HTMLCanvasElement[];
    const img = modal.querySelector("img.kb-preview-image") as HTMLImageElement | null;
    const closeBtn = modal.querySelector('.kb-preview-actions button[title^="Close"]') as HTMLButtonElement | null;
    let kind: FilePreviewKindUI = "unknown";
    if (body) {
        for (const k of ["pdf", "markdown", "image", "text"] as const) {
            if (body.classList.contains(`kb-preview-body-${k}`)) { kind = k; break; }
        }
    }
    return { modal, body, titleEl, iframe, pdfHost, pdfPages, img, closeBtn, kind };
}
function getCurrentPdfPage(body: HTMLElement, pages: HTMLCanvasElement[]): number {
    if (!pages.length) return 1;
    const bodyRect = body.getBoundingClientRect();
    const probeY = bodyRect.top + bodyRect.height * 0.25;
    let best = 1;
    let bestDist = Infinity;
    for (const c of pages) {
        const r = c.getBoundingClientRect();
        // page is "current" if its top is closest to (but at/above) the probe line
        const dist = Math.abs(r.top - probeY);
        if (dist < bestDist) { bestDist = dist; best = Number(c.dataset.page ?? "0") || best; }
    }
    return best;
}
function readPdfViewerHash(iframe: HTMLIFrameElement): { base: string; params: URLSearchParams; page: number; zoom: string | null } {
    const src = iframe.src || "";
    const hashIdx = src.indexOf("#");
    const base = hashIdx < 0 ? src : src.slice(0, hashIdx);
    let hashStr = hashIdx < 0 ? "" : src.slice(hashIdx + 1);
    // Prefer the live location if accessible (blob: URLs inherit parent origin)
    try {
        const winHash = iframe.contentWindow?.location.hash;
        if (winHash) hashStr = winHash.replace(/^#/, "");
    } catch { /* not accessible — keep src-derived */ }
    const params = new URLSearchParams(hashStr);
    const page = Number(params.get("page") ?? "1") || 1;
    const zoom = params.get("zoom");
    return { base, params, page, zoom };
}
function applyPdfViewerHash(iframe: HTMLIFrameElement, base: string, params: URLSearchParams): void {
    const hash = "#" + params.toString();
    // contentWindow.location.hash navigates in-place without reload —
    // Chrome's native PDF viewer reacts to hashchange.
    try {
        const win = iframe.contentWindow;
        if (win) {
            win.location.hash = hash;
            return;
        }
    } catch { /* fall back to full src swap (causes reload) */ }
    iframe.src = base + hash;
}

export function registerAppViewControllers(host: AppViewState): void {
    unregisterAppViewControllers();

    /* ─── nav: global tab + sidebar ───────────────────────────────── */
    registered.push(attachViewController({
        viewName: "nav",
        description:
            "Global navigation: which top-level tab is active, sidebar/panel state, theme. Use switch_tab to take the user to a page. The agent should consult availableTabs in get_state (id, title, subtitle, group, synonyms) before guessing tab names.",
        getState: () => {
            const current = tabCatalog().find((t) => t.id === host.tab);
            return {
                tab: host.tab,
                // Merged host pages: which sub-tab is showing, and whose content.
                subView: host.hostView?.[host.tab] ?? null,
                contentTab: contentTabOf(host),
                currentTab: current
                    ? { id: current.id, title: current.title, subtitle: current.subtitle, group: current.group }
                    : { id: host.tab, title: host.tab, subtitle: "", group: "" },
                availableTabs: tabCatalog(),
                theme: host.theme,
                themeResolved: host.themeResolved,
                sidebarOpen: host.sidebarOpen,
                threadsSidebarOpen: host.threadsSidebarOpen,
                assistantName: host.assistantName,
                connected: host.connected,
                activityPanelOpen: host.activityPanelOpen,
            };
        },
        describeActions: () => [
            {
                type: "switch_tab",
                args: {
                    tab: `Tab id, title, or synonym. Resolved against availableTabs (get_state). Canonical ids: ${tabCatalog().map((t) => t.id).join(", ")}`,
                },
                doc: "Navigate to a top-level tab. Accepts loose strings (e.g. \"clients\", \"Clients\", \"client's page\", \"crm\" all map to the Clients tab). Returns the resolved tab id; on miss returns ok=false with the full catalog so you can pick again.",
            },
            {
                type: "open_page",
                args: {
                    target: "Loose intent. Tab id/title/synonym, OR a project name (\"open the InfiniBot project\"), OR a system role (\"clients\", \"leads\", \"projects\", \"notes\", \"tasks\"). One call switches the tab AND triggers the right within-view action.",
                    query: "Optional. Refines target — e.g. target='clients' + query='top 10 by MRR' will switch to clients view and load that database; target='kanban' + query='InfiniBot redesign' will switch to projects and open that project.",
                },
                doc: "Preferred entry point for natural-language navigation. Use this instead of switch_tab when the user says \"open my X\" — it figures out the right tab AND brings up the actual data (system-role db for clients/leads/notes/tasks/projects, named project for kanban, etc.) in one round-trip.",
            },
            { type: "toggle_threads_sidebar", doc: "Show/hide the chat threads sidebar." },
            { type: "toggle_voice_panel", doc: "Show/hide the voice panel." },
            { type: "toggle_activity_panel", doc: "Show/hide the activity panel." },
            { type: "set_theme", args: { theme: "'system' | 'light' | 'dark'" }, doc: "Change theme." },
        ],
        dispatch: async (action) => {
            const a = action as Record<string, unknown>;
            // Tabs whose backing view stores its data lazily — when the
            // agent switches in, we kick off the load so subsequent find_*
            // / query_rows calls see real data instead of an empty list
            // (which previously read as "the UI dropped" in the agent's
            // narration).
            const KANBAN_TABS = new Set<Tab>(["projects"]);
            const DATABASE_TABS = new Set<Tab>(["databases", "clients", "leads", "qualifier"]);
            const warmTab = async (tab: Tab) => {
                if (KANBAN_TABS.has(tab)) await ensureKanbanLoaded(host);
                if (DATABASE_TABS.has(tab) && host.client) {
                    await ensureDatabasesLoaded(host, host.client);
                }
            };
            // System roles that map to a databases-backed tab. open_page
            // uses this when the user says "open my clients" — switch to
            // the clients tab and bring up the role-bound database.
            const ROLE_TO_TAB: Partial<Record<dbCtrl.SystemRole, Tab>> = {
                clients: "clients",
                leads: "leads",
                projects: "projects",
                tasks: "projects",
                notes: "notes",
            };
            switch (a.type) {
                case "switch_tab": {
                    const raw = (a.tab as string | undefined) ?? "";
                    if (!raw) return { ok: false, error: "tab required", availableTabs: tabCatalog() };
                    const resolved = resolveTab(raw);
                    if (!resolved) {
                        return {
                            ok: false,
                            error: `unknown tab "${raw}". See availableTabs for the canonical list (id, title, synonyms).`,
                            availableTabs: tabCatalog(),
                        };
                    }
                    host.setTab(resolved.id);
                    await warmTab(resolved.id);
                    return {
                        ok: true,
                        result: {
                            tab: resolved.id,
                            title: resolved.title,
                            subtitle: resolved.subtitle,
                            group: resolved.group,
                            matchedFrom: raw === resolved.id ? undefined : raw,
                        },
                    };
                }
                case "open_page": {
                    const target = ((a.target as string | undefined) ?? "").trim();
                    const query = ((a.query as string | undefined) ?? "").trim();
                    if (!target && !query) {
                        return { ok: false, error: "target or query required" };
                    }
                    const steps: Array<Record<string, unknown>> = [];
                    // 1. Resolve target as a system role first ("clients",
                    //    "leads", etc.) so "open my clients" → clients tab
                    //    + the role-bound CRM, even if the role string also
                    //    happens to match a tab id.
                    const roleKey = target.toLowerCase() as dbCtrl.SystemRole;
                    if (roleKey && (dbCtrl.SYSTEM_ROLES as readonly string[]).includes(roleKey)) {
                        const tab = ROLE_TO_TAB[roleKey] ?? "databases";
                        host.setTab(tab);
                        if (host.client) await ensureDatabasesLoaded(host, host.client);
                        const roleResult = await UIControlBus.dispatchTo("databases", {
                            type: "open_by_role",
                            role: roleKey,
                        } as never);
                        steps.push({ step: "switch_tab", tab }, { step: "open_by_role", role: roleKey, result: roleResult });
                        return { ok: roleResult.ok, result: { steps, ...(roleResult.result as Record<string, unknown> | undefined) }, error: roleResult.error };
                    }
                    // 2. Tab resolution. If query is non-empty and the tab
                    //    backs a list (kanban / databases), chain into the
                    //    appropriate open_*_by_name action.
                    const tabHit = resolveTab(target || query);
                    if (tabHit) {
                        host.setTab(tabHit.id);
                        await warmTab(tabHit.id);
                        steps.push({ step: "switch_tab", tab: tabHit.id });
                        if (query) {
                            if (KANBAN_TABS.has(tabHit.id)) {
                                const projResult = await UIControlBus.dispatchTo("kanban", {
                                    type: "open_project_by_name",
                                    query,
                                } as never);
                                steps.push({ step: "open_project_by_name", query, result: projResult });
                                return { ok: projResult.ok, result: { steps, ...(projResult.result as Record<string, unknown> | undefined) }, error: projResult.error };
                            }
                            if (DATABASE_TABS.has(tabHit.id) || tabHit.id === "databases") {
                                const dbResult = await UIControlBus.dispatchTo("databases", {
                                    type: "open_database_by_name",
                                    query,
                                } as never);
                                steps.push({ step: "open_database_by_name", query, result: dbResult });
                                return { ok: dbResult.ok, result: { steps, ...(dbResult.result as Record<string, unknown> | undefined) }, error: dbResult.error };
                            }
                        }
                        return {
                            ok: true,
                            result: { steps, tab: tabHit.id, title: tabHit.title, subtitle: tabHit.subtitle, group: tabHit.group },
                        };
                    }
                    // 3. Fall back to project / database name lookups
                    //    without a tab hint — let those views answer.
                    if (target) {
                        await ensureKanbanLoaded(host);
                        const projMatches = matchByName(
                            target,
                            (host.kanbanProjects ?? []).map((p) => ({ id: p.id, name: p.name })),
                        );
                        if (projMatches.length > 0 && projMatches[0]!.score >= (target.length || 1)) {
                            host.setTab("projects");
                            const projResult = await UIControlBus.dispatchTo("kanban", {
                                type: "open_project_by_name",
                                query: target,
                            } as never);
                            steps.push({ step: "switch_tab", tab: "projects" }, { step: "open_project_by_name", query: target, result: projResult });
                            return { ok: projResult.ok, result: { steps, ...(projResult.result as Record<string, unknown> | undefined) }, error: projResult.error };
                        }
                        if (host.client) {
                            await ensureDatabasesLoaded(host, host.client);
                            const dbs = dbCtrl.getDatabasesState(host).databases;
                            const dbMatches = matchByName(target, dbs.map((d) => ({ id: d.id, name: d.name })));
                            if (dbMatches.length > 0) {
                                host.setTab("databases");
                                const dbResult = await UIControlBus.dispatchTo("databases", {
                                    type: "open_database_by_name",
                                    query: target,
                                } as never);
                                steps.push({ step: "switch_tab", tab: "databases" }, { step: "open_database_by_name", query: target, result: dbResult });
                                return { ok: dbResult.ok, result: { steps, ...(dbResult.result as Record<string, unknown> | undefined) }, error: dbResult.error };
                            }
                        }
                    }
                    return {
                        ok: false,
                        error: `couldn't resolve target="${target}" query="${query}" to a tab, system role, project, or database.`,
                        availableTabs: tabCatalog().map((t) => t.id),
                        availableRoles: dbCtrl.SYSTEM_ROLES,
                    };
                }
                case "toggle_threads_sidebar":
                    host.threadsSidebarOpen = !host.threadsSidebarOpen;
                    (host as unknown as { requestUpdate?: () => void }).requestUpdate?.();
                    return { ok: true, result: { open: host.threadsSidebarOpen } };
                case "toggle_voice_panel": {
                    // Voice runs on Robovoice: the legacy action opens the
                    // Voice page (Robovoice console, or Connect Robovoice
                    // when this install isn't linked).
                    (host as unknown as { setTab?: (t: string) => void }).setTab?.("voice");
                    (host as unknown as { requestUpdate?: () => void }).requestUpdate?.();
                    return { ok: true, result: { open: true, panel: "voice", provider: "robovoice" } };
                }
                case "toggle_activity_panel":
                    host.activityPanelOpen = !host.activityPanelOpen;
                    (host as unknown as { requestUpdate?: () => void }).requestUpdate?.();
                    return { ok: true, result: { open: host.activityPanelOpen } };
                case "set_theme": {
                    const theme = a.theme as "system" | "light" | "dark" | undefined;
                    if (!theme) return { ok: false, error: "theme required" };
                    host.theme = theme;
                    (host as unknown as { requestUpdate?: () => void }).requestUpdate?.();
                    return { ok: true, result: { theme } };
                }
            }
            return { ok: false, error: `unknown action: ${a.type}` };
        },
    }));

    /* ─── page (viewport / scroll / find-text) ──────────────────────── */
    registered.push(attachViewController({
        viewName: "page",
        description:
            "Generic viewport control for whichever tab/page is currently active. Use this for 'scroll down', 'scroll to the X section', 'find Y in this page', 'click the Z button'. Scrolling falls through to the largest visible internal scroll container when the document body itself doesn't overflow (notes, kanban, databases all flex inside a non-scrolling shell).",
        getState: () => {
            if (typeof window === "undefined" || typeof document === "undefined") {
                return { ready: false };
            }
            const doc = document.documentElement;
            const body = document.body;
            const target = pickScrollTarget();
            return {
                ready: true,
                tab: host.tab,
                scrollY: window.scrollY,
                scrollX: window.scrollX,
                viewportHeight: window.innerHeight,
                viewportWidth: window.innerWidth,
                documentHeight: Math.max(doc?.scrollHeight ?? 0, body?.scrollHeight ?? 0),
                documentWidth: Math.max(doc?.scrollWidth ?? 0, body?.scrollWidth ?? 0),
                atTop: window.scrollY <= 2,
                atBottom:
                    window.scrollY + window.innerHeight >=
                    Math.max(doc?.scrollHeight ?? 0, body?.scrollHeight ?? 0) - 2,
                scrollTarget: target.kind === "window"
                    ? { kind: "window" }
                    : {
                        kind: "element",
                        tag: target.element.tagName.toLowerCase(),
                        className: target.element.className || undefined,
                        scrollTop: target.element.scrollTop,
                        scrollHeight: target.element.scrollHeight,
                        clientHeight: target.element.clientHeight,
                    },
                activeElement: (() => {
                    const el = document.activeElement as HTMLElement | null;
                    if (!el || el === document.body) return null;
                    return {
                        tag: el.tagName.toLowerCase(),
                        id: el.id || undefined,
                        text: el.innerText?.slice(0, 80),
                    };
                })(),
            };
        },
        describeActions: () => [
            { type: "scroll_to_top", doc: "Scroll the page to the very top." },
            { type: "scroll_to_bottom", doc: "Scroll the page to the very bottom." },
            { type: "scroll_by", args: { y: "number (pixels, positive = down)", x: "number? default 0", smooth: "boolean? default true" }, doc: "Scroll relatively by `y` pixels (and optionally `x`). Use a viewport-height fraction for page-by-page nav, e.g. y = window.innerHeight * 0.9." },
            { type: "scroll_page", args: { direction: "'up'|'down'|'half_up'|'half_down'", smooth: "boolean? default true" }, doc: "Page-up/down equivalent. 'half_*' moves by half a viewport (good for voice 'scroll down a bit')." },
            { type: "scroll_to_element", args: { selector: "string CSS selector", behavior: "'smooth'|'instant'? default 'smooth'", block: "'start'|'center'|'end'|'nearest'? default 'start'" }, doc: "Scroll a specific element into view by CSS selector. Returns ok=false if the selector matches nothing." },
            { type: "scroll_to_text", args: { query: "string", caseSensitive: "boolean? default false", behavior: "'smooth'|'instant'? default 'smooth'" }, doc: "Find the first visible occurrence of `query` in the page and scroll it into view. Best for voice: \"scroll to the FastAPI section\"." },
            { type: "find_text", args: { query: "string", caseSensitive: "boolean? default false", limit: "number? default 10" }, doc: "Find occurrences of `query` in the page without scrolling. Returns matches with surrounding text snippets and CSS selectors when stable." },
            { type: "click_text", args: { query: "string", role: "string? CSS-narrow ('button'|'link'|...)" }, doc: "Click the first element whose visible text contains `query`. Optional `role` narrows to <button>, <a>, etc. Returns ok=false on miss; agent can fall back to scroll_to_text + manual click." },
            { type: "click_selector", args: { selector: "string CSS selector" }, doc: "Click an element by CSS selector. Use when you know the selector (e.g. from get_state of another view); use click_text otherwise." },
            { type: "focus_selector", args: { selector: "string CSS selector" }, doc: "Move keyboard focus to an element (e.g. an input field) before typing into it." },
            { type: "type_into", args: { selector: "string CSS selector", text: "string", clear: "boolean? default false" }, doc: "Type text into the focused element (or a selector). Sets .value AND dispatches input/change events so Lit / React state updates correctly." },
        ],
        dispatch: async (action) => {
            const a = action as Record<string, unknown>;
            if (typeof window === "undefined" || typeof document === "undefined") {
                return { ok: false, error: "no window/document — not in a browser context" };
            }
            const smoothFlag = (val: unknown) =>
                (val === undefined || val === true || val === "smooth") ? "smooth" : "auto";
            const scrollTargetTo = (top: number, behavior: ScrollBehavior) => {
                const t = pickScrollTarget();
                if (t.kind === "window") window.scrollTo({ top, behavior });
                else t.element.scrollTo({ top, behavior });
                return t;
            };
            const scrollTargetBy = (top: number, left: number, behavior: ScrollBehavior) => {
                const t = pickScrollTarget();
                if (t.kind === "window") window.scrollBy({ top, left, behavior });
                else t.element.scrollBy({ top, left, behavior });
                return t;
            };
            const describeTarget = (t: ScrollTarget) =>
                t.kind === "window" ? "window" : `${t.element.tagName.toLowerCase()}.${t.element.className || ""}`.slice(0, 80);
            switch (a.type) {
                case "scroll_to_top": {
                    const t = scrollTargetTo(0, "smooth");
                    return { ok: true, result: { scrollY: 0, target: describeTarget(t) } };
                }
                case "scroll_to_bottom": {
                    const t = pickScrollTarget();
                    const h = t.kind === "window"
                        ? Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)
                        : t.element.scrollHeight;
                    if (t.kind === "window") window.scrollTo({ top: h, behavior: "smooth" });
                    else t.element.scrollTo({ top: h, behavior: "smooth" });
                    return { ok: true, result: { scrollY: h, target: describeTarget(t) } };
                }
                case "scroll_by": {
                    const y = Number(a.y ?? 0) || 0;
                    const x = Number(a.x ?? 0) || 0;
                    const t = scrollTargetBy(y, x, smoothFlag(a.smooth));
                    return { ok: true, result: { deltaY: y, deltaX: x, target: describeTarget(t) } };
                }
                case "scroll_page": {
                    const dir = (a.direction as string) ?? "down";
                    const t = pickScrollTarget();
                    const vh = t.kind === "window" ? window.innerHeight : t.element.clientHeight;
                    const step =
                        dir === "up" ? -vh * 0.9 :
                        dir === "down" ? vh * 0.9 :
                        dir === "half_up" ? -vh * 0.5 :
                        dir === "half_down" ? vh * 0.5 :
                        0;
                    if (!step) return { ok: false, error: `unknown direction "${dir}". Use up|down|half_up|half_down.` };
                    if (t.kind === "window") window.scrollBy({ top: step, behavior: smoothFlag(a.smooth) });
                    else t.element.scrollBy({ top: step, behavior: smoothFlag(a.smooth) });
                    return { ok: true, result: { deltaY: step, target: describeTarget(t) } };
                }
                case "scroll_to_element": {
                    const selector = a.selector as string | undefined;
                    if (!selector) return { ok: false, error: "selector required" };
                    let el: Element | null = null;
                    try { el = document.querySelector(selector); } catch (e) {
                        return { ok: false, error: `invalid selector: ${(e as Error).message}` };
                    }
                    if (!el) return { ok: false, error: `no element matches "${selector}"` };
                    el.scrollIntoView({
                        behavior: (a.behavior === "instant" ? "instant" : "smooth") as ScrollBehavior,
                        block: (a.block as ScrollLogicalPosition | undefined) ?? "start",
                    });
                    return { ok: true, result: { tag: el.tagName.toLowerCase(), text: (el as HTMLElement).innerText?.slice(0, 80) } };
                }
                case "scroll_to_text": {
                    const query = ((a.query as string | undefined) ?? "").trim();
                    if (!query) return { ok: false, error: "query required" };
                    const caseSensitive = a.caseSensitive === true;
                    const hit = findFirstTextNode(query, caseSensitive);
                    if (!hit) return { ok: false, error: `no visible text matches "${query}"` };
                    hit.element.scrollIntoView({
                        behavior: (a.behavior === "instant" ? "instant" : "smooth") as ScrollBehavior,
                        block: "center",
                    });
                    return { ok: true, result: { snippet: hit.snippet, tag: hit.element.tagName.toLowerCase() } };
                }
                case "find_text": {
                    const query = ((a.query as string | undefined) ?? "").trim();
                    if (!query) return { ok: false, error: "query required" };
                    const caseSensitive = a.caseSensitive === true;
                    const limit = Math.max(1, Math.min(50, (a.limit as number | undefined) ?? 10));
                    const matches = findAllTextNodes(query, caseSensitive, limit);
                    return {
                        ok: true,
                        result: {
                            query,
                            count: matches.length,
                            matches: matches.map((m) => ({
                                snippet: m.snippet,
                                tag: m.element.tagName.toLowerCase(),
                                id: m.element.id || undefined,
                                selector: cssPath(m.element),
                            })),
                        },
                    };
                }
                case "click_text": {
                    const query = ((a.query as string | undefined) ?? "").trim();
                    if (!query) return { ok: false, error: "query required" };
                    const roleFilter = a.role as string | undefined;
                    const hit = findFirstClickableByText(query, roleFilter);
                    if (!hit) return { ok: false, error: `no clickable element with text matching "${query}"` };
                    hit.click();
                    return { ok: true, result: { tag: hit.tagName.toLowerCase(), text: (hit as HTMLElement).innerText?.slice(0, 80) } };
                }
                case "click_selector": {
                    const selector = a.selector as string | undefined;
                    if (!selector) return { ok: false, error: "selector required" };
                    let el: HTMLElement | null = null;
                    try { el = document.querySelector(selector) as HTMLElement | null; } catch (e) {
                        return { ok: false, error: `invalid selector: ${(e as Error).message}` };
                    }
                    if (!el) return { ok: false, error: `no element matches "${selector}"` };
                    el.click();
                    return { ok: true, result: { tag: el.tagName.toLowerCase() } };
                }
                case "focus_selector": {
                    const selector = a.selector as string | undefined;
                    if (!selector) return { ok: false, error: "selector required" };
                    const el = document.querySelector(selector) as HTMLElement | null;
                    if (!el) return { ok: false, error: `no element matches "${selector}"` };
                    el.focus();
                    return { ok: true };
                }
                case "type_into": {
                    const selector = a.selector as string | undefined;
                    const text = (a.text as string | undefined) ?? "";
                    const target = (selector
                        ? document.querySelector(selector)
                        : document.activeElement) as (HTMLInputElement | HTMLTextAreaElement | null);
                    if (!target) return { ok: false, error: "no target — pass selector or focus an input first" };
                    if (a.clear) target.value = "";
                    target.value = (target.value ?? "") + text;
                    target.dispatchEvent(new Event("input", { bubbles: true }));
                    target.dispatchEvent(new Event("change", { bubbles: true }));
                    return { ok: true, result: { value: target.value } };
                }
            }
            return { ok: false, error: `unknown action: ${a.type}` };
        },
    }));

    /* ─── editor (line-level markdown read/edit + AI highlight) ────── */
    registered.push(attachViewController({
        viewName: "editor",
        description:
            "Operate on whichever markdown editor is currently active (notes body, workflow body, project description, db row body — anything rendered via <moltbot-markdown-editor> or <moltbot-block-editor>). Verbs are line-based so you don't have to resend the whole document for a small change, and you can paint a colored band over a line range so the user sees what you're focused on.",
        getState: () => {
            const ed = findActiveEditor();
            if (!ed) {
                return { ready: false, reason: "no markdown editor on the active page (focus one or open a note/workflow/project first)" };
            }
            if (ed.kind === "textarea") {
                const lines = (ed.element.value ?? "").split("\n");
                return {
                    ready: true,
                    kind: "textarea",
                    tag: ed.element.tagName.toLowerCase(),
                    readOnly: ed.element.readOnly === true,
                    lineCount: lines.length,
                    charCount: (ed.element.value ?? "").length,
                    preview: lines.slice(0, 10).map((line: string, i: number) => ({ line: i + 1, text: line.slice(0, 200) })),
                    highlight: getCurrentHighlight(),
                };
            }
            // blocks
            const blocks = ed.backend.getBlocks();
            return {
                ready: true,
                kind: "blocks",
                tag: ed.host.tagName.toLowerCase(),
                readOnly: false,
                lineCount: blocks.length,
                blockCount: blocks.length,
                preview: blocks.slice(0, 10).map((b, i) => ({
                    line: i + 1,
                    id: b.id,
                    type: b.type,
                    text: b.text.slice(0, 200),
                })),
                highlight: getCurrentHighlight(),
            };
        },
        describeActions: () => [
            { type: "get_content", doc: "Return the full document text + total line count. Use this once at the start of an edit session." },
            { type: "get_lines", args: { start: "number (1-based, inclusive)", end: "number (1-based, inclusive)" }, doc: "Return a specific line range. Use to inspect what you're about to edit before changing it." },
            { type: "replace_lines", args: { start: "number 1-based", end: "number 1-based", text: "string (replacement content; may include newlines for multi-line replacements)" }, doc: "Replace lines [start..end] with `text`. Inclusive on both ends. Preserves the document around the edit. Commits change via the host view's update path so it persists." },
            { type: "insert_lines", args: { after: "number 1-based (0 = insert at top)", text: "string" }, doc: "Insert content after a given line without replacing anything." },
            { type: "delete_lines", args: { start: "number 1-based", end: "number 1-based" }, doc: "Delete lines [start..end] (inclusive)." },
            { type: "highlight_lines", args: { start: "number 1-based", end: "number 1-based", color: "css color? default 'rgba(255,200,40,0.35)'", scroll: "boolean? default true (also scrolls the lines into view)" }, doc: "Paint a colored band over the given line range so the user can see what the AI is focused on. Persists until clear_highlight or another highlight_lines call. Overlay sits over the textarea, no editor-side changes." },
            { type: "clear_highlight", doc: "Remove the AI-focus highlight overlay." },
            { type: "scroll_to_line", args: { line: "number 1-based", behavior: "'smooth'|'instant'? default 'smooth'" }, doc: "Scroll the editor so the given line is visible. Works in both textarea and preview modes." },
            { type: "find_in_editor", args: { query: "string", caseSensitive: "boolean? default false", limit: "number? default 20" }, doc: "Search the editor's current content for `query`. Returns matching {line, col, snippet} tuples so you can scroll/highlight without scanning yourself." },
        ],
        dispatch: async (action) => {
            const a = action as Record<string, unknown>;
            const ed = findActiveEditor();
            if (!ed) {
                return {
                    ok: false,
                    error: "no markdown editor on the active page. Open a note/workflow/project body first.",
                };
            }
            // Helpers that read/write through whichever editor kind we're on.
            // For textarea: lines = `\n`-split text. For blocks: lines =
            // blocks; each block's text is one logical line. Multi-line
            // block text is collapsed to its first line in get_lines so the
            // line index stays stable — agents wanting full text should use
            // get_content and look at the structured blocks payload.
            const getLines = (): string[] => {
                if (ed.kind === "textarea") return (ed.element.value ?? "").split("\n");
                return ed.backend.getBlocks().map((b) => b.text);
            };
            const setLines = (next: string[]) => {
                if (ed.kind === "textarea") {
                    ed.element.value = next.join("\n");
                    ed.element.dispatchEvent(new CustomEvent("input", { detail: { value: ed.element.value }, bubbles: true, composed: true }));
                    ed.element.dispatchEvent(new CustomEvent("change", { detail: { value: ed.element.value }, bubbles: true, composed: true }));
                } else {
                    const existing = ed.backend.getBlocks();
                    // Pair surviving block ids with their new text so block
                    // type/id is preserved when content overlaps. Extra new
                    // lines become paragraph blocks.
                    const updated: BlockEditorBlock[] = [];
                    for (let i = 0; i < next.length; i++) {
                        const text = next[i] ?? "";
                        const prev = existing[i];
                        if (prev) {
                            updated.push({ ...prev, text });
                        } else {
                            updated.push(ed.backend.newBlock("paragraph", text));
                        }
                    }
                    ed.backend.applyBlocks(updated);
                }
                (host as unknown as { requestUpdate?: () => void }).requestUpdate?.();
            };
            const readOnly = ed.kind === "textarea" && ed.element.readOnly === true;

            switch (a.type) {
                case "get_content": {
                    if (ed.kind === "textarea") {
                        const text = ed.element.value ?? "";
                        return { ok: true, result: { kind: "textarea", content: text, lineCount: text.split("\n").length } };
                    }
                    const blocks = ed.backend.getBlocks();
                    return {
                        ok: true,
                        result: {
                            kind: "blocks",
                            blockCount: blocks.length,
                            lineCount: blocks.length,
                            blocks: blocks.map((b, i) => ({ line: i + 1, id: b.id, type: b.type, text: b.text })),
                        },
                    };
                }
                case "get_lines": {
                    const lines = getLines();
                    const start = Math.max(1, Math.min(lines.length, Number(a.start) || 1));
                    const end = Math.max(start, Math.min(lines.length, Number(a.end) || start));
                    const slice = lines.slice(start - 1, end);
                    if (ed.kind === "blocks") {
                        const blocks = ed.backend.getBlocks();
                        return {
                            ok: true,
                            result: {
                                start, end, totalLines: lines.length, kind: "blocks",
                                lines: slice.map((text: string, i: number) => {
                                    const b = blocks[start - 1 + i];
                                    return { line: start + i, id: b?.id, type: b?.type, text };
                                }),
                            },
                        };
                    }
                    return {
                        ok: true,
                        result: {
                            start, end, totalLines: lines.length, kind: "textarea",
                            lines: slice.map((text: string, i: number) => ({ line: start + i, text })),
                        },
                    };
                }
                case "replace_lines": {
                    if (readOnly) return { ok: false, error: "editor is read-only" };
                    const lines = getLines();
                    const start = Math.max(1, Math.min(lines.length, Number(a.start) || 1));
                    const end = Math.max(start, Math.min(lines.length, Number(a.end) || start));
                    const repl = (a.text as string | undefined) ?? "";
                    const replLines = repl.split("\n");
                    const before = lines.slice(0, start - 1);
                    const after = lines.slice(end);
                    setLines([...before, ...replLines, ...after]);
                    return {
                        ok: true,
                        result: {
                            kind: ed.kind,
                            replaced: { start, end, originalCount: end - start + 1, newCount: replLines.length },
                            totalLines: getLines().length,
                        },
                    };
                }
                case "insert_lines": {
                    if (readOnly) return { ok: false, error: "editor is read-only" };
                    const lines = getLines();
                    const after = Math.max(0, Math.min(lines.length, Number(a.after) ?? 0));
                    const text = (a.text as string | undefined) ?? "";
                    const insertLines = text.split("\n");
                    const next = [...lines.slice(0, after), ...insertLines, ...lines.slice(after)];
                    setLines(next);
                    return {
                        ok: true,
                        result: { kind: ed.kind, insertedAt: after + 1, insertedCount: insertLines.length, totalLines: next.length },
                    };
                }
                case "delete_lines": {
                    if (readOnly) return { ok: false, error: "editor is read-only" };
                    const lines = getLines();
                    const start = Math.max(1, Math.min(lines.length, Number(a.start) || 1));
                    const end = Math.max(start, Math.min(lines.length, Number(a.end) || start));
                    const next = [...lines.slice(0, start - 1), ...lines.slice(end)];
                    setLines(next);
                    return {
                        ok: true,
                        result: { kind: ed.kind, deleted: { start, end, count: end - start + 1 }, totalLines: next.length },
                    };
                }
                case "highlight_lines": {
                    const lines = getLines();
                    const start = Math.max(1, Math.min(lines.length, Number(a.start) || 1));
                    const end = Math.max(start, Math.min(lines.length, Number(a.end) || start));
                    const color = (a.color as string | undefined) ?? "rgba(255,200,40,0.35)";
                    const shouldScroll = a.scroll !== false;
                    paintEditorHighlight(ed, start, end, color);
                    if (shouldScroll) scrollEditorToLine(ed, start);
                    return { ok: true, result: { kind: ed.kind, start, end, color } };
                }
                case "clear_highlight":
                    clearEditorHighlight();
                    return { ok: true };
                case "scroll_to_line": {
                    const line = Math.max(1, Number(a.line) || 1);
                    scrollEditorToLine(ed, line, a.behavior === "instant" ? "instant" : "smooth");
                    return { ok: true, result: { kind: ed.kind, line } };
                }
                case "find_in_editor": {
                    const query = ((a.query as string | undefined) ?? "").trim();
                    if (!query) return { ok: false, error: "query required" };
                    const caseSensitive = a.caseSensitive === true;
                    const limit = Math.max(1, Math.min(100, (a.limit as number | undefined) ?? 20));
                    const needle = caseSensitive ? query : query.toLowerCase();
                    const lines = getLines();
                    const matches: Array<{ line: number; col: number; snippet: string; blockId?: string; blockType?: string }> = [];
                    const blocks = ed.kind === "blocks" ? ed.backend.getBlocks() : null;
                    for (let i = 0; i < lines.length && matches.length < limit; i++) {
                        const hay = caseSensitive ? lines[i]! : lines[i]!.toLowerCase();
                        const idx = hay.indexOf(needle);
                        if (idx >= 0) {
                            const original = lines[i]!;
                            const start = Math.max(0, idx - 15);
                            const end = Math.min(original.length, idx + needle.length + 30);
                            const snippet = (start > 0 ? "…" : "") + original.slice(start, end) + (end < original.length ? "…" : "");
                            const m: { line: number; col: number; snippet: string; blockId?: string; blockType?: string } = { line: i + 1, col: idx + 1, snippet };
                            if (blocks) {
                                const b = blocks[i];
                                if (b) { m.blockId = b.id; m.blockType = b.type; }
                            }
                            matches.push(m);
                        }
                    }
                    return { ok: true, result: { kind: ed.kind, query, count: matches.length, matches } };
                }
            }
            return { ok: false, error: `unknown action: ${a.type}` };
        },
    }));

    /* ─── file_viewer (kanban project attachment preview modal) ────── */
    registered.push(attachViewController({
        viewName: "file_viewer",
        description:
            "Drive the project-attachment preview modal opened when a file on a kanban project is clicked. PDFs render same-origin via pdf.js (one canvas per page stacked inside .kb-preview-body), so scroll_by/scroll_page work for smooth in-page scroll AND next_page/prev_page/goto_page jump to specific pages. Markdown/text/image previews scroll the same body. Returns ready:false when no preview is open.",
        getState: () => {
            const ctx = getFilePreviewElements();
            if (!ctx) return { ready: false, reason: "no file preview is open" };
            const { body, titleEl, iframe, pdfHost, pdfPages, kind } = ctx;
            const base: Record<string, unknown> = {
                ready: true,
                kind,
                name: titleEl?.textContent?.trim() ?? null,
            };
            if (body) {
                base.scrollTop = body.scrollTop;
                base.scrollHeight = body.scrollHeight;
                base.clientHeight = body.clientHeight;
                base.atTop = body.scrollTop <= 2;
                base.atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 2;
            }
            if (kind === "pdf") {
                if (pdfHost) {
                    base.viewer = "pdfjs";
                    base.totalPages = pdfPages.length || null;
                    base.page = body ? getCurrentPdfPage(body, pdfPages) : 1;
                    base.rendering = pdfPages.length === 0;
                } else if (iframe) {
                    base.viewer = "iframe";
                    const h = readPdfViewerHash(iframe);
                    base.page = h.page;
                    base.zoom = h.zoom;
                }
            }
            return base;
        },
        describeActions: () => [
            { type: "close", doc: "Close the file preview modal (same as clicking × or pressing Escape)." },
            { type: "scroll_by", args: { y: "number (pixels, positive = down)", smooth: "boolean? default true" }, doc: "Scroll the preview body by `y` pixels. Works for PDF (pdf.js canvas-per-page), markdown, text, image." },
            { type: "scroll_page", args: { direction: "'up'|'down'|'half_up'|'half_down'", smooth: "boolean? default true" }, doc: "Scroll by ~one viewport (or half). Same path as scroll_by; for PDFs this is in-page smooth scroll." },
            { type: "scroll_to_top", doc: "Jump to the top of the preview body." },
            { type: "scroll_to_bottom", doc: "Jump to the bottom of the preview body." },
            { type: "next_page", doc: "PDF only: scroll to the next page canvas." },
            { type: "prev_page", doc: "PDF only: scroll to the previous page canvas." },
            { type: "goto_page", args: { page: "number 1-based" }, doc: "PDF only: scroll a specific page into view." },
            { type: "set_zoom", args: { zoom: "'page-fit'|'page-width'|number percent (e.g. 100, 150)" }, doc: "PDF only — legacy iframe path. The pdf.js path renders at fit-width; programmatic zoom isn't wired up yet." },
        ],
        dispatch: async (action) => {
            const a = action as Record<string, unknown>;
            const ctx = getFilePreviewElements();
            if (!ctx) return { ok: false, error: "no file preview is open" };
            const { body, iframe, pdfHost, pdfPages, closeBtn, kind } = ctx;
            const smoothBehavior = (val: unknown): ScrollBehavior =>
                (val === undefined || val === true || val === "smooth") ? "smooth" : "auto";
            const gotoPdfPage = (page: number, behavior: ScrollBehavior) => {
                if (!pdfHost) return { ok: false, error: "no PDF host" };
                const total = pdfPages.length;
                if (!total) return { ok: false, error: "PDF still rendering — try again in a moment" };
                const clamped = Math.max(1, Math.min(total, page));
                const target = pdfPages.find((c) => Number(c.dataset.page) === clamped);
                if (!target) return { ok: false, error: `page ${clamped} not found` };
                target.scrollIntoView({ behavior, block: "start" });
                return { ok: true, result: { page: clamped, totalPages: total } };
            };
            // Legacy iframe fallback (kept in case the iframe variant is reintroduced)
            const navPdfIframe = (mut: (p: URLSearchParams) => void) => {
                if (!iframe) return { ok: false, error: "no PDF iframe" };
                const { base, params } = readPdfViewerHash(iframe);
                mut(params);
                applyPdfViewerHash(iframe, base, params);
                const next = readPdfViewerHash(iframe);
                return { ok: true, result: { page: next.page, zoom: next.zoom } };
            };

            switch (a.type) {
                case "close": {
                    if (closeBtn) { closeBtn.click(); return { ok: true, result: { closed: true } }; }
                    return { ok: false, error: "close button not found" };
                }
                case "scroll_by": {
                    const y = Number(a.y ?? 0) || 0;
                    if (!body) return { ok: false, error: "no preview body" };
                    body.scrollBy({ top: y, behavior: smoothBehavior(a.smooth) });
                    return { ok: true, result: { deltaY: y, scrollTop: body.scrollTop } };
                }
                case "scroll_page": {
                    const dir = (a.direction as string) ?? "down";
                    if (!body) return { ok: false, error: "no preview body" };
                    const vh = body.clientHeight;
                    const step =
                        dir === "up" ? -vh * 0.9 :
                        dir === "down" ? vh * 0.9 :
                        dir === "half_up" ? -vh * 0.5 :
                        dir === "half_down" ? vh * 0.5 : 0;
                    if (!step) return { ok: false, error: `unknown direction "${dir}". Use up|down|half_up|half_down.` };
                    body.scrollBy({ top: step, behavior: smoothBehavior(a.smooth) });
                    return { ok: true, result: { deltaY: step, scrollTop: body.scrollTop } };
                }
                case "scroll_to_top": {
                    if (!body) return { ok: false, error: "no preview body" };
                    body.scrollTo({ top: 0, behavior: "smooth" });
                    return { ok: true, result: { scrollTop: 0 } };
                }
                case "scroll_to_bottom": {
                    if (!body) return { ok: false, error: "no preview body" };
                    body.scrollTo({ top: body.scrollHeight, behavior: "smooth" });
                    return { ok: true, result: { scrollTop: body.scrollHeight } };
                }
                case "next_page": {
                    if (kind !== "pdf") return { ok: false, error: "not a PDF preview" };
                    if (pdfHost && body) {
                        const cur = getCurrentPdfPage(body, pdfPages);
                        return gotoPdfPage(cur + 1, "smooth");
                    }
                    return navPdfIframe((p) => {
                        const cur = Number(p.get("page") ?? "1") || 1;
                        p.set("page", String(cur + 1));
                    });
                }
                case "prev_page": {
                    if (kind !== "pdf") return { ok: false, error: "not a PDF preview" };
                    if (pdfHost && body) {
                        const cur = getCurrentPdfPage(body, pdfPages);
                        return gotoPdfPage(cur - 1, "smooth");
                    }
                    return navPdfIframe((p) => {
                        const cur = Number(p.get("page") ?? "1") || 1;
                        p.set("page", String(Math.max(1, cur - 1)));
                    });
                }
                case "goto_page": {
                    if (kind !== "pdf") return { ok: false, error: "not a PDF preview" };
                    const page = Math.max(1, Math.floor(Number(a.page ?? 1)) || 1);
                    if (pdfHost) return gotoPdfPage(page, "smooth");
                    return navPdfIframe((p) => p.set("page", String(page)));
                }
                case "set_zoom": {
                    if (kind !== "pdf") return { ok: false, error: "not a PDF preview" };
                    if (pdfHost) return { ok: false, error: "set_zoom is not supported on the pdf.js viewer yet — file renders at fit-width" };
                    const z = a.zoom;
                    const zoomStr = typeof z === "number" ? String(z) : String(z ?? "").trim();
                    if (!zoomStr) return { ok: false, error: "missing zoom value" };
                    return navPdfIframe((p) => p.set("zoom", zoomStr));
                }
            }
            return { ok: false, error: `unknown action: ${a.type}` };
        },
    }));

    /* ─── chat ─────────────────────────────────────────────────────── */
    registered.push(attachViewController({
        viewName: "chat",
        description:
            "Primary chat view: streaming agent conversation with the user. Read messages, send a message, switch session, abort the running stream.",
        getState: () => ({
            sessionKey: host.sessionKey,
            chatLoadedSessionKey: host.chatLoadedSessionKey ?? null,
            connected: host.connected,
            chatSending: host.chatSending,
            chatRunId: host.chatRunId,
            chatStreamActive: !!host.chatStream,
            chatThinkingLevel: host.chatThinkingLevel,
            messageCount: Array.isArray(host.chatMessages) ? host.chatMessages.length : 0,
            queueLength: Array.isArray(host.chatQueue) ? host.chatQueue.length : 0,
            recentMessages: safe(
                () => (host.chatMessages as Array<{ role?: string; text?: string; content?: string }> | undefined)?.slice(-5).map((m) => ({
                    role: m.role,
                    text: typeof m.text === "string" ? m.text.slice(0, 240) : (typeof m.content === "string" ? m.content.slice(0, 240) : ""),
                })) ?? [],
                [],
            ),
            attachmentsCount: host.chatAttachments?.length ?? 0,
            assistantName: host.assistantName,
            assistantAvatar: host.assistantAvatar,
        }),
        describeActions: () => [
            { type: "send_message", args: { text: "string", attach: "optional ChatAttachment[]" }, doc: "Send a message in the current session." },
            { type: "abort_run", doc: "Abort the running chat stream." },
            { type: "switch_session", args: { sessionKey: "agent:<id>:<session>" }, doc: "Switch the active session." },
            { type: "set_thinking_level", args: { level: "'minimal'|'low'|'medium'|'high'|'extended'" }, doc: "Set assistant thinking budget." },
            { type: "load_history", args: { sessionKey: "string", limit: "number (default 100)" }, doc: "Force-reload chat history for a session." },
            { type: "clear_attachments", doc: "Drop staged attachments." },
        ],
        dispatch: async (action) => {
            const a = action as Record<string, unknown>;
            const client = reqClient(host);
            switch (a.type) {
                case "send_message": {
                    const text = a.text as string | undefined;
                    if (!text) return { ok: false, error: "text required" };
                    const ok = await chatCtrl.sendChatMessage(host as never, text);
                    return { ok };
                }
                case "abort_run": {
                    await chatCtrl.abortChatRun(host as never);
                    return { ok: true };
                }
                case "switch_session": {
                    const key = a.sessionKey as string | undefined;
                    if (!key) return { ok: false, error: "sessionKey required" };
                    host.sessionKey = key;
                    (host as unknown as { requestUpdate?: () => void }).requestUpdate?.();
                    await chatCtrl.loadChatHistory(host as never, { force: true });
                    return { ok: true, result: { sessionKey: key } };
                }
                case "set_thinking_level": {
                    const level = a.level as string | undefined;
                    if (!level) return { ok: false, error: "level required" };
                    host.chatThinkingLevel = level;
                    if (host.patchSessionModel) {
                        await host.patchSessionModel(host.sessionKey, level).catch(() => {});
                    }
                    return { ok: true, result: { level } };
                }
                case "load_history": {
                    const key = a.sessionKey as string | undefined;
                    if (key) host.sessionKey = key;
                    await chatCtrl.loadChatHistory(host as never, { force: true });
                    return { ok: true };
                }
                case "clear_attachments":
                    host.chatAttachments = [];
                    (host as unknown as { requestUpdate?: () => void }).requestUpdate?.();
                    return { ok: true };
            }
            void client;
            return { ok: false, error: `unknown action: ${a.type}` };
        },
    }));

    /* ─── chat_sessions ───────────────────────────────────────────── */
    registered.push(attachViewController({
        viewName: "chat_sessions",
        description:
            "List of agent sessions and the active selector/filter. Switch sessions, refresh the list, open the threads sidebar.",
        getState: () => ({
            loading: host.sessionsLoading,
            error: host.sessionsError,
            current: host.sessionKey,
            filterActive: host.sessionsFilterActive,
            filterLimit: host.sessionsFilterLimit,
            includeGlobal: host.sessionsIncludeGlobal,
            includeUnknown: host.sessionsIncludeUnknown,
            count: safe(() => (host.sessionsResult as { sessions?: unknown[] } | null)?.sessions?.length ?? 0, 0),
        }),
        describeActions: () => [
            { type: "switch", args: { sessionKey: "string" }, doc: "Activate a session by key." },
            { type: "set_filter", args: { active: "string", limit: "string", includeGlobal: "boolean", includeUnknown: "boolean" }, doc: "Update the sessions list filter." },
        ],
        dispatch: async (action) => {
            const a = action as Record<string, unknown>;
            switch (a.type) {
                case "switch": {
                    const key = a.sessionKey as string | undefined;
                    if (!key) return { ok: false, error: "sessionKey required" };
                    host.sessionKey = key;
                    (host as unknown as { requestUpdate?: () => void }).requestUpdate?.();
                    return { ok: true, result: { sessionKey: key } };
                }
                case "set_filter": {
                    if (typeof a.active === "string") host.sessionsFilterActive = a.active;
                    if (typeof a.limit === "string") host.sessionsFilterLimit = a.limit;
                    if (typeof a.includeGlobal === "boolean") host.sessionsIncludeGlobal = a.includeGlobal;
                    if (typeof a.includeUnknown === "boolean") host.sessionsIncludeUnknown = a.includeUnknown;
                    (host as unknown as { requestUpdate?: () => void }).requestUpdate?.();
                    return { ok: true };
                }
            }
            return { ok: false, error: `unknown action: ${a.type}` };
        },
    }));

    /* ─── grid (masonry multi-session) ───────────────────────────── */
    registered.push(attachViewController({
        viewName: "grid",
        description:
            "Multi-session masonry grid: tabs (\"canvases\") containing draggable panels for sessions, kanban, databases, etc. Spawn sub-agents and drop them into a panel; send messages to specific panel sessions; switch canvases.",
        getState: () => {
            const g = host.masonryGridState as
                | {
                      canvases?: Array<{ id: string; name: string; icon?: string; panels: Array<{ id: string; type: string; sessionKey: string; title: string; minimized?: boolean; maximized?: boolean }> }>;
                      activeCanvasId?: string;
                      gridMode?: string;
                  }
                | null;
            const active = g?.canvases?.find((c) => c.id === g?.activeCanvasId);
            return {
                ready: !!g,
                canvasCount: g?.canvases?.length ?? 0,
                activeCanvasId: g?.activeCanvasId,
                gridMode: g?.gridMode,
                canvases: (g?.canvases ?? []).map((c) => ({
                    id: c.id,
                    name: c.name,
                    icon: c.icon,
                    panelCount: c.panels.length,
                })),
                activePanels: (active?.panels ?? []).map((p) => ({
                    id: p.id,
                    type: p.type,
                    sessionKey: p.sessionKey,
                    title: p.title,
                    minimized: p.minimized,
                    maximized: p.maximized,
                })),
            };
        },
        describeActions: () => [
            { type: "list_panels", doc: "Return the panels on the active canvas (id, type, sessionKey, title)." },
            { type: "switch_canvas", args: { canvasId: "string" }, doc: "Activate a canvas by id." },
            { type: "add_session_panel", args: { sessionKey: "string", title: "string?" }, doc: "Add a panel for an existing session to the active canvas. Focuses the panel if one already exists for the session." },
            { type: "spawn_session", args: { task: "string", agentId: "string? default 'coder'", label: "string?", model: "string?", thinking: "string?", addToGrid: "boolean? default true" }, doc: "Spawn a sub-agent via sessions.spawn and (by default) add it to the grid. Returns the new sessionKey." },
            { type: "send_to_session", args: { sessionKey: "string", message: "string", thinking: "string?" }, doc: "Send a message into a session (chat.send). Use this to drive a spawned subagent or any existing session." },
            { type: "remove_panel", args: { panelId: "string" }, doc: "Remove a panel from the active canvas." },
            { type: "focus_panel", args: { panelId: "string" }, doc: "Bring a panel to the front." },
            { type: "add_activity_panel", args: { title: "string? default '⚡ Agent Feed'" }, doc: "Add a live agent activity feed panel to the active canvas. Only one activity panel per canvas (re-focuses if it already exists). Returns the new panelId." },
        ],
        dispatch: async (action) => {
            const a = action as Record<string, unknown>;
            const client = reqClient(host);
            const g = host.masonryGridState as typeof host.masonryGridState | null;
            const activeCanvas = () => g?.canvases?.find((c) => c.id === g?.activeCanvasId);
            const requestUpdate = () => (host as unknown as { requestUpdate?: () => void }).requestUpdate?.();
            switch (a.type) {
                case "list_panels": {
                    const c = activeCanvas();
                    return {
                        ok: true,
                        result: {
                            activeCanvasId: g?.activeCanvasId,
                            panels: (c?.panels ?? []).map((p) => ({
                                id: p.id,
                                type: p.type,
                                sessionKey: p.sessionKey,
                                title: p.title,
                                minimized: p.minimized,
                                maximized: p.maximized,
                            })),
                        },
                    };
                }
                case "switch_canvas": {
                    const canvasId = a.canvasId as string | undefined;
                    if (!canvasId) return { ok: false, error: "canvasId required" };
                    if (!g) return { ok: false, error: "grid not initialized — open the Grid tab first" };
                    const next = mgridCtrl.switchCanvas(g, canvasId);
                    host.masonryGridState = next;
                    requestUpdate();
                    return { ok: true, result: { activeCanvasId: next.activeCanvasId } };
                }
                case "add_session_panel": {
                    const sessionKey = a.sessionKey as string | undefined;
                    if (!sessionKey) return { ok: false, error: "sessionKey required" };
                    if (!g) return { ok: false, error: "grid not initialized — open the Grid tab first" };
                    const title = (a.title as string | undefined) ?? sessionKey;
                    const next = mgridCtrl.addPanel(g, sessionKey, title);
                    host.masonryGridState = next;
                    requestUpdate();
                    return { ok: true, result: { sessionKey, activePanelId: next.activePanel } };
                }
                case "spawn_session": {
                    const task = ((a.task as string | undefined) ?? "").trim();
                    if (!task) return { ok: false, error: "task required" };
                    const spawnPayload: Record<string, unknown> = { task };
                    if (typeof a.agentId === "string") spawnPayload.agentId = a.agentId;
                    if (typeof a.label === "string") spawnPayload.label = a.label;
                    if (typeof a.model === "string") spawnPayload.model = a.model;
                    if (typeof a.thinking === "string") spawnPayload.thinking = a.thinking;
                    const spawn = (await client.request("sessions.spawn", spawnPayload)) as
                        | { sessionKey?: string; childSessionKey?: string; label?: string }
                        | undefined;
                    const sessionKey = spawn?.sessionKey ?? spawn?.childSessionKey;
                    if (!sessionKey) return { ok: false, error: "spawn did not return a sessionKey", result: spawn };
                    const addToGrid = a.addToGrid !== false;
                    if (addToGrid && g) {
                        const title = (a.label as string | undefined) ?? spawn?.label ?? task.slice(0, 40);
                        host.masonryGridState = mgridCtrl.addPanel(g, sessionKey, title);
                        requestUpdate();
                    }
                    return { ok: true, result: { sessionKey, addedToGrid: addToGrid && !!g } };
                }
                case "send_to_session": {
                    const sessionKey = a.sessionKey as string | undefined;
                    const message = a.message as string | undefined;
                    if (!sessionKey || !message) return { ok: false, error: "sessionKey and message required" };
                    const payload: Record<string, unknown> = {
                        sessionKey,
                        message,
                        idempotencyKey: `grid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    };
                    if (typeof a.thinking === "string") payload.thinking = a.thinking;
                    const r = await client.request("chat.send", payload);
                    return { ok: true, result: r };
                }
                case "remove_panel": {
                    const panelId = a.panelId as string | undefined;
                    if (!panelId) return { ok: false, error: "panelId required" };
                    if (!g) return { ok: false, error: "grid not initialized" };
                    host.masonryGridState = mgridCtrl.removePanel(g, panelId);
                    requestUpdate();
                    return { ok: true };
                }
                case "focus_panel": {
                    const panelId = a.panelId as string | undefined;
                    if (!panelId) return { ok: false, error: "panelId required" };
                    if (!g) return { ok: false, error: "grid not initialized" };
                    host.masonryGridState = mgridCtrl.focusPanel(g, panelId);
                    requestUpdate();
                    return { ok: true };
                }
                case "add_activity_panel": {
                    if (!g) return { ok: false, error: "grid not initialized — open the Grid tab first" };
                    const title = (a.title as string | undefined) ?? "⚡ Agent Feed";
                    const next = mgridCtrl.addActivityPanel(g, title);
                    host.masonryGridState = next;
                    requestUpdate();
                    return { ok: true, result: { panelId: next.activePanel } };
                }
            }
            return { ok: false, error: `unknown action: ${a.type}` };
        },
    }));

    /* ─── grid (richer controller — overrides the inline registration
     *           above by name; lives in control-bus-grid.ts so the
     *           panel-aware verb surface stays self-contained and the
     *           voice agent's Grid Live Action mode can drive it via
     *           ui_control dispatch { view: "grid", op: "..." }). ──── */
    registered.push(registerGridController(host));

    /* ─── whiteboard (plugin page + Grid canvas panel) ───────────── */
    registered.push(registerWhiteboardController(host, {
        isAvailable: () => tabCatalog().some((entry) => entry.id === "whiteboard"),
    }));

    /* ─── remote_screen (live view of another node's window) ──────── */
    registered.push(registerRemoteScreenController());

    /* ─── kanban ──────────────────────────────────────────────────── */
    registered.push(attachViewController({
        viewName: "kanban",
        description:
            "Kanban / Projects board: list projects, current project + columns + cards, gallery filter and search. Use to navigate, open a project, change view filter, refresh.",
        getState: () => ({
            loading: host.kanbanLoading,
            error: host.kanbanError,
            galleryView: host.kanbanGalleryView,
            galleryFilter: host.kanbanGalleryFilter,
            gallerySearch: host.kanbanGallerySearch,
            gallerySort: host.kanbanGallerySort,
            selectedProjectId: host.kanbanSelectedProjectId,
            projectCount: host.kanbanProjects?.length ?? 0,
            taskCount: host.kanbanTasks?.length ?? 0,
            projects: safe(
                () => host.kanbanProjects?.slice(0, 20).map((p) => ({
                    id: p.id, name: p.name, status: p.status,
                    progress: p.progress, taskCount: p.taskCount,
                })) ?? [],
                [],
            ),
            tasksForCurrentProject: safe(
                () => host.kanbanSelectedProjectId
                    ? host.kanbanTasks
                        .filter((t) => t.projectId === host.kanbanSelectedProjectId)
                        .slice(0, 50)
                        .map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority }))
                    : [],
                [],
            ),
        }),
        describeActions: () => [
            { type: "select_project", args: { projectId: "string|null" }, doc: "Open a project (null returns to gallery)." },
            { type: "find_project", args: { query: "string", limit: "number? default 10" }, doc: "Fuzzy-search projects by name/id. Returns ranked matches — call refresh first if results look stale." },
            { type: "open_project_by_name", args: { query: "string" }, doc: "Resolve a name to a project id and open it in one call. Returns ok=false with candidates on ambiguity or miss." },
            { type: "get_project_tasks", args: { projectId: "string?", status: "string?", limit: "number? default 100" }, doc: "Return tasks for a project (defaults to current selection). Filter by status. Includes title, status, priority, due date." },
            { type: "set_gallery_filter", args: { filter: "'tasks'|'ai'|'all'|'active'|'completed'|'paused'" }, doc: "Filter the gallery." },
            { type: "set_gallery_search", args: { query: "string" }, doc: "Search projects in the on-screen gallery (visual filter, not a server query)." },
            { type: "set_gallery_sort", args: { sort: "string" }, doc: "Sort gallery." },
            { type: "toggle_gallery_view", doc: "Switch between gallery and board view." },
            { type: "refresh", doc: "Full reload: fetches projects AND tasks. **SLOW (often 15-30s)** on large workspaces. Pass timeoutMs:45000 in ui_control args. For just-pick-a-project flows, prefer refresh_projects." },
            { type: "refresh_projects", doc: "Lightweight reload — projects list only, no tasks. Fast (sub-second). Use this before find_project/open_project_by_name when you only need names." },
            { type: "create_task", args: { projectId: "string", title: "string", status: "optional", priority: "optional" }, doc: "Create a new task." },
            { type: "update_task_status", args: { taskId: "string", status: "string" }, doc: "Move a task to another column/status." },
            { type: "set_project_directory", args: { projectId: "string", directory: "string (absolute path)" }, doc: "Bind a project to a local repo path. Writes the path to the Notion 'Project Directory' field AND auto-creates a clickable 'Project directory' file-link on the project row (idempotent). Always set this for code/repo projects." },
        ],
        // Resolve a DOM target for the Live Action overlay so the fake
        // cursor flies to the right element. Selectors are best-effort —
        // when the kanban view isn't currently rendered (user on another
        // tab), querySelector returns null and the overlay falls back to
        // a center-screen ring + toast. The overlay also auto-switches
        // tabs based on this view name, so by the time we re-render the
        // target usually exists.
        resolveActionTarget: (action) => {
            const a = action as Record<string, unknown>;
            switch (a.type) {
                case "select_project":
                    return a.projectId
                        ? `[data-project-id="${String(a.projectId).replace(/"/g, "")}"]`
                        : ".kanban-back-to-gallery, .kanban-gallery-btn";
                case "set_gallery_filter":
                    return `[data-gallery-filter="${a.filter}"]`;
                case "set_gallery_search":
                    return ".kanban-search-input, input.gallery-search";
                case "set_gallery_sort":
                    return ".kanban-sort-select, select.gallery-sort";
                case "toggle_gallery_view":
                    return ".kanban-view-toggle";
                case "refresh":
                    return ".kanban-refresh-btn";
                case "create_task":
                    return ".kanban-add-task, [data-action='add-task']";
                case "update_task_status":
                    return a.taskId
                        ? `[data-task-id="${String(a.taskId).replace(/"/g, "")}"]`
                        : null;
            }
            return null;
        },
        dispatch: async (action) => {
            const a = action as Record<string, unknown>;
            const client = reqClient(host);
            switch (a.type) {
                case "select_project": {
                    const requested = (a.projectId as string | null | undefined) ?? null;
                    if (requested) {
                        await ensureKanbanLoaded(host);
                        const exists = (host.kanbanProjects ?? []).some((p) => p.id === requested);
                        if (!exists) {
                            return {
                                ok: false,
                                error: `project "${requested}" not found after refresh. Use find_project to list current ids — the user may have renamed/deleted it, or it lives in another business.`,
                            };
                        }
                    }
                    host.kanbanSelectedProjectId = requested;
                    host.kanbanGalleryView = !requested;
                    (host as unknown as { requestUpdate?: () => void }).requestUpdate?.();
                    return { ok: true, result: { selected: host.kanbanSelectedProjectId } };
                }
                case "find_project": {
                    await ensureKanbanLoaded(host);
                    const query = (a.query as string | undefined) ?? "";
                    const limit = Math.max(1, Math.min(50, (a.limit as number | undefined) ?? 10));
                    const projects = host.kanbanProjects ?? [];
                    const matches = matchByName(query, projects.map((p) => ({ id: p.id, name: p.name })));
                    return {
                        ok: true,
                        result: {
                            query,
                            total: projects.length,
                            count: matches.length,
                            matches: matches.slice(0, limit).map((m) => {
                                const p = projects.find((x) => x.id === m.item.id);
                                return {
                                    id: m.item.id,
                                    name: m.item.name,
                                    status: p?.status,
                                    progress: p?.progress,
                                    taskCount: p?.taskCount,
                                    businessId: (p as unknown as { businessId?: string } | undefined)?.businessId,
                                    matchedOn: m.matchedOn,
                                };
                            }),
                        },
                    };
                }
                case "open_project_by_name": {
                    const query = (a.query as string | undefined) ?? "";
                    if (!query) return { ok: false, error: "query required" };
                    await ensureKanbanLoaded(host);
                    const projects = host.kanbanProjects ?? [];
                    const matches = matchByName(query, projects.map((p) => ({ id: p.id, name: p.name })));
                    if (matches.length === 0) {
                        return {
                            ok: false,
                            error: `no project matched "${query}". The kanban has ${projects.length} project(s) loaded — call find_project (no query) to list them all.`,
                        };
                    }
                    // Ambiguous: top two have the same score and don't tie via exact id.
                    if (matches.length > 1 && matches[0]!.score === matches[1]!.score && matches[0]!.score < 1000) {
                        return {
                            ok: false,
                            error: `ambiguous: ${matches.length} projects matched "${query}". Pick one and call select_project.`,
                            candidates: matches.slice(0, 5).map((m) => ({ id: m.item.id, name: m.item.name, matchedOn: m.matchedOn })),
                        };
                    }
                    const picked = matches[0]!.item;
                    host.kanbanSelectedProjectId = picked.id;
                    host.kanbanGalleryView = false;
                    (host as unknown as { requestUpdate?: () => void }).requestUpdate?.();
                    return { ok: true, result: { id: picked.id, name: picked.name, matchedOn: matches[0]!.matchedOn } };
                }
                case "get_project_tasks": {
                    // Tasks aren't included in the cheap projects-only load,
                    // so force the full path here. First call after the
                    // workspace opens can take ~20s on Notion-backed boards.
                    await ensureKanbanLoaded(host, { projectsOnly: false });
                    const projectId = (a.projectId as string | undefined) ?? host.kanbanSelectedProjectId ?? null;
                    if (!projectId) return { ok: false, error: "projectId required (no project currently selected)" };
                    const statusFilter = (a.status as string | undefined)?.toLowerCase();
                    const limit = Math.max(1, Math.min(500, (a.limit as number | undefined) ?? 100));
                    const all = (host.kanbanTasks ?? []).filter((t) => t.projectId === projectId);
                    const filtered = statusFilter
                        ? all.filter((t) => String(t.status ?? "").toLowerCase() === statusFilter)
                        : all;
                    const project = (host.kanbanProjects ?? []).find((p) => p.id === projectId);
                    return {
                        ok: true,
                        result: {
                            projectId,
                            projectName: project?.name,
                            total: all.length,
                            returned: Math.min(filtered.length, limit),
                            tasks: filtered.slice(0, limit).map((t) => ({
                                id: t.id,
                                title: t.title,
                                status: t.status,
                                priority: t.priority,
                                dueDate: (t as unknown as { dueDate?: string }).dueDate,
                                description: (t as unknown as { description?: string }).description?.slice(0, 200),
                            })),
                        },
                    };
                }
                case "set_gallery_filter":
                    host.kanbanGalleryFilter = (a.filter as string) ?? "all";
                    (host as unknown as { requestUpdate?: () => void }).requestUpdate?.();
                    return { ok: true };
                case "set_gallery_search":
                    host.kanbanGallerySearch = (a.query as string) ?? "";
                    (host as unknown as { requestUpdate?: () => void }).requestUpdate?.();
                    return { ok: true };
                case "set_gallery_sort":
                    host.kanbanGallerySort = (a.sort as string) ?? "updated";
                    (host as unknown as { requestUpdate?: () => void }).requestUpdate?.();
                    return { ok: true };
                case "toggle_gallery_view":
                    host.kanbanGalleryView = !host.kanbanGalleryView;
                    (host as unknown as { requestUpdate?: () => void }).requestUpdate?.();
                    return { ok: true, result: { gallery: host.kanbanGalleryView } };
                case "refresh":
                    if ((kanbanCtrl as { loadKanban?: (s: unknown, c: unknown) => Promise<unknown> }).loadKanban) {
                        await (kanbanCtrl as { loadKanban: (s: unknown, c: unknown) => Promise<unknown> }).loadKanban(host, client);
                    }
                    return {
                        ok: true,
                        result: {
                            projectCount: host.kanbanProjects?.length ?? 0,
                            taskCount: host.kanbanTasks?.length ?? 0,
                        },
                    };
                case "refresh_projects": {
                    // Lightweight: projects list only, no tasks. Most "find
                    // the X project" flows only need names; full refresh
                    // can take 20-30s on Notion-backed kanbans.
                    try {
                        const projects = await client.request<unknown>("kanban.projects.list");
                        host.kanbanProjects = (Array.isArray(projects) ? projects : []) as typeof host.kanbanProjects;
                        (host as unknown as { requestUpdate?: () => void }).requestUpdate?.();
                        return { ok: true, result: { projectCount: host.kanbanProjects.length } };
                    } catch (err) {
                        return { ok: false, error: `refresh_projects: ${(err as Error).message ?? String(err)}` };
                    }
                }
                case "create_task": {
                    const projectId = a.projectId as string | undefined;
                    const title = a.title as string | undefined;
                    if (!projectId || !title) return { ok: false, error: "projectId and title required" };
                    const r = await client.request("kanban.tasks.create", {
                        projectId, title,
                        status: a.status, priority: a.priority,
                    });
                    return { ok: true, result: r };
                }
                case "update_task_status": {
                    const taskId = a.taskId as string | undefined;
                    const status = a.status as string | undefined;
                    if (!taskId || !status) return { ok: false, error: "taskId and status required" };
                    const r = await client.request("kanban.tasks.update", { id: taskId, status });
                    return { ok: true, result: r };
                }
                case "set_project_directory": {
                    const projectId = a.projectId as string | undefined;
                    const directory = a.directory as string | undefined;
                    if (!projectId || !directory) return { ok: false, error: "projectId and directory required" };
                    // Re-uses kanban.projects.update; the server-side handler
                    // writes the Notion "Project Directory" field AND
                    // creates the clickable file-link via ensureProjectDirectoryLink.
                    const r = await client.request("kanban.projects.update", {
                        id: projectId,
                        projectDirectory: directory,
                    });
                    return { ok: true, result: r };
                }
            }
            return { ok: false, error: `unknown action: ${a.type}` };
        },
    }));

    /* ─── databases ───────────────────────────────────────────────── */
    /**
     * Find the `files`-typed property to drop an agent upload into.
     * Order: explicit `propertyId` → currently-loaded property of type files
     * → fetch the database schema and look there → create one named
     * `propertyName` (default "Files") via `db.properties.create`. Returns
     * the property id, or `null` if creation failed.
     */
    async function resolveOrCreateFilesProperty(
        host: unknown,
        client: ReturnType<typeof reqClient>,
        databaseId: string,
        explicitPropertyId: string | undefined,
        propertyName: string | undefined,
    ): Promise<string | null> {
        const s = dbCtrl.getDatabasesState(host as never);
        if (explicitPropertyId) return explicitPropertyId;

        if (s.selectedDatabaseId === databaseId) {
            const local = s.properties.find((p) => p.type === "files");
            if (local) return local.id;
        }

        try {
            const dbRes = await client.request<{ properties: Array<{ id: string; type: string; name: string }> }>(
                "db.get",
                { id: databaseId },
            );
            const remote = dbRes.properties?.find((p) => p.type === "files");
            if (remote) return remote.id;
        } catch {
            /* fall through to create */
        }

        try {
            const created = await client.request<{ property?: { id: string } }>(
                "db.properties.create",
                { databaseId, name: propertyName ?? "Files", type: "files" },
            );
            if (s.selectedDatabaseId === databaseId) {
                await dbCtrl.loadDatabase(host as never, client, databaseId);
            }
            return created?.property?.id ?? null;
        } catch {
            return null;
        }
    }

    function base64ToFile(content: string, filename: string, mime?: string): File {
        const cleaned = content.replace(/^data:[^,]+,/, "");
        const bytes = Uint8Array.from(atob(cleaned), (c) => c.charCodeAt(0));
        return new File([bytes], filename, mime ? { type: mime } : undefined);
    }

    registered.push(attachViewController({
        viewName: "databases",
        description:
            "Databases view: list user databases, schema/properties, rows in the selected database, current view (table/board/list), filters, modals (new database, import, row editor). Drives DB navigation and CRUD.",
        getState: () => {
            const s = dbCtrl.getDatabasesState(host);
            return {
                loading: s.loading,
                error: s.error,
                view: s.view,
                groupByPropertyId: s.groupByPropertyId,
                searchQuery: s.searchQuery,
                selectedDatabaseId: s.selectedDatabaseId,
                selectedRowId: s.selectedRowId,
                openRowId: s.openRowId,
                showNewDatabaseDialog: s.showNewDatabaseDialog,
                showImportDialog: s.showImportDialog,
                importRunning: s.importRunning,
                databaseCount: s.databases.length,
                propertyCount: s.properties.length,
                rowCount: s.rows.length,
                databases: s.databases.slice(0, 50).map((d) => ({
                    id: d.id, name: d.name,
                    rowCount: (d as unknown as { rowCount?: number }).rowCount,
                })),
                properties: s.properties.map((p) => ({ id: p.id, name: p.name, type: p.type })),
                rows: s.rows.slice(0, 50).map((r) => ({
                    id: r.id,
                    title: dbCtrl.valueAsString(
                        (r.values as Record<string, unknown>)[
                            dbCtrl.getTitleProperty(s)?.id ?? ""
                        ] as never,
                    ),
                })),
                systemRoles: s.systemRoles,
            };
        },
        describeActions: () => [
            { type: "list", doc: "Refresh database list." },
            { type: "select_database", args: { databaseId: "string|null" }, doc: "Open a database by id." },
            { type: "find_database", args: { query: "string", limit: "number? default 10" }, doc: "Fuzzy-search databases by name/id. Returns ranked matches including any system roles (clients/leads/...) the db is tagged with." },
            { type: "open_database_by_name", args: { query: "string" }, doc: "Resolve a name to a database id and open it in one call. Returns ok=false with candidates on ambiguity or miss." },
            { type: "open_by_role", args: { role: "'projects'|'tasks'|'notes'|'clients'|'leads'" }, doc: "Open the database currently bound to a system role. Use this when the user says \"my clients\" / \"the leads list\" — it picks the configured CRM/leads/etc. db." },
            { type: "search_everywhere", args: { query: "string", limit: "number? default 20", perDbCap: "number? default 5" }, doc: "Cross-database fuzzy search: matches against every database name AND scans rows inside each database server-side for title matches. Use this when the user names something and you don't know whether it's a database, a row, a project, or a contact." },
            { type: "find_row_by_name", args: { query: "string", databaseId: "string?", limit: "number? default 10" }, doc: "Fuzzy-match row titles inside one database (defaults to the selected one). Faster than search_everywhere when you already know which database." },
            { type: "query_rows", args: { databaseId: "string?", query: "string?", filters: "object<propertyName, value>?", limit: "number? default 50", offset: "number? default 0", includeBody: "boolean? default false" }, doc: "Return rows from the selected database (or `databaseId`) with their full property values. `query` does a case-insensitive substring match against the title; `filters` does exact-match per property (by name or id). Use this to actually READ data — not just list ids." },
            { type: "get_row", args: { rowId: "string", databaseId: "string?" }, doc: "Return a single row's full title, body, and property values resolved to readable strings." },
            { type: "select_row", args: { rowId: "string|null" }, doc: "Highlight a row." },
            { type: "open_row", args: { rowId: "string" }, doc: "Open the row editor modal for a row." },
            { type: "close_row", doc: "Close the row editor modal." },
            { type: "set_view", args: { view: "'table'|'board'|'gallery'|'calendar'" }, doc: "Switch the database renderer. Only effective when a database is selected — on the gallery (no selection) this is a no-op. 'board' requires set_group_by first." },
            { type: "set_group_by", args: { propertyId: "string|null" }, doc: "Group rows by a property (board view)." },
            { type: "set_search", args: { query: "string" }, doc: "Filter rows by search query (visual filter only — for actual data queries use query_rows)." },
            { type: "open_new_database_modal", doc: "Open the create-database modal." },
            { type: "close_new_database_modal", doc: "Close the create-database modal." },
            { type: "open_import_modal", doc: "Open the import-from-Notion modal." },
            { type: "close_import_modal", doc: "Close the import-from-Notion modal." },
            { type: "create_database", args: { name: "string", businessId: "string?" }, doc: "Create a new database." },
            { type: "delete_database", args: { databaseId: "string" }, doc: "Delete a database (irreversible)." },
            { type: "create_row", args: { title: "optional title", values: "object<propertyNameOrId, bare-value | typed-PropertyValue>" }, doc: "Create a row in the current database. `values` keys may use the property NAME (case-insensitive) or id; bare strings/numbers/arrays are auto-coerced based on the property type (e.g. {Phone: \"02 ...\", Website: \"https://...\", Tags: [\"Bangkok\"]}). Unknown keys are ignored." },
            { type: "create_rows", args: { rows: "Array<{title?: string, values?: object}>" }, doc: "Bulk-create rows in the current database — same friendly value coercion as create_row. Returns {created, rows[]}. Faster and cleaner than looping create_row from the agent side; use this for CSV/CRM imports." },
            { type: "update_row", args: { rowId: "string", title: "optional", body: "optional", values: "object<propertyNameOrId, bare-value | typed-PropertyValue>" }, doc: "Update a row's title/body/values. `values` accepts the same friendly shape as create_row — property name or id as key, bare strings/numbers/arrays auto-coerced to the right PropertyValue type." },
            { type: "delete_row", args: { rowId: "string" }, doc: "Delete a row." },
            { type: "add_file_to_row", args: { rowId: "string", filename: "string", content: "base64 string", propertyId: "string? — defaults to first files-typed property; auto-created on the row's database if none exists", propertyName: "string? — name to use when auto-creating the property (default 'Files')", mime: "string?" }, doc: "Attach a file to a row's `files`-typed property. Uploads the base64 content to `db-attachments/<rowId>/<filename>` via files.upload and appends a FileRef to the property. Auto-creates the files property on the database when one doesn't exist yet. Use this to drop generated reports, screenshots, exports, etc. onto a project / row from an agent." },
            { type: "attach_file_url_to_row", args: { rowId: "string", name: "string", url: "string", propertyId: "string?", propertyName: "string?", mime: "string?", size: "number?" }, doc: "Attach an externally-hosted file (any URL) to a row's `files`-typed property without uploading bytes — use when the file already lives somewhere the user can fetch (e.g. an asset URL from another tool)." },
            { type: "remove_file_from_row", args: { rowId: "string", propertyId: "string", fileUrl: "string" }, doc: "Remove a single file from a row's files property by its stored URL." },
            { type: "set_system_role", args: { role: "'projects'|'tasks'|'notes'|'clients'|'leads'", databaseId: "string" }, doc: "Assign a database to a system role." },
            { type: "import_from_notion", args: { apiKey: "optional override", databaseIds: "optional list of Notion database ids" }, doc: "Run the Notion → InfiniBot DB import." },
        ],
        dispatch: async (action) => {
            const a = action as Record<string, unknown>;
            const client = reqClient(host);
            const s = dbCtrl.getDatabasesState(host);
            const requestUpdate = () => (host as unknown as { requestUpdate?: () => void }).requestUpdate?.();
            switch (a.type) {
                case "list":
                    await dbCtrl.loadDatabases(host, client);
                    return { ok: true };
                case "select_database": {
                    const id = (a.databaseId as string | null | undefined) ?? null;
                    if (!id) {
                        s.selectedDatabaseId = null;
                        s.properties = [];
                        s.rows = [];
                        requestUpdate();
                        return { ok: true };
                    }
                    await dbCtrl.loadDatabase(host, client, id);
                    return { ok: true, result: { selected: id } };
                }
                case "find_database": {
                    await ensureDatabasesLoaded(host, client);
                    const query = (a.query as string | undefined)?.trim() ?? "";
                    const limit = Math.max(1, Math.min(100, (a.limit as number | undefined) ?? 25));
                    // Empty query → return every database (browse mode). Agent can
                    // then pick by name without needing to issue a separate "list"
                    // call. Avoids the "I see twelve but didn't search them" loop.
                    const entries = s.databases.map((d) => ({
                        id: d.id,
                        name: d.name,
                        rowCount: (d as unknown as { rowCount?: number }).rowCount,
                        roles: dbCtrl.rolesForDatabase(s, d.id),
                    }));
                    if (!query) {
                        return {
                            ok: true,
                            result: {
                                query: "",
                                total: entries.length,
                                count: entries.length,
                                matches: entries.slice(0, limit).map((e) => ({
                                    id: e.id,
                                    name: e.name,
                                    rowCount: e.rowCount,
                                    roles: e.roles,
                                    matchedOn: "(no query — listing all)",
                                })),
                            },
                        };
                    }
                    const matches = matchByName(query, entries);
                    return {
                        ok: true,
                        result: {
                            query,
                            total: entries.length,
                            count: matches.length,
                            matches: matches.slice(0, limit).map((m) => {
                                const entry = entries.find((e) => e.id === m.item.id);
                                return {
                                    id: m.item.id,
                                    name: m.item.name,
                                    rowCount: entry?.rowCount,
                                    roles: entry?.roles ?? [],
                                    matchedOn: m.matchedOn,
                                };
                            }),
                        },
                    };
                }
                case "open_database_by_name": {
                    const query = (a.query as string | undefined) ?? "";
                    if (!query) return { ok: false, error: "query required" };
                    await ensureDatabasesLoaded(host, client);
                    const matches = matchByName(
                        query,
                        s.databases.map((d) => ({ id: d.id, name: d.name })),
                    );
                    if (matches.length === 0) {
                        return { ok: false, error: `no database matched "${query}" among ${s.databases.length} loaded. Use find_database to list candidates.` };
                    }
                    if (matches.length > 1 && matches[0]!.score === matches[1]!.score && matches[0]!.score < 1000) {
                        return {
                            ok: false,
                            error: `ambiguous: ${matches.length} databases matched "${query}". Pick one and call select_database.`,
                            candidates: matches.slice(0, 5).map((m) => ({
                                id: m.item.id,
                                name: m.item.name,
                                roles: dbCtrl.rolesForDatabase(s, m.item.id),
                                matchedOn: m.matchedOn,
                            })),
                        };
                    }
                    const picked = matches[0]!.item;
                    await dbCtrl.loadDatabase(host, client, picked.id);
                    return { ok: true, result: { id: picked.id, name: picked.name, matchedOn: matches[0]!.matchedOn } };
                }
                case "open_by_role": {
                    const role = a.role as dbCtrl.SystemRole | undefined;
                    if (!role) return { ok: false, error: "role required" };
                    await ensureDatabasesLoaded(host, client);
                    const dbId = s.systemRoles[role];
                    if (!dbId) {
                        return {
                            ok: false,
                            error: `no database is assigned to the "${role}" system role. The user has no ${role} database configured — offer to create one or pick from find_database.`,
                            availableRoles: Object.entries(s.systemRoles).map(([r, id]) => ({ role: r, databaseId: id })),
                        };
                    }
                    await dbCtrl.loadDatabase(host, client, dbId);
                    const db = dbCtrl.findDatabase(s, dbId);
                    return { ok: true, result: { role, id: dbId, name: db?.name } };
                }
                case "search_everywhere": {
                    // Cross-database fuzzy search. The user said something like
                    // "Robo Park" — we don't know whether it's a database name,
                    // a row title, a project, or a CRM record. Match against
                    // database names AND scan each database's rows server-side
                    // for title hits. Returns ranked candidates so the agent can
                    // pick the right one in the next call.
                    const query = ((a.query as string | undefined) ?? "").trim();
                    if (!query) return { ok: false, error: "query required" };
                    const limit = Math.max(1, Math.min(50, (a.limit as number | undefined) ?? 20));
                    const perDbCap = Math.max(1, Math.min(20, (a.perDbCap as number | undefined) ?? 5));
                    await ensureDatabasesLoaded(host, client);
                    const dbHits = matchByName(
                        query,
                        s.databases.map((d) => ({ id: d.id, name: d.name })),
                    );
                    // Scan rows per-db. We fetch each database's row list via
                    // db.rows.list (capped at 200 to keep this responsive) and
                    // fuzzy-match titles client-side. Parallelized across DBs.
                    // Skip kanban-source databases — those load via the kanban
                    // controller; this RPC isn't shaped for them.
                    const ROW_FETCH_CAP = 200;
                    const isPlainDb = (d: { source?: string }) =>
                        !d.source || (d.source !== "kanban-projects" && d.source !== "kanban-tasks");
                    const scanDbs = s.databases.filter(isPlainDb);
                    type RowSlim = { id: string; title?: string; values?: Record<string, unknown> };
                    type RowHit = { databaseId: string; databaseName: string; rowId: string; title: string; matchedOn: string; score: number };
                    const rowMatches: RowHit[] = [];
                    await Promise.all(
                        scanDbs.map(async (d) => {
                            try {
                                const r = await client.request<{ rows?: RowSlim[] }>("db.rows.list", {
                                    databaseId: d.id,
                                    limit: ROW_FETCH_CAP,
                                });
                                const rows = r?.rows ?? [];
                                const candidates = rows
                                    .map((row) => ({
                                        id: row.id,
                                        name: typeof row.title === "string" && row.title.length > 0
                                            ? row.title
                                            : "(untitled)",
                                    }))
                                    .filter((row) => row.name !== "(untitled)");
                                const hits = matchByName(query, candidates).slice(0, perDbCap);
                                for (const h of hits) {
                                    rowMatches.push({
                                        databaseId: d.id,
                                        databaseName: d.name,
                                        rowId: h.item.id,
                                        title: h.item.name,
                                        matchedOn: h.matchedOn,
                                        score: h.score,
                                    });
                                }
                            } catch { /* per-db best-effort */ }
                        }),
                    );
                    rowMatches.sort((a, b) => b.score - a.score);
                    return {
                        ok: true,
                        result: {
                            query,
                            databaseMatches: dbHits.slice(0, limit).map((m) => ({
                                id: m.item.id,
                                name: m.item.name,
                                matchedOn: m.matchedOn,
                            })),
                            rowMatches: rowMatches.slice(0, limit),
                            scannedDatabases: scanDbs.length,
                            note: rowMatches.length === 0 && dbHits.length === 0
                                ? `No matches for "${query}" in ${scanDbs.length} database(s) (first ${ROW_FETCH_CAP} rows each).`
                                : undefined,
                        },
                    };
                }
                case "find_row_by_name": {
                    const query = ((a.query as string | undefined) ?? "").trim();
                    if (!query) return { ok: false, error: "query required" };
                    const limit = Math.max(1, Math.min(50, (a.limit as number | undefined) ?? 10));
                    await ensureDatabasesLoaded(host, client);
                    const targetDbId = (a.databaseId as string | undefined) ?? s.selectedDatabaseId ?? null;
                    if (!targetDbId) {
                        return {
                            ok: false,
                            error: "databaseId required (no database currently selected). Use search_everywhere to scan across all databases.",
                        };
                    }
                    if (targetDbId !== s.selectedDatabaseId) {
                        await dbCtrl.loadDatabase(host, client, targetDbId);
                    }
                    const titleProp = dbCtrl.getTitleProperty(s);
                    const rowCandidates = s.rows.map((r) => ({
                        id: r.id,
                        name: titleProp
                            ? dbCtrl.valueAsString(
                                  (r.values as Record<string, dbCtrl.PropertyValue | undefined>)[titleProp.id],
                              ) || r.title
                            : r.title,
                    }));
                    const hits = matchByName(query, rowCandidates);
                    return {
                        ok: true,
                        result: {
                            databaseId: targetDbId,
                            query,
                            total: rowCandidates.length,
                            count: hits.length,
                            matches: hits.slice(0, limit).map((h) => ({
                                rowId: h.item.id,
                                title: h.item.name,
                                matchedOn: h.matchedOn,
                            })),
                        },
                    };
                }
                case "query_rows": {
                    await ensureDatabasesLoaded(host, client);
                    const requestedDbId = (a.databaseId as string | undefined) ?? s.selectedDatabaseId ?? null;
                    if (!requestedDbId) {
                        return { ok: false, error: "databaseId required (or select a database first)" };
                    }
                    if (requestedDbId !== s.selectedDatabaseId) {
                        await dbCtrl.loadDatabase(host, client, requestedDbId);
                    }
                    const limit = Math.max(1, Math.min(500, (a.limit as number | undefined) ?? 50));
                    const offset = Math.max(0, (a.offset as number | undefined) ?? 0);
                    const includeBody = a.includeBody === true;
                    const queryStr = (a.query as string | undefined)?.trim().toLowerCase() ?? "";
                    const filters = (a.filters as Record<string, unknown> | undefined) ?? {};
                    const titleProp = dbCtrl.getTitleProperty(s);
                    const propByKey = new Map<string, dbCtrl.DatabaseProperty>();
                    for (const p of s.properties) {
                        propByKey.set(p.id, p);
                        propByKey.set(p.name.toLowerCase(), p);
                    }
                    const filterEntries = Object.entries(filters).map(([k, v]) => ({
                        prop: propByKey.get(k) ?? propByKey.get(k.toLowerCase()),
                        rawKey: k,
                        wanted: v,
                    }));
                    const unknownFilters = filterEntries.filter((e) => !e.prop).map((e) => e.rawKey);
                    const valuesForRow = (row: dbCtrl.DatabaseRow) => {
                        const out: Record<string, string> = {};
                        for (const p of s.properties) {
                            if (p.hidden) continue;
                            const v = (row.values as Record<string, dbCtrl.PropertyValue | undefined>)[p.id];
                            if (v === undefined) continue;
                            const str = dbCtrl.valueAsString(v);
                            if (str) out[p.name] = str;
                        }
                        return out;
                    };
                    const matches: dbCtrl.DatabaseRow[] = [];
                    for (const row of s.rows) {
                        if (queryStr) {
                            const titleVal = titleProp
                                ? dbCtrl.valueAsString(
                                      (row.values as Record<string, dbCtrl.PropertyValue | undefined>)[titleProp.id],
                                  )
                                : row.title;
                            if (!String(titleVal ?? row.title ?? "").toLowerCase().includes(queryStr)) continue;
                        }
                        let filterOk = true;
                        for (const entry of filterEntries) {
                            if (!entry.prop) continue;
                            const v = (row.values as Record<string, dbCtrl.PropertyValue | undefined>)[entry.prop.id];
                            const got = (dbCtrl.valueAsString(v) ?? "").toLowerCase();
                            const want = String(entry.wanted ?? "").toLowerCase();
                            if (got !== want && !got.includes(want)) {
                                filterOk = false;
                                break;
                            }
                        }
                        if (filterOk) matches.push(row);
                    }
                    const slice = matches.slice(offset, offset + limit);
                    return {
                        ok: true,
                        result: {
                            databaseId: requestedDbId,
                            total: matches.length,
                            returned: slice.length,
                            offset,
                            limit,
                            unknownFilters: unknownFilters.length ? unknownFilters : undefined,
                            properties: s.properties
                                .filter((p) => !p.hidden)
                                .map((p) => ({ id: p.id, name: p.name, type: p.type })),
                            rows: slice.map((r) => ({
                                id: r.id,
                                title: titleProp
                                    ? dbCtrl.valueAsString(
                                          (r.values as Record<string, dbCtrl.PropertyValue | undefined>)[titleProp.id],
                                      ) || r.title
                                    : r.title,
                                values: valuesForRow(r),
                                body: includeBody ? r.body ?? "" : undefined,
                                updatedAt: r.updatedAt,
                            })),
                        },
                    };
                }
                case "get_row": {
                    const rowId = a.rowId as string | undefined;
                    if (!rowId) return { ok: false, error: "rowId required" };
                    const targetDbId = (a.databaseId as string | undefined) ?? s.selectedDatabaseId ?? null;
                    if (targetDbId && targetDbId !== s.selectedDatabaseId) {
                        await dbCtrl.loadDatabase(host, client, targetDbId);
                    }
                    const row = s.rows.find((r) => r.id === rowId);
                    if (!row) {
                        return { ok: false, error: `row "${rowId}" not found in the loaded database. Try query_rows first or pass databaseId.` };
                    }
                    const titleProp = dbCtrl.getTitleProperty(s);
                    const values: Record<string, string> = {};
                    for (const p of s.properties) {
                        if (p.hidden) continue;
                        const v = (row.values as Record<string, dbCtrl.PropertyValue | undefined>)[p.id];
                        const str = dbCtrl.valueAsString(v);
                        if (str) values[p.name] = str;
                    }
                    return {
                        ok: true,
                        result: {
                            id: row.id,
                            databaseId: row.databaseId,
                            title: titleProp
                                ? dbCtrl.valueAsString(
                                      (row.values as Record<string, dbCtrl.PropertyValue | undefined>)[titleProp.id],
                                  ) || row.title
                                : row.title,
                            body: row.body ?? "",
                            values,
                            updatedAt: row.updatedAt,
                        },
                    };
                }
                case "select_row":
                    dbCtrl.setSelectedRow(host, (a.rowId as string | null | undefined) ?? null);
                    return { ok: true };
                case "open_row":
                    s.openRowId = a.rowId as string;
                    requestUpdate();
                    return { ok: true };
                case "close_row":
                    s.openRowId = null;
                    s.openRow = null;
                    requestUpdate();
                    return { ok: true };
                case "set_view": {
                    const raw = (a.view as string | undefined) ?? "table";
                    const valid = new Set<dbCtrl.DbView>(["table", "board", "gallery", "calendar"]);
                    if (!valid.has(raw as dbCtrl.DbView)) {
                        return {
                            ok: false,
                            error: `unknown view "${raw}". Valid: ${[...valid].join(", ")}. Note "list" is not a real view — use "table" for a list-style grid.`,
                        };
                    }
                    if (!s.selectedDatabaseId) {
                        return {
                            ok: false,
                            error: "no database selected — set_view only switches the renderer for the currently-open database. Call open_database_by_name or select_database first.",
                        };
                    }
                    dbCtrl.setView(host, raw as dbCtrl.DbView);
                    return { ok: true, result: { view: raw, databaseId: s.selectedDatabaseId } };
                }
                case "set_group_by":
                    dbCtrl.setGroupBy(host, (a.propertyId as string | null | undefined) ?? null);
                    return { ok: true };
                case "set_search":
                    s.searchQuery = (a.query as string) ?? "";
                    requestUpdate();
                    return { ok: true };
                case "open_new_database_modal":
                    s.showNewDatabaseDialog = true;
                    requestUpdate();
                    return { ok: true };
                case "close_new_database_modal":
                    s.showNewDatabaseDialog = false;
                    requestUpdate();
                    return { ok: true };
                case "open_import_modal":
                    s.showImportDialog = true;
                    requestUpdate();
                    return { ok: true };
                case "close_import_modal":
                    s.showImportDialog = false;
                    requestUpdate();
                    return { ok: true };
                case "create_database": {
                    const name = a.name as string | undefined;
                    if (!name) return { ok: false, error: "name required" };
                    const r = await dbCtrl.createDatabase(host, client, {
                        name,
                        icon: a.icon as string | undefined,
                        description: a.description as string | undefined,
                    });
                    if (r && a.businessId !== undefined) {
                        await dbCtrl.setDatabaseBusiness(host, client, r.id, String(a.businessId));
                    }
                    return { ok: true, result: r };
                }
                case "delete_database": {
                    const id = a.databaseId as string | undefined;
                    if (!id) return { ok: false, error: "databaseId required" };
                    await dbCtrl.deleteDatabase(host, client, id);
                    return { ok: true };
                }
                case "create_row": {
                    if (!s.selectedDatabaseId) return { ok: false, error: "no database selected" };
                    const title = (a.title as string | undefined) ?? "";
                    const r = await dbCtrl.createRow(host, client, s.selectedDatabaseId, title);
                    if (r && a.values && typeof a.values === "object") {
                        const coerced = dbCtrl.coerceValuesForProperties(
                            s.properties,
                            a.values as Record<string, unknown>,
                        );
                        if (Object.keys(coerced).length) {
                            await dbCtrl.updateRow(host, client, r.id, { values: coerced });
                        }
                    }
                    return { ok: true, result: r };
                }
                case "create_rows": {
                    if (!s.selectedDatabaseId) return { ok: false, error: "no database selected" };
                    const rowsArg = Array.isArray(a.rows) ? (a.rows as Array<Record<string, unknown>>) : null;
                    if (!rowsArg) return { ok: false, error: "rows[] required (array of {title?, values?})" };
                    const created: Array<{ id: string; title: string }> = [];
                    for (const r of rowsArg) {
                        const title = (r.title as string | undefined) ?? "";
                        const row = await dbCtrl.createRow(host, client, s.selectedDatabaseId, title);
                        if (!row) continue;
                        const vals = r.values;
                        if (vals && typeof vals === "object") {
                            const coerced = dbCtrl.coerceValuesForProperties(
                                s.properties,
                                vals as Record<string, unknown>,
                            );
                            if (Object.keys(coerced).length) {
                                await dbCtrl.updateRow(host, client, row.id, { values: coerced });
                            }
                        }
                        created.push({ id: row.id, title: row.title });
                    }
                    return { ok: true, result: { created: created.length, rows: created } };
                }
                case "update_row": {
                    const rowId = a.rowId as string | undefined;
                    if (!rowId) return { ok: false, error: "rowId required" };
                    const valuesIn = a.values;
                    const coerced =
                        valuesIn && typeof valuesIn === "object"
                            ? dbCtrl.coerceValuesForProperties(
                                  s.properties,
                                  valuesIn as Record<string, unknown>,
                              )
                            : undefined;
                    await dbCtrl.updateRow(host, client, rowId, {
                        title: a.title as string | undefined,
                        body: a.body as string | null | undefined,
                        values: coerced,
                    });
                    return { ok: true };
                }
                case "delete_row": {
                    const rowId = a.rowId as string | undefined;
                    if (!rowId) return { ok: false, error: "rowId required" };
                    await dbCtrl.deleteRow(host, client, rowId);
                    return { ok: true };
                }
                case "add_file_to_row": {
                    const rowId = a.rowId as string | undefined;
                    const filename = a.filename as string | undefined;
                    const content = a.content as string | undefined;
                    if (!rowId || !filename || !content) {
                        return { ok: false, error: "rowId, filename, and content (base64) required" };
                    }
                    const row = s.rows.find((r) => r.id === rowId) ?? (s.openRow?.id === rowId ? s.openRow : null);
                    if (!row) return { ok: false, error: `row ${rowId} not loaded — select its database first` };
                    const propertyId = await resolveOrCreateFilesProperty(
                        host,
                        client,
                        row.databaseId,
                        a.propertyId as string | undefined,
                        a.propertyName as string | undefined,
                    );
                    if (!propertyId) return { ok: false, error: "no files property and could not create one" };
                    const file = base64ToFile(content, filename, a.mime as string | undefined);
                    await dbCtrl.uploadFilesToRowProperty(host, client, rowId, propertyId, [file]);
                    return { ok: true, result: { rowId, propertyId, filename, size: file.size } };
                }
                case "attach_file_url_to_row": {
                    const rowId = a.rowId as string | undefined;
                    const name = a.name as string | undefined;
                    const url = a.url as string | undefined;
                    if (!rowId || !name || !url) return { ok: false, error: "rowId, name, url required" };
                    const row = s.rows.find((r) => r.id === rowId) ?? (s.openRow?.id === rowId ? s.openRow : null);
                    if (!row) return { ok: false, error: `row ${rowId} not loaded — select its database first` };
                    const propertyId = await resolveOrCreateFilesProperty(
                        host,
                        client,
                        row.databaseId,
                        a.propertyId as string | undefined,
                        a.propertyName as string | undefined,
                    );
                    if (!propertyId) return { ok: false, error: "no files property and could not create one" };
                    const existing = row.values[propertyId];
                    const existingRefs = existing?.type === "files" ? [...existing.files] : [];
                    const newRef = {
                        name,
                        url,
                        mime: a.mime as string | undefined,
                        size: a.size as number | undefined,
                    };
                    await dbCtrl.updateRow(host, client, rowId, {
                        values: {
                            [propertyId]: { type: "files", files: [...existingRefs, newRef] },
                        },
                    });
                    return { ok: true, result: { rowId, propertyId, name, url } };
                }
                case "remove_file_from_row": {
                    const rowId = a.rowId as string | undefined;
                    const propertyId = a.propertyId as string | undefined;
                    const fileUrl = a.fileUrl as string | undefined;
                    if (!rowId || !propertyId || !fileUrl) {
                        return { ok: false, error: "rowId, propertyId, fileUrl required" };
                    }
                    await dbCtrl.removeFileFromRowProperty(host, client, rowId, propertyId, fileUrl);
                    return { ok: true };
                }
                case "set_system_role": {
                    const role = a.role as dbCtrl.SystemRole | undefined;
                    const dbId = a.databaseId as string | undefined;
                    if (!role || !dbId) return { ok: false, error: "role and databaseId required" };
                    await dbCtrl.setSystemRole(host, client, role, dbId);
                    return { ok: true };
                }
                case "import_from_notion": {
                    const dbIds = (a.databaseIds as string[] | undefined) ?? undefined;
                    const apiKey = a.apiKey as string | undefined;
                    await dbCtrl.importFromNotion(host, client, { databaseIds: dbIds, apiKey });
                    return { ok: true };
                }
            }
            return { ok: false, error: `unknown action: ${a.type}` };
        },
    }));

    /* ─── workflows ───────────────────────────────────────────────── */
    registered.push(attachViewController({
        viewName: "workflows",
        description:
            "Workflows view: list, open, fuzzy-find, edit, and run. open / open_by_name brings the workflow up in the editor; run_with_inputs opens the run dialog, sets inputs, runs preflight, and starts the run in one call.",
        getState: () => {
            const ws = host.workflowsState as
                | {
                      workflows?: Array<{ id: string; name: string; description?: string; status?: string; tags?: string[]; updatedAt?: string }>;
                      selected?: { id: string; name?: string; body?: string } | null;
                      dirty?: boolean;
                      runDialog?: { open?: boolean; workflow?: { id: string; name: string } | null };
                  }
                | null;
            return {
                ready: !!ws,
                count: ws?.workflows?.length ?? 0,
                workflows: (ws?.workflows ?? []).slice(0, 50).map((w) => ({
                    id: w.id,
                    name: w.name,
                    description: w.description,
                    status: w.status,
                    tags: w.tags,
                    updatedAt: w.updatedAt,
                })),
                selected: ws?.selected ? { id: ws.selected.id, name: ws.selected.name, bodyLength: ws.selected.body?.length ?? 0 } : null,
                dirty: ws?.dirty ?? false,
                runDialogOpen: ws?.runDialog?.open ?? false,
                runDialogWorkflow: ws?.runDialog?.workflow ? { id: ws.runDialog.workflow.id, name: ws.runDialog.workflow.name } : null,
            };
        },
        describeActions: () => [
            { type: "refresh", doc: "Reload workflows from gateway." },
            { type: "find_workflow", args: { query: "string", limit: "number? default 10" }, doc: "Fuzzy-search workflows by name/id/tags. Returns ranked matches." },
            { type: "open", args: { id: "string" }, doc: "Open a workflow in the editor pane by id." },
            { type: "open_by_name", args: { query: "string" }, doc: "Resolve a name and open the workflow." },
            { type: "update", args: { id: "string?", name: "string?", body: "string?", description: "string?", tags: "string[]?" }, doc: "Update the selected workflow (or a specific id)." },
            { type: "run", args: { workflowId: "string", inputs: "object?" }, doc: "Run a workflow. If inputs is provided, opens the run dialog, sets each input, runs preflight, and starts the run. If omitted, runs immediately with defaults." },
            { type: "run_by_name", args: { query: "string", inputs: "object?" }, doc: "Find a workflow by name and run it. Same input semantics as `run`." },
            { type: "open_run_dialog", args: { workflowId: "string" }, doc: "Open the run dialog (with preflight) but don't start. Useful when the agent needs to inspect required inputs first." },
            { type: "close_run_dialog", doc: "Close the run dialog." },
        ],
        dispatch: async (action) => {
            const a = action as Record<string, unknown>;
            const client = reqClient(host);
            const loadList = async () => {
                const fn = (workflowsCtrl as { loadWorkflows?: (s: unknown, c: unknown) => Promise<unknown> }).loadWorkflows;
                if (fn) await fn(host, client);
            };
            const ensureLoaded = async () => {
                const ws = host.workflowsState as { workflows?: unknown[] } | null;
                if (!ws?.workflows?.length) await loadList();
            };
            const matchesFor = (query: string) => {
                const ws = host.workflowsState as { workflows?: Array<{ id: string; name: string; tags?: string[] }> } | null;
                const entries = (ws?.workflows ?? []).map((w) => ({ id: w.id, name: w.name, aliases: w.tags }));
                return matchByName(query, entries);
            };
            switch (a.type) {
                case "refresh": {
                    await loadList();
                    const ws = host.workflowsState as { workflows?: unknown[] } | null;
                    return { ok: true, result: { count: ws?.workflows?.length ?? 0 } };
                }
                case "find_workflow": {
                    await ensureLoaded();
                    const query = ((a.query as string | undefined) ?? "").trim();
                    const limit = Math.max(1, Math.min(50, (a.limit as number | undefined) ?? 10));
                    const ws = host.workflowsState as { workflows?: Array<{ id: string; name: string; description?: string; status?: string; tags?: string[] }> } | null;
                    const entries = ws?.workflows ?? [];
                    if (!query) {
                        return {
                            ok: true,
                            result: {
                                query: "",
                                total: entries.length,
                                matches: entries.slice(0, limit).map((w) => ({ id: w.id, name: w.name, status: w.status, tags: w.tags, matchedOn: "(no query — listing all)" })),
                            },
                        };
                    }
                    const matches = matchesFor(query);
                    return {
                        ok: true,
                        result: {
                            query,
                            total: entries.length,
                            count: matches.length,
                            matches: matches.slice(0, limit).map((m) => {
                                const w = entries.find((e) => e.id === m.item.id);
                                return { id: m.item.id, name: m.item.name, description: w?.description, status: w?.status, tags: w?.tags, matchedOn: m.matchedOn };
                            }),
                        },
                    };
                }
                case "open": {
                    const id = a.id as string | undefined;
                    if (!id) return { ok: false, error: "id required" };
                    await ensureLoaded();
                    await workflowsCtrl.loadWorkflow(host, client, id);
                    const ws = host.workflowsState as { selected?: { id: string; name?: string } } | null;
                    return { ok: true, result: { id, name: ws?.selected?.name } };
                }
                case "open_by_name": {
                    const query = ((a.query as string | undefined) ?? "").trim();
                    if (!query) return { ok: false, error: "query required" };
                    await ensureLoaded();
                    const matches = matchesFor(query);
                    if (matches.length === 0) return { ok: false, error: `no workflow matched "${query}". Use find_workflow to list all.` };
                    if (matches.length > 1 && matches[0]!.score === matches[1]!.score && matches[0]!.score < 1000) {
                        return {
                            ok: false,
                            error: `ambiguous: ${matches.length} workflows matched "${query}". Pick one by id.`,
                            candidates: matches.slice(0, 5).map((m) => ({ id: m.item.id, name: m.item.name, matchedOn: m.matchedOn })),
                        };
                    }
                    const picked = matches[0]!.item;
                    await workflowsCtrl.loadWorkflow(host, client, picked.id);
                    return { ok: true, result: { id: picked.id, name: picked.name, matchedOn: matches[0]!.matchedOn } };
                }
                case "update": {
                    const ws = host.workflowsState as { selected?: { id: string } | null } | null;
                    const id = (a.id as string | undefined) ?? ws?.selected?.id ?? null;
                    if (!id) return { ok: false, error: "id required (or open a workflow first)" };
                    const patch: Record<string, unknown> = { id };
                    for (const key of ["name", "body", "description"] as const) {
                        if (typeof a[key] === "string") patch[key] = a[key];
                    }
                    if (Array.isArray(a.tags)) patch.tags = a.tags;
                    const r = await client.request("workflows.update", patch);
                    await loadList();
                    if (ws?.selected?.id === id) await workflowsCtrl.loadWorkflow(host, client, id);
                    return { ok: true, result: r };
                }
                case "run": {
                    const id = a.workflowId as string | undefined;
                    if (!id) return { ok: false, error: "workflowId required" };
                    const inputs = (a.inputs as Record<string, unknown> | undefined) ?? null;
                    if (!inputs) {
                        const r = await client.request("workflows.run.start", { id, inputs: {} });
                        return { ok: true, result: r };
                    }
                    // Inputs path: drive the run dialog so the UI shows
                    // preflight + actually launches under the agent's view.
                    await workflowsCtrl.openRunDialog(host, client, id);
                    for (const [name, value] of Object.entries(inputs)) {
                        workflowsCtrl.setRunInput(host, name, value);
                    }
                    await workflowsCtrl.runPreflight(host, client);
                    await workflowsCtrl.startRun(host, client);
                    return { ok: true, result: { id, inputs } };
                }
                case "run_by_name": {
                    const query = ((a.query as string | undefined) ?? "").trim();
                    if (!query) return { ok: false, error: "query required" };
                    await ensureLoaded();
                    const matches = matchesFor(query);
                    if (matches.length === 0) return { ok: false, error: `no workflow matched "${query}".` };
                    const picked = matches[0]!.item;
                    const inputs = (a.inputs as Record<string, unknown> | undefined) ?? null;
                    if (!inputs) {
                        const r = await client.request("workflows.run.start", { id: picked.id, inputs: {} });
                        return { ok: true, result: { id: picked.id, name: picked.name, run: r } };
                    }
                    await workflowsCtrl.openRunDialog(host, client, picked.id);
                    for (const [name, value] of Object.entries(inputs)) {
                        workflowsCtrl.setRunInput(host, name, value);
                    }
                    await workflowsCtrl.runPreflight(host, client);
                    await workflowsCtrl.startRun(host, client);
                    return { ok: true, result: { id: picked.id, name: picked.name, inputs } };
                }
                case "open_run_dialog": {
                    const id = a.workflowId as string | undefined;
                    if (!id) return { ok: false, error: "workflowId required" };
                    await workflowsCtrl.openRunDialog(host, client, id);
                    return { ok: true };
                }
                case "close_run_dialog": {
                    workflowsCtrl.closeRunDialog(host);
                    return { ok: true };
                }
            }
            return { ok: false, error: `unknown action: ${a.type}` };
        },
    }));

    /* ─── notes ───────────────────────────────────────────────────── */
    registered.push(attachViewController({
        viewName: "notes",
        description:
            "Notes view: list, open, fuzzy-find, create, update, delete notes. open / open_by_name brings the note up in the editor pane so the user sees it. find_note returns matches without changing the UI.",
        getState: () => {
            const ns = host.notesState as
                | {
                      notes?: Array<{ id: string; name?: string; title?: string; updatedAt?: number }>;
                      selected?: { id: string; name?: string; body?: string } | null;
                      editing?: boolean;
                      dirty?: boolean;
                  }
                | null;
            return {
                ready: !!ns,
                count: ns?.notes?.length ?? 0,
                notes: (ns?.notes ?? []).slice(0, 50).map((n) => ({
                    id: n.id,
                    name: n.name ?? n.title,
                    updatedAt: n.updatedAt,
                })),
                selected: ns?.selected
                    ? { id: ns.selected.id, name: ns.selected.name, bodyLength: ns.selected.body?.length ?? 0 }
                    : null,
                editing: ns?.editing ?? false,
                dirty: ns?.dirty ?? false,
            };
        },
        describeActions: () => [
            { type: "refresh", doc: "Reload notes list from the gateway." },
            { type: "find_note", args: { query: "string", limit: "number? default 10" }, doc: "Fuzzy-search the loaded notes by name. Returns ranked matches — does not change the UI." },
            { type: "open", args: { id: "string" }, doc: "Open a note in the editor pane by id. The note becomes the selected one and the user sees its body." },
            { type: "open_by_name", args: { query: "string" }, doc: "Resolve a name and open the note in one call. Returns ok=false with candidates on ambiguity." },
            { type: "set_editing", args: { editing: "boolean" }, doc: "Switch between rendered-markdown preview and raw-markdown editor for the currently open note." },
            { type: "update", args: { id: "string?", name: "string?", body: "string?", description: "string?", tags: "string[]?", category: "string?", pinned: "boolean?" }, doc: "Update the open note (or a specific id). Only the fields you pass are changed. Goes straight to the gateway — no need to call open first." },
            { type: "create", args: { name: "string", body: "string?", description: "string?" }, doc: "Create a new note." },
            { type: "delete", args: { id: "string" }, doc: "Delete a note." },
        ],
        dispatch: async (action) => {
            const a = action as Record<string, unknown>;
            const client = reqClient(host);
            const loadList = async () => {
                const fn = (notesCtrl as { loadNotes?: (s: unknown, c: unknown) => Promise<unknown> }).loadNotes;
                if (fn) await fn(host, client);
            };
            const ensureLoaded = async () => {
                const ns = host.notesState as { notes?: unknown[] } | null;
                if (!ns?.notes?.length) await loadList();
            };
            switch (a.type) {
                case "refresh": {
                    await loadList();
                    const ns = host.notesState as { notes?: unknown[] } | null;
                    return { ok: true, result: { count: ns?.notes?.length ?? 0 } };
                }
                case "find_note": {
                    await ensureLoaded();
                    const query = ((a.query as string | undefined) ?? "").trim();
                    const limit = Math.max(1, Math.min(50, (a.limit as number | undefined) ?? 10));
                    const notes = ((host.notesState as { notes?: Array<{ id: string; name?: string; title?: string; updatedAt?: string }> } | null)?.notes ?? []);
                    const entries = notes.map((n) => ({ id: n.id, name: n.name ?? n.title ?? "(untitled)" }));
                    if (!query) {
                        return {
                            ok: true,
                            result: {
                                query: "",
                                total: entries.length,
                                matches: entries.slice(0, limit).map((e) => ({ id: e.id, name: e.name, matchedOn: "(no query — listing all)" })),
                            },
                        };
                    }
                    const matches = matchByName(query, entries);
                    return {
                        ok: true,
                        result: {
                            query,
                            total: entries.length,
                            count: matches.length,
                            matches: matches.slice(0, limit).map((m) => ({ id: m.item.id, name: m.item.name, matchedOn: m.matchedOn })),
                        },
                    };
                }
                case "open": {
                    const id = a.id as string | undefined;
                    if (!id) return { ok: false, error: "id required" };
                    await ensureLoaded();
                    await notesCtrl.loadNote(host, client, id);
                    const ns = host.notesState as { selected?: { id: string; name?: string } } | null;
                    return {
                        ok: true,
                        result: { id, name: ns?.selected?.name },
                    };
                }
                case "open_by_name": {
                    const query = ((a.query as string | undefined) ?? "").trim();
                    if (!query) return { ok: false, error: "query required" };
                    await ensureLoaded();
                    const notes = ((host.notesState as { notes?: Array<{ id: string; name?: string; title?: string }> } | null)?.notes ?? []);
                    const entries = notes.map((n) => ({ id: n.id, name: n.name ?? n.title ?? "(untitled)" }));
                    const matches = matchByName(query, entries);
                    if (matches.length === 0) {
                        return { ok: false, error: `no note matched "${query}" among ${entries.length} loaded notes. Try find_note "" to list them.` };
                    }
                    if (matches.length > 1 && matches[0]!.score === matches[1]!.score && matches[0]!.score < 1000) {
                        return {
                            ok: false,
                            error: `ambiguous: ${matches.length} notes matched "${query}". Pick one and call open with its id.`,
                            candidates: matches.slice(0, 5).map((m) => ({ id: m.item.id, name: m.item.name, matchedOn: m.matchedOn })),
                        };
                    }
                    const picked = matches[0]!.item;
                    await notesCtrl.loadNote(host, client, picked.id);
                    return { ok: true, result: { id: picked.id, name: picked.name, matchedOn: matches[0]!.matchedOn } };
                }
                case "set_editing": {
                    const ns = host.notesState as { editing?: boolean } | null;
                    if (!ns) return { ok: false, error: "no note loaded — call open first" };
                    ns.editing = a.editing === true;
                    (host as unknown as { requestUpdate?: () => void }).requestUpdate?.();
                    if (ns.editing && typeof requestAnimationFrame === "function") {
                        requestAnimationFrame(() => {
                            const ta = document.querySelector("textarea.notes-raw-editor") as HTMLTextAreaElement | null;
                            ta?.focus();
                        });
                    }
                    return { ok: true, result: { editing: ns.editing } };
                }
                case "update": {
                    const ns = host.notesState as { selected?: { id: string } | null } | null;
                    const id = (a.id as string | undefined) ?? ns?.selected?.id ?? null;
                    if (!id) return { ok: false, error: "id required (or open a note first so update applies to the selection)" };
                    const patch: Record<string, unknown> = { id };
                    for (const key of ["name", "body", "description", "category"] as const) {
                        if (typeof a[key] === "string") patch[key] = a[key];
                    }
                    if (Array.isArray(a.tags)) patch.tags = a.tags;
                    if (Array.isArray(a.linkedTo)) patch.linkedTo = a.linkedTo;
                    if (typeof a.pinned === "boolean") patch.pinned = a.pinned;
                    const r = await client.request("notes.update", patch);
                    // Refresh list + selection so the UI reflects the change immediately.
                    await loadList();
                    if (ns?.selected?.id === id) await notesCtrl.loadNote(host, client, id);
                    return { ok: true, result: r };
                }
                case "create": {
                    const r = await client.request("notes.create", {
                        name: a.name ?? a.title,
                        body: a.body,
                        description: a.description,
                    });
                    await loadList();
                    return { ok: true, result: r };
                }
                case "delete": {
                    const id = a.id as string | undefined;
                    if (!id) return { ok: false, error: "id required" };
                    await client.request("notes.delete", { id });
                    await loadList();
                    return { ok: true };
                }
            }
            return { ok: false, error: `unknown action: ${a.type}` };
        },
    }));

    /* ─── research ────────────────────────────────────────────────── */
    registered.push(attachViewController({
        viewName: "research",
        description: "Research / intel view.",
        getState: () => ({ ready: !!host.researchState, state: host.researchState }),
        describeActions: () => [],
        dispatch: async () => ({ ok: false, error: "research view: read-only for now" }),
    }));

    /* ─── agents (management) ─────────────────────────────────────── */
    registered.push(attachViewController({
        viewName: "agents",
        description:
            "Agent management: list of agents, currently selected, edit dialog. Includes the AgentManagement modal.",
        getState: () => ({
            loading: host.agentsLoading,
            error: host.agentsError,
            agentCount: safe(() => host.agentsList?.agents?.length ?? 0, 0),
            agents: safe(
                () => host.agentsList?.agents?.slice(0, 30).map((a) => ({
                    id: (a as unknown as { id: string }).id,
                    name: (a as unknown as { name?: string }).name,
                    role: (a as unknown as { role?: string }).role,
                })) ?? [],
                [],
            ),
            assistantAgentId: host.assistantAgentId,
            management: host.agentsManagementState ? {
                selectedAgentId: host.agentsManagementState.selectedAgentId,
                isDirty: host.agentsManagementState.isDirty,
                showCreateDialog: host.agentsManagementState.showCreateDialog,
            } : null,
        }),
        describeActions: () => [
            { type: "refresh", doc: "Load the agents list and warm the management modal state. Safe to call before any other agents action — it lazy-initializes the management slice that the other actions depend on." },
            { type: "select_agent", args: { agentId: "string" }, doc: "Select agent in management modal." },
            { type: "open_create_dialog", doc: "Open the create-agent dialog." },
            { type: "close_create_dialog", doc: "Close the create-agent dialog." },
        ],
        dispatch: async (action) => {
            const a = action as Record<string, unknown>;
            // Auto-init: the agents management slice only existed when the
            // user manually opened the Agents tab. The agent has no way to
            // know that, so we lazy-init here. loadAgentsList itself fills
            // host.agentsManagementState if it's missing.
            if (!host.agentsManagementState && host.client) {
                try {
                    await agentsMgmtCtrl.loadAgentsList(host, host.client);
                } catch (err) {
                    return {
                        ok: false,
                        error: `agents auto-init failed: ${(err as Error).message ?? String(err)}`,
                    };
                }
            }
            if (!host.agentsManagementState) {
                return {
                    ok: false,
                    error: "agents management not initialized and no gateway client available to initialize it. Connect the UI first.",
                };
            }
            switch (a.type) {
                case "refresh": {
                    if (!host.client) return { ok: false, error: "no gateway client" };
                    await agentsMgmtCtrl.loadAgentsList(host, host.client);
                    return {
                        ok: true,
                        result: {
                            count: host.agentsManagementState.agents?.length ?? 0,
                            selectedAgentId: host.agentsManagementState.selectedAgentId,
                        },
                    };
                }
                case "select_agent":
                    host.agentsManagementState.selectedAgentId = a.agentId as string;
                    (host as unknown as { requestUpdate?: () => void }).requestUpdate?.();
                    return { ok: true };
                case "open_create_dialog":
                    host.agentsManagementState.showCreateDialog = true;
                    (host as unknown as { requestUpdate?: () => void }).requestUpdate?.();
                    return { ok: true };
                case "close_create_dialog":
                    host.agentsManagementState.showCreateDialog = false;
                    (host as unknown as { requestUpdate?: () => void }).requestUpdate?.();
                    return { ok: true };
            }
            return { ok: false, error: `unknown action: ${a.type}` };
        },
    }));

    /* ─── federation ──────────────────────────────────────────────── */
    registered.push(attachViewController({
        viewName: "federation",
        description: "Federation: connected nodes, pairing state, master/satellite topology.",
        getState: () => ({
            nodesLoading: host.nodesLoading,
            nodes: host.nodes?.slice(0, 30) ?? [],
            ready: !!host.federationState,
        }),
        describeActions: () => [
            { type: "refresh_nodes", doc: "Re-list federation nodes." },
        ],
        dispatch: async (action) => {
            const a = action as Record<string, unknown>;
            const client = reqClient(host);
            switch (a.type) {
                case "refresh_nodes": {
                    const r = await client.request("federation.nodes.list", {});
                    host.nodes = (r as { nodes?: Array<Record<string, unknown>> }).nodes ?? [];
                    (host as unknown as { requestUpdate?: () => void }).requestUpdate?.();
                    return { ok: true, result: { count: host.nodes.length } };
                }
            }
            return { ok: false, error: `unknown action: ${a.type}` };
        },
    }));

    /* ─── business / business-workspace ───────────────────────────── */
    registered.push(attachViewController({
        viewName: "business",
        description: "Business command center / workspace: businesses, summary cards, KPIs.",
        getState: () => ({
            ready: !!host.businessState,
            businesses: safe(
                () => (host.businessState as { businesses?: Array<{ id: string; name: string }> } | null)?.businesses?.slice(0, 20) ?? [],
                [],
            ),
        }),
        describeActions: () => [
            { type: "refresh", doc: "Reload business state." },
        ],
        dispatch: async (action) => {
            const a = action as Record<string, unknown>;
            const client = reqClient(host);
            switch (a.type) {
                case "refresh": {
                    const r = await client.request("business.list", {});
                    return { ok: true, result: r };
                }
            }
            return { ok: false, error: `unknown action: ${a.type}` };
        },
    }));

    /* ─── clients (CRM page) ──────────────────────────────────────────
     * The clients tab has its OWN viewMode (grid/table/kanban) that lives
     * on cs.viewMode, separate from the generic databases.view. Before
     * this controller existed, an agent had to fall back to page.click_text
     * to flip view modes and there was no first-class "add a client" verb
     * — callers either prefilled cs.formData via the dialog or wrote rows
     * into the underlying database directly. Both were fragile. Expose
     * the page's actual capabilities so voice flows ("show clients in
     * kanban", "add this lead") don't depend on DOM hunting.
     */
    registered.push(attachViewController({
        viewName: "clients",
        description:
            "Clients CRM page: list/filter clients, switch grid/table/kanban view, add/update/delete a client, open the detail panel. Operates on the page's own state (cs.viewMode etc.) — distinct from the generic databases view that also renders the underlying CRM database.",
        getState: () => {
            const cs = (host.businessState as { _clientsState?: Record<string, unknown> } | null)?._clientsState ?? null;
            if (!cs) return { ready: false };
            return {
                ready: true,
                viewMode: cs.viewMode as string | undefined,
                kanbanGroupBy: cs.kanbanGroupBy as string | undefined,
                clientCount: Array.isArray(cs.clients) ? (cs.clients as unknown[]).length : 0,
                selectedClientId: cs.selectedClientId as string | null | undefined,
                searchQuery: cs.searchQuery as string | undefined,
                filterStatus: cs.filterStatus as string | undefined,
                filterTags: cs.filterTags as string[] | undefined,
                showCreateDialog: cs.showCreateDialog as boolean | undefined,
                showEditDialog: cs.showEditDialog as boolean | undefined,
                showDetailPanel: cs.showDetailPanel as boolean | undefined,
                schemaTitleProperty: (() => {
                    const schema = cs.schema as { properties?: Array<{ name: string; type: string }> } | null;
                    return schema?.properties?.find((p) => p.type === "title")?.name ?? null;
                })(),
            };
        },
        describeActions: () => [
            { type: "refresh", doc: "Re-fetch the clients list from the active business's CRM." },
            {
                type: "set_view_mode",
                args: { mode: "'grid'|'table'|'kanban'" },
                doc: "Switch the clients page renderer. This is the right verb for \"show CRM as a board\" — the generic databases.set_view does NOT drive the clients page (it has its own viewMode).",
            },
            {
                type: "set_kanban_group_by",
                args: { propertyName: "string (column property name from schema)" },
                doc: "Pick which property the kanban view groups by (e.g. \"Status\"). No-op in grid/table modes.",
            },
            {
                type: "set_search",
                args: { query: "string" },
                doc: "Set the page's search filter.",
            },
            {
                type: "set_filter_status",
                args: { status: "string ('' for all)" },
                doc: "Filter the visible clients by status value.",
            },
            {
                type: "set_filter_tags",
                args: { tags: "string[]" },
                doc: "Set the active tag filters (multi-select). Pass [] to clear.",
            },
            {
                type: "set_sort",
                args: { sortBy: "string", sortDir: "'asc'|'desc'" },
                doc: "Set the sort column and direction.",
            },
            {
                type: "add_client",
                args: { data: "object<propertyName, value> — title prop required (usually \"Name\")" },
                doc: "Create a client via the active business's CRM. Data keys match the schema property names (e.g. {Name, Email, Phone, Status, Tags}). Goes straight to business.clients.create — no dialog round-trip.",
            },
            {
                type: "add_clients",
                args: { records: "Array<object<propertyName, value>>" },
                doc: "Bulk-create clients via business.clients.create. Use this for CSV / Maps-scrape imports so the rows land in the business scope and become visible on the Clients page (unlike databases.create_rows which only writes the raw db).",
            },
            {
                type: "update_client",
                args: { id: "string", data: "partial object<propertyName, value>" },
                doc: "Patch a client's fields. Same key shape as add_client.",
            },
            {
                type: "set_client_property",
                args: { id: "string", property: "string", value: "any" },
                doc: "Inline edit one property on one client (optimistic, reverts on failure).",
            },
            {
                type: "delete_client",
                args: { id: "string" },
                doc: "Delete a client (irreversible).",
            },
            {
                type: "open_delete_confirm",
                args: { id: "string" },
                doc: "Open the delete-confirm modal for a client (UI-only; doesn't delete).",
            },
            { type: "close_delete_confirm", doc: "Close the delete-confirm modal." },
            {
                type: "open_create_dialog",
                doc: "Open the empty 'new client' dialog (UI-only; use add_client to skip the dialog).",
            },
            { type: "close_create_dialog", doc: "Close the new-client dialog." },
            {
                type: "open_edit_dialog",
                args: { id: "string" },
                doc: "Open the edit-client dialog populated with the given client.",
            },
            { type: "close_edit_dialog", doc: "Close the edit-client dialog." },
            {
                type: "open_detail",
                args: { id: "string" },
                doc: "Open the right-side detail panel for a client.",
            },
            { type: "close_detail", doc: "Close the detail panel." },
            {
                type: "set_detail_tab",
                args: { tab: "'overview'|'properties'|'docs'|'relations'|'activity'" },
                doc: "Switch the detail panel's active tab (relations lazy-loads peer lists when opened).",
            },
            {
                type: "set_docs_draft",
                args: { body: "string" },
                doc: "Set the markdown draft for the detail panel's Docs tab without saving.",
            },
            { type: "save_docs", doc: "Persist the Docs draft to the client record." },
            {
                type: "link_peer",
                args: { peerType: "'project'|'note'|'workflow'", peerId: "string" },
                doc: "Link the open detail client to another record (project / note / workflow).",
            },
            {
                type: "unlink_peer",
                args: { peerType: "'project'|'note'|'workflow'", peerId: "string" },
                doc: "Remove a peer relation from the open detail client.",
            },
            {
                type: "open_relation_picker",
                args: { peerType: "'project'|'note'|'workflow'" },
                doc: "Open the relation picker for a specific peer type (UI-only).",
            },
            { type: "close_relation_picker", doc: "Close the relation picker." },
            {
                type: "set_relation_picker_query",
                args: { query: "string" },
                doc: "Filter the relation picker list.",
            },
            { type: "open_import_dialog", doc: "Open the CSV / JSON / vCard import dialog." },
            { type: "close_import_dialog", doc: "Close the import dialog." },
            {
                type: "set_import_format",
                args: { format: "'csv'|'json'|'vcard'" },
                doc: "Pick the import format before pasting / running.",
            },
            {
                type: "set_import_data",
                args: { text: "string" },
                doc: "Set the raw text to import (CSV / JSON / vCard).",
            },
            {
                type: "run_import",
                doc: "Execute the import using the staged format + data; populates importLastResult on the state.",
            },
            {
                type: "create_notion_crm_database",
                doc: "Create a fresh Notion CRM database for the active business and connect it.",
            },
            {
                type: "connect_notion_from_url",
                args: { url: "string (Notion database URL)" },
                doc: "Pair the active business's CRM with an existing Notion database by URL.",
            },
            {
                type: "connect_notion_database",
                args: { databaseId: "string" },
                doc: "Pair the active business's CRM with a Notion database by id.",
            },
            { type: "disconnect_notion", doc: "Unlink the Notion CRM database." },
            { type: "sync_to_notion", doc: "Push pending client changes to the connected Notion CRM." },
            { type: "import_from_notion", doc: "Pull rows from the connected Notion CRM into local clients." },
        ],
        dispatch: async (action) => {
            const a = action as Record<string, unknown>;
            const client = reqClient(host);
            const requestUpdate = () => (host as unknown as { requestUpdate?: () => void }).requestUpdate?.();
            const cs = (host.businessState as { _clientsState?: Record<string, unknown> } | null)?._clientsState ?? null;
            if (!cs && a.type !== "refresh") {
                return { ok: false, error: "clients state not initialized — switch to the Clients tab first or call refresh" };
            }
            const businessId =
                (host.businessState as { activeBusinessId?: string | null } | null)?.activeBusinessId ?? null;
            switch (a.type) {
                case "refresh": {
                    const r = await client.request("business.clients.list", { businessId });
                    requestUpdate();
                    return { ok: true, result: r };
                }
                case "set_view_mode": {
                    const mode = (a.mode as string | undefined) ?? "";
                    if (!["grid", "table", "kanban"].includes(mode)) {
                        return { ok: false, error: `unknown mode "${mode}". Valid: grid, table, kanban` };
                    }
                    (cs as Record<string, unknown>).viewMode = mode;
                    requestUpdate();
                    return { ok: true, result: { viewMode: mode } };
                }
                case "set_kanban_group_by": {
                    const propertyName = (a.propertyName as string | undefined) ?? "";
                    if (!propertyName) return { ok: false, error: "propertyName required" };
                    (cs as Record<string, unknown>).kanbanGroupBy = propertyName;
                    requestUpdate();
                    return { ok: true };
                }
                case "set_search": {
                    (cs as Record<string, unknown>).searchQuery = (a.query as string | undefined) ?? "";
                    requestUpdate();
                    return { ok: true };
                }
                case "set_filter_status": {
                    (cs as Record<string, unknown>).filterStatus = (a.status as string | undefined) ?? "";
                    requestUpdate();
                    return { ok: true };
                }
                case "add_client": {
                    const data = (a.data as Record<string, unknown> | undefined) ?? {};
                    const res = await client.request("business.clients.create", { businessId, data });
                    const created = (res as { client?: { id?: string } } | null)?.client ?? null;
                    if (created && Array.isArray((cs as Record<string, unknown>).clients)) {
                        ((cs as Record<string, unknown>).clients as unknown[]).push(created);
                        requestUpdate();
                    }
                    return { ok: true, result: res };
                }
                case "update_client": {
                    const id = a.id as string | undefined;
                    if (!id) return { ok: false, error: "id required" };
                    const data = (a.data as Record<string, unknown> | undefined) ?? {};
                    const res = await client.request("business.clients.update", { businessId, id, data });
                    const updated = (res as { client?: { id: string } } | null)?.client ?? null;
                    if (updated && Array.isArray((cs as Record<string, unknown>).clients)) {
                        const list = (cs as Record<string, unknown>).clients as Array<{ id: string }>;
                        const idx = list.findIndex((c) => c.id === updated.id);
                        if (idx >= 0) list[idx] = updated as { id: string };
                        requestUpdate();
                    }
                    return { ok: true, result: res };
                }
                case "delete_client": {
                    const id = a.id as string | undefined;
                    if (!id) return { ok: false, error: "id required" };
                    await client.request("business.clients.delete", { businessId, id });
                    if (Array.isArray((cs as Record<string, unknown>).clients)) {
                        (cs as Record<string, unknown>).clients = (
                            (cs as Record<string, unknown>).clients as Array<{ id: string }>
                        ).filter((c) => c.id !== id);
                        requestUpdate();
                    }
                    return { ok: true };
                }
                case "open_detail": {
                    const id = a.id as string | undefined;
                    if (!id) return { ok: false, error: "id required" };
                    (cs as Record<string, unknown>).selectedClientId = id;
                    (cs as Record<string, unknown>).showDetailPanel = true;
                    const found = Array.isArray((cs as Record<string, unknown>).clients)
                        ? (((cs as Record<string, unknown>).clients as Array<{ id: string }>) ?? []).find(
                              (c) => c.id === id,
                          )
                        : null;
                    if (found) (cs as Record<string, unknown>).detailClient = found;
                    requestUpdate();
                    return { ok: true };
                }
                case "close_detail": {
                    clientsCtrl.closeClientDetail(host);
                    return { ok: true };
                }
                case "set_filter_tags": {
                    const tags = Array.isArray(a.tags) ? (a.tags as unknown[]).map(String) : [];
                    (cs as Record<string, unknown>).filterTags = tags;
                    requestUpdate();
                    return { ok: true };
                }
                case "set_sort": {
                    const sortBy = (a.sortBy as string | undefined) ?? "";
                    const sortDir = a.sortDir === "desc" ? "desc" : "asc";
                    if (sortBy) (cs as Record<string, unknown>).sortBy = sortBy;
                    (cs as Record<string, unknown>).sortDir = sortDir;
                    requestUpdate();
                    return { ok: true };
                }
                case "add_clients": {
                    const records = Array.isArray(a.records)
                        ? (a.records as Array<Record<string, unknown>>)
                        : null;
                    if (!records) return { ok: false, error: "records[] required" };
                    const created: Array<{ id: string }> = [];
                    for (const data of records) {
                        const res = await client.request("business.clients.create", { businessId, data });
                        const c = (res as { client?: { id?: string } } | null)?.client ?? null;
                        if (c?.id) {
                            created.push(c as { id: string });
                            const list = (cs as Record<string, unknown>).clients;
                            if (Array.isArray(list)) (list as unknown[]).push(c);
                        }
                    }
                    requestUpdate();
                    return { ok: true, result: { created: created.length, ids: created.map((x) => x.id) } };
                }
                case "set_client_property": {
                    const id = a.id as string | undefined;
                    const property = a.property as string | undefined;
                    if (!id || !property) return { ok: false, error: "id and property required" };
                    const value = a.value as unknown;
                    const ok = await clientsCtrl.setClientProperty(host, client, id, property, value);
                    return ok ? { ok: true } : { ok: false, error: "setClientProperty failed (see clients state error)" };
                }
                case "open_delete_confirm": {
                    const id = a.id as string | undefined;
                    if (!id) return { ok: false, error: "id required" };
                    (cs as Record<string, unknown>).showDeleteConfirm = id;
                    requestUpdate();
                    return { ok: true };
                }
                case "close_delete_confirm": {
                    (cs as Record<string, unknown>).showDeleteConfirm = null;
                    requestUpdate();
                    return { ok: true };
                }
                case "open_create_dialog": {
                    (cs as Record<string, unknown>).showCreateDialog = true;
                    (cs as Record<string, unknown>).formData = {};
                    requestUpdate();
                    return { ok: true };
                }
                case "close_create_dialog": {
                    (cs as Record<string, unknown>).showCreateDialog = false;
                    (cs as Record<string, unknown>).formData = {};
                    requestUpdate();
                    return { ok: true };
                }
                case "open_edit_dialog": {
                    const id = a.id as string | undefined;
                    if (!id) return { ok: false, error: "id required" };
                    const list = (cs as Record<string, unknown>).clients as Array<{ id: string; data?: Record<string, unknown> }> | undefined;
                    const target = list?.find((c) => c.id === id) ?? null;
                    if (!target) return { ok: false, error: `client ${id} not in loaded list` };
                    (cs as Record<string, unknown>).editingClient = target;
                    (cs as Record<string, unknown>).formData = { ...(target.data ?? {}) };
                    (cs as Record<string, unknown>).showEditDialog = true;
                    requestUpdate();
                    return { ok: true };
                }
                case "close_edit_dialog": {
                    (cs as Record<string, unknown>).showEditDialog = false;
                    (cs as Record<string, unknown>).editingClient = null;
                    (cs as Record<string, unknown>).formData = {};
                    requestUpdate();
                    return { ok: true };
                }
                case "set_detail_tab": {
                    const tab = a.tab as string | undefined;
                    const valid = new Set(["overview", "properties", "docs", "relations", "activity"]);
                    if (!tab || !valid.has(tab)) return { ok: false, error: `tab required; one of ${[...valid].join(", ")}` };
                    clientsCtrl.setDetailTab(host, client, tab as never);
                    return { ok: true };
                }
                case "set_docs_draft": {
                    const body = (a.body as string | undefined) ?? "";
                    clientsCtrl.setDocsDraft(host, body);
                    return { ok: true };
                }
                case "save_docs": {
                    const ok = await clientsCtrl.saveDocs(host, client);
                    return ok ? { ok: true } : { ok: false, error: "saveDocs failed (see clients state error)" };
                }
                case "link_peer": {
                    const peerType = a.peerType as string | undefined;
                    const peerId = a.peerId as string | undefined;
                    if (!peerType || !peerId) return { ok: false, error: "peerType and peerId required" };
                    await clientsCtrl.linkClientPeer(host, client, peerType as never, peerId);
                    return { ok: true };
                }
                case "unlink_peer": {
                    const peerType = a.peerType as string | undefined;
                    const peerId = a.peerId as string | undefined;
                    if (!peerType || !peerId) return { ok: false, error: "peerType and peerId required" };
                    await clientsCtrl.unlinkClientPeer(host, client, peerType as never, peerId);
                    return { ok: true };
                }
                case "open_relation_picker": {
                    const peerType = a.peerType as string | undefined;
                    if (!peerType) return { ok: false, error: "peerType required" };
                    clientsCtrl.setRelationPickerOpen(host, peerType as never);
                    return { ok: true };
                }
                case "close_relation_picker": {
                    clientsCtrl.setRelationPickerOpen(host, null);
                    return { ok: true };
                }
                case "set_relation_picker_query": {
                    clientsCtrl.setRelationPickerQuery(host, (a.query as string | undefined) ?? "");
                    return { ok: true };
                }
                case "open_import_dialog": {
                    (cs as Record<string, unknown>).showImportDialog = true;
                    requestUpdate();
                    return { ok: true };
                }
                case "close_import_dialog": {
                    (cs as Record<string, unknown>).showImportDialog = false;
                    requestUpdate();
                    return { ok: true };
                }
                case "set_import_format": {
                    const format = a.format as string | undefined;
                    if (!["csv", "json", "vcard"].includes(format ?? "")) {
                        return { ok: false, error: "format must be csv|json|vcard" };
                    }
                    (cs as Record<string, unknown>).importFormat = format as never;
                    requestUpdate();
                    return { ok: true };
                }
                case "set_import_data": {
                    (cs as Record<string, unknown>).importDataText = (a.text as string | undefined) ?? "";
                    requestUpdate();
                    return { ok: true };
                }
                case "run_import": {
                    const format = (cs as Record<string, unknown>).importFormat as "csv" | "json" | "vcard" | undefined;
                    const text = ((cs as Record<string, unknown>).importDataText as string | undefined) ?? "";
                    if (!format) return { ok: false, error: "no import format staged — call set_import_format first" };
                    const ok = await clientsCtrl.importClientsFromText(host, client, format, text);
                    return ok
                        ? { ok: true, result: (cs as Record<string, unknown>).importLastResult }
                        : { ok: false, error: "importClientsFromText failed (see clients state error)" };
                }
                case "create_notion_crm_database": {
                    const ok = await clientsCtrl.createNotionCrmDatabase(host, client);
                    return ok ? { ok: true } : { ok: false, error: "createNotionCrmDatabase failed" };
                }
                case "connect_notion_from_url": {
                    const url = a.url as string | undefined;
                    if (!url) return { ok: false, error: "url required" };
                    (cs as Record<string, unknown>).notionDbUrl = url;
                    const ok = await clientsCtrl.connectNotionFromUrl(host, client);
                    return ok ? { ok: true } : { ok: false, error: "connectNotionFromUrl failed" };
                }
                case "connect_notion_database": {
                    const dbId = a.databaseId as string | undefined;
                    if (!dbId) return { ok: false, error: "databaseId required" };
                    const ok = await clientsCtrl.connectNotionCrmDatabase(host, client, dbId);
                    return ok ? { ok: true } : { ok: false, error: "connectNotionCrmDatabase failed" };
                }
                case "disconnect_notion": {
                    await clientsCtrl.disconnectNotionCrmDatabase(host, client);
                    return { ok: true };
                }
                case "sync_to_notion": {
                    const ok = await clientsCtrl.syncClientsToNotion(host, client);
                    return ok ? { ok: true } : { ok: false, error: "syncClientsToNotion failed" };
                }
                case "import_from_notion": {
                    const ok = await clientsCtrl.importClientsFromNotion(host, client);
                    return ok ? { ok: true } : { ok: false, error: "importClientsFromNotion failed" };
                }
            }
            return { ok: false, error: `unknown action: ${a.type}` };
        },
    }));

    /* ─── characters ──────────────────────────────────────────────── */
    registered.push(attachViewController({
        viewName: "characters",
        description: "Character profiles (TTS voice, system prompt persona).",
        getState: () => ({
            // characters state is stored via voice-settings.json; expose a hint
            assistantName: host.assistantName,
        }),
        describeActions: () => [],
        dispatch: async () => ({ ok: false, error: "characters: read-only for now (use the Settings panel)" }),
    }));

    /* ─── vault ───────────────────────────────────────────────────── */
    registered.push(attachViewController({
        viewName: "vault",
        description: "Vault dashboard (community / member management).",
        getState: () => ({ ready: !!host.vaultState }),
        describeActions: () => [],
        dispatch: async () => ({ ok: false, error: "vault: read-only for now" }),
    }));

    /* ─── funnels ─────────────────────────────────────────────────── */
    registered.push(attachViewController({
        viewName: "funnels",
        description: "Funnels canvas (lead capture / automation flows).",
        getState: () => ({}),
        describeActions: () => [],
        dispatch: async () => ({ ok: false, error: "funnels: read-only for now" }),
    }));

    /* ─── settings ────────────────────────────────────────────────── */
    registered.push(attachViewController({
        viewName: "settings",
        description: "Settings tab / panel — config form, raw config, sub-section nav.",
        getState: () => ({
            loading: host.configLoading,
            saving: host.configSaving,
            applying: host.configApplying,
            mode: host.configFormMode,
            search: host.configSearchQuery,
            activeSection: host.configActiveSection,
            activeSubsection: host.configActiveSubsection,
            dirty: host.configFormDirty,
            valid: host.configValid,
        }),
        describeActions: () => [
            { type: "switch_mode", args: { mode: "'form'|'raw'" }, doc: "Switch between form and raw JSON modes." },
            { type: "set_active_section", args: { section: "string" }, doc: "Navigate to a config section." },
            { type: "set_search", args: { query: "string" }, doc: "Filter settings by search." },
        ],
        dispatch: async (action) => {
            const a = action as Record<string, unknown>;
            switch (a.type) {
                case "switch_mode":
                    host.configFormMode = (a.mode as "form" | "raw") ?? "form";
                    (host as unknown as { requestUpdate?: () => void }).requestUpdate?.();
                    return { ok: true };
                case "set_active_section":
                    host.configActiveSection = a.section as string | null;
                    (host as unknown as { requestUpdate?: () => void }).requestUpdate?.();
                    return { ok: true };
                case "set_search":
                    host.configSearchQuery = (a.query as string) ?? "";
                    (host as unknown as { requestUpdate?: () => void }).requestUpdate?.();
                    return { ok: true };
            }
            return { ok: false, error: `unknown action: ${a.type}` };
        },
    }));

    /* ─── workspace: per-project IDE ──────────────────────────────── */
    {
        // Lazy import — workspace controller is only needed when the tab is active.
        let wsCtrl: typeof import("./controllers/workspace") | null = null;
        const getWsCtrl = async () => {
            if (!wsCtrl) wsCtrl = await import("./controllers/workspace");
            return wsCtrl;
        };
        registered.push(attachViewController({
            viewName: "workspace",
            description:
                "Per-project IDE. File tree, code editor, live preview, Claude Coder chat. Supports multiple project modes: web, app, document, pdf, presentation.",
            getState: () => safe(() => {
                // Only expose ws state when the workspace tab is active.
                const wsMod = wsCtrl;
                if (!wsMod) return { loaded: false };
                const ws = wsMod.getWorkspaceState(host);
                return {
                    loaded: true,
                    selectedWorkspace: ws.workspaces.find((w) => w.id === ws.selectedId) ?? null,
                    workspaceCount: ws.workspaces.length,
                    projectMode: ws.projectMode,
                    viewMode: ws.viewMode,
                    activeFile: ws.activeTabPath,
                    openFiles: ws.tabs.map((t) => ({ path: t.path, name: t.name, dirty: t.dirty })),
                    slideIndex: ws.slideIndex,
                    coderRunning: ws.coderRunning,
                    workflowRunning: ws.workflowRunning,
                };
            }, { loaded: false }),
            describeActions: () => [
                { type: "set_project_mode", args: { mode: "web | app | document | pdf | presentation" }, doc: "Switch the workspace project mode." },
                { type: "set_view_mode", args: { mode: "files | code | diff | preview" }, doc: "Switch the center-pane view mode." },
                { type: "open_file", args: { path: "Absolute path to open." }, doc: "Open a file in the editor." },
                { type: "send_coder", args: { message: "Task description for Claude Coder." }, doc: "Send a message to the Claude Coder chat panel and kick off a run." },
                { type: "run_workflow", args: { workflowId: "Workflow id to run against this workspace." }, doc: "Run a workflow against the current workspace and stream the result into chat." },
                { type: "add_preview_pane", args: { renderer: "web | markdown | pdf | slides", label: "Display label." }, doc: "Open a second preview pane beside the editor." },
                { type: "remove_preview_pane", doc: "Close the secondary preview pane." },
            ],
            dispatch: async (action) => {
                const a = action as Record<string, unknown>;
                const ctrl = await getWsCtrl();
                const client_ = safe(() => reqClient(host), null);
                const ws = ctrl.getWorkspaceState(host);
                switch (a.type) {
                    case "set_project_mode": {
                        const mode = a.mode as string | undefined;
                        if (!["web", "app", "document", "pdf", "presentation"].includes(mode ?? "")) {
                            return { ok: false, error: "mode must be one of: web, app, document, pdf, presentation" };
                        }
                        ctrl.setProjectMode(host, mode as import("./controllers/workspace").ProjectMode);
                        return { ok: true, result: { projectMode: ws.projectMode } };
                    }
                    case "set_view_mode": {
                        const mode = a.mode as string | undefined;
                        if (!["files", "code", "diff", "preview"].includes(mode ?? "")) {
                            return { ok: false, error: "mode must be one of: files, code, diff, preview" };
                        }
                        ctrl.setViewMode(host, mode as import("./controllers/workspace").WorkspaceViewMode);
                        return { ok: true, result: { viewMode: ws.viewMode } };
                    }
                    case "open_file": {
                        const path_ = (a.path as string | undefined ?? "").trim();
                        if (!path_) return { ok: false, error: "path required" };
                        if (!client_) return { ok: false, error: "gateway client not connected" };
                        await ctrl.openFile(host, client_, path_);
                        return { ok: true, result: { activeFile: ws.activeTabPath } };
                    }
                    case "send_coder": {
                        const msg = (a.message as string | undefined ?? "").trim();
                        if (!msg) return { ok: false, error: "message required" };
                        if (!client_) return { ok: false, error: "gateway client not connected" };
                        ctrl.setCoderInput(host, msg);
                        await ctrl.sendCoder(host, client_);
                        return { ok: true, result: { running: ws.coderRunning } };
                    }
                    case "run_workflow": {
                        const wfId = (a.workflowId as string | undefined ?? "").trim();
                        if (!wfId) return { ok: false, error: "workflowId required" };
                        if (!client_) return { ok: false, error: "gateway client not connected" };
                        await ctrl.runWorkflowInChat(host, client_, wfId);
                        return { ok: true };
                    }
                    case "add_preview_pane": {
                        const renderer = (a.renderer as string | undefined) ?? "web";
                        const label = (a.label as string | undefined) ?? renderer;
                        ctrl.addPreviewPane(host, renderer as import("./controllers/workspace").PreviewPane["renderer"], label);
                        return { ok: true };
                    }
                    case "remove_preview_pane": {
                        const pane = ws.previewPanes[0];
                        if (pane) ctrl.removePreviewPane(host, pane.id);
                        return { ok: true };
                    }
                }
                return { ok: false, error: `unknown action: ${a.type}` };
            },
        }));
    }
}
