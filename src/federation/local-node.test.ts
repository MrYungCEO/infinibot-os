/**
 * Tests for isLocalNodeId — the single local-vs-remote decision used by the
 * spawn/send handlers and the forwarder. Getting this right is what stops a
 * forwarded call from re-forwarding forever (and what routes "master" up from
 * a satellite).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./hub.js", () => ({ getFederationHub: vi.fn(() => null) }));
vi.mock("./satellite.js", () => ({ getFederationSatellite: vi.fn(() => null) }));

import { getFederationHub } from "./hub.js";
import { getFederationSatellite } from "./satellite.js";
import { isLocalNodeId, getLocalNodeId } from "./local-node.js";

beforeEach(() => {
  vi.mocked(getFederationHub).mockReturnValue(null);
  vi.mocked(getFederationSatellite).mockReturnValue(null);
});

function asMaster(id: string) {
  vi.mocked(getFederationHub).mockReturnValue({
    getLocalNodeId: () => id,
  } as unknown as ReturnType<typeof getFederationHub>);
}
function asSatellite(id: string) {
  vi.mocked(getFederationSatellite).mockReturnValue({
    getManifest: () => ({ id }),
  } as unknown as ReturnType<typeof getFederationSatellite>);
}

describe("isLocalNodeId", () => {
  it("treats empty / 'local' as local everywhere", () => {
    expect(isLocalNodeId("")).toBe(true);
    expect(isLocalNodeId(undefined)).toBe(true);
    expect(isLocalNodeId("local")).toBe(true);
    asMaster("m1");
    expect(isLocalNodeId("  local ")).toBe(true);
  });

  it("on master: own id and 'master' alias are local; peers are remote", () => {
    asMaster("master-1");
    expect(isLocalNodeId("master-1")).toBe(true);
    expect(isLocalNodeId("master")).toBe(true);
    expect(isLocalNodeId("sat-2")).toBe(false);
  });

  it("on satellite: own id is local but 'master' is REMOTE (must route up)", () => {
    asSatellite("sat-1");
    expect(isLocalNodeId("sat-1")).toBe(true);
    expect(isLocalNodeId("master")).toBe(false);
    expect(isLocalNodeId("sat-2")).toBe(false);
  });

  it("getLocalNodeId resolves from hub, then satellite, else null", () => {
    expect(getLocalNodeId()).toBeNull();
    asSatellite("sat-9");
    expect(getLocalNodeId()).toBe("sat-9");
    asMaster("m-9");
    expect(getLocalNodeId()).toBe("m-9"); // hub wins
  });
});
