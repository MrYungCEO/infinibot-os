import { describe, expect, it } from "vitest";
import type { InfinibotConfig } from "../config/config.js";
import {
  buildDeepLink,
  deepLinkPath,
  isTelegramButtonUrl,
  linkPair,
  normalizeDeepLink,
  resolvePublicBaseUrl,
  webOpenerUrl,
  webRouteForDeepLink,
  type LinkPluginInfo,
} from "./links.js";

const PLUGINS: LinkPluginInfo[] = [
  {
    id: "infinitrade",
    status: "loaded",
    enabled: true,
    contributes: {
      pages: [
        { tab: "infinitrade-signals", route: "/infinitrade/signals" },
        { tab: "infinitrade", route: "/infinitrade" },
        { tab: "infinitrade-journal", route: "/infinitrade/journal" },
      ],
    },
  },
  {
    id: "solatrix",
    status: "loaded",
    contributes: {
      pages: [
        { tab: "solatrix-bubblemap", route: "/solatrix/bubble-map" },
        { tab: "solatrix-alerts", route: "/solatrix/alerts" },
        { tab: "solatrix", route: "/solatrix" },
      ],
    },
  },
  {
    id: "discipline",
    status: "loaded",
    contributes: { pages: [{ tab: "discipline", route: "/discipline" }] },
  },
  {
    id: "off-plugin",
    status: "disabled",
    enabled: false,
    contributes: { pages: [{ tab: "off", route: "/off" }] },
  },
];

describe("buildDeepLink", () => {
  it("builds every kind", () => {
    expect(buildDeepLink({ kind: "home" })).toBe("infinibot://");
    expect(buildDeepLink({ kind: "run", runId: "r 1" })).toBe("infinibot://runs/r%201");
    expect(buildDeepLink({ kind: "run" })).toBe("infinibot://runs");
    expect(buildDeepLink({ kind: "approval", id: "apv1" })).toBe("infinibot://approvals/apv1");
    expect(buildDeepLink({ kind: "goal", id: "g1" })).toBe("infinibot://goals/g1");
    expect(buildDeepLink({ kind: "phase", id: "p1" })).toBe("infinibot://phases/p1");
    expect(buildDeepLink({ kind: "scheduled", taskId: "t1" })).toBe("infinibot://scheduled/t1");
    expect(buildDeepLink({ kind: "document", id: "d1" })).toBe("infinibot://documents/d1");
    expect(buildDeepLink({ kind: "session", sessionKey: "agent:main:main" })).toBe(
      "infinibot://chat/agent%3Amain%3Amain",
    );
    expect(buildDeepLink({ kind: "task", taskId: "k1" })).toBe("infinibot://board/task/k1");
    expect(
      buildDeepLink({
        kind: "plugin",
        pluginId: "infinitrade",
        page: "signals",
        query: { signal: "abc" },
      }),
    ).toBe("infinibot://plugin/infinitrade/signals?signal=abc");
    expect(buildDeepLink({ kind: "plugins", pluginId: "solatrix" })).toBe(
      "infinibot://plugins/solatrix",
    );
    expect(buildDeepLink({ kind: "web", path: "/solatrix/alerts?x=1" })).toBe(
      "infinibot://web/solatrix/alerts?x=1",
    );
  });
});

describe("normalizeDeepLink", () => {
  it("canonicalizes legacy forms", () => {
    expect(normalizeDeepLink("mobile://chat?sessionKey=agent%3Amain%3Amain")).toBe(
      "infinibot://chat/agent%3Amain%3Amain",
    );
    expect(normalizeDeepLink("/solatrix/alerts")).toBe("infinibot://web/solatrix/alerts");
    expect(normalizeDeepLink("/infinitrade?section=signals")).toBe(
      "infinibot://web/infinitrade?section=signals",
    );
    expect(normalizeDeepLink("infinibot://activity/session/abc")).toBe(
      "infinibot://activity/session/abc",
    );
    expect(normalizeDeepLink("https://x.ts.net/m/approvals/a1?y=2")).toBe(
      "infinibot://approvals/a1?y=2",
    );
    expect(normalizeDeepLink("discipline")).toBe("infinibot://discipline");
  });
  it("rejects unsafe or empty input", () => {
    expect(normalizeDeepLink("")).toBeNull();
    expect(normalizeDeepLink(null)).toBeNull();
    expect(normalizeDeepLink("javascript:alert(1)")).toBeNull();
    expect(normalizeDeepLink("//evil.com/x")).toBeNull();
    expect(normalizeDeepLink("https://evil.com/phish")).toBeNull();
  });
});

