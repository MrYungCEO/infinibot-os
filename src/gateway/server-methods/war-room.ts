/**
 * AI War Room — Gateway RPC Handlers
 *
 * Registers all war room RPC methods with the gateway.
 * Follows the standard GatewayRequestHandlers pattern.
 */

import type { GatewayRequestHandlers } from "./types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import {
  createWarRoomSession,
  getSession,
  listSessions,
  deleteSession,
  startDebate,
  runNextPhase,
  advanceSessionPhase,
  runAgentTurn,
  addManualMessage,
  createProposal,
  castVote,
  ceoOverride,
  requireSession,
} from "../../war-room/orchestrator.js";
import { getMonitorManager } from "../../war-room/monitor-manager.js";
import { getWarRoomBus } from "../../war-room/message-bus.js";
import {
  createReviewRequest,
  runFullReview,
  runAgentReview,
  ceoOverrideReview,
} from "../../war-room/visual-verifier.js";
import type {
  WarRoomScenario,
  WarRoomSessionStatus,
  WarRoomAgentRole,
  WarRoomMessageType,
  WarRoomVote,
  WarRoomPhase,
} from "../../war-room/types.js";

// ─── Validation Helpers ───────────────────────────────────────────────────────

function isString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isNumber(v: unknown): v is number {
  return typeof v === "number";
}

const VALID_SCENARIOS: WarRoomScenario[] = [
  "website-upgrade",
  "product-launch",
  "growth-strategy",
  "technical-review",
  "financial-planning",
  "crisis-management",
  "custom",
];

const VALID_ROLES: WarRoomAgentRole[] = ["ceo", "cto", "cmo", "cfo", "ops"];

const VALID_VOTES: WarRoomVote[] = ["approve", "reject", "abstain", "revise"];

const VALID_MESSAGE_TYPES: WarRoomMessageType[] = [
  "proposal",
  "analysis",
  "vote",
  "challenge",
  "decision",
  "execution",
  "review",
  "status",
  "system",
];

const VALID_PHASES: WarRoomPhase[] = [
  "briefing",
  "analysis",
  "debate",
  "proposal",
  "voting",
  "decision",
  "execution",
  "review",
  "reporting",
];

// ─── Handlers ────────────────────────────────────────────────────────────────

