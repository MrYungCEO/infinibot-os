/**
 * Content Studio → Droid Swarm seam for the posting queue.
 *
 * The two plugins never import each other. Droid Swarm registers
 * `droid-swarm.publisher.devices|detect|publish` gateway methods; Content
 * Studio calls them in-process through the active plugin registry (a
 * globalThis singleton, so it is the same registry from any module instance —
 * the same way flypicAvailable() finds FlyPic). When Droid Swarm is off the
 * methods are simply absent and posting reports "Droid Swarm unavailable".
 */

import type { GatewayRequestHandlerOptions } from "../gateway/server-methods/types.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";

export const DROID_METHODS = {
  devices: "droid-swarm.publisher.devices",
  detect: "droid-swarm.publisher.detect",
  publish: "droid-swarm.publisher.publish",
  verifyPost: "droid-swarm.publisher.verifyPost",
} as const;

export type DroidAccount = {
  id: string;
  platform: string;
  handle: string;
  sessionHealth: string;
};

/** ok | logged_out | challenge | app_missing | error (see droid-swarm publisher). */
export type DroidSessionHealth = "ok" | "logged_out" | "challenge" | "app_missing" | "error";

export type DroidDetection = {
  platform: string;
  deviceId: string;
  /** Older publishers omit it; derive from loggedIn. */
  sessionHealth?: DroidSessionHealth;
  loggedIn: boolean;
  activeHandle: string | null;
  accounts: string[];
  postCount: number | null;
  switcherSupported: boolean;
  detectedAt: number;
  error: string | null;
  challenge?: string | null;
  source?: "detect" | "publish";
  trace?: string[];
};

export type DroidPresence = {
  connection: string;
  online: boolean;
  adbState: string;
  lastSeenAt: number | null;
  heartbeatAgeMs: number | null;
  checkedAt: number;
  summary: string;
  fix: string[];
  screen: { awake: boolean | null; locked: boolean | null; foreground: string | null } | null;
};

export type DroidDevice = {
  id: string;
  label: string;
  model: string | null;
  status: string;
  adbState: string;
  online: boolean;
  lastHeartbeatAt: number | null;
  lastSeenAt?: number | null;
  connection?: string;
  presence?: DroidPresence;
  accounts: DroidAccount[];
  detected: Record<string, DroidDetection>;
  detecting?: {
    kind?: "detect" | "publish";
    platform: string;
    startedAt: number;
    step: string;
    steps: Array<{ step: string; ok: boolean; detail: string | null }>;
  } | null;
};

export type DroidDevicesResult = {
  ok: boolean;
  status: string;
  reason?: string;
  platforms?: string[];
  checkedAt?: number;
  devices: DroidDevice[];
};

export type DroidDetectResult = {
  ok: boolean;
  /** ok = a check ran (see detection.sessionHealth); offline/busy = it did not. */
  status?: "ok" | "offline" | "busy" | "unavailable" | "failed";
  reason: string | null;
  detection: DroidDetection | null;
  steps: DroidStep[];
  presence?: DroidPresence | null;
};

export const sessionHealthOf = (d: DroidDetection | null | undefined): DroidSessionHealth | null =>
  d ? (d.sessionHealth ?? (d.loggedIn ? "ok" : "error")) : null;

export type DroidStep = { step: string; ok: boolean; detail?: string; at: number };

export type DroidPublishStatus =
  | "posted"
  | "dry_run_complete"
  | "failed"
  | "wrong_account"
  | "logged_out"
  | "blocked"
  | "busy"
  | "paced"
  | "offline"
  | "unavailable"
  /** trialReel asked for, but the phone's Instagram had no (working) Trial switch. */
  | "trial_unavailable";

