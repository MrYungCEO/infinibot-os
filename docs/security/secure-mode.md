# Secure Mode — design, audit and threat model

Secure Mode is a second, isolated data lane in InfiniBot. Work done in it is
encrypted at rest, runs only on models served from this machine, and cannot
reach the network through agent tools. The normal lane is untouched.

Code: `src/secure-mode/` (core), `src/gateway/server-methods/secure-mode.ts`
(RPCs), plus the guard points listed below. Tests: `src/secure-mode/*.test.ts`.

## The toggle (single source of truth)

| RPC | Scope | What it does |
| --- | --- | --- |
| `secure.status` | read | `{enabled, unlocked, keySource, keyAccount, counts, seededAt, allowedTools, error?}` |
| `secure.set {enabled}` | write | ON: fetch the master key from the OS keyring, unseal transcripts into RAM. OFF: seal + wipe RAM transcripts, zero the key. Broadcasts `secure.mode.changed`. |
| `secure.check {model?, tool?}` | read | Dry-run verdict for a model ref / tool name. Runs nothing. |
| `secure.session.new {agentId}` | write | Mints a secure session key. |
| `secure.kanban.*`, `secure.docs.*`, `secure.graph.*` | read/write | The encrypted lane. Fail with `SECURE_MODE_LOCKED` while off. |
| `secure.graph.seed {confirm:true}` | **admin** | One-time copy of the current normal knowledge graph (labels, kinds, edges) into the secure graph. Refuses a second run. |

The on/off flag persists at `<stateDir>/secure/state.json` (no secrets). On
gateway start the runtime restores it; if the keyring cannot be reached the
lane stays enabled-but-locked (fail closed) and `secure.status.error` says why.

`secure.lane.changed` events carry only `{kind, at}` — never content.
Secure RPCs are not wrapped in `proxyMethodsToMaster`, so a federation
satellite never forwards secure data to the master.

## What belongs to the lane

Membership is decided by the **session key**, synchronously, everywhere:

- `agent:<id>:secure-<id>` — secure 1:1 chat
- `agent:<id>:groupchat-sec-<id>` / `agent:<id>:gcmember-sec-<id>` — secure group chat and its members' private sessions (`groupchat.create {secure:true}`)

A key is secure forever. Turning Secure Mode off locks the lane; it never
relabels a secure session as normal, so nothing secure can drift into the
normal lane by switching. Transcript forking across lanes is refused
(`auto-reply/reply/session.ts`).

## What is isolated

| Data | Normal lane | Secure lane |
| --- | --- | --- |
| Kanban tasks/projects | `databases.db` / `kanban.db`, synced to Notion | `secure/vault/kanban.ibsec` — no Notion/cloud code is imported by the secure store (`lane-store.ts`); test asserts zero `fetch` and zero `notion-sync` calls |
| Documents | `documents/` | `secure/vault/docs-index.ibsec` + `doc-<id>.ibsec` |
| Knowledge graph | derived from kanban/notes/docs/relations | `secure/vault/graph.ibsec` + nodes derived from the secure kanban/docs (`secure.graph.snapshot`, same shape as `graph.global.snapshot`) |
| Session transcripts | `agents/<id>/sessions/*.jsonl` | live: RAM (`$XDG_RUNTIME_DIR/infinibot-secure/<account>/transcripts`, tmpfs, 0700); at rest: `secure/vault/t-<sessionId>.ibsec` |

Normal-lane agents never get the `secure_lane` tool, so they cannot read
secure data. Secure agents never get `kanban`/`notes`/`memory_*`, so they
cannot write secure content into the normal lane.

## Encryption at rest

- AES-256-GCM envelope (`vault.ts`, `node:crypto` only). Every write uses a
  fresh random 32-byte data key and a 96-bit random IV; the data key is
  wrapped with the master key (also AES-256-GCM).
- AAD binds each ciphertext to its store name, so a file copied over another
  store fails authentication. A key id (`sha256(master)[0..8]`) detects a
  wrong master key with a clear error. Tampering fails authentication.
