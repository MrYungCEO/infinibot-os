/**
 * Gateway RPCs for Android Social Ops — the 4-phone V1 command center.
 *
 * Read methods (`androidops.*.list`, `.dashboard`, `.ops.status`) hydrate the
 * dashboard; write methods mutate through {@link AndroidOpsService} so every
 * change is guarded and audited in one place.
 *
 * Two conventions worth knowing:
 *
 *  - Every write takes an `actor`. It is not decoration: the compliance layer
 *    refuses to clear a human checkpoint for an automated actor, so an honest
 *    actor string is what keeps that guard meaningful.
 *  - A {@link ComplianceViolationError} is mapped to a distinct FORBIDDEN
 *    error code rather than a generic 500, so the UI can explain *why* the
 *    system declined instead of showing a crash.
 */

import { isFleetTenantMachine } from "../../saas/fleet-plugins.js";
import { ComplianceViolationError } from "../../android-ops/compliance.js";
import { getAndroidOpsService, type DeviceAgentControlAction } from "../../android-ops/service.js";
import { SecretMaterialError } from "../../android-ops/setup.js";
import type { AccountImportEntry, DeviceRegistrationInput } from "../../android-ops/setup.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import type { JobState, Platform } from "../../android-ops/types.js";

type Params = Record<string, unknown>;

