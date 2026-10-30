/**
 * AI Insights Engine for Social Analytics
 * Uses FREE APIs only: Ollama (local) + Brave Search
 */

import { getSocialAnalyticsStore, type PostMetric } from "./analytics-store.js";
import { resolve } from "node:path";
import { loadConfig } from "../config/config.js";
import { localProvidersEnabled } from "../saas/config.js";

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export interface NicheDetection {
  niches: Array<{
    name: string;
    confidence: number;
    keywords: string[];
  }>;
  primaryNiche: string;
  analyzedPosts: number;
}

export interface ContentRecommendation {
  bestPostingTimes: Array<{
    day: string;
    hour: number;
    engagementScore: number;
  }>;
  formatSuggestions: Array<{
    format: "IMAGE" | "VIDEO" | "CAROUSEL_ALBUM" | "REELS";
    avgEngagement: number;
    postCount: number;
    recommendation: string;
  }>;
  contentTips: string[];
  hashtagSuggestions: string[];
}

export interface CompetitorProfile {
  username: string;
  url: string;
  description: string;
  estimatedFollowers?: string;
  niche: string;
  source: string;
}

export interface CompetitorDiscovery {
  competitors: CompetitorProfile[];
  searchQuery: string;
  niche: string;
}

export interface EngagementInsight {
  overallTrend: "growing" | "stable" | "declining";
  engagementRate: number;
  avgLikes: number;
  avgComments: number;
  viralPosts: PostMetric[];
  patterns: string[];
  improvements: string[];
}

export interface FullAnalysis {
  niche: NicheDetection;
  recommendations: ContentRecommendation;
  competitors: CompetitorDiscovery;
  engagement: EngagementInsight;
  generatedAt: number;
}

// ═══════════════════════════════════════════════════════════════
// OLLAMA CLIENT
// ═══════════════════════════════════════════════════════════════

const DEFAULT_MODEL = "qwen3:32b";

function getOllamaBaseUrl(): string {
  const configured = loadConfig()?.integrations?.ollama?.host;
  return process.env.OLLAMA_HOST || configured || "http://127.0.0.1:11434";
}

interface OllamaResponse {
  model: string;
  response: string;
  done: boolean;
}

/**
 * One completion for the insight passes: local Ollama where local providers
 * are allowed, otherwise (InfiniBot Cloud, or Ollama unreachable) the
 * workspace's default model with its own provider key.
 */
async function ollamaGenerate(prompt: string, model = DEFAULT_MODEL): Promise<string> {
  if (localProvidersEnabled()) {
    try {
      return await ollamaGenerateLocal(prompt, model);
    } catch (err) {
      const viaDefault = await defaultModelGenerate(prompt).catch(() => null);
      if (viaDefault !== null) return viaDefault;
      throw err;
    }
  }
  return defaultModelGenerate(prompt);
}

async function defaultModelGenerate(prompt: string): Promise<string> {
  const { runLLM } = await import("../services/email/llm-analysis.js");
  const out = await runLLM({
    systemPrompt:
      "You are a social media analytics assistant. Follow the output format in the request exactly.",
    userPrompt: prompt,
    maxTokens: 2048,
    temperature: 0.7,
  });
  return out.text.trim();
}

async function ollamaGenerateLocal(prompt: string, model = DEFAULT_MODEL): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000); // 2 min timeout

  try {
    const response = await fetch(`${getOllamaBaseUrl()}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: {
          temperature: 0.7,
          num_predict: 2048,
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Ollama error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as OllamaResponse;
    return data.response.trim();
  } finally {
    clearTimeout(timeout);
  }
}

async function ollamaChat(
  messages: Array<{ role: string; content: string }>,
  model = DEFAULT_MODEL,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);

  try {
    const response = await fetch(`${getOllamaBaseUrl()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        options: {
          temperature: 0.7,
          num_predict: 2048,
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Ollama chat error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { message: { content: string } };
    return data.message.content.trim();
  } finally {
    clearTimeout(timeout);
  }
}

// ═══════════════════════════════════════════════════════════════
// BRAVE SEARCH
// ═══════════════════════════════════════════════════════════════

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

interface BraveSearchResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveSearchResult[];
  };
}

