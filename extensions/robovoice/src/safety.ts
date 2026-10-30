/**
 * Commercial-safety labels for a Robovoice deployment.
 *
 * The plugin bundles NO models. It inspects what the connected Robovoice stack
 * is configured with (effective pipelines + the declared wake word) and labels
 * non-commercial choices "self-host only" — openWakeWord's default weights
 * (Robovoice ships models/hey_jarvis.onnx as its default) and Piper Lessac
 * voices (Robovoice's PIPER_VOICES list includes en_US-lessac-medium).
 * On a *cloud* deployment the same finding is an error-level warning.
 */

import { flagVoiceModels, type VoiceSafetyFlag } from "infinibot/plugin-sdk";
import type { RobovoicePipeline } from "./client.js";
import type { RobovoiceSettings } from "./settings.js";

export type RobovoiceSafetyReport = {
  flags: VoiceSafetyFlag[];
  /** True when a self-host-only model is in use on a cloud deployment. */
  cloudViolation: boolean;
};

export function assessRobovoiceSafety(
  settings: Pick<RobovoiceSettings, "deployment" | "wakeWord">,
  pipelines: RobovoicePipeline[],
): RobovoiceSafetyReport {
  const ttsVoices: string[] = [];
  for (const p of pipelines) {
    const tts = p.tts;
    if (!tts) continue;
    for (const v of [tts.model, tts.engine]) if (typeof v === "string") ttsVoices.push(v);
    // A bare "piper" provider with no voice id still uses Robovoice's default
    // Piper list, which leads with Lessac.
    if (tts.provider === "piper" && !tts.model) ttsVoices.push("piper default (lessac)");
  }
  const flags = flagVoiceModels({
    ttsVoices,
    wakeWords: settings.wakeWord ? [settings.wakeWord] : [],
  });
  return { flags, cloudViolation: settings.deployment === "cloud" && flags.length > 0 };
}
