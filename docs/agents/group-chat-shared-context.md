# Agent group chats: shared context, activity ledger and truthfulness

The fix comes from the 2026-10-14 live test group "Live test crew" (`agent:main:groupchat-mv7zfz921x6k`; members main, coder and qa). In that test:

- coder committed in its personal workspace (`~/clawd`).
- coder's push failed (no remote), but coder said "pushed to master".
- qa searched `/workspace` and the home directory, then tried to clone a URL coder had made up (`https://github.com/your-org/clawd-reports.git`).
- main said "Tool animations are now enabled" right after it had only *started* a claude_coder run.
- main said "I've created a Kanban task" without calling any kanban tool.
- Tool calls failed schema validation (`cmd` instead of `command`, `file_path` instead of `path`, `old_string` instead of `oldText`) and had to be retried with the duplicated arguments.

## What a group now has

| Piece | Where |
| --- | --- |
| **Binding**: `{ workdir, projectId, projectName, purpose }` on `GroupChatMeta.binding`, set by `groupchat.create` / `groupchat.update` (`binding: null` or a field set to `""` clears it). The workdir must be an existing absolute directory. A project with a linked GitHub local path fills in the workdir. New web groups start with the owner's current chat directory and project. | `src/gateway/group-chat/repo-info.ts`, `service.ts`, `server-methods/group-chat.ts`, `ui/.../webchat.ts` |
| **Member cwd**: every member turn runs exec / read / write / edit / apply_patch in the bound workdir, through a per-session `toolCwd` (identity files still load from the agent workspace). The bootstrap note "commit your changes in this workspace" is replaced by a note pointing at the shared repo. | `src/agents/session-tool-cwd.ts`, `pi-tools.ts`, `pi-embedded-runner/run/attempt.ts`, `group-chat/agent-turn.ts` |
| **Shared context block** in each member's system prompt (`GroupSystemPrompt` → `extraSystemPrompt`). It covers: group title, purpose, owner name, date and time zone, each member's role (first line of its `systemPrompt`) and real capabilities (shell, read-only, can start coder runs), repo path, git branch and HEAD, dirty count, remote status (it says explicitly when there is **no remote** and that nothing can be cloned), the linked kanban project, and the truthfulness rules. | `src/shared/group-chat/context.ts`, `group-chat/member-profile.ts` |
| **Activity ledger**: after each member turn, the turn's tool calls and their *real* results are read back from the member transcript and stored as `groupChat.activity` on the group message. Each entry records the command, cwd, exit code, error, output tail, files written, commit SHA, push ok or failed, spawned run id and kanban writes. Other members see the ledger under that message in their turn prompt (`formatTranscript`). A `{status:"error"}` result counts as a failure even when `isError` is false, which is how the live push failure came back. | `src/shared/group-chat/activity.ts`, `agent-turn.ts#collectTurnActivity`, `planner.ts#formatTranscript` |
| **Truthfulness post-check**: flags sentences that claim created / committed / pushed / enabled / done / tests-pass when that turn (or, for relayed third-person claims, another member's recent ledger) has no matching successful tool result. It also flags "done" when the only action was spawning a run, and placeholder or unseen git remote URLs. Future, conditional and negative sentences are never flagged. Flags are stored as `groupChat.unverified`, shown in the UI as an "Unverified" callout, and passed to the other members. | `src/shared/group-chat/truth-guard.ts`, `service.ts#reviewReply` |
| **Spawned-run results reach the group**: a subagent completion whose requester is a `gcmember-` session used to be injected as a turn into the member session, so its reply went nowhere. It is now posted into the group transcript as a status message carrying the verification verdict (`VERIFIED` / `UNVERIFIED …`). | `src/agents/subagent-announce.ts`, `server-methods/group-chat.ts#recordGroupMemberRunResult` |
| **UI**: header chip (repo · ⎇ branch · "no remote" · project), Shared-workspace fields in the create/edit dialog (web) and GroupSheet (mobile), and a per-message ledger plus Unverified callout. | `ui/.../group_chat/group-context-ui.ts`, `mobile/src/chat/group/GroupContext.js` |

## Tool-argument duplication (item D): it was our schema

`patchToolSchemaForClaudeCompatibility` adds the `file_path` / `old_string` / `new_string` aliases and removes the original keys from `required`. However, when **every** required key had an alias (read: `path`; edit: `path`, `oldText`, `newText`), the emptied list was dropped from the spread and the original `required` survived through `...schema`. AJV in pi-ai then rejected the alias call before our normalizer ran, so every call cost a validation round trip, and that round trip is where the "duplicate" args came from. write was unaffected because `content` stayed required.

`exec` had no `cmd` alias at all, and gpt-oss sends `cmd` first. Fixes:

- `required` is now rebuilt from scratch.
- `exec` accepts `cmd` (a string or an argv array), normalized to `command` in the tool-definition adapter, which is the outermost layer. The Live Action browser guard and every hook therefore still see `command`.
- Tests: `src/agents/pi-tools.claude-alias-required.test.ts`.

## Audit: what a 1:1 chat gives that group member turns did not

| Context | 1:1 chat | Group member turn before | Now |
| --- | --- | --- | --- |
| Agent identity files (SOUL / IDENTITY / AGENTS / USER / TOOLS.md) | agent workspace | same pipeline, loaded ✓ | unchanged ✓ (tool cwd is separate) |
| Memory (memory tools, memory flush) | ✓ | same pipeline ✓ | unchanged ✓ |
| Skills snapshot | ✓ | same pipeline ✓ | unchanged ✓ |
| Time zone / date | `userTimezone` from config, else host | same, but no date line | date and time zone in the context block (config → owner USER.md → host) ✓ |
| Owner name | from USER.md of *that* agent's workspace; sender = client display name | `SenderName: "Group chat"`. Members whose workspace has a template USER.md (qa) did not know the owner. | owner name from the default agent's USER.md in the context block ✓ |
| Working directory / repo | session context bar (directory / project) | **missing**: each member in its own workspace | binding plus shared cwd ✓ |
| Who the other members are and what they can do | n/a | names only | roles plus capabilities ✓ |
| Other members' tool results | n/a | **missing**: final text only | activity ledger ✓ |
| Spawned run completion | announce turn delivered to the chat | **lost** (member session has no channel) | posted to the group with its verdict ✓ |
| "Commit in this workspace" bootstrap note | correct for 1:1 | **misdirected** coder to its personal repo | replaced by a shared-repo note when bound ✓ |
| Attachments (images) | chat.send attachments | **missing** | being added by the composer-parity branch (`feat/group-chat-composer-parity`, f3537ea2): group messages store images and pass them to members |
| Model / thinking level per chat | session picker | agent default only | composer-parity branch (group and per-member settings) |
| Sender id (per-sender policies, allowlists) | client id | none | **not changed**. Member turns are owner-relayed internal turns (`CommandAuthorized`, internal provider), the same trust level as chat.send. |
| CLI-backend agents (claude-cli runner) | — | — | **open**: the `toolCwd` override and workspace note apply to the embedded runner only. A CLI-backend member still starts in its agent workspace, but the context block tells it the repo path. |
| Sandboxed agents | — | — | `toolCwd` is ignored in a sandbox by design (the sandbox mount wins). The context block still names the repo. |

## Verification

- Unit: `src/shared/group-chat/shared-context.test.ts` (ledger built from the real live failed-push transcript, guard cases from the live claims, context block), `src/gateway/group-chat/shared-context.service.test.ts`, `repo-info.test.ts`, `src/agents/pi-tools.claude-alias-required.test.ts`, `ui/src/ui/features/group_chat/ledger-logic.test.ts`, `mobile/src/__tests__/group-shared-context.test.js`.
- Side gateway e2e (scripted mock LLM, real tools, real git, temp repo with no remote): `node --import tsx scripts/verify-groupchat-shared-context-side-gateway.mts` runs 8 checks:
  - coder and qa both ran in the bound repo.
  - the `cmd` / `file_path` alias calls went straight through.
  - qa tested coder's commit (HEAD) and it passed.
  - the push failure is in the ledger and in qa's prompt.
  - coder's false "pushed" is flagged.
  - no invented URL appears anywhere.
  - main's "created a Kanban task … done" with no tool call is flagged.
