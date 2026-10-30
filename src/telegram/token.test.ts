import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { InfinibotConfig } from "../config/config.js";
import { resolveTelegramToken } from "./token.js";

function withTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "infinibot-telegram-token-"));
}

describe("resolveTelegramToken", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers config token over env", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "env-token");
    const cfg = {
      channels: { telegram: { botToken: "cfg-token" } },
    } as InfinibotConfig;
    const res = resolveTelegramToken(cfg);
    expect(res.token).toBe("cfg-token");
    expect(res.source).toBe("config");
  });

  it("uses env token when config is missing", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "env-token");
    const cfg = {
      channels: { telegram: {} },
    } as InfinibotConfig;
    const res = resolveTelegramToken(cfg);
    expect(res.token).toBe("env-token");
    expect(res.source).toBe("env");
  });

  it("uses tokenFile when configured", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    const dir = withTempDir();
    const tokenFile = path.join(dir, "token.txt");
    fs.writeFileSync(tokenFile, "file-token\n", "utf-8");
    const cfg = { channels: { telegram: { tokenFile } } } as InfinibotConfig;
    const res = resolveTelegramToken(cfg);
    expect(res.token).toBe("file-token");
    expect(res.source).toBe("tokenFile");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to config token when no env or tokenFile", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    const cfg = {
      channels: { telegram: { botToken: "cfg-token" } },
    } as InfinibotConfig;
    const res = resolveTelegramToken(cfg);
    expect(res.token).toBe("cfg-token");
    expect(res.source).toBe("config");
  });

  it("does not fall back to config when tokenFile is missing", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    const dir = withTempDir();
    const tokenFile = path.join(dir, "missing-token.txt");
    const cfg = {
      channels: { telegram: { tokenFile, botToken: "cfg-token" } },
    } as InfinibotConfig;
    const res = resolveTelegramToken(cfg);
    expect(res.token).toBe("");
    expect(res.source).toBe("none");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a fleet tenant Machine never uses a process-level TELEGRAM_BOT_TOKEN, only its own config", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "operator-token");
    vi.stubEnv("SAAS_MODE", "1");
    vi.stubEnv("FLEET_TENANT_ID", "t-1");
    expect(resolveTelegramToken({} as InfinibotConfig)).toEqual({ token: "", source: "none" });
    const cfg = { channels: { telegram: { botToken: "tenant-token" } } } as InfinibotConfig;
    expect(resolveTelegramToken(cfg).token).toBe("tenant-token");
  });
});
