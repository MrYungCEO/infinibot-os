import { createSign, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pluginAccessDecision } from "./access.js";
import { __setOwnerGrantMachineIdForTests } from "./owner-grant.js";
import { linkEntitlementsFromRelay, relayStatePath, resetRelayLinkForTests } from "./relay-link.js";
import {
  __setEntitlementPublicKeyForTests,
  __setPlanLicensePublicKeyForTests,
  extractEntitlementToken,
  importEntitlementToken,
  readEntitlementFile,
} from "./store.js";

const ent = generateKeyPairSync("rsa", { modulusLength: 2048 });
const plan = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = (k: typeof ent.publicKey) => k.export({ type: "spki", format: "pem" }).toString();
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function sign(payload: Record<string, unknown>, key = ent.privateKey) {
  const head = `${b64({ alg: "RS256", typ: "JWT" })}.${b64(payload)}`;
  const s = createSign("RSA-SHA256");
  s.update(head);
  return `${head}.${s.sign(key).toString("base64url")}`;
}
const nowSec = () => Math.floor(Date.now() / 1000);
const planLicence = (p: string, key = plan.privateKey) =>
  sign(
    {
      iss: "kinglyvault",
      aud: "infinibot",
      sub: "user_ceo",
      plan: p,
      features: [],
      iat: nowSec(),
      exp: nowSec() + 30 * 86400,
    },
    key,
  );
const entToken = (e: unknown[]) =>
  sign({
    iss: "kinglyvault",
    aud: "infinibot-plugins",
    sub: "user_ceo",
    email: "ceo@example.com",
    iat: nowSec(),
    exp: nowSec() + 14 * 86400,
    ent: e,
  });

let dir = "";
const env = () => ({ ...process.env, INFINIBOT_STATE_DIR: dir }) as NodeJS.ProcessEnv;
const saved = process.env.INFINIBOT_STATE_DIR;

