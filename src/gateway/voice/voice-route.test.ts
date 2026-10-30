import { describe, expect, it } from "vitest";

import {
  isHandoffMarker,
  looksLikeRefusal,
  prefilterVoiceRoute,
  recallVoiceRoute,
  rememberVoiceRoute,
} from "./voice-route.js";

describe("prefilterVoiceRoute", () => {
  it.each([
    // The live transcript (2026-10-02).
    "My in progress projects.",
    "Tell me about our RoboVoice project.",
    "Can you spawn an InfiniBot agent to send me a message saying hello on Telegram?",
    // Other work.
    "Check my calendar for tomorrow.",
    "What's on my kanban board?",
    "Send a message to the team.",
    "Remind me to call the bank at five.",
    "Could you please look up the weather in Bangkok?",
    "I need you to create a task for the landing page.",
    "How many agents are running right now?",
    "Any updates?",
    "What's the status of the deploy?",
    "Did you send it?",
    "Search the web for the latest LiveKit release.",
    "Open the Robo Voice dashboard.",
    "What did I ask you to remember about the invoice?",
  ])("agent: %s", (message) => {
    expect(prefilterVoiceRoute(message).route).toBe("agent");
  });

  it.each([
    "Hello, can you hear me?",
    "Who is this?",
    "Hey",
    "Hi there",
    "Good morning",
    "How are you doing today?",
    "Thanks",
    "Thank you so much.",
    "Okay",
    "Bye",
    "What's your name?",
    "Can you repeat that?",
  ])("reply (small talk): %s", (message) => {
    expect(prefilterVoiceRoute(message).route).toBe("reply");
  });

  it.each([
    "Nice. Tell me a fun fact about the ocean.",
    "What do you think about pineapple on pizza?",
    "Why is the sky blue?",
    "Why not?",
  ])("unsure (the fast model decides): %s", (message) => {
    expect(prefilterVoiceRoute(message).route).toBe("unsure");
  });

  it("short follow-ups stay with the agent after an agent turn, small talk does not", () => {
    for (const m of ["Why not?", "Yes, do it.", "And the second one?", "Go ahead", "Tell me more", "What about tomorrow?"])
      expect(prefilterVoiceRoute(m, { lastRoute: "agent" })).toMatchObject({ route: "agent" });
    expect(prefilterVoiceRoute("Thanks", { lastRoute: "agent" }).route).toBe("reply");
    expect(prefilterVoiceRoute("Why not?", { lastRoute: "reply" }).route).toBe("unsure");
  });

  it("a follow-up to a refusal in the history goes to the agent", () => {
    const history = [
      { role: "user" as const, content: "Tell me about our RoboVoice project." },
      { role: "assistant" as const, content: "I'm sorry, but I can't share details about that project." },
      { role: "user" as const, content: "Why not?" },
    ];
    expect(prefilterVoiceRoute("Why not?", { history })).toEqual({ route: "agent", reason: "follow-up to a refusal" });
  });
});

describe("looksLikeRefusal", () => {
  it.each([
    "I'm sorry, but I can't share details about that project.",
    "I'm sorry, but I can't discuss that.",
    "I'm sorry, but I can't do that.",
    "I’m sorry, but I can’t do that.",
    "I cannot help with that.",
    "I'm unable to access that.",
    "I am not able to send messages.",
    "Sorry, I can't do that right now.",
    "Unfortunately, I don't have access to your calendar.",
    "That's confidential.",
    "I don't have any information about that project.",
    "As an AI, I do not have personal projects.",
  ])("refusal: %s", (text) => {
    expect(looksLikeRefusal(text)).toBe(true);
  });

  it.each([
    "Hello! Yes, I can hear you loud and clear.",
    "I'm Ash, your assistant.",
    "I can't wait to hear about it!",
    "Sorry, could you say that again?",
    "The ocean covers about seventy percent of the planet.",
    "",
  ])("not a refusal: %s", (text) => {
    expect(looksLikeRefusal(text)).toBe(false);
  });
});

describe("hand-off marker + per-call route memory", () => {
  it("recognises the marker a tool-less model writes", () => {
    expect(isHandoffMarker("HANDOFF")).toBe(true);
    expect(isHandoffMarker(" handoff.")).toBe(true);
    expect(isHandoffMarker("handoff_to_agent")).toBe(true);
    expect(isHandoffMarker('{\n  "name": "handoff_to_agent",\n  "arguments": {')).toBe(true);
    expect(isHandoffMarker("Hand me that")).toBe(false);
  });

  it("remembers the last route per call and forgets it after ten minutes", () => {
    rememberVoiceRoute("call-a", "agent", 1_000);
    expect(recallVoiceRoute("call-a", 2_000)).toBe("agent");
    expect(recallVoiceRoute("call-b", 2_000)).toBeUndefined();
    expect(recallVoiceRoute("call-a", 1_000 + 11 * 60_000)).toBeUndefined();
  });
});
