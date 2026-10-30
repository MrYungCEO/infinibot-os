# InfiniBot Control UI — Orphan Audit

**Scope:** `ui/src/ui/views/**` and `ui/src/ui/components/**`, `*.ts`, excluding `*.test.ts` and `*.d.ts`.
**Verdict:** **59 orphaned files / 46,829 lines** out of 478 candidate files.
**Status:** analysis only — no source file was modified or deleted.

---

## 1. Method

A file is declared an orphan only if **nothing** references it by **any** of the following mechanisms. Each was checked mechanically across `ui/**`, `src/**` and `electron/**` (`.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.html`, `.json`):

| Mechanism | How it was checked |
|---|---|
| Static import | `from "…"` / `import "…"`, resolved with and without `.js`, plus `dir/index.ts` folding |
| Dynamic import | `import("…")` — this is how `ui/src/ui/lazy-views.ts` mounts every route |
| Re-export barrel | `export * from` / `export { … } from` (same resolver) |
| Vite query imports | `"./x.ts?worker"`, `?raw`, `?url`, `?inline` — query stripped before resolving |
| Custom-element tag | `@customElement("t")` / `customElements.define("t", …)`, then every `<t` and `"t"`/`'t'`/`` `t` `` occurrence hunted across all sources, **excluding comment lines and the defining file itself** |
| HTML / config entry | `src=`/`href=` in all 7 `ui/**/*.html`; `rollupOptions.input` in `vite.config.ts` and `vite.embed.config.ts` |
| Reachability cross-check | Independent transitive walk from the real entry point (`ui/index.html` → `src/main.ts`), 2,506 modules reached |

### False positives caught and removed during the audit

Two mechanisms produced wrong verdicts on the first pass and were fixed:

1. **`?worker` query suffix.** `ui/src/ui/components/knowledge-graph-layout.worker.ts` (152 lines) looked orphaned because the specifier is `"./knowledge-graph-layout.worker.ts?worker"` (`knowledge-graph.ts:35`). **It is live.** It is excluded from every count below. It was the only `.ts` query-suffixed import in the tree.
2. **Loose tag matching.** Matching a tag name anywhere in a file wrongly rescued `views/gmail.ts` — the only other occurrences of `gmail-page` are prose inside comments in `inbox.ts:4` and `inbox-all-mail.ts:8` describing what replaced it. Comment lines are now excluded, and `gmail.ts` is correctly an orphan.

After the fix, **zero** candidate files are reachable by tag alone — every file with a real tag consumer also has a real importer. So no row in the table below is at risk from the custom-element mechanism.

### Confidence

The **orphan verdict** (nothing imports it) is mechanically derived and is high confidence on every row. The **bucket** and the **named replacement** are judgement calls; per-row confidence is given where it is not clear-cut.

---

## 2. Confirmed orphans (59 files, 46,829 lines) — sorted by line count descending

