# Findings · FlyPic Storyboard (heuristic pass)

All findings link to a knowledge-base pattern. `[needs-evidence]` = high-likelihood for this surface type but unverified until live screenshots + vision are available.

## Critical

### C1 · Primary CTA hierarchy unclear on the canvas/timeline split [needs-evidence]
- **Category**: hierarchy · conversion
- **Evidence**: Storyboard tools commonly present both "Generate scene" and "Render video" as equally-weighted brand-accent buttons. With glass + gradient bg, both reading >10% accent saturation likely produces a "two primaries" problem.
- **Knowledge**: `01-visual-hierarchy.md` (One dominant focal point), `07-conversion-patterns.md` (One primary CTA per screen)
- **Effort**: S
- **Impact**: conversion + clarity

### C2 · Glass-morphism text contrast over busy video frames [needs-evidence]
- **Category**: accessibility · color · brand
- **Evidence**: Toolbar / inspector panels using `backdrop-filter: blur` over a video preview frequently drop body-text contrast below 4.5:1 when the underlying frame is bright (titles, beach shots).
- **Knowledge**: `08-accessibility-wcag-2-2.md` (Contrast minimums), `11-dock-and-floating-panel-patterns.md` (Glass-morphism done responsibly)
- **Effort**: M (need to add a scrim token + ensure worst-case contrast)
- **Impact**: accessibility + brand-fit

### C3 · Reduced-motion not honored on framer-motion springs [needs-evidence]
- **Category**: motion · accessibility
- **Evidence**: framer-motion default `animate` / spring choreography (staggered scene cards, dock pill bounce) typically ignores `prefers-reduced-motion` unless `useReducedMotion()` is wired explicitly.
- **Knowledge**: `05-motion-design.md` (Respect prefers-reduced-motion)
- **Effort**: S
- **Impact**: accessibility

## High

### H1 · Loading state for long renders unclear [needs-evidence]
- **Category**: states · feedback
- **Evidence**: Video render is multi-second to multi-minute; if only a spinner shows, users abandon. Need determinate progress per scene + persistent status drawer.
- **Knowledge**: `09-empty-error-loading-states.md` (Skeleton + progress text), `15-feedback-and-status-systems.md` (Persistent status surfaces)
- **Effort**: M
- **Impact**: clarity + conversion

### H2 · Dock icon-only buttons missing aria-labels [needs-evidence]
- **Category**: accessibility · microcopy
- **Evidence**: Floating dock pills in studio tools almost always rely on tooltips alone; without `aria-label` the dock is opaque to screen readers and voice control.
- **Knowledge**: `08-accessibility-wcag-2-2.md` (Semantic HTML; icon-only labels), `11-dock-and-floating-panel-patterns.md` (Floating dock)
- **Effort**: S
- **Impact**: accessibility

### H3 · Empty storyboard state likely "No scenes" [needs-evidence]
- **Category**: states · conversion
- **Evidence**: First-run empty states default to "No scenes yet" with no path. Should become guided onboarding: illustration + "Generate first scene" CTA + sample storyboard template.
- **Knowledge**: `09-empty-error-loading-states.md` (First-run empty state = onboarding)
- **Effort**: M
- **Impact**: conversion + activation

### H4 · Focus indicator likely brand-blue on brand-blue surfaces [needs-evidence]
- **Category**: accessibility
- **Evidence**: Brand accent often doubles as focus ring; on brand-tinted buttons the ring disappears. Needs a high-contrast outline that adapts.
- **Knowledge**: `08-accessibility-wcag-2-2.md` (Visible focus indicator)
- **Effort**: S
- **Impact**: accessibility

## Medium

### M1 · Mobile breakpoint for the timeline/canvas split [needs-evidence]
- **Category**: responsive
- **Evidence**: Two-panel canvas/timeline UIs rarely have a thoughtful <768 px collapse; usually horizontal-scroll or unreadable squish.
- **Knowledge**: `14-responsive-and-mobile-patterns.md` (One column ≤640 px)
- **Effort**: L
- **Impact**: responsive + conversion (mobile reviewers)

### M2 · Microcopy probably "Submit" / "OK" on render dialogs [needs-evidence]
- **Category**: microcopy · conversion
- **Evidence**: AI-tool dialogs frequently leak generic verbs; should be "Render video", "Generate scene", "Save draft".
- **Knowledge**: `07-conversion-patterns.md` (Verb-first CTA), `12-microcopy-and-tone.md` (Verbs on buttons)
- **Effort**: S
- **Impact**: clarity + brand voice

### M3 · Icon family likely mixed (lucide + emoji + custom) [needs-evidence]
- **Category**: brand
- **Evidence**: Creative tools commonly leak emoji / heroicons into lucide sets.
- **Knowledge**: `16-brand-system-application.md` (One icon family per product)
- **Effort**: S
- **Impact**: brand-fit

### M4 · Toast as only error surface for failed renders [needs-evidence]
- **Category**: feedback · states
- **Evidence**: Toasts vanish in 4 s — users miss multi-minute render failures.
- **Knowledge**: `15-feedback-and-status-systems.md` (Toast for non-blocking, NOT for fatal); `09-empty-error-loading-states.md` (Error: what/why/how)
- **Effort**: M
- **Impact**: clarity + conversion

## Low

### L1 · Tabular numerics on duration/time fields [needs-evidence]
- **Category**: typography
- **Evidence**: `00:03 / 00:12` timeline counters wobble without `tabular-nums`.
- **Knowledge**: `02-typography-systems.md` (Tabular numerics)
- **Effort**: S

### L2 · Optical alignment of lucide icons in dock [needs-evidence]
- **Category**: hierarchy
- **Evidence**: lucide icons are 24×24 viewbox but optical weight varies; some sit 1 px low.
- **Knowledge**: `01-visual-hierarchy.md` (Optical alignment)
- **Effort**: S

---

## Summary
- **Critical**: 3 · **High**: 4 · **Medium**: 4 · **Low**: 2 · **Total**: 13
- All findings tagged `[needs-evidence]` pending live capture re-run.
- Next pass should additionally screenshot: hover/focus, empty, loading (mid-render), error (force a failure), and ≤640 px.