async function braveSearch(query: string, count = 10): Promise<BraveSearchResult[]> {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) {
    console.warn("[ai-insights] No BRAVE_API_KEY configured, skipping competitor search");
    return [];
  }

  const url = new URL(BRAVE_SEARCH_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey,
    },
  });

  if (!response.ok) {
    throw new Error(`Brave Search error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as BraveSearchResponse;
  return data.web?.results ?? [];
}

// ═══════════════════════════════════════════════════════════════
// NICHE DETECTION
// ═══════════════════════════════════════════════════════════════

function extractHashtags(text: string): string[] {
  const matches = text.match(/#[a-zA-Z0-9_]+/g) || [];
  return matches.map((h) => h.toLowerCase());
}

function extractKeywords(captions: string[]): string[] {
  // Combine all captions and extract common words
  const allText = captions.join(" ").toLowerCase();
  const words = allText
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .filter((w) => !w.startsWith("#"))
    .filter((w) => !w.startsWith("@"))
    .filter((w) => !w.startsWith("http"));

  // Count frequency
  const freq = new Map<string, number>();
  for (const word of words) {
    const clean = word.replace(/[^a-zA-Z0-9]/g, "");
    if (clean.length > 3) {
      freq.set(clean, (freq.get(clean) || 0) + 1);
    }
  }

  // Return top 20 most common
  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([word]) => word);
}

export async function detectNiche(
  platform: string,
  accountId: string,
  stateDir: string,
): Promise<NicheDetection> {
  const store = getSocialAnalyticsStore(stateDir);
  const posts = store.getPostMetrics(platform, accountId, 50);

  if (posts.length === 0) {
    return {
      niches: [],
      primaryNiche: "unknown",
      analyzedPosts: 0,
    };
  }

  // Extract content for analysis
  const captions = posts.map((p) => p.caption || "").filter((c) => c.length > 0);
  const allHashtags = captions.flatMap(extractHashtags);
  const keywords = extractKeywords(captions);

  // Build prompt for Ollama
  const hashtagSample = [...new Set(allHashtags)].slice(0, 30).join(", ");
  const keywordSample = keywords.slice(0, 15).join(", ");
  const captionSamples = captions
    .slice(0, 5)
    .map((c) => c.slice(0, 200))
    .join("\n---\n");

  const prompt = `Analyze these Instagram post characteristics and identify the top 3 content niches.

HASHTAGS USED:
${hashtagSample}

COMMON KEYWORDS:
${keywordSample}

SAMPLE CAPTIONS:
${captionSamples}

Return ONLY a JSON object in this exact format (no other text):
{
  "niches": [
    {"name": "niche1", "confidence": 0.9, "keywords": ["keyword1", "keyword2"]},
    {"name": "niche2", "confidence": 0.7, "keywords": ["keyword3", "keyword4"]},
    {"name": "niche3", "confidence": 0.5, "keywords": ["keyword5", "keyword6"]}
  ]
}

Common niches: AI/Tech, Crypto/Web3, Fitness, Lifestyle, Fashion, Travel, Food, Business/Entrepreneurship, Motivation, Gaming, Music, Art, Photography, Education, Comedy, Beauty

Return exactly 3 niches with confidence scores between 0 and 1.`;

  try {
    const response = await ollamaGenerate(prompt);

    // Extract JSON from response (handle thinking models that add extra text)
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON found in response");
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      niches: Array<{ name: string; confidence: number; keywords: string[] }>;
    };

    return {
      niches: parsed.niches.slice(0, 3),
      primaryNiche: parsed.niches[0]?.name || "general",
      analyzedPosts: posts.length,
    };
  } catch (error) {
    console.error("[ai-insights] Niche detection error:", error);

    // Fallback: basic keyword-based detection
    const fallbackNiches = inferNicheFromHashtags(allHashtags);
    return {
      niches: fallbackNiches,
      primaryNiche: fallbackNiches[0]?.name || "general",
      analyzedPosts: posts.length,
    };
  }
}

function inferNicheFromHashtags(hashtags: string[]): NicheDetection["niches"] {
  const nicheKeywords: Record<string, string[]> = {
    "AI/Tech": [
      "ai",
      "tech",
      "technology",
      "coding",
      "programming",
      "developer",
      "software",
      "machine learning",
      "ml",
      "gpt",
    ],
    "Crypto/Web3": [
      "crypto",
      "bitcoin",
      "ethereum",
      "nft",
      "web3",
      "blockchain",
      "defi",
      "trading",
    ],
    Fitness: ["fitness", "gym", "workout", "health", "training", "bodybuilding", "gains"],
    Business: ["business", "entrepreneur", "startup", "money", "success", "hustle", "mindset"],
    Lifestyle: ["lifestyle", "life", "daily", "routine", "vibes", "aesthetic"],
    Motivation: ["motivation", "inspire", "success", "grind", "hustle", "goals"],
  };

  const scores = new Map<string, number>();

  for (const hashtag of hashtags) {
    const clean = hashtag.replace("#", "").toLowerCase();
    for (const [niche, keywords] of Object.entries(nicheKeywords)) {
      if (keywords.some((kw) => clean.includes(kw))) {
        scores.set(niche, (scores.get(niche) || 0) + 1);
      }
    }
  }

  const sorted = Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  const total = hashtags.length || 1;

  return sorted.map(([name, count]) => ({
    name,
    confidence: Math.min((count / total) * 2, 0.95),
    keywords: nicheKeywords[name]?.slice(0, 3) || [],
  }));
}

// ═══════════════════════════════════════════════════════════════
// CONTENT RECOMMENDATIONS
// ═══════════════════════════════════════════════════════════════

export async function generateRecommendations(
  platform: string,
  accountId: string,
  stateDir: string,
): Promise<ContentRecommendation> {
  const store = getSocialAnalyticsStore(stateDir);
  const posts = store.getPostMetrics(platform, accountId, 100);
  const topPosts = store.getTopPosts(platform, accountId, "engagement_rate", 10);

  // Analyze posting times
  const bestTimes = analyzePostingTimes(posts);

  // Analyze format performance
  const formatStats = analyzeFormatPerformance(posts);

  // Generate AI-powered tips
  const tips = await generateContentTips(posts, topPosts);

  // Extract successful hashtags
  const hashtagSuggestions = extractSuccessfulHashtags(topPosts);

  return {
    bestPostingTimes: bestTimes,
    formatSuggestions: formatStats,
    contentTips: tips,
    hashtagSuggestions,
  };
}

function analyzePostingTimes(posts: PostMetric[]): ContentRecommendation["bestPostingTimes"] {
  const timeSlots = new Map<string, { total: number; engagement: number }>();

  for (const post of posts) {
    const date = new Date(post.postedAt);
    const day = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][
      date.getDay()
    ];
    const hour = date.getHours();
    const key = `${day}-${hour}`;

    const current = timeSlots.get(key) || { total: 0, engagement: 0 };
    current.total++;
    current.engagement += post.engagementRate || 0;
    timeSlots.set(key, current);
  }

  const results: ContentRecommendation["bestPostingTimes"] = [];

  for (const [key, data] of timeSlots.entries()) {
    const [day, hourStr] = key.split("-");
    const avgEngagement = data.engagement / data.total;

    if (data.total >= 2) {
      // Only include time slots with enough data
      results.push({
        day,
        hour: parseInt(hourStr, 10),
        engagementScore: avgEngagement,
      });
    }
  }

  return results.sort((a, b) => b.engagementScore - a.engagementScore).slice(0, 5);
}

function analyzeFormatPerformance(posts: PostMetric[]): ContentRecommendation["formatSuggestions"] {
  const formatStats = new Map<string, { total: number; engagement: number }>();

  for (const post of posts) {
    const format = post.mediaType;
    const current = formatStats.get(format) || { total: 0, engagement: 0 };
    current.total++;
    current.engagement += post.engagementRate || 0;
    formatStats.set(format, current);
  }

  const results: ContentRecommendation["formatSuggestions"] = [];

  for (const [format, data] of formatStats.entries()) {
    const avgEngagement = data.engagement / data.total;
    let recommendation = "";

    if (format === "REELS" && avgEngagement > 0.05) {
      recommendation = "Reels are performing well! Consider posting more short-form video content.";
    } else if (format === "CAROUSEL_ALBUM" && avgEngagement > 0.04) {
      recommendation =
        "Carousels drive good engagement. Use them for educational or story-based content.";
    } else if (format === "IMAGE" && avgEngagement > 0.03) {
      recommendation =
        "Single images work well. Focus on high-quality visuals with compelling captions.";
    } else if (format === "VIDEO") {
      recommendation =
        "Long-form video has potential. Consider converting top performers to Reels.";
    } else {
      recommendation = "Try experimenting with different content formats.";
    }

    results.push({
      format: format as ContentRecommendation["formatSuggestions"][0]["format"],
      avgEngagement,
      postCount: data.total,
      recommendation,
    });
  }

  return results.sort((a, b) => b.avgEngagement - a.avgEngagement);
}

async function generateContentTips(posts: PostMetric[], topPosts: PostMetric[]): Promise<string[]> {
  if (topPosts.length === 0) {
    return [
      "Post consistently to build engagement patterns",
      "Use relevant hashtags to increase discoverability",
      "Engage with your audience in comments",
      "Test different content formats (Reels, carousels, images)",
    ];
  }

  const topCaptions = topPosts
    .slice(0, 3)
    .map((p) => p.caption || "")
    .filter((c) => c.length > 0);

  if (topCaptions.length === 0) {
    return [
      "Add captions to your posts to increase engagement",
      "Use storytelling to connect with your audience",
      "Include calls-to-action in your captions",
    ];
  }

  const prompt = `Analyze these top-performing Instagram captions and provide 5 actionable content tips:

TOP CAPTIONS:
${topCaptions.map((c, i) => `${i + 1}. ${c.slice(0, 300)}`).join("\n\n")}

Based on these successful posts, provide exactly 5 short, actionable tips for creating better content. Return ONLY a JSON array:
["tip 1", "tip 2", "tip 3", "tip 4", "tip 5"]`;

  try {
    const response = await ollamaGenerate(prompt);
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const tips = JSON.parse(jsonMatch[0]) as string[];
      return tips.slice(0, 5);
    }
  } catch (error) {
    console.error("[ai-insights] Content tips generation error:", error);
  }

  // Fallback tips
  return [
    "Study your top posts and create similar content",
    "Post during peak engagement hours",
    "Use trending audio for Reels",
    "Engage with comments within the first hour of posting",
    "Create content that encourages saves and shares",
  ];
}

function extractSuccessfulHashtags(topPosts: PostMetric[]): string[] {
  const hashtags = topPosts
    .flatMap((p) => extractHashtags(p.caption || ""))
    .filter((h) => h.length > 2);

  const freq = new Map<string, number>();
  for (const tag of hashtags) {
    freq.set(tag, (freq.get(tag) || 0) + 1);
  }

  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([tag]) => tag);
}

// ═══════════════════════════════════════════════════════════════
// COMPETITOR DISCOVERY
// ═══════════════════════════════════════════════════════════════

export async function discoverCompetitors(
  niche: string,
  platform: string = "instagram",
): Promise<CompetitorDiscovery> {
  const searchQuery = `${niche} ${platform} influencer`;

  try {
    const results = await braveSearch(searchQuery, 15);

    const competitors: CompetitorProfile[] = [];

    for (const result of results) {
      // Filter for Instagram profiles
      if (!result.url || !result.title) continue;

      const isInstagram = result.url.includes("instagram.com");
      const isSocialBlade = result.url.includes("socialblade.com");
      const isInfluencerList =
        result.title.toLowerCase().includes("influencer") ||
        result.title.toLowerCase().includes("creator") ||
        result.title.toLowerCase().includes("account");

      if (isInstagram) {
        // Direct Instagram profile
        const usernameMatch = result.url.match(/instagram\.com\/([a-zA-Z0-9_.]+)/);
        if (usernameMatch && usernameMatch[1] !== "p" && usernameMatch[1] !== "reel") {
          competitors.push({
            username: `@${usernameMatch[1]}`,
            url: result.url,
            description: result.description || "",
            niche,
            source: "instagram_direct",
          });
        }
      } else if (isSocialBlade || isInfluencerList) {
        // Influencer list or analytics site - extract mentions
        const mentions = extractInstagramMentions(result.description || "");
        for (const mention of mentions.slice(0, 2)) {
          competitors.push({
            username: mention,
            url: `https://instagram.com/${mention.replace("@", "")}`,
            description: result.title || "",
            niche,
            source: "influencer_list",
          });
        }
      }

      // Stop if we have enough
      if (competitors.length >= 5) break;
    }

    // Remove duplicates
    const seen = new Set<string>();
    const unique = competitors.filter((c) => {
      const key = c.username.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return {
      competitors: unique.slice(0, 5),
      searchQuery,
      niche,
    };
  } catch (error) {
    console.error("[ai-insights] Competitor discovery error:", error);
    return {
      competitors: [],
      searchQuery,
      niche,
    };
  }
}