const str = (p: Params, key: string): string | undefined => {
  const v = p[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
};
const num = (p: Params, key: string): number | undefined => {
  const v = p[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
};
const list = (p: Params, key: string): string[] =>
  Array.isArray(p[key])
    ? (p[key] as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
const bool = (p: Params, key: string): boolean | undefined =>
  typeof p[key] === "boolean" ? (p[key] as boolean) : undefined;

const DEVICE_AGENT_CONTROL_ACTIONS = new Set<string>([
  "adb_connect",
  "adb_pair",
  "screenshot",
  "logs",
  "launch",
  "tap",
  "swipe",
  "text",
  "keyevent",
  "open_stream",
  "close_stream",
]);

/** Who performed the write. Anonymous callers are explicitly *not* operators. */
const actorOf = (p: Params): string => str(p, "actor") ?? "system";

function fail(respond: RespondFn, e: unknown) {
  if (e instanceof SecretMaterialError) {
    // A caller trying to store a credential is a request bug, not a crash —
    // and the reply must never echo the offending value back.
    respond(false, undefined, {
      code: "INVALID_REQUEST",
      message: e.message,
      details: { fields: e.fields, secretMaterial: true },
    });
    return;
  }
  if (e instanceof ComplianceViolationError) {
    respond(false, undefined, {
      code: "FORBIDDEN",
      message: e.message,
      details: { capability: e.capability, complianceBoundary: true },
    });
    return;
  }
  respond(false, undefined, {
    code: "INTERNAL_ERROR",
    message: String(e instanceof Error ? e.message : e),
  });
}

/**
 * Droid Swarm drives phones on the owner's LAN / tailnet (adb, Tailscale,
 * scrcpy, local Claude). None of that exists on an InfiniBot Cloud workspace
 * Machine, and the backend spawns local programs, so every androidops.* method
 * is refused there (the droid-swarm plugin is self-hosted only in
 * src/saas/fleet-plugins.ts; the android_ops agent tool is already SaaS-gated).
 */
export const ANDROID_OPS_CLOUD_REFUSAL =
  "Droid Swarm controls phones on your own network (adb over your LAN or tailnet), so it runs on self-hosted InfiniBot only.";

/** Wrap a handler so every method gets the same error mapping. */
function handler(fn: (args: { params: Params; respond: RespondFn }) => Promise<void> | void) {
  return async ({ params, respond }: { params?: unknown; respond: RespondFn }) => {
    if (isFleetTenantMachine()) {
      respond(false, undefined, {
        code: "UNAVAILABLE",
        message: ANDROID_OPS_CLOUD_REFUSAL,
        details: { selfHostOnly: true },
      });
      return;
    }
    try {
      await fn({ params: (params ?? {}) as Params, respond });
    } catch (e) {
      fail(respond, e);
    }
  };
}

export const androidOpsHandlers: GatewayRequestHandlers = {
  // ── Read ───────────────────────────────────────────────────────────────────

  "androidops.dashboard": handler(async ({ respond }) => {
    const service = await getAndroidOpsService();
    respond(true, {
      summary: service.dashboard(),
      adapters: await service.adapterSnapshot(),
      devices: service.store.listDevices(),
      // Accounts always leave through the secret-free projection.
      accounts: service.listAccountsPublic(),
      census: service.census(),
      // Where the fleet is actually stored + a warning when this process opened
      // an empty non-default DB while the default install still has devices, so
      // a blank dashboard is never silently mistaken for an empty install.
      storage: service.storageDiagnostics(),
    });
  }),

  "androidops.devices.list": handler(async ({ params, respond }) => {
    const service = await getAndroidOpsService();
    const devices = service.store.listDevices();
    const withHistory = str(params, "deviceId");
    respond(true, {
      devices,
      loads: service.deviceLoads(),
      history: withHistory ? service.store.healthHistory(withHistory) : null,
      adapters: await service.adapterSnapshot(),
      streamSessions: (await service.opsStatus()).streamSessions,
    });
  }),

  "androidops.device.history": handler(async ({ params, respond }) => {
    const service = await getAndroidOpsService();
    const deviceId = str(params, "deviceId");
    if (!deviceId)
      return respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "deviceId is required",
      });
    respond(true, { history: service.store.healthHistory(deviceId, num(params, "limit") ?? 48) });
  }),

  "androidops.accounts.list": handler(async ({ respond }) => {
    const service = await getAndroidOpsService();
    respond(true, {
      accounts: service.listAccountsPublic(),
      devices: service.store.listDevices(),
      jobs: service.store.listJobs({ limit: 2000 }),
    });
  }),

  "androidops.media.list": handler(async ({ respond }) => {
    const service = await getAndroidOpsService();
    respond(true, { media: service.store.listMedia(), accounts: service.listAccountsPublic() });
  }),

  "androidops.jobs.list": handler(async ({ params, respond }) => {
    const service = await getAndroidOpsService();
    const states = list(params, "states");
    respond(true, {
      jobs: service.store.listJobs({
        states: states.length ? states : undefined,
        from: num(params, "from"),
        to: num(params, "to"),
        limit: num(params, "limit") ?? 500,
      }),
      media: service.store.listMedia(),
      accounts: service.listAccountsPublic(),
      devices: service.store.listDevices(),
    });
  }),

  "androidops.audit.list": handler(async ({ params, respond }) => {
    const service = await getAndroidOpsService();
    respond(true, {
      events: service.store.listAudit({
        targetType: str(params, "targetType"),
        targetId: str(params, "targetId"),
        limit: num(params, "limit") ?? 200,
      }),
    });
  }),

  "androidops.inbox.list": handler(async ({ params, respond }) => {
    const service = await getAndroidOpsService();
    respond(true, {
      items: service.store.listInbox(str(params, "status")),
      accounts: service.listAccountsPublic(),
    });
  }),

  "androidops.provisioning.list": handler(async ({ respond }) => {
    const service = await getAndroidOpsService();
    respond(true, { runs: service.store.listProvisioning(), loads: service.deviceLoads() });
  }),

  /**
   * First-run / standalone-dashboard payload: store census, adapter and tailnet
   * readiness, fly deploy-config presence, and the ordered setup checklist.
   */
  "androidops.setup.status": handler(async ({ respond }) => {
    const service = await getAndroidOpsService();
    respond(true, await service.setupStatus());
  }),

  "androidops.ops.status": handler(async ({ respond }) => {
    const service = await getAndroidOpsService();
    respond(true, await service.opsStatus());
  }),

  // ── Write ──────────────────────────────────────────────────────────────────

  /**
   * Probe the rack. Handsets adb can see that are not registered are adopted
   * into the fleet unless the caller passes `adopt: false`.
   */
  "androidops.fleet.refresh": handler(async ({ params, respond }) => {
    const service = await getAndroidOpsService();
    respond(true, await service.refreshFleet(actorOf(params), { adopt: bool(params, "adopt") }));
  }),

  /** Register (or re-register, by passing `deviceId`) a handset from form data. */
  "androidops.device.register": handler(async ({ params, respond }) => {
    const service = await getAndroidOpsService();
    const serial = str(params, "serial");
    if (!serial)
      return respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "serial is required — run `adb devices` to find it",
      });
    const input: DeviceRegistrationInput = {
      id: str(params, "deviceId"),
      label: str(params, "label"),
      slot: num(params, "slot"),
      model: str(params, "model"),
      androidVersion: str(params, "androidVersion"),
      serial,
      androidId: str(params, "androidId") ?? null,
      tailscaleIp: str(params, "tailscaleIp") ?? null,
      isSpare: bool(params, "isSpare"),
      notes: str(params, "notes") ?? null,
      updateChannel: str(params, "updateChannel") as DeviceRegistrationInput["updateChannel"],
      storageTotalMb: num(params, "storageTotalMb"),
      appVersion: str(params, "appVersion") ?? null,
    };
    respond(true, { device: service.registerDevice(input, actorOf(params)) });
  }),

  /**
   * Retire a handset. Defaults to `mode: "archive"`, which keeps the row and
   * its history; `mode: "delete"` is refused while accounts or live jobs still
   * point at the device.
   */
  "androidops.device.remove": handler(async ({ params, respond }) => {
    const service = await getAndroidOpsService();
    const id = str(params, "deviceId");
    if (!id)
      return respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "deviceId is required",
      });
    const mode = str(params, "mode");
    if (mode && mode !== "archive" && mode !== "delete") {
      return respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: 'mode must be "archive" or "delete"',
      });
    }
    respond(
      true,
      service.removeDevice(id, actorOf(params), {
        mode: mode as "archive" | "delete" | undefined,
        reason: str(params, "reason"),
      }),
    );
  }),

  /**
   * Import an account roster. Idempotent on (platform, handle). Credentials are
   * rejected outright — pass a `vault://` reference in `secretRef` instead.
   */
  "androidops.accounts.import": handler(async ({ params, respond }) => {
    const service = await getAndroidOpsService();
    const raw = params.accounts;
    if (!Array.isArray(raw) || !raw.length) {
      return respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "accounts must be a non-empty array",
      });
    }
    respond(
      true,
      service.importAccounts(raw as AccountImportEntry[], actorOf(params), {
        autoAssign: params.autoAssign === true,
      }),
    );
  }),

  "androidops.device.update": handler(async ({ params, respond }) => {
    const service = await getAndroidOpsService();
    const id = str(params, "deviceId");
    if (!id)
      return respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "deviceId is required",
      });
    const patch = (params.patch ?? {}) as Params;
    respond(true, { device: service.updateDevice(id, patch, actorOf(params)) });
  }),

  "androidops.device.control": handler(async ({ params, respond }) => {
    const service = await getAndroidOpsService();
    const id = str(params, "deviceId");
    if (!id)
      return respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "deviceId is required",
      });
    respond(true, { session: await service.openStream(id, actorOf(params)) });
  }),

  "androidops.device.control.stop": handler(async ({ params, respond }) => {
    const service = await getAndroidOpsService();
    const sessionId = str(params, "sessionId");
    if (!sessionId)
      return respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "sessionId is required",
      });
    respond(true, await service.closeStream(sessionId, actorOf(params)));
  }),

  /**
   * MCP/agent handset control. This is direct device input, but still routes
   * through the Android Ops allow-list and audit trail. It intentionally does
   * not expose arbitrary adb shell/root.
   */
  "androidops.device.agent_control": handler(async ({ params, respond }) => {
    const service = await getAndroidOpsService();
    const deviceId = str(params, "deviceId");
    const action = str(params, "action");
    if (!deviceId || !action) {
      return respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "deviceId and action are required",
      });
    }
    if (!DEVICE_AGENT_CONTROL_ACTIONS.has(action)) {
      return respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "action must be one of " + Array.from(DEVICE_AGENT_CONTROL_ACTIONS).join(", "),
      });
    }
    respond(
      true,
      await service.agentControlDevice(
        {
          deviceId,
          action: action as DeviceAgentControlAction,
          x: num(params, "x"),
          y: num(params, "y"),
          x1: num(params, "x1"),
          y1: num(params, "y1"),
          x2: num(params, "x2"),
          y2: num(params, "y2"),
          durationMs: num(params, "durationMs"),
          text: str(params, "text"),
          keyevent: str(params, "keyevent"),
          package: str(params, "package"),
          label: str(params, "label"),
          sinceMs: num(params, "sinceMs"),
          sessionId: str(params, "sessionId"),
          pairHostPort: str(params, "pairHostPort"),
          pairingCode: str(params, "pairingCode"),
        },
        actorOf(params),
      ),
    );
  }),

  "androidops.account.update": handler(async ({ params, respond }) => {
    const service = await getAndroidOpsService();
    const id = str(params, "accountId");
    if (!id)
      return respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "accountId is required",
      });
    respond(true, {
      account: service.updateAccount(id, (params.patch ?? {}) as Params, actorOf(params)),
    });
  }),

  "androidops.account.assign": handler(async ({ params, respond }) => {
    const service = await getAndroidOpsService();
    const id = str(params, "accountId");
    if (!id)
      return respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "accountId is required",
      });
    const target = str(params, "deviceId") ?? "auto";
    respond(true, service.assignAccount(id, target, actorOf(params)));
  }),

  "androidops.media.create": handler(async ({ params, respond }) => {
    const service = await getAndroidOpsService();
    const title = str(params, "title");
    if (!title)
      return respond(false, undefined, { code: "INVALID_REQUEST", message: "title is required" });
    const media = await service.registerMedia(
      {
        title,
        kind: (str(params, "kind") ?? "video") as "video" | "image" | "carousel",
        storageKey: str(params, "storageKey"),
        caption: str(params, "caption") ?? "",
        hashtags: list(params, "hashtags"),
        platforms: list(params, "platforms") as Platform[],
        targetAccountIds: list(params, "targetAccountIds"),
        sizeBytes: num(params, "sizeBytes"),
        durationSec: num(params, "durationSec") ?? null,
        width: num(params, "width") ?? null,
        height: num(params, "height") ?? null,
      },
      actorOf(params),
    );
    respond(true, { media });
  }),

  "androidops.media.update": handler(async ({ params, respond }) => {
    const service = await getAndroidOpsService();
    const id = str(params, "mediaId");
    if (!id)
      return respond(false, undefined, { code: "INVALID_REQUEST", message: "mediaId is required" });
    respond(true, {
      media: service.updateMedia(id, (params.patch ?? {}) as Params, actorOf(params)),
    });
  }),

  "androidops.schedule.create": handler(async ({ params, respond }) => {
    const service = await getAndroidOpsService();
    const mediaId = str(params, "mediaId");
    const accountIds = list(params, "accountIds");
    if (!mediaId || !accountIds.length) {
      return respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "mediaId and at least one accountId are required",
      });
    }
    respond(
      true,
      service.scheduleContent({
        mediaId,
        accountIds,
        startAt: num(params, "startAt") ?? Date.now() + 60_000,
        caption: str(params, "caption"),
        deviceGapMs: num(params, "deviceGapMs"),
        rackGapMs: num(params, "rackGapMs"),
        actor: actorOf(params),
      }),
    );
  }),

  "androidops.job.advance": handler(async ({ params, respond }) => {
    const service = await getAndroidOpsService();
    const jobId = str(params, "jobId");
    const to = str(params, "to") as JobState | undefined;
    if (!jobId || !to) {
      return respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "jobId and to are required",
      });
    }
    const actionRequired = params.actionRequired as { kind?: string; message?: string } | undefined;
    respond(true, {
      job: service.advanceJob(jobId, to, {
        actor: actorOf(params),
        error: str(params, "error"),
        permalink: str(params, "permalink"),
        bundleRef: str(params, "bundleRef"),
        actionRequired:
          actionRequired?.kind && actionRequired.message
            ? { kind: actionRequired.kind as never, message: actionRequired.message }
            : undefined,
      }),
    });
  }),

  "androidops.job.retry": handler(async ({ params, respond }) => {
    const service = await getAndroidOpsService();
    const jobId = str(params, "jobId");
    if (!jobId)
      return respond(false, undefined, { code: "INVALID_REQUEST", message: "jobId is required" });
    respond(true, { job: service.retryJob(jobId, actorOf(params)) });
  }),

  /**
   * Clearing a human checkpoint. `actor` must name a real operator — the
   * compliance layer rejects "system"/"scheduler"/"simulator" here.
   */
  "androidops.job.checkpoint.resolve": handler(async ({ params, respond }) => {
    const service = await getAndroidOpsService();
    const jobId = str(params, "jobId");
    if (!jobId)
      return respond(false, undefined, { code: "INVALID_REQUEST", message: "jobId is required" });
    respond(true, {
      job: service.resolveActionRequired(jobId, actorOf(params), {
        resume: str(params, "resume") as JobState | undefined,
        note: str(params, "note"),
      }),
    });
  }),

  "androidops.pipeline.tick": handler(async ({ params, respond }) => {
    const service = await getAndroidOpsService();
    respond(
      true,
      await service.tick({ actor: actorOf(params), simulate: params.simulate === true }),
    );
  }),

  "androidops.provisioning.start": handler(async ({ params, respond }) => {
    const service = await getAndroidOpsService();
    const handle = str(params, "handle");
    const platform = str(params, "platform") as Platform | undefined;
    if (!handle || !platform) {
      return respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "handle and platform are required",
      });
    }
    respond(true, {
      run: service.startProvisioning({
        handle,
        platform,
        deviceId: str(params, "deviceId"),
        actor: actorOf(params),
      }),
    });
  }),

  "androidops.provisioning.step": handler(async ({ params, respond }) => {
    const service = await getAndroidOpsService();
    const runId = str(params, "runId");
    const stepKey = str(params, "stepKey");
    if (!runId || !stepKey) {
      return respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "runId and stepKey are required",
      });
    }
    respond(true, {
      run: service.advanceProvisioningStep(runId, {
        stepKey,
        status: (str(params, "status") ?? "done") as never,
        note: str(params, "note"),
        actor: actorOf(params),
      }),
    });
  }),

  "androidops.inbox.update": handler(async ({ params, respond }) => {
    const service = await getAndroidOpsService();
    const id = str(params, "itemId");
    if (!id)
      return respond(false, undefined, { code: "INVALID_REQUEST", message: "itemId is required" });
    respond(true, {
      item: service.updateInbox(id, (params.patch ?? {}) as Params, actorOf(params)),
    });
  }),

  "androidops.alert.ack": handler(async ({ params, respond }) => {
    const service = await getAndroidOpsService();
    const id = str(params, "alertId");
    if (!id)
      return respond(false, undefined, { code: "INVALID_REQUEST", message: "alertId is required" });
    respond(true, { acknowledged: service.acknowledgeAlert(id, actorOf(params)) });
  }),

  "androidops.backup.run": handler(async ({ params, respond }) => {
    const service = await getAndroidOpsService();
    respond(true, { backups: service.runBackup(actorOf(params)) });
  }),

  "androidops.seed": handler(async ({ params, respond }) => {
    const service = await getAndroidOpsService();
    respond(true, service.reseed(actorOf(params)));
  }),
};

export { ANDROID_OPS_READ_METHODS, ANDROID_OPS_WRITE_METHODS } from "./android-ops-methods.js";
