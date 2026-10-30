/**
 * Documents › Ideas — pure model (no DOM, no gateway; tested in node).
 * Shapes mirror src/ideas/types.ts (the ideas.* RPC payloads).
 */

export type IdeaStatus = "new" | "exploring" | "parked" | "promoted";
export type IdeaSource = "voice" | "web" | "agent" | "mobile";
export type IdeaPromoteTarget = "task" | "project" | "document";

export type Idea = {
  id: string;
  title: string;
  body: string;
  tags: string[];
  source: IdeaSource;
  status: IdeaStatus;
  projectIds: string[];
  taskIds: string[];
  docIds: string[];
  promotedTo?: { kind: IdeaPromoteTarget; id: string; at: string };
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
};

export type IdeasListPayload = {
  ideas: Idea[];
  counts: Record<IdeaStatus, number>;
  tags: Array<{ tag: string; count: number }>;
};

export const IDEA_STATUS_ORDER: IdeaStatus[] = ["new", "exploring", "parked", "promoted"];

export const IDEA_STATUS_META: Record<IdeaStatus, { label: string; hint: string }> = {
  new: { label: "New", hint: "Just captured" },
  exploring: { label: "Exploring", hint: "Being thought through" },
  parked: { label: "Parked", hint: "Not now — kept for later" },
  promoted: { label: "Promoted", hint: "Became a task, project or document" },
};

export const SOURCE_LABEL: Record<IdeaSource, string> = {
  voice: "Voice",
  web: "Web",
  agent: "Agent",
  mobile: "Phone",
};

export type IdeaFilter = { query: string; status: IdeaStatus | "all"; tag: string | null };

/** Client-side filter over the loaded list (the RPC also filters; this keeps typing instant). */
export function filterIdeas(ideas: readonly Idea[], f: IdeaFilter): Idea[] {
  const q = f.query.trim().toLowerCase();
  return ideas.filter((i) => {
    if (f.status !== "all" && i.status !== f.status) return false;
    if (f.tag && !i.tags.includes(f.tag)) return false;
    if (q && !`${i.title}\n${i.body}\n${i.tags.join(" ")}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

/** "a, #b,  c" → ["a","b","c"] (lowercase, de-duplicated). */
export function parseTagInput(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[,\s]+/)
        .map((t) => t.trim().replace(/^#/, "").toLowerCase())
        .filter(Boolean),
    ),
  ].slice(0, 12);
}

/** Short excerpt of the body for list rows. */
export function excerpt(body: string, max = 120): string {
  const flat = body.replace(/[#*_`>[\]]/g, "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

export function relTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.round((now - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString();
}

/** What a promoted idea became, as one line. */
export function promotedLabel(i: Idea, names: { projects: Map<string, string>; docs: Map<string, string> }): string | null {
  const p = i.promotedTo;
  if (!p) return null;
  if (p.kind === "project") return `Project · ${names.projects.get(p.id) ?? p.id}`;
  if (p.kind === "document") return `Document · ${names.docs.get(p.id) ?? p.id}`;
  return `Task · ${p.id}`;
}
