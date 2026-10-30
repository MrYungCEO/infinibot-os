import { createSign, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deviceIdentity,
  getKvConnect,
  kvCapabilities,
  pollKvConnectOnce,
  resetKvConnectForTests,
  revokeKvDeviceLink,
  startKvConnect,
} from "./kv-connect.js";
import {
  __setEntitlementPublicKeyForTests,
  entitlementFilePath,
  entitlementSummary,
  readEntitlementFile,
} from "./store.js";

const API = "https://kv.test/functions/v1/infinibot-entitlements";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

function token(
  ent: Array<{ p: string; src: string; until: number | null }>,
  email = "owner@kv.test",
) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: "kinglyvault",
    aud: "infinibot-plugins",
    sub: "user_kv",
    email,
    iat: now,
    exp: now + 3600,
    link: "link-1",
    ent,
  })}`;
  const s = createSign("RSA-SHA256");
  s.update(head);
  return `${head}.${s.sign(privateKey).toString("base64url")}`;
}

/** A fake KinglyVault: records calls, answers from a script. */
function fakeKv(script: Record<string, (body: Record<string, unknown>) => [number, unknown]>) {
  const calls: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push(body);
    const handler = script[String(body.action)];
    const [status, payload] = handler ? handler(body) : [404, { code: "NOT_FOUND" }];
    return new Response(JSON.stringify(payload), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

let dir: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-kv-connect-"));
  env = {
    INFINIBOT_STATE_DIR: dir,
    INFINIBOT_KINGLYVAULT_ENTITLEMENTS_API: API,
    INFINIBOT_KINGLYVAULT_URL: "https://kv.test",
    INFINIBOT_DEVICE_NAME: "test-pc",
  };
  __setEntitlementPublicKeyForTests(publicKey.export({ type: "spki", format: "pem" }).toString());
  resetKvConnectForTests();
});
afterEach(() => {
  resetKvConnectForTests();
  __setEntitlementPublicKeyForTests(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("kv-connect capabilities", () => {
  it("is unavailable while KinglyVault doesn't have the endpoints (404), and says so plainly", async () => {
    const kv = fakeKv({});
    const caps = await kvCapabilities({ env, fetchImpl: kv.fetchImpl, force: true });
    expect(caps).toMatchObject({ available: false, webUrl: "https://kv.test" });
    expect(caps.reason).toMatch(/isn't switched on yet/);
    const start = await startKvConnect({ env, fetchImpl: kv.fetchImpl, background: false });
    expect(start).toMatchObject({ ok: false });
  });

  it("is unavailable (not an exception) when KinglyVault can't be reached", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const caps = await kvCapabilities({ env, fetchImpl, force: true });
    expect(caps).toMatchObject({ available: false });
    expect(caps.reason).toMatch(/can't be reached/);
  });
});

describe("kv-connect device flow", () => {
  function script(state: { approve: boolean; deny?: boolean }) {
    return fakeKv({
      capabilities: () => [200, { deviceConnect: true, entitlements: true, version: 1 }],
      "device-start": () => [
        200,
        {
          deviceCode: "ibd_secret_device_code",
          userCode: "BCDF-GHJK",
          verificationUri: "https://kv.test/infinibot/connect",
          verificationUriComplete: "https://kv.test/infinibot/connect?code=BCDF-GHJK",
          expiresIn: 600,
          interval: 5,
        },
      ],
      "device-poll": () =>
        state.deny
          ? [403, { error: "access_denied" }]
          : state.approve
            ? [
                200,
                {
                  status: "approved",
                  token: token([{ p: "*", src: "plan:ceo", until: null }]),
                  refreshToken: "ibr_refresh",
                  apiUrl: API,
                  linkId: "link-1",
                  email: "owner@kv.test",
                },
              ]
            : [200, { status: "pending" }],
      "device-unlink": () => [200, { ok: true }],
    });
  }

  it("start → pending → approved: imports the signed token, unlocks, never exposes the device code", async () => {
    const state = { approve: false };
    const kv = script(state);
    const linked: string[][] = [];
    const hooks = {
      env,
      fetchImpl: kv.fetchImpl,
      background: false,
      onLinked: ({ changed }: { changed: string[] }) => {
        linked.push(changed);
        return { restart: true };
      },
    };
    const started = await startKvConnect(hooks);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const c = started.connect;
    expect(c).toMatchObject({
      status: "pending",
      userCode: "BCDF-GHJK",
      verificationUriComplete: "https://kv.test/infinibot/connect?code=BCDF-GHJK",
    });
    expect(JSON.stringify(c)).not.toContain("ibd_secret_device_code");
    // The approval page names this machine.
    expect(kv.calls.find((x) => x.action === "device-start")).toMatchObject({
      label: "InfiniBot on test-pc",
      client: "web",
      host: "test-pc",
    });

    expect((await pollKvConnectOnce(c.id, hooks))?.status).toBe("pending");
    expect(readEntitlementFile(env).token).toBeNull();

    state.approve = true;
    const done = await pollKvConnectOnce(c.id, hooks);
    expect(done).toMatchObject({
      status: "approved",
      email: "owner@kv.test",
      changed: ["*"],
      restart: { restart: true },
    });
    expect(linked).toEqual([["*"]]);
    expect(JSON.stringify(done)).not.toMatch(/ibr_refresh|ibd_secret/);
    const file = readEntitlementFile(env);
    expect(file.refreshToken).toBe("ibr_refresh");
    expect(file.apiUrl).toBe(API);
    expect(entitlementSummary(Date.now(), env)).toMatchObject({
      linked: true,
      account: { email: "owner@kv.test" },
    });
    // Stored 0600.
    expect(fs.statSync(entitlementFilePath(env)).mode & 0o077).toBe(0);
    expect(getKvConnect(c.id)?.status).toBe("approved");
  });

  it("denied and expired codes stop polling with a plain message", async () => {
    const kv = script({ approve: false, deny: true });
    const hooks = { env, fetchImpl: kv.fetchImpl, background: false };
    const started = await startKvConnect(hooks);
    if (!started.ok) throw new Error("start failed");
    expect(await pollKvConnectOnce(started.connect.id, hooks)).toMatchObject({
      status: "denied",
      error: expect.stringMatching(/denied/),
    });

    const kv2 = script({ approve: false });
    let t = Date.now();
    const hooks2 = { env, fetchImpl: kv2.fetchImpl, background: false, now: () => t };
    const s2 = await startKvConnect(hooks2);
    if (!s2.ok) throw new Error("start failed");
    t += 11 * 60_000;
    expect(await pollKvConnectOnce(s2.connect.id, hooks2)).toMatchObject({ status: "expired" });
  });

  it("refuses a token that isn't signed by KinglyVault", async () => {
    const kv = fakeKv({
      capabilities: () => [200, { deviceConnect: true }],
      "device-start": () => [
        200,
        {
          deviceCode: "ibd_x",
          userCode: "BCDF-GHJK",
          verificationUri: "https://kv.test/infinibot/connect",
        },
      ],
      "device-poll": () => [200, { status: "approved", token: "a.b.c", refreshToken: "ibr_x" }],
    });
    const hooks = { env, fetchImpl: kv.fetchImpl, background: false };
    const s = await startKvConnect(hooks);
    if (!s.ok) throw new Error("start failed");
    expect(await pollKvConnectOnce(s.connect.id, hooks)).toMatchObject({ status: "error" });
    expect(readEntitlementFile(env).token).toBeNull();
  });

  it("only opens http(s) approval pages", async () => {
    const kv = fakeKv({
      capabilities: () => [200, { deviceConnect: true }],
      "device-start": () => [
        200,
        { deviceCode: "ibd_x", userCode: "BCDF-GHJK", verificationUri: "javascript:alert(1)" },
      ],
    });
    expect(await startKvConnect({ env, fetchImpl: kv.fetchImpl, background: false })).toMatchObject(
      { ok: false },
    );
  });

  it("disconnect tells KinglyVault to drop the device link", async () => {
    const kv = script({ approve: true });
    const hooks = { env, fetchImpl: kv.fetchImpl, background: false };
    const s = await startKvConnect(hooks);
    if (!s.ok) throw new Error("start failed");
    await pollKvConnectOnce(s.connect.id, hooks);
    expect(await revokeKvDeviceLink({ env, fetchImpl: kv.fetchImpl })).toBe(true);
    expect(kv.calls.at(-1)).toEqual({ action: "device-unlink", refreshToken: "ibr_refresh" });
  });
});

describe("deviceIdentity", () => {
  it("names Desktop, cloud and plain installs", () => {
    expect(
      deviceIdentity({ INFINIBOT_DEVICE_NAME: "pc" }, { electron: "33.0.0" } as never),
    ).toMatchObject({
      client: "desktop",
      label: "InfiniBot Desktop on pc",
    });
    expect(deviceIdentity({ INFINIBOT_DEVICE_NAME: "pc" }, {} as never)).toMatchObject({
      client: "web",
      label: "InfiniBot on pc",
    });
  });
});
