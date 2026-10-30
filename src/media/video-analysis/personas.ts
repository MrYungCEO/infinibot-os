/**
 * Analyst personas for video analysis.
 *
 * An analyst is an ordinary InfiniBot agent (config.agents.list[]). Built-in
 * templates (Archaeologist, Security analyst, Sports coach, Video editor) are
 * created as real agents on first use (or by `ensureAnalystAgents`), never
 * overwriting an existing agent with the same id. Any other agent from
 * agents.list can analyze too: its own systemPrompt is the persona.
 *
 * New personas are created with `createAnalystAgent({ name, focus })`, which
 * writes an agent entry through the same config path the Agents page uses.
 */
import {
  loadConfig,
  parseConfigJson5,
  readConfigFileSnapshot,
  validateConfigObjectWithPlugins,
  writeConfigFile,
} from "../../config/config.js";
import type { InfinibotConfig } from "../../config/types.infinibot.js";

export interface AnalystTemplate {
  id: string;
  name: string;
  /** Short tagline for the picker. */
  tagline: string;
  /** Icon key for the UI (premium SVG set; no emoji). */
  icon: string;
  systemPrompt: string;
}

const COMMON_OUTPUT = [
  "When you analyze a video you receive keyframes and a contact sheet, each labelled with its timecode, plus the transcript and on-screen text.",
  "Ground every statement in what is visible or audible, cite timecodes (mm:ss), and say plainly when something is uncertain or not visible.",
].join(" ");

export const ARCHAEOLOGIST_PROMPT = [
  "You are ARCHAEOLOGIST — a field and finds archaeologist who reviews site footage, finds photography and excavation videos.",
  "",
  "Focus on:",
  "- Artifacts and ecofacts: type, form, fragment vs. complete, diagnostic features (rims, handles, bases, decoration, wear, tool marks), probable function.",
  "- Materials and fabric: ceramic (fabric, temper, slip, glaze, firing), lithics, metal (bronze, iron, silver; corrosion products), bone, glass, wood, textile.",
  "- Stratigraphy and context: layers, cuts and fills, interfaces, inclusions, burning, disturbance and intrusions; apply the law of superposition and note relative sequences.",
  "- Site and features: walls, floors, pits, hearths, postholes, burials; trench and section layout; scale bars, north arrows and labels.",
  "- Dating clues: typology, inscriptions and coin legends, manufacturing techniques, terminus post quem / ante quem, material that could be sampled (charcoal, bone) for radiocarbon.",
  "- Documentation standards: context and small-find numbers, scale and north arrow in photos, section drawings, labelling and bagging, chain of custody, what still needs recording.",
  "- Conservation and ethics: handling and storage risks, human remains protocols, provenance concerns.",
  "",
  "Distinguish observation from interpretation. Give confidence for identifications and list what further analysis would confirm them (fabric analysis, XRF, residue, C14).",
  COMMON_OUTPUT,
].join("\n");

export const ANALYST_TEMPLATES: AnalystTemplate[] = [
  {
    id: "archaeologist",
    name: "Archaeologist",
    tagline: "Artifacts, stratigraphy, materials, dating clues, documentation",
    icon: "trowel",
    systemPrompt: ARCHAEOLOGIST_PROMPT,
  },
  {
    id: "security-analyst",
    name: "Security analyst",
    tagline: "People, vehicles, access points, anomalies, timeline of events",
    icon: "shield",
    systemPrompt: [
      "You are SECURITY ANALYST — you review CCTV, body-cam and incident footage.",
      "Focus on: people (count, clothing, behaviour — never guess identity), vehicles (type, colour, plates if legible), entry/exit points, objects carried or left behind, suspicious or unsafe behaviour, camera blind spots and visibility limits, and an exact timeline of events.",
      "Be factual and neutral; separate what is seen from inference; flag evidence-handling concerns.",
      COMMON_OUTPUT,
    ].join("\n"),
  },
  {
    id: "sports-coach",
    name: "Sports coach",
    tagline: "Technique, positioning, tactics, drills to improve",
    icon: "whistle",
    systemPrompt: [
      "You are SPORTS COACH — you review training and match footage.",
      "Focus on: technique (posture, balance, timing, follow-through), positioning and spacing, decision making, tactical patterns, fatigue signs and injury risk, and concrete drills to fix each issue. Praise what works before what to fix.",
      COMMON_OUTPUT,
    ].join("\n"),
  },
  {
    id: "video-editor",
    name: "Video editor",
    tagline: "Pacing, shots, cut points, b-roll, audio, captions",
    icon: "scissors",
    systemPrompt: [
      "You are VIDEO EDITOR — you review raw and cut footage for an edit.",
      "Focus on: shot types and composition, pacing, the strongest moments and hooks, suggested cut points and in/out timecodes, b-roll opportunities, continuity and jump cuts, exposure/colour/focus problems, audio quality, and captions or on-screen text to add.",
      COMMON_OUTPUT,
    ].join("\n"),
  },
];

/** Existing agents that already fill a template's role (e.g. the seeded video-editor-agent). */
const TEMPLATE_ALIASES: Record<string, string[]> = {
  "video-editor": ["video-editor-agent"],
};

export interface AnalystOption {
  agentId: string;
  name: string;
  tagline: string;
  icon: string;
  /** "template" = built-in analyst persona, "agent" = any configured agent. */
  kind: "template" | "agent";
  /** True once the agent exists in config.agents.list. */
  exists: boolean;
}

type AgentRow = { id: string; name?: string; systemPrompt?: string; identity?: { name?: string } };

function agentRows(cfg: InfinibotConfig): AgentRow[] {
  const list = (cfg.agents?.list ?? []) as AgentRow[];
  return list.filter((a) => a && typeof a.id === "string");
}

