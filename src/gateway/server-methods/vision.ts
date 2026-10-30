/**
 * Vision Gateway Methods
 * Dual pipeline: Claude Vision (quality) + Local Ollama (real-time)
 */

import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import type { GatewayRequestHandlers } from "./types.js";
import { grim, captureMonitor, captureAll } from "../../desktop/backends/hyprland/capture.js";
import { listMonitors } from "../../desktop/backends/hyprland/ipc.js";

const execAsync = promisify(exec);

const isWindows = process.platform === "win32";

let hyprlandCheckCache: { available: boolean; checkedAt: number } | null = null;
const HYPRLAND_CHECK_TTL_MS = 30_000;

async function isHyprlandAvailable(): Promise<boolean> {
  if (hyprlandCheckCache && Date.now() - hyprlandCheckCache.checkedAt < HYPRLAND_CHECK_TTL_MS) {
    return hyprlandCheckCache.available;
  }

  let available = false;
  if (process.env.HYPRLAND_INSTANCE_SIGNATURE) {
    available = true;
  } else {
    try {
      await execAsync("hyprctl version", { timeout: 2000 });
      available = true;
    } catch {
      available = false;
    }
  }

  hyprlandCheckCache = { available, checkedAt: Date.now() };
  return available;
}

// Configuration
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const LOCAL_VISION_MODEL = process.env.LOCAL_VISION_MODEL || "minicpm-v:8b";
const FRAME_BUFFER_DIR = path.join(process.env.INFINIBOT_STATE_DIR || "state", "vision", "frames");

// UI Stream frame storage (pushed from browser via WebSocket)
let uiStreamFrame: { dataUrl: string; timestamp: number } | null = null;
const UI_STREAM_MAX_AGE_MS = 5000; // 5 seconds - frame must be fresh

/**
 * Set the latest frame from UI video feed
 * Called when UI pushes a frame via WebSocket
 */
export function setUIStreamFrame(dataUrl: string): void {
  uiStreamFrame = { dataUrl, timestamp: Date.now() };
}

/**
 * Get the latest UI stream frame if fresh
 */
function getUIStreamFrame(): string | null {
  if (!uiStreamFrame) return null;
  if (Date.now() - uiStreamFrame.timestamp > UI_STREAM_MAX_AGE_MS) {
    uiStreamFrame = null;
    return null;
  }
  return uiStreamFrame.dataUrl;
}

// Ensure frame buffer directory exists
function ensureFrameDir() {
  if (!fs.existsSync(FRAME_BUFFER_DIR)) {
    fs.mkdirSync(FRAME_BUFFER_DIR, { recursive: true });
  }
}

interface CaptureResult {
  path: string;
  timestamp: number;
  device: string;
  width?: number;
  height?: number;
}

interface AnalysisResult {
  description: string;
  backend: "local" | "claude";
  latencyMs: number;
  timestamp: number;
}

/**
 * Capture frame from webcam using ffmpeg
 */
async function captureWebcam(device = "video=USB Camera"): Promise<CaptureResult> {
  ensureFrameDir();
  const timestamp = Date.now();
  const outputPath = path.join(FRAME_BUFFER_DIR, `webcam_${timestamp}.jpg`);

  // Windows DirectShow capture
  const cmd = `ffmpeg -f dshow -i "${device}" -frames:v 1 -q:v 2 "${outputPath}" -y`;

  try {
    await execAsync(cmd, { timeout: 10000 });
    return {
      path: outputPath,
      timestamp,
      device: "webcam",
    };
  } catch (error: any) {
    throw new Error(`Webcam capture failed: ${error.message}`);
  }
}

/**
 * Capture screen on Hyprland via grim.
 * `monitor` is an index into the hyprctl monitor list; pass -1 to capture all.
 */
