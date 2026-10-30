import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../infra/infinibot-root.js", () => ({
  resolveInfiniBotPackageRootSync: vi.fn(() => null),
  resolveInfiniBotPackageRoot: vi.fn().mockResolvedValue(null),
}));
vi.mock("../infra/tailscale.js", () => ({ getTailnetHostname: vi.fn().mockResolvedValue(null) }));

import { decideExpoOffline, detectExpoAuth, readExpoProjectIdentity } from "./expo-runner.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "expo-offline-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("detectExpoAuth (no network: env + ~/.expo/state.json)", () => {
  it("EXPO_TOKEN counts as logged in", () => {
    expect(detectExpoAuth({ EXPO_TOKEN: "abc" }, "/nonexistent")).toEqual({
      loggedIn: true,
      via: "token",
    });
  });

  it("a session in ~/.expo/state.json counts as logged in", () => {
    const home = tmp();
    mkdirSync(join(home, ".expo"));
    writeFileSync(
      join(home, ".expo", "state.json"),
      JSON.stringify({ auth: { sessionSecret: "s", username: "moltbot-ash" } }),
    );
    expect(detectExpoAuth({}, home)).toEqual({
      loggedIn: true,
      via: "session",
      username: "moltbot-ash",
    });
  });

  it("no state file, or a state file without auth, is logged out", () => {
    expect(detectExpoAuth({}, tmp())).toEqual({ loggedIn: false, via: null });
    const home = tmp();
    mkdirSync(join(home, ".expo"));
    writeFileSync(join(home, ".expo", "state.json"), JSON.stringify({ uuid: "x", auth: null }));
    expect(detectExpoAuth({}, home)).toEqual({ loggedIn: false, via: null });
  });

  it("garbage state.json is logged out, not a crash", () => {
    const home = tmp();
    mkdirSync(join(home, ".expo"));
    writeFileSync(join(home, ".expo", "state.json"), "{nope");
    expect(detectExpoAuth({}, home).loggedIn).toBe(false);
  });
});

describe("readExpoProjectIdentity", () => {
  it("reads owner + EAS project id from the gitignored .env.owner over app.json", () => {
    const dir = tmp();
    writeFileSync(join(dir, "app.json"), JSON.stringify({ expo: { name: "x" } }));
    writeFileSync(
      join(dir, ".env.owner"),
      "INFINIBOT_EXPO_OWNER=moltbot-ash\nINFINIBOT_EAS_PROJECT_ID='p-123'\n",
    );
    expect(readExpoProjectIdentity(dir, {})).toEqual({ owner: "moltbot-ash", projectId: "p-123" });
  });

  it("falls back to app.json owner/projectId; empty when the project is unbound", () => {
    const dir = tmp();
    writeFileSync(
      join(dir, "app.json"),
      JSON.stringify({ expo: { owner: "o", extra: { eas: { projectId: "p" } } } }),
    );
    expect(readExpoProjectIdentity(dir, {})).toEqual({ owner: "o", projectId: "p" });
    const bare = tmp();
    writeFileSync(join(bare, "app.json"), JSON.stringify({ expo: {} }));
    expect(readExpoProjectIdentity(bare, {})).toEqual({});
  });
});

describe("decideExpoOffline", () => {
  const owned = { owner: "moltbot-ash", projectId: "p-1" };

  it("logged in → online, so Expo Go gets a signed manifest (the reported bug)", () => {
    const d = decideExpoOffline({
      mode: "lan",
      setting: "auto",
      auth: { loggedIn: true, username: "moltbot-ash" },
      project: owned,
    });
    expect(d.offline).toBe(false);
    expect(d.notice).toBeUndefined();
  });

  it("not logged in + owner-bound project → offline with a clear login notice", () => {
    const d = decideExpoOffline({ mode: "lan", auth: { loggedIn: false }, project: owned });
    expect(d.offline).toBe(true);
    expect(d.notice).toMatch(/npx expo login/);
    expect(d.notice).toMatch(/moltbot-ash/);
    expect(d.notice).toMatch(/EXPO_TOKEN/);
  });

  it("not logged in + unbound project → offline, no notice", () => {
    const d = decideExpoOffline({ mode: "localhost", auth: { loggedIn: false }, project: {} });
    expect(d).toMatchObject({ offline: true });
    expect(d.notice).toBeUndefined();
  });

  it("tunnel mode is always online (ngrok needs the network)", () => {
    expect(
      decideExpoOffline({
        mode: "tunnel",
        setting: true,
        auth: { loggedIn: false },
        project: owned,
      }).offline,
    ).toBe(false);
  });

  it("config override forces either way", () => {
    expect(
      decideExpoOffline({ mode: "lan", setting: true, auth: { loggedIn: true }, project: owned })
        .offline,
    ).toBe(true);
    expect(
      decideExpoOffline({
        mode: "tailscale",
        setting: false,
        auth: { loggedIn: false },
        project: owned,
      }).offline,
    ).toBe(false);
  });
});
