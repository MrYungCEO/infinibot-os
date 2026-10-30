import { afterAll, describe, expect, it } from "vitest";
import type { GatewayRequestHandlerOptions } from "../../gateway/server-methods/types.js";
import { closeHubDbs } from "../db.js";
import { REVENUE_METHOD_SCOPES, revenueHubHandlers } from "../rpc/revenue.js";

async function call(method: string, params: Record<string, unknown> = {}) {
  let out: { ok: boolean; payload: unknown; error: unknown } = {
    ok: false,
    payload: null,
    error: null,
  };
  await revenueHubHandlers[method]({
    params,
    respond: (ok: boolean, payload?: unknown, error?: unknown) => {
      out = { ok, payload, error };
    },
    context: { broadcast: () => {} },
  } as unknown as GatewayRequestHandlerOptions);
  return out;
}

describe("hub.revenue RPC", () => {
  afterAll(() => closeHubDbs());

  it("declares a scope for every handler", () => {
    expect(Object.keys(REVENUE_METHOD_SCOPES).sort()).toEqual(
      Object.keys(revenueHubHandlers).sort(),
    );
    expect(REVENUE_METHOD_SCOPES["hub.revenue.accounts.connect"]).toBe("admin");
    expect(REVENUE_METHOD_SCOPES["hub.revenue.sync"]).toBe("write");
    expect(REVENUE_METHOD_SCOPES["hub.revenue.summary"]).toBe("read");
  });

  it("connects, lists masked, queries and removes an account", async () => {
    const c = await call("hub.revenue.accounts.connect", {
      provider: "stripe",
      label: "Stripe RPC",
      secretRef: "env:REVENUE_RPC_TEST_KEY",
      sync: false,
    });
    expect(c.ok).toBe(true);
    const account = (c.payload as { account: { id: string; keyKind: string } }).account;
    expect(account.keyKind).toBe("env");
    const list = await call("hub.revenue.accounts.list");
    expect(JSON.stringify(list.payload)).toContain("Stripe RPC");
    expect((await call("hub.revenue.summary")).ok).toBe(true);
    expect((await call("hub.revenue.ledger", { accountId: account.id })).payload).toEqual({
      rows: [],
      total: 0,
    });
    expect((await call("hub.revenue.sync", { mode: "sideways" })).ok).toBe(false);
    expect(
      (await call("hub.revenue.accounts.connect", { provider: "paypal", label: "x", secret: "y" }))
        .ok,
    ).toBe(false);
    expect((await call("hub.revenue.accounts.remove", { id: account.id })).payload).toEqual({
      removed: true,
      purged: 0,
    });
  });
});
