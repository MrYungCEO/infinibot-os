# Comms Hub — Multi-Platform Client Communication System

**Status:** Foundation scaffolded (this branch). Telegram adapter is live (reference
implementation); Email/WhatsApp/Discord/Instagram are stubbed behind a
"not configured" state with per-channel setup notes.

**Owner surface:** `/comms` (new Lit view) + `comms.*` gateway RPCs +
`src/comms/*` backend module.

---

## 1. Vision

A messaging page where a **project-manager agent** (or any agent granted the
`communication` capability) can message clients on their preferred channel, and
where **all inbound client messages aggregate into one inbox** visible to the
operator and to the assigned agent — as if the PM were a real human employee who
can be DM'd by clients or added to group chats.

Channels: **Email/Gmail, WhatsApp, Telegram, Discord, Instagram.**

Design principles:

- **One unified message model.** Every channel normalizes to the same
  `NormalizedMessage` shape. The inbox, threading, and reply UI never branch on
  channel except for capability hints (e.g. "Instagram can't send files").
- **Reuse, don't rebuild.** A Telegram bridge already exists
  (`src/telegram/*`, creds at `channels.telegram` in `~/.infinibot/infinibot.json`).
  The Telegram adapter is a thin wrapper over `sendMessageTelegram()` — it does
  not re-implement transport, auth, or config.
- **No hardcoded secrets.** Adapters read creds from the existing config
  (`~/.infinibot/infinibot.json`) or env, exactly like the Telegram bridge.
  Unconfigured channels report `configured: false` with actionable setup notes.
- **Additive only.** The client schema, agency-operations server-methods, and the
  clients UI are owned by other agents. This feature stores its extra data
  (preferred channel, per-channel handles, agent permissions, message log) in its
  **own** store + the client `data` JSON blob, and documents the exact edits the
  owned files would need rather than making them.

---

## 2. Data model

### 2.1 Channel identifier

```ts
type CommsChannel = "email" | "whatsapp" | "telegram" | "discord" | "instagram";
```

### 2.2 Normalized message (`src/comms/types.ts`)

```ts
interface NormalizedMessage {
  id: string;              // stable comms id (uuid)
  channel: CommsChannel;
  direction: "inbound" | "outbound";
  threadKey: string;       // `${clientId}:${channel}` — groups a conversation
  clientId: string | null; // resolved client, or null if unmatched
  agencyId: string;
  // Channel-native routing/identity
  channelAccountId: string | null; // which of our accounts sent/received
  peerHandle: string;      // the client's handle on this channel (chatId, email, @ig, etc.)
  peerDisplayName: string | null;
  // Content
  text: string;
  mediaUrls: string[];
  // Provenance / status
  channelMessageId: string | null; // the id the channel assigned
  status: "received" | "queued" | "sent" | "failed" | "draft" | "pending_approval";
  sentByAgentId: string | null;     // which agent authored an outbound msg
  autonomyDecision: AutonomyDecision | null; // how the agent was allowed to act
  error: string | null;
  createdAt: number;
  updatedAt: number;
}
```

### 2.3 Thread

Threads are derived, not stored separately: a thread is all messages sharing a
`threadKey` (`clientId:channel`). The store exposes `listThreads()` which returns
a rollup (last message, unread count, assigned agent, channel).

### 2.4 Client preferred-channel + handles

Lives in the client `data` JSON blob under a reserved `comms` key — **no schema
migration required**, and no edit to the off-limits `clients` files. Written and
read through `src/comms/client-channel-prefs.ts`:

```ts
// client.data.comms
interface ClientCommsPrefs {
  preferredChannel: CommsChannel | null;
  handles: Partial<Record<CommsChannel, string>>; // email, whatsapp, telegram, discord, instagram
  assignedAgentId: string | null;  // the "PM" who owns this client's comms
  optOut: CommsChannel[];          // channels the client asked not to be contacted on
}
```

The top-level `Client` already has `email`, `whatsapp`, `telegram`, `discord`,
`instagram` string columns (see `src/agency-operations/types.ts`). The prefs
module **reads those as fallback handles** and only writes the extra fields
(`preferredChannel`, `assignedAgentId`, `optOut`, per-channel overrides) into
`data.comms`, so the two representations never fight.

> **Documented edit (NOT applied — owned by other agents):**
> To surface Preferred Channel as a first-class column with a dropdown in the
> Clients CRM, `ui/src/ui/views/clients.ts` + `ui/src/ui/controllers/clients.ts`
> would add a "Preferred Channel" select bound to `data.comms.preferredChannel`
> and pass it through the existing `clients.update` `data` blob (which already
> round-trips arbitrary keys). No server change is needed because `clients.update`
> already persists the whole `data` object. See §7 for the precise patch.

### 2.5 Agent communication permission (`src/comms/autonomy.ts`)