| # | Path (`ui/src/ui/…`) | Lines | Custom element | What it is | Bucket | Replacement / notes | Conf. |
|---|---|---:|---|---|---|---|---|
| 1 | `views/systems-intelligence.ts` | 7906 | — | Values / Priorities / Map / Reviews / Insights sub-nav for the Systems Intelligence feature | UNREACHABLE FEATURE | Whole stack is live except the UI: `src/systems-intelligence/store.ts`, `src/gateway/server-methods/systems-intelligence.ts` and `ui/src/ui/controllers/systems-intelligence.ts` all exist — but the controller is imported **only** by this dead view. `dashboard.ts` reads the insights RPC directly and never mounts this screen. | High |
| 2 | `views/image-studio.ts` | 3082 | — | Image editing suite: crop, upscale, background removal, batch, federation-node routing | UNREACHABLE FEATURE | `controllers/image-studio.ts` is imported **only** here. No live image-editing surface anywhere in `ui/src`. | High |
| 3 | `views/gmail.ts` | 2444 | `gmail-page` | Legacy Gmail/Emails page + OAuth account-connect flow | SUPERSEDED | `views/inbox.ts` (live, `lazyInbox`). The file's own header says `@deprecated Use the unified Inbox page`. Account-management UI was to be absorbed into `views/email-accounts.ts` (live). | High |
| 4 | `views/projects-dashboard.ts` | 1684 | — | Grid of project sessions with progress bars and context-window indicators | SUPERSEDED | `views/kanban.ts` — `/projects` is served by `lazyKanban` in `lazy-views.ts:62`. | High |
| 5 | `views/funnels-automation.ts` | 1649 | — | Visual rule builder: WHEN trigger / IF conditions / THEN actions | UNREACHABLE FEATURE | Server side is live (`src/funnels/automation/bridge.ts`, `src/gateway/server-methods/funnels-flow.ts`) but no live view renders a rule builder. The live funnels suite (`funnels.ts`, `funnels-canvas.ts`, `funnels-flow-end-to-end.ts`) does not import it. | Med-High |
| 6 | `views/focus.ts` | 1526 | — | Full-screen priority board: drag-and-drop top-5 column over a collapsible kanban source | UNREACHABLE FEATURE | Partially superseded: `controllers/focus.ts` **is** live via `views/dashboard-kanban-card.ts`, so the feature survives as a dashboard card. The full-screen board has no live mount. Do not delete the controller. | Medium |
| 7 | `views/vault-dashboard.ts` | 1511 | — | Kingly Vault HUD: automation rules, moderation log, members | UNREACHABLE FEATURE | Root of a dead cluster — `vault-members.ts` (988), `vault-courses.ts` (844) and `vault-discord.ts` (656) are imported *only* by this file, and `controllers/vault.ts` only by those four. The entire Vault UI is unreachable. | High |
| 8 | `views/users-management.ts` | 1208 | — | Multi-user management, terminal HUD styling | SUPERSEDED | `views/users.ts` (live, `lazyUsers` at `lazy-views.ts:133`). Note: `controllers/users-management.ts` is still wired into `app.ts` / `app-view-state.ts` as dangling state. | High |
| 9 | `views/voice-panel.ts` | 1204 | — | Site-wide slide-out voice chat: LiveKit + wake word + Docker voice-service control | SUPERSEDED | `views/voice-chat.ts` (live, `lazy-views.ts:155-165`) plus `components/voice-floating-hud.ts` and `components/voice-setup-wizard.ts`. | High |
| 10 | `views/ollama-monitor.ts` | 1165 | `ollama-command-center` | Ollama server status, GPU gauges, loaded models / VRAM, load-unload actions | UNREACHABLE FEATURE | `controllers/ollama-monitor.ts` imported **only** here. Closest live surface is `views/hardware-analysis.ts`, which does not cover model load/unload. | High |
| 11 | `views/federation.ts` | 1096 | — | Animated federation mesh topology with live spawn/message events | SUPERSEDED | `views/federation-dashboard.ts` and `views/federation-control-center.ts` (both live and both importing the shared `controllers/federation.ts`). | High |
| 12 | `views/war-room.ts` | 1066 | — | Multi-agent "AI War Room": 5-monitor executive-agent conversation layout | UNREACHABLE FEATURE | `controllers/war-room.ts` imported **only** here. No live equivalent. | High |
| 13 | `views/agent-config-panel.ts` | 1052 | — | Per-agent MCP / skills / tools configuration panel | SUPERSEDED | `views/agents-management.ts` (live, `lazyAgents` at `lazy-views.ts:64`) — same concern, current generation. | Medium |
| 14 | `views/ssh-devices.ts` | 975 | `ssh-devices-view` | Network device discovery + SSH management with live scan-progress logs | UNREACHABLE FEATURE | `controllers/ssh-devices.ts` imported **only** here. `views/inficode/devices-panel.ts` is live and is the nearest analogue but tracks fleet nodes, not SSH scan results — not a drop-in replacement. | High (orphan) / Med (no-replacement) |
| 15 | `views/agents.ts` | 942 | — | Agent-management section originally embedded in the Skills page | SUPERSEDED | `views/agents-management.ts`. Generation 1 of 3 — see also rows 26 and 38. | High |
| 16 | `views/community-nodes.ts` | 932 | — | Multi-tenant community management with per-community feature toggles | UNREACHABLE FEATURE | No live equivalent found anywhere in `ui/src`. | High |
| 17 | `views/hyperframes-stage.ts` | 930 | `hyperframes-stage` | Inline hyperframes mount replacing the iframe-based preview in the video editor | UNREACHABLE FEATURE | Part of the missing video-editor surface (see rows 31, 34, 35, 36, 41). `hyperframes` appears **nowhere else** in `ui/src`, though `src/compositions/hyperframes-translator.ts` is live server-side. | High |
| 18 | `views/gpu-command-center.ts` | 886 | `gpu-command-center` | Live GPU utilisation, per-GPU processes, service registry, task queue, smart routing | SUPERSEDED | `views/hardware-analysis.ts` and `views/inficode/hardware-panel.ts` (both live). Smart-routing controls have no live home. | Medium |
| 19 | `views/sessions-spawn-dialog.ts` | 856 | — | Dialog for spawning agent sessions on a local or federated node, with task analysis | UNCLEAR | Session spawning is live through `control-bus-app-views.ts`, `controllers/agent-mesh.ts` and `views/masonry-grid.ts`, but none of them is a clear 1:1 successor to this dialog. `views/agent-ops/spawn-dialog.ts` is a closer match but is itself dead (see §4). | Medium |
| 20 | `views/agent-ops/index.ts` | 829 | — | Agent Operations Center: PixiJS activity map, agent monitoring, node federation, messaging | SUPERSEDED | `views/agency-operations.ts` (live, `lazy-views.ts:103`) + `components/agency-world-viz.ts` (the live world renderer). Root of the largest dead cluster — ~20 `views/agent-ops/**` files including `agency-world.ts` (3584) hang off this entry point only. | High |
| 21 | `views/dashboard-command-center.ts` | 818 | — | "What should I focus on now?" header layer: ranked insights over already-loaded `DashboardState` | SUPERSEDED | `views/dashboard.ts` (live, `lazy-views.ts:201-212`) renders the insight surfaces directly. | High |
| 22 | `views/agents-profile-config.ts` | 769 | — | Agent specialties / tools / MCP / system-prompt configuration | SUPERSEDED | `views/agents-management.ts`. Overlaps heavily with row 13. | Medium |
| 23 | `views/socials-dashboard.ts` | 723 | — | Unified social command center (Instagram / TikTok / Twitter / YouTube) | UNREACHABLE FEATURE | Root of a dead pair: `views/socials-analytics.ts` (626) and `controllers/socials-analytics.ts` are imported *only* by this file. The whole socials UI is unreachable. | High |
| 24 | `views/federation-transfer-drawer.ts` | 697 | `federation-transfer-drawer` | Globally-mounted floating panel showing live federation file-transfer progress, driven by a `federation-file-transfer-request` document event | SUPERSEDED | `views/federation-file-transfer.ts` (live). Note the event-driven design means it was *intended* to be mounted once globally — nothing ever mounts it. | Medium |
| 25 | `views/graph-overlay.ts` | 664 | — | Floating InfraNodus knowledge-graph modal sourced from kanban + notes | SUPERSEDED | `views/knowledge-graph.ts` (live, `lazyKnowledgeGraph` at `lazy-views.ts:114`) + `views/grid-panels/knowledge-graph-panel.ts`. | Med-High |
| 26 | `views/agents-real.ts` | 634 | — | Agents gallery: glass cards with avatar upload, set-default, test, delete | SUPERSEDED | `views/agents-management.ts`. Generation 2 of 3. | High |
| 27 | `views/downloads.ts` | 634 | — | Client-app downloads page (Android APK, iOS TestFlight, desktop builds, pairing code) | UNREACHABLE FEATURE | No live equivalent. `views/mobile.ts` / `views/mobile-page.ts` are live but cover pairing, not downloads. | Medium |
| 28 | `views/federation-node-selector.ts` | 573 | — | Dropdown for targeting a command/session at a specific federation node | SUPERSEDED | `views/node-selector.ts` (live, used by `ui/src/ui/federation/index.ts`, `views/federation-integration.ts`, `views/masonry-grid.ts`). | High |
| 29 | `views/services.ts` | 526 | — | Start / stop / restart / register federation API servers | SUPERSEDED | `views/docker.ts`, `views/instances.ts`, `views/federation-control-center.ts` (all live). | Medium |
| 30 | `views/room-customizer/index.ts` | 509 | — | Room customisation editor for the agent-visualisation world: element library, canvas, properties, settings | UNREACHABLE FEATURE | Root of a 4-file dead cluster (`room-canvas.ts` 731, `room-settings.ts` 721, `properties-panel.ts` 688, `element-library.ts` 442 — all imported only from here). `views/agent-ops/room-customization.ts` is a parallel implementation that is *also* dead. | High |
| 31 | `views/video-block-inspector.ts` | 422 | — | Auto-generated per-`BlockStyleField` inspector for the video editor | UNREACHABLE FEATURE | Video editor surface. Server side lives (`src/compositions/blocks/**`, `server-methods/composition-blocks.ts`) and `controllers/video-blocks-catalog.ts` exists, but no video-editor view exists in `ui/src`. | High |
| 32 | `views/email-marketing.ts` | 410 | — | Loops.so dashboard: Overview / Campaigns / Groups / Contacts / Templates / Log | UNREACHABLE FEATURE | `emailMarketingState` is still declared in `app.ts:288` and `app-view-state.ts:297` — dangling state for a view that is never rendered. `views/campaigns.ts` is live but is a different (CRM) campaign surface. | High |
| 33 | `views/kanban-agent-assignment.ts` | 407 | — | Task cards with agent assignment, suggestions and scoring indicators | SUPERSEDED | `views/kanban.ts` (live) — assignment is handled there and in `components/world-interactions/drag-assign.ts`. | Medium |
| 34 | `views/video-template-gallery.ts` | 309 | — | Composition-template gallery overlay for the video editor | UNREACHABLE FEATURE | Video editor surface — see row 31. | High |
| 35 | `views/video-block-stagger.ts` | 220 | — | Per-element stagger driver emitting a scoped `<style>` for `data-anim-item` children | UNREACHABLE FEATURE | Video editor surface — see row 31. | High |
| 36 | `views/block-preview-html.ts` | 214 | — | UI-side mirror of the server's `builtInBlockHtml`, self-sizing via container-query units | UNREACHABLE FEATURE | Video editor surface. Server counterpart `src/compositions/blocks/built-in-templates.ts` is live. | High |
| 37 | `components/voice-terminal-controller.ts` | 772 | — | Reusable VAD → Whisper STT → terminal, plus `assistant:text:delta` → Kokoro/Web-Speech TTS with a voice-blob canvas | UNREACHABLE FEATURE | Its own header names "the video editor's Coder pane" as the first consumer — that pane does not exist. `views/voice-chat.ts` keeps its own in-house implementation, which this module was meant to replace. | Medium |
| 38 | `components/wake-word-settings.ts` | 657 | — | Per-panel wake-word configuration for the multi-session grid page | SUPERSEDED | Live wake stack: `controllers/agent-wake.ts`, `controllers/assistant-wake.ts`, `controllers/compound-wake.ts`, wired via `control-bus-grid.ts` and `app-render.ts`. | Medium |
| 39 | `components/agent-selector.ts` | 584 | — | Dropdown for selecting agents across gateways, grouped by gateway with status | SUPERSEDED | `views/masonry-grid.ts` re-implements it inline — the identical `.agent-selector__trigger` / `__dropdown` / `__option` markup and CSS lives at `masonry-grid.ts:7065-10906`. | Medium |
| 40 | `components/neural-network-viz.ts` | 505 | `neural-network-viz` | Three.js rotating node-sphere with glowing connections and pulse animations | UNCLEAR | Purely decorative; no live equivalent and no obvious successor. Needs a human call on whether it is wanted. | — |
| 41 | `components/voice-setup-section.ts` | 487 | — | Reusable voice onboarding panel: Cloud/Native/Docker picker, API key, smoke test, voice-brain picker | SUPERSEDED | `components/voice-setup-wizard.ts` — `views/setup.ts:1648` imports it and `:1916` renders `<voice-setup-wizard variant="full">`. This file's own header names `/setup` as its mount point, so it lost that slot. | High |
| 42 | `components/overlay-card-running-agents.ts` | 262 | `overlay-card-running-agents` | Live list of active agent sessions for the agent overlay layer | UNREACHABLE FEATURE | See the overlay-card note below the table. | High |
| 43 | `components/overlay-card-workflow.ts` | 248 | `overlay-card-workflow` | Running / just-finished workflow run with steps, polls while non-terminal | UNREACHABLE FEATURE | See note below. | High |
| 44 | `components/overlay-card-revenue.ts` | 234 | `overlay-card-revenue` | Revenue / pipeline KPI card with money-field auto-detection over `business.clients.list` | UNREACHABLE FEATURE | See note below. | High |
| 45 | `components/aurora-bg.ts` | 230 | — | WebGL (`ogl`) simplex-noise aurora background layer | SUPERSEDED | `components/backgrounds/` is the live background system (`grainient.ts`, `faulty-terminal.ts`, `ambient-grid.ts`). | Medium |
| 46 | `components/overlay-card-clients-list.ts` | 221 | `overlay-card-clients-list` | Top-N clients by a sort field, rows routing into the Clients page | UNREACHABLE FEATURE | See note below. | High |
| 47 | `components/agency-note-overlay.ts` | 204 | `agency-note-overlay` | Floating editor for sticky-note marks in the agency world, using `<moltbot-block-editor>` | UNCLEAR | No live sticky-note surface exists in the world renderer; nothing else in `ui/src` mentions note marks. Could be an unfinished feature rather than a dead one. | — |
| 48 | `components/overlay-card-client.ts` | 204 | `overlay-card-client` | Single-client summary card over `business.clients.get` | UNREACHABLE FEATURE | See note below. | High |
| 49 | `components/overlay-card-hardware.ts` | 182 | `overlay-card-hardware` | Live CPU/GPU/RAM/disk/network card riding the existing `/api/hardware/stream` SSE | UNREACHABLE FEATURE | See note below. | High |
| 50 | `components/walkthroughs/canvas-diagrams.ts` | 151 | — | Animated SMIL SVG diagrams for the Holo-Canvas walkthrough renderer | UNCLEAR | Its intended host `components/walkthroughs/infinite-canvas-walkthrough.ts` **is live** (used by `proactive-overlay-host.ts`) but never imports it — the live renderer draws a plain `DIAGRAM` placeholder at line 998 instead. This looks like a prepared asset module that was never wired up, not dead code. | — |
| 51 | `components/world-overlays/__test.entry.ts` | 109 | — | Standalone esbuild visual-test entry for `<world-overlays>` with a mock world floor | SCRATCH/TEST | Zero references from any `.html`, config or source file. | High |
| 52 | `views/agent-ops/iso/__cinematic_test_entry.ts` | 95 | — | Puppeteer harness for `cinematic-camera.ts`, bundled by esbuild for `__test.html` | SCRATCH/TEST | Zero references. | High |
| 53 | `components/world-environment/__test.entry.ts` | 57 | — | Standalone visual-test entry for `<world-environment>` | SCRATCH/TEST | Zero references. | High |
| 54 | `components/overlay-card-credit-usage.ts` | 48 | `overlay-card-credit-usage` | Overlay wrapper around the live `<credit-usage-breakdown>` component | UNREACHABLE FEATURE | See note below. | High |
| 55 | `components/__minimap_test_entry.ts` | 40 | — | Harness for `world-minimap.ts` with four mock sectors | SCRATCH/TEST | Zero references. | High |
| 56 | `views/agent-ops/iso/sprites/apply.ts` | 39 | — | `applySprite()` helper writing texture/tint onto a PIXI container child | SUPERSEDED | `views/agent-ops/iso/sprites/registry.ts` is the live-ish sprite path; `applySprite` is called from nowhere, not even inside the (already dead) agent-ops cluster. | Medium |
| 57 | `views/agent-ops/iso/sectors/__test.entry.ts` | 22 | — | Visual-verify harness for `<world-atmosphere>` + `<world-sectors>` | SCRATCH/TEST | Zero references; its own comment points at a `__build.mjs` that no longer wires it. | High |
| 58 | `components/agent-emotes-layer/__test.entry.ts` | 4 | — | Registers `<agent-emotes-layer>` for the standalone `__test.html` harness | SCRATCH/TEST | Zero references. | High |
| 59 | `views/agents-page.ts` | 2 | — | Full-screen wrapper that calls `renderAgentsSection` from `views/agents.ts` | SUPERSEDED | `views/agents-management.ts`. Generation 3 of 3. **This file is corrupt** — its entire source is one line of literal `\n` escape sequences rather than real newlines, so it would not compile even if imported. | High |

