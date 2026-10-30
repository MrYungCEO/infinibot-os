/**
 * AI War Room — Orchestrator
 *
 * Manages multi-agent conversation flow: propose → debate → vote → execute.
 * Uses @anthropic-ai/sdk for direct LLM calls, broadcasting results
 * via the WarRoomMessageBus.
 */

import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type {
  WarRoomSession,
  WarRoomMessage,
  WarRoomProposal,
  WarRoomAgent,
  WarRoomAgentRole,
  WarRoomPhase,
  WarRoomSessionStatus,
  WarRoomScenario,
  WarRoomMessageType,
  WarRoomVote,
  WarRoomArtifact,
  WarRoomStore,
  WarRoomSessionSummary,
} from "./types.js";
import { getWarRoomBus } from "./message-bus.js";
import {
  createDefaultAgents,
  buildScenarioBriefing,
  buildAgentContext,
  SCENARIO_BRIEFINGS,
  WAR_ROOM_DEFAULT_MODEL,
} from "./agents.js";
import { collectAnthropicApiKeys } from "../agents/live-auth-keys.js";

// ─── In-Memory Store (singleton) ─────────────────────────────────────────────

const _store: WarRoomStore = {
  sessions: new Map(),
  reviewRequests: new Map(),
};

export function getWarRoomStore(): WarRoomStore {
  return _store;
}

// ─── Anthropic Client Factory ─────────────────────────────────────────────────

function createAnthropicClient(): Anthropic {
  const keys = collectAnthropicApiKeys();
  const apiKey = keys[0] ?? process.env.ANTHROPIC_API_KEY ?? "";
  return new Anthropic({ apiKey });
}

// ─── Session Lifecycle ────────────────────────────────────────────────────────

export interface CreateSessionOptions {
  title: string;
  scenario: WarRoomScenario;
  scenarioContext: string;
  maxRounds?: number;
  agentModel?: string;
}

export function createWarRoomSession(opts: CreateSessionOptions): WarRoomSession {
  const id = randomUUID();
  const agents = createDefaultAgents(opts.agentModel ?? WAR_ROOM_DEFAULT_MODEL);
  const now = Date.now();

  const session: WarRoomSession = {
    id,
    title: opts.title,
    scenario: opts.scenario,
    scenarioContext: opts.scenarioContext,
    status: "initializing",
    agents,
    messages: [],
    proposals: [],
    currentPhase: "briefing",
    turnOrder: ["ceo", "cto", "cmo", "cfo", "ops"],
    currentTurnIndex: 0,
    maxRounds: opts.maxRounds ?? 3,
    currentRound: 1,
    createdAt: now,
    updatedAt: now,
    metadata: {},
  };

  _store.sessions.set(id, session);
  return session;
}

export function getSession(sessionId: string): WarRoomSession | undefined {
  return _store.sessions.get(sessionId);
}

export function listSessions(
  opts: {
    limit?: number;
    status?: WarRoomSessionStatus;
  } = {},
): WarRoomSessionSummary[] {
  const sessions = Array.from(_store.sessions.values());
  let filtered = opts.status ? sessions.filter((s) => s.status === opts.status) : sessions;

  filtered = filtered.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, opts.limit ?? 50);

  return filtered.map((s) => ({
    id: s.id,
    title: s.title,
    scenario: s.scenario,
    status: s.status,
    currentPhase: s.currentPhase,
    messageCount: s.messages.length,
    proposalCount: s.proposals.length,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  }));
}

export function deleteSession(sessionId: string): boolean {
  const existed = _store.sessions.has(sessionId);
  _store.sessions.delete(sessionId);
  getWarRoomBus().unsubscribeSession(sessionId);
  return existed;
}

// ─── Session State Transitions ────────────────────────────────────────────────

function updateSessionStatus(session: WarRoomSession, status: WarRoomSessionStatus): void {
  const prev = session.status;
  session.status = status;
  session.updatedAt = Date.now();
  getWarRoomBus().publishStatusChanged(session.id, prev, status, session);
}

function advancePhase(session: WarRoomSession, toPhase?: WarRoomPhase): void {
  const scenario = SCENARIO_BRIEFINGS[session.scenario];
  const phases = scenario.phases as WarRoomPhase[];

  let next: WarRoomPhase;
  if (toPhase) {
    next = toPhase;
  } else {
    const currentIdx = phases.indexOf(session.currentPhase);
    if (currentIdx === -1 || currentIdx >= phases.length - 1) {
      next = "reporting";
    } else {
      next = phases[currentIdx + 1];
    }
  }

  const prev = session.currentPhase;
  session.currentPhase = next;
  session.updatedAt = Date.now();
  getWarRoomBus().publishPhaseChanged(session.id, prev, next);
}

