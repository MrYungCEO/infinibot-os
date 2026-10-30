// Open-source build stub: the real module is part of the hosted product (see docs/licensing/PRIVATE-SPLIT.md).
import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";

export type PlanId = "free" | "starter" | "ceo" | "vip";

export type Feature =
  | "browse_courses"
  | "free_courses"
  | "walkthroughs"
  | "leaderboard"
  | "task_manager"
  | "ai_chat_basic"
  | "prompt_library_read"
  | "premium_courses"
  | "image_generation"
  | "image_processing"
  | "agent_vault_browse"
  | "ai_tools_browse"
  | "prompt_scorer"
  | "ai_chat_unlimited"
  | "agent_builder"
  | "agent_vault_publish"
  | "form_builder"
  | "chatbot_builder"
  | "website_extractor"
  | "linktree_builder"
  | "n8n_prompt_generator"
  | "unlimited_image_generation"
  | "priority_support"
  | "beta_features"
  | "infinibot_save"
  | "infinibot_voice_pack"
  | "offline_only_mode"
  | "vip_support"
  | "early_access"
  | "lifetime";

export interface GatedResponseDetails {
  gated: true;
  requiredPlan: PlanId;
  feature: Feature;
}

/** Unreachable here (nothing is gated); kept because chat handlers reference it. */
export function gatedError(feature: Feature): {
  code: string;
  message: string;
  details: GatedResponseDetails;
} {
  return {
    code: "GATED",
    message: `Feature is not available: ${feature}`,
    details: { gated: true, requiredPlan: "free", feature },
  };
}

export function requireFeature<T extends GatewayRequestHandler>(_feature: Feature, handler: T): T {
  return handler;
}
