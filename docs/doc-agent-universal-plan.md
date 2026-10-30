# Universal Document Agent — implementation plan

Goal: every content document in the InfiniBot UI gets its own scoped agent
with side-panel chat, voice chat, and (where the view can support it)
live-action observation — bound to a single document, with a narrow tool
surface.

Today the `<doc-agent-panel>` is mounted on three views: `notes.ts`,
`databases.ts`, `workflows.ts`. This document plans the expansion: which
views get the panel, what new `DocAgentType`s are introduced, what
modalities each docType supports, the gateway / live-action changes
required to keep voice + observation scoped to one document, and the
risks we're taking on.

---

## 1. View inventory (`ui/src/ui/views/`)

Walked every `*.ts` file under `ui/src/ui/views/`. For each: **yes** = the
view exposes a "currently-open document" that warrants a doc-agent panel;
**no** = list/dashboard/settings/modal/utility, no single doc to scope
to.

### YES — mount a doc-agent panel

| View                                | docType          | "documentId" source                  | Notes                                                                          |
| ----------------------------------- | ---------------- | ------------------------------------ | ------------------------------------------------------------------------------ |
| `notes.ts`                          | `note`           | `ns.selected.id`                     | Already mounted. Keep as-is.                                                   |
| `databases.ts`                      | `db_row`         | `row.id`                             | Already mounted on the row page.                                               |
| `workflows.ts`                      | `workflow`       | `ws.selected.id`                     | Already mounted.                                                               |
| `content-pages.ts`                  | `content_page`   | `selectedPageId`                     | The Lit element opens a detail view when a page is selected.                   |
| `project-content-editor.ts`         | (n/a, via host)  | —                                    | This is a block editor mounted **inside** `kanban.ts`. Mount the panel on the kanban project detail (docType `project`) — not on this module directly. |
| `kanban.ts` (project detail)        | `project`        | `projectId`                          | Existing `project` docType. Mount on the project detail render path.           |
| `storyboard.ts`                     | `storyboard`     | `selectedProjectId`                  | The view's "project" is the storyboard project — different from kanban project. New docType. |
| `whiteboard.ts`                     | `whiteboard_doc` | `state.activeBoardId`                | Excalidraw scene. Use excalidraw_* tools.                                      |
| `video-editor.ts`                   | `video_composition` | `compositionId`                   | One per composition.                                                            |
| `video-studio.ts`                   | `video_composition` | active composition / project id   | Same docType — the Studio is a shell around `video-editor.ts`.                  |
| `brand-control.ts`                  | `brand_doc`      | brand profile id (`state.brand.id`)  | Single profile per workspace today, but key by id for future multi-brand.       |
| `funnels-page-editor.ts`            | `funnel_page`    | funnel `pageId`                      | The public lead-capture page belonging to one funnel.                           |
| `inbox.ts`                          | `inbox_thread`   | `selectedMessage.threadId`           | Wrapper view — delegates to inbox-all-mail / reply-inbox; only show panel when a thread is open. |
| `inbox-all-mail.ts`                 | `inbox_thread`   | `selectedMessage.threadId`           | Single-thread reading pane.                                                     |
| `reply-inbox.ts`                    | `inbox_thread`   | `selectedReplyId` → thread id         | Same docType.                                                                   |
| `docs.ts`                           | `generic`        | doc article `path`                   | In-app docs viewer. Use the existing `generic` docType — no new type needed.    |
| `notion-databases.ts`               | `db_row`         | open page id                         | Reuses `db_row` — it's still a database row, just sourced from Notion.          |
| `agents-page.ts`                    | `generic`        | agent id                             | Edit page for a single agent identity. Keep generic; the agent isn't a "doc" in the strict sense. |

### NO — not a document surface

(Listing here so the inventory is exhaustive; one-line reason each.)