- Files are written tmp+rename at mode 0600 under a 0700 dir. Plaintext is
  only ever in memory (and in the tmpfs transcript dir while unlocked).
- Tests grep the on-disk tree for a plaintext marker after writes to every
  store and after sealing a transcript (`vault.test.ts`, `runtime.test.ts`).

### Master key (`keyring.ts`)

32 random bytes, generated on first enable, stored in the desktop Secret
Service under `service=infinibot-secure-mode, account=state-<sha256(stateDir)>`
(so a side gateway's state dir gets its own key). Providers, in order:

1. `secret-tool` (package `libsecret-tools`)
2. libsecret through python3 GObject introspection (`gir1.2-secret-1`, present
   on stock Ubuntu even without secret-tool — this is what this host uses)
3. `INFINIBOT_SECURE_MASTER_KEY` (base64, 32 bytes) for headless hosts / CI
4. **Weak, opt-in fallback:** `INFINIBOT_SECURE_KEY_FALLBACK=file` writes a
   0600 key file at `<stateDir>/secure/master.key`. The key then sits next to
   the data it protects; it only defends against copying the vault elsewhere.

With none of these, Secure Mode refuses to turn on. The key is read back after
storing so data is never sealed under a key the keyring did not keep.

## Local models only (`policy.ts`)

Enforced in code, not by prompt:

- **What "local" means** (`host-locality.ts`): a model endpoint is local when
  every address its host resolves to is loopback (`127.0.0.0/8`, `::1`,
  `localhost`) or is bound to one of this machine's network interfaces
  (`os.networkInterfaces()`: docker0 / `br-*`, tailscale0, the LAN NIC). So
  `172.17.0.1` (the Docker bridge gateway) is local on a host with docker0.
  The host's own hostname, and `host.docker.internal` (mapped to docker0 when
  it has no DNS entry), count as this machine. Hostnames are resolved with DNS
  and **every** address must be local. Answers are cached for 30 s and
  re-resolved periodically. If a name that was local starts resolving to a
  non-local address (DNS rebinding), it is quarantined for 10 minutes and
  stays blocked even if it flips back. Anything else is remote. That includes
  other tailnet machines and LAN boxes, unless the owner lists them in
  `secureMode.allowedModelHosts` (`localHosts` is the older name; both work).
  Provider names do not matter: `ollama` pointed at `ollama.com` is remote,
  and `ollama` with no baseUrl uses its built-in `127.0.0.1:11434` default.
