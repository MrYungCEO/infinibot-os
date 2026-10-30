/**
 * replay-collector.ts — drives the FrameStore by sampling live agent state at
 * 1 Hz. Self-contained: it never touches <agency-world-viz>; it only *reads*
 * the screen-space state the viz already publishes on `window.__agentFxState`
 * (the same feed <agent-fx-layer> consumes). If that feed is absent the buffer
 * simply stays empty until it appears — no errors, no coupling.
 *
 * Reference-counted: multiple <world-timeline-scrubber> instances can mount and
 * unmount without ever stopping a shared collection loop prematurely.
 */

import { getFrameStore, type FrameStore, type ReplayAgent } from "./frame-store.js";

export type ReplaySource = () => ReplayAgent[];

const defaultSource: ReplaySource = () =>
  ((window as Window & { __agentFxState?: ReplayAgent[] }).__agentFxState ?? []).map((a) => ({
    id: a.id,
    x: a.x,
    y: a.y,
    status: a.status,
    backend: a.backend,
  }));

export class ReplayCollector {
  private store: FrameStore;
  private source: ReplaySource = defaultSource;
  private timer = 0;
  private refs = 0;

  constructor(store: FrameStore = getFrameStore()) {
    this.store = store;
  }

  /** Override the agent feed (tests / custom wiring). null restores default. */
  setSource(fn: ReplaySource | null): void {
    this.source = fn ?? defaultSource;
  }

  /** Begin/continue collection for one consumer. */
  acquire(): void {
    this.refs++;
    if (this.refs === 1) this.start();
  }

  /** Release one consumer; stops the loop when the last one leaves. */
  release(): void {
    this.refs = Math.max(0, this.refs - 1);
    if (this.refs === 0) this.stop();
  }

  private start(): void {
    if (this.timer) return;
    const tick = () => {
      // While the world is in replay mode, __agentFxState reflects the *replayed*
      // (historical) positions — recording it would feed the past back into the
      // buffer. Skip sampling until the user returns to Live.
      if ((window as Window & { __worldReplayFrame?: unknown }).__worldReplayFrame) return;
      try {
        this.store.push(this.source(), Date.now());
      } catch {
        /* a bad source must not kill the loop */
      }
    };
    tick();
    this.timer = window.setInterval(tick, 1000);
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = 0;
    }
  }
}

let singleton: ReplayCollector | null = null;
export function getReplayCollector(): ReplayCollector {
  if (!singleton) singleton = new ReplayCollector();
  return singleton;
}
