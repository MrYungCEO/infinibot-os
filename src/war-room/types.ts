/**
 * AI War Room — Type Definitions
 *
 * Multi-agent conversation system with multi-monitor support.
 * Each agent has a distinct executive role (CEO, CTO, CMO, CFO, Ops)
 * and communicates via a structured message bus.
 */

// ─── Agent Roles ─────────────────────────────────────────────────────────────

export type WarRoomAgentRole = "ceo" | "cto" | "cmo" | "cfo" | "ops";

export interface WarRoomAgent {
  id: string;
  role: WarRoomAgentRole;
  name: string;
  title: string;
  systemPrompt: string;
  model?: string;
  /** Index 0–4 maps to monitor assignment */
  monitorIndex: number;
  /** Hex color for UI highlighting */
  accentColor: string;
  /** Icon identifier */
  icon: string;
}

// ─── Messages ────────────────────────────────────────────────────────────────

export type WarRoomMessageType =
  | "proposal" // Agent proposes an action or decision
  | "analysis" // Agent analyzes a topic or artifact
  | "vote" // Agent casts a vote on a proposal
  | "challenge" // Agent challenges another's proposal
  | "decision" // Final decision (CEO override or consensus)
  | "execution" // Agent reports executing a task
  | "review" // Agent reviews another agent's output
  | "status" // Status update / progress report
  | "system"; // System-level message (session start, end, etc.)

export type WarRoomVote = "approve" | "reject" | "abstain" | "revise";

export interface WarRoomMessage {
  id: string;
  sessionId: string;
  fromAgentId: string;
  fromRole: WarRoomAgentRole;
  toAgentId?: string; // undefined = broadcast to all
  toRole?: WarRoomAgentRole;
  type: WarRoomMessageType;
  content: string;
  /** Streaming content (partial, before done) */
  streamContent?: string;
  streaming?: boolean;
  /** For vote messages */
  vote?: WarRoomVote;
  /** For proposal/decision messages */
  proposalId?: string;
  /** Reference to a prior message this replies to */
  replyToId?: string;
  /** Attached artifacts (code, design, copy, etc.) */
  artifacts?: WarRoomArtifact[];
  timestamp: number;
  /** Monitor index this message is primarily targeted at */
  targetMonitor?: number;
  metadata?: Record<string, unknown>;
}

export interface WarRoomArtifact {
  id: string;
  type: "code" | "markdown" | "json" | "image" | "url" | "plan";
  title: string;
  content: string;
  language?: string; // for code artifacts
  mimeType?: string;
  createdByRole: WarRoomAgentRole;
  reviewStatus?: "pending" | "approved" | "rejected" | "needs-revision";
  reviewNotes?: string;
}

// ─── Proposals & Decisions ───────────────────────────────────────────────────

export type ProposalStatus = "open" | "voting" | "approved" | "rejected" | "executed" | "abandoned";

export interface WarRoomProposal {
  id: string;
  sessionId: string;
  proposedByRole: WarRoomAgentRole;
  title: string;
  description: string;
  artifacts?: WarRoomArtifact[];
  votes: Record<WarRoomAgentRole, WarRoomVote | undefined>;
  status: ProposalStatus;
  /** CEO can override consensus */
  ceoOverride?: WarRoomVote;
  ceoOverrideReason?: string;
  executionPlan?: string;
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
}

// ─── Session ─────────────────────────────────────────────────────────────────

export type WarRoomSessionStatus =
  | "initializing"
  | "active"
  | "deliberating"
  | "executing"
  | "reviewing"
  | "paused"
  | "completed"
  | "failed";

export type WarRoomScenario =
  | "website-upgrade" // Upgrade website components
  | "product-launch" // Plan a product launch
  | "growth-strategy" // Develop growth strategy
  | "technical-review" // Technical architecture review
  | "financial-planning" // Financial planning & projections
  | "crisis-management" // Handle an incident or crisis
  | "custom"; // User-defined scenario

export interface WarRoomSession {
  id: string;
  title: string;
  scenario: WarRoomScenario;
  scenarioContext: string; // The brief / initial context passed to agents
  status: WarRoomSessionStatus;
  agents: WarRoomAgent[];
  messages: WarRoomMessage[];
  proposals: WarRoomProposal[];
  currentPhase: WarRoomPhase;
  activeAgentId?: string; // Which agent is currently "speaking"
  turnOrder: WarRoomAgentRole[]; // Rotation for structured debates
  currentTurnIndex: number;
  maxRounds: number;
  currentRound: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  executionResults?: WarRoomExecutionResult[];
  metadata?: Record<string, unknown>;
}

export type WarRoomPhase =
  | "briefing" // CEO briefs the team
  | "analysis" // Each agent analyzes from their domain
  | "debate" // Open debate and challenge
  | "proposal" // Agents submit formal proposals
  | "voting" // Vote on proposals
  | "decision" // CEO makes final call
  | "execution" // Agents execute their parts
  | "review" // Cross-agent review loop
  | "reporting"; // Final report generation

