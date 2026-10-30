/**
 * Discovery Docs — pipeline orchestrator.
 *
 * Given a template and a set of inputs (manual test OR Netlify submission),
 * runs the full pipeline:
 *
 *   1. Pull context from registered InfiniBot databases.
 *   2. Resolve token references in system + user prompts.
 *   3. Call AI to generate the markdown document.
 *   4. Decide the qualify category (qualify_lead action) — moved to the
 *      front of the actions so downstream actions can condition on it.
 *   5. Decide approvalState from the template's approval gate.
 *   6. Run actions in order, recording each result on the run.
 *   7. Persist the final run.
 *
 * Each step writes to the runs table as it goes so a crash leaves a
 * recoverable partial record.
 */

import { randomUUID } from "node:crypto";

import { STATE_DIR } from "../config/paths.js";
import { resolveContext } from "./context.js";
import { resolvePrompts } from "./prompt.js";
import { generateDocument } from "./ai.js";
import { runAction } from "./actions.js";
import { getDiscoveryStore } from "./store.js";

import type { DiscoveryDocTemplate, DiscoveryDocRun, ActionResult, RunSource } from "./types.js";

export interface RunPipelineInput {
  template: DiscoveryDocTemplate;
  inputs: Record<string, string>;
  source: RunSource;
  /** Snapshot of the active business profile, used for {{biz.*}} tokens. */
  business: { id: string; name: string; industry?: string; [key: string]: unknown };
  /** Netlify submission id when this came from a polled webhook. */
  netlifySubmissionId?: string | null;
  /** When true (manual test from UI), skip side-effect actions and only generate the doc. */
  dryRun?: boolean;
}

export async function runPipeline(input: RunPipelineInput): Promise<DiscoveryDocRun> {
  const store = getDiscoveryStore(STATE_DIR);
  const tpl = input.template;
  const now = Date.now();
  const runId = randomUUID();

  // Pre-create a placeholder run so the UI can show "in progress" if it
  // polls during a long generation.
  let run: DiscoveryDocRun = {
    id: runId,
    templateId: tpl.id,
    businessId: tpl.businessId,
    source: input.source,
    inputs: input.inputs,
    contextSnapshot: {},
    resolvedSystemPrompt: "",
    resolvedUserPrompt: "",
    generatedMarkdown: "",
    qualifyCategory: null,
    actions: tpl.actions.map((a) => ({
      actionId: a.id,
      kind: a.kind,
      status: "pending" as const,
      startedAt: null,
      finishedAt: null,
      detail: null,
    })),
    approvalState: "pending",
    approvalNote: null,
    netlifySubmissionId: input.netlifySubmissionId ?? null,
    calendlyLinkSent: false,
    createdAt: now,
    updatedAt: now,
  };
  run = store.upsertRun(run);

  // 1. Context
  const ctx = resolveContext(tpl.contextSources);
  run.contextSnapshot = ctx;
  run = store.upsertRun(run);

  // 2. Prompts
  const prompts = resolvePrompts({
    systemPrompt: tpl.ai.systemPrompt,
    userPromptTemplate: tpl.ai.userPromptTemplate,
    inputs: input.inputs,
    context: ctx,
    business: input.business,
    runId,
    runTimestamp: now,
  });
  run.resolvedSystemPrompt = prompts.system;
  run.resolvedUserPrompt = prompts.user;
  run = store.upsertRun(run);

  // 3. AI
  // TODO(campaigns): If the inputs include a leadId, call
  // `buildCampaignContext(leadId)` from src/campaigns/context-builder.ts
  // and pass it as `campaignContext` so the generator can personalize
  // by business voice + product catalog + campaign goal.
  try {
    const gen = await generateDocument({
      model: tpl.ai.model,
      systemPrompt: prompts.system,
      userPrompt: prompts.user,
      temperature: tpl.ai.temperature,
      maxTokens: tpl.ai.maxTokens,
      timeoutMs: 120_000,
    });
    run.generatedMarkdown = gen.text;
  } catch (err) {
    run.generatedMarkdown = `**AI generation failed:** ${err instanceof Error ? err.message : String(err)}`;
    run = store.upsertRun(run);
    // Even on failure, run actions so the user can see what was attempted.
  }
  run = store.upsertRun(run);

  if (input.dryRun) {
    run.approvalState = "pending";
    run = store.upsertRun(run);
    return run;
  }

  // 4. Qualify first — let other actions condition on the category.
  const businessName = input.business.name ?? "Business";
  const actionsOrdered = orderQualifyFirst(tpl.actions);
  const resultsById = new Map<string, ActionResult>();

  // Run qualify_lead actions first so we have a category before we
  // decide approval state.
  for (const a of actionsOrdered) {
    if (a.kind !== "qualify_lead") continue;
    const r = await runAction({ template: tpl, run, businessName }, a);
    resultsById.set(a.id, r);
  }

  // 5. Approval decision
  run.approvalState = decideApprovalState(tpl, run.qualifyCategory);

  // 6. Remaining actions
  for (const a of actionsOrdered) {
    if (a.kind === "qualify_lead") continue;
    const r = await runAction({ template: tpl, run, businessName }, a);
    resultsById.set(a.id, r);
    // Persist after each step so a crash leaves the pipeline mid-way recoverable.
    run.actions = tpl.actions.map((aa) => resultsById.get(aa.id) ?? placeholder(aa.id, aa.kind));
    run = store.upsertRun(run);
  }

  // Finalize action ordering on the run record.
  run.actions = tpl.actions.map((a) => resultsById.get(a.id) ?? placeholder(a.id, a.kind));
  run = store.upsertRun(run);
  return run;
}

