/**
 * The live "channels this plan leaves out" list for the hosted app (Free: no
 * Telegram, no Slack). Filled from GET /api/me `channelsExcluded` at cloud boot
 * (fleet-connect.ts) and by the cloud setup gate; empty everywhere else
 * (self-hosted, paid plans, servers that predate the field), so those surfaces
 * behave exactly as before.
 *
 * Views read `channelsExcluded()` while rendering; a change dispatches
 * `infinibot:plan-channels` and asks the app shell to re-render.
 */
import { getClerkToken } from "../saas-clerk";
import { cloudApiBase, isCloudBuild } from "./cloud-env";
import { isChannelLocked, normalizeChannelsExcluded } from "./plan-channels-model";

export {
  channelLabel,
  channelLockReason,
  channelLockView,
  channelUpgradeCta,
  isChannelLocked,
  isChannelNotInPlanError,
  lockedChannelOf,
  normalizeChannelsExcluded,
  type ChannelLockView,
} from "./plan-channels-model";

export const PLAN_CHANNELS_EVENT = "infinibot:plan-channels";

let excluded: string[] = [];

/** Channels the current plan leaves out ([] = none / not the hosted app). */
export function channelsExcluded(): readonly string[] {
  return excluded;
}

/** True when this tenant's plan leaves the channel out. */
export function isChannelExcluded(id: string | null | undefined): boolean {
  return isChannelLocked(id, excluded);
}

/** Apply `channelsExcluded` from a server payload (absent / malformed → []). */
export function setChannelsExcluded(raw: unknown): void {
  const next = normalizeChannelsExcluded(raw);
  if (next.length === excluded.length && next.every((id) => excluded.includes(id))) return;
  excluded = next;
  window.dispatchEvent(new CustomEvent(PLAN_CHANNELS_EVENT, { detail: { channelsExcluded: next } }));
  const app = document.querySelector("infinibot-app") as (HTMLElement & { requestUpdate?: () => void }) | null;
  app?.requestUpdate?.();
}

let watching = false;
let lastLoad = 0;

/** Back from the checkout tab (or an upgrade that lifted the daily gate): look again. */
function watchForUpgrade(): void {
  if (watching) return;
  watching = true;
  const again = () => {
    if (excluded.length && Date.now() - lastLoad > 10_000) void loadPlanChannels();
  };
  window.addEventListener("focus", again);
  window.addEventListener("infinibot:daily-limit", again);
}

/** Read GET /api/me and publish its `channelsExcluded`. Never throws. */
export async function loadPlanChannels(): Promise<void> {
  if (!isCloudBuild()) return;
  watchForUpgrade();
  lastLoad = Date.now();
  try {
    const token = await getClerkToken().catch(() => null);
    if (!token) return;
    const res = await fetch(`${cloudApiBase()}/me`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) return;
    const me = (await res.json().catch(() => null)) as { channelsExcluded?: unknown } | null;
    if (me) setChannelsExcluded(me.channelsExcluded);
  } catch {
    /* offline: the gateway still refuses excluded channels; the UI just isn't pre-locked */
  }
}
