# Telegram guided setup

One wizard, `<telegram-setup>` (`ui/src/ui/components/telegram-setup.ts`), is used
wherever a Telegram bot is connected. It talks to the gateway through the
`telegram.setup.*` RPCs (`src/gateway/server-methods/telegram-setup.ts`); the
logic lives in `src/telegram/setup/`.

## Flow

1. **Create your bot** – BotFather steps, a token field with a shape check
   (`123456789:AAH…`, about 46 characters).
2. **Check the token** – the gateway calls `getMe` and shows the bot's name,
   @username and avatar. Errors say what to do: wrong token, no network, the bot
   is on another app's webhook (one-click "Disconnect the other app" =
   `deleteWebhook`), or another program is already polling it.
3. **Find you** – the wizard shows `https://t.me/<bot>?start=<code>` (and a QR
   code). Pressing Start sends `/start <code>`; the gateway reads `from.id`
   (user id), `chat.id`, username and first name, and shows "Found you". Confirm
   writes `allowFrom` and `defaultChatId`. A group works the same way with
   `?startgroup=<code>` and saves the negative chat id under `groups`.
   Manual entry (via @userinfobot) is the fallback; the id is checked with `getChat`.
4. **Test** – sends "✅ InfiniBot is connected" to the found chat.
5. **Done** – summary card: bot, owner, default chat, groups; change owner, add a
   group, send a test, use a different bot, disconnect.

## How the first message is heard

| The bot's channel is… | The setup listens by… |
| --- | --- |
| not running (new bot) | short-lived `getUpdates` polling for this session only; it stops when the owner is found, on cancel, or after 5 minutes |
| running, long-polling | the running bot hands each update to the setup first (`offerTelegramSetupUpdate` in `src/telegram/bot.ts`) |
| running on a webhook (hosted wake-on-message Machines) | the same hook: the webhook handler feeds the same bot, so no polling happens |

## Starting without a restart

When the Telegram channel plugin is loaded, saving stops and starts the channel
in place. On an install that has never had a Telegram bot the bundled plugin is
not loaded yet, so the config change makes the gateway reload itself in-process
(a few seconds; the page reconnects and the wizard resumes at "Test"). `confirm`
reports which happened as `starting: "live" | "reload"`.

## Security

- The token is sent browser → gateway once, over the gateway socket. It is never
  put in a URL by the browser, never returned by any RPC (responses carry a
  session id and a masked token `123456789:••••••abcd`), and never logged; error
  text is scrubbed of anything token-shaped.
- Ownership needs the one-time start code (8 characters, random per capture).
  A message without it is ignored and only counted, so someone else messaging the
  bot during setup cannot claim it. Once an owner is known, only that user can
  add a group.
- A capture closes after 5 minutes; a setup session after 30 idle minutes.
  Sessions are kept in gateway memory per tenant scope.
- Everything except `telegram.setup.summary` needs `operator.admin`.
- In SaaS mode a member workspace never writes the shared gateway config: it
  saves through the tenant store registered with `registerTelegramSetupStore`
  (`src/telegram/setup/store.ts`), or not at all.

## Testing without a real bot

`INFINIBOT_TELEGRAM_API_ROOT` points every Bot API call (setup, channel, sends,
probe) at another server. It exists for tests and for a self-hosted Bot API
server; whatever it points at receives the bot token, so only use a server you
run. `test/helpers/mock-telegram-bot-api.ts` is a local stand-in.

```
pnpm build && pnpm -C ui build
node_modules/.bin/tsx scripts/verify-telegram-setup.mts   # side gateway + mock + browser
```
