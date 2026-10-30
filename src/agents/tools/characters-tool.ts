/**
 * Characters Tool — Agent tool for managing character references
 * Used for consistent image generation with saved character designs.
 */

import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  initCharacterStore,
  createCharacter,
  getCharacter,
  listCharacters,
  addCharacterImage,
  updateCharacter,
  deleteCharacter,
  deleteCharacterImage,
  setPrimaryImage,
  searchCharacters,
  type CharacterSummary,
} from "../../characters/store.js";
import { STATE_DIR } from "../../config/paths.js";

const log = createSubsystemLogger("characters-tool");

// Lazy store initialization - called on first use to ensure env vars are set
let storeInitialized = false;
function ensureStore(): void {
  if (storeInitialized) return;
  log.info("Initializing character store", { stateDir: STATE_DIR });
  initCharacterStore(STATE_DIR);
  storeInitialized = true;
}

// ── Schema ──────────────────────────────────

const CharactersToolSchema = Type.Object({
  action: stringEnum([
    "list",
    "get",
    "create",
    "update",
    "delete",
    "add_image",
    "delete_image",
    "set_primary",
    "search",
  ]),
  // Identifiers
  id: Type.Optional(Type.String()),
  slug: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  imageId: Type.Optional(Type.String()),
  // Create/Update fields
  imagePath: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  tags: Type.Optional(Type.String()),
  label: Type.Optional(Type.String()),
  // Search/Filter
  query: Type.Optional(Type.String()),
  tag: Type.Optional(Type.String()),
});

// ── Tool Factory ──────────────────────────────────

