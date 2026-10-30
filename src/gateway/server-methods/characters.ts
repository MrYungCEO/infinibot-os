/**
 * Characters gateway handlers — CRUD for character references.
 * Used for consistent image generation with saved character designs.
 */

import {
  initCharacterStore,
  createCharacter,
  createCharacterFromBase64,
  getCharacter,
  listCharacters,
  addCharacterImage,
  addCharacterImageFromBase64,
  updateCharacter,
  deleteCharacter,
  deleteCharacterImage,
  setPrimaryImage,
  searchCharacters,
} from "../../characters/store.js";
import { STATE_DIR } from "../../config/paths.js";
import { proxyMethodsToMaster } from "../../federation/satellite-context.js";
import type { GatewayRequestHandlers } from "./types.js";

// Lazy store initialization - called on first handler use to ensure env vars are set
let storeInitialized = false;
const ensureStore = () => {
  if (storeInitialized) return;
  console.log("[characters] Initializing store with stateDir:", STATE_DIR);
  initCharacterStore(STATE_DIR);
  storeInitialized = true;
};

const _rawCharacterHandlers: GatewayRequestHandlers = {
  "characters.list": async ({ params, respond }) => {
    ensureStore();
    try {
      const { tag } = (params ?? {}) as { tag?: string };
      const characters = listCharacters(tag);
      respond(true, { characters });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "characters.get": async ({ params, respond }) => {
    ensureStore();
    try {
      const { id, slug, name } = params as { id?: string; slug?: string; name?: string };
      const idOrSlug = id || slug || name;
      if (!idOrSlug) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id, slug, or name required" });
        return;
      }
      const character = getCharacter(idOrSlug);
      respond(true, { character });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "characters.create": async ({ params, respond }) => {
    ensureStore();
    try {
      const p = params as {
        name: string;
        imagePath?: string;
        imageData?: string; // base64
        filename?: string;
        description?: string;
        tags?: string[];
        label?: string;
      };
      
      if (!p.name) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "name required" });
        return;
      }
      
      if (!p.imagePath && !p.imageData) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "imagePath or imageData required" });
        return;
      }
      
      let character;
      if (p.imageData) {
        // Base64 upload
        character = createCharacterFromBase64(
          p.name,
          p.imageData,
          p.filename || "upload.png",
          p.description || "",
          p.tags || [],
          p.label || "primary"
        );
      } else {
        // File path
        character = createCharacter(
          p.name,
          p.imagePath!,
          p.description || "",
          p.tags || [],
          p.label || "primary"
        );
      }
      
      if (!character) {
        respond(false, undefined, { code: "CONFLICT", message: "Character already exists or image not found" });
        return;
      }
      
      respond(true, { character });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "characters.update": async ({ params, respond }) => {
    ensureStore();
    try {
      const p = params as {
        id?: string;
        slug?: string;
        name?: string;
        description?: string;
        tags?: string[];
      };
      
      const idOrSlug = p.id || p.slug;
      if (!idOrSlug) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id or slug required" });
        return;
      }
      
      const updates: any = {};
      if (p.name !== undefined) updates.name = p.name;
      if (p.description !== undefined) updates.description = p.description;
      if (p.tags !== undefined) updates.tags = p.tags;
      
      const character = updateCharacter(idOrSlug, updates);
      if (!character) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Character not found" });
        return;
      }
      
      respond(true, { character });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "characters.delete": async ({ params, respond }) => {
    ensureStore();
    try {
      const { id, slug } = params as { id?: string; slug?: string };
      const idOrSlug = id || slug;
      if (!idOrSlug) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id or slug required" });
        return;
      }
      
      const success = deleteCharacter(idOrSlug);
      if (!success) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Character not found" });
        return;
      }
      
      respond(true, { success: true });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "characters.addImage": async ({ params, respond }) => {
    ensureStore();
    try {
      const p = params as {
        id?: string;
        slug?: string;
        imagePath?: string;
        imageData?: string; // base64 data
        filename?: string;
        label?: string;
      };
      
      const idOrSlug = p.id || p.slug;
      if (!idOrSlug) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id or slug required" });
        return;
      }
      
      if (!p.imagePath && !p.imageData) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "imagePath or imageData required" });
        return;
      }
      
      let image;
      if (p.imageData) {
        // Base64 upload from browser
        image = addCharacterImageFromBase64(
          idOrSlug, 
          p.imageData, 
          p.filename || "upload.png",
          p.label || "reference"
        );
      } else {
        // File path upload
        image = addCharacterImage(idOrSlug, p.imagePath!, p.label || "reference");
      }
      
      if (!image) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Character not found or image not found" });
        return;
      }
      
      respond(true, { image });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "characters.deleteImage": async ({ params, respond }) => {
    ensureStore();
    try {
      const { imageId } = params as { imageId: string };
      if (!imageId) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "imageId required" });
        return;
      }
      
      const success = deleteCharacterImage(imageId);
      if (!success) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Image not found" });
        return;
      }
      
      respond(true, { success: true });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "characters.setPrimary": async ({ params, respond }) => {
    ensureStore();
    try {
      const p = params as { id?: string; slug?: string; imageId: string };
      const idOrSlug = p.id || p.slug;
      if (!idOrSlug || !p.imageId) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id/slug and imageId required" });
        return;
      }
      
      const success = setPrimaryImage(idOrSlug, p.imageId);
      if (!success) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Character or image not found" });
        return;
      }
      
      respond(true, { success: true });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "characters.search": async ({ params, respond }) => {
    ensureStore();
    try {
      const { query } = params as { query: string };
      if (!query) {
        respond(true, { characters: [] });
        return;
      }
      
      const characters = searchCharacters(query);
      respond(true, { characters });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};

// In satellite mode, every method that touches the shared character registry
// proxies to master so all devices see the same characters and images.
// `characters.create` / `characters.addImage` still take an optional
// `imagePath` arg — when proxied, that path is interpreted on master, so the
// browser-side base64 (`imageData`) path is the supported satellite flow.
export const characterHandlers: GatewayRequestHandlers = proxyMethodsToMaster(
  _rawCharacterHandlers,
  [
    "characters.list",
    "characters.get",
    "characters.create",
    "characters.update",
    "characters.delete",
    "characters.addImage",
    "characters.deleteImage",
    "characters.setPrimary",
    "characters.search",
  ],
);
