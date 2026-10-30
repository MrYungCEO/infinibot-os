# Phase queue — multi-phase work on any coding agent

The phase queue (`src/queue/**`, `queue.db`) runs an **entry**: a brief plus an
ordered list of **phases**. Each phase can run on a different agent:

| `agent` | Runs as |
|---|---|
| `claude-code` (aliases `claude`, `cc`) | Claude Code CLI (`claude -p --output-format stream-json`) |
| `codex` | Codex CLI (`codex exec --json`) |
| `opencode` | OpenCode CLI (`opencode run --format json`) |
| `gemini` (alias `gemini-cli`) | Gemini CLI (`gemini -p … -o json`) |
| any other id | a gateway agent from `agents.list` (`sessions.spawn`) |

**A phase completes only when the run's verified-completion verdict is
VERIFIED (or operator-ACCEPTED) and the phase gate passes.** Process exit is
never success on its own (see [VERIFIED-COMPLETION](../principles/VERIFIED-COMPLETION.md)).

## Architecture

```
queue.enqueue / queue_run / infinibot queue add
        │
        ▼
 queue.db ── queue_entries · queue_attempts · queue_events · queue_meta (schema v2, lease)
        │
 QueueOrchestrator.tick()  (gateway singleton, one lease holder per state dir)
   1. reconcile running attempts ── PhaseRunner.poll(runId)
   2. unblock operator-ACCEPTED runs
   3. dispatch eligible entries (deps done · backoff over · no conflict · capacity)
        │
        ▼
 PhaseRunner (src/queue/phase-runner.ts) — one runner for every backend
   CLI: createCoderBackend(id).spawnBackground()  ← shared coder-backend layer
        · durable tmux session (survives gateway restarts)
        · COMPLETION_CONTRACT_PROMPT appended (fresh sessions)
        · verification record opened before launch (HEAD = evidence baseline)
        · same-session resume: claude --resume · codex exec resume · opencode --session · gemini -r
        · on exit → superviseRunExit(): classify → auto-continue premature exits
          on the same session → evidence + LLM review → verdict
   gateway agent: sessions.spawn (contract via buildSubagentSystemPrompt;
        reviewed on exit) · resume = `agent` on the same session key
        │
        ▼
 verdict (verified | unverified | failed | stalled | blocked | needs_input …)
   + phase gate (runChecks — shell | file | grep | llm | visual; same checker as goal runs)
   → advance exactly once · or retry with feedback · or block with a fix
```

### Entry states

`queued → running → (queued next phase …) → done`, plus `paused`, `blocked`
(needs a human; `blockedKind` + `fixHint`), `failed` (invalid spec),
`canceled`, and `dead` (dead-letter: repeated crashes / spawn failures).

| Attempt outcome | Meaning | Counts against `maxAttempts` |
|---|---|---|
| `passed` | verdict ok + gate passed → phase advanced | yes |
| `unverified` | verdict not VERIFIED (or exit ≠ 0 when verification is off) | yes |
| `gate_failed` | verified, but the gate failed | yes |
| `timeout` | per-attempt `timeoutSec` hit (process tree killed) | yes |
| `needs_input` | agent RESULT `blocked`/`needs_input` → entry blocked | no |
| `unavailable` | CLI missing / not logged in / 401 → entry blocked with login fix | no |
| `crashed`, `spawn_failed` | transient; retried with backoff, dead-letter after 5 in a row | no |
| `interrupted` | force-pause | no |
| `canceled` | cancel / operator skip | no |

Retries resume the **same agent session** when the previous attempt of the
phase ran on the same agent and reported a session id (`freshSession` opts
out). The retry prompt carries the failing verdict reasons / gate output and
any operator instruction.

### Blocked kinds → fix

| `blockedKind` | Typical fix |
|---|---|
| `gate_failed` | fix the failing checks, `queue retry` or `queue advance` |
| `unverified` | read the review; `verification.decide accept` (the queue then advances on its own) or `queue retry --instruction` |
| `needs_input` | answer the agent's open issues, `queue retry --instruction "…"` |
| `backend_unavailable` | install / log in the CLI (the fix text says how), or set `fallbackAgent` |
| `timeout` | raise `timeoutSec` / the entry `timeoutSec`, split the phase |
| `dependency_failed` | retry the dependency, then this entry |
| `invalid` | worktree/workdir problem |
| `restart` | legacy running row from before the upgrade — check the tree, retry/advance |

## Durability and concurrency

- **Exactly once.** Claims, settles and advances are conditional updates
  (`WHERE status=… AND current_phase_idx=…`) inside `BEGIN IMMEDIATE`
  transactions. The run id is written **before** anything is spawned.
