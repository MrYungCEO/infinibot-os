/**
 * The always-on "InfiniBot product expert" prompt section for the main agent
 * (system-prompt.ts, when the agent has infinibot_help) and the voice
 * orchestrator (voice-orchestrator-prompt.ts). Short by design: a one-line-
 * per-group UI map + the rules; details come from infinibot_help at call time.
 */

import { renderPromptSection } from "./digest.js";
import { enabledPluginIds, getKnowledgeBase } from "./runtime.js";

export function infinibotExpertPromptLines(opts: { plain?: boolean } = {}): string[] {
  try {
    const kb = getKnowledgeBase();
    const lines = renderPromptSection(kb, {
      enabledPlugins: enabledPluginIds() ?? undefined,
      plain: opts.plain,
    });
    return opts.plain ? lines.map((l) => l.replace(/`/g, "").replace(/\*\*/g, "")) : lines;
  } catch {
    return [];
  }
}
