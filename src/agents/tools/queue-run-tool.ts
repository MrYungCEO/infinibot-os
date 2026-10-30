/**
 * `queue_run` agent tool — create and steer phased queue entries
 * (src/queue). Each phase runs on ANY agent — Claude Code, Codex, OpenCode,
 * Gemini CLI or a gateway agent id — and only advances when the run's
 * verified-completion verdict is VERIFIED and the phase gate passes.
 *
 * Every action proxies to the `queue.*` gateway RPCs, so entries are durable,
 * survive restarts, and show up on Autonomy → Phases.
 */

import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { callGatewayTool, type GatewayCallOptions } from "./gateway.js";
import { QueuePhaseSchema, QueueIsolationSchema } from "../../gateway/protocol/schema/queue.js";

const QUEUE_RUN_ACTIONS = [
  "add",
  "list",
  "show",
  "logs",
  "pause",
  "resume",
  "cancel",
  "retry",
  "advance",
  "reorder",
  "backends",
] as const;

const QueueRunToolSchema = Type.Object({
  action: stringEnum(QUEUE_RUN_ACTIONS),
  // add
  title: Type.Optional(Type.String()),
  brief: Type.Optional(
    Type.String({ description: "Project-wide brief shared by every phase (markdown)." }),
  ),
  phases: Type.Optional(
    Type.Array(QueuePhaseSchema, {
      description:
        "Ordered phases. Each: {name, brief, agent?: claude-code|codex|opencode|gemini|grok|<gateway agent id>, model?, fallbackAgent?, workdir?, gateCriteria?: [{type:'shell',command}|{type:'file',path}|{type:'grep',path,pattern}|{type:'llm',criterion}], maxAttempts?, timeoutSec?}.",
    }),
  ),
  workdir: Type.Optional(
    Type.String({ description: "Absolute repo/project dir (default for all phases)." }),
  ),
  isolation: Type.Optional(QueueIsolationSchema),
  dependsOn: Type.Optional(Type.Array(Type.String())),
  priority: Type.Optional(Type.Integer()),
  autoApprove: Type.Optional(
    Type.Boolean({
      description:
        "CLI permission bypass for the phase agents (default true; forced off on untrusted turns).",
    }),
  ),
  // controls
  id: Type.Optional(Type.String({ description: "Queue entry id (or unique prefix)." })),
  force: Type.Optional(Type.Boolean({ description: "pause: stop the running attempt now." })),
  instruction: Type.Optional(
    Type.String({ description: "retry: extra instruction for the agent." }),
  ),
  fromPhase: Type.Optional(Type.Integer({ description: "retry: 0-based phase to restart from." })),
  freshSession: Type.Optional(Type.Boolean()),
  agent: Type.Optional(Type.String({ description: "retry: switch the phase to another agent." })),
  model: Type.Optional(Type.String({ description: "retry: switch the phase to another model." })),
  reason: Type.Optional(Type.String()),
  status: Type.Optional(Type.String({ description: "list: filter by status." })),
});

