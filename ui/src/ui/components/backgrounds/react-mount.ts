/**
 * Minimal React-into-DOM adapter so we can mount reactbits components
 * (shipped as React FCs) inside our Lit/vanilla app shell. Returns a
 * handle with update/dispose symmetric to our other effect modules.
 *
 * Wraps the rendered component in an error boundary so a single broken
 * effect (e.g. an upstream R3F bug) does not propagate up and crash the
 * surrounding shell or pollute the WebGL context for other effects.
 */

import {
  Component as ReactComponent,
  createElement,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";

export interface ReactMountHandle<Props> {
  update(next: Partial<Props>): void;
  dispose(): void;
}

interface BoundaryProps {
  onError?: (err: unknown, info: ErrorInfo) => void;
  children?: ReactNode;
}
interface BoundaryState { failed: boolean }

class EffectErrorBoundary extends ReactComponent<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false };
  static getDerivedStateFromError(): BoundaryState { return { failed: true }; }
  componentDidCatch(err: unknown, info: ErrorInfo) {
    this.props.onError?.(err, info);
  }
  render() {
    if (this.state.failed) return null;
    return this.props.children ?? null;
  }
}

export function mountReactComponent<Props extends object>(
  container: HTMLElement,
  Component: ComponentType<Props>,
  initialProps: Props,
  onError?: (err: unknown, info: ErrorInfo) => void,
): ReactMountHandle<Props> {
  // Give the effect a full-bleed host so canvas-based effects size correctly.
  // Many reactbits backgrounds rely on `getBoundingClientRect` of their root
  // container — explicit width/height in px units avoids degenerate 0-size
  // mounts when the parent is a fixed-position viewport-sized layer.
  const host = document.createElement("div");
  host.style.cssText = [
    "position:absolute",
    "top:0",
    "left:0",
    "width:100%",
    "height:100%",
    "min-width:100vw",
    "min-height:100vh",
    "overflow:hidden",
  ].join(";") + ";";
  container.appendChild(host);

  const root: Root = createRoot(host);
  let props = initialProps;
  const render = () =>
    root.render(
      createElement(
        EffectErrorBoundary,
        { onError },
        createElement(Component, props),
      ),
    );
  render();

  return {
    update(next) {
      props = { ...props, ...next };
      render();
    },
    dispose() {
      try { root.unmount(); } catch { /* ignore */ }
      if (host.parentNode === container) container.removeChild(host);
    },
  };
}
