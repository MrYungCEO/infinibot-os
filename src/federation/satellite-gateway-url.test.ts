/**
 * Tests for satellite gateway URL advertising.
 *
 * Background: mobile voice falls back to the local gateway whenever a
 * satellite entry in `federation.nodes.list` is missing a reachable URL
 * field. These tests cover both halves of the fix:
 *
 *   1. `resolveGatewayUrl` (satellite side) — what the satellite puts
 *      into its `NodeManifest.gatewayUrl` at registration time.
 *   2. `satelliteReachableUrl` (master side) — what
 *      `federation.nodes.list` exposes as `node.url` to mobile.
 */

import { describe, it, expect } from "vitest";

import { resolveGatewayUrl } from "./satellite.js";
import { satelliteReachableUrl } from "../gateway/server-methods/federation.js";
import type { NodeManifest } from "./types.js";

function manifest(overrides: Partial<NodeManifest> = {}): NodeManifest {
  return {
    id: "sat-1",
    name: "sat-1",
    hostname: "sat-host",
    port: 18789,
    workspace: "/tmp",
    capabilities: {
      hasOllama: false,
      hasComfyUI: false,
      hasVoice: false,
      mcpServers: [],
      agents: [],
      workspaces: ["/tmp"],
      platform: "linux",
      arch: "x64",
    },
    isMaster: false,
    ...overrides,
  };
}

describe("resolveGatewayUrl (satellite advertisement)", () => {
  it("falls back to ws://host:port/federation when no publicUrl is set", () => {
    expect(resolveGatewayUrl(undefined, "node-a.local", 18789)).toBe(
      "ws://node-a.local:18789/federation",
    );
  });

  it("trims whitespace publicUrl as if it were absent", () => {
    expect(resolveGatewayUrl("   ", "node-a.local", 18789)).toBe(
      "ws://node-a.local:18789/federation",
    );
  });

  it("respects an explicit publicUrl and appends /federation if missing", () => {
    expect(resolveGatewayUrl("https://node-a.example.com", "node-a.local", 18789)).toBe(
      "https://node-a.example.com/federation",
    );
  });

  it("does not double-append /federation when publicUrl already has it", () => {
    expect(resolveGatewayUrl("https://node-a.example.com/federation", "node-a.local", 18789)).toBe(
      "https://node-a.example.com/federation",
    );
  });

  it("strips trailing slashes from publicUrl before appending /federation", () => {
    expect(resolveGatewayUrl("https://node-a.example.com/", "node-a.local", 18789)).toBe(
      "https://node-a.example.com/federation",
    );
  });
});

describe("satelliteReachableUrl (master exposes URL to clients)", () => {
  it("returns null when no manifest is present", () => {
    expect(satelliteReachableUrl(null)).toBeNull();
    expect(satelliteReachableUrl(undefined)).toBeNull();
  });

  it("prefers the manifest's gatewayUrl when the satellite advertised one", () => {
    const m = manifest({ gatewayUrl: "ws://192.168.1.150:18789/federation" });
    expect(satelliteReachableUrl(m)).toBe("ws://192.168.1.150:18789/federation");
  });

  it("ignores blank-string gatewayUrl and falls back to hostname+port", () => {
    const m = manifest({ gatewayUrl: "   ", hostname: "sat-host", port: 18789 });
    expect(satelliteReachableUrl(m)).toBe("ws://sat-host:18789/federation");
  });

  it("derives ws://hostname:port/federation when older manifest lacks gatewayUrl", () => {
    const m = manifest({ hostname: "sat-host", port: 47913 });
    expect(satelliteReachableUrl(m)).toBe("ws://sat-host:47913/federation");
  });

  it("returns null when neither gatewayUrl nor hostname+port are available", () => {
    const m = manifest({ hostname: "", port: 0 });
    expect(satelliteReachableUrl(m)).toBeNull();
  });

  it("produces a URL in the shape mobile's nodeHttpBase expects", () => {
    // Mobile strips /federation and converts ws→http; both transforms
    // are applied here to confirm the produced URL round-trips cleanly
    // through the helper without leaving stray slashes.
    const m = manifest({ hostname: "node-a", port: 18789 });
    const url = satelliteReachableUrl(m)!;
    const stripped = url.replace(/\/federation\/?$/, "");
    const httpBase = stripped.replace(/^ws(s?):\/\//i, "http$1://").replace(/\/$/, "");
    expect(httpBase).toBe("http://node-a:18789");
  });
});
