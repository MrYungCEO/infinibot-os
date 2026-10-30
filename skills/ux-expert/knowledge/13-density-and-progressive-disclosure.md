# 13 · Density & Progressive Disclosure

## Pattern: Summary → detail
- **When**: Any list of complex items (rows with many attributes).
- **How**:
  - Default row shows ID + title + 2–3 KPIs.
  - Click/expand reveals full record without leaving the list.
  - "View full page" link for deep work.
- **Source**: NN/g progressive disclosure; Linear lists.

## Pattern: Defaults that work for 80%
- **When**: Settings, filters, advanced options.
- **How**: Show the 3–5 most-used controls; gate the rest behind "Advanced" / "More". Track usage and promote what crosses 20%.
- **Source**: Cooper *About Face*; Microsoft Office "ribbon" research.

## Pattern: Density tiers (Comfortable / Compact)
- **When**: Tables, kanban, settings.
- **How**:
  - Comfortable = default. 44–48 px rows.
  - Compact = power users. 32 px rows. Smaller font ONLY if line-height stays ≥1.3.
  - Persist per user. Never compact-by-default for first-runs.
- **Source**: Atlassian density tokens; Gmail.

## Pattern: Surfacing through truncation
- **When**: Long titles, paths, descriptions.
- **How**:
  - Truncate with ellipsis BUT show full value in tooltip on hover/focus.
  - Mid-string truncation for paths (`…/storyboard/scene-4.tsx`).
  - For lists, prefer wrapping to 2 lines + ellipsis vs single-line ellipsis when scan-readability matters.
- **Source**: Material 3 truncation guidance.

## Pattern: Reveal advanced via "Show advanced" toggle
- **When**: Forms with optional/expert fields.
- **How**: Default-hide, toggle to reveal; remember choice in localStorage; preselect reveal if the user previously used those fields.
- **Source**: Adam Silver forms; Material 3.

## Pattern: Inline help over modals
- **When**: Adding explanatory copy.
- **How**: Short hint below the field > tooltip (?) > full doc modal. Reserve modals for blocking confirmations.
- **Source**: GOV.UK hints.

## Pattern: Just-in-time hints
- **When**: Onboarding new feature.
- **How**: Coachmark / spotlight on first encounter; dismiss permanently after 1 view; never re-trigger.
- **Source**: Pendo / Appcues research.

## Anti-pattern checklist
- 12-column dense table with no view-options for non-power-users.
- "Advanced" section that contains 30+ fields nobody touches.
- Every column truncated, all tooltips empty.
- Coachmarks that block onboarding flow.