`activity-panel`, `agent-activity-dashboard`, `agent-activity`, `agent-config-panel`, `agent-popup`, `agents-management`, `agents-profile-config`, `agents-real`, `agents`, `api-keys`, `appearance`, `apps`, `auth`, `autonomy`, `block-preview-html`, `browser`, `business-workspace`, `business`, `campaigns`, `canvas-overlay`, `change-notion-db-host`, `change-notion-db-modal`, `channels.*`, `characters`, `chat-sessions`, `chat.ts`, `clients`, `community-nodes`, `config*`, `debug`, `design`, `directories`, `discipline`, `docker`, `downloads`, `email-accounts`, `email-composer-host`, `email-marketing`, `exec-approval`, `export-modal`, `federation-*`, `files`, `focus`, `funnel-flow-map`, `funnels-canvas`, `funnels-detail-panel`, `funnels-flow-end-to-end`, `funnels-kpi-dashboard`, `funnels-onboarding`, `funnels-sidebar`, `funnels.ts`, `glasses`, `gmail`, `gpu-command-center`, `graph-overlay`, `grid-panels/*`, `hardware-analysis`, `hyperframes-stage`, `image-studio`, `instances`, `integrations-panel`, `kanban-agent-assignment`, `lead-campaigns`, `lead-dashboard`, `lead-pipeline`, `lead-qualifier*`, `leads`, `lead-timeline`, `learn`, `logs`, `markdown-sidebar`, `masonry-grid`, `mcp`, `memory`, `mobile`, `nav-sidebar-enhanced`, `network`, `node-selector`, `nodes`, `notifications`, `notion-conflicts-panel`, `notion-import-wizard`, `notion-schema-panel`, `ollama-monitor`, `onboarding`, `platform-features`, `preset-builder`, `products`, `projects-dashboard`, `prompt-templates`, `quickstart`, `recently-completed-feed`, `research-intel`, `room-customizer/*`, `schedule`, `services`, `sessions-spawn-dialog`, `sessions`, `setup`, `setup-wizard`, `sidebar-update-widget`, `sites`, `skills`, `socials-analytics`, `socials-dashboard`, `solana-chart`, `ssh-devices`, `system-databases-card`, `systems-intelligence`, `task-sidebar`, `template-editor`, `terminals`, `threads-sidebar-enhanced`, `toast-notifications`, `users-management`, `users`, `vault-*`, `video-block-*`, `video-stage-transform`, `video-template-gallery`, `video`, `voice-chat`, `voice-commands`, `workspace`.

Reasons by category: list/dashboard surfaces (no single document), modals,
wizards, sidebars, settings/admin, embedded sub-views (`video-block-*`),
or surfaces that ARE the agent chat already (`chat.ts`, `voice-chat.ts`,
`chat-sessions.ts` — these would conflict with the main agent surface; see
risk #4).

### Explicit skips with rationale

- **`chat-sessions.ts` / `chat.ts` / `voice-chat.ts`** — these surfaces already
  ARE the main agent. Mounting a doc-agent on a chat thread would create
  two competing chat panes on the same view. Defer until there is a clean
  "thread as document" abstraction; until then the main chat handles it.
- **`image-studio.ts`** — has many ad-hoc artifacts but no single "document"
  identity. Could add `image_doc` later when an image-project model
  exists.
- **`preset-builder.ts` / `template-editor.ts` / `prompt-templates.ts` /
  `skills.ts`** — interesting candidates, but the user's scope list does
  not include them. Treat as Phase 2 work.

---

## 2. DocAgentType extension table

Existing: `note | db_row | workflow | project | kanban_card | generic`.

New types and their per-type prompt content (kept terse, matching the
existing PER_TYPE style — 3 lines, naming the tool + the boundaries):

| New docType         | Rationale                                                      | Preferred tool / surface                              | Boundary rules                                                                                              |
| ------------------- | -------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `content_page`      | Each Content Pages hub entry is a multi-tab content asset.     | `content_pages_tool` (or `notes_tool` fallback)       | Edit the open page only. Don't switch tabs without asking. Don't bulk-create child rows.                    |
| `storyboard`        | A storyboard project: script + scenes + image gen pipeline.    | `storyboard_tool`                                     | Suggest scene edits as text first; only commit via storyboard_tool action=regenerate after user OK.         |
| `whiteboard_doc`    | One Excalidraw scene (board).                                  | `excalidraw_*` MCP tools                              | Stay on the active board. Don't clear the canvas without explicit OK. Prefer create_batch over many writes. |
| `video_composition` | One composition (timeline + blocks).                           | `compositions_tool` (+ `composition-blocks` RPCs)     | Edit the open composition. Don't render without confirmation — renders are expensive.                       |
| `brand_doc`         | The workspace's brand profile (palette, fonts, voice, guides). | `branding_tool` (gateway `branding.*` RPCs)           | Suggest palette diffs as text first. Don't overwrite the voice block; append.                               |
| `funnel_page`       | The public lead-capture page for a funnel.                     | `funnels_tool` action=`page.config.set`               | Edit copy/fields/theme. Don't publish without explicit OK.                                                  |
| `inbox_thread`      | One email thread / lead reply.                                 | `gmail_tool` (read) + `reply_dispatch` (send replies) | Reply drafts as text first; never send without explicit OK. Don't archive/trash without OK.                 |

`chat_thread` is **deferred** — see risks #4.

### DocAgentContext extension

Prefer overloading `extra` first; only add a new field when type-safety
demands. The new fields we'll add (because the type discriminates UI
state):