function extractInstagramMentions(text: string): string[] {
  const matches = text.match(/@[a-zA-Z0-9_.]+/g) || [];
  return [...new Set(matches)];
}

// ═══════════════════════════════════════════════════════════════
// ENGAGEMENT INSIGHTS
// ═══════════════════════════════════════════════════════════════

export async function analyzeEngagement(
  platform: string,
  accountId: string,
  stateDir: string,
): Promise<EngagementInsight> {
  const store = getSocialAnalyticsStore(stateDir);
  const posts = store.getPostMetrics(platform, accountId, 100);
  const growth = store.getFollowerGrowth(platform, accountId, 30);
  const topPosts = store.getTopPosts(platform, accountId, "engagement_rate", 5);

  if (posts.length === 0) {
    return {
      overallTrend: "stable",
      engagementRate: 0,
      avgLikes: 0,
      avgComments: 0,
      viralPosts: [],
      patterns: [],
      improvements: ["Start posting content to generate engagement data"],
    };
  }

  // Calculate averages
  const totalLikes = posts.reduce((sum, p) => sum + p.likes, 0);
  const totalComments = posts.reduce((sum, p) => sum + p.comments, 0);
  const totalEngagement = posts.reduce((sum, p) => sum + (p.engagementRate || 0), 0);

  const avgLikes = totalLikes / posts.length;
  const avgComments = totalComments / posts.length;
  const engagementRate = totalEngagement / posts.length;

  // Determine trend
  const recentPosts = posts.slice(0, 10);
  const olderPosts = posts.slice(10, 20);

  let overallTrend: EngagementInsight["overallTrend"] = "stable";
  if (recentPosts.length > 0 && olderPosts.length > 0) {
    const recentAvg =
      recentPosts.reduce((sum, p) => sum + (p.engagementRate || 0), 0) / recentPosts.length;
    const olderAvg =
      olderPosts.reduce((sum, p) => sum + (p.engagementRate || 0), 0) / olderPosts.length;

    if (recentAvg > olderAvg * 1.15) {
      overallTrend = "growing";
    } else if (recentAvg < olderAvg * 0.85) {
      overallTrend = "declining";
    }
  }

  // Identify viral posts (2x average engagement)
  const viralThreshold = engagementRate * 2;
  const viralPosts = posts.filter((p) => (p.engagementRate || 0) > viralThreshold).slice(0, 5);

  // Identify patterns and generate improvements
  const patterns = identifyEngagementPatterns(posts, topPosts);
  const improvements = await generateImprovements(posts, topPosts, engagementRate);

  return {
    overallTrend,
    engagementRate,
    avgLikes,
    avgComments,
    viralPosts,
    patterns,
    improvements,
  };
}

