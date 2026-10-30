# Scheduled Agent Tasks

A scheduled task tells an agent or coding CLI to review some repos on a
schedule. Each run:

1. Produces a **standard work-suggestion report**.
2. Delivers it to the owner (Telegram and/or the Autonomy page).
3. Waits for the owner to decide on each item.

Approved items continue on their own as **verified goal runs** (see
[GOALS.md](./GOALS.md)). Before anything is deployed there is a **second
approval**. Nothing merges, pushes or deploys without an explicit approval.

```
schedule fires ─► READ-ONLY review (goal run, check = report validator)
                   └► report.json ─► validate ─► black-gold PDF ─► Telegram + UI
                                                         │
owner: Approve / Modify / Reject / Snooze (per item) ◄───┘   (+ "Approve all low-risk")
  approve ─► git worktree + branch ─► dev goal run (item checks + "has changes")
              ├ checks pass ─► "ready to deploy" (diff, evidence, plan) ─► Approve deploy / Reject
              │                    └ approve ─► deploy command (or deploy goal run) + post-deploy checks
              │                                   ├ ok ─► deployed + final report
              │                                   └ fail ─► Retry / Continue with instruction
              └ exhausted/failed ─► Retry / Continue with instruction / Reject
```

## Where it lives

| Piece | File |
|---|---|
| Types, stages, deploy-command precedence | `src/autonomy/scheduled-tasks/types.ts` |
| Report contract: TypeBox schema, semantic rules, standalone validator | `report-schema.ts` |
| Pure state machine (`transition`, `actionsFor`) | `pipeline.ts` |
| Service: tick loop, runs, decisions, effects, restart recovery | `service.ts` |
| Store: `sched_tasks`, `sched_runs`, `sched_items`, `sched_events`, `sched_meta` tables in `queue.db` | `store.ts` |
| Schedule math (reuses `src/cron/schedule.ts` croner + timezones) | `schedule.ts` |
| Goal texts for the review, dev and deploy stages | `prompts.ts` |
| PDF payloads (via `src/reports`) + Telegram texts/buttons | `render.ts` |
| Sinks: Telegram, JSONL file, memory | `delivery.ts` |
| Telegram callbacks (`st:<code>:<id>`) + force-reply instructions | `telegram.ts` |
| Singleton, boot, PDF render + `/reports` registration | `runtime.ts` |
| Seed ("InfiniBot Cloud daily review") | `seed.ts` |
| RPCs | `src/gateway/server-methods/scheduled-tasks.ts` (+ schema `protocol/schema/scheduled-tasks.ts`) |
| Agent tool `scheduled_task` | `src/agents/tools/scheduled-task-tool.ts` |
| UI: Autonomy → Scheduled | `ui/src/ui/views/autonomy-scheduled.ts` |

Hooks in shared files are one or two lines each:
- `server-methods.ts`: import, READ/WRITE spread and handler spread.
- `server-methods-list.ts`: advertised methods plus the `scheduledTask.changed` event.
- `server-runtime-state.ts`: `startScheduledTasks()` after `startGoalRunner()`.
- `telegram/bot-handlers.ts`: the `st:` callback prefix and routing for replies to `#sched-` prompts.
- `infinibot-tools.ts`: registers the tool.
- `standard-roster.ts`: adds `main` to the tool allow-list and bumps `ROSTER_VERSION`.
- `views/autonomy.ts` and `controllers/autonomy.ts`: add the "Scheduled" tab.

## Why not a cron job?

Cron jobs (`src/cron`) run an agent *turn*. Here each firing starts a
deterministic pipeline: goal run → validation → delivery → state machine.

The feature reuses the cron scheduler's `computeNextRunAtMs` and keeps its own
restart-safe `nextRunAt` in `queue.db`. On boot, a slot that was missed within
the last 6h runs once; older missed slots are skipped and logged. This keeps
`src/cron` untouched, which matters because OSS work is changing its seeders.

## Report contract (`work-suggestions-v1`)

```
{ summary, repos: [ { repo, branch, ahead, behind, openPRs, openIssues, ci, failingTests[],
                      uncommittedChanges, staleBranches[], deployStatus, notes } ],
  items: [ { id, title, why, priority P0–P3, effort S|M|L, risk low|medium|high, repo, files[],
             dev: { steps[] }, checks: GoalCheck[] (shell|file|grep|llm),
             deploy: { steps[], rollback, command?, checks?: GoalCheck[] }, approvals[] } ] }
```

- The assignee writes `report.json` into the run's artifact dir. It is told the
  run is read-only and that this file is the only thing it may write.
- `validate-report.mjs` is generated next to `report.json`. It embeds the same
  JSON schema and semantic rules, and it is the review goal run's completion
  check. So the agent gets the exact validation errors as feedback, and it
  cannot finish with a malformed report.
