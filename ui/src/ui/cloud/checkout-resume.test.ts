import { describe, expect, it } from "vitest";
import { pendingCheckoutPlan, safeCheckoutUrl } from "./checkout-resume";

describe("checkout resume", () => {
  it("accepts only the four paid plans", () => {
    expect(pendingCheckoutPlan("?checkout=pro")).toBe("pro");
    expect(pendingCheckoutPlan("?x=1&checkout=SCALE")).toBe("scale");
    expect(pendingCheckoutPlan("?checkout=free")).toBeNull();
    expect(pendingCheckoutPlan("?checkout=team")).toBeNull();
    expect(pendingCheckoutPlan("")).toBeNull();
  });
  it("only redirects to https whop.com", () => {
    expect(safeCheckoutUrl("https://whop.com/checkout/plan_abc")).toBe("https://whop.com/checkout/plan_abc");
    expect(safeCheckoutUrl("https://sub.whop.com/c")).toBe("https://sub.whop.com/c");
    expect(safeCheckoutUrl("http://whop.com/c")).toBeNull();
    expect(safeCheckoutUrl("https://evilwhop.com/c")).toBeNull();
    expect(safeCheckoutUrl("javascript:alert(1)")).toBeNull();
    expect(safeCheckoutUrl(42)).toBeNull();
  });
});
