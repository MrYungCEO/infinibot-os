/**
 * Seed: the Iam.YungCEO YouTube page + "InfiniBot: Your AI Team" Season 1.
 *
 * - Finds the @iam.yungceo Instagram page by id, then by handle (never
 *   creates a duplicate); creates it from the legacy values only when no
 *   Instagram page with that handle exists.
 * - Finds or creates the "Iam.YungCEO YouTube" page (same business, voice and
 *   tone) and links the two pages both ways.
 * - Creates Season 1 episodes 0–13 at stage Outlined. Episodes that already
 *   exist (same series + season + episode) are left exactly as they are, so
 *   a re-run never resets progress.
 * - Adds the Bonus / Season 2 ideas to the YouTube page at stage Idea
 *   (skipped when an idea with the same title exists).
 *
 * Touches only <stateDir>/databases.db (content_pages + its child databases).
 * Never opens content-intel.db.
 *
 * CLI: scripts/seed-youtube-series.mts.
 */

import { getDatabasesStore } from "../databases/store.js";
import { normalizeHandle } from "./pages-intel.js";
import { getContentPagesStore } from "./pages-store.js";
import { ContentSeriesService, type EpisodeInput } from "./series.js";
import type { ContentPage, ContentPageInput } from "./types.js";

export const IG_PAGE: ContentPageInput & { id: string } = {
  id: "page_357b5087-742e-47f0-a9fe-fa7f748db935",
  name: "Iam.YungCEO",
  surface: "instagram",
  handle: "@iam.yungceo",
  url: "https://www.instagram.com/iam.yungceo/",
  businessId: "biz-1778348586455-sywl8o",
  status: "active",
  theme: { voice: "Informative, Funny, Real", tone: "Direct, Family Like, Urgency Inducing" },
  goals: { followersTarget: 300000, monthlyPostsTarget: 90, engagementRateTarget: 10 },
};

export const YT_PAGE_NAME = "Iam.YungCEO YouTube";
export const SERIES_NAME = "InfiniBot: Your AI Team";
export const SEASON = 1;

const SHORTS_NOTE =
  'Cut 2–3 vertical Shorts (30–45s) from the episode\'s best "aha" moment with a CTA to the full episode; post the strongest as an IG Reel.';

type SeedEpisode = Required<Pick<EpisodeInput, "episode" | "title">> &
  Pick<EpisodeInput, "painPoint" | "whatToShow" | "payoff" | "notes" | "repurposeNote">;

/** Season 1 outline (owner's course outline, 2026-10-04). */
export const SEASON_1: SeedEpisode[] = [
  {
    episode: 0,
    title: "Trailer: I run my business with an AI team. Here's a normal Tuesday",
    whatToShow:
      "90s montage: WhatsApp message → code shipped, image generated, emails drafted, call answered. End on the activity map with several agents working.",
    notes: "Trailer, 90 seconds.",
  },
  {
    episode: 1,
    title: '"ChatGPT can\'t do this": the one demo that sells it',
    painPoint: "AI that talks but doesn't DO anything.",
    whatToShow:
      "One message from your phone kicks off sub-agents that research, write, build. Watch it live on the mesh map; it comes back VERIFIED with screenshots.",
    payoff: '"It didn\'t say it was done. It proved it."',
  },
  {
    episode: 2,
    title: "Set up in 10 minutes (no coding)",
    painPoint: '"AI setup needs a CS degree."',
    whatToShow:
      "Cloud sign-up → onboarding quickstart → BYOK key → connect Telegram/WhatsApp. First win under 10 min.",
    payoff: "The free plan is enough to follow the whole course.",
  },
  {
    episode: 3,
    title: "Your AI lives in WhatsApp and Telegram",
    painPoint: "Tab-switching, lost context.",
    whatToShow: "Voice notes and texts → tasks, reminders, answers while you're out.",
  },
  {
    episode: 4,
    title: "Inbox Zero on autopilot",
    painPoint: "Drowning in email.",
    whatToShow:
      "Gmail triage, drafted replies, and the APPROVAL step (nothing sends without your tap).",
  },
  {
    episode: 5,
    title: "Stop forgetting things: one brain for notes, tasks, docs",
    painPoint: "To-dos in five apps.",
    whatToShow: "Documents workspace, Notion import, Kanban, messy brain-dump → project board.",
  },
  {
    episode: 6,
    title: "Hire AI employees: sub-agents explained simply",
    painPoint: '"AI does one thing at a time and I babysit it."',
    whatToShow:
      'Spawn 3 agents in parallel, ask "what\'s running?", results come back VERIFIED / FAILED.',
  },
  {
    episode: 7,
    title: '"AI said it was done… it wasn\'t." Fixing that forever',
    painPoint: "The most universal AI frustration.",
    whatToShow:
      "Coder agents build a feature with visual_verify screenshots as proof. Show a FAILED run getting caught honestly.",
    notes: "Your most viral hook.",
  },
  {
    episode: 8,
    title: "Content machine: post every day without burning out",
    painPoint: "Posting consistently.",
    whatToShow: "FlyPic image/video, Content Studio, Canva exports. One idea → a week of posts.",
  },
  {
    episode: 9,
    title: "Your AI answers the phone (Robovoice)",
    painPoint: "Missed calls = lost revenue.",
    whatToShow:
      "Live call to an AI receptionist that books/takes notes, then hands off to InfiniBot tasks.",
  },
  {
    episode: 10,
    title: "Run your agency/business from one screen",
    painPoint: "Client chaos.",
    whatToShow: "Business & Agency plugin, client kanban, client brief → tasks + deliverables.",
  },
  {
    episode: 11,
    title: "Automations that run while you sleep",
    painPoint: "Repeating chores.",
    whatToShow:
      "Scheduled tasks, workflows, goal runs. Set up a morning brief + weekly report once, never touch again.",
  },
  {
    episode: 12,
    title: '"Can I trust it with my accounts?"',
    painPoint: "Fear and trust.",
    whatToShow: "Approvals, Vault secrets, audit history.",
    payoff: "You stay in control.",
    notes: "Converts skeptics. Move earlier if comments show fear.",
  },
  {
    episode: 13,
    title: 'Capstone: "A full day running my business with InfiniBot"',
    whatToShow: "Vlog-style real day tying every episode together.",
    payoff: 'Becomes the evergreen "start here" video.',
  },
];

