import type { WorkflowGraph, WorkflowNode } from "../shared/group-chat/types.js";
import type { LaunchPanelFlow, LaunchPersona } from "./types.js";

export const DEFAULT_LAUNCH_FLOWS: LaunchPanelFlow[] = [
  {
    id: "signup",
    label: "Sign up",
    instruction:
      "Create a marked test account and complete any verification that the configured test inbox permits.",
  },
  {
    id: "onboarding",
    label: "Onboarding",
    instruction:
      "Complete the real onboarding path and record every decision, delay, and dead end.",
  },
  {
    id: "core",
    label: "Core product",
    instruction:
      "Use the primary product path far enough to produce a real result, not merely view a dashboard.",
  },
  {
    id: "lesson",
    label: "Course lesson",
    instruction: "Open a course, start a real lesson, and check progress/navigation behavior.",
  },
  {
    id: "pricing",
    label: "Pricing and checkout",
    instruction:
      "Choose the most plausible tier and continue to the external checkout handoff. Stop before entering payment details or paying.",
  },
  {
    id: "errors",
    label: "Error states",
    instruction:
      "Probe one safe validation or empty state. Never delete data, spam forms, or perform admin actions.",
  },
  {
    id: "mobile-nav",
    label: "Mobile navigation",
    instruction: "At 390px, verify menu access, tap targets, overflow, and return paths.",
  },
];

export interface PersonaAssignment {
  persona: LaunchPersona;
  agentId: string;
}

export function assignPersonasToAgents(
  personas: LaunchPersona[],
  agentIds: string[],
): PersonaAssignment[] {
  const usable = [...new Set(agentIds.map((id) => id.trim().toLowerCase()).filter(Boolean))];
  if (!usable.length) throw new Error("Launch Panel needs at least one configured agent");
  return personas.map((persona, index) => ({ persona, agentId: usable[index % usable.length]! }));
}

function personaBrief(persona: LaunchPersona): string {
  return JSON.stringify(
    {
      name: persona.name,
      role: persona.role,
      background: persona.background,
      goals: persona.goals,
      pains: persona.pains,
      techLevel: persona.techLevel,
      budget: persona.budget,
      spendingAuthority: persona.spendingAuthority,
      buyingTriggers: persona.buyingTriggers,
      objections: persona.objections,
      devices: persona.devices,
      patience: persona.patience,
      privateInfo: persona.privateInfo,
    },
    null,
    2,
  );
}

function node(
  id: string,
  agentId: string,
  label: string,
  prompt: string,
  column: number,
  row: number,
): WorkflowNode {
  return { id, agentId, label, prompt, x: 24 + column * 260, y: 24 + row * 118, parentId: null };
}

function edge(sourceId: string, targetId: string, index: number) {
  return { id: `e-${index}-${sourceId}-${targetId}`.slice(0, 64), sourceId, targetId };
}