beforeAll(() => {
  __setEntitlementPublicKeyForTests(pem(ent.publicKey));
  __setPlanLicensePublicKeyForTests(pem(plan.publicKey));
  __setOwnerGrantMachineIdForTests(null);
});
afterAll(() => {
  __setEntitlementPublicKeyForTests(null);
  __setPlanLicensePublicKeyForTests(null);
  __setOwnerGrantMachineIdForTests(undefined);
});
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-onecon-"));
  process.env.INFINIBOT_STATE_DIR = dir;
  resetRelayLinkForTests();
});
afterEach(() => {
  if (saved === undefined) delete process.env.INFINIBOT_STATE_DIR;
  else process.env.INFINIBOT_STATE_DIR = saved;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("CEO licence file import", () => {
  it("a KinglyVault CEO plan licence (license-jwt) unlocks every paid first-party plugin", () => {
    const r = importEntitlementToken({ token: planLicence("ceo") }, env());
    expect(r.ok).toBe(true);
    const d = pluginAccessDecision("flypic", { env: env() });
    expect(d).toMatchObject({ status: "unlocked", loadable: true, source: "plan:ceo" });
  });

  it("a free/starter plan licence imports but unlocks nothing", () => {
    expect(importEntitlementToken({ token: planLicence("starter") }, env()).ok).toBe(true);
    expect(pluginAccessDecision("flypic", { env: env() }).status).toBe("locked-purchase");
  });

  it("a plan licence signed with any other key is refused with a plain reason", () => {
    const r = importEntitlementToken({ token: planLicence("ceo", ent.privateKey) }, env());
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/bad-signature.*isn't signed by KinglyVault/);
  });

  it("accepts the key inside a JSON file, quotes or line breaks", () => {
    const t = entToken([{ p: "*", src: "plan:ceo", until: null }]);
    expect(extractEntitlementToken(JSON.stringify({ license: t })).token).toBe(t);
    expect(extractEntitlementToken(`"${t.slice(0, 40)}\n${t.slice(40)}"\n`).token).toBe(t);
    expect(extractEntitlementToken(`Bearer ${t}`).token).toBe(t);
    const r = importEntitlementToken(
      { token: JSON.stringify({ token: t, refreshToken: "ibr_x" }) },
      env(),
    );
    expect(r.ok).toBe(true);
    expect(readEntitlementFile(env()).refreshToken).toBe("ibr_x");
  });
});

describe("one connection: KinglyVault Connect → plugin licence", () => {
  const pair = () => {
    fs.mkdirSync(path.dirname(relayStatePath(env())), { recursive: true });
    fs.writeFileSync(
      relayStatePath(env()),
      JSON.stringify({
        deviceSecret: "relay-secret-0123456789abcdefghij",
        connectionId: "b5dd513b",
        deviceName: "pc",
      }),
    );
  };
  const reply = (status: number, body: unknown) => async () =>
    new Response(JSON.stringify(body), { status });

  it("does nothing when not paired", async () => {
    const r = await linkEntitlementsFromRelay({
      env: env(),
      fetchImpl: reply(500, {}) as typeof fetch,
    });
    expect(r).toEqual({ ok: false, reason: "not-paired" });
  });

  it("paired → links the licence with the relay secret and unlocks CEO plugins", async () => {
    pair();
    let sent: Record<string, unknown> = {};
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          token: entToken([{ p: "*", src: "plan:ceo", until: null }]),
          refreshToken: "ibr_new",
          apiUrl: "https://kv.example/fn",
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const r = await linkEntitlementsFromRelay({ env: env(), fetchImpl });
    expect(r.ok).toBe(true);
    expect(sent).toMatchObject({
      action: "relay-exchange",
      relaySecret: "relay-secret-0123456789abcdefghij",
    });
    expect(readEntitlementFile(env())).toMatchObject({
      refreshToken: "ibr_new",
      apiUrl: "https://kv.example/fn",
    });
    expect(pluginAccessDecision("droid-swarm", { env: env() }).status).toBe("unlocked");
    // Linked: never asks again.
    expect(
      await linkEntitlementsFromRelay({ env: env(), fetchImpl: reply(500, {}) as typeof fetch }),
    ).toEqual({ ok: false, reason: "already-linked" });
  });

  it("a non-CEO account only gets what it bought (Buy stays for the rest)", async () => {
    pair();
    await linkEntitlementsFromRelay({
      env: env(),
      fetchImpl: reply(200, {
        token: entToken([{ p: "flypic", src: "purchase", until: null }]),
        refreshToken: "ibr_a",
      }) as typeof fetch,
    });
    expect(pluginAccessDecision("flypic", { env: env() }).status).toBe("unlocked");
    expect(pluginAccessDecision("infinitrade", { env: env() }).status).toBe("locked-purchase");
  });

  it("revoked connection: refused once, not retried", async () => {
    pair();
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response(JSON.stringify({ error: "connection_revoked" }), { status: 410 });
    }) as typeof fetch;
    expect((await linkEntitlementsFromRelay({ env: env(), fetchImpl: f })).ok).toBe(false);
    expect(await linkEntitlementsFromRelay({ env: env(), fetchImpl: f })).toEqual({
      ok: false,
      reason: "refused",
    });
    expect(calls).toBe(1);
  });

  it("KinglyVault unreachable: clear error, cached access untouched", async () => {
    pair();
    importEntitlementToken({ token: entToken([{ p: "*", src: "plan:ceo", until: null }]) }, env());
    const f = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as typeof fetch;
    const r = await linkEntitlementsFromRelay({ env: env(), fetchImpl: f });
    expect(r).toMatchObject({ ok: false, reason: "unreachable" });
    expect(!r.ok && r.error).toMatch(/can't be reached.*keeps working/);
    expect(pluginAccessDecision("flypic", { env: env() }).status).toBe("unlocked");
  });
});