```ts
type AutonomyLevel =
  | "suggest_only"       // agent proposes; nothing is drafted into a thread
  | "draft_for_approval" // agent writes a draft, operator must approve to send
  | "full_auto";         // agent sends without human approval

interface AgentCommsPermission {
  agentId: string;
  enabled: boolean;
  autonomy: AutonomyLevel;
  channels: CommsChannel[];      // which channels this agent may use ([] = none)
  clientScope: "all" | string[]; // "all" clients or an explicit clientId allowlist
  dailySendLimit: number | null; // null = unlimited
  updatedAt: number;
}
```

`evaluateSend()` takes a permission + a send request (agent, channel, client) and
returns an `AutonomyDecision` (`allow` | `needs_approval` | `deny`) with a reason.
The gateway `comms.send` handler enforces this fail-closed: an agent with no
permission row is denied.

---

## 3. Channel adapter layer

### 3.1 Interface (`src/comms/types.ts`)

```ts
interface ChannelAdapter {
  channel: CommsChannel;
  /** Is this channel usable right now (creds present, enabled)? */
  status(): Promise<AdapterStatus>; // { configured, enabled, accountId, setupNotes }
  /** Send an outbound message. Throws on hard failure. */
  send(req: OutboundSend): Promise<SendResult>; // { channelMessageId }
  /** Normalize a raw inbound channel payload into a NormalizedMessage. */
  normalizeInbound(raw: unknown): NormalizedMessage | null;
  /** Best-effort map a channel-native handle to one of our clients. */
  resolveClient?(peerHandle: string, agencyId: string): string | null;
}
```

Adapters are registered in `src/comms/adapters/index.ts` (`getAdapter(channel)`).

### 3.2 Per-channel status

| Channel   | Status in this branch | Transport / lib | Creds source |
|-----------|----------------------|-----------------|--------------|
| Telegram  | **Live** (reference) | `sendMessageTelegram()` (`src/telegram/send.ts`) | `channels.telegram` in `infinibot.json` (existing bridge) |
| Email/Gmail | Stub → wire to existing `emailHandlers`/`gmailHandlers` | Nodemailer / Gmail API (already in repo) | `channels.email` / Gmail OAuth |
| WhatsApp  | Stub | WhatsApp Cloud API (Meta) or Baileys | `channels.whatsapp` (to add) |
| Discord   | Stub | discord.js / bot token | `channels.discord` (to add) |
| Instagram | Stub → existing `instagramHandlers`/`manychatHandlers` | IG Graph API / ManyChat | `channels.instagram` |

Stub adapters implement `status()` truthfully (`configured: false` + setup notes)
and throw a clear "channel not configured" error from `send()`. This keeps the UI
honest — a channel shows as "Setup required" instead of silently swallowing
messages.

### 3.3 Telegram reference wiring

`src/comms/adapters/telegram.ts`:

- `status()` → `resolveTelegramAccount({ cfg: loadConfig() })`; `configured` =
  `tokenSource !== "none"`.
- `send()` → `sendMessageTelegram(peerHandle, text, { accountId, mediaUrl })`,
  returns the telegram `messageId` as `channelMessageId`.
- `normalizeInbound()` → maps a grammy update (`chatId`, `from`, `text`) into a
  `NormalizedMessage` with `direction: "inbound"`.
- Inbound delivery: the existing Telegram bot handlers
  (`src/telegram/bot-handlers.ts`) are the receive path. **Follow-up task T-1**
  adds a hook there to also call `recordInbound()` on the comms store. For the
  scaffold, inbound can be recorded via the `comms.ingest` RPC (used by tests and
  by a future bot-handler hook) so the pipeline is testable without touching the
  bot dispatch yet.

---

## 4. Unified inbox (UI)

`ui/src/ui/views/comms-hub.ts` + `ui/src/ui/controllers/comms-hub.ts`, route
`/comms`, tab `comms` (added to the **Business** nav group).

Layout: three panes —

1. **Thread list** (left): all threads, filterable by
   - assignment: *Assigned to me* / *Assigned to agent X* / *Unassigned*
   - channel chips (Telegram/Email/WhatsApp/Discord/Instagram)
   - search by client name / handle.
2. **Conversation** (center): messages for the selected thread, inbound left /
   outbound right, channel badge, autonomy badge on agent-sent messages.
