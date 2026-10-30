# Voice: latency and audio output

How a Robovoice call's turn gets its answer from InfiniBot quickly, how the
agent's voice reaches the right speaker, and how to see what went wrong when a
turn is slow or silent.

## 1. Fast path for voice turns

Robovoice runs STT and TTS; it calls InfiniBot for the LLM step
(`POST /plugins/robovoice/voice-llm/v1/chat/completions`, streamed).

A full agent run spends seconds before the model is asked (session store,
skills, tool list, a very large system prompt). On the live gateway that was
6.9–15.8 s to the first token for "hello", of which the model itself was ~1.7 s.

`voiceLlmMode` (plugin setting, default `auto`):

| mode    | what a turn does |
| ------- | ---------------- |
| `auto`  | One direct streaming model call with a short persona + speakable-reply prompt and the call's recent turns (`src/gateway/voice/voice-fast-turn.ts`). It answers small talk only; everything else is handed to the full agent after a short spoken acknowledgement (see Routing below). A fast step that fails before saying anything falls back to the full agent. |
| `agent` | Every turn is a full agent run (the old behaviour). |

- `voiceLlmFastModel` (`provider/model`, optional): model of the fast step.
  Default is the agent's own model. A lower first-token model (for example a
  Groq or Cerebras key in `models.providers`) lowers the floor further.
- Trust is unchanged: the fast step has no tools; a hand-off runs on the same
  `voicecall:` / `voicecall-owner:` session key as before.
- The full agent returns at the run's own end instead of waiting for
  `agentCommand`'s bookkeeping, so the last sentence reaches TTS ~1 s sooner.
- Set from the Voice page → **Voice LLM**, or
  `robovoice.voiceLlm.set { mode, fastModel }`.

### Routing: the fast step only answers small talk

The fast step is the voice front-end of the agent, not a second assistant. Who
answers a turn is decided in three layers (`src/gateway/voice/voice-route.ts`):

1. **Pre-filter** (deterministic, 0 ms). A work request goes straight to the
   full agent without asking the fast model: anything naming the user's work
   (projects, tasks, agents, InfiniBot, Robovoice, Telegram, messages, files,
   memory, calendar, code…), any request to do something (check, look up, send,
   make, create, spawn, remind…), a question about the user's own data, and a
   short follow-up ("Why not?", "Yes, do it") to a turn the agent answered or to
   a refusal. The acknowledgement is spoken at once. Greetings and "who is
   this?" stay on the fast step.
2. **The fast model decides** everything else: it answers, or calls
   `handoff_to_agent` (a model without tool calling writes `HANDOFF`).
3. **Refusal guard.** The opening of a fast reply is held until it is a full
   sentence. A refusal or statement of inability ("I'm sorry, but…", "I can't
   share / discuss / do that", "I'm unable to…") is never spoken: it is
   discarded and the full agent takes the turn.

The route and its reason are on the turn line (`route "prefilter: action
request"`, `route "refusal guard"`), with the tools the agent called.

### Who the caller is

A voice caller is untrusted unless one of these holds (the reason is on the
turn line, e.g. `(owner: call started from this install)`):

- Robovoice vouches for a signed-in caller whose email is on the owner list
  (`ownerCallerEmails`). When that list was never set, the Robovoice account
  the install is linked with is the owner; an explicit list, even an empty one,
  is final.
- The call was started from this install by its operator: turns that name
  the room the operator's page actually joined are the owner's until the call
  ends (`robovoice.call.end`, by either room) or two hours pass. That room is
  the one `/plugins/robovoice/connection-details` (behind the gateway auth
  gate) got from Robovoice: `robopark-<install device id>`. It is NOT the
  `room` a cloud `robovoice.call.start` answers (`robopark-<characterId>`, a
  status handle only). A local call trusts the Desktop room call.start names.
  Matching is exact (no suffixes) and bound to the session's character; active
  operator calls are kept in `plugin-data/robovoice/operator-calls.json`, so a
  gateway restart mid-call keeps the owner. A turn that is not the owner's logs
  its room and the active operator rooms, e.g.
  `(caller: anonymous; room robopark-x is not an operator call (active: robopark-infinibot-…))`.

An owner is told nothing of theirs is confidential, and their spoken request is
the go-ahead (no approval dialogs on a call). Everyone else keeps the guest
rules: no tools that act for the owner, no private data.

### Choosing the fast model

`voiceLlmFastModel` unset = the agent's own model. Probe candidates on the
install's providers with the turns of a real call (first event, answer vs
hand-off vs refusal):

