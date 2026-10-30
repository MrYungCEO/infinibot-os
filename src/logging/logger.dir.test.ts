import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { logInfo } from "../logger.js";
import { resetLogger, resolveDefaultLogDir, setLoggerOverride } from "./logger.js";

describe("log location + permissions", () => {
  afterEach(() => resetLogger());

  it("defaults under the state dir, not a shared /tmp", () => {
    const dir = resolveDefaultLogDir({ INFINIBOT_STATE_DIR: "/srv/ib-state" } as NodeJS.ProcessEnv);
    expect(dir).toBe(path.join("/srv/ib-state", "logs"));
    // The legacy shared dir was exactly /tmp/infinibot (os.tmpdir()/infinibot on
    // Windows). Compare path segments, not a string prefix: test/setup.ts puts
    // HOME under /tmp/infinibot-vitest-home-*, which is a per-user state dir.
    const legacy =
      process.platform === "win32" ? path.join(os.tmpdir(), "infinibot") : "/tmp/infinibot";
    const fallback = resolveDefaultLogDir({} as NodeJS.ProcessEnv);
    expect(fallback === legacy || fallback.startsWith(legacy + path.sep)).toBe(false);
  });

  it("honours INFINIBOT_LOG_DIR", () => {
    expect(resolveDefaultLogDir({ INFINIBOT_LOG_DIR: "/var/log/ib" } as NodeJS.ProcessEnv)).toBe(
      "/var/log/ib",
    );
  });

  it.skipIf(process.platform === "win32")("creates log files 0600", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-log-"));
    const file = path.join(dir, "infinibot-test.log");
    setLoggerOverride({ level: "info", file });
    logInfo("perm-check");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
