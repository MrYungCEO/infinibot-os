/**
 * overlay-highlight.ts — transient "gold pill" text highlighter.
 *
 * Walks the live DOM, finds runs of text matching a query (case-insensitive),
 * builds a DOM Range over each match and paints an absolutely-positioned gold
 * pill over its client rects. Pills are appended to a single fixed-position
 * light-DOM container (NOT a shadow root) so they float above every surface and
 * can be measured against page geometry. Each highlight auto-clears after a
 * timeout. Highlights are effects, never persisted.
 *
 * Wired to voice + chat streams via the `overlay.events` topic (kind:'highlight'),
 * and usable standalone from devtools.
 */

export type HighlightSpec = {
  /** caller-supplied id; one logical highlight may paint many pills */
  id?: string;
  query: string;
  /** any CSS color; defaults to the gold token */
  color?: string;
  /** auto-clear delay; default 2600ms */
  durationMs?: number;
  /** CSS selector to scope the search; default = document body */
  scope?: string;
};

type ActiveHighlight = {
  id: string;
  pills: HTMLElement[];
  timer: number | null;
};

const CONTAINER_ID = "infinibot-overlay-highlight-layer";
const DEFAULT_DURATION = 2600;
const MAX_MATCHES = 60; // safety cap so a 1-char query can't paint thousands

let SEQ = 0;
const nextId = () => `hl-${Date.now().toString(36)}-${(SEQ++).toString(36)}`;

export class OverlayHighlightController {
  private container: HTMLElement | null = null;
  private active = new Map<string, ActiveHighlight>();

  private ensureContainer(): HTMLElement {
    let el = document.getElementById(CONTAINER_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = CONTAINER_ID;
      Object.assign(el.style, {
        position: "fixed",
        inset: "0",
        pointerEvents: "none",
        zIndex: "2147483646", // just under max so cards/modals can still go above
        contain: "strict",
      } as CSSStyleDeclaration);
      document.body.appendChild(el);
    }
    this.container = el;
    return el;
  }

  /** Paint pills for every visible match of `spec.query`. Returns the id. */
  paint(spec: HighlightSpec): string {
    const id = spec.id || nextId();
    const query = (spec.query ?? "").trim();
    if (!query) return id;

    // Re-painting the same id replaces its pills.
    this.clear(id);

    const ranges = this.findRanges(query, spec.scope);
    if (!ranges.length) {
      // Nothing to paint; still register so a later clear(id) is a no-op match.
      this.active.set(id, { id, pills: [], timer: null });
      return id;
    }

    const container = this.ensureContainer();
    const color = spec.color || "var(--g-primary, #fbbf24)";
    const pills: HTMLElement[] = [];
    for (const range of ranges) {
      const rects = Array.from(range.getClientRects());
      for (const rect of rects) {
        if (rect.width < 1 || rect.height < 1) continue;
        const pill = document.createElement("div");
        pill.className = "infinibot-overlay-highlight-pill";
        Object.assign(pill.style, {
          position: "fixed",
          left: `${rect.left - 3}px`,
          top: `${rect.top - 2}px`,
          width: `${rect.width + 6}px`,
          height: `${rect.height + 4}px`,
          borderRadius: "6px",
          background: `color-mix(in srgb, ${color} 22%, transparent)`,
          boxShadow: `0 0 0 1px color-mix(in srgb, ${color} 55%, transparent), 0 0 14px color-mix(in srgb, ${color} 45%, transparent)`,
          pointerEvents: "none",
          opacity: "0",
          transform: "scale(0.96)",
          transition: "opacity 160ms ease, transform 220ms cubic-bezier(.2,.9,.3,1.4)",
        } as CSSStyleDeclaration);
        container.appendChild(pill);
        pills.push(pill);
      }
    }
    // Animate in on the next frame.
    requestAnimationFrame(() => {
      for (const p of pills) {
        p.style.opacity = "1";
        p.style.transform = "scale(1)";
      }
    });

    const durationMs = spec.durationMs ?? DEFAULT_DURATION;
    const timer =
      durationMs > 0 ? window.setTimeout(() => this.fadeAndClear(id), durationMs) : null;
    this.active.set(id, { id, pills, timer });
    return id;
  }

  /** Clear one highlight (by id) or all when id is omitted. */
  clear(id?: string) {
    if (id == null) {
      for (const key of [...this.active.keys()]) this.removeNow(key);
      return;
    }
    this.removeNow(id);
  }

  private fadeAndClear(id: string) {
    const h = this.active.get(id);
    if (!h) return;
    for (const p of h.pills) {
      p.style.opacity = "0";
      p.style.transform = "scale(0.96)";
    }
    window.setTimeout(() => this.removeNow(id), 200);
  }

  private removeNow(id: string) {
    const h = this.active.get(id);
    if (!h) return;
    if (h.timer != null) window.clearTimeout(h.timer);
    for (const p of h.pills) p.remove();
    this.active.delete(id);
    if (this.active.size === 0 && this.container && !this.container.childElementCount) {
      this.container.remove();
      this.container = null;
    }
  }

  // ── range matching ────────────────────────────────────────────────────
  private findRanges(query: string, scope?: string): Range[] {
    const root: ParentNode =
      (scope && (document.querySelector(scope) as ParentNode | null)) || document.body;
    const needle = query.toLowerCase();
    const ranges: Range[] = [];

    const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const text = node.nodeValue;
        if (!text || !text.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT")
          return NodeFilter.FILTER_REJECT;
        // Skip our own highlight container.
        if (parent.closest(`#${CONTAINER_ID}`)) return NodeFilter.FILTER_REJECT;
        return text.toLowerCase().includes(needle)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });

    let node = walker.nextNode();
    while (node && ranges.length < MAX_MATCHES) {
      const text = node.nodeValue ?? "";
      const lower = text.toLowerCase();
      let from = lower.indexOf(needle);
      while (from !== -1 && ranges.length < MAX_MATCHES) {
        const range = document.createRange();
        range.setStart(node, from);
        range.setEnd(node, from + needle.length);
        ranges.push(range);
        from = lower.indexOf(needle, from + needle.length);
      }
      node = walker.nextNode();
    }
    return ranges;
  }
}
