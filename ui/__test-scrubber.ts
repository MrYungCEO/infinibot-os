/**
 * Visual-verify harness for <world-timeline-scrubber>.
 * Seeds the FrameStore with one hour of synthetic agent activity (positions +
 * status transitions → event markers), then mounts the scrubber over a fake
 * world backdrop so we can screenshot live/replay/playing/markers states.
 */
import "./src/ui/components/world-timeline-scrubber.js";
import { getFrameStore, type ReplayFrame, type ReplayEvent } from "./src/ui/components/world-timeline-scrubber/frame-store.js";
import type { WorldTimelineScrubber } from "./src/ui/components/world-timeline-scrubber.js";

const W = 900;
const H = 420;
const BACKENDS = ["claude-code", "opencode", "codex", "gemini"];

function seed() {
  const now = Date.now();
  const start = now - 60 * 60 * 1000; // one hour back
  const frames: ReplayFrame[] = [];
  const events: ReplayEvent[] = [];

  // 6 agents, each with a spawn time, a wandering path, and a terminal event.
  const agents = Array.from({ length: 6 }, (_, i) => {
    const spawnAt = start + i * 7 * 60 * 1000; // staggered spawns
    const lifespan = (25 + i * 4) * 60 * 1000;
    const endKind = (["complete", "fail", "blocked", "complete", "blocked", "fail"] as const)[i];
    return { id: `agent-${i + 1}`, backend: BACKENDS[i % BACKENDS.length], spawnAt, endAt: spawnAt + lifespan, endKind };
  });

  // Sample at 1 Hz but only keep every 10th frame to keep the buffer light.
  for (let t = start; t <= now; t += 10 * 1000) {
    const live = agents.filter((a) => t >= a.spawnAt && t <= a.endAt);
    frames.push({
      t,
      agents: live.map((a, idx) => {
        const phase = (t - a.spawnAt) / 90000 + idx;
        let status = "running";
        if (t > a.endAt - 60000) status = a.endKind === "complete" ? "completed" : a.endKind === "fail" ? "failed" : "blocked";
        return {
          id: a.id,
          x: W * (0.2 + 0.6 * (0.5 + 0.4 * Math.sin(phase))),
          y: H * (0.25 + 0.5 * (0.5 + 0.4 * Math.cos(phase * 1.3))),
          status,
          backend: a.backend,
        };
      }),
    });
  }

  for (const a of agents) {
    events.push({ t: a.spawnAt, id: a.id, kind: "spawn", label: a.id });
    events.push({ t: a.endAt - 30000, id: a.id, kind: a.endKind, label: a.id });
  }

  getFrameStore().seed(frames, events);
  // Also expose a live feed so Live mode has something to pin to.
  (window as any).__agentFxState = frames[frames.length - 1]?.agents ?? [];
}

seed();

const scrubber = document.querySelector("world-timeline-scrubber") as WorldTimelineScrubber;

// Test hooks driven from puppeteer.
(window as any).__scrubberTest = {
  setReplay(ratio: number, playing: boolean, speed: number) {
    const track = scrubber.renderRoot.querySelector(".track") as HTMLElement;
    const rect = track.getBoundingClientRect();
    const x = rect.left + rect.width * ratio;
    track.dispatchEvent(new PointerEvent("pointerdown", { clientX: x, bubbles: true, pointerId: 1 }));
    track.dispatchEvent(new PointerEvent("pointerup", { clientX: x, bubbles: true, pointerId: 1 }));
    const sb = scrubber as any;
    sb.speed = speed;
    sb.playing = playing;
    sb.requestUpdate();
  },
  setLive() {
    (scrubber as any).setLive();
  },
};