- No new required fields. All new types fit into the existing context
  (`documentId`, `title`, `content`, `databaseId`, `schema`, `extra`).
- `funnel_page`: pack the funnelId into `extra` so the prompt mentions it
  even though the canonical id is the page.
- `inbox_thread`: pack the accountId + sender + subject snippet into
  `extra`.
- `whiteboard_doc`: pack a one-line scene summary (element count) into
  `extra`.

`docAgentSessionKey` stays stable for existing types. New types simply
add new prefixes (`agent:<id>:doc:storyboard:<safeId>` etc.).

---

## 3. Capability matrix

Per docType, which modalities are enabled. Defaults: `side_panel_chat` ON
everywhere, `voice_chat` ON everywhere. `live_action_observe` (the agent
sees a filtered stream of what the user is doing in the document) and
`live_action_act` (the agent can drive the doc UI via tools) require
per-view controller wiring, so they're called out individually.

| docType           | side_panel | voice | live_action_observe | live_action_act |
| ----------------- | :--------: | :---: | :-----------------: | :-------------: |
| note              |     ✓      |   ✓   |          ✓          |        ✓        |
| db_row            |     ✓      |   ✓   |          ✓          |        ✓        |
| workflow          |     ✓      |   ✓   |          ✓          |        ✓        |
| project           |     ✓      |   ✓   |          ✓          |        ✓        |
| kanban_card       |     ✓      |   ✓   |          ✓          |        ✓        |
| content_page      |     ✓      |   ✓   |          ✓          |     later       |
| storyboard        |     ✓      |   ✓   |          ✓          |     later       |
| whiteboard_doc    |     ✓      |   ✓   |          ✓          |        ✓        |
| video_composition |     ✓      |   ✓   |          ✓          |     later       |
| brand_doc         |     ✓      |   ✓   |        later        |     later       |
| funnel_page       |     ✓      |   ✓   |          ✓          |     later       |
| inbox_thread      |     ✓      |   ✓   |          ✓          |     later       |
| generic           |     ✓      |   ✓   |        off          |       off       |

"later" = the view doesn't expose a stable event stream yet; we'll gate
the toggle off until the controller is wired. The capability matrix is
the server-side source of truth: `doc_agent.set_modalities` validates
requests against it before storing.

---

## 4. Risks

1. **Backwards compat for the 3 existing mounts.** notes / databases /
   workflows must keep working with zero behavior change. Mitigation:
   never alter the existing `DocAgentType` values, the existing PER_TYPE
   strings, or the existing `<doc-agent-panel>` props. All new behavior
   lives behind new types, new methods (`attach_live_action`,
   `detach_live_action`, `set_modalities`), and new optional props on the
   panel.

2. **Context budget on live-action observation.** A naive "stream every
   UI event into the agent's context" blows past the model window in
   minutes. Mitigation: per-session circular buffer of N=20 events,
   debounced to 1 event/sec, and a hard `filterEvent(ctx, event)` gate
   that drops anything whose `docScope` doesn't match the session's
   document. The panel surfaces the **last 5** observed events only.

3. **Tool-surface drift.** The doc-agent profile in `tool-policy.ts`
   already denies `exec`/`process`/`browser`. New docTypes that need
   different tools (excalidraw_* for whiteboard, compositions for video)
   need to be **additive only** — we extend the allow list, we do not
   loosen the deny list. Specifically: `exec`, `process`, `browser`,
   `cron` stay denied for ALL doc-agent sessions regardless of docType.

4. **chat_thread conflicts with the main chat agent.** A `<doc-agent-panel>`
   on a chat thread would attach a *second* agent to the same
   conversation — confusing UX. Decision: defer `chat_thread`. The
   capability matrix and PER_TYPE table will NOT include it; the prompt
   contract is unchanged.

5. **Voice routing on doc-scoped sessions.** Voice streaming today
   defaults to the grid preamble when `gridContext` is sent. We branch on
   the sessionKey shape (`agent:*:doc:*`) so a doc-scoped voice session
   gets the doc preamble + tool policy + filtered live-action context.
   Risk: a stale UI bundle could send `gridContext` against a doc
   sessionKey. Mitigation: when the sessionKey starts with `agent:*:doc:*`,
   we ignore `gridContext` and emit a single log line so a "doc voice
   used grid prompt" report has a breadcrumb.

6. **Pre-existing TS errors on this branch.** `codex.ts`,
   `goal-orchestrator.ts`, `auto-skill.ts`, `content-builder.ts` have
   errors that pre-date this work. We will not touch them; we will not
   add new errors. Each phase ends with a `pnpm build` check that
   asserts only the known pre-existing errors remain.

---

## 5. Phase checklist (mirrors the task brief)

