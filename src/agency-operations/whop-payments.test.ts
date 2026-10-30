import { describe, expect, it } from "vitest";

import {
  WHOP_INVOICE_ID_KEY,
  WHOP_LINK_REFERENCE_KEY,
  centsToWhopAmount,
  createWhopCheckoutLink,
  createWhopTransport,
  deleteWhopCheckoutLink,
  listWhopPayments,
  normalizeWhopPayment,
  whopAmountToCents,
  type WhopTransport,
} from "./whop-payments.js";

/**
 * A recording transport. Every test in this file goes through it — the real
 * Whop API is never called, exactly as `notion-bridge.test.ts` does for Notion.
 */
function fakeTransport(
  handler: (
    path: string,
    init?: { method?: string; body?: unknown; query?: Record<string, unknown> },
  ) => unknown,
): WhopTransport & {
  calls: Array<{ path: string; method: string; body: unknown; query: unknown }>;
} {
  const calls: Array<{ path: string; method: string; body: unknown; query: unknown }> = [];
  return {
    calls,
    async request(path, init) {
      calls.push({ path, method: init?.method ?? "GET", body: init?.body, query: init?.query });
      return handler(path, init as never);
    },
  };
}

describe("Whop money conversion", () => {
  it("converts integer cents to Whop's decimal major units", () => {
    expect(centsToWhopAmount(690)).toBe(6.9);
    expect(centsToWhopAmount(105_997)).toBe(1059.97);
    expect(centsToWhopAmount(1)).toBe(0.01);
  });

  it("refuses non-integer or non-positive cents rather than silently rounding", () => {
    expect(() => centsToWhopAmount(6.5)).toThrow(/whole number of cents/);
    expect(() => centsToWhopAmount(0)).toThrow(/greater than zero/);
    expect(() => centsToWhopAmount(-100)).toThrow(/greater than zero/);
  });

  it("converts major units back to cents without the float error `value * 100` has", () => {
    // 6.9 * 100 === 689.9999999999999 in IEEE-754.
    expect(whopAmountToCents(6.9)).toBe(690);
    // 1.005 * 100 === 100.49999999999999, which rounds to 100 — one cent short.
    expect(whopAmountToCents(1.005)).toBe(101);
    expect(whopAmountToCents(0.07)).toBe(7);
    expect(whopAmountToCents(1059.97)).toBe(105_997);
    expect(whopAmountToCents(100)).toBe(10_000);
    expect(whopAmountToCents("249.99")).toBe(24_999);
    expect(whopAmountToCents(0)).toBe(0);
  });

  it("round-trips every amount an invoice could carry", () => {
    for (const cents of [1, 7, 99, 100, 690, 1_999, 4_997, 105_997, 1_000_000]) {
      expect(whopAmountToCents(centsToWhopAmount(cents))).toBe(cents);
    }
  });

  it("throws on an amount it cannot parse rather than guessing zero", () => {
    expect(() => whopAmountToCents("not money")).toThrow(/unparseable/);
    expect(() => whopAmountToCents(null)).toThrow(/unparseable/);
    expect(() => whopAmountToCents(Number.NaN)).toThrow(/unparseable/);
  });
});

describe("createWhopTransport", () => {
  it("fails with an actionable message when no API key is configured", () => {
    expect(() => createWhopTransport("")).toThrow("Whop API key not configured");
    expect(() => createWhopTransport("   ")).toThrow("Whop API key not configured");
    expect(() => createWhopTransport(undefined as unknown as string)).toThrow(
      "Whop API key not configured",
    );
  });
});

