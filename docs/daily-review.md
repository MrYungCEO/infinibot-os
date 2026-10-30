# Daily Review

**Where:** Home › Daily Review (`/daily-review`) in the control UI, plus the `daily_review` agent tool and the `daily_review.*` gateway RPCs.

The page answers three questions:

- **What got done today?** Tasks and projects worked on, what shipped (verified runs, deploys, merges), what is still running, and what needs the owner.
- **Where did the workload go?** By project → task, by type (code, video, deploy, research, design, ops), by backend and agent kind, by hour of day, plus tokens and cost over the day.
- **How productive was the day?** A transparent score (below), compared with the trailing 14-day baseline, kept for every day. History has a calendar heatmap, day/week/month trends and the project share over time.

## Data sources

Everything is read locally. Each source was checked against live data on 2026-10-26.

| Source | File(s) | What we take |
|---|---|---|
| Coder/sub-agent runs | `~/.infinibot/subagents/spawn-ledger.ndjson`, `runs.json`, `history.json` | label, task, backend, workdir, start/end, respawns, kanban link |
| Verdicts | `subagents/reviews.json` (newest verifier entry per run), `run-reviews.json` | VERIFIED / UNVERIFIED / FAILED, state (needs_owner, blocked, stalled), commit evidence, files |
| Run logs | `subagents/durable/<runId>/{meta.json,exit.code,stdout.log[.gz]}` | cost + tokens (claude `result` events, codex `turn.completed`), final RESULT block (commits, files, summary, deploy claims), Telegram sends made via MCP |
| Kanban | `~/.infinibot/kanban.db` (read-only) | tasks completed (`completedAt`), created, moved; project names |
| Git | repos and worktrees under `~/Desktop` and `~/Desktop/Development` | commits and merges per repo per day; worktrees are deduplicated by their common git dir, so each commit counts once |
| Deploys | run RESULT summaries and claims | Netlify deploy ids, Fly releases, live gateway, npm, desktop (best effort; negated phrases are ignored) |
| Chat, voice, Telegram | `~/.infinibot/agents/*/sessions/*.jsonl` | messages per day and hour, gateway LLM cost, `message`/`telegram_send` tool calls to Telegram |
| Reports | `~/.infinibot/reports/**` | documents created that day |
| Incidents | `journalctl --user -u infinibot-watchdog`, `~/.infinibot/watchdog.log` | gateway OOM kills and crashes |

Continuation passes of the same task (`<runId>-c2`, `-c3`, …) collapse into one **task**. The latest pass carries the outcome, but a later unverified follow-up does not undo an earlier verification. Time and cost add up across passes. Only explicit respawns (`respawnOfRunId`) count as rework.

All stored strings pass through a secret redactor (API keys, bot tokens, JWTs, bearer tokens, DB URLs, `key=value` secrets). Raw logs are never copied into the rollups.

## Storage

- `~/.infinibot/analytics/daily/YYYY-MM-DD.json` holds one compact record per local day: totals, per project/backend/agent/type, 24 hour buckets, runs, deploys, highlights, score, and the AI summary.
- `~/.infinibot/analytics/daily/index.json` holds one small entry per day for the history views.
- `~/.infinibot/analytics/cache/rollup-cache.json` stores byte-offset cursors per run log and per-file session buckets. Recomputing today reads only what changed, so a warm refresh takes about a second.
- `~/.infinibot/files/.daily-review/` mirrors the day files and the index. The UI reads them through `files.read` until the gateway has the `daily_review.*` handlers loaded.

## Jobs

```
node dist/daily-review/cli.js backfill [--from YYYY-MM-DD]   # all history (first run ~1 min)
node dist/daily-review/cli.js refresh                       # today (+ finalise yesterday)
node dist/daily-review/cli.js day YYYY-MM-DD
node dist/daily-review/cli.js summary [YYYY-MM-DD] [--send] [--media a.png,b.png]
node dist/daily-review/cli.js tick                          # what the timer runs
node dist/daily-review/cli.js show [YYYY-MM-DD]             # compact text
```

The systemd user timer (`deploy/systemd/infinibot-daily-review.{service,timer}`) runs `tick` every 15 minutes with low CPU and IO priority. The gateway never parses run stores itself. `daily_review.get` re-reads today's file and, when it is older than 5 minutes, refreshes it in a short-lived child process.

## Productivity score

All weights live in `src/daily-review/score.ts` (`SCORE_WEIGHTS`). The UI shows every component.

```
net points =
    10 × Σ verified tasks × (1 + size bonus)     size bonus = min(1, commits/4) + min(0.5, files/40) + 1 if it deployed   (≤ 2.5)
  +  4 × tasks done but not verified (incl. needs-you / blocked)
  +  6 × deploys not already credited to a verified task
  +  3 × kanban tasks completed that no counted run was linked to
  +  1 × git commits (deduplicated, capped at 40)
  −  4 × failed tasks
  −  2 × rework (explicit respawns)
  −  3 × incidents (gateway OOM kills / crashes)

absolute = net / (net + 60)                      60 ≈ five solid verified tasks
relative = r / (r + 1),  r = net / baseline      baseline = median net of the previous 14 active days (min 20)
score    = round(100 × (0.5 × absolute + 0.5 × relative))
```

A normal day at your own baseline lands near **50**. Twice the baseline with solid output is roughly **70+**. Failures, rework and incidents show up as negative lines. Grades: 80+ Exceptional, 65+ Strong, 45+ Solid, 25+ Light, above 0 Quiet.

## End-of-day summary

`summary` sends the capped compact rollup (at most 5,000 characters) to `claude --print --model haiku` with no MCP servers. It asks for 3-6 bullets: what shipped, what is blocked, and "Tomorrow:" with the top 3. If the model can't be reached, a rule-based fallback writes the bullets instead. The bullets are saved inside the day file.

The `tick` job writes the summary automatically at `summary.autoTime` (default 21:15). Telegram delivery is **off by default**. Switch it on from the page (Send daily at …) or with `daily_review.config.set { telegram: { enabled: true, time: "21:30" } }`. Settings live in `~/.infinibot/analytics/daily-review.config.json`. Messages go out through `infinibot message send --channel telegram`, with retry and backoff on 429.

## API

| Method | Params | Returns |
|---|---|---|
| `daily_review.get` | `{ date?, refresh? }` | full day record (today refreshed when stale) |
| `daily_review.range` | `{ range?: week\|month\|quarter\|year\|all, from?, to? }` | `{ days: DayIndexEntry[] }` |
| `daily_review.compact` | `{ date?, range? }` | `{ text }`, capped plain text |
| `daily_review.config.get` / `.set` | `{ telegram?: { enabled?, time? }, summary?: { autoTime? } }` | config |
| `daily_review.summarize` | `{ date?, send? }` | `{ summary }` |
| `daily_review.rebuild` | `{ from? }` | starts a backfill in the background |

Agent tool: `daily_review({ date?, range? })` returns at most 6,000 characters. Voice and the standard roster have it allowlisted, so "what did we do today?" is answered in one tool call.
