/**
 * Gateway Methods — Image Studio
 *
 * Direct access to Image Studio without spawning the graphic-designer agent
 */

import type { GatewayRequestHandlerOptions } from "./types.js";
import { getImageStudioStore } from "../../image-studio/store.js";
import type { AssetType } from "../../image-studio/types.js";

export const imageStudioMethods = {
  // ─────────────────────────────────────────────────────────────────────────────
  // ASSET OPERATIONS
  // ─────────────────────────────────────────────────────────────────────────────

  "imageStudio.addAsset": async (
    ctx: GatewayRequestHandlerOptions,
    params: {
      name: string;
      filePath: string;
      type: AssetType;
      description?: string;
      tags?: string[];
      contextTerms?: string[];
    },
  ) => {
    const store = getImageStudioStore();
    const asset = store.addAsset(params);
    return { success: true, asset };
  },

  "imageStudio.listAssets": async (
    ctx: GatewayRequestHandlerOptions,
    params: { type?: AssetType; limit?: number },
  ) => {
    const store = getImageStudioStore();
    const assets = store.listAssets(params.type, params.limit);
    return { assets, count: assets.length };
  },

  "imageStudio.searchAssets": async (
    ctx: GatewayRequestHandlerOptions,
    params: {
      query?: string;
      type?: AssetType;
      tags?: string[];
      contextTerm?: string;
      limit?: number;
    },
  ) => {
    const store = getImageStudioStore();
    const assets = store.searchAssets(params);
    return { assets, count: assets.length };
  },

  "imageStudio.getAsset": async (ctx: GatewayRequestHandlerOptions, params: { id: string }) => {
    const store = getImageStudioStore();
    const asset = store.getAsset(params.id);
    if (!asset) return { error: "Asset not found" };
    return { asset };
  },

  "imageStudio.deleteAsset": async (ctx: GatewayRequestHandlerOptions, params: { id: string }) => {
    const store = getImageStudioStore();
    const deleted = store.deleteAsset(params.id);
    return { success: deleted };
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // CONTEXT TERM OPERATIONS
  // ─────────────────────────────────────────────────────────────────────────────

  "imageStudio.createContextTerm": async (
    ctx: GatewayRequestHandlerOptions,
    params: {
      term: string;
      aliases?: string[];
      description?: string;
      assetIds?: string[];
      primaryAssetId?: string;
      promptInjection?: string;
      autoInject?: boolean;
    },
  ) => {
    const store = getImageStudioStore();
    const contextTerm = store.createContextTerm(params);
    return { success: true, contextTerm };
  },

  "imageStudio.listContextTerms": async (ctx: GatewayRequestHandlerOptions) => {
    const store = getImageStudioStore();
    const terms = store.listContextTerms();
    return { contextTerms: terms, count: terms.length };
  },

  "imageStudio.getContextTerm": async (
    ctx: GatewayRequestHandlerOptions,
    params: { termOrId: string },
  ) => {
    const store = getImageStudioStore();
    const term = store.getContextTerm(params.termOrId);
    if (!term) return { error: "Context term not found" };
    return { contextTerm: term };
  },

  "imageStudio.updateContextTerm": async (
    ctx: GatewayRequestHandlerOptions,
    params: {
      id: string;
      aliases?: string[];
      description?: string;
      assetIds?: string[];
      primaryAssetId?: string;
      promptInjection?: string;
      negativePrompt?: string;
      autoInject?: boolean;
      priority?: number;
    },
  ) => {
    const store = getImageStudioStore();
    const { id, ...updates } = params;
    const term = store.updateContextTerm(id, updates);
    if (!term) return { error: "Context term not found" };
    return { success: true, contextTerm: term };
  },

  "imageStudio.deleteContextTerm": async (
    ctx: GatewayRequestHandlerOptions,
    params: { id: string },
  ) => {
    const store = getImageStudioStore();
    const deleted = store.deleteContextTerm(params.id);
    return { success: deleted };
  },

  "imageStudio.linkAssetToTerm": async (
    ctx: GatewayRequestHandlerOptions,
    params: { assetId: string; term: string },
  ) => {
    const store = getImageStudioStore();
    store.linkAssetToContextTerm(params.assetId, params.term);
    return { success: true };
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // PROMPT PROCESSING
  // ─────────────────────────────────────────────────────────────────────────────

  "imageStudio.processPrompt": async (
    ctx: GatewayRequestHandlerOptions,
    params: { prompt: string },
  ) => {
    const store = getImageStudioStore();
    const result = store.processPromptWithContext(params.prompt);

    return {
      originalPrompt: params.prompt,
      processedPrompt: result.processedPrompt,
      contextTermsUsed: result.contextTermsUsed.map((ct) => ct.term),
      assetsToUse: result.assetsToUse.map((a) => ({
        id: a.id,
        name: a.name,
        filePath: a.filePath,
        type: a.type,
      })),
      promptAdditions: result.promptAdditions,
    };
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // GENERATION HISTORY
  // ─────────────────────────────────────────────────────────────────────────────

  "imageStudio.getHistory": async (
    ctx: GatewayRequestHandlerOptions,
    params: { limit?: number },
  ) => {
    const store = getImageStudioStore();
    const history = store.getGenerationHistory(params.limit);
    return { history, count: history.length };
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // QUICK SETUP
  // ─────────────────────────────────────────────────────────────────────────────

  "imageStudio.setupPersonalContext": async (
    ctx: GatewayRequestHandlerOptions,
    params: {
      faceImagePaths: string[];
      name?: string;
    },
  ) => {
    const store = getImageStudioStore();
    const { faceImagePaths, name = "Subject" } = params;

    // Add face assets
    const assetIds: string[] = [];
    for (let i = 0; i < faceImagePaths.length; i++) {
      const asset = store.addAsset({
        name: `${name} Face ${i + 1}`,
        filePath: faceImagePaths[i],
        type: "face",
        tags: ["person", "face", "reference"],
        contextTerms: ["me", "myself", "I"],
      });
      assetIds.push(asset.id);
    }

    // Create/update "me" context term
    let meTerm = store.getContextTerm("me");
    if (meTerm) {
      store.updateContextTerm(meTerm.id, {
        assetIds: [...meTerm.assetIds, ...assetIds],
        primaryAssetId: meTerm.primaryAssetId || assetIds[0],
      });
    } else {
      meTerm = store.createContextTerm({
        term: "me",
        aliases: ["myself", "I", "my face", "my photo"],
        description: `Reference images of ${name}`,
        assetIds,
        primaryAssetId: assetIds[0],
        promptInjection: "maintaining exact face consistency with provided reference photos",
        autoInject: true,
      });
    }

    return {
      success: true,
      assetsAdded: assetIds.length,
      contextTerm: meTerm,
    };
  },
};