describe("createWhopCheckoutLink", () => {
  const baseInput = {
    companyId: "biz_test",
    amountCents: 105_997,
    currency: "USD",
    title: "Invoice INV-0042",
    reference: "ref-abc",
    invoiceId: "inv-1",
  };

  it("posts an inline one-time plan and returns the purchase URL", async () => {
    const transport = fakeTransport(() => ({
      id: "ch_123",
      purchase_url: "https://whop.com/checkout/ch_123",
      plan: { id: "plan_123", initial_price: 1059.97, currency: "usd" },
    }));

    const link = await createWhopCheckoutLink(transport, baseInput);

    expect(link).toEqual({
      id: "ch_123",
      purchaseUrl: "https://whop.com/checkout/ch_123",
      planId: "plan_123",
      currency: "usd",
      amountCents: 105_997,
    });

    const [call] = transport.calls;
    expect(call.path).toBe("/checkout_configurations");
    expect(call.method).toBe("POST");
    const body = call.body as any;
    // Whop's field is `company_id`, and for an inline plan it lives inside
    // `plan`. Sending `account_id` — its internal name, which is what the API
    // error quotes back — produced a 400 on every real call while this test
    // passed, so the assertion now pins the documented shape.
    expect(body.account_id).toBeUndefined();
    expect(body.company_id).toBeUndefined();
    expect(body.plan.company_id).toBe("biz_test");
    expect(body.mode).toBe("payment");
    // Whop takes major units; the invoice's cents must not be sent raw.
    expect(body.plan.initial_price).toBe(1059.97);
    expect(body.plan.plan_type).toBe("one_time");
    expect(body.plan.currency).toBe("usd");
    // A plan per invoice, so a plan id is per-invoice evidence.
    expect(body.plan.force_create_new_plan).toBe(true);
    // The correlation token rides on the checkout's top-level metadata only.
    expect(body.metadata[WHOP_INVOICE_ID_KEY]).toBe("inv-1");
    expect(body.metadata[WHOP_LINK_REFERENCE_KEY]).toBe("ref-abc");
    // Whop's inline-plan schema has no `metadata` field and 400s the whole
    // request when one is sent, so the plan must not carry it.
    expect(body.plan.metadata).toBeUndefined();
    expect(body.plan.internal_notes).toContain("ref-abc");
  });

  it("records the price Whop echoed back, not the price we asked for", async () => {
    const transport = fakeTransport(() => ({
      id: "ch_9",
      purchase_url: "https://whop.com/checkout/ch_9",
      // Whop re-denominated: the client will be charged 999.00, not 1059.97.
      plan: { id: "plan_9", initial_price: 999, currency: "eur" },
    }));
    const link = await createWhopCheckoutLink(transport, baseInput);
    expect(link.amountCents).toBe(99_900);
    expect(link.currency).toBe("eur");
  });

  it("refuses a response with no purchase_url instead of storing an unusable link", async () => {
    const transport = fakeTransport(() => ({ id: "ch_1", plan: { id: "plan_1" } }));
    await expect(createWhopCheckoutLink(transport, baseInput)).rejects.toThrow(
      /returned no purchase_url/,
    );
  });

  it("surfaces a scope failure as an actionable message", async () => {
    const transport = fakeTransport(() => {
      throw new Error(
        "Whop API 403 Forbidden: insufficient scope — the Whop API key was rejected for this operation; creating checkout links needs a key with checkout/plan write scope, which is broader than the read scope used for payment sync",
      );
    });
    await expect(createWhopCheckoutLink(transport, baseInput)).rejects.toThrow(
      /checkout\/plan write scope/,
    );
  });
});

describe("deleteWhopCheckoutLink", () => {
  it("reports a remote failure instead of throwing, so a local detach can proceed", async () => {
    const transport = fakeTransport(() => {
      throw new Error("Whop API 404 Not Found: no such configuration");
    });
    const outcome = await deleteWhopCheckoutLink(transport, "ch_gone");
    expect(outcome.deleted).toBe(false);
    expect(outcome.error).toMatch(/404/);
  });

  it("deletes by id", async () => {
    const transport = fakeTransport(() => ({}));
    expect(await deleteWhopCheckoutLink(transport, "ch_1")).toEqual({ deleted: true });
    expect(transport.calls[0]).toMatchObject({
      path: "/checkout_configurations/ch_1",
      method: "DELETE",
    });
  });
});

