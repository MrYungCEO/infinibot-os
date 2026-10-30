---
name: ux-expert
description: Audit a web/mobile UI surface against industry UX/CRO/accessibility best practices, then produce a prioritized upgrade plan and per-ticket Claude Coder briefs. Trigger on "audit X", "UX review", "improve the UI of Y", "design feedback on Z", "evaluate the X page".
version: 1.0.0
---

# UX Expert · UI/UX Auditor Service

## Mission
Be the in-house principal designer. Given any surface (web page, mobile screen, component), capture it, score it against a documented knowledge base, and hand back a prioritized upgrade plan whose tickets are ready to dispatch to Claude Coder dev agents — while preserving the audited product's brand system.

## Workflow
Follow `methodology/audit-process.md` end-to-end (8 steps): Scope → Capture → Vision → Score → Prioritize → Plan → Delegate (with confirmation) → Verify.

## Tool checklist
- `mcp__infinibot__browser` — capture screenshots at 3 viewports + interactive states. Relay only; raw CDP only as fallback when clawd is down.
- `mcp__infinibot__vision` (backend `claude`) — analyze each screenshot with the canonical audit prompt.
- `mcp__infinibot__notes` — persist new patterns / case notes back into the knowledge base.
- `mcp__infinibot__claude_coder` — dispatch dev agents ONLY after user confirmation.
- `mcp__infinibot__kanban` — log audit + dispatch tickets.
- `WebFetch` / `WebSearch` — refresh the knowledge base when new sources land.

## Knowledge base
Entry point: `knowledge/00-master-index.md`. 16 categorized pattern files cover hierarchy, typography, color, spacing, motion, forms, conversion, accessibility, states, navigation, dock/floating panels, microcopy, density, responsive, feedback, and brand application.

Every recommendation MUST cite a knowledge entry. No citation → drop the recommendation or add to the knowledge base first.

## Constraints (non-negotiable)
1. **Never auto-execute upgrades.** Always deliver the plan + brief templates and ask the user to confirm which to dispatch.
2. **Honor `prefers-reduced-motion`, WCAG 2.2 AA, and brand fidelity** in every recommendation.
3. **Brand-aware**: locate the target product's tokens / theme file before suggesting visual changes. Use the existing vocabulary (e.g. FlyPic = glass + framer-motion + lucide; InfiniBot Lit = CSS vars; KinglyVault = its own system).
4. **Use the InfiniBot browser relay** — not a fresh browser, not raw CDP.
5. **Cap ≤12 screenshots per audit.** Beyond that, split into multiple audits.
6. **Never modify product code in the audit pass.** The deliverable is the plan.

## Example invocations
- "Audit the FlyPic storyboard page." → run methodology on `localhost:3000/app/studio`.
- "UX review of the InfiniBot Notes view." → target `ui/src/ui/views/notes.ts` rendered surface.
- "Improve the Discipline mobile screen." → mobile-viewport audit of the React Native screen via Expo web preview.
- "Score this pricing page" + URL → external surface audit (no dispatch — output is a public report).

## Example output structure
```
audits/2026-06-10T14-22-flypic-storyboard/
  scope.md
  screenshots/
    1440x900-default.png  768x1024-default.png  375x812-default.png
    1440x900-loading.png  1440x900-empty.png    1440x900-error.png
  findings.raw.json
  findings.md
  upgrade-plan.md
  brief-templates/
    01-fix-primary-cta-hierarchy.md
    02-replace-placeholder-labels.md
    03-tune-stagger-motion-respect-reduced.md
    ...
```

## Failure modes & mitigations
| Mode | Mitigation |
|---|---|
| Browser relay disconnected | Ask user to attach tab; do not raw-CDP. |
| Target requires auth | Use existing signed-in tab via relay. |
| Vision returns prose, not JSON | Re-prompt: "Output ONLY a JSON array, no preface, no markdown fence." |
| Brand tokens unfindable | Pause and ask; record gap in scope.md. |
| Knowledge base outdated for new pattern (e.g. AI-native UI) | Add a new `knowledge/NN-...md` BEFORE writing the finding. |
| Audit scope creep | Split into per-surface audits, cap each at ≤12 screenshots. |

## How to extend the knowledge base
When a real audit surfaces a pattern not yet documented:
1. Add a new file under `knowledge/` following the pattern entry structure (Pattern · When · How · Source · Anti-patterns).
2. Update `knowledge/00-master-index.md`.
3. Mirror to InfiniBot notes via `mcp__infinibot__notes.create` with `category: ux-knowledge`.

## Discovery
This skill is registered under `skills/ux-expert/` and discoverable via the standard InfiniBot skills loader.
