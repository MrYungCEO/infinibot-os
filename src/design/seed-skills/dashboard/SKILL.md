---
name: Dashboard
description: Admin / analytics dashboard with sidebar nav, dense data layout, charts, and KPI cards. Realistic data shape, not placeholder numbers.
od:
  mode: prototype
  platform: desktop
  scenario: operation
  preview.type: iframe
  fidelity: polished
  featured: true
  example_prompt: Build me a dashboard for a SaaS metrics tool — MAU, churn, revenue, recent signups feed.
  design_system:
    requires: true
---

# Dashboard

You produce a **single `index.html`** with a left sidebar, top topbar, and a dense main content area suitable for an admin or analytics tool.

## Hard constraints

- One file. Inline `<style>`. Charts as inline SVG or `<canvas>` with a small vanilla JS draw routine — no Chart.js / D3 dependency.
- **Realistic data shape** in every widget. Pick a plausible domain from the brief, then fabricate convincing numbers (round-trip totals to KPIs, time series with realistic shape, segmented bars that sum correctly).
- Active DESIGN.md drives color, type, spacing.

## Layout

```
<body>
  <aside.sidebar>   logo · nav (5-8 items) · footer (user, settings)
  <header.topbar>   search · date-range picker · primary action button · avatar
  <main>
    <section.kpis>      4-6 metric cards with trend arrow + delta
    <section.charts>    2-3 charts (line, bar, donut — vary, don't repeat)
    <section.table>     a recent-activity table (8-12 rows, real-feeling)
    <section.aux>       sidebar widget(s) — leaderboard, alerts, etc.
```

## Polish checklist

- [ ] KPI cards show both the absolute and the delta — not just one.
- [ ] Time-series charts have plausible noise. Straight lines look fake.
- [ ] Table rows alternate background or use a hairline between rows — never a heavy grid.
- [ ] Hover states on every interactive element.
- [ ] Anti-pattern audit against DESIGN.md.
