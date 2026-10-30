/**
 * Satellite join + handshake: invite token → durable device credential,
 * persisted hub key, plain rejection reasons, capability registration.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FederationSecurity,
  DEFAULT_PERMISSIONS,
  getFederationSecurity,
  resetFederationSecurityForTests,
  resolveHubKeyPairPath,
} from "./security.js";
import {
  readPairedDevices,
  resolveSatelliteAuthToken,
  readSatelliteCredential,
  revokePairedDevice,
  tokenFingerprint,
  upsertPairedDevice,
  writeSatelliteCredential,
} from "./paired-devices.js";
import { FederationHub } from "./hub.js";
import { FederationSatellite } from "./satellite.js";
import { FEDERATION_PROTOCOL_VERSION } from "./protocol.js";
import { collectDeviceCapabilities, detectScreenshotBackend } from "./device-capabilities.js";

let dir: string;
const prevState = process.env.INFINIBOT_STATE_DIR;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-sat-join-"));
  process.env.INFINIBOT_STATE_DIR = dir;
  resetFederationSecurityForTests();
});
afterEach(() => {
  process.env.INFINIBOT_STATE_DIR = prevState;
  delete process.env.INFINIBOT_FEDERATION_PERSIST_KEYS;
  resetFederationSecurityForTests();
  fs.rmSync(dir, { recursive: true, force: true });
});

function fakeSocket() {
  const sent: Array<Record<string, any>> = [];
  let closed: { code?: number; reason?: string } | null = null;
  return {
    sent,
    get closed() {
      return closed;
    },
    readyState: 1,
    send: (m: string) => sent.push(JSON.parse(m)),
    close: (code?: number, reason?: string) => {
      closed = { code, reason };
    },
    on: () => {},
    once: () => {},
    terminate: () => {},
  };
}

function registerMessage(token: unknown, id = "laptop-node") {
  return {
    type: "node.register",
    nodeId: id,
    timestamp: Date.now(),
    payload: {
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      token,
      manifest: {
        id,
        name: "CEO laptop",
        hostname: "ceo-laptop",
        port: 18789,
        workspace: "/tmp/ws",
        capabilities: {
          hasOllama: false,
          hasComfyUI: false,
          hasVoice: false,
          mcpServers: [],
          agents: [],
          workspaces: [],
          platform: "win32",
        },
        isMaster: false,
      },
    },
  };
}

describe("hub key persistence", () => {
  it("keeps invite tokens valid across a master restart", () => {
    const file = path.join(dir, "federation", "hub-keypair.json");
    const a = new FederationSecurity({ keyPairPath: file });
    const token = a.createSatelliteToken("sat-1", DEFAULT_PERMISSIONS.full, 0.25);
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe("600");
    const restarted = new FederationSecurity({ keyPairPath: file });
    expect(restarted.validateSatelliteToken(token)).toBeTruthy();
    // A fresh in-memory key (the old behaviour) rejects it.
    expect(new FederationSecurity().validateSatelliteToken(token)).toBeNull();
  });

  it("getFederationSecurity persists only when opted in under vitest", () => {
    getFederationSecurity();
    expect(fs.existsSync(resolveHubKeyPairPath())).toBe(false);
    resetFederationSecurityForTests();
    process.env.INFINIBOT_FEDERATION_PERSIST_KEYS = "1";
    getFederationSecurity();
    expect(fs.existsSync(resolveHubKeyPairPath())).toBe(true);
  });
});

describe("token diagnosis (plain errors)", () => {
  it("explains expired, foreign and revoked tokens", () => {
    const sec = new FederationSecurity();
    const expired = {
      ...sec.createSatelliteToken("a", DEFAULT_PERMISSIONS.full, 1),
      expiresAt: Date.now() - 1000,
    };
    expired.signature = (sec as any).signToken(expired);
    expect(sec.diagnoseSatelliteToken(expired)?.code).toBe("expired");
    expect(sec.diagnoseSatelliteToken(expired)?.message).toMatch(/expired/i);

    const foreign = new FederationSecurity().createSatelliteToken("b", DEFAULT_PERMISSIONS.full, 1);
    expect(sec.diagnoseSatelliteToken(foreign)?.code).toBe("unknown_signer");

    const ok = sec.createSatelliteToken("c", DEFAULT_PERMISSIONS.full, 1);
    expect(sec.diagnoseSatelliteToken(ok)).toBeNull();
    sec.revokeSatelliteToken("c");
    expect(sec.diagnoseSatelliteToken(ok)?.code).toBe("revoked");
    expect(sec.diagnoseSatelliteToken({} as any)?.code).toBe("malformed");
  });
});

describe("hub registration handshake", () => {
  it("swaps a valid invite for a durable device credential and records the device", () => {
    const hub = new FederationHub({ enableDiscovery: false });
    const sec = getFederationSecurity();
    const invite = sec.createSatelliteToken("sat-xyz", DEFAULT_PERMISSIONS.full, 0.25);
    const sock = fakeSocket();
    (hub as any).handleRegister(sock, registerMessage(invite, "sat-xyz"));
    const ack = sock.sent.find((m) => m.type === "node.register.ack");
    expect(ack?.payload.success).toBe(true);
    const cred = ack.payload.security?.credential;
    expect(cred?.satelliteId).toBe("sat-xyz");
    expect(cred?.expiresAt).toBeUndefined();
    expect(sec.validateSatelliteToken(cred)).toBeTruthy();
    expect(ack.payload.security.publicKeyFingerprint).toMatch(/^[0-9a-f]{32}$/);
    // Permissions are granted to the node id the device registered under.
    expect(sec.getPermissions("sat-xyz")?.allowedOperations).toContain("session.spawn");
    const devices = readPairedDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      satelliteId: "sat-xyz",
      name: "CEO laptop",
      platform: "win32",
    });
    // The credential is never written into the device record.
    expect(JSON.stringify(devices)).not.toContain(cred.signature);
    void hub.stop?.();
  });

  it("a reconnect with the device credential is accepted without issuing another", () => {
    const hub = new FederationHub({ enableDiscovery: false });
    const sec = getFederationSecurity();
    const cred = sec.createSatelliteToken("sat-2", DEFAULT_PERMISSIONS.full);
    const sock = fakeSocket();
    (hub as any).handleRegister(sock, registerMessage(cred, "sat-2"));
    const ack = sock.sent.find((m) => m.type === "node.register.ack");
    expect(ack?.payload.success).toBe(true);
    expect(ack.payload.security?.credential).toBeUndefined();
    void hub.stop?.();
  });

  it("rejects tokenless, expired and removed devices with actionable messages", () => {
    const hub = new FederationHub({ enableDiscovery: false });
    const sec = getFederationSecurity();

    const s1 = fakeSocket();
    (hub as any).handleRegister(s1, registerMessage(undefined));
    expect(s1.sent[0]).toMatchObject({ type: "error", payload: { code: "UNAUTHORIZED" } });
    expect(s1.sent[0].payload.message).toMatch(/Share Invite/);
    expect(s1.closed?.code).toBe(1008);

    const expired = sec.createSatelliteToken("old", DEFAULT_PERMISSIONS.full, 1);
    expired.expiresAt = Date.now() - 1;
    expired.signature = (sec as any).signToken(expired);
    const s2 = fakeSocket();
    (hub as any).handleRegister(s2, registerMessage(expired));
    expect(s2.sent[0].payload.message).toMatch(/expired/i);

    const cred = sec.createSatelliteToken("gone", DEFAULT_PERMISSIONS.full);
    upsertPairedDevice({ satelliteId: "gone", nodeId: "gone" });
    revokePairedDevice("gone");
    sec.revokeSatelliteToken("gone");
    const s3 = fakeSocket();
    (hub as any).handleRegister(s3, registerMessage(cred, "gone"));
    expect(s3.sent[0].payload.message).toMatch(/removed/i);
    void hub.stop?.();
  });
});

describe("satellite side", () => {
  it("presents the invite from config, then the stored device credential", () => {
    const sec = new FederationSecurity();
    const invite = sec.createSatelliteToken("sat-9", DEFAULT_PERMISSIONS.full, 0.25);
    expect(resolveSatelliteAuthToken(invite, null)).toBe(invite);
    const cred = sec.createSatelliteToken("sat-9", DEFAULT_PERMISSIONS.full);
    writeSatelliteCredential({ token: cred, masterUrl: "ws://m/federation" });
    const file = path.join(dir, "federation", "satellite-credential.json");
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe("600");
    expect(resolveSatelliteAuthToken(invite)).toEqual(cred);
    // A NEW invite (different satelliteId) means re-joining: the invite wins.
    const other = sec.createSatelliteToken("sat-new", DEFAULT_PERMISSIONS.full, 0.25);
    expect(resolveSatelliteAuthToken(other)).toBe(other);
    expect(tokenFingerprint(cred)).toMatch(/^[0-9a-f]{8}$/);
  });

  it("saves the credential from register.ack and reports status without secrets", async () => {
    const sec = new FederationSecurity();
    const invite = sec.createSatelliteToken("sat-ack", DEFAULT_PERMISSIONS.full, 0.25);
    const sat = new FederationSatellite({
      masterUrl: "ws://127.0.0.1:1/federation",
      authToken: invite,
      nodeId: "sat-ack",
      enablePeerMesh: false,
    });
    expect(sat.getManifest().id).toBe("sat-ack");
    const cred = sec.createSatelliteToken("sat-ack", DEFAULT_PERMISSIONS.full);
    await (sat as any).handleRegisterAck({
      success: true,
      nodeId: "sat-ack",
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      security: { scopes: [], credential: cred, publicKeyFingerprint: "f".repeat(32) },
    });
    expect(readSatelliteCredential()?.token).toEqual(cred);
    const st = sat.getStatus();
    expect(st).toMatchObject({
      state: "connected",
      nodeId: "sat-ack",
      paired: true,
      credentialKind: "device",
      permissionLevel: "full",
    });
    expect(JSON.stringify(st)).not.toContain(cred.signature);
    const statusFile = JSON.parse(
      fs.readFileSync(path.join(dir, "federation", "satellite-status.json"), "utf-8"),
    );
    expect(statusFile.state).toBe("connected");
    expect(JSON.stringify(statusFile)).not.toContain(cred.signature);
    await sat.disconnect();
  });

  it("registers device capabilities in its manifest", () => {
    const sat = new FederationSatellite({
      masterUrl: "ws://127.0.0.1:1/federation",
      enablePeerMesh: false,
    });
    const device = sat.getManifest().capabilities.device;
    expect(device?.hostname).toBe(os.hostname());
    expect(device?.cpu.cores).toBeGreaterThan(0);
    expect(device?.memoryMB).toBeGreaterThan(0);
    expect(device?.features).toMatchObject({ exec: true, files: true });
    void sat.disconnect();
  });
});

describe("device capability detection", () => {
  it("finds CLIs on PATH and picks a screenshot backend per platform", () => {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    for (const n of ["claude", "xwd", "tmux"]) {
      fs.writeFileSync(path.join(bin, n), "#!/bin/sh\n", { mode: 0o755 });
    }
    const env = { PATH: bin, DISPLAY: ":91" };
    const caps = collectDeviceCapabilities(env, "linux");
    expect(caps.clis).toEqual(["claude"]);
    expect(caps.features.terminal).toBe(true);
    expect(caps.features.screenshot).toBe(true);
    expect(caps.screenshotBackend).toBe("xwd");
    expect(detectScreenshotBackend({ PATH: bin }, "linux")).toBeUndefined(); // headless
    expect(detectScreenshotBackend({}, "win32")).toBe("powershell");
    expect(collectDeviceCapabilities({ PATH: "" }, "win32").features.input).toBe(true);
  });
});
