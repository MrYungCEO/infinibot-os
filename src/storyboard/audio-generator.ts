/**
 * Storyboard Audio Generator — TTS for scene voiceovers
 * 
 * Supports: ElevenLabs (with voice cloning), OpenAI TTS, Edge TTS
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { spawn } from "child_process";
import type { Scene, StoryboardProject } from "./types.js";

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export type TtsProvider = "elevenlabs" | "openai" | "edge" | "local" | "kokoro";

export interface VoiceInfo {
  id: string;
  name: string;
  provider: TtsProvider;
  previewUrl?: string;
  labels?: Record<string, string>;
  category?: string; // "premade", "cloned", "professional"
}

export interface ClonedVoice {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
}

export interface AudioGenOptions {
  text: string;
  outputPath: string;
  voiceId?: string;
  provider?: TtsProvider;
  modelId?: string;
  stability?: number;
  similarityBoost?: number;
  speed?: number;
}

export interface AudioGenResult {
  success: boolean;
  audioPath?: string;
  duration?: number;
  error?: string;
}

// ═══════════════════════════════════════════════════════════════
// ELEVENLABS API
// ═══════════════════════════════════════════════════════════════

const ELEVENLABS_API_URL = "https://api.elevenlabs.io/v1";

function getElevenLabsApiKey(): string | undefined {
  return process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY;
}

export async function listElevenLabsVoices(): Promise<VoiceInfo[]> {
  const apiKey = getElevenLabsApiKey();
  if (!apiKey) return [];

  try {
    const res = await fetch(`${ELEVENLABS_API_URL}/voices`, {
      headers: { "xi-api-key": apiKey },
    });

    if (!res.ok) {
      console.error("ElevenLabs voices list failed:", res.status);
      return [];
    }

    const data = await res.json();
    return (data.voices || []).map((v: any) => ({
      id: v.voice_id,
      name: v.name,
      provider: "elevenlabs" as TtsProvider,
      previewUrl: v.preview_url,
      labels: v.labels,
      category: v.category || (v.labels?.use_case === "custom" ? "cloned" : "premade"),
    }));
  } catch (err) {
    console.error("Failed to list ElevenLabs voices:", err);
    return [];
  }
}

export async function cloneVoice(
  name: string,
  audioFiles: string[],
  description?: string
): Promise<{ success: boolean; voiceId?: string; error?: string }> {
  const apiKey = getElevenLabsApiKey();
  if (!apiKey) {
    return { success: false, error: "ElevenLabs API key not configured" };
  }

  try {
    const formData = new FormData();
    formData.append("name", name);
    if (description) {
      formData.append("description", description);
    }

    // Add audio files
    for (const filePath of audioFiles) {
      const fileBuffer = readFileSync(filePath);
      const fileName = filePath.split(/[\\/]/).pop() || "audio.mp3";
      formData.append("files", new Blob([fileBuffer]), fileName);
    }

    const res = await fetch(`${ELEVENLABS_API_URL}/voices/add`, {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: formData,
    });

    if (!res.ok) {
      const error = await res.text();
      return { success: false, error: `ElevenLabs clone failed: ${error}` };
    }

    const data = await res.json();
    return { success: true, voiceId: data.voice_id };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export async function deleteClonedVoice(voiceId: string): Promise<{ success: boolean; error?: string }> {
  const apiKey = getElevenLabsApiKey();
  if (!apiKey) {
    return { success: false, error: "ElevenLabs API key not configured" };
  }

  try {
    const res = await fetch(`${ELEVENLABS_API_URL}/voices/${voiceId}`, {
      method: "DELETE",
      headers: { "xi-api-key": apiKey },
    });

    if (!res.ok) {
      const error = await res.text();
      return { success: false, error };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

async function generateElevenLabsAudio(options: AudioGenOptions): Promise<AudioGenResult> {
  const apiKey = getElevenLabsApiKey();
  if (!apiKey) {
    return { success: false, error: "ElevenLabs API key not configured" };
  }

  const voiceId = options.voiceId || "pMsXgVXv3BLzUgSXRplE"; // Default: "Serena"
  const modelId = options.modelId || "eleven_multilingual_v2";

  try {
    const res = await fetch(`${ELEVENLABS_API_URL}/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: options.text,
        model_id: modelId,
        voice_settings: {
          stability: options.stability ?? 0.5,
          similarity_boost: options.similarityBoost ?? 0.75,
          style: 0,
          use_speaker_boost: true,
          speed: options.speed ?? 1.0,
        },
      }),
    });

    if (!res.ok) {
      const error = await res.text();
      return { success: false, error: `ElevenLabs TTS failed: ${error}` };
    }

    // Ensure output directory exists
    const outDir = dirname(options.outputPath);
    if (!existsSync(outDir)) {
      mkdirSync(outDir, { recursive: true });
    }

    // Write audio file
    const audioBuffer = await res.arrayBuffer();
    writeFileSync(options.outputPath, Buffer.from(audioBuffer));

    // Get duration using ffprobe
    const duration = await getAudioDuration(options.outputPath);

    return { success: true, audioPath: options.outputPath, duration };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// ═══════════════════════════════════════════════════════════════
// OPENAI TTS
// ═══════════════════════════════════════════════════════════════

export const OPENAI_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"] as const;

async function generateOpenAIAudio(options: AudioGenOptions): Promise<AudioGenResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { success: false, error: "OpenAI API key not configured" };
  }

  const voice = options.voiceId || "alloy";
  const model = options.modelId || "tts-1";

  try {
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        voice,
        input: options.text,
        response_format: "mp3",
        speed: options.speed ?? 1.0,
      }),
    });

    if (!res.ok) {
      const error = await res.text();
      return { success: false, error: `OpenAI TTS failed: ${error}` };
    }

    // Ensure output directory exists
    const outDir = dirname(options.outputPath);
    if (!existsSync(outDir)) {
      mkdirSync(outDir, { recursive: true });
    }

    // Write audio file
    const audioBuffer = await res.arrayBuffer();
    writeFileSync(options.outputPath, Buffer.from(audioBuffer));

    const duration = await getAudioDuration(options.outputPath);

    return { success: true, audioPath: options.outputPath, duration };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// ═══════════════════════════════════════════════════════════════
// KOKORO TTS (Local Docker Server)
// ═══════════════════════════════════════════════════════════════

const KOKORO_API_URL = process.env.KOKORO_API_URL || "http://localhost:8882";

export async function listKokoroVoices(): Promise<VoiceInfo[]> {
  try {
    const res = await fetch(`${KOKORO_API_URL}/v1/audio/voices`);
    if (!res.ok) return [];

    const data = await res.json();
    return (data.voices || []).map((v: string) => ({
      id: v,
      name: formatKokoroVoiceName(v),
      provider: "kokoro" as TtsProvider,
      category: "local",
    }));
  } catch (err) {
    console.error("Failed to list Kokoro voices:", err);
    return [];
  }
}

function formatKokoroVoiceName(voiceId: string): string {
  // Voice IDs like "af_nova" → "Nova (American Female)"
  const parts = voiceId.split("_");
  if (parts.length < 2) return voiceId;
  
  const [lang, name] = parts;
  const langMap: Record<string, string> = {
    af: "American Female",
    am: "American Male", 
    bf: "British Female",
    bm: "British Male",
    ef: "Spanish Female",
    em: "Spanish Male",
    ff: "French Female",
    hf: "Hindi Female",
    hm: "Hindi Male",
    if: "Italian Female",
    im: "Italian Male",
    jf: "Japanese Female",
    jm: "Japanese Male",
    pf: "Portuguese Female",
    pm: "Portuguese Male",
    zf: "Chinese Female",
    zm: "Chinese Male",
  };
  
  const langLabel = langMap[lang] || lang.toUpperCase();
  const nameLabel = name.charAt(0).toUpperCase() + name.slice(1);
  
  return `${nameLabel} (${langLabel})`;
}

async function generateKokoroAudio(options: AudioGenOptions): Promise<AudioGenResult> {
  try {
    const voice = options.voiceId || "af_nova";
    
    const res = await fetch(`${KOKORO_API_URL}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: options.text,
        voice: voice,
        model: "kokoro",
        response_format: "mp3",
        speed: options.speed ?? 1.0,
      }),
    });

    if (!res.ok) {
      const error = await res.text();
      return { success: false, error: `Kokoro TTS failed: ${error}` };
    }

    // Ensure output directory exists
    const outDir = dirname(options.outputPath);
    if (!existsSync(outDir)) {
      mkdirSync(outDir, { recursive: true });
    }

    // Write audio file
    const audioBuffer = await res.arrayBuffer();
    writeFileSync(options.outputPath, Buffer.from(audioBuffer));

    const duration = await getAudioDuration(options.outputPath);

    return { success: true, audioPath: options.outputPath, duration };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export async function isKokoroAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${KOKORO_API_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// EDGE TTS (Free, local)
// ═══════════════════════════════════════════════════════════════

export const EDGE_VOICES = [
  { id: "en-US-MichelleNeural", name: "Michelle (US Female)" },
  { id: "en-US-GuyNeural", name: "Guy (US Male)" },
  { id: "en-US-JennyNeural", name: "Jenny (US Female)" },
  { id: "en-US-AriaNeural", name: "Aria (US Female)" },
  { id: "en-GB-SoniaNeural", name: "Sonia (UK Female)" },
  { id: "en-GB-RyanNeural", name: "Ryan (UK Male)" },
  { id: "en-AU-NatashaNeural", name: "Natasha (AU Female)" },
] as const;

async function generateEdgeAudio(options: AudioGenOptions): Promise<AudioGenResult> {
  const voice = options.voiceId || "en-US-MichelleNeural";

  try {
    // Ensure output directory exists
    const outDir = dirname(options.outputPath);
    if (!existsSync(outDir)) {
      mkdirSync(outDir, { recursive: true });
    }

    // Use edge-tts CLI
    const args = [
      "--voice", voice,
      "--text", options.text,
      "--write-media", options.outputPath,
    ];

    if (options.speed && options.speed !== 1.0) {
      const rate = options.speed > 1 ? `+${Math.round((options.speed - 1) * 100)}%` : `${Math.round((options.speed - 1) * 100)}%`;
      args.push("--rate", rate);
    }

    await runCommand("edge-tts", args);

    const duration = await getAudioDuration(options.outputPath);

    return { success: true, audioPath: options.outputPath, duration };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// ═══════════════════════════════════════════════════════════════
// UNIFIED AUDIO GENERATION
// ═══════════════════════════════════════════════════════════════

export async function generateAudio(options: AudioGenOptions): Promise<AudioGenResult> {
  let provider = options.provider;
  
  // Auto-detect best provider if not specified
  if (!provider) {
    provider = await detectBestProvider();
  }

  switch (provider) {
    case "kokoro":
    case "local":
      return generateKokoroAudio(options);
    case "elevenlabs":
      return generateElevenLabsAudio(options);
    case "openai":
      return generateOpenAIAudio(options);
    case "edge":
      return generateEdgeAudio(options);
    default:
      return { success: false, error: `Unknown provider: ${provider}` };
  }
}

async function detectBestProvider(): Promise<TtsProvider> {
  // Priority: Kokoro (local) > ElevenLabs > OpenAI > Edge
  if (await isKokoroAvailable()) return "kokoro";
  if (getElevenLabsApiKey()) return "elevenlabs";
  if (process.env.OPENAI_API_KEY) return "openai";
  return "edge";
}

export async function listAllVoices(): Promise<VoiceInfo[]> {
  const voices: VoiceInfo[] = [];

  // Kokoro voices (local, prioritized)
  const kokoroVoices = await listKokoroVoices();
  voices.push(...kokoroVoices);

  // ElevenLabs voices
  const elevenLabsVoices = await listElevenLabsVoices();
  voices.push(...elevenLabsVoices);

  // OpenAI voices
  OPENAI_VOICES.forEach(v => {
    voices.push({
      id: v,
      name: v.charAt(0).toUpperCase() + v.slice(1),
      provider: "openai",
      category: "premade",
    });
  });

  // Edge voices
  EDGE_VOICES.forEach(v => {
    voices.push({
      id: v.id,
      name: v.name,
      provider: "edge",
      category: "premade",
    });
  });

  return voices;
}

// ═══════════════════════════════════════════════════════════════
// SCENE VOICEOVER GENERATION
// ═══════════════════════════════════════════════════════════════

export interface SceneAudioOptions {
  voiceId?: string;
  provider?: TtsProvider;
  modelId?: string;
  stability?: number;
  similarityBoost?: number;
  speed?: number;
}

export async function generateSceneVoiceover(
  scene: Scene,
  outputDir: string,
  options?: SceneAudioOptions
): Promise<AudioGenResult> {
  const text = scene.voiceover || scene.description;
  if (!text || text.trim().length === 0) {
    return { success: false, error: "No voiceover text for scene" };
  }

  const outputPath = resolve(outputDir, `scene_${String(scene.index).padStart(3, "0")}_vo.mp3`);

  return generateAudio({
    text,
    outputPath,
    ...options,
  });
}

export async function generateAllVoiceovers(
  project: StoryboardProject,
  outputDir: string,
  options?: SceneAudioOptions
): Promise<{ success: boolean; audioFiles: string[]; errors: string[] }> {
  const audioFiles: string[] = [];
  const errors: string[] = [];

  // Ensure output directory exists
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  for (const scene of project.scenes) {
    const text = scene.voiceover || scene.description;
    if (!text || text.trim().length === 0) {
      continue;
    }

    const result = await generateSceneVoiceover(scene, outputDir, options);
    
    if (result.success && result.audioPath) {
      audioFiles.push(result.audioPath);
    } else {
      errors.push(`Scene ${scene.index}: ${result.error || "Unknown error"}`);
    }
  }

  return {
    success: errors.length === 0,
    audioFiles,
    errors,
  };
}

// ═══════════════════════════════════════════════════════════════
// AUDIO/VIDEO MERGE
// ═══════════════════════════════════════════════════════════════

export async function mergeAudioWithVideo(
  videoPath: string,
  audioPath: string,
  outputPath: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // Ensure output directory exists
    const outDir = dirname(outputPath);
    if (!existsSync(outDir)) {
      mkdirSync(outDir, { recursive: true });
    }

    // FFmpeg command to merge audio with video
    // If audio is longer than video, extend video. If shorter, just use audio duration.
    const args = [
      "-y",
      "-i", videoPath,
      "-i", audioPath,
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "128k",
      "-shortest", // Use shortest stream duration
      "-map", "0:v:0",
      "-map", "1:a:0",
      outputPath,
    ];

    await runCommand("ffmpeg", args);

    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

async function getAudioDuration(audioPath: string): Promise<number | undefined> {
  try {
    return new Promise((resolve) => {
      const proc = spawn("ffprobe", [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        audioPath,
      ], { shell: true });

      let output = "";
      proc.stdout?.on("data", (data) => {
        output += data.toString();
      });

      proc.on("close", (code) => {
        if (code === 0) {
          const duration = parseFloat(output.trim());
          resolve(isNaN(duration) ? undefined : duration);
        } else {
          resolve(undefined);
        }
      });

      proc.on("error", () => resolve(undefined));
    });
  } catch {
    return undefined;
  }
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { shell: true });

    let stderr = "";
    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `${command} exited with code ${code}`));
      }
    });

    proc.on("error", (err) => reject(err));
  });
}