export type DroidPublishResult = {
  ok: boolean;
  status: DroidPublishStatus;
  retryable: boolean;
  reason: string | null;
  dryRun: boolean;
  activeHandle: string | null;
  switched: boolean;
  postUrl: string | null;
  postRef: string | null;
  warnings: string[];
  steps: DroidStep[];
  /** Screens captured on a failed step (screenshot path + visible elements). */
  evidence?: Array<{
    tag: string;
    screenshot: string | null;
    foreground: string | null;
    visible: string[];
    at: number;
  }>;
  /** The normalized video as sent to the phone (and whether it was removed). */
  media?: {
    hostPath: string;
    devicePath: string;
    normalized: string;
    cached: boolean;
    bytes: number;
    durationSec: number;
    mediaStoreId: number | null;
    removedFromPhone: boolean | null;
  } | null;
};

export type DroidPublishInput = {
  deviceId: string;
  platform: string;
  handle: string;
  videoPath: string;
  caption: string;
  dryRun: boolean;
  /** Instagram: share as a Trial reel; never falls back to a regular reel. */
  trialReel?: boolean;
  requestId: string;
  actor: string;
  authorization: string;
};

export interface DroidPublisher {
  available(): boolean;
  devices(opts?: { refresh?: boolean }): Promise<DroidDevicesResult>;
  detect(input: { deviceId: string; platform: string; actor: string }): Promise<DroidDetectResult>;
  publish(input: DroidPublishInput): Promise<DroidPublishResult>;
  /** Post-publish check on the phone (older Droid Swarm builds lack it). */
  verifyPost?(input: DroidVerifyInput): Promise<DroidVerifyResult>;
}

export type DroidVerifyInput = {
  deviceId: string;
  platform: string;
  handle: string;
  caption: string;
  requestId: string;
  actor: string;
};

export type DroidVerifyResult = {
  ok: boolean;
  status:
    | "verified"
    | "not_found"
    | "wrong_account"
    | "offline"
    | "busy"
    | "unavailable"
    | "failed";
  reason: string | null;
  permalink: string | null;
  captionMatched: boolean;
  seenCaption: string | null;
  activeHandle: string | null;
  steps: DroidStep[];
  evidence?: Array<{
    tag: string;
    screenshot: string | null;
    foreground: string | null;
    visible: string[];
    at: number;
  }>;
};

export class DroidUnavailableError extends Error {
  constructor() {
    super("Droid Swarm is not enabled on this gateway (enable it under Setup › Plugins)");
  }
}

function invoke<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const handler = getActivePluginRegistry()?.gatewayHandlers?.[method];
  if (typeof handler !== "function") return Promise.reject(new DroidUnavailableError());
  return new Promise<T>((resolve, reject) => {
    const opts = {
      req: { type: "req", id: `content-studio-posting-${Date.now()}`, method, params },
      params,
      client: null,
      isWebchatConnect: () => false,
      respond: (ok: boolean, payload?: unknown, error?: { message?: string }) => {
        if (ok) resolve(payload as T);
        else reject(new Error(error?.message ?? `${method} failed`));
      },
      context: {},
    } as unknown as GatewayRequestHandlerOptions;
    Promise.resolve(handler(opts)).catch(reject);
  });
}

/** The live adapter: Droid Swarm's publisher through the plugin registry. */
export const registryDroidPublisher: DroidPublisher = {
  available: () =>
    typeof getActivePluginRegistry()?.gatewayHandlers?.[DROID_METHODS.publish] === "function",
  devices: (opts) => invoke(DROID_METHODS.devices, { refresh: opts?.refresh === true }),
  detect: (input) => invoke(DROID_METHODS.detect, input),
  publish: (input) => invoke(DROID_METHODS.publish, input as unknown as Record<string, unknown>),
  verifyPost: (input) => {
    if (
      typeof getActivePluginRegistry()?.gatewayHandlers?.[DROID_METHODS.verifyPost] !== "function"
    ) {
      return Promise.resolve({
        ok: false,
        status: "unavailable",
        reason: "this Droid Swarm build has no post verification (update the plugin)",
        permalink: null,
        captionMatched: false,
        seenCaption: null,
        activeHandle: null,
        steps: [],
      } satisfies DroidVerifyResult);
    }
    return invoke(DROID_METHODS.verifyPost, input as unknown as Record<string, unknown>);
  },
};
