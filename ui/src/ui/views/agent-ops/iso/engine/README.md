# World Engine Primitives

Reliability foundations for the agent-ops world viz. These are **standalone,
framework-agnostic primitives** — they do **not** touch `agency-world-viz.ts`,
`activity-map.ts`, the camera director, or sprites. The live viz can *opt into*
them incrementally (see [Adoption Plan](#adoption-plan)); nothing here is wired
into a running surface yet.

| Module | Responsibility |
| --- | --- |
| `simulation-loop.ts` | Fixed-step sim update + interpolated render (accumulator pattern). Decouples data tick from render frame. |
| `quadtree.ts` | 2D spatial partitioning for neighbour/region queries at 1000+ agents / 60fps. |
| `determinism.ts` | Seedable xorshift32 PRNG + state-hash replay validator for reproducible runs. |
| `error-budget.ts` | `runProtected(name, fn)` — a throwing subsystem is counted & swallowed, never blanks the canvas; degrades after a burst. |
| `telemetry-overlay.ts` | `<telemetry-overlay>` debug HUD (backtick to toggle): FPS, tick rate, agents, quadtree size, per-subsystem errors. |

## Why each exists

- **Decoupled tick/render** → behaviour is stable and reproducible regardless of
  display refresh; render interpolates between sim states so motion stays smooth
  even when frame rate and tick rate diverge. A `maxFrameDt` clamp kills the
  "spiral of death" after a backgrounded tab.
- **Quadtree** → flocking / collision-avoidance / hover-pick are O(n²) with a
  linear scan. The tree narrows queries to overlapping cells (~O(log n + k)).
  Benchmarked **~4× faster** than linear scan at 2000 agents (see tests).
- **Determinism** → `Math.random()` is the only source of non-determinism in a JS
  sim. Replacing it with a seeded `Rng` makes a run a pure function of
  `(seed, events)`, so record/replay and regression-hunting are trustworthy.
- **Error budget** → a single broken subsystem must never take down the whole
  world. Each subsystem wraps its tick/render; a persistent failure is isolated
  and surfaced (degraded) instead of crashing the frame.
- **Telemetry overlay** → makes all of the above observable at a glance.

## Tests

Pure-logic unit tests live beside each module (`*.test.ts`) and run node-only:

```bash
cd ui
npx vitest run --config vitest.engine.config.ts
```

Covers: fixed-step determinism under a fake clock, quadtree correctness vs a
linear-scan reference + the speed benchmark, PRNG reproducibility, replay hash
divergence, and error-budget degradation/skip/recovery.

## Visual verification

`/__telemetry-overlay-test.html` (root) + `__telemetry-overlay-test.ts` (this
folder) wire the real primitives — a 850-agent quadtree world driven by the
SimulationLoop, with a deliberately broken `flocking` subsystem — to the
overlay. Serve via `vite` and open it; press backtick to toggle the HUD.
Reference capture: `/tmp/telemetry-overlay.png` (flocking degraded, world still
rendering — proving the error budget keeps the canvas alive).

## Adoption Plan

This lane intentionally ships primitives **without** integrating them into the
live viz. A follow-up should adopt them additively, in this order — each step is
independently shippable and reversible:

1. **Error budget first (lowest risk, highest payoff).** Construct one
   `ErrorBudget` in `agency-world-viz` / `activity-map`, then wrap the existing
   per-frame passes (sprite update, label render, fx layer, flocking) in
   `budget.runProtected("<name>", () => …)`. No behaviour change when nothing
   throws; instant blast-radius containment when something does. Pure
   instrumentation.
2. **Telemetry overlay.** Append a `<telemetry-overlay>` to the map host
   container (same place the pinboard/active-breakdown overlays mount) and set
   `.provider` to read from the viz's existing frame stats + the `ErrorBudget`
   snapshot. Off by default; backtick reveals it. Dev-facing only.
3. **Quadtree for neighbour queries.** Where the viz currently linear-scans
   agents for proximity (hover pick, flocking, conduit endpoints), build a
   `Quadtree` once per frame (`insert` on spawn / `rebuild` after the position
   pass) and swap the scans for `queryRect`/`queryCircle`. Validate parity
   against the old path behind a flag before deleting it.
4. **Simulation loop (largest change — do last).** Today the viz updates and
   renders in a single `requestAnimationFrame`. Migrate by moving state
   mutation into a `SimulationLoop` consumer's `update(dt)` and drawing into
   `render(alpha)`, interpolating sprite positions prev→curr by `alpha`. This is
   the step that unlocks frame-rate-independent motion and replay; gate it
   behind a flag and A/B against the current loop.
5. **Determinism harness (depends on step 4).** Once the world advances in fixed
   steps, route every `Math.random()` consumer through a forked `Rng` seeded
   from a session seed, and add a record/replay path that hashes world state per
   tick via `hashState`. Enables deterministic bug repros.

Steps 1–2 are safe to land immediately; 3–5 each want a feature flag + parity
check against the current implementation before the old path is removed.

> **Do not edit `agency-world-viz.ts` to adopt these.** It is shared engine code
> consumed by the dashboard band *and* the grid panel; integration belongs in a
> dedicated, flagged follow-up with its own visual verification.
