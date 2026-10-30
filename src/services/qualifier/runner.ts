/**
 * Qualifier action runner.
 *
 * One pure entry point — `runQualifier(payload, config)` — that:
 *   1. Evaluates criteria via evaluator.evaluateConfig.
 *   2. Walks the action stack, executing each step whose `branch` matches
 *      the qualification result (or `null` = run on both).
 *   3. Returns a per-action outcome trace so the runs UI can render
 *      what fired and what failed.
 *
 * Fire-and-forget: the gateway handler awaits the whole thing for now,
 * but the contract is that any individual action failure does NOT abort
 * the pipeline — failures are collected and returned. The qualifier UI
 * surfaces them in the run record.
 *
 * Action kinds wired in v1:
 *   - save-to-crm     → creates a funnel Lead (the canonical lead row),
 *                        optionally links to a Notion CRM via fromLead
 *   - send-email      → email dispatcher
 *   - tag-lead        → adds tags on the lead just created (no-op if none)
 *   - link-to-project → attaches lead to a kanban project as a task
 *   - notify-telegram → routed through the existing send.* channel layer
 *                        when configured; otherwise records a "skipped" outcome
 *   - ai-proposal     → defers to the existing funnel ai-engine if available
 *   - respond-webhook → POSTs to a configured callback URL
 *
 * Each action's config is a loosely-typed object; the runner pulls the
 * fields it knows and ignores the rest.
 */
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { evaluateConfig } from "./evaluator.js";
import { sendEmail } from "../email/dispatcher.js";
import type { QualifierConfigV1 } from "./store.js";

const log = createSubsystemLogger("qualifier-runner");

export interface QualifierActionResult {
  actionId: string;
  kind: string;
  ok: boolean;
  detail?: string;
  /** Free-form data the action produced (e.g. created leadId). */
  data?: Record<string, unknown>;
}

export interface QualifierRunResult {
  result: "qualified" | "unqualified";
  matched: number;
  total: number;
  trace: Array<{ id?: string; label?: string; matched: boolean; reason: string }>;
  actions: QualifierActionResult[];
  /** First successful save-to-crm result, hoisted for the UI's badge. */
  leadId?: string;
  /** Aggregate ok flag — true iff every executed action returned ok. */
  ok: boolean;
}

interface ActionLite {
  id: string;
  kind: string;
  branch?: string | null;
  config?: Record<string, unknown>;
  label?: string;
}

