import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  setupRunning: false,
  setupContainer: null as string | null,
  containers: {} as Record<string, string>,
  native: false,
  nativeStarts: 0,
};
const spawned: string[][] = [];

vi.mock("./voice/local-setup/runner.js", () => ({
  isLocalVoiceSetupRunning: () => state.setupRunning,
}));
vi.mock("./voice/local-setup/wire.js", () => ({
  setupKokoroContainer: () => state.setupContainer,
  setupNativeEngine: () => (state.native ? { port: 8886 } : null),
  ensureNativeVoiceEngine: async () => {
    state.nativeStarts++;
    return true;
  },
}));
vi.mock("node:child_process", () => ({
  execFile: (
    _cmd: string,
    args: string[],
    _opts: unknown,
    cb: (err: unknown, out: string) => void,
  ) => {
    const s = state.containers[args[2]!];
    cb(s ? null : new Error("No such container"), s ?? "");
  },
  spawn: (_cmd: string, args: string[]) => {
    spawned.push(args);
    return { on: () => undefined, unref: () => undefined };
  },
}));

const { restartKokoro } = await import("./kokoro-bootstrap.js");

describe("restartKokoro — never fights the setup or Docker", () => {
  beforeEach(() => {
    state.setupRunning = false;
    state.setupContainer = null;
    state.containers = {};
    state.native = false;
    state.nativeStarts = 0;
    spawned.length = 0;
  });

  it("built-in engine: hands off to its supervisor, never touches Docker", async () => {
    state.native = true;
    state.containers["infinibot-kokoro"] = "exited";
    expect(await restartKokoro("/x/docker-compose.voice.yaml")).toBe(true);
    expect(state.nativeStarts).toBe(1);
    expect(spawned).toEqual([]);
  });

  it("does nothing while the one-click setup is running", async () => {
    state.setupRunning = true;
    expect(await restartKokoro("/x/docker-compose.voice.yaml")).toBe(false);
    expect(spawned).toEqual([]);
  });

  it("leaves a container Docker is already restarting alone", async () => {
    state.setupContainer = "infinibot-voice-kokoro";
    state.containers["infinibot-voice-kokoro"] = "restarting";
    expect(await restartKokoro("/x/docker-compose.voice.yaml")).toBe(false);
    expect(spawned).toEqual([]);
  });

  it("starts the setup's stopped container with docker start (no compose name clash)", async () => {
    state.setupContainer = "infinibot-voice-kokoro";
    state.containers["infinibot-voice-kokoro"] = "exited";
    expect(await restartKokoro("/x/docker-compose.voice.yaml")).toBe(true);
    expect(spawned).toEqual([["start", "infinibot-voice-kokoro"]]);
  });

  it("starts the older compose container by name when it exists", async () => {
    state.containers["infinibot-kokoro"] = "exited";
    expect(await restartKokoro("/x/docker-compose.voice.yaml")).toBe(true);
    expect(spawned).toEqual([["start", "infinibot-kokoro"]]);
  });

  it("falls back to compose up when no container exists yet", async () => {
    expect(await restartKokoro("/x/docker-compose.voice.yaml")).toBe(true);
    expect(spawned[0]?.slice(0, 2)).toEqual(["compose", "-f"]);
  });
});