### Note on the seven `overlay-card-*` orphans (rows 42, 43, 44, 46, 48, 49, 54 — 1,399 lines)

These deserve a closer look before deletion because `components/agent-overlay-layer.ts` resolves card tags **dynamically**:

```ts
// agent-overlay-layer.ts:125
const tag = `overlay-card-${type}`;
if (OWNED_LOADERS[type]) return this.loaded.has(type) ? tag : "";
return customElements.get(tag) ? tag : FALLBACK_TAG;
```

`OWNED_LOADERS` (lines 27–34) lazily imports exactly eight cards: `note`, `task`, `project`, `markdown`, `image`, `code`, `pdf`, `diagram` — all live. The seven files above are **not** in that map, and nothing else imports them, so `customElements.get("overlay-card-revenue")` is always `false` and the layer silently renders `overlay-card-fallback` instead. They are unreachable **as written**, but the code was clearly designed for another module to register them ("Business + live types (Agent C) are resolved at runtime if their elements are registered"). Treat them as *unfinished integration* rather than obsolete code: the one-line fix is to add them to `OWNED_LOADERS`, not to delete them.

---

## 3. Totals

| Bucket | Files | Lines |
|---|---:|---:|
| SUPERSEDED | 23 | 18,432 |
| UNREACHABLE FEATURE | 26 | 26,354 |
| SCRATCH/TEST | 6 | 327 |
| UNCLEAR | 4 | 1,716 |
| **TOTAL** | **59** | **46,829** |

