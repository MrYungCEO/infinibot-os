/**
 * Survival Video Workflow — Script generation for survival/prepper content
 *
 * Generates scripts and scene breakdowns that can be used with the existing
 * storyboard pipeline.
 */

import Anthropic from "@anthropic-ai/sdk";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";

const log = createSubsystemLogger("survival-workflow");

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export interface SurvivalVideoConfig {
  /** Video topic/title */
  topic: string;
  /** Target duration in minutes */
  durationMinutes: number;
  /** YouTube URL for style reference */
  styleReference?: string;
  /** Custom style prompt (used if no URL provided) */
  stylePrompt?: string;
  /** Character slug to use from saved characters */
  characterSlug?: string;
  /** Character description (if not using saved character) */
  characterDescription?: string;
  /** Style preset name */
  stylePreset?: keyof typeof SURVIVAL_STYLE_PRESETS;
}

export interface SceneData {
  index: number;
  title: string;
  visual: string;
  voiceover: string;
  durationSeconds: number;
}

export interface SurvivalScriptResult {
  success: boolean;
  title?: string;
  script?: string;
  scenes?: SceneData[];
  hook?: string;
  outro?: string;
  estimatedDuration?: number;
  error?: string;
}

// ═══════════════════════════════════════════════════════════════
// STYLE PRESETS
// ═══════════════════════════════════════════════════════════════

export const SURVIVAL_STYLE_PRESETS = {
  tactical: `
STYLE: Tactical/Military Survival
- Tone: Authoritative, no-nonsense, slightly intense
- Phrases: "Get clapped", "mission-critical", "your six", "exfil"
- Structure: Direct numbered lists with tactical reasoning
- Visuals: Military-style graphics, dark themes, tactical gear
`,
  prepper: `
STYLE: Prepper/SHTF
- Tone: Urgent but practical, "wake up" energy
- Phrases: "When SHTF", "grid down", "bug out", "gray man"
- Structure: Scenarios and solutions, worst-case thinking
- Visuals: Post-apocalyptic, bunkers, supplies
`,
  bushcraft: `
STYLE: Bushcraft/Wilderness
- Tone: Calm expertise, nature-focused, respectful
- Phrases: "In the wild", "primitive skills", "the old ways"
- Structure: Teaching format, step-by-step
- Visuals: Forest, handmade tools, natural shelters
`,
  urban: `
STYLE: Urban Survival
- Tone: Street-smart, realistic, city-focused
- Phrases: "Urban jungle", "situational awareness", "everyday carry"
- Structure: Practical tips, real-world scenarios
- Visuals: City environments, concealed gear, crowds
`,
};

// ═══════════════════════════════════════════════════════════════
// STYLE ANALYSIS
// ═══════════════════════════════════════════════════════════════

/**
 * Analyze a YouTube video style to extract writing patterns
 */
export async function analyzeVideoStyle(youtubeUrl: string): Promise<{
  success: boolean;
  styleGuide?: string;
  error?: string;
}> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { success: false, error: "ANTHROPIC_API_KEY not set" };
  }

  try {
    const client = new Anthropic({ apiKey });

    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      messages: [
        {
          role: "user",
          content: `Analyze this YouTube video URL and describe the scriptwriting style I should mimic:

URL: ${youtubeUrl}

Based on typical survival/prepper YouTube content, create a detailed style guide covering:
1. Tone (serious, casual, urgent, etc.)
2. Hook structure (how to open)
3. List/point format (numbered, storytelling, etc.)
4. Language patterns (direct, conversational, authoritative)
5. Call-to-action style
6. Pacing and rhythm
7. Use of rhetorical questions
8. How to build tension/engagement

Format as a concise style guide I can use for scriptwriting.`,
        },
      ],
    });

    const content = response.content[0];
    if (content.type !== "text") {
      return { success: false, error: "Unexpected response" };
    }

    return { success: true, styleGuide: content.text };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// ═══════════════════════════════════════════════════════════════
// SCRIPT GENERATOR
// ═══════════════════════════════════════════════════════════════

/**
 * Generate a survival-style video script with full scene breakdown
 */
