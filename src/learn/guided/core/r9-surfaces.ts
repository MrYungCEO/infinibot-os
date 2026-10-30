import type { LearnWalkthrough } from "../types.js";

/**
 * Walkthroughs for the release r9 surfaces: the Agents constellation, the
 * mesh Plugin District and the optional Cloud voice (Robovoice) pipeline. These shipped
 * live in r9, so they carry no `surface` guard any more (the Robovoice one
 * still needs the robovoice plugin enabled). core/index.ts appends each one to
 * its core track.
 */

/** Appended to the "agents" track. */
export const AGENTS_CONSTELLATION: LearnWalkthrough = {
  id: "constellation",
  title: "The agent constellation",
  summary:
    "Read your whole roster at a glance: live KPIs, the constellation map, filters and the card view.",
  estMinutes: 4,
  steps: [
    {
      id: "roster-header",
      title: "Your roster, live",
      body: "The header counts your agents and clusters and says when the data last refreshed. It updates while you watch.",
      route: "/agents",
      target: [".agp-top", ".agp-root"],
      placement: "bottom",
    },
    {
      id: "kpis",
      title: "Today at a glance",
      body: "Four numbers: agents **active now** (plus blocked and errored), **runs today**, the share of today's judged runs that were **Verified**, and **spend today**.",
      target: [".agp-kpis", ".agp-top"],
    },
    {
      id: "constellation-view",
      title: "Switch to the constellation",
      body: "Click **Constellation**. Each node is an agent, clusters are its team, and pulses are runs in flight.",
      target: ".agp-seg",
      action: { kind: "click", target: '.agp-seg [role="tab"]:first-child' },
    },
    {
      id: "map",
      title: "Read the map",
      body: "Node size shows activity and colour shows state (working, idle, blocked, error). Hover a node for its card, or click it to open the detail drawer with runs, spend, tools, memory and channels.",
      target: [".agp-cx-host", ".agp-main"],
      placement: "center",
    },
    {
      id: "controls",
      title: "Zoom and fit",
      body: "Zoom in and out, or **Fit all** to frame the whole roster. The keyboard shortcuts are +, − and 0.",
      target: [".agp-cx-controls", ".agp-main"],
    },
    {
      id: "filters",
      title: "Filter the roster",
      body: "Filter by team, status or name. On a phone the filters sit behind the **Filters** button.",
      target: [".agp-rail", ".agp-actions"],
    },
    {
      id: "cards",
      title: "Prefer cards?",
      body: "**Cards** shows the same agents as a sortable grid. The view you pick is remembered.",
      target: ".agp-seg",
      action: { kind: "click", target: '.agp-seg [role="tab"]:nth-child(2)' },
    },
  ],
};

/** Appended to the "plugins-marketplace" track. */
export const MESH_PLUGIN_DISTRICT: LearnWalkthrough = {
  id: "plugin-district",
  title: "Your plugins on the mesh: the Plugin District",
  summary:
    "Every enabled plugin gets a themed room on the agent mesh map, and agents walk there while they work in it.",
  estMinutes: 3,
  steps: [
    {
      id: "mesh",
      title: "The agent mesh",
      body: "This is Galactic HQ, the live map of your agents. The core station sits in the middle. Around it is the **Plugin District**.",
      route: "/mesh",
      target: ["agency-world-viz", "main.content"],
      placement: "center",
      waitMs: 12000,
    },
    {
      id: "rooms",
      title: "One room per plugin",
      body: "Each enabled plugin with a page gets a room themed to what it does: a trading floor for Infinitrade, a clinic for OmniClinic, a dojo for Discipline, a fleet bay for InfiniCode. Its monogram sits on the room's sign.",
      target: ["agency-world-viz", "main.content"],
      placement: "center",
    },
    {
      id: "activity",
      title: "Agents go where the work is",
      body: "When an agent calls a plugin's tools or RPCs, works on one of its pages, runs a task tagged with it, or is one of its roster agents, it walks to that room and works at a desk there. Click a room to open the plugin.",
      target: ["agency-world-viz", "main.content"],
      placement: "center",
    },
    {
      id: "toggle",
      title: "Rooms follow your plugins",
      body: "Turn a plugin off and its room dissolves. To keep the plugin but hide its room, open the plugin's **What it adds** section and switch off **Map room**. That takes effect right away, no restart.",
      route: "/plugins",
      target: ["[data-plugin-card]", "main.content"],
    },
  ],
};

