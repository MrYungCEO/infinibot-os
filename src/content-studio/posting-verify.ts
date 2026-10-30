/**
 * Content Studio posting — "is the bound account really on that phone, right
 * now?" Shared by the scheduler, post-now, the Detect button and the agent
 * tool, so all of them refuse for the same reasons.
 *
 * Truth comes from Droid Swarm: live adb presence (cached a few seconds by
 * the publisher) and the last on-phone account detection. A detection is
 * trusted for DETECT_TTL_MS when it was healthy; anything older, or anything
 * that was not healthy, is re-checked on the phone before a post. The
 * publisher then verifies the active account once more on-screen right before
 * it touches the composer, so a stale cache can never post from the wrong
 * account — it can only cause a refusal.
 */

import {
  sessionHealthOf,
  type DroidDetection,
  type DroidDevice,
  type DroidPublisher,
} from "./posting-droid.js";
import type {
  BindingVerification,
  PlatformBinding,
  PostingConfig,
  PostingStore,
} from "./posting-store.js";
import { normalizeHandle } from "./posting-store.js";

/** A healthy detection younger than this is reused instead of re-driving the phone. */
export const DETECT_TTL_MS = 30 * 60_000;

export type PreflightRefusal =
  | "unavailable"
  | "unknown_device"
  | "offline"
  | "busy"
  | "wrong_account"
  | "logged_out"
  | "challenge"
  | "app_missing"
  | "error"
  | "no_binding";

export type PreflightResult =
  | { ok: true; device: DroidDevice; detection: DroidDetection; redetected: boolean }
  | {
      ok: false;
      kind: PreflightRefusal;
      reason: string;
      /** Worth trying again later on its own (offline / busy / unavailable / error). */
      transient: boolean;
      device: DroidDevice | null;
      detection: DroidDetection | null;
    };

const PLATFORM_LABEL: Record<string, string> = { instagram: "Instagram", tiktok: "TikTok" };
const label = (p: string) => PLATFORM_LABEL[p] ?? p;

/** What a detection says about one bound handle. */
export function verdictFor(
  binding: Pick<PlatformBinding, "platform" | "handle">,
  det: DroidDetection | null | undefined,
): { verification: BindingVerification; note: string | null } {
  const health = sessionHealthOf(det);
  if (!det || !health) return { verification: "unverified", note: "not checked on the phone yet" };
  const handle = normalizeHandle(binding.handle);
  if (health !== "ok") {
    return {
      verification: health,
      note:
        health === "challenge"
          ? `a security checkpoint is on the phone${det.challenge ? ` (“${det.challenge}”)` : ""} — clear it on the phone, then Detect again`
          : health === "logged_out"
            ? `${label(binding.platform)} is logged out on the phone`
            : health === "app_missing"
              ? `${label(binding.platform)} is not installed on the phone`
              : (det.error ?? "the last check failed"),
    };
  }
  const accounts = det.accounts.map(normalizeHandle);
  const active = det.activeHandle ? normalizeHandle(det.activeHandle) : null;
  if (!accounts.includes(handle)) {
    return {
      verification: "mismatch",
      note: `@${handle} is not logged in on the phone (found ${accounts.map((h) => `@${h}`).join(", ") || "no account"})`,
    };
  }
  if (active !== handle && !det.switcherSupported) {
    return {
      verification: "mismatch",
      note: `@${active} is active and ${label(binding.platform)} can't be switched automatically — switch to @${handle} on the phone`,
    };
  }
  return { verification: "verified", note: null };
}

const REFUSAL_OF: Record<Exclude<BindingVerification, "verified">, PreflightRefusal> = {
  unverified: "error",
  mismatch: "wrong_account",
  logged_out: "logged_out",
  challenge: "challenge",
  app_missing: "app_missing",
  error: "error",
  offline: "offline",
};

/**
 * Writes a detection's verdict onto every page bound to that device +
 * platform, so each page's binding shows the fresh state.
 */
