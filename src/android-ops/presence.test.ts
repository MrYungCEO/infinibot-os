import { describe, expect, it } from "vitest";

import { buildPresence, matchAttached, parseScreenState } from "./presence.js";
import { detectBlocker } from "./ui-automation.js";
import type { PhoneDevice } from "./types.js";

const device = (over: Partial<PhoneDevice> = {}): PhoneDevice =>
  ({
    id: "dev-01",
    label: "Phone 01",
    serial: "100.111.16.100:5555",
    androidId: null,
    model: "vivo 1901",
    tailscaleIp: "100.111.16.100",
    status: "online",
    adbState: "device",
    lastHeartbeatAt: Date.UTC(2026, 9, 3, 13, 19),
    isSpare: false,
    ...over,
  }) as PhoneDevice;

describe("presence", () => {
  const now = Date.UTC(2026, 9, 7, 7, 0);

  it("a stored 'online' phone adb does not list is offline, with last seen and wireless-adb fixes", () => {
    const p = buildPresence(device(), null, true, now);
    expect(p).toMatchObject({ online: false, connection: "not_connected", adbState: "absent" });
    expect(p.summary).toBe("Not connected — last seen 4 days ago");
    expect(p.fix.join("\n")).toMatch(
      /Tailscale is connected on the phone \(this computer dials 100\.111\.16\.100:5555\)/,
    );
    expect(p.fix.join("\n")).toMatch(/adb tcpip 5555/);
  });

  it("matches a re-paired wireless phone by its tailnet IP", () => {
    const live = {
      serial: "100.111.16.100:41235",
      state: "device" as const,
      model: "vivo_1901",
      transport: "tcp" as const,
      androidId: null,
    };
    expect(matchAttached(device(), [live])).toBe(live);
    const p = buildPresence(device(), live, true, now);
    expect(p).toMatchObject({
      online: true,
      connection: "connected",
      lastSeenAt: now,
      transport: "tcp",
    });
  });

  it("adb missing on the host is its own state", () => {
    expect(buildPresence(device(), null, false, now).connection).toBe("adb_unavailable");
  });

  it("parses screen state from real dumpsys lines", () => {
    expect(
      parseScreenState(
        "  mWakefulness=Asleep\nDisplay Power: state=OFF\n  mCurrentFocus=Window{9f1 u0 NotificationShade}\n  mShowingLockscreen=true mShowingDream=false\n",
      ),
    ).toEqual({ awake: false, locked: true, foreground: "com.android.systemui" });
    expect(
      parseScreenState(
        "  mWakefulness=Awake\n  mCurrentFocus=Window{1a2b u0 com.instagram.android/com.instagram.mainactivity.MainActivity}\n    mKeyguardShowing=false\n",
      ),
    ).toEqual({ awake: true, locked: false, foreground: "com.instagram.android" });
    expect(parseScreenState("")).toEqual({ awake: null, locked: null, foreground: null });
  });

  it("Google account prompts are human checkpoints", () => {
    const node = (text: string) => ({ text, contentDesc: "" }) as never;
    expect(detectBlocker([node("Allow app access?"), node("Yes, it's me")])?.kind).toBe(
      "login_challenge",
    );
    expect(detectBlocker([node("Is it you trying to sign in?")])?.kind).toBe("login_challenge");
    expect(detectBlocker([node("Your story"), node("Edit profile")])).toBeNull();
  });
});
