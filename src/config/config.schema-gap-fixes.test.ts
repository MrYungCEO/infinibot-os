/**
 * Regression tests for config options that existed in the TypeScript types (and
 * in the running code) but were missing from the `.strict()` zod schemas, which
 * made them impossible to set through `config set`, the config RPCs, or a
 * hand-edited infinibot.json.
 *
 * Found by src/config/zod-schema.coverage.test.ts — see that file for the guard
 * that stops this class of bug from coming back.
 */
import { describe, expect, it } from "vitest";

import { validateConfigObject } from "./config.js";

function expectOk(value: Record<string, unknown>) {
  const res = validateConfigObject(value);
  expect(res.issues ?? [], JSON.stringify(res.issues ?? [], null, 2)).toEqual([]);
  expect(res.ok).toBe(true);
}

function expectRejected(value: Record<string, unknown>) {
  expect(validateConfigObject(value).ok).toBe(false);
}

describe("config schema gap fixes", () => {
  it("accepts the update.auto scheduler block", () => {
    expectOk({
      update: {
        channel: "stable",
        checkOnStart: true,
        auto: {
          enabled: true,
          intervalMinutes: 360,
          autoApply: false,
          quietHours: { enabled: true, start: 2, end: 6 },
          notifications: {
            onAvailable: true,
            onBeforeApply: false,
            onApplied: true,
            onFailure: true,
            targetSession: "telegram:123",
          },
          applyDelaySeconds: 30,
          maxConsecutiveFailures: 3,
          backoffMultiplier: 2,
          maxBackoffMinutes: 1440,
        },
      },
    });
  });

  it("keeps update.auto bounds tight", () => {
    expectRejected({ update: { auto: { intervalMinutes: 5 } } });
    expectRejected({ update: { auto: { quietHours: { start: 24 } } } });
    expectRejected({ update: { auto: { typoKey: true } } });
  });

  it("accepts gateway.customBindHost alongside bind: custom", () => {
    expectOk({ gateway: { bind: "custom", customBindHost: "192.168.1.20" } });
  });

  it("accepts de-owned integration endpoints and database ids", () => {
    expectOk({
      integrations: {
        ollama: { host: "http://127.0.0.1:11434" },
        contentIntel: {
          pipelineDir: "/srv/reel-pipeline",
          venvPath: "/srv/reel-pipeline/.venv",
        },
      },
      notion: { incomeStreamsDbId: "income-db" },
      voice: { robovoiceUrl: "http://127.0.0.1:3001" },
    });
    expectRejected({ voice: { robovoiceUrl: "not-a-url" } });
  });

  it("accepts the kokoro TTS provider and its settings block", () => {
    expectOk({
      messages: {
        tts: {
          auto: "always",
          provider: "kokoro",
          kokoro: {
            baseUrl: "http://localhost:8882",
            voice: "af_nova",
            speed: 1,
            model: "kokoro",
          },
        },
      },
    });
    expectRejected({ messages: { tts: { provider: "not-a-provider" } } });
  });

  it("accepts a per-channel queue mode for googlechat", () => {
    expectOk({ messages: { queue: { byChannel: { googlechat: "collect" } } } });
  });

  it("accepts the telegram editMessage action toggle", () => {
    expectOk({
      channels: { telegram: { actions: { editMessage: false, deleteMessage: true } } },
    });
  });

  it("accepts tools.exec.approvalRunningNoticeMs at the global tools scope", () => {
    expectOk({ tools: { exec: { approvalRunningNoticeMs: 0 } } });
    expectRejected({ tools: { exec: { approvalRunningNoticeMs: -1 } } });
  });

  it("accepts tools.web.fetch readability + firecrawl settings", () => {
    expectOk({
      tools: {
        web: {
          fetch: {
            readability: false,
            firecrawl: {
              enabled: true,
              apiKey: "fc-test",
              baseUrl: "https://api.firecrawl.dev",
              onlyMainContent: true,
              maxAgeMs: 60000,
              timeoutSeconds: 30,
            },
          },
        },
      },
    });
    expectRejected({ tools: { web: { fetch: { firecrawl: { unknownKey: 1 } } } } });
  });

  it("accepts workloadTracking", () => {
    expectOk({ workloadTracking: { enabled: false, streakMinEvents: 5 } });
    expectRejected({ workloadTracking: { streakMinEvents: 0 } });
  });

  it("accepts declared media capabilities on federation nodes", () => {
    expectOk({
      federation: {
        mode: "satellite",
        capabilities: {
          hasComfyUI: true,
          comfyUIPath: "/opt/ComfyUI",
          ffmpeg: {
            available: true,
            version: "7.1",
            hasNvenc: true,
            hasNvdec: false,
            hasCuda: true,
            codecs: ["h264", "hevc"],
          },
          imageTools: { rembg: true, realesrgan: false, pillow: true, imagemagick: false },
          mediaServices: ["ffmpeg", "nvenc"],
        },
      },
    });
    expectRejected({ federation: { mode: "satellite", capabilities: { ffmpeg: { nope: 1 } } } });
  });
});