export function recordDetection(
  posting: PostingStore,
  deviceId: string,
  platform: string,
  det: DroidDetection | null,
): number {
  if (!det) return 0;
  let n = 0;
  for (const cfg of posting.listConfigs()) {
    if (cfg.deviceId !== deviceId) continue;
    for (const b of cfg.bindings) {
      if (b.platform !== platform) continue;
      const v = verdictFor(b, det);
      posting.setBindingVerification(cfg.pageId, b.platform, b.handle, {
        verification: v.verification,
        note: v.note,
        at: det.detectedAt,
      });
      n++;
    }
  }
  return n;
}

/**
 * Can this page post to `platform` right now? Checks the phone is reachable
 * and the bound account is verified (re-detecting on the phone when the last
 * healthy check is older than DETECT_TTL_MS or was not healthy).
 */
export async function preflight(
  deps: { droid: DroidPublisher; posting: PostingStore; now: () => number },
  cfg: PostingConfig,
  platform: string,
  opts: { actor: string; ttlMs?: number },
): Promise<PreflightResult> {
  const binding = cfg.bindings.find((b) => b.platform === platform);
  const refuse = (
    kind: PreflightRefusal,
    reason: string,
    transient: boolean,
    device: DroidDevice | null = null,
    detection: DroidDetection | null = null,
  ): PreflightResult => ({ ok: false, kind, reason, transient, device, detection });
  if (!cfg.deviceId || !binding) {
    return refuse("no_binding", `bind a device and a ${label(platform)} account first`, false);
  }
  const { droid } = deps;
  if (!droid.available()) {
    return refuse("unavailable", "Droid Swarm is not enabled on this gateway", true);
  }
  let list;
  try {
    list = await droid.devices();
  } catch (err) {
    return refuse("unavailable", `Droid Swarm device list failed: ${String(err)}`, true);
  }
  if (!list.ok) return refuse("unavailable", list.reason ?? "Droid Swarm unavailable", true);
  const device = list.devices.find((d) => d.id === cfg.deviceId) ?? null;
  const name = device?.label ?? cfg.deviceLabel ?? cfg.deviceId;
  if (!device) {
    return refuse(
      "unknown_device",
      `${name} is no longer registered in Droid Swarm — re-bind the page to a phone`,
      false,
    );
  }
  if (!device.online) {
    const p = device.presence;
    return refuse(
      "offline",
      `${name} is offline${p?.summary ? ` — ${p.summary}` : ""}.${p?.fix?.[0] ? ` Fix: ${p.fix[0]}` : ""}`,
      true,
      device,
    );
  }
  const ttl = opts.ttlMs ?? DETECT_TTL_MS;
  let det: DroidDetection | null = device.detected?.[platform] ?? null;
  let redetected = false;
  const fresh = det && sessionHealthOf(det) === "ok" && deps.now() - det.detectedAt < ttl;
  if (!fresh) {
    const res = await droid.detect({ deviceId: device.id, platform, actor: opts.actor });
    if (res.status === "offline") {
      return refuse("offline", res.reason ?? `${name} is offline`, true, device);
    }
    if (res.status === "busy") {
      return refuse("busy", res.reason ?? `${name} is busy`, true, device);
    }
    if (res.status === "unavailable") {
      return refuse("unavailable", res.reason ?? "Droid Swarm unavailable", true, device);
    }
    if (!res.detection) {
      return refuse("error", res.reason ?? "account detection failed", true, device);
    }
    det = res.detection;
    redetected = true;
    recordDetection(deps.posting, device.id, platform, det);
  }
  const v = verdictFor(binding, det);
  if (!redetected) {
    deps.posting.setBindingVerification(cfg.pageId, binding.platform, binding.handle, {
      verification: v.verification,
      note: v.note,
      at: det!.detectedAt,
    });
  }
  if (v.verification === "verified") {
    return { ok: true, device, detection: det!, redetected };
  }
  const kind = REFUSAL_OF[v.verification];
  return refuse(
    kind,
    `${label(platform)} @${normalizeHandle(binding.handle)} on ${name} is not verified: ${v.note} — nothing was posted`,
    kind === "error",
    device,
    det,
  );
}