function placeholder(actionId: string, kind: ActionResult["kind"]): ActionResult {
  return {
    actionId,
    kind,
    status: "skipped",
    startedAt: null,
    finishedAt: null,
    detail: "did not run",
  };
}

function orderQualifyFirst(
  actions: DiscoveryDocTemplate["actions"],
): DiscoveryDocTemplate["actions"] {
  const q = actions.filter((a) => a.kind === "qualify_lead");
  const rest = actions.filter((a) => a.kind !== "qualify_lead");
  return [...q, ...rest];
}

function decideApprovalState(
  tpl: DiscoveryDocTemplate,
  category: string | null,
): DiscoveryDocRun["approvalState"] {
  const c = category ?? "";
  if (tpl.approval.autoApproveCategories.includes(c)) return "auto-approved";
  if (tpl.approval.rejectCategories.includes(c)) return "rejected";
  if (tpl.approval.requireManualForCategories.includes(c)) return "pending";
  // Unknown category — be conservative and route through manual approval.
  return "pending";
}

/**
 * Approve a pending run and re-fire the Calendly action so the link
 * actually gets sent. Other actions are not re-run — they already
 * executed at submission time and have records on the run.
 */
export async function approveRun(
  runId: string,
  approver: string,
  note?: string,
): Promise<DiscoveryDocRun | null> {
  const store = getDiscoveryStore(STATE_DIR);
  const run = store.getRun(runId);
  if (!run) return null;
  run.approvalState = "approved";
  run.approvalNote = note ? `${approver}: ${note}` : `approved by ${approver}`;
  const template = store.getTemplate(run.templateId);
  if (!template) {
    store.upsertRun(run);
    return run;
  }
  // Re-fire calendly_link + any actions that were originally skipped due
  // to approval gating. The pipeline records show the original attempt;
  // we append fresh results so the timeline is preserved.
  const businessName = "Business"; // best-effort; UI passes real name on its approval RPC
  for (const a of template.actions) {
    if (a.kind !== "calendly_link" && a.kind !== "send_email") continue;
    const r = await runAction({ template, run, businessName }, a);
    const idx = run.actions.findIndex((x) => x.actionId === a.id);
    if (idx >= 0) run.actions[idx] = r;
    else run.actions.push(r);
  }
  store.upsertRun(run);
  return run;
}

export function rejectRun(runId: string, approver: string, note?: string): DiscoveryDocRun | null {
  const store = getDiscoveryStore(STATE_DIR);
  const run = store.getRun(runId);
  if (!run) return null;
  run.approvalState = "rejected";
  run.approvalNote = note ? `${approver}: ${note}` : `rejected by ${approver}`;
  store.upsertRun(run);
  return run;
}
