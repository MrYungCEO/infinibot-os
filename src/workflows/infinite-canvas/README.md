# `src/workflows/infinite-canvas/` — Infinite Canvas Walkthrough workflow

`infinite-canvas-walkthrough.seed.md` is the tracked seed for the workflow that
wraps the `infinite-canvas-walkthrough` skill (interactive pan/zoom canvas site
→ build → puppeteer verify → Netlify deploy → Telegram link).

The InfiniBot workflow store reads from `<stateDir>/workflows/*.md` at runtime
(`<stateDir>` defaults to `~/.infinibot` and is gitignored locally as `state/`).
To install this workflow into a running gateway:

```bash
cp src/workflows/infinite-canvas/infinite-canvas-walkthrough.seed.md \
   "$INFINIBOT_STATE_DIR/workflows/infinite-canvas-walkthrough.md"
# Then restart the gateway so it shows up in mcp__infinibot__workflows.
```

The skill itself lives at `skills/infinite-canvas-walkthrough/` — see its
`SKILL.md` for the visual + delivery contract.
