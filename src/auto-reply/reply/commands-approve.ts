import { callGateway } from "../../gateway/call.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { logVerbose } from "../../globals.js";
import type { CommandHandler } from "./commands-types.js";

const COMMAND = "/approve";

const DECISION_ALIASES: Record<string, "allow-once" | "allow-always" | "deny"> = {
  allow: "allow-once",
  once: "allow-once",
  "allow-once": "allow-once",
  allowonce: "allow-once",
  always: "allow-always",
  "allow-always": "allow-always",
  allowalways: "allow-always",
  approve: "allow-once",
  yes: "allow-once",
  deny: "deny",
  reject: "deny",
  block: "deny",
  no: "deny",
};

type ParsedApproveCommand =
  | { ok: true; id: string; decision: "allow-once" | "allow-always" | "deny"; note?: string }
  | { ok: false; error: string };

const USAGE = "Usage: /approve <id> approve|always|deny [note…]";

function parseApproveCommand(raw: string): ParsedApproveCommand | null {
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith(COMMAND)) return null;
  const rest = trimmed.slice(COMMAND.length).trim();
  if (!rest) {
    return { ok: false, error: USAGE };
  }
  const tokens = rest.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    return { ok: false, error: USAGE };
  }

  const first = tokens[0].toLowerCase();
  const second = tokens[1].toLowerCase();

  if (DECISION_ALIASES[first]) {
    // "/approve deny <id> [note…]"
    const note = tokens.slice(2).join(" ").trim();
    return {
      ok: true,
      decision: DECISION_ALIASES[first],
      id: tokens[1],
      ...(note ? { note } : {}),
    };
  }
  if (DECISION_ALIASES[second]) {
    // "/approve <id> deny [note…]"
    const note = tokens.slice(2).join(" ").trim();
    return {
      ok: true,
      decision: DECISION_ALIASES[second],
      id: tokens[0],
      ...(note ? { note } : {}),
    };
  }
  return { ok: false, error: USAGE };
}

function buildResolvedByLabel(params: Parameters<CommandHandler>[0]): string {
  const channel = params.command.channel;
  const sender = params.command.senderId ?? "unknown";
  return `${channel}:${sender}`;
}

export const handleApproveCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) return null;
  const normalized = params.command.commandBodyNormalized;
  const parsed = parseApproveCommand(normalized);
  if (!parsed) return null;
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /approve from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  if (!parsed.ok) {
    return { shouldContinue: false, reply: { text: parsed.error } };
  }

  const resolvedBy = buildResolvedByLabel(params);
  // Unified approvals first (covers exec, sub-agent check-ins, orchestrator
  // request_approval, autopilot). Falls back to the legacy exec path.
  try {
    const res = (await callGateway({
      method: "approvals.resolve",
      params: {
        id: parsed.id,
        action:
          parsed.decision === "allow-once"
            ? "approve"
            : parsed.decision === "allow-always"
              ? "approve-always"
              : "deny",
        note: parsed.note,
        by: resolvedBy,
        via: "chat",
      },
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: `Chat approval (${resolvedBy})`,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
    })) as {
      ok?: boolean;
      error?: string;
      message?: string;
      record?: { status?: string; decidedBy?: string | null; title?: string } | null;
    } | null;
    if (res?.ok) {
      return {
        shouldContinue: false,
        reply: {
          text: `✅ ${res.record?.status ?? parsed.decision}: ${res.record?.title ?? parsed.id}`,
        },
      };
    }
    if (res?.error === "already_resolved") {
      return {
        shouldContinue: false,
        reply: {
          text: `ℹ️ Already ${res.record?.status ?? "resolved"} by ${res.record?.decidedBy ?? "someone"}.`,
        },
      };
    }
    if (res?.error === "not_authorized") {
      return {
        shouldContinue: false,
        reply: {
          text: `🔒 ${res.message ?? "This approval can only be approved by the owner in the web UI or Telegram."}`,
        },
      };
    }
    if (res?.error === "option_not_allowed") {
      return {
        shouldContinue: false,
        reply: { text: "❌ That option isn't available for this request." },
      };
    }
  } catch (err) {
    logVerbose(`/approve: approvals.resolve failed, trying exec path: ${String(err)}`);
  }
  try {
    await callGateway({
      method: "exec.approval.resolve",
      params: { id: parsed.id, decision: parsed.decision },
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: `Chat approval (${resolvedBy})`,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
    });
  } catch (err) {
    return {
      shouldContinue: false,
      reply: {
        text: `❌ Failed to submit approval: ${String(err)}`,
      },
    };
  }

  return {
    shouldContinue: false,
    reply: { text: `✅ Exec approval ${parsed.decision} submitted for ${parsed.id}.` },
  };
};
