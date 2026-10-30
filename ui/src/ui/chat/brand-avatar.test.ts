import { describe, expect, it, beforeEach } from "vitest";
import { resolveBrandLogoUrl } from "../controllers/app-branding";
import { renderBrandAvatar } from "./brand-avatar";
import { renderAvatar } from "./grouped-render";

const CACHE_KEY = "infinibot.branding.cache.v4";
const cache = (branding: Record<string, string>) =>
  localStorage.setItem(
    CACHE_KEY,
    JSON.stringify({ theme: { mode: "dark", paletteId: "x", tokens: {} }, branding, palettes: [] }),
  );

describe("brand logo avatar", () => {
  beforeEach(() => localStorage.removeItem(CACHE_KEY));

  it("falls back to the default logo, anchored to the app root", () => {
    expect(resolveBrandLogoUrl()).toBe("/infinibot-logo.png");
  });

  it("stays root-anchored on a nested route (/webchat/<session>)", () => {
    const prev = (globalThis as any).location;
    (globalThis as any).location = { pathname: "/webchat/agent:main:abc" };
    try {
      expect(resolveBrandLogoUrl()).toBe("/infinibot-logo.png");
    } finally {
      (globalThis as any).location = prev;
    }
  });

  it("anchors the default logo to a configured base path, not the route", () => {
    (window as any).__INFINIBOT_CONTROL_UI_BASE_PATH__ = "/ui/";
    try {
      expect(resolveBrandLogoUrl()).toBe("/ui/infinibot-logo.png");
    } finally {
      delete (window as any).__INFINIBOT_CONTROL_UI_BASE_PATH__;
    }
  });

  it("prefers data URL, then URL, from cached branding", () => {
    cache({ appName: "Acme", logoUrl: "https://acme.test/logo.png" });
    expect(resolveBrandLogoUrl()).toBe("https://acme.test/logo.png");
    cache({ appName: "Acme", logoUrl: "https://acme.test/logo.png", logoDataUrl: "data:image/png;base64,AA" });
    expect(resolveBrandLogoUrl()).toBe("data:image/png;base64,AA");
    // custom logos are shown whole (no emblem crop)
    expect(renderBrandAvatar("x", "Acme").values).toEqual(["x", "", "data:image/png;base64,AA", "Acme"]);
  });

  it("uses live branding when passed", () => {
    expect(resolveBrandLogoUrl({ appName: "X", logoUrl: "/l.png" })).toBe("/l.png");
  });

  it("renders an img with the logo and alt text", () => {
    const tpl = renderBrandAvatar("wc-avatar", "Main");
    expect(tpl.strings.join("")).toContain("<img");
    expect(tpl.values).toEqual(["wc-avatar", " chat-logo-avatar--mark", "/infinibot-logo.png", "Main"]);
  });

  it("renderAvatar: assistant → logo, user/tool unchanged", () => {
    const a = renderAvatar("assistant", { name: "Jarvis", avatar: "J" });
    expect(a.strings.join("")).toContain("<img");
    expect(a.values).toEqual(["chat-avatar assistant", " chat-logo-avatar--mark", "/infinibot-logo.png", "Jarvis"]);
    const u = renderAvatar("user");
    expect(u.strings.join("")).toContain("<div");
    expect(u.values).toEqual(["user", "U"]);
    expect(renderAvatar("tool").values).toEqual(["tool", "⚙"]);
  });
});
