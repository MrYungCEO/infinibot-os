/**
 * Niche taxonomy — a standardized, typed model of content niches and their
 * subniches, plus a generic niche-detection routine.
 *
 * The taxonomy is the spine of the viral-formats subsystem: every watched item
 * and every reel we score is classified into a (niche, subniche) so that
 * benchmarks and top-format discovery are computed *relative to the right
 * competitive set* rather than against one global scale.
 *
 * Currently the AI niche is fully fleshed out (the operator's home turf), but
 * the structure and the `detectNiche()` routine are deliberately generic: add
 * another `NicheDescriptor` to `NICHE_TAXONOMY` and detection generalizes to it
 * with no code changes.
 */

export type NicheId = string;

/** A leaf classification inside a top-level niche. */
export interface SubnicheDescriptor {
  /** Stable kebab-case id, unique within its niche. */
  id: string;
  /** Human label for UI. */
  label: string;
  /** One-line description of what this subniche covers. */
  description: string;
  /**
   * Lexical signals. Detection scores an item by how many of these appear in
   * its transcript/caption/topic. Keep them lowercase; multi-word phrases are
   * matched as substrings, single words as whole-word tokens.
   */
  keywords: string[];
  /** Representative creator handles (no leading @). Used as strong signals. */
  exampleAccounts: string[];
  /** Representative hashtags (no leading #, lowercase). */
  hashtags: string[];
}

/** A top-level niche containing subniches. */
export interface NicheDescriptor {
  id: NicheId;
  label: string;
  description: string;
  /** Niche-wide signals that apply regardless of subniche. */
  keywords: string[];
  subniches: SubnicheDescriptor[];
}

/** Result of classifying an item into the taxonomy. */
export interface NicheDetection {
  niche: NicheId;
  subniche: string | null;
  /** 0..1 normalized confidence in the niche pick. */
  confidence: number;
  /** 0..1 normalized confidence in the subniche pick. */
  subnicheConfidence: number;
  /** Raw per-niche scores for transparency / debugging. */
  nicheScores: Record<NicheId, number>;
  /** Raw per-subniche scores within the winning niche. */
  subnicheScores: Record<string, number>;
}

/** Free-text-ish input to classify. All fields optional; more is better. */
export interface NicheDetectionInput {
  transcript?: string | null;
  caption?: string | null;
  topic?: string | null;
  account?: string | null;
  hashtags?: string[] | null;
}

/**
 * The standardized taxonomy. AI is fully populated; the shape generalizes —
 * append new `NicheDescriptor`s here and everything downstream (detection,
 * benchmarks, format discovery) works without further changes.
 */
