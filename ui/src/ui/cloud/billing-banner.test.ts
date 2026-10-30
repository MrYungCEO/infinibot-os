import { describe, expect, it } from "vitest";
import { billingBannerModel, safeManageUrl } from "./billing-banner";

const NOW = Date.parse("2026-10-01T00:00:00Z");

describe("billing banner", () => {
  it("shows nothing unless the tenant is past due", () => {
    expect(billingBannerModel(null, NOW)).toBeNull();
    expect(billingBannerModel({ status: "ok" }, NOW)).toBeNull();
    expect(billingBannerModel({ status: "lapsed" }, NOW)).toBeNull();
  });
  it("past due: counts down the grace period and links to Whop", () => {
    const m = billingBannerModel(
      {
        status: "past_due",
        graceUntil: "2026-10-07T12:00:00Z",
        manageUrl: "https://whop.com/@me/settings/memberships/",
      },
      NOW,
    );
    expect(m).toEqual({
      message: "Payment failed",
      detail: "Update your billing details within 7 days to keep your plan.",
      manageUrl: "https://whop.com/@me/settings/memberships/",
    });
    expect(
      billingBannerModel({ status: "past_due", graceUntil: "2026-10-01T06:00:00Z" }, NOW)?.detail,
    ).toBe("Update your billing details within 1 day to keep your plan.");
    expect(
      billingBannerModel({ status: "past_due", graceUntil: "2026-09-30T00:00:00Z" }, NOW)?.detail,
    ).toBe("Update your billing details today to keep your plan.");
  });
  it("never links anywhere but https whop.com", () => {
    expect(safeManageUrl("https://whop.com/orders/mem_1/manage/")).toBe(
      "https://whop.com/orders/mem_1/manage/",
    );
    expect(safeManageUrl("https://evilwhop.com/x")).toBeNull();
    expect(safeManageUrl("javascript:alert(1)")).toBeNull();
    expect(billingBannerModel({ status: "past_due", manageUrl: "http://whop.com/x" }, NOW)?.manageUrl).toBeNull();
  });
});
