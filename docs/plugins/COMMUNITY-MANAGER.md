# Community Manager (Discord)

First-party plugin `community-manager` (`extensions/community-manager`). It runs a Discord community day to day; its first deployment is the Young CEO Society server.

- **Page:** `/community` (dashboard), setup wizard at `/community?step=1..10`.
- **Agent:** roster agent `community` (no exec or coder tools), bound to the picked server through `bindings[]`.
- **Tool:** `community` (status, leads, moderate, schedule_post, dm_members, activity).
- **Plan:** `~/.infinibot/reports/discord-community-manager-agent-plan-2026-10-22.md` (MVP phase).

## How it works

The plugin does not open its own Discord connection. Core's Discord monitor publishes four kinds of event on a small bus (`src/discord/community-events.ts`): member joins and leaves (these need `intents.guildMembers` on the account), guild messages, and presses of `cm:` buttons and `cmsel:` select menus. REST calls go through KinglyVault's Discord helpers (`src/vault/discord.ts`). The plugin reaches both through the `discordCommunity` seam in `infinibot/plugin-sdk`.

The engine is deterministic: there's no LLM in the fast path.

| Event | What happens |
|---|---|
| Join | Unverified role, one welcome DM ever, risk score from account age, raid counter (owner alert) |
| Verify button | Accounts younger than the preset's minimum age go to manual review. Otherwise the member gets Verified and the intake questions (select menus) start |
| Intake done | Weighted score 0–100 (hot ≥ 60, warm 30–59, nurture < 30), a **primary + secondary offer and a next step** (see Offer routing), interest roles, a lead assigned to the least-busy onboarder who covers that offer. Hot leads also get a private `#onboarding-desk` thread and a Telegram ping to the owner |
| Message | Scam links and phrases, banned financial claims and invite links are deleted. Scams also get a 1 h timeout plus a ban **queued for approval**. Trading channels get the disclaimer re-posted every N messages |
| Get help button | A ticket opens as a private thread under `#support` |
| Campaigns | Due posts go out. Anything that pings `@everyone` or `@here` waits for approval |

The approval gate covers bans, kicks, timeouts longer than 1 h, DMs to more than 25 people, and `@everyone`. Each one becomes a request in core's approval registry, so it shows up in the dashboard Mod queue, on Telegram and on mobile. Requests expire after 24 h, and an expired request counts as a deny.

### Offer routing (no dead ends)

Owner rule: everyone is directed somewhere, and there is never "no offer". `src/routing.ts` turns the intake answers into a primary offer, a secondary offer and a CTA. It does this for every input, including no answers at all:

| Who | Primary | Secondary |
|---|---|---|
| AI / automation / business with AI | InfiniBot | KinglyVault · Plugins |
| Learning / skills / digital products | KinglyVault · Learn | InfiniBot |
| Plugins / tools | KinglyVault · Plugins | InfiniBot |
| Trading, qualified (18+, allowed region, $100 funded) | Gold Desk · Pulse | KinglyVault · Learn |
| Trading, under 18 / age unknown / region blocked / not funded | KinglyVault · Learn (free trading education) | InfiniBot |
| **Fallback:** unknown, low score, networking, incomplete | InfiniBot (free) | KinglyVault · Learn (free) |

- **Hard age gate:** a member is never routed to Gold Desk / Pulse, and never gets the Pulse interest role, unless an 18+ answer is confirmed. Under 18 or no age answer means KinglyVault free trading education.
- **Gate questions:** these are marked with `gate: "age" | "region" | "capital"` and per-option `pass`. When those tags are missing, the gate is inferred from the question id or label (`age`, `trading`, `region`…), and an unclear answer fails. If no region question is configured, the onboarder confirms the region in the Gold Desk checklist.
- **CTAs:** they point at the mapped `offer-infinibot` / `offer-kinglyvault` / `offer-golddesk` channels, or at `#infinibot-start-here` / `#vault-start-here` / `#gold-desk-start-here` when nothing is mapped. Owner links (`offerLinks`, https only) are appended. Prices and links are never invented.
- **Welcome DM:** `{offers}` places the default route in the DM. A template without `{offers}` gets it appended, so even a member who never finishes intake gets a next step.
- **Store guard and KPI:** the store refuses a lead without a primary offer, a secondary offer and a CTA. Legacy rows routed to `none` read as the default route. The dashboard KPI "Offer assigned" is the share of intake-done members with a routed lead, and the target is 100%.

**Modes:**

- **Setup:** events are ignored.
- **Shadow:** everything is logged and nothing is done on Discord.
- **Live:** the engine acts on Discord.
- **Pause:** a separate kill switch that stops every autonomous action, in any mode.

### Live modules + the welcome greeting