```bash
node --import tsx extensions/robovoice/scripts/voice-fast-model-probe.mts --runs 3 \
  --model ollama-cloud/gemma4:31b --model ollama-cloud/deepseek-v4.1-flash --model ollama-cloud/gpt-oss:120b
```

### Cancelled turns

When the caller speaks again or hangs up, the voice agent drops the request.
That turn is logged as `cancelled (caller spoke again or hung up)` and is not
counted as a failure.

## 2. One log line per turn

```
voice-llm main via gateway path=fast model=ollama-cloud/gpt-oss:120b (caller) prep 1ms first-token 820ms first-sentence 970ms total 1004ms chars 57
voice-llm main via gateway path=fast+agent model=… (caller) prep 2ms first-token 640ms first-sentence 655ms agent-prep 900ms agent-first-token 3100ms total 5200ms chars 117
```

`prep` = until the model was asked; `first-sentence` = what TTS can start
speaking. The same numbers are returned in the SSE stop chunk (`infinibot`),
kept in `robovoice.voiceLlm.status → turns`, and shown on the Voice page
(Session → System → **Turn diagnostics**, and the Voice LLM tab's table) next
to Robovoice's own per-turn timing (speech end → first audio, STT → LLM,
LLM → TTS).

## 3. Audio output

Session → System → **Speaker**:

- **Output device** — `setSinkId` on the element the agent's track plays on
  (Chrome, Edge, Firefox). Safari / iOS always use the system output; the
  control says so. Firefox lists speakers after its own picker
  (`selectAudioOutput`).
- **Volume**, **Play test sound** (a chime on the same route the agent's voice
  takes), **Agent voice** (opens the Pipeline tab, where the TTS provider and
  voice are edited — they are Robovoice's).
- **Microphone** can be switched during a call.
- The choice is remembered in this browser (`infinibot.voice.outputDeviceId`,
  `.outputVolume`, `.micDeviceId`, `.fallbackVoice` in localStorage). Device ids
  are per browser and origin, so they are not gateway config.
- A saved device that is unplugged: the call uses the system default, the panel
  says so, and the choice is kept for when the device returns.

## 4. Never silence

The agent's text and its voice travel separately (transcript on a data topic,
audio on a track). When Robovoice's speech step fails the text still arrives
and the track stays silent.

- The call watches the agent track's energy against each agent line. Text with
  no audio within 6 s (and none in the 12 s before it) is a **silent reply**:
  a red notice names the speech step, the System log records it, the Speaker
  module shows `Agent audio: NONE — TEXT ONLY`, and — unless switched off — the
  reply is spoken with the browser's own voice.
- `Agent audio: RECEIVING` + `Playback: BLOCKED` is the other case: audio
  arrived but the browser refused to play it → "Tap to enable audio". The
  Connect tap now unlocks playback up front.

## 5. Checking it

```
extensions/robovoice/scripts/voice-latency-e2e.sh up      # side gateway + mock Robovoice
extensions/robovoice/scripts/voice-latency-e2e.sh bench   # agent vs auto: STT → LLM → TTS, audio energy check
node extensions/robovoice/scripts/voice-audio-shots.mjs   # speaker picker / test sound / fault notice in Chrome
extensions/robovoice/scripts/voice-latency-e2e.sh down
```

`REAL_MODEL=1` uses the install's default model provider; `OWNER_WORKSPACE=<dir>`
copies an agent workspace's bootstrap files so the full-agent prompt is realistic.
