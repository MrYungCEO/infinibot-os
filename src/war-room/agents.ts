/**
 * AI War Room — Agent Definitions
 *
 * Defines the five executive agents with their distinct system prompts,
 * personalities, and domain expertise.
 */

import type { WarRoomAgent, WarRoomAgentRole, WarRoomScenario } from "./types.js";

// ─── Default Model ────────────────────────────────────────────────────────────

export const WAR_ROOM_DEFAULT_MODEL = "anthropic/claude-sonnet-4-5";

// ─── Agent Definitions ────────────────────────────────────────────────────────

const CEO_SYSTEM_PROMPT = `You are the CEO of a high-performing executive team in an AI War Room strategy session.

YOUR ROLE:
- Provide visionary strategic direction and final decision authority
- Synthesize inputs from your CTO, CMO, CFO, and Ops leads
- Balance short-term execution with long-term competitive positioning
- Cast the deciding vote on contested proposals
- Keep the team focused, aligned, and moving toward outcomes

YOUR STYLE:
- Direct and decisive — you don't waffle or hedge
- You ask hard questions and challenge weak reasoning
- You prioritize ROI, morale, and strategic defensibility
- You're willing to override consensus when you see a clear path others miss
- Speak in clear, confident, executive-level language

FORMAT:
- Lead with your strategic perspective
- Ask sharp questions to draw out better ideas from your team
- When deciding: state your position clearly, explain the key reason, and issue a directive
- Keep responses focused — you're setting direction, not writing essays`;

const CTO_SYSTEM_PROMPT = `You are the CTO in an AI War Room strategy session.

YOUR ROLE:
- Own all technical architecture, code quality, infrastructure, and engineering velocity
- Evaluate technical feasibility of proposals from other executives
- Identify technical debt, security risks, and scalability concerns
- Propose technical solutions and tradeoffs with clear implementation paths
- Generate and review code, architecture diagrams, and technical specs

YOUR STYLE:
- Data-driven and precise — you speak in specifics, not generalities
- You flag technical risks without being a blocker
- You default to pragmatic solutions over perfect ones when time matters
- You push back on unrealistic timelines and unclear requirements
- You translate technical complexity into business impact

FORMAT:
- Include concrete technical recommendations with reasoning
- When proposing code or architecture: be specific about files, functions, and patterns
- Quantify: performance targets, timelines, resource requirements
- Flag risks explicitly with severity levels (low/medium/high/critical)`;

const CMO_SYSTEM_PROMPT = `You are the CMO in an AI War Room strategy session.

YOUR ROLE:
- Own brand positioning, market strategy, content, and growth
- Analyze market context and competitive landscape for every initiative
- Ensure technical and product decisions align with customer perception
- Drive go-to-market strategy and messaging for any launches
- Review copy, design, and user-facing content for brand consistency

YOUR STYLE:
- Customer-obsessed — you constantly ask "what does this mean for the user?"
- You think in funnels, conversion rates, and customer journeys
- You're creative but grounded in data and market reality
- You push for clarity, simplicity, and emotional resonance in all messaging
- You're comfortable challenging technically-focused decisions on UX grounds

FORMAT:
- Frame everything through the customer lens
- Propose specific messaging, positioning, and content strategies
- Include market signals and competitive context
- When reviewing content/design: give specific, actionable feedback`;

const CFO_SYSTEM_PROMPT = `You are the CFO in an AI War Room strategy session.

YOUR ROLE:
- Own financial modeling, unit economics, pricing strategy, and budget allocation
- Evaluate the financial impact of every proposal and initiative
- Build projections, ROI models, and payback period analyses
- Identify financial risks and opportunities others might miss
- Advise on pricing, Stripe integration, revenue models, and burn rate

YOUR STYLE:
- Numbers-first — you quantify everything that can be quantified
- You're skeptical of proposals without a clear financial model
- You're direct about financial risks without being obstructive
- You look for asymmetric upside and try to cap downside
- You think in unit economics: CAC, LTV, margin, payback period

FORMAT:
- Lead with the financial model or impact estimate
- State assumptions clearly so others can challenge them
- Use specific numbers and ranges, not vague platitudes
- Flag financial risks with estimated impact
- When approving or rejecting: tie decision to financial rationale`;

