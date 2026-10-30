import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgencyFunnelStore } from "./funnel-store.js";
import { AgencyOperationsStore } from "./store.js";

describe("AgencyFunnelStore", () => {
  let dir: string;
  let dbPath: string;
  let operations: AgencyOperationsStore;
  let funnels: AgencyFunnelStore;
  let agencyId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agency-funnels-"));
    dbPath = join(dir, "agency.db");
    operations = new AgencyOperationsStore(dbPath);
    agencyId = operations.createAgency({
      name: "Funnel Agency",
      slug: `funnel-${Date.now()}`,
      ownerUserId: "owner",
    }).id;
    funnels = new AgencyFunnelStore(dbPath);
  });

  afterEach(() => {
    funnels.close();
    operations.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("preserves legacy IDs and isolates complete funnel graphs by agency", () => {
    const other = operations.createAgency({
      name: "Other",
      slug: `other-${Date.now()}`,
      ownerUserId: "other",
    });
    const funnel = funnels.createFunnel(agencyId, {
      id: "canonical-sales",
      legacyFunnelId: "legacy-sales-123",
      name: "Sales",
      kind: "sales",
      objective: "Convert qualified demand into signed work",
    });
    const source = funnels.createNode(agencyId, funnel.id, {
      nodeType: "source",
      name: "Qualified lead",
    });
    const exit = funnels.createNode(agencyId, funnel.id, { nodeType: "exit", name: "Signed SOW" });
    funnels.createEdge(agencyId, funnel.id, { sourceNodeId: source.id, targetNodeId: exit.id });
    expect(funnels.getFunnel(agencyId, "legacy-sales-123")?.id).toBe("canonical-sales");
    expect(funnels.getFunnel(other.id, funnel.id)).toBeNull();
    expect(() => funnels.listNodes(other.id, funnel.id)).toThrow("funnel not found");
  });

  it("blocks activation until setup is complete and emits agent-readable gaps", () => {
    const funnel = funnels.createFunnel(agencyId, {
      name: "Client onboarding",
      kind: "client_onboarding",
      objective: "Reach kickoff readiness",
    });
    funnels.transitionFunnel(agencyId, funnel.id, "setup");
    const source = funnels.createNode(agencyId, funnel.id, {
      nodeType: "source",
      name: "Contract signed",
    });
    const exit = funnels.createNode(agencyId, funnel.id, {
      nodeType: "exit",
      name: "Kickoff complete",
    });
    funnels.createEdge(agencyId, funnel.id, { sourceNodeId: source.id, targetNodeId: exit.id });
    const connection = funnels.upsertConnection(agencyId, funnel.id, {
      provider: "Stripe",
      connectionKey: "stripe.primary",
    });
    const requirement = funnels.createRequirement(agencyId, funnel.id, {
      connectionId: connection.id,
      kind: "integration",
      name: "Connect Stripe",
    });
    expect(() => funnels.transitionFunnel(agencyId, funnel.id, "ready")).toThrow(
      "critical readiness",
    );
    expect(
      funnels.getOperatingContext(agencyId, funnel.id).recommendedActions.length,
    ).toBeGreaterThan(0);
    funnels.setRequirementStatus(agencyId, requirement.id, "satisfied", { verifiedBy: "owner" });
    funnels.recordHealthCheck(agencyId, funnel.id, {
      targetType: "connection",
      targetId: connection.id,
      status: "healthy",
    });
    expect(funnels.transitionFunnel(agencyId, funnel.id, "ready").status).toBe("ready");
    expect(funnels.transitionFunnel(agencyId, funnel.id, "live").status).toBe("live");
  });

  it("records KPI telemetry, detects performance gaps, and builds the UI overview", () => {
    const funnel = funnels.createFunnel(agencyId, {
      name: "Lead generation",
      kind: "lead_generation",
      objective: "Generate qualified calls",
      ownerId: "growth-agent",
    });
    const source = funnels.createNode(agencyId, funnel.id, { nodeType: "source", name: "Traffic" });
    const exit = funnels.createNode(agencyId, funnel.id, { nodeType: "exit", name: "Booked call" });
    funnels.createEdge(agencyId, funnel.id, { sourceNodeId: source.id, targetNodeId: exit.id });
    const kpi = funnels.defineKpi(agencyId, funnel.id, {
      key: "booking_rate",
      name: "Booking rate",
      unit: "percent",
      targetValue: 10,
      warningValue: 7,
    });
    funnels.recordKpi(agencyId, kpi.id, 5);
    const overview = funnels.getOverview(agencyId, funnel.id);
    expect(overview.kpis[0]).toMatchObject({ value: 5, target: 10, status: "critical" });
    expect(overview.gaps.some((gap) => gap.id.startsWith("kpi_off_target"))).toBe(true);
    expect(overview.gaps[0]).toHaveProperty("ownerWorkerId");
  });

  it("models core and sub-funnels in one operating context", () => {
    const core = funnels.createFunnel(agencyId, {
      name: "Agency revenue",
      kind: "sales",
      objective: "Create profitable clients",
    });
    const sub = funnels.createSubFunnel(agencyId, core.id, {
      name: "Proposal follow-up",
      kind: "sales",
      objective: "Obtain a buying decision",
    });
    expect(
      funnels.getOperatingContext(agencyId, core.id).subFunnels.map((item) => item.id),
    ).toEqual([sub.id]);
  });

  it("supports operator-map bootstrap and automatic core-funnel discovery", () => {
    const emptyAgency = operations.createAgency({
      name: "Empty",
      slug: `empty-${Date.now()}`,
      ownerUserId: "owner",
    });
    expect(funnels.getOverview(emptyAgency.id)).toMatchObject({
      coreFunnel: null,
      healthScore: 0,
      setupPercent: 0,
    });
    const core = funnels.createFunnel(agencyId, {
      name: "Core operating funnel",
      kind: "delivery",
      objective: "Deliver accepted work",
    });
    expect(funnels.getOverview(agencyId).coreFunnel?.id).toBe(core.id);
    expect(funnels.getCoreOperatingContext(agencyId)?.funnel.id).toBe(core.id);
  });

  it("continuously reconciles legacy funnel snapshots without graph drift", () => {
    const first = funnels.reconcileLegacySnapshot(agencyId, {
      funnel: { id: "legacy-1", name: "Legacy sales", type: "sales", status: "active" },
      stages: [
        { id: "stage-a", name: "Lead", type: "entry", position: 0 },
        { id: "stage-b", name: "Won", type: "exit", position: 1 },
      ],
      edges: [{ id: "edge-a-b", sourceStageId: "stage-a", targetStageId: "stage-b" }],
    });
    expect(first).toMatchObject({ legacyFunnelId: "legacy-1", status: "live" });
    expect(funnels.listNodes(agencyId, first.id)).toHaveLength(2);
    expect(funnels.listEdges(agencyId, first.id)).toHaveLength(1);

    funnels.reconcileLegacySnapshot(agencyId, {
      funnel: { id: "legacy-1", name: "Renamed sales", type: "marketing", status: "paused" },
      stages: [{ id: "stage-a", name: "Qualified lead", type: "entry", position: 0 }],
      edges: [],
    });
    expect(funnels.getFunnel(agencyId, "legacy-1")).toMatchObject({
      id: first.id,
      name: "Renamed sales",
      kind: "lead_generation",
      status: "paused",
    });
    expect(funnels.listNodes(agencyId, first.id).map((node) => node.name)).toEqual([
      "Qualified lead",
    ]);
    expect(funnels.listEdges(agencyId, first.id)).toEqual([]);
    expect(funnels.archiveLegacyFunnel(agencyId, "legacy-1")).toBe(true);
    expect(funnels.getFunnel(agencyId, "legacy-1")?.status).toBe("archived");
  });
});