- **Auto-switch, not an error** (`local-models.ts`): when a secure run's model
  is remote, `runWithModelFallback` (and `runEmbeddedPiAgent` for direct
  callers) moves the run to a local model, picked in this order:
  1. the agent's own local model (its primary, then its fallbacks);
  2. `secureMode.defaultModel`;
  3. the suggested defaults: `vllm-local/qwen3.8-27b`, then
     `ollama/huihui_ai/Qwen3.8-abliterated:latest`;
  4. any other installed model on a local endpoint.

  A candidate counts only when its endpoint is local and its server lists the
  model. The chat gets an agent `notice` event (`kind: "secure_model"`), which
  the UI shows as "Secure Mode: using <model> (local)". Remote fallbacks and
  remote self-heal candidates are dropped from the chain. If nothing local is
  reachable, the turn fails with a plain `SecureModeBlockedError` ("no local
  model is reachable … Checked: …"); it never goes to a hosted model.
- The resolved model's `baseUrl` is still re-checked inside the run.
- Blocked errors are plain `SecureModeBlockedError`s, not `FailoverError`s.
- RPCs: `secure.models` lists the candidates (local/reachable flags plus the
  suggestion). `secure.defaultModel.set` sets or clears the default; it accepts
  local models only. `secureMode.*` config changes hot-reload, so no restart is
  needed. The setting is in the Secure Mode popover (top-bar badge).
- Compaction (`compact.ts`) runs the same check.
- CLI backends (`claude-cli`, `codex-cli`, Claude Code, Codex, OpenCode,
  Gemini) are refused in `runCliAgent` for secure sessions, and the coder tools
  are never given to secure runs. There is no "local CLI" exception: the
  gateway cannot verify where a CLI routes its model calls.
- The lane must be unlocked: a secure run while off throws `SecureModeLockedError`.

## No external egress (`policy.ts`, `pi-tools.ts`)

Allowlist, not blocklist. A secure run gets exactly:

- `read` — read local files
- `secure_lane` — the encrypted kanban/docs/graph
- `file_context`, `video_analysis` — lane-bound local OCR/vision/video analysis
- `secure_research` — sanitized, owner-approved search through the local
  SearXNG, read by local models (see "Secure research" below)

Everything else is dropped from the run, including `web_*`, `browser`,
`research`, `rss_read`, `youtube_transcript`, `github_*`, `gmail`, `message`,
`telegram_*`, `sessions_send/spawn`, `mcp` and all MCP/plugin tools (FlyPic,
Excalidraw, Droid Swarm…), `nodes`, `mesh`, `ssh_devices`, `tailscale_control`,
`image`/`vision`/`tts`, `calendar`, coders, `exec`/`process` (a shell can
`curl`), `write`/`edit`/`apply_patch` (they would put secure content on disk
in the clear), `kanban`/`notes`/`memory_*`, `session_status` (fetches provider
usage). `secure.check {tool}` returns "Blocked by Secure Mode: tool … is not on
the local-only allowlist".

Owners may add local tools with `secureMode.allowTools` (e.g. `write`), but a
hard deny list (network, messaging, coders, MCP, FlyPic) cannot be re-enabled.

Other egress paths closed for secure sessions:

- link understanding and media understanding (URL fetch, hosted STT/vision) — skipped (`get-reply.ts`)
- auto-TTS (hosted voices) — forced off (`dispatch-from-config.ts`)
- internal hooks (session-memory, command-logger) — skipped (`internal-hooks.ts`)
- plugin hooks (memory capture, embeddings, analytics, `message_received`) — skipped (`plugins/hooks.ts`, `dispatch-from-config.ts`)
- pre-compaction memory flush (writes plaintext memory files) — skipped
- `chat.send` federation forwarding to another node — refused
- notifications (`notifications/history.db` + mobile push) — title/body/summary
  replaced with a neutral "Secure Mode" line; only the session key/run id kept
- Telegram completion pings — not sent for secure sessions
- `agent` command delivery — the reply is not printed to the gateway log and
  never delivered to an external channel
- cumulative-skills trajectories (`cumulative-skills/trajectories/*.jsonl`) and
  their LLM reflection — skipped
- per-run provider discovery (`models.json` refresh, which calls hosted
  catalogs such as ollama.com) — skipped for secure runs when `models.json`
  already exists
- the Robovoice "Call" button — hidden in secure sessions (voice uses hosted
  speech / LiveKit)

The last six were found by the side-gateway e2e, which greps everything the
gateway writes (state dir, file logs, stdout, workspace) for a plaintext
marker after a real secure turn and after locking.

## Secure research (web research without leaking secure data)

Code: `src/secure-mode/research/` (sanitizer, egress policy, hardened fetcher,
approvals, service, encrypted store, the `secure_research` tool),
`secure.research.*` RPCs in `src/gateway/server-methods/secure-mode.ts`, UI in
`ui/src/ui/secure-mode/secure-research.ts`, SearXNG in `docker/searxng/`.

### Threat model

**Protected assets.** Everything in the secure lane: secure files and their
OCR/vision/video analyses, images, transcripts, the encrypted kanban/docs/graph
and the vault itself, plus the owner's research goal (for example "what is my
grandfather's 1924 bond worth").

**Rule.** Secure data never leaves the machine. The only things that go out
are minimal, sanitized **search query strings**, and plain **GETs of public
result pages**. No cloud LLM ever sees secure content: planning the queries,
reviewing them, reading the pages and writing the estimate all run on the
local model (the same locality rules as secure chat runs: `local-models.ts`,
`host-locality.ts`; the endpoint is re-checked before every call).

**Adversaries considered.**

| Adversary | What they could learn | Mitigation |
| --- | --- | --- |
| Public search engines (via SearXNG) | the query text and SearXNG's IP | queries are generic item descriptions only (sanitizer + approval); SearXNG adds no cookies and no user account |
| Websites whose pages are fetched | that someone fetched this public page, the IP, the UA | generic UA, no cookies, no Referer, no JS, no auth headers; optional Tor/HTTP proxy (`secureMode.research.proxy`) hides the IP |
| Cloud LLM / "AI search" providers | everything they are sent | never contacted: their hosts are refused by the egress policy for search **and** page fetches (`CLOUD_LLM_SEARCH_DENY`) |
| A malicious result page | SSRF into the gateway, the LAN or the tailnet; redirects to a cloud API | only public addresses; DNS is resolved, every address must be public, and the connection is pinned to the vetted address; every redirect hop is re-checked; at most 4 hops; text content types only; size and time caps |
| Prompt injection in page text | tricks the model into "searching" secrets | page text only reaches the local model's **extract** step; extracts cannot trigger new searches. A run sends only the batch the owner approved, and a new batch needs a new approval |
| The local model itself | could propose a query containing a name or a serial number | it is not trusted: deterministic rules run after it, its review can only **remove** words, and the owner sees the exact final strings before anything is sent |
| Network observers | DNS lookups and TLS SNI of result hosts | inherent to fetching public pages; use the proxy setting (Tor `socks5://127.0.0.1:9050`) to hide them |

**Out of scope / residual risk.** Query text is not anonymous: someone who
can correlate "who searched for 1924 German External Loan bond value" with
your IP learns that interest, unless you use the proxy. Combining several
generic queries can narrow what you own (for example "1924 bond" plus
"1935 Reichsmark bond"); the approval card exists so you can drop queries.
SearXNG forwards queries to the engines it is configured with
(`docker/searxng/settings.yml`; Brave is turned off there). Opening a source
link in your browser is a normal browser visit.

### Flow

1. **Plan (local).** The `secure_research` tool takes a goal, optional
   generic `items`, optional secure `fileIds` and optional `queries`. The
   local model reads the secure file analyses (OCR text, vision description,
   analyst summaries) and proposes up to `maxQueries` short generic queries.
2. **Sanitize (local).** `sanitizer.ts` rules always run. They remove emails,
   URLs, phone numbers, IBAN, card and account numbers, serial and
   certificate numbers (any letter+digit token, any run of 5+ digits,
   "No. 123", "Nr.", "#…"), full dates, street addresses and postcode+city,
   file names and paths, exact non-round money amounts, honorific+name pairs,
   "owned by / registered to / my grandfather X" phrases, common first-name +
   surname pairs, and every sensitive term:
   - secure-graph nodes of kind `person`/`client`, or with `sensitive: true`;
   - identifying OCR entities of the files in play, and any part of an
     entity the rules would strip (names, ids, addresses);
   - file names;
   - `secureMode.research.sensitiveTerms`.

   Kept: years, round denominations ("1000 Reichsmark", "$1,000"),
   percentages and descriptive words. Then the local model reviews the
   cleaned list and may flag more words. It can only remove words. The
   result must be a fixed point of the rules, or the query is dropped.
3. **Approve.** `secureMode.research.approval`:
   - `"ask"` (default): the run waits; the secure chat shows the approval
     card with the exact query strings, a lock icon and "Only these words will
     leave this machine". **Approve**, **Edit** (edits are sanitized again; if
     anything would change, the card shows the sanitized words and asks once
     more, so what you approve is byte-for-byte what is sent) or **Deny**.
     No answer within `approvalTimeoutSec` (default 300) = nothing sent.
     Locking Secure Mode cancels pending batches.
   - `"auto-sanitized"`: sent automatically when the rules pass **and** the
     local model review ran; if the review is unavailable it falls back to
     asking. Still logged.
