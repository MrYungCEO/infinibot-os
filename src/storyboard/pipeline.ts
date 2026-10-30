/**
 * Storyboard Pipeline — Orchestrates the full generation workflow
 */

import type { Scene, ImageBackend, CharacterRef } from "./types.js";
import { getProject, updateProject, addScenes, updateScene, clearScenes } from "./store.js";
import { generateScript } from "./script-generator.js";
import { splitScriptToScenes, enhanceImagePrompt } from "./scene-splitter.js";
import { generateImage } from "./image-generator.js";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * Character manager store location. Resolved in order:
 *   1. INFINIBOT_CHARACTERS_DIR (explicit override)
 *   2. <INFINIBOT_STATE_DIR>/characters (when state dir is set)
 *   3. ~/.infinibot/characters (default install location)
 */
function getCharactersDir(): string {
  if (process.env.INFINIBOT_CHARACTERS_DIR) return process.env.INFINIBOT_CHARACTERS_DIR;
  if (process.env.INFINIBOT_STATE_DIR) return join(process.env.INFINIBOT_STATE_DIR, "characters");
  return join(homedir(), ".infinibot", "characters");
}

/**
 * Enrich character refs with their reference image paths from the character manager.
 * This enables multi-reference image generation for character consistency.
 */
async function enrichCharacterRefs(characters: CharacterRef[]): Promise<CharacterRef[]> {
  const enriched: CharacterRef[] = [];

  for (const char of characters) {
    // If already has a reference image path, use it
    if (char.referenceImagePath && existsSync(char.referenceImagePath)) {
      enriched.push(char);
      continue;
    }

    // Try to find character in character manager by name
    const slug = char.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const charDir = join(getCharactersDir(), slug);
    const metadataPath = join(charDir, "metadata.json");

    if (existsSync(metadataPath)) {
      try {
        const metadata = JSON.parse(readFileSync(metadataPath, "utf-8"));

        // Get primary image or first available
        const primaryImage =
          metadata.images?.find((img: any) => img.isPrimary) || metadata.images?.[0];

        if (primaryImage?.path && existsSync(primaryImage.path)) {
          enriched.push({
            ...char,
            referenceImagePath: primaryImage.path,
            // Also update description from character manager if richer
            description: metadata.description || char.description,
            styleTokens: metadata.styleTokens || char.styleTokens,
          });
          console.log(
            `[Pipeline] Enriched character "${char.name}" with reference: ${primaryImage.path}`,
          );
          continue;
        }
      } catch (err) {
        console.warn(`[Pipeline] Failed to load character metadata for ${char.name}:`, err);
      }
    }

    // Fallback: use character as-is
    enriched.push(char);
  }

  return enriched;
}

export interface PipelineProgress {
  stage: "scripting" | "splitting" | "generating" | "complete" | "failed";
  progress: number; // 0-100
  currentScene?: number;
  totalScenes?: number;
  message: string;
}

export type ProgressCallback = (progress: PipelineProgress) => void;

// ═══════════════════════════════════════════════════════════════
// FULL PIPELINE
// ═══════════════════════════════════════════════════════════════

