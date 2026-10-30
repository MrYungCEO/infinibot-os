import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { normalizePluginsConfig, resolveEnableState } from "../config-state.js";
import {
  cloudPlanGoverns,
  firstPartyAccessPolicy,
  parseManifestAccess,
  pluginAccessDecision,
} from "./access.js";
import {
  __setOwnerGrantMachineIdForTests,
  OWNER_GRANT_AUDIENCE,
  ownerGrantFilePath,
} from "./owner-grant.js";
import {
  __setEntitlementPublicKeyForTests,
  entitlementFilePath,
  GRACE_MS,
  importEntitlementToken,
  readEntitlementFile,
  refreshEntitlements,
  tokenState,
  verifyEntitlementToken,
  writeEntitlementFile,
} from "./store.js";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUB = publicKey.export({ type: "spki", format: "pem" }).toString();
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function sign(
  payload: Record<string, unknown>,
  key = privateKey,
  header: Record<string, unknown> = { alg: "RS256", typ: "JWT" },
) {
  const head = `${b64(header)}.${b64(payload)}`;
  const s = createSign("RSA-SHA256");
  s.update(head);
  return `${head}.${s.sign(key).toString("base64url")}`;
}
const nowSec = () => Math.floor(Date.now() / 1000);
function claims(over: Record<string, unknown> = {}) {
  return {
    iss: "kinglyvault",
    aud: "infinibot-plugins",
    sub: "user_test",
    email: "buyer@example.com",
    iat: nowSec(),
    exp: nowSec() + 14 * 86400,
    ent: [{ p: "flypic", src: "purchase", until: null }],
    ...over,
  };
}

const PAID = [
  "infinitrade",
  "solatrix",
  "omniclinic",
  "droid-swarm",
  "infinicode",
  "products",
  "flypic",
];

let dir: string;
const saved = { ...process.env };
beforeAll(() => __setEntitlementPublicKeyForTests(PUB));
afterAll(() => __setEntitlementPublicKeyForTests(null));
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-ent-"));
  process.env.INFINIBOT_STATE_DIR = dir;
  delete process.env.INFINIBOT_DESKTOP;
  delete process.env.SAAS_MODE;
  delete process.env.FLEET_TENANT_ID;
});
afterEach(() => {
  process.env = { ...saved };
  fs.rmSync(dir, { recursive: true, force: true });
});

const cfg = (entries: Record<string, { enabled: boolean }>) =>
  normalizePluginsConfig({ entries } as never);

describe("entitlement token verification", () => {
  it("accepts a KinglyVault-signed token", () => {
    const v = verifyEntitlementToken(sign(claims()));
    expect(v.ok).toBe(true);
  });
  it("rejects a token signed by another key", () => {
    expect(verifyEntitlementToken(sign(claims(), other.privateKey))).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });
  it("rejects alg confusion (HS256 / none)", () => {
    const t = sign(claims(), privateKey, { alg: "none" });
    expect(verifyEntitlementToken(t)).toEqual({ ok: false, reason: "bad-signature" });
  });
  it("a plan-licence-shaped JWT (aud infinibot) must carry the plan-licence key's signature", () => {
    // Signed with the entitlement key, not KinglyVault's plan-licence key: refused,
    // so an `ent` claim can't be smuggled in through the plan-licence path.
    expect(verifyEntitlementToken(sign(claims({ aud: "infinibot" })))).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });
  it("rejects a tampered payload", () => {
    const [h, , s] = sign(claims()).split(".");
    const forged = `${h}.${b64(claims({ ent: [{ p: "*", src: "plan:ceo", until: null }] }))}.${s}`;
    expect(verifyEntitlementToken(forged).ok).toBe(false);
  });
});

