import { describe, expect, it } from "vitest";

import { clerkTokenStillValid } from "./saas-clerk";

const jwt = (exp: number) =>
  `h.${btoa(JSON.stringify({ exp })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.s`;

describe("cached Clerk token fallback", () => {
  const now = 1_790_000_000_000;
  it("keeps a token with time left", () => {
    expect(clerkTokenStillValid(jwt(now / 1000 + 60), now)).toBe(true);
  });
  it("drops an expired (or about-to-expire) token instead of sending it", () => {
    expect(clerkTokenStillValid(jwt(now / 1000 - 1), now)).toBe(false);
    expect(clerkTokenStillValid(jwt(now / 1000 + 2), now)).toBe(false);
    expect(clerkTokenStillValid("garbage", now)).toBe(false);
  });
});