4. **Search.** `GET <searxngUrl>/search?q=…&format=json` to the local
   SearXNG only (`egress.ts` refuses a SearXNG that is not on this machine).
5. **Fetch (hardened, `fetcher.ts`).** Top `pagesPerQuery` public results per
   query (max `maxPages`). Generic Firefox UA, `Accept`/`Accept-Language`
   only: no cookies, Referer, Authorization or DNT. Text/HTML/JSON/XML only, up
   to `maxPageBytes` (1.5 MB), `fetchTimeoutMs` (12 s), manual redirects.
   Optional proxy for page fetches: `socks5://` (Tor) or `http(s)://`.
6. **Read (local).** HTML → text with Readability + linkedom in-process (no
   script execution), then the local model extracts the prices the page
   actually states, then writes the summary and value ranges, citing only
   sources it read.
7. **Store (encrypted).** The whole run sits in the vault:
   - `research-log`: the index the log panel lists;
   - `research-<id>`: the goal, proposed vs. sent queries, what was removed,
     sources, extracts, estimates and the egress log of every host
     contacted or refused.

   It is attached to the session, project and file ids. WS events
   (`secure.research.changed`) carry only `{id, sessionKey, status}`.

### Egress allowlist (`egress.ts`)

| Purpose | Allowed | Refused |
| --- | --- | --- |
| search | exactly the configured SearXNG origin, and only if it is on this machine | any other host, including other search APIs |
| page | public `http(s)` URLs on ports 80/443/≥1024 whose every DNS address is public | cloud LLM / AI search / search-API hosts (OpenAI, ChatGPT, Anthropic, Claude, Perplexity, Brave Search API + Brave search, Gemini/Vertex, Google Custom Search, Exa, Tavily, Serper, SerpAPI, You.com, Bing API/Copilot, Kagi, Phind, OpenRouter, Groq, Together, DeepSeek, Mistral, Cohere, xAI, ollama.com, Hugging Face, Replicate, Fireworks, DeepInfra, Cerebras, Jina, Firecrawl, DuckDuckGo AI chat, Meta AI, Poe, Azure, Bedrock), loopback, RFC1918, CGNAT/tailnet, link-local/metadata, ULA, `.local`/`.internal`, credentials in URL, non-http schemes, the SearXNG itself |

