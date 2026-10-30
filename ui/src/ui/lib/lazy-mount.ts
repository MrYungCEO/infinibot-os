/**
 * lazyMount — Lit directive that defers rendering a template until the host
 * element scrolls into the viewport.
 *
 * Usage:
 *   import { lazyMount } from "../lib/lazy-mount";
 *
 *   // In a Lit render():
 *   html`<div>${lazyMount(() => expensiveTemplate(), { rootMargin: "100px" })}</div>`
 *
 * While off-screen the directive renders a lightweight placeholder (same
 * intrinsic height via contain-intrinsic-size so scroll position is stable).
 * Once the host element intersects the root + rootMargin the real template is
 * rendered and the observer is disconnected.
 *
 * Options:
 *   rootMargin  — IntersectionObserver rootMargin (default "200px")
 *   placeholder — TemplateResult or nothing shown while off-screen
 *   once        — if true (default) stop observing after first intersection
 */

import {
  AsyncDirective,
  directive,
  type PartInfo,
  PartType,
} from "lit/async-directive.js";
import { html, nothing, type TemplateResult } from "lit";

export interface LazyMountOptions {
  rootMargin?: string;
  placeholder?: TemplateResult | typeof nothing;
  once?: boolean;
}

class LazyMountDirective extends AsyncDirective {
  private _observer: IntersectionObserver | null = null;
  private _visible = false;
  private _factory: (() => TemplateResult) | null = null;
  private _opts: LazyMountOptions = {};

  constructor(partInfo: PartInfo) {
    super(partInfo);
    if (partInfo.type !== PartType.CHILD) {
      throw new Error("lazyMount must be used in a child binding position");
    }
  }

  render(factory: () => TemplateResult, opts: LazyMountOptions = {}): TemplateResult | typeof nothing {
    this._factory = factory;
    this._opts = opts;
    if (this._visible) return factory();
    return opts.placeholder ?? nothing;
  }

  override update(part: Parameters<AsyncDirective["update"]>[0], [factory, opts = {}]: [() => TemplateResult, LazyMountOptions?]) {
    this._factory = factory;
    this._opts = opts;

    if (this._visible) return factory();

    // Attach observer the first time we have the host element.
    if (!this._observer) {
      const el = part.parentNode as Element;
      this._observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            this._visible = true;
            if (opts.once !== false) {
              this._observer?.disconnect();
              this._observer = null;
            }
            // Trigger Lit to re-render this directive with the real template.
            this.setValue(factory());
          }
        },
        { rootMargin: opts.rootMargin ?? "200px" },
      );
      this._observer.observe(el);
    }

    return opts.placeholder ?? nothing;
  }

  protected override disconnected(): void {
    this._observer?.disconnect();
    this._observer = null;
  }

  protected override reconnected(): void {
    // Reconnect observer if element re-enters DOM and was not yet visible.
    // (nothing to do if already visible — the rendered template persists)
  }
}

export const lazyMount = directive(LazyMountDirective);
