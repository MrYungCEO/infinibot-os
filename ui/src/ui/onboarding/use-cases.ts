/**
 * "What are you using InfiniBot for?" — the use-case catalogue behind the
 * first-run onboarding, and the plan each answer turns into.
 *
 * Pure data + pure functions (no DOM, no Lit, no gateway) so the mapping is
 * unit-tested and the same table can drive the wizard, the Learn page's
 * "Recommended for you" ordering and any later personalisation.
 *
 * Copy rules: plain language, no jargon, no emoji.
 */

export type UseCaseId =
  | "business"
  | "content"
  | "coding"
  | "assistant"
  | "research"
  | "trading"
  | "voice"
  | "phones"
  | "media"
  | "clinic"
  | "exploring";

export type DashboardPreset = "hyperfocus" | "operator" | "executive" | "full";

export interface StarterTask {
  title: string;
  description: string;
}

export interface UseCase {
  id: UseCaseId;
  title: string;
  /** One plain sentence: what InfiniBot does for you here. */
  blurb: string;
  /** Icon name from ui/src/ui/icons.ts. */
  icon: string;
  /** Learn track ids (core or plugin), most useful first. */
  courses: string[];
  /** First-party plugin ids worth turning on. */
  plugins: string[];
  /** Agents worth pinning for this kind of work (roster ids; best effort). */
  agents: string[];
  dashboard: DashboardPreset;
  tasks: StarterTask[];
}

/** Every new user starts here: the chat course lands on the Chat page (/webchat). */
export const FIRST_COURSE = "chat-models";

export const USE_CASES: readonly UseCase[] = [
  {
    id: "business",
    title: "Running a business or agency",
    blurb: "Clients, projects, follow-ups and reports, handled by a team of agents.",
    icon: "briefcase",
    courses: ["projects", "business-agency", "scheduled-approvals"],
    plugins: ["business-agency", "products"],
    agents: ["client-director", "outreach", "ledger"],
    dashboard: "executive",
    tasks: [
      { title: "Tell InfiniBot about your business", description: "Open Chat and describe what you sell, who your customers are and how you find them." },
      { title: "Add your first client", description: "Add one real client so your agents can draft follow-ups and track the work." },
    ],
  },
  {
    id: "content",
    title: "Content creation and social media",
    blurb: "Plan posts, write captions and scripts, and keep a steady publishing calendar.",
    icon: "clapperboard",
    courses: ["content-studio", "flypic", "scheduled-approvals"],
    plugins: ["content-studio", "flypic"],
    agents: ["content-director", "scriptwriter", "cmo"],
    dashboard: "operator",
    tasks: [
      { title: "Plan a week of posts", description: "Ask your assistant for seven post ideas for your main channel, then pick your favourites." },
    ],
  },
  {
    id: "coding",
    title: "Coding and building software",
    blurb: "Hand coding tasks to AI coders, review their work and keep projects moving.",
    icon: "terminal",
    courses: ["agents", "infinicode", "mcp-skills", "workspace"],
    plugins: ["infinicode"],
    agents: ["coder", "head-of-dev", "qa"],
    dashboard: "operator",
    tasks: [
      { title: "Connect your first project folder", description: "Point InfiniBot at a code folder so coding agents know where to work." },
    ],
  },
  {
    id: "assistant",
    title: "Personal assistant and productivity",
    blurb: "Reminders, goals, notes and your daily plan, kept in one place.",
    icon: "calendar",
    courses: ["goals", "scheduled-approvals", "documents", "discipline"],
    plugins: ["discipline"],
    agents: ["main", "inbox-handler"],
    dashboard: "hyperfocus",
    tasks: [
      { title: "Set one goal for this month", description: "Write down one thing you want done by the end of the month. InfiniBot will help you break it down." },
      { title: "Schedule a daily briefing", description: "Ask your assistant for a short summary of your day every morning." },
    ],
  },
  {
    id: "research",
    title: "Research and learning",
    blurb: "Search the web, read long documents and turn findings into clear reports.",
    icon: "book",
    courses: ["documents", "canvas-library", "whiteboard"],
    plugins: ["canvas-library", "mcp-excalidraw"],
    agents: ["scout", "archivist"],
    dashboard: "hyperfocus",
    tasks: [
      { title: "Ask your first research question", description: "Pick a topic you care about and ask InfiniBot for a short, sourced summary." },
    ],
  },
  {
    id: "trading",
    title: "Trading and finance",
    blurb: "Watch markets, track a portfolio and get alerts when something moves.",
    icon: "chart",
    courses: ["infinitrade", "solatrix"],
    plugins: ["infinitrade", "solatrix"],
    agents: ["ledger", "monitor"],
    dashboard: "operator",
    tasks: [
      { title: "Build your watchlist", description: "Add the markets or coins you follow so InfiniBot can keep an eye on them." },
    ],
  },
  {
    id: "voice",
    title: "Talking to it by voice",
    blurb: "Speak instead of typing, hands-free, on your computer or phone.",
    icon: "mic",
    courses: ["voice", "robovoice"],
    plugins: ["robovoice"],
    agents: ["main"],
    dashboard: "hyperfocus",
    tasks: [
      { title: "Have your first voice conversation", description: "Open the Voice page, press the call button and say hello." },
    ],
  },
  {
    id: "phones",
    title: "Automating phones (Droid Swarm)",
    blurb: "Run a set of Android phones from one screen: apps, accounts and routines.",
    icon: "smartphone",
    courses: ["mobile-app"],
    plugins: ["droid-swarm"],
    agents: ["monitor"],
    dashboard: "operator",
    tasks: [
      { title: "Connect your first Android phone", description: "Follow the Droid Swarm guide to link one phone over Wi-Fi or USB." },
    ],
  },
  {
    id: "media",
    title: "Images and video (FlyPic)",
    blurb: "Make pictures and short videos from a sentence or a reference photo.",
    icon: "image",
    courses: ["flypic", "canvas-library"],
    plugins: ["flypic"],
    agents: ["graphic-designer", "video-editor-agent"],
    dashboard: "operator",
    tasks: [
      { title: "Make your first image", description: "Describe a picture in one sentence and let FlyPic draw it." },
    ],
  },
  {
    id: "clinic",
    title: "Running a clinic or practice",
    blurb: "Patients, appointments and front-desk messages for a health practice.",
    icon: "shieldCheck",
    courses: ["omniclinic", "security"],
    plugins: ["omniclinic"],
    agents: ["inbox-handler"],
    dashboard: "executive",
    tasks: [
      { title: "Set up your practice details", description: "Add your clinic name, hours and services so messages go out correctly." },
    ],
  },
  {
    id: "exploring",
    title: "Just exploring",
    blurb: "Not sure yet. Show me around and I will decide later.",
    icon: "sparkles",
    courses: ["getting-started", "sidebar", "plugins-marketplace"],
    plugins: [],
    agents: ["main"],
    dashboard: "full",
    tasks: [
      { title: "Say hello to your assistant", description: "Open Chat and ask what InfiniBot can do for you." },
    ],
  },
];