- **Lease.** `queue_meta.lease_*` (30 s TTL, holder pid checked): only one
  gateway on a state dir dispatches; another one stands by. Graceful shutdown
  releases the lease (`stopQueueOrchestrator` in `server-close.ts`).
- **Restart.** Nothing is swept. Running entries are polled again: a durable
  CLI still alive in tmux is re-attached; one that finished while the gateway
  was down is reviewed from its durable `stdout.log` (the subagent registry or,
  after 90 s, the queue itself supervises it); an attempt lost with the process
  is re-queued uncounted and resumes its session.
- **Timeouts.** Per attempt (`phase.timeoutSec`, default 30 min) and per entry
  (`timeoutSec`). Timeouts and cancel kill the **whole process tree** (tmux
  pane pid + descendants: SIGTERM, then SIGKILL after 3 s) and settle the
  verification record so nothing resumes it.
- **Concurrency.** `INFINIBOT_QUEUE_MAX_CONCURRENT` (default 2). Entries don't
  head-of-line block each other. Two entries on the same repo without isolation
  run one at a time (`waitingReason: repo busy`).
- **Isolation.** `isolation: "entry"` gives the entry its own git worktree +
  branch `queue/<id8>` under `<state>/queue/worktrees/`; `"phase"` gives each
  phase `queue/<id8>-pN`, branched from the previous phase's branch.
- **Dependencies.** `dependsOn` must reference existing entries (so no
  cycles). A dependency that ends `failed`/`canceled`/`dead` blocks its
  dependents (`dependency_failed`).

## Models

`mapModelForBackend()` maps one phase `model` per backend: Claude Code, Codex
and Gemini take a bare name (a `provider/` prefix is stripped; a model from
another vendor is dropped in favour of the CLI default, with a note in the
events); OpenCode takes `provider/name` (a bare known-vendor name gets its
prefix). The requested and actual model are both recorded per attempt.

## Trust (W5)

Entries record `trusted`. Operator surfaces (RPC, CLI, UI) create trusted
entries; `queue_run` from an untrusted turn is forced to `autoApprove:false`
(`pi-tools.trust.ts`), so its phase CLIs never get the permission-bypass flag.
`tools.coder.autoApprove = "never"` always wins.

## Interfaces

**RPCs** (`QUEUE_READ_METHODS` / `QUEUE_WRITE_METHODS`, TypeBox-validated,
advertised): `queue.enqueue`, `queue.list`, `queue.get`, `queue.logs`,
`queue.metrics`, `queue.backends`, `queue.pause {force?}`, `queue.resume`,
`queue.cancel`, `queue.retry {fromPhase?, instruction?, freshSession?}`,
`queue.advance`, `queue.reorder`, `queue.setPaused`.

**Events:** `queue.entry.{created,started,paused,resumed,blocked,done,failed,canceled,dead,retried,reordered,advanced}`,
`queue.phase.{started,settled,gate,completed,retrying,timeout}`, legacy names,
and `queue.changed {id}`. Every event is also persisted to `queue_events`.

**Agent tool:** `queue_run` — `add | list | show | logs | pause | resume | cancel | retry | advance | reorder | backends`.

**CLI:** `infinibot queue add|list|show|pause|resume|cancel|retry|advance|reorder|logs [-f]|backends|metrics|dispatch on|off`.

```bash
infinibot queue add --workdir ~/code/app --isolation entry \
  --phase 'scaffold::claude-code::sonnet::Create the module skeleton' \
  --phase 'implement::codex::gpt-5.5::Implement + unit tests' \
  --phase 'docs::opencode::Document the API' \
  --gate '2:pnpm test' --gate '3:grep -q "## API" README.md'
infinibot queue show 1a2b3c4d
infinibot queue logs 1a2b3c4d -f
```

**UI:** Autonomy → **Phases** (`<autonomy-phases-view>`): dispatch toggle,
backend availability, metrics, composer, entry list, phase timeline with
backend/model/session/verdict/gate per attempt, logs, controls.

## Env

| Env | Default | Effect |
|---|---|---|
| `INFINIBOT_QUEUE` | on | `0` disables the orchestrator (RPCs still read the store) |
| `INFINIBOT_QUEUE_MAX_CONCURRENT` | 2 | concurrent running entries |
| `INFINIBOT_VERIFIED_COMPLETION` | on | `0` → exit code + gate decide (legacy) |
| `INFINIBOT_DURABLE_SUBAGENTS` | on | `0` → direct child processes (no restart survival) |