export interface WarRoomExecutionResult {
  agentId: string;
  role: WarRoomAgentRole;
  taskDescription: string;
  output: string;
  artifacts: WarRoomArtifact[];
  status: "pending" | "in-progress" | "completed" | "failed";
  startedAt?: number;
  completedAt?: number;
  reviewStatus?: "pending" | "approved" | "rejected";
  reviewedByRole?: WarRoomAgentRole;
}

// ─── Monitor State ───────────────────────────────────────────────────────────

export interface WarRoomMonitorState {
  /** 0–4 */
  index: number;
  agentRole: WarRoomAgentRole;
  isActive: boolean;
  /** Whether this monitor is highlighted (agent is speaking) */
  highlighted: boolean;
  /** Local message buffer for this monitor */
  messages: WarRoomMessage[];
  /** Current streaming content */
  streamBuffer: string;
  /** UI animation state */
  animState: MonitorAnimState;
  /** Last activity timestamp */
  lastActivityAt: number;
}

export type MonitorAnimState =
  | "idle"
  | "typing"
  | "speaking"
  | "reviewing"
  | "voting"
  | "executing"
  | "approved"
  | "rejected";

// ─── Message Bus Events ──────────────────────────────────────────────────────

export type WarRoomBusEventType =
  | "message.new"
  | "message.stream"
  | "message.done"
  | "proposal.created"
  | "proposal.vote"
  | "proposal.resolved"
  | "session.phase.changed"
  | "session.status.changed"
  | "monitor.highlight"
  | "monitor.update"
  | "agent.turn.start"
  | "agent.turn.end"
  | "execution.start"
  | "execution.progress"
  | "execution.done"
  | "review.requested"
  | "review.result";

export interface WarRoomBusEvent {
  type: WarRoomBusEventType;
  sessionId: string;
  payload: unknown;
  timestamp: number;
  /** Which monitors should receive this event (undefined = all) */
  targetMonitors?: number[];
}

// ─── Gateway RPC Types ───────────────────────────────────────────────────────

export interface WarRoomCreateSessionParams {
  title: string;
  scenario: WarRoomScenario;
  scenarioContext: string;
  maxRounds?: number;
  agentModel?: string;
}

export interface WarRoomListSessionsParams {
  limit?: number;
  status?: WarRoomSessionStatus;
}

export interface WarRoomGetSessionParams {
  sessionId: string;
}

export interface WarRoomStartDebateParams {
  sessionId: string;
}

export interface WarRoomSendMessageParams {
  sessionId: string;
  fromRole: WarRoomAgentRole;
  content: string;
  type?: WarRoomMessageType;
  toRole?: WarRoomAgentRole;
  replyToId?: string;
}

export interface WarRoomCastVoteParams {
  sessionId: string;
  proposalId: string;
  agentRole: WarRoomAgentRole;
  vote: WarRoomVote;
  reason?: string;
}

export interface WarRoomCeoOverrideParams {
  sessionId: string;
  proposalId: string;
  vote: WarRoomVote;
  reason: string;
}

export interface WarRoomAdvancePhaseParams {
  sessionId: string;
  toPhase?: WarRoomPhase;
}

export interface WarRoomRunAgentTurnParams {
  sessionId: string;
  agentRole: WarRoomAgentRole;
  prompt?: string; // Optional override prompt
}

export interface WarRoomGetMonitorStateParams {
  sessionId: string;
  monitorIndex?: number; // undefined = all monitors
}

export interface WarRoomDeleteSessionParams {
  sessionId: string;
}

// ─── Gateway Response Types ──────────────────────────────────────────────────

export interface WarRoomSessionResult {
  session: WarRoomSession;
}

export interface WarRoomSessionsListResult {
  sessions: WarRoomSessionSummary[];
  total: number;
}

export interface WarRoomSessionSummary {
  id: string;
  title: string;
  scenario: WarRoomScenario;
  status: WarRoomSessionStatus;
  currentPhase: WarRoomPhase;
  messageCount: number;
  proposalCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface WarRoomMessageResult {
  message: WarRoomMessage;
}

export interface WarRoomMonitorStateResult {
  monitors: WarRoomMonitorState[];
}

// ─── Visual Verifier Types ───────────────────────────────────────────────────

export type ReviewDecision = "approved" | "rejected" | "needs-revision";

export interface VisualReviewRequest {
  id: string;
  sessionId: string;
  artifactId: string;
  artifact: WarRoomArtifact;
  reviewerRoles: WarRoomAgentRole[];
  reviews: Record<WarRoomAgentRole, VisualReview | undefined>;
  consensus?: ReviewDecision;
  iteration: number;
  maxIterations: number;
  createdAt: number;
  completedAt?: number;
}

export interface VisualReview {
  role: WarRoomAgentRole;
  decision: ReviewDecision;
  feedback: string;
  suggestions?: string[];
  timestamp: number;
}

// ─── In-memory store interface ───────────────────────────────────────────────

export interface WarRoomStore {
  sessions: Map<string, WarRoomSession>;
  reviewRequests: Map<string, VisualReviewRequest>;
}