/** Bonus / Season 2 ideas (stage Idea on the YouTube page). */
export const BONUS_IDEAS: Array<{ title: string; notes: string }> = [
  {
    title: "Plugins marketplace: extend InfiniBot, or build and sell your own plugin",
    notes: "Bonus / Season 2 idea from the InfiniBot course outline.",
  },
  {
    title: "Discipline + Focus: the AI accountability coach",
    notes: "Bonus / Season 2 idea from the InfiniBot course outline.",
  },
  {
    title: "Mobile app tour: your AI team in your pocket",
    notes: "Bonus / Season 2 idea from the InfiniBot course outline.",
  },
  {
    title: "Developer track: MCP orchestration with Claude Code, coder agents on real repos",
    notes: "Bonus / Season 2 idea from the InfiniBot course outline.",
  },
];

export interface SeedReport {
  stateDir: string;
  igPage: { id: string; created: boolean; matchedBy: "id" | "handle" | "created" };
  youtubePage: { id: string; created: boolean };
  linked: boolean;
  episodes: { created: number; kept: number; ids: string[] };
  ideas: { created: number; kept: number };
}

function findIgPage(pages: ContentPage[]): { page: ContentPage; by: "id" | "handle" } | null {
  const live = pages.filter((p) => !p.deletedAt);
  const byId = live.find((p) => p.id === IG_PAGE.id);
  if (byId) return { page: byId, by: "id" };
  const want = normalizeHandle(IG_PAGE.handle);
  const byHandle = live.find(
    (p) =>
      p.surface === "instagram" &&
      (normalizeHandle(p.handle) === want || normalizeHandle(p.links.intelAccount) === want),
  );
  return byHandle ? { page: byHandle, by: "handle" } : null;
}

export function seedYoutubeSeries(opts: { stateDir: string; youtubeHandle?: string }): SeedReport {
  const store = getContentPagesStore(opts.stateDir);
  const series = new ContentSeriesService(store, getDatabasesStore(opts.stateDir));
  const all = store.list({ includeArchived: true });

  // 1. Instagram page — reuse, never duplicate.
  const found = findIgPage(all);
  const ig = found?.page ?? store.create(IG_PAGE);
  const igReport: SeedReport["igPage"] = {
    id: ig.id,
    created: !found,
    matchedBy: found?.by ?? "created",
  };

  // 2. YouTube page — the one linked to IG, else by name, else create.
  const ytExisting =
    all.find((p) => !p.deletedAt && p.surface === "youtube" && ig.links.pageIds.includes(p.id)) ??
    all.find((p) => !p.deletedAt && p.surface === "youtube" && p.name === YT_PAGE_NAME);
  const yt =
    ytExisting ??
    store.create({
      name: YT_PAGE_NAME,
      surface: "youtube",
      businessId: ig.businessId,
      handle: opts.youtubeHandle,
      status: "active",
      theme: { voice: IG_PAGE.theme!.voice, tone: IG_PAGE.theme!.tone },
    });

  // 3. Link both ways (idempotent).
  store.linkPages(yt.id, ig.id);

  // 4. Season 1 episodes — create missing only.
  const existing = series.listEpisodes(yt.id);
  let created = 0;
  let kept = 0;
  const ids: string[] = [];
  for (const ep of SEASON_1) {
    const hit = existing.find(
      (e) => e.seriesName === SERIES_NAME && e.season === SEASON && e.episode === ep.episode,
    );
    if (hit) {
      kept++;
      ids.push(hit.id);
      continue;
    }
    const row = series.upsertEpisode(yt.id, {
      ...ep,
      seriesName: SERIES_NAME,
      season: SEASON,
      stage: "outlined",
      repurposeNote: ep.repurposeNote ?? SHORTS_NOTE,
    });
    created++;
    ids.push(row.id);
  }

  // 5. Bonus / Season 2 ideas.
  let ideasCreated = 0;
  let ideasKept = 0;
  for (const idea of BONUS_IDEAS) {
    const res = series.addIdea(yt.id, {
      title: idea.title,
      notes: idea.notes,
      source: `${SERIES_NAME} outline`,
      stage: "idea",
    });
    if (res.created) ideasCreated++;
    else ideasKept++;
  }

  const igAfter = store.get(ig.id)!;
  const ytAfter = store.get(yt.id)!;
  return {
    stateDir: opts.stateDir,
    igPage: igReport,
    youtubePage: { id: yt.id, created: !ytExisting },
    linked: igAfter.links.pageIds.includes(yt.id) && ytAfter.links.pageIds.includes(ig.id),
    episodes: { created, kept, ids },
    ideas: { created: ideasCreated, kept: ideasKept },
  };
}
