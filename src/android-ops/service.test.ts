/**
 * End-to-end vertical slice against a real SQLite store in a temp dir, with
 * no-device adapters attached — i.e. exactly the situation a fresh install is
 * in. Proves the operator loop works without hardware and that the compliance
 * guards hold at the service boundary, not just inside the state machine.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AndroidOpsStore } from "./store.js";
import { AndroidOpsService } from "./service.js";
import { seedAndroidOps } from "./seed.js";
import { NullDeviceAdapter, NullStreamAdapter } from "./adapters/null-device.js";
import { LocalStorageAdapter } from "./adapters/storage.js";
import { ComplianceViolationError } from "./compliance.js";
import type { AdapterSet } from "./adapters/types.js";
import { revealSecret } from "./secrets.js";

let dir: string;
let store: AndroidOpsStore;
let service: AndroidOpsService;

function nullAdapters(root: string): AdapterSet {
  return {
    device: new NullDeviceAdapter(),
    stream: new NullStreamAdapter(),
    storage: new LocalStorageAdapter(join(root, "media")),
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "android-ops-"));
  store = new AndroidOpsStore(dir);
  seedAndroidOps(store);
  service = new AndroidOpsService(store, nullAdapters(dir));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the V1 seed rack", () => {
  it("provisions 4 active handsets plus a configured spare", () => {
    const devices = store.listDevices();
    expect(devices.filter((d) => !d.isSpare)).toHaveLength(4);
    expect(devices.filter((d) => d.isSpare)).toHaveLength(1);
  });

  it("provisions 12 accounts at 3 per handset", () => {
    const accounts = store.listAccounts();
    expect(accounts).toHaveLength(12);
    for (const device of store.listDevices().filter((d) => !d.isSpare)) {
      expect(accounts.filter((a) => a.deviceId === device.id)).toHaveLength(3);
    }
  });

  it("gives every account a durable recovery path and a vault reference, never a secret", () => {
    for (const account of store.listAccounts()) {
      expect(account.recoveryEmail).toMatch(/@/);
      expect(account.secretRef.startsWith("vault://")).toBe(true);
      // The record carries a pointer and a boolean — never a credential value.
      expect(Object.keys(account)).not.toContain("password");
      expect(Object.keys(account)).not.toContain("totp");
      expect(Object.keys(account)).not.toContain("recoveryCodes");
    }
  });

  it("exercises every pipeline state so the UI has real data to render", () => {
    const states = new Set(store.listJobs({ limit: 500 }).map((j) => j.state));
    for (const s of [
      "DRAFT",
      "SCHEDULED",
      "DISPATCHED",
      "PREPARED",
      "ACTION_REQUIRED",
      "POSTED",
      "FAILED",
    ]) {
      expect(states).toContain(s);
    }
  });
});

describe("dashboard", () => {
  it("summarises the rack, the accounts and the queue in one payload", () => {
    const d = service.dashboard();
    expect(d.devices.total).toBe(4);
    expect(d.accounts.total).toBe(12);
    expect(d.jobs.actionRequired).toBeGreaterThan(0);
    expect(d.loads.filter((l) => !l.eligible).length).toBeGreaterThan(0);
    expect(d.workload).toHaveLength(7);
  });

  it("surfaces ACTION REQUIRED work at the top of the urgent list", () => {
    const urgent = service.dashboard().urgent;
    expect(urgent.length).toBeGreaterThan(0);
    expect(urgent[0].severity).toBe("critical");
    expect(urgent.some((u) => u.kind === "job")).toBe(true);
    expect(urgent.some((u) => u.kind === "provisioning")).toBe(true);
  });
});

describe("scheduling", () => {
  it("staggers a multi-account schedule and audits every job", () => {
    const media = store.listMedia().find((m) => m.platforms.includes("instagram"))!;
    const targets = store
      .listAccounts()
      .filter((a) => a.platform === "instagram")
      .slice(0, 3);
    const at = Date.now() + 3_600_000;

    const { jobs, shifted } = service.scheduleContent({
      mediaId: media.id,
      accountIds: targets.map((a) => a.id),
      startAt: at,
      actor: "operator:demo",
    });

    expect(jobs).toHaveLength(3);
    expect(shifted).toBeGreaterThan(0);
    const times = jobs.map((j) => j.scheduledFor).sort((a, b) => a - b);
    expect(times[0]).toBeGreaterThanOrEqual(at);
    expect(new Set(times).size).toBe(3);

    for (const job of jobs) {
      expect(store.listAudit({ targetType: "job", targetId: job.id }).length).toBeGreaterThan(0);
    }
  });

  it("refuses to schedule an asset to a platform it isn't cleared for", () => {
    const igOnly = store.listMedia().find((m) => !m.platforms.includes("youtube"))!;
    const yt = store.listAccounts().find((a) => a.platform === "youtube")!;
    expect(() =>
      service.scheduleContent({
        mediaId: igOnly.id,
        accountIds: [yt.id],
        startAt: Date.now(),
        actor: "operator:demo",
      }),
    ).toThrow(/not cleared for/);
  });

  it("refuses to schedule an account with no assigned handset", () => {
    const account = store.listAccounts()[0];
    store.upsertAccount({ ...account, deviceId: null });
    const media = store.listMedia().find((m) => m.platforms.includes(account.platform))!;
    expect(() =>
      service.scheduleContent({
        mediaId: media.id,
        accountIds: [account.id],
        startAt: Date.now(),
        actor: "operator:demo",
      }),
    ).toThrow(/no assigned handset/);
  });
});

describe("pipeline execution", () => {
  it("pauses the live pipeline instead of failing jobs when no rack is attached", async () => {
    const result = await service.tick({ actor: "scheduler" });
    expect(result.mode).toBe("live");
    expect(result.paused).toMatch(/paused/);
    expect(result.moved).toHaveLength(0);
  });

  it("advances due jobs in simulated mode so the loop is usable without hardware", async () => {
    const result = await service.tick({ actor: "operator:demo", simulate: true });
    expect(result.mode).toBe("simulated");
    expect(result.moved.length).toBeGreaterThan(0);
    for (const m of result.moved) expect(m.from).not.toBe(m.to);
  });

  it("is deterministic — the same rack ticks the same way twice", async () => {
    const a = await service.tick({ simulate: true, now: 1_800_000_000_000 });

    const dir2 = mkdtempSync(join(tmpdir(), "android-ops-b-"));
    const store2 = new AndroidOpsStore(dir2);
    seedAndroidOps(store2);
    const service2 = new AndroidOpsService(store2, nullAdapters(dir2));
    const b = await service2.tick({ simulate: true, now: 1_800_000_000_000 });
    store2.close();
    rmSync(dir2, { recursive: true, force: true });

    expect(a.moved.map((m) => `${m.from}>${m.to}`).sort()).toEqual(
      b.moved.map((m) => `${m.from}>${m.to}`).sort(),
    );
  });

  it("marks the account's lastPostAt when a job reaches POSTED", () => {
    const job = store.listJobs({ states: ["PREPARED"] })[0];
    service.advanceJob(job.id, "POSTED", {
      actor: "operator:demo",
      permalink: "https://example.com/p/x",
    });
    expect(store.getAccount(job.accountId)!.lastPostAt).toBeGreaterThan(0);
  });

  it("raises a critical alert when a job burns its last retry", () => {
    const job = store.listJobs({ states: ["PREPARED"] })[0];
    store.upsertJob({ ...job, attempt: 3, maxAttempts: 3 });
    service.advanceJob(job.id, "FAILED", { actor: "scheduler", error: "final failure" });
    expect(store.listAlerts(true).some((a) => a.kind === "job_retries_exhausted")).toBe(true);
  });
});

describe("compliance boundary", () => {
  it("will not let an automated actor clear a human checkpoint", () => {
    const parked = store.listJobs({ states: ["ACTION_REQUIRED"] })[0];
    expect(() => service.resolveActionRequired(parked.id, "scheduler")).toThrow(
      ComplianceViolationError,
    );
    expect(() => service.resolveActionRequired(parked.id, "simulator")).toThrow(
      ComplianceViolationError,
    );
    expect(store.getJob(parked.id)!.state).toBe("ACTION_REQUIRED");
  });

  it("lets a named operator clear it, resuming where the job left off", () => {
    const parked = store.listJobs({ states: ["ACTION_REQUIRED"] })[0];
    const resumed = service.resolveActionRequired(parked.id, "operator:demo");
    expect(resumed.state).toBe("DISPATCHED");
    expect(resumed.actionRequired?.resolvedBy).toBe("operator:demo");
    expect(
      store
        .listAudit({ targetType: "job", targetId: parked.id })
        .some((a) => a.action === "job.checkpoint.cleared"),
    ).toBe(true);
  });

  it("will not let a secret be written through the account API", () => {
    const account = store.listAccounts()[0];
    service.updateAccount(
      account.id,
      { secretRef: "hunter2", displayName: "Renamed" } as never,
      "operator:demo",
    );
    const after = store.getAccount(account.id)!;
    expect(after.displayName).toBe("Renamed");
    expect(after.secretRef).toBe(account.secretRef);
  });

  it("refuses to auto-complete a human provisioning step", () => {
    const run = service.startProvisioning({
      handle: "demo.newshop",
      platform: "tiktok",
      actor: "operator:demo",
    });
    expect(() =>
      service.advanceProvisioningStep(run.id, {
        stepKey: "verification",
        status: "done",
        actor: "system",
      }),
    ).toThrow(ComplianceViolationError);
  });
});

describe("provisioning", () => {
  // Rewritten deliberately. This used to assert that "password" and
  // "recovery_email" were done the moment a run started — they were flipped
  // green while nothing wrote to a vault or provisioned a mailbox, so the board
  // reported credential work that had not happened.
  it("only marks the prefix steps whose work actually ran", () => {
    const run = service.startProvisioning({
      handle: "demo.newshop",
      platform: "tiktok",
      actor: "operator:demo",
    });
    const status = (key: string) => run.steps.find((s) => s.key === key)!.status;
    // the row really is written at start, so this one is true
    expect(status("record")).toBe("done");
    expect(store.getAccount(run.accountId)?.handle).toBe("demo.newshop");
    // the password IS vaulted now, so this step is earned rather than assumed
    expect(status("password")).toBe("done");
    expect(run.steps.find((s) => s.key === "password")!.note).toMatch(
      /encrypted into the secret store/i,
    );
    // no domain was supplied, so the mailbox step stays honest
    expect(status("recovery_email")).toBe("pending");
    expect(run.steps.find((s) => s.key === "verification")!.mode).toBe("human");
  });

  it("claims the mailbox only when a catch-all domain is configured", () => {
    const run = service.startProvisioning({
      handle: "demo.shop",
      platform: "tiktok",
      actor: "operator:demo",
      recoveryDomain: "ops.example.com",
    });
    expect(run.steps.find((s) => s.key === "recovery_email")!.status).toBe("done");
    expect(store.getAccount(run.accountId)?.recoveryEmail).toBe("demo.shop@ops.example.com");
  });

  it("opens the account in provisioning lifecycle, asserting no 2FA or session yet", () => {
    const run = service.startProvisioning({
      handle: "demo.fresh",
      platform: "tiktok",
      actor: "operator:demo",
    });
    const acct = store.getAccount(run.accountId)!;
    expect(acct.lifecycle).toBe("provisioning");
    expect(acct.twoFactorEnabled).toBe(false);
    expect(acct.recoveryCodesVaulted).toBe(false);
    // a reference, never the credential itself
    expect(acct.secretRef).toBe("vault://android-ops/tiktok/demo.fresh");
  });

  // The whole point of a reference is that the value stays out of everything
  // that gets serialised, queried or rendered.
  it("keeps the generated password out of the run, the row and the store dump", () => {
    const run = service.startProvisioning({
      handle: "demo.leak",
      platform: "tiktok",
      actor: "operator:demo",
    });
    const secret = revealSecret(store.stateDir, "vault://android-ops/tiktok/demo.leak");
    expect(secret).toBeTruthy();
    expect(secret!.length).toBeGreaterThanOrEqual(16);
    const exposed = JSON.stringify({
      run,
      account: store.getAccount(run.accountId),
      accounts: store.listAccounts(),
      audit: store.listAudit({}),
    });
    expect(exposed).not.toContain(secret!);
  });

  it("creates a real account record once every step is cleared by an operator", () => {
    let run = service.startProvisioning({
      handle: "demo.newshop",
      platform: "tiktok",
      actor: "operator:demo",
    });
    for (const step of run.steps) {
      if (step.status === "done") continue;
      run = service.advanceProvisioningStep(run.id, {
        stepKey: step.key,
        status: "done",
        actor: "operator:demo",
      });
    }
    expect(run.state).toBe("completed");
    const created = store.getAccount(run.accountId)!;
    expect(created.handle).toBe("demo.newshop");
    expect(created.twoFactorEnabled).toBe(true);
    expect(created.recoveryCodesVaulted).toBe(true);
  });
});

describe("account profile, credentials and status", () => {
  it("edits the profile copy the workflow will type in", () => {
    const account = store.listAccounts()[0];
    const next = service.editAccountProfile(
      account.id,
      { displayName: "Morpheus Studio", bio: "Daily builds.", avatarRef: "media-01" },
      "operator:demo",
    );
    expect(next.displayName).toBe("Morpheus Studio");
    expect(next.bio).toBe("Daily builds.");
    expect(next.avatarRef).toBe("media-01");
  });

  it("stores a password by reference and never in the row", () => {
    const account = store.listAccounts()[0];
    const next = service.setAccountPassword(account.id, "hunter2-but-longer", "operator:demo");
    expect(next.secretRef).toMatch(/^vault:\/\/android-ops\//);
    expect(JSON.stringify(store.getAccount(account.id))).not.toContain("hunter2-but-longer");
    // and it round-trips for an operator who has to type it into a handset
    expect(service.revealAccountPassword(account.id, "operator:demo").secret).toBe(
      "hunter2-but-longer",
    );
    expect(
      store
        .listAudit({ targetType: "account", targetId: account.id })
        .some((a) => a.action === "account.password.reveal"),
    ).toBe(true);
  });

  it("generates one when the operator supplies nothing", () => {
    const account = store.listAccounts()[1];
    service.setAccountPassword(account.id, null, "operator:demo");
    const revealed = service.revealAccountPassword(account.id, "operator:demo").secret;
    expect(revealed.length).toBeGreaterThanOrEqual(16);
  });

  it("treats logging in as implying signed up, and never the reverse", () => {
    const account = store.listAccounts()[2];
    const loggedIn = service.setAccountStatus(account.id, { loggedIn: true }, "operator:demo");
    expect(loggedIn.loggedInAt).toBeTruthy();
    expect(loggedIn.signedUpAt).toBeTruthy();
    expect(loggedIn.sessionHealth).toBe("healthy");
    const out = service.setAccountStatus(account.id, { loggedIn: false }, "operator:demo");
    expect(out.loggedInAt).toBeNull();
    expect(out.signedUpAt).toBeTruthy();
    expect(out.sessionHealth).toBe("logged_out");
  });
});

describe("workflow drives account status", () => {
  it("marks the account signed up when the signup step clears, and logged in on completion", () => {
    let run = service.startProvisioning({
      handle: "flow.acct",
      platform: "tiktok",
      actor: "operator:demo",
    });
    expect(store.getAccount(run.accountId)!.signedUpAt).toBeNull();
    run = service.advanceProvisioningStep(run.id, {
      stepKey: "signup",
      status: "done",
      actor: "operator:demo",
    });
    expect(store.getAccount(run.accountId)!.signedUpAt).toBeTruthy();
    expect(store.getAccount(run.accountId)!.loggedInAt).toBeNull();
    for (const step of run.steps) {
      if (step.status === "done") continue;
      run = service.advanceProvisioningStep(run.id, {
        stepKey: step.key,
        status: "done",
        actor: "operator:demo",
      });
    }
    expect(run.state).toBe("completed");
    expect(store.getAccount(run.accountId)!.loggedInAt).toBeTruthy();
  });

  it("does not blank the profile copy when a run completes", () => {
    let run = service.startProvisioning({
      handle: "keepme.acct",
      platform: "tiktok",
      actor: "operator:demo",
    });
    service.editAccountProfile(
      run.accountId,
      { bio: "keep this", avatarRef: "media-77" },
      "operator:demo",
    );
    for (const step of run.steps) {
      if (step.status === "done") continue;
      run = service.advanceProvisioningStep(run.id, {
        stepKey: step.key,
        status: "done",
        actor: "operator:demo",
      });
    }
    const acct = store.getAccount(run.accountId)!;
    expect(acct.bio).toBe("keep this");
    expect(acct.avatarRef).toBe("media-77");
  });
});

describe("renaming an account", () => {
  // The editor used to lock the username on the reasoning that the handle is
  // the account identity. It is — it derives the vault reference — but a
  // platform routinely refuses the handle you reserved, so the console has to be
  // able to record the variant you actually took.
  it("moves the vaulted password to the new reference", () => {
    const account = store.listAccounts()[0];
    service.setAccountPassword(account.id, "keep-this-password", "operator:demo");
    const before = store.getAccount(account.id)!.secretRef;
    const renamed = service.renameAccount(account.id, "taken.variant2", "operator:demo");
    expect(renamed.handle).toBe("taken.variant2");
    expect(renamed.secretRef).not.toBe(before);
    expect(renamed.secretRef).toContain("taken.variant2");
    // the credential survives the move rather than being orphaned
    expect(service.revealAccountPassword(account.id, "operator:demo").secret).toBe(
      "keep-this-password",
    );
  });

  it("refuses a handle already used on that platform", () => {
    // build the collision rather than hoping the fixture has two accounts on
    // one platform — it has one each
    const target = store.listAccounts()[0];
    const run = service.startProvisioning({
      handle: "sibling.acct",
      platform: target.platform,
      actor: "operator:demo",
    });
    expect(store.getAccount(run.accountId)!.platform).toBe(target.platform);
    expect(() => service.renameAccount(target.id, "sibling.acct", "operator:demo")).toThrow(
      /already exists/i,
    );
    expect(store.getAccount(target.id)!.handle).toBe(target.handle);
  });

  it("refuses characters a platform would not accept", () => {
    const account = store.listAccounts()[0];
    expect(() => service.renameAccount(account.id, "bad handle!", "operator:demo")).toThrow(
      /letters, numbers/i,
    );
  });

  it("audits the rename", () => {
    const account = store.listAccounts()[2];
    service.renameAccount(account.id, "audited.rename", "operator:demo");
    expect(
      store
        .listAudit({ targetType: "account", targetId: account.id })
        .some((x) => x.action === "account.rename"),
    ).toBe(true);
  });
});

describe("signing up an existing account", () => {
  // The roster's Sign up button runs setup for a row the operator has already
  // authored. Using the generic start path would mint a SECOND account and
  // strand the handle, bio, photo and password on the first.
  it("binds the run to that account instead of creating another", () => {
    const before = store.listAccounts().length;
    const account = store.listAccounts()[0];
    service.editAccountProfile(account.id, { bio: "authored here" }, "operator:demo");
    const run = service.startProvisioning({
      handle: account.handle,
      platform: account.platform,
      actor: "operator:demo",
      accountId: account.id,
    });
    expect(run.accountId).toBe(account.id);
    expect(store.listAccounts().length).toBe(before);
    expect(store.getAccount(account.id)!.bio).toBe("authored here");
  });

  it("refuses a second run while one is already in progress", () => {
    const account = store.listAccounts()[1];
    service.startProvisioning({
      handle: account.handle,
      platform: account.platform,
      actor: "operator:demo",
      accountId: account.id,
    });
    expect(() =>
      service.startProvisioning({
        handle: account.handle,
        platform: account.platform,
        actor: "operator:demo",
        accountId: account.id,
      }),
    ).toThrow(/already has a setup run/i);
  });

  it("keeps the account's own vault reference rather than deriving a fresh one", () => {
    const account = store.listAccounts()[2];
    service.setAccountPassword(account.id, "already-chosen-pass", "operator:demo");
    const ref = store.getAccount(account.id)!.secretRef;
    service.startProvisioning({
      handle: account.handle,
      platform: account.platform,
      actor: "operator:demo",
      accountId: account.id,
    });
    expect(store.getAccount(account.id)!.secretRef).toBe(ref);
    expect(service.revealAccountPassword(account.id, "operator:demo").secret).toBe(
      "already-chosen-pass",
    );
  });
});

describe("AI-driven steps", () => {
  // The model is consulted inside the guardrails, never instead of them.
  it("halts on a blocker without ever asking the model", async () => {
    const account = store.listAccounts()[0];
    const run = service.startProvisioning({
      handle: account.handle,
      platform: account.platform,
      actor: "operator:demo",
      accountId: account.id,
    });
    let asked = 0;
    // the null adapter cannot dump a screen, so this also proves the loop
    // surfaces a device failure instead of pretending it drove something
    await expect(
      service.aiDriveRunStep(run.id, "operator:demo", {
        ask: async () => {
          asked += 1;
          return '{"action":"done","why":"x"}';
        },
      }),
    ).rejects.toThrow();
    expect(asked).toBe(0);
  });

  it("refuses to drive a human checkpoint", async () => {
    const account = store.listAccounts()[1];
    let run = service.startProvisioning({
      handle: account.handle,
      platform: account.platform,
      actor: "operator:demo",
      accountId: account.id,
    });
    for (const step of run.steps) {
      if (step.status === "done" || step.key === "verification") continue;
      if (step.key === "signup" || step.key === "profile") {
        run = service.advanceProvisioningStep(run.id, {
          stepKey: step.key,
          status: "done",
          actor: "operator:demo",
        });
      }
    }
    const current = run.steps.find((s) => s.status !== "done" && s.status !== "skipped");
    if (current?.mode === "human") {
      await expect(
        service.aiDriveRunStep(run.id, "operator:demo", { ask: async () => "{}" }),
      ).rejects.toThrow(/human checkpoint/i);
    }
  });
});

describe("assignment stability", () => {
  // The roster offers "no phone"; before this, "none" threw Unknown device and
  // an empty value silently auto-assigned, so an account could never be freed.
  it("unpairs an account when asked for no phone", () => {
    const account = store.listAccounts()[0];
    service.assignAccount(account.id, "auto", "operator:demo");
    expect(store.getAccount(account.id)!.deviceId).toBeTruthy();
    const result = service.assignAccount(account.id, "none", "operator:demo");
    expect(result.device).toBeNull();
    expect(store.getAccount(account.id)!.deviceId).toBeNull();
    expect(
      store
        .listAudit({ targetType: "account", targetId: account.id })
        .some((a) => /unpaired/i.test(a.summary)),
    ).toBe(true);
  });

  it("audits a re-assignment loudly because it costs the trusted-device history", () => {
    const account = store.listAccounts().find((a) => a.deviceId === "dev-01")!;
    service.assignAccount(account.id, "dev-04", "operator:demo");
    const entry = store.listAudit({ targetType: "account", targetId: account.id })[0];
    expect(entry.summary).toMatch(/trusted-device history/);
  });

  it("keeps an existing account on its handset when re-assigned to itself", () => {
    // Re-assignment must not count the account against its own device's
    // capacity, otherwise a full-but-valid rack could never be touched.
    const account = store.listAccounts().find((a) => a.deviceId === "dev-01")!;
    expect(service.assignAccount(account.id, "auto", "operator:demo").device.id).toBe("dev-01");
  });

  it("reports why a thirteenth account cannot be auto-assigned into a full rack", () => {
    const now = Date.now();
    store.upsertAccount({
      id: "acct-13",
      handle: "demo.overflow",
      platform: "instagram",
      displayName: "Overflow",
      deviceId: null,
      lifecycle: "provisioning",
      sessionHealth: "unknown",
      twoFactorEnabled: false,
      twoFactorMethod: "none",
      recoveryEmail: "demo-overflow@recovery.example-ops.com",
      recoveryCodesVaulted: false,
      secretRef: "vault://android-ops/demo/instagram/demo.overflow",
      lastPostAt: null,
      recoveryNotes: null,
      provisionedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    expect(() => service.assignAccount("acct-13", "auto", "operator:demo")).toThrow(
      /no eligible handset/,
    );
  });
});

describe("no-device behaviour", () => {
  it("returns a placeholder session with a paste-able hint rather than throwing", async () => {
    const session = await service.openStream("dev-01", "operator:demo");
    expect(session.ok).toBe(false);
    expect(session.reason).toMatch(/scrcpy/i);
  });

  it("reports adapters as unavailable with an operator-readable reason", async () => {
    const status = await service.adapterSnapshot(true);
    expect(status.device.available).toBe(false);
    expect(status.device.reason).toBeTruthy();
    expect(status.storage.available).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A real install starts empty. These run against their own store rather than
// the seeded one above, because the whole point is that nothing was written.
// ─────────────────────────────────────────────────────────────────────────────

describe("a fresh, unseeded install", () => {
  let emptyDir: string;
  let emptyStore: AndroidOpsStore;
  let emptyService: AndroidOpsService;

  beforeEach(() => {
    emptyDir = mkdtempSync(join(tmpdir(), "android-ops-empty-"));
    emptyStore = new AndroidOpsStore(emptyDir);
    emptyService = new AndroidOpsService(emptyStore, nullAdapters(emptyDir));
  });

  afterEach(() => {
    emptyStore.close();
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it("does not seed demo data just because the store is empty", async () => {
    const previous = process.env.INFINIBOT_STATE_DIR;
    process.env.INFINIBOT_STATE_DIR = emptyDir;
    try {
      const created = await AndroidOpsService.create(emptyStore);
      expect(created.store.count("ao_devices")).toBe(0);
      expect(created.store.count("ao_accounts")).toBe(0);
      expect(created.store.count("ao_jobs")).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.INFINIBOT_STATE_DIR;
      else process.env.INFINIBOT_STATE_DIR = previous;
    }
  });

  it("reports an empty census with no demo rows", () => {
    const census = emptyService.census();
    expect(census.empty).toBe(true);
    expect(census.needsDevices).toBe(true);
    expect(census.needsAccounts).toBe(true);
    expect(census.demoSeedPresent).toBe(false);
  });

  it("renders a dashboard rather than throwing on zero rows", () => {
    const summary = emptyService.dashboard();
    expect(summary.devices.total).toBe(0);
    expect(summary.accounts.total).toBe(0);
    expect(summary.urgent).toEqual([]);
  });

  it("hands a standalone dashboard the setup checklist it needs", async () => {
    const status = await emptyService.setupStatus();
    expect(status.ready).toBe(false);
    expect(status.census.empty).toBe(true);
    expect(status.steps.some((s) => s.key === "devices" && !s.done)).toBe(true);
    // Presence flags only — adapters, tailnet and deploy config, no secrets.
    expect(status.adapters.device.available).toBe(false);
    expect(typeof status.fly.configured).toBe("boolean");
    expect(typeof status.fly.tokenPresent).toBe("boolean");
    expect(status.storageBackend).toBe("local");
  });

  it("registers a handset from form data and audits it", () => {
    const device = emptyService.registerDevice(
      { serial: "9B021FFAZ00A01", model: "Pixel 4a" },
      "operator:demo",
    );
    expect(device.id).toBe("dev-01");
    expect(device.slot).toBe(1);
    // Registration is a claim about existence, not about health.
    expect(device.status).toBe("offline");
    expect(emptyStore.listDevices()).toHaveLength(1);
    expect(emptyStore.listAudit({ targetType: "device", targetId: device.id })[0].action).toBe(
      "device.register",
    );
  });

  it("refuses to register the same handset twice", () => {
    emptyService.registerDevice({ serial: "SERIAL-A" }, "operator:demo");
    expect(() => emptyService.registerDevice({ serial: "SERIAL-A" }, "operator:demo")).toThrow(
      /already registered/,
    );
    expect(emptyStore.listDevices()).toHaveLength(1);
  });

  it("imports a roster, assigns it, and re-running the same sheet updates rather than duplicates", () => {
    emptyService.registerDevice({ serial: "SERIAL-A" }, "operator:demo");
    const roster = [
      {
        handle: "ops.shop",
        platform: "instagram",
        recoveryEmail: "ops-shop@recovery.example.com",
        deviceId: "auto",
      },
      {
        handle: "ops.clips",
        platform: "tiktok",
        recoveryEmail: "ops-clips@recovery.example.com",
        deviceId: "auto",
      },
    ];

    const first = emptyService.importAccounts(roster, "operator:demo");
    expect(first.created).toHaveLength(2);
    expect(first.rejected).toEqual([]);
    // The handset has never answered a probe, so auto-assignment declines and
    // says so rather than pinning accounts to a phone that may not exist.
    expect(first.unassigned).toHaveLength(2);
    expect(first.unassigned[0].reason).toMatch(/no eligible handset/i);
    expect(first.created.every((a) => a.deviceId === null)).toBe(true);

    const again = emptyService.importAccounts(roster, "operator:demo");
    expect(again.created).toHaveLength(0);
    expect(again.updated).toHaveLength(2);
    expect(emptyStore.listAccounts()).toHaveLength(2);
  });

  it("auto-assigns onto a handset once it has actually reported in", () => {
    emptyService.registerDevice({ serial: "SERIAL-A" }, "operator:demo");
    // Only a probe may promote a device to online; simulate that having happened.
    emptyService.updateDevice(
      "dev-01",
      { status: "online", storageFreeMb: 32_000, adbState: "device" },
      "operator:demo",
    );
    const result = emptyService.importAccounts(
      [
        {
          handle: "ops.shop",
          platform: "instagram",
          recoveryEmail: "ops-shop@recovery.example.com",
          deviceId: "auto",
        },
      ],
      "operator:demo",
    );
    expect(result.unassigned).toEqual([]);
    expect(result.created[0].deviceId).toBe("dev-01");
  });

  it("rejects only the offending row when an import carries a credential", () => {
    emptyService.registerDevice({ serial: "SERIAL-A" }, "operator:demo");
    const result = emptyService.importAccounts(
      [
        {
          handle: "ops.shop",
          platform: "instagram",
          recoveryEmail: "ops-shop@recovery.example.com",
        },
        {
          handle: "ops.leak",
          platform: "instagram",
          recoveryEmail: "ops-leak@recovery.example.com",
          password: "hunter2",
        } as never,
        { handle: "ops.nomail", platform: "instagram" },
      ],
      "operator:demo",
    );

    expect(result.created).toHaveLength(1);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected[0].reason).toMatch(/Credential values must never be sent/);
    expect(result.rejected[0].reason).not.toContain("hunter2");
    expect(result.rejected[1].reason).toMatch(/recovery mailbox/);
    // Nothing from a rejected row reached the database.
    expect(emptyStore.getAccountByHandle("instagram", "ops.leak")).toBeNull();
    expect(JSON.stringify(emptyService.listAccountsPublic())).not.toContain("hunter2");
  });

  it("hands back accounts with the vault pointer flagged and no credential fields", () => {
    emptyService.registerDevice({ serial: "SERIAL-A" }, "operator:demo");
    emptyService.importAccounts(
      [
        {
          handle: "ops.shop",
          platform: "instagram",
          recoveryEmail: "ops-shop@recovery.example.com",
        },
      ],
      "operator:demo",
    );
    const [account] = emptyService.listAccountsPublic();
    expect(account.secretRefPresent).toBe(true);
    expect(account.secretRefScheme).toBe("vault");
    for (const key of ["password", "totp", "recoveryCodes", "sessionToken"]) {
      expect(Object.keys(account)).not.toContain(key);
    }
  });

  it("archives a handset without losing it, and refuses to delete one that is still in use", () => {
    emptyService.registerDevice({ serial: "SERIAL-A" }, "operator:demo");
    emptyService.importAccounts(
      [
        {
          handle: "ops.shop",
          platform: "instagram",
          recoveryEmail: "ops-shop@recovery.example.com",
          deviceId: "dev-01",
        },
      ],
      "operator:demo",
    );

    const archived = emptyService.removeDevice("dev-01", "operator:demo", {
      reason: "screen died",
    });
    expect(archived.mode).toBe("archive");
    expect(archived.device!.status).toBe("maintenance");
    expect(archived.device!.updateChannel).toBe("held");
    expect(archived.device!.notes).toMatch(/archived/);
    expect(archived.assignedAccounts).toBe(1);
    expect(emptyStore.getDevice("dev-01")).not.toBeNull();

    expect(() => emptyService.removeDevice("dev-01", "operator:demo", { mode: "delete" })).toThrow(
      /still holds 1 account/,
    );
  });

  it("deletes a handset once nothing points at it", () => {
    emptyService.registerDevice({ serial: "SERIAL-A" }, "operator:demo");
    const result = emptyService.removeDevice("dev-01", "operator:demo", { mode: "delete" });
    expect(result.device).toBeNull();
    expect(emptyStore.getDevice("dev-01")).toBeNull();
    expect(emptyStore.listAudit({ targetType: "device", targetId: "dev-01" })[0].action).toBe(
      "device.delete",
    );
  });

  it("reports why nothing could be probed when there is no toolchain", async () => {
    const result = await emptyService.refreshFleet("operator:demo");
    expect(result.adopted).toEqual([]);
    expect(result.matched).toBe(0);
    expect(result.reason).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stable-identity registration: a reconnecting handset (whose wireless-debugging
// serial changes on every re-pair) must update its existing row, never insert a
// duplicate that leaves the old row rotting offline.
// ─────────────────────────────────────────────────────────────────────────────

describe("stable-identity device registration", () => {
  let idDir: string;
  let idStore: AndroidOpsStore;
  let idService: AndroidOpsService;

  beforeEach(() => {
    idDir = mkdtempSync(join(tmpdir(), "android-ops-id-"));
    idStore = new AndroidOpsStore(idDir);
    idService = new AndroidOpsService(idStore, nullAdapters(idDir));
  });

  afterEach(() => {
    idStore.close();
    rmSync(idDir, { recursive: true, force: true });
  });

  it("updates the existing row when the same androidId reconnects under a new serial", () => {
    const first = idService.registerDevice(
      { serial: "100.64.10.4:5555", model: "vivo 1901", androidId: "1d15c8a953857ef9" },
      "operator:demo",
    );
    idService.importAccounts(
      [
        {
          handle: "ops.shop",
          platform: "instagram",
          recoveryEmail: "ops-shop@recovery.example.com",
          deviceId: first.id,
        },
      ],
      "operator:demo",
    );

    const again = idService.registerDevice(
      { serial: "100.64.10.4:44961", model: "vivo 1901", androidId: "1d15c8a953857ef9" },
      "operator:demo",
    );

    // One physical phone → exactly one row, id/slot preserved, serial refreshed.
    expect(idStore.listDevices()).toHaveLength(1);
    expect(again.id).toBe(first.id);
    expect(again.slot).toBe(first.slot);
    expect(again.serial).toBe("100.64.10.4:44961");
    // The account that was pinned to it did not lose its handset.
    expect(idStore.accountsOnDevice(first.id)).toHaveLength(1);
    // The re-registration is audited as a reconnect, not a fresh registration.
    expect(
      idStore
        .listAudit({ targetType: "device", targetId: first.id })
        .some((a) => /new serial/i.test(a.summary)),
    ).toBe(true);
  });

  it("deduplicates by tailnet IP + model when no androidId is available", () => {
    const first = idService.registerDevice(
      { serial: "100.64.10.4:5555", model: "vivo 1901" },
      "operator:demo",
    );
    const again = idService.registerDevice(
      { serial: "100.64.10.4:44961", model: "vivo 1901" },
      "operator:demo",
    );
    expect(idStore.listDevices()).toHaveLength(1);
    expect(again.id).toBe(first.id);
  });

  // Rewritten deliberately. This used to place both handsets on one TAILNET
  // address, which Tailscale cannot actually produce — it assigns one 100.x per
  // node — and the assertion that they stay separate is what made a real
  // duplicate unmergeable once ANDROID_ID rotated. A LAN address is the case
  // where the premise does hold, because DHCP recycles it between phones.
  it("keeps two genuinely different handsets on one recyclable LAN IP separate", () => {
    idService.registerDevice(
      { serial: "192.168.1.150:5555", model: "vivo 1901", androidId: "aaaaaaaaaaaaaaaa" },
      "operator:demo",
    );
    idService.registerDevice(
      { serial: "192.168.1.150:6666", model: "vivo 1901", androidId: "bbbbbbbbbbbbbbbb" },
      "operator:demo",
    );
    expect(idStore.listDevices()).toHaveLength(2);
  });

  // The live case: one vivo, two ANDROID_IDs, because the companion APK was
  // re-signed between registrations. On a tailnet address that must fold into
  // one row rather than spawning a duplicate the operator has to clean up.
  it("folds a handset whose androidId rotated on a tailnet address", () => {
    const first = idService.registerDevice(
      { serial: "100.64.10.4:44961", model: "vivo vivo 1901", androidId: "ffa6d8017a40cfca" },
      "operator:demo",
    );
    const again = idService.registerDevice(
      { serial: "100.64.10.4:5555", model: "vivo vivo 1901", androidId: "1d15c8a953857ef9" },
      "operator:demo",
    );
    expect(idStore.listDevices()).toHaveLength(1);
    expect(again.id).toBe(first.id);
  });

  it("merges a pre-existing duplicate, re-pointing its accounts and jobs", () => {
    const now = Date.now();
    // Reproduce the real dev-01/dev-02 split directly in the store.
    const base = {
      model: "vivo 1901",
      androidVersion: "11",
      status: "offline" as const,
      batteryPct: 0,
      charging: false,
      storageFreeMb: 0,
      storageTotalMb: 0,
      wifiSsid: null,
      wifiSignalDbm: null,
      tailscaleUp: false,
      adbState: "absent" as const,
      scrcpyState: "unavailable" as const,
      lastHeartbeatAt: null,
      isSpare: false,
      appVersion: null,
      updateChannel: "stable" as const,
      createdAt: now,
      updatedAt: now,
    };
    idStore.upsertDevice({
      ...base,
      id: "dev-01",
      label: "Phone 01",
      slot: 1,
      serial: "100.64.10.4:44961",
      androidId: null,
      status: "online",
      batteryPct: 69,
      tailscaleIp: "100.64.10.4",
      notes: "adopted from wireless debugging",
    });
    idStore.upsertDevice({
      ...base,
      id: "dev-02",
      label: "Phone 02",
      slot: 2,
      serial: "100.64.10.4:5555",
      androidId: "1d15c8a953857ef9",
      tailscaleIp: "100.64.10.4",
      notes: "androidId=1d15c8a953857ef9 manufacturer=vivo sdk=30",
    });
    idStore.upsertAccount({
      id: "acct-01",
      handle: "ops.shop",
      platform: "instagram",
      displayName: "Ops Shop",
      deviceId: "dev-02",
      lifecycle: "active",
      sessionHealth: "healthy",
      twoFactorEnabled: true,
      twoFactorMethod: "authenticator",
      recoveryEmail: "ops-shop@recovery.example.com",
      recoveryCodesVaulted: true,
      secretRef: "vault://android-ops/instagram/ops.shop",
      lastPostAt: null,
      recoveryNotes: null,
      provisionedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const result = idService.mergeDevices("dev-01", "dev-02", "operator:demo");

    expect(idStore.listDevices()).toHaveLength(1);
    expect(idStore.getDevice("dev-02")).toBeNull();
    expect(result.accountsMoved).toBe(1);
    expect(idStore.accountsOnDevice("dev-01")).toHaveLength(1);
    // The survivor adopts the stable identity so future reconnects resolve to it.
    expect(result.kept.androidId).toBe("1d15c8a953857ef9");
    expect(
      idStore
        .listAudit({ targetType: "device", targetId: "dev-01" })
        .some((a) => a.action === "device.merge"),
    ).toBe(true);
  });
});

describe("storage diagnostics", () => {
  it("reports the live state dir, db path and device count", () => {
    const dir = mkdtempSync(join(tmpdir(), "android-ops-diag-"));
    const s = new AndroidOpsStore(dir);
    const svc = new AndroidOpsService(s, nullAdapters(dir));
    try {
      // Point "default" at a dir that has no DB, so the warning path stays out
      // of this test (it has its own case) and the result is machine-independent.
      const diag = svc.storageDiagnostics({ defaultStateDir: join(dir, "no-default-here") });
      expect(diag.stateDir).toBe(dir);
      expect(diag.dbPath).toBe(join(dir, "android-ops.db"));
      expect(diag.deviceCount).toBe(0);
      expect(diag.defaultDeviceCount).toBeNull();
      expect(diag.warning).toBeNull();
    } finally {
      s.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns when a non-default, empty store is open while the default DB has devices", () => {
    // A populated "default" install elsewhere on disk.
    const defaultDir = mkdtempSync(join(tmpdir(), "android-ops-default-"));
    const defaultStore = new AndroidOpsStore(defaultDir);
    seedAndroidOps(defaultStore);
    defaultStore.close();

    // This process opened an empty store in a *different* (non-default) dir.
    const wrongDir = mkdtempSync(join(tmpdir(), "android-ops-wrong-"));
    const wrongStore = new AndroidOpsStore(wrongDir);
    const svc = new AndroidOpsService(wrongStore, nullAdapters(wrongDir));
    try {
      const diag = svc.storageDiagnostics({ defaultStateDir: defaultDir });
      expect(diag.isDefaultStateDir).toBe(false);
      expect(diag.deviceCount).toBe(0);
      expect(diag.defaultDeviceCount).toBeGreaterThan(0);
      expect(diag.warning).toBeTruthy();
      expect(diag.warning).toMatch(/not gone/i);
      // It never switches databases — the live store is still the empty one.
      expect(diag.dbPath).toBe(join(wrongDir, "android-ops.db"));
    } finally {
      wrongStore.close();
      rmSync(wrongDir, { recursive: true, force: true });
      rmSync(defaultDir, { recursive: true, force: true });
    }
  });

  it("does not warn when the empty store IS the default location", () => {
    const dir = mkdtempSync(join(tmpdir(), "android-ops-isdefault-"));
    const s = new AndroidOpsStore(dir);
    const svc = new AndroidOpsService(s, nullAdapters(dir));
    try {
      // Point the "default" at this same dir → isDefaultStateDir true.
      const diag = svc.storageDiagnostics({ defaultStateDir: dir });
      expect(diag.isDefaultStateDir).toBe(true);
      expect(diag.warning).toBeNull();
    } finally {
      s.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the demo seed is opt-in only", () => {
  it("is the one action that writes demo rows, and says it is destructive", () => {
    const result = service.reseed("operator:demo");
    expect(result.demo).toBe(true);
    expect(result.destructive).toBe(true);
    expect(store.listAccounts().some((a) => a.handle.startsWith("demo."))).toBe(true);
    expect(service.census().demoSeedPresent).toBe(true);
  });
});
