# Setup status ("needs setup" glow)

Sidebar entries whose page can't do its job yet get a soft glowing border in
the control UI, plus a slim banner on the page itself that says what's missing
and links to the fix. The glow goes away by itself within about a second of the
setup being completed. There's no reload and no polling.

## Pieces

| Piece | Where |
| --- | --- |
| Check types | `src/gateway/setup-status/types.ts` |
| Registry: evaluate, cache, push | `src/gateway/setup-status/registry.ts` |
| Core checks | `src/gateway/setup-status/core-checks.ts` |
| RPC `setup.status` (read scope) | `src/gateway/server-methods/setup-status.ts` |
| Plugin API | manifest `contributes.setupChecks` + `api.registerSetupCheck` |
| UI state (fetch, push, toggle, snooze) | `ui/src/ui/controllers/nav-setup-status.ts` |
| Sidebar glow | `ui/src/ui/views/nav-sidebar-enhanced.ts`, `ui/src/styles/nav-setup-glow.css` |
| Page banner | `ui/src/ui/components/setup-banner.ts`, `ui/src/styles/setup-banner.css` |
| Appearance toggle | Appearance › Sidebar › "Highlight pages that need setup" |

## Check result

```ts
{ id, source: "core" | pluginId, title, tabs: string[],
  state: "ready" | "needs-setup" | "optional" | "error",
  reason: string, action?: { label, tab?, view?, section?, href? }, priority? }
```

- `needs-setup`: the page objectively can't work until the user acts. Shown as
  a breathing gold ring.
- `error`: something is configured but broken, e.g. every stored model key was
  rejected. Shown as a warm red ring.
- `optional`: nice to have. Shown as a quiet dashed hairline. The user can
  dismiss it for good or snooze it for a week (stored in the browser's
  localStorage).
- `ready`: nothing is shown.

`tabs` lists control-UI tab ids. A retired or merged id lights up its host
entry. For example, `coders` lights up **Setup**, because the Coders page lives
at `/setup?view=coders`.

## Evaluation

- Checks must be cheap. They read config and local stores only: no process
  spawns and no network calls.
- Each check gets 1.5 s. A check that throws, times out or returns an invalid
  state is dropped, so it never glows by mistake.
- Snapshots are cached for 5 s per tenant namespace (a local profile, or a SaaS
  tenant's request scope).
- After any write RPC except chat, session or kanban traffic, the dispatcher
  schedules a recompute 400 ms later. It debounces per namespace and broadcasts
  `setup.status` with the full snapshot only when the result changed. In SaaS
  mode the broadcast goes only to that tenant's clients.
- On every gateway `hello` (first connect or reconnect) the UI refetches once.
  Toggling a plugin or saving config restarts the gateway, so this path covers
  those cases.
- Cloud mode (`SAAS_MODE`, or any tenant-scoped request) skips checks marked
  `localOnly`, because those features don't exist there.

## Core checks

| id | Pages | State when missing | Condition | Action |
| --- | --- | --- | --- | --- |
| core.models | API keys, Web chat | needs-setup / error | No model credential of any kind: no stored LLM profile, no provider env key, no custom provider key or local base URL, no local `ollama/…` primary model, no Claude/Codex CLI login. The state is **error** when every stored key's last event was an auth failure and nothing else can stand in. | Add an API key → /apikeys |
| core.inbox | Inbox | needs-setup | No Gmail account in config and no email-accounts row. | Connect email → /inbox |
| core.coders | Setup (Coders) | needs-setup | No coder CLI resolvable (managed install or PATH). Skipped where installs are impossible (shared SaaS process). | Install a coder → /setup?view=coders |
| core.voice (local only) | Voice | needs-setup | `isVoiceConfigured()` is false: no voice.json, or STT/TTS has no key and isn't native. | Set up voice → Setup › Voice |
| core.channels | Channels | optional | No messaging channel configured (web chat always works). | Connect a channel → /channels |
| core.calendar | Schedule | optional | No Google Calendar credentials and no Calendly connection. | Connect a calendar → /schedule |
| core.mobile (local only) | Mobile | optional | No paired device whose platform is mobile/iOS/Android. | Pair a phone → /mobile |

Research is left out on purpose. Its store seeds six default topics the first
time the page opens, so "has topics" says nothing about whether the user set it
up.

## Plugin checks

Declare the check in the manifest. A plugin can only light up its own pages
and point its action at them.

```json
"contributes": {
  "setupChecks": [
    { "id": "solatrix.rpc", "title": "Solana RPC",
      "tabs": ["solatrix-settings", "solatrix-bubblemap"],
      "action": { "label": "Set RPC URL", "tab": "solatrix-settings" } }
  ]
}
```

Then supply the evaluate function when the plugin registers:

```ts
api.registerSetupCheck({
  id: "solatrix.rpc",
  evaluate: () => core.rpcSource().source === "public"
    ? { state: "needs-setup", reason: "Using the public Solana RPC…" }
    : { state: "ready" },
});
```

Checks that aren't declared, duplicates, and v1 plugins are rejected with a
plugin diagnostic. Only checks from loaded, enabled plugins are evaluated, so
disabling a plugin removes its glows.

## UI rules

- The glow is an inset ring drawn inside the row. It never paints outside the
  row, so `ui/scripts/sidebar-overlap-audit.mjs` is unaffected. The pulse
  animates opacity only, and `prefers-reduced-motion` makes it static.
- In the collapsed icon rail each glowing entry gets a small dot at the top
  left of its icon. The live-badge dot keeps the top right. Plugin section
  headers get the same dot.
- In the stacked top bar (≤1100px) entries keep their ring. The hover or focus
  hint hangs below the chip instead of beside it.
- Group headers show a "● N" chip counting pages that need setup. Optional
  checks aren't counted.
- Hovering or focusing an entry shows the body-level flyout with "Needs setup:
  reason" and the action label. The entry's `title` carries the same text, and
  `aria-describedby` points at a visually hidden description.
- The page banner shows up to two checks. The action button is hidden when it
  would link to the page you're already on. Full-bleed canvases (chat, grid,
  mesh, terminals, graph, autonomy) show no banner.
