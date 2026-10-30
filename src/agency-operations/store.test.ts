import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { AgencyOperationsStore } from "./store.js";
import { parseInvoice } from "./invoice-parser.js";

describe("AgencyOperationsStore", () => {
  let dir: string;
  let store: AgencyOperationsStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agency-operations-"));
    store = new AgencyOperationsStore(join(dir, "operations.sqlite"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs the lead-to-engagement lifecycle with auditable state transitions", () => {
    const client = store.createClient(
      { name: "Acme", billingEmail: "billing@acme.test" },
      { actorId: "human-1" },
    );
    const opportunity = store.createOpportunity({
      clientId: client.id,
      name: "Website redesign",
      valueCents: 2_000_000,
    });
    store.transitionOpportunity(opportunity.id, "qualified", { probability: 0.6 });
    store.transitionOpportunity(opportunity.id, "proposal");

    const proposal = store.createProposal({
      opportunityId: opportunity.id,
      title: "Website SOW",
      scope: "Strategy, design, implementation and launch",
      lineItems: [
        { description: "Discovery", quantity: 1, unitPriceCents: 500_000 },
        { description: "Design and build", quantity: 1, unitPriceCents: 1_500_000 },
      ],
    });
    store.transitionProposal(proposal.id, "internal_review");
    store.transitionProposal(proposal.id, "sent");
    store.transitionProposal(proposal.id, "accepted");
    store.transitionOpportunity(opportunity.id, "won");

    const engagement = store.createEngagement({
      clientId: client.id,
      proposalId: proposal.id,
      name: "Acme website",
      budgetCents: proposal.totalCents,
    });
    expect(store.transitionEngagement(engagement.id, "active").status).toBe("active");
    expect(store.listAuditEvents("proposal", proposal.id).map((event) => event.action)).toEqual([
      "created",
      "status_changed",
      "status_changed",
      "status_changed",
    ]);
  });

  it("blocks lifecycle shortcuts and requires loss context", () => {
    const client = store.createClient({ name: "Prospect" });
    const opportunity = store.createOpportunity({
      clientId: client.id,
      name: "Campaign",
      valueCents: 100_000,
    });
    expect(() => store.transitionOpportunity(opportunity.id, "won")).toThrow(
      "Invalid opportunity transition",
    );
    expect(() => store.transitionOpportunity(opportunity.id, "lost")).toThrow(
      "lostReason required",
    );

    const proposal = store.createProposal({
      opportunityId: opportunity.id,
      title: "Campaign",
      scope: "Launch campaign",
      lineItems: [{ description: "Campaign", quantity: 1, unitPriceCents: 100_000 }],
    });
    expect(() => store.transitionProposal(proposal.id, "accepted")).toThrow(
      "Invalid proposal transition",
    );
    expect(() =>
      store.createEngagement({
        clientId: client.id,
        proposalId: proposal.id,
        name: "Campaign",
        budgetCents: 100_000,
      }),
    ).toThrow("proposal must be accepted");
  });

  it("coordinates deliverables, approvals, and change control", () => {
    const client = store.createClient({ name: "Client" });
    const engagement = store.createEngagement({
      clientId: client.id,
      name: "Site",
      budgetCents: 800_000,
    });
    const milestone = store.createMilestone({
      engagementId: engagement.id,
      name: "Design approval",
    });
    const deliverable = store.createDeliverable({
      engagementId: engagement.id,
      milestoneId: milestone.id,
      name: "Homepage design",
      acceptanceCriteria: "Matches approved brief and passes WCAG checks",
      assigneeType: "hybrid",
      assigneeId: "design-pod",
    });
    for (const state of ["in_progress", "review", "client_review"] as const)
      store.transitionDeliverable(deliverable.id, state);
    const approval = store.requestClientApproval({
      engagementId: engagement.id,
      deliverableId: deliverable.id,
    });
    expect(store.decideClientApproval(approval.id, "approved").status).toBe("approved");
    expect(store.transitionDeliverable(deliverable.id, "approved").status).toBe("approved");

    const change = store.createChangeRequest({
      engagementId: engagement.id,
      title: "Add portal",
      description: "New authenticated portal",
      impactCents: 200_000,
      impactDays: 10,
    });
    for (const state of ["submitted", "approved", "implemented"] as const)
      store.transitionChangeRequest(change.id, state);
    expect(store.getChangeRequest(change.id)?.status).toBe("implemented");
  });

  it("tracks invoice collections and management summary metrics", () => {
    const client = store.createClient({ name: "Paying Client" });
    const opportunity = store.createOpportunity({
      clientId: client.id,
      name: "Retainer",
      valueCents: 1_200_000,
      probability: 0.5,
    });
    store.transitionOpportunity(opportunity.id, "qualified");

    const invoice = store.createInvoice({
      clientId: client.id,
      number: "INV-0001",
      subtotalCents: 1_000_000,
      taxCents: 100_000,
    });
    store.issueInvoice(invoice.id);
    store.recordPayment(invoice.id, { amountCents: 400_000, method: "bank_transfer" });
    expect(store.getInvoice(invoice.id)).toMatchObject({
      status: "partially_paid",
      amountPaidCents: 400_000,
      balanceCents: 700_000,
    });
    store.recordPayment(invoice.id, { amountCents: 700_000 });
    expect(store.getInvoice(invoice.id)?.status).toBe("paid");
    expect(store.businessSummary()).toMatchObject({
      openPipelineCents: 1_200_000,
      weightedPipelineCents: 600_000,
      collectedCents: 1_100_000,
      outstandingInvoicesCents: 0,
    });
  });

  it("ingests invoices idempotently and updates revenue and MRR", () => {
    const project = store.createProject("default", { name: "AI operations rollout" });
    const parsed = parseInvoice({
      structured: {
        invoiceNumber: "INV-MRR-1",
        clientName: "MRR Client",
        issuedAt: "2026-07-05",
        dueAt: "2026-07-15",
        currency: "USD",
        subtotal: 2000,
        total: 2000,
        amountPaid: 2000,
        lineItems: [
          { description: "Monthly AI operations retainer", amount: 2000, cadence: "monthly" },
        ],
      },
    });
    const first = store.ingestParsedInvoice(parsed, {
      sourceText: "fixture",
      sourceName: "invoice.json",
      projectId: project.id,
    });
    const duplicate = store.ingestParsedInvoice(parsed, {
      sourceText: "fixture",
      sourceName: "invoice.json",
    });
    expect(first.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    expect(store.listClients()).toHaveLength(1);
    expect(store.listInvoices()).toHaveLength(1);
    expect(store.listRevenueEntries("default")).toHaveLength(2);
    expect(first.projectLinks).toMatchObject([{ projectId: project.id, allocationCents: 200_000 }]);
    expect(store.getClientRevenueProfile("default", first.client.id)).toMatchObject({
      mrrCents: 200_000,
      arrCents: 2_400_000,
    });
    const summary = store.revenueSummary(
      "default",
      Date.parse("2026-07-01"),
      Date.parse("2026-08-01"),
    );
    expect(summary).toMatchObject({
      invoicedRevenueCents: 200_000,
      collectedRevenueCents: 200_000,
      mrrCents: 200_000,
      activeMrrClients: 1,
      revenueByProject: [
        expect.objectContaining({
          projectId: project.id,
          invoicedCents: 200_000,
          collectedCents: 200_000,
        }),
      ],
    });
  });

  it("sets client and project MRR manually and derives ARR", () => {
    const client = store.createClient({ name: "Manual MRR Client" });
    const project = store.createProject("default", {
      name: "Retainer engagement",
      clientId: client.id,
    });
    expect(store.getProject("default", project.id)).toMatchObject({ mrrCents: 0 });

    const profile = store.setClientMrr("default", client.id, 150_000);
    expect(profile).toMatchObject({ mrrCents: 150_000, arrCents: 1_800_000 });
    expect(store.getClientRevenueProfile("default", client.id)).toMatchObject({
      mrrCents: 150_000,
      arrCents: 1_800_000,
    });
    // A re-set overwrites rather than accumulating, and preserves currency.
    const relowered = store.setClientMrr("default", client.id, 90_000);
    expect(relowered).toMatchObject({ mrrCents: 90_000, arrCents: 1_080_000 });

    const updated = store.setProjectMrr("default", project.id, 45_000);
    expect(updated).toMatchObject({ mrrCents: 45_000 });
    expect(store.getProject("default", project.id)).toMatchObject({ mrrCents: 45_000 });
    // Other project fields survive an MRR-only write.
    expect(updated.name).toBe("Retainer engagement");

    expect(() => store.setClientMrr("default", client.id, -1)).toThrow();
    expect(() => store.setProjectMrr("default", project.id, 12.5)).toThrow();
    expect(() => store.setProjectMrr("default", "missing-project", 100)).toThrow(
      "project not found",
    );
  });

  it("persists partial project and task edits and survives a reload", () => {
    const dbPath = join(dir, "operations.sqlite");
    const client = store.createClient({ name: "Edit Client" });
    const project = store.createProject("default", {
      name: "Original name",
      clientId: client.id,
      budgetCents: 100_000,
    });
    const task = store.createTask("default", {
      projectId: project.id,
      title: "Original title",
      acceptanceCriteria: "done when accepted",
    });

    // A rename-only patch must not clobber the untouched budget/client.
    store.updateProject("default", project.id, { name: "Renamed project" });
    // A budget/deadline patch must not clobber the name we just set.
    const deadline = Date.parse("2026-12-01");
    store.updateProject("default", project.id, {
      budgetCents: 250_000,
      targetEndAt: deadline,
    });
    store.updateTask("default", task.id, {
      title: "Sharper title",
      priority: "high",
      dueAt: deadline,
    });

    // Reopen the database file to prove the writes hit disk, not just cache.
    store.close();
    store = new AgencyOperationsStore(dbPath);
    expect(store.getProject("default", project.id)).toMatchObject({
      name: "Renamed project",
      budgetCents: 250_000,
      targetEndAt: deadline,
      clientId: client.id,
    });
    expect(store.getTask("default", task.id)).toMatchObject({
      title: "Sharper title",
      priority: "high",
      dueAt: deadline,
      projectId: project.id,
    });
  });

  it("supports explicit client attribution when an invoice omits the client name", () => {
    const client = store.createClient({ name: "Existing Client" });
    const parsed = parseInvoice({
      structured: {
        invoiceNumber: "INV-EXPLICIT-CLIENT",
        total: 500,
        lineItems: [{ description: "Implementation", amount: 500 }],
      },
    });
    const result = store.ingestParsedInvoice(parsed, {
      sourceText: "fixture-explicit-client",
      clientId: client.id,
    });
    expect(result.client.id).toBe(client.id);
    expect(result.invoice.clientId).toBe(client.id);
    expect(store.listClients()).toHaveLength(1);
  });

  it("isolates clients, projects, and tasks by agency", () => {
    const agencyA = store.createAgency({
      name: "Agency A",
      slug: "agency-a",
      ownerUserId: "owner-a",
    });
    const agencyB = store.createAgency({
      name: "Agency B",
      slug: "agency-b",
      ownerUserId: "owner-b",
    });
    const a = store.createClient({ name: "Agency A Client" }, { agencyId: agencyA.id });
    store.createClient({ name: "Agency B Client" }, { agencyId: agencyB.id });
    const project = store.createProject(agencyA.id, { name: "Private A project", clientId: a.id });
    const task = store.createTask(agencyA.id, {
      projectId: project.id,
      title: "Private A task",
      acceptanceCriteria: "Reviewed and approved",
      assigneeType: "ai",
      assigneeId: "web-builder",
    });
    expect(store.listClients(agencyA.id).map((client) => client.id)).toEqual([a.id]);
    expect(store.getClient(a.id, agencyB.id)).toBeNull();
    expect(store.getProject(agencyB.id, project.id)).toBeNull();
    expect(store.getTask(agencyB.id, task.id)).toBeNull();
    expect(store.listProjects(agencyB.id)).toEqual([]);
    expect(store.listTasks(agencyB.id)).toEqual([]);
  });

  it("supports owned/shared workspaces and secure expiring invitations", () => {
    const agency = store.createAgency({ name: "Studio", slug: "studio", ownerUserId: "owner" });
    const { invitation, token } = store.createAgencyInvitation(
      {
        agencyId: agency.id,
        email: "designer@example.test",
        role: "member",
        expiresAt: Date.now() + 60_000,
      },
      "owner",
    );
    expect(invitation.tokenHash).not.toBe(token);
    const membership = store.acceptAgencyInvitation(token, "designer", "designer@example.test");
    expect(membership.role).toBe("member");
    expect(store.listAgenciesForUser("owner")[0]).toMatchObject({
      id: agency.id,
      ownership: "owned",
    });
    expect(store.listAgenciesForUser("designer")[0]).toMatchObject({
      id: agency.id,
      ownership: "shared",
    });
    expect(store.setAgencyMemberRole(agency.id, "designer", "viewer", "owner").role).toBe("viewer");
    store.removeAgencyMember(agency.id, "designer", "owner");
    expect(store.listAgenciesForUser("designer")).toEqual([]);
    expect(
      store
        .listAgencyAuditEvents(agency.id, { entityType: "agency_membership" })
        .map((event) => event.action),
    ).toContain("removed");
    expect(() => store.removeAgencyMember(agency.id, "owner", "owner")).toThrow(
      "agency owner cannot be removed",
    );
    expect(() =>
      store.createAgencyInvitation(
        {
          agencyId: agency.id,
          email: "x@example.test",
          role: "admin",
          expiresAt: Date.now() + 60_000,
        },
        "designer",
      ),
    ).toThrow("agency membership required");
  });

  it("enforces project and task operating transitions", () => {
    const agency = store.createAgency({ name: "Ops", slug: "ops", ownerUserId: "owner" });
    const project = store.createProject(agency.id, { name: "Launch", budgetCents: 100_000 });
    expect(() => store.transitionProject(agency.id, project.id, "completed")).toThrow(
      "Invalid project transition",
    );
    store.transitionProject(agency.id, project.id, "active");
    const task = store.createTask(agency.id, {
      projectId: project.id,
      title: "Ship homepage",
      acceptanceCriteria: "QA suite passes",
    });
    for (const status of ["ready", "in_progress", "review", "done"] as const) {
      store.transitionTask(agency.id, task.id, status);
    }
    expect(store.getTask(agency.id, task.id)).toMatchObject({ status: "done" });
  });

  it("reads the recent audit log from an index instead of sorting the whole agency", () => {
    const agency = store.createAgency({ name: "Audited", slug: "audited", ownerUserId: "owner" });
    for (let index = 0; index < 50; index += 1) {
      store.createClient({ name: `Client ${index}` }, { agencyId: agency.id, actorId: "owner" });
    }
    const recent = store.listAgencyAuditEvents(agency.id, { limit: 10 });
    expect(recent).toHaveLength(10);
    // The timeline renders metadata only. Shipping before/after payloads here
    // once made a single page of events tens of megabytes, because one row can
    // hold an entire imported business snapshot.
    expect(recent.every((event) => event.before === null && event.after === null)).toBe(true);
    expect(recent[0]).toMatchObject({ entityType: "client", action: "created" });

    // Without a (agency_id, id) index SQLite materialises every audit row for
    // the agency into a temp B-tree just to return the newest few. On a busy
    // log that blocks the gateway for minutes, because better-sqlite3 is
    // synchronous — so assert the planner never has to sort.
    const db = new Database(join(dir, "operations.sqlite"), { readonly: true });
    try {
      const plan = (
        db
          .prepare(
            "EXPLAIN QUERY PLAN SELECT * FROM audit_events WHERE agency_id=? ORDER BY id DESC LIMIT ?",
          )
          .all(agency.id, 100) as Array<{ detail: string }>
      )
        .map((row) => row.detail)
        .join(" | ");
      expect(plan).not.toMatch(/TEMP B-TREE/i);
    } finally {
      db.close();
    }
  });
});
