# Goal runs — `/goal`-style verified autonomy

A goal run is: goal text + completion checks + any agent. The gateway keeps the
agent working until every check passes (COMPLETED), a budget runs out
(EXHAUSTED) or the agent keeps crashing or failing to start (FAILED).
**A process exiting never counts as success on its own.**

## 1. What existed before this branch

| Area | Files | State |
|---|---|---|
| Build/test orchestrator | `src/autonomy/orchestrator.ts`, `tester-agent.ts`, `retry.ts`, `self-heal.ts` | Works, but each run is one queued *kanban-style task* with a pre-fire form. "Done" comes from an LLM tester verdict; there are no deterministic checks. Hardcoded to `agentId: "coder"`. State is not durable across restarts: the file header says "stateless across process restarts on purpose". |
| Goal orchestrator ("goal mode") | `goal-orchestrator.ts`, `goal-judge.ts`, `cli-planner.ts`, `orchestrator-backends.ts` | An LLM planner spawns sub-agents. `evaluateGoal()` judges "done" from the conversation tail. If no credentials resolve it defaults to *continue*. There are no shell or file checks, so completion is judged, not verified. |
| `goal` agent tool | `src/agents/tools/goal-tool.ts` → `autonomy.goal.*` | Drives the goal orchestrator above. |
| Persistent queue | `src/queue/*` (`queue.db`), RPCs `queue.*` | Durable. **Gap:** `QueuePhase.gateCriteria` was declared but *never enforced*, so phases advanced on process exit (`getRunStatus() === "ok"`). Spawns were hardcoded to `agentId: "coder"`. `queue.*` RPCs are not in `READ_/WRITE_METHODS`, so they only work for `operator.admin` clients. |
| Durable spawns | `agents/coder-backend/durable-spawn.ts` (tmux `-L infinibot`, `<state>/subagents/durable/<runId>/{stdout,stderr}.log, exit.code`) | Solid. Survives gateway restarts. Reused as-is. |
| Session resume | `LaunchOptions.resumeSessionId` (claude `--resume`, codex `exec resume`, opencode `--session`, gemini `-r`) | Present in every backend. The `claude_coder` tool never exposed it, so nothing looped on one session. |
| UI | `ui/src/ui/views/autonomy.ts` (3.5k lines) | 3-column dashboard with 6 center tabs. Its `queue` tab duplicated the left queue rail. See §4. |

**Duplicated:** there were three separate notions of "is it done?" (tester
verdict, goal judge, queue exit status), and none of them was deterministic.
There were also two goal paths (`autonomy:queue.add {isGoal}` and the `goal`
tool), both LLM-judged.

## 2. What this branch adds (built on the pieces above)

```
src/autonomy/goals/
  types.ts     GoalCheck (shell|file|grep|llm), GoalRun, outcomes, limits
  checks.ts    runCheck/runChecks — THE checker (goal runs + queue gates)
  store.ts     goal_runs + goal_check_results tables in queue.db
  runner.ts    GoalRunner — tick loop, outcome classification, controls
  executor.ts  production executor: durable CLI coder backends / gateway agents
  service.ts   singleton, validation, WS events, notifications
src/gateway/server-methods/goals.ts      goals.* RPCs
src/gateway/protocol/schema/goals.ts     TypeBox schemas (RPCs + tool)
src/agents/tools/goal-run-tool.ts        goal_run agent/MCP tool
ui/src/ui/views/autonomy-goals.ts        <autonomy-goals-view>
```

### The loop (`runner.ts`)

1. The run is `queued`. The runner spawns the agent with the goal plus a list of the checks.
2. While the agent works, cheap checks (shell, file, grep) run every
   `checkIntervalSec`. The LLM judge runs only once all cheap checks pass. If
   every check passes mid-run, the agent is stopped and the run COMPLETES.
3. The iteration ends in one of these outcomes:

   | Outcome | Meaning |
   |---|---|
   | `exited` | Clean exit (code 0 / gateway run ok). |
   | `nonzero_exit` | Exited with a non-zero code. |
   | `crashed` | Record missing, or exit 137/139. |
   | `timeout` | Per-iteration timeout, or wall-clock hit. |
   | `hung` | No output for `hangSec`. |
   | `claimed_done_checks_failed` | Clean exit, output claims done, checks fail. |
   | `spawn_failed` | Agent could not start. |
   | `interrupted` | Pause or operator instruction. |
   | `canceled` | Run canceled. |

