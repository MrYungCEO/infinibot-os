/**
 * Real Chrome: the secure profile is a separate browser on tmpfs that shares
 * nothing with the normal profile and is wiped when it stops; the normal
 * profile keeps a session cookie across a browser restart.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const CHROME = ["/opt/google/chrome/google-chrome", "/usr/bin/chromium"].find((p) =>
  fs.existsSync(p),
);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ib-browser-secure-"));

describe.skipIf(!CHROME || process.env.INFINIBOT_SKIP_BROWSER_E2E === "1")(
  "browser profile isolation (real Chrome)",
  () => {
    let runtime: typeof import("./runtime.js");
    let control: typeof import("../control-service.js");
    let store: typeof import("./profile-store.js");

    beforeAll(async () => {
      vi.resetModules();
      const stateDir = path.join(root, "state");
      fs.mkdirSync(stateDir, { recursive: true });
      const cfgPath = path.join(stateDir, "infinibot.json");
      // A gateway port far from the live one so the derived CDP range never collides.
      fs.writeFileSync(
        cfgPath,
        JSON.stringify({
          gateway: { port: 19560 },
          browser: { enabled: true, headless: true, executablePath: CHROME },
        }),
      );
      process.env.INFINIBOT_STATE_DIR = stateDir;
      process.env.INFINIBOT_CONFIG_PATH = cfgPath;
      runtime = await import("./runtime.js");
      control = await import("../control-service.js");
      store = await import("./profile-store.js");
    }, 30_000);

    afterAll(async () => {
      await control?.stopBrowserControlService().catch(() => {});
      fs.rmSync(root, { recursive: true, force: true });
    }, 30_000);

    it("keeps secure and normal profiles apart and wipes the secure one on stop", async () => {
      const normal = await runtime.openManagedProfile("default");
      await normal.context.addCookies([
        { name: "normal_sid", value: "n1", domain: "example.test", path: "/" },
      ]);
      const secure = await runtime.openManagedProfile("secure");
      expect(secure.cdpUrl).not.toBe(normal.cdpUrl);
      const secureDir = store.userDataDirForManagedProfile("secure");
      expect(secureDir.startsWith(path.join(root, "state"))).toBe(false);
      expect(fs.existsSync(secureDir)).toBe(true);
      expect(await secure.context.cookies()).toEqual([]);
      await secure.context.addCookies([
        { name: "secret_sid", value: "s1", domain: "example.test", path: "/" },
      ]);
      expect((await normal.context.cookies()).map((c) => c.name)).toEqual(["normal_sid"]);

      await control.createBrowserControlContext().forProfile("secure").stopRunningBrowser();
      await expect.poll(() => fs.existsSync(secureDir), { timeout: 10_000 }).toBe(false);

      // Relaunch: the secure profile starts empty again.
      const again = await runtime.openManagedProfile("secure");
      expect(await again.context.cookies()).toEqual([]);
    }, 90_000);

    it("brings a normal profile's session cookie back after its browser restarts", async () => {
      const h = await runtime.openManagedProfile("default");
      await h.context.addCookies([
        { name: "sid", value: "keep-me", domain: "example.test", path: "/" },
      ]);
      const ctx = control.createBrowserControlContext().forProfile(h.managed);
      await ctx.stopRunningBrowser();
      const userDataDir = store.userDataDirForManagedProfile(h.managed);
      expect(store.readProfileLock(userDataDir)).toBeNull();
      const back = await runtime.openManagedProfile("default");
      const names = (await back.context.cookies()).map((c) => `${c.name}=${c.value}`);
      expect(names).toContain("sid=keep-me");
      expect(store.readProfileLock(userDataDir)?.pid).toBe(process.pid);
    }, 90_000);
  },
);
