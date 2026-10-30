/**
 * Agent device control: screen parsing from uiautomator dumps in the real
 * on-device format, and agentControlDevice()'s agent actions driven through
 * the real AdbDeviceAdapter against a FAKE adb (extensions/droid-swarm/test/
 * fake-bin). No hardware is touched: the fake is first on PATH and the real
 * platform-tools directories are removed from PATH for the duration.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import {
  compactHierarchy,
  locate,
  parseCurrentApp,
  parseDeviceProps,
  parseNetwork,
  parsePackages,
  selectorFrom,
} from "./agent-device.js";
import { parseHierarchy } from "./ui-automation.js";
import { assertHumanCheckpoint, ComplianceViolationError } from "./compliance.js";
import { AndroidOpsStore } from "./store.js";
import { AndroidOpsService } from "./service.js";
import { AdbDeviceAdapter } from "./adapters/adb.js";
import { NullStreamAdapter } from "./adapters/null-device.js";
import { LocalStorageAdapter } from "./adapters/storage.js";
import { resolveBin } from "../agents/coder-backend/bin-detect.js";

const FAKE_BIN = resolve(import.meta.dirname, "../../extensions/droid-swarm/test/fake-bin");
const FIXTURES = resolve(import.meta.dirname, "../../extensions/droid-swarm/test/fixtures");
const loginXml = readFileSync(join(FIXTURES, "ui-login.xml"), "utf8");
const captchaXml = readFileSync(join(FIXTURES, "ui-captcha.xml"), "utf8");

describe("uiautomator dump parsing (real dump format)", () => {
  const nodes = parseHierarchy(loginXml);

  it("reads every node, entities decoded, extra flags kept", () => {
    expect(nodes).toHaveLength(11);
    const footer = nodes.find((n) => n.resourceId.endsWith("footer"))!;
    expect(footer.text).toBe("Terms & Privacy\nMeta");
    const scroll = nodes.find((n) => n.className.endsWith("ScrollView"))!;
    expect(scroll.scrollable).toBe(true);
    expect(nodes.every((n) => n.packageName === "com.instagram.android")).toBe(true);
  });

  it("does not confuse text with hint-text style attributes", () => {
    const xml = `<hierarchy><node index="0" hint-text="Search" text="" resource-id="a" class="android.widget.EditText" bounds="[0,0][10,10]" /></hierarchy>`;
    expect(parseHierarchy(xml)[0].text).toBe("");
  });

  it("compacts to the nameable elements and never echoes a password field", () => {
    const { elements, totalNodes, truncated } = compactHierarchy(nodes);
    expect(totalNodes).toBe(11);
    expect(truncated).toBe(false);
    // the anonymous root FrameLayout is dropped
    expect(elements.length).toBe(10);
    const pw = elements.find((e) => e.id?.endsWith(":id/password"))!;
    expect(pw.password).toBe(true);
    expect(pw.text).toBe("•••");
    const login = elements.find((e) => e.text === "Log in")!;
    expect(login.cls).toBe("TextView");
    expect(login.center).toEqual([540, 1323]);
    expect(compactHierarchy(nodes, { all: true }).elements).toHaveLength(11);
    expect(compactHierarchy(nodes, { limit: 3 })).toMatchObject({ truncated: true });
  });

  it("locates a label inside a clickable container and taps the container", () => {
    const hit = locate(nodes, selectorFrom({ exactText: "Log in" }))!;
    expect(hit.element.id).toBe("com.instagram.android:id/button_container");
    expect(hit.tap).toEqual({ x: 540, y: 1323 });
    const byDesc = locate(nodes, selectorFrom({ label: "create new account" }))!;
    expect(byDesc.element.desc).toBe("Create new account");
    expect(locate(nodes, selectorFrom({ resourceId: "login_username" }))!.element.focused).toBe(
      true,
    );
    expect(locate(nodes, selectorFrom({ text: "nope" }))).toBeNull();
  });

  it("rejects an empty selector", () => {
    expect(() => selectorFrom({})).toThrow(/Name the element/);
    expect(() => selectorFrom({ text: "   " })).toThrow(/Name the element/);
  });
});

describe("device readouts", () => {
  it("parses the foreground activity", () => {
    expect(
      parseCurrentApp(
        "  topResumedActivity=ActivityRecord{8a1f2 u0 com.instagram.android/com.instagram.mainactivity.LauncherActivity t12}",
      ),
    ).toEqual({
      package: "com.instagram.android",
      activity: "com.instagram.mainactivity.LauncherActivity",
    });
    expect(
      parseCurrentApp(
        "    mResumedActivity: ActivityRecord{1 u0 com.android.settings/.Settings t3}",
      ),
    ).toEqual({
      package: "com.android.settings",
      activity: "com.android.settings.Settings",
    });
    expect(parseCurrentApp("nothing here")).toBeNull();
  });

  it("parses getprop, ip addr and pm list", () => {
    expect(
      parseDeviceProps(
        "[ro.product.model]: [Pixel 8]\n[ro.build.version.release]: [14]\n[x.y]: [z]\n",
      ),
    ).toEqual({
      model: "Pixel 8",
      androidVersion: "14",
    });
    expect(
      parseNetwork(
        "1: lo    inet 127.0.0.1/8 scope host lo\n21: tun0    inet 100.64.0.4/32 scope global tun0\n",
      ),
    ).toEqual([{ iface: "tun0", family: "ipv4", address: "100.64.0.4" }]);
    expect(parsePackages("package:b.app\npackage:a.app\ngarbage line\n")).toEqual([
      "a.app",
      "b.app",
    ]);
  });
});

describe("compliance: agent actors cannot clear human checkpoints", () => {
  it("refuses namespaced agent actors, accepts a named operator", () => {
    for (const actor of ["agent", "agent:mcp", "agent:main:mcp-123", "Agent/main"]) {
      expect(() => assertHumanCheckpoint(actor)).toThrow(ComplianceViolationError);
    }
    expect(() => assertHumanCheckpoint("operator:alice")).not.toThrow();
  });
});

describe("agentControlDevice agent actions over a fake adb", () => {
  let dir: string;
  let store: AndroidOpsStore;
  let service: AndroidOpsService;
  let deviceId: string;
  const savedPath = process.env.PATH;
  const savedScreen = process.env.FAKE_ADB_SCREEN;
  const savedLog = process.env.FAKE_ADB_LOG;
  let screenFile: string;
  let logFile: string;

  beforeAll(() => {
    // Fake first; drop every PATH dir that holds a real adb.
    const rest = (savedPath ?? "").split(delimiter).filter((d) => d && !existsSync(join(d, "adb")));
    process.env.PATH = [FAKE_BIN, ...rest].join(delimiter);
  });
  afterAll(() => {
    process.env.PATH = savedPath;
    if (savedScreen === undefined) delete process.env.FAKE_ADB_SCREEN;
    else process.env.FAKE_ADB_SCREEN = savedScreen;
    if (savedLog === undefined) delete process.env.FAKE_ADB_LOG;
    else process.env.FAKE_ADB_LOG = savedLog;
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "android-ops-agent-"));
    screenFile = join(dir, "screen");
    logFile = join(dir, "adb.log");
    writeFileSync(screenFile, "ui-login");
    process.env.FAKE_ADB_SCREEN = screenFile;
    process.env.FAKE_ADB_LOG = logFile;
    store = new AndroidOpsStore(dir);
    service = new AndroidOpsService(store, {
      device: new AdbDeviceAdapter(join(dir, "bundles")),
      stream: new NullStreamAdapter(),
      storage: new LocalStorageAdapter(join(dir, "media")),
    });
    deviceId = service.registerDevice(
      { label: "Phone 01", serial: "fake-01", model: "Pixel 8" },
      "operator:test",
    ).id;
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const calls = () =>
    existsSync(logFile)
      ? readFileSync(logFile, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as string[])
      : [];

  it("resolves the fake adb, never a real one", () => {
    expect(resolveBin("adb")).toBe(join(FAKE_BIN, "adb"));
  });

  it("ui_dump returns compact elements and audits", async () => {
    const out = await service.agentControlDevice(
      { deviceId, action: "ui_dump" },
      "agent:main:test",
    );
    expect(out.ok).toBe(true);
    const r = out.result as { elements: unknown[]; foreground: string; blocker: unknown };
    expect(r.foreground).toBe("com.instagram.android");
    expect(r.elements).toHaveLength(10);
    expect(r.blocker).toBeNull();
    const audit = store
      .listAudit({ limit: 5 })
      .find((a) => a.action === "device.agent_control.ui_dump")!;
    expect(audit.actor).toBe("agent:main:test");
  });

  it("find_and_tap taps the element centre", async () => {
    const out = await service.agentControlDevice(
      { deviceId, action: "find_and_tap", selector: { exactText: "Log in" } },
      "agent:main:test",
    );
    expect(out.ok).toBe(true);
    expect(calls()).toContainEqual(["-s", "fake-01", "shell", "input", "tap", "540", "1323"]);
  });

  it("find_and_tap refuses on a CAPTCHA screen and taps nothing", async () => {
    writeFileSync(screenFile, "ui-captcha");
    const out = await service.agentControlDevice(
      { deviceId, action: "find_and_tap", selector: { label: "not a robot" } },
      "agent:main:test",
    );
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/Human checkpoint on screen \(captcha\)/);
    expect(calls().some((c) => c.includes("tap"))).toBe(false);
    expect(parseHierarchy(captchaXml)[2].text).toBe("I'm not a robot");
  });

  it("wait_for sees an element appear, and times out when it never does", async () => {
    const found = await service.agentControlDevice(
      { deviceId, action: "wait_for", selector: { text: "Forgot password" }, timeoutMs: 2000 },
      "agent:main:test",
    );
    expect(found.ok).toBe(true);
    const gone = await service.agentControlDevice(
      {
        deviceId,
        action: "wait_for",
        selector: { text: "Forgot password" },
        gone: true,
        timeoutMs: 600,
      },
      "agent:main:test",
    );
    expect(gone.ok).toBe(false);
    expect(gone.reason).toMatch(/Timed out after 600 ms/);
  });

  it("current_app, list_apps, device_info, stop", async () => {
    const cur = await service.agentControlDevice({ deviceId, action: "current_app" }, "a");
    expect(cur.result).toEqual({
      package: "com.instagram.android",
      activity: "com.instagram.mainactivity.LauncherActivity",
    });
    const apps = await service.agentControlDevice({ deviceId, action: "list_apps" }, "a");
    expect((apps.result as { packages: string[] }).packages).toContain("com.tailscale.ipn");
    const info = await service.agentControlDevice({ deviceId, action: "device_info" }, "a");
    expect(info.result).toMatchObject({
      props: { model: "Pixel 8", androidVersion: "14" },
      battery: { pct: 87, charging: true },
      wifi: { ssid: "RackNet", signalDbm: -51 },
    });
    expect(
      (info.result as { network: Array<{ address: string }> }).network.map((n) => n.address),
    ).toContain("100.64.0.4");
    const stop = await service.agentControlDevice(
      { deviceId, action: "stop", package: "com.instagram.android" },
      "a",
    );
    expect(stop.ok).toBe(true);
    expect(calls()).toContainEqual([
      "-s",
      "fake-01",
      "shell",
      "am",
      "force-stop",
      "com.instagram.android",
    ]);
    await expect(
      service.agentControlDevice({ deviceId, action: "stop", package: "x; rm -rf /" }, "a"),
    ).rejects.toThrow(/package must be/);
  });

  it("install / uninstall / push_media validate inputs and report Success", async () => {
    const apk = join(dir, "app.apk");
    writeFileSync(apk, "PK fake apk");
    const inst = await service.agentControlDevice(
      { deviceId, action: "install", apkPath: apk },
      "a",
    );
    expect(inst.ok).toBe(true);
    expect(calls()).toContainEqual(["-s", "fake-01", "install", "-r", apk]);
    await expect(
      service.agentControlDevice({ deviceId, action: "install", apkPath: "relative.apk" }, "a"),
    ).rejects.toThrow(/absolute/);
    await expect(
      service.agentControlDevice(
        { deviceId, action: "install", apkPath: join(dir, "missing.apk") },
        "a",
      ),
    ).rejects.toThrow(/No APK/);
    const un = await service.agentControlDevice(
      { deviceId, action: "uninstall", package: "com.example.app" },
      "a",
    );
    expect(un.ok).toBe(true);

    mkdirSync(join(dir, "media", "lib"), { recursive: true });
    writeFileSync(join(dir, "media", "lib", "clip.mp4"), "fake video");
    const asset = await service.registerMedia(
      {
        title: "Clip",
        kind: "video",
        storageKey: "lib/clip.mp4",
        caption: "",
        hashtags: [],
        platforms: [],
        durationSec: 3,
        sizeBytes: 10,
      },
      "operator:test",
    );
    const push = await service.agentControlDevice(
      { deviceId, action: "push_media", mediaId: asset.id },
      "a",
    );
    expect(push.ok).toBe(true);
    expect(calls()).toContainEqual([
      "-s",
      "fake-01",
      "push",
      join(dir, "media", "lib", "clip.mp4"),
      "/sdcard/Movies/",
    ]);
    await expect(
      service.agentControlDevice(
        { deviceId, action: "push_media", mediaId: asset.id, dest: "/sdcard/../data" },
        "a",
      ),
    ).rejects.toThrow(/dest must be/);
  });

  it("abortProvisioning cancels a run and keeps the record", () => {
    const run = service.startProvisioning({
      handle: "demo.handle",
      platform: "instagram",
      deviceId,
      actor: "operator:test",
    });
    const aborted = service.abortProvisioning(run.id, "agent:main:test", "test");
    expect(aborted.state).toBe("aborted");
    expect(store.getProvisioning(run.id)?.state).toBe("aborted");
    expect(
      store
        .listAudit({ limit: 3 })
        .some((a) => a.action === "provisioning.abort" && a.actor === "agent:main:test"),
    ).toBe(true);
  });
});
