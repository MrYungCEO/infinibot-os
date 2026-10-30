/**
 * Agency Demo Source — synthetic event stream for the live agency world.
 *
 * When demo mode is on (e.g. ?demo=1), the viz wires its engine to this source
 * instead of the gateway. It fabricates a believable, gateway-free scene: a
 * couple of federation nodes, ~12 agents across providers, steady tool changes,
 * occasional spawns/messages/task-ingests, and the periodic clock tick — enough
 * to make a great marketing reel without any backend.
 *
 *   const stop = startDemoSource((events) => engine.applyEvents(events));
 *   // …later…
 *   stop(); // clears all timers
 *
 * Scene structure is deterministic (driven by an incrementing counter); only
 * the wall-clock timing has natural jitter from the browser scheduler.
 */

import type { MeshNode, MeshAgent } from "./activity-map";

// ──────────────────────────────────────────────────────────────────
// WorldEvent — the engine's input event union (defined locally on purpose).
// ──────────────────────────────────────────────────────────────────

export type WorldEvent =
  | { kind: "node.upsert"; node: MeshNode }
  | { kind: "node.remove"; nodeId: string }
  | { kind: "agent.spawn"; agent: MeshAgent }
  | { kind: "agent.progress"; sessionKey: string; patch: Partial<MeshAgent> }
  | { kind: "agent.tool"; sessionKey: string; tool: { kind: string; label: string } }
  | {
      kind: "agent.message";
      from: string;
      to: string;
      type: "request" | "response" | "broadcast";
    }
  | { kind: "agent.complete"; sessionKey: string; success: boolean; message?: string }
  | { kind: "task.ingest"; id: string; title: string; nodeId?: string; priority?: string }
  | { kind: "period.tick"; epochMs: number };

// ──────────────────────────────────────────────────────────────────
// Scene tables
// ──────────────────────────────────────────────────────────────────

const NODE_LOCAL = "local";
const NODE_SAT = "sat-aurora";

const PROVIDERS = ["claude", "openai", "gemini", "ollama", "xai", "claude"];

const PROVIDER_MODEL: Record<string, string> = {
  claude: "claude-opus",
  openai: "gpt-4o",
  gemini: "gemini-pro",
  ollama: "ollama-local",
  xai: "grok-2",
  default: "agent",
};

const AGENT_ROLES = [
  "coder",
  "research",
  "browser",
  "tester",
  "coder",
  "research",
];

// Tools cycle through the zone-mapped kinds the engine understands.
const TOOLS: Array<{ kind: string; label: string }> = [
  { kind: "bash", label: "npm run build" },
  { kind: "edit", label: "manager.ts" },
  { kind: "read", label: "activity-map.ts" },
  { kind: "grep", label: "TODO across src" },
  { kind: "write", label: "agency-world.ts" },
  { kind: "webfetch", label: "docs.pixijs.com" },
  { kind: "websearch", label: "webm mediarecorder" },
  { kind: "task", label: "spawn subagent" },
  { kind: "message", label: "ping coordinator" },
  { kind: "taskupdate", label: "card #42 -> done" },
  { kind: "memorysearch", label: "prior decisions" },
  { kind: "bash", label: "git status" },
  { kind: "read", label: "agency-world-viz.ts" },
  { kind: "edit", label: "gpu-animation-panel.ts" },
];

const TASK_TITLES = [
  "Refactor mesh controller",
  "Add WebM recorder",
  "Wire news ticker",
  "Fix viewport clamp",
  "Demo-mode scene",
  "Provider palette pass",
  "Courier easing tweak",
  "Conveyor task ingest",
];

const TASK_PRIORITIES = ["high", "normal", "normal", "low", "high"];

const MESSAGE_TYPES: Array<"request" | "response" | "broadcast"> = [
  "request",
  "response",
  "broadcast",
  "request",
];

const STATUS_TASKS = [
  "Building the agency floor",
  "Indexing the codebase",
  "Browsing reference docs",
  "Running the test suite",
  "Drafting the new module",
  "Coordinating subagents",
];

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

function pick<T>(arr: T[], i: number): T {
  return arr[((i % arr.length) + arr.length) % arr.length];
}

function makeAgent(i: number): MeshAgent {
  const provider = pick(PROVIDERS, i);
  const role = pick(AGENT_ROLES, i);
  // Most agents on local; roughly every third on the satellite node.
  const nodeId = i % 3 === 2 ? NODE_SAT : NODE_LOCAL;
  const sessionKey = `agent:${role}-${i}`;
  const agent: MeshAgent = {
    sessionKey,
    agentId: `${role}-${provider}`,
    label: `${provider}-${role}-${i}`,
    nodeId,
    status: "starting",
    progress: 0,
    currentTask: pick(STATUS_TASKS, i),
  };
  // Provider/model hints so the engine's inferProvider picks the right palette.
  (agent as any).model = PROVIDER_MODEL[provider] || PROVIDER_MODEL.default;
  return agent;
}

// ──────────────────────────────────────────────────────────────────
// startDemoSource
// ──────────────────────────────────────────────────────────────────

/**
 * Begin emitting a synthetic agency scene. `emit` is called with batches of
 * WorldEvents. Returns a disposer that clears every internal timer.
 */