// ─── Message Creation ─────────────────────────────────────────────────────────

function createMessage(
  session: WarRoomSession,
  opts: {
    fromAgent: WarRoomAgent;
    type: WarRoomMessageType;
    content: string;
    toRole?: WarRoomAgentRole;
    replyToId?: string;
    artifacts?: WarRoomArtifact[];
    proposalId?: string;
    vote?: WarRoomVote;
  },
): WarRoomMessage {
  const msg: WarRoomMessage = {
    id: randomUUID(),
    sessionId: session.id,
    fromAgentId: opts.fromAgent.id,
    fromRole: opts.fromAgent.role,
    toRole: opts.toRole,
    type: opts.type,
    content: opts.content,
    artifacts: opts.artifacts,
    proposalId: opts.proposalId,
    vote: opts.vote,
    replyToId: opts.replyToId,
    timestamp: Date.now(),
    targetMonitor: opts.fromAgent.monitorIndex,
  };

  session.messages.push(msg);
  session.updatedAt = Date.now();
  getWarRoomBus().publishMessage(session.id, msg);

  return msg;
}

// ─── LLM Invocation ──────────────────────────────────────────────────────────

interface RunAgentTurnOpts {
  session: WarRoomSession;
  agent: WarRoomAgent;
  promptOverride?: string;
  messageType?: WarRoomMessageType;
  toRole?: WarRoomAgentRole;
  replyToId?: string;
}

export async function runAgentTurn(opts: RunAgentTurnOpts): Promise<WarRoomMessage> {
  const { session, agent, promptOverride, messageType = "analysis", toRole, replyToId } = opts;
  const bus = getWarRoomBus();

  // Mark monitor as typing
  bus.publishAgentTurnStart(session.id, agent.role, agent.id, agent.monitorIndex);
  bus.publishMonitorHighlight(session.id, agent.monitorIndex, true);

  const client = createAnthropicClient();

  // Build conversation history from session messages (last 20 for context window)
  const recentMessages = session.messages.slice(-20);
  const conversationContext = recentMessages
    .map((m) => {
      const agentName = session.agents.find((a) => a.id === m.fromAgentId)?.name ?? m.fromRole;
      return `[${agentName} (${m.fromRole.toUpperCase()})]: ${m.content}`;
    })
    .join("\n\n");

  // Build the user prompt
  const userPrompt = promptOverride ?? buildPhasePrompt(session, agent, conversationContext);

  // Streaming response
  let fullContent = "";
  const messageId = randomUUID();
  const now = Date.now();

  // Create a placeholder message for streaming
  const streamMsg: WarRoomMessage = {
    id: messageId,
    sessionId: session.id,
    fromAgentId: agent.id,
    fromRole: agent.role,
    toRole,
    type: messageType,
    content: "",
    streamContent: "",
    streaming: true,
    replyToId,
    timestamp: now,
    targetMonitor: agent.monitorIndex,
  };

  session.messages.push(streamMsg);

  try {
    const stream = client.messages.stream({
      model: agent.model ?? WAR_ROOM_DEFAULT_MODEL,
      max_tokens: 1024,
      system: buildAgentContext(agent, session.scenario, session.scenarioContext),
      messages: [{ role: "user", content: userPrompt }],
    });

    for await (const chunk of stream) {
      if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
        const delta = chunk.delta.text;
        fullContent += delta;
        streamMsg.streamContent = fullContent;
        bus.publishMessageStream(session.id, messageId, delta, agent.monitorIndex);
      }
    }
  } catch (err) {
    fullContent = `[Agent ${agent.name} encountered an error: ${err instanceof Error ? err.message : String(err)}]`;
  }

  // Finalize the message
  streamMsg.content = fullContent;
  streamMsg.streamContent = undefined;
  streamMsg.streaming = false;

  session.updatedAt = Date.now();
  bus.publishMessageDone(session.id, streamMsg);
  bus.publishAgentTurnEnd(session.id, agent.role, agent.id, agent.monitorIndex);
  bus.publishMonitorHighlight(session.id, agent.monitorIndex, false);

  return streamMsg;
}

// ─── Phase Prompts ────────────────────────────────────────────────────────────

