/**
 * Robovoice linkage enforcement (fix/robovoice-link-enforce).
 *
 * The bug: an InfiniBot install with a Robovoice URL but NO link could start a
 * voice session; Robovoice served it from the deployment owner's default agent
 * (RoboPark's Magnus & co.) on the owner's wallet. These tests pin that every
 * voice path needs a live link, uses only the linked org's characters, and that
 * the session Robovoice mints carries that org.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startMockRobovoice, type MockCharacter, type MockRobovoice } from "../test/mock-robovoice-server.js";
import {
  assertOrgCharacter,
  clearIssuesPatch,
  configIssues,
  linkState,
  linkedCharacterFor,
  OrgRoster,
  ROSTER_FRESH_MS,
  ROSTER_STALE_MAX_MS,
} from "./link-guard.js";
import { RobovoiceLinkService } from "./link.js";
import { createRobovoiceProvider } from "./provider.js";
import { RobovoiceSettingsStore } from "./settings.js";

/** The deployment owner's public roster — what an unlinked call used to land on. */
const OWNER_ROSTER: MockCharacter[] = [
  { id: "magnus", name: "Magnus", description: "Star Guardians leader" },
  { id: "robopanda", name: "RoboPanda" },
];

const PERSONAS = [
  { id: "main", name: "INFINI" },
  { id: "cmo", name: "CMO" },
];

let mock: MockRobovoice;
let dir: string;
let store: RobovoiceSettingsStore;

function service() {
  return new RobovoiceLinkService({
    store,
    personas: () => PERSONAS,
    sleep: async () => {},
    env: {},
    detectDesktop: () => ({ installed: false, running: false }),
  });
}

async function linked(): Promise<RobovoiceLinkService> {
  const svc = service();
  const { apiBase, start } = await svc.startLogin(mock.url);
  await svc.completeLogin(apiBase, await svc.waitForLogin(apiBase, start));
  return svc;
}

const connectionRequests = () => mock.requests.filter((r) => r.path === "/api/connection-details");

