/**
 * Image Studio MCP Server — Context-aware image generation control
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { getImageStudioStore } from "./store.js";
import type { AssetType } from "./types.js";

// ═══════════════════════════════════════════════════════════════════════════════
// MCP SERVER SETUP
// ═══════════════════════════════════════════════════════════════════════════════

const server = new Server(
  {
    name: "image-studio",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// TOOLS
// ═══════════════════════════════════════════════════════════════════════════════

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // Asset Management
    {
      name: "add_asset",
      description: "Add a reference image/asset to the library",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Asset name" },
          filePath: { type: "string", description: "Path to the image file" },
          type: {
            type: "string",
            enum: ["face", "person", "object", "style", "background", "logo", "texture", "other"],
            description: "Asset type",
          },
          description: { type: "string", description: "Optional description" },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Tags for categorization",
          },
          contextTerms: {
            type: "array",
            items: { type: "string" },
            description: "Context terms to associate (e.g., 'me', 'my car')",
          },
        },
        required: ["name", "filePath", "type"],
      },
    },
    {
      name: "list_assets",
      description: "List all assets in the library",
      inputSchema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["face", "person", "object", "style", "background", "logo", "texture", "other"],
            description: "Filter by asset type",
          },
          limit: { type: "number", description: "Max results (default 50)" },
        },
      },
    },
    {
      name: "search_assets",
      description: "Search assets by query, tags, or context term",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          type: { type: "string", description: "Filter by type" },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Filter by tags",
          },
          contextTerm: { type: "string", description: "Filter by context term" },
          limit: { type: "number", description: "Max results" },
        },
      },
    },
    {
      name: "get_asset",
      description: "Get a specific asset by ID",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Asset ID" },
        },
        required: ["id"],
      },
    },
    {
      name: "delete_asset",
      description: "Delete an asset from the library",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Asset ID to delete" },
        },
        required: ["id"],
      },
    },

    // Context Terms
    {
      name: "create_context_term",
      description: "Create a context term (e.g., 'me' mapped to face references)",
      inputSchema: {
        type: "object",
        properties: {
          term: { type: "string", description: "The term (e.g., 'me', 'my car')" },
          aliases: {
            type: "array",
            items: { type: "string" },
            description: "Alternative terms (e.g., 'myself', 'I')",
          },
          description: { type: "string", description: "What this term represents" },
          assetIds: {
            type: "array",
            items: { type: "string" },
            description: "Asset IDs to associate",
          },
          primaryAssetId: { type: "string", description: "Main reference asset" },
          promptInjection: {
            type: "string",
            description: "Additional prompt text when term is detected",
          },
          autoInject: {
            type: "boolean",
            description: "Auto-inject when term detected (default true)",
          },
        },
        required: ["term"],
      },
    },
    {
      name: "list_context_terms",
      description: "List all context terms",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_context_term",
      description: "Get a context term by term or ID",
      inputSchema: {
        type: "object",
        properties: {
          termOrId: { type: "string", description: "The term or ID" },
        },
        required: ["termOrId"],
      },
    },
    {
      name: "update_context_term",
      description: "Update a context term",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Context term ID" },
          aliases: { type: "array", items: { type: "string" } },
          description: { type: "string" },
          assetIds: { type: "array", items: { type: "string" } },
          primaryAssetId: { type: "string" },
          promptInjection: { type: "string" },
          autoInject: { type: "boolean" },
          priority: { type: "number" },
        },
        required: ["id"],
      },
    },
    {
      name: "delete_context_term",
      description: "Delete a context term",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Context term ID" },
        },
        required: ["id"],
      },
    },
    {
      name: "link_asset_to_term",
      description: "Link an asset to a context term",
      inputSchema: {
        type: "object",
        properties: {
          assetId: { type: "string", description: "Asset ID" },
          term: { type: "string", description: "Context term" },
        },
        required: ["assetId", "term"],
      },
    },

    // Generation
    {
      name: "process_prompt",
      description: "Process a prompt and show what context would be injected",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "The generation prompt" },
        },
        required: ["prompt"],
      },
    },
    {
      name: "get_generation_history",
      description: "Get recent generation history",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max results (default 50)" },
        },
      },
    },
  ],
}));

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  const args = rawArgs || {};
  const store = getImageStudioStore();

  try {
    switch (name) {
      // ─────────────────────────────────────────────────────────────────────────
      // ASSET OPERATIONS
      // ─────────────────────────────────────────────────────────────────────────
      
      case "add_asset": {
        const asset = store.addAsset({
          name: args.name as string,
          filePath: args.filePath as string,
          type: args.type as AssetType,
          description: args.description as string | undefined,
          tags: args.tags as string[] | undefined,
          contextTerms: args.contextTerms as string[] | undefined,
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: true, asset }, null, 2),
          }],
        };
      }

      case "list_assets": {
        const assets = store.listAssets(
          args.type as AssetType | undefined,
          args.limit as number | undefined
        );
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ assets, count: assets.length }, null, 2),
          }],
        };
      }

      case "search_assets": {
        const assets = store.searchAssets({
          query: args.query as string | undefined,
          type: args.type as AssetType | undefined,
          tags: args.tags as string[] | undefined,
          contextTerm: args.contextTerm as string | undefined,
          limit: args.limit as number | undefined,
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ assets, count: assets.length }, null, 2),
          }],
        };
      }

      case "get_asset": {
        const asset = store.getAsset(args.id as string);
        if (!asset) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "Asset not found" }) }],
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify({ asset }, null, 2) }],
        };
      }

      case "delete_asset": {
        const deleted = store.deleteAsset(args.id as string);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: deleted }),
          }],
        };
      }

      // ─────────────────────────────────────────────────────────────────────────
      // CONTEXT TERM OPERATIONS
      // ─────────────────────────────────────────────────────────────────────────

      case "create_context_term": {
        const contextTerm = store.createContextTerm({
          term: args.term as string,
          aliases: args.aliases as string[] | undefined,
          description: args.description as string | undefined,
          assetIds: args.assetIds as string[] | undefined,
          primaryAssetId: args.primaryAssetId as string | undefined,
          promptInjection: args.promptInjection as string | undefined,
          autoInject: args.autoInject as boolean | undefined,
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: true, contextTerm }, null, 2),
          }],
        };
      }

      case "list_context_terms": {
        const terms = store.listContextTerms();
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ contextTerms: terms, count: terms.length }, null, 2),
          }],
        };
      }

      case "get_context_term": {
        const term = store.getContextTerm(args.termOrId as string);
        if (!term) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "Context term not found" }) }],
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify({ contextTerm: term }, null, 2) }],
        };
      }

      case "update_context_term": {
        const { id, ...updates } = args;
        const term = store.updateContextTerm(id as string, updates);
        if (!term) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "Context term not found" }) }],
          };
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: true, contextTerm: term }, null, 2),
          }],
        };
      }

      case "delete_context_term": {
        const deleted = store.deleteContextTerm(args.id as string);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: deleted }),
          }],
        };
      }

      case "link_asset_to_term": {
        store.linkAssetToContextTerm(args.assetId as string, args.term as string);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: true }),
          }],
        };
      }

      // ─────────────────────────────────────────────────────────────────────────
      // GENERATION
      // ─────────────────────────────────────────────────────────────────────────

      case "process_prompt": {
        const result = store.processPromptWithContext(args.prompt as string);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              originalPrompt: args.prompt,
              processedPrompt: result.processedPrompt,
              contextTermsUsed: result.contextTermsUsed.map(ct => ct.term),
              assetsToUse: result.assetsToUse.map(a => ({
                id: a.id,
                name: a.name,
                filePath: a.filePath,
                type: a.type,
              })),
              promptAdditions: result.promptAdditions,
            }, null, 2),
          }],
        };
      }

      case "get_generation_history": {
        const history = store.getGenerationHistory(args.limit as number | undefined);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ history, count: history.length }, null, 2),
          }],
        };
      }

      default:
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
        };
    }
  } catch (error) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ error: String(error) }),
      }],
    };
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// RESOURCES (expose assets as MCP resources)
// ═══════════════════════════════════════════════════════════════════════════════

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const store = getImageStudioStore();
  const assets = store.listAssets();
  
  return {
    resources: assets.map(asset => ({
      uri: `image-studio://assets/${asset.id}`,
      name: asset.name,
      description: asset.description || `${asset.type} asset`,
      mimeType: asset.mimeType,
    })),
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  const store = getImageStudioStore();
  
  // Parse URI: image-studio://assets/{id}
  const match = uri.match(/^image-studio:\/\/assets\/(.+)$/);
  if (!match) {
    throw new Error(`Invalid URI: ${uri}`);
  }
  
  const asset = store.getAsset(match[1]);
  if (!asset) {
    throw new Error(`Asset not found: ${match[1]}`);
  }
  
  return {
    contents: [{
      uri,
      mimeType: "application/json",
      text: JSON.stringify(asset, null, 2),
    }],
  };
});

// ═══════════════════════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Image Studio MCP Server running on stdio");
}

main().catch(console.error);
