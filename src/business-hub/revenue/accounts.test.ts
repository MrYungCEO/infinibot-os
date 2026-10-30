import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openHubDb } from "../db.js";
import {
  connectDiscovered,
  createAccount,
  discoverAccounts,
  fingerprint,
  getAccount,
  listAccounts,
  parseSecretRef,
  readEnvFileVar,
  removeAccount,
  resolveAccountSecret,
  updateAccount,
} from "./accounts.js";
import { upsertTxns } from "./ledger.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "rev-acct-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("revenue accounts", () => {
  it("parses and resolves secret references", () => {
    expect(parseSecretRef("env:WHOP_API_KEY")).toEqual({ kind: "env", name: "WHOP_API_KEY" });
    expect(parseSecretRef("env-file:/a/b/.env#WHOP_API_KEY")).toEqual({
      kind: "env-file",
      path: "/a/b/.env",
      name: "WHOP_API_KEY",
    });
    expect(() => parseSecretRef("env-file:relative/.env#X")).toThrow();
    expect(() => parseSecretRef("plain-key")).toThrow();
    const dir = tmp();
    const f = join(dir, ".env");
    writeFileSync(
      f,
      [
        "# c",
        'export A="quoted value" # note',
        "B=plain # trailing",
        "C='single'",
        "B=last-wins",
      ].join("\n"),
    );
    expect(readEnvFileVar(f, "A")).toBe("quoted value");
    expect(readEnvFileVar(f, "B")).toBe("last-wins");
    expect(readEnvFileVar(f, "C")).toBe("single");
    expect(readEnvFileVar(f, "D")).toBeNull();
  });

  it("stores keys encrypted or by reference and only ever lists masked info", async () => {
    const db = openHubDb(":memory:");
    const dir = tmp();
    writeFileSync(join(dir, ".env.local"), "WHOP_API_KEY=apik_from_file_123\n");
    const a = await createAccount(db, {
      provider: "whop",
      label: "Stored",
      companyRef: "biz_ABCDEFGH1234",
      secret: "apik_stored_secret_999",
    });
    const b = await createAccount(db, {
      provider: "whop",
      label: "File",
      companyRef: "biz_x",
      secretRef: `env-file:${join(dir, ".env.local")}#WHOP_API_KEY`,
    });
    const raw = db.prepare("SELECT secret FROM revenue_accounts WHERE id = ?").get(a.id) as {
      secret: string;
    };
    expect(raw.secret).not.toContain("apik_stored_secret_999");
    expect(await resolveAccountSecret(getAccount(db, a.id)!)).toBe("apik_stored_secret_999");
    expect(await resolveAccountSecret(getAccount(db, b.id)!)).toBe("apik_from_file_123");
    const listed = listAccounts(db);
    const json = JSON.stringify(listed);
    expect(json).not.toContain("apik_");
    expect(json).not.toContain("biz_ABCDEFGH1234");
    expect(listed[0]).toMatchObject({ label: "Stored", keyKind: "stored", companyRef: "••••1234" });
    expect(listed[1]).toMatchObject({ keyKind: "env-file", keyRefName: "WHOP_API_KEY" });
    await expect(createAccount(db, { provider: "whop", label: "None" })).rejects.toThrow(/secret/);

    const u = await updateAccount(db, b.id, {
      label: "Renamed",
      status: "paused",
      companyRef: "biz_new",
    });
    expect(u).toMatchObject({
      label: "Renamed",
      status: "paused",
      companyRef: "biz_new",
      apiVersion: null,
    });
  });

  it("removes ledger rows only when purgeLedger is set", async () => {
    const db = openHubDb(":memory:");
    const a = await createAccount(db, { provider: "stripe", label: "S", secretRef: "env:X" });
    const row = {
      externalId: "ch_1",
      type: "charge" as const,
      status: "succeeded",
      grossCents: 100,
      feeCents: 0,
      netCents: 100,
      refundedCents: 0,
      currency: "USD",
      amountUsdCents: 100,
      occurredAt: 1,
      productId: null,
      productName: null,
      planId: null,
      billingReason: null,
      customerRef: null,
      customerEmail: null,
      customerName: null,
      subscriptionRef: null,
      parentExternalId: null,
      raw: {},
    };
    upsertTxns(db, { id: a.id, provider: "stripe" }, [row]);
    expect(removeAccount(db, a.id)).toEqual({ removed: true, purged: 0 });
    expect((db.prepare("SELECT COUNT(*) c FROM revenue_txns").get() as { c: number }).c).toBe(1);
    const b = await createAccount(db, { provider: "stripe", label: "S2", secretRef: "env:X" });
    upsertTxns(db, { id: b.id, provider: "stripe" }, [row]);
    expect(removeAccount(db, b.id, { purgeLedger: true })).toEqual({ removed: true, purged: 1 });
  });

  it("discovers keys from plugin config, env and income.json without exposing them", async () => {
    const db = openHubDb(":memory:");
    const dir = tmp();
    const income = join(dir, "income.json");
    writeFileSync(
      income,
      JSON.stringify({
        entries: [],
        businesses: {
          flypic: { apiKeys: { whop: "whop_key_one", whopCompanyId: "biz_one0001" } },
          other: { apiKeys: { whop: "whop_key_two", stripe: "rk_live_stripe" } },
        },
      }),
    );
    const opts = {
      env: { WHOP_API_KEY: "whop_key_one", WHOP_COMPANY_ID: "biz_one0001" },
      incomePaths: [income],
      readConfig: () => ({
        plugins: {
          entries: { "business-agency": { config: { stripeSecretKey: "rk_live_stripe" } } },
        },
      }),
    };
    const found = await discoverAccounts(db, opts);
    expect(found).toHaveLength(3);
    const json = JSON.stringify(found);
    for (const k of ["whop_key_one", "whop_key_two", "rk_live_stripe", "biz_one0001"])
      expect(json).not.toContain(k);
    const one = found.find((c) => c.fingerprint === fingerprint("whop_key_one"))!;
    expect(one.sources.map((x) => x.source).sort()).toEqual(["env", "income-json"]);
    expect(one).toMatchObject({
      secretRef: "env:WHOP_API_KEY",
      companyRef: "••••0001",
      alreadyConnected: null,
    });
    const stripe = found.find((c) => c.provider === "stripe")!;
    expect(stripe.sources.map((x) => x.source).sort()).toEqual(["income-json", "plugin-config"]);

    const two = found.find((c) => c.fingerprint === fingerprint("whop_key_two"))!;
    const acct = await connectDiscovered(db, two.fingerprint, {}, opts);
    expect(acct).toMatchObject({ provider: "whop", label: "Whop (other)", secretRef: null });
    expect(await resolveAccountSecret(acct)).toBe("whop_key_two");
    const viaEnv = await connectDiscovered(db, one.fingerprint, { label: "FlyPic" }, opts);
    expect(viaEnv).toMatchObject({
      secretRef: "env:WHOP_API_KEY",
      secret: null,
      companyRef: "biz_one0001",
    });
    const again = await discoverAccounts(db, opts);
    expect(again.find((c) => c.fingerprint === two.fingerprint)?.alreadyConnected).toBe(acct.id);
    expect(again.find((c) => c.fingerprint === one.fingerprint)?.companyConnected).toBe(viaEnv.id);
  });
});