export function buildLaunchPanelWorkflow(params: {
  assignments: PersonaAssignment[];
  moderatorAgentId: string;
  url: string;
  flows: LaunchPanelFlow[];
  credentialsPath: string;
  runId: string;
  depth: "quick" | "standard" | "deep";
}): WorkflowGraph {
  const { assignments, moderatorAgentId, url, flows, credentialsPath, runId, depth } = params;
  const nodes: WorkflowNode[] = [];
  const edges: Array<{ id: string; sourceId: string; targetId: string }> = [];
  let edgeIndex = 0;

  for (const [i, assignment] of assignments.entries()) {
    const p = assignment.persona;
    nodes.push(
      node(
        `r1-${p.id}`,
        assignment.agentId,
        `Round 1 · ${p.name}`,
        `ROLEPLAY THIS CUSTOMER WITHOUT BREAKING CHARACTER:\n${personaBrief(p)}\n\nUse the native \`browser\` tool for this external website; NEVER use \`ui_control\`, which only controls InfiniBot itself. Start with exactly \`browser({ action: "open", url: "${url}" })\`, then set the real viewport with \`browser({ action: "resize", value: "${p.devices.includes("mobile") ? "390x844" : "1440x1000"}" })\`; valid follow-up actions include \`snapshot\`, \`click\`, \`type\`, \`wait\`, and \`screenshot\`. Do not invent action names. Test as a ${p.devices.includes("mobile") ? "mobile customer" : "desktop customer"}. Run a five-second first-impression test. Do not rely on page source or another agent's description. Take a screenshot and report only claims grounded in what you personally saw. State: what this appears to sell, who it is for, the first trust signal, the first confusion, and whether you would keep scrolling. Include the screenshot's absolute path.`,
        0,
        i,
      ),
    );
    if (i > 0) edges.push(edge(`r1-${assignments[i - 1]!.persona.id}`, `r1-${p.id}`, edgeIndex++));
  }

  const flowText = flows.map((f, i) => `${i + 1}. ${f.label}: ${f.instruction}`).join("\n");
  for (const [i, assignment] of assignments.entries()) {
    const p = assignment.persona;
    nodes.push(
      node(
        `r2-${p.id}`,
        assignment.agentId,
        `Round 2 · ${p.name}`,
        `Stay fully in character as this customer:\n${personaBrief(p)}\n\nUse the native \`browser\` tool for this external website; NEVER use \`ui_control\`, which only controls InfiniBot itself. Start with exactly \`browser({ action: "open", url: "${url}" })\`, then set the real viewport with \`browser({ action: "resize", value: "${p.devices.includes("mobile") ? "390x844" : "1440x1000"}" })\`; use only schema-valid actions such as \`snapshot\`, \`click\`, \`type\`, \`wait\`, and \`screenshot\`. ACTUALLY DRIVE the real site ${url}; do not just review the front page. Use only the marked test account for run ${runId}, persona ${p.id}, stored at ${credentialsPath}. Do not call \`read\` and never place credentials in your response or tool arguments: type the email with opaque text \`launch-panel://${runId}/${p.id}/email\` and the password with \`launch-panel://${runId}/${p.id}/password\`; the browser resolves those references privately. If verification cannot be completed, record the exact blocker and continue every public flow that remains possible.\n\nRequired flows (${depth} depth):\n${flowText}\n\nTimebox the entire audit to 15 minutes and reserve the final 90 seconds for the summary. Safety: no payment details, no purchase, stop at the payment-provider page, no destructive/admin action, no spam, and no more than one browser. Save a screenshot at each major step. Immediately after each flow, before starting the next one, emit exactly one machine-readable line:\nSTEP|step name|pass,fail,blocked|seconds|confusion or none|absolute screenshot path or none\nFor every conversion gap emit:\nFINDING|critical,high,medium,low|1-5 reach|1-5 effort|short title|absolute screenshot path or none|specific fix or copy\nThen give a concise in-character narrative. Every claim must name the click or screenshot that supports it.`,
        1,
        i,
      ),
    );
    if (i === 0)
      edges.push(edge(`r1-${assignments.at(-1)!.persona.id}`, `r2-${p.id}`, edgeIndex++));
    else edges.push(edge(`r2-${assignments[i - 1]!.persona.id}`, `r2-${p.id}`, edgeIndex++));
  }

  for (const [i, assignment] of assignments.entries()) {
    const p = assignment.persona;
    nodes.push(
      node(
        `r3-${p.id}`,
        assignment.agentId,
        `Round 3 · ${p.name}`,
        `Debate the evidence as ${p.name}, not as a generic analyst. Read the other panelists' observed results supplied upstream, disagree where your background warrants it, and do not repeat an unverified claim. Answer using these exact fields:\nWOULD_BUY: yes|no|maybe\nTIER: free|starter|ceo|vip|enterprise|none\nWTP: amount and billing period\nTOP_OBJECTION: one sentence\nCOMPETITOR: what you would choose instead and why\nCONVERSION_CHANGE: the single change most likely to convert you\nThen explain your budget constraint, buying authority, refund risk, and evidence-based reasoning.`,
        2,
        i,
      ),
    );
    for (const r2 of assignments)
      edges.push(edge(`r2-${r2.persona.id}`, `r3-${p.id}`, edgeIndex++));
    if (i > 0) edges.push(edge(`r3-${assignments[i - 1]!.persona.id}`, `r3-${p.id}`, edgeIndex++));
  }

  nodes.push(
    node(
      "r4-moderator",
      moderatorAgentId,
      "Round 4 · Moderator synthesis",
      `You are the Launch Panel moderator and conversion analyst. Synthesize only evidence the panel actually observed or clicked. Call out disagreements instead of averaging them away. Produce: launch readiness verdict; funnel drop-off map; prioritized gaps scored severity × reach ÷ effort; pricing/offer matrix; exact copy or product fix for each top issue; cleanup instructions for all test accounts; and 5 kanban-ready task titles. Every finding must cite an absolute screenshot path or explicitly say evidence missing. Never claim payment was tested: checkout must stop before payment.`,
      3,
      0,
    ),
  );
  for (const assignment of assignments)
    edges.push(edge(`r3-${assignment.persona.id}`, "r4-moderator", edgeIndex++));

  return {
    id: `launch-panel-${Date.now().toString(36)}`,
    name: `Launch Test Panel · ${new URL(url).hostname}`,
    nodes,
    edges,
    updatedAt: Date.now(),
  };
}
