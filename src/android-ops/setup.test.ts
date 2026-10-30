/**
 * Setup-path unit tests. These cover the code an operator hits *before* there
 * is anything in the database: registering a handset from a form, importing a
 * roster, and reporting what infrastructure is actually configured.
 *
 * The secret-material guard is the load-bearing one here — a regression that
 * lets a password through would persist a credential in plain SQLite.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  androidIdFromNotes,
  assertNoSecretMaterial,
  buildSetupSteps,
  detectFlyConfig,
  ipFromSerial,
  looksLikeDemoData,
  matchDeviceByIdentity,
  nextFreeSlot,
  normalizeAccountImport,
  normalizeAndroidId,
  normalizeDeviceRegistration,
  normalizeSecretRef,
  sameStableIdentity,
  SecretMaterialError,
  toPublicAccount,
  type StoreCensus,
} from "./setup.js";
import type { PhoneDevice, SocialAccount } from "./types.js";

function device(over: Partial<PhoneDevice> = {}): PhoneDevice {
  const now = 1_800_000_000_000;
  return {
    id: "dev-01",
    label: "Phone 01",
    slot: 1,
    model: "Pixel 4a",
    androidVersion: "13",
    serial: "SERIAL01",
    androidId: null,
    status: "online",
    batteryPct: 80,
    charging: true,
    storageFreeMb: 20_000,
    storageTotalMb: 64_000,
    wifiSsid: "OPS",
    wifiSignalDbm: -50,
    tailscaleIp: "100.64.20.11",
    tailscaleUp: true,
    adbState: "device",
    scrcpyState: "ready",
    lastHeartbeatAt: now,
    isSpare: false,
    appVersion: null,
    updateChannel: "stable",
    notes: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

describe("secret material guard", () => {
  it("rejects every credential-valued field name", () => {
    for (const field of ["password", "totpSeed", "recoveryCodes", "sessionToken", "apiKey"]) {
      expect(() => assertNoSecretMaterial({ handle: "x", [field]: "value" })).toThrow(
        SecretMaterialError,
      );
    }
  });

  it("names the offending fields without echoing their values", () => {
    try {
      assertNoSecretMaterial({ password: "hunter2", totp: "JBSWY3DP" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SecretMaterialError);
      const err = e as SecretMaterialError;
      expect(err.fields.sort()).toEqual(["password", "totp"]);
      expect(err.message).not.toContain("hunter2");
      expect(err.message).not.toContain("JBSWY3DP");
    }
  });

  it("lets a vault pointer through and derives one when absent", () => {
    expect(normalizeSecretRef("vault://android-ops/ig/shop", "instagram", "shop")).toBe(
      "vault://android-ops/ig/shop",
    );
    expect(normalizeSecretRef(undefined, "tiktok", "shop")).toBe("vault://android-ops/tiktok/shop");
  });

  it("treats a literal secret pasted into secretRef as secret material", () => {
    expect(() => normalizeSecretRef("hunter2", "instagram", "shop")).toThrow(SecretMaterialError);
  });

  it("projects an account with the vault pointer flagged and no credential fields", () => {
    const account = {
      id: "acct-1",
      handle: "shop",
      platform: "instagram",
      secretRef: "vault://android-ops/instagram/shop",
      password: "hunter2",
    } as unknown as SocialAccount;
    const pub = toPublicAccount(account);
    expect(pub.secretRefPresent).toBe(true);
    expect(pub.secretRefScheme).toBe("vault");
    expect(Object.keys(pub)).not.toContain("password");
  });
});

describe("device registration", () => {
  it("fills in the label, slot and id an operator did not type", () => {
    const registered = normalizeDeviceRegistration(
      { serial: "9B021FFAZ00A07" },
      { existing: [device()], now: 1 },
    );
    expect(registered.slot).toBe(2);
    expect(registered.label).toBe("Phone 02");
    expect(registered.id).toBe("dev-02");
  });

  it("never claims a freshly registered handset is online", () => {
    const registered = normalizeDeviceRegistration({ serial: "NEWSERIAL" }, { existing: [] });
    expect(registered.status).toBe("offline");
    expect(registered.adbState).toBe("absent");
    expect(registered.scrcpyState).toBe("unavailable");
    expect(registered.lastHeartbeatAt).toBeNull();
  });

  it("refuses a duplicate serial and a duplicate slot", () => {
    expect(() =>
      normalizeDeviceRegistration({ serial: "SERIAL01" }, { existing: [device()] }),
    ).toThrow(/already registered/);
    expect(() =>
      normalizeDeviceRegistration({ serial: "OTHER", slot: 1 }, { existing: [device()] }),
    ).toThrow(/already held/);
  });

  it("refuses a serial that is not argv-safe", () => {
    expect(() => normalizeDeviceRegistration({ serial: "a; rm -rf /" }, { existing: [] })).toThrow(
      /not a usable adb serial/,
    );
    expect(() => normalizeDeviceRegistration({ serial: "" }, { existing: [] })).toThrow(
      /serial is required/,
    );
  });

  it("learns the tailnet address from a host:port serial", () => {
    const registered = normalizeDeviceRegistration(
      { serial: "100.64.20.19:5555" },
      { existing: [] },
    );
    expect(registered.tailscaleIp).toBe("100.64.20.19");
    expect(ipFromSerial("9B021FFAZ00A01")).toBeNull();
  });

  it("re-registers an existing device without losing its history", () => {
    const existing = device({ batteryPct: 42, createdAt: 5 });
    const updated = normalizeDeviceRegistration(
      { id: "dev-01", serial: "SERIAL01", label: "Rack A / 1" },
      { existing: [existing], now: 99 },
    );
    expect(updated.label).toBe("Rack A / 1");
    expect(updated.slot).toBe(1);
    expect(updated.batteryPct).toBe(42);
    expect(updated.createdAt).toBe(5);
    expect(updated.updatedAt).toBe(99);
  });

  it("rejects a registration carrying credential material", () => {
    expect(() =>
      normalizeDeviceRegistration({ serial: "NEW1", password: "x" } as never, { existing: [] }),
    ).toThrow(SecretMaterialError);
  });

  it("finds the first free slot rather than appending", () => {
    expect(nextFreeSlot([device({ slot: 1 }), device({ id: "dev-03", slot: 3 })])).toBe(2);
  });

  it("records the stable androidId and recovers it from a companion note", () => {
    const explicit = normalizeDeviceRegistration(
      { serial: "100.64.10.4:44961", androidId: "1D15C8A953857EF9", model: "vivo 1901" },
      { existing: [] },
    );
    expect(explicit.androidId).toBe("1d15c8a953857ef9");

    const fromNote = normalizeDeviceRegistration(
      {
        serial: "companion:x",
        notes: "Registered by companion. androidId=1d15c8a953857ef9 sdk=30",
      },
      { existing: [] },
    );
    expect(fromNote.androidId).toBe("1d15c8a953857ef9");
  });

  it("keeps an existing androidId when a re-registration omits one", () => {
    const existing = device({ androidId: "1d15c8a953857ef9" });
    const updated = normalizeDeviceRegistration(
      { id: "dev-01", serial: "100.64.10.4:52001" },
      { existing: [existing] },
    );
    expect(updated.androidId).toBe("1d15c8a953857ef9");
  });
});

describe("stable device identity", () => {
  it("normalises and validates an androidId", () => {
    expect(normalizeAndroidId("1D15C8A953857EF9")).toBe("1d15c8a953857ef9");
    expect(normalizeAndroidId("  1d15c8a953857ef9 ")).toBe("1d15c8a953857ef9");
    expect(normalizeAndroidId("not-hex!")).toBeNull();
    expect(normalizeAndroidId(null)).toBeNull();
  });

  it("recovers an androidId marker from companion notes", () => {
    expect(androidIdFromNotes("manufacturer=vivo androidId=1d15c8a953857ef9 sdk=30")).toBe(
      "1d15c8a953857ef9",
    );
    expect(androidIdFromNotes("no id here")).toBeNull();
  });

  it("treats two rows with the same androidId as the same handset", () => {
    expect(
      sameStableIdentity(
        { androidId: "1d15c8a953857ef9", serial: "100.64.10.4:44961" },
        { androidId: "1d15c8a953857ef9", serial: "100.64.10.4:5555" },
      ),
    ).toBe(true);
  });

  // Behaviour change, made deliberately: this used to assert that differing
  // ANDROID_IDs meant different handsets even on one IP. A real vivo proved
  // otherwise — re-signing the companion APK rotates ANDROID_ID — and the old
  // rule made that duplicate unmergeable. On a TAILNET address (unique per node)
  // the ids are now overruled.
  it("treats different androidIds on one TAILNET IP as the same handset", () => {
    expect(
      sameStableIdentity(
        { androidId: "aaaaaaaaaaaaaaaa", serial: "100.64.10.4:1", model: "vivo 1901" },
        { androidId: "bbbbbbbbbbbbbbbb", serial: "100.64.10.4:2", model: "vivo 1901" },
      ),
    ).toBe(true);
  });

  // A LAN address is DHCP-assigned and can be recycled between phones, so it is
  // never enough to overrule two distinct ANDROID_IDs.
  it("keeps different androidIds apart on a recyclable LAN IP", () => {
    expect(
      sameStableIdentity(
        { androidId: "aaaaaaaaaaaaaaaa", serial: "192.168.1.150:1", model: "vivo 1901" },
        { androidId: "bbbbbbbbbbbbbbbb", serial: "192.168.1.150:2", model: "vivo 1901" },
      ),
    ).toBe(false);
  });

  it("falls back to tailnet IP + model when an androidId is unknown", () => {
    // This is exactly the dev-01/dev-02 case: same phone, two serials, neither
    // row has the androidId column populated yet.
    expect(
      sameStableIdentity(
        { serial: "100.64.10.4:44961", model: "vivo 1901" },
        { serial: "100.64.10.4:5555", model: "vivo 1901" },
      ),
    ).toBe(true);
    // Different model on the same IP is not a match.
    expect(
      sameStableIdentity(
        { serial: "100.64.10.4:44961", model: "vivo 1901" },
        { serial: "100.64.10.4:5555", model: "Pixel 7" },
      ),
    ).toBe(false);
  });

  it("matches a reconnecting handset to its existing row by identity", () => {
    const existing = [
      device({
        id: "dev-01",
        serial: "100.64.10.4:5555",
        model: "vivo 1901",
        tailscaleIp: "100.64.10.4",
      }),
    ];
    const match = matchDeviceByIdentity(
      { serial: "100.64.10.4:44961", model: "vivo 1901" },
      existing,
    );
    expect(match?.id).toBe("dev-01");
  });
});

describe("account import", () => {
  const base = {
    handle: "@ops.shop",
    platform: "Instagram",
    recoveryEmail: "ops-shop@recovery.example.com",
  };

  it("normalises the handle and platform and derives a vault pointer", () => {
    const { account } = normalizeAccountImport(base);
    expect(account.handle).toBe("ops.shop");
    expect(account.platform).toBe("instagram");
    expect(account.secretRef).toBe("vault://android-ops/instagram/ops.shop");
    expect(account.lifecycle).toBe("provisioning");
  });

  it("requires a durable recovery mailbox", () => {
    expect(() => normalizeAccountImport({ ...base, recoveryEmail: "" })).toThrow(
      /recovery mailbox/,
    );
    expect(() => normalizeAccountImport({ ...base, recoveryEmail: "not-an-email" })).toThrow(
      /recovery mailbox/,
    );
  });

  it("rejects an unknown platform and a malformed handle", () => {
    expect(() => normalizeAccountImport({ ...base, platform: "myspace" })).toThrow(
      /Unknown platform/,
    );
    expect(() => normalizeAccountImport({ ...base, handle: "bad handle!" })).toThrow(
      /not a valid handle/,
    );
  });

  it("rejects a row carrying a password or recovery codes", () => {
    expect(() => normalizeAccountImport({ ...base, password: "hunter2" } as never)).toThrow(
      SecretMaterialError,
    );
    expect(() => normalizeAccountImport({ ...base, recoveryCodes: ["1", "2"] } as never)).toThrow(
      SecretMaterialError,
    );
  });

  it("flags an auto-assignment request instead of silently leaving it unassigned", () => {
    expect(normalizeAccountImport({ ...base, deviceId: "auto" }).autoAssign).toBe(true);
    expect(normalizeAccountImport({ ...base, deviceId: "dev-02" }).account.deviceId).toBe("dev-02");
  });

  it("keeps an existing account's id, creation history and assignment", () => {
    const existing = {
      id: "acct-legacy",
      deviceId: "dev-03",
      lastPostAt: 1234,
      provisionedAt: 10,
      secretRef: "vault://custom/path",
      displayName: "Ops Shop",
    } as unknown as SocialAccount;
    const { account } = normalizeAccountImport(base, { existing });
    expect(account.id).toBe("acct-legacy");
    expect(account.deviceId).toBe("dev-03");
    expect(account.lastPostAt).toBe(1234);
    expect(account.secretRef).toBe("vault://custom/path");
    expect(account.displayName).toBe("Ops Shop");
  });
});

describe("setup readiness", () => {
  const census = (over: Partial<StoreCensus> = {}): StoreCensus => ({
    devices: 0,
    accounts: 0,
    media: 0,
    jobs: 0,
    provisioning: 0,
    inbox: 0,
    empty: true,
    needsDevices: true,
    needsAccounts: true,
    needsMedia: true,
    demoSeedPresent: false,
    ...over,
  });

  it("marks the blocking steps outstanding on an empty install", () => {
    const steps = buildSetupSteps({
      census: census(),
      deviceAdapterAvailable: false,
      streamAdapterAvailable: false,
      storageAvailable: true,
      tailscaleAvailable: false,
      assignedAccounts: 0,
    });
    const blocking = steps.filter((s) => s.blocking);
    expect(blocking.length).toBeGreaterThan(0);
    expect(blocking.every((s) => !s.done)).toBe(true);
    expect(steps.find((s) => s.key === "devices")!.detail).toMatch(/register/i);
  });

  it("clears every blocking step once the rack is configured", () => {
    const steps = buildSetupSteps({
      census: census({
        devices: 4,
        accounts: 12,
        media: 3,
        empty: false,
        needsDevices: false,
        needsAccounts: false,
        needsMedia: false,
      }),
      deviceAdapterAvailable: true,
      streamAdapterAvailable: true,
      storageAvailable: true,
      tailscaleAvailable: true,
      assignedAccounts: 12,
    });
    expect(steps.filter((s) => s.blocking).every((s) => s.done)).toBe(true);
  });

  it("keeps the demo-rack step outstanding while seeded rows are present", () => {
    const steps = buildSetupSteps({
      census: census({ demoSeedPresent: true }),
      deviceAdapterAvailable: true,
      streamAdapterAvailable: true,
      storageAvailable: true,
      tailscaleAvailable: true,
      assignedAccounts: 0,
    });
    expect(steps.find((s) => s.key === "demo")!.done).toBe(false);
  });

  it("recognises seeded demo accounts", () => {
    expect(
      looksLikeDemoData({ accounts: [{ handle: "demo.shop", secretRef: "" }], devices: [] }),
    ).toBe(true);
    expect(
      looksLikeDemoData({
        accounts: [{ handle: "ops.shop", secretRef: "vault://android-ops/instagram/ops.shop" }],
        devices: [],
      }),
    ).toBe(false);
  });
});

describe("fly config detection", () => {
  it("reports the app and region from a fly.toml on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "android-ops-fly-"));
    try {
      writeFileSync(
        join(dir, "fly.toml"),
        'app = "android-ops-dash"\nprimary_region = "iad"\n',
        "utf8",
      );
      const fly = await detectFlyConfig([dir]);
      expect(fly.configured).toBe(true);
      expect(fly.appName).toBe("android-ops-dash");
      expect(fly.primaryRegion).toBe("iad");
      expect(fly.configPath).toBe(join(dir, "fly.toml"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Regression: one physical vivo was recorded twice because the two rows
  // carried DIFFERENT ANDROID_IDs. That value is derived per app-signing-key, so
  // re-signing or reinstalling the companion APK mints a fresh one — and the
  // matcher used to short-circuit to "different handset" the moment both ids
  // were present and unequal, never reaching the tailnet-IP fallback.
  it("still matches one handset whose ANDROID_ID rotated after an APK re-sign", () => {
    const rotated = {
      androidId: "1d15c8a953857ef9",
      tailscaleIp: "100.64.10.4",
      model: "vivo vivo 1901",
      serial: "100.64.10.4:5555",
    };
    const known = {
      androidId: "ffa6d8017a40cfca",
      tailscaleIp: "100.64.10.4",
      model: "vivo vivo 1901",
      serial: "100.64.10.4:44961",
    };
    expect(sameStableIdentity(rotated, known)).toBe(true);
  });

  // Regression: adb says "S1", the companion APK says "true S1" (manufacturer +
  // model). Comparing those exactly split one handset in two — the live endpoint
  // was adopted as "Phone 03" while the real row went stale.
  it("matches adb's bare model against the APK's manufacturer-prefixed one", () => {
    expect(
      sameStableIdentity(
        { tailscaleIp: "100.64.10.2", model: "S1", serial: "100.64.10.2:33989" },
        { tailscaleIp: "100.64.10.2", model: "true S1", serial: "100.64.10.2:5555" },
      ),
    ).toBe(true);
  });

  it("still separates two handsets that merely share a model", () => {
    const a = {
      androidId: "aaaa1111",
      tailscaleIp: "100.64.10.4",
      model: "vivo vivo 1901",
      serial: "100.64.10.4:5555",
    };
    const b = {
      androidId: "bbbb2222",
      tailscaleIp: "100.64.10.2",
      model: "vivo vivo 1901",
      serial: "100.64.10.2:5555",
    };
    expect(sameStableIdentity(a, b)).toBe(false);
  });

  it("matches a re-registering handset against the existing roster", () => {
    const existing = [
      {
        id: "dev-01",
        androidId: "ffa6d8017a40cfca",
        tailscaleIp: "100.64.10.4",
        model: "vivo vivo 1901",
        serial: "100.64.10.4:44961",
      },
      {
        id: "dev-02",
        androidId: "27c10f8aa0c4685c",
        tailscaleIp: "100.64.10.2",
        model: "true S1",
        serial: "100.64.10.2:5555",
      },
    ] as unknown as PhoneDevice[];
    const hit = matchDeviceByIdentity(
      {
        androidId: "1d15c8a953857ef9",
        tailscaleIp: "100.64.10.4",
        model: "vivo vivo 1901",
        serial: "100.64.10.4:5555",
      },
      existing,
    );
    expect(hit?.id).toBe("dev-01");
  });

  it("says so plainly when there is no deploy config, and never returns a token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "android-ops-nofly-"));
    try {
      const fly = await detectFlyConfig([dir]);
      expect(fly.configured).toBe(false);
      expect(fly.appName).toBeNull();
      expect(fly.reason).toMatch(/no fly\.toml/);
      // Presence only — the value is never read into the payload.
      expect(typeof fly.tokenPresent).toBe("boolean");
      expect(JSON.stringify(fly)).not.toContain(process.env.FLY_API_TOKEN ?? " never");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
