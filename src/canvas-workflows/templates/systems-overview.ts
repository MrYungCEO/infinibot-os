/**
 * Template: systems-overview — a live tour of the federation fleet.
 *
 * Scenes:
 *   1. Title scene
 *   2. Stats scene (totals: nodes, online, agents)
 *   3..N. One scene per federation node (hostname, GPU/RAM/CPU, agent count,
 *          health) with connector links from a central hub.
 *
 * Auto-laid-out on a grid. Node schema uses direct fields
 * (n.title, n.body, n.h1, n.sub, n.stats, n.kicker, n.h2) — NOT a
 * `content` object — matching the locked overlay schema in
 * ui/src/ui/components/walkthroughs/infinite-canvas-walkthrough.ts.
 */

import type { CanvasNode, CanvasScene, CanvasLink } from "../../proactive/popup-types.js";
import type { BuildCtx, CanvasPayload, CanvasWorkflow } from "../registry.js";
import { registerWorkflow } from "../registry.js";

const NODE_W = 560;
const COL_GAP = 760;
const ROW_GAP = 520;
const HUB_X = 1200;
const HUB_Y = 400;

function safeCap(s: string | undefined | null, fallback = "—"): string {
  if (!s || typeof s !== "string") return fallback;
  return s.trim() || fallback;
}

function deriveAccent(role: string): string {
  switch (role) {
    case "master":
      return "gold";
    case "satellite":
      return "cyan";
    default:
      return "green";
  }
}

/** Extract a short hardware summary from a node's capabilities blob. */
function hardwareSummary(caps: Record<string, unknown> | undefined | null): {
  gpu?: string;
  cpu?: string;
  ram?: string;
} {
  if (!caps || typeof caps !== "object") return {};
  const out: { gpu?: string; cpu?: string; ram?: string } = {};
  const gpu = caps.gpu ?? caps.GPU ?? caps.gpuModel;
  if (gpu && typeof gpu === "string") out.gpu = gpu;
  const cpu = caps.cpu ?? caps.CPU ?? caps.cpuModel;
  if (cpu && typeof cpu === "string") out.cpu = cpu;
  const ram = caps.ram ?? caps.RAM ?? caps.memory;
  if (ram && typeof ram === "string") out.ram = ram;
  return out;
}

export async function buildSystemsOverview(ctx: BuildCtx): Promise<CanvasPayload> {
  const [{ nodes: fedNodes, role }, agentsRes] = await Promise.all([
    ctx.federation.list(),
    ctx.agents.list(),
  ]);
  const agents = agentsRes.agents ?? [];
  const online = fedNodes.filter((n) => n.status === "online").length;

  const nodes: CanvasNode[] = [];
  const links: CanvasLink[] = [];
  const scenes: CanvasScene[] = [];

  // 1) Title scene
  nodes.push({
    id: "title",
    kind: "title",
    x: HUB_X,
    y: 80,
    w: 900,
    brand: "InfiniBot Holo-Canvas",
    h1: "Federation Fleet Overview",
    sub: `${fedNodes.length} node${fedNodes.length === 1 ? "" : "s"} · ${online} online · ${agents.length} agent${agents.length === 1 ? "" : "s"} configured`,
    body: "A live spatial tour of every connected node, its hardware, and its health.",
  });
  scenes.push({
    id: "scene-title",
    focusNodeId: "title",
    narration: {
      ttsText: `Welcome to the federation fleet overview. You have ${fedNodes.length} node${fedNodes.length === 1 ? "" : "s"}, ${online} online, and ${agents.length} configured agent${agents.length === 1 ? "" : "s"}. Let's tour them.`,
    },
  });

  // 2) Stats scene
  nodes.push({
    id: "stats",
    kind: "stats",
    x: HUB_X,
    y: 320,
    w: 900,
    kicker: "Fleet Totals",
    stats: [
      { n: String(fedNodes.length), l: "Nodes" },
      { n: String(online), l: "Online" },
      { n: String(agents.length), l: "Agents" },
      { n: safeCap(role, "standalone"), l: "Role" },
    ],
  });
  scenes.push({
    id: "scene-stats",
    focusNodeId: "stats",
    narration: {
      ttsText: `Fleet totals: ${fedNodes.length} nodes, ${online} online, ${agents.length} agents configured. This node is running as ${safeCap(role, "standalone")}.`,
    },
  });

  // 3) Hub + per-node scenes
  nodes.push({
    id: "hub",
    kind: "callout",
    x: HUB_X,
    y: HUB_Y,
    w: 480,
    icon: "◆",
    title: "Federation Hub",
    body: `Central routing hub. ${fedNodes.length} connected nodes.`,
  });
  links.push(["hub", "title"]);
  links.push(["hub", "stats"]);

  if (fedNodes.length === 0) {
    nodes.push({
      id: "node-empty",
      kind: "text",
      x: HUB_X + 600,
      y: HUB_Y,
      w: 520,
      kicker: "No Nodes",
      h2: "Federation is empty",
      body: "No federation nodes are connected. Start a satellite and pair it to populate this tour.",
    });
    scenes.push({
      id: "scene-empty",
      focusNodeId: "node-empty",
      narration: { ttsText: "No federation nodes are connected right now." },
    });
    return { title: "Systems Overview", nodes, links, scenes, voiceSuppress: true };
  }

  const cols = Math.min(3, fedNodes.length);
  fedNodes.forEach((fn, i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const x = HUB_X + 620 + col * COL_GAP;
    const y = HUB_Y + row * ROW_GAP;
    const accent = deriveAccent(fn.role);
    const hw = hardwareSummary(fn.capabilities);
    const hwLines: string[] = [];
    if (hw.gpu) hwLines.push(`**GPU:** ${hw.gpu}`);
    if (hw.cpu) hwLines.push(`**CPU:** ${hw.cpu}`);
    if (hw.ram) hwLines.push(`**RAM:** ${hw.ram}`);
    const plat = fn.platform ? `\n**Platform:** ${fn.platform}` : "";
    const body =
      hwLines.length > 0 ? hwLines.join("\n") + plat : `Role: ${safeCap(fn.role)}${plat}`;
    const id = `node-${i}`;
    nodes.push({
      id,
      kind: "text",
      x,
      y,
      w: NODE_W,
      cl: accent,
      kicker: safeCap(fn.role, "node").toUpperCase(),
      h2: safeCap(fn.name, fn.id),
      body,
      stats: [
        { n: safeCap(fn.status, "—"), l: "Status" },
        { n: fn.isLocal ? "yes" : "no", l: "Local" },
      ],
    });
    links.push(["hub", id]);
    scenes.push({
      id: `scene-${id}`,
      focusNodeId: id,
      narration: {
        ttsText: `Node ${i + 1}: ${safeCap(fn.name, fn.id)}, status ${safeCap(fn.status)}, role ${safeCap(fn.role)}.${hw.gpu ? ` GPU: ${hw.gpu}.` : ""}${hw.ram ? ` RAM: ${hw.ram}.` : ""}`,
      },
    });
  });

  return { title: "Systems Overview", nodes, links, scenes, voiceSuppress: true };
}

export const systemsOverviewWorkflow: CanvasWorkflow = {
  id: "systems-overview",
  title: "Systems Overview",
  description:
    "Live spatial tour of the federation fleet — one scene per node with hardware and health.",
  defaultVoice: "af_heart",
  build: buildSystemsOverview,
};

registerWorkflow(systemsOverviewWorkflow);
