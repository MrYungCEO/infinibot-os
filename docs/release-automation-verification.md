# Release Automation — End-to-End Verification (Bucket D)

**Verifier:** Bucket D (read-only audit)
**Branch:** `feat/mobile-ui-federation-bundle`
**Date started:** 2026-06-17
**Repo:** `<repo>`
**PR under test:** #24 (`feat: federation routing, agency world viz, voice UI + landing refresh`, OPEN)

## Systems under verification

| Bucket | Deliverable | Integration point |
|--------|-------------|-------------------|
| **A** | `release-publisher` continuous workflow — polls subagents, auto-commits + pushes when tree dirty + all agents idle + build passes, comments on PR 24 | `src/workflows/` continuous-runner (`kind: "continuous"`) |
| **B** | `SubagentStop` hook + `~/.infinibot/hooks/agent-stop-readiness.sh` — fast typecheck + PR comment, never commits | `~/.claude/settings.json` hooks |
| **C** | `infinibot release plan/publish/verify/rollback` CLI subcommand | `src/cli/release-cli.ts` registered via `register.subclis.ts` / route-first registry |

## Shared baseline facts (captured Phase 1)

- `package.json` version: **2026.6.6** (calver `YYYY.M.P`)
- `package.json` `files[]`: 100 whitelisted `dist/<dir>/**` globs covering 100 of 102 `src/` dirs.
- **Pre-existing files[] drift (baseline):** src dirs NOT in the dist whitelist: `files`, `scripts`, `test-helpers`, `test-utils`. The first three are intentionally non-shipping (scripts ship individually; test-* never ship). This is the baseline a drift check must distinguish "expected omission" from "new src dir that should ship."
- Kill switch `~/.infinibot/release-publisher.paused`: **absent** at start (correct default = NOT paused).
- `~/.infinibot/hooks/`: **absent** at start (B will create).
- `~/.claude/settings.json` at start: permissions + effort only, **no `hooks` block** (B will add).
- CLI route: route-first via `src/cli/program/command-registry.ts` + subcli registry `src/cli/program/register.subclis.ts` (pattern: `{ name, register(program) }`). C must add a `release` entry here.

---

## TEST MATRIX

Legend: ✅ pass · ⚠️ pass-with-concern / partial · 🚫 fail/blocker · ⏳ pending (awaiting bucket landing)

### Bucket A — `release-publisher` continuous daemon

| # | Test | Method | Result |
|---|------|--------|--------|
| A1 | Workflow is registered as `kind: "continuous"` and discoverable | locate registration in `src/workflows/` | ⏳ |
| A2 | **Pause switch** — daemon no-ops when `~/.infinibot/release-publisher.paused` exists | code-read guard + create/remove kill switch around a dry tick | ⏳ |
| A3 | **Dry-run mode** — `RELEASE_PUBLISHER_DRY_RUN=1` walks all logic, performs NO commit/push/publish | controlled run with env var, inspect git tree unchanged | ⏳ |
| A4 | **Build-fail gate** — does NOT commit when typecheck/build fails | code-read guard ordering (build before commit) | ⏳ |
| A5 | **Idle gate** — only fires when all sibling subagents are idle | code-read: polls `subagents_list`/sessions | ⏳ |
| A6 | **Dirty-tree gate** — no-op when working tree is clean | code-read | ⏳ |
| A7 | **files[] drift detection** — refuses/warns when a new shipping src dir is missing from `files[]` | code-read + stash a fake `src/zzz_fake/` | ⏳ |
| A8 | **PR comment** — posts status to PR 24 (not silent) | code-read of gh/octokit call; confirm dry-run suppresses | ⏳ |
| A9 | **No push in dry-run / safety** — never pushes to git or npm under dry-run | code-read + observe | ⏳ |

### Bucket B — `SubagentStop` readiness hook

| # | Test | Method | Result |
|---|------|--------|--------|
| B1 | Hook registered in `~/.claude/settings.json` under `SubagentStop` with correct matcher | cat settings.json | ⏳ |
| B2 | Script exists + executable: `~/.infinibot/hooks/agent-stop-readiness.sh` | ls -l | ⏳ |
| B3 | **Exits quick when tree clean** | run script via stdin fake event, clean tree | ⏳ |
| B4 | **Exits quick / 0 when cwd is NOT the InfiniBot repo** | run with fake event whose cwd ≠ repo | ⏳ |
| B5 | **Respects kill switch** — no-ops when `release-publisher.paused` exists | create switch, run, confirm early exit | ⏳ |
| B6 | **Never commits** — reactive ping only; no `git commit`/`git push` in script | grep script body | ⏳ |
| B7 | **Posts to PR 24** (fast typecheck result) | code-read of gh call; do not actually post | ⏳ |
| B8 | Exit code 0 in all non-matching paths (does not block subagent stop) | run manually | ⏳ |

### Bucket C — `infinibot release` CLI

| # | Test | Method | Result |
|---|------|--------|--------|
| C1 | `release` subcommand registered + routable (`plan/publish/verify/rollback`) | grep register.subclis.ts / command-registry.ts | ⏳ |
| C2 | **`release plan`** output sane (shows current→next calver, files[] check, steps) | run command, capture output | ⏳ |
| C3 | **`release publish --dry-run`** walks all steps, NO version bump, NO commit, NO publish | run, diff package.json + git tree | ⏳ |
| C4 | **Calver bump auto-reverts on smoke-test fail** | code-read of try/finally revert; simulate if safe | ⏳ |
| C5 | **Refuses dirty tree** (non-dry real publish path) | code-read guard | ⏳ |
| C6 | **files[] drift surfaces** in plan/publish | code-read + fake src dir under stash | ⏳ |
| C7 | `release verify` / `release rollback` exist and are coherent | run/inspect | ⏳ |

### Cross-cutting integration

| # | Test | Method | Result |
|---|------|--------|--------|
| X1 | A and B both honor the SAME `~/.infinibot/release-publisher.paused` kill switch (same path constant) | grep both for the literal path | ⏳ |
| X2 | **DRY** — A reuses C's smoke-test/build helper rather than duplicating it; flag duplication | compare A's build/smoke logic vs C's | ⏳ |
| X3 | B does NOT duplicate A's commit logic (B = reactive ping only) | confirm B6 + absence of commit | ⏳ |
| X4 | files[] drift logic is consistent across A and C (same detection, ideally shared) | compare implementations | ⏳ |
| X5 | All three agree on calver scheme + PR 24 target | grep PR number / version source | ⏳ |

---

## Phase 1 status

All three buckets (A, B, C) confirmed **in flight** as active subagent runs at start:
- `Bucket A: release-publisher continuous workflow`
- `Bucket B:` (SubagentStop hook)
- `Bucket C: infinibot release CLI subcommand`

None of the deliverable files exist yet (`src/cli/release-cli.ts`, `~/.infinibot/hooks/`, settings.json `hooks` block, the `release-publisher` workflow). Polling every ~120s; Phase 2 results appended below once all three land.

---

## PHASE 2 RESULTS

_(appended after A/B/C complete)_
