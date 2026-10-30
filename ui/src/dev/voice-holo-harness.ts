/**
 * Dev harness: mounts the real <voice-robovoice-console> (Session tab) against a
 * fake gateway client so the Voice Terminal can be screenshotted without a
 * gateway or a Robovoice account. `?state=live` drives a mid-call state with a
 * transcript; `?state=idle` (default) shows the page before a call.
 */
import "../ui/views/voice-robovoice/voice-console";
// The control UI's live theme tokens (--g-*), captured from the running app, so
// the harness renders with the same palette the shell applies at runtime.
import themeVars from "./voice-holo-theme.json";

for (const [k, v] of Object.entries(themeVars as Record<string, string>)) document.documentElement.style.setProperty(k, v);

const params = new URLSearchParams(location.search);
const stateName = params.get("state") ?? "idle";
const stages = {
  stt: { provider: "assemblyai", model: "universal-streaming-english" },
  llm: { provider: "infinibot", model: "infinibot:main" },
  tts: { provider: "kokoro", model: "af_heart" },
};
const credits = { available: true, availableCredits: 128_400, availableUsd: 42.8, creditUsd: 0.000333 };
const responses: Record<string, unknown> = {
  "robovoice.link.status": {
    linked: true, signedIn: true, apiBase: "https://robovoice.io", org: { id: "o1", name: "Gengu" },
    agents: [], credits, remote: { fetchedAt: new Date().toISOString(), stale: false },
  },
  "robovoice.credits.get": credits,
  "robovoice.voiceAgents.list": {
    linked: true, location: "loc1", publicUrl: null,
    agents: [{ id: "main", name: "INFINI", voiceAgent: true, characterId: "c1", syncedAt: null, error: null, llm: "infinibot", llmBackend: "gateway", ttsProvider: null, voice: null, llmModel: null }],
  },
  "robovoice.voiceLlm.status": { enabled: true, turns: [] },
  "robovoice.characters.list": { characters: [] },
  "robovoice.settings.get": {},
  "robovoice.pipeline.config.get": { effective: { location: stages, characters: { c1: stages } } },
};
const client = {
  connected: true,
  request: async (method: string) => {
    if (method in responses) return structuredClone(responses[method]);
    return {};
  },
  subscribe: () => () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
};

const el = document.createElement("voice-robovoice-console") as any;
el.client = client;
document.body.appendChild(el);
// The plugin host gates the tab on a loaded plugin; the harness has none.
el.pluginAvailable = true;
void el.load();

if (stateName === "live") {
  const t0 = new Date();
  t0.setHours(14, 37, 12, 0);
  const at = (s: number) => t0.getTime() + s * 1000;
  setTimeout(() => {
    el.call = {
      ...el.call,
      phase: "active", agentId: "main", room: "robopark-c1", mode: "cloud", startedAt: new Date(Date.now() - 18_000).toISOString(),
      media: "connected", live: true, participants: 2, agentState: "speaking", playback: "playing", audioIn: true,
      transcript: [
        { id: "1", who: "you", text: "Hey Infini, what can you do?", final: true, at: at(0) },
        { id: "2", who: "agent", text: "I can chat, answer questions, run your agents and speak the answers out loud.", final: true, at: at(1) },
        { id: "3", who: "you", text: "Tell me a fun fact about space.", final: true, at: at(8) },
        { id: "4", who: "agent", text: "A day on Venus is longer than a year on Venus.", final: true, at: at(9) },
        { id: "5", who: "you", text: "That's crazy. Can you speak it?", final: true, at: at(16) },
        { id: "6", who: "agent", text: "Sure! Here you go…", final: true, at: at(18) },
      ],
      latency: [{ at: at(18), totalMs: 812, sttToLlmMs: 340, llmToTtsMs: 290 }],
    };
    // The brief's system log lines (the view's own lines are replaced for the screenshot).
    setTimeout(() => {
      const sv = el.shadowRoot?.querySelector("voice-session-view") as any;
      if (!sv) return;
      sv.logs = [
        { text: "SYSTEM INITIALIZED", type: "system", timestamp: at(-11) },
        { text: "Found 3 mics, 3 speakers", type: "info", timestamp: at(-11) },
        { text: "Connected to INFINI", type: "success", timestamp: at(0) },
        { text: "STT → LLM → TTS pipeline ready", type: "success", timestamp: at(9) },
        { text: "Voice output playing...", type: "info", timestamp: at(18) },
      ];
    }, 400);
  }, 1500);
}
(window as any).__voice = el;
