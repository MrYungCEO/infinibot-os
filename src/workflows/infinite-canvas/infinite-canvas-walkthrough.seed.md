---
id: infinite-canvas-walkthrough
name: Infinite Canvas Walkthrough
description: Produce a premium interactive infinite-canvas walkthrough site (pan/zoom/guided tour, animated SVG diagrams, screenshot frames, minimap) — built, locally verified in puppeteer, deployed to Netlify, and delivered as a link-only Telegram message. Wraps the infinite-canvas-walkthrough skill.
tags:
  - canvas
  - walkthrough
  - interactive
  - infinite-canvas
  - holo
  - black-gold
  - report
author: main
agent: main
kind: static
timeoutSeconds: 1800
inputs:
  - name: configPath
    label: Config JSON path
    description: Absolute path to a canvas.json (see the skill for its shape). If set, overrides slug/title/contentMd below.
    type: string
    required: false
    default: ""
    placeholder: /home/you/canvas.json
  - name: slug
    label: Slug
    description: URL slug + Netlify site name + build dir (/tmp/<slug>-canvas-build). Required unless configPath is set.
    type: string
    required: false
    default: ""
    placeholder: my-walkthrough
  - name: title
    label: Title
    description: Cover title. Required unless configPath is set.
    type: string
    required: false
    default: ""
    placeholder: My Product Walkthrough
  - name: subtitle
    label: Subtitle
    description: Topbar / meta line.
    type: string
    required: false
    default: ""
  - name: contentMd
    label: Chapter markdown (JSON array)
    description: JSON array of chapter strings (markdown). The skill auto-lays-out clusters of 3-4 nodes per chapter on a grid. Required unless configPath is set.
    type: text
    required: false
    default: "[]"
  - name: site
    label: Netlify site (name or id)
    description: The Netlify site to deploy to. Created if missing.
    type: string
    required: true
    default: ""
    placeholder: my-canvas-walkthrough
  - name: telegram
    label: Post link to Telegram
    description: If true, posts the deployed URL via sendCanvasLinkToTelegram (link-only — no PDF).
    type: boolean
    required: false
    default: true
requires:
  - kind: tool
    name: Bash
    reason: The pipeline shells out to node + the Netlify CLI.
  - kind: channel
    name: telegram
    optional: true
    reason: Only needed if the telegram input is true.
---

# Infinite Canvas Walkthrough — produce an interactive infinite-canvas site

You are producing an **interactive infinite-canvas walkthrough** — a free-floating
pannable/zoomable single-page site with a guided tour, animated SVG diagrams,
screenshot cards, and a live minimap.

**Use the `infinite-canvas-walkthrough` skill.** Read its `SKILL.md`
(`skills/infinite-canvas-walkthrough/SKILL.md`) and follow the contract exactly.
This is NOT the same artifact as the `stylized-walkthrough` skill — that skill
produces a paginated PDF; this one produces an interactive web canvas. Never
collapse them.

## Inputs given to you

- configPath: `{{configPath}}`
- slug:       `{{slug}}`
- title:      `{{title}}`
- subtitle:   `{{subtitle}}`
- contentMd:  `{{contentMd}}`
- site:       `{{site}}`
- telegram:   `{{telegram}}`

## Steps

1. **Resolve config.** If `configPath` is set, load it. Otherwise build a
   `canvas.json` from `slug`/`title`/`subtitle`/`contentMd` — clusters of
   3-4 nodes per chapter, laid out on a grid. Always set `deploy.site = "{{site}}"`
   and `deploy.telegram = {{telegram}}` on the generated config.

2. **Build.** Run:
   ```
   node skills/infinite-canvas-walkthrough/build.mjs \
     --config <canvas.json> --slug <slug>
   ```
   Output lands at `/tmp/<slug>-canvas-build/index.html`.

3. **Verify (gate).** Run:
   ```
   node skills/infinite-canvas-walkthrough/verify.mjs \
     --build /tmp/<slug>-canvas-build
   ```
   This loads the artifact in puppeteer at 1920x1080 and asserts the camera
   moves, images load, a diagram is animating, links are drawn, and zero
   console errors. **Do not deploy on a failed verify.** Fix and rebuild.

4. **Deploy.** Run:
   ```
   node skills/infinite-canvas-walkthrough/deploy.mjs \
     --build /tmp/<slug>-canvas-build \
     --site {{site}} \
     --config <canvas.json>
   ```
   The Netlify CLI is invoked from `/tmp` with absolute `--dir` to dodge the
   monorepo prompt. The site is created if missing. The live URL is re-verified.

5. **Telegram (link-only).** If the config has `deploy.telegram: true` (or
   `--telegram` is passed), `deploy.mjs` will call `sendCanvasLinkToTelegram`
   from `src/reports/index.ts` to post the URL. Never attach a PDF or the HTML
   itself — this artifact ships as a URL.

6. **Return.** Reply with the live URL and a one-line summary.
