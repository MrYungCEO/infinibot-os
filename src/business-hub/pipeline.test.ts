import { describe, expect, it } from "vitest";
import { getContact, timeline, upsertContact, ensureSource } from "./contacts.js";
import { openHubDb } from "./db.js";
import {
  applyEvent,
  createDeal,
  ensureDefaultPipeline,
  listDeals,
  listRules,
  moveDeal,
  pipelineMetrics,
  saveRules,
  saveStages,
  StageRequirementError,
  syncReminders,
  type ReminderSink,
} from "./pipeline.js";

function setup() {
  const db = openHubDb(":memory:");
  const pl = ensureDefaultPipeline(db);
  const st = Object.fromEntries(pl.stages.map((s) => [s.name, s]));
  return { db, pl, st };
}

describe("pipeline", () => {
  it("seeds New → Contacted → Engaged → Qualified → Proposal → Won / Lost once", () => {
    const { db, pl } = setup();
    expect(pl.stages.map((s) => s.name)).toEqual([
      "New",
      "Contacted",
      "Engaged",
      "Qualified",
      "Proposal",
      "Won",
      "Lost",
    ]);
    expect(ensureDefaultPipeline(db).id).toBe(pl.id);
    expect(listRules(db, pl.id).length).toBeGreaterThanOrEqual(5);
  });

  it("enforces required fields per stage", () => {
    const { db, st } = setup();
    const c = upsertContact(db, { name: "Ann", email: "ann@example.com" })!.contact;
    const d = createDeal(db, { title: "Ann site", contactId: c.id });
    expect(() => moveDeal(db, d.id, st.Proposal.id)).toThrow(StageRequirementError);
    try {
      moveDeal(db, d.id, st.Proposal.id);
    } catch (e) {
      expect((e as StageRequirementError).missing).toEqual(["valueCents", "expectedCloseAt"]);
    }
    const moved = moveDeal(db, d.id, st.Proposal.id, {
      patch: { valueCents: 250000, expectedCloseAt: Date.now() + 864e5 },
    });
    expect(moved.stageId).toBe(st.Proposal.id);
    expect(getContact(db, c.id)?.lifecycle).toBe("qualified");
    expect(() => moveDeal(db, d.id, st.Lost.id)).toThrow(/lostReason/);
    const lost = moveDeal(db, d.id, st.Lost.id, { patch: { lostReason: "Budget" } });
    expect(lost.status).toBe("lost");
    expect(timeline(db, "contact", c.id).filter((a) => a.type === "stage.changed")).toHaveLength(2);
  });

  it("moves deals forward from events, never backwards, and fires onWon", () => {
    const { db, st } = setup();
    const c = upsertContact(db, { name: "Bo", email: "bo@example.com" })!.contact;
    const d = createDeal(db, { title: "Bo", contactId: c.id });
    expect(applyEvent(db, c.id, "email.sent")[0]?.stageId).toBe(st.Contacted.id);
    expect(applyEvent(db, c.id, "email.replied")[0]?.stageId).toBe(st.Engaged.id);
    // form submit only applies from New/Contacted → no move from Engaged
    expect(applyEvent(db, c.id, "form.submitted")).toHaveLength(0);
    let won = "";
    const res = applyEvent(db, c.id, "payment.succeeded", {
      valueCents: 9900,
      onWon: (x) => (won = x.id),
    });
    expect(res[0]?.status).toBe("won");
    expect(res[0]?.valueCents).toBe(9900);
    expect(won).toBe(d.id);
    expect(getContact(db, c.id)?.lifecycle).toBe("customer");
  });

  it("lets the owner reconfigure stages and rules safely", () => {
    const { db, pl, st } = setup();
    createDeal(db, { title: "X" }); // in New
    const without = pl.stages.filter((s) => s.name !== "New");
    expect(() => saveStages(db, pl.id, without)).toThrow(/still has 1 deal/);
    const next = saveStages(
      db,
      pl.id,
      [{ name: "Discovery", kind: "open", probability: 15 }, ...without],
      st.Contacted.id,
    );
    expect(next.stages[0].name).toBe("Discovery");
    expect(listDeals(db).deals[0].stageId).toBe(st.Contacted.id);
    expect(() =>
      saveStages(
        db,
        pl.id,
        without.filter((s) => s.kind !== "won"),
      ),
    ).toThrow(/Won/);
    const rules = saveRules(db, pl.id, [
      { event: "form.submitted", toStageId: st.Qualified.id, onlyFrom: [], enabled: true },
    ]);
    expect(rules).toHaveLength(1);
  });

  it("computes conversion, win rate and attribution", () => {
    const { db, st } = setup();
    const src = ensureSource(db, "leadgen", "OpenStreetMap");
    for (let i = 0; i < 4; i++) {
      const d = createDeal(db, { title: `D${i}`, sourceId: src, valueCents: 10000 });
      moveDeal(db, d.id, st.Contacted.id, { force: true });
      if (i < 2) moveDeal(db, d.id, st.Engaged.id, { force: true });
      if (i === 0) moveDeal(db, d.id, st.Won.id, { force: true });
      if (i === 3) moveDeal(db, d.id, st.Lost.id, { patch: { lostReason: "No fit" } });
    }
    const m = pipelineMetrics(db);
    const byName = Object.fromEntries(m.stages.map((s) => [s.name, s]));
    expect(byName.New.reached).toBe(4);
    expect(byName.Contacted.reached).toBe(4);
    expect(byName.Engaged.reached).toBe(2);
    expect(byName.Engaged.conversionFromPrev).toBe(0.5);
    expect(m.winRate).toBe(0.5);
    expect(m.bySource[0]).toMatchObject({
      label: "OpenStreetMap",
      deals: 4,
      won: 1,
      wonCents: 10000,
    });
    expect(m.lostReasons[0]).toEqual({ reason: "No fit", count: 1 });
  });

  it("mirrors next actions into reminder tasks idempotently", async () => {
    const { db, st } = setup();
    const tasks = new Map<string, { title: string; done?: boolean }>();
    const sink: ReminderSink = {
      async create(t) {
        const id = `t${tasks.size + 1}`;
        tasks.set(id, { title: t.title });
        return id;
      },
      async update(id, t) {
        if (!tasks.has(id)) return false;
        tasks.set(id, { title: t.title, done: t.done });
        return true;
      },
    };
    const d = createDeal(db, { title: "Acme", nextAction: "Call back", nextActionAt: Date.now() });
    expect(await syncReminders(db, sink)).toEqual({ created: 1, updated: 0, closed: 0 });
    expect(await syncReminders(db, sink)).toEqual({ created: 0, updated: 1, closed: 0 });
    moveDeal(db, d.id, st.Lost.id, { patch: { lostReason: "x" } });
    expect(await syncReminders(db, sink)).toEqual({ created: 0, updated: 0, closed: 1 });
    expect([...tasks.values()][0].done).toBe(true);
  });
});