const BY_ID = new Map(USE_CASES.map((u) => [u.id, u] as const));

export function useCaseById(id: string): UseCase | undefined {
  return BY_ID.get(id as UseCaseId);
}

/** Keep only known ids, in catalogue order, without duplicates. */
export function normalizeUseCases(ids: readonly unknown[] | null | undefined): UseCaseId[] {
  const want = new Set((ids ?? []).filter((x): x is string => typeof x === "string"));
  return USE_CASES.filter((u) => want.has(u.id)).map((u) => u.id);
}

export interface OnboardingPlan {
  /** Learn tracks, FIRST_COURSE first, then interleaved across use cases. */
  courses: string[];
  plugins: string[];
  agents: string[];
  dashboard: DashboardPreset;
  tasks: StarterTask[];
}

/** Round-robin merge so two picked use cases both get their top items early. */
function interleave(lists: string[][]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const max = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < max; i++) {
    for (const l of lists) {
      const v = l[i];
      if (v && !seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
  }
  return out;
}

/** Busiest preset wins when picks disagree (more surfaces beats fewer). */
const PRESET_RANK: Record<DashboardPreset, number> = { hyperfocus: 0, operator: 1, executive: 2, full: 3 };

/**
 * Turn the picked use cases into concrete recommendations. `available`
 * filters courses / plugins to what this install actually has (unknown ids
 * from the catalogue are dropped instead of shown as dead cards).
 */
export function planFor(
  picked: readonly UseCaseId[],
  available?: { tracks?: ReadonlySet<string>; plugins?: ReadonlySet<string> },
): OnboardingPlan {
  const cases = normalizeUseCases(picked).map((id) => BY_ID.get(id)!);
  const effective = cases.length ? cases : [BY_ID.get("exploring")!];
  const okTrack = (id: string) => !available?.tracks || available.tracks.has(id);
  const okPlugin = (id: string) => !available?.plugins || available.plugins.has(id);
  const courses = interleave([[FIRST_COURSE], ...effective.map((u) => u.courses)]).filter(okTrack);
  const plugins = interleave(effective.map((u) => u.plugins)).filter(okPlugin);
  const agents = interleave(effective.map((u) => u.agents));
  const dashboard = effective
    .map((u) => u.dashboard)
    .reduce((a, b) => (PRESET_RANK[b] > PRESET_RANK[a] ? b : a));
  const tasks: StarterTask[] = [];
  const titles = new Set<string>();
  for (const u of effective) {
    for (const t of u.tasks) {
      if (!titles.has(t.title)) {
        titles.add(t.title);
        tasks.push(t);
      }
    }
  }
  return { courses, plugins, agents, dashboard, tasks: tasks.slice(0, 6) };
}

/**
 * Score boost for the Learn page's recommendations: tracks that belong to
 * the user's use cases float up (earlier in the plan = bigger boost).
 */
export function useCaseTrackBoost(picked: readonly UseCaseId[]): Map<string, number> {
  const plan = planFor(picked);
  const boost = new Map<string, number>();
  plan.courses.forEach((id, i) => boost.set(id, Math.max(100, 600 - i * 50)));
  return boost;
}