function identifyEngagementPatterns(posts: PostMetric[], topPosts: PostMetric[]): string[] {
  const patterns: string[] = [];

  // Check format patterns
  const formatEngagement = new Map<string, number[]>();
  for (const post of posts) {
    const rates = formatEngagement.get(post.mediaType) || [];
    rates.push(post.engagementRate || 0);
    formatEngagement.set(post.mediaType, rates);
  }

  let bestFormat = "";
  let bestAvg = 0;
  for (const [format, rates] of formatEngagement.entries()) {
    const avg = rates.reduce((a, b) => a + b, 0) / rates.length;
    if (avg > bestAvg) {
      bestAvg = avg;
      bestFormat = format;
    }
  }

  if (bestFormat) {
    patterns.push(
      `${bestFormat} content performs best with ${(bestAvg * 100).toFixed(2)}% avg engagement`,
    );
  }

  // Check caption length patterns
  const shortCaptions = posts.filter((p) => (p.caption?.length || 0) < 100);
  const longCaptions = posts.filter((p) => (p.caption?.length || 0) >= 100);

  if (shortCaptions.length > 5 && longCaptions.length > 5) {
    const shortAvg =
      shortCaptions.reduce((sum, p) => sum + (p.engagementRate || 0), 0) / shortCaptions.length;
    const longAvg =
      longCaptions.reduce((sum, p) => sum + (p.engagementRate || 0), 0) / longCaptions.length;

    if (longAvg > shortAvg * 1.2) {
      patterns.push("Longer captions tend to drive higher engagement");
    } else if (shortAvg > longAvg * 1.2) {
      patterns.push("Shorter, punchy captions perform better");
    }
  }

  // Check hashtag patterns
  const withHashtags = posts.filter((p) => (p.caption || "").includes("#"));
  const withoutHashtags = posts.filter((p) => !(p.caption || "").includes("#"));

  if (withHashtags.length > 3 && withoutHashtags.length > 3) {
    const withAvg =
      withHashtags.reduce((sum, p) => sum + (p.engagementRate || 0), 0) / withHashtags.length;
    const withoutAvg =
      withoutHashtags.reduce((sum, p) => sum + (p.engagementRate || 0), 0) / withoutHashtags.length;

    if (withAvg > withoutAvg * 1.15) {
      patterns.push("Posts with hashtags get more engagement");
    }
  }

  return patterns;
}

