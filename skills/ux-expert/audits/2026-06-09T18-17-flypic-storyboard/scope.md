# Audit Scope · FlyPic Video Studio (Storyboard)

- **Target**: `http://localhost:3000/app/studio` — "Video Studio — Flypic"
- **Surface goal**: Compose scenes for an AI-generated launch/ad video.
- **Audience**: Solo creators / marketers; desktop-primary, mobile review.
- **Brand system**: dark glass-morphism, framer-motion choreography, lucide icon family. Tokens implied via Tailwind / CSS vars on the Next.js app.
- **Audit run**: 2026-06-09T18:17 UTC

## Degraded-run note (IMPORTANT)
This bootstrap audit could NOT capture live screenshots:
- `mcp__infinibot__browser` reports tabs OK via CDP HTTP, but `screenshot`/`act`/`snapshot` return `tab not found` — the **InfiniBot Browser Relay extension is not currently attached to the FlyPic tab** (Chrome 137+ manual install requirement, per memory `spawned_agents_auto_attach_browser`).
- `mcp__infinibot__vision` returned `ANTHROPIC_API_KEY not set` (claude backend) and `No compatible vision model available` (local backend).

→ This audit ships as a **heuristic / static-analysis pass** grounded in the 16-category knowledge base and what is known about FlyPic's stack (Next.js, glass-morphism, framer-motion). Findings flagged `[needs-evidence]` must be confirmed in the next run when capture is available.

## Re-run checklist
1. Pin and click the InfiniBot Browser Relay extension on the `localhost:3000/app/studio` tab (badge ON).
2. Set `ANTHROPIC_API_KEY` in the gateway env, OR run `infinibot vision install local-model` to enable local vision.
3. Re-invoke the `ux-expert` skill — it will replay capture + vision phases and convert `[needs-evidence]` findings into evidence-backed ones.
