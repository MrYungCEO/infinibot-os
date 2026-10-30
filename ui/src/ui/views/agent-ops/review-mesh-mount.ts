/**
 * Mount the visible review (Auditor + packets + screenshot orbit + panels) onto
 * an ActivityMap engine. Lazy-loaded by <agency-world-viz review-layer> so the
 * dashboard band never pays for it.
 */

import "../../components/review-mesh-panel";
import "../../components/mesh-completed-rail";
import type { ReviewMeshPanel, ReviewPanelMode } from "../../components/review-mesh-panel";
import { ReviewFeed, isReviewDemo, type FeedRequester } from "../../lib/review-mesh/feed";
import type { ActivityMap } from "./activity-map";
import { ReviewMeshLayer } from "./review-mesh-layer";

export interface ReviewMeshMountOptions {
  engine: ActivityMap;
  host: HTMLElement;
  client: FeedRequester | null;
  onOpenRun?: (runId: string) => void;
  /** Ask the host's auto-focus camera to yield for `ms`. */
  holdCamera?: (ms: number) => void;
}

export interface ReviewMeshHandle {
  setClient(client: FeedRequester | null): void;
  destroy(): void;
  openThread(runId: string): void;
  openScreenshots(runId: string): void;
  readonly feed: ReviewFeed;
}

export function mountReviewMesh(opts: ReviewMeshMountOptions): ReviewMeshHandle {
  const demo = isReviewDemo();
  let destroyed = false;
  const feed = new ReviewFeed(opts.client);
  let panel: ReviewMeshPanel | null = null;

  const openPanel = (mode: ReviewPanelMode, patch: { runId?: string; focusId?: string; shotId?: string } = {}) => {
    opts.holdCamera?.(20_000);
    if (!panel) {
      panel = document.createElement("review-mesh-panel");
      panel.feed = feed;
      panel.addEventListener("review-panel-close", () => closePanel());
      panel.addEventListener("review-replay", (e) => {
        const runId = (e as CustomEvent<{ runId: string }>).detail?.runId;
        if (!runId) return;
        opts.holdCamera?.(20_000);
        layer.focusAuditor({ panel: true });
        void feed.loadThread(runId).then((t) => {
          if (t) layer.replayThread(t);
        });
      });
      panel.addEventListener("review-open-run", (e) => {
        const runId = (e as CustomEvent<{ runId: string }>).detail?.runId;
        if (runId) opts.onOpenRun?.(runId);
      });
      opts.host.appendChild(panel);
      rail.style.visibility = "hidden";
    }
    // Keep the Auditor (and the packets) in view beside the panel.
    if (mode === "threads") layer.focusAuditor({ panel: true });
    panel.mode = mode;
    panel.runId = patch.runId ?? (mode === "threads" ? "" : panel.runId);
    panel.focusId = patch.focusId ?? "";
    panel.shotId = patch.shotId ?? "";
  };

  const closePanel = () => {
    panel?.remove();
    panel = null;
    rail.style.visibility = "";
  };

  const layer = new ReviewMeshLayer({
    engine: opts.engine,
    host: opts.host,
    feed,
    onOpenThread: (runId, focusId) => openPanel("threads", { runId: runId ?? "", focusId }),
    onOpenGallery: (shotId) => openPanel("gallery", { shotId }),
  });

  // Recently-completed rail (bottom-right). Clicking a card flies to the agent
  // and opens its run details + review thread.
  const rail = document.createElement("mesh-completed-rail");
  rail.feed = feed;
  rail.addEventListener("completed-open", (e) => {
    const d = (e as CustomEvent<{ runId: string; sessionKey: string }>).detail;
    if (!d?.runId) return;
    opts.holdCamera?.(20_000);
    layer.flyToRun(d.runId, d.sessionKey);
    openPanel("threads", { runId: d.runId });
  });
  rail.addEventListener("rail-height", (e) => {
    const px = (e as CustomEvent<{ px: number }>).detail?.px ?? 0;
    try {
      opts.engine.setBottomReserved(px);
    } catch {
      /* engine gone */
    }
  });
  opts.host.appendChild(rail);

  let stopDemo: (() => void) | null = null;
  void feed.start().then(() => layer.warmUp());
  if (demo) {
    void import("../../lib/review-mesh/demo").then(({ startReviewDemo }) => {
      if (destroyed) return;
      stopDemo = startReviewDemo(feed);
      // Demo: frame the Executive Suite so the conversation is in view.
      // Twice: the host's initial zoomToFit can land after the first fly-to.
      for (const ms of [1500, 3500, 6500]) {
        setTimeout(() => {
          if (destroyed) return;
          opts.holdCamera?.(45_000);
          layer.focusAuditor();
        }, ms);
      }
    });
  }

  // Debug / verification hooks (also used by the ?reviewDemo=1 harness).
  const w = window as unknown as Record<string, unknown>;
  w.__reviewMesh = {
    open: (runId?: string) => openPanel("threads", { runId }),
    gallery: (shotId?: string) => openPanel("gallery", { shotId }),
    close: closePanel,
    stats: () => layer.stats(),
    focus: () => {
      opts.holdCamera?.(45_000);
      layer.focusAuditor();
    },
    feed,
  };

  return {
    feed,
    openThread(runId) {
      openPanel("threads", { runId });
    },
    openScreenshots(runId) {
      openPanel("gallery");
      panel?.showRunScreenshots(runId);
    },
    setClient(client) {
      feed.setClient(client);
    },
    destroy() {
      destroyed = true;
      stopDemo?.();
      closePanel();
      rail.remove();
      layer.destroy();
      feed.destroy();
      if (w.__reviewMesh) delete w.__reviewMesh;
    },
  };
}