4. **All** checks run. If every one passes, the run is COMPLETED.
5. Otherwise the failing checks' output is fed back. The runner **resumes the
   same session** when a session id is known; if not, it respawns with the full
   goal plus the feedback. The run stops as:
   - EXHAUSTED with `max_iterations: …; failing: c1, c2` or `max_time: …`;
   - FAILED after 3 consecutive `crashed` / `spawn_failed` outcomes.
6. `interrupted` and `canceled` iterations do not count against the budget.
7. When a run finishes (unless canceled), a notification goes out through
   `sendNotification()` in `src/autonomy/notifications.ts` (Telegram, with a
   retry queue).

### Durability

- State is kept in `queue.db` (`goal_runs`, `goal_check_results`).
- CLI iterations run in durable tmux sessions (`infinibot_spawn_<runId>`). After
  a restart, status is read straight from disk: tmux liveness, `exit.code` and
  log mtimes (used for hang detection). The session id is recovered from
  `stdout.log`.
- On boot, `recover()` returns runs caught mid-check (`checking`) to
  `running`, and the next tick re-checks them.

### Checks

| type | fields | pass when |
|---|---|---|
| `shell` | `command`, `timeoutSec` | `bash -lc` in workdir exits 0 (timeout = fail; env `INFINIBOT_GOAL_CHECK=1` marks the verifier) |
| `file` | `path`, `negate` | path exists (or not) |
| `grep` | `path`, `pattern`, `negate` | JS regex matches file (or not) |
| `llm` | `criterion` | `evaluateCriterion()` in `goal-judge.ts` reads the output tail + `git diff` and returns strict JSON `{pass}`. It uses the gateway model catalog, falls back to a local CLI, and any failure counts as a fail. |
| `visual` | `routes[]`, `expectation`, `worktree?` | `visual_verify` screenshots (desktop + mobile) exist and the vision reviewer passes them against `expectation`. Costly like `llm`: runs only once cheap checks pass. See docs/principles/VERIFIED-COMPLETION.md. |

### Queue gate enforcement (`src/queue/orchestrator.ts`)

- `QueuePhase.gateCriteria` can be a list of `GoalCheck`s or the legacy text
  form: one LLM criterion per line, and a line starting with `$ ` is a shell
  command.
- A gated phase advances **only when the gate passes**, whatever the exit
  status.
- A failing gate re-queues the same phase with the failing output as feedback
  (`phaseAttempts`). After `maxAttempts` (default 3) the entry is marked `blocked`.
- The last gate result is stored on the entry (`last_gate` column, with an
  additive migration).
- Phases without a gate keep the legacy behaviour.
- New per-phase fields:
  - `agent`: a CLI backend (sent as `coderBackend`) or a gateway agent id; replaces the hardcoded `"coder"`.
  - `model`, `workdir`, `maxAttempts`.

### RPCs (in `GOALS_READ_METHODS` / `GOALS_WRITE_METHODS`, and advertised)

| RPC | Purpose |
|---|---|
| `goals.create` | `{goal, checks[], target, model?, workdir?, limits?, notify?, start?}` |
| `goals.list` | Summaries |
| `goals.get` | Run, iterations and per-check history |
| `goals.log` | Live or final agent output of an iteration |
| `goals.pause`, `goals.resume`, `goals.cancel` | Flow control |
| `goals.recheck` | Runs every check now; completes the run when all pass, including a failed or exhausted run the operator fixed by hand |
| `goals.continue {instruction}` | While running: interrupts and resumes the same session with the instruction. When finished: reopens the run with a fresh budget |
| `goals.retry` | Reopens a failed, exhausted or canceled run with a fresh budget |
| `goals.delete` | Removes a finished or paused run |

Events: `goal.created | goal.updated | goal.iteration | goal.checked |
goal.completed | goal.failed` plus `goal.changed`.

### Agent tool

`goal_run` supports `start | list | status | pause | resume | cancel | recheck
| continue | retry`.

- It is registered in `infinibot-tools.ts` and added to the roster
  allow-lists wherever `goal` was allowed: main, head-of-dev and the ops lead.
- `ROSTER_VERSION` was bumped, so seed-managed agents pick it up on the next
  boot.
- It shows up over MCP through `agent.tools.list`.
- The legacy `goal` tool's description now points to `goal_run` for verified
  work.

## 3. UI — `<autonomy-goals-view>` (the default section)

- **Composer**
  - Goal textarea.
  - "Done when" check rows, each with a type picker: Command / File exists /
    File contains / AI judge.
  - Agent picker: Claude Code, Codex, OpenCode, Gemini CLI, and every gateway
    agent from `agents.list`.
  - Model: `webchat-model-picker` for gateway agents; a free-text field with
    suggestions for CLIs, because CLI model ids aren't gateway catalog ids.
  - Project folder.
  - "Advanced limits" (collapsed): max iterations, max time, per-iteration
    timeout, check interval, hang window, notify.
  - The draft is saved to `localStorage`.