3. **Composer + context** (right/bottom): reply box with channel selector
   (defaults to the client's preferred channel), send / save-draft, and a
   "drafts awaiting approval" queue with Approve/Reject.

The controller talks to the gateway with `client.request("comms.*", ...)` and
subscribes to the `comms:updated` broadcast for live inbox updates.

---

## 5. Gateway RPCs (`src/gateway/server-methods/comms.ts`)

| Method | Purpose |
|--------|---------|
| `comms.channels.status` | Per-channel `{configured,enabled,setupNotes}` for the UI. |
| `comms.threads.list` | Threads rollup, with `assignedAgentId` / channel filters. |
| `comms.thread.get` | All messages for a `threadKey` (or clientId+channel). |
| `comms.send` | Agent/operator sends an outbound message; enforces autonomy. |
| `comms.draft.approve` / `comms.draft.reject` | Approve/reject a `pending_approval` draft. |
| `comms.ingest` | Record a normalized inbound message (bot-handler hook + tests). |
| `comms.prefs.get` / `comms.prefs.set` | Read/write a client's `ClientCommsPrefs`. |
| `comms.permissions.list` / `comms.permissions.set` | Agent communication permissions. |

Registered by spreading `commsHandlers` into `coreGatewayHandlers` in
`src/gateway/server-methods.ts`, and `setCommsBroadcaster(broadcast)` in
`src/gateway/server.impl.ts` (mirrors the `clients.*` pattern). Both files are
**not** in the off-limits set.

---

## 6. Task breakdown — remaining per-channel integration work

- **T-1 Telegram inbound hook** — call `recordInbound()` from
  `src/telegram/bot-handlers.ts` so real inbound Telegram DMs land in the inbox
  (scaffold uses `comms.ingest`). Map telegram `chatId` → client via
  `ClientCommsPrefs.handles.telegram` fallback to `Client.telegram`.
- **T-2 Email/Gmail adapter** — implement `send()`/`normalizeInbound()` over the
  existing `emailHandlers` + `gmailHandlers`; poll/webhook inbound into
  `recordInbound()`. Creds already exist.
- **T-3 WhatsApp adapter** — WhatsApp Cloud API: add `channels.whatsapp` config
  (phoneNumberId, token, verifyToken), webhook receiver, media handling.
- **T-4 Discord adapter** — discord.js bot; add `channels.discord` (botToken,
  guild/DM policy); gateway intents for DMs + mentions in group channels.
- **T-5 Instagram adapter** — IG Graph API / ManyChat via existing
  `instagramHandlers`/`manychatHandlers`; DM webhook → `recordInbound()`.
- **T-6 Client resolution service** — fuzzy-match unknown inbound handles to
  clients; UI "link to client" action for `clientId: null` threads.
- **T-7 Clients CRM Preferred-Channel column** — apply the documented patch (§7)
  to the clients view/controller (owned by another agent).
- **T-8 Group-chat identity** — model the PM agent as a member of a group thread
  (multi-peer), not just 1:1 DMs.
- **T-9 Autonomy enforcement in agent tools** — expose a `send_client_message`
  agent tool that routes through `comms.send` so agents inherit the permission
  model.

---

## 7. Documented edits to off-limits files (apply later)

**`ui/src/ui/controllers/clients.ts`** — when building the edit payload for
`clients.update`, include the comms prefs already round-tripped in `data`:
no code change strictly required (the `data` blob already persists), but add a
typed accessor:

```ts
// pseudo — add to the client edit form model
form.preferredChannel = record.data?.comms?.preferredChannel ?? null;
// on save, merge back:
data.comms = { ...(data.comms ?? {}), preferredChannel: form.preferredChannel };
```

**`ui/src/ui/views/clients.ts`** — add a "Preferred Channel" `<select>` to the
client edit modal bound to the field above (options: none/email/whatsapp/telegram/
discord/instagram), and a small channel badge in the client row.

**`src/gateway/server-methods/agency-operations.ts`** — no change needed;
`clients.update` (in the non-off-limits `clients.ts` server-methods file) already
persists the whole `data` object, and `comms.prefs.set` writes there directly.

---

## 8. What is built vs stubbed (this branch)

**Built & wired:**
- `src/comms/types.ts` — full type surface (channels, messages, adapters, autonomy).
- `src/comms/store.ts` — SQLite store (`comms.db`): messages, threads rollup,
  client prefs, agent permissions, broadcaster.
- `src/comms/autonomy.ts` — permission model + `evaluateSend()` (fail-closed).
- `src/comms/client-channel-prefs.ts` — prefs read/write over the client `data` blob.
- `src/comms/adapters/telegram.ts` — **live**, over the existing bridge.
- `src/comms/adapters/{email,whatsapp,discord,instagram}.ts` — honest stubs.
- `src/comms/adapters/index.ts` — registry.
- `src/gateway/server-methods/comms.ts` — the `comms.*` RPC surface.
- `ui/src/ui/views/comms-hub.ts` + `controllers/comms-hub.ts` — the inbox view.
- Nav + route registration for `/comms`.

**Stubbed (needs the T-tasks above):**
- Email/WhatsApp/Discord/Instagram transport.
- Real Telegram inbound hook (scaffold ingests via `comms.ingest`).
- Clients CRM Preferred-Channel column (documented patch).
</content>
</invoke>
