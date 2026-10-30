/**
 * Script Agent Tool Registry — the tool surface the script-agent can call
 * inside its loop. Each tool exposes an Anthropic-shaped schema plus an
 * in-process executor, so the same registry drives the agent loop and can be
 * re-exposed over RPC.
 *
 * Tools:
 *   viralExamples.search     — retrieve more exemplars on demand
 *   viralExamples.getStructure — parsed HOOK/beats/CTA of one exemplar
 *   web.search               — current trends/headlines/facts (research-service)
 *   web.fetch                — read a source URL as text
 *   transcripts.search       — search the transcribed-exemplar corpus
 *   knowledge.query          — query the user's knowledge graph (best-effort)
 *   notes.search             — pull saved hooks/angles/proof points
 *   script.draft             — record a full draft; runtime lints + returns critique
 *   script.revise            — record a revised draft; runtime re-lints
 */

import { getViralExamplesStore, toExemplar } from "../../content/viral-examples-store.js";
import {
  gatherResearch,
  fetchWithTimeout,
  type ResearchBundle,
} from "../../content/research-service.js";
import { NoteStore } from "../../notes/store.js";
import { parseScript } from "../../storyboard/script-generator.js";
import { lintScript, type LintResult } from "./viral-lint.js";

/** Mutable per-run state shared across tool calls and the loop. */
export interface AgentRunState {
  stateDir: string;
  platform: string | undefined;
  /** Most recent full draft text the agent submitted via script.draft/revise. */
  currentDraft?: string;
  /** Last lint result. */
  lastLint?: LintResult;
  /** Research bundles gathered (merged for the final result). */
  research?: ResearchBundle;
  /** Exemplars the agent pulled (deduped by id). */
  exemplarsUsed: Map<string, { id: string; title: string; platform: string }>;
  /** Count of web.search calls (used by tests / acceptance). */
  webSearchCount: number;
  /** Count of viralExamples.* calls. */
  exemplarLookupCount: number;
}

export function newRunState(stateDir: string, platform: string | undefined): AgentRunState {
  return {
    stateDir,
    platform,
    exemplarsUsed: new Map(),
    webSearchCount: 0,
    exemplarLookupCount: 0,
  };
}

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolResult {
  /** Short human summary for the trace. */
  summary: string;
  /** Text fed back to the model as the tool_result content. */
  content: string;
}

export type ToolExecutor = (
  args: Record<string, unknown>,
  state: AgentRunState,
) => Promise<ToolResult>;

interface ToolDef {
  schema: ToolSchema;
  execute: ToolExecutor;
}

function clip(s: string, n: number): string {
  const x = (s || "").replace(/\s+/g, " ").trim();
  return x.length > n ? x.slice(0, n - 1) + "…" : x;
}

