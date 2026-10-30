import { describe, expect, it } from "vitest";
import { attachDesktopDeepLinks, deepLinkToWebRoute, withBasePath } from "./deep-link-route";

const plugins = [
  {
    id: "solatrix",
    status: "loaded",
    enabled: true,
    contributes: {
      pages: [
        { tab: "solatrix", route: "/solatrix" },
        { tab: "solatrix-bubblemap", route: "/solatrix/bubble-map" },
      ],
    },
  },
];

describe("deep-link-route", () => {
  it("routes the three legacy kinds", () => {
    expect(deepLinkToWebRoute("infinibot://activity/session/agent%3Amain%3Amain", [])).toBe(
      "/webchat?session=agent%3Amain%3Amain",
    );
    expect(deepLinkToWebRoute("infinibot://board/task/t1", [])).toBe("/projects?task=t1");
    expect(deepLinkToWebRoute("infinibot://discipline", [])).toBe("/discipline");
  });

  it("routes the new kinds and plugin pages", () => {
    expect(deepLinkToWebRoute("infinibot://runs/r1", [])).toBe("/reviews?run=r1");
    expect(deepLinkToWebRoute("infinibot://approvals/a1", [])).toBe(
      "/autonomy?view=approvals&approval=a1",
    );
    expect(deepLinkToWebRoute("infinibot://goals/g1", [])).toBe("/autonomy?view=goals&goal=g1");
    expect(deepLinkToWebRoute("mobile://chat?sessionKey=s1", [])).toBe("/webchat?session=s1");
    expect(deepLinkToWebRoute("/solatrix/bubble-map?mint=M", plugins)).toBe(
      "/solatrix/bubble-map?mint=M",
    );
    expect(deepLinkToWebRoute("infinibot://plugin/solatrix/bubble-map?mint=M", plugins)).toBe(
      "/solatrix/bubble-map?mint=M",
    );
    expect(deepLinkToWebRoute("infinibot://plugin/solatrix/wallets", plugins)).toBe(
      "/solatrix?section=wallets",
    );
  });

  it("rejects unusable links and applies the base path", () => {
    expect(deepLinkToWebRoute("javascript:alert(1)", [])).toBeNull();
    expect(deepLinkToWebRoute(null, [])).toBeNull();
    expect(withBasePath("/reviews?run=r1", "/ui/")).toBe("/ui/reviews?run=r1");
    expect(withBasePath("/reviews", "")).toBe("/reviews");
  });

  it("routes the marketplace's desktop install link to the Plugins page", () => {
    expect(deepLinkToWebRoute("infinibot://web/plugins?install=flypic", [])).toBe("/plugins?install=flypic");
    // A paid plugin's purchase page adds its install entitlement; it rides along untouched.
    expect(deepLinkToWebRoute("infinibot://web/plugins?install=flypic&entitlement=ibin1.p.abc.1790000000.sig", [])).toBe(
      "/plugins?install=flypic&entitlement=ibin1.p.abc.1790000000.sig",
    );
    expect(deepLinkToWebRoute("/plugins?install=flypic&source=marketplace", [])).toBe(
      "/plugins?install=flypic&source=marketplace",
    );
  });

  it("subscribes to the desktop shell's deep links only when the bridge exists", () => {
    expect(attachDesktopDeepLinks(() => "", undefined, undefined)()).toBeUndefined();
    let cb: ((url: string) => void) | null = null;
    let off = 0;
    const stop = attachDesktopDeepLinks(() => "", undefined, {
      onDeepLink: (fn) => {
        cb = fn;
        return () => void off++;
      },
    });
    expect(typeof cb).toBe("function");
    stop();
    expect(off).toBe(1);
  });
});
