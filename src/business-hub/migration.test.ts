import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listContacts, timeline } from "./contacts.js";
import { openHubDb } from "./db.js";
import { migrateLegacyBusinessData, migrationStatus, type MigrationDeps } from "./migration.js";
import { listDeals } from "./pipeline.js";

function fixtureState() {
  const dir = mkdtempSync(join(tmpdir(), "hub-mig-"));
  mkdirSync(join(dir, "agency-operations"), { recursive: true });
  const adb = new Database(join(dir, "agency-operations", "agency.db"));
  adb.exec("CREATE TABLE clients (id TEXT, name TEXT)");
  adb.close();
  mkdirSync(join(dir, "lead-qualifier-forms"), { recursive: true });
  writeFileSync(
    join(dir, "lead-qualifier-forms", "submissions-roofing.jsonl"),
    [
      JSON.stringify({
        id: "s1",
        ts: "2026-09-01T10:00:00Z",
        data: {
          Email: "pat@roof.example.com",
          Name: "Pat",
          Phone: "555-201-3344",
          Message: "Need a quote",
        },
      }),
      "{torn",
      JSON.stringify({ id: "s2", ts: "2026-09-02T10:00:00Z", data: { name: "No email" } }),
    ].join("\n"),
  );
  return dir;
}

const deps = (stateDir: string): MigrationDeps => ({
  cwd: stateDir,
  loadLeadRows: async () => [
    {
      id: "r1",
      values: {
        Name: "LawnStarter",
        Stage: "Negotiating",
        Email: null,
        Phone: "+1 404-998-4354",
        Website: "https://www.lawnstarter.com",
        "Estimated Value": "1500",
        Tags: "lawn-care,atlanta",
        LeadSource: "Google Maps",
        Temperature: "Warm",
        Notes: "Rating 4.5",
        "Next Step": "Send proposal",
        "Next Action Date": "2026-10-10",
      },
    },
    {
      id: "r2",
      values: {
        Name: "Dana Fox",
        Stage: "Won",
        Email: "dana@fox.example.com",
        Company: null,
        LeadSource: "Manual",
      },
    },
    { id: "r3", values: { Name: "Lost Co", Stage: "lost", LeadSource: "Manual" } },
  ],
  loadAgencyClients: () => [
    {
      id: "cl_1",
      name: "Dana Fox Studio",
      email: "dana@fox.example.com",
      billingEmail: null,
      phone: null,
      pipelineStatus: "active",
      createdAt: 1,
    },
    {
      id: "cl_2",
      name: "Prospect Ltd",
      email: "hi@prospect.example.com",
      billingEmail: null,
      phone: null,
      pipelineStatus: "lead",
      createdAt: 1,
    },
  ],
  migrateIncome: () => 0,
});

describe("legacy migration", () => {
  it("imports leads, agency leads and submissions once, with a backup", async () => {
    const stateDir = fixtureState();
    const db = openHubDb(":memory:");
    const report = (await migrateLegacyBusinessData(db, stateDir, deps(stateDir)))!;
    expect(report.errors).toEqual([]);
    expect(report.backupDir).toBeTruthy();
    expect(readdirSync(report.backupDir!)).toContain("agency-operations__agency.db");
    expect(report).toMatchObject({ leadRows: 3, agencyLeads: 1, submissions: 1, clientLinks: 1 });

    const deals = listDeals(db).deals;
    const lawn = deals.find((d) => d.title === "LawnStarter")!;
    expect(lawn.companyName).toBe("LawnStarter");
    expect(lawn.valueCents).toBe(150000);
    expect(lawn.nextAction).toBe("Send proposal");
    const stageName = (id: string) =>
      (db.prepare("SELECT name FROM stages WHERE id = ?").get(id) as { name: string }).name;
    expect(stageName(lawn.stageId)).toBe("Proposal");
    expect(deals.find((d) => d.title === "Dana Fox")!.status).toBe("won");
    expect(deals.find((d) => d.title === "Lost Co")!.status).toBe("lost");
    expect(deals.find((d) => d.title === "Prospect Ltd")!.clientId).toBe("cl_2");
    const dana = listContacts(db, { search: "dana@" }).contacts[0];
    expect(dana.clientId).toBe("cl_1");
    const pat = listContacts(db, { search: "pat@" }).contacts[0];
    expect(pat.phoneE164).toBe("+15552013344");
    expect(timeline(db, "contact", pat.id).some((a) => a.type === "form.submitted")).toBe(true);
    expect(migrationStatus(db)?.leadRows).toBe(3);

    // Second run is a no-op; a forced run is idempotent.
    expect(await migrateLegacyBusinessData(db, stateDir, deps(stateDir))).toBeNull();
    const again = (await migrateLegacyBusinessData(db, stateDir, deps(stateDir), { force: true }))!;
    expect(again).toMatchObject({ leadRows: 0, agencyLeads: 0, submissions: 0 });
    expect(listDeals(db).total).toBe(deals.length);
  });
});
