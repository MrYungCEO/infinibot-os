/**
 * Storyboard Script Generator — LLM-powered script generation
 */

import type { ScriptGenOptions, ScriptGenResult, Platform } from "./types.js";

// ═══════════════════════════════════════════════════════════════
// SCRIPT GENERATION
// ═══════════════════════════════════════════════════════════════

/**
 * Try providers in the same order the gateway prefers — Anthropic first
 * (the gateway's default for Claude/Coder agents), Gemini second,
 * OpenRouter last. Auto-falls through on rate-limit (429) or server (5xx)
 * errors so a single exhausted free-tier doesn't block the workflow.
 */
export async function generateScript(options: ScriptGenOptions): Promise<ScriptGenResult> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;

  const errors: string[] = [];

  if (anthropicKey) {
    const r = await generateScriptWithAnthropic(options, anthropicKey);
    if (r.success) return r;
    errors.push(`Anthropic: ${r.error}`);
    if (!isRetryableProviderError(r.error)) return r;
  }

  if (geminiKey) {
    const r = await generateScriptWithGemini(options, geminiKey);
    if (r.success) return r;
    errors.push(`Gemini: ${r.error}`);
    if (!isRetryableProviderError(r.error)) return r;
  }

  if (openrouterKey) {
    const r = await generateScriptWithOpenRouter(options, openrouterKey);
    if (r.success) return r;
    errors.push(`OpenRouter: ${r.error}`);
    return r;
  }

  if (errors.length === 0) {
    // No script-specific env key: use the workspace's default model with its
    // own provider key (Settings › API keys). This is the path on InfiniBot
    // Cloud, where provider keys live in the workspace, not the environment.
    return generateScriptWithDefaultModel(options);
  }
  return { success: false, error: `All providers failed — ${errors.join(" | ")}` };
}

/** Treat rate-limits and 5xx as fall-through-able; quota-exhausted Gemini falls through to Anthropic/OpenRouter. */
function isRetryableProviderError(err: string | undefined): boolean {
  if (!err) return false;
  const s = err.toLowerCase();
  return (
    s.includes("429") ||
    s.includes("rate") ||
    s.includes("quota") ||
    s.includes("resource_exhausted") ||
    s.includes("overloaded") ||
    s.includes(" 500 ") ||
    s.includes(" 502 ") ||
    s.includes(" 503 ") ||
    s.includes(" 504 ")
  );
}

async function generateScriptWithDefaultModel(options: ScriptGenOptions): Promise<ScriptGenResult> {
  try {
    const { runLLM } = await import("../services/email/llm-analysis.js");
    const out = await runLLM({
      systemPrompt: buildSystemPrompt(options),
      userPrompt: buildUserPrompt(options),
      maxTokens: 8000,
      temperature: 0.7,
    });
    const script = out.text;
    if (!script.trim())
      return { success: false, error: "The default model returned an empty script" };
    return { success: true, script, estimatedDuration: estimateScriptDuration(script) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `No LLM provider configured for scripts (${msg}). Add a provider key under Settings › API keys, or set ANTHROPIC_API_KEY, GEMINI_API_KEY or OPENROUTER_API_KEY.`,
    };
  }
}