### Tool, RPCs, UI

- Tool `secure_research` — on the secure allowlist; given only to secure
  sessions (normal sessions keep the normal web tools). `secureMode.research.enabled: false` removes it.
- RPCs:

  | Method | Scope | What it does |
  | --- | --- | --- |
  | `secure.research.pending {sessionKey?}` | read | batches waiting for approval |
  | `secure.research.preview {id, queries}` | read | sanitize a draft edit; nothing is sent |
  | `secure.research.log {sessionKey?, limit?}` | read | the encrypted query log |
  | `secure.research.get {id}` | read | one full research record |
  | `secure.research.resolve {id, decision, queries?}` | write | approve (with optional edits) or deny a batch |
  | `secure.research.approval.set {approval}` | write | set the approval policy |
  | `secure.research.delete {id}` | write | delete a record |

  `secure.status.research` reports `{enabled, approval, searxngUrl, proxy}`.
- UI: in `/webchat` the tool block becomes the approval card, then progress,
  then the result card: value ranges, confidence, summary, numbered sources
  with full URLs, and a collapsible list of exactly which queries left and
  which hosts were contacted. The Secure Mode popover (top-bar badge) has the
  approval switch, any pending batches, and the **Secure Research log**
  (each query and when it was sent).

### Local SearXNG

```bash
docker compose -f docker/searxng/docker-compose.yml up -d   # binds 127.0.0.1:8888 only
curl -s http://127.0.0.1:8888/healthz                       # -> OK
curl -s 'http://127.0.0.1:8888/search?q=test&format=json' | head -c 200
```

If it is not running, a research run fails with a clear message and nothing
else is contacted (there is no fallback to a hosted search API).

### Config