export async function generateSurvivalScript(
  config: SurvivalVideoConfig,
): Promise<SurvivalScriptResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { success: false, error: "ANTHROPIC_API_KEY not set" };
  }

  log.info("Generating survival script", { topic: config.topic, duration: config.durationMinutes });

  const wordsPerMinute = 150;
  const targetWords = config.durationMinutes * wordsPerMinute;
  const numScenes = Math.max(10, Math.round(config.durationMinutes * 1.5));

  // Build style guide
  let styleGuide = config.stylePrompt || "";

  if (config.stylePreset && SURVIVAL_STYLE_PRESETS[config.stylePreset]) {
    styleGuide = SURVIVAL_STYLE_PRESETS[config.stylePreset];
  }

  if (!styleGuide) {
    styleGuide = `
STYLE GUIDE - Survival/Prepper YouTube:
- Tone: Direct, slightly urgent, authoritative but not preachy
- Hook: Start with a bold statement or statistic that grabs attention
- Structure: Numbered list format ("15 ways to...", "10 mistakes that...")
- Language: Conversational but informed, use "you" directly
- Phrases to use: "Here's the thing...", "Most people don't realize...", "Get clapped" (slang for getting killed/destroyed)
- Build tension: Each point should feel consequential
- End with a strong call-to-action about preparation
- NO corporate speak, NO hedging, BE DIRECT
`;
  }

  const characterInstruction = config.characterDescription
    ? `\nMASCOT CHARACTER: ${config.characterDescription}\nInclude this character in scene visuals as a recurring mascot/host figure.`
    : "";

  try {
    const client = new Anthropic({ apiKey });

    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 12000,
      system: `You are an expert survival/prepper YouTube scriptwriter. Your scripts get millions of views because they're direct, engaging, and genuinely useful.

${styleGuide}
${characterInstruction}

OUTPUT FORMAT:
Return a JSON object with this structure:
{
  "title": "Video title",
  "hook": "Opening hook text (first 30 seconds)",
  "scenes": [
    {
      "index": 1,
      "title": "Scene title",
      "visual": "Detailed visual description for image generation",
      "voiceover": "The narration text for this scene",
      "durationSeconds": 30
    }
  ],
  "outro": "Closing text with CTA"
}

Each scene should be a distinct visual moment. Include approximately ${numScenes} scenes for a ${config.durationMinutes}-minute video (~${targetWords} words of voiceover total).`,
      messages: [
        {
          role: "user",
          content: `Write a complete YouTube video script about:

TOPIC: ${config.topic}

Target duration: ${config.durationMinutes} minutes
Target word count: ~${targetWords} words
Number of scenes: ~${numScenes}

Generate the full script in the JSON format specified. Make it engaging, direct, and genuinely useful for viewers interested in survival preparedness.`,
        },
      ],
    });

    const content = response.content[0];
    if (content.type !== "text") {
      return { success: false, error: "Unexpected response" };
    }

    // Parse JSON from response
    const jsonMatch = content.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { success: true, script: content.text };
    }

    const scriptData = JSON.parse(jsonMatch[0]);

    // Build full script text
    const fullScript = buildFullScript(scriptData);

    // Calculate estimated duration
    const totalWords = fullScript.split(/\s+/).length;
    const estimatedDuration = Math.round((totalWords / wordsPerMinute) * 10) / 10;

    log.info("Script generated", {
      title: scriptData.title,
      scenes: scriptData.scenes?.length,
      words: totalWords,
      estimatedMinutes: estimatedDuration,
    });

    return {
      success: true,
      title: scriptData.title,
      script: fullScript,
      scenes: scriptData.scenes,
      hook: scriptData.hook,
      outro: scriptData.outro,
      estimatedDuration,
    };
  } catch (err) {
    log.error("Script generation failed:", err as Record<string, unknown>);
    return { success: false, error: String(err) };
  }
}

function buildFullScript(data: any): string {
  const lines: string[] = [];

  lines.push(`# ${data.title || "Untitled"}\n`);
  lines.push(`## HOOK\n${data.hook || ""}\n`);

  if (data.scenes) {
    for (const scene of data.scenes) {
      lines.push(`---\n`);
      lines.push(`### SCENE ${scene.index}: ${scene.title}\n`);
      lines.push(`**VISUAL:** ${scene.visual}\n`);
      lines.push(`**VOICEOVER:** ${scene.voiceover}\n`);
      lines.push(`**DURATION:** ${scene.durationSeconds} seconds\n`);
    }
  }

  if (data.outro) {
    lines.push(`---\n## OUTRO\n${data.outro}\n`);
  }

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════
// WORKFLOW RUNNER
// ═══════════════════════════════════════════════════════════════

export interface WorkflowResult {
  success: boolean;
  scriptResult?: SurvivalScriptResult;
  outputPath?: string;
  error?: string;
}

/**
 * Run the survival script workflow and save output
 */
export async function runSurvivalWorkflow(
  stateDir: string,
  config: SurvivalVideoConfig,
): Promise<WorkflowResult> {
  log.info("Starting survival workflow", { topic: config.topic });

  try {
    // Step 1: Analyze style reference if provided
    if (config.styleReference && !config.stylePrompt) {
      const styleResult = await analyzeVideoStyle(config.styleReference);
      if (styleResult.success && styleResult.styleGuide) {
        config.stylePrompt = styleResult.styleGuide;
      }
    }

    // Step 2: Load character if slug provided
    if (config.characterSlug && !config.characterDescription) {
      const charPath = join(stateDir, "characters", config.characterSlug, "metadata.json");
      if (existsSync(charPath)) {
        try {
          const charData = JSON.parse(readFileSync(charPath, "utf-8"));
          config.characterDescription = `"${charData.name}" - ${charData.description}`;
          log.info("Loaded character", { name: charData.name });
        } catch (e) {
          log.error("Failed to load character:", e as Record<string, unknown>);
        }
      }
    }

    // Step 3: Generate script
    const scriptResult = await generateSurvivalScript(config);

    if (!scriptResult.success) {
      return { success: false, error: scriptResult.error };
    }

    // Step 4: Save output
    const outputDir = join(stateDir, "survival-scripts");
    mkdirSync(outputDir, { recursive: true });

    const slug = config.topic
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 50);
    const timestamp = Date.now();
    const outputPath = join(outputDir, `${slug}-${timestamp}.md`);

    writeFileSync(outputPath, scriptResult.script || "", "utf-8");

    // Also save JSON data
    const jsonPath = join(outputDir, `${slug}-${timestamp}.json`);
    writeFileSync(
      jsonPath,
      JSON.stringify(
        {
          config,
          result: scriptResult,
          generatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf-8",
    );

    log.info("Workflow complete", { outputPath });

    return {
      success: true,
      scriptResult,
      outputPath,
    };
  } catch (err) {
    log.error("Workflow failed:", err as Record<string, unknown>);
    return { success: false, error: String(err) };
  }
}