export function startDemoSource(
  emit: (events: WorldEvent[]) => void,
): () => void {
  const TOTAL_AGENTS = 12;

  // Live registry of session keys so messages/completes target real agents.
  const liveAgents: string[] = [];
  let agentSeq = 0; // next agent index (also drives spawns/respawns)
  let toolSeq = 0;
  let msgSeq = 0;
  let taskSeq = 0;

  const spawnAgent = (): MeshAgent => {
    const agent = makeAgent(agentSeq++);
    liveAgents.push(agent.sessionKey);
    return agent;
  };

  // ── Initial burst: nodes + a handful of agents so the world fills fast.
  const local: MeshNode = {
    id: NODE_LOCAL,
    name: "Local",
    role: "hub",
    status: "online",
    agentCount: 0,
    capabilities: ["coder", "research", "browser", "terminal"],
  };
  const satellite: MeshNode = {
    id: NODE_SAT,
    name: "Aurora",
    role: "satellite",
    status: "online",
    agentCount: 0,
    capabilities: ["research", "browser"],
  };

  const initial: WorldEvent[] = [
    { kind: "node.upsert", node: local },
    { kind: "node.upsert", node: satellite },
  ];
  // Seed ~6 agents immediately, the rest trickle in via the spawn timer.
  const seedCount = Math.min(6, TOTAL_AGENTS);
  for (let i = 0; i < seedCount; i++) {
    initial.push({ kind: "agent.spawn", agent: spawnAgent() });
  }
  emit(initial);

  // Bring the seeded agents up to "working" shortly after they appear.
  const warmup = setTimeout(() => {
    const batch: WorldEvent[] = [];
    for (const sk of [...liveAgents]) {
      batch.push({
        kind: "agent.progress",
        sessionKey: sk,
        patch: { status: "working", progress: 5 },
      });
    }
    if (batch.length) emit(batch);
  }, 1200);

  const timers: Array<ReturnType<typeof setInterval>> = [];

  // ── Tool changes: ~3/sec total. Each tick advances one agent's tool and
  //    nudges its progress, keeping characters walking between zones.
  timers.push(
    setInterval(() => {
      if (!liveAgents.length) return;
      const sk = pick(liveAgents, toolSeq);
      const tool = pick(TOOLS, toolSeq);
      toolSeq++;
      const progress = 10 + ((toolSeq * 7) % 80);
      emit([
        { kind: "agent.tool", sessionKey: sk, tool },
        {
          kind: "agent.progress",
          sessionKey: sk,
          patch: {
            status: "working",
            progress,
            currentTask: tool.label,
          },
        },
      ]);
    }, 333),
  );

  // ── Spawns: ~1 every 15s, until we reach TOTAL_AGENTS, then respawn churn.
  timers.push(
    setInterval(() => {
      if (liveAgents.length < TOTAL_AGENTS) {
        const agent = spawnAgent();
        emit([
          { kind: "agent.spawn", agent },
          {
            kind: "agent.progress",
            sessionKey: agent.sessionKey,
            patch: { status: "working", progress: 3 },
          },
        ]);
      } else {
        // At capacity — spawn a fresh one to replace churn handled by completes.
        const agent = spawnAgent();
        emit([{ kind: "agent.spawn", agent }]);
      }
    }, 15000),
  );

  // ── Inter-agent messages: ~1 every 2s between two distinct live agents.
  timers.push(
    setInterval(() => {
      if (liveAgents.length < 2) return;
      const from = pick(liveAgents, msgSeq);
      let to = pick(liveAgents, msgSeq + 1);
      if (to === from) to = pick(liveAgents, msgSeq + 2);
      const type = pick(MESSAGE_TYPES, msgSeq);
      msgSeq++;
      emit([{ kind: "agent.message", from, to, type }]);
    }, 2000),
  );

  // ── Task ingest: ~1 every 8s onto the conveyor; alternate target node.
  timers.push(
    setInterval(() => {
      const title = pick(TASK_TITLES, taskSeq);
      const priority = pick(TASK_PRIORITIES, taskSeq);
      const nodeId = taskSeq % 2 === 0 ? NODE_LOCAL : NODE_SAT;
      const id = `task-${taskSeq}`;
      taskSeq++;
      emit([{ kind: "task.ingest", id, title, nodeId, priority }]);
    }, 8000),
  );

  // ── Completions + respawn churn: ~1 every 11s. Complete the oldest agent,
  //    remove it from the registry, and queue a replacement spawn.
  timers.push(
    setInterval(() => {
      if (liveAgents.length <= 4) return; // keep a healthy floor
      const sk = liveAgents.shift()!;
      const success = taskSeq % 4 !== 0; // mostly succeed, occasional fail
      emit([
        {
          kind: "agent.complete",
          sessionKey: sk,
          success,
          message: success ? "Task complete" : "Hit a blocker",
        },
      ]);
      // Replacement arrives a beat later so the floor breathes.
      setTimeout(() => {
        const agent = spawnAgent();
        emit([
          { kind: "agent.spawn", agent },
          {
            kind: "agent.progress",
            sessionKey: agent.sessionKey,
            patch: { status: "working", progress: 4 },
          },
        ]);
      }, 1400);
    }, 11000),
  );

  // ── Period tick: 1/sec wall clock for any time-based engine visuals.
  timers.push(
    setInterval(() => {
      emit([{ kind: "period.tick", epochMs: Date.now() }]);
    }, 1000),
  );

  // Disposer — clears the warmup timeout and every interval.
  return () => {
    clearTimeout(warmup);
    for (const t of timers) clearInterval(t);
    timers.length = 0;
  };
}