- **Runs list**: status chips (Queued, Running, Checking, Paused, Completed,
  Failed, Exhausted, Canceled) and filters (All / Active / Done / Failed).
- **Detail pane**
  - Reason banner.
  - Controls: Pause/Resume, Re-check now, Retry, Cancel/Delete.
  - Each check shows its latest result with the output and a pass/fail
    history strip.
  - Iteration timeline: outcome, exit code, `resumed` tag, duration, prompt
    sent, and the live agent log from `goals.log`. For a running CLI
    iteration it also shows the `tmux attach` command and an "Open
    Terminals" link.
  - A "Continue / add an instruction" box.
- **Updates**: live via the `goal.*` events, plus a 5-second poll while runs
  are active.
- **Styling**: tokens only (`--card`, `--text`, `--accent`, `--ok/--warn/--danger`, …).
- **Layout**: two columns on desktop, one column at ≤ 900px (list ↔ detail with
  a back button), and verified at 390px.

### Removed / moved on the Autonomy page

- The page is now **Goals | Tasks & approvals | Activity | Settings**.
  Previously it was 6 center tabs plus two always-on side columns.
- **Removed:**
  - The `QUEUE` tab (`renderQueue` / `renderQueueItem`). It duplicated the
    left task-queue rail.
  - The "Use legacy form" pre-fire button and `renderPrefireLegacyPanelForceShow`.
    It set a flag nobody read and fired an event nobody listened to.
  - The header "Test" notification button. The Telegram chip already has Test
    and Reconnect.
  - The header metrics strip (TODAY / COST); the cost moved into the Activity
    section's title.
  - The decorative aurora layer.
- **Moved:**
  - The task queue, approvals, pre-fire forms, continuous loops, oversight,
    live session and iteration history all now sit under **Tasks & approvals**
    (sub-tabs Overview / Projects). They are unchanged.
  - Audit and API usage are now under **Activity**.
  - Backend defaults are now under **Settings**.
- **Fixed:** on ≤ 900px the task-queue rail and details panel used to be
  `display: none`. They now stack.

## 4. Verification

- **Unit / e2e loop tests.** 14 in `src/autonomy/goals/runner.test.ts`:
  - pass first try;
  - fail→pass on iteration 2 with feedback and session resume;
  - exhausted after max iterations;
  - per-iteration timeout;
  - hang;
  - non-zero exit, crashes, and repeated crash → FAILED;
  - spawn failures;
  - timer completion;
  - restart recovery;
  - pause, resume, continue, recheck, cancel;
  - retry reopening;
  - LLM judge gating;
  - shell timeout.
- **Queue gate tests.** 3 new in `src/queue/orchestrator.test.ts`.
- **RPC tests.** 4 in `src/gateway/server-methods/goals.test.ts`: schema
  validation, full control flow, and registration/scopes/advertising.
- **Real end-to-end** runs used a side gateway on :18977 with its own state dir.
  Evidence is in `/tmp/autonomy-goal-shots/e2e-*.txt`.

## 5. Known gaps

- **Gateway-agent targets** use `sessions.spawn` for the first iteration and
  `agent` on the same session key to resume. After a gateway restart, the
  in-memory `agent.wait` snapshot of a *resumed* gateway-agent iteration is
  lost, so that iteration is bounded by the hang and timeout limits instead of
  an exact exit.
- **"Claimed done" detection** uses an output heuristic (`claimsDone()`). An
  exit that doesn't claim completion is still verified; it is just labelled
  `exited`.
- **Branding palettes vs light mode.** The `noir` palette writes dark-only
  inline `--text/--bg` values that override light mode app-wide. This was
  already the case before this branch. The Goals view is verified with the stock
  `base.css` light tokens.
- **Legacy paths are not yet folded in.** The build/test orchestrator and the
  LLM-judged `goal` tool (`autonomy.goal.*`) still exist in parallel.
  Recommended next step: have `autonomy:queue.add {isGoal}` create a goal run,
  then deprecate `goal-orchestrator.ts`.
- ~~Queue RPCs are still unscoped.~~ Fixed on feat/phase-system-prod: `queue.*`
  are in `QUEUE_READ_/WRITE_METHODS`, TypeBox-validated, and phases complete on
  verdict + gate on any CLI or gateway agent. See [PHASES.md](PHASES.md).
