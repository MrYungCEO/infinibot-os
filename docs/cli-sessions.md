# Persistent CLI sessions

One session concept for every surface that talks to a CLI coder: KinglyVault
Agent HQ (over the KinglyVault relay) today, and InfiniBot's own chat CLI mode
(`feat/chat-cli-switcher`) next. A session is one long-lived conversation with
one backend in one folder. Every message **continues** it; a new session only
exists when someone explicitly creates one.

Code: `extensions/kinglyvault-relay/cli-sessions.mjs` (plain ESM, no build step,
so the standalone relay link can load it without a gateway restart).
Tests: `node --test extensions/kinglyvault-relay/cli-sessions.test.mjs`.

## Backends and how a turn continues

| backend       | first turn                                         | later turns                                   |
|---------------|----------------------------------------------------|-----------------------------------------------|
| `claude-code` | `claude -p --session-id <uuid>` (uuid made at create) | `claude -p --resume <uuid>`                |
| `codex`       | `codex exec --json -`                               | `codex exec --json resume <thread_id> -`      |
| `opencode`    | `opencode run --format json -- <msg>`               | `opencode run --session <ses_…> -- <msg>`     |
| `gemini`      | `gemini --output-format stream-json -p <msg>`       | `… --resume <session_id>` (best effort)       |
| `agent`       | gateway `chat.send` on `agent:<id>:kv-<conn>-<session id>` | same sessionKey                        |
| `helper`      | (never created here) a one-off `*_coder` / `sessions_spawn` run, recorded so it is listed | `subagent_message` while it runs |

- The prompt goes on stdin (Claude Code, Codex) or after `--`, never as a flag.
- Permission flags follow `tools.coder.autoApprove` like the coder tools:
  bypass by default; `never` (or SaaS mode) → Claude `--permission-mode acceptEdits`,
  Codex `sandbox_mode=workspace-write`, no OpenCode/Gemini bypass.
- A turn only marks the session resumable (`nativeStarted`) when the CLI really
  answered, so a failed first turn (no credits, bad login) retries fresh.
- One turn at a time per session (`running` + owner pid in the index, so the
  relay link process and the gateway process both respect it). Turns time out
  after 25 minutes. `stop` kills the turn's process group.

## Storage

```
~/.infinibot/cli-sessions/sessions.json   index: id, kind, backend, agentId, title, folder,
                                           nativeId, nativeStarted, runId, origin, status,
                                           archived, turns, lastPreview, lastError, timestamps
~/.infinibot/cli-sessions/<id>.jsonl       history: {at, role: user|assistant|event|error, text}
```

Survives relay reconnects, page reloads and gateway restarts. A `running` entry
whose process is gone is read back as `idle` ("interrupted").

## Operations

| op                       | params                                          | result                          |
|--------------------------|-------------------------------------------------|---------------------------------|
| `cli.sessions.list`      | `includeArchived?`, `backend?`                   | `{sessions[], backends[]}` (+ `folders`, `bypass` over the relay) |
| `cli.sessions.history`   | `id`, `limit?`                                  | `{session, history[]}`          |
| `cli.sessions.create`    | `backend`, `folder?`, `title?`, `agentId?` (agent) | `{session}` — runs nothing   |
| `cli.sessions.send`      | `id`, `message`, `context?` (agent only, relay)  | `{session, text}` streaming     |
| `cli.sessions.stop`      | `id`                                            | `{stopped}`                     |
| `cli.sessions.rename`    | `id`, `title`                                   | `{session}`                     |
| `cli.sessions.archive`   | `id`, `archived?` (default true)                | `{session}`                     |

Two hosts expose them:

1. **KinglyVault relay** (`relay-client.mjs` → `runSessionAction`): closed
   action list + HMAC envelope like every relay action. The envelope's scope
   must match the session kind: CLI → `coder.spawn`, agent → `chat`, helper →
   `coder.spawn` or `agents.spawn`. Folders must pass `allow-dir`; sessions in
   folders that are no longer allowed disappear from the list and refuse
   turns. Every request is in the local + KV audit log.
2. **Gateway plugin RPCs** (`extensions/kinglyvault-relay/index.ts`), live after
   the next gateway restart with the plugin enabled. Operator-local, so no
   folder allowlist. `send` streams through the `cli.sessions.event`
   broadcast (`{id, text}` / `{id, event}`). Agent sessions are listed but driven
   by `chat.send` with their sessionKey.

## Note for the chat CLI-mode switcher (coder-infinibot-chat-easy-cli-mode-votg)

Please adopt this store instead of a second one, so a session started in
KinglyVault shows (and continues) in InfiniBot chat and vice versa:
per chat thread keep `cliSessionId`; on send call `cli.sessions.send`; for
"New session" call `cli.sessions.create`. If the store needs to move into core
(`src/`), keep the file format above and the `cli.sessions.*` names.
