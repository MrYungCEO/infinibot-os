# Verified completion — a core InfiniBot principle

> **A process exiting is not success. Evidence is.**
> Every agent run ends in exactly one terminal state, that state is always
> delivered to whoever is waiting, and nothing is called "verified" unless
> the evidence says so. Visual changes need screenshots.

This applies to every agent and CLI InfiniBot runs or talks to: Claude Code,
Codex, OpenCode and Gemini sub-agents (`claude_coder` / `codex_coder` /
`opencode_coder`), gateway sub-agents (`sessions_spawn`), goal runs, and
external orchestrators connected over MCP.

## Why

These failures were observed in real runs:

| Failure | What happened | What handles it now |
|---|---|---|
| No push to MCP orchestrators | Claude Code, connected over the infinibot MCP server, had to poll PIDs, tmux and `stdout.log` because the announce to `agent:main:mcp-*` failed with `unknown channel: mcp` | Completion inbox + `subagents_wait` / `subagents_events` + MCP push |
| Premature exit looked like success | Run `coder-oss-w5-agent-tool-safety-fmuz` ended with "I'll wait for the notification." while 3 background tasks were still running. The CLI exited 0 and the run was reported done, but its regression check never ran. | Exit classifier + automatic same-session continuation |
| Unchecked claims | Reports said "tests pass" or "verified in browser" and nothing checked them | RESULT block + deterministic evidence + LLM reviewer |
| UI "fixed" without screenshots | Every agent rediscovered the headless setup: auth, profile gate, WebGL flags, overlays | `visual_verify` tool, plus a mandatory visual gate |

## The pipeline (`src/verification/`)

```
spawn ──► contract appended to the system prompt (contract.ts)
  │       completion record opened; HEAD saved as the evidence baseline (store.ts)
  ▼
process exits
  │ digest transcript (transcript.ts): final text, session id, background tasks still running
  │ classify (classifier.ts): complete | blocked | needs_input | premature | no_result | failed
  │
  ├─ premature / no RESULT ──► resume SAME session: "Continue: you exited before finishing…"
  │                            (claude --resume · codex exec resume · opencode --session · gemini -r)
  ▼
review (pipeline.ts → evidence.ts + reviewer.ts)
  │ deterministic: commits exist + on branch · files_changed == git diff · safe checks re-run
  │                · screenshots exist, are images, and are newer than the run start
  │ visual gate:   diff touches visual files ⇒ valid screenshots required (visual-files.ts)
  │ LLM reviewer:  claims vs evidence + diff ⇒ supported | unsupported | contradicted
  │ verdict:       VERIFIED | UNVERIFIED (reasons) | FAILED
  │
  ├─ UNVERIFIED with fixable gaps ──► resume with the gaps listed (e.g. "call visual_verify")
  ▼
terminal state (exactly one per round):
  verified | unverified | failed | stalled | blocked | needs_input | needs_owner  (+ accepted | rejected by an operator)
  ├─ written to the inbox FIRST   (<stateDir>/verification/events.jsonl + records.json)
  ├─ mirrored to the reviews store (subagent_reviews_* → Reviews/Oversight page, focus modal)
  ├─ WS broadcast verification.completion (UI, and the MCP bridge relays it as an MCP push)
  └─ Telegram: verdict + reasons + evidence; Continue / Retry / Accept / Reject for anything not verified
```

Continuations are bounded: `maxContinuations` per round (default 3, env
`INFINIBOT_VERIFY_MAX_CONTINUATIONS`). After that the run is `stalled` and the
operator is notified. Blocked and needs_input runs are never auto-continued,
because a human has to act. If a review comes back with the same reasons as
the previous attempt's review (same round; shas and numbers ignored), the
pipeline stops and settles `needs_owner` instead of looping. Only real
problems drive a continuation: premature exits, failing re-runs, missing
screenshots, unsupported claims. Environment warnings (below) never do. An
operator Continue or Retry opens a new round with a fresh budget.

During review and continuation the registry's liveness and stuck sweeps leave
the run alone. Continuations run durably under `<runId>-c<N>` tmux keys, and
boot recovery follows `durableKey`, so a gateway restart mid-continuation is
handled like any other durable run.

## 1. The completion contract

The contract is defined once in `COMPLETION_CONTRACT_PROMPT` (`src/verification/contract.ts`). It is appended:

- to every coder spawn (`composeSpawnSystemPrompt` in `claude-coder-tool.ts`),
  which covers all four CLI backends;
- to every gateway sub-agent (`buildSubagentSystemPrompt` in `subagent-announce.ts`).

It requires the agent to:

- never end its turn while background work it started is still running;
- only claim what it proved;
- use `visual_verify` for visual changes;
- end with exactly one RESULT block:

```
<<<RESULT
{"status":"done|blocked|needs_input","summary":"1-3 sentences",
 "commits":["<sha>"],"files_changed":["path"],
 "claims":[{"claim":"build passes","evidence_type":"command|test|screenshot|file|url","evidence_ref":"pnpm build"}],
 "checks_run":[{"command":"pnpm test src/x","exit_code":0,"output_tail":"…"}],
 "screenshots":["/abs/path.png"],"open_issues":["…"]}
RESULT>>>
```

The JSON schema is `RESULT_JSON_SCHEMA`, also returned by the
`verification.contract` RPC. The parser is tolerant: it takes the last block,
and accepts a fenced JSON body, trailing commas, a missing closing marker, a
fenced `{status, summary}` object, or a `RESULT:` heading. When there is no
block at all, the transcript heuristics in `classifier.ts` decide.

### Premature-exit signals (`classifier.ts`)

- Claude Code's own `background_tasks_changed` event still lists running tasks
  when the final `result` event arrives, and those tasks are `killed` after it
  (the W5 case; a trimmed copy is in `src/verification/__fixtures__/`).
- The final message says it is waiting or about to act ("I'll wait…", "Let me
  check…", "still running in the background", "once the build finishes…").
- The final message lists unchecked plan items.
- There is no final message, or no exit code and no end-of-run event.

A `done` RESULT sent while background tasks are still running is still classed as premature.

## 2. Evidence rules (`evidence.ts`)

| Claim evidence | How it is checked |
|---|---|
| (run tree) | Agents usually work in their own worktree branch, not the record's spawn `workdir` (the owner's checkout). The review runs against the run's tree (`run-env.ts` `resolveRunWorkspace`): the worktree whose HEAD contains every claimed commit (paths named in the RESULT first, then `git worktree list`), else the first repo named by `cd X` / `git -C X` / absolute `files_changed`, else `workdir`. `review.workspace` records which tree was used. |
| `commits` | Must exist (`git rev-parse --verify`; missing **fails**) and be reachable from the run tree's HEAD. Not being on the owner's branch is expected. A commit that exists only on another branch is a warning. A commit older than the run start is a warning. |
| `files_changed` | Compared with the run branch's `git diff base..HEAD` (base = recorded `baseCommit`, or its merge-base with HEAD if the branch was rebased), plus that tree's working-tree and untracked files. A claimed file that shows no change **fails**; a changed file that isn't listed is a warning. |
| `checks_run` / `command` / `test` | Re-run in the run tree (`bash --noprofile --norc -c`, 180s timeout, at most 3 commands). PATH = the `cd` target's and the tree's `node_modules/.bin` + a Node that satisfies `.nvmrc` / `engines.node` (highest match under `~/.nvm/versions/node`, or the gateway's own Node) + the gateway PATH. HOME is kept and secret-looking env vars (tokens, keys, passwords, DB URLs) are removed. A leading `PATH=… cmd` assignment is stripped (the verifier sets PATH). Only commands on the safe allowlist are re-run: build, test, lint and typecheck via pnpm/npm/yarn/bun, vitest, jest, tsc, pytest, go and cargo, read-only git (also `git -C dir …`), optionally prefixed with `cd … &&` or `timeout N`. Anything with rm, git push/reset, curl, sudo, install, deploy, restart, docker, etc. is never executed. If a claimed pass really fails on re-run the verdict is **FAILED**. |
| environment | A re-run that could not run here is a **warning** marked `environment`, never a failed claim: exit 127 / command not found, engines mismatch, missing `node_modules` or worktree, timeout, ENOSPC / OOM, or vitest passing but not exiting. These appear in `review.warnings`. The LLM reviewer is told to ignore them, and an "unsupported" objection to such a claim is downgraded to a warning. |
| `screenshot` | The file must be an absolute path, a PNG/JPEG over 1 KB, and have an mtime newer than the run start. |
| `file` | The path exists. |
| `url` | Not fetched automatically; recorded as a warning. |

If the LLM reviewer cannot be reached, a run can still be VERIFIED, but only
when every claim was proven deterministically.

## 3. Visual changes need visual verification

`visual-files.ts` decides what counts as visual:

- `ui/src/ui/{views,components,styles,…}`
- `ui/src/styles*`
- `mobile/src/{screens,components,navigation,theme,styles}`
- `electron` / `apps/*` renderer code
- `docs/**/*.html`
- public assets
- any `.css`, `.scss` or `.html` outside build and test folders

Tests, controllers, stores and backend code do not count. If the diff touches
any visual file and the run has no valid screenshot, the verdict is UNVERIFIED
and the run is continued with instructions to use `visual_verify`.

### `visual_verify` — the standard harness

This is an agent tool, so every agent and every MCP client gets it (Codex,
OpenCode and Gemini included, not just Claude Code). The RPC equivalent is
`verification.visual`. It runs in a child process
(`src/verification/visual/runner-cli.ts`), so a browser crash can't take the
gateway down.

**Inputs**

| Input | Meaning |
|---|---|
| `routes[]` | Pages to capture. |
| `expectation` | What the screenshots should show; the vision model grades against it. |
| `worktree` | A worktree to serve `<worktree>/dist/control-ui` from, on a free loopback port. Omit it (or pass `"live"`) to use the live UI. |
| `distDir`, `baseUrl` | Serve a different directory, or load a different URL. |
| `viewports` | Default 1440×900 and 390×844. |
| `themes` | Default `dark`. |
| `actions` | click, type, press, wait, scroll, hover, eval — selectors pierce shadow DOM. |
| `crops` | Selector or clip rectangles to capture separately. |
| `waitFor` | A selector to wait for before capturing. |
| `compareTo` | Baseline screenshots to compare against. |

**What it handles for you**

- **Auth:** sets `localStorage["infinibot.control.settings.v1"] = {gatewayUrl, password|token}` before the app boots. In worktree mode the side server proxies `/api/*` to the gateway with the credential injected.
- **Profile gate:** sets `sessionStorage["infinibot.profiles.gatePassed"] = "1"`, and clicks "Continue as …" if the chooser still appears.
- **WebGL:** launches Chrome with `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist`.
- **Overlays:** hides the proactive, missions and toast overlays.
- **Diagnostics:** records console errors, page exceptions, failed HTTP requests and failed gateway RPCs (WS `res ok:false` matched back to the method).

**Output:** `<stateDir>/verification/<runId>/visual-<ts>/*.png`, plus
`report.json` and `result.json`. The result includes a vision assessment
(`judgeText` with images: vision-capable models from the judge chain first,
then a Claude CLI fallback that reads the files).

Goal runs can use the same harness as a check:
`{type:"visual", routes:[…], expectation:"…", worktree?}`. It is treated as a
costly check (like `llm`), so it runs only after the cheap checks pass.

## 4. Reliable completion notifications

Every terminal state is written to the inbox **before** any push is attempted:

| Consumer | How it learns about completions |
|---|---|
| MCP orchestrators (Claude Code, Codex, Cursor…) | `subagents_wait({runIds, mode:"all"\|"any", timeoutSec≤600})` blocks until the runs are terminal. `subagents_events({cursor, waitSec?, terminalOnly?})` is a cursor feed scoped to the caller's session. The MCP bridge also pushes each terminal event for runs this session spawned as an MCP `notifications/message` (logging) and as `notifications/claude/channel`. |
| Gateway agents (main, Telegram) | The existing announce flow now includes the verdict and tells the agent not to present unverified claims as facts. For `agent:*:mcp-*` requesters, announce no longer calls `agent` (which failed with "unknown channel: mcp"); the inbox is the delivery path. |
| Control UI | `verification.completion` WS event. Verdict chip on Oversight rows; `<completion-verdict>` on the run detail page and in the agent focus modal, with screenshots served from `GET /api/verification/file` (auth-gated, verification dir only). |
| Telegram (owner) | `INFINIBOT_VERIFY_TELEGRAM=problems` (default) sends only non-verified runs; `all` or `off` are the alternatives. Buttons `vc:<continue\|retry\|accept\|reject>:<token>` are owner-only. |

The MCP server's `instructions` (from `MCP_ORCHESTRATOR_LINES`) tell connected clients to:

- delegate, then await with `subagents_wait` / `subagents_events`;
- never poll PIDs, tmux or logs;
- relay work as done only when it is VERIFIED;
- require `visual_verify` screenshots for visual changes.

The MCP gateway call timeout now scales with the blocking tools: a
`subagents_wait` call gets `timeoutSec + 30s` and `visual_verify` gets 11 min.

### Claude Code push (`--channels`)

The infinibot MCP server declares the experimental `claude/channel`
capability and emits `notifications/claude/channel` with
`{content, meta:{run_id, state, verdict}}`. Start Claude Code with the channel
enabled:

```bash
claude --channels server:infinibot          # research preview; exact flag per your Claude Code version
# development builds: claude --dangerously-load-development-channels server:infinibot
```

Clients without channel support still receive the MCP logging notification if
they enabled logging. `subagents_wait` and `subagents_events` work everywhere,
so treat pushes as a convenience and the inbox as the source of truth.

## 5. APIs for other pipelines

These are the integration points for scheduled agent tasks, goal runs and
external orchestrators:

| RPC | Use |
|---|---|
| `verification.contract` | The schema and prompt text to inject into your own spawns. |
| `verification.start {runId, task, workdir?, backend?, requesterSessionKey?, label?, tags?, maxContinuations?}` | Opens a record and captures HEAD as the baseline. Call this before your agent starts. |
| `verification.submit {runId, exitCode, rawOutput? \| finalText?, sessionId?, continue?, wait?}` | Hands an exited attempt to the pipeline: classify, continue (coder backends), review, terminal. |
| `verification.wait {runIds, mode?, timeoutSec≤110}` / `verification.events {cursor, requesterSessionKey?, runIds?, terminalOnly?}` | Await the result. |
| `verification.get` / `verification.list` | Read the full record: attempts, RESULT, review, evidence. |
| `verification.review {runId, settle?, rerun?}` | Re-run the evidence review, e.g. after a manual fix. Works on terminal runs; `settle` (default true) moves the state to the new verdict (owner Accept/Reject is kept); `rerun:false` skips re-running build/test checks. |
| `verification.decide {runId, action: continue\|retry\|accept\|reject, note?}` | Operator decision. |
| `verification.visual {…visual_verify input}` | The harness, over RPC. |

**Scheduled agent tasks (`feat/scheduled-agent-tasks`)**

- If a task spawns through `claude_coder` / `codex_coder` / `opencode_coder` / `sessions_spawn`, it is covered automatically. Store the returned `runId` and await it with `verification.wait`, or follow `verification.events`.
- If it spawns its own processes, call `verification.start` before the spawn and `verification.submit` on exit.
- Put the task id in `tags` so records can be traced back to it.
- Treat only `verified` (or `accepted`) as success. `stalled`, `blocked`, `needs_input` and `needs_owner` should surface in the task's own UI.

**Goal runs**

- Use `{type:"visual"}` checks for UI goals.
- Goal iterations spawned through the goals executor are separate from the coder pipeline. Goals keep their own shell/file/grep/llm checks, which are already deterministic.

## Configuration

| Env | Default | Effect |
|---|---|---|
| `INFINIBOT_VERIFIED_COMPLETION` | on | Set to `0` to disable the pipeline and the contract injection (escape hatch). |
| `INFINIBOT_VERIFY_MAX_CONTINUATIONS` | 3 | Automatic resumes per round. |
| `INFINIBOT_VERIFY_TELEGRAM` | `problems` | `all` / `problems` / `off`. |
| `INFINIBOT_VISUAL_CHROME` | auto | Chrome binary for `visual_verify`. |
| `ANTHROPIC_GOAL_JUDGE_MODEL` | unset | Judge override (`provider/model`, or a bare Anthropic id). Tried first. |

| Config | Effect |
|---|---|
| `verification.judgeModel` / `verification.judgeFallbacks` | Reviewer, goal-check and vision judge (`provider/model`). |
| `verification.judgeTimeoutMs` | Per-attempt API timeout (default 90s; CLI judges get at least 180s). |
| `channels.telegram.defaultChatId` | Where verdicts are sent (same chat as reports). `allowFrom[0]` is only a fallback. |

**Judge chain** (`src/autonomy/judge-models.ts`): env override → `verification.judgeModel` + fallbacks → the agent default model + its fallbacks → the first model of each configured provider, then cheap defaults for anthropic/openai/openrouter/google → the logged-in `claude` / `codex` / `opencode` CLIs. A judge without a key is skipped. Reasoning models get a bigger budget. An answer that is not the expected JSON moves on to the next judge. Each failed attempt is logged with its provider/model and error. The review records the judge that answered (`review.llm.judge`), plus the failures.

**Evidence files:** a claim whose `evidence_ref` names files (`/tmp/result.json; a.b=true`, `pnpm build (exit 0, /tmp/build.log)`, `a.png, b.png`) is checked by reading them, not re-running anything. JSON is parsed and the claim's `field=value` assertions are compared. Logs are tailed. Images need a real size and an mtime at or after the run start. Bounded excerpts go to the LLM reviewer.

**Restarts:** an attempt that dies while the gateway is stopping, or a continuation that cannot start, is marked `interrupted` (not terminal). About 45s after the next boot, it is re-reviewed from its last RESULT. A continuation killed after a complete attempt is reviewed from that attempt's RESULT; it no longer FAILs the run.

## Known limits

- **Operator Continue / Retry after the run is archived.** The continuation still runs durably and settles through the pipeline, but the activity feed row does not come back.
- **Gateway sub-agents (`sessions_spawn`)** are reviewed and delivered, but not auto-continued, because there is no CLI session to resume. Use `verification.decide` to retry them.
- **URL evidence** is recorded, not fetched.
- **Command re-runs** are limited to the safe allowlist and to 3 per review.
