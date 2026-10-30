/**
 * Storyboard Gateway Handlers
 */

import type { GatewayRequestHandlers } from "./types.js";
import { requireFeature } from "../../license/middleware.js";
import {
  createProject,
  getProject,
  listProjects,
  updateProject,
  deleteProject,
  addCharacter,
  updateCharacter,
  deleteCharacter,
  updateScene,
  getScene,
} from "../../storyboard/store.js";
import {
  runPipeline,
  regenerateScript,
  regenerateScenes,
  regenerateSceneImage,
  generateAllImages,
} from "../../storyboard/pipeline.js";
import { getAvailableGenerators, LocalGenerator } from "../../storyboard/image-generator.js";
import type {
  Platform,
  ImageBackend,
  CharacterRef,
  EffectPreset,
  CustomEffectPreset,
} from "../../storyboard/types.js";
import {
  exportStoryboardVideo,
  generateKenBurnsClip,
  type KenBurnsOptions,
} from "../../storyboard/video-generator.js";
import {
  listAllVoices,
  cloneVoice,
  deleteClonedVoice,
  generateSceneVoiceover,
  generateAllVoiceovers,
  mergeAudioWithVideo,
  type TtsProvider,
} from "../../storyboard/audio-generator.js";
import { resolve } from "path";
import {
  runSurvivalWorkflow,
  generateSurvivalScript,
  analyzeVideoStyle,
  SURVIVAL_STYLE_PRESETS,
  type SurvivalVideoConfig,
} from "../../storyboard/survival-video-workflow.js";

// Get state directory from environment
function getStateDir(): string {
  return process.env.INFINIBOT_STATE_DIR || "state";
}

