/**
 * <credit-usage-breakdown> — BACK-COMPAT SHIM.
 *
 * This product has no "credits" (BYOK + Whop + KinglyVault). The real component
 * is now {@link TokenUsageBreakdown} in `./token-usage-breakdown`, which shows
 * REAL token counts instead of the old fabricated `1 credit = $0.001` figure.
 *
 * This file is kept for one release so existing mounts that import
 * `"../components/credit-usage-breakdown"` and render `<credit-usage-breakdown>`
 * (dashboard, agent-ops world map, masonry grid, agent-activity) keep working
 * without edits. They now render real tokens. New code should import and use
 * `<token-usage-breakdown>` directly.
 *
 * @deprecated Use `<token-usage-breakdown>` / {@link TokenUsageBreakdown}.
 */

import { TokenUsageBreakdown } from "./token-usage-breakdown";

export { TokenUsageBreakdown } from "./token-usage-breakdown";

// A distinct subclass is required because a custom-element class may only be
// registered to a single tag name; TokenUsageBreakdown already owns
// <token-usage-breakdown>.
export class CreditUsageBreakdown extends TokenUsageBreakdown {}

if (typeof customElements !== "undefined" && !customElements.get("credit-usage-breakdown")) {
  customElements.define("credit-usage-breakdown", CreditUsageBreakdown);
}

declare global {
  interface HTMLElementTagNameMap {
    "credit-usage-breakdown": CreditUsageBreakdown;
  }
}
