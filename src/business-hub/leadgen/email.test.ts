import { describe, expect, it } from "vitest";
import {
  emailPatternCandidates,
  isDisposableDomain,
  isRoleAddress,
  verifyEmailAddress,
} from "./email.js";
import { mapAfterShip, mapReacher } from "./external.js";
import { mockMx } from "./test-utils.js";

describe("email patterns", () => {
  it("generates the common corporate patterns in order", () => {
    expect(emailPatternCandidates({ name: "Dr. José Doe-Smith, DDS" }, "Acme.com")).toEqual([
      "jose@acme.com",
      "jose.doesmith@acme.com",
      "josedoesmith@acme.com",
      "jdoesmith@acme.com",
      "j.doesmith@acme.com",
      "jose_doesmith@acme.com",
      "doesmith@acme.com",
    ]);
    expect(emailPatternCandidates({ first: "Ann" }, "x.io")).toEqual(["ann@x.io"]);
  });

  it("detects role and disposable addresses", () => {
    expect(isRoleAddress("info@acme.com")).toBe(true);
    expect(isRoleAddress("no-reply@acme.com")).toBe(true);
    expect(isRoleAddress("jane@acme.com")).toBe(false);
    expect(isDisposableDomain("mailinator.com")).toBe(true);
    expect(isDisposableDomain("inbox.mailinator.com")).toBe(true);
    expect(isDisposableDomain("acme.com")).toBe(false);
  });
});

describe("verifyEmailAddress", () => {
  it("grades by syntax, disposable, MX and whether the address was published", async () => {
    const resolveMx = mockMx(["acme.com", "gmail.com"], ["flaky.com"]);
    const deps = { resolveMx };
    expect((await verifyEmailAddress("jane@acme.com", { foundOnSite: true, deps })).status).toBe(
      "valid",
    );
    const guess = await verifyEmailAddress("jane.doe@acme.com", { deps });
    expect(guess.status).toBe("risky");
    expect(guess.reasons.join(" ")).toMatch(/no SMTP probing/);
    const role = await verifyEmailAddress("info@acme.com", { foundOnSite: true, deps });
    expect(role).toMatchObject({ status: "valid", role: true });
    expect((await verifyEmailAddress("x@nomx.com", { foundOnSite: true, deps })).status).toBe(
      "invalid",
    );
    expect((await verifyEmailAddress("x@mailinator.com", { deps })).status).toBe("invalid");
    expect((await verifyEmailAddress("logo@2x.png", { deps })).status).toBe("invalid");
    expect((await verifyEmailAddress("a@flaky.com", { deps })).status).toBe("unknown");
    expect((await verifyEmailAddress("bob@gmail.com", { foundOnSite: true, deps })).freeMail).toBe(
      true,
    );
    // MX answers are cached per domain.
    expect(resolveMx.calls.filter((d) => d === "acme.com")).toHaveLength(1);
  });

  it("maps self-hosted verifier responses", () => {
    expect(
      mapAfterShip("a@acme.com", {
        email: "a@acme.com",
        reachable: "yes",
        syntax: { valid: true },
        smtp: { host_exists: true, deliverable: true, catch_all: false },
        has_mx_records: true,
        disposable: false,
      }).status,
    ).toBe("valid");
    expect(
      mapAfterShip("a@acme.com", {
        reachable: "unknown",
        syntax: { valid: true },
        smtp: { catch_all: true },
        has_mx_records: true,
      }).status,
    ).toBe("risky");
    expect(
      mapAfterShip("a@acme.com", { syntax: { valid: true }, has_mx_records: false }).status,
    ).toBe("invalid");
    expect(
      mapReacher("a@acme.com", { is_reachable: "safe", misc: { is_role_account: false } }).status,
    ).toBe("valid");
    expect(mapReacher("a@acme.com", { is_reachable: "invalid" }).status).toBe("invalid");
    expect(
      mapReacher("info@acme.com", { is_reachable: "risky", misc: { is_role_account: true } }),
    ).toMatchObject({
      status: "risky",
      role: true,
    });
  });
});
