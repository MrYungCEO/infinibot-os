/**
 * Resolve walkthrough targets against the live DOM.
 *
 * The control UI is a tree of Lit elements, many with open shadow roots, so a
 * plain `document.querySelector` misses most of the app. `deepQueryAll` walks
 * every open shadow root. `learn:<id>` targets expand to
 * `[data-learn-id="<id>"]` (see src/learn/guided/types.ts `expandTarget`).
 */

import { expandTarget, type LearnTarget } from "../../../../src/learn/guided/types.js";

type Root = Document | ShadowRoot | Element;

/** Every open shadow root under `root` (including nested ones). */
function shadowRoots(root: Root, out: ShadowRoot[] = []): ShadowRoot[] {
  const start = root instanceof Document ? root.documentElement : root;
  if (!start) return out;
  const walker = document.createTreeWalker(start, NodeFilter.SHOW_ELEMENT);
  let node: Node | null = walker.currentNode;
  while (node) {
    const sr = (node as Element).shadowRoot;
    if (sr) {
      out.push(sr);
      shadowRoots(sr, out);
    }
    node = walker.nextNode();
  }
  return out;
}

export function deepQueryAll(selector: string, root: Root = document): Element[] {
  const out: Element[] = [];
  const scopes: Root[] = [root, ...shadowRoots(root)];
  for (const scope of scopes) {
    try {
      out.push(...Array.from(scope.querySelectorAll(selector)));
    } catch {
      return []; // invalid selector
    }
  }
  return out;
}

/** Visible = connected, laid out, non-zero box, not hidden, and on screen horizontally. */
export function isVisible(el: Element): boolean {
  if (!el.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const cs = getComputedStyle(el);
  if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return false;
  if (r.right < 0 || r.left > window.innerWidth) return false;
  return true;
}

/** First visible element matching any of the target's selectors (in order). */
export function resolveTarget(target: LearnTarget | undefined): Element | null {
  if (!target) return null;
  for (const sel of expandTarget(target)) {
    const hit = deepQueryAll(sel).find(isVisible);
    if (hit) return hit;
  }
  return null;
}

/**
 * Bring an element into view by scrolling its nearest scrollable ancestor.
 * Deliberately NOT `scrollIntoView`: in this shell it also scrolls the
 * overflow-hidden `.shell` and shifts the whole chrome.
 */
export function revealElement(el: Element): void {
  let node: Element | null = el;
  const r = el.getBoundingClientRect();
  while (node) {
    const parent: Element | null =
      node.parentElement ?? ((node.getRootNode() as ShadowRoot).host as Element | undefined) ?? null;
    if (!parent) break;
    const cs = getComputedStyle(parent);
    const scrollable = /(auto|scroll)/.test(cs.overflowY) && parent.scrollHeight > parent.clientHeight + 4;
    if (scrollable) {
      const pr = parent.getBoundingClientRect();
      if (r.top < pr.top + 8 || r.bottom > pr.bottom - 8) {
        // Rects are post-zoom; scrollTop is in the parent's CSS px.
        const ratio = pr.height > 0 ? parent.clientHeight / pr.height : 1;
        const delta = (r.top - pr.top - pr.height / 3) * ratio;
        parent.scrollTop += delta;
      }
      return;
    }
    node = parent;
  }
}

/** Does `event` originate inside `el` (crossing shadow boundaries)? */
export function eventHits(event: Event, el: Element): boolean {
  return event.composedPath().includes(el);
}
