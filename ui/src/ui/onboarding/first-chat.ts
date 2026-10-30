/**
 * The first chat after onboarding: a friendly welcome with a few one-tap
 * starters picked from the user's goals, then the personal learning path
 * starts AFTER InfiniBot's first reply (not before).
 *
 * Onboarding writes a small hand-off to localStorage and opens /webchat;
 * <webchat-view> renders the welcome while the chat is empty, marks the
 * hand-off as sent when a message goes out, and calls completeFirstChat()
 * on the first final reply.
 *
 * Copy rules: plain language, no jargon, no emoji.
 */
import type { UseCaseId } from "./use-cases";

export interface FirstChatStarter {
  title: string;
  prompt: string;
}

export interface FirstChatHandoff {
  v: 1;
  /** Name of the account the chat runs on ("ChatGPT"), when it came from "My subscription". */
  account: string | null;
  starters: FirstChatStarter[];
  /** Start the learning path after the first reply. */
  pendingPath: boolean;
  courses: string[];
  useCases: string[];
  at: number;
  /** Set once the first message went out from the welcome screen. */
  sentAt: number | null;
}

const KEY = "infinibot.onboarding.firstChat.v1";
const DONE_KEY = "infinibot.onboarding.firstChatDone";
/** A hand-off nobody used within a day is dropped (the normal empty chat comes back). */
const TTL_MS = 24 * 60 * 60_000;

const STARTERS: Record<UseCaseId, FirstChatStarter[]> = {
  business: [
    { title: "Plan my week", prompt: "Help me plan this week for my business. Ask me two quick questions first." },
    { title: "Follow up with a client", prompt: "Write a short, friendly follow-up email to a client I haven't heard from in a while." },
  ],
  content: [
    { title: "Ideas for posts", prompt: "Give me five post ideas for this week, each with a one-line hook." },
    { title: "Turn notes into a post", prompt: "I'll paste some rough notes. Turn them into a short, punchy social post." },
  ],
  coding: [
    { title: "Explain some code", prompt: "I'm going to paste some code. Explain what it does in plain words." },
    { title: "Plan a small app", prompt: "Help me plan a small app. Ask me what it should do, then list the first steps." },
  ],
  assistant: [
    { title: "Organise my day", prompt: "Help me organise my day. Ask me what's on my plate, then make a simple plan." },
    { title: "Remind me of something", prompt: "What kinds of things can you remember or remind me about?" },
  ],
  research: [
    { title: "Research a topic", prompt: "Research a topic for me and give me a short summary with the key points. Ask me the topic first." },
    { title: "Compare two options", prompt: "Help me compare two options side by side. Ask me what they are." },
  ],
  trading: [
    { title: "Explain a market idea", prompt: "Explain, in plain words, how to think about risk before making a trade." },
    { title: "Make a watchlist", prompt: "Help me set up a simple watchlist. Ask me what I'm interested in." },
  ],
  voice: [
    { title: "Try a voice chat", prompt: "How do I talk to you out loud? Walk me through it in three short steps." },
  ],
  phones: [
    { title: "What can you do on phones?", prompt: "What can you do with my Android phones? Give me three simple examples." },
  ],
  media: [
    { title: "Ideas for a video", prompt: "Give me three ideas for a short video, each with a one-line description." },
    { title: "Write an image prompt", prompt: "Help me write a good prompt for an image. Ask me what I want to see." },
  ],
  clinic: [
    { title: "Plan my clinic day", prompt: "Help me plan a busy clinic day so nothing slips. Ask me how many patients I expect." },
  ],
  exploring: [
    { title: "What can you do?", prompt: "What can you do for me? Give me five simple examples." },
    { title: "Write something for me", prompt: "Write a short, friendly message I can send to a friend to catch up." },
  ],
};

const GENERAL: FirstChatStarter[] = [
  { title: "What can you do?", prompt: "What can you do for me? Give me five simple examples." },
  { title: "Help me plan my day", prompt: "Help me plan my day. Ask me what's on my plate first." },
  { title: "Write a quick message", prompt: "Write a short, friendly message I can send to a friend to catch up." },
  { title: "Explain something simply", prompt: "Explain how you work in three short sentences, like I'm new to this." },
];

/** Three or four starters: one per picked goal first, then general ones to fill. */
export function startersFor(useCases: readonly string[], max = 4): FirstChatStarter[] {
  const out: FirstChatStarter[] = [];
  const seen = new Set<string>();
  const push = (s: FirstChatStarter | undefined) => {
    if (s && !seen.has(s.title) && out.length < max) {
      seen.add(s.title);
      out.push(s);
    }
  };
  const lists = useCases.map((u) => STARTERS[u as UseCaseId] ?? []);
  for (let round = 0; round < 2; round++) for (const l of lists) push(l[round]);
  for (const s of GENERAL) push(s);
  return out;
}

export function readFirstChat(): FirstChatHandoff | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as FirstChatHandoff | null;
    if (!v || v.v !== 1 || !Array.isArray(v.starters)) return null;
    if (Date.now() - v.at > TTL_MS) {
      localStorage.removeItem(KEY);
      return null;
    }
    return v;
  } catch {
    return null;
  }
}

export function writeFirstChat(h: FirstChatHandoff | null): void {
  try {
    if (h) localStorage.setItem(KEY, JSON.stringify(h));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage blocked */
  }
}

export function firstChatDone(): boolean {
  try {
    return localStorage.getItem(DONE_KEY) === "1";
  } catch {
    return false;
  }
}

export function prepareFirstChat(opts: { account: string | null; useCases: readonly string[]; courses: readonly string[]; pendingPath?: boolean }): FirstChatHandoff {
  const h: FirstChatHandoff = {
    v: 1,
    account: opts.account,
    starters: startersFor(opts.useCases),
    pendingPath: opts.pendingPath ?? true,
    courses: [...opts.courses],
    useCases: [...opts.useCases],
    at: Date.now(),
    sentAt: null,
  };
  writeFirstChat(h);
  return h;
}

export function markFirstChatSent(): void {
  const h = readFirstChat();
  if (h && !h.sentAt) writeFirstChat({ ...h, sentAt: Date.now() });
}

/**
 * First reply arrived: drop the hand-off and start the learning path (built
 * now if onboarding hadn't reached Finish yet). Returns true when a lesson started.
 */
export async function completeFirstChat(): Promise<boolean> {
  const h = readFirstChat();
  if (!h?.sentAt) return false;
  writeFirstChat(null);
  try {
    localStorage.setItem(DONE_KEY, "1");
  } catch {
    /* storage blocked */
  }
  if (!h.pendingPath) return false;
  const [{ currentPath, createPath, startPath }, { loadGuidedCatalog }] = await Promise.all([
    import("../../learn/guided/learning-path"),
    import("../../learn/guided/catalog-store"),
  ]);
  try {
    await loadGuidedCatalog();
    if (!currentPath()) await createPath(h.courses, h.useCases);
    return await startPath();
  } catch {
    return false;
  }
}

/** ?firstChatDemo=1 on /webchat: show the welcome with sample starters, nothing stored. */
export function firstChatDemo(search: string = typeof location === "undefined" ? "" : location.search): FirstChatHandoff | null {
  try {
    if (new URLSearchParams(search).get("firstChatDemo") !== "1") return null;
  } catch {
    return null;
  }
  return { v: 1, account: "ChatGPT", starters: startersFor(["business", "content"]), pendingPath: false, courses: [], useCases: [], at: Date.now(), sentAt: null };
}