---

## 4. Supplementary — collateral dead code (not counted above)

Reachability from `ui/index.html` shows **89** candidate files (64,772 lines) that never execute. 59 are the direct orphans above; the other **30 files / 17,943 lines** are live-looking modules whose *only* importers are orphans. They are not orphans by the strict definition, so they are excluded from every count above — but they die with their roots and are listed here so a future cleanup does not treat them as safe.

| Path | Lines | Dead because |
|---|---:|---|
| `views/agent-ops/agency-world.ts` | 3584 | `agent-ops/index.ts` (row 20). The **live** world is `components/agency-world-viz.ts` — a different implementation. |
| `views/agent-ops/room-customization.ts` | 1866 | `agent-ops/index.ts` |
| `views/agent-ops/agency-buildings.ts` | 1335 | `agent-ops/index.ts` |
| `views/vault-members.ts` | 988 | `vault-dashboard.ts` (row 7) |
| `views/vault-courses.ts` | 844 | `vault-dashboard.ts` |
| `views/room-customizer/room-canvas.ts` | 731 | `room-customizer/index.ts` (row 30) |
| `views/room-customizer/room-settings.ts` | 721 | `room-customizer/index.ts` |
| `views/room-customizer/properties-panel.ts` | 688 | `room-customizer/index.ts` |
| `views/vault-discord.ts` | 656 | `vault-dashboard.ts` |
| `views/agent-ops/mesh-sidebar.ts` | 631 | `agent-ops/index.ts` |
| `views/socials-analytics.ts` | 626 | `socials-dashboard.ts` (row 23) |
| `views/agent-ops/spawn-dialog.ts` | 443 | `agent-ops/index.ts` |
| `views/room-customizer/element-library.ts` | 442 | `room-customizer/index.ts` |
| `components/world-minimap.ts` | 408 | `__minimap_test_entry.ts` (row 55) |
| `views/agent-ops/iso/engine/telemetry-overlay.ts` | 354 | agent-ops cluster |
| `views/agent-ops/room-integration.ts` | 339 | agent-ops cluster |
| `views/agent-ops/agency-sprite-atlas.ts` | 330 | agent-ops cluster |
| `components/cosmetics-picker.ts` | 313 | world test entries |
| `components/world-environment.ts` | 297 | `world-environment/__test.entry.ts` (row 53) |
| `views/agent-ops/iso/sectors/sector-buildings.ts` | 285 | agent-ops cluster |
| `components/world-environment/conduit-beams.ts` | 267 | `world-environment` cluster |
| `views/agent-ops/message-stream.ts` | 236 | agent-ops cluster |
| `views/agent-ops/iso/sectors/world-sectors.ts` | 235 | agent-ops cluster |
| `views/agent-ops/iso/engine/error-budget.ts` | 226 | agent-ops cluster |
| `components/world-environment/skybox.ts` | 224 | `world-environment` cluster |
| `views/agent-ops/iso/engine/simulation-loop.ts` | 218 | agent-ops cluster |
| `views/agent-ops/iso/engine/quadtree.ts` | 201 | agent-ops cluster |
| `views/agent-ops/iso/engine/determinism.ts` | 179 | agent-ops cluster |
| `components/world-environment/ground-grid.ts` | 158 | `world-environment` cluster |
| `views/agent-ops/iso/engine/__telemetry-overlay-test.ts` | 118 | agent-ops cluster |

Combined direct + collateral dead surface: **89 files, 64,772 lines** — 18.6% of the 478 candidate files.

---

## 5. Dangling references worth fixing regardless

These are live files that still carry state or wiring for orphaned views:

- `ui/src/ui/app.ts:288` and `ui/src/ui/app-view-state.ts:297` — `emailMarketingState` for the unreachable `views/email-marketing.ts` (row 32).
- `ui/src/ui/app.ts` / `app-view-state.ts` — `controllers/users-management` state for the superseded `views/users-management.ts` (row 8).
- `ui/src/ui/controllers/focus.ts` — shared between the orphaned `views/focus.ts` and the **live** `views/dashboard-kanban-card.ts`. Must survive any cleanup of row 6.
- `ui/src/ui/components/agent-overlay-layer.ts:27-34` — `OWNED_LOADERS` is missing the seven business/live overlay cards it was written to support.
