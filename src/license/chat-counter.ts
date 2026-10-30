// Open-source build stub: the real module is part of the hosted product (see docs/licensing/PRIVATE-SPLIT.md).
import type { Feature, PlanId } from "./middleware.js";

export interface ChatGateResult {
  allowed: boolean;
  remaining: number;
  used: number;
  cap: number;
  feature?: Feature;
  requiredPlan?: PlanId;
}

export function consumeChatSend(_now: Date = new Date()): ChatGateResult {
  return { allowed: true, remaining: Infinity, used: 0, cap: Infinity };
}