function assembleBeats(beats: Array<Record<string, unknown>>): string {
  return beats
    .map((b, i) => {
      const title = String(b.title ?? `Scene ${i + 1}`);
      const visual = String(b.visual ?? "");
      const vo = b.voiceover != null ? String(b.voiceover) : "";
      const dur = b.duration != null ? String(b.duration) : "";
      return [
        `[SCENE ${i + 1}: ${title}]`,
        `VISUAL: ${visual}`,
        vo ? `VOICEOVER: ${vo}` : "",
        dur ? `DURATION: ${dur}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

/** Lint a submitted draft and store it as the current draft. */
function recordDraft(script: string, state: AgentRunState): ToolResult {
  state.currentDraft = script;
  const scenes = parseScript(script);
  const lint = lintScript(script, state.platform, scenes);
  state.lastLint = lint;
  const summary = lint.clean
    ? `draft recorded — ${scenes.length} scenes, lint CLEAN`
    : `draft recorded — ${scenes.length} scenes, ${lint.violations.length} lint issue(s)`;
  const content = lint.clean
    ? `Draft recorded. Lint is CLEAN (${scenes.length} scenes). If you are satisfied, return the final script as your next message.`
    : `Draft recorded (${scenes.length} scenes). LINT FOUND ISSUES:\n\n${lint.critique}\n\nCall script.revise with the corrected full script.`;
  return { summary, content };
}

export const SCRIPT_AGENT_TOOLS: Record<string, ToolDef> = {
  "viralExamples.search": {
    schema: {
      name: "viralExamples_search",
      description:
        "Search the library of transcribed viral videos for style exemplars matching a topic. Returns titles, hooks, platforms, and excerpts. Use to anchor your structure on what actually went viral.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Topic/angle to match exemplars against." },
          platform: {
            type: "string",
            description: "Optional platform filter (tiktok, shorts, instagram, youtube).",
          },
          limit: { type: "number", description: "Max exemplars (default 3, max 8)." },
        },
        required: ["query"],
      },
    },
    execute: async (args, state) => {
      state.exemplarLookupCount += 1;
      const store = getViralExamplesStore(state.stateDir);
      const limit = Math.max(1, Math.min(8, Number(args.limit) || 3));
      const platform = typeof args.platform === "string" ? args.platform : undefined;
      const matches = store.retrieveBest({
        topic: String(args.query || ""),
        platform: platform as never,
        limit,
      });
      for (const m of matches) {
        state.exemplarsUsed.set(m.id, { id: m.id, title: m.title, platform: String(m.platform) });
      }
      if (matches.length === 0) {
        return {
          summary: "no exemplars matched",
          content:
            "No exemplars matched. The library may be empty or the topic is novel — rely on the structure rules in your system prompt.",
        };
      }
      const body = matches
        .map((m, i) => {
          const ex = toExemplar(m, 400);
          return `#${i + 1} [id:${m.id}] "${ex.title}" (${ex.platform})\n  HOOK: ${ex.hook}\n  EXCERPT: ${ex.excerpt}`;
        })
        .join("\n\n");
      return { summary: `${matches.length} exemplar(s)`, content: body };
    },
  },

  "viralExamples.getStructure": {
    schema: {
      name: "viralExamples_getStructure",
      description:
        "Fetch the parsed HOOK / beats / CTA structure of a specific exemplar by id (from viralExamples_search). Use to study the exact beat order of a strong match.",
      input_schema: {
        type: "object",
        properties: { exampleId: { type: "string", description: "Exemplar id." } },
        required: ["exampleId"],
      },
    },
    execute: async (args, state) => {
      const store = getViralExamplesStore(state.stateDir);
      const ex = store.get(String(args.exampleId || ""));
      if (!ex) return { summary: "not found", content: "No exemplar with that id." };
      state.exemplarsUsed.set(ex.id, { id: ex.id, title: ex.title, platform: String(ex.platform) });
      const beats = parseScript(ex.transcript);
      const beatText = beats.length
        ? beats.map((b) => `  - ${b.title}: ${clip(b.voiceover || b.visual, 120)}`).join("\n")
        : "  (transcript is not scene-formatted — infer beats from the excerpt below)";
      return {
        summary: `structure of "${ex.title}"`,
        content: [
          `"${ex.title}" (${ex.platform})`,
          `HOOK: ${ex.hook}`,
          ex.structureNotes ? `STRUCTURE NOTES: ${ex.structureNotes}` : "",
          "BEATS:",
          beatText,
          `EXCERPT: ${clip(ex.transcript, 500)}`,
        ]
          .filter(Boolean)
          .join("\n"),
      };
    },
  },

  "web.search": {
    schema: {
      name: "web_search",
      description:
        "Research current trends, headlines, slang, recent events, and facts for the angle. Returns facts, stats, quotes, and trending phrases with sources.",
      input_schema: {
        type: "object",
        properties: { query: { type: "string", description: "What to research." } },
        required: ["query"],
      },
    },
    execute: async (args, state) => {
      state.webSearchCount += 1;
      const bundle = await gatherResearch({ query: String(args.query || ""), timeoutMs: 12000 });
      // Merge into the run's research accumulator (keep first as canonical, append sources).
      if (!state.research) state.research = bundle;
      else {
        state.research.facts.push(...bundle.facts);
        state.research.stats.push(...bundle.stats);
        state.research.quotes.push(...bundle.quotes);
        state.research.sources.push(...bundle.sources);
      }
      const lines: string[] = [];
      if (bundle.facts.length)
        lines.push(
          "FACTS:\n" +
            bundle.facts
              .slice(0, 6)
              .map((f) => `  - ${clip(f, 180)}`)
              .join("\n"),
        );
      if (bundle.stats.length)
        lines.push(
          "STATS:\n" +
            bundle.stats
              .slice(0, 5)
              .map((s) => `  - ${s.value}: ${clip(s.context, 120)}`)
              .join("\n"),
        );
      if (bundle.quotes.length)
        lines.push(
          "QUOTES:\n" +
            bundle.quotes
              .slice(0, 3)
              .map((q) => `  - "${clip(q.text, 140)}"${q.speaker ? ` — ${q.speaker}` : ""}`)
              .join("\n"),
        );
      if (bundle.trends.length) lines.push("TRENDS:\n  " + bundle.trends.slice(0, 8).join(" · "));
      const body = lines.length
        ? lines.join("\n\n")
        : "No strong results — proceed from your own knowledge but stay specific.";
      return {
        summary: `${bundle.facts.length}f/${bundle.stats.length}s/${bundle.sources.length}src`,
        content: body,
      };
    },
  },

  "web.fetch": {
    schema: {
      name: "web_fetch",
      description:
        "Fetch a URL the user referenced (article, transcript, primary doc) and read it as plain text.",
      input_schema: {
        type: "object",
        properties: { url: { type: "string", description: "Absolute http(s) URL." } },
        required: ["url"],
      },
    },
    execute: async (args) => {
      const url = String(args.url || "");
      if (!/^https?:\/\//i.test(url))
        return { summary: "bad url", content: "Provide an absolute http(s) URL." };
      try {
        const res = await fetchWithTimeout(url, 12000);
        const html = await res.text();
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        return { summary: `fetched ${url} (${text.length} chars)`, content: clip(text, 4000) };
      } catch (err) {
        return {
          summary: "fetch failed",
          content: `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  },

  "transcripts.search": {
    schema: {
      name: "transcripts_search",
      description:
        "Search the transcribed-video corpus (the exemplar library's full transcripts) for phrasing, hook patterns, or proof points relevant to the angle.",
      input_schema: {
        type: "object",
        properties: { query: { type: "string", description: "What to find in the transcripts." } },
        required: ["query"],
      },
    },
    execute: async (args, state) => {
      const store = getViralExamplesStore(state.stateDir);
      const matches = store.retrieveBest({ topic: String(args.query || ""), limit: 4 });
      if (matches.length === 0)
        return { summary: "no transcripts", content: "No matching transcripts in the corpus." };
      const body = matches
        .map((m) => `"${m.title}" (${m.platform}):\n  ${clip(m.transcript, 600)}`)
        .join("\n\n");
      return { summary: `${matches.length} transcript(s)`, content: body };
    },
  },

  "knowledge.query": {
    schema: {
      name: "knowledge_query",
      description:
        "Query the user's knowledge graph for entities, facts, or relationships relevant to the angle. Best-effort: returns nothing if no graph is configured.",
      input_schema: {
        type: "object",
        properties: { query: { type: "string", description: "What to look up." } },
        required: ["query"],
      },
    },
    // No standalone knowledge-graph data store exists server-side (the graph is a
    // UI projection). Return a graceful empty result so the agent doesn't stall.
    execute: async () => ({
      summary: "no knowledge graph",
      content:
        "No server-side knowledge graph is available in this build. Use web.search / notes.search / transcripts.search instead.",
    }),
  },

  "notes.search": {
    schema: {
      name: "notes_search",
      description:
        "Search the user's saved notes for hooks, angles, proof points, or prior research they've written down.",
      input_schema: {
        type: "object",
        properties: { query: { type: "string", description: "What to find." } },
        required: ["query"],
      },
    },
    execute: async (args, state) => {
      try {
        const notes = new NoteStore(state.stateDir);
        const items = notes.list({ query: String(args.query || "") }).slice(0, 5);
        if (items.length === 0) return { summary: "no notes", content: "No matching notes." };
        const body = items
          .map(
            (n) =>
              `"${n.name}"${n.description ? ` — ${clip(n.description, 100)}` : ""}\n  ${clip((n as { bodyPreview?: string; body?: string }).bodyPreview || (n as { body?: string }).body || "", 280)}`,
          )
          .join("\n\n");
        return { summary: `${items.length} note(s)`, content: body };
      } catch (err) {
        return {
          summary: "notes unavailable",
          content: `Notes store unavailable: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  },

  "script.draft": {
    schema: {
      name: "script_draft",
      description:
        "Record your first full draft. Pass the complete script as `script` (preferred) OR structured `beats`. The runtime lints it against the viral structure rules and returns any violations to fix.",
      input_schema: {
        type: "object",
        properties: {
          script: { type: "string", description: "Full script text in [SCENE X] format." },
          beats: {
            type: "array",
            description: "Alternative to `script`: ordered scene beats.",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                visual: { type: "string" },
                voiceover: { type: "string" },
                duration: { type: "number" },
              },
            },
          },
        },
      },
    },
    execute: async (args, state) => {
      const script =
        typeof args.script === "string" && args.script.trim()
          ? args.script
          : Array.isArray(args.beats)
            ? assembleBeats(args.beats as Array<Record<string, unknown>>)
            : "";
      if (!script.trim())
        return { summary: "empty draft", content: "Provide `script` text or `beats`." };
      return recordDraft(script, state);
    },
  },

  "script.revise": {
    schema: {
      name: "script_revise",
      description:
        "Record a revised full draft after addressing lint critique. Pass the complete corrected `script`. The runtime re-lints and confirms whether it is now clean.",
      input_schema: {
        type: "object",
        properties: {
          script: { type: "string", description: "Full corrected script text." },
        },
        required: ["script"],
      },
    },
    execute: async (args, state) => {
      const script = typeof args.script === "string" ? args.script : "";
      if (!script.trim())
        return { summary: "empty revision", content: "Provide the full corrected `script`." };
      return recordDraft(script, state);
    },
  },
};

/** Anthropic tools[] array. */
export function toolSchemas(): ToolSchema[] {
  return Object.values(SCRIPT_AGENT_TOOLS).map((t) => t.schema);
}

/** Map an Anthropic tool name (underscored) back to its registry key. */
const NAME_TO_KEY: Record<string, string> = Object.fromEntries(
  Object.entries(SCRIPT_AGENT_TOOLS).map(([key, def]) => [def.schema.name, key]),
);

export function resolveTool(anthropicName: string): { key: string; def: ToolDef } | null {
  const key = NAME_TO_KEY[anthropicName];
  if (!key) return null;
  return { key, def: SCRIPT_AGENT_TOOLS[key] };
}
