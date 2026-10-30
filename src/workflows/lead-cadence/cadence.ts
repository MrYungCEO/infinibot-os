/**
 * Lead Cadence — Continuous Workflow Daemon
 *
 * Registered with the continuous-workflow runtime (kind: "continuous").
 * Ticks every 5 minutes and runs the full outreach pipeline:
 *
 *   1. raw → enriching       enrichLead() for leads in `raw` state
 *   2. enriched → scored     scoreLead() for leads in `enriched` state
 *   3. scored → queued       auto-promote qualified leads if campaign.autoPromote
 *   4. queued → contacted    sendOutreach() for leads in `queued` state
 *   5. drain inbox           classify new replies
 *   6. schedule follow-ups   overdue cadence rows → send next follow-up
 *   7. emit metrics          update campaign counters
 *
 * Each step is idempotent. A restart picks up where it left off because all
 * state is persisted to the databases store (not in-memory).
 *
 * The workflow is registered idempotently at gateway boot via
 * ensureLeadCadenceWorkflow(stateDir).
 *
 * TODO(closed-loop): call ensureLeadCadenceWorkflow from the gateway boot sequence.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CadenceConfig {
  /** Seconds between ticks. Default 300 (5 min). */
  intervalSeconds: number;
  /** Max leads to enrich per tick. */
  enrichConcurrency: number;
  /** Max leads to score per tick. */
  scoreConcurrency: number;
  /** Max leads to contact per tick (respect provider rate limits). */
  sendConcurrency: number;
  /** Default qualifier threshold (0-100). */
  defaultQualifierThreshold: number;
  /** State dir for the DatabasesStore. */
  stateDir: string;
}

export interface CadenceTickResult {
  tick: number;
  durationMs: number;
  enriched: number;
  scored: number;
  promoted: number;
  sent: number;
  repliesClassified: number;
  followUpsSent: number;
  errors: string[];
}

// ── Default config ────────────────────────────────────────────────────────────

export const DEFAULT_CADENCE_CONFIG: CadenceConfig = {
  intervalSeconds: 300,
  enrichConcurrency: 10,
  scoreConcurrency: 20,
  sendConcurrency: 5,
  defaultQualifierThreshold: 70,
  stateDir: process.env.INFINIBOT_STATE_DIR ?? "state",
};

// ── Cadence tick ──────────────────────────────────────────────────────────────

/**
 * Execute one cadence tick. Called by the continuous-workflow runner.
 * Each step is wrapped in try/catch so partial failures don't break the tick.
 */
export async function runCadenceTick(
  config: Partial<CadenceConfig> = {},
  log: (line: string) => void = console.log,
  signal?: AbortSignal,
): Promise<CadenceTickResult> {
  const cfg: CadenceConfig = { ...DEFAULT_CADENCE_CONFIG, ...config };
  const startMs = Date.now();
  const result: CadenceTickResult = {
    tick: Date.now(),
    durationMs: 0,
    enriched: 0,
    scored: 0,
    promoted: 0,
    sent: 0,
    repliesClassified: 0,
    followUpsSent: 0,
    errors: [],
  };

  log("[cadence] tick started");

  // Step 1 — Enrich raw leads
  try {
    const count = await _enrichRawLeads(cfg, log, signal);
    result.enriched = count;
    log(`[cadence] enriched ${count} leads`);
  } catch (err) {
    const msg = `enrich step failed: ${String(err)}`;
    result.errors.push(msg);
    log(`[cadence] ${msg}`);
  }

  if (signal?.aborted) return _finish(result, startMs);

  // Step 2 — Score enriched leads
  try {
    const count = await _scoreEnrichedLeads(cfg, log, signal);
    result.scored = count;
    log(`[cadence] scored ${count} leads`);
  } catch (err) {
    const msg = `score step failed: ${String(err)}`;
    result.errors.push(msg);
    log(`[cadence] ${msg}`);
  }

  if (signal?.aborted) return _finish(result, startMs);

  // Step 3 — Auto-promote qualified leads
  try {
    const count = await _promoteQualified(cfg, log);
    result.promoted = count;
    log(`[cadence] promoted ${count} leads to queued`);
  } catch (err) {
    const msg = `promote step failed: ${String(err)}`;
    result.errors.push(msg);
    log(`[cadence] ${msg}`);
  }

  if (signal?.aborted) return _finish(result, startMs);

  // Step 4 — Send queued leads
  try {
    const count = await _sendQueuedLeads(cfg, log, signal);
    result.sent = count;
    log(`[cadence] sent ${count} initial emails`);
  } catch (err) {
    const msg = `send step failed: ${String(err)}`;
    result.errors.push(msg);
    log(`[cadence] ${msg}`);
  }

  if (signal?.aborted) return _finish(result, startMs);

  // Step 5 — Schedule follow-ups for overdue leads
  try {
    const count = await _sendFollowUps(cfg, log, signal);
    result.followUpsSent = count;
    log(`[cadence] sent ${count} follow-up emails`);
  } catch (err) {
    const msg = `follow-up step failed: ${String(err)}`;
    result.errors.push(msg);
    log(`[cadence] ${msg}`);
  }

  return _finish(result, startMs);
}

