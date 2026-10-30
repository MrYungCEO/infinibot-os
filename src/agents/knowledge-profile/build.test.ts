import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { InfinibotConfig } from "../../config/types.infinibot.js";
import {
  buildKnowledgeProfiles,
  liveStatus,
  resolveAgentTools,
  type KnowledgeProfileSources,
} from "./build.js";
import { domainForTool } from "./domains.js";
import type { StoreSnapshot } from "./probes.js";

const NOW = 1_800_000_000_000;
const probe = (count: number, extra: object = {}) => ({
  status: "ok" as const,
  count,
  lastUpdatedAt: NOW - 1000,
  ...extra,
});

const STORES: StoreSnapshot = {
  notes: probe(12),
  kanban: probe(3, {
    detail: { projects: 3, tasks: 40, openTasks: 9 },
    byAgent: { researcher: 7 },
  }),
  databases: probe(5),
  notion: {
    status: "not-configured",
    count: null,
    lastUpdatedAt: null,
    note: "Notion not connected",
  },
  crm: probe(20),
  reports: probe(100, { byAgent: { researcher: 4 } }),
  directories: probe(2, { byAgent: { researcher: 1 } }),
  contentIntel: probe(186),
  research: probe(50),
  vault: probe(7),
};

const CATALOG = [
  { name: "notes", description: "Read/write notes.\nMore lines" },
  { name: "kanban", description: "Projects and tasks" },
  { name: "databases", description: "Databases" },
  { name: "memory_search", description: "Semantic memory search" },
  { name: "web_search", description: "Search the web" },
  { name: "browser", description: "Drive a browser" },
  { name: "sessions_spawn", description: "Spawn a sub-agent" },
  { name: "tts", description: "Speak" },
  { name: "hyprland_window", description: "Window control" },
  { name: "pluginthing", description: "From a plugin", pluginId: "acme" },
];

let ws: string;

function sources(
  config: InfinibotConfig,
  over: Partial<KnowledgeProfileSources> = {},
): KnowledgeProfileSources {
  return {
    now: () => NOW,
    config,
    toolCatalog: () => CATALOG,
    stores: () => STORES,
    sovereign: async () => ({
      status: "offline",
      shared: true,
      url: "x",
      counts: {},
      lastUpdatedAt: null,
    }),
    sessions: () =>
      new Map([
        [
          "researcher",
          {
            sessions: 10,
            sessionsLast24h: 2,
            lastActiveAt: NOW - 3_600_000,
            totalTokens: 500,
            recentFiles: ["f"],
          },
        ],
      ]),
    runs: () => [
      {
        runId: "r1",
        agentId: "writer",
        label: "draft",
        startedAt: NOW - 10,
        endedAt: null,
        active: true,
        state: "running",
      },
    ],
    mcpServers: async () => [
      { name: "github", status: "running", toolCount: 12 },
      { name: "excalidraw", status: "running", toolCount: 4 },
    ],
    federation: () => ({
      role: "master",
      nodes: [
        { id: "local", name: "here", online: true, local: true },
        { id: "sat", name: "laptop", online: true },
      ],
    }),
    skills: () => [
      { name: "weather", description: "Forecasts", eligible: true },
      { name: "github", description: "gh", eligible: false },
    ],
    workspaceDir: (id) => path.join(ws, id),
    vectorConfig: (id) =>
      id === "researcher"
        ? { enabled: true, storePath: "/idx.sqlite", sessionsSource: true }
        : { enabled: false },
    vectorIndex: () => ({
      status: "ok",
      files: 3,
      chunks: 30,
      sources: { memory: { files: 2, chunks: 20 }, sessions: { files: 1, chunks: 10 } },
      lastIndexedAt: NOW,
    }),
    recentTools: () => [{ name: "notes", count: 3 }],
    workspaceEntries: (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).length : null),
    ...over,
  };
}

const CONFIG = {
  agents: {
    list: [
      {
        id: "researcher",
        name: "Researcher",
        default: true,
        identity: { emoji: "🔬" },
        tools: { allow: ["notes", "kanban", "group:memory", "sessions_spawn", "web", "acme"] },
        skills: ["weather", "ghost"],
        subagents: { allowAgents: ["writer"] },
        enabledMCPs: ["github"],
        model: { primary: "anthropic/claude-sonnet-5", fallbacks: ["openai/gpt-5"] },
      },
      { id: "writer", name: "Writer", tools: { allow: ["notes"], deny: ["kanban"] } },
      { id: "full", tools: { profile: "full" } },
      { id: "cli", type: "cli", cliCommand: "codex", tools: { allow: ["notes"] } },
    ],
  },
  bindings: [{ agentId: "writer", match: { channel: "telegram", accountId: "bot2" } }],
  channels: { telegram: { enabled: true }, discord: { enabled: false } },
} as unknown as InfinibotConfig;

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "kp-build-"));
  fs.mkdirSync(path.join(ws, "researcher", "memory"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, "researcher", "IDENTITY.md"),
    "- **Name:** Rae\n- **Emoji:** 🦉\n",
  );
  fs.writeFileSync(path.join(ws, "researcher", "MEMORY.md"), "x".repeat(50));
  fs.writeFileSync(path.join(ws, "researcher", "memory", "2026-09-01.md"), "day");
});
afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