export async function runPipeline(
  stateDir: string,
  projectId: string,
  onProgress?: ProgressCallback,
): Promise<{ success: boolean; error?: string }> {
  const project = getProject(stateDir, projectId);
  if (!project) {
    return { success: false, error: "Project not found" };
  }

  try {
    // Stage 1: Script Generation
    onProgress?.({
      stage: "scripting",
      progress: 5,
      message: "Generating script...",
    });

    updateProject(stateDir, projectId, { status: "scripting", progress: 5 });

    const scriptResult = await generateScript({
      prompt: project.prompt,
      platform: project.platform,
      targetDuration: project.targetDuration,
      includeVoiceover: true,
    });

    if (!scriptResult.success || !scriptResult.script) {
      updateProject(stateDir, projectId, {
        status: "failed",
        error: scriptResult.error || "Script generation failed",
      });
      return { success: false, error: scriptResult.error };
    }

    updateProject(stateDir, projectId, {
      script: scriptResult.script,
      progress: 20,
    });

    // Stage 2: Scene Splitting
    onProgress?.({
      stage: "splitting",
      progress: 25,
      message: "Breaking script into scenes...",
    });

    updateProject(stateDir, projectId, { status: "splitting", progress: 25 });

    const splitResult = splitScriptToScenes({
      script: scriptResult.script,
      targetDuration: project.targetDuration,
      platform: project.platform,
      characters: project.characters,
    });

    if (!splitResult.success || !splitResult.scenes) {
      updateProject(stateDir, projectId, {
        status: "failed",
        error: splitResult.error || "Scene splitting failed",
      });
      return { success: false, error: splitResult.error };
    }

    // Clear old scenes and add new ones
    clearScenes(stateDir, projectId);
    const scenes = addScenes(
      stateDir,
      projectId,
      splitResult.scenes.map((s, i) => ({
        ...s,
        index: i,
      })),
    );

    updateProject(stateDir, projectId, { progress: 30 });

    // Stage 3: Image Generation
    onProgress?.({
      stage: "generating",
      progress: 30,
      currentScene: 0,
      totalScenes: scenes.length,
      message: `Generating images (0/${scenes.length})...`,
    });

    updateProject(stateDir, projectId, { status: "generating" });

    // Enrich character refs with reference images from character manager (once for all scenes)
    const enrichedCharacters = await enrichCharacterRefs(project.characters);
    console.log(
      "[Pipeline] Enriched characters for generation:",
      enrichedCharacters.map((c) => ({
        name: c.name,
        hasRef: !!c.referenceImagePath,
      })),
    );

    const imageProgress = 30;
    const imageProgressRange = 65; // 30% to 95%
    const progressPerScene = imageProgressRange / scenes.length;

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const currentProgress = imageProgress + i * progressPerScene;

      onProgress?.({
        stage: "generating",
        progress: Math.round(currentProgress),
        currentScene: i + 1,
        totalScenes: scenes.length,
        message: `Generating image ${i + 1}/${scenes.length}: ${scene.title}`,
      });

      updateProject(stateDir, projectId, { progress: Math.round(currentProgress) });
      updateScene(stateDir, scene.id, { imageStatus: "generating" });

      // Enhance prompt with style
      const enhancedPrompt = enhanceImagePrompt(
        scene.imagePrompt,
        project.imageStyle,
        project.aspectRatio,
      );

      const imageResult = await generateImage(
        {
          prompt: enhancedPrompt,
          characterRefs: enrichedCharacters,
          style: project.imageStyle,
          aspectRatio: project.aspectRatio,
        },
        project.imageBackend,
      );

      if (imageResult.success && imageResult.imageUrl) {
        updateScene(stateDir, scene.id, {
          imageUrl: imageResult.imageUrl,
          thumbnailUrl: imageResult.thumbnailUrl,
          imageStatus: "complete",
        });
      } else {
        updateScene(stateDir, scene.id, {
          imageStatus: "failed",
          imageError: imageResult.error,
        });
        // Continue with other scenes even if one fails
      }
    }

    // Check completion status
    const updatedProject = getProject(stateDir, projectId);
    const failedScenes = updatedProject?.scenes.filter((s) => s.imageStatus === "failed") || [];

    if (failedScenes.length === scenes.length) {
      updateProject(stateDir, projectId, {
        status: "failed",
        error: "All image generations failed",
        progress: 100,
      });
      return { success: false, error: "All image generations failed" };
    }

    // Complete
    onProgress?.({
      stage: "complete",
      progress: 100,
      message:
        failedScenes.length > 0
          ? `Complete with ${failedScenes.length} failed scene(s)`
          : "Storyboard complete!",
    });

    updateProject(stateDir, projectId, {
      status: "complete",
      progress: 100,
      error:
        failedScenes.length > 0 ? `${failedScenes.length} scene(s) failed to generate` : undefined,
    });

    return { success: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    updateProject(stateDir, projectId, { status: "failed", error });
    return { success: false, error };
  }
}

// ═══════════════════════════════════════════════════════════════
// PARTIAL OPERATIONS
// ═══════════════════════════════════════════════════════════════

export async function regenerateScript(
  stateDir: string,
  projectId: string,
): Promise<{ success: boolean; error?: string }> {
  const project = getProject(stateDir, projectId);
  if (!project) {
    return { success: false, error: "Project not found" };
  }

  updateProject(stateDir, projectId, { status: "scripting", progress: 5 });

  const result = await generateScript({
    prompt: project.prompt,
    platform: project.platform,
    targetDuration: project.targetDuration,
    includeVoiceover: true,
  });

  if (result.success && result.script) {
    updateProject(stateDir, projectId, {
      script: result.script,
      status: "draft",
      progress: 20,
    });
    return { success: true };
  }

  updateProject(stateDir, projectId, { status: "draft" });
  return { success: false, error: result.error };
}

