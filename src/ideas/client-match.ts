/**
 * Deterministic client association for quick capture — the CRM twin of
 * project-match.ts, and built on the same scorer.
 *
 * Clients come from the agency store (agency.db `clients`, the list Business
 * HQ › Clients shows) for the active business: 1000+ rows, so the model only
 * sees a shortlist. This module (pure, no I/O):
 *   - toCaptureClients()  agency Client rows → slim CaptureClient rows
 *                         (name, company / legal name aliases, a short
 *                         "about" from business type + notes)
 *   - matchClient()       explicit or near-explicit mention → a real client
 *                         id with confidence + reason; never an unknown id
 *   - shortlistClients()  ranked hits + most recently active, for the prompt
 *   - clientsOfProject()  the client(s) a board project belongs to
 *                         (relations.db / objrel pairs, Notion "Clients")
 */

import {
  matchProject,
  rankProjects,
  shortlistProjects,
  type CaptureProject,
} from "./project-match.js";
import { coerceString } from "../shared/text/coerce.js";

export type CaptureClient = {
  id: string;
  name: string;
  /** Company / legal name / brand — matched like the name. */
  aliases?: string[];
  /** Business type + notes, for implicit context. */
  description?: string;
  email?: string;
  /** Notion CRM page id (tasks' "Customer" / projects' "Clients" relations). */
  notionPageId?: string;
  status?: string;
  updatedAt?: number | string;
};

export type ClientMatch = { client: CaptureClient; confidence: number; reason: string };

/** Agency client rows (formatClient / store shape) → capture rows. Drops nameless rows. */
export function toCaptureClients(rows: unknown): CaptureClient[] {
  const list = Array.isArray(rows)
    ? rows
    : ((rows as { clients?: unknown[] } | null)?.clients ?? []);
  const out: CaptureClient[] = [];
  const seen = new Set<string>();
  for (const raw of list as Array<Record<string, unknown>>) {
    if (!raw || typeof raw !== "object") continue;
    const id = typeof raw.id === "string" ? raw.id : "";
    const data = (raw.data && typeof raw.data === "object" ? raw.data : {}) as Record<
      string,
      unknown
    >;
    const name = coerceString(raw.name ?? data.Name)
      .replace(/\s+/g, " ")
      .trim();
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    const aliases = new Set<string>();
    for (const v of [raw.legalName, raw.legal_name, data.Company, data["Company Name"], data.Brand])
      if (typeof v === "string" && v.trim() && v.trim().toLowerCase() !== name.toLowerCase())
        aliases.add(v.trim());
    const about: string[] = [];
    const btype = data["Business Type"];
    if (Array.isArray(btype)) about.push(btype.filter((x) => typeof x === "string").join(", "));
    for (const k of ["Industry", "Interest", "Location", "Notes"]) {
      const v = data[k];
      if (typeof v === "string" && v.trim()) about.push(v.trim());
    }
    if (typeof raw.notes === "string" && raw.notes.trim()) about.push(raw.notes.trim());
    const description = about.join(" — ").replace(/\s+/g, " ").slice(0, 240);
    const email = [raw.email, raw.billingEmail, data.Email].find(
      (v): v is string => typeof v === "string" && v.includes("@"),
    );
    const notionPageId =
      typeof raw.notionPageId === "string"
        ? raw.notionPageId
        : typeof raw.notion_page_id === "string"
          ? raw.notion_page_id
          : undefined;
    const status =
      typeof raw.pipelineStatusLabel === "string"
        ? raw.pipelineStatusLabel
        : typeof raw.status === "string"
          ? raw.status
          : undefined;
    const updatedAt =
      typeof raw.updatedAt === "number" || typeof raw.updatedAt === "string"
        ? (raw.updatedAt as number | string)
        : undefined;
    out.push({
      id,
      name,
      ...(aliases.size ? { aliases: [...aliases] } : {}),
      ...(description ? { description } : {}),
      ...(email ? { email } : {}),
      ...(notionPageId ? { notionPageId } : {}),
      ...(status ? { status } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
    });
  }
  return out;
}

const asProject = (c: CaptureClient): CaptureProject => ({
  id: c.id,
  name: c.name,
  ...(c.aliases?.length ? { aliases: c.aliases } : {}),
  ...(c.description ? { description: c.description } : {}),
  ...(c.updatedAt !== undefined ? { updatedAt: c.updatedAt } : {}),
});

/** Best deterministic client match for `text`, or undefined. */
export function matchClient(text: string, clients: CaptureClient[]): ClientMatch | undefined {
  const byId = new Map(clients.map((c) => [c.id, c]));
  const m = matchProject(text, clients.map(asProject));
  const client = m ? byId.get(m.project.id) : undefined;
  if (!m || !client) return undefined;
  // "for the X client", "X's account", "client X" is as explicit as it gets.
  let { confidence, reason } = m;
  const nm = client.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (
    new RegExp(
      `\\b(?:client|customer|account)\\s+${nm}\\b|\\b${nm}(?:'s)?\\s+(?:client|account|deal|order)\\b`,
      "i",
    ).test(text)
  ) {
    confidence = Math.max(confidence, 0.97);
    reason = `named the client (“${client.name}”)`;
  }
  return { client, confidence: Math.min(0.99, confidence), reason };
}

/** Ranked hits first, then the most recently active clients, up to `max`. */
export function shortlistClients(
  text: string,
  clients: CaptureClient[],
  max = 30,
): CaptureClient[] {
  const byId = new Map(clients.map((c) => [c.id, c]));
  return shortlistProjects(text, clients.map(asProject), max)
    .map((p) => byId.get(p.id))
    .filter((c): c is CaptureClient => !!c);
}

/** Every client whose name/alias/about matches, best first (for tests and the picker). */
export function rankClients(text: string, clients: CaptureClient[]): ClientMatch[] {
  const byId = new Map(clients.map((c) => [c.id, c]));
  return rankProjects(text, clients.map(asProject))
    .map((r) => {
      const client = byId.get(r.project.id);
      return client ? { client, confidence: Math.min(0.99, r.score), reason: r.reason } : null;
    })
    .filter((x): x is ClientMatch => !!x);
}

/**
 * The client(s) of a board project, resolved to real client ids:
 *   - `linkedIds`: client ids linked to the project in the relation indexes
 *   - `notionIds`: the project's Notion "Clients" relation (CRM page ids)
 * Unknown ids are dropped; order = linked first.
 */
export function clientsOfProject(
  clients: CaptureClient[],
  refs: { linkedIds?: string[]; notionIds?: string[] },
): CaptureClient[] {
  const byId = new Map(clients.map((c) => [c.id, c]));
  const byNotion = new Map(
    clients.filter((c) => c.notionPageId).map((c) => [normNotionId(c.notionPageId!), c]),
  );
  const out: CaptureClient[] = [];
  const add = (c: CaptureClient | undefined) => {
    if (c && !out.some((x) => x.id === c.id)) out.push(c);
  };
  for (const id of refs.linkedIds ?? []) add(byId.get(id));
  for (const id of refs.notionIds ?? []) add(byNotion.get(normNotionId(id)) ?? byId.get(id));
  return out;
}

/** Notion ids come dashed or not; compare without dashes. */
export function normNotionId(id: string): string {
  return id.replace(/-/g, "").toLowerCase();
}
