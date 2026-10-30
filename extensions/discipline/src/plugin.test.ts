import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseManifestV2 } from "../../../src/plugins/manifest-v2.js";
import {
  createSlotTool,
  dropEmptyToolSlots,
  setCoreToolSlot,
} from "../../../src/plugins/core-tool-slots.js";
import {
  getDayPlannerProvider,
  setDayPlannerProvider,
} from "../../../src/infra/day-planner-seam.js";
import { setActivePluginRegistry } from "../../../src/plugins/runtime.js";
import register from "../index.js";
import { pendingAlertTimers } from "./alerts.js";
import { disciplineDataDir, migrateLegacyData } from "./data-dir.js";
import { closeDisciplineStores, DisciplineStore, getDisciplineStore } from "./store.js";

const Database = createRequire(import.meta.url)("better-sqlite3");
const manifest = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "..", "infinibot.plugin.json"), "utf-8"),
);

let stateDir: string;

type Registered = {
  methods: Map<string, (opts: any) => unknown>;
  services: Array<{ id: string; start: (ctx: any) => unknown; stop?: (ctx: any) => unknown }>;
  slots: string[];
  agentListeners: number;
  completionListeners: number;
};

function fakeApi(): { api: any; reg: Registered } {
  const reg: Registered = {
    methods: new Map(),
    services: [],
    slots: [],
    agentListeners: 0,
    completionListeners: 0,
  };
  const api = {
    id: "discipline",
    pluginConfig: {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    registerGatewayMethod: (m: string, h: any) => reg.methods.set(m, h),
    registerService: (s: any) => reg.services.push(s),
    runtime: {
      state: { resolveStateDir: () => stateDir },
      channel: { telegram: { sendMessageTelegram: vi.fn(async () => ({})) } },
      host: {
        onAgentEvent: () => {
          reg.agentListeners++;
          return () => reg.agentListeners--;
        },
        onWorkCompleted: () => {
          reg.completionListeners++;
          return () => reg.completionListeners--;
        },
        emitNotification: vi.fn(async () => "n1"),
        gatherBusinessSnapshot: vi.fn(),
        setDayPlannerProvider,
        setCoreToolSlot: (name: string, fill: any) => {
          if (fill) reg.slots.push(name);
          setCoreToolSlot(name, fill);
        },
      },
    },
  };
  return { api, reg };
}

async function call(reg: Registered, method: string, params: Record<string, unknown> = {}) {
  let out: { ok: boolean; payload?: any; error?: any } | undefined;
  await reg.methods.get(method)!({
    params,
    respond: (ok: boolean, payload?: unknown, error?: unknown) => (out = { ok, payload, error }),
  });
  return out!;
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "discipline-plugin-"));
});
afterEach(() => {
  closeDisciplineStores();
  setCoreToolSlot("discipline", null);
  setCoreToolSlot("focus", null);
  setDayPlannerProvider(null);
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("discipline manifest", () => {
  it("parses as v2 with appearance, listing art and FSL licence", () => {
    const res = parseManifestV2("discipline", manifest);
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    if (!res.ok) return;
    expect(res.fields.license).toBe("FSL-1.1-ALv2");
    expect(res.fields.contributes.pages.map((p) => p.tab)).toEqual(["discipline", "focus"]);
    for (const img of [
      manifest.listing.cover,
      manifest.listing.icon,
      ...manifest.listing.screenshots.map((s: any) => s.src),
    ]) {
      expect(fs.existsSync(path.join(import.meta.dirname, "..", img)), img).toBe(true);
    }
  });
});

describe("register", () => {
  it("registers exactly the RPCs the manifest declares, and arms nothing", () => {
    const { api, reg } = fakeApi();
    register(api);
    const declared = manifest.contributes.rpc.map((r: any) => r.method).sort();
    expect([...reg.methods.keys()].sort()).toEqual(declared);
    expect(reg.services.map((s) => s.id)).toEqual(manifest.contributes.services);
    expect(reg.slots.sort()).toEqual(["discipline", "focus"]);
    // Import + register start no subscriptions or timers.
    expect(reg.agentListeners).toBe(0);
    expect(reg.completionListeners).toBe(0);
    expect(pendingAlertTimers()).toBe(0);
  });

  it("service start subscribes + arms timers; stop leaves nothing behind", async () => {
    const { api, reg } = fakeApi();
    register(api);
    const svc = reg.services[0];
    await svc.start({});
    expect(reg.agentListeners).toBe(1);
    expect(reg.completionListeners).toBe(1);
    expect(pendingAlertTimers()).toBeGreaterThan(0);
    await svc.stop?.({});
    expect(reg.agentListeners).toBe(0);
    expect(reg.completionListeners).toBe(0);
    expect(pendingAlertTimers()).toBe(0);
  });

  it("blocks round-trip through the RPCs into plugin-data", async () => {
    const { api, reg } = fakeApi();
    register(api);
    const created = await call(reg, "discipline.blocks.create", {
      label: "Deep work",
      category: "deep-work",
      startMinute: 540,
      endMinute: 660,
    });
    expect(created.ok).toBe(true);
    const state = await call(reg, "discipline.state");
    expect(state.payload.blocks.map((b: any) => b.label)).toEqual(["Deep work"]);
    expect(fs.existsSync(path.join(disciplineDataDir(stateDir), "discipline.db"))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, "discipline.db"))).toBe(false);
  });

  it("focus.set stores UI items with titles (no Notion needed)", async () => {
    const { api, reg } = fakeApi();
    register(api);
    const res = await call(reg, "discipline.focus.set", {
      items: [
        { id: "t1", type: "task", title: "Ship the plugin" },
        { id: "p1", type: "project", title: "Launch" },
      ],
    });
    expect(res.ok).toBe(true);
    const list = await call(reg, "discipline.focus.list");
    expect(list.payload.items.map((i: any) => [i.id, i.title, i.priority])).toEqual([
      ["t1", "Ship the plugin", 1],
      ["p1", "Launch", 2],
    ]);
  });

  it("fills the tool slots and the day-planner seam — only while the plugin is loaded", () => {
    const { api } = fakeApi();
    register(api);
    const activate = (status: "loaded" | "disabled") =>
      setActivePluginRegistry({ plugins: [{ id: "discipline", status }] } as never);
    activate("loaded");
    expect(createSlotTool("discipline", "Discipline").description).toMatch(/time-blocks/);
    expect(dropEmptyToolSlots([createSlotTool("focus", "Discipline")])).toHaveLength(1);
    expect(getDayPlannerProvider()?.pluginId).toBe("discipline");
    // Turned off in-process: the registration lingers but no longer counts.
    activate("disabled");
    expect(dropEmptyToolSlots([createSlotTool("discipline", "Discipline")])).toEqual([]);
    expect(getDayPlannerProvider()).toBeNull();
  });
});