describe("webRouteForDeepLink", () => {
  const r = (l: string) => webRouteForDeepLink(l, { plugins: PLUGINS });
  it("maps the core table", () => {
    expect(r("infinibot://")).toBe("/dashboard");
    expect(r("infinibot://home")).toBe("/dashboard");
    expect(r("infinibot://chat/agent%3Amain%3Amain")).toBe("/webchat?session=agent%3Amain%3Amain");
    expect(r("infinibot://activity/session/abc")).toBe("/webchat?session=abc");
    expect(r("infinibot://board/task/t1")).toBe("/projects?task=t1");
    expect(r("infinibot://board")).toBe("/projects");
    expect(r("infinibot://business")).toBe("/business-hq");
    expect(r("infinibot://knowledge")).toBe("/notes");
    expect(r("infinibot://documents/d1")).toBe("/documents/d1");
    expect(r("infinibot://runs/r1")).toBe("/reviews?run=r1");
    expect(r("infinibot://approvals/a1")).toBe("/autonomy?view=approvals&approval=a1");
    expect(r("infinibot://goals/g1")).toBe("/autonomy?view=goals&goal=g1");
    expect(r("infinibot://learn")).toBe("/learn");
    expect(r("infinibot://learn/infinitrade")).toBe("/learn/infinitrade");
    expect(r("infinibot://learn/goals/first-goal")).toBe("/learn/goals?walkthrough=first-goal");
    expect(r("infinibot://phases/p1")).toBe("/autonomy?view=phases&phase=p1");
    expect(r("infinibot://scheduled/t1")).toBe("/autonomy?view=scheduled&task=t1");
    expect(r("infinibot://plugins/solatrix")).toBe("/plugins?plugin=solatrix");
    expect(r("infinibot://settings")).toBe("/setup");
    expect(r("infinibot://discipline")).toBe("/discipline");
    expect(r("infinibot://web/solatrix/alerts?x=1")).toBe("/solatrix/alerts?x=1");
  });
  it("resolves plugin pages", () => {
    expect(r("infinibot://plugin/infinitrade/signals?signal=abc")).toBe(
      "/infinitrade/signals?signal=abc",
    );
    expect(r("infinibot://plugin/infinitrade")).toBe("/infinitrade");
    expect(r("infinibot://plugin/solatrix/bubble-map?mint=M")).toBe("/solatrix/bubble-map?mint=M");
    expect(r("infinibot://plugin/solatrix/alerts")).toBe("/solatrix/alerts");
    expect(r("infinibot://plugin/infinitrade/terminal")).toBe("/infinitrade?section=terminal");
    expect(r("infinibot://plugin/off-plugin")).toBe("/plugins?plugin=off-plugin");
    expect(r("infinibot://plugin/nope/x")).toBe("/plugins?plugin=nope");
  });
  it("passes queries through without overriding mapped keys", () => {
    expect(r("infinibot://runs/r1?run=evil&tab=log")).toBe("/reviews?run=r1&tab=log");
  });
  it("never produces a protocol-relative or foreign route", () => {
    expect(r("infinibot://web//evil.com")).toBe("/evil.com");
    expect(r("javascript:alert(1)")).toBe("/dashboard");
    expect(r("infinibot://%2F%2Fevil.com")).toMatch(/^\/[^/]/);
  });
});

describe("public base + opener", () => {
  const cfg = (c: Partial<InfinibotConfig>) => c as InfinibotConfig;
  it("follows env → federation → tailscale → null", () => {
    expect(
      resolvePublicBaseUrl(cfg({}), { env: { INFINIBOT_PUBLIC_URL: "https://ib.example.com/" } }),
    ).toBe("https://ib.example.com");
    expect(
      resolvePublicBaseUrl(
        cfg({ federation: { publicUrl: "wss://node.example.com/federation" } } as never),
        {
          env: {},
        },
      ),
    ).toBe("https://node.example.com");
    expect(
      resolvePublicBaseUrl(cfg({ gateway: { tailscale: { mode: "serve" } } } as never), {
        env: {},
        tailnetHost: "box.tail1.ts.net.",
      }),
    ).toBe("https://box.tail1.ts.net");
    expect(
      resolvePublicBaseUrl(cfg({ gateway: { bind: "tailnet", port: 18789 } } as never), {
        env: {},
        tailnetHost: "box.tail1.ts.net",
      }),
    ).toBe("http://box.tail1.ts.net:18789");
    expect(
      resolvePublicBaseUrl(cfg({ gateway: { bind: "loopback" } } as never), {
        env: {},
        tailnetHost: "box.tail1.ts.net",
      }),
    ).toBeNull();
    expect(resolvePublicBaseUrl(cfg({}), { env: {} })).toBeNull();
    expect(
      resolvePublicBaseUrl(cfg({}), { env: { INFINIBOT_PUBLIC_URL: "javascript:x" } }),
    ).toBeNull();
  });
  it("builds opener URLs and pairs", () => {
    expect(
      webOpenerUrl("infinibot://plugin/infinitrade/signals?signal=abc", "https://h.example"),
    ).toBe("https://h.example/m/plugin/infinitrade/signals?signal=abc");
    expect(deepLinkPath("infinibot://chat/a%3Ab")).toBe("chat/a%3Ab");
    expect(linkPair({ kind: "approval", id: "a1" }, null, { base: "https://h.example" })).toEqual({
      deepLink: "infinibot://approvals/a1",
      webUrl: "https://h.example/m/approvals/a1",
    });
    expect(linkPair("mobile://chat?sessionKey=s1", null, { base: null })).toEqual({
      deepLink: "infinibot://chat/s1",
      webUrl: null,
    });
  });
  it("vets Telegram button URLs", () => {
    expect(isTelegramButtonUrl("https://box.tail1.ts.net/m/runs/r1")).toBe(true);
    expect(isTelegramButtonUrl("http://box.tail1.ts.net:18789/m/x")).toBe(true);
    expect(isTelegramButtonUrl("http://localhost:18789/m/x")).toBe(false);
    expect(isTelegramButtonUrl("http://100.64.0.1:18789/m/x")).toBe(false);
    expect(isTelegramButtonUrl("infinibot://x")).toBe(false);
    expect(isTelegramButtonUrl(null)).toBe(false);
  });
});