- **Read-only guard.** The reviewed branch refs are snapshotted before the run
  and compared after it. If a ref moved, the report shows a "Read-only
  violation". The working tree is not diffed, because the owner's shared tree
  churns on its own.

## Stages

`suggested → approved → building → awaiting_deploy (verified) → deploying → deployed`

Side stages: `snoozed`, `rejected`, `build_failed`, `deploy_failed`,
`deploy_rejected`.

- Every transition is written to `sched_events`. You can see them in the UI
  stage log and in the final PDF.
- Owner actions are `approve`, `modify` (needs text; approves with the
  change), `reject`, `snooze`, `start`, `approve_deploy`, `reject_deploy`,
  `retry` and `continue` (needs text), plus `approve_low_risk` for a whole run.
- **Dev.** The worktree is `<state>/scheduled-tasks/worktrees/<task>-<item>`
  on branch `sched/<task>/<item>`. The checks are the item's own checks plus
  a "worktree has changes" check.
- **Concurrency.** `limits.maxConcurrentBuilds` caps parallel builds per task.
  Extra items wait in `approved` until a slot frees.
- **Deploy.** If the task has an owner-configured `deployCommand`, it runs and
  it *overrides* any command the agent proposed. Otherwise the item's
  `deploy.command` runs. If neither exists, a deploy goal run executes the
  deploy plan.
  - A deploy command runs detached with `exit.code` and `out.log` files, so it
    survives a gateway restart. If it vanished during a restart, the item is
    marked `deploy_failed` and offers Retry.
  - When the item has `deploy.checks`, they must also pass.

## Surfaces

- **RPCs**
  - Read: `scheduledTasks.list`, `scheduledTasks.get`,
    `scheduledTasks.runs.get`, `scheduledTasks.items.list`,
    `scheduledTasks.items.get`, `scheduledTasks.approvals.list`
  - Write: `scheduledTasks.create` (`runNow?`), `scheduledTasks.update`,
    `scheduledTasks.delete`, `scheduledTasks.runNow`,
    `scheduledTasks.approvals.decide`
  - Event: `scheduledTask.changed`
- **Tool** `scheduled_task`: `create`, `list`, `get`, `update`, `enable`,
  `disable`, `delete`, `run_now`, `run`, `approvals`, `decide`. `create`
  accepts `at: "17:00"` plus `days` as an alternative to a cron expression.
- **Telegram**
  - One PDF and summary message per run, then one message per item with
    buttons, then an "Approve all low-risk" message.
  - The item's message is edited in place as its stage changes.
  - Modify and Continue send a force-reply prompt; your reply becomes the
    instruction.
  - Only `channels.telegram.allowFrom[0]` can decide. With no owner
    configured, nobody can.
- **UI**: Autonomy → Scheduled.
  - Task list and create/edit form.
  - "Needs you" with the same actions as Telegram.
  - In-flight items with a pipeline stepper.
  - Run history with the PDF.
  - Closed and snoozed items.

## Env

| Variable | Effect |
|---|---|
| `INFINIBOT_SCHEDULED_TASKS_DISABLE=1` | Don't start the loop. |
| `INFINIBOT_SCHEDULED_TASKS_SINK=file:/x.jsonl` | Deliver to a JSONL file instead of Telegram (tests / side gateways). |
| `INFINIBOT_SCHEDULED_TASKS_SINK=none` | No delivery. |
| `INFINIBOT_SKIP_CHANNELS=1` | Also disables Telegram delivery. |
| `INFINIBOT_SCHEDULED_TASKS_SEED=0` | Skip the seed. |
| `INFINIBOT_SCHEDULED_TASKS_PDF=0` | Text-only delivery. |
| `INFINIBOT_SCHEDULED_TASKS_TICK_MS` | Tick interval. Default 15000. |

## Seed

The seed is **"InfiniBot Cloud daily review"**: daily at 17:00 Asia/Bangkok,
Claude Code, Telegram + UI, enabled.

- **Repos are discovered, never hardcoded.** Starting from the checkout the
  gateway runs from, it looks for the branches `feat/cloud-serverless`,
  `feat/fleet` and `feat/saas-clerk-neon`, preferring the worktree checked out
  on each. It also looks for a sibling clone that has `feat/cloud-saas`.
- A fresh install has none of these branches, so nothing is seeded there.
- It seeds once. A marker in `sched_meta` stops it from coming back after the
  owner deletes it.

## Known gaps

- **Budget is iterations and time only.** There is no dollar or token cap,
  because goal runs don't meter cost.
- **No multi-tenant (SaaS) scoping.** Like goal runs, the service is a
  process singleton bound to the gateway state dir.
- **Deploy = what the command does.** The pipeline never merges or pushes by
  itself. If the owner's deploy command pushes, that happens after the explicit
  deploy approval.
- **The UI "PDF in Reports" link opens the Reports page**, not the specific
  report, because Reports has no deep link yet.