export const storyboardHandlers: GatewayRequestHandlers = {
  // ─── List Projects ─────────────────────────────────────────
  "storyboard.list": async ({ params, respond }) => {
    try {
      const projects = listProjects(getStateDir(), {
        status: params.status as any,
        limit: params.limit as number,
        offset: params.offset as number,
      });
      respond(true, { projects });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ─── Get Project ───────────────────────────────────────────
  "storyboard.get": async ({ params, respond }) => {
    try {
      const project = getProject(getStateDir(), params.id as string);
      if (!project) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Project not found" });
        return;
      }
      respond(true, { project });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ─── Create Project ────────────────────────────────────────
  "storyboard.create": async ({ params, respond }) => {
    try {
      const project = createProject(getStateDir(), {
        name: params.name as string,
        prompt: params.prompt as string,
        targetDuration: params.targetDuration as number,
        platform: params.platform as Platform,
        aspectRatio: params.aspectRatio as string,
        imageStyle: params.imageStyle as string,
        imageBackend: params.imageBackend as ImageBackend,
        language: params.language as string,
        ttsProvider: params.ttsProvider as string,
        ttsVoice: params.ttsVoice as string,
        characters: params.characters as Omit<CharacterRef, "id">[],
      });
      // Register in /apps catalog so storyboard projects show up next to
      // other apps/sites/projects.
      try {
        const { autoRegister } = await import("../../apps/store.js");
        autoRegister(getStateDir(), {
          sourceKind: "storyboard",
          sourceId: project.id,
          name: project.name,
          description: (project.prompt || "").slice(0, 200),
          type: "storyboard",
          meta: { platform: project.platform, status: project.status },
        });
      } catch {
        /* swallow */
      }
      respond(true, { project });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ─── Update Project ────────────────────────────────────────
  "storyboard.update": async ({ params, respond }) => {
    try {
      const { id, ...patch } = params as any;
      const project = updateProject(getStateDir(), id, patch);
      if (!project) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Project not found" });
        return;
      }
      respond(true, { project });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ─── Delete Project ────────────────────────────────────────
  "storyboard.delete": async ({ params, respond }) => {
    try {
      const deleted = deleteProject(getStateDir(), params.id as string);
      respond(true, { deleted });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ─── Run Full Pipeline ─────────────────────────────────────
  "storyboard.run": async ({ params, respond }) => {
    try {
      const result = await runPipeline(getStateDir(), params.id as string);
      const project = getProject(getStateDir(), params.id as string);
      respond(true, { ...result, project });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ─── Generate/Regenerate Script (Step 1) ────────────────────
  "storyboard.generateScript": async ({ params, respond }) => {
    try {
      const result = await regenerateScript(getStateDir(), params.id as string);
      const project = getProject(getStateDir(), params.id as string);
      respond(true, { ...result, project });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  "storyboard.regenerateScript": async ({ params, respond }) => {
    try {
      const result = await regenerateScript(getStateDir(), params.id as string);
      const project = getProject(getStateDir(), params.id as string);
      respond(true, { ...result, project });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ─── Split/Regenerate Scenes (Step 2) ──────────────────────
  "storyboard.splitScenes": async ({ params, respond }) => {
    try {
      const result = await regenerateScenes(getStateDir(), params.id as string);
      const project = getProject(getStateDir(), params.id as string);
      respond(true, { ...result, project });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  "storyboard.regenerateScenes": async ({ params, respond }) => {
    try {
      const result = await regenerateScenes(getStateDir(), params.id as string);
      const project = getProject(getStateDir(), params.id as string);
      respond(true, { ...result, project });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ─── Regenerate Scene Image ────────────────────────────────
  // Single-image generation: gated at Starter (image_generation).
  "storyboard.regenerateSceneImage": requireFeature(
    "image_generation",
    async ({ params, respond }) => {
      try {
        // If custom prompt provided, update the scene first
        if (params.customPrompt) {
          updateScene(getStateDir(), params.sceneId as string, {
            imagePrompt: params.customPrompt as string,
          });
        }

        const result = await regenerateSceneImage(
          getStateDir(),
          params.sceneId as string,
          params.backend as ImageBackend,
          params.model as string | undefined,
        );
        const scene = getScene(getStateDir(), params.sceneId as string);
        respond(true, { ...result, scene });
      } catch (err) {
        respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
      }
    },
  ),

  // ─── Generate All Images ───────────────────────────────────
  // Bulk/batch image generation: the high-volume "unlimited" path, gated at
  // CEO (unlimited_image_generation).
  "storyboard.generateImages": requireFeature(
    "unlimited_image_generation",
    async ({ params, respond }) => {
      try {
        const result = await generateAllImages(getStateDir(), params.id as string);
        const project = getProject(getStateDir(), params.id as string);
        respond(true, { ...result, project });
      } catch (err) {
        respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
      }
    },
  ),

  // ─── Update Scene ──────────────────────────────────────────
  "storyboard.updateScene": async ({ params, respond }) => {
    try {
      const { sceneId, ...patch } = params as any;
      const scene = updateScene(getStateDir(), sceneId, patch);
      if (!scene) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Scene not found" });
        return;
      }
      respond(true, { scene });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ─── Add Character ─────────────────────────────────────────
  "storyboard.addCharacter": async ({ params, respond }) => {
    try {
      const { projectId, ...data } = params as any;
      const character = addCharacter(getStateDir(), projectId, data);
      respond(true, { character });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ─── Update Character ──────────────────────────────────────
  "storyboard.updateCharacter": async ({ params, respond }) => {
    try {
      const { characterId, ...patch } = params as any;
      const character = updateCharacter(getStateDir(), characterId, patch);
      if (!character) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Character not found" });
        return;
      }
      respond(true, { character });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ─── Delete Character ──────────────────────────────────────
  "storyboard.deleteCharacter": async ({ params, respond }) => {
    try {
      const deleted = deleteCharacter(getStateDir(), params.characterId as string);
      respond(true, { deleted });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ─── Get Available Backends ────────────────────────────────
  "storyboard.backends": async ({ respond }) => {
    try {
      const generators = await getAvailableGenerators();
      respond(true, {
        available: generators.map((g) => ({
          name: g.name,
          backend: g.backend,
          supportsCharacterRef: g.supportsCharacterRef,
          supportsStyleTransfer: g.supportsStyleTransfer,
        })),
      });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ─── List ComfyUI checkpoints (proxied to avoid browser CORS) ─
  // The dashboard origin can't fetch ComfyUI directly because ComfyUI
  // Desktop ships without CORS headers — so the UI calls this method
  // and the gateway makes the cross-origin request server-side.
  "storyboard.models": async ({ respond }) => {
    try {
      const gen = new LocalGenerator();
      const available = await gen.isAvailable();
      const checkpoints = available ? await gen.listCheckpoints() : [];
      respond(true, { available, checkpoints });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ─── Export Video with Scene Effects ────────────────────────
  "storyboard.exportVideo": async ({ params, respond }) => {
    try {
      const project = getProject(getStateDir(), params.id as string);
      if (!project) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Project not found" });
        return;
      }

      const outputDir =
        (params.outputDir as string) || resolve(getStateDir(), "storyboard-exports", project.id);

      // When useSceneEffects is true (default), use per-scene effect presets
      // Ken Burns options are only used as fallback for scenes without effects
      const useSceneEffects = params.useSceneEffects !== false; // Default to true

      // Only use custom Ken Burns if explicitly provided AND not using scene effects
      const kenBurnsOptions: KenBurnsOptions | undefined =
        !useSceneEffects && params.kenBurns
          ? {
              zoomDirection: (params.kenBurns as any).zoomDirection || "random",
              zoomAmount: (params.kenBurns as any).zoomAmount || 1.08,
              panDirection: (params.kenBurns as any).panDirection || "random",
              panAmount: (params.kenBurns as any).panAmount || 30,
              easing: (params.kenBurns as any).easing || "ease-in-out",
            }
          : undefined;

      const result = await exportStoryboardVideo(project, outputDir, {
        fps: (params.fps as number) || 30,
        fadeTransition: (params.fadeTransition as number) ?? 0.3,
        kenBurns: kenBurnsOptions,
        forceRemotionCheck: useSceneEffects, // Check Remotion if using scene effects
      });

      respond(true, result);
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ─── Generate Single Scene Clip ────────────────────────────
  "storyboard.generateClip": async ({ params, respond }) => {
    try {
      const scene = getScene(getStateDir(), params.sceneId as string);
      if (!scene) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Scene not found" });
        return;
      }

      if (!scene.imageUrl) {
        respond(false, undefined, { code: "INVALID_STATE", message: "Scene has no image" });
        return;
      }

      const outputDir = (params.outputDir as string) || resolve(getStateDir(), "storyboard-clips");
      const outputPath = resolve(outputDir, `scene_${scene.id}.mp4`);

      const result = await generateKenBurnsClip({
        inputImage: scene.imageUrl.replace("file://", ""),
        outputPath,
        duration: scene.durationSeconds,
        fps: (params.fps as number) || 30,
        kenBurns: params.kenBurns
          ? {
              zoomDirection: (params.kenBurns as any).zoomDirection || "random",
              zoomAmount: (params.kenBurns as any).zoomAmount || 1.08,
              panDirection: (params.kenBurns as any).panDirection || "random",
              panAmount: (params.kenBurns as any).panAmount || 30,
              easing: (params.kenBurns as any).easing || "ease-in-out",
            }
          : undefined,
      });

      respond(true, result);
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ─── Render Scene with Remotion Effect ─────────────────────
  "storyboard.renderSceneWithEffect": async ({ params, respond }) => {
    try {
      const scene = getScene(getStateDir(), params.sceneId as string);
      if (!scene) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Scene not found" });
        return;
      }

      if (!scene.imageUrl) {
        respond(false, undefined, { code: "INVALID_STATE", message: "Scene has no image" });
        return;
      }

      const preset = (params.preset as EffectPreset) || scene.effectPreset || "ken-burns";

      // Skip Remotion if preset is "none"
      if (preset === "none") {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "Preset is 'none' - use storyboard.generateClip for FFmpeg Ken Burns instead",
        });
        return;
      }

      const outputDir = (params.outputDir as string) || resolve(getStateDir(), "storyboard-clips");
      const outputPath = resolve(outputDir, `scene_${scene.id}_${preset}.mp4`);

      let result;
      try {
        const { renderSceneWithEffect } =
          await import("../../storyboard/remotion-effects/render.js");
        result = await renderSceneWithEffect({
          imagePath: scene.imageUrl.replace("file://", ""),
          outputPath,
          preset,
          durationSeconds: scene.durationSeconds,
          fps: (params.fps as number) || 30,
          aspectRatio: (params.aspectRatio as "16:9" | "9:16" | "1:1") || "16:9",
        });
      } catch (err) {
        result = {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }

      respond(true, result);
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ─── Check Remotion Availability ───────────────────────────
  "storyboard.remotionStatus": async ({ respond }) => {
    try {
      let available = false;
      try {
        const { isHyperframesAvailable } =
          await import("../../storyboard/remotion-effects/render.js");
        available = await isHyperframesAvailable();
      } catch {
        available = false;
      }
      respond(true, { available });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ─── List Available Voices ─────────────────────────────────
  "storyboard.voices": async ({ respond }) => {
    try {
      const voices = await listAllVoices();
      respond(true, { voices });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ─── Clone Voice (ElevenLabs) ──────────────────────────────
  "storyboard.cloneVoice": async ({ params, respond }) => {
    try {
      const name = params.name as string;
      const audioFiles = params.audioFiles as string[];
      const description = params.description as string | undefined;

      if (!name || !audioFiles || audioFiles.length === 0) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "name and audioFiles required",
        });
        return;
      }

      const result = await cloneVoice(name, audioFiles, description);
      respond(true, result);
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ─── Delete Cloned Voice ───────────────────────────────────
  "storyboard.deleteVoice": async ({ params, respond }) => {
    try {
      const voiceId = params.voiceId as string;
      if (!voiceId) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "voiceId required" });
        return;
      }

      const result = await deleteClonedVoice(voiceId);
      respond(true, result);
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ─── Generate Scene Voiceover ──────────────────────────────
  "storyboard.generateVoiceover": async ({ params, respond }) => {
    try {
      const scene = getScene(getStateDir(), params.sceneId as string);
      if (!scene) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Scene not found" });
        return;
      }

      // Use media/storyboard-audio for serving via /media/ route
      const outputDir =
        (params.outputDir as string) ||
        resolve(getStateDir(), "media", "storyboard-audio", scene.projectId);

      const result = await generateSceneVoiceover(scene, outputDir, {
        voiceId: params.voiceId as string,
        provider: params.provider as TtsProvider,
        modelId: params.modelId as string,
        stability: params.stability as number,
        similarityBoost: params.similarityBoost as number,
        speed: params.speed as number,
      });

      // Update scene with audio URL if successful
      if (result.success && result.audioPath) {
        // Convert local path to /media/ URL
        const audioUrl = `/media/storyboard-audio/${scene.projectId}/scene_${String(scene.index).padStart(3, "0")}_vo.mp3`;
        updateScene(getStateDir(), params.sceneId as string, { audioUrl });
        (result as any).audioUrl = audioUrl;
      }

      respond(true, result);
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ─── Generate All Voiceovers ───────────────────────────────
  "storyboard.generateAllVoiceovers": async ({ params, respond }) => {
    try {
      const project = getProject(getStateDir(), params.id as string);
      if (!project) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Project not found" });
        return;
      }

      // Use media/storyboard-audio for serving via /media/ route
      const outputDir =
        (params.outputDir as string) ||
        resolve(getStateDir(), "media", "storyboard-audio", project.id);

      const result = await generateAllVoiceovers(project, outputDir, {
        voiceId: params.voiceId as string,
        provider: params.provider as TtsProvider,
        modelId: params.modelId as string,
        stability: params.stability as number,
        similarityBoost: params.similarityBoost as number,
        speed: params.speed as number,
      });

      // Update each scene with its audio URL
      if (result.audioFiles && result.audioFiles.length > 0) {
        for (let i = 0; i < project.scenes.length; i++) {
          const scene = project.scenes[i];
          const audioUrl = `/media/storyboard-audio/${project.id}/scene_${String(scene.index).padStart(3, "0")}_vo.mp3`;
          updateScene(getStateDir(), scene.id, { audioUrl });
        }
      }

      respond(true, result);
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ─── Merge Audio with Video ────────────────────────────────
  "storyboard.mergeAudio": async ({ params, respond }) => {
    try {
      const videoPath = params.videoPath as string;
      const audioPath = params.audioPath as string;
      const outputPath = params.outputPath as string;

      if (!videoPath || !audioPath || !outputPath) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "videoPath, audioPath, and outputPath required",
        });
        return;
      }

      const result = await mergeAudioWithVideo(videoPath, audioPath, outputPath);
      respond(true, result);
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ═══════════════════════════════════════════════════════════
  // SURVIVAL VIDEO WORKFLOW
  // ═══════════════════════════════════════════════════════════

  // ─── Analyze Style Reference ───────────────────────────────
  "storyboard.analyzeStyle": async ({ params, respond }) => {
    try {
      const url = params.url as string;
      if (!url) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "url required" });
        return;
      }

      const result = await analyzeVideoStyle(url);
      respond(true, result);
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ─── Get Style Presets ─────────────────────────────────────
  "storyboard.stylePresets": async ({ respond }) => {
    respond(true, { presets: Object.keys(SURVIVAL_STYLE_PRESETS), styles: SURVIVAL_STYLE_PRESETS });
  },

  // ─── Run Full Survival Video Workflow ──────────────────────
  "storyboard.runSurvivalWorkflow": async ({ params, respond }) => {
    try {
      const config: SurvivalVideoConfig = {
        topic: params.topic as string,
        durationMinutes: (params.durationMinutes as number) || 15,
        styleReference: params.styleReference as string,
        stylePrompt: params.stylePrompt as string,
        characterSlug: params.characterSlug as string,
        characterDescription: params.characterDescription as string,
        stylePreset: params.stylePreset as keyof typeof SURVIVAL_STYLE_PRESETS,
      };

      if (!config.topic) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "topic required" });
        return;
      }

      // Run workflow
      const result = await runSurvivalWorkflow(getStateDir(), config);

      respond(true, result);
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ─── Generate Survival Script Only ─────────────────────────
  "storyboard.generateSurvivalScript": async ({ params, respond }) => {
    try {
      const config: SurvivalVideoConfig = {
        topic: params.topic as string,
        durationMinutes: (params.durationMinutes as number) || 15,
        stylePrompt: params.stylePrompt as string,
        characterDescription: params.characterDescription as string,
        stylePreset: params.stylePreset as keyof typeof SURVIVAL_STYLE_PRESETS,
      };

      if (!config.topic) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "topic required" });
        return;
      }

      const result = await generateSurvivalScript(config);
      respond(true, result);
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ─── Generate Prompt Suggestions (Unexpected Scene Ideas) ─────────────────
  "storyboard.generatePromptSuggestions": async ({ params, respond }) => {
    try {
      const sceneTitle = params.sceneTitle as string;
      const sceneDescription = params.sceneDescription as string;
      const sceneVoiceover = params.sceneVoiceover as string;
      const currentPrompt = params.currentPrompt as string;
      const characterContext = params.characterContext as string;
      const imageStyle = (params.imageStyle as string) || "cinematic";

      // Use Anthropic to generate unexpected but relevant prompts
      const Anthropic = (await import("@anthropic-ai/sdk")).default;
      const apiKey = process.env.ANTHROPIC_API_KEY;

      if (!apiKey) {
        respond(false, undefined, { code: "CONFIG_ERROR", message: "ANTHROPIC_API_KEY not set" });
        return;
      }

      const client = new Anthropic({ apiKey });

      const systemPrompt = `You are a creative director generating unexpected but visually stunning image prompts for a storyboard scene.

Your prompts should be:
- CONCISE (under 100 words each)
- VISUAL and SPECIFIC (focus on what the viewer will see)
- UNEXPECTED but RELEVANT to the scene's theme
- Follow this pattern: "[Character] [action] in [setting]. [style tags]."

Example of a good prompt:
"SF Bear scavenging in desolate Avon dome, finding duct tape. Military tactical gear, post-apocalyptic."

Generate prompts that surprise but still fit the scene's narrative purpose.`;

      const userPrompt = `Generate 5 unexpected but relevant image prompts for this scene:

SCENE: ${sceneTitle}
DESCRIPTION: ${sceneDescription || "Not provided"}
VOICEOVER: ${sceneVoiceover || "Not provided"}
CURRENT PROMPT: ${currentPrompt || "Not provided"}
${characterContext ? `CHARACTER: ${characterContext}` : ""}
STYLE: ${imageStyle}

Generate 5 creative alternatives that:
1. Show the same narrative moment from an unexpected angle or perspective
2. Add unexpected but fitting visual elements
3. Create visual drama through composition, lighting, or setting
4. Keep the character central but in surprising scenarios
5. Maintain the scene's purpose while being visually fresh

Return ONLY a JSON array of 5 prompt strings, no explanation:
["prompt 1", "prompt 2", "prompt 3", "prompt 4", "prompt 5"]`;

      const response = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      });

      const content = response.content[0];
      if (content.type !== "text") {
        respond(false, undefined, {
          code: "UNEXPECTED_RESPONSE",
          message: "Non-text response from Claude",
        });
        return;
      }

      // Parse JSON array from response
      const jsonMatch = content.text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        respond(false, undefined, {
          code: "PARSE_ERROR",
          message: "Could not parse prompt suggestions",
        });
        return;
      }

      const suggestions = JSON.parse(jsonMatch[0]) as string[];
      respond(true, { suggestions });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // EFFECT PRESET MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  "storyboard.listEffectPresets": async ({ respond }) => {
    try {
      const stateDir = getStateDir();
      const presetsPath = resolve(stateDir, "storyboard", "effect-presets.json");

      let presets: CustomEffectPreset[] = [];
      try {
        const data = await import("fs").then((fs) => fs.promises.readFile(presetsPath, "utf-8"));
        presets = JSON.parse(data);
      } catch {
        // No presets file yet, return empty
      }

      respond(true, { presets });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  "storyboard.saveEffectPreset": async ({ params, respond }) => {
    try {
      const { preset } = params as { preset: CustomEffectPreset };
      if (!preset || !preset.id || !preset.name) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "preset with id and name required",
        });
        return;
      }

      const stateDir = getStateDir();
      const presetsDir = resolve(stateDir, "storyboard");
      const presetsPath = resolve(presetsDir, "effect-presets.json");

      // Ensure directory exists
      const fs = await import("fs");
      await fs.promises.mkdir(presetsDir, { recursive: true });

      // Load existing presets
      let presets: CustomEffectPreset[] = [];
      try {
        const data = await fs.promises.readFile(presetsPath, "utf-8");
        presets = JSON.parse(data);
      } catch {
        // No presets file yet
      }

      // Update or add
      const existingIndex = presets.findIndex((p) => p.id === preset.id);
      if (existingIndex >= 0) {
        presets[existingIndex] = { ...preset, updatedAt: Date.now() };
      } else {
        presets.push({ ...preset, createdAt: Date.now(), updatedAt: Date.now() });
      }

      // Save
      await fs.promises.writeFile(presetsPath, JSON.stringify(presets, null, 2));

      respond(true, { success: true, preset: presets.find((p) => p.id === preset.id) });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  "storyboard.deleteEffectPreset": async ({ params, respond }) => {
    try {
      const { id } = params as { id: string };
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id required" });
        return;
      }

      const stateDir = getStateDir();
      const presetsPath = resolve(stateDir, "storyboard", "effect-presets.json");

      const fs = await import("fs");
      let presets: CustomEffectPreset[] = [];
      try {
        const data = await fs.promises.readFile(presetsPath, "utf-8");
        presets = JSON.parse(data);
      } catch {
        respond(false, undefined, { code: "NOT_FOUND", message: "Preset not found" });
        return;
      }

      const filtered = presets.filter((p) => p.id !== id);
      if (filtered.length === presets.length) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Preset not found" });
        return;
      }

      await fs.promises.writeFile(presetsPath, JSON.stringify(filtered, null, 2));

      respond(true, { success: true });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  "storyboard.renderPresetPreview": async ({ params, respond }) => {
    try {
      const { preset, imageUrl } = params as { preset: CustomEffectPreset; imageUrl: string };
      if (!preset || !imageUrl) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "preset and imageUrl required",
        });
        return;
      }

      const stateDir = getStateDir();
      const outputDir = resolve(stateDir, "storyboard", "previews");
      const fs = await import("fs");
      await fs.promises.mkdir(outputDir, { recursive: true });

      const outputPath = resolve(outputDir, `preview-${preset.id}-${Date.now()}.mp4`);

      try {
        const { renderSceneWithEffect } =
          await import("../../storyboard/remotion-effects/render.js");
        await renderSceneWithEffect({
          imagePath: imageUrl,
          outputPath,
          preset: preset.id as EffectPreset,
          customParams: preset.params,
          durationSeconds: 5,
          fps: 30,
          width: 1920,
          height: 1080,
        });
      } catch (err) {
        respond(false, undefined, {
          code: "REMOTION_UNAVAILABLE",
          message: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      respond(true, { videoUrl: outputPath });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },
};
