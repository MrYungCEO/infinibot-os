---
name: infinite-canvas-walkthrough
description: Produce a premium black-gold INTERACTIVE INFINITE CANVAS walkthrough site (pan/zoom/guided tour, animated SVG diagrams, screenshot frames, minimap) from a canvas.json config — built, locally verified in puppeteer, deployed to Netlify, and delivered as a link-only Telegram message. Use whenever the user asks for an "infinite canvas walkthrough", "interactive canvas walkthrough", "infinite canvas diagram", "pan zoom walkthrough site", "holo canvas", or "canvas walkthrough site".
---

# Infinite Canvas Walkthrough

This skill is the canonical pipeline for the **interactive infinite-canvas
walkthrough site** — a free-floating, pannable/zoomable single-page artifact
with a guided tour, animated SVG diagrams, screenshot cards, and a live
minimap. It is the standardization of the `/tmp/voice-fleet-canvas/index.html`
exemplar (the "10x Workflow Holo-Canvas").

## When to use this skill

Trigger phrases:

- "interactive canvas walkthrough"
- "infinite canvas diagram"
- "pan zoom walkthrough site"
- "holo canvas"
- "canvas walkthrough"
- "free-floating walkthrough page"

**Do NOT reuse the `stylized-walkthrough` skill for this** — that skill produces
a *paginated PDF*, this skill produces an *interactive canvas web page*. They
are different artifacts with different visual contracts; never collapse them
into one pipeline.

## Visual contract (the non-negotiables)

1. **Four-layer void background** — `#bg-radial` + `#bg-grid` + `#stars`
   (canvas) + `#vignette`. A flat black `<body>` background is a regression.
   `build.mjs` asserts the four IDs are present in the output.
2. **Black-gold theme** — gold `#d4af37` / gold-2 `#f4d77a` / void `#05060b` /
   glass `rgba(16,20,38,.62)` / 14px backdrop blur. Token set lives in
   `templates/canvas.theme.css`.
3. **Animated SVG diagrams** — every diagram has at least one `<animate>` /
   `<animateMotion>` / `<animateTransform>`. The verifier checks
   `getCurrentTime() > 0` on at least one diagram SVG.
4. **Self-contained** — NO CDN dependencies. All CSS + JS inline. Images live
   under `./img/`. The exemplar runs offline; the built site must too.
5. **HUD** — topbar (logo + meta), bottom-left zoom controls (+ / − / fit /
   percentage), bottom-center guided tour pill (prev / stop-name / next /
   count), bottom-right minimap canvas, top-right help panel.
6. **Curved gold connectors** — `#links` SVG with the `lg` gold gradient,
   marching dots, dashed overlay. The verifier checks `#links path` count > 0.

## Delivery contract (the gotchas)

- **Puppeteer gate is mandatory.** `verify.mjs` runs at 1920x1080 against
  `file://<build>/index.html`, checks the camera moves on `flyToNode`, every
  `<img>` has `naturalWidth > 0`, a diagram is animating, links exist, and
  there are zero console errors. CI/agents MUST gate on this before deploy.
- **Netlify deploy from `/tmp` with absolute `--dir`.** Running the Netlify
  CLI from inside the monorepo trips a monorepo prompt. The build output
  always lands at `/tmp/<slug>-canvas-build/` and `deploy.mjs` always passes
  `--dir <absolute>` + `--site <name-or-id>` + `--prod`.
- **Telegram is LINK-ONLY.** Do NOT send the HTML/PDF as a Telegram document
  for this artifact — send the deployed URL via
  `sendCanvasLinkToTelegram(url, title)` (from `src/reports/index.ts`).
  The PDF sink is for the `stylized-walkthrough` skill.

## Quickstart

```bash
# 1. Build from a config
node skills/infinite-canvas-walkthrough/build.mjs \
  --config skills/infinite-canvas-walkthrough/exemplars/voice-fleet-canvas/canvas.json \
  --slug voice-fleet
# → /tmp/voice-fleet-canvas-build/index.html

# 2. Verify in puppeteer (mandatory gate)
node skills/infinite-canvas-walkthrough/verify.mjs \
  --build /tmp/voice-fleet-canvas-build
# → /tmp/voice-fleet-canvas-build/shot-default.png
# → /tmp/voice-fleet-canvas-build/shot-pan.png

# 3. Deploy to Netlify + Telegram link (only if verify is green)
node skills/infinite-canvas-walkthrough/deploy.mjs \
  --build /tmp/voice-fleet-canvas-build \
  --site voice-fleet-canvas \
  --config skills/infinite-canvas-walkthrough/exemplars/voice-fleet-canvas/canvas.json
```