const byId = async (over: Partial<KnowledgeProfileSources> = {}, config = CONFIG) => {
  const r = await buildKnowledgeProfiles(sources(config, over));
  return { r, a: Object.fromEntries(r.agents.map((x) => [x.id, x])) };
};

describe("tool allowlist → reachability", () => {
  it("allows exactly the allowlisted tools (groups + plugin ids expanded) and flags unknown entries", () => {
    const t = resolveAgentTools(CONFIG, "researcher", CATALOG);
    expect([...t.allowed].sort()).toEqual([
      "kanban",
      "memory_search",
      "notes",
      "pluginthing",
      "sessions_spawn",
      "web_search",
    ]);
    // A bare "web" (used by roster agents) expands to the web tool group.
    expect(t.unknownAllowEntries).toEqual([]);
  });

  it("maps allowed tools onto knowledge sources", async () => {
    const { a } = await byId();
    const src = Object.fromEntries(a.researcher.knowledge.map((k) => [k.id, k]));
    expect(src.notes).toMatchObject({
      reachable: true,
      grantedBy: ["notes"],
      count: 12,
    });
    expect(src.projects).toMatchObject({
      reachable: true,
      agentCount: 7,
    });
    expect(src.databases.reachable).toBe(false);
    expect(src.web.reachable).toBe(true);
    expect(src.reports).toMatchObject({ reachable: false, agentCount: 4 });
    expect(src["memory-index"]).toMatchObject({ reachable: true, count: 30, status: "ok" });
    // deny wins over allow
    const w = Object.fromEntries(a.writer.knowledge.map((k) => [k.id, k]));
    expect(w.notes.reachable).toBe(true);
    expect(w.projects.reachable).toBe(false);
  });

  it("a full-profile agent reaches every catalog tool", async () => {
    const { a } = await byId();
    expect(a.full.capabilities.tools.allowed).toBe(a.full.capabilities.tools.total);
    expect(a.full.capabilities.access).toMatchObject({
      browser: true,
      voice: true,
      computerUse: true,
      web: true,
      exec: true,
    });
  });
});

describe("sections", () => {
  it("builds identity, memory, capabilities and activity from the sources", async () => {
    const { r, a } = await byId();
    const rs = a.researcher;
    expect(r.defaultAgentId).toBe("researcher");
    expect(rs.name).toBe("Researcher");
    expect(rs.emoji).toBe("🔬"); // config identity beats IDENTITY.md
    expect(rs.identity.persona.name).toBe("Rae");
    expect(rs.identity.present).toBe(2);
    expect(rs.identity.files.find((f) => f.name === "SOUL.md")).toMatchObject({
      exists: false,
      readOnly: true,
    });
    expect(rs.memory.notebook).toMatchObject({ status: "ok", memoryMdBytes: 50, dailyFiles: 1 });
    expect(rs.memory.transcripts).toMatchObject({
      sessions: 10,
      indexedIntoMemory: true,
      indexedChunks: 10,
    });
    expect(rs.memory.vector.reachable).toBe(true);
    expect(rs.capabilities.model).toEqual({
      primary: "anthropic/claude-sonnet-5",
      fallbacks: ["openai/gpt-5"],
    });
    expect(rs.capabilities.skills).toMatchObject({
      mode: "list",
      enabled: ["weather", "ghost"],
      count: 2,
    });
    expect(rs.capabilities.mcp.servers.map((s) => [s.name, s.enabledForAgent])).toEqual([
      ["github", false],
      ["excalidraw", false],
    ]); // no `mcp` tool → not reachable even if scoped
    expect(rs.capabilities.subagents).toEqual({
      canSpawn: true,
      allowAgents: ["writer"],
      coders: [],
    });
    expect(rs.capabilities.federation.canTargetRemote).toBe(true);
    expect(rs.capabilities.channels).toEqual([{ channel: "telegram", source: "default-route" }]);
    expect(rs.activity).toMatchObject({
      status: "active",
      sessions: 10,
      recentTools: [{ name: "notes", count: 3 }],
    });
    const kg = rs.capabilities.tools.domains.find((d) => d.domain === "Knowledge & memory")!;
    expect(kg).toEqual({
      domain: "Knowledge & memory",
      allowed: 3,
      total: 4,
      allowedTools: ["kanban", "memory_search", "notes"],
    });
    // shared catalog: descriptions once, first line only, core tools appended
    expect(r.tools.find((t) => t.name === "notes")).toEqual({
      name: "notes",
      description: "Read/write notes.",
      domain: "Knowledge & memory",
    });
    expect(r.tools.find((t) => t.name === "exec")).toMatchObject({ core: true, domain: "Runtime" });
    expect(r.skills.map((s) => s.name)).toEqual(["weather", "github"]);
    expect(rs.matrix["Knowledge & memory"]).toBe(3);
    expect(rs.badges).toMatchObject({ tools: 6, skills: 2, identityFiles: 2 });
  });

  it("covers bindings, running runs, cli agents and skills mode all", async () => {
    const { a } = await byId();
    expect(a.writer.capabilities.channels).toEqual([
      { channel: "telegram", accountId: "bot2", peer: undefined, source: "binding" },
    ]);
    expect(a.writer.activity).toMatchObject({ status: "running", runningNow: 1 });
    expect(a.writer.capabilities.skills).toMatchObject({
      mode: "all",
      catalogTotal: 2,
      catalogEligible: 1,
    });
    expect(a.cli.capabilities.type).toBe("cli");
    expect(a.cli.capabilities.access.exec).toBe(true);
    expect(a.cli.capabilities.mcp.reachable).toBe(true);
    expect(a.full.activity.status).toBe("dormant");
  });

  it("ships static source metadata once, shared by every agent", async () => {
    const { r, a } = await byId();
    const defs = Object.fromEntries(r.sourceDefs.map((d) => [d.id, d]));
    expect(defs.notes).toMatchObject({ label: "Notes", via: ["notes"], tab: "notes" });
    expect(defs.projects.agentCountLabel).toBe("tasks assigned");
    expect(a.researcher.knowledge.map((k) => k.id)).toEqual(r.sourceDefs.map((d) => d.id));
    expect(a.researcher.knowledge[0]).not.toHaveProperty("label");
  });

  it("filters to one agent", async () => {
    const r = await buildKnowledgeProfiles(sources(CONFIG), { agentId: "Writer" });
    expect(r.agents.map((x) => x.id)).toEqual(["writer"]);
  });
});