export function createQueueRunTool(): AnyAgentTool {
  return {
    label: "Phase queue",
    name: "queue_run",
    description:
      "Queue multi-phase work where each phase can run on a different coding agent (claude-code, codex, opencode, gemini, grok, or a gateway agent id). " +
      "Phases run in order in the entry's workdir (optionally an isolated git worktree), resume the same agent session on retries, and advance only when the run is VERIFIED and the phase gate checks pass. " +
      "Actions: add {title?, brief, phases[], workdir, isolation?, dependsOn?}, list {status?}, show {id}, logs {id}, pause {id, force?}, resume {id}, cancel {id}, retry {id, instruction?, fromPhase?, agent?, model?}, advance {id, reason}, reorder {id, priority}, backends.",
    parameters: QueueRunToolSchema,
    execute: async (_id, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const opts: GatewayCallOptions = { timeoutMs: 60_000 };
      const id = readStringParam(params, "id");
      const needId = () => {
        if (!id) throw new Error(`queue_run ${action}: id is required`);
        return id;
      };
      switch (action) {
        case "add": {
          const phases = Array.isArray(params.phases) ? params.phases : [];
          if (!phases.length) throw new Error("queue_run add: phases[] is required");
          const res = (await callGatewayTool("queue.enqueue", opts, {
            title: readStringParam(params, "title") || undefined,
            briefMd: readStringParam(params, "brief") || "",
            phaseSpec: phases,
            workdir: readStringParam(params, "workdir") || undefined,
            isolation: params.isolation,
            dependsOn: Array.isArray(params.dependsOn) ? params.dependsOn : undefined,
            priority: typeof params.priority === "number" ? params.priority : undefined,
            autoApprove: params.autoApprove === false ? false : undefined,
          })) as { id?: string; entry?: { status?: string; title?: string } };
          return jsonResult({
            status: "queued",
            id: res?.id,
            title: res?.entry?.title,
            hint: "Follow progress with queue_run show {id}; phases advance only on a VERIFIED verdict + passing gate.",
          });
        }
        case "list":
          return jsonResult(
            await callGatewayTool("queue.list", opts, {
              ...(readStringParam(params, "status")
                ? { status: readStringParam(params, "status") }
                : {}),
              limit: 50,
            }),
          );
        case "show": {
          const res = (await callGatewayTool("queue.get", opts, { id: needId(), events: 30 })) as {
            entry?: Record<string, unknown>;
            attempts?: Array<Record<string, unknown>>;
            events?: Array<Record<string, unknown>>;
          };
          const e = res?.entry ?? {};
          return jsonResult({
            id: e.id,
            title: e.title,
            status: e.status,
            phase: `${Number(e.currentPhaseIdx ?? 0) + 1}/${Array.isArray(e.phaseSpec) ? e.phaseSpec.length : "?"}`,
            blockedKind: e.blockedKind,
            fixHint: e.fixHint,
            lastError: typeof e.lastError === "string" ? e.lastError.slice(0, 2000) : e.lastError,
            waitingReason: e.waitingReason,
            attempts: (res?.attempts ?? []).map((a) => ({
              phase: Number(a.phaseIdx) + 1,
              n: a.n,
              agent: a.agent,
              model: a.model,
              outcome: a.outcome,
              verdict: a.verdict,
              session: a.sessionId,
              resumed: Boolean(a.resumedSession),
              gatePass: (a.gate as { pass?: boolean } | null)?.pass ?? null,
            })),
            events: (res?.events ?? []).slice(-10).map((ev) => `${ev.kind}: ${ev.message}`),
          });
        }
        case "logs":
          return jsonResult(
            await callGatewayTool("queue.logs", opts, { id: needId(), maxChars: 8000 }),
          );
        case "pause":
          return jsonResult(
            await callGatewayTool("queue.pause", opts, {
              id: needId(),
              force: params.force === true,
            }),
          );
        case "resume":
          return jsonResult(await callGatewayTool("queue.resume", opts, { id: needId() }));
        case "cancel":
          return jsonResult(
            await callGatewayTool("queue.cancel", opts, {
              id: needId(),
              reason: readStringParam(params, "reason") || undefined,
            }),
          );
        case "retry":
          return jsonResult(
            await callGatewayTool("queue.retry", opts, {
              id: needId(),
              instruction: readStringParam(params, "instruction") || undefined,
              fromPhase: typeof params.fromPhase === "number" ? params.fromPhase : undefined,
              freshSession: params.freshSession === true ? true : undefined,
              agent: readStringParam(params, "agent") || undefined,
              model: readStringParam(params, "model") || undefined,
            }),
          );
        case "advance":
          return jsonResult(
            await callGatewayTool("queue.advance", opts, {
              id: needId(),
              reason: readStringParam(params, "reason") || undefined,
            }),
          );
        case "reorder": {
          if (typeof params.priority !== "number")
            throw new Error("queue_run reorder: priority is required");
          return jsonResult(
            await callGatewayTool("queue.reorder", opts, {
              id: needId(),
              priority: params.priority,
            }),
          );
        }
        case "backends":
          return jsonResult(await callGatewayTool("queue.backends", opts, { refresh: true }));
        default:
          throw new Error(`queue_run: unknown action ${action}`);
      }
    },
  };
}