async function generateScriptWithGemini(
  options: ScriptGenOptions,
  apiKey: string,
): Promise<ScriptGenResult> {
  try {
    const systemPrompt = buildSystemPrompt(options);
    const userPrompt = buildUserPrompt(options);

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }],
            },
          ],
          generationConfig: {
            temperature: 0.8,
            maxOutputTokens: 8000,
          },
        }),
      },
    );

    if (!response.ok) {
      const errText = await response.text();
      return { success: false, error: `Gemini API error: ${response.status} - ${errText}` };
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      return { success: false, error: "No text in Gemini response" };
    }

    return {
      success: true,
      script: text,
      estimatedDuration: estimateScriptDuration(text),
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * OpenRouter — proxies to many providers behind a single API. Useful as a
 * last-resort fallback when the user has exhausted other free tiers; the
 * model picked here is a free-by-default Llama, override with
 * OPENROUTER_SCRIPT_MODEL if you want something stronger.
 */
async function generateScriptWithOpenRouter(
  options: ScriptGenOptions,
  apiKey: string,
): Promise<ScriptGenResult> {
  try {
    const model = process.env.OPENROUTER_SCRIPT_MODEL || "meta-llama/llama-3.1-70b-instruct";
    const systemPrompt = buildSystemPrompt(options);
    const userPrompt = buildUserPrompt(options);

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "InfiniBot Storyboard",
      },
      body: JSON.stringify({
        model,
        max_tokens: 8000,
        temperature: 0.8,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return { success: false, error: `OpenRouter API error: ${response.status} - ${errText}` };
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text || typeof text !== "string") {
      return { success: false, error: "No text in OpenRouter response" };
    }
    return { success: true, script: text, estimatedDuration: estimateScriptDuration(text) };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function generateScriptWithAnthropic(
  options: ScriptGenOptions,
  apiKey: string,
): Promise<ScriptGenResult> {
  try {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic({ apiKey });
    // Default to Sonnet 4.6 (current GA), override with ANTHROPIC_SCRIPT_MODEL.
    const model = process.env.ANTHROPIC_SCRIPT_MODEL || "claude-sonnet-4-6";

    const systemPrompt = buildSystemPrompt(options);
    const userPrompt = buildUserPrompt(options);

    const response = await client.messages.create({
      model,
      max_tokens: 8000,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    const content = response.content[0];
    if (content.type !== "text") {
      return { success: false, error: "Unexpected response type" };
    }

    const script = content.text;
    return { success: true, script, estimatedDuration: estimateScriptDuration(script) };
  } catch (err) {
    // Surface status code so isRetryableProviderError() can spot 429/5xx
    // and fall through to the next provider instead of giving up.
    const status =
      (err as { status?: number; statusCode?: number }).status ??
      (err as { statusCode?: number }).statusCode;
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: status ? `${status} - ${msg}` : msg };
  }
}

function buildSystemPrompt(options: ScriptGenOptions): string {
  const platformName = getPlatformName(options.platform);
  const durationMin = options.targetDuration;
  const wordsPerMinute = 150; // Average speaking rate
  const targetWords = Math.round(durationMin * wordsPerMinute);
  const isShortForm =
    options.platform === "tiktok" ||
    options.platform === "shorts" ||
    options.platform === "instagram";

  const exemplars = (options.exemplars || []).slice(0, 3);
  const exemplarBlock = exemplars.length
    ? `

STYLE EXEMPLARS — these are real viral videos. Match their HOOK CADENCE, sentence length, and structural beats. Do NOT copy their words.
${exemplars
  .map(
    (ex, i) =>
      `\n#${i + 1} "${ex.title}" (${ex.platform})\n  HOOK: ${ex.hook}\n  TRANSCRIPT EXCERPT: ${ex.excerpt}${
        ex.structureNotes ? `\n  STRUCTURE: ${ex.structureNotes}` : ""
      }`,
  )
  .join("\n")}

When you write the script, the first scene's VOICEOVER must use the same hook PATTERN as one of the exemplars above (bold claim, contrarian framing, open loop, or pointed question) — not the same words.`
    : "";

  const hookRules = isShortForm
    ? `- HOOK rule (CRITICAL): scene 1's VOICEOVER must hook the viewer in the FIRST 7 WORDS — bold claim, contrarian statement, open loop, or pointed question. No "In today's video", no "Hey guys", no "Let's talk about". Mention a concrete number, name, or specific detail by word 12.`
    : `- HOOK rule: scene 1's VOICEOVER opens with a bold claim, contrarian statement, or pointed question — no "In today's video", no "Welcome back". Establish stakes within the first 25 words.`;

  return `You are a senior short-form video scriptwriter who has shipped viral ${platformName} content. You write the way top-performing creators write: pattern-interrupt hooks, payoff every 5–7 seconds, no filler.

Your task is to write a complete video script that:
- Is approximately ${durationMin} minute(s) long (~${targetWords} words)
- Is structured with clear scene breaks for visual storytelling
- ${options.includeVoiceover ? "Includes voiceover narration" : "Has minimal narration, relies on visuals"}
- Matches the tone: ${options.tone || "engaging and direct"}
- Follows the style: ${options.style || "educational with story"}

HARD RULES:
${hookRules}
- Every scene must earn its place. If a scene doesn't deliver a payoff, a reveal, or a specific detail, cut it.
- BANNED phrases (never use): "In today's video", "Let's dive in", "Hey guys", "Welcome back", "Make sure to like and subscribe" (unless explicitly in a CTA scene), "Without further ado", "At the end of the day", "It is what it is".
- Prefer concrete > abstract: use a name, a number, a place, or a sensory detail in every scene's VOICEOVER.
- Each VOICEOVER line must be speakable in one breath (≤ 18 words per sentence).
- End the script with a clear PAYOFF or CTA scene — never trail off.${exemplarBlock}

FORMAT YOUR SCRIPT AS:
Each scene should be formatted as:

[SCENE X: Title]
VISUAL: Description of what appears on screen
${options.includeVoiceover ? "VOICEOVER: Narration text" : ""}
DURATION: Estimated seconds

Keep scenes visually distinct and interesting. Each scene should be a self-contained visual moment that can be rendered as a single image.`;
}

function buildUserPrompt(options: ScriptGenOptions): string {
  return `Write a complete video script about:

${options.prompt}

Target duration: ${options.targetDuration} minute(s)
Platform: ${getPlatformName(options.platform)}
${options.style ? `Style: ${options.style}` : ""}
${options.tone ? `Tone: ${options.tone}` : ""}

Write the full script now with scene-by-scene breakdown. Remember: the FIRST seven words of scene 1 decide whether anyone watches the rest. Make them count.`;
}

function getPlatformName(platform: Platform): string {
  const names: Record<Platform, string> = {
    youtube: "YouTube",
    tiktok: "TikTok",
    shorts: "YouTube Shorts",
    instagram: "Instagram Reels",
    custom: "Video",
  };
  return names[platform] || "Video";
}

function estimateScriptDuration(script: string): number {
  // Estimate based on word count
  const words = script.split(/\s+/).length;
  const wordsPerMinute = 150;
  return Math.round((words / wordsPerMinute) * 10) / 10; // Round to 1 decimal
}

// ═══════════════════════════════════════════════════════════════
// SCRIPT PARSING
// ═══════════════════════════════════════════════════════════════

export interface ParsedScene {
  index: number;
  title: string;
  visual: string;
  voiceover?: string;
  duration?: number;
}

export function parseScript(script: string): ParsedScene[] {
  const scenes: ParsedScene[] = [];

  // Match [SCENE X: Title] blocks
  const sceneRegex = /\[SCENE\s*(\d+)[:\s]*([^\]]*)\]/gi;
  const matches = [...script.matchAll(sceneRegex)];

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const nextMatch = matches[i + 1];

    const sceneIndex = parseInt(match[1], 10);
    const title = match[2]?.trim() || `Scene ${sceneIndex}`;

    // Extract content between this scene header and the next
    const startIdx = match.index! + match[0].length;
    const endIdx = nextMatch ? nextMatch.index! : script.length;
    const content = script.slice(startIdx, endIdx);

    // Parse VISUAL
    const visualMatch = content.match(/VISUAL:\s*([^\n]+(?:\n(?!VOICEOVER:|DURATION:)[^\n]+)*)/i);
    const visual = visualMatch ? visualMatch[1].trim() : content.trim().slice(0, 200);

    // Parse VOICEOVER
    const voiceoverMatch = content.match(
      /VOICEOVER:\s*([^\n]+(?:\n(?!VISUAL:|DURATION:)[^\n]+)*)/i,
    );
    const voiceover = voiceoverMatch ? voiceoverMatch[1].trim() : undefined;

    // Parse DURATION
    const durationMatch = content.match(/DURATION:\s*(\d+)\s*(?:seconds?|s)?/i);
    const duration = durationMatch ? parseInt(durationMatch[1], 10) : undefined;

    scenes.push({
      index: sceneIndex,
      title,
      visual,
      voiceover,
      duration,
    });
  }

  // If no scenes found with the expected format, try to split by paragraphs
  if (scenes.length === 0) {
    const paragraphs = script.split(/\n\n+/).filter((p) => p.trim().length > 20);
    paragraphs.forEach((p, i) => {
      scenes.push({
        index: i + 1,
        title: `Scene ${i + 1}`,
        visual: p.trim().slice(0, 300),
        duration: 5,
      });
    });
  }

  return scenes;
}
