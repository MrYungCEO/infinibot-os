# Visual Verification

A rerunnable, Playwright-based visual verification system for InfiniBot's UI
surfaces. It opens real browsers, drives the actual UI through its routes,
screenshots full pages + key components, diffs them against committed baselines,
runs behavioural assertions, and emits a pass/fail report.

It complements — does **not** replace — the `visual-verify-loop` skill. Use the
skill for ad-hoc, single-page "did my CSS change land?" loops. Use this suite for
systematic, multi-surface regression checks on every agent-finish, PR, and
release.

- Suite: `tests/visual/` (Playwright)
- Runner: `scripts/verify-ui.sh` (also `pnpm verify-ui`)
- Baselines: `tests/visual/__snapshots__/` (committed)
- Reports: `tests/visual/__reports__/<timestamp>/` (git-ignored)

---

## Quick start

```bash
# One-time: install the browser binary
pnpm exec playwright install chromium

# First run → creates baselines, exits 0 ("baselines created")
scripts/verify-ui.sh --surface all --report-only

# Subsequent runs → diff against baselines, exit non-zero on regression
scripts/verify-ui.sh --surface all
```

The runner:
1. Reads the gateway password from `~/.infinibot/infinibot.json`
   (`gateway.auth.password`) and exports it for the localStorage auth bypass.
2. Reuses the gateway if it's already listening on the target port, otherwise
   boots `node scripts/run-node.mjs gateway` as a child and waits for HTTP 200.
3. Serves the Expo web build (`mobile/dist`) on `:18790` when the mobile surface
   is in scope.
4. Runs the Playwright suite, writes a timestamped report, tears down children.
5. Exits non-zero on a (strict) visual diff or behavioural failure.

### Flags

| Flag | Default | Meaning |
|------|---------|---------|
| `--surface <s>` | `all` | `dashboard`, `voice`, `world`, `grid`, `setup`, `mobile`, or `all` |
| `--browsers <list>` | `chromium` | comma list: `chromium,firefox,webkit,electron` |
| `--gateway-url <url>` | `http://localhost:18789` | gateway base (accepts `ws://` too) |
| `--update-baselines` | off | write/refresh baselines, never fail |
| `--report-only` | off | diff + report, but never fail on a diff (CI-soft) |
| `--threshold <ratio>` | `0.001` | max diff pixel ratio (0.1%) for strict checks |

Env knobs: `HEADED=1` (run headed for debugging), `VERIFY_GATEWAY_PASSWORD`
(override the password lookup).

---

## What each spec covers

| Spec | Route / target | Behavioural assertions | Screenshots |
|------|----------------|------------------------|-------------|
| `dashboard.spec.ts` | `/dashboard` | app shell + `<agency-world-viz>` mount; proactive panel if present | `dashboard-full`\*, `dashboard-worldmap`\*, `dashboard-proactive` |
| `world-map.spec.ts` | `/dashboard` world map | drag `<world-timeline-scrubber>` → assert `window.__worldReplayFrame` advances | `worldmap-scrubber`\*, `worldmap-after-scrub`\* |
| `voice-terminal.spec.ts` | `/voice` | surface renders; text input accepts typed input | `voice-terminal-full`\*, `voice-terminal-typed`\* |
| `setup-wizard.spec.ts` | `/setup` | wizard renders; voice mode controls; hardware-probe button present + clickable | `setup-wizard-full`, `setup-wizard-voice`, `setup-wizard-hardware` |
| `grid-panels.spec.ts` | `/grid` | grid layout renders; panel model-selector opens | `grid-full`, `grid-model-dropdown` |
| `voice-call-mobile.spec.ts` | Expo web (`:18790`) | mobile shell renders in phone viewport; voice-call entry reachable | `mobile-shell`, `mobile-voice-entry` |
| `audio-ducking.spec.ts` | — | **TODO / fixme** (non-visual; see file header) | — |

\* = **soft** (volatile) screenshot — captured & delta-logged into the report but
never gates the build. See below.

---

## Volatile surfaces (soft checks)

The world map is a live, data-driven `<canvas>`: agent positions move every run
and the component's **width even reflows** with the agent count
(e.g. 715px → 539px). Pixel- and size-diffing a live canvas produces false
positives, so those screenshots are marked `{ soft: true }` in the spec:

- The shot is still captured and attached to the report.
- The measured delta is logged as a `soft-visual-diff` annotation.
- It **never fails** the build.

Strict (gating) screenshots — `grid-full`, `setup-wizard-full`, `mobile-shell`,
etc. — are stable between runs and DO gate. The acceptance "tweak a CSS color →
flagged" demo targets a strict surface (grid) and reports a ~0.91 diff ratio when
the panel background is changed.

To make a currently-soft surface strictly gateable later, freeze its data (seed a
fixed agent set) or mask the canvas region with Playwright's `mask` option, then
drop the `soft` flag.

---

## When to update baselines

> **Only when the UI change is intentional and has been reviewed.**

A failing strict diff means one of two things:
1. **A regression** — fix the code, do *not* touch the baseline.
2. **An intended visual change** — update the baseline, and review the diff PNGs
   in the report before committing the new baseline.

