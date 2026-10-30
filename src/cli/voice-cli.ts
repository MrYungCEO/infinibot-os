/**
 * `infinibot voice` — manage the non-Docker voice stack.
 *
 *   voice up [--cloud|--native|--docker]   bring the stack up (auto-picks)
 *   voice down                             tear it down
 *   voice doctor                           STT + TTS roundtrip self-test
 *   voice set <stt|tts> <provider>         change a provider
 *   voice status                           show current config
 *
 * The Docker path (`--docker`) shells out to docker-compose.voice.yaml exactly
 * as before; cloud/native are pure config + in-process adapters.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Command } from "commander";
import * as p from "@clack/prompts";

import { autoPickMode } from "../gateway/voice/autopick.js";
import {
  DEFAULT_CLOUD_CONFIG,
  DEFAULT_NATIVE_CONFIG,
  loadVoiceConfig,
  loadVoiceConfigOrDefault,
  saveVoiceConfig,
  type SttProviderId,
  type TtsProviderId,
  type VoiceConfig,
} from "../gateway/voice/config.js";
import { runDoctor } from "../gateway/voice/doctor.js";
import { installNativeWhisper } from "../gateway/voice/native/install.js";

const pExecFile = promisify(execFile);

const STT_PROVIDERS = new Set(["groq", "deepgram", "openai", "native"]);
const TTS_PROVIDERS = new Set(["elevenlabs", "openai", "cartesia", "native"]);

const SIGNUP_URLS: Record<string, string> = {
  groq: "https://console.groq.com/keys",
  elevenlabs: "https://elevenlabs.io/app/settings/api-keys",
  openai: "https://platform.openai.com/api-keys",
  deepgram: "https://console.deepgram.com/",
  cartesia: "https://play.cartesia.ai/keys",
};

function openUrl(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  void pExecFile(cmd, [url]).catch(() => {
    /* best-effort — just printed below too */
  });
}

export function registerVoiceCli(program: Command): void {
  const voice = program
    .command("voice")
    .description("Manage the voice stack (cloud / native / docker)");

  // ── voice up ───────────────────────────────────────────────────────────
  voice
    .command("up")
    .description("Bring the voice stack up (auto-picks cloud/native unless a flag is given)")
    .option("--cloud", "Cloud providers (Groq STT + ElevenLabs TTS)")
    .option("--native", "Native in-process (whisper.cpp + Kokoro)")
    .option("--docker", "Legacy Docker compose stack")
    .action(async (opts) => {
      const flag = opts.cloud
        ? "cloud"
        : opts.native
          ? "native"
          : opts.docker
            ? "docker"
            : undefined;
      const decision = autoPickMode(flag);
      console.log(`[voice] mode: ${decision.mode} — ${decision.reason}`);

      if (decision.mode === "docker") {
        await voiceUpDocker();
        return;
      }
      if (decision.mode === "native") {
        await voiceUpNative();
        return;
      }
      if (decision.mode === "wizard") {
        await voiceUpWizard();
        return;
      }
      // cloud (keys already in env or config)
      await voiceUpCloud();
    });

  // ── voice down ─────────────────────────────────────────────────────────
  voice
    .command("down")
    .description("Tear down the voice stack")
    .action(async () => {
      const cfg = loadVoiceConfig();
      if (cfg?.mode === "docker") {
        console.log("[voice] stopping Docker voice stack…");
        await runDockerCompose(["down"]);
        return;
      }
      console.log(
        "[voice] cloud/native stacks run in-process inside the gateway — nothing to stop. " +
          "Restart or stop the gateway to disable voice.",
      );
    });

  // ── voice doctor ───────────────────────────────────────────────────────
  voice
    .command("doctor")
    .description("Run STT + TTS roundtrip checks with timings")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      const cfg = loadVoiceConfigOrDefault();
      console.log(
        `[voice] doctor — mode=${cfg.mode} stt=${cfg.stt.provider} tts=${cfg.tts.provider}`,
      );
      console.log(
        "[voice] microphone permission is browser/OS-granted at call time — doctor checks the " +
          "STT and TTS service paths, not the local mic device.",
      );
      const report = await runDoctor(cfg);
      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        for (const c of report.checks) {
          const mark = c.ok ? "✅" : "❌";
          const ms = c.ms !== undefined ? ` ${c.ms}ms` : "";
          console.log(`  ${mark} ${c.name}${ms}${c.detail ? ` — ${c.detail}` : ""}`);
          if (c.error) console.log(`     ${c.error}`);
        }
        console.log(report.ok ? "\n[voice] doctor: PASS" : "\n[voice] doctor: FAIL");
      }
      if (!report.ok) process.exitCode = 1;
    });

  // ── voice set ──────────────────────────────────────────────────────────
  voice
    .command("set <kind> <provider>")
    .description("Set the STT or TTS provider (kind = stt | tts)")
    .option("--voice <id>", "TTS voice id")
    .option("--model <id>", "STT model id")
    .option("--api-key <key>", "Store an API key for this provider in voice.json")
    .action(async (kind: string, provider: string, opts) => {
      const cfg = loadVoiceConfigOrDefault();
      if (kind === "stt") {
        if (!STT_PROVIDERS.has(provider)) {
          console.error(
            `[voice] unknown STT provider "${provider}" — one of: ${[...STT_PROVIDERS].join(", ")}`,
          );
          process.exitCode = 1;
          return;
        }
        cfg.stt.provider = provider as SttProviderId;
        if (opts.model) cfg.stt.model = opts.model;
        if (opts.apiKey) cfg.stt.apiKey = opts.apiKey;
      } else if (kind === "tts") {
        if (!TTS_PROVIDERS.has(provider)) {
          console.error(
            `[voice] unknown TTS provider "${provider}" — one of: ${[...TTS_PROVIDERS].join(", ")}`,
          );
          process.exitCode = 1;
          return;
        }
        cfg.tts.provider = provider as TtsProviderId;
        if (opts.voice) cfg.tts.voice = opts.voice;
        if (opts.apiKey) cfg.tts.apiKey = opts.apiKey;
      } else {
        console.error(`[voice] kind must be "stt" or "tts", got "${kind}"`);
        process.exitCode = 1;
        return;
      }
      saveVoiceConfig(cfg);
      console.log(`[voice] ${kind} → ${provider}. Saved.`);
    });

  // ── voice status ───────────────────────────────────────────────────────
  voice
    .command("status")
    .description("Show the current voice configuration")
    .option("--json", "Output JSON", false)
    .action((opts) => {
      const cfg = loadVoiceConfig();
      if (!cfg) {
        console.log(
          "[voice] no voice.json — gateway uses the legacy Docker voice path. " +
            "Run `infinibot voice up` to configure cloud or native.",
        );
        return;
      }
      if (opts.json) {
        // Redact stored keys.
        const redacted = redactKeys(cfg);
        console.log(JSON.stringify(redacted, null, 2));
        return;
      }
      console.log(`mode:  ${cfg.mode}`);
      console.log(`STT:   ${cfg.stt.provider}${cfg.stt.model ? ` (${cfg.stt.model})` : ""}`);
      console.log(`TTS:   ${cfg.tts.provider}${cfg.tts.voice ? ` (${cfg.tts.voice})` : ""}`);
    });
}

