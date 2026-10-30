/**
 * Business hub — the funnel pipeline: configurable stages with required
 * fields, deals, event-driven stage automation, conversion metrics and
 * next-action reminders (mirrored into kanban as tasks).
 *
 * Default pipeline: New → Contacted → Engaged → Qualified → Proposal → Won / Lost.
 * Every move goes through `moveDeal` (validates required fields, logs a
 * `stage.changed` activity); events go through `applyEvent`.
 */

import type { HubDb } from "./db.js";
import { getMeta, setMeta } from "./db.js";
import { getContact, logActivity, tagsFor, updateContact } from "./contacts.js";
import { hubId, parseJson, str } from "./util.js";
import { coerceString } from "../shared/text/coerce.js";

export type StageKind = "open" | "won" | "lost";

export type Stage = {
  id: string;
  pipelineId: string;
  name: string;
  position: number;
  kind: StageKind;
  probability: number;
  requiredFields: string[];
  rotDays: number | null;
  color: string | null;
};

export type Pipeline = { id: string; name: string; isDefault: boolean; stages: Stage[] };

export type Deal = {
  id: string;
  businessId: string | null;
  title: string;
  pipelineId: string;
  stageId: string;
  status: "open" | "won" | "lost";
  valueCents: number;
  currency: string;
  probability: number | null;
  expectedCloseAt: number | null;
  nextAction: string | null;
  nextActionAt: number | null;
  lostReason: string | null;
  contactId: string | null;
  companyId: string | null;
  clientId: string | null;
  sourceId: string | null;
  campaignId: string | null;
  projectId: string | null;
  kanbanTaskId: string | null;
  owner: string | null;
  stageEnteredAt: number;
  wonAt: number | null;
  lostAt: number | null;
  custom: Record<string, unknown>;
  legacyRef: string | null;
  createdAt: number;
  updatedAt: number;
};

export type DealView = Deal & {
  contactName: string | null;
  contactEmail: string | null;
  companyName: string | null;
  sourceName: string | null;
  campaignName: string | null;
  tags: string[];
  /** Days since the deal entered its stage. */
  ageDays: number;
  /** True when the stage has rot_days and the deal has sat longer. */
  rotting: boolean;
};

export type PipelineEvent =
  | "email.replied"
  | "email.clicked"
  | "form.submitted"
  | "meeting.booked"
  | "payment.succeeded"
  | "email.sent";

export const PIPELINE_EVENTS: readonly PipelineEvent[] = [
  "email.sent",
  "email.clicked",
  "email.replied",
  "form.submitted",
  "meeting.booked",
  "payment.succeeded",
];

/** Fields a stage can require before a deal may enter it. */
export const REQUIRABLE_FIELDS = [
  "valueCents",
  "contactId",
  "companyId",
  "expectedCloseAt",
  "nextAction",
  "nextActionAt",
  "lostReason",
  "contactEmail",
  "owner",
] as const;

const DEFAULT_STAGES: Array<Omit<Stage, "id" | "pipelineId" | "position">> = [
  { name: "New", kind: "open", probability: 5, requiredFields: [], rotDays: 3, color: "#8a8f98" },
  {
    name: "Contacted",
    kind: "open",
    probability: 10,
    requiredFields: ["contactId"],
    rotDays: 5,
    color: "#6e9bd1",
  },
  {
    name: "Engaged",
    kind: "open",
    probability: 25,
    requiredFields: [],
    rotDays: 7,
    color: "#58b4a8",
  },
  {
    name: "Qualified",
    kind: "open",
    probability: 45,
    requiredFields: ["nextAction"],
    rotDays: 10,
    color: "#d6b25e",
  },
  {
    name: "Proposal",
    kind: "open",
    probability: 70,
    requiredFields: ["valueCents", "expectedCloseAt"],
    rotDays: 14,
    color: "#e09a4f",
  },
  {
    name: "Won",
    kind: "won",
    probability: 100,
    requiredFields: ["valueCents"],
    rotDays: null,
    color: "#3fbf7f",
  },
  {
    name: "Lost",
    kind: "lost",
    probability: 0,
    requiredFields: ["lostReason"],
    rotDays: null,
    color: "#c45b5b",
  },
];

/** Default automation: (event, target stage name, only from these stage names). */
const DEFAULT_RULES: Array<[PipelineEvent, string, string[]]> = [
  ["email.sent", "Contacted", ["New"]],
  ["email.replied", "Engaged", ["New", "Contacted"]],
  ["email.clicked", "Engaged", ["New", "Contacted"]],
  ["form.submitted", "Engaged", ["New", "Contacted"]],
  ["meeting.booked", "Qualified", ["New", "Contacted", "Engaged"]],
  ["payment.succeeded", "Won", []],
];

type Row = Record<string, unknown>;

function rowToStage(r: Row): Stage {
  return {
    id: r.id as string,
    pipelineId: r.pipeline_id as string,
    name: r.name as string,
    position: r.position as number,
    kind: r.kind as StageKind,
    probability: r.probability as number,
    requiredFields: parseJson<string[]>(r.required_fields, []),
    rotDays: (r.rot_days as number) ?? null,
    color: (r.color as string) ?? null,
  };
}