```bash
# After an intentional, reviewed UI change:
scripts/verify-ui.sh --surface <changed-surface> --update-baselines
# Inspect tests/visual/__snapshots__/<spec>/<name>-<browser>.png in the diff,
# then commit the updated baseline alongside the code change.
```

Never run `--update-baselines` to "make the build green" without looking at the
diff — that silently bakes regressions into the baseline.

The **first ever** run (no baselines present) auto-detects the empty state, runs
in update mode, prints "baselines created", and exits 0 — so bootstrapping is a
single command.

---

## Report directory structure

```
tests/visual/__reports__/
  latest -> <timestamp>/          # symlink to the most recent run
  <timestamp>/
    html/index.html               # browsable HTML summary (open this)
    results.json                  # machine-readable results (for daemons/CI)
    gateway.log                   # gateway child stdout (only if we booted it)
    mobile-serve.log              # mobile static server log (mobile surface)
    artifacts/
      <spec>-<test>-<browser>/
        <name>-expected.png       # baseline
        <name>-actual.png         # this run
        <name>-diff.png           # highlighted pixel diff
        trace.zip                 # Playwright trace (open: playwright show-trace)
```

Reports are git-ignored (`tests/visual/__reports__/.gitignore`). Baselines in
`__snapshots__/` are committed.

---

## Browsers & Electron

Projects are selected via `--browsers`. `chromium` / `firefox` / `webkit` are
standard Playwright projects. **`electron`** is currently a headed-Chromium
project pointed at the same gateway-served UI: the InfiniBot desktop app
(`electron/main.js`) loads the identical control UI over WebSocket, so a headed
Chromium run reproduces the desktop window's rendering without needing a packaged
build. When a stable test entrypoint exists for the packaged app, swap that
project for Playwright's `_electron` fixture (see `playwright.config.ts`).

Install extra browser engines as needed:
```bash
pnpm exec playwright install firefox webkit
```

---

## Integration with the release-publisher daemon (Bucket A)

The release-publisher daemon should gate commits on visual verification:

1. **Hook point.** Before the daemon commits generated UI changes, it runs:
   ```bash
   scripts/verify-ui.sh --surface all --report-only
   ```
   `--report-only` means the call never *fails* the daemon on a diff — instead
   the daemon inspects the machine-readable result and decides.

2. **Decision.** Parse `tests/visual/__reports__/latest/results.json`. Sum the
   strict (non-soft) failures and read the per-screenshot diff ratios. Suggested
   policy:
   - All strict checks pass → proceed to commit.
   - Any strict check exceeds the big-change ceiling (e.g. diff ratio > 0.30) →
     **refuse to commit**; instead post the diff report (the `*-diff.png`
     artifacts + `results.json` summary) to **PR #24** for human review.
   - `soft-visual-diff` annotations are informational only — never block on them.

3. **Wiring (env contract).** The daemon passes through:
   - `VERIFY_GATEWAY_URL` — if it already has a gateway running.
   - `VERIFY_REPORT_DIR` — to collect the report into its own run dir.
   - It reads the exit code (`--report-only` ⇒ always 0) and the JSON, not the
     exit code, for the gate decision.

> Bucket A is being built in parallel (`src/workflows/*`, off-limits to this
> change). This section documents the contract so the daemon owner can wire it;
> no daemon code is modified here.

A non-report-only invocation (`scripts/verify-ui.sh --surface all`) is the
git-hook / CI form: it exits non-zero on any strict regression and is safe to put
in a pre-push hook or CI step.

---

## Coverage matrix — in-flight agents

| In-flight work | Covered by | Status |
|----------------|-----------|--------|
| Mobile voice call background fix | `voice-call-mobile.spec.ts` | shell + voice-call entry screenshot; persistence assertion TODO once testIDs land |
| Voice setup wizard + hardware probe | `setup-wizard.spec.ts` | wizard + voice-step + hardware-probe button checks |
| World-map timeline scrubber replay | `world-map.spec.ts` | drives scrubber, asserts `window.__worldReplayFrame` advances |
| Proactive overhaul v2 | `dashboard.spec.ts` (+ future feature specs) | soft dashboard coverage + conditional `proactive-panel` shot |
| Audio ducking | `audio-ducking.spec.ts` | **TODO** — non-visual; needs a Web Audio gain assertion harness (header documents the approach) |
| npm package readiness | `infinibot release verify` (no UI) | out of scope for this suite |

---

## Missing test hooks (follow-ups)

The control UI ships **zero `data-testid` attributes** today, so specs rely on
custom-element tags (`agency-world-viz`, `voice-chat`, `world-timeline-scrubber`)
and visible text/role selectors. Each spec carries `TODO(testid)` notes for the
hooks that would harden it. These were **not** injected now because the relevant
files (`VoiceCallScreen.js`, `setup-wizard.ts`, `dashboard.ts`,
`agency-world-viz.ts`, …) are owned by other in-flight agents. Suggested additions
once those land:

- `data-testid="proactive-panel"`, `"kpi-strip"` on the dashboard
- `data-testid="voice-input"`, `"voice-send"` on the voice terminal
- `data-testid="wizard-step-voice"`, `"hardware-probe-btn"`, `"voice-mode-native/cloud"` on the wizard
- `testID="voice-call-button"`, `"active-call-pill"` in the mobile app (RN exports `testID` → `data-testid` on web)