- [x] **Phase 0** — this document.
- [ ] **Phase 1** — extend types/prompts, add `attach_live_action`,
      `detach_live_action`, `set_modalities`; widen tool-policy mapping.
- [ ] **Phase 2** — `live-action-context.ts` gains `docScope` +
      `filterEvent`; new `doc-live-action-prompt.ts`; voice-stream
      branches on doc sessionKey.
- [ ] **Phase 3** — extend `<doc-agent-panel>` with voice toggle, live
      action toggle, attach/detach lifecycle, observed-events strip;
      mount on every YES view from §1.
- [ ] **Phase 4** — unit tests on prompts, gateway methods, filterEvent.
- [ ] **Phase 5** — final build, summary at the bottom of this file.

---

## 6. Implementation summary (2026-05-27)

Implemented Phase 1–5; mounted on 12 views (3 existing + 9 new); new
types: `content_page`, `storyboard`, `whiteboard_doc`,
`video_composition`, `brand_doc`, `funnel_page`, `inbox_thread`. New
gateway RPCs: `doc_agent.attach_live_action`,
`doc_agent.detach_live_action`, `doc_agent.set_modalities`,
`doc_agent.get_modalities`. 57 unit tests across 3 files.

### Shipped

| Phase   | Files / commit                                                                                                                                              |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0       | `docs/doc-agent-universal-plan.md`                                                                                                                          |
| 1       | `src/agents/doc-agent-prompts.ts` (capability matrix + 7 new docTypes), `src/agents/tool-policy.ts` (additive allow list), `src/gateway/server-methods/doc-agent.ts` (attach/detach/set_modalities/get_modalities), `src/gateway/live-action-context.ts` (DocScope + filterEvent + modality storage), `src/gateway/doc-live-action-prompt.ts` (new) |
| 2       | `src/gateway/server-voice-stream.ts` (doc-scope branch in preamble routing; voice modality gate; grid-context isolated from doc sessions)                   |
| 3       | `ui/src/ui/components/doc-agent-panel.ts:84-153` (capabilities + voice + live-action toggles + observed-events strip), mounts in `ui/src/ui/views/{content-pages,storyboard,whiteboard,video-editor,brand-control,funnels-page-editor,inbox,notion-databases,kanban}.ts` |
| 4       | `src/agents/doc-agent-prompts.test.ts` (37 tests), `src/gateway/live-action-context.test.ts` (11 tests), `src/gateway/server-methods/doc-agent.test.ts` (9 tests). All pass.    |

### Integration points (file:line for the main hooks)

- Doc-scoped session detection (regex): `src/gateway/server-voice-stream.ts:166`
- Doc preamble selection: `src/gateway/server-voice-stream.ts:185-201`
- Voice modality gate (HTTP 403): `src/gateway/server-voice-stream.ts:174`
- Grid-context isolation on doc sessions: `src/gateway/server-voice-stream.ts:484-490`
- Capability matrix: `src/agents/doc-agent-prompts.ts:59`
- Spawn returns capabilities: `src/gateway/server-methods/doc-agent.ts:111-128`
- Attach/detach/set_modalities/get_modalities: `src/gateway/server-methods/doc-agent.ts:170-280`
- filterEvent: `src/gateway/live-action-context.ts:127`
- Panel voice/live-action toggles: `ui/src/ui/components/doc-agent-panel.ts:_toggleVoice / _toggleLiveAction`
- Observed-events strip: `ui/src/ui/components/doc-agent-panel.ts:_onLiveActionEvent`

### Deferred / not in scope

- `chat_thread` docType — would conflict with the main chat agent (two
  chats on the same view); see §4 risk #4.
- Mount on `docs.ts` (in-app docs viewer) — its LitElement doesn't
  receive a gateway client; would require a small wiring change to its
  caller. Out of scope for this PR.
- Mount on `agents-page.ts` — file is currently empty (untracked
  placeholder) on this branch; nothing to mount into.
- `live_action_act` for content_page / storyboard / video_composition /
  funnel_page / inbox_thread — the matrix has `liveActionAct: false`
  here pending per-view controller wiring. The `set_modalities` server
  clamps act=true off for these types until the views are ready.
- A real live-action event observer that emits
  `infinibot:doc-agent-event` for each doc-scope. The panel listener
  is in place; the producer side (window-wake / agent-wake / panel
  controllers ringing `dispatchEvent`) is a follow-up.

### Pre-existing issues left untouched

- TS errors in `codex.ts`, `goal-orchestrator.ts`, `auto-skill.ts`,
  `content-builder.ts`, `subagents.handlers.ts`, and a number of UI
  views (icons, lit `nothing` returns) all pre-date this work and were
  not changed.