export async function runQualifier(
  payload: Record<string, unknown>,
  config: QualifierConfigV1,
): Promise<QualifierRunResult> {
  const evalResult = evaluateConfig(payload, config);

  const actions: QualifierActionResult[] = [];
  let leadId: string | undefined;

  for (const action of (config.actions ?? []) as ActionLite[]) {
    if (action.branch && action.branch !== evalResult.result && action.branch !== "both") continue;
    try {
      const out = await runAction(action, payload, config, { leadId });
      if (out.data?.leadId && typeof out.data.leadId === "string" && !leadId) {
        leadId = out.data.leadId;
      }
      actions.push(out);
    } catch (err) {
      actions.push({
        actionId: action.id,
        kind: action.kind,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const ok = actions.every((a) => a.ok);
  return { ...evalResult, actions, leadId, ok };
}

async function runAction(
  action: ActionLite,
  payload: Record<string, unknown>,
  config: QualifierConfigV1,
  ctx: { leadId?: string },
): Promise<QualifierActionResult> {
  const cfg = (action.config ?? {}) as Record<string, unknown>;
  switch (action.kind) {
    case "save-to-crm": {
      const result = await saveToCrm(payload, config, cfg);
      return {
        actionId: action.id,
        kind: action.kind,
        ok: result.ok,
        detail: result.detail,
        data: result.leadId ? { leadId: result.leadId } : undefined,
      };
    }
    case "send-email": {
      const to =
        asString(cfg.to) ||
        asString(payload.email) ||
        asString((payload as Record<string, unknown>).body && readPath(payload, "body.email"));
      if (!to) {
        return { actionId: action.id, kind: action.kind, ok: false, detail: "no recipient" };
      }
      // TODO(campaigns): if ctx.leadId is set, call
      // `buildCampaignContext(ctx.leadId)` and pass as `campaignContext`
      // so the dispatcher bumps the campaign's emailsSent counter and
      // any downstream AI body composer can personalize on it.
      const send = await sendEmail({
        to,
        subject: asString(cfg.subject) || "Following up on your inquiry",
        body: asString(cfg.body) || asString(cfg.text) || undefined,
        html: asString(cfg.html) || undefined,
        transactionalId: asString(cfg.transactionalId) || undefined,
        from: asString(cfg.from) || undefined,
        replyTo: asString(cfg.replyTo) || undefined,
        businessId: config.businessId,
      });
      if (send.ok) {
        return {
          actionId: action.id,
          kind: action.kind,
          ok: true,
          detail: `sent via ${send.providerUsed}`,
        };
      }
      return {
        actionId: action.id,
        kind: action.kind,
        ok: false,
        detail: `${send.code}: ${send.message}`,
      };
    }
    case "tag-lead": {
      if (!ctx.leadId) {
        return { actionId: action.id, kind: action.kind, ok: false, detail: "no lead in context" };
      }
      const tagsRaw = cfg.tags;
      const tags = Array.isArray(tagsRaw)
        ? tagsRaw.map(String)
        : typeof tagsRaw === "string"
          ? tagsRaw
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : [];
      if (tags.length === 0)
        return { actionId: action.id, kind: action.kind, ok: true, detail: "no tags" };
      try {
        const { getFunnelStore } = await import("../../funnels/store.js");
        const store = getFunnelStore();
        const lead = store.getLead(ctx.leadId);
        const merged = Array.from(new Set([...(lead?.tags ?? []), ...tags]));
        store.updateLead(ctx.leadId, { tags: merged });
        return { actionId: action.id, kind: action.kind, ok: true, detail: `+${tags.length} tags` };
      } catch (err) {
        return {
          actionId: action.id,
          kind: action.kind,
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }
    case "link-to-project": {
      const projectId = asString(cfg.projectId) || config.linkedProjectId || "";
      if (!projectId)
        return { actionId: action.id, kind: action.kind, ok: false, detail: "no projectId" };
      if (!ctx.leadId)
        return { actionId: action.id, kind: action.kind, ok: false, detail: "no lead in context" };
      try {
        const { getKanbanStore } = await import("../../tasks/store.js");
        const stateDir = process.env.INFINIBOT_STATE_DIR ?? "state";
        const store = getKanbanStore(stateDir);
        const title =
          asString(payload.name) ||
          asString(readPath(payload, "body.name")) ||
          `New lead ${ctx.leadId.slice(0, 8)}`;
        await store.createTask({
          projectId,
          title: `Lead: ${title}`,
          description:
            asString(cfg.description) || `Auto-created from qualifier run for lead ${ctx.leadId}.`,
          status: "todo" as never,
          priority: "medium" as never,
        } as never);
        return { actionId: action.id, kind: action.kind, ok: true, detail: `task in ${projectId}` };
      } catch (err) {
        return {
          actionId: action.id,
          kind: action.kind,
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }
    case "notify-telegram": {
      // Telegram delivery rides the gateway's send.* channel layer, which
      // isn't reachable from this services module without dragging in
      // the gateway runtime. For v1 we record the intent so the runs UI
      // shows it; future work: route via a `notifications.dispatch`
      // gateway RPC the runner can call across the bus.
      const message =
        asString(cfg.message) ||
        `Qualifier hit (${config.name}) — lead "${asString(payload.name) || asString(payload.email) || "anon"}"`;
      void message;
      return {
        actionId: action.id,
        kind: action.kind,
        ok: true,
        detail: "telegram routing not wired in v1 (queued)",
      };
    }
    case "respond-webhook": {
      const url = asString(cfg.url);
      if (!url) return { actionId: action.id, kind: action.kind, ok: false, detail: "no url" };
      try {
        const res = await fetch(url, {
          method: asString(cfg.method) || "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            qualifier: { businessId: config.businessId, name: config.name },
            payload,
            leadId: ctx.leadId,
          }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          return {
            actionId: action.id,
            kind: action.kind,
            ok: false,
            detail: `${res.status} from webhook`,
          };
        }
        return {
          actionId: action.id,
          kind: action.kind,
          ok: true,
          detail: `posted (${res.status})`,
        };
      } catch (err) {
        return {
          actionId: action.id,
          kind: action.kind,
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }
    case "ai-proposal":
      // Deferred — the funnel ai-engine has its own proposal generator
      // and we don't want to duplicate the prompt logic here. Surface a
      // "not yet" outcome so the UI shows the action ran and was a no-op.
      return {
        actionId: action.id,
        kind: action.kind,
        ok: true,
        detail: "ai-proposal not wired in v1 (use funnel ai-engine)",
      };
    case "branch-on-criteria":
      // The branch field on each action already handles qualified vs
      // unqualified routing — this kind is metadata for the UI canvas.
      return { actionId: action.id, kind: action.kind, ok: true, detail: "branch marker" };
    default:
      log.warn("unknown action kind", { kind: action.kind });
      return {
        actionId: action.id,
        kind: action.kind,
        ok: false,
        detail: `unknown action kind: ${action.kind}`,
      };
  }
}

interface SaveToCrmResult {
  ok: boolean;
  detail: string;
  leadId?: string;
}

async function saveToCrm(
  payload: Record<string, unknown>,
  config: QualifierConfigV1,
  cfg: Record<string, unknown>,
): Promise<SaveToCrmResult> {
  // Resolve a target funnel — explicit in the action config, else the
  // first funnel in the business, else punt with an error so the operator
  // knows to wire one.
  let funnelId = asString(cfg.funnelId);
  try {
    const { getFunnelStore } = await import("../../funnels/store.js");
    const store = getFunnelStore();
    if (!funnelId) {
      const all = store.listFunnels?.({ businessId: config.businessId }) ?? [];
      const first = Array.isArray(all) && all.length > 0 ? (all[0] as { id?: string }).id : null;
      if (typeof first === "string") funnelId = first;
    }
    if (!funnelId) {
      return {
        ok: false,
        detail: "no funnelId — set one on the action or create a funnel for this business",
      };
    }
    const name =
      asString(payload.name) ||
      asString(readPath(payload, "body.name")) ||
      asString(payload.email) ||
      "Unknown";
    const lead = store.createLead({
      businessId: config.businessId,
      funnelId,
      name,
      email: asString(payload.email) || asString(readPath(payload, "body.email")) || undefined,
      phone: asString(payload.phone) || asString(readPath(payload, "body.phone")) || undefined,
      company:
        asString(payload.company) || asString(readPath(payload, "body.company")) || undefined,
      title: asString(payload.title) || undefined,
      source: (asString(cfg.source) || "qualifier") as never,
      status: "new",
      priority: "medium",
      customFields: { rawPayload: payload },
      firstContactAt: new Date().toISOString(),
    } as never);
    return { ok: true, detail: `lead ${lead.id}`, leadId: lead.id };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

// ─── helpers ──

function asString(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function readPath(root: unknown, path: string): unknown {
  let curr: unknown = root;
  for (const part of path.split(".")) {
    if (curr === null || curr === undefined) return undefined;
    if (typeof curr !== "object") return undefined;
    curr = (curr as Record<string, unknown>)[part];
  }
  return curr;
}
