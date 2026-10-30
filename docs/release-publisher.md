# Release Publisher (continuous workflow)

A local-only InfiniBot **continuous workflow** (`kind: "continuous"`, daemon loop)
that watches in-flight coder agents and the git working tree, then auto-commits +
pushes finished work to update the open PR. **No GitHub Actions** — everything runs
in-process in the gateway.

- Workflow id: `release-publisher-v1`
- Native tick: `src/release/publisher.ts` (`runReleasePublisherTick`)
- Helpers: `src/release/git-ops.ts`, config/state: `src/release/config.ts`

## How it works

Unlike a normal continuous workflow (which spawns a fresh agent each iteration with
its markdown body as the task), release-publisher runs a **native code tick**
registered against the workflow id via `registerNativeContinuousTick(...)` in the
continuous runner. When the daemon for `release-publisher-v1` runs an iteration it
calls the TypeScript function in-process and skips the agent spawn.

Each tick (default every 60s), in order:

1. **Kill switch** — bail if `~/.infinibot/release-publisher.paused` exists.
2. **Quiet check** — skip while any (optionally hint-matched) subagent is still
   in flight (via `listActiveSubagentRuns()` — the internal registry, not MCP).
3. **Dirty check** — skip if the working tree is clean.
4. **Build gate** — `pnpm run build` (auto-detects pnpm vs npm). A broken build is
   **never** committed; the error is recorded and (optionally) filed as a kanban task.
5. **Pack-drift gate** — `npm pack --dry-run --json` is parsed and every top-level
   `src/<subdir>` is checked against the packed `dist/<subdir>` set. If a src subdir
   would be dropped from the published tarball (a `files[]` whitelist gap), the tick
   logs and skips instead of publishing.
6. **Commit by scope** — changed files are bucketed and committed separately with
   conventional-commit prefixes so release-please-style tooling can pick them up:

   | bucket  | path prefix       | commit prefix |
   | ------- | ----------------- | ------------- |
   | docs    | `docs/`           | `docs:`       |
   | mobile  | `mobile/`         | `feat(mobile):` |
   | ui      | `ui/`             | `feat(ui):`   |
   | gateway | `src/gateway/`    | `feat(gateway):` |
   | core    | `src/`            | `feat(core):` |
   | chore   | everything else   | `chore:`      |

   Every commit message ends with the standard `Co-Authored-By: Claude …` line.
7. **Push** — `git push origin HEAD:<branch>`.
8. **PR comment** — `gh pr comment <prNumber> -b "…"` with file/scope counts.

State (last published sha, totals, last error) is persisted to
`~/.infinibot/release-publisher.state.json` via `resolveStateDir()`, so a non-default
multi-user profile gets its own namespaced state.

## Enabling it

The workflow auto-registers on first use of any `workflows.*` gateway method (so it
shows up in **Workflows** in the UI after the gateway is running). To start the daemon:

- **UI**: open the **Workflows** view, find **Release Publisher**, and start it
  (it's a continuous workflow, so it gets the start/pause/stop controls).
- **RPC**:

  ```jsonc
  // start
  { "method": "workflows.continuous.start", "params": { "id": "release-publisher-v1" } }
  // optional per-run inputs
  { "method": "workflows.continuous.start",
    "params": { "id": "release-publisher-v1",
      "inputs": { "branch": "feat/mobile-ui-federation-bundle", "prNumber": 24,
                  "waitProjectHints": "mobile,gateway" } } }
  // pause / resume / stop (use the returned runId)
  { "method": "workflows.continuous.pause",  "params": { "runId": "wfr_…" } }
  { "method": "workflows.continuous.resume", "params": { "runId": "wfr_…" } }
  { "method": "workflows.continuous.stop",   "params": { "runId": "wfr_…" } }
  ```

The running daemon appears in `workflows.continuous.list` and in the live workflows
list in the UI.

## Dry run

Set `RELEASE_PUBLISHER_DRY_RUN=1` in the gateway environment. The tick does
everything (subagent check, build, pack-drift) **except** the side effects — it logs
exactly what it *would* commit / push / comment without mutating git or the PR.

## Configuration

Optional file `~/.infinibot/release-publisher.json` (merged over defaults):

```jsonc
{
  "repoDir": "<repo>",
  "branch": null,                 // null = repo's current branch
  "remote": "origin",
  "prNumber": 24,                 // null = skip PR comment
  "waitProjectHints": [],         // [] = wait on ANY in-flight subagent
  "packageManager": "auto",       // "auto" | "pnpm" | "npm"
  "runBuild": true,
  "checkPackDrift": true,
  "push": true,
  "buildTimeoutMs": 600000
}
```

`waitProjectHints` scopes which subagents the daemon waits on: with hints set, only
subagents whose label / task / workdir contains one of the (case-insensitive)
substrings block a tick. Empty = wait on everything (safe default).

## Kill switch

```bash
touch ~/.infinibot/release-publisher.paused   # daemon skips every tick
rm    ~/.infinibot/release-publisher.paused    # resume
```

The daemon keeps ticking (and logging "paused …") so you can flip it without
stopping/restarting the workflow.

## Notes / gotchas

- The pack-drift gate is doing its job if it reports `src/release` missing: that
  package's compiled `dist/release/**` is **not** yet in `package.json` `files[]`.
  Add `"dist/release/**"` to the whitelist before the daemon can publish a tarball
  that ships this module. (package.json is intentionally not edited here.)
- `errorStreakThreshold` is `0` (never auto-stop) because transient build failures
  while agents iterate are normal; the daemon just skips and retries next tick.