/** Appended to the "voice" track. */
export const VOICE_ROBOVOICE_PIPELINE: LearnWalkthrough = {
  id: "robovoice-pipeline",
  title: "Cloud voice (Robovoice) pipeline",
  summary:
    "Optional: if you picked Cloud voice (Robovoice), the free cloud choice, see and tune the speech-to-text → language model → voice pipeline it uses for calls.",
  estMinutes: 4,
  requires: { kind: "pluginEnabled", plugin: "robovoice" },
  steps: [
    {
      id: "pipeline",
      title: "The location pipeline",
      body: "Local voice is the default and needs none of this. If you picked Cloud voice (Robovoice), calls at your Robovoice location run through three stages: **speech-to-text**, then a **language model**, then **text-to-speech**. InfiniBot edits the same pipeline as Robovoice's own dashboard.",
      route: "/robovoice",
      target: ["#rv-pipeline-section", "rv-pipeline-editor", "robovoice-view", "main.content"],
      waitMs: 10000,
    },
    {
      id: "layers",
      title: "Scopes and inheritance",
      body: "Pick **Global pipeline** or one agent. Each field says whether it's **Overridden here** or **Inherited** from the org, the location or the character. Resetting a field returns it to the inherited value.",
      target: ["rv-pipeline-editor", "#rv-pipeline-section", "main.content"],
    },
    {
      id: "apply",
      title: "Apply live",
      body: "Edits stay local until you press **Apply live**.",
      target: ["rv-pipeline-editor", "#rv-pipeline-section", "main.content"],
      practice: {
        mode: "explain",
        note: "Apply live changes the voice real callers hear immediately, so this tour doesn't press it. It only works while your install is linked to Robovoice and you're allowed to edit the pipeline.",
      },
    },
    {
      id: "agents",
      title: "Voice agents",
      body: "Your InfiniBot agents are matched to Robovoice characters by agent id. Each row shows its voice, how it answers and its TTS voice.",
      target: ['[data-testid="rv-voice-agents"]', "robovoice-view", "main.content"],
    },
    {
      id: "llm",
      title: "InfiniBot answers the call",
      body: "With the voice-LLM callback bound, your InfiniBot agent writes the replies on calls, tools included. The card shows the callback URL, the location token hint and first-token latency.",
      target: ['[data-testid="rv-voice-llm"]', "robovoice-view", "main.content"],
      practice: {
        mode: "explain",
        note: "Rotating the token re-sends a new secret to Robovoice. Do it only if the old one leaked.",
      },
    },
    {
      id: "voice-page",
      title: "Whose pipeline is live",
      body: "When Cloud voice is on, a badge on the Voice page shows which Robovoice org and location your voice is running through. If Cloud voice is busy or unreachable, you can switch back to local voice in one click.",
      route: "/voice",
      target: ["[data-voice-account]", "voice-chat", "main.content"],
    },
  ],
};

/** Projects › Repos & deploy: deploy branch, branch health, safe cleanup. */
export const PROJECTS_REPOS_DEPLOY: LearnWalkthrough = {
  id: "repos-deploy",
  title: "Repos, deploy branches and safe cleanup",
  summary:
    "Set where each repo deploys from, see which branches are merged and safe to delete, and clean up with a restore file.",
  estMinutes: 3,
  steps: [
    {
      id: "subtab",
      title: "Repos & deploy",
      body: "The **Repos & deploy** sub-tab lists every repo you attached to a project, with its deploy branch and branch health.",
      route: "/projects",
      target: ['[data-host-view="repos"]', '[data-host-subtabs="projects"]'],
      placement: "bottom",
    },
    {
      id: "page",
      title: "Deploy branch and health",
      body: "Each repo card shows the **deploy branch** (the branch and folder your live app is built from, with how far it is behind origin and any uncommitted changes) and health totals: **Safe to delete**, **Review**, **Active** and **Protected**. **Add a repo** opens a guided setup for your first one.",
      route: "/repos",
      target: "ib-repos-page",
      placement: "center",
    },
    {
      id: "cleanup",
      title: "Cleanup is always safe",
      body: "**Branch health → Clean up safe branches** shows a dry run first. Nothing is deleted until you confirm, a restore file is written before anything is removed, and branches with unique work, dirty folders, stashes and folders an agent is using are never touched.",
      target: "ib-repos-page",
      placement: "center",
    },
  ],
};