describe("empty slots (plugin off)", () => {
  it("yield a stub that tool pipelines drop", async () => {
    const stub = createSlotTool("discipline", "Discipline");
    expect(dropEmptyToolSlots([stub])).toEqual([]);
    const out = await stub.execute("c1", {} as never, undefined as never, undefined as never);
    expect(JSON.stringify(out)).toMatch(/plugin is disabled/);
    expect(JSON.stringify(out)).toMatch(/Home › Plugins › Discipline/);
  });
});

describe("legacy data move", () => {
  it("moves discipline.db (WAL flushed), notion config and focus.json once", () => {
    const legacy = path.join(stateDir, "discipline.db");
    // Pre-plugin layout: the real store writing <stateDir>/discipline.db (WAL).
    const old = new DisciplineStore(stateDir);
    const block = old.createBlock({
      label: "Morning",
      category: "deep-work",
      startMinute: 480,
      endMinute: 540,
    } as never);
    // keep the connection open so the row may still sit in the WAL
    fs.writeFileSync(path.join(stateDir, "discipline-notion.json"), '{"connected":false}');
    fs.writeFileSync(path.join(stateDir, "focus.json"), '{"items":[{"id":"x"}]}');

    const first = migrateLegacyData(stateDir);
    old.close();
    expect(first.moved).toHaveLength(3);
    const dir = disciplineDataDir(stateDir);
    const moved = new Database(path.join(dir, "discipline.db"), { readonly: true });
    expect(moved.prepare("SELECT label FROM discipline_blocks").get()).toEqual({
      label: "Morning",
    });
    moved.close();
    expect(fs.existsSync(`${legacy}.moved-to-plugin-data`)).toBe(true);
    expect(fs.existsSync(path.join(dir, "focus.json"))).toBe(true);

    // idempotent
    expect(migrateLegacyData(stateDir).moved).toEqual([]);
    expect(
      getDisciplineStore(stateDir)
        .getBlocks()
        .map((b) => b.id),
    ).toEqual([block.id]);
  });
});