async function captureScreenHyprland(monitor = 0): Promise<CaptureResult> {
  ensureFrameDir();
  const timestamp = Date.now();
  const outputPath = path.join(FRAME_BUFFER_DIR, `screen_${timestamp}.png`);

  try {
    if (monitor < 0) {
      await captureAll(outputPath);
      return { path: outputPath, timestamp, device: "screen:hyprland:all" };
    }

    const monitors = await listMonitors();
    if (monitors.length === 0) {
      // No monitor info — fall back to grim with no args (captures all outputs).
      await grim(outputPath, {});
      return { path: outputPath, timestamp, device: "screen:hyprland:all" };
    }

    const target = monitors[monitor] ?? monitors.find((m) => m.focused) ?? monitors[0];
    await captureMonitor(target, outputPath);
    return {
      path: outputPath,
      timestamp,
      device: `screen:hyprland:${target.name}`,
      width: target.width,
      height: target.height,
    };
  } catch (error: any) {
    throw new Error(`Hyprland screen capture failed: ${error.message}`);
  }
}

/**
 * Capture screen using gdigrab on Windows.
 */
async function captureScreenWindows(): Promise<CaptureResult> {
  ensureFrameDir();
  const timestamp = Date.now();
  const outputPath = path.join(FRAME_BUFFER_DIR, `screen_${timestamp}.jpg`);

  const cmd = `ffmpeg -f gdigrab -framerate 1 -i desktop -frames:v 1 -q:v 2 "${outputPath}" -y`;

  try {
    await execAsync(cmd, { timeout: 10000 });
    return {
      path: outputPath,
      timestamp,
      device: "screen:windows",
    };
  } catch (error: any) {
    throw new Error(`Screen capture failed: ${error.message}`);
  }
}

/**
 * Capture screen — auto-selects Hyprland (grim) on Linux or gdigrab on Windows.
 */
async function captureScreen(monitor = 0): Promise<CaptureResult> {
  if (await isHyprlandAvailable()) {
    return captureScreenHyprland(monitor);
  }
  if (isWindows) {
    return captureScreenWindows();
  }
  throw new Error(
    "Screen capture unavailable: no Hyprland session detected and platform is not Windows. " +
      "Install Hyprland + grim, or run on Windows with ffmpeg.",
  );
}

/**
 * Analyze image with local Ollama vision model
 * Tries multiple API formats for compatibility with different models
 */
async function analyzeLocal(imagePath: string, prompt: string): Promise<AnalysisResult> {
  const startTime = Date.now();

  // Read image as base64
  const imageBuffer = fs.readFileSync(imagePath);
  const base64Image = imageBuffer.toString("base64");

  // Try llava first if available (most compatible)
  const modelsToTry = ["llava:7b", LOCAL_VISION_MODEL];

  for (const model of modelsToTry) {
    // Try /api/chat first (newer models)
    try {
      const chatResponse = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "user",
              content: prompt || "Describe what you see in this image.",
              images: [base64Image],
            },
          ],
          stream: false,
          options: { temperature: 0.3, num_predict: 500 },
        }),
      });

      if (chatResponse.ok) {
        const result = (await chatResponse.json()) as any;
        const content = result.message?.content || result.response;
        if (content) {
          return {
            description: content,
            backend: "local",
            latencyMs: Date.now() - startTime,
            timestamp: Date.now(),
          };
        }
      }
    } catch {
      /* try next */
    }

    // Try /api/generate (older format)
    try {
      const genResponse = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          prompt: prompt || "Describe what you see in this image.",
          images: [base64Image],
          stream: false,
          options: { temperature: 0.3, num_predict: 500 },
        }),
      });

      if (genResponse.ok) {
        const result = (await genResponse.json()) as any;
        if (result.response) {
          return {
            description: result.response,
            backend: "local",
            latencyMs: Date.now() - startTime,
            timestamp: Date.now(),
          };
        }
      }
    } catch {
      /* try next model */
    }
  }

  throw new Error("No compatible vision model available");
}

/**
 * Analyze image with Claude Vision API
 */
