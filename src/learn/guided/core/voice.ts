import type { LearnStep, LearnTrack } from "../types.js";

/**
 * Voice — the Voice page (/voice): the voice terminal, speech providers
 * (local by default, Cloud voice (Robovoice) optional and free), wake words
 * and Live Action, and the holographic HUD. The lead appends a guarded
 * walkthrough for the optional Robovoice pipeline.
 *
 * Tours never connect a call or open the microphone; those controls are
 * explained only.
 */

/** First-run gate: the "voice isn't ready yet" card sits over the voice
 *  pages until voice is set up. Both steps skip themselves when it's absent. */
const noSetupCard = {
  kind: "not",
  condition: { kind: "element", target: "learn:voice-setup-card" },
} as const;
function setupSteps(prefix = ""): LearnStep[] {
  return [
    {
      id: `${prefix}setup-card`,
      title: "Finish voice setup",
      body: "Voice isn't ready yet, and this card shows the one step missing: setting up local voice, or allowing the microphone. **Local voice** is the default: it runs privately on your computer with no keys. **Cloud voice (Robovoice)** is an optional, free choice for when your computer can't run voice.",
      target: "learn:voice-setup-card",
      skipIf: noSetupCard,
    },
    {
      id: `${prefix}setup-later`,
      title: "Tour first, then set up",
      body: "Click outside the card to continue the tour. The card comes back each new session until voice is ready, so you can finish setup straight after the tour.",
      target: "learn:voice-setup-scrim",
      placement: "center",
      action: { kind: "click" },
      skipIf: noSetupCard,
    },
  ];
}

/** Opens /voice first so the setup-card check runs on the page itself. */
function openVoice(summary: string): LearnStep {
  return {
    id: "open-voice",
    title: "The Voice page",
    body: summary,
    route: "/voice",
    // Spotlight the terminal once it has rendered: the setup card (if any)
    // mounts with it and appears a moment later, while this step is read.
    target: ["learn:voice-header", "learn:voice-pills"],
    placement: "bottom",
    // Voice readiness is probed on page load; wait for the same config read
    // so the setup-card check below sees the card if it's coming.
    check: { kind: "rpc", method: "quickstart.voice.get" },
    checkHint: "Checking your voice setup…",
  };
}

