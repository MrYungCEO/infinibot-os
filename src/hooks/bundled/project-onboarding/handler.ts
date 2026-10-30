/**
 * Project Onboarding Hook
 *
 * Automatically triggers project onboarding when:
 * 1. A new session is created (/new command)
 * 2. A webchat session starts without a linked project
 */

import os from "node:os";
import type { InfinibotConfig } from "../../../config/config.js";
import { resolveAgentIdFromSessionKey } from "../../../routing/session-key.js";
import {
  shouldTriggerOnboarding,
  startOnboarding,
  getOnboardingPrompt,
} from "../../../projects/index.js";
import type { HookHandler } from "../../hooks.js";

/**
 * Auto-trigger onboarding on /new command or new webchat sessions
 */
const projectOnboardingHook: HookHandler = async (event) => {
  // Only trigger on 'new' command (after /new is used)
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  try {
    console.log("[project-onboarding] Hook triggered for /new command");

    const context = event.context || {};
    const cfg = context.cfg as InfinibotConfig | undefined;
    const agentId = resolveAgentIdFromSessionKey(event.sessionKey);

    // Check if we should trigger onboarding
    const onboardingCheck = shouldTriggerOnboarding(event.sessionKey);

    if (!onboardingCheck.trigger) {
      console.log("[project-onboarding] Onboarding not triggered:", onboardingCheck.reason);
      return;
    }

    console.log("[project-onboarding] Starting onboarding flow");

    // Start onboarding
    const state = startOnboarding(event.sessionKey, agentId, onboardingCheck.existingProjects);

    // Get the prompt and push it to event messages
    const prompt = getOnboardingPrompt(state, onboardingCheck.existingProjects);

    if (prompt) {
      event.messages.push(prompt);
      console.log("[project-onboarding] Pushed onboarding prompt to event messages");
    }
  } catch (err) {
    console.error(
      "[project-onboarding] Failed to trigger onboarding:",
      err instanceof Error ? err.message : String(err),
    );
  }
};

export default projectOnboardingHook;
