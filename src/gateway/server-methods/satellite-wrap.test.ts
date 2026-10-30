/**
 * Federation satellite-proxy wraps applied to per-handler files in Pillar 2.
 *
 * For each handler file that gained a `proxyMethodsToMaster` or
 * `applySatelliteProxy` wrap, assert that:
 *   - On a connected satellite, the wrapped method forwards the call to
 *     master via `invokeOnMaster` instead of touching the local store.
 *   - On master / standalone, the same method runs the local handler.
 *   - For partial wraps (channels), only the named methods are forwarded;
 *     un-named methods still run locally even on a satellite.
 *
 * The handler internals (CRUD correctness) are covered by their own dedicated
 * tests. These cases focus narrowly on the satellite proxy wiring.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/config.js", () => ({
  loadConfig: vi.fn(() => ({ federation: { mode: "standalone" } })),
}));

vi.mock("../../federation/satellite.js", () => ({
  getFederationSatellite: vi.fn(() => null),
}));

// Notes pulls in the role bridge + a file-based note store at import time.
// Stub both so the test never touches disk.
vi.mock("../../databases/system-role-bridge.js", () => ({
  describeRoleBridge: vi.fn(() => ({ mode: "legacy" })),
  getRoleMode: vi.fn(() => ({ mode: "legacy" })),
  importLegacyRecordsToRole: vi.fn(),
  listRowsForRole: vi.fn(() => []),
  getRowForRole: vi.fn(() => null),
  upsertRowForRole: vi.fn(() => null),
  deleteRowForRole: vi.fn(() => false),
}));

vi.mock("../../notes/store.js", () => ({
  NoteStore: vi.fn(function NoteStore(this: Record<string, unknown>) {
    this.list = vi.fn(() => []);
    this.get = vi.fn(() => null);
    this.create = vi.fn(() => ({ id: "n1", name: "x", body: "" }));
    this.update = vi.fn(() => null);
    this.delete = vi.fn(() => false);
  }),
}));

// Characters store has lots of side effects; stub at the module level.
vi.mock("../../characters/store.js", () => ({
  initCharacterStore: vi.fn(),
  createCharacter: vi.fn(),
  createCharacterFromBase64: vi.fn(),
  getCharacter: vi.fn(),
  listCharacters: vi.fn(() => []),
  addCharacterImage: vi.fn(),
  addCharacterImageFromBase64: vi.fn(),
  updateCharacter: vi.fn(),
  deleteCharacter: vi.fn(),
  deleteCharacterImage: vi.fn(),
  setPrimaryImage: vi.fn(),
  searchCharacters: vi.fn(() => []),
}));

// Channels: a sprawling plugin system. Stub just the imports the handler
// touches at module load.
vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: vi.fn(() => null),
  listChannelPlugins: vi.fn(() => []),
  normalizeChannelId: vi.fn((id: string) => id as never),
}));
vi.mock("../../channels/plugins/catalog.js", () => ({
  buildChannelUiCatalog: vi.fn(() => ({
    order: [],
    labels: {},
    detailLabels: {},
    systemImages: {},
    entries: {},
  })),
}));
vi.mock("../../channels/plugins/status.js", () => ({
  buildChannelAccountSnapshot: vi.fn(async () => ({})),
}));
vi.mock("../../channels/plugins/helpers.js", () => ({
  resolveChannelDefaultAccountId: vi.fn(() => "default"),
}));
vi.mock("../../infra/channel-activity.js", () => ({
  getChannelActivity: vi.fn(() => ({ inboundAt: null, outboundAt: null })),
}));
vi.mock("../../runtime.js", () => ({
  defaultRuntime: {},
}));
vi.mock("../protocol/index.js", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    validateChannelsStatusParams: Object.assign((_: unknown) => true, { errors: null }),
    validateChannelsLogoutParams: Object.assign((_: unknown) => true, { errors: null }),
  };
});

import { loadConfig } from "../../config/config.js";
import { getFederationSatellite } from "../../federation/satellite.js";
import { noteHandlers } from "./notes.js";
import { characterHandlers } from "./characters.js";
import { channelsHandlers } from "./channels.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeConnectedSatellite(masterReply: unknown) {
  return {
    getState: () => "connected",
    invokeOnMaster: vi.fn().mockResolvedValue({ success: true, data: masterReply }),
  };
}

function makeOpts(params: Record<string, unknown> = {}): GatewayRequestHandlerOptions {
  const respond = vi.fn();
  return {
    req: {} as never,
    params,
    client: null,
    isWebchatConnect: () => false,
    respond,
    context: {} as never,
  };
}

function setSatelliteMode(connected: boolean) {
  vi.mocked(loadConfig).mockReturnValue({
    federation: { mode: "satellite" },
  } as ReturnType<typeof loadConfig>);
  if (connected) {
    const sat = makeConnectedSatellite({ source: "master" });
    vi.mocked(getFederationSatellite).mockReturnValue(
      sat as unknown as ReturnType<typeof getFederationSatellite>,
    );
    return sat;
  }
  vi.mocked(getFederationSatellite).mockReturnValue(null);
  return null;
}

function setStandaloneMode() {
  vi.mocked(loadConfig).mockReturnValue({
    federation: { mode: "standalone" },
  } as ReturnType<typeof loadConfig>);
  vi.mocked(getFederationSatellite).mockReturnValue(null);
}

beforeEach(() => {
  vi.mocked(loadConfig).mockReset();
  vi.mocked(getFederationSatellite).mockReset();
});

// ── notes ──────────────────────────────────────────────────────────────────

describe("noteHandlers satellite wrap", () => {
  it("proxies notes.list to master when satellite connected", async () => {
    const sat = setSatelliteMode(true);
    const opts = makeOpts({});
    await noteHandlers["notes.list"](opts);
    expect(sat?.invokeOnMaster).toHaveBeenCalledWith("notes.list", {});
    expect(opts.respond).toHaveBeenCalledWith(true, { source: "master" });
  });

  it("runs notes.create locally in standalone mode", async () => {
    setStandaloneMode();
    const opts = makeOpts({ name: "x", body: "y" });
    await noteHandlers["notes.create"](opts);
    // local handler responds with whatever the stub store returns
    expect(opts.respond).toHaveBeenCalled();
    const args = vi.mocked(opts.respond).mock.calls[0];
    expect(args[0]).toBe(true);
  });
});

// ── characters ─────────────────────────────────────────────────────────────

describe("characterHandlers satellite wrap", () => {
  it("proxies characters.list to master when satellite connected", async () => {
    const sat = setSatelliteMode(true);
    const opts = makeOpts({});
    await characterHandlers["characters.list"](opts);
    expect(sat?.invokeOnMaster).toHaveBeenCalledWith("characters.list", {});
    expect(opts.respond).toHaveBeenCalledWith(true, { source: "master" });
  });

  it("runs characters.list locally in standalone mode", async () => {
    setStandaloneMode();
    const opts = makeOpts({});
    await characterHandlers["characters.list"](opts);
    expect(opts.respond).toHaveBeenCalledWith(true, { characters: [] });
  });
});

// ── channels ───────────────────────────────────────────────────────────────

describe("channelsHandlers selective satellite wrap", () => {
  it("proxies channels.status to master when satellite connected", async () => {
    const sat = setSatelliteMode(true);
    const opts = makeOpts({ probe: false });
    await channelsHandlers["channels.status"](opts);
    expect(sat?.invokeOnMaster).toHaveBeenCalledWith("channels.status", { probe: false });
    expect(opts.respond).toHaveBeenCalledWith(true, { source: "master" });
  });

  it("leaves channels.logout running locally even on a satellite", async () => {
    const sat = setSatelliteMode(true);
    const opts = makeOpts({ channel: "telegram" });
    // The local handler will fail because we stubbed channel plugin lookup to
    // return null — what matters is that the satellite proxy was NOT called.
    await channelsHandlers["channels.logout"](opts);
    expect(sat?.invokeOnMaster).not.toHaveBeenCalledWith("channels.logout", expect.anything());
  });
});

// Discipline (discipline.*) moved into the Discipline plugin; satellite →
// master forwarding for it is the dispatcher's "discipline." proxy prefix.
