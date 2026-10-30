import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getNotionConfig, isNotionEnabled, setNotionRuntimeOverride } from "./notion-config.js";

describe("notion-config", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.NOTION_API_KEY;
    delete process.env.NOTION_PROJECTS_DB;
    delete process.env.NOTION_TASKS_DB;
    setNotionRuntimeOverride(null);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    setNotionRuntimeOverride(null);
    vi.restoreAllMocks();
  });

  it("defaults to syncMode='off' and apiKey null when nothing is configured", () => {
    const cfg = getNotionConfig();
    expect(cfg.syncMode).toBe("off");
    expect(cfg.apiKey).toBeNull();
    expect(isNotionEnabled()).toBe(false);
  });

  it("treats env-only NOTION_API_KEY as implicit mirror mode", () => {
    process.env.NOTION_API_KEY = "secret_test";
    const cfg = getNotionConfig();
    expect(cfg.apiKey).toBe("secret_test");
    expect(cfg.syncMode).toBe("mirror");
    expect(isNotionEnabled()).toBe(true);
  });

  it("runtime override beats env values", () => {
    process.env.NOTION_API_KEY = "from_env";
    setNotionRuntimeOverride({
      apiKey: "from_runtime",
      syncMode: "off",
      incomeStreamsDbId: "income-db",
    });
    const cfg = getNotionConfig();
    expect(cfg.apiKey).toBe("from_runtime");
    expect(cfg.syncMode).toBe("off");
    expect(cfg.incomeStreamsDbId).toBe("income-db");
    expect(isNotionEnabled()).toBe(false);
  });

  it("env-pinned project / task ids are surfaced in config", () => {
    process.env.NOTION_API_KEY = "k";
    process.env.NOTION_PROJECTS_DB = "proj-id";
    process.env.NOTION_TASKS_DB = "task-id";
    const cfg = getNotionConfig();
    expect(cfg.projectsDbId).toBe("proj-id");
    expect(cfg.tasksDbId).toBe("task-id");
  });
});
