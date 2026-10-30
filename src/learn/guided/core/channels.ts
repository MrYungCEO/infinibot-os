import type { LearnTrack } from "../types.js";

/**
 * Channels — Settings › Channels (/channels): per-channel status cards
 * (Telegram, WhatsApp, Discord, Slack, Signal…), WhatsApp QR linking, DM
 * pairing, deterministic routing to agents, and the cross-channel Inbox
 * sub-tab (/channels?view=inbox, formerly /comms).
 *
 * Tours never connect, link, log out or send. Those steps are explain-only.
 */
export const track: LearnTrack = {
  id: "channels",
  title: "Channels",
  summary:
    "Connect Telegram, WhatsApp, Discord, Slack and more, understand how inbound messages reach an agent, and work the cross-channel Inbox.",
  overview: [
    "**Channels** connect your agents to the messaging apps you already use. Each channel runs inside the gateway: messages come in, get routed to one agent, and the reply goes back to the chat it came from.",
    "",
    "The **Channels** page (Settings › Channels, `/channels`) has one card per channel, showing whether it's configured, running and connected, plus its settings. The **Inbox** sub-tab gathers client conversations from every channel in one place.",
    "",
    "This track covers:",
    "- **The channel cards.** Status, probes and where each channel's settings live.",
    "- **Linking and pairing.** WhatsApp's QR link and how unknown senders are approved.",
    "- **Routing and the Inbox.** Which agent answers, how sessions are split, and the shared inbox.",
    "",
    "The tours never connect, link, log out or send anything. Those controls are explained only.",
  ].join("\n"),
  category: "Chat & Voice",
  level: "intermediate",
  certRequired: true,
  order: 85,
  routes: ["/channels", "/comms"],
  signals: ["channels", "comms"],
  prerequisites: ["agents"],
  badge: { id: "channels", label: "Switchboard", icon: "📡" },
  walkthroughs: [
    {
      id: "channel-cards",
      title: "Tour the channel cards",
      summary: "Read a channel's status and find where it's configured.",
      estMinutes: 3,
      steps: [
        {
          id: "grid",
          title: "One card per channel",
          body: "Each card is a channel the gateway can run. Enabled channels are listed first. The pill in the corner reads **Not configured**, **Connected** and so on at a glance.",
          route: "/channels",
          target: "learn:channels-grid",
          placement: "top",
          check: { kind: "rpc", method: "channels.status" },
          checkHint: "Waiting for the gateway's channel status…",
        },
        {
          id: "telegram",
          title: "Telegram",
          body: "Telegram uses a bot token from **@BotFather**, saved as `channels.telegram.botToken`. The card shows whether it's configured and running, its mode (polling or webhook), and when it last started and was last probed.",
          target: ['[data-channel-id="telegram"]', "learn:channels-grid"],
        },
        {
          id: "discord-slack",
          title: "Discord, Slack and more",
          body: "Discord and Slack run as bots too. Slack uses Socket Mode, so no public URL is needed. Signal, Google Chat, iMessage and others follow the same pattern: add credentials in config, then check the card.",
          target: [
            '[data-channel-id="discord"]',
            '[data-channel-id="slack"]',
            "learn:channels-grid",
          ],
        },
        {
          id: "config",
          title: "Settings on the card",
          body: "Under **Configuration**, channels that publish a schema get editable fields with **Save** and **Reload**. **Probe** checks the credentials against the service without changing anything.",
          target: ['[data-channel-id="telegram"]', "learn:channels-grid"],
          practice: {
            mode: "explain",
            note: "Saving channel settings changes how the gateway connects. The tour doesn't save or probe.",
          },
        },
        {
          id: "health",
          title: "Channel health",
          body: "At the bottom is the raw status snapshot from the gateway, for when you need to debug a channel that won't start.",
          target: "learn:channels-health",
          placement: "top",
        },
      ],
    },
    {
      id: "link-and-pair",
      title: "Link WhatsApp and approve senders",
      summary: "The WhatsApp QR flow and how DM pairing keeps strangers out.",
      estMinutes: 3,
      steps: [
        {
          id: "whatsapp",
          title: "The WhatsApp card",
          body: "WhatsApp links like WhatsApp Web, as a linked device on your phone. The card shows whether it's **Linked**, **Running** and **Connected**, when it last connected or got a message, and the auth age.",
          route: "/channels",
          target: ['[data-channel-id="whatsapp"]', "learn:channels-grid"],
        },
        {
          id: "qr",
          title: "Link with a QR code",
          body: "**Connect (Show QR)** shows a code. On your phone, open WhatsApp → **Linked Devices** and scan it, and it links by itself. **Relink** starts over with a fresh code, **Wait for scan** keeps watching, and **Logout** unlinks.",
          target: [
            "learn:channels-whatsapp-connect",
            "learn:channels-whatsapp-actions",
            '[data-channel-id="whatsapp"]',
          ],
          practice: {
            mode: "explain",
            note: "The tour doesn't link a device. Linking gives the gateway access to your WhatsApp account.",
          },
        },
        {
          id: "pairing",
          title: "Pairing: who may talk to your agent",
          body: "By default, direct messages use **pairing**. An unknown sender gets a one-time code and their message isn't processed until you approve it with `infinibot pairing approve <channel> <code>`. Codes expire after an hour.",
          target: ['[data-channel-id="whatsapp"]', "learn:channels-grid"],
        },
        {
          id: "allowlist",
          title: "Or an allowlist",
          body: "Set a channel's `dmPolicy` to **allowlist** and list trusted senders in `allowFrom` to skip pairing. Outbound messages never trigger pairing replies, so your contacts aren't spammed.",
          target: ["learn:channels-health", "learn:channels-grid"],
        },
      ],
    },
    {
      id: "routing-inbox",
      title: "Routing and the Inbox",
      summary: "Which agent answers an inbound message, and the cross-channel Inbox.",
      estMinutes: 4,
      steps: [
        {
          id: "deterministic",
          title: "Replies go back where they came from",
          body: "Routing is set by configuration, not by the model. Each inbound message is routed to exactly one agent, and the reply goes back to the same channel and chat.",
          route: "/channels",
          target: "learn:channels-grid",
          placement: "top",
        },
        {
          id: "bindings",
          title: "Which agent answers",
          body: "**Bindings** map messages to agents. The most specific match wins: an exact chat or person, then a Discord server or Slack team, then the account, then the whole channel. Anything left over goes to your default agent (usually **main**).",
          target: "learn:channels-grid",
          placement: "top",
        },
        {
          id: "sessions",
          title: "How conversations are kept",
          body: "Direct messages share the agent's **main** session, so context follows you across apps. Each group or channel gets its own session, and threads and Telegram topics are kept separate too.",
          target: "learn:channels-grid",
          placement: "top",
        },
        {
          id: "open-inbox",
          title: "Open the Inbox",
          body: "Click **Inbox**.",
          target: '[data-host-view="inbox"]',
          action: { kind: "click" },
        },
        {
          id: "threads",
          title: "Every client thread in one list",
          body: "Client conversations from Telegram, email, WhatsApp, Discord and Instagram land here. The pills show which channels are ready and which still need **setup**. Filter the list by assignment or by channel.",
          target: ["learn:comms-threads", "learn:comms-hub"],
          placement: "right",
        },
        {
          id: "approvals",
          title: "Approve before it sends",
          body: "Open a thread to read it and reply. Replies an agent drafts can wait as **pending approval**: **Approve & send** delivers one, **Reject** drops it. The count to approve shows at the top of the list.",
          target: ["learn:comms-conversation", "learn:comms-hub"],
          practice: {
            mode: "explain",
            note: "The tour never sends or approves a message. Approve & send delivers it to a real person.",
          },
        },
      ],
    },
  ],
  quiz: [
    {
      id: "who-picks",
      prompt: "Who decides which channel a reply goes to?",
      options: [
        "The model picks the best channel",
        "Routing is deterministic: the reply goes back to where the message came from",
        "Always Telegram",
        "The Inbox, by hand",
      ],
      answer: 1,
      explain:
        "The host configuration routes messages. Replies return to the originating channel and chat.",
    },
    {
      id: "pairing",
      prompt:
        "A stranger DMs your WhatsApp for the first time. With the default policy, what happens?",
      options: [
        "The agent replies right away",
        "They get a pairing code and the message isn't processed until you approve it",
        "The message is forwarded to email",
        "WhatsApp blocks them",
      ],
      answer: 1,
      explain:
        "The default dmPolicy is pairing. Approve with `infinibot pairing approve whatsapp <code>`.",
    },
    {
      id: "binding",
      prompt:
        "Two bindings match a Telegram group: one for that exact group, one for all of Telegram. Which agent answers?",
      options: [
        "The one bound to the exact group",
        "The one bound to all of Telegram",
        "Both at once",
        "Neither, so it goes to main",
      ],
      answer: 0,
      explain: "The most specific match wins: an exact peer comes before the channel-wide binding.",
    },
    {
      id: "whatsapp-link",
      prompt: "How do you link WhatsApp?",
      options: [
        "Paste a bot token",
        "Connect (Show QR), then scan it in WhatsApp › Linked Devices",
        "Email support",
        "Install a plugin",
      ],
      answer: 1,
      explain: "WhatsApp links as a device through its QR code, like WhatsApp Web.",
    },
  ],
};