`Settings.liveModules` lets single modules act **LIVE while the plugin stays in Shadow**.
Modules: `greeting`, `onboarding` (Unverified/Verified roles, intake, lead threads, owner pings),
`moderation`, `disclaimer`, `tickets`, `campaigns`. Mode `live` runs all of them, `paused` stops
all of them, and an empty or missing list keeps the plain global mode.

`greeting` = on every new member: one public post in the `welcome` channel (an embed with three
steps: read `start-here`, say hi in `introductions`, questions → `support` / `faq` (falls back to
`help`), lives in `lives`; link buttons to InfiniBot + KinglyVault from `offerLinks`, defaulting to
https://infinibotos.com and https://kinglyvault.com) plus the one welcome DM. The post mentions only
the new member (`allowedMentions: { parse: [], users: [id] }`). Above 5 greetings a minute, joins
are collected for 60 s and greeted in one combined post (≤ 20 mentions + "and N more"). With only
the greeting live, the DM is the built-in three steps + "Reply here or open a ticket" (the owner's
`welcomeDm` template is used in full Live only). Closed DMs (403 / 50007) are skipped silently and
never retried.

Turning it on is **hot** (no restart): settings live in the plugin's SQLite store and the engine
re-reads them on every event.

```bash
# `channels` is merged into the existing channel map (only the purposes you pass change)
infinibot gateway call community-manager.control.liveModules --params '{"modules":["greeting"],
  "channels":{"introductions":"1562870913769144460","faq":"1562870946610552832","lives":"1562871015606976724"}}'
infinibot gateway call community-manager.status --json   # liveModules ["greeting"]; health "mode" = "shadow · live: Welcome greeting"
# off again: --params '{"modules":[]}'
```

The /community wizard step 10 shows the same toggles ("Live while in Shadow") when the mode is Shadow.

## Secrets

The bot token is stored only at `channels.discord.accounts.<accountId>.token` (account `ycs` by default), together with `intents.guildMembers: true`. The token is:

- sent by the wizard to `community-manager.setup.validateToken` / `saveToken`
- never returned, logged or stored in the plugin DB
- redacted from any Discord error text before it reaches a response
- never present in the UI bundle

`saveToken` refuses to write while the Discord channel plugin is off. In that state `channels.discord.*` has no hot-reload rule, so the write would restart the whole gateway.

## Activation (owner runbook — needs one gateway restart)

The branch `feat/discord-manager` was cut from `deploy/flypic-fixes-live` at `251065b2`. While the deploy branch hasn't moved, it fast-forwards.

1. **Check that nothing is running.** `subagents_list` should show no running coder runs. Announce the restart on Telegram.
2. **Merge (fast-forward)** in a side worktree:
   `git -C <repo> branch -f deploy/flypic-fixes-live feat/discord-manager` (fast-forward only — if the deploy branch has moved on, run `git merge feat/discord-manager` on it instead).
3. **Rebuild the live folder** (it serves from `IB-live-release`):
   ```
   cd ~/Desktop/Development/IB-live-release
   git merge --ff-only feat/discord-manager      # the folder is on deploy/flypic-fixes-live
   PATH=~/.nvm/versions/node/v22.23.1/bin:$PATH pnpm build && pnpm ui:build
   ```
   Root `pnpm build` deletes `dist/control-ui`, so always run `ui:build` after it. The folder has a stray `.deploy.lock` and regenerated knowledge files; leave them alone.
4. **Turn both plugins on** in `~/.infinibot/infinibot.json` (`plugins.entries.discord.enabled: true` and `plugins.entries.community-manager.enabled: true`). Do **not** add the token here; the wizard does that after the restart, and with the Discord plugin loaded it's a hot channel reload.
5. **Restart once through the watchdog** (`systemctl --user restart infinibot-watchdog`, or SIGHUP to the watchdog's main PID).
6. **In the UI:** go to `/community`, paste the token at step 1, invite the bot (step 2), pick the server (step 3 writes the `bindings[]` entry), then complete steps 4–9 and go live in **Shadow** (step 10). Nothing after step 1 needs a restart.

There's a short window between steps 1 and 3 of the wizard where a guild @mention of the bot would reach the default agent, because the binding isn't written yet. Do steps 1–3 together.

## Before Live (owner)

- Turn **Public Bot** off and **Presence intent** off in the Developer Portal. The live bot "Infini" currently has both on.
- Get the Pulse disclaimer and the blocked-regions list legally reviewed (wizard step 8).
- Run Shadow for 24–48 h, then choose Live at step 10. Live also posts the Verify panel in `#start-here`.

## Tests

- `extensions/community-manager/community-manager.test.ts` covers scoring and routing, compliance, the approval gate, modes, token handling, the wizard RPCs and the manifest.
- `src/discord/community-events.test.ts` covers the event bus, the listeners and components, and the Vault REST changes.
- `ui/src/ui/views/community/logic.test.ts` covers the wizard and dashboard helpers.
- `ui/src/ui/views/setup-wizard.discord-token.test.ts` covers the core wizard's `token` key fix.