```json5
{
  secureMode: {
    research: {
      approval: "ask",                     // or "auto-sanitized"
      searxngUrl: "http://127.0.0.1:8888", // must be on this machine
      proxy: "socks5://127.0.0.1:9050",    // optional, page fetches only (Tor)
      model: "ollama/huihui_ai/Qwen3.8-abliterated:latest", // optional; default = secure default model
      maxQueries: 6, pagesPerQuery: 2, maxPages: 8,
      fetchTimeoutMs: 12000, maxPageBytes: 1500000, approvalTimeoutSec: 300,
      sensitiveTerms: ["Lindqvist", "Hauptstraße"], // extra words that must never leave
    },
  },
}
```

### Verification

- `src/secure-mode/research/sanitizer.test.ts`: names (including non-ASCII),
  serials, certificate numbers, emails, phone numbers, IBAN/cards/accounts,
  addresses, dates, files and exact amounts are stripped; generic collectible
  terms are kept verbatim; the output is a fixed point; model flags can only
  remove words.
- `egress.test.ts`: every cloud LLM / AI-search endpoint is refused for search
  and pages; search goes only to a local SearXNG; there is no SSRF to
  loopback, LAN, tailnet or metadata; DNS rebinding is refused; every redirect
  hop is re-checked; the client sends no cookie, Referer or auth and uses a
  generic UA; body caps apply; the proxy is used for pages only.
- `service.test.ts`: in ask mode there are zero network calls until
  approval. Deny and timeout send nothing. Edits are sanitized again. Auto
  mode sends without waiting but falls back to ask without the model review.
  Vault and OCR-entity terms are stripped. The goal, queries, URLs and session
  key are absent from the on-disk vault files, which have mode 0600 and fail
  under a different key.
- The side-gateway e2e (`scripts/e2e/secure-research-side-e2e.mjs`) runs
  under `strace -f -e connect`, so every socket the gateway opened during a
  secure research turn is recorded and compared with the egress log.

## Known gaps (honest list)

1. **Session index metadata.** Secure sessions still have an entry in the
   normal `sessions.json` (key, session id, timestamps, token counts, model
   name). Message content is not there. Secure group chats get a neutral title
   ("Secure group") and no binding, and those cannot be changed later.
2. **RAM is not disk-proof under swap.** Live transcripts sit on tmpfs while
   unlocked. If the host swaps to an unencrypted swap device, pages could reach
   disk. Use encrypted swap (Ubuntu default with full-disk encryption) or none.
   Hibernation would write RAM to disk.
3. **Live UI streaming.** Chat deltas for secure sessions go to connected UI
   clients over the gateway WebSocket like any chat (including the phone over
   Tailscale). Transport is the same as the normal lane.
4. **Gateway process memory.** While unlocked, the master key and decrypted
   documents live in the gateway's memory; a same-user process with ptrace
   rights could read them. Lock (turn off) when not in use.
5. **The keyring is unlocked with the login session.** Anyone with the
   logged-in desktop session can read the key. The file fallback is weaker
   still (see above).
6. **`read` can read any file the gateway user can read** (including normal
   lane files). This direction (normal → secure) is not a leak, but secure
   prompts can pull normal-lane data into a secure transcript.
7. **Local servers are trusted.** A "local" OpenAI-compatible server on
   loopback could itself proxy to a hosted API; Secure Mode cannot see past
   the endpoint. Only list servers you run.
8. **Seeding copies normal-lane graph labels** into the secure lane (one-time,
   explicit owner action, admin scope). It never goes the other way.
9. **Existing sessions are not converted.** Toggling Secure Mode does not move a
   normal session into the lane; the UI opens a new secure session instead.
10. **Coder CLIs** have no local-model exception (see above) — by design for
    now.
11. **Process-wide model catalog warm.** The gateway keeps one model catalog
    cache (TTL) shared by every lane; if it is cold, the first run of any lane
    (including a secure one) refreshes it from hosted catalogs (models.dev,
    OpenRouter, …). The request carries no secure content, only the fact that
    a run started. On a running gateway the cache is already warm; the e2e
    asserts zero egress during secure turns once it is.

## Verification

- `src/secure-mode/*.test.ts` (vitest): vault, keyring (mocked + opt-in real
  keyring via `INFINIBOT_TEST_REAL_KEYRING=1`), policy, toggle round-trip,
  Notion isolation, tool assembly, runner guard, side channels.