describe("valid / expired / offline grace", () => {
  it("valid before exp", () => {
    expect(tokenState(sign(claims())).state).toBe("valid");
  });
  it("grace after exp, within the grace window", () => {
    const t = sign(claims({ exp: nowSec() - 3600 }));
    const st = tokenState(t);
    expect(st.state).toBe("grace");
  });
  it("expired after the grace window", () => {
    const t = sign(claims({ exp: nowSec() - Math.ceil(GRACE_MS / 1000) - 60 }));
    expect(tokenState(t).state).toBe("expired");
  });
  it("grace keeps a purchased plugin loadable; past grace locks it", () => {
    writeEntitlementFile({ version: 1, token: sign(claims({ exp: nowSec() - 3600 })) });
    expect(pluginAccessDecision("flypic").status).toBe("grace");
    expect(pluginAccessDecision("flypic").loadable).toBe(true);
    writeEntitlementFile({ version: 1, token: sign(claims({ exp: nowSec() - 8 * 86400 })) });
    const d = pluginAccessDecision("flypic");
    expect(d.status).toBe("expired");
    expect(d.loadable).toBe(false);
  });
  it("an entitlement's own end date is hard (grace does not extend it)", () => {
    writeEntitlementFile({
      version: 1,
      token: sign(claims({ ent: [{ p: "flypic", src: "purchase", until: nowSec() - 60 }] })),
    });
    const d = pluginAccessDecision("flypic");
    expect(d.loadable).toBe(false);
    expect(d.status).toBe("expired");
  });
});

describe("server gate: a gated plugin never loads without its entitlement", () => {
  it("free plugins are untouched", () => {
    expect(
      resolveEnableState("content-studio", "bundled", cfg({ "content-studio": { enabled: true } }))
        .enabled,
    ).toBe(true);
  });
  it("paid plugin switched on in config is refused without an entitlement", () => {
    const st = resolveEnableState("flypic", "bundled", cfg({ flypic: { enabled: true } }));
    expect(st.enabled).toBe(false);
    expect(st.reason).toMatch(/Paid plugin \(\$19\)/);
  });
  it("a forged / foreign-key token does not unlock", () => {
    writeEntitlementFile({ version: 1, token: sign(claims(), other.privateKey) });
    expect(
      resolveEnableState("flypic", "bundled", cfg({ flypic: { enabled: true } })).enabled,
    ).toBe(false);
  });
  it("a purchase for one plugin does not unlock another", () => {
    writeEntitlementFile({ version: 1, token: sign(claims()) });
    expect(
      resolveEnableState("flypic", "bundled", cfg({ flypic: { enabled: true } })).enabled,
    ).toBe(true);
    expect(
      resolveEnableState("infinicode", "bundled", cfg({ infinicode: { enabled: true } })).enabled,
    ).toBe(false);
  });
  it("a plan-wide entitlement (*) unlocks paid first-party plugins but not third-party paid ones", () => {
    writeEntitlementFile({
      version: 1,
      token: sign(claims({ ent: [{ p: "*", src: "plan:ceo", until: null }] })),
    });
    expect(pluginAccessDecision("infinicode").loadable).toBe(true);
    expect(pluginAccessDecision("infinicode").source).toBe("plan:ceo");
    expect(
      pluginAccessDecision("acme-paid", { manifestAccess: { purchase: { priceCents: 900 } } })
        .loadable,
    ).toBe(false);
  });
  it("Robovoice (optional free cloud voice) loads with no entitlement", () => {
    expect(pluginAccessDecision("robovoice").loadable).toBe(true);
    expect(
      resolveEnableState("robovoice", "bundled", cfg({ robovoice: { enabled: true } })).enabled,
    ).toBe(true);
  });
  it("a manifest cannot make a paid first-party plugin free", () => {
    expect(pluginAccessDecision("flypic", { manifestAccess: { purchase: null } }).loadable).toBe(
      false,
    );
  });
  it("there are no desktop-only plugins: droid-swarm is paid, and only paid", () => {
    expect(firstPartyAccessPolicy("droid-swarm")).toEqual({
      purchase: { priceCents: 4900, currency: "USD", interval: "once" },
    });
    // The old Desktop env switch neither unlocks nor locks anything.
    process.env.INFINIBOT_DESKTOP = "1";
    const locked = pluginAccessDecision("droid-swarm");
    expect(locked.status).toBe("locked-purchase");
    expect(locked.requires).toEqual({ purchase: true });
    expect(locked.reason).not.toMatch(/Desktop/);
    delete process.env.INFINIBOT_DESKTOP;
    writeEntitlementFile({
      version: 1,
      token: sign(claims({ ent: [{ p: "droid-swarm", src: "purchase", until: null }] })),
    });
    expect(
      resolveEnableState("droid-swarm", "bundled", cfg({ "droid-swarm": { enabled: true } }))
        .enabled,
    ).toBe(true);
  });
  it("a manifest `desktop` flag is ignored (no restriction, no unlock)", () => {
    expect(parseManifestAccess({ desktop: true })).toEqual({});
    expect(pluginAccessDecision("acme-free", { manifestAccess: { desktop: true } }).status).toBe(
      "free",
    );
  });
  it("all 7 paid first-party plugins are refused with no entitlement", () => {
    for (const id of PAID) {
      const d = pluginAccessDecision(id);
      expect(d.loadable, id).toBe(false);
      expect(d.status, id).toBe("locked-purchase");
      const st = resolveEnableState(id, "bundled", cfg({ [id]: { enabled: true } }));
      expect(st.enabled, id).toBe(false);
    }
  });
  it("hosted fleet tenants are left to the cloud plan", () => {
    process.env.SAAS_MODE = "1";
    process.env.FLEET_TENANT_ID = "t_1";
    expect(pluginAccessDecision("flypic").status).toBe("free");
  });
  it("inside the Electron runtime fleet-tenant env vars can't lift the gate", () => {
    const env = { SAAS_MODE: "1", FLEET_TENANT_ID: "t_1" } as NodeJS.ProcessEnv;
    expect(cloudPlanGoverns(env, { ...process.versions })).toBe(true);
    expect(cloudPlanGoverns(env, { ...process.versions, electron: "33.0.0" })).toBe(false);
  });
});

