import { describe, expect, it } from "vitest";
import { pendingMarketplacePlugin, safeReceiptUrl } from "./marketplace-resume";

describe("marketplace resume (sign in to download a bought plugin)", () => {
  it("reads a plugin id from ?marketplace=", () => {
    expect(pendingMarketplacePlugin("?marketplace=flypic")).toBe("flypic");
    expect(pendingMarketplacePlugin("?x=1&marketplace=Droid-Swarm")).toBe("droid-swarm");
    expect(pendingMarketplacePlugin("?marketplace=../x")).toBeNull();
    expect(pendingMarketplacePlugin("?marketplace=")).toBeNull();
    expect(pendingMarketplacePlugin("")).toBeNull();
  });
  it("only follows a same-origin receipt page", () => {
    const o = "https://cloud.infinibotos.com";
    expect(safeReceiptUrl(`${o}/marketplace/flypic/purchased?receipt=ibrc1.p.x.0.sig`, o)).toBe(`${o}/marketplace/flypic/purchased?receipt=ibrc1.p.x.0.sig`);
    expect(safeReceiptUrl("/marketplace/flypic/purchased?receipt=r", o)).toBe(`${o}/marketplace/flypic/purchased?receipt=r`);
    expect(safeReceiptUrl("https://evil.example/marketplace/flypic/purchased", o)).toBeNull();
    expect(safeReceiptUrl(`${o}/app/admin`, o)).toBeNull();
    expect(safeReceiptUrl("javascript:alert(1)", o)).toBeNull();
    expect(safeReceiptUrl(null, o)).toBeNull();
  });
});