- `scripts/e2e/secure-mode-side-e2e.mjs` against an isolated side gateway
  (`scripts/e2e/secure-mode-side-gateway.sh`) behind a recording deny-all
  egress proxy (`scripts/e2e/secure-mode-egress-proxy.mjs`): 20 checks —
  toggle via the OS keyring, lane isolation from kanban/graph, zero Notion
  egress for secure writes (with a normal-lane control that does reach
  Notion), a real local Ollama turn with zero egress, transcript in tmpfs +
  vault only, hosted / ollama-cloud models blocked (with a normal-lane
  control that does attempt them), `web_fetch` not offered, lock wipes RAM
  and refuses sends, unlock restores.
- Seed the starter project into a state dir's secure lane:
  `node --import tsx scripts/secure-mode-seed-starter.ts --state-dir ~/.infinibot`.

## Where each guard lives

| Guard | File |
| --- | --- |
| lane membership | `src/secure-mode/session-key.ts` |
| model allow/deny | `src/secure-mode/policy.ts` → `pi-embedded-runner/run.ts`, `compact.ts`, `cli-runner.ts` |
| tool allowlist | `src/secure-mode/policy.ts` → `src/agents/pi-tools.ts` |
| transcripts in RAM + sealing | `src/secure-mode/runtime.ts`, `transcripts.ts` → `config/sessions/store.ts`, `auto-reply/reply/session.ts`, `commands/agent.ts` |
| chat / group chat gating | `src/secure-mode/gateway-guards.ts` → `server-methods/chat.ts`, `server-methods/group-chat.ts`, `group-chat/service.ts` |
| hooks / TTS / link+media understanding | `hooks/internal-hooks.ts`, `plugins/hooks.ts`, `auto-reply/reply/dispatch-from-config.ts`, `get-reply.ts`, `agent-runner-memory.ts` |
| boot restore / shutdown seal | `gateway/server-runtime-state.ts`, `gateway/server-close.ts` |

## Config

On the owner's machine, `vllm-local` points at `http://172.17.0.1:8010/v1`. It is
the user systemd unit `vllm-qwen.service` (vLLM serving `qwen3.8-27b`), bound
**only** to the docker0 address 172.17.0.1, on purpose, so it stays off the LAN
and the tailnet. It is **not** published on 127.0.0.1. Since 2026-10-15 it
counts as local through the docker0 interface rule, so no config change is
needed.

```json5
{
  secureMode: {
    allowedModelHosts: ["100.70.1.2"], // OTHER machines trusted as model servers (exact host/IP)
    defaultModel: "vllm-local/qwen3.8-27b", // local model for secure runs whose model is remote (unset = best installed)
    allowTools: ["write"],        // extra local tools (network tools stay denied)
  },
}
```

Environment: `INFINIBOT_SECURE_MASTER_KEY`, `INFINIBOT_SECURE_KEY_FALLBACK=file`,
`INFINIBOT_SECURE_RAM_DIR` (tests only; skips the tmpfs check).

## Long local turns

- Local-model and Secure Mode turns use `agents.defaults.localTimeoutSeconds`.
  The default is 20 min, or `timeoutSeconds` when that is longer.
- With thinking off, local Ollama/vLLM requests explicitly disable reasoning:
  `reasoning_effort: "none"` for Ollama,
  `chat_template_kwargs.enable_thinking: false` for vLLM. Qwen3.x otherwise
  reasons for thousands of hidden tokens.
- When a turn times out, the gateway closes it and saves a turn-timeout note
  (model `turn-timeout`) listing the tool results gathered so far. Webchat
  shows it with a **Continue** button that resumes from those results.
- Webchat shows every tool call live with its elapsed time, plus a
  "Thinking… 1m20s" line while the model generates.
- Secure sessions get an up-front prompt note. It says to fetch saved file
  analyses in one batch call, and to use `secure_research` for web
  information when that tool is registered; otherwise the model answers from
  its own knowledge, marked as an estimate.