export const NICHE_TAXONOMY: NicheDescriptor[] = [
  {
    id: "ai",
    label: "AI",
    description: "Artificial intelligence — tools, news, agents, art, coding, and prompting.",
    keywords: [
      "ai",
      "artificial intelligence",
      "machine learning",
      "neural",
      "llm",
      "gpt",
      "model",
      "openai",
      "anthropic",
      "claude",
      "gemini",
      "automation",
    ],
    subniches: [
      {
        id: "ai-tools",
        label: "AI Tools",
        description: "Round-ups, demos, and reviews of AI apps and SaaS tools.",
        keywords: [
          "tool",
          "app",
          "saas",
          "free tool",
          "this tool",
          "5 tools",
          "best ai tools",
          "try this",
          "workflow",
          "no code",
        ],
        exampleAccounts: ["riley.brown.ai", "heyriley", "futuretools", "theresanaiforthat"],
        hashtags: ["aitools", "aiapps", "futuretools", "aiproductivity"],
      },
      {
        id: "ai-news",
        label: "AI News",
        description: "Breaking model releases, research drops, and industry moves.",
        keywords: [
          "breaking",
          "just launched",
          "announced",
          "release",
          "new model",
          "today",
          "this week in ai",
          "update",
          "rumor",
          "leaked",
        ],
        exampleAccounts: ["rowancheung", "theaigrid", "bensbites"],
        hashtags: ["ainews", "ai", "technews", "airelease"],
      },
      {
        id: "ai-agents-automation",
        label: "AI Agents & Automation",
        description: "Autonomous agents, multi-agent systems, and workflow automation.",
        keywords: [
          "agent",
          "agents",
          "autonomous",
          "automation",
          "automate",
          "workflow",
          "n8n",
          "make.com",
          "zapier",
          "mcp",
          "tool calling",
          "orchestration",
        ],
        exampleAccounts: ["nicolaiu", "aiadvantage", "liamottley"],
        hashtags: ["aiagents", "automation", "n8n", "aiautomation", "agenticai"],
      },
      {
        id: "ai-art",
        label: "AI Art & Media",
        description: "Image, video, and audio generation (Midjourney, Sora, Veo, etc.).",
        keywords: [
          "midjourney",
          "image",
          "art",
          "generate",
          "render",
          "sora",
          "veo",
          "runway",
          "video generation",
          "stable diffusion",
          "prompt to image",
          "cinematic",
        ],
        exampleAccounts: ["nickfloats", "heyglif", "pierrick.chevallier"],
        hashtags: ["aiart", "midjourney", "aivideo", "generativeart", "sora"],
      },
      {
        id: "ai-coding",
        label: "AI Coding",
        description: "AI-assisted software development and vibe-coding workflows.",
        keywords: [
          "code",
          "coding",
          "cursor",
          "copilot",
          "claude code",
          "vibe coding",
          "build an app",
          "developer",
          "programming",
          "ship",
          "deploy",
          "repo",
        ],
        exampleAccounts: ["mckaywrigley", "theo", "cursor_ai"],
        hashtags: ["aicoding", "cursor", "vibecoding", "buildinpublic", "devtools"],
      },
      {
        id: "prompt-engineering",
        label: "Prompt Engineering",
        description: "Prompts, prompt frameworks, and getting more out of models.",
        keywords: [
          "prompt",
          "prompts",
          "prompting",
          "copy this prompt",
          "system prompt",
          "framework",
          "chatgpt prompt",
          "mega prompt",
          "steal this prompt",
        ],
        exampleAccounts: ["godofprompt", "prompthero"],
        hashtags: ["prompts", "promptengineering", "chatgptprompts", "aiprompts"],
      },
      {
        id: "ai-business",
        label: "AI Business & Money",
        description: "Making money with AI — agencies, products, and side hustles.",
        keywords: [
          "money",
          "business",
          "client",
          "agency",
          "side hustle",
          "passive income",
          "monetize",
          "revenue",
          "sell",
          "saas business",
          "make money with ai",
        ],
        exampleAccounts: ["liamottley", "thejasonwest", "aiandrew"],
        hashtags: ["aibusiness", "makemoneywithai", "aiagency", "aisidehustle"],
      },
      {
        id: "ai-research",
        label: "AI Research & Concepts",
        description: "Explainers, paper breakdowns, and conceptual deep-dives.",
        keywords: [
          "paper",
          "research",
          "study",
          "how it works",
          "explained",
          "benchmark",
          "architecture",
          "transformer",
          "training",
          "fine-tune",
          "rag",
          "embedding",
        ],
        exampleAccounts: ["aiexplained", "yannickilcher", "twominutepapers"],
        hashtags: ["aiexplained", "airesearch", "deeplearning", "machinelearning"],
      },
    ],
  },
];

/** Index for O(1) lookups by niche id. */
const NICHE_BY_ID = new Map<NicheId, NicheDescriptor>(NICHE_TAXONOMY.map((n) => [n.id, n]));

export function getNiche(id: NicheId): NicheDescriptor | undefined {
  return NICHE_BY_ID.get(id);
}

export function listNiches(): NicheDescriptor[] {
  return NICHE_TAXONOMY;
}