describe("graceful degradation", () => {
  it("never throws when every source fails; each section reports its own error", async () => {
    const boom = () => {
      throw new Error("boom");
    };
    const { r, a } = await byId({
      toolCatalog: boom,
      stores: boom,
      sovereign: async () => Promise.reject(new Error("down")),
      sessions: boom,
      runs: boom,
      mcpServers: async () => Promise.reject(new Error("mcp down")),
      federation: boom,
      skills: boom,
      workspaceDir: boom,
      vectorConfig: boom,
    });
    const rs = a.researcher;
    expect(r.errors.join("\n")).toMatch(/stores: boom/);
    expect(r.errors.join("\n")).toMatch(/mcp: mcp down/);
    expect(rs.errors.join("\n")).toMatch(/workspace: boom/);
    expect(rs.memory.sovereign.status).toBe("error");
    expect(rs.capabilities.mcp.status).toBe("error");
    expect(rs.identity.workspace).toBe("");
    expect(rs.knowledge.find((k) => k.id === "notes")).toMatchObject({
      status: "error",
      count: null,
    });
    // core tools still listed even with no gateway catalog
    expect(rs.capabilities.tools.total).toBeGreaterThan(0);
    expect(rs.activity.status).toBe("dormant");
  });

  it("a missing store only degrades that source", async () => {
    const { a } = await byId();
    const notion = a.researcher.knowledge.find((k) => k.id === "notion")!;
    expect(notion).toMatchObject({ status: "not-configured", note: "Notion not connected" });
    expect(a.researcher.knowledge.find((k) => k.id === "notes")!.status).toBe("ok");
  });
});

describe("helpers", () => {
  it("classifies tools into domains", () => {
    expect(domainForTool("memory_search")).toBe("Knowledge & memory");
    expect(domainForTool("claude_coder")).toBe("Agents & sessions");
    expect(domainForTool("hyprland_input")).toBe("Desktop control");
    expect(domainForTool("telegram_send")).toBe("Messaging");
    expect(domainForTool("zzz_unknown")).toBe("Other");
  });

  it("derives live status", () => {
    expect(liveStatus({ runningNow: 1, lastActiveAt: null, sessions: 0 }, NOW)).toBe("running");
    expect(liveStatus({ runningNow: 0, lastActiveAt: NOW - 30_000, sessions: 1 }, NOW)).toBe(
      "running",
    );
    expect(liveStatus({ runningNow: 0, lastActiveAt: NOW - 3_600_000, sessions: 1 }, NOW)).toBe(
      "active",
    );
    expect(
      liveStatus({ runningNow: 0, lastActiveAt: NOW - 86_400_000 * 3, sessions: 1 }, NOW),
    ).toBe("idle");
    expect(liveStatus({ runningNow: 0, lastActiveAt: null, sessions: 0 }, NOW)).toBe("dormant");
  });
});
