/**
 * Storyboard Scene Splitter — Parse script into visual scenes
 */

import type { Scene, SceneSplitOptions, SceneSplitResult, CharacterRef } from "./types.js";
import { parseScript, type ParsedScene } from "./script-generator.js";

// ═══════════════════════════════════════════════════════════════
// SCENE SPLITTING
// ═══════════════════════════════════════════════════════════════

export function splitScriptToScenes(options: SceneSplitOptions): SceneSplitResult {
  try {
    const parsed = parseScript(options.script);

    if (parsed.length === 0) {
      return { success: false, error: "Could not parse any scenes from script" };
    }

    const totalTargetSeconds = options.targetDuration * 60;
    const minDuration = options.minSceneDuration || 3;
    const maxDuration = options.maxSceneDuration || 30;

    // Calculate scene durations
    const scenes = distributeSceneDurations(parsed, totalTargetSeconds, minDuration, maxDuration);

    // Generate image prompts with character integration
    const scenesWithPrompts = scenes.map((scene) => ({
      ...scene,
      imagePrompt: buildImagePrompt(scene, options.characters),
    }));

    return {
      success: true,
      scenes: scenesWithPrompts,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function distributeSceneDurations(
  scenes: ParsedScene[],
  totalSeconds: number,
  minDuration: number,
  maxDuration: number,
): Omit<Scene, "id" | "projectId" | "imageUrl" | "thumbnailUrl" | "imageStatus">[] {
  const count = scenes.length;

  // If scenes have explicit durations, use them (with constraints)
  const hasExplicitDurations = scenes.some((s) => s.duration !== undefined);

  if (hasExplicitDurations) {
    // Use explicit durations, normalize to fit target
    const explicitTotal = scenes.reduce((sum, s) => sum + (s.duration || 5), 0);
    const scaleFactor = totalSeconds / explicitTotal;

    return scenes.map((scene, i) => {
      const baseDuration = (scene.duration || 5) * scaleFactor;
      const duration = Math.max(minDuration, Math.min(maxDuration, Math.round(baseDuration)));

      return {
        index: i,
        title: scene.title,
        description: scene.visual,
        dialogue: undefined,
        voiceover: scene.voiceover,
        durationSeconds: duration,
        imagePrompt: "", // Will be filled later
      };
    });
  }

  // Distribute evenly with slight variation
  const baseDuration = totalSeconds / count;
  const constrainedBase = Math.max(minDuration, Math.min(maxDuration, baseDuration));

  return scenes.map((scene, i) => ({
    index: i,
    title: scene.title,
    description: scene.visual,
    dialogue: undefined,
    voiceover: scene.voiceover,
    durationSeconds: Math.round(constrainedBase),
    imagePrompt: "", // Will be filled later
  }));
}

function buildImagePrompt(
  scene: Omit<
    Scene,
    "id" | "projectId" | "imageUrl" | "thumbnailUrl" | "imageStatus" | "imagePrompt"
  >,
  characters?: CharacterRef[],
): string {
  // Check if this is a title card (first scene or has "title" in name)
  const isTitleCard =
    scene.index === 0 ||
    scene.title?.toLowerCase().includes("title") ||
    scene.title?.toLowerCase().includes("intro") ||
    scene.title?.toLowerCase().includes("thumbnail") ||
    scene.title?.toLowerCase().includes("hook") ||
    scene.title?.toLowerCase().includes("opening");

  // For title cards, generate viral YouTube thumbnail style
  if (isTitleCard) {
    return buildTitleCardPrompt(scene, characters);
  }

  // NEW: Concise prompt format optimized for FLUX 2 Klein
  // Pattern: "[Character] [action] in [setting]. [style tags]."

  const parts: string[] = [];

  // 1. CHARACTER FIRST - the main subject of the image
  const mainChar = characters?.[0]; // Use primary character
  if (mainChar) {
    // Build character subject line with core visual traits
    const charCore = mainChar.styleTokens
      ? `${mainChar.name} ${mainChar.styleTokens}`
      : mainChar.description
        ? `${mainChar.name} ${extractCoreTraits(mainChar.description)}`
        : mainChar.name;
    parts.push(charCore);
  }

  // 2. ACTION + SETTING from scene description
  if (scene.description) {
    // Clean the description - remove character mentions (already handled), extract action
    let actionDesc = scene.description;
    if (mainChar) {
      // Remove character name references since we already added them
      actionDesc = actionDesc.replace(new RegExp(mainChar.name, "gi"), "").trim();
    }
    // Clean up any leading "the character" or similar
    actionDesc = actionDesc
      .replace(/^(the\s+)?(character|subject|figure)\s+/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    if (actionDesc) {
      parts.push(actionDesc);
    }
  }

  // 3. VOICEOVER CONTEXT - extract the key visual moment being narrated
  if (scene.voiceover && !scene.description) {
    const context = extractActionFromVoiceover(scene.voiceover);
    if (context) {
      parts.push(context);
    }
  }

  // 4. STYLE TAGS at the end (from character or defaults)
  const styleTags: string[] = [];
  if (mainChar?.styleTokens) {
    // Extract style tags from character (e.g., "anime military style")
    const styleMatch = mainChar.styleTokens.match(
      /(anime|military|tactical|cinematic|photorealistic|illustrated)[^,]*/gi,
    );
    if (styleMatch) {
      styleTags.push(...styleMatch);
    }
  }

  // Combine: Character + action, style tags
  let prompt = parts.join(" ");

  // Add style tags at end if not already present
  if (styleTags.length > 0) {
    const uniqueTags = [...new Set(styleTags)].join(", ");
    if (!prompt.toLowerCase().includes(uniqueTags.toLowerCase())) {
      prompt = `${prompt}. ${uniqueTags}`;
    }
  }

  // Final cleanup
  prompt = prompt
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\.+/g, ".")
    .replace(/\.\s*\./g, ".")
    .replace(/,\s*,/g, ",")
    .trim();

  // Ensure it ends with a period
  if (!prompt.endsWith(".")) {
    prompt += ".";
  }

  return prompt;
}

/**
 * Extract core visual traits from a character description
 * Returns concise tags like "military black bear with glowing eyes"
 */
function extractCoreTraits(description: string): string {
  // Remove wordy phrases, keep visual descriptors
  return description
    .replace(/\b(who|that|which|is|are|has|have|with a|the)\b/gi, " ")
    .replace(/\b(special forces|operator)\b/gi, "military")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100); // Keep it concise
}

/**
 * Extract the key action/visual from voiceover text
 * Returns a simple action phrase suitable for image prompts
 */
function extractActionFromVoiceover(voiceover: string): string | null {
  if (!voiceover) return null;

  // Look for action verbs and their objects
  const actionPatterns = [
    /\b(scavenging|gathering|collecting|finding|searching|looking for)\s+([^,.!?]+)/i,
    /\b(building|constructing|making|creating)\s+([^,.!?]+)/i,
    /\b(hiding|concealing|storing|stashing)\s+([^,.!?]+)/i,
    /\b(moving|traveling|walking|running|hiking)\s+(through|to|in|across)\s+([^,.!?]+)/i,
    /\b(fighting|defending|attacking|protecting)\s+([^,.!?]+)/i,
    /\b(teaching|showing|demonstrating|explaining)\s+([^,.!?]+)/i,
  ];

  for (const pattern of actionPatterns) {
    const match = voiceover.match(pattern);
    if (match) {
      return match[0].toLowerCase().trim();
    }
  }

  // Fallback: first 60 chars of the voiceover, cleaned
  return voiceover.split(/[.!?]/)[0]?.replace(/\s+/g, " ").trim().slice(0, 60) || null;
}

/**
 * Build a viral YouTube thumbnail style prompt for title cards
 * Concise format: Character in hero pose, dramatic lighting, topic context
 */
function buildTitleCardPrompt(
  scene: Omit<
    Scene,
    "id" | "projectId" | "imageUrl" | "thumbnailUrl" | "imageStatus" | "imagePrompt"
  >,
  characters?: CharacterRef[],
): string {
  const parts: string[] = [];

  // 1. CHARACTER FIRST with heroic pose
  const mainChar = characters?.[0];
  if (mainChar) {
    const charCore = mainChar.styleTokens
      ? `${mainChar.name} ${mainChar.styleTokens}`
      : mainChar.description
        ? `${mainChar.name} ${extractCoreTraits(mainChar.description)}`
        : mainChar.name;
    parts.push(`${charCore} in dramatic hero pose`);
  }

  // 2. SCENE CONTEXT from title/description
  let context = "";
  if (scene.title) {
    context = scene.title
      .replace(/title\s*card/gi, "")
      .replace(/intro(duction)?/gi, "")
      .replace(/thumbnail/gi, "")
      .replace(/hook/gi, "")
      .replace(/opening/gi, "")
      .replace(/scene\s*\d*/gi, "")
      .replace(/[:\-–—]/g, " ")
      .trim();
  }
  if (scene.description) {
    context = scene.description;
  }
  if (context) {
    parts.push(context);
  }

  // 3. THUMBNAIL STYLE TAGS - concise
  parts.push("cinematic dramatic lighting, bold composition, high contrast, no text");

  // Combine
  let prompt = parts.join(", ");
  prompt = prompt.replace(/\n+/g, " ").replace(/\s+/g, " ").replace(/,\s*,/g, ",").trim();

  if (!prompt.endsWith(".")) {
    prompt += ".";
  }

  return prompt;
}

// ═══════════════════════════════════════════════════════════════
// SCENE ENHANCEMENT
// ═══════════════════════════════════════════════════════════════

export function enhanceImagePrompt(prompt: string, style: string, aspectRatio: string): string {
  let enhanced = prompt;

  // Add style prefix
  const styleMap: Record<string, string> = {
    cinematic: "Cinematic shot, dramatic lighting, film grain, movie quality",
    realistic: "Photorealistic, high detail, natural lighting",
    anime: "Anime style, Japanese animation, vibrant colors",
    illustrated: "Digital illustration, clean lines, artistic",
    "3d-render": "3D rendered, CGI quality, volumetric lighting",
    watercolor: "Watercolor painting, soft edges, artistic",
    comic: "Comic book style, bold outlines, dynamic composition",
    minimalist: "Minimalist, clean, simple shapes, flat design",
  };

  const stylePrefix = styleMap[style] || "";
  if (stylePrefix) {
    enhanced = `${stylePrefix}. ${enhanced}`;
  }

  // Add aspect-specific composition hints
  if (aspectRatio === "9:16") {
    enhanced = `Vertical composition, portrait orientation. ${enhanced}`;
  } else if (aspectRatio === "1:1") {
    enhanced = `Square composition, centered subject. ${enhanced}`;
  }

  return enhanced;
}

// ═══════════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════════

export function validateScenes(
  scenes: Scene[],
  targetDurationMinutes: number,
): { valid: boolean; issues: string[] } {
  const issues: string[] = [];

  if (scenes.length === 0) {
    issues.push("No scenes generated");
    return { valid: false, issues };
  }

  const totalDuration = scenes.reduce((sum, s) => sum + s.durationSeconds, 0);
  const targetSeconds = targetDurationMinutes * 60;
  const tolerance = 0.2; // 20% tolerance

  if (totalDuration < targetSeconds * (1 - tolerance)) {
    issues.push(
      `Total duration (${totalDuration}s) is significantly less than target (${targetSeconds}s)`,
    );
  }

  if (totalDuration > targetSeconds * (1 + tolerance)) {
    issues.push(
      `Total duration (${totalDuration}s) is significantly more than target (${targetSeconds}s)`,
    );
  }

  // Check for empty prompts
  const emptyPrompts = scenes.filter((s) => !s.imagePrompt || s.imagePrompt.length < 10);
  if (emptyPrompts.length > 0) {
    issues.push(`${emptyPrompts.length} scene(s) have empty or very short image prompts`);
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}
