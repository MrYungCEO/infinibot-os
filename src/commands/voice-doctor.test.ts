import { describe, expect, it } from "vitest";

import { runVoiceDoctorChecks, formatDoctorReport, type ReachProbe } from "./voice-doctor.js";
import type { VoiceSetupConfig } from "../voice/schema.js";

const reachOk: ReachProbe = async () => ({ ok: true, status: 200, ms: 12 });
const reachFail: ReachProbe = async () => ({
  ok: false,
  status: 401,
  ms: 30,
  error: "unauthorized",
});

const cloudSetup: VoiceSetupConfig = {
  provider: "cloud",
  cloud: { stt: "openai", tts: "openai", apiKey: "sk-good" },
};

const nativeSetup: VoiceSetupConfig = {
  provider: "native",
  native: { tts: "kokoro", ttsVoice: "coral", sttModel: "whisper-base" },
};

describe("runVoiceDoctorChecks", () => {
  it("passes for a valid cloud config with a reachable key", async () => {
    const report = await runVoiceDoctorChecks({
      setup: cloudSetup,
      reach: reachOk,
      runSmoke: false,
    });
    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.name === "config")?.status).toBe("pass");
    expect(report.checks.find((c) => c.name === "api-reachable")?.status).toBe("pass");
  });

  it("fails when no config exists", async () => {
    const report = await runVoiceDoctorChecks({ setup: null, reach: reachOk, runSmoke: false });
    expect(report.ok).toBe(false);
    expect(report.checks[0].status).toBe("fail");
  });

  it("fails when the cloud API key is missing", async () => {
    const report = await runVoiceDoctorChecks({
      setup: {
        provider: "cloud",
        cloud: { stt: "openai", tts: "openai", apiKey: "" },
      } as VoiceSetupConfig,
      reach: reachOk,
      runSmoke: false,
    });
    expect(report.ok).toBe(false);
  });

  it("fails when the cloud key is unreachable / rejected", async () => {
    const report = await runVoiceDoctorChecks({
      setup: cloudSetup,
      reach: reachFail,
      runSmoke: false,
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === "api-reachable")?.status).toBe("fail");
  });

  it("passes native config when containers are reachable", async () => {
    const report = await runVoiceDoctorChecks({
      setup: nativeSetup,
      reach: reachOk,
      runSmoke: false,
    });
    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.name === "kokoro-tts")?.status).toBe("pass");
    expect(report.checks.find((c) => c.name === "speaches-stt")?.status).toBe("pass");
  });

  it("fails native config when a container is down", async () => {
    const report = await runVoiceDoctorChecks({
      setup: nativeSetup,
      reach: reachFail,
      runSmoke: false,
    });
    expect(report.ok).toBe(false);
  });

  it("formats a readable table", () => {
    const text = formatDoctorReport({
      ok: true,
      checks: [{ name: "config", status: "pass", detail: "provider = native" }],
    });
    expect(text).toContain("✓");
    expect(text).toContain("config");
    expect(text).toContain("All checks passed.");
  });
});
