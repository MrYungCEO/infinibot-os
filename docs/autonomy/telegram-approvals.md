# Telegram approvals

When an agent or action is blocked waiting for the operator, InfiniBot sends a
Telegram message with context and inline buttons. Tap **Approve** or **Deny**
on your phone and the blocked work resumes. The same request also appears in the
web **Approvals** inbox (the shield badge in the topbar), and it can be
answered from the CLI or with `/approve` in chat. The first answer wins.

## What asks for approval

| Source | When | Buttons |
| --- | --- | --- |
| `subagent-checkpoint` | A `claude_coder` run spawned with `requireCheckpointApproval` calls `report_checkpoint` | ✅ Approve · 🛑 Stop · ↪️ Redirect… |
| `exec` | `exec.approval.request` (a node host or gateway exec in ask mode) | ✅ Allow once · ♾️ Always · ❌ Deny · ✍️ Reply… |
| `orchestrator` | An agent or an MCP-connected Claude Code session calls `request_approval` | ✅ Approve · ❌ Deny · ✍️ Reply… |
| `autopilot` | `autonomy.approval.request` (autonomous task gate) | ✅ Approve · ❌ Deny · ✍️ Reply… |
| `tool-gate` / `custom` | `approvals.request` RPC | ✅ Approve · ❌ Deny · ✍️ Reply… |

- **✍️ Reply… / ↪️ Redirect…**: your next message in the chat becomes the note.
  For check-ins it becomes the redirect plan straight away. For everything
  else you then choose Approve or Deny with that note. Send `/cancel` to abort.
- **Bursts**: requests that arrive within `digestWindowMs` are grouped into one
  digest message with numbered buttons per item. 🔍 opens the full card.
- **Edited in place**: once a request is resolved (from any surface) or expires,
  every Telegram message showing it is edited ("✅ Approved by you at 02:14")
  and its buttons are removed.
- **Safety**:
  - Only the operator's taps and replies count, checked against `from.id`. If no
    operator id can be resolved, nothing is accepted.
  - Expiry always **denies**. For a check-in, deny means **stop**.
  - Secrets in details are redacted before anything is stored or sent.
  - Every request and resolution is appended to
    `<stateDir>/approvals/audit.jsonl`.

## Config (`infinibot.json`)

Everything is optional. By default messages go to
`channels.telegram.defaultChatId` (falling back to `allowFrom[0]`), and the
operator is `allowFrom[0]` plus a private numeric `defaultChatId`.

```json5
{
  approvals: {
    telegram: {
      enabled: true,                 // false = UI/CLI only
      chatId: "123456789",           // override delivery chat
      operatorIds: [123456789],      // who may decide (ids or @usernames)
      sources: ["exec", "orchestrator", "subagent-checkpoint", "autopilot", "tool-gate", "custom"],
      minRisk: "low",                // low | medium | high | critical
      digestWindowMs: 1500,          // burst grouping window
      minIntervalMs: 3000,           // min spacing between approval messages
    },
    checkpointTimeoutMinutes: 30,    // gated check-in expiry (expiry = stop)
  },
}
```

## Agents and MCP orchestrators

`request_approval {title, summary?, details?, risk?, timeoutSec?, waitSec?, allowRedirect?}`
blocks for up to `waitSec` (default 300 s, max 600 s). It returns
`{status: approved | denied | redirected | timed_out | pending, note}`. If the
status is `pending`, call `wait_approval {approvalId}` to keep waiting.
Requests are persisted, so a gateway restart doesn't lose them.

## CLI

```
infinibot approvals pending [--all]
infinibot approvals approve <id> [--note "…"]
infinibot approvals deny <id> [--note "…"]
infinibot approvals redirect <id> --note "…"
infinibot approvals audit
```

In chat: `/approve <id> approve|always|deny [note…]`.

## RPCs

`approvals.list | get | wait | audit` (read), `approvals.request` (write),
`approvals.resolve` (needs the `operator.approvals` scope, so an agent can
request approval but can never grant it). The WS events are
`approval.requested` and `approval.resolved`.
