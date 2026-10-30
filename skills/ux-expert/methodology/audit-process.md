# UX Audit Process (canonical methodology)

Reusable 8-step audit. Every invocation of the `ux-expert` skill walks this loop.

---

## Step 1 · Scope
Define the surface in writing before opening the browser.
- **Target**: URL or component path (e.g. `http://localhost:3000/app/studio` → "Storyboard scene composer").
- **Goal of the surface**: one sentence ("user assembles scenes for a launch video").
- **Audience**: primary persona + their context (mobile? touch? screen-reader?).
- **Brand system context**: locate brand tokens in repo.
  - FlyPic: `Infinibot/infini-data/video-editor` + `studio-enhanced.html` IIFE; dark glass-morphism, framer-motion, lucide icons.
  - Products with their own design system: use that product's token file.
  - InfiniBot: `ui/src/ui/views/*` Lit components; theme tokens via CSS vars.
  - Always grep the target repo for `theme`, `tokens`, `:root {`, `--color`, before proposing changes.

## Step 2 · Capture
Use `mcp__infinibot__browser` (relay only — never raw CDP unless relay is down per memory).

For each surface capture:
1. Navigate (`action: navigate`) or focus existing tab.
2. Screenshot at 3 viewport widths via `resize` → `screenshot`:
   - 375×812 (mobile, iPhone 13)
   - 768×1024 (tablet)
   - 1440×900 (desktop)
3. Capture interactive states by driving the UI:
   - Default (resting)
   - Hover / focus on primary CTA
   - Loading (intercept or trigger)
   - Empty (clear data or fresh user)
   - Filled (representative data)
   - Error (invalid input or forced failure)
4. Save each to `audits/<ISO-timestamp>-<slug>/screenshots/<viewport>-<state>.png`.

Limit: capture ≤12 screenshots per audit (vision-token budget).

## Step 3 · Vision analysis
For each screenshot, call `mcp__infinibot__vision` with backend `claude` and the **canonical audit prompt**:

```
Audit this screenshot of {surface} (viewport {w}×{h}, state: {state}).
Brand system: {one-line brand summary + token sources}.
For each of the 16 categories below, list every concrete issue you can detect with a 1-line description, severity tag, and the category code.

Categories: hierarchy, typography, color, spacing, motion (inferred), forms, conversion, accessibility, states, navigation, dock, microcopy, density, responsive, feedback, brand.

Severity: critical | high | medium | low.
Output strict JSON array: [{ "category": "...", "severity": "...", "issue": "...", "evidence": "..." }].
```

Aggregate per-screenshot JSON into one `findings.raw.json`.

## Step 4 · Score
For every finding, attach:
- **Severity** (vision-provided, sanity-checked against the knowledge base): critical / high / medium / low.
- **Effort**: S (≤30 min), M (≤4 h), L (>4 h or unclear).
- **Impact axis**: conversion | clarity | accessibility | brand-fit | perf.
- **Knowledge ref**: file + pattern name from `knowledge/`.

A finding without a knowledge ref is rejected — we only ship recommendations backed by a documented pattern.

## Step 5 · Prioritize
Eisenhower-style 2×2: `impact × effort`.

Order:
1. Critical/High impact · S effort → ship this week.
2. Critical/High impact · M effort → ship this sprint.
3. Medium impact · S effort → backlog quick wins.
4. Everything else → deferred, documented.

Accessibility critical items skip the matrix — they ship first regardless of effort.

## Step 6 · Plan
Convert prioritized findings into **atomic tickets**. Each ticket = one self-contained Claude Coder dispatch. Ticket structure:

```
title: <short imperative>
files: <paths the agent should touch>
brand-constraints: <tokens / fonts / motion vocab to preserve>
problem: <one-paragraph>
acceptance:
  - <verifiable bullet>
  - <verifiable bullet>
verification:
  - <screenshot or selector check>
knowledge: <links to knowledge/* patterns>
```

Save under `audits/<...>/brief-templates/<NN>-<slug>.md`.

## Step 7 · Delegate
NEVER auto-dispatch. Always present the plan to the user and wait for explicit "ship N, N, N" confirmation.

On approval, for each approved ticket call:
```
mcp__infinibot__claude_coder({
  task: <contents of the brief template>,
  workdir: <project root for the surface>,
})
```
Tag each dispatch with `ux-audit:<audit-id>:<ticket-id>` for kanban tracking.

## Step 8 · Verify
After dev agents report done:
1. Re-screenshot the same viewports + states.
2. Re-run vision with the same prompt.
3. Compute deltas: closed issues, new regressions, untouched items.
4. Write `closure-report.md` with before/after screenshots and a "next audit" recommendation.

---

## Failure modes
| Mode | Mitigation |
|---|---|
| Browser relay down | Skip capture; document; do NOT raw-CDP unless explicitly authorized. |
| Vision rate-limit | Batch fewer screenshots; retry with backoff; fall back to manual heuristics. |
| Surface requires auth | Use existing signed-in tab via relay (never re-auth from scratch). |
| Brand tokens not locatable | Pause; ask user; record what was missing. |
| Vision returns non-JSON | Re-prompt with `output only JSON, no preface`. |

## Outputs (canonical)
```
audits/<timestamp>-<slug>/
  scope.md
  screenshots/<viewport>-<state>.png
  findings.raw.json
  findings.md           # human-readable, grouped by category
  upgrade-plan.md       # prioritized matrix + ticket index
  brief-templates/<NN>-<slug>.md
  (after dispatch) dispatch-log.md
  (after verify)   closure-report.md
```
