/**
 * Knowledge-graph force-layout Web Worker.
 *
 * Runs the 3D galaxy simulation (knowledge-graph-galaxy.ts: d3-force x/y +
 * custom z forces) OFF the main thread so the UI stays responsive (60fps
 * render) even while thousands of nodes settle. The worker owns the
 * authoritative simulation; the main thread only sends intent (init /
 * reheat / drag / resize / stop) and renders from the position buffers the
 * worker streams back.
 *
 * Protocol — main → worker:
 *   { type: "init",   nodes, links, w, h, alpha?, opts? }   // opts: LayoutOptions
 *       nodes[i] may carry { z?, plan?, orbit?, orbitStrength?, charge?, pinned?, gx?, gy?, gs? } and
 *       links[i] { distance?, strength? } — all optional, all additive.
 *   { type: "reheat", alpha }
 *   { type: "drag",   index, x, y, z? }   // pin a node under the cursor
 *   { type: "dragEnd",index }             // release the pin
 *   { type: "resize", w, h }
 *   { type: "stop" }
 *
 * Worker → main:
 *   { type: "tick", alpha }  + transferable Float32Array [x0,y0,z0,x1,y1,z1,…]
 *   { type: "end" }          // simulation cooled below alphaMin
 *
 * Positions are indexed by the node order supplied at init — the worker
 * never reorders, so the main thread maps buffer[i*3] → nodes[i].
 */

import { forceCenter, type Simulation } from "d3-force";
import {
  createGalaxyLayout,
  snapToTargets,
  orbitForce,
  type GNode,
  type LayoutLinkIn,
  type LayoutOptions,
  type LayoutNodeIn,
} from "./knowledge-graph-galaxy";

let sim: Simulation<GNode, undefined> | null = null;
let nodes: GNode[] = [];
/** Throttle position broadcasts to ~30/s — layout converges fine at that rate
 * and it halves the per-tick transferable allocation churn for huge graphs. */
let lastPost = 0;
let snap = false;
const POST_INTERVAL_MS = 33;

function postPositions(alpha: number, force = false): void {
  const now = Date.now();
  if (!force && now - lastPost < POST_INTERVAL_MS) return;
  lastPost = now;
  const buf = new Float32Array(nodes.length * 3);
  for (let i = 0; i < nodes.length; i++) {
    buf[i * 3] = nodes[i].x ?? 0;
    buf[i * 3 + 1] = nodes[i].y ?? 0;
    buf[i * 3 + 2] = nodes[i].z ?? 0;
  }
  (self as unknown as Worker).postMessage({ type: "tick", alpha, positions: buf }, [buf.buffer]);
}

self.onmessage = (ev: MessageEvent) => {
  const msg = ev.data as Record<string, unknown>;
  switch (msg.type) {
    case "init": {
      sim?.stop();
      const built = createGalaxyLayout(
        (msg.nodes as LayoutNodeIn[]) ?? [],
        (msg.links as LayoutLinkIn[]) ?? [],
        Number(msg.w) || 800,
        Number(msg.h) || 600,
        typeof msg.alpha === "number" ? (msg.alpha as number) : 1,
        (msg.opts as LayoutOptions | undefined) ?? {},
      );
      nodes = built.nodes;
      snap = (msg.opts as LayoutOptions | undefined)?.snap === true;
      sim = built.sim
        .on("tick", () => postPositions(sim?.alpha() ?? 0))
        .on("end", () => {
          if (snap) snapToTargets(nodes);
          postPositions(0, true); // final settled frame
          (self as unknown as Worker).postMessage({ type: "end" });
        });
      break;
    }
    case "reheat": {
      sim?.alpha(typeof msg.alpha === "number" ? (msg.alpha as number) : 0.3).restart();
      break;
    }
    case "drag": {
      const n = nodes[msg.index as number];
      if (n) {
        n.fx = msg.x as number;
        n.fy = msg.y as number;
        if (typeof msg.z === "number") n.fz = msg.z;
      }
      break;
    }
    case "dragEnd": {
      const n = nodes[msg.index as number];
      if (n) {
        n.fx = null;
        n.fy = null;
        n.fz = null;
      }
      break;
    }
    case "resize": {
      const w = Number(msg.w) || 800;
      const h = Number(msg.h) || 600;
      if (sim?.force("center")) sim.force("center", forceCenter(w / 2, h / 2).strength(0.05));
      if (sim?.force("orbit")) sim.force("orbit", orbitForce(w, h));
      break;
    }
    case "unpin": {
      // Release warm-refresh pins (not a drag pin) once the layout settled.
      for (const n of nodes) {
        n.fx = null;
        n.fy = null;
        n.fz = null;
      }
      break;
    }
    case "stop": {
      sim?.stop();
      break;
    }
    default:
      break;
  }
};