export function getSubniche(nicheId: NicheId, subnicheId: string): SubnicheDescriptor | undefined {
  return getNiche(nicheId)?.subniches.find((s) => s.id === subnicheId);
}

/** Lowercase + collapse whitespace; null-safe. */
function norm(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Count occurrences of a signal in a haystack. Phrases = substring, words = token. */
function signalHits(haystack: string, tokens: Set<string>, signal: string): number {
  const sig = signal.toLowerCase();
  if (sig.includes(" ")) {
    // Phrase: count non-overlapping substring occurrences (capped).
    let count = 0;
    let idx = haystack.indexOf(sig);
    while (idx !== -1 && count < 5) {
      count++;
      idx = haystack.indexOf(sig, idx + sig.length);
    }
    return count;
  }
  return tokens.has(sig) ? 1 : 0;
}

/**
 * Classify an item into the taxonomy using lexical signal scoring.
 *
 * Generic over the whole `NICHE_TAXONOMY` — works for any registered niche, not
 * just AI. Returns `{ niche: "unknown", subniche: null, confidence: 0 }` when
 * nothing scores, so callers can fall back gracefully.
 */
export function detectNiche(input: NicheDetectionInput): NicheDetection {
  const text = [norm(input.transcript), norm(input.caption), norm(input.topic)]
    .filter(Boolean)
    .join(" ");
  const account = norm(input.account);
  const hashtags = (input.hashtags ?? []).map((h) => norm(h).replace(/^#/, ""));
  const tokens = new Set(text.split(/[^a-z0-9]+/).filter(Boolean));
  hashtags.forEach((h) => tokens.add(h));

  const nicheScores: Record<NicheId, number> = {};
  const subnicheScoresByNiche: Record<NicheId, Record<string, number>> = {};

  for (const niche of NICHE_TAXONOMY) {
    let nicheScore = 0;
    for (const kw of niche.keywords) nicheScore += signalHits(text, tokens, kw);

    const subScores: Record<string, number> = {};
    for (const sub of niche.subniches) {
      let s = 0;
      for (const kw of sub.keywords) s += signalHits(text, tokens, kw) * 2; // subniche keywords weigh more
      for (const tag of sub.hashtags) if (hashtags.includes(tag)) s += 3; // explicit hashtag = strong
      for (const acc of sub.exampleAccounts) {
        if (account && (account === acc || account.includes(acc))) s += 5; // known creator = very strong
      }
      subScores[sub.id] = s;
      nicheScore += s; // subniche evidence rolls up into niche evidence
    }
    nicheScores[niche.id] = nicheScore;
    subnicheScoresByNiche[niche.id] = subScores;
  }

  // Pick winning niche.
  let bestNiche: NicheId | null = null;
  let bestNicheScore = 0;
  let totalNiche = 0;
  for (const [id, score] of Object.entries(nicheScores)) {
    totalNiche += score;
    if (score > bestNicheScore) {
      bestNicheScore = score;
      bestNiche = id;
    }
  }

  if (!bestNiche || bestNicheScore === 0) {
    return {
      niche: "unknown",
      subniche: null,
      confidence: 0,
      subnicheConfidence: 0,
      nicheScores,
      subnicheScores: {},
    };
  }

  const subScores = subnicheScoresByNiche[bestNiche];
  let bestSub: string | null = null;
  let bestSubScore = 0;
  let totalSub = 0;
  for (const [id, score] of Object.entries(subScores)) {
    totalSub += score;
    if (score > bestSubScore) {
      bestSubScore = score;
      bestSub = id;
    }
  }

  return {
    niche: bestNiche,
    subniche: bestSubScore > 0 ? bestSub : null,
    confidence: totalNiche > 0 ? bestNicheScore / totalNiche : 0,
    subnicheConfidence: totalSub > 0 ? bestSubScore / totalSub : 0,
    nicheScores,
    subnicheScores: subScores,
  };
}
