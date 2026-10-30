# Agent group chats: composer parity audit

The owner asked (2026-10-14, by voice) that "our group chats have access to all of our custom chat modals", read as modes, models, and modals. This doc lists every custom option in the regular 1:1 chat composer on the web (`/webchat`, `ui/src/ui/views/webchat.ts`) and on native mobile (`mobile/src/screens/ChatScreen.js`). For each one it records whether agent group chats had it before this change and how it works now.

Group chats are `agent:<owner>:groupchat-<id>` sessions. Each member agent replies in its own `agent:<id>:gcmember-<id>` session through the normal agent pipeline (`src/gateway/group-chat/*`).

## Inventory

| # | 1:1 chat option | Where (1:1) | Group chat before | Group chat now |
|---|---|---|---|---|
| 1 | **Model picker** (catalog, "Your models" allowlist, inline provider connect, local/free tags) | web `<webchat-model-picker>` → `sessions.patch {model}`; mobile: none (only shows the model in use) | Missing; members always ran their agent default | **Wired.** Group-wide model in the header (web) / composer chip + header sliders (mobile). Per-member override in "Models & thinking". Stored on the group (`settings` / `memberSettings`) and pinned on each member session before every turn through `applySessionsPatchToStore`, the same code path `sessions.patch` uses, so the allowlist and catalog checks are identical. |
| 2 | **Thinking / effort level** | web picker thinking row → `sessions.patch {thinkingLevel}`; `chat.send {thinking}` (unused by webchat) | Missing | **Wired.** Same picker, group-wide and per member. Reaches the provider as `reasoning_effort` (proven end to end, see below). |
| 3 | **Per-agent model overrides** | the agent row's default (`agents.list .model`); a session override per chat | n/a | **Wired.** Each member falls back member override > group > the agent's own default, field by field (`src/shared/group-chat/settings.ts`). The sheet shows the source as Override / Group / Agent default. |
| 4 | **Chat modes** | The 1:1 chat has **no** plan/research/persona mode switch. Its modes are session directives sent as gateway slash commands: `/think`, `/reasoning`, `/verbose`, `/elevated`, `/model`, `/queue` | Group "who replies" mode existed (everyone / round robin / moderator). Directives typed in a group were forwarded into every member's prompt as text, and the pipeline re-parsed them inline (e.g. `/think` silently changed a member's thinking) | **Wired.** The effort mode (thinking) is a first-class group setting (#2). The group's own reply mode is kept. Group slash commands (#5) set mode, model and effort. Command messages never reach members as context, which fixes the inline-directive leak. `/reasoning` and `/verbose` only change how a 1:1 transcript shows reasoning and tool chatter. Group members contribute final replies only, so these two have no effect in a group and are left out on purpose. |
| 5 | **Slash commands** | gateway-side (`src/auto-reply/commands-registry.data.ts`); webchat has no client-side menu (the legacy `/chat` view has a popup) | None. Text went to every agent | **Wired.** `/model [@agent] <ref\|default>`, `/think [@agent] <level\|default>`, `/mode <everyone\|round-robin\|moderator>`, `/stop`, `/help` (`src/shared/group-chat/commands.ts`). Handled by `groupchat.send` and by `chat.send` on a group key (so voice, Grid and topbar surfaces get them too). The web and mobile composers suggest them as you type `/` and have a terminal button. |
| 6 | **Image attachments** (button, paste, thumbnails) | web paperclip + paste → `chat.send {attachments}`; mobile image button (camera / library) | Missing | **Wired.** Same wire shape (`attachments: [{type:'image', mimeType, content}]`, same parser and 5 MB cap). Stored on the group message, shown as thumbnails, and passed as image input to every member answering that message (and to workflow steps via `groupchat.workflow.run {attachments}`). Mobile reuses the picker flow via the extracted `useImageAttach` (ChatComposer uses it too). |
| 7 | **Chat panels / panel modal** ("custom chat modals"): `show_panel` and plugin cards (FlyPic, Infinitrade, …) → `<chat-panel-card>` → Expand → `<chat-panel-modal>` | web `renderChatPanelRef`; mobile `PanelCard` | Missing. Panels stayed in the hidden member sessions | **Wired.** After each member turn the gateway collects the panel refs that run produced (`src/shared/chat-panels/panel-ref.ts`, now shared by the gateway and UI) into `groupChat.panels` on the agent's group message. Web renders the same card and modal. Mobile renders the same `PanelCard`. A member that only showed a panel (NO_REPLY text) still posts it. |
| 8 | **Model shown per reply** | web/mobile show the model on assistant turns | Missing | **Wired.** `groupChat.model` gets a chip on each reply. |
| 9 | **Agent picker** | 1:1 header (the agent is part of the session key) | Members editor (existing) | Already covered (members dialog / GroupSheet). |
| 10 | **Stop** | `chat.abort` | `groupchat.abort` (existing) | Already covered; `/stop` too. |
| 11 | **Starter suggestions** | empty-state cards | Group empty state with @mention hint (existing) | Kept. Starters are 1:1-agent prompts. |
| 12 | **Voice call button** | web `<chat-call-button>` → `robovoice.call.start {agentId, sessionKey}` | Missing | **Not wired (gap).** A call is one agent talking to you. A group turn finishes immediately and replies come in as separate member finals, which the voice pipeline doesn't speak. Supporting this needs a group-aware voice turn. |
| 13 | **Tool / plugin toggles** | none in the 1:1 composer (tools come from each agent's tool policy) | n/a | n/a. Members keep their own tool policy (e.g. the `coder` roster profile has no `show_panel`; `main` does). |
| 14 | **Prompt library / workflows panel** | none in the 1:1 composer | Group-only Workflows tab (existing) | Workflow steps now also run with each member's model/thinking. |

## Where it lives

- Shared: `src/shared/group-chat/settings.ts`, `commands.ts`, `types.ts` (`settings`, `memberSettings`, `GroupMessageMeta.panels/model/command`), and `src/shared/chat-panels/panel-ref.ts` (moved from the UI, which re-exports it).
- Gateway:
  - `src/gateway/group-chat/service.ts`: settings, images, panels, commands, and filtering commands out of member context.
  - `agent-turn.ts`: `applyMemberRunSettings`, image input, panel and model harvesting.
  - `server-methods/group-chat.ts`: `settings` / `memberSettings` on create/update, validated through `sessions.patch` against a scratch store; attachments on send and workflow.run.
  - `server-methods/chat.ts`: attachments for `chat.send` on group keys.
- Web: `ui/src/ui/features/group_chat/group-chat-view.ts`, `group-run-settings.ts` (new), `group-chat-dialog.ts`, `logic.ts`. `webchat-model-picker.ts` gained `defaultLabel` and `align="end"`, and its sheet is capped at 720px wide.
- Mobile:
  - `mobile/src/chat/ModelSheet.js` (new, reusable).
  - `mobile/src/chat/group/GroupRunSettingsSheet.js` (new), `composer-logic.js` (new, parity-tested mirror).
  - `mobile/src/chat/useImageAttach.js` (extracted).
  - Updated: `GroupComposer`, `GroupTranscript`, `GroupSheet`, `useGroupChat`, `group-logic`, `ChatScreen`.
  - New SVG icons in `infini/icons.js`.

## Proof

- **Side gateway e2e:** `scripts/verify-groupchat-composer-side-gateway.mts` runs an isolated gateway with a mock OpenAI-compatible provider. It passes 8/8:
  - create with group model + thinking and a per-member override
  - unknown model rejected
  - send with an image, where every member's provider request carries its model, `reasoning_effort` and the image
  - member sessions pinned
  - `/think @coder low` and `/mode` change the group without running agents
  - the next turns use the new settings
  - `show_panel` lands on the group message
- **Unit tests:**
  - `src/gateway/group-chat/service.test.ts` and `src/shared/group-chat/composer-parity.test.ts`
  - `ui/src/ui/features/group_chat/logic.test.ts`
  - `mobile/src/__tests__/group-composer-logic.test.js` (parity with the shared TS and the web logic)
