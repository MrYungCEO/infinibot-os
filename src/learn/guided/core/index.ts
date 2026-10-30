/**
 * Core guided Learn tracks (always available). One file per track; plugin
 * tracks live with their plugin (`extensions/<dir>/learn.json`).
 *
 * Every track is validated by src/learn/guided/core.test.ts and every step's
 * target is proven in a real browser by scripts/learn/audit-walkthroughs.mjs.
 */

import type { LearnMissionRef, LearnTrack, LearnWalkthrough } from "../types.js";
import {
  AGENTS_CONSTELLATION,
  MESH_PLUGIN_DISTRICT,
  PROJECTS_REPOS_DEPLOY,
  VOICE_ROBOVOICE_PIPELINE,
} from "./r9-surfaces.js";
import { track as gettingStarted } from "./getting-started.js";
import { track as chatModels } from "./chat-models.js";
import { track as agents } from "./agents.js";
import { track as goals } from "./goals.js";
import { track as phasesQueue } from "./phases-queue.js";
import { track as scheduledApprovals } from "./scheduled-approvals.js";
import { track as documents } from "./documents.js";
import { track as projects } from "./projects.js";
import { track as workspace } from "./workspace.js";
import { track as voice } from "./voice.js";
import { track as channels } from "./channels.js";
import { track as mcpSkills } from "./mcp-skills.js";
import { track as pluginsMarketplace } from "./plugins-marketplace.js";
import { track as sidebar } from "./sidebar.js";
import { track as mobileApp } from "./mobile-app.js";
import { track as security } from "./security.js";

/** Append the r9 walkthroughs (r9-surfaces.ts) to their track. */
function withExtras(track: LearnTrack | null, extras: LearnWalkthrough[]): LearnTrack | null {
  if (!track) return track;
  const add = extras.filter((e) => !track.walkthroughs.some((w) => w.id === e.id));
  return add.length ? { ...track, walkthroughs: [...track.walkthroughs, ...add] } : track;
}

const EXTRAS: Record<string, LearnWalkthrough[]> = {
  agents: [AGENTS_CONSTELLATION],
  "plugins-marketplace": [MESH_PLUGIN_DISTRICT],
  voice: [VOICE_ROBOVOICE_PIPELINE],
  projects: [PROJECTS_REPOS_DEPLOY],
};

export const CORE_TRACKS: LearnTrack[] = [
  gettingStarted,
  chatModels,
  agents,
  goals,
  phasesQueue,
  scheduledApprovals,
  documents,
  projects,
  workspace,
  voice,
  channels,
  mcpSkills,
  pluginsMarketplace,
  sidebar,
  mobileApp,
  security,
]
  .map((t) => withExtras(t, t ? (EXTRAS[t.id] ?? []) : []))
  .filter((t): t is LearnTrack => Boolean(t));

/** Day-1 missions: the first walkthroughs a new user is nudged through. */
export const CORE_MISSIONS: LearnMissionRef[] = [
  { walkthrough: "getting-started/tour-the-app", starter: true },
  { walkthrough: "chat-models/first-message", starter: true },
  { walkthrough: "goals/first-goal", starter: true },
  { walkthrough: "plugins-marketplace/browse-plugins", starter: true },
].filter((m) => CORE_TRACKS.some((t) => m.walkthrough.startsWith(`${t.id}/`)));