async function generateImprovements(
  posts: PostMetric[],
  topPosts: PostMetric[],
  avgEngagement: number,
): Promise<string[]> {
  // Rule-based improvements (fast, no AI needed)
  const improvements: string[] = [];

  // Check posting frequency
  if (posts.length < 10) {
    improvements.push("Increase posting frequency to gather more engagement data");
  }

  // Check format diversity
  const formats = new Set(posts.map((p) => p.mediaType));
  if (formats.size < 3) {
    improvements.push(
      "Try different content formats (Reels, carousels, images) to find what works best",
    );
  }

  // Check if Reels are being used
  const reelsCount = posts.filter((p) => p.mediaType === "REELS").length;
  if (reelsCount === 0) {
    improvements.push("Start posting Reels - they typically have higher reach and engagement");
  } else if (reelsCount / posts.length < 0.3) {
    improvements.push("Consider increasing Reels content - they often outperform static posts");
  }

  // Check engagement rate benchmarks
  if (avgEngagement < 0.01) {
    improvements.push(
      "Focus on creating more engaging content - aim for at least 1% engagement rate",
    );
  } else if (avgEngagement < 0.03) {
    improvements.push(
      "Engagement is below average. Try asking questions or using CTAs in captions",
    );
  } else if (avgEngagement > 0.05) {
    improvements.push("Great engagement! Focus on growth - collaborate with similar creators");
  }

  // Check captions
  const emptyCaptions = posts.filter((p) => !p.caption || p.caption.length < 20).length;
  if (emptyCaptions > posts.length * 0.3) {
    improvements.push("Add compelling captions to your posts - they drive comments and saves");
  }

  return improvements.slice(0, 5);
}

// ═══════════════════════════════════════════════════════════════
// FULL ANALYSIS
// ═══════════════════════════════════════════════════════════════

export async function runFullAnalysis(
  platform: string,
  accountId: string,
  stateDir: string,
): Promise<FullAnalysis> {
  // Run all analyses in parallel where possible
  const [niche, recommendations, engagement] = await Promise.all([
    detectNiche(platform, accountId, stateDir),
    generateRecommendations(platform, accountId, stateDir),
    analyzeEngagement(platform, accountId, stateDir),
  ]);

  // Competitor discovery needs the niche result
  const competitors = await discoverCompetitors(niche.primaryNiche, platform);

  return {
    niche,
    recommendations,
    competitors,
    engagement,
    generatedAt: Date.now(),
  };
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

export function getStateDir(): string {
  return resolve(process.env.INFINIBOT_STATE_DIR || "state");
}

// Default export for module
export const AIInsights = {
  detectNiche,
  generateRecommendations,
  discoverCompetitors,
  analyzeEngagement,
  runFullAnalysis,
};