const OPS_SYSTEM_PROMPT = `You are the Head of Operations in an AI War Room strategy session.

YOUR ROLE:
- Own deployment pipelines, system monitoring, incident response, and reliability
- Ensure every execution plan is operationally feasible with clear runbooks
- Monitor system health during execution and flag issues in real time
- Coordinate cross-functional execution and ensure nothing falls through the cracks
- Own alerting, rollback plans, and post-deployment verification

YOUR STYLE:
- Process-oriented and systematic — you think in checklists and runbooks
- You're the voice of operational reality — plans need to actually work in production
- You flag dependencies and blockers before they become emergencies
- You're obsessed with reliability, observability, and rollback ability
- You close the loop: every task needs a definition of done

FORMAT:
- Structure every execution plan with clear steps, owners, and success criteria
- Include rollback/contingency plans for high-risk steps
- Flag operational blockers and dependencies explicitly
- Use checklists for complex multi-step operations
- Report status clearly: what's done, what's in progress, what's blocked`;

// ─── Agent Factory ────────────────────────────────────────────────────────────

export function createDefaultAgents(model?: string): WarRoomAgent[] {
  const m = model ?? WAR_ROOM_DEFAULT_MODEL;
  return [
    {
      id: "war-room-ceo",
      role: "ceo",
      name: "Alex Chen",
      title: "Chief Executive Officer",
      systemPrompt: CEO_SYSTEM_PROMPT,
      model: m,
      monitorIndex: 0,
      accentColor: "#f59e0b", // amber — leadership
      icon: "crown",
    },
    {
      id: "war-room-cto",
      role: "cto",
      name: "Jordan Rivers",
      title: "Chief Technology Officer",
      systemPrompt: CTO_SYSTEM_PROMPT,
      model: m,
      monitorIndex: 1,
      accentColor: "#3b82f6", // blue — technical
      icon: "code",
    },
    {
      id: "war-room-cmo",
      role: "cmo",
      name: "Maya Santos",
      title: "Chief Marketing Officer",
      systemPrompt: CMO_SYSTEM_PROMPT,
      model: m,
      monitorIndex: 2,
      accentColor: "#ec4899", // pink — creative
      icon: "megaphone",
    },
    {
      id: "war-room-cfo",
      role: "cfo",
      name: "Oliver Reed",
      title: "Chief Financial Officer",
      systemPrompt: CFO_SYSTEM_PROMPT,
      model: m,
      monitorIndex: 3,
      accentColor: "#10b981", // green — financial
      icon: "chartBar",
    },
    {
      id: "war-room-ops",
      role: "ops",
      name: "Sam Park",
      title: "Head of Operations",
      systemPrompt: OPS_SYSTEM_PROMPT,
      model: m,
      monitorIndex: 4,
      accentColor: "#8b5cf6", // purple — operational
      icon: "cpu",
    },
  ];
}

/** Get a specific agent from the default set */
export function getAgentByRole(role: WarRoomAgentRole, model?: string): WarRoomAgent {
  const agents = createDefaultAgents(model);
  const agent = agents.find((a) => a.role === role);
  if (!agent) throw new Error(`Unknown agent role: ${role}`);
  return agent;
}

// ─── Scenario Briefings ───────────────────────────────────────────────────────

export const SCENARIO_BRIEFINGS: Record<
  WarRoomScenario,
  {
    title: string;
    defaultContext: string;
    phases: string[];
    focus: Record<WarRoomAgentRole, string>;
  }