## Config shape

`canvas.json` describes the canvas as a list of clusters → nodes → links → a
tour ordering. See `exemplars/voice-fleet-canvas/canvas.json` for the seed
config the exemplar was reverse-engineered from.

```jsonc
{
  "slug": "voice-fleet",
  "title": "The 10× Workflow",
  "subtitle": "Voice Orchestrators + Parallel Subagents on InfiniBot",
  "brand": "InfiniBot · Holo-Canvas",
  "world": { "w": 9600, "h": 6400 },
  "nodes": [
    { "id": "title", "kind": "title", "x": 240, "y": 240, "w": 760, "cl": "gold",
      "h1": "The 10× Workflow", "sub": "...", "brand": "InfiniBot · v1 2026",
      "edition": "...", "hints": ["**Drag** to fly", "**Scroll** to zoom"] },
    { "id": "c1", "kind": "text", "x": 240, "y": 1120, "w": 480, "cl": "red",
      "part": "The Problem", "kicker": "Chapter 01", "h2": "The Bottleneck",
      "body": "Markdown-lite paragraphs..." },
    { "id": "shot-voice", "kind": "shot", "x": 2440, "y": 480, "w": 560, "cl": "gold",
      "img": "voice.png", "label": "Voice Terminal", "caption": "..." },
    { "id": "d-fanout", "kind": "diagram", "x": 1900, "y": 1360, "w": 520, "cl": "gold",
      "diagram": "fanout", "caption": "D1 · voice in → orchestrator → fan-out" }
    /* …kinds: title|text|shot|diagram|stats|callout|steps|cmp|term */
  ],
  "links": [["title", "c1"], ["c1", "shot-voice"]],
  "tour": [
    { "id": "title", "name": "Welcome", "z": 0.62 },
    { "id": "c1", "name": "Ch.1 · The Bottleneck", "z": 0.78 }
  ],
  "deploy": { "site": "voice-fleet-canvas", "telegram": true }
}
```

### Node kinds

| kind     | extra fields                                                         |
| -------- | -------------------------------------------------------------------- |
| `title`  | `h1`, `sub`, `brand`, `edition`, `hints[]`                            |
| `text`   | `kicker?`, `h2?`, `h3?`, `body` (markdown-lite paragraphs)            |
| `shot`   | `img` (relative to `./img/`), `label`, `caption`                      |
| `diagram`| `diagram` (key into `templates/diagrams/`), `caption`                  |
| `stats`  | `stats[]` of `{ n, l }`                                                |
| `callout`| `body`, `icon?` (default `◆`)                                          |
| `steps`  | `steps[]` of `{ num, t }`                                              |
| `cmp`    | `cols[]` of `{ ch, items[], hot? }`                                    |
| `term`   | `lang?`, `lines[]`                                                     |

Colors `cl` are one of `red|teal|amber|violet|blue|orange|gold` (mapped to
CSS vars in the theme).

## Workflow integration

A workflow `infinite-canvas-walkthrough` is registered at
`state/workflows/infinite-canvas-walkthrough.md`. It accepts either
`configPath` (point at an existing `canvas.json`) or
`{ slug, title, contentMd }` (auto-generate a config from raw chapter
markdown), then runs build → verify → deploy → telegram link → returns URL.

## Files

- `SKILL.md` — this file
- `templates/canvas.template.html` — shell with placeholders
- `templates/canvas.theme.css` — token + component CSS
- `templates/diagrams/*.svg` — reusable animated SVG snippets
- `build.mjs` — config → built canvas at `/tmp/<slug>-canvas-build/`
- `verify.mjs` — puppeteer gate
- `deploy.mjs` — Netlify deploy + Telegram link
- `exemplars/voice-fleet-canvas/` — the seed config that regenerates the
  `/tmp/voice-fleet-canvas` exemplar shape

## What to do when this skill triggers

1. Read this file and confirm whether the user already has a `canvas.json`.
   If not, either ask once OR auto-generate from `contentMd` by grouping into
   clusters of 3-4 nodes per chapter.
2. Run `build.mjs` → emits to `/tmp/<slug>-canvas-build/`.
3. Run `verify.mjs` — **gate**. On any error, fix and rebuild.
4. Run `deploy.mjs` (only on green verify) — returns live URL, posts link to
   Telegram if `deploy.telegram: true`.
5. Reply with the live URL and a one-line summary.