function jwtMetadata(token: string): Record<string, unknown> {
  const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as { metadata: string };
  return JSON.parse(payload.metadata) as Record<string, unknown>;
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rv-enforce-"));
  store = new RobovoiceSettingsStore(dir, {}, undefined, {});
  mock = await startMockRobovoice({ publicCharacters: OWNER_ROSTER });
});
afterEach(async () => {
  await mock.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("unlinked install", () => {
  it("refuses a session even with a URL, a device id + key and a legacy URL — and never calls Robovoice", async () => {
    // Everything the old code needed to mint a call: a cloud URL, a device id,
    // an env device key, the legacy voice.robovoiceUrl.
    store = new RobovoiceSettingsStore(dir, { baseUrl: mock.url, deployment: "cloud" }, "http://192.168.1.5:3011", {
      ROBOVOICE_DEVICE_KEY: "devkey-from-env",
      ROBOVOICE_EDGE_TOKEN: "rve_from_env",
    });
    store.update({ deviceId: "infinibot-old", defaultCharacterId: "magnus" });
    expect(linkState(store)).toMatchObject({ linked: false, reason: "never_linked" });
    const provider = createRobovoiceProvider(store);
    expect(provider.configured?.()).toBe(false);
    expect(await provider.status()).toMatchObject({ ready: false, error: expect.stringMatching(/Connect Robovoice/) });
    await expect(provider.createRealtimeSession!({ agentId: "main" })).rejects.toMatchObject({
      status: 409,
      code: "robovoice_not_linked",
    });
    expect(connectionRequests()).toHaveLength(0);
  });

  it("after unlink: calls are refused and every org-scoped id is cleared", async () => {
    const svc = await linked();
    const before = store.get();
    expect(before.characterMap.main).toBeTruthy();
    await svc.unlink();
    const after = store.get();
    expect(after.link?.unlinkedAt).toBeTruthy();
    expect(after.characterMap).toEqual({});
    expect(after.linkedCharacters).toEqual({});
    expect(after.defaultCharacterId).toBeUndefined();
    expect(after.deviceId).toBeUndefined();
    expect(after.locationId).toBeUndefined();
    expect(store.secrets().deviceKey).toBeUndefined();
    const provider = createRobovoiceProvider(store);
    expect(provider.configured?.()).toBe(false);
    await expect(provider.createRealtimeSession!({ agentId: "main" })).rejects.toMatchObject({ code: "robovoice_not_linked" });
    await expect(svc.startCall("main")).rejects.toMatchObject({ code: "not_linked", status: 409 });
    expect(connectionRequests()).toHaveLength(0);
  });

  it("logout clears org-scoped config too", async () => {
    const svc = await linked();
    await svc.logout();
    expect(store.get().characterMap).toEqual({});
    expect(store.get().linkedCharacters).toEqual({});
    expect(linkState(store).linked).toBe(false);
  });

  it("switching to another org drops the old org's mappings + default character", async () => {
    const svc = await linked();
    store.update({ defaultCharacterId: store.get().characterMap.main, pipelineLocationId: "loc-old" });
    mock.options.org = { id: "99999999-2222-4333-8444-555555555555", name: "Other Org" };
    await mock.close();
    mock = await startMockRobovoice({ publicCharacters: OWNER_ROSTER, org: { id: "99999999-2222-4333-8444-555555555555", name: "Other Org" } });
    const svc2 = service();
    const { apiBase, start } = await svc2.startLogin(mock.url);
    const token = await svc2.waitForLogin(apiBase, start);
    await svc2.completeLogin(apiBase, token);
    void svc;
    const s = store.get();
    expect(s.link?.orgName).toBe("Other Org");
    expect(s.defaultCharacterId).toBeUndefined();
    expect(s.pipelineLocationId).toBeUndefined();
  });
});

describe("linked install", () => {
  it("mints the session for the linked org's own character, as the linked device, and the token carries that org", async () => {
    await linked();
    const s = store.get();
    const own = s.linkedCharacters.main!.characterId!;
    const session = await createRobovoiceProvider(store).createRealtimeSession!({ agentId: "main" });
    expect(session.characterId).toBe(own);
    const [req] = connectionRequests();
    expect(req!.query).toMatchObject({ character: own, device: s.link!.deviceId, location: s.link!.locationId });
    expect(req!.body).toMatchObject({ device_id: s.link!.deviceId });
    expect((req!.body as { device_key?: string }).device_key).toBeTruthy();
    const meta = jwtMetadata(session.token);
    // The org Robovoice bills (the hold is on THIS org's wallet).
    expect(meta).toMatchObject({ character_id: own, org_id: s.link!.orgId, billing_hold_id: expect.any(String) });
    expect(meta.character_id).not.toBe("magnus");
  });

  it("refuses a character that isn't the org's (e.g. the deployment owner's Magnus) before asking Robovoice", async () => {
    await linked();
    store.update({ linkedCharacters: {}, characterMap: { main: "magnus" } });
    await expect(createRobovoiceProvider(store).createRealtimeSession!({ agentId: "main" })).rejects.toMatchObject({
      status: 409,
      code: "robovoice_foreign_character",
    });
    expect(connectionRequests()).toHaveLength(0);
  });

  it("refuses an agent with no character of its own (never lets Robovoice pick the deployment default)", async () => {
    await linked();
    await expect(createRobovoiceProvider(store).createRealtimeSession!({ agentId: "cmo" })).rejects.toMatchObject({
      status: 409,
      code: "robovoice_no_character",
    });
    expect(connectionRequests()).toHaveLength(0);
  });

  it("works with no credits: a linked install gets a session with an empty wallet", async () => {
    await linked();
    mock.options.wallet = { balance_usd: 0, held_usd: 0, available_usd: 0 };
    const session = await createRobovoiceProvider(store).createRealtimeSession!({ agentId: "main" });
    expect(session.token).toBeTruthy();
    expect(connectionRequests()).toHaveLength(1);
  });

  it("fair-use limit (429) or a re-enabled credit gate (402) → cloud_voice_busy, no top-up link, no fallback", async () => {
    for (const opt of ["cloudVoiceBusy", "insufficientBalance"] as const) {
      await linked();
      mock.options[opt] = true;
      const err = await createRobovoiceProvider(store)
        .createRealtimeSession!({ agentId: "main" })
        .catch((e: unknown) => e as { status: number; code: string; message: string });
      expect(err).toMatchObject({ status: 429, code: "cloud_voice_busy" });
      expect(err.message).toMatch(/switch to local voice/i);
      expect(err.message).not.toMatch(/credit|top.?up|billing/i);
      mock.options[opt] = false;
    }
  });

  it("status counts the org's agents, not the deployment's public roster", async () => {
    await linked();
    const status = await createRobovoiceProvider(store).status();
    expect(status.detail).toMatch(/^Mock Org · \d+ agents?$/);
    expect(status.account?.org).toBe("Mock Org");
    expect(mock.requests.some((r) => r.path === "/api/call/characters")).toBe(false);
  });

  it("Robovoice-side enforcement: a forged unlinked device is refused even if the plugin were bypassed", async () => {
    await linked();
    const res = await fetch(`${mock.url}/api/connection-details?character=magnus&device=infinibot-forged`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-robovoice-client": "infinibot" },
      body: JSON.stringify({ device_id: "infinibot-forged", device_key: "nope" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("config validation", () => {
  const roster = [
    { id: "own-1", name: "Ash" },
    { id: "own-2", name: "Kate" },
  ];

  it("flags mappings / default / synced characters outside the org and clears them on fix", () => {
    store.update({
      link: { apiBase: "https://rv.test", orgId: "org-1", orgName: "Org One", locationId: "loc-1", deviceId: "infinibot-x", linkedAt: "x" },
      characterMap: { main: "own-1", cmo: "magnus" },
      defaultCharacterId: "robopanda",
      linkedCharacters: { main: { characterId: "own-1", managed: true }, ghost: { characterId: "gone", managed: true } },
      pipelineLocationId: "loc-elsewhere",
    });
    const s = store.get();
    const issues = configIssues(s, roster, ["loc-1"]);
    expect(issues.map((i) => `${i.field}:${i.key ?? ""}:${i.value}`).sort()).toEqual([
      "characterMap:cmo:magnus",
      "defaultCharacterId::robopanda",
      "linkedCharacters:ghost:gone",
      "pipelineLocationId::loc-elsewhere",
    ]);
    expect(issues.every((i) => i.problem === "not_in_org")).toBe(true);
    store.update(clearIssuesPatch(s, issues));
    const fixed = store.get();
    expect(fixed.characterMap).toEqual({ main: "own-1" });
    expect(fixed.defaultCharacterId).toBeUndefined();
    expect(Object.keys(fixed.linkedCharacters)).toEqual(["main"]);
    expect(fixed.pipelineLocationId).toBeUndefined();
    expect(configIssues(fixed, roster, ["loc-1"])).toEqual([]);
  });

  it("unlinked: any org-scoped id left over is flagged as stale", () => {
    store.update({ characterMap: { main: "own-1" }, defaultCharacterId: "own-2" });
    const issues = configIssues(store.get(), null);
    expect(issues).toHaveLength(2);
    expect(issues.every((i) => i.problem === "not_linked")).toBe(true);
  });

  it("character choice order: synced character > mapping > default; none → null", () => {
    const base = { characterMap: {}, linkedCharacters: {}, defaultCharacterId: undefined };
    expect(linkedCharacterFor(base, "main")).toBeNull();
    expect(linkedCharacterFor({ ...base, defaultCharacterId: "d" }, "main")).toMatchObject({ characterId: "d", source: "default" });
    expect(linkedCharacterFor({ ...base, characterMap: { main: "m" }, defaultCharacterId: "d" }, "main")).toMatchObject({ characterId: "m", source: "mapping" });
    expect(
      linkedCharacterFor({ ...base, characterMap: { main: "m" }, linkedCharacters: { main: { characterId: "l", managed: true } } }, "main"),
    ).toMatchObject({ characterId: "l", source: "linked" });
    expect(() => assertOrgCharacter("magnus", roster, "Org One")).toThrow(/isn't one of Org One's agents/);
    expect(assertOrgCharacter("own-2", roster)).toMatchObject({ name: "Kate" });
  });

  it("org roster cache: fresh reuse, stale fallback within the window, fail closed after", async () => {
    let now = 0;
    let calls = 0;
    let fail = false;
    const cache = new OrgRoster(() => now);
    const api = {
      pipelineGet: async () => {
        calls++;
        if (fail) throw new Error("down");
        return { characters: [{ id: "own-1", name: "Ash" }] } as never;
      },
    };
    const ctx = { orgId: "o", locationId: "l" };
    expect(await cache.get(ctx, api)).toHaveLength(1);
    expect(await cache.get(ctx, api)).toHaveLength(1);
    expect(calls).toBe(1);
    now += ROSTER_FRESH_MS + 1;
    fail = true;
    expect(await cache.get(ctx, api)).toHaveLength(1);
    now += ROSTER_STALE_MAX_MS;
    await expect(cache.get(ctx, api)).rejects.toMatchObject({ code: "robovoice_roster_unavailable", status: 503 });
  });
});