describe("normalizeWhopPayment", () => {
  const settled = {
    id: "pay_1",
    status: "succeeded",
    total: 1059.97,
    currency: "USD",
    paid_at: "2024-03-15T10:00:00.000Z",
    checkout_configuration_id: "ch_123",
    plan: { id: "plan_123", metadata: { [WHOP_LINK_REFERENCE_KEY]: "ref-abc" } },
    metadata: { [WHOP_INVOICE_ID_KEY]: "inv-1", [WHOP_LINK_REFERENCE_KEY]: "ref-abc" },
    user: { name: "Jane Buyer", email: "jane@acme.test" },
    product: { title: "Retainer" },
  };

  it("reduces a settled payment to cents, a timestamp and its evidence", () => {
    expect(normalizeWhopPayment(settled)).toEqual({
      externalId: "pay_1",
      amountCents: 105_997,
      currency: "usd",
      paidAt: Date.parse("2024-03-15T10:00:00.000Z"),
      checkoutConfigurationId: "ch_123",
      planId: "plan_123",
      metadata: { [WHOP_INVOICE_ID_KEY]: "inv-1", [WHOP_LINK_REFERENCE_KEY]: "ref-abc" },
      customerName: "Jane Buyer",
      customerEmail: "jane@acme.test",
      productTitle: "Retainer",
    });
  });

  it("drops anything that is not settled money we can date", () => {
    expect(normalizeWhopPayment({ ...settled, status: "failed", substatus: undefined })).toBeNull();
    expect(normalizeWhopPayment({ ...settled, id: undefined })).toBeNull();
    expect(normalizeWhopPayment({ ...settled, total: 0 })).toBeNull();
    expect(normalizeWhopPayment({ ...settled, currency: "" })).toBeNull();
    expect(
      normalizeWhopPayment({
        ...settled,
        paid_at: undefined,
        created_at: undefined,
        updated_at: undefined,
      }),
    ).toBeNull();
    expect(normalizeWhopPayment(null)).toBeNull();
  });

  it("accepts a settled label in substatus and unix-second timestamps", () => {
    const normalized = normalizeWhopPayment({
      ...settled,
      status: "draft",
      substatus: "succeeded",
      paid_at: 1_710_496_800,
    });
    expect(normalized?.paidAt).toBe(1_710_496_800_000);
  });

  it("lets payment metadata win over the weaker plan metadata", () => {
    const normalized = normalizeWhopPayment({
      ...settled,
      plan: { id: "plan_123", metadata: { [WHOP_INVOICE_ID_KEY]: "inv-STALE" } },
      metadata: { [WHOP_INVOICE_ID_KEY]: "inv-1" },
    });
    expect(normalized?.metadata[WHOP_INVOICE_ID_KEY]).toBe("inv-1");
  });
});

describe("listWhopPayments", () => {
  it("drains every page and collapses a payment repeated across pages", async () => {
    // Whop v1 paginates by cursor (`page_info.end_cursor` → `?after=`); the
    // `page` query param does not advance, so the loop is driven off page_info.
    const page = (ids: string[], endCursor: string | null) => ({
      data: ids.map((id) => ({
        id,
        status: "succeeded",
        total: 10,
        currency: "usd",
        paid_at: "2024-03-15T10:00:00.000Z",
      })),
      page_info: { end_cursor: endCursor, has_next_page: endCursor !== null },
    });
    const transport = fakeTransport((_path, init) =>
      (init?.query as any).after === undefined
        ? page(["pay_1", "pay_2"], "cursor_1")
        : page(["pay_2", "pay_3"], null),
    );

    const payments = await listWhopPayments(transport, {
      companyId: "biz_test",
      perPage: 2,
    });

    expect(payments.map((p) => p.externalId)).toEqual(["pay_1", "pay_2", "pay_3"]);
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[0].query).toMatchObject({ company_id: "biz_test", per_page: 2 });
    expect((transport.calls[0].query as any).after).toBeUndefined();
    expect(transport.calls[1].query).toMatchObject({ company_id: "biz_test", after: "cursor_1" });
  });
});