function buildPhasePrompt(
  session: WarRoomSession,
  agent: WarRoomAgent,
  conversationContext: string,
): string {
  const phase = session.currentPhase;
  const scenario = SCENARIO_BRIEFINGS[session.scenario];

  const contextBlock = conversationContext
    ? `\n\n## Prior Discussion\n${conversationContext}\n`
    : "";

  switch (phase) {
    case "briefing":
      return `${buildScenarioBriefing(session.scenario, session.scenarioContext)}${contextBlock}

As ${agent.name} (${agent.title}), provide your initial analysis. Focus on: ${scenario.focus[agent.role]}`;

    case "analysis":
      return `${contextBlock}
Based on the briefing, provide your detailed domain analysis as ${agent.title}.
Focus specifically on: ${scenario.focus[agent.role]}

Be specific, quantitative where possible, and flag your key concerns.`;

    case "debate":
      return `${contextBlock}
We are now in open debate. As ${agent.title}, respond to the discussion above.
- Challenge or support specific points made by other executives
- Add new perspectives from your domain
- Ask clarifying questions
Keep it sharp and substantive.`;

    case "proposal":
      return `${contextBlock}
As ${agent.title}, submit a formal proposal for your recommended course of action.
Structure it as:
**Title:** [Brief title]
**Recommendation:** [What you propose]
**Rationale:** [Why this is the right move]
**Tradeoffs:** [What we give up]
**Success Criteria:** [How we know it worked]
**Owner:** [Who does what]`;

    case "voting":
      return `${contextBlock}
As ${agent.title}, you are voting on the proposals above.
For each proposal, state: APPROVE / REJECT / ABSTAIN / REVISE and your brief reasoning.
Be decisive.`;

    case "decision":
      return `${contextBlock}
Summarize the debate and your final position as ${agent.title}.
State what decision you support and what your role in execution will be.`;

    case "execution":
      return `${contextBlock}
As ${agent.title}, lay out your execution plan.
Include:
- Specific tasks you will own
- Dependencies on other executives
- Timeline
- Success metrics
- Risks and mitigations`;

    case "review":
      return `${contextBlock}
As ${agent.title}, review the execution outputs above.
For each output in your domain:
- APPROVE, REJECT, or request REVISION
- Give specific, actionable feedback
- Flag any issues that could cause failures`;

    case "reporting":
      return `${contextBlock}
As ${agent.title}, provide your final summary for the session report.
Include:
- What was decided
- What you committed to execute
- Open items / follow-ups
- Lessons learned from this session`;

    default:
      return `${contextBlock}
As ${agent.title}, contribute your perspective on the current discussion.`;
  }
}

// ─── Full Debate Orchestration ────────────────────────────────────────────────

export async function startDebate(session: WarRoomSession): Promise<void> {
  updateSessionStatus(session, "active");

  // Run each agent in turn for the briefing phase
  await runPhase(session, "briefing");
  advancePhase(session);

  // Analysis round — all agents analyze
  await runPhase(session, "analysis");
  advancePhase(session);
}

export async function runNextPhase(session: WarRoomSession): Promise<void> {
  await runPhase(session, session.currentPhase);
  advancePhase(session);
}

export async function advanceSessionPhase(
  session: WarRoomSession,
  toPhase?: WarRoomPhase,
): Promise<void> {
  advancePhase(session, toPhase);
}

async function runPhase(session: WarRoomSession, phase: WarRoomPhase): Promise<void> {
  const phaseStatusMap: Record<WarRoomPhase, WarRoomSessionStatus> = {
    briefing: "active",
    analysis: "active",
    debate: "deliberating",
    proposal: "deliberating",
    voting: "deliberating",
    decision: "deliberating",
    execution: "executing",
    review: "reviewing",
    reporting: "reviewing",
  };

  updateSessionStatus(session, phaseStatusMap[phase] ?? "active");

  // Run each agent sequentially in their turn order
  for (const role of session.turnOrder) {
    const agent = session.agents.find((a) => a.role === role);
    if (!agent) continue;

    const messageType = phaseToMessageType(phase);
    await runAgentTurn({
      session,
      agent,
      messageType,
    });

    // Small delay between agent turns for better UX
    await sleep(500);
  }
}

function phaseToMessageType(phase: WarRoomPhase): WarRoomMessageType {
  switch (phase) {
    case "briefing":
    case "analysis":
      return "analysis";
    case "debate":
      return "challenge";
    case "proposal":
      return "proposal";
    case "voting":
      return "vote";
    case "decision":
      return "decision";
    case "execution":
      return "execution";
    case "review":
      return "review";
    case "reporting":
      return "status";
    default:
      return "analysis";
  }
}

