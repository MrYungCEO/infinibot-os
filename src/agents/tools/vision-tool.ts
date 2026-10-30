/**
 * Vision Tool
 * Allows agents to see via webcam/screen capture with dual pipeline
 * - Local: Fast real-time (MiniCPM-V via Ollama)
 * - Claude: Quality analysis (Claude Vision API)
 */

import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { readStringParam } from "./common.js";
import { callGatewayTool, type GatewayCallOptions } from "./gateway.js";

const VisionToolSchema = Type.Object({
  action: Type.Union([
    Type.Literal("look"),
    Type.Literal("capture"),
    Type.Literal("analyze"),
    Type.Literal("describe"),
    Type.Literal("status"),
    Type.Literal("devices"),
    Type.Literal("cleanup"),
  ], {
    description: "Action to perform: look (capture+analyze), capture (just capture), analyze (analyze existing), describe (quick description), status (system status), devices (list cameras), cleanup (remove old frames)"
  }),
  device: Type.Optional(
    Type.Union([Type.Literal("webcam"), Type.Literal("screen"), Type.Literal("stream")], {
      description: "Capture device - webcam (default), screen, or stream (UI video feed)"
    })
  ),
  prompt: Type.Optional(
    Type.String({ description: "What to look for or analyze" })
  ),
  backend: Type.Optional(
    Type.Union([Type.Literal("local"), Type.Literal("claude"), Type.Literal("auto")], {
      description: "Vision backend - local (fast, ~200-400ms), claude (quality, ~2-3s), auto (routes by complexity)"
    })
  ),
  imagePath: Type.Optional(
    Type.String({ description: "Path to existing image (for analyze action)" })
  ),
  urgency: Type.Optional(
    Type.Union([Type.Literal("realtime"), Type.Literal("quality"), Type.Literal("auto")], {
      description: "Urgency level affects backend selection"
    })
  ),
});

export function createVisionTool(): AnyAgentTool {
  return {
    label: "Vision",
    name: "vision",
    description: `See and analyze what's visible through webcam, screen capture, or UI video feed.

Actions:
- look: Capture + analyze in one step (most common)
- capture: Just capture a frame (returns path)
- analyze: Analyze an existing image
- describe: Quick 1-2 sentence description (always fast/local)
- status: Check vision system status
- devices: List available cameras
- cleanup: Remove old captured frames

Devices:
- webcam: Direct webcam capture via ffmpeg (default)
- screen: Desktop screen capture
- stream: UI video feed panel (live preview in grid)

Backends:
- local: Fast (~200-400ms), uses MiniCPM-V via Ollama
- claude: Quality (~2-3s), uses Claude Vision API
- auto: Routes based on prompt complexity (default)

Examples:
- "What's on my screen?" → look + screen + auto
- "Read the text in this document" → look + screen + claude (complex)
- "Quick, what am I holding?" → describe + webcam (fastest)
- "What do you see?" → look + stream + auto (uses UI video feed if active)`,

    parameters: VisionToolSchema,

    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const device = readStringParam(params, "device") ?? "webcam";
      const prompt = readStringParam(params, "prompt") ?? "What do you see?";
      const backend = readStringParam(params, "backend") ?? "auto";
      const imagePath = readStringParam(params, "imagePath");
      const urgency = readStringParam(params, "urgency") ?? "auto";

      const gatewayOpts: GatewayCallOptions = { timeoutMs: 30_000 };

      try {
        switch (action) {
          case "look": {
            const result = await callGatewayTool<any>("vision.look", gatewayOpts, {
              device,
              prompt,
              backend,
            });

            const text = `[${(result.backend as string).toUpperCase()} | ${result.latencyMs}ms]\n\n${result.description}`;
            return {
              content: [{ type: "text", text }],
              details: result,
            };
          }

          case "capture": {
            const result = await callGatewayTool<any>("vision.capture", gatewayOpts, { device });

            return {
              content: [{ type: "text", text: `📷 Captured: ${result.path}` }],
              details: result,
            };
          }

          case "analyze": {
            if (!imagePath) {
              return {
                content: [{ type: "text", text: "❌ imagePath required for analyze action" }],
                details: { error: "imagePath required" },
              };
            }

            const result = await callGatewayTool<any>("vision.analyze", gatewayOpts, {
              imagePath,
              prompt,
              backend,
              urgency,
            });

            const text = `[${(result.backend as string).toUpperCase()} | ${result.latencyMs}ms]\n\n${result.description}`;
            return {
              content: [{ type: "text", text }],
              details: result,
            };
          }

          case "describe": {
            const result = await callGatewayTool<any>("vision.describe", gatewayOpts, { device });

            return {
              content: [{ type: "text", text: `👁️ ${result.description}` }],
              details: result,
            };
          }

          case "status": {
            const result = await callGatewayTool<any>("vision.status", gatewayOpts, {});

            const localStatus = result.local.modelLoaded
              ? `✅ Local: ${result.local.model} loaded`
              : `⚠️ Local: ${result.local.model} not loaded`;
            const claudeStatus = result.claude.status === "configured"
              ? "✅ Claude: API key configured"
              : "❌ Claude: Missing API key";

            const text = `Vision Status:\n${localStatus}\n${claudeStatus}\nFrames buffered: ${result.framesStored}`;
            return {
              content: [{ type: "text", text }],
              details: result,
            };
          }

          case "devices": {
            const result = await callGatewayTool<any>("vision.devices", gatewayOpts, {});

            const webcams = result.webcams.length > 0
              ? result.webcams.map((d: string) => `  • ${d}`).join("\n")
              : "  (none detected)";

            const text = `Available Devices:\nWebcams:\n${webcams}\nScreen: ${result.screen ? "available" : "unavailable"}`;
            return {
              content: [{ type: "text", text }],
              details: result,
            };
          }

          case "cleanup": {
            const result = await callGatewayTool<any>("vision.cleanup", gatewayOpts, {});

            return {
              content: [{ type: "text", text: `🧹 Cleaned up ${result.deleted} old frames. ${result.remaining} remaining.` }],
              details: result,
            };
          }

          default:
            return {
              content: [{ type: "text", text: `❌ Unknown action: ${action}` }],
              details: { error: `Unknown action: ${action}` },
            };
        }
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `❌ Vision error: ${error.message || String(error)}` }],
          details: { error: error.message || String(error) },
        };
      }
    },
  };
}