describe("import / refresh", () => {
  it("import stores a verified token (0600) and reports what changed", () => {
    const res = importEntitlementToken({ token: sign(claims()), refreshToken: "rt_1" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.changed).toEqual(["flypic"]);
    expect(fs.statSync(entitlementFilePath()).mode & 0o777).toBe(0o600);
    expect(readEntitlementFile().refreshToken).toBe("rt_1");
  });
  it("import refuses an unverifiable token", () => {
    const res = importEntitlementToken({ token: sign(claims(), other.privateKey) });
    expect(res.ok).toBe(false);
  });
  it("refresh swaps in the new token", async () => {
    writeEntitlementFile({ version: 1, token: sign(claims()), refreshToken: "rt_1" });
    const next = sign(claims({ ent: [{ p: "*", src: "plan:ceo", until: null }] }));
    let body: unknown;
    const res = await refreshEntitlements({
      fetchImpl: (async (_u: string, init: RequestInit) => {
        body = JSON.parse(init.body as string);
        return new Response(JSON.stringify({ token: next }), { status: 200 });
      }) as never,
    });
    expect(body).toEqual({ action: "refresh", refreshToken: "rt_1" });
    expect(res.ok).toBe(true);
    expect(readEntitlementFile().token).toBe(next);
  });
  it("offline refresh keeps the cached token (grace applies)", async () => {
    const t = sign(claims({ exp: nowSec() - 60 }));
    writeEntitlementFile({ version: 1, token: t, refreshToken: "rt_1" });
    const res = await refreshEntitlements({
      fetchImpl: (async () => {
        throw new Error("ENOTFOUND");
      }) as never,
    });
    expect(res.ok).toBe(false);
    expect(readEntitlementFile().token).toBe(t);
    expect(pluginAccessDecision("flypic").status).toBe("grace");
  });
  it("a revoked device link locks immediately", async () => {
    writeEntitlementFile({ version: 1, token: sign(claims()), refreshToken: "rt_1" });
    const res = await refreshEntitlements({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: "link_revoked" }), { status: 401 })) as never,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.revoked).toBe(true);
    expect(readEntitlementFile().token).toBeNull();
    expect(pluginAccessDecision("flypic").loadable).toBe(false);
  });
});