function redactKeys(cfg: VoiceConfig): VoiceConfig {
  return {
    ...cfg,
    stt: { ...cfg.stt, apiKey: cfg.stt.apiKey ? "***" : undefined },
    tts: { ...cfg.tts, apiKey: cfg.tts.apiKey ? "***" : undefined },
  };
}

async function voiceUpCloud(): Promise<void> {
  const existing = loadVoiceConfig();
  const cfg: VoiceConfig =
    existing && existing.mode === "cloud" ? existing : { ...DEFAULT_CLOUD_CONFIG };
  cfg.mode = "cloud";
  saveVoiceConfig(cfg);
  console.log(`[voice] cloud stack ready — STT=${cfg.stt.provider}, TTS=${cfg.tts.provider}.`);
  console.log("[voice] run `infinibot voice doctor` to verify.");
}

async function voiceUpNative(): Promise<void> {
  console.log("[voice] installing native stack (whisper.cpp model + Kokoro ONNX on first use)…");
  const cfg: VoiceConfig = { ...DEFAULT_NATIVE_CONFIG };
  try {
    const report = await installNativeWhisper(cfg.stt.model, (line) => console.log(`  ${line}`));
    console.log(`[voice] whisper model: ${report.modelPath}`);
    for (const note of report.notes) console.log(`  ⚠ ${note}`);
  } catch (err) {
    console.error(`[voice] native install failed: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  saveVoiceConfig(cfg);
  console.log("[voice] native stack configured. Run `infinibot voice doctor` to verify.");
}

async function voiceUpWizard(): Promise<void> {
  p.intro("InfiniBot voice setup");
  p.note(
    "No cloud keys and no supported GPU were found. Let's set up the cloud stack:\n" +
      "Groq (speech-to-text) + ElevenLabs (text-to-speech). Both have free tiers.",
  );

  openUrl(SIGNUP_URLS.groq);
  const groqKey = await p.text({
    message: `Groq API key  (signup: ${SIGNUP_URLS.groq})`,
    placeholder: "gsk_…",
    validate: (v) => (v && v.trim() ? undefined : "required"),
  });
  if (p.isCancel(groqKey)) return cancelWizard();

  openUrl(SIGNUP_URLS.elevenlabs);
  const elevenKey = await p.text({
    message: `ElevenLabs API key  (signup: ${SIGNUP_URLS.elevenlabs})`,
    placeholder: "sk_…",
    validate: (v) => (v && v.trim() ? undefined : "required"),
  });
  if (p.isCancel(elevenKey)) return cancelWizard();

  const cfg: VoiceConfig = {
    mode: "cloud",
    stt: {
      provider: "groq",
      model: DEFAULT_CLOUD_CONFIG.stt.model,
      apiKey: String(groqKey).trim(),
    },
    tts: {
      provider: "elevenlabs",
      voice: DEFAULT_CLOUD_CONFIG.tts.voice,
      apiKey: String(elevenKey).trim(),
    },
  };
  saveVoiceConfig(cfg);
  p.outro("Saved. Run `infinibot voice doctor` to verify.");
}

function cancelWizard(): void {
  p.cancel("Setup cancelled.");
  process.exitCode = 1;
}

async function voiceUpDocker(): Promise<void> {
  const cfg = loadVoiceConfig() ?? { ...DEFAULT_CLOUD_CONFIG };
  cfg.mode = "docker";
  saveVoiceConfig(cfg);
  console.log("[voice] starting Docker voice stack (docker-compose.voice.yaml)…");
  await runDockerCompose(["up", "-d"]);
}

async function runDockerCompose(args: string[]): Promise<void> {
  try {
    const { stdout, stderr } = await pExecFile(
      "docker",
      ["compose", "-f", "docker-compose.voice.yaml", ...args],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    if (stdout.trim()) console.log(stdout.trim());
    if (stderr.trim()) console.error(stderr.trim());
  } catch (err) {
    console.error(`[voice] docker compose failed: ${(err as Error).message}`);
    console.error("[voice] ensure Docker is running and you're in the repo root.");
    process.exitCode = 1;
  }
}
