import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { GatewayRequestHandlerOptions } from "./types.js";

const stateDir = mkdtempSync(join(tmpdir(), "infinibot-agency-rpc-"));
process.env.INFINIBOT_STATE_DIR = stateDir;

// Imported after the state dir is pinned so the singleton stores resolve to it.
const { agencyOperationsHandlers } = await import("./agency-operations.js");
const { getAgencyOperationsStore } = await import("../../agency-operations/store.js");
const { getWorkforceStore } = await import("../../workforce/store.js");

const AGENCY_ID = "agency-rpc-test";
const dbPath = join(stateDir, "agency-operations", "agency.db");

type Response = { ok: boolean; result?: any; error?: { code: string; message: string } };

async function call(method: string, params: Record<string, unknown>): Promise<Response> {
  let response: Response | null = null;
  const opts = {
    params,
    client: null,
    respond: (ok: boolean, result?: unknown, error?: { code: string; message: string }) => {
      response = { ok, result, error } as Response;
    },
  } as unknown as GatewayRequestHandlerOptions;
  await agencyOperationsHandlers[method](opts);
  if (!response) throw new Error(`${method} did not respond`);
  return response;
}

let employeeId = "";
let managerId = "";

beforeAll(() => {
  const store = getAgencyOperationsStore(stateDir);
  store.createAgency({
    id: AGENCY_ID,
    name: "RPC Test Agency",
    slug: "rpc-test-agency",
    ownerUserId: "local-owner",
  });
  const workforce = getWorkforceStore(dbPath);
  employeeId = workforce.createWorker(
    { agencyId: AGENCY_ID, type: "human", displayName: "Jo", title: "Designer" },
    "local-owner",
  ).id;
  managerId = workforce.createWorker(
    { agencyId: AGENCY_ID, type: "ai", displayName: "Vega", title: "Development Head" },
    "local-owner",
  ).id;
});

afterAll(() => {
  try {
    // Windows keeps the sqlite handle busy until the process exits; best effort.
    rmSync(stateDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("agency.ops.employee.update", () => {
  it("is registered alongside its siblings", () => {
    expect(typeof agencyOperationsHandlers["agency.ops.employee.update"]).toBe("function");
    expect(typeof agencyOperationsHandlers["agency.ops.employee.deactivate"]).toBe("function");
  });

  it("updates name, role, department, manager and capacity", async () => {
    const response = await call("agency.ops.employee.update", {
      agencyId: AGENCY_ID,
      employeeId,
      name: "Jo Bell",
      role: "Front End Developer",
      department: "Engineering",
      managerWorkerId: managerId,
      capacityHours: 32,
      status: "focused",
    });

    expect(response.ok).toBe(true);
    const employee = response.result.employee;
    expect(employee.displayName).toBe("Jo Bell");
    expect(employee.title).toBe("Front End Developer");
    expect(employee.managerWorkerId).toBe(managerId);
    expect(employee.weeklyCapacityHours).toBe(32);
    expect(employee.currentStatus).toBe("focused");
    expect(employee.departmentId).toBeTruthy();

    const workforce = getWorkforceStore(dbPath);
    expect(workforce.getWorker(AGENCY_ID, employeeId)?.displayName).toBe("Jo Bell");
    // Audited like its siblings.
    expect(
      workforce.listAuditEntries(AGENCY_ID).some((entry) => entry.action === "worker.updated"),
    ).toBe(true);
  });

  it("rejects unknown employees, self-management and empty patches", async () => {
    const missing = await call("agency.ops.employee.update", {
      agencyId: AGENCY_ID,
      employeeId: "nope",
      name: "X",
    });
    expect(missing.ok).toBe(false);
    expect(missing.error?.message).toMatch(/not found/);

    const self = await call("agency.ops.employee.update", {
      agencyId: AGENCY_ID,
      employeeId,
      managerWorkerId: employeeId,
    });
    expect(self.ok).toBe(false);
    expect(self.error?.message).toMatch(/cannot manage themselves/);

    const empty = await call("agency.ops.employee.update", { agencyId: AGENCY_ID, employeeId });
    expect(empty.ok).toBe(false);
    expect(empty.error?.message).toMatch(/no updatable fields/);
  });

  it("requires owner/admin access", async () => {
    // An agency the caller is not a member of.
    getAgencyOperationsStore(stateDir).createAgency({
      id: "foreign-agency",
      name: "Foreign",
      slug: "foreign",
      ownerUserId: "someone-else",
    });
    const forbidden = await call("agency.ops.employee.update", {
      agencyId: "foreign-agency",
      employeeId,
      name: "X",
    });
    expect(forbidden.ok).toBe(false);
    expect(forbidden.error?.code).toBe("FORBIDDEN");
  });
});

describe("agency.ops.employee.deactivate", () => {
  it("transitions employment status and drops the worker off the active roster", async () => {
    const response = await call("agency.ops.employee.deactivate", {
      agencyId: AGENCY_ID,
      employeeId,
    });
    expect(response.ok).toBe(true);
    expect(response.result.employee.employmentStatus).toBe("inactive");
    expect(response.result.employee.currentStatus).toBe("offline");

    const active = getWorkforceStore(dbPath).listWorkers(AGENCY_ID, { status: "active" });
    expect(active.map((worker) => worker.id)).not.toContain(employeeId);
  });

  it("rejects an unsupported target status", async () => {
    const response = await call("agency.ops.employee.deactivate", {
      agencyId: AGENCY_ID,
      employeeId,
      employmentStatus: "active",
    });
    expect(response.ok).toBe(false);
    expect(response.error?.message).toMatch(/employmentStatus must be one of/);
  });
});
