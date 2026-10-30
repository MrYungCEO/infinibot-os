/**
 * In-flight messaging tools for CLI coder sub-agents.
 *
 *   subagent_message — orchestrator side: send a message to a RUNNING
 *     claude_coder / opencode_coder / codex_coder run (by runId or
 *     childSessionKey), or poll a message's delivery status.
 *   subagent_inbox   — child side: fetch pending operator messages / ack them.
 *
 * See src/agents/subagent-inbox/service.ts for delivery semantics.
 */

import { Type } from "@sinclair/typebox";

import { optionalStringEnum } from "../schema/typebox.js";
import {
  ackInboxForSession,
  drainInboxForSession,
  getSubagentMessageStatus,
  sendSubagentMessage,
} from "../subagent-inbox/service.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const SubagentMessageSchema = Type.Object({
  action: optionalStringEnum(["send", "status"] as const, {
    description: "send (default) = queue a message for the running agent; status = poll delivery.",
  }),
  runId: Type.Optional(Type.String({ description: "runId returned by claude_coder / *_coder." })),
  childSessionKey: Type.Optional(
    Type.String({
      description: "childSessionKey returned by the coder tool (agent:…:subagent:…).",
    }),
  ),
  message: Type.Optional(Type.String({ description: "The instruction to deliver (send)." })),
  messageId: Type.Optional(Type.String({ description: "Message to poll (status). Omit for all." })),
  waitSeconds: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 8,
      description:
        "send only: wait up to N seconds (max 8) for the agent's next tool boundary so the status can come back as delivered. Default 0 = return immediately as queued.",
    }),
  ),
});

export function createSubagentMessageTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Message Sub-agent",
    name: "subagent_message",
    description: `Send a message to an IN-FLIGHT coder sub-agent (claude_coder / opencode_coder / codex_coder / grok_coder) so the running agent receives it and acts on it — e.g. add a requirement, change direction, or ask it to stop.

Identify the run by runId or childSessionKey (both returned by the coder tool). Returns fast with a messageId and an honest status:
- queued — stored durably; the agent sees it at its next tool boundary (Claude Code/OpenCode: mid-turn right after its next tool call; Codex/Gemini: its next infinibot MCP tool call)
- delivered — injected into the agent's context (deliveredAt/deliveredVia)
- acknowledged — the agent confirmed it (ACK)
- not_running — the run already ended; nothing is listening (respawn instead)
- not_found / unsupported_backend — no such coder run (use sessions_send for embedded agents)

Poll with action:"status" + messageId. Messages survive gateway restarts.`,
    parameters: SubagentMessageSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action") === "status" ? "status" : "send";
      const runId = readStringParam(params, "runId");
      const sessionKey = readStringParam(params, "childSessionKey");
      if (!runId && !sessionKey) {
        return jsonResult({
          ok: false,
          status: "error",
          error: "runId or childSessionKey is required",
        });
      }
      if (action === "status") {
        return jsonResult(
          getSubagentMessageStatus({
            runId,
            sessionKey,
            messageId: readStringParam(params, "messageId"),
          }),
        );
      }
      const message = readStringParam(params, "message");
      if (!message) {
        return jsonResult({ ok: false, status: "error", error: "message is required for send" });
      }
      const waitSeconds =
        typeof params.waitSeconds === "number" && Number.isFinite(params.waitSeconds)
          ? params.waitSeconds
          : 0;
      return jsonResult(
        await sendSubagentMessage({
          runId,
          sessionKey,
          message,
          from: opts?.agentSessionKey || "operator",
          waitMs: waitSeconds * 1000,
        }),
      );
    },
  };
}

const SubagentInboxSchema = Type.Object({
  action: optionalStringEnum(["check", "ack"] as const, {
    description: "check (default) = fetch pending operator messages; ack = confirm receipt.",
  }),
  ids: Type.Optional(
    Type.Array(Type.String(), { description: "ack: message ids to acknowledge." }),
  ),
});

export function createSubagentInboxTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Operator Inbox",
    name: "subagent_inbox",
    description: `For coder sub-agents: fetch operator messages sent to you while you work (action "check"), or acknowledge them (action "ack" + ids). Operator messages are authoritative amendments to your task — act on them immediately. Check between major steps; pending messages are also appended automatically to the result of any infinibot tool you call.`,
    parameters: SubagentInboxSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const sessionKey = opts?.agentSessionKey;
      if (readStringParam(params, "action") === "ack") {
        const ids = Array.isArray(params.ids)
          ? (params.ids as unknown[]).filter((x): x is string => typeof x === "string")
          : [];
        const res = ackInboxForSession(sessionKey, ids);
        return jsonResult({
          ok: Boolean(res.runId),
          acknowledged: res.acked,
          ...(res.runId ? {} : { error: "No running coder sub-agent is bound to this session." }),
        });
      }
      const drained = drainInboxForSession(sessionKey, "inbox-tool");
      if (!drained.run) {
        return jsonResult({
          ok: false,
          messages: [],
          error: "No running coder sub-agent is bound to this session.",
        });
      }
      if (drained.messages.length === 0) {
        return jsonResult({
          ok: true,
          messages: [],
          note: "No pending operator messages. Continue.",
        });
      }
      return {
        content: [{ type: "text", text: drained.text }],
        details: {
          ok: true,
          messages: drained.messages.map((m) => ({ id: m.id, from: m.from, text: m.text })),
        },
      };
    },
  };
}