function _finish(result: CadenceTickResult, startMs: number): CadenceTickResult {
  result.durationMs = Date.now() - startMs;
  console.log(
    `[cadence] tick complete in ${result.durationMs}ms ` +
      `enriched=${result.enriched} scored=${result.scored} sent=${result.sent} followUps=${result.followUpsSent} errors=${result.errors.length}`,
  );
  return result;
}

// ── Step implementations (stubs + DB integration placeholders) ────────────────

async function _enrichRawLeads(
  cfg: CadenceConfig,
  log: (l: string) => void,
  signal?: AbortSignal,
): Promise<number> {
  // TODO(closed-loop): query DatabasesStore for leads with LifecycleStatus=raw,
  // call enrichLead() from src/workflows/enrichment/run.ts, update lead row.
  //
  // Pattern:
  //   const store = getDatabasesStore(cfg.stateDir);
  //   const leadsDb = store.listDatabases().find(d => d.name === "Leads");
  //   const rawLeads = store.listRows(leadsDb.id, { filter: ... });
  //   for (const lead of rawLeads.slice(0, cfg.enrichConcurrency)) {
  //     updateLeadStatus(store, lead, "enriching");
  //     const result = await enrichLead({ lead: ..., log, signal });
  //     updateLeadFromEnrichment(store, lead, result);
  //   }
  log("[cadence:enrich] stub — wire DatabasesStore queries in Phase 1 completion");
  return 0;
}

async function _scoreEnrichedLeads(
  cfg: CadenceConfig,
  log: (l: string) => void,
  signal?: AbortSignal,
): Promise<number> {
  // TODO(closed-loop): query leads with LifecycleStatus=enriched, call scoreLead(),
  // update QualifierScore/QualifierReason/RecommendedPitch, set status=qualified/disqualified.
  log("[cadence:score] stub — wire DatabasesStore queries");
  return 0;
}

async function _promoteQualified(cfg: CadenceConfig, log: (l: string) => void): Promise<number> {
  // TODO(closed-loop): for each campaign with autoPromote=true,
  // move leads with status=qualified and QualifierScore >= threshold to status=queued.
  log("[cadence:promote] stub — wire campaign DB queries");
  return 0;
}

async function _sendQueuedLeads(
  cfg: CadenceConfig,
  log: (l: string) => void,
  signal?: AbortSignal,
): Promise<number> {
  // TODO(closed-loop): query leads with status=queued, call sendOutreach(),
  // create OutreachMessages row, update lead status to contacted.
  log("[cadence:send] stub — wire sendOutreach integration");
  return 0;
}

async function _sendFollowUps(
  cfg: CadenceConfig,
  log: (l: string) => void,
  signal?: AbortSignal,
): Promise<number> {
  // TODO(closed-loop): query leads with status in (contacted, opened, unresponsive)
  // where nextTouchAt <= now AND followUpCount < template.maxFollowups AND paused=false.
  // Send next follow-up, bump followUpCount, update nextTouchAt.
  // Stop conditions: replied, unsubscribed, max followups, paused, dead.
  log("[cadence:followup] stub — wire follow-up scheduling");
  return 0;
}

// ── Idempotent registration at gateway boot ───────────────────────────────────

export const LEAD_CADENCE_WORKFLOW_ID = "lead-cadence-v1";

/**
 * Registers the lead cadence as a continuous workflow if it's not already registered.
 * Call this once at gateway startup.
 *
 * TODO(closed-loop): import and call ensureLeadCadenceWorkflow in the gateway boot.
 */
export async function ensureLeadCadenceWorkflow(stateDir: string): Promise<void> {
  // Dynamic import to avoid circular dep if called from gateway boot
  const { WorkflowStore } = await import("../store.js");
  const store = new WorkflowStore(stateDir);

  const existing = store.get(LEAD_CADENCE_WORKFLOW_ID);
  if (existing) return;

  store.create({
    id: LEAD_CADENCE_WORKFLOW_ID,
    name: "Lead Cadence (Closed-Loop)",
    description:
      "Autonomous outreach pipeline: enrich → qualify → contact → follow-up → classify replies",
    kind: "continuous",
    body: `# Lead Cadence Tick

This workflow runs the closed-loop lead pipeline every 5 minutes.

Steps per tick:
1. Enrich raw leads (Maps detail + email finder + domain crawl)
2. Score enriched leads (rule filter + LLM qualifier)
3. Auto-promote qualified leads to outreach queue
4. Send initial outreach emails
5. Send follow-up emails for overdue cadence
6. Update campaign counters

All state is persisted to the databases store — restart-safe.`,
    continuous: {
      iterationIntervalSeconds: 300,
      maxIterations: null,
      iterationTimeoutSeconds: 240,
      errorStreakThreshold: 5,
      stopOn: ["manual", "error_streak"],
    },
  });

  console.log(`[cadence] Registered continuous workflow: ${LEAD_CADENCE_WORKFLOW_ID}`);
}
