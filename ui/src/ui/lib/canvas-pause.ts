/**
 * Pause WebGL/Canvas RAF loops when:
 *   - the tab/document is hidden (visibilitychange)
 *   - the host element is not intersecting the viewport (IntersectionObserver)
 *
 * and (optionally) throttle them to a lower frame rate while the window is
 * blurred (another window is focused) — decorative backgrounds don't need
 * 60fps when the user isn't even looking at the app.
 *
 * Usage:
 *   const pause = createCanvasPause(host, { throttleWhenBlurred: true });
 *   pause.onChange = (active) => { running = active; if (active) tick(); };
 *   pause.start();
 *   const tick = (t) => {
 *     if (!running || !pause.isActive()) { rafId = 0; return; }
 *     rafId = requestAnimationFrame(tick);
 *     if (!pause.wantsFrame(t)) return;   // throttle gate (skips render, keeps loop)
 *     ...render...
 *   };
 *   // ... in dispose:
 *   pause.stop();
 *
 * The controller debounces visibility/intersection state so flips don't fight
 * each other. A frame is only requested when transitioning inactive → active.
 */
export type CanvasPauseOptions = {
  /**
   * When the window loses focus (user tabbed to another window but this tab is
   * still "visible"), throttle rendering to `blurredFps` instead of full speed.
   * Defaults to off for backwards-compatibility; pass true for decorative
   * backgrounds (aurora / mesh / shaders).
   */
  throttleWhenBlurred?: boolean;
  /** Target fps while the window is blurred. Default 30. */
  blurredFps?: number;
};

export type CanvasPause = {
  /** True when the loop should run at all (visible + in viewport). */
  isActive: () => boolean;
  /**
   * Frame gate: returns true if a frame should be rendered *now*. When the
   * window is blurred and throttling is enabled, returns false on frames that
   * exceed the throttled cadence so the caller can skip the expensive render
   * while keeping the rAF loop alive. Always advances its internal clock.
   */
  wantsFrame: (now: number) => boolean;
  start: () => void;
  stop: () => void;
  onChange: ((active: boolean) => void) | null;
};

export function createCanvasPause(
  host: Element,
  opts: CanvasPauseOptions = {},
): CanvasPause {
  const throttleWhenBlurred = opts.throttleWhenBlurred ?? false;
  const minBlurredMs = 1000 / Math.max(1, opts.blurredFps ?? 30);

  let docVisible = !document.hidden;
  let inViewport = true;
  let focused = typeof document.hasFocus === "function" ? document.hasFocus() : true;
  let active = docVisible && inViewport;
  let started = false;
  let observer: IntersectionObserver | null = null;
  let lastRendered = 0;

  const ctrl: CanvasPause = {
    isActive: () => active,
    wantsFrame(now: number) {
      if (!active) return false;
      if (!throttleWhenBlurred || focused) {
        lastRendered = now;
        return true;
      }
      // Window blurred: render at most once per throttled interval.
      if (now - lastRendered >= minBlurredMs) {
        lastRendered = now;
        return true;
      }
      return false;
    },
    onChange: null,
    start() {
      if (started) return;
      started = true;
      document.addEventListener("visibilitychange", onVisibility, { passive: true });
      window.addEventListener("focus", onFocus, { passive: true });
      window.addEventListener("blur", onBlur, { passive: true });
      if (typeof IntersectionObserver !== "undefined") {
        observer = new IntersectionObserver((entries) => {
          for (const e of entries) {
            if (e.target === host) {
              inViewport = e.isIntersecting;
              recompute();
            }
          }
        }, { threshold: 0 });
        observer.observe(host);
      }
    },
    stop() {
      if (!started) return;
      started = false;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      observer?.disconnect();
      observer = null;
    },
  };

  function onVisibility() {
    docVisible = !document.hidden;
    recompute();
  }
  function onFocus() {
    focused = true;
  }
  function onBlur() {
    focused = false;
  }

  function recompute() {
    const next = docVisible && inViewport;
    if (next !== active) {
      active = next;
      ctrl.onChange?.(active);
    }
  }

  return ctrl;
}