// ─── Manual Message Injection ─────────────────────────────────────────────────

export function addManualMessage(
  session: WarRoomSession,
  opts: {
    fromRole: WarRoomAgentRole;
    content: string;
    type?: WarRoomMessageType;
    toRole?: WarRoomAgentRole;
    replyToId?: string;
  },
): WarRoomMessage {
  const agent = session.agents.find((a) => a.role === opts.fromRole);
  if (!agent) throw new Error(`Agent not found for role: ${opts.fromRole}`);

  return createMessage(session, {
    fromAgent: agent,
    type: opts.type ?? "analysis",
    content: opts.content,
    toRole: opts.toRole,
    replyToId: opts.replyToId,
  });
}

// ─── Proposal Management ──────────────────────────────────────────────────────

export function createProposal(
  session: WarRoomSession,
  opts: {
    proposedByRole: WarRoomAgentRole;
    title: string;
    description: string;
    artifacts?: WarRoomArtifact[];
  },
): WarRoomProposal {
  const now = Date.now();
  const proposal: WarRoomProposal = {
    id: randomUUID(),
    sessionId: session.id,
    proposedByRole: opts.proposedByRole,
    title: opts.title,
    description: opts.description,
    artifacts: opts.artifacts,
    votes: {
      ceo: undefined,
      cto: undefined,
      cmo: undefined,
      cfo: undefined,
      ops: undefined,
    },
    status: "open",
    createdAt: now,
    updatedAt: now,
  };

  session.proposals.push(proposal);
  session.updatedAt = Date.now();
  getWarRoomBus().publishProposalCreated(session.id, proposal);

  return proposal;
}

export function castVote(
  session: WarRoomSession,
  opts: {
    proposalId: string;
    agentRole: WarRoomAgentRole;
    vote: WarRoomVote;
    reason?: string;
  },
): WarRoomProposal {
  const proposal = session.proposals.find((p) => p.id === opts.proposalId);
  if (!proposal) throw new Error(`Proposal not found: ${opts.proposalId}`);
  if (proposal.status !== "open" && proposal.status !== "voting") {
    throw new Error(`Proposal is not open for voting (status: ${proposal.status})`);
  }

  proposal.votes[opts.agentRole] = opts.vote;
  proposal.status = "voting";
  proposal.updatedAt = Date.now();
  session.updatedAt = Date.now();

  getWarRoomBus().publishProposalVote(
    session.id,
    proposal.id,
    opts.agentRole,
    opts.vote,
    opts.reason,
  );

  // Check if all votes are in
  const allVoted = (Object.keys(proposal.votes) as WarRoomAgentRole[]).every(
    (role) => proposal.votes[role] !== undefined,
  );

  if (allVoted) {
    resolveProposal(session, proposal);
  }

  return proposal;
}

export function ceoOverride(
  session: WarRoomSession,
  opts: {
    proposalId: string;
    vote: WarRoomVote;
    reason: string;
  },
): WarRoomProposal {
  const proposal = session.proposals.find((p) => p.id === opts.proposalId);
  if (!proposal) throw new Error(`Proposal not found: ${opts.proposalId}`);

  proposal.ceoOverride = opts.vote;
  proposal.ceoOverrideReason = opts.reason;
  proposal.updatedAt = Date.now();
  session.updatedAt = Date.now();

  resolveProposal(session, proposal);
  return proposal;
}

function resolveProposal(session: WarRoomSession, proposal: WarRoomProposal): void {
  // CEO override takes precedence
  if (proposal.ceoOverride) {
    proposal.status = proposal.ceoOverride === "approve" ? "approved" : "rejected";
  } else {
    // Count votes
    const votes = Object.values(proposal.votes).filter(Boolean) as WarRoomVote[];
    const approves = votes.filter((v) => v === "approve").length;
    const rejects = votes.filter((v) => v === "reject").length;
    const revises = votes.filter((v) => v === "revise").length;

    if (revises > 0) {
      proposal.status = "open"; // back to open for revision
    } else if (approves > rejects) {
      proposal.status = "approved";
    } else {
      proposal.status = "rejected";
    }
  }

  proposal.resolvedAt = Date.now();
  proposal.updatedAt = Date.now();
  session.updatedAt = Date.now();

  getWarRoomBus().publishProposalResolved(session.id, proposal);
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Get a session or throw with a clear error */
export function requireSession(sessionId: string): WarRoomSession {
  const session = getSession(sessionId);
  if (!session) throw new Error(`War room session not found: ${sessionId}`);
  return session;
}
