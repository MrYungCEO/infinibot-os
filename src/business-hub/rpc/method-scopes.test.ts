import { describe, expect, it } from "vitest";
import { BUSINESS_HUB_ACTIONS } from "../tool.js";
import { BUSINESS_HUB_METHOD_SCOPES, businessHubHandlers } from "./index.js";
import { HUB_METHOD_SCOPES } from "./method-scopes.js";

describe("business hub RPC surface", () => {
  it("the static scope table matches the handlers (run scripts/business-hub/gen-method-scopes.mts)", () => {
    expect(Object.keys(HUB_METHOD_SCOPES).sort()).toEqual(Object.keys(businessHubHandlers).sort());
    expect({ ...HUB_METHOD_SCOPES }).toEqual(BUSINESS_HUB_METHOD_SCOPES);
  });

  it("every business_hub tool action calls a real hub method", () => {
    for (const [action, method] of Object.entries(BUSINESS_HUB_ACTIONS)) {
      expect(businessHubHandlers[method], `${action} → ${method}`).toBeTypeOf("function");
    }
  });

  it("secrets and sending are never plain-read scoped", () => {
    for (const m of [
      "hub.email.senders.save",
      "hub.revenue.accounts.connect",
      "hub.leadgen.config.set",
      "hub.settings.set",
    ]) {
      expect(HUB_METHOD_SCOPES[m as keyof typeof HUB_METHOD_SCOPES]).toBe("admin");
    }
    for (const m of ["hub.email.sendOne", "hub.email.campaigns.start", "hub.revenue.sync"]) {
      expect(HUB_METHOD_SCOPES[m as keyof typeof HUB_METHOD_SCOPES]).not.toBe("read");
    }
  });
});
