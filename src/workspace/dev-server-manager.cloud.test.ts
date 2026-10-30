/** Hosted cloud: Workspace dev servers (host programs) never start for a tenant without a sandbox. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkspaceDevServerManager } from "./dev-server-manager.js";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("workspace dev servers in SaaS / fleet", () => {
  it("refuses to start on a tenant Machine (no INFINIBOT_WORKSPACE_SANDBOX_ROOT) and runs nothing", async () => {
    process.env.SAAS_MODE = "1";
    process.env.FLEET_TENANT_ID = "t-1";
    delete process.env.INFINIBOT_WORKSPACE_SANDBOX_ROOT;
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-wsdev-cloud-"));
    const runTmux = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const m = new WorkspaceDevServerManager({ stateDir, deps: { runTmux } as never });
    await expect(
      m.start({ directoryId: "d1", projectPath: path.join(stateDir, "proj") }),
    ).rejects.toThrow(/disabled in SaaS\/cloud mode/);
    expect(runTmux).not.toHaveBeenCalled();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
});