export function resolveTemplateAgentId(templateId: string, cfg: InfinibotConfig): string {
  const rows = agentRows(cfg);
  if (rows.some((a) => a.id === templateId)) return templateId;
  for (const alias of TEMPLATE_ALIASES[templateId] ?? []) {
    if (rows.some((a) => a.id === alias)) return alias;
  }
  return templateId;
}

/** Picker options: analyst templates first, then every other configured agent. */
export function listAnalystOptions(cfg: InfinibotConfig = loadConfig()): AnalystOption[] {
  const rows = agentRows(cfg);
  const byId = new Map(rows.map((a) => [a.id, a]));
  const out: AnalystOption[] = [];
  const used = new Set<string>();
  for (const t of ANALYST_TEMPLATES) {
    const id = resolveTemplateAgentId(t.id, cfg);
    used.add(id);
    out.push({
      agentId: id,
      name: byId.get(id)?.name ?? t.name,
      tagline: t.tagline,
      icon: t.icon,
      kind: "template",
      exists: byId.has(id),
    });
  }
  for (const a of rows) {
    if (used.has(a.id)) continue;
    out.push({
      agentId: a.id,
      name: a.name ?? a.identity?.name ?? a.id,
      tagline: firstSentence(a.systemPrompt) || "InfiniBot agent",
      icon: a.id.startsWith("analyst-") ? "eye" : "bot",
      kind: "agent",
      exists: true,
    });
  }
  return out;
}

function firstSentence(s?: string): string {
  if (!s) return "";
  const line = s.split("\n").find((l) => l.trim()) ?? "";
  return line.replace(/^you are\s+/i, "").slice(0, 110);
}

export interface AnalystPersona {
  agentId: string;
  name: string;
  systemPrompt: string;
}

/** Persona text for an agent id (config agent or template). */
export function resolvePersona(
  agentId: string,
  cfg: InfinibotConfig = loadConfig(),
): AnalystPersona {
  const row = agentRows(cfg).find((a) => a.id === agentId);
  const tpl =
    ANALYST_TEMPLATES.find((t) => t.id === agentId) ??
    ANALYST_TEMPLATES.find((t) => (TEMPLATE_ALIASES[t.id] ?? []).includes(agentId));
  const prompt = row?.systemPrompt?.trim() || tpl?.systemPrompt || "";
  const name = row?.name ?? row?.identity?.name ?? tpl?.name ?? agentId;
  return {
    agentId,
    name,
    systemPrompt:
      prompt.slice(0, 4000) ||
      `You are ${name}, an InfiniBot agent. Review the video from your area of expertise. ${COMMON_OUTPUT}`,
  };
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function personaPromptFor(name: string, focus: string): string {
  return [
    `You are ${name.toUpperCase()} — a specialist who reviews video footage.`,
    "",
    "Focus on:",
    ...focus
      .split(/\n|;/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => `- ${l.replace(/^[-*]\s*/, "")}`),
    "",
    COMMON_OUTPUT,
  ].join("\n");
}

async function mutateAgents(fn: (list: AgentRow[]) => boolean): Promise<void> {
  const snapshot = await readConfigFileSnapshot();
  const parsed = parseConfigJson5(snapshot.raw ?? "{}");
  const config: InfinibotConfig =
    parsed.ok && parsed.parsed && typeof parsed.parsed === "object"
      ? (parsed.parsed as InfinibotConfig)
      : ({} as InfinibotConfig);
  if (!config.agents) config.agents = {};
  if (!Array.isArray(config.agents.list)) config.agents.list = [];
  if (!fn(config.agents.list as AgentRow[])) return;
  const validation = validateConfigObjectWithPlugins(config);
  if (!validation.ok) {
    throw new Error(
      `Invalid config: ${validation.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
    );
  }
  await writeConfigFile(config);
}

/** Create the template's agent if no agent with that id (or alias) exists. */
export async function ensureTemplateAgent(templateId: string): Promise<string> {
  const tpl = ANALYST_TEMPLATES.find((t) => t.id === templateId);
  if (!tpl) return templateId;
  const id = resolveTemplateAgentId(templateId, loadConfig());
  if (id !== templateId) return id;
  if (agentRows(loadConfig()).some((a) => a.id === templateId)) return templateId;
  await mutateAgents((list) => {
    if (list.some((a) => a.id === tpl.id)) return false;
    list.push({ id: tpl.id, name: tpl.name.toUpperCase(), systemPrompt: tpl.systemPrompt });
    return true;
  });
  return tpl.id;
}

/** Seed the Archaeologist analyst (idempotent; never overwrites). */
export async function ensureAnalystAgents(): Promise<void> {
  await ensureTemplateAgent("archaeologist");
}

/** Create a new analyst persona as a real agent. Returns its agent id. */
export async function createAnalystAgent(params: {
  name: string;
  focus: string;
  id?: string;
}): Promise<{ agentId: string; created: boolean }> {
  const name = params.name.trim().slice(0, 60);
  const focus = params.focus.trim().slice(0, 2000);
  if (!name) throw new Error("name required");
  if (!focus) throw new Error("focus required (what should this analyst look for?)");
  const base = params.id?.trim() ? slug(params.id) : `analyst-${slug(name)}`;
  if (!base || base === "analyst-") throw new Error("name must contain letters or digits");
  let agentId = base;
  let created = false;
  await mutateAgents((list) => {
    for (let i = 2; list.some((a) => a.id === agentId); i++) agentId = `${base}-${i}`;
    list.push({
      id: agentId,
      name: name.toUpperCase(),
      systemPrompt: personaPromptFor(name, focus),
    });
    created = true;
    return true;
  });
  return { agentId, created };
}
