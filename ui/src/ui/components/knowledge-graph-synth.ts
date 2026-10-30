/**
 * Knowledge graph — a deterministic synthetic graph shaped like the live
 * install, for verification at real scale without touching real data
 * (`?kgsynth=live` / `?kgsynth=live-tasks`, and the layout tests).
 *
 *   350 projects (mixed health, ~1 in 9 a sub-project), 31 clients,
 *   121 notes, 6 reports, 6 content, 3 opportunities, 3 issues, 1 decision,
 *   1 agent + 1 run, one "relates to" mega-hub, ~110 unlinked items,
 *   and optionally 2,194 tasks hanging off projects (a long-tail spread).
 */

import type { GraphNodeKind } from "./knowledge-graph-model";

interface GraphNodeIn {
  id: string;
  kind: GraphNodeKind;
  label: string;
  weight?: number;
  meta?: Record<string, unknown>;
}

interface GraphEdgeIn {
  source: string;
  target: string;
  rel: string;
  weight?: number;
  inferred?: boolean;
}

export interface SynthSnapshot {
  generatedAt: number;
  nodes: GraphNodeIn[];
  edges: GraphEdgeIn[];
  typeStats: Partial<Record<GraphNodeKind, number>>;
  kinds: GraphNodeKind[];
}

const A = ["Infini", "Kingly", "Robo", "Fly", "Omni", "Solar", "Vault", "Nova", "Apex", "Quantum", "Atlas", "Echo", "Prime", "Zen", "Orbit", "Pulse"];
const B = ["Bot", "Pic", "Voice", "Trade", "Clinic", "Studio", "Market", "Cloud", "Ops", "Hub", "Flow", "Lab", "Desk", "Park", "Swarm", "Mesh"];
const C = ["landing page", "plugin", "mobile app", "dashboard", "redesign", "launch", "pricing", "onboarding", "API", "billing", "case study", "video", "docs", "migration", "audit", "integration"];
const PEOPLE = ["Ada Example", "Acme Inc", "Sam Sample", "Riley Demo", "Bright Bakery", "Jordan Test", "Morgan", "Taylor", "Casey", "Case Study Co", "Blue Robots", "Harbor Clinic", "Lumen Dental", "Nordic Haus", "Sato Holdings"];

export function makeLiveShapedSnapshot(withTasks = false, seed = 7): SynthSnapshot {
  let s = seed >>> 0;
  const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
  const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
  const nodes: GraphNodeIn[] = [];
  const edges: GraphEdgeIn[] = [];
  const stats: Partial<Record<GraphNodeKind, number>> = {};
  const add = (kind: GraphNodeKind, label: string, meta: Record<string, unknown> = {}) => {
    const id = `${kind}:${nodes.length}`;
    nodes.push({ id, kind, label, weight: rnd(), meta });
    stats[kind] = (stats[kind] ?? 0) + 1;
    return id;
  };
  const link = (a: string, b: string, rel: string) => edges.push({ source: a, target: b, rel });
  const clients = Array.from({ length: 31 }, (_, i) => add("client", PEOPLE[i % PEOPLE.length] + (i >= PEOPLE.length ? ` ${i}` : "")));
  const health = ["active", "backlog", "backlog", "backlog", "done", "done", "at_risk", "blocked", "review", "backlog"];
  const projects: string[] = [];
  for (let p = 0; p < 350; p++) {
    const h = health[p % health.length];
    const tasks = Math.floor(rnd() * 20);
    const id = add("project", `${pick(A)}${pick(B)} ${pick(C)}`, {
      health: h,
      status: h,
      tasks,
      done: Math.floor(tasks * rnd()),
      progress: rnd(),
      live: p % 97 === 0,
    });
    if (p > 20 && p % 9 === 0) link(id, projects[Math.floor(rnd() * 20)], "sub-project of");
    projects.push(id);
  }
  for (let p = 0; p < 350; p++) if (p % 3 !== 2 && rnd() < 0.36) link(clients[Math.floor(rnd() * 31)], projects[p], "for client");
  for (let k = 0; k < 121; k++) {
    const id = add("note", `${pick(["Notes", "Spec", "Research", "Brief", "Ideas", "Retro"])} — ${pick(C)} ${k}`);
    if (k < 84) link(projects[Math.floor(rnd() * 350)], id, "about");
  }
  for (let k = 0; k < 6; k++) {
    const id = add("report", `Report — ${pick(C)}`);
    if (k < 4) link(projects[k * 7], id, "about");
  }
  for (let k = 0; k < 6; k++) add("content", `${pick(["Reel", "Carousel", "Post"])} — ${pick(C)}`);
  for (let k = 0; k < 3; k++) add("opportunity", `Opportunity — ${pick(PEOPLE)}`);
  for (let k = 0; k < 3; k++) add("issue", `Issue — ${pick(C)}`);
  add("decision", "Decision — pricing v2");
  const agent = add("agent", "Main agent");
  link(agent, add("run", "Coder run"), "ran");
  // The InfiniBotOS-like hub: dozens of "relates to" links.
  for (let k = 0; k < 60; k++) link(projects[1], projects[30 + k * 5], "relates to");
  if (withTasks) {
    for (let k = 0; k < 2194; k++) {
      const id = add("task", `Task ${k}: ${pick(C)}`, { status: ["todo", "in_progress", "done", "backlog"][k % 4] });
      link(projects[Math.floor(Math.pow(rnd(), 2.2) * 350)], id, "contains");
    }
  }
  const kinds = Object.keys(stats) as GraphNodeKind[];
  return { generatedAt: Date.now(), nodes, edges, typeStats: stats, kinds };
}