function rowToDeal(r: Row): Deal {
  return {
    id: r.id as string,
    businessId: (r.business_id as string) ?? null,
    title: r.title as string,
    pipelineId: r.pipeline_id as string,
    stageId: r.stage_id as string,
    status: r.status as Deal["status"],
    valueCents: Number(r.value_cents ?? 0),
    currency: (r.currency as string) ?? "USD",
    probability: (r.probability as number) ?? null,
    expectedCloseAt: (r.expected_close_at as number) ?? null,
    nextAction: (r.next_action as string) ?? null,
    nextActionAt: (r.next_action_at as number) ?? null,
    lostReason: (r.lost_reason as string) ?? null,
    contactId: (r.contact_id as string) ?? null,
    companyId: (r.company_id as string) ?? null,
    clientId: (r.client_id as string) ?? null,
    sourceId: (r.source_id as string) ?? null,
    campaignId: (r.campaign_id as string) ?? null,
    projectId: (r.project_id as string) ?? null,
    kanbanTaskId: (r.kanban_task_id as string) ?? null,
    owner: (r.owner as string) ?? null,
    stageEnteredAt: r.stage_entered_at as number,
    wonAt: (r.won_at as number) ?? null,
    lostAt: (r.lost_at as number) ?? null,
    custom: parseJson(r.custom, {}),
    legacyRef: (r.legacy_ref as string) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

// ── Pipelines + stages ────────────────────────────────────────────────────────

/** The default pipeline, seeded on first use with stages and automation rules. */
export function ensureDefaultPipeline(db: HubDb): Pipeline {
  const row = db.prepare("SELECT * FROM pipelines WHERE is_default = 1 LIMIT 1").get() as
    | Row
    | undefined;
  if (row) return getPipeline(db, row.id as string)!;
  const now = Date.now();
  const id = hubId("pl");
  db.transaction(() => {
    db.prepare(
      "INSERT INTO pipelines(id,name,is_default,created_at,updated_at) VALUES(?,?,1,?,?)",
    ).run(id, "Sales", now, now);
    const ids = new Map<string, string>();
    DEFAULT_STAGES.forEach((s, i) => {
      const sid = hubId("st");
      ids.set(s.name, sid);
      db.prepare(
        "INSERT INTO stages(id,pipeline_id,name,position,kind,probability,required_fields,rot_days,color,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        sid,
        id,
        s.name,
        i,
        s.kind,
        s.probability,
        JSON.stringify(s.requiredFields),
        s.rotDays,
        s.color,
        now,
        now,
      );
    });
    for (const [event, to, from] of DEFAULT_RULES) {
      db.prepare(
        "INSERT INTO stage_rules(id,pipeline_id,event,to_stage_id,only_from,enabled,created_at) VALUES(?,?,?,?,?,1,?)",
      ).run(
        hubId("rule"),
        id,
        event,
        ids.get(to),
        JSON.stringify(from.map((n) => ids.get(n))),
        now,
      );
    }
  })();
  return getPipeline(db, id)!;
}

export function getPipeline(db: HubDb, id: string): Pipeline | null {
  const row = db.prepare("SELECT * FROM pipelines WHERE id = ?").get(id) as Row | undefined;
  if (!row) return null;
  const stages = (
    db.prepare("SELECT * FROM stages WHERE pipeline_id = ? ORDER BY position").all(id) as Row[]
  ).map(rowToStage);
  return { id, name: row.name as string, isDefault: Boolean(row.is_default), stages };
}

export function listPipelines(db: HubDb): Pipeline[] {
  ensureDefaultPipeline(db);
  return (
    db.prepare("SELECT id FROM pipelines ORDER BY is_default DESC, created_at").all() as Array<{
      id: string;
    }>
  ).map((r) => getPipeline(db, r.id)!);
}

function stageById(db: HubDb, id: string): Stage | null {
  const r = db.prepare("SELECT * FROM stages WHERE id = ?").get(id) as Row | undefined;
  return r ? rowToStage(r) : null;
}

/**
 * Replace a pipeline's stage list (create / rename / reorder / reconfigure /
 * delete). Deleting a stage that still holds deals requires `moveDealsTo`.
 * Exactly one won and at least one lost stage must remain.
 */
export function saveStages(
  db: HubDb,
  pipelineId: string,
  stages: Array<Partial<Stage> & { name: string }>,
  moveDealsTo?: string,
): Pipeline {
  const pipeline = getPipeline(db, pipelineId);
  if (!pipeline) throw new Error("pipeline not found");
  if (stages.filter((s) => (s.kind ?? "open") === "won").length !== 1)
    throw new Error("a pipeline needs exactly one Won stage");
  if (!stages.some((s) => s.kind === "lost")) throw new Error("a pipeline needs a Lost stage");
  const names = new Set<string>();
  for (const s of stages) {
    const n = s.name.trim().toLowerCase();
    if (!n) throw new Error("stage names cannot be empty");
    if (names.has(n)) throw new Error(`duplicate stage name: ${s.name}`);
    names.add(n);
    for (const f of s.requiredFields ?? [])
      if (!(REQUIRABLE_FIELDS as readonly string[]).includes(f))
        throw new Error(`unknown required field: ${f}`);
  }
  const now = Date.now();
  db.transaction(() => {
    const keep = new Set(stages.map((s) => s.id).filter(Boolean) as string[]);
    for (const old of pipeline.stages) {
      if (keep.has(old.id)) continue;
      const n = (
        db.prepare("SELECT COUNT(*) AS n FROM deals WHERE stage_id = ?").get(old.id) as {
          n: number;
        }
      ).n;
      if (n > 0) {
        if (!moveDealsTo || moveDealsTo === old.id)
          throw new Error(`stage "${old.name}" still has ${n} deal(s); choose where to move them`);
        db.prepare(
          "UPDATE deals SET stage_id = ?, stage_entered_at = ?, updated_at = ? WHERE stage_id = ?",
        ).run(moveDealsTo, now, now, old.id);
      }
      db.prepare("DELETE FROM stage_rules WHERE to_stage_id = ?").run(old.id);
      db.prepare("DELETE FROM stages WHERE id = ?").run(old.id);
    }
    stages.forEach((s, i) => {
      const vals = [
        s.name.trim(),
        i,
        s.kind ?? "open",
        Math.max(0, Math.min(100, s.probability ?? 0)),
        JSON.stringify(s.requiredFields ?? []),
        s.rotDays ?? null,
        s.color ?? null,
        now,
      ];
      if (s.id && pipeline.stages.some((o) => o.id === s.id)) {
        db.prepare(
          "UPDATE stages SET name=?, position=?, kind=?, probability=?, required_fields=?, rot_days=?, color=?, updated_at=? WHERE id=?",
        ).run(...vals, s.id);
      } else {
        db.prepare(
          "INSERT INTO stages(id,pipeline_id,name,position,kind,probability,required_fields,rot_days,color,updated_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        ).run(hubId("st"), pipelineId, ...vals, now);
      }
    });
  })();
  return getPipeline(db, pipelineId)!;
}

export type StageRule = {
  id: string;
  event: PipelineEvent;
  toStageId: string;
  onlyFrom: string[];
  enabled: boolean;
};

export function listRules(db: HubDb, pipelineId: string): StageRule[] {
  return (
    db
      .prepare("SELECT * FROM stage_rules WHERE pipeline_id = ? ORDER BY created_at")
      .all(pipelineId) as Row[]
  ).map((r) => ({
    id: r.id as string,
    event: r.event as PipelineEvent,
    toStageId: r.to_stage_id as string,
    onlyFrom: parseJson<string[]>(r.only_from, []),
    enabled: Boolean(r.enabled),
  }));
}

export function saveRules(
  db: HubDb,
  pipelineId: string,
  rules: Array<Omit<StageRule, "id"> & { id?: string }>,
): StageRule[] {
  const stageIds = new Set((getPipeline(db, pipelineId)?.stages ?? []).map((s) => s.id));
  db.transaction(() => {
    db.prepare("DELETE FROM stage_rules WHERE pipeline_id = ?").run(pipelineId);
    for (const r of rules) {
      if (!PIPELINE_EVENTS.includes(r.event)) throw new Error(`unknown event: ${r.event}`);
      if (!stageIds.has(r.toStageId)) throw new Error("rule targets a stage outside this pipeline");
      db.prepare(
        "INSERT INTO stage_rules(id,pipeline_id,event,to_stage_id,only_from,enabled,created_at) VALUES(?,?,?,?,?,?,?)",
      ).run(
        r.id ?? hubId("rule"),
        pipelineId,
        r.event,
        r.toStageId,
        JSON.stringify(r.onlyFrom.filter((s) => stageIds.has(s))),
        r.enabled ? 1 : 0,
        Date.now(),
      );
    }
  })();
  return listRules(db, pipelineId);
}

// ── Deals ─────────────────────────────────────────────────────────────────────

export type DealInput = {
  title?: string;
  pipelineId?: string;
  stageId?: string;
  valueCents?: number;
  currency?: string;
  probability?: number | null;
  expectedCloseAt?: number | null;
  nextAction?: string | null;
  nextActionAt?: number | null;
  lostReason?: string | null;
  contactId?: string | null;
  companyId?: string | null;
  clientId?: string | null;
  sourceId?: string | null;
  campaignId?: string | null;
  projectId?: string | null;
  owner?: string | null;
  custom?: Record<string, unknown>;
  businessId?: string | null;
};

export function getDeal(db: HubDb, id: string): Deal | null {
  const r = db.prepare("SELECT * FROM deals WHERE id = ?").get(id) as Row | undefined;
  return r ? rowToDeal(r) : null;
}

/** Missing required fields for `stage`, checked against the merged deal. */
export function missingFields(db: HubDb, deal: Partial<Deal>, stage: Stage): string[] {
  const missing: string[] = [];
  for (const f of stage.requiredFields) {
    if (f === "contactEmail") {
      const c = deal.contactId ? getContact(db, deal.contactId) : null;
      if (!c?.email) missing.push(f);
      continue;
    }
    const v = (deal as Record<string, unknown>)[f];
    if (v === null || v === undefined || v === "" || (f === "valueCents" && Number(v) <= 0))
      missing.push(f);
  }
  return missing;
}

export class StageRequirementError extends Error {
  constructor(
    readonly stage: string,
    readonly missing: string[],
  ) {
    super(`"${stage}" needs: ${missing.join(", ")}`);
  }
}

export function createDeal(
  db: HubDb,
  input: DealInput,
  opts: { actor?: string | null; legacyRef?: string | null; enforce?: boolean } = {},
): Deal {
  const pipeline = input.pipelineId ? getPipeline(db, input.pipelineId) : ensureDefaultPipeline(db);
  if (!pipeline) throw new Error("pipeline not found");
  const stage = input.stageId
    ? pipeline.stages.find((s) => s.id === input.stageId)
    : pipeline.stages[0];
  if (!stage) throw new Error("stage not found in pipeline");
  let title = str(input.title);
  if (!title && input.contactId) title = getContact(db, input.contactId)?.name ?? null;
  if (!title && input.companyId)
    title =
      (
        db.prepare("SELECT name FROM companies WHERE id = ?").get(input.companyId) as
          | { name?: string }
          | undefined
      )?.name ?? null;
  if (!title) throw new Error("title required");
  if (opts.enforce !== false) {
    const missing = missingFields(db, input as Partial<Deal>, stage);
    if (missing.length) throw new StageRequirementError(stage.name, missing);
  }
  const now = Date.now();
  const id = hubId("dl");
  const status = stage.kind === "won" ? "won" : stage.kind === "lost" ? "lost" : "open";
  db.prepare(
    `INSERT INTO deals(id,business_id,title,pipeline_id,stage_id,status,value_cents,currency,probability,expected_close_at,next_action,next_action_at,lost_reason,contact_id,company_id,client_id,source_id,campaign_id,project_id,owner,stage_entered_at,won_at,lost_at,custom,legacy_ref,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    input.businessId ?? null,
    title,
    pipeline.id,
    stage.id,
    status,
    Math.max(0, Math.round(input.valueCents ?? 0)),
    (input.currency ?? "USD").toUpperCase(),
    input.probability ?? null,
    input.expectedCloseAt ?? null,
    str(input.nextAction),
    input.nextActionAt ?? null,
    str(input.lostReason),
    input.contactId ?? null,
    input.companyId ?? null,
    input.clientId ?? null,
    input.sourceId ?? null,
    input.campaignId ?? null,
    input.projectId ?? null,
    str(input.owner),
    now,
    status === "won" ? now : null,
    status === "lost" ? now : null,
    JSON.stringify(input.custom ?? {}),
    opts.legacyRef ?? null,
    now,
    now,
  );
  logActivity(db, {
    subjectType: "deal",
    subjectId: id,
    type: "created",
    summary: `Deal created in ${stage.name}`,
    actor: opts.actor,
    data: { stageId: stage.id, stage: stage.name, valueCents: input.valueCents ?? 0 },
  });
  if (input.contactId) bumpLifecycleForStage(db, input.contactId, stage);
  return getDeal(db, id)!;
}

export function updateDeal(db: HubDb, id: string, patch: DealInput, actor?: string | null): Deal {
  const cur = getDeal(db, id);
  if (!cur) throw new Error("deal not found");
  const map: Array<[keyof DealInput, string]> = [
    ["title", "title"],
    ["valueCents", "value_cents"],
    ["currency", "currency"],
    ["probability", "probability"],
    ["expectedCloseAt", "expected_close_at"],
    ["nextAction", "next_action"],
    ["nextActionAt", "next_action_at"],
    ["lostReason", "lost_reason"],
    ["contactId", "contact_id"],
    ["companyId", "company_id"],
    ["clientId", "client_id"],
    ["sourceId", "source_id"],
    ["campaignId", "campaign_id"],
    ["projectId", "project_id"],
    ["owner", "owner"],
  ];
  const sets: string[] = [];
  const vals: unknown[] = [];
  const changed: string[] = [];
  for (const [k, col] of map) {
    if (patch[k] === undefined) continue;
    let v = patch[k] as unknown;
    if (k === "valueCents") v = Math.max(0, Math.round(Number(v) || 0));
    if (k === "currency") v = coerceString(v || "USD").toUpperCase();
    if (typeof v === "string") v = v.trim() || null;
    sets.push(`${col} = ?`);
    vals.push(v);
    changed.push(k);
  }
  if (patch.custom) {
    sets.push("custom = ?");
    vals.push(JSON.stringify({ ...cur.custom, ...patch.custom }));
  }
  if (sets.length) {
    sets.push("updated_at = ?");
    vals.push(Date.now(), id);
    db.prepare(`UPDATE deals SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
    if (changed.length)
      logActivity(db, {
        subjectType: "deal",
        subjectId: id,
        type: "updated",
        summary: `Updated ${changed.join(", ")}`,
        actor,
        data: { fields: changed },
      });
  }
  if (patch.stageId && patch.stageId !== cur.stageId)
    return moveDeal(db, id, patch.stageId, { actor });
  return getDeal(db, id)!;
}

export function deleteDeal(db: HubDb, id: string): void {
  db.prepare("DELETE FROM activities WHERE subject_type = 'deal' AND subject_id = ?").run(id);
  db.prepare("DELETE FROM taggings WHERE subject_type = 'deal' AND subject_id = ?").run(id);
  db.prepare("UPDATE revenue_txns SET deal_id = NULL WHERE deal_id = ?").run(id);
  db.prepare("DELETE FROM deals WHERE id = ?").run(id);
}

function bumpLifecycleForStage(db: HubDb, contactId: string, stage: Stage): void {
  const c = getContact(db, contactId);
  if (!c) return;
  // Lifecycle only ever moves up: Won → customer, a qualified-or-later stage → qualified.
  const target =
    stage.kind === "won"
      ? "customer"
      : stage.kind === "open" && stage.probability >= 45
        ? "qualified"
        : null;
  if (!target) return;
  const rank = { subscriber: 0, lead: 1, qualified: 2, customer: 3, churned: 3 } as const;
  if (rank[target] > rank[c.lifecycle])
    updateContact(db, contactId, { lifecycle: target }, "pipeline");
}

export type MoveOpts = {
  actor?: string | null;
  /** Fields to set as part of the move (e.g. lostReason, valueCents). */
  patch?: DealInput;
  /** Skip required-field checks (automation from trusted events only). */
  force?: boolean;
  reason?: string;
  /** Called when a deal reaches a Won stage (orchestrator converts to a client). */
  onWon?: (deal: Deal) => void;
};

export function moveDeal(db: HubDb, id: string, stageId: string, opts: MoveOpts = {}): Deal {
  const cur = getDeal(db, id);
  if (!cur) throw new Error("deal not found");
  const stage = stageById(db, stageId);
  if (!stage || stage.pipelineId !== cur.pipelineId)
    throw new Error("stage not in this deal's pipeline");
  const from = stageById(db, cur.stageId);
  if (opts.patch) {
    const { stageId: _ignored, ...rest } = opts.patch;
    updateDeal(db, id, rest, opts.actor);
  }
  const merged = getDeal(db, id)!;
  if (!opts.force) {
    const missing = missingFields(db, merged, stage);
    if (missing.length) throw new StageRequirementError(stage.name, missing);
  }
  if (cur.stageId === stageId) return merged;
  const now = Date.now();
  const status = stage.kind === "won" ? "won" : stage.kind === "lost" ? "lost" : "open";
  db.prepare(
    `UPDATE deals SET stage_id = ?, status = ?, stage_entered_at = ?, updated_at = ?,
       won_at = CASE WHEN ? = 'won' THEN COALESCE(won_at, ?) ELSE NULL END,
       lost_at = CASE WHEN ? = 'lost' THEN COALESCE(lost_at, ?) ELSE NULL END WHERE id = ?`,
  ).run(stageId, status, now, now, status, now, status, now, id);
  logActivity(db, {
    subjectType: "deal",
    subjectId: id,
    type: "stage.changed",
    summary: `${from?.name ?? "?"} → ${stage.name}${opts.reason ? ` (${opts.reason})` : ""}`,
    actor: opts.actor,
    data: {
      fromStageId: from?.id ?? null,
      toStageId: stage.id,
      from: from?.name ?? null,
      to: stage.name,
      reason: opts.reason ?? null,
      auto: Boolean(opts.force),
    },
  });
  if (merged.contactId) bumpLifecycleForStage(db, merged.contactId, stage);
  const deal = getDeal(db, id)!;
  if (status === "won") opts.onWon?.(deal);
  return deal;
}

/**
 * Apply a business event to every open deal of `contactId`: the first enabled
 * rule for the event whose `onlyFrom` matches the deal's stage moves it
 * forward (never backwards). Returns the deals that moved.
 */
export function applyEvent(
  db: HubDb,
  contactId: string,
  event: PipelineEvent,
  opts: { reason?: string; onWon?: (deal: Deal) => void; valueCents?: number } = {},
): Deal[] {
  const moved: Deal[] = [];
  const deals = (
    db
      .prepare("SELECT * FROM deals WHERE contact_id = ? AND status = 'open'")
      .all(contactId) as Row[]
  ).map(rowToDeal);
  for (const deal of deals) {
    const rules = listRules(db, deal.pipelineId).filter((r) => r.enabled && r.event === event);
    const curStage = stageById(db, deal.stageId);
    for (const rule of rules) {
      if (rule.onlyFrom.length && !rule.onlyFrom.includes(deal.stageId)) continue;
      const target = stageById(db, rule.toStageId);
      if (!target || !curStage) continue;
      // Never move a deal backwards through the funnel.
      if (target.kind === "open" && target.position <= curStage.position) continue;
      const patch: DealInput = {};
      if (target.kind === "won" && deal.valueCents <= 0 && opts.valueCents)
        patch.valueCents = opts.valueCents;
      moved.push(
        moveDeal(db, deal.id, target.id, {
          force: true,
          reason: opts.reason ?? event,
          actor: "automation",
          patch,
          onWon: opts.onWon,
        }),
      );
      break;
    }
  }
  return moved;
}

export type DealQuery = {
  pipelineId?: string;
  stageId?: string;
  status?: Deal["status"];
  contactId?: string;
  companyId?: string;
  clientId?: string;
  sourceId?: string;
  campaignId?: string;
  search?: string;
  rotting?: boolean;
  dueBefore?: number;
  limit?: number;
  offset?: number;
};

export function listDeals(db: HubDb, q: DealQuery = {}): { deals: DealView[]; total: number } {
  const where: string[] = [];
  const p: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    where.push(sql);
    p.push(v);
  };
  if (q.pipelineId) add("d.pipeline_id = ?", q.pipelineId);
  if (q.stageId) add("d.stage_id = ?", q.stageId);
  if (q.status) add("d.status = ?", q.status);
  if (q.contactId) add("d.contact_id = ?", q.contactId);
  if (q.companyId) add("d.company_id = ?", q.companyId);
  if (q.clientId) add("d.client_id = ?", q.clientId);
  if (q.sourceId) add("d.source_id = ?", q.sourceId);
  if (q.campaignId) add("d.campaign_id = ?", q.campaignId);
  if (q.dueBefore) add("d.next_action_at IS NOT NULL AND d.next_action_at <= ?", q.dueBefore);
  if (q.search) {
    where.push(
      "(lower(d.title) LIKE ? OR lower(c.name) LIKE ? OR lower(co.name) LIKE ? OR c.email LIKE ?)",
    );
    const s = `%${q.search.toLowerCase()}%`;
    p.push(s, s, s, s);
  }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const base = `FROM deals d LEFT JOIN contacts c ON c.id = d.contact_id LEFT JOIN companies co ON co.id = d.company_id
    LEFT JOIN sources so ON so.id = d.source_id LEFT JOIN campaigns cm ON cm.id = d.campaign_id
    LEFT JOIN stages st ON st.id = d.stage_id ${w}`;
  const rows = db
    .prepare(
      `SELECT d.*, c.name AS contact_name, c.email AS contact_email, co.name AS company_name, so.name AS source_name,
              cm.name AS campaign_name, st.rot_days AS rot_days ${base}
       ORDER BY st.position, d.stage_entered_at LIMIT ? OFFSET ?`,
    )
    .all(...p, Math.min(q.limit ?? 500, 2000), q.offset ?? 0) as Row[];
  const now = Date.now();
  let deals: DealView[] = rows.map((r) => {
    const d = rowToDeal(r);
    const ageDays = Math.floor((now - d.stageEnteredAt) / 86_400_000);
    const rot = (r.rot_days as number) ?? null;
    return {
      ...d,
      contactName: (r.contact_name as string) ?? null,
      contactEmail: (r.contact_email as string) ?? null,
      companyName: (r.company_name as string) ?? null,
      sourceName: (r.source_name as string) ?? null,
      campaignName: (r.campaign_name as string) ?? null,
      tags: [],
      ageDays,
      rotting: d.status === "open" && rot !== null && ageDays > rot,
    };
  });
  if (q.rotting !== undefined) deals = deals.filter((d) => d.rotting === q.rotting);
  const tags = tagsFor(
    db,
    "deal",
    deals.map((d) => d.id),
  );
  for (const d of deals) d.tags = tags.get(d.id) ?? [];
  const total = (db.prepare(`SELECT COUNT(*) AS n ${base}`).get(...p) as { n: number }).n;
  return { deals, total };
}

// ── Metrics ───────────────────────────────────────────────────────────────────

export type PipelineMetrics = {
  pipelineId: string;
  stages: Array<{
    stageId: string;
    name: string;
    kind: StageKind;
    count: number;
    valueCents: number;
    weightedCents: number;
    /** Deals that ever reached this stage (from the stage history). */
    reached: number;
    /** reached(this) / reached(previous open stage). */
    conversionFromPrev: number | null;
    avgDaysInStage: number | null;
    rotting: number;
  }>;
  open: { count: number; valueCents: number; weightedCents: number };
  won: { count: number; valueCents: number };
  lost: { count: number; valueCents: number };
  winRate: number | null;
  avgCycleDays: number | null;
  bySource: Array<{
    key: string;
    label: string;
    deals: number;
    won: number;
    wonCents: number;
    winRate: number | null;
  }>;
  byCampaign: Array<{
    key: string;
    label: string;
    deals: number;
    won: number;
    wonCents: number;
    winRate: number | null;
  }>;
  lostReasons: Array<{ reason: string; count: number }>;
};

export function pipelineMetrics(
  db: HubDb,
  pipelineId?: string,
  range: { from?: number; to?: number } = {},
): PipelineMetrics {
  const pipeline = pipelineId ? getPipeline(db, pipelineId) : ensureDefaultPipeline(db);
  if (!pipeline) throw new Error("pipeline not found");
  const from = range.from ?? 0;
  const to = range.to ?? Date.now() + 1;
  const deals = (
    db
      .prepare("SELECT * FROM deals WHERE pipeline_id = ? AND created_at >= ? AND created_at < ?")
      .all(pipeline.id, from, to) as Row[]
  ).map(rowToDeal);
  const dealIds = new Set(deals.map((d) => d.id));
  // Stage history from stage.changed activities + each deal's creation stage.
  const reachedBy = new Map<string, Set<string>>();
  const dwell = new Map<string, number[]>();
  const mark = (stageId: string, dealId: string) => {
    const s = reachedBy.get(stageId) ?? new Set<string>();
    s.add(dealId);
    reachedBy.set(stageId, s);
  };
  const histRows = db
    .prepare(
      "SELECT subject_id, data, occurred_at FROM activities WHERE subject_type = 'deal' AND type IN ('created','stage.changed') ORDER BY occurred_at",
    )
    .all() as Array<{ subject_id: string; data: string; occurred_at: number }>;
  const lastEnter = new Map<string, { stageId: string; at: number }>();
  for (const h of histRows) {
    if (!dealIds.has(h.subject_id)) continue;
    const d = parseJson<{ stageId?: string; toStageId?: string }>(h.data, {});
    const sid = d.toStageId ?? d.stageId;
    if (!sid) continue;
    const prev = lastEnter.get(h.subject_id);
    if (prev) {
      const list = dwell.get(prev.stageId) ?? [];
      list.push((h.occurred_at - prev.at) / 86_400_000);
      dwell.set(prev.stageId, list);
    }
    lastEnter.set(h.subject_id, { stageId: sid, at: h.occurred_at });
    mark(sid, h.subject_id);
  }
  // A deal in stage N has implicitly passed every earlier open stage (imports, drag-skips).
  const pos = new Map(pipeline.stages.map((s) => [s.id, s.position]));
  for (const d of deals) {
    mark(d.stageId, d.id);
    const p = pos.get(d.stageId) ?? 0;
    const st = pipeline.stages.find((s) => s.id === d.stageId);
    if (st?.kind === "lost") continue;
    for (const s of pipeline.stages) if (s.kind === "open" && s.position < p) mark(s.id, d.id);
  }
  const now = Date.now();
  let prevReached: number | null = null;
  const stages = pipeline.stages.map((s) => {
    const inStage = deals.filter((d) => d.stageId === s.id);
    const valueCents = inStage.reduce((a, d) => a + d.valueCents, 0);
    const reached = reachedBy.get(s.id)?.size ?? 0;
    const conv = s.kind === "lost" ? null : prevReached ? reached / prevReached : null;
    if (s.kind !== "lost") prevReached = reached;
    const dw = dwell.get(s.id);
    return {
      stageId: s.id,
      name: s.name,
      kind: s.kind,
      count: inStage.length,
      valueCents,
      weightedCents: Math.round(
        inStage.reduce((a, d) => a + d.valueCents * ((d.probability ?? s.probability) / 100), 0),
      ),
      reached,
      conversionFromPrev: conv,
      avgDaysInStage: dw?.length
        ? Math.round((dw.reduce((a, b) => a + b, 0) / dw.length) * 10) / 10
        : null,
      rotting:
        s.rotDays === null
          ? 0
          : inStage.filter(
              (d) => d.status === "open" && (now - d.stageEnteredAt) / 86_400_000 > s.rotDays!,
            ).length,
    };
  });
  const open = deals.filter((d) => d.status === "open");
  const won = deals.filter((d) => d.status === "won");
  const lost = deals.filter((d) => d.status === "lost");
  const cycle = won.filter((d) => d.wonAt).map((d) => (d.wonAt! - d.createdAt) / 86_400_000);
  const group = (key: (d: Deal) => string | null, label: (k: string) => string) => {
    const m = new Map<string, { deals: number; won: number; wonCents: number; closed: number }>();
    for (const d of deals) {
      const k = key(d) ?? "none";
      const g = m.get(k) ?? { deals: 0, won: 0, wonCents: 0, closed: 0 };
      g.deals++;
      if (d.status !== "open") g.closed++;
      if (d.status === "won") {
        g.won++;
        g.wonCents += d.valueCents;
      }
      m.set(k, g);
    }
    return [...m.entries()]
      .map(([k, g]) => ({
        key: k,
        label: k === "none" ? "Unattributed" : label(k),
        deals: g.deals,
        won: g.won,
        wonCents: g.wonCents,
        winRate: g.closed ? g.won / g.closed : null,
      }))
      .sort((a, b) => b.wonCents - a.wonCents || b.deals - a.deals);
  };
  const name = (table: "sources" | "campaigns") => (id: string) =>
    (db.prepare(`SELECT name FROM ${table} WHERE id = ?`).get(id) as { name?: string } | undefined)
      ?.name ?? id;
  const reasons = new Map<string, number>();
  for (const d of lost)
    reasons.set(d.lostReason ?? "No reason", (reasons.get(d.lostReason ?? "No reason") ?? 0) + 1);
  return {
    pipelineId: pipeline.id,
    stages,
    open: {
      count: open.length,
      valueCents: open.reduce((a, d) => a + d.valueCents, 0),
      weightedCents: stages
        .filter((s) => s.kind === "open")
        .reduce((a, s) => a + s.weightedCents, 0),
    },
    won: { count: won.length, valueCents: won.reduce((a, d) => a + d.valueCents, 0) },
    lost: { count: lost.length, valueCents: lost.reduce((a, d) => a + d.valueCents, 0) },
    winRate: won.length + lost.length ? won.length / (won.length + lost.length) : null,
    avgCycleDays: cycle.length
      ? Math.round((cycle.reduce((a, b) => a + b, 0) / cycle.length) * 10) / 10
      : null,
    bySource: group((d) => d.sourceId, name("sources")),
    byCampaign: group((d) => d.campaignId, name("campaigns")),
    lostReasons: [...reasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
  };
}

// ── Next-action reminders → kanban ────────────────────────────────────────────

export type ReminderSink = {
  /** Create a task; returns its id. */
  create(task: {
    title: string;
    description: string;
    dueDate: string | null;
    tags: string[];
  }): Promise<string>;
  /** Update an existing task (title/due/description). Returns false when it no longer exists. */
  update(
    taskId: string,
    task: { title: string; description: string; dueDate: string | null; done?: boolean },
  ): Promise<boolean>;
};

/**
 * Mirror every open deal's next action into a kanban task (one per deal) and
 * close tasks of deals that are won/lost or have no next action anymore.
 * Idempotent: the task id lives on the deal (`kanban_task_id`).
 */
export async function syncReminders(
  db: HubDb,
  sink: ReminderSink,
): Promise<{ created: number; updated: number; closed: number }> {
  let created = 0;
  let updated = 0;
  let closed = 0;
  const rows = db
    .prepare(
      `SELECT d.*, c.name AS contact_name, co.name AS company_name, st.name AS stage_name FROM deals d
       LEFT JOIN contacts c ON c.id = d.contact_id LEFT JOIN companies co ON co.id = d.company_id
       LEFT JOIN stages st ON st.id = d.stage_id
       WHERE (d.next_action IS NOT NULL AND d.status = 'open') OR d.kanban_task_id IS NOT NULL`,
    )
    .all() as Row[];
  for (const r of rows) {
    const d = rowToDeal(r);
    const who = [r.contact_name, r.company_name].filter(Boolean).join(" · ");
    const title = `${d.nextAction ?? "Follow up"} — ${d.title}`;
    const description = `Business hub deal in ${coerceString(r.stage_name)}${who ? ` (${who})` : ""}. Value ${(d.valueCents / 100).toFixed(2)} ${d.currency}.\nhub:deal:${d.id}`;
    const due = d.nextActionAt ? new Date(d.nextActionAt).toISOString().slice(0, 10) : null;
    const active = d.status === "open" && Boolean(d.nextAction);
    if (d.kanbanTaskId) {
      const ok = await sink.update(d.kanbanTaskId, {
        title,
        description,
        dueDate: due,
        done: !active,
      });
      if (!ok) {
        db.prepare("UPDATE deals SET kanban_task_id = NULL WHERE id = ?").run(d.id);
        if (!active) continue;
      } else {
        if (active) updated++;
        else {
          closed++;
          db.prepare("UPDATE deals SET kanban_task_id = NULL WHERE id = ?").run(d.id);
        }
        continue;
      }
    }
    if (!active) continue;
    const taskId = await sink.create({
      title,
      description,
      dueDate: due,
      tags: ["sales", "business-hub"],
    });
    db.prepare("UPDATE deals SET kanban_task_id = ? WHERE id = ?").run(taskId, d.id);
    created++;
  }
  return { created, updated, closed };
}

/** Kanban-backed reminder sink: tasks live in one "Sales follow-ups" project. */
export function kanbanReminderSink(db: HubDb, stateDir?: string): ReminderSink {
  const projectKey = "pipeline.kanbanProjectId";
  return {
    async create(task) {
      const { getKanbanStore } = await import("../tasks/store.js");
      const store = getKanbanStore(stateDir);
      let projectId = getMeta(db, projectKey);
      const projects = await store.getProjects();
      if (!projectId || !projects.some((p) => p.id === projectId)) {
        const existing = projects.find((p) => p.name === "Sales follow-ups");
        projectId =
          existing?.id ??
          (
            await store.createProject({
              id: `proj_sales_${Date.now().toString(36)}`,
              name: "Sales follow-ups",
              description: "Next actions from Business hub deals (kept in sync automatically).",
              color: "#d6b25e",
            })
          ).id;
        setMeta(db, projectKey, projectId);
      }
      const t = await store.createTask({
        projectId,
        title: task.title,
        description: task.description,
        status: "todo",
        dueDate: task.dueDate ?? undefined,
        tags: task.tags,
      });
      return t.id;
    },
    async update(taskId, task) {
      const { getKanbanStore } = await import("../tasks/store.js");
      const store = getKanbanStore(stateDir);
      if (!store.getTaskById(taskId)) return false;
      await store.updateTask(taskId, {
        title: task.title,
        description: task.description,
        dueDate: task.dueDate ?? undefined,
        ...(task.done ? { status: "done", done: true } : {}),
      });
      return true;
    },
  };
}