export const warRoomHandlers: GatewayRequestHandlers = {
  // ─── Session Management ───────────────────────────────────────────────────

  "war.room.session.create": async ({ params, respond }) => {
    const p = params as Record<string, unknown>;

    if (!isString(p.title)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "title is required"));
      return;
    }
    if (!isString(p.scenario) || !VALID_SCENARIOS.includes(p.scenario as WarRoomScenario)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `scenario must be one of: ${VALID_SCENARIOS.join(", ")}`,
        ),
      );
      return;
    }
    if (!isString(p.scenarioContext)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "scenarioContext is required"),
      );
      return;
    }

    try {
      const session = createWarRoomSession({
        title: p.title,
        scenario: p.scenario as WarRoomScenario,
        scenarioContext: p.scenarioContext,
        maxRounds: isNumber(p.maxRounds) ? p.maxRounds : undefined,
        agentModel: isString(p.agentModel) ? p.agentModel : undefined,
      });

      // Initialize monitor manager for this session
      const monitorManager = getMonitorManager();
      monitorManager.initSession(session);

      respond(true, { session });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INTERNAL_ERROR,
          `Failed to create session: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  },

  "war.room.sessions.list": ({ params, respond }) => {
    const p = params as Record<string, unknown>;
    try {
      const sessions = listSessions({
        limit: isNumber(p.limit) ? p.limit : undefined,
        status: isString(p.status) ? (p.status as WarRoomSessionStatus) : undefined,
      });
      respond(true, { sessions, total: sessions.length });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INTERNAL_ERROR,
          `Failed to list sessions: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  },

  "war.room.session.get": ({ params, respond }) => {
    const p = params as Record<string, unknown>;
    if (!isString(p.sessionId)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionId is required"));
      return;
    }
    const session = getSession(p.sessionId);
    if (!session) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.NOT_FOUND, `Session not found: ${p.sessionId}`),
      );
      return;
    }
    respond(true, { session });
  },

  "war.room.session.delete": ({ params, respond }) => {
    const p = params as Record<string, unknown>;
    if (!isString(p.sessionId)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionId is required"));
      return;
    }
    const existed = deleteSession(p.sessionId);
    getMonitorManager().destroySession(p.sessionId);
    respond(true, { deleted: existed });
  },

  // ─── Debate Control ───────────────────────────────────────────────────────

  "war.room.debate.start": async ({ params, respond }) => {
    const p = params as Record<string, unknown>;
    if (!isString(p.sessionId)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionId is required"));
      return;
    }

    try {
      const session = requireSession(p.sessionId);
      respond(true, { session, started: true });

      // Run debate asynchronously — results stream via WebSocket events
      void startDebate(session).catch((err) => {
        const bus = getWarRoomBus();
        bus.publish({
          type: "session.status.changed",
          sessionId: session.id,
          payload: {
            from: session.status,
            to: "failed",
            error: err instanceof Error ? err.message : String(err),
          },
          timestamp: Date.now(),
        });
      });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, err instanceof Error ? err.message : String(err)),
      );
    }
  },

  "war.room.phase.advance": async ({ params, respond }) => {
    const p = params as Record<string, unknown>;
    if (!isString(p.sessionId)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionId is required"));
      return;
    }

    const toPhase =
      isString(p.toPhase) && VALID_PHASES.includes(p.toPhase as WarRoomPhase)
        ? (p.toPhase as WarRoomPhase)
        : undefined;

    try {
      const session = requireSession(p.sessionId);
      await advanceSessionPhase(session, toPhase);
      respond(true, { session, phase: session.currentPhase });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, err instanceof Error ? err.message : String(err)),
      );
    }
  },

  "war.room.phase.run": async ({ params, respond }) => {
    const p = params as Record<string, unknown>;
    if (!isString(p.sessionId)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionId is required"));
      return;
    }

    try {
      const session = requireSession(p.sessionId);
      respond(true, { session, phase: session.currentPhase });
      // Run the next phase asynchronously
      void runNextPhase(session);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, err instanceof Error ? err.message : String(err)),
      );
    }
  },

  // ─── Agent Turns ──────────────────────────────────────────────────────────

  "war.room.agent.turn": async ({ params, respond }) => {
    const p = params as Record<string, unknown>;
    if (!isString(p.sessionId)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionId is required"));
      return;
    }
    if (!isString(p.agentRole) || !VALID_ROLES.includes(p.agentRole as WarRoomAgentRole)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `agentRole must be one of: ${VALID_ROLES.join(", ")}`,
        ),
      );
      return;
    }

    try {
      const session = requireSession(p.sessionId);
      const agent = session.agents.find((a) => a.role === p.agentRole);
      if (!agent) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.NOT_FOUND, `Agent not found for role: ${p.agentRole}`),
        );
        return;
      }

      respond(true, { started: true });
      // Run asynchronously — streams via bus/WebSocket
      void runAgentTurn({
        session,
        agent,
        promptOverride: isString(p.prompt) ? p.prompt : undefined,
        messageType:
          isString(p.messageType) &&
          VALID_MESSAGE_TYPES.includes(p.messageType as WarRoomMessageType)
            ? (p.messageType as WarRoomMessageType)
            : undefined,
        toRole:
          isString(p.toRole) && VALID_ROLES.includes(p.toRole as WarRoomAgentRole)
            ? (p.toRole as WarRoomAgentRole)
            : undefined,
      });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, err instanceof Error ? err.message : String(err)),
      );
    }
  },

  // ─── Manual Messaging ─────────────────────────────────────────────────────

  "war.room.message.send": ({ params, respond }) => {
    const p = params as Record<string, unknown>;
    if (!isString(p.sessionId)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionId is required"));
      return;
    }
    if (!isString(p.fromRole) || !VALID_ROLES.includes(p.fromRole as WarRoomAgentRole)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `fromRole must be one of: ${VALID_ROLES.join(", ")}`,
        ),
      );
      return;
    }
    if (!isString(p.content)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "content is required"));
      return;
    }

    try {
      const session = requireSession(p.sessionId);
      const msg = addManualMessage(session, {
        fromRole: p.fromRole as WarRoomAgentRole,
        content: p.content,
        type:
          isString(p.type) && VALID_MESSAGE_TYPES.includes(p.type as WarRoomMessageType)
            ? (p.type as WarRoomMessageType)
            : undefined,
        toRole:
          isString(p.toRole) && VALID_ROLES.includes(p.toRole as WarRoomAgentRole)
            ? (p.toRole as WarRoomAgentRole)
            : undefined,
        replyToId: isString(p.replyToId) ? p.replyToId : undefined,
      });
      respond(true, { message: msg });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, err instanceof Error ? err.message : String(err)),
      );
    }
  },

  // ─── Proposals & Voting ───────────────────────────────────────────────────

  "war.room.proposal.create": ({ params, respond }) => {
    const p = params as Record<string, unknown>;
    if (!isString(p.sessionId)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionId is required"));
      return;
    }
    if (
      !isString(p.proposedByRole) ||
      !VALID_ROLES.includes(p.proposedByRole as WarRoomAgentRole)
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `proposedByRole must be one of: ${VALID_ROLES.join(", ")}`,
        ),
      );
      return;
    }
    if (!isString(p.title)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "title is required"));
      return;
    }
    if (!isString(p.description)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "description is required"));
      return;
    }

    try {
      const session = requireSession(p.sessionId);
      const proposal = createProposal(session, {
        proposedByRole: p.proposedByRole as WarRoomAgentRole,
        title: p.title,
        description: p.description,
      });
      respond(true, { proposal });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, err instanceof Error ? err.message : String(err)),
      );
    }
  },

  "war.room.proposal.vote": ({ params, respond }) => {
    const p = params as Record<string, unknown>;
    if (!isString(p.sessionId)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionId is required"));
      return;
    }
    if (!isString(p.proposalId)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "proposalId is required"));
      return;
    }
    if (!isString(p.agentRole) || !VALID_ROLES.includes(p.agentRole as WarRoomAgentRole)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `agentRole must be one of: ${VALID_ROLES.join(", ")}`,
        ),
      );
      return;
    }
    if (!isString(p.vote) || !VALID_VOTES.includes(p.vote as WarRoomVote)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `vote must be one of: ${VALID_VOTES.join(", ")}`),
      );
      return;
    }

    try {
      const session = requireSession(p.sessionId);
      const proposal = castVote(session, {
        proposalId: p.proposalId,
        agentRole: p.agentRole as WarRoomAgentRole,
        vote: p.vote as WarRoomVote,
        reason: isString(p.reason) ? p.reason : undefined,
      });
      respond(true, { proposal });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, err instanceof Error ? err.message : String(err)),
      );
    }
  },

  "war.room.proposal.ceo.override": ({ params, respond }) => {
    const p = params as Record<string, unknown>;
    if (!isString(p.sessionId)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionId is required"));
      return;
    }
    if (!isString(p.proposalId)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "proposalId is required"));
      return;
    }
    if (!isString(p.vote) || !VALID_VOTES.includes(p.vote as WarRoomVote)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `vote must be one of: ${VALID_VOTES.join(", ")}`),
      );
      return;
    }
    if (!isString(p.reason)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "reason is required"));
      return;
    }

    try {
      const session = requireSession(p.sessionId);
      const proposal = ceoOverride(session, {
        proposalId: p.proposalId,
        vote: p.vote as WarRoomVote,
        reason: p.reason,
      });
      respond(true, { proposal });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, err instanceof Error ? err.message : String(err)),
      );
    }
  },

  // ─── Monitor State ────────────────────────────────────────────────────────

  "war.room.monitors.get": ({ params, respond }) => {
    const p = params as Record<string, unknown>;
    if (!isString(p.sessionId)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionId is required"));
      return;
    }

    try {
      const monitorManager = getMonitorManager();
      const monitors = monitorManager.getSnapshot(p.sessionId);
      respond(true, { monitors });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, err instanceof Error ? err.message : String(err)),
      );
    }
  },

  // ─── Visual Review ────────────────────────────────────────────────────────

  "war.room.review.create": ({ params, respond }) => {
    const p = params as Record<string, unknown>;
    if (!isString(p.sessionId)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionId is required"));
      return;
    }
    if (!p.artifact || typeof p.artifact !== "object") {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "artifact is required"));
      return;
    }

    try {
      const session = requireSession(p.sessionId);
      const reviewerRoles = Array.isArray(p.reviewerRoles)
        ? (p.reviewerRoles as string[]).filter((r): r is WarRoomAgentRole =>
            VALID_ROLES.includes(r as WarRoomAgentRole),
          )
        : VALID_ROLES;

      const reviewRequest = createReviewRequest(session, {
        artifact: p.artifact as Parameters<typeof createReviewRequest>[1]["artifact"],
        reviewerRoles,
        maxIterations: isNumber(p.maxIterations) ? p.maxIterations : undefined,
      });

      respond(true, { reviewRequest });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, err instanceof Error ? err.message : String(err)),
      );
    }
  },

  "war.room.review.run": async ({ params, respond }) => {
    const p = params as Record<string, unknown>;
    if (!isString(p.sessionId)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionId is required"));
      return;
    }
    if (!isString(p.reviewRequestId)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "reviewRequestId is required"),
      );
      return;
    }

    try {
      const session = requireSession(p.sessionId);
      respond(true, { started: true });
      // Run asynchronously — results stream via bus
      void runFullReview(session, p.reviewRequestId);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, err instanceof Error ? err.message : String(err)),
      );
    }
  },

  "war.room.review.agent": async ({ params, respond }) => {
    const p = params as Record<string, unknown>;
    if (!isString(p.sessionId)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionId is required"));
      return;
    }
    if (!isString(p.reviewRequestId)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "reviewRequestId is required"),
      );
      return;
    }
    if (!isString(p.reviewerRole) || !VALID_ROLES.includes(p.reviewerRole as WarRoomAgentRole)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `reviewerRole must be one of: ${VALID_ROLES.join(", ")}`,
        ),
      );
      return;
    }

    try {
      const session = requireSession(p.sessionId);
      const review = await runAgentReview(
        session,
        p.reviewRequestId,
        p.reviewerRole as WarRoomAgentRole,
      );
      respond(true, { review });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, err instanceof Error ? err.message : String(err)),
      );
    }
  },

  "war.room.review.ceo.override": ({ params, respond }) => {
    const p = params as Record<string, unknown>;
    if (!isString(p.reviewRequestId)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "reviewRequestId is required"),
      );
      return;
    }
    if (!isString(p.decision)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "decision is required"));
      return;
    }

    try {
      const request = ceoOverrideReview(
        p.reviewRequestId,
        p.decision as "approved" | "rejected" | "needs-revision",
      );
      respond(true, { reviewRequest: request });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, err instanceof Error ? err.message : String(err)),
      );
    }
  },
};