export function createCharactersTool(): AnyAgentTool {
  return {
    label: "Characters",
    name: "characters",
    description: `Manage saved character references for consistent image generation.

Actions:
- list: List all saved characters (optional tag filter)
- get: Get character details and all image paths
- create: Save new character with reference image
- update: Update character name/description/tags
- delete: Delete character and all images
- add_image: Add another reference image to character
- delete_image: Remove specific image from character
- set_primary: Set which image is primary reference
- search: Search characters by name/description/tags

Examples:
- List all: { action: "list" }
- List by tag: { action: "list", tag: "anime" }
- Get character: { action: "get", name: "SF Bear" }
- Create: { action: "create", name: "Hero", imagePath: "/path/to/image.png", description: "tall warrior", tags: "fantasy,warrior" }
- Add image: { action: "add_image", name: "SF Bear", imagePath: "/path/to/new.png", label: "side view" }
- Search: { action: "search", query: "military" }

Use the primary_image path with image generation tools (-i flag) for consistency.`,
    parameters: CharactersToolSchema,

    execute: async (_toolCallId, args) => {
      // Ensure store is initialized on first use
      ensureStore();

      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action");

      try {
        switch (action) {
          case "list": {
            const tag = readStringParam(params, "tag");
            const characters = listCharacters(tag || undefined);

            if (!characters.length) {
              return jsonResult({ message: "No characters saved yet." });
            }

            const lines = ["🎭 Saved Characters:\n"];
            for (const char of characters) {
              lines.push(`• ${char.name} (${char.slug})`);
              lines.push(`  Images: ${char.imageCount} | Tags: ${char.tags.join(", ") || "none"}`);
              if (char.primaryImage) {
                lines.push(`  Primary: ${char.primaryImage}`);
              }
              lines.push("");
            }
            return jsonResult({ message: lines.join("\n"), characters });
          }

          case "get": {
            const idOrSlug =
              readStringParam(params, "id") ||
              readStringParam(params, "slug") ||
              readStringParam(params, "name");

            if (!idOrSlug) {
              return jsonResult({ error: "Provide id, slug, or name" });
            }

            const character = getCharacter(idOrSlug);
            if (!character) {
              return jsonResult({ error: `Character "${idOrSlug}" not found.` });
            }

            const lines = [
              `🎭 ${character.name}`,
              `ID: ${character.id}`,
              `Slug: ${character.slug}`,
              `Description: ${character.description || "None"}`,
              `Tags: ${character.tags.join(", ") || "None"}`,
              "",
              "Reference Images:",
            ];

            for (const img of character.images) {
              const primary = img.isPrimary ? " ⭐" : "";
              lines.push(`  • [${img.label}]${primary} ${img.path}`);
            }

            const primaryImg = character.images.find((i) => i.isPrimary);
            if (primaryImg) {
              lines.push("");
              lines.push(`PRIMARY_IMAGE: ${primaryImg.path}`);
            }

            return jsonResult({ message: lines.join("\n"), character });
          }

          case "create": {
            const name = readStringParam(params, "name");
            const imagePath = readStringParam(params, "imagePath");

            if (!name || !imagePath) {
              return jsonResult({ error: "name and imagePath required" });
            }

            const description = readStringParam(params, "description") || "";
            const tagsStr = readStringParam(params, "tags") || "";
            const label = readStringParam(params, "label") || "primary";

            const tags = tagsStr ? tagsStr.split(",").map((t) => t.trim()) : [];

            const character = createCharacter(name, imagePath, description, tags, label);

            if (!character) {
              return jsonResult({ error: "Character already exists or image not found" });
            }

            return jsonResult({
              message: `✅ Character "${character.name}" created!\nSlug: ${character.slug}\nPrimary image: ${character.images[0]?.path}`,
              character,
            });
          }

          case "update": {
            const idOrSlug = readStringParam(params, "id") || readStringParam(params, "slug");
            if (!idOrSlug) {
              return jsonResult({ error: "id or slug required" });
            }

            const name = readStringParam(params, "name");
            const description = readStringParam(params, "description");
            const tagsStr = readStringParam(params, "tags");

            const updates: { name?: string; description?: string; tags?: string[] } = {};
            if (name) updates.name = name;
            if (description !== undefined) updates.description = description;
            if (tagsStr) updates.tags = tagsStr.split(",").map((t) => t.trim());

            const character = updateCharacter(idOrSlug, updates);
            if (!character) {
              return jsonResult({ error: "Character not found" });
            }

            return jsonResult({ message: `✅ Character "${character.name}" updated.`, character });
          }

          case "delete": {
            const idOrSlug =
              readStringParam(params, "id") ||
              readStringParam(params, "slug") ||
              readStringParam(params, "name");

            if (!idOrSlug) {
              return jsonResult({ error: "id, slug, or name required" });
            }

            const success = deleteCharacter(idOrSlug);
            if (!success) {
              return jsonResult({ error: "Character not found" });
            }

            return jsonResult({ message: "🗑️ Character deleted.", success: true });
          }

          case "add_image": {
            const idOrSlug =
              readStringParam(params, "id") ||
              readStringParam(params, "slug") ||
              readStringParam(params, "name");
            const imagePath = readStringParam(params, "imagePath");

            if (!idOrSlug || !imagePath) {
              return jsonResult({ error: "id/slug/name and imagePath required" });
            }

            const label = readStringParam(params, "label") || "reference";

            const image = addCharacterImage(idOrSlug, imagePath, label);
            if (!image) {
              return jsonResult({ error: "Character not found or image not found" });
            }

            return jsonResult({ message: `✅ Image added: ${image.path} [${image.label}]`, image });
          }

          case "delete_image": {
            const imageId = readStringParam(params, "imageId");
            if (!imageId) {
              return jsonResult({ error: "imageId required" });
            }

            const success = deleteCharacterImage(imageId);
            if (!success) {
              return jsonResult({ error: "Image not found" });
            }

            return jsonResult({ message: "🗑️ Image deleted.", success: true });
          }

          case "set_primary": {
            const idOrSlug =
              readStringParam(params, "id") ||
              readStringParam(params, "slug") ||
              readStringParam(params, "name");
            const imageId = readStringParam(params, "imageId");

            if (!idOrSlug || !imageId) {
              return jsonResult({ error: "id/slug/name and imageId required" });
            }

            const success = setPrimaryImage(idOrSlug, imageId);
            if (!success) {
              return jsonResult({ error: "Character or image not found" });
            }

            return jsonResult({ message: "⭐ Primary image updated.", success: true });
          }

          case "search": {
            const query = readStringParam(params, "query");
            if (!query) {
              return jsonResult({ error: "query required" });
            }

            const characters = searchCharacters(query);
            if (!characters.length) {
              return jsonResult({ message: `No characters found matching "${query}"` });
            }

            const lines = [`🔍 Search results for "${query}":\n`];
            for (const char of characters) {
              lines.push(`• ${char.name} (${char.slug})`);
              lines.push(`  Images: ${char.imageCount} | Tags: ${char.tags.join(", ") || "none"}`);
              lines.push("");
            }

            return jsonResult({ message: lines.join("\n"), characters });
          }

          default:
            return jsonResult({ error: `Unknown action: ${action}` });
        }
      } catch (err: any) {
        log.error("Characters tool error:", err);
        return jsonResult({ error: err.message || String(err) });
      }
    },
  };
}

export default createCharactersTool;