describe("loader cache", () => {
  it("the registry cache key changes when an entitlement arrives", async () => {
    const { entitlementCacheStamp } = await import("./store.js");
    const before = entitlementCacheStamp();
    writeEntitlementFile({ version: 1, token: sign(claims()) });
    expect(entitlementCacheStamp()).not.toBe(before);
  });
});

describe("owner grant (signed, machine-bound admin entitlement)", () => {
  const MACHINE = "0123456789abcdef0123456789abcdef";
  const machineHash = (id: string) =>
    createHash("sha256").update(`infinibot-owner:${id}`).digest("hex");
  const ownerClaims = (over: Record<string, unknown> = {}) => ({
    iss: "kinglyvault",
    aud: OWNER_GRANT_AUDIENCE,
    sub: "owner",
    role: "owner",
    machine: machineHash(MACHINE),
    iat: nowSec(),
    exp: nowSec() + 365 * 86400,
    ent: [{ p: "*", src: "admin:owner", until: null }],
    ...over,
  });
  const writeGrant = (token: string) =>
    fs.writeFileSync(ownerGrantFilePath(), JSON.stringify({ version: 1, token }), {
      mode: 0o600,
    });
  beforeEach(() => __setOwnerGrantMachineIdForTests(MACHINE));
  afterEach(() => __setOwnerGrantMachineIdForTests(undefined));

  it("unlocks all 7 paid first-party plugins on its own machine", () => {
    writeGrant(sign(ownerClaims()));
    for (const id of PAID) {
      const d = pluginAccessDecision(id);
      expect(d.loadable, id).toBe(true);
      expect(d.source, id).toBe("admin:owner");
      expect(resolveEnableState(id, "bundled", cfg({ [id]: { enabled: true } })).enabled).toBe(
        true,
      );
    }
  });
  it("never covers a third-party paid plugin via *", () => {
    writeGrant(sign(ownerClaims()));
    expect(
      pluginAccessDecision("acme-paid", { manifestAccess: { purchase: { priceCents: 900 } } })
        .loadable,
    ).toBe(false);
  });
  it("does nothing on another machine (copied file)", () => {
    writeGrant(sign(ownerClaims()));
    __setOwnerGrantMachineIdForTests("ffffffffffffffffffffffffffffffff");
    expect(pluginAccessDecision("droid-swarm").loadable).toBe(false);
    __setOwnerGrantMachineIdForTests(null);
    expect(pluginAccessDecision("droid-swarm").loadable).toBe(false);
  });
  it("rejects a forged grant (other key), a purchase-audience token, a non-owner role, and an expired grant", () => {
    for (const t of [
      sign(ownerClaims(), other.privateKey),
      sign(ownerClaims({ aud: "infinibot-plugins" })),
      sign(ownerClaims({ role: "user" })),
      sign(ownerClaims({ exp: nowSec() - 1 })),
    ]) {
      writeGrant(t);
      expect(pluginAccessDecision("flypic").loadable).toBe(false);
    }
  });
  it("can't be pasted through the purchase import (wrong audience)", () => {
    const res = importEntitlementToken({ token: sign(ownerClaims()) });
    expect(res).toMatchObject({ ok: false });
  });
  it("no env var unlocks a paid plugin", () => {
    Object.assign(process.env, {
      INFINIBOT_DESKTOP: "1",
      INFINIBOT_FEATURE_OVERRIDE: "lifetime,beta_features",
      INFINIBOT_LICENSE_JWT: sign(ownerClaims()),
      INFINIBOT_KINGLYVAULT_ENTITLEMENTS_API: "http://127.0.0.1:1/",
    });
    for (const id of PAID) expect(pluginAccessDecision(id).loadable, id).toBe(false);
  });
  it("changes the loader cache key", async () => {
    const { entitlementCacheStamp } = await import("./store.js");
    const before = entitlementCacheStamp();
    writeGrant(sign(ownerClaims()));
    expect(entitlementCacheStamp()).not.toBe(before);
  });
});