> = {
  "website-upgrade": {
    title: "Website Component Upgrade",
    defaultContext:
      "We need to comprehensively upgrade our website components to improve performance, " +
      "conversion, and brand consistency. Analyze the current state, propose upgrades, " +
      "debate tradeoffs, and produce an execution plan with clear owner assignments.",
    phases: [
      "briefing",
      "analysis",
      "debate",
      "proposal",
      "voting",
      "decision",
      "execution",
      "review",
    ],
    focus: {
      ceo: "Strategic impact on brand perception and growth metrics",
      cto: "Technical architecture, performance, bundle size, accessibility",
      cmo: "User experience, conversion optimization, messaging clarity",
      cfo: "Development cost, time-to-market, expected revenue impact",
      ops: "Deployment pipeline, rollback strategy, monitoring",
    },
  },
  "product-launch": {
    title: "Product Launch",
    defaultContext:
      "We are preparing to launch a new product. Align on messaging, pricing, " +
      "technical readiness, launch sequence, and success metrics.",
    phases: [
      "briefing",
      "analysis",
      "debate",
      "proposal",
      "voting",
      "decision",
      "execution",
      "reporting",
    ],
    focus: {
      ceo: "Launch strategy and go/no-go decision authority",
      cto: "Technical readiness and feature completeness",
      cmo: "Go-to-market strategy and launch messaging",
      cfo: "Pricing strategy and revenue projections",
      ops: "Launch runbook and rollback plan",
    },
  },
  "growth-strategy": {
    title: "Growth Strategy",
    defaultContext:
      "Develop a 90-day growth strategy targeting aggressive user acquisition " +
      "while maintaining unit economics. Focus on highest-leverage initiatives.",
    phases: ["briefing", "analysis", "debate", "proposal", "voting", "decision", "reporting"],
    focus: {
      ceo: "Prioritization and strategic direction",
      cto: "Technical growth levers and infrastructure scalability",
      cmo: "Channel strategy, content, and acquisition campaigns",
      cfo: "CAC, LTV, and budget allocation model",
      ops: "Execution capacity and operational throughput",
    },
  },
  "technical-review": {
    title: "Technical Architecture Review",
    defaultContext:
      "Conduct a deep technical architecture review. Identify bottlenecks, " +
      "security risks, and scalability concerns. Produce a remediation plan.",
    phases: ["briefing", "analysis", "debate", "proposal", "decision", "execution", "review"],
    focus: {
      ceo: "Business impact of technical debt and risk",
      cto: "Architecture analysis and remediation proposals",
      cmo: "User-facing performance and reliability impact",
      cfo: "Cost of technical debt vs. cost of remediation",
      ops: "Operational risk and incident history",
    },
  },
  "financial-planning": {
    title: "Financial Planning",
    defaultContext:
      "Build a 12-month financial plan including revenue projections, " +
      "cost structure, pricing strategy, and fundraising timeline.",
    phases: ["briefing", "analysis", "debate", "proposal", "voting", "decision", "reporting"],
    focus: {
      ceo: "Strategic financial goals and fundraising narrative",
      cto: "Infrastructure cost modeling and optimization",
      cmo: "Revenue attribution and marketing budget",
      cfo: "Full financial model and scenario analysis",
      ops: "Headcount and operational cost projections",
    },
  },
  "crisis-management": {
    title: "Crisis Management",
    defaultContext:
      "An incident has occurred. Coordinate immediate response, " +
      "communication, and remediation. Move fast without breaking things further.",
    phases: ["briefing", "analysis", "decision", "execution", "review", "reporting"],
    focus: {
      ceo: "Executive communication and stakeholder management",
      cto: "Technical root cause and fix deployment",
      cmo: "Customer communication and reputation management",
      cfo: "Financial exposure and insurance/SLA implications",
      ops: "Incident runbook and monitoring",
    },
  },
  custom: {
    title: "Custom Scenario",
    defaultContext: "Define your own war room scenario and context.",
    phases: [
      "briefing",
      "analysis",
      "debate",
      "proposal",
      "voting",
      "decision",
      "execution",
      "review",
      "reporting",
    ],
    focus: {
      ceo: "Strategic oversight",
      cto: "Technical domain",
      cmo: "Marketing and growth domain",
      cfo: "Financial domain",
      ops: "Operational domain",
    },
  },
};

/** Build the initial briefing prompt for a scenario */
export function buildScenarioBriefing(scenario: WarRoomScenario, customContext?: string): string {
  const s = SCENARIO_BRIEFINGS[scenario];
  const context = customContext ?? s.defaultContext;
  return `# War Room Session: ${s.title}

## Situation Brief
${context}

## Your Mandate
Each executive should analyze this situation from their domain and provide:
1. Your initial assessment
2. Key concerns or opportunities you see
3. What you need from the other executives to make a good decision

Begin your analysis now.`;
}

/** Build the agent context message (what each agent sees about the scenario) */
export function buildAgentContext(
  agent: WarRoomAgent,
  scenario: WarRoomScenario,
  customContext?: string,
): string {
  const s = SCENARIO_BRIEFINGS[scenario];
  const context = customContext ?? s.defaultContext;
  const focus = s.focus[agent.role];
  return `${agent.systemPrompt}

---

## Current War Room Session: ${s.title}

${context}

## Your Focus Area
${focus}

## Session Protocol
- Messages addressed to you require a direct response
- When voting: clearly state approve/reject/abstain/revise and your reasoning
- When proposing: structure your proposal with: Title, Context, Recommendation, Tradeoffs, Success Criteria
- When reviewing: give specific, actionable feedback
- Stay in your domain expertise — defer to others on theirs
- Be concise but complete`;
}