async function analyzeClaude(imagePath: string, prompt: string): Promise<AnalysisResult> {
  const startTime = Date.now();

  // Read image as base64
  const imageBuffer = fs.readFileSync(imagePath);
  const base64Image = imageBuffer.toString("base64");
  const mimeType = imagePath.endsWith(".png") ? "image/png" : "image/jpeg";

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not set");
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mimeType,
                data: base64Image,
              },
            },
            {
              type: "text",
              text: prompt || "Describe what you see in this image in detail.",
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Claude API error: ${response.status} - ${error}`);
  }

  const result = (await response.json()) as any;

  return {
    description: result.content[0].text,
    backend: "claude",
    latencyMs: Date.now() - startTime,
    timestamp: Date.now(),
  };
}

/**
 * Route vision request to appropriate backend
 */
function routeVisionRequest(
  prompt: string,
  urgency: "realtime" | "quality" | "auto",
): "local" | "claude" {
  if (urgency === "realtime") return "local";
  if (urgency === "quality") return "claude";

  // Auto-route based on prompt complexity
  const complexPatterns = [
    /read.*text/i,
    /what does.*say/i,
    /analyze.*detail/i,
    /compare/i,
    /explain.*diagram/i,
    /transcribe/i,
    /ocr/i,
    /document/i,
    /fine print/i,
    /small text/i,
  ];

  if (complexPatterns.some((p) => p.test(prompt))) return "claude";
  return "local";
}

// ═══════════════════════════════════════════════════════════════════════════════
// GATEWAY HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

export const visionHandlers: GatewayRequestHandlers = {
  /**
   * Capture a frame from camera or screen
   */
  "vision.capture": async ({ params, respond }) => {
    try {
      const device = typeof params.device === "string" ? params.device : "webcam";
      const monitor = typeof params.monitor === "number" ? params.monitor : 0;

      if (device === "screen") {
        const result = await captureScreen(monitor);
        respond(true, result);
      } else {
        const result = await captureWebcam();
        respond(true, result);
      }
    } catch (e) {
      respond(false, undefined, { code: "CAPTURE_ERROR", message: String(e) });
    }
  },

  /**
   * Analyze an image with vision model
   */
  "vision.analyze": async ({ params, respond }) => {
    try {
      const {
        imagePath,
        imageBase64,
        prompt = "What do you see?",
        backend = "auto",
        urgency = "auto",
      } = params as any;

      // Determine image path
      let actualPath = imagePath;

      if (imageBase64 && !imagePath) {
        // Save base64 to temp file
        ensureFrameDir();
        const timestamp = Date.now();
        actualPath = path.join(FRAME_BUFFER_DIR, `temp_${timestamp}.jpg`);
        const buffer = Buffer.from(imageBase64, "base64");
        fs.writeFileSync(actualPath, buffer);
      }

      if (!actualPath || !fs.existsSync(actualPath)) {
        respond(false, undefined, {
          code: "NO_IMAGE",
          message: "No image provided or image not found",
        });
        return;
      }

      // Route to backend
      const selectedBackend = backend === "auto" ? routeVisionRequest(prompt, urgency) : backend;

      const result =
        selectedBackend === "local"
          ? await analyzeLocal(actualPath, prompt)
          : await analyzeClaude(actualPath, prompt);

      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "ANALYZE_ERROR", message: String(e) });
    }
  },

  /**
   * Quick scene description (always uses local for speed)
   */
  "vision.describe": async ({ params, respond }) => {
    try {
      const device = typeof params.device === "string" ? params.device : "webcam";

      // Capture
      const capture = device === "screen" ? await captureScreen() : await captureWebcam();

      // Analyze with local model
      const analysis = await analyzeLocal(
        capture.path,
        "Briefly describe what you see in this image in 1-2 sentences.",
      );

      // Cleanup temp file
      try {
        fs.unlinkSync(capture.path);
      } catch {}

      respond(true, { ...analysis, device });
    } catch (e) {
      respond(false, undefined, { code: "DESCRIBE_ERROR", message: String(e) });
    }
  },

  /**
   * Capture and analyze in one call (convenience method)
   * Supports devices: webcam, screen, stream (UI video feed)
   */
  "vision.look": async ({ params, respond }) => {
    try {
      const device = typeof params.device === "string" ? params.device : "webcam";
      const prompt = typeof params.prompt === "string" ? params.prompt : "What do you see?";
      const backend = typeof params.backend === "string" ? params.backend : "auto";

      let imagePath: string;
      let captureTimestamp = Date.now();
      let shouldCleanup = true;

      if (device === "stream") {
        // Use UI video feed frame
        const streamFrame = getUIStreamFrame();
        if (!streamFrame) {
          respond(false, undefined, {
            code: "NO_STREAM",
            message: "No video feed available. Start the video feed in the grid UI first.",
          });
          return;
        }

        // Save base64 data URL to temp file
        ensureFrameDir();
        imagePath = path.join(FRAME_BUFFER_DIR, `stream_${captureTimestamp}.jpg`);

        // Extract base64 data from data URL
        const base64Match = streamFrame.match(/^data:image\/\w+;base64,(.+)$/);
        if (!base64Match) {
          respond(false, undefined, {
            code: "INVALID_FRAME",
            message: "Invalid frame data from UI",
          });
          return;
        }
        const buffer = Buffer.from(base64Match[1], "base64");
        fs.writeFileSync(imagePath, buffer);
      } else {
        // Traditional capture
        const capture = device === "screen" ? await captureScreen() : await captureWebcam();
        imagePath = capture.path;
        captureTimestamp = capture.timestamp;
      }

      // Route and analyze
      const selectedBackend = backend === "auto" ? routeVisionRequest(prompt, "auto") : backend;

      const analysis =
        selectedBackend === "local"
          ? await analyzeLocal(imagePath, prompt)
          : await analyzeClaude(imagePath, prompt);

      // Cleanup temp file
      if (shouldCleanup) {
        try {
          fs.unlinkSync(imagePath);
        } catch {}
      }

      respond(true, {
        ...analysis,
        device,
        captureTimestamp,
      });
    } catch (e) {
      respond(false, undefined, { code: "LOOK_ERROR", message: String(e) });
    }
  },

  /**
   * Push a frame from UI video feed
   * Called by browser via WebSocket
   */
  "vision.pushFrame": async ({ params, respond }) => {
    try {
      const dataUrl = typeof params.dataUrl === "string" ? params.dataUrl : "";

      if (!dataUrl.startsWith("data:image/")) {
        respond(false, undefined, {
          code: "INVALID_DATA",
          message: "Expected data URL with image",
        });
        return;
      }

      setUIStreamFrame(dataUrl);
      respond(true, { success: true, timestamp: Date.now() });
    } catch (e) {
      respond(false, undefined, { code: "PUSH_ERROR", message: String(e) });
    }
  },

  /**
   * Detect objects in image with bounding boxes
   * Returns boxes with labels and confidence scores
   * Uses local Ollama model with structured prompt for object detection
   */
  "vision.detect": async ({ params, respond }) => {
    try {
      const dataUrl = typeof params.dataUrl === "string" ? params.dataUrl : "";
      const mode = typeof params.mode === "string" ? params.mode : "scene";

      if (!dataUrl.startsWith("data:image/")) {
        respond(false, undefined, {
          code: "INVALID_DATA",
          message: "Expected data URL with image",
        });
        return;
      }

      // Save image to temp file
      ensureFrameDir();
      const timestamp = Date.now();
      const imagePath = path.join(FRAME_BUFFER_DIR, `detect_${timestamp}.jpg`);

      const base64Match = dataUrl.match(/^data:image\/\w+;base64,(.+)$/);
      if (!base64Match) {
        respond(false, undefined, { code: "INVALID_FORMAT", message: "Invalid base64 image data" });
        return;
      }

      const buffer = Buffer.from(base64Match[1], "base64");
      fs.writeFileSync(imagePath, buffer);

      const startTime = Date.now();

      let description = "";
      let boxes: Array<{
        label: string;
        confidence: number;
        x: number;
        y: number;
        width: number;
        height: number;
      }> = [];

      // Primary: Use local Ollama model for detection
      const detectPrompt =
        mode === "objects"
          ? `List the main objects in this image. For each object, estimate its position.
Format as: OBJECT: name | CONFIDENCE: 0.X | POSITION: left/center/right, top/middle/bottom
Then provide a brief description.
Example:
OBJECT: laptop | CONFIDENCE: 0.9 | POSITION: center, middle
OBJECT: coffee cup | CONFIDENCE: 0.8 | POSITION: right, bottom
DESCRIPTION: A workspace with a laptop and coffee cup.`
          : "Describe what you see in 1-2 sentences.";

      try {
        const localResult = await analyzeLocal(imagePath, detectPrompt);
        const text = localResult.description;

        if (mode === "objects" && text) {
          // Parse the structured response
          const lines = text.split("\n");
          const imgWidth = 640;
          const imgHeight = 480;

          for (const line of lines) {
            // Match OBJECT: ... | CONFIDENCE: ... | POSITION: ...
            const match = line.match(
              /OBJECT:\s*(.+?)\s*\|\s*CONFIDENCE:\s*([\d.]+)\s*\|\s*POSITION:\s*(.+)/i,
            );
            if (match) {
              const label = match[1].trim();
              const confidence = parseFloat(match[2]) || 0.8;
              const position = match[3].toLowerCase();

              // Convert position words to approximate coordinates
              let x = imgWidth * 0.3,
                y = imgHeight * 0.3;
              let width = imgWidth * 0.3,
                height = imgHeight * 0.3;

              if (position.includes("left")) x = imgWidth * 0.05;
              else if (position.includes("right")) x = imgWidth * 0.55;
              else if (position.includes("center")) x = imgWidth * 0.3;

              if (position.includes("top")) y = imgHeight * 0.05;
              else if (position.includes("bottom")) y = imgHeight * 0.55;
              else if (position.includes("middle")) y = imgHeight * 0.3;

              boxes.push({
                label,
                confidence,
                x: Math.round(x),
                y: Math.round(y),
                width: Math.round(width),
                height: Math.round(height),
              });
            }

            // Get description
            const descMatch = line.match(/DESCRIPTION:\s*(.+)/i);
            if (descMatch) {
              description = descMatch[1].trim();
            }
          }

          // If no structured description found, use whole text
          if (!description) {
            description =
              text
                .replace(/OBJECT:.*$/gim, "")
                .trim()
                .split("\n")
                .pop() || text;
          }
        } else {
          description = text;
        }
      } catch (localErr) {
        console.warn("[vision.detect] Local analysis failed:", localErr);
        description =
          "Local vision model unavailable. Try installing llava:7b with: ollama pull llava:7b";
      }

      // Cleanup
      try {
        fs.unlinkSync(imagePath);
      } catch {}

      respond(true, {
        boxes,
        description,
        mode,
        latencyMs: Date.now() - startTime,
        timestamp: Date.now(),
      });
    } catch (e) {
      respond(false, undefined, { code: "DETECT_ERROR", message: String(e) });
    }
  },

  /**
   * List available capture devices
   */
  "vision.devices": async ({ respond }) => {
    try {
      // List DirectShow devices on Windows
      let videoDevices: string[] = [];
      if (isWindows) {
        try {
          const { stderr } = await execAsync("ffmpeg -list_devices true -f dshow -i dummy", {
            timeout: 5000,
          }).catch((e) => ({ stderr: e.stderr || "" }));

          const lines = stderr.split("\n");
          let inVideoSection = false;

          for (const line of lines) {
            if (line.includes("DirectShow video devices")) {
              inVideoSection = true;
              continue;
            }
            if (line.includes("DirectShow audio devices")) {
              inVideoSection = false;
              continue;
            }
            if (inVideoSection && line.includes('"')) {
              const match = line.match(/"([^"]+)"/);
              if (match) {
                videoDevices.push(match[1]);
              }
            }
          }
        } catch {}
      }

      const hyprlandAvailable = await isHyprlandAvailable();
      let hyprlandMonitors: Array<{
        id: number;
        name: string;
        width: number;
        height: number;
        focused: boolean;
      }> = [];
      if (hyprlandAvailable) {
        try {
          const mons = await listMonitors();
          hyprlandMonitors = mons.map((m) => ({
            id: m.id,
            name: m.name,
            width: m.width,
            height: m.height,
            focused: m.focused,
          }));
        } catch {}
      }

      const screenBackend = hyprlandAvailable ? "hyprland" : isWindows ? "gdigrab" : "none";

      respond(true, {
        webcams: videoDevices,
        screen: screenBackend !== "none",
        screenBackend,
        hyprland: {
          available: hyprlandAvailable,
          monitors: hyprlandMonitors,
        },
        platform: process.platform,
        localModel: LOCAL_VISION_MODEL,
        ollamaUrl: OLLAMA_URL,
      });
    } catch (e) {
      respond(false, undefined, { code: "DEVICES_ERROR", message: String(e) });
    }
  },

  /**
   * Check vision system status
   */
  "vision.status": async ({ respond }) => {
    try {
      // Check Ollama
      let ollamaStatus = "unknown";
      let modelLoaded = false;

      try {
        const response = await fetch(`${OLLAMA_URL}/api/tags`);
        if (response.ok) {
          const data = (await response.json()) as any;
          ollamaStatus = "connected";
          modelLoaded = data.models?.some(
            (m: any) =>
              m.name === LOCAL_VISION_MODEL || m.name.startsWith(LOCAL_VISION_MODEL.split(":")[0]),
          );
        }
      } catch {
        ollamaStatus = "disconnected";
      }

      // Check Claude API
      const claudeStatus = process.env.ANTHROPIC_API_KEY ? "configured" : "missing_key";

      ensureFrameDir();
      respond(true, {
        local: {
          status: ollamaStatus,
          model: LOCAL_VISION_MODEL,
          modelLoaded,
          url: OLLAMA_URL,
        },
        claude: {
          status: claudeStatus,
        },
        frameBufferDir: FRAME_BUFFER_DIR,
        framesStored: fs.existsSync(FRAME_BUFFER_DIR) ? fs.readdirSync(FRAME_BUFFER_DIR).length : 0,
      });
    } catch (e) {
      respond(false, undefined, { code: "STATUS_ERROR", message: String(e) });
    }
  },

  /**
   * Clean up old frames
   */
  "vision.cleanup": async ({ params, respond }) => {
    try {
      const maxAgeMs = typeof params.maxAgeMs === "number" ? params.maxAgeMs : 3600000; // Default 1 hour
      const now = Date.now();
      let deleted = 0;

      ensureFrameDir();
      if (fs.existsSync(FRAME_BUFFER_DIR)) {
        const files = fs.readdirSync(FRAME_BUFFER_DIR);
        for (const file of files) {
          const filePath = path.join(FRAME_BUFFER_DIR, file);
          const stats = fs.statSync(filePath);
          if (now - stats.mtimeMs > maxAgeMs) {
            fs.unlinkSync(filePath);
            deleted++;
          }
        }
      }

      respond(true, { deleted, remaining: fs.readdirSync(FRAME_BUFFER_DIR).length });
    } catch (e) {
      respond(false, undefined, { code: "CLEANUP_ERROR", message: String(e) });
    }
  },
};