export const track: LearnTrack = {
  id: "voice",
  title: "Voice",
  summary:
    "Talk to your agents: the voice terminal, local voice (the default) or optional cloud voice, wake words, Live Action and the voice HUD.",
  overview: [
    "Voice is a core way to use InfiniBot. The **Voice** page (Chat & Voice › Voice, `/voice`) is a voice terminal. You talk, an agent answers out loud, and you can watch its work in the transcript, the system log or a live terminal.",
    "",
    "**Local voice** is the default: speech runs on your own computer (Whisper for hearing, Kokoro or Piper for speaking), private and free. **Cloud voice (Robovoice)** is an optional choice you pick yourself. It's free too, handy when your computer can't run voice, and you can switch back to local any time.",
    "",
    "This track covers:",
    "- **The voice terminal.** Session controls, the agent picker, the transcript and the footer.",
    "- **Providers.** The speech engine, the voice route and the TTS voice.",
    "- **Wake words and Live Action.** “hey infinibot”, voice commands and the Live sidebar.",
    "- **The voice HUD.** The holographic HUD, the system modules and the floating terminal.",
    "",
    "The tours never start a call or open your microphone. They show you where those controls are.",
  ].join("\n"),
  category: "Chat & Voice",
  level: "intermediate",
  certRequired: true,
  order: 80,
  routes: ["/voice", "/voice-commands"],
  signals: ["voice", "voicecommands"],
  prerequisites: ["chat-models"],
  badge: { id: "voice", label: "Voice operator", icon: "🎙️" },
  walkthroughs: [
    {
      id: "voice-terminal",
      title: "Tour the voice terminal",
      summary: "Session controls, the agent picker, the transcript and the footer.",
      estMinutes: 3,
      steps: [
        openVoice(
          "This is the voice terminal. The header shows whether a voice session is **LIVE** or **OFFLINE** and which speech provider is in use. The tour won't start a call or use your microphone.",
        ),
        ...setupSteps(),
        {
          id: "provider",
          title: "Which voice is active",
          body: "The provider badge names the speech stack this session will use and warns when something is missing, such as a key or a stopped local voice engine. Hover it for details.",
          target: ["learn:voice-provider", "learn:voice-header", "learn:voice-pills"],
        },
        {
          id: "pills",
          title: "Session controls",
          body: "**Connect** starts a voice session. **Mic** mutes or unmutes it. **Talk** is push-to-talk with local Whisper. The picker chooses which agent or coding CLI answers, and **⌗ Terminal** shows its live activity.",
          target: ["learn:voice-pills", "learn:voice-footer"],
          placement: "bottom",
          practice: {
            mode: "explain",
            note: "The tour never connects a session or opens the microphone. Your browser asks for mic permission the first time you do.",
          },
        },
        {
          id: "transcript",
          title: "Transcript and log",
          body: "What you and the agent say appears here, with the system log underneath. **▶ Terminal** swaps the transcript for the answering CLI's terminal.",
          target: ["learn:voice-transcript", "learn:voice-mode-toggle"],
          placement: "right",
        },
        {
          id: "footer",
          title: "The control deck",
          body: "The footer repeats the essentials: **CONNECT / DISCONNECT**, the agent picker and the **LOCAL STT** record button.",
          target: ["learn:voice-footer", "learn:voice-pills"],
          placement: "top",
        },
      ],
    },
    {
      id: "voice-providers",
      title: "Choose your voice providers",
      summary: "The speech engine, the voice route and the TTS voice.",
      estMinutes: 4,
      steps: [
        openVoice(
          "Voice settings decide which speech engine hears and speaks, and which agent answers.",
        ),
        ...setupSteps(),
        {
          id: "open-config",
          title: "Open voice settings",
          body: "Click **⚙** (Model & voice settings).",
          route: "/voice",
          target: ["learn:voice-model-settings", "learn:voice-settings"],
          action: { kind: "click" },
        },
        {
          id: "engine",
          title: "Local or cloud voice",
          body: "**Local voice** is the default: Whisper and Kokoro or Piper run on this machine, so audio never leaves it. Ticks show which local models are present. **Cloud voice (Robovoice)** is optional and free; nothing switches to it unless you pick it.",
          target: ["learn:voice-speech-engine", "learn:voice-config"],
        },
        {
          id: "route",
          title: "Who answers",
          body: "The voice route picks the brain. **Gateway Agent** uses the full reply pipeline (needs the LiveKit stack). **Claude Code**, **OpenCode** and **Codex** start that CLI and read its reply aloud.",
          target: ["learn:voice-route", "learn:voice-config"],
        },
        {
          id: "tts",
          title: "The voice itself",
          body: "**TTS Provider** and **Voice Model** pick how the agent sounds. The **Wake Word** switch turns the voice agent's wake word on or off.",
          target: ["learn:voice-tts-provider", "learn:voice-config"],
        },
        {
          id: "test-save",
          title: "Test, then save",
          body: "**Refresh** and **Test (smoke)** check that speech-to-text and text-to-speech respond before you rely on them. **Save Voice Stack** and **Save Configuration** apply your changes.",
          target: "learn:voice-config",
          practice: {
            mode: "explain",
            note: "The tour doesn't save anything, so your current voice settings stay as they are.",
          },
        },
        {
          id: "close",
          title: "Close settings",
          body: "Click **✕** to close without saving.",
          target: "learn:voice-config-close",
          action: { kind: "click" },
        },
      ],
    },
    {
      id: "wake-and-live",
      title: "Wake words and Live Action",
      summary: "“hey infinibot”, voice commands and the Live sidebar.",
      estMinutes: 4,
      steps: [
        openVoice(
          "Wake words let you start voice without touching the keyboard. They live on the **Commands** sub-tab.",
        ),
        ...setupSteps(),
        {
          id: "commands-tab",
          title: "Open Commands",
          body: "Click **Commands**. This sub-tab holds every wake word and voice command.",
          route: "/voice",
          target: '[data-host-view="commands"]',
          action: { kind: "click" },
        },
        ...setupSteps("cmd-"),
        {
          id: "optin",
          title: "The microphone switch",
          body: "Wake words need the microphone, and InfiniBot never opens it until you turn on **Listen for wake word**. The badge at the top shows **LISTENING**, **IDLE** or **OFF**.",
          target: ["learn:voice-wake-optin", "learn:voice-setup-card"],
          practice: {
            mode: "explain",
            note: "The tour doesn't turn the microphone on. Your browser asks for permission when you do.",
          },
        },
        {
          id: "live-action",
          title: "Say “hey infinibot”",
          body: "**“hey infinibot”** and **“live action”** are fixed phrases that open Live Action from anywhere, with no tab or agent name needed. Keep **Always on** ticked, or add your own phrases.",
          target: "learn:voice-live-action",
        },
        {
          id: "tab-commands",
          title: "Navigate by voice",
          body: "Every page gets a **“hey <page>”** trigger. Rename or disable them here. Agents get **“hey <agent>”** triggers too.",
          target: ["learn:voice-tab-commands", "learn:voice-agent-commands"],
        },
        {
          id: "custom",
          title: "Your own commands",
          body: "**Add command** binds any phrase to an action: switch tab, open the voice panel, run a workflow or dispatch a UI action.",
          target: "learn:voice-add-command",
        },
        {
          id: "live-button",
          title: "The Live button",
          body: "**Live** in the command bar opens the **Live Action** sidebar. Voice docks to the side while you keep working, and agent actions are shown as they happen. The wake phrases open the same sidebar.",
          target: ['button[data-cb-item="live"]', ".cb-more__btn"],
          placement: "bottom",
        },
      ],
    },
    {
      id: "voice-hud",
      title: "The voice HUD",
      summary: "The holographic HUD, the system modules and the floating terminal.",
      estMinutes: 3,
      steps: [
        openVoice(
          "The voice page has more than one view. Here are the HUD, the system panel and the floating terminal.",
        ),
        ...setupSteps(),
        {
          id: "hud",
          title: "Holographic HUD",
          body: "**HUD** switches the page to a full-screen holographic view: the voice blob in the centre, with running agents and node hardware around the edges. Leave it from inside the HUD, and your choice is remembered.",
          route: "/voice",
          target: ["learn:voice-hud-toggle", "learn:voice-header", "learn:voice-pills"],
        },
        {
          id: "system",
          title: "System modules",
          body: "The **System** panel shows the **Vision Engine**, **Microphone**, **Camera** and **Audio Engine** at a glance, with a log counter. Collapse it with the arrow for more room.",
          target: ["learn:voice-system", "learn:voice-pills"],
          placement: "left",
        },
        {
          id: "open-terminal",
          title: "Watch the agent work",
          body: "Click **⌗ Terminal** to float the cloud terminal: a draggable panel that shows the answering agent's live activity.",
          target: "learn:voice-cloud-terminal-toggle",
          action: { kind: "click" },
        },
        {
          id: "close-terminal",
          title: "Hide it again",
          body: "Click **⌗ Terminal** again (or **✕** on the panel) to hide it. **⤢** on the panel opens the full embedded terminal instead.",
          target: "learn:voice-cloud-terminal-toggle",
          action: { kind: "click" },
        },
      ],
    },
  ],
  quiz: [
    {
      id: "default",
      prompt: "What does voice use by default, and what's the opt-in alternative?",
      options: [
        "Cloud only, with no local option",
        "Local voice by default; Cloud voice (Robovoice) is an optional, free choice",
        "Text only until you install a plugin",
        "Only ElevenLabs",
      ],
      answer: 1,
      explain:
        "Local voice keeps audio on your machine and needs no keys. Cloud voice (Robovoice) is free and only used if you pick it.",
    },
    {
      id: "wake",
      prompt: "Which phrase opens Live Action hands-free?",
      options: ["“ok computer”", "“hey infinibot”", "“start recording”", "Any phrase at all"],
      answer: 1,
      explain: "“hey infinibot” and “live action” are the fixed Live Action wake phrases.",
    },
    {
      id: "mic",
      prompt: "When does InfiniBot open your microphone for wake words?",
      options: [
        "Always, from first launch",
        "Only after you turn on Listen for wake word",
        "Whenever you open the Voice page",
        "Never, wake words are typed",
      ],
      answer: 1,
      explain: "The wake-word listener stays off until you opt in on Voice › Commands.",
    },
    {
      id: "route",
      prompt: "You want Claude Code to answer by voice. Where do you choose that?",
      options: [
        "Voice settings › Voice Route (or the agent picker)",
        "Channels",
        "Documents",
        "It isn't possible",
      ],
      answer: 0,
      explain: "The voice route and the agent picker choose which agent or CLI answers.",
    },
  ],
};
