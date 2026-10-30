# Chat sidebar speech: read-aloud + talk (local by default, Cloud voice optional)

The topbar **Chat** button toggles `<agent-chat-modal>`, which is now a
right-hand, non-blocking sidebar:

- no scrim, so the page underneath stays usable
- drag its left edge to resize; the width is kept in localStorage
  (`infinibot.agentChat.sidebarWidthPx`)
- collapse it to a rail (`…sidebarCollapsed`)
- Esc closes it
- at ≤600px it's a full-width sheet

Read-aloud and talk use **local voice** by default. If you pick **Cloud voice (Robovoice)** (optional, and free), the sidebar uses it instead once the Robovoice plugin is on and linked. There are no credits, wallet or top-ups: usage is measured only to keep cloud voice fair for everyone.

## What the user sees

| State | Sidebar |
|---|---|
| Local voice (the default) | **Read aloud**, a voice picker and the talk button, all served on this computer. |
| Cloud voice picked, not linked | A one-line hint, "Link Cloud voice (Robovoice) on the Voice page, or switch back to local voice." No cloud speech controls. |
| Cloud voice picked and linked | A **Read aloud** toggle and a voice picker from Robovoice. |
| Cloud voice busy, or the daily fair-use limit reached | The controls stay visible with "Cloud voice is busy — switch to local voice" and a one-click switch. |

On each assistant reply there are **Read / Replay / Stop** buttons.

The **talk** button sits in the composer:
- Click to start and click again to stop, or hold it for push-to-talk.
- A status line shows **Recording m:ss**, then **Transcribing…**, then **Transcribed**, or an error.
- The transcript lands in the composer. You can choose to have it sent automatically.

With Cloud voice, the voice picker lists what Robovoice offers: TTS provider → model → voice, and STT provider → model. Nothing is pre-selected. Your choices persist in `infinibot.chatSpeech.prefs`, and any choice that disappears from the catalog is dropped.

## Usage and fair use

Cloud voice is free. Robovoice still records each request (one line per synthesis or transcription) so it can keep usage fair:

| Request | Ledger kind | Measured by |
|---|---|---|
| One synthesis (each chunk of ≤2,000 chars) | `tts` | Characters |
| One transcription | `stt` | Whole seconds (minimum 1) |

There is a daily fair-use limit. When cloud voice is busy or the limit is reached, Robovoice answers with an error instead of calling the provider; InfiniBot shows "Cloud voice is busy — switch to local voice" and, for 30 seconds, stops sending further cloud requests. Every request carries a `request_id`, so a retry is never counted twice.

## RPCs (`extensions/robovoice/src/speech-rpc.ts`)

| RPC | Scope | Input | Result |
|---|---|---|---|
| `robovoice.speech.catalog` | read | none | `{available:false, reason:'not_linked'\|'error'}` or the catalog, including `topUpUrl` |
| `robovoice.speech.estimate` | read | `{kind:'tts', provider, model?, text\|chars}` or `{kind:'stt', seconds}` | The estimate |
| `robovoice.speech.tts` | write | `{provider, model?, voice, text}` | `{audioBase64, mime, rating, charge}` |
| `robovoice.speech.stt` | write | `{provider, model, audioBase64, mime, durationMs}` | `{text, rating, charge}` |

Errors keep Robovoice's `code` (`not_linked`, `provider_error`, and so on). The legacy `wallet_empty` / `insufficient_balance` codes are shown to the user as "Cloud voice is busy — switch to local voice", never as a billing or top-up message.

These RPCs call the Robovoice endpoints `/api/edge/infinibot/speech{,/estimate,/tts,/stt}` with the install's `rve_` token, scoped to the linked location. The endpoints live on Robovoice branch `feat/infinibot-speech-metering`, documented in `docs/INFINIBOT-SPEECH-METERING.md`. **Until that branch is deployed to robovoice.io, the catalog answers `error` (HTTP 404) and the strip says "Robovoice speech unavailable".**
