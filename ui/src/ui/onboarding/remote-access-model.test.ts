import { describe, expect, it } from "vitest";
import {
  checklist,
  demoStatus,
  homeScreenSteps,
  installPaths,
  lanBase,
  linkFor,
  otherMappings,
  phoneWebAppUrl,
} from "./remote-access-model";

describe("remote access model", () => {
  it("checklist follows each state", () => {
    const states = (step: Parameters<typeof demoStatus>[0]) => checklist(demoStatus(step)).map((c) => c.state);
    expect(states("install")).toEqual(["todo", "todo", "unknown", "unknown"]);
    expect(states("login")).toEqual(["ok", "todo", "unknown", "unknown"]);
    expect(states("magicdns")).toEqual(["ok", "ok", "todo", "todo"]);
    expect(states("https")).toEqual(["ok", "ok", "ok", "todo"]);
    expect(states("ready")).toEqual(["ok", "ok", "ok", "ok"]);
  });

  it("link and other mappings", () => {
    const ready = demoStatus("ready");
    expect(linkFor(ready)).toBe("https://your-pc.your-tailnet.ts.net:8443");
    expect(otherMappings(ready).map((m) => m.port)).toEqual([443]);
    expect(linkFor(demoStatus("create"))).toBeNull();
  });

  it("install paths are honest about what exists", () => {
    const android = installPaths("android", { available: true, version: "1.0.3" });
    expect(android.map((p) => [p.id, p.status])).toEqual([
      ["apk", "available"],
      ["pwa", "available"],
      ["play", "coming-soon"],
    ]);
    expect(installPaths("android", { available: false })[0]!.status).toBe("needs-setup");
    expect(installPaths("iphone", null).map((p) => [p.id, p.status])).toEqual([
      ["pwa", "available"],
      ["appstore", "coming-soon"],
    ]);
  });

  it("home screen steps are browser specific", () => {
    expect(homeScreenSteps("iphone").join(" ")).toMatch(/Safari.*Share.*Add to Home Screen/);
    expect(homeScreenSteps("android").join(" ")).toMatch(/Chrome.*three-dot.*Add to Home screen/);
  });

  it("phone URLs", () => {
    expect(phoneWebAppUrl("https://a.ts.net:8443/")).toBe("https://a.ts.net:8443/mobile-web/");
    expect(lanBase("192.168.1.13", 18789)).toBe("http://192.168.1.13:18789");
    expect(lanBase(null, 18789)).toBeNull();
  });
});