export async function regenerateScenes(
  stateDir: string,
  projectId: string,
): Promise<{ success: boolean; error?: string }> {
  const project = getProject(stateDir, projectId);
  if (!project || !project.script) {
    return { success: false, error: "Project or script not found" };
  }

  updateProject(stateDir, projectId, { status: "splitting", progress: 25 });

  const result = splitScriptToScenes({
    script: project.script,
    targetDuration: project.targetDuration,
    platform: project.platform,
    characters: project.characters,
  });

  if (result.success && result.scenes) {
    clearScenes(stateDir, projectId);
    addScenes(
      stateDir,
      projectId,
      result.scenes.map((s, i) => ({
        ...s,
        index: i,
      })),
    );
    updateProject(stateDir, projectId, { status: "draft", progress: 30 });
    return { success: true };
  }

  updateProject(stateDir, projectId, { status: "draft" });
  return { success: false, error: result.error };
}

export async function regenerateSceneImage(
  stateDir: string,
  sceneId: string,
  backend?: ImageBackend,
  model?: string,
): Promise<{ success: boolean; error?: string }> {
  const { getScene, updateScene } = await import("./store.js");

  const scene = getScene(stateDir, sceneId);
  if (!scene) {
    return { success: false, error: "Scene not found" };
  }

  const project = getProject(stateDir, scene.projectId);
  if (!project) {
    return { success: false, error: "Project not found" };
  }

  updateScene(stateDir, sceneId, { imageStatus: "generating", imageError: undefined });

  const enhancedPrompt = enhanceImagePrompt(
    scene.imagePrompt,
    project.imageStyle,
    project.aspectRatio,
  );

  // Enrich character refs with reference images from character manager
  const enrichedCharacters = await enrichCharacterRefs(project.characters);

  // Debug: Log character data being passed to generator
  console.log(
    "[Pipeline] regenerateSceneImage - Characters:",
    enrichedCharacters.map((c) => ({
      name: c.name,
      referenceImagePath: c.referenceImagePath,
      hasRef: !!c.referenceImagePath,
    })),
  );

  const result = await generateImage(
    {
      prompt: enhancedPrompt,
      characterRefs: enrichedCharacters,
      style: project.imageStyle,
      aspectRatio: project.aspectRatio,
      model, // Pass model to generator
    },
    backend || project.imageBackend,
  );

  if (result.success && result.imageUrl) {
    updateScene(stateDir, sceneId, {
      imageUrl: result.imageUrl,
      thumbnailUrl: result.thumbnailUrl,
      imageStatus: "complete",
      imageError: undefined,
    });
    return { success: true };
  }

  updateScene(stateDir, sceneId, {
    imageStatus: "failed",
    imageError: result.error,
  });
  return { success: false, error: result.error };
}

export async function generateAllImages(
  stateDir: string,
  projectId: string,
  onProgress?: ProgressCallback,
): Promise<{ success: boolean; error?: string }> {
  const project = getProject(stateDir, projectId);
  if (!project) {
    return { success: false, error: "Project not found" };
  }

  const pendingScenes = project.scenes.filter((s) => s.imageStatus !== "complete");
  if (pendingScenes.length === 0) {
    return { success: true };
  }

  updateProject(stateDir, projectId, { status: "generating" });

  let completed = 0;
  let failed = 0;

  for (const scene of pendingScenes) {
    onProgress?.({
      stage: "generating",
      progress: Math.round((completed / pendingScenes.length) * 100),
      currentScene: completed + 1,
      totalScenes: pendingScenes.length,
      message: `Generating ${completed + 1}/${pendingScenes.length}: ${scene.title}`,
    });

    const result = await regenerateSceneImage(stateDir, scene.id);

    if (result.success) {
      completed++;
    } else {
      failed++;
    }
  }

  const finalStatus = failed === pendingScenes.length ? "failed" : "complete";
  updateProject(stateDir, projectId, {
    status: finalStatus,
    progress: 100,
  });

  return {
    success: failed < pendingScenes.length,
    error: failed > 0 ? `${failed} scene(s) failed` : undefined,
  };
}
