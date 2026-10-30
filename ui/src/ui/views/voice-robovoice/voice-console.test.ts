import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { RobovoiceCallSession, type CallDeps, type RoomHandlers } from "./call-session";
import { VOICE_PAGE_WRITE_METHODS, voiceConsoleActions, normalizePublicUrl, parseEmails } from "./console-actions";
import {
  IDLE_CALL,
  ageText,
  callInProgress,
  callReducer,
  consolePhase,
  latencyP50,
  requestVoiceCall,
  startBlockedReason,
  takeVoiceIntent,
  isCloudVoiceBusy,
  CLOUD_VOICE_BUSY_TEXT,
  type RvLinkStatus,
} from "./console-state";

const here = dirname(fileURLToPath(import.meta.url));

const baseStatus = (over: Partial<RvLinkStatus> = {}): RvLinkStatus => ({
  linked: false,
  signedIn: false,
  apiBase: "https://robovoice.io",
  agents: [],
  pending: null,
  ...over,
});

const LINKED = baseStatus({
  linked: true,
  signedIn: true,
  org: { id: "o1", name: "RoboPark" },
  location: { id: "436455aa", name: "InfiniBot · My-Host-01", dashboardUrl: "https://robovoice.io/dashboard/locations/436455aa" },
  agents: [{ agentId: "main", name: "INFINI", characterId: "c1", managed: true }],
});


describe("Voice page state machine", () => {
  it("plugin off → one card, nothing else", () => {
    expect(consolePhase({ pluginAvailable: false, status: LINKED })).toBe("plugin-off");
  });

  it("unlinked: never linked, or device retired", () => {
    expect(consolePhase({ pluginAvailable: true, status: null })).toBe("loading");
    expect(consolePhase({ pluginAvailable: true, status: null, error: "gateway not connected" })).toBe("error");
    expect(consolePhase({ pluginAvailable: true, status: baseStatus() })).toBe("unlinked");
    expect(consolePhase({ pluginAvailable: true, status: { ...LINKED, unlinkedAt: "2026-09-30T00:00:00Z" } })).toBe("unlinked");
  });

  it("linking while the device-code sign-in is pending or approving", () => {
    const pending = { userCode: "ABCD-EFGH", verificationUriComplete: "https://robovoice.io/edge/activate?code=ABCD-EFGH", expiresAt: 0 };
    expect(consolePhase({ pluginAvailable: true, status: baseStatus({ pending: { ...pending, status: "pending" } }) })).toBe("linking");
    expect(consolePhase({ pluginAvailable: true, status: baseStatus({ pending: { ...pending, status: "linking" } }) })).toBe("linking");
    // An errored sign-in drops back to the connect state (with the error note).
    expect(consolePhase({ pluginAvailable: true, status: baseStatus({ pending: { ...pending, status: "error" } }) })).toBe("unlinked");
  });

  it("linked → the Robovoice console", () => {
    expect(consolePhase({ pluginAvailable: true, status: LINKED })).toBe("linked");
  });

  it("cloud voice is free: no wallet ever blocks a call", () => {
    // Start call depends only on the link, a free line and a picked agent — never on credits.
    expect(startBlockedReason("linked", IDLE_CALL, "main")).toBeNull();
    expect(startBlockedReason("unlinked", IDLE_CALL, "main")).toMatch(/connect robovoice/i);
    expect(startBlockedReason("linked", IDLE_CALL, null)).toMatch(/pick a voice agent/i);
  });

  it("a cloud refusal (fair-use cap / busy / legacy 402) reads as 'busy, switch to local voice'", () => {
    for (const msg of [
      "Cloud voice is busy right now. Switch to local voice to keep talking.",
      "cloud_voice_busy",
      "Robovoice credits exhausted — top up your Robovoice wallet.",
      "insufficient_balance",
    ]) {
      expect(isCloudVoiceBusy(msg)).toBe(true);
    }
    expect(isCloudVoiceBusy("Robovoice connection-details failed: http 500")).toBe(false);
    expect(CLOUD_VOICE_BUSY_TEXT).toMatch(/switch to local voice/i);
    expect(CLOUD_VOICE_BUSY_TEXT).not.toMatch(/credit|top.?up|wallet|upgrade|pay/i);
  });

  it("call-active: start → started → media connected → live; end → ended", () => {
    let c = callReducer(IDLE_CALL, { type: "start", agentId: "main" });
    expect(c.phase).toBe("starting");
    expect(startBlockedReason("linked", c, "main")).toMatch(/already in progress/);
    c = callReducer(c, { type: "started", room: "robopark-infinibot-1", mode: "cloud", startedAt: "2026-09-30T10:00:00Z" });
    expect(c.phase).toBe("connecting");
    c = callReducer(c, { type: "media", media: "connected", room: "robopark-infinibot-dev" });
    expect(c.phase).toBe("active");
    expect(c.room).toBe("robopark-infinibot-dev");
    c = callReducer(c, { type: "status", live: true, participants: 2 });
    c = callReducer(c, { type: "transcript", line: { id: "a", who: "you", text: "hi", final: false, at: 1 } });
    c = callReducer(c, { type: "transcript", line: { id: "a", who: "you", text: "hi there", final: true, at: 1 } });
    expect(c.transcript).toHaveLength(1);
    expect(c.transcript[0].text).toBe("hi there");
    c = callReducer(c, { type: "latency", sample: { at: 1, totalMs: 900, sttToLlmMs: 300, llmToTtsMs: 200 } });
    c = callReducer(c, { type: "latency", sample: { at: 2, totalMs: 700, sttToLlmMs: 250, llmToTtsMs: null } });
    expect(latencyP50(c.latency)).toBe(800);
    expect(latencyP50(c.latency, "llmToTtsMs")).toBe(200);
    expect(callInProgress(c)).toBe(true);
    c = callReducer(c, { type: "end" });
    expect(c.phase).toBe("ending");
    c = callReducer(c, { type: "ended" });
    expect(c.phase).toBe("ended");
    expect(callInProgress(c)).toBe(false);
    // A new call can start after the last one ended.
    expect(callReducer(c, { type: "start", agentId: "main" }).phase).toBe("starting");
  });

  it("a Robovoice-side live room with no local audio ends when Robovoice says it's gone", () => {
    let c = callReducer(IDLE_CALL, { type: "start", agentId: "main" });
    c = callReducer(c, { type: "started", room: "robopark-desk", mode: "local", startedAt: "t" });
    c = callReducer(c, { type: "status", live: true, participants: 2 });
    expect(c.phase).toBe("active");
    c = callReducer(c, { type: "status", live: false, participants: 0, creditsCharged: 42, billableSeconds: 42 });
    expect(c.phase).toBe("ended");
    expect(c.creditsCharged).toBe(42);
  });

  it("wake-word intents are one-shot and expire", () => {
    const store = new Map<string, string>();
    const storage = {
      setItem: (k: string, v: string) => void store.set(k, v),
      getItem: (k: string) => store.get(k) ?? null,
      removeItem: (k: string) => void store.delete(k),
    };
    requestVoiceCall({ agentId: "coder", source: "agent-wake" }, storage);
    const got = takeVoiceIntent(storage);
    expect(got?.agentId).toBe("coder");
    expect(takeVoiceIntent(storage)).toBeNull();
    requestVoiceCall({ source: "live-action-wake" }, storage);
    expect(takeVoiceIntent(storage, Date.now() + 120_000)).toBeNull();
  });

  it("a call intent from a chat carries that chat's sessionKey to the Voice page", () => {
    const store = new Map<string, string>();
    const storage = {
      setItem: (k: string, v: string) => void store.set(k, v),
      getItem: (k: string) => store.get(k) ?? null,
      removeItem: (k: string) => void store.delete(k),
    };
    requestVoiceCall({ sessionKey: "agent:ops:webchat:abc", source: "project-voice" }, storage);
    expect(takeVoiceIntent(storage)).toMatchObject({ sessionKey: "agent:ops:webchat:abc", source: "project-voice" });
    requestVoiceCall({ agentId: "main", source: "agent-wake" }, storage);
    expect(takeVoiceIntent(storage)).not.toHaveProperty("sessionKey");
  });
});

describe("Robovoice call session", () => {
  function harness(over: Partial<CallDeps> = {}) {
    const calls: Array<{ method: string; params: unknown }> = [];
    const timers: Array<() => void> = [];
    let handlers: RoomHandlers | null = null;
    const left = vi.fn(async () => {});
    const deps: CallDeps = {
      rpc: async <T>(method: string, params?: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "robovoice.call.start")
          return { ok: true, mode: "cloud", room: "robopark-char-1", started_at: "2026-09-30T10:00:00Z", url: "https://robovoice.io/call/char-1" } as T;
        if (method === "robovoice.call.status")
          return { room: "robopark-dev", live: true, participants: 2, usage: { sessions: 0, billable_seconds: 0, credits_charged: 0 } } as T;
        return { ok: true } as T;
      },
      fetchConnection: async () => ({ serverUrl: "wss://lk", participantToken: "tok", roomName: "robopark-dev" }),
      joinRoom: async (_c, h) => {
        handlers = h;
        return { leave: left, setMuted: async () => {} };
      },
      onChange: () => {},
      setTimer: (fn) => (timers.push(fn), timers.length),
      clearTimer: () => {},
      ...over,
    };
    return { deps, calls, timers, left, handlers: () => handlers };
  }

  it("start → joins the Robovoice room in the page → polls status → end", async () => {
    const h = harness();
    const s = new RobovoiceCallSession(h.deps);
    await s.begin("main");
    expect(h.calls[0]).toEqual({ method: "robovoice.call.start", params: { agentId: "main", mode: "auto" } });
    expect(s.state.phase).toBe("active");
    expect(s.state.media).toBe("connected");
    expect(s.state.room).toBe("robopark-dev");
    await s.poll();
    expect(h.calls.at(-1)).toEqual({ method: "robovoice.call.status", params: { room: "robopark-dev", since: "2026-09-30T10:00:00Z" } });
    expect(s.state.live).toBe(true);
    h.handlers()!.onLatency({ at: 1, totalMs: 812, sttToLlmMs: 310, llmToTtsMs: 190 });
    h.handlers()!.onTranscript({ id: "1", who: "agent", text: "Hi, I'm INFINI.", final: true, at: 1 });
    expect(s.state.latency[0].totalMs).toBe(812);
    expect(s.state.transcript[0].text).toMatch(/INFINI/);
    await s.end();
    expect(h.calls.some((c) => c.method === "robovoice.call.end" && (c.params as { room: string }).room === "robopark-dev")).toBe(true);
    expect(h.left).toHaveBeenCalled();
    expect(s.state.phase).toBe("ended");
  });

  it("a call from a chat session passes that sessionKey to call.start and connection-details", async () => {
    const fetched: Array<{ agentId: string; sessionKey?: string }> = [];
    const h = harness({
      fetchConnection: async (agentId, sessionKey) => {
        fetched.push({ agentId, sessionKey });
        return { serverUrl: "wss://lk", participantToken: "tok", roomName: "robopark-dev" };
      },
    });
    const s = new RobovoiceCallSession(h.deps);
    await s.begin("main", { sessionKey: "agent:main:webchat:xyz" });
    expect(h.calls[0]).toEqual({ method: "robovoice.call.start", params: { agentId: "main", mode: "auto", sessionKey: "agent:main:webchat:xyz" } });
    expect(fetched).toEqual([{ agentId: "main", sessionKey: "agent:main:webchat:xyz" }]);
    expect(s.state.sessionKey).toBe("agent:main:webchat:xyz");
    expect(s.state.phase).toBe("active");
  });

  it("without a sessionKey the call stays on the agent's main session (no sessionKey param)", async () => {
    const fetched: unknown[][] = [];
    const h = harness({
      fetchConnection: async (...args) => {
        fetched.push(args);
        return { serverUrl: "wss://lk", participantToken: "tok", roomName: "robopark-dev" };
      },
    });
    const s = new RobovoiceCallSession(h.deps);
    await s.begin("ops", { sessionKey: "  " });
    expect(h.calls[0].params).toEqual({ agentId: "ops", mode: "auto" });
    expect(fetched).toEqual([["ops"]]);
    expect(s.state.sessionKey).toBeNull();
  });

  it("cloud voice busy (fair-use cap, 429 cloud_voice_busy) fails the call with the friendly switch-to-local line", async () => {
    const h = harness({
      fetchConnection: async () => {
        throw new Error("Cloud voice is busy right now. Switch to local voice to keep talking.");
      },
    });
    const s = new RobovoiceCallSession(h.deps);
    await s.begin("main");
    expect(s.state.phase).toBe("failed");
    expect(s.state.error).toBe(CLOUD_VOICE_BUSY_TEXT);
    expect(s.state.error).not.toMatch(/credit|top.?up|wallet/i);
  });

  it("a legacy credit refusal is never shown as a top-up: it reads as busy", async () => {
    const h = harness({
      fetchConnection: async () => {
        throw new Error("Robovoice credits exhausted ($0.00 available) — top up your Robovoice wallet.");
      },
    });
    const s = new RobovoiceCallSession(h.deps);
    await s.begin("main");
    expect(s.state.error).toBe(CLOUD_VOICE_BUSY_TEXT);
  });

  it("audio that can't join keeps the Robovoice call and offers the Robovoice call page", async () => {
    const h = harness({
      joinRoom: async () => {
        throw new Error("could not establish signal connection");
      },
    });
    const s = new RobovoiceCallSession(h.deps);
    await s.begin("main");
    expect(s.state.media).toBe("unavailable");
    expect(s.start?.url).toBe("https://robovoice.io/call/char-1");
    await s.poll();
    expect(s.state.phase).toBe("active");
  });

  it("a failed LiveKit connect that also fires Disconnected doesn't end the Robovoice call", async () => {
    const h = harness({
      joinRoom: async (_c, handlers) => {
        handlers.onDisconnected();
        throw new Error("could not establish signal connection");
      },
    });
    const s = new RobovoiceCallSession(h.deps);
    await s.begin("main");
    expect(s.state.phase).toBe("connecting");
    expect(s.state.media).toBe("unavailable");
    await s.poll();
    expect(s.state.phase).toBe("active");
  });

  it("Robovoice Desktop (mode local) takes the call — no in-page audio", async () => {
    const joinRoom = vi.fn();
    const h = harness({
      joinRoom,
      rpc: async <T>(method: string) =>
        (method === "robovoice.call.start"
          ? { mode: "local", room: "robopark-desk-1", started_at: "t", device: { device_id: "desk-1", name: "Studio Mac" } }
          : { room: "robopark-desk-1", live: false, participants: 0 }) as T,
    });
    const s = new RobovoiceCallSession(h.deps);
    await s.begin("main");
    expect(joinRoom).not.toHaveBeenCalled();
    expect(s.state.desktopName).toBe("Studio Mac");
    expect(s.state.phase).toBe("connecting");
  });

  it("start failure (not linked) surfaces Robovoice's error", async () => {
    const h = harness({
      rpc: async () => {
        throw new Error("Not linked — run `infinibot robovoice login`");
      },
    });
    const s = new RobovoiceCallSession(h.deps);
    await s.begin("main");
    expect(s.state.phase).toBe("failed");
    expect(s.state.error).toMatch(/Not linked/);
  });
});

describe("Voice page writes go to Robovoice only", () => {
  it("every action is a robovoice.* RPC (plus turning the plugin on)", async () => {
    const methods: string[] = [];
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const a = voiceConsoleActions(async <T>(m: string) => {
      methods.push(m);
      return (m === "robovoice.link.sync" ? { mcp: { status: "ok" } } : {}) as T;
    });
    await a.linkStart();
    await a.linkStart("http://192.168.1.110:3011");
    await a.linkCancel();
    await a.sync();
    await a.unlink();
    await a.logout();
    await a.setCharacter("coder", "char-9");
    await a.setDefaultCharacter("char-1");
    await a.setOwnerCallerEmails(["owner@x.test"]);
    await a.setPublicUrl("https://host.ts.net");
    await a.setVoiceAgent("main", { llmBackend: "claude-code", voice: "am_puck", language: "he" });
    await a.rotateVoiceLlm();
    await a.testVoiceLlm("main");
    await a.enablePlugin();
    await a.linkStatus();
    await a.credits();
    await a.characters();
    await a.settings();
    await a.voiceLlmStatus();
    vi.unstubAllGlobals();
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const m of methods) expect(m === "plugins.setEnabled" || m.startsWith("robovoice.")).toBe(true);
    const writes = methods.filter((m) => !/\.(status|get|list)$/.test(m));
    for (const m of writes) expect(VOICE_PAGE_WRITE_METHODS as readonly string[]).toContain(m);
  });

  it("the Voice page source never touches local voice config", () => {
    const files = ["voice-console.ts", "console-actions.ts", "call-session.ts", "call-store.ts", "../robovoice/pipeline-editor.ts", "../../components/robovoice-agent-voice.ts"];
    const forbidden = [/\/api\/settings/, /\/api\/voices/, /["']voice\.setup\./, /["']voice\.providers\./, /["']quickstart\.voice\./, /["']voice\.docker\./, /["']voicewake\./, /voice-settings\.json/, /voice\.json/];
    for (const f of files) {
      // Code only: doc comments may name the local stores they don't use.
      const src = readFileSync(join(here, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      const rpcs = [...src.matchAll(/(?:rpc|request)(?:<[^>]*>)?\(\s*["']([a-zA-Z.]+)["']/g)].map((m) => m[1]);
      for (const r of rpcs) expect(`${f}: ${r}`).toMatch(/: (robovoice\.|plugins\.setEnabled$)/);
      for (const re of forbidden) expect(re.test(src), `${f} matches ${re}`).toBe(false);
    }
  });

  it("the Voice tab renders the Robovoice console; the local voice chat is gone", () => {
    const app = readFileSync(join(here, "../../app-render.ts"), "utf8");
    expect(app).toMatch(/<voice-robovoice-console/);
    expect(app).not.toMatch(/<voice-chat|lazyRenderVoiceChat|LOCAL_VOICE_UI|voice-mini-orb/);
    const setup = readFileSync(join(here, "../setup.ts"), "utf8");
    expect(setup).not.toMatch(/<voice-setup-wizard/);
    expect(setup).not.toMatch(/<voice-provider-card/);
  });

  it("form helpers", () => {
    expect(parseEmails("a@x.com, b@y.com;c@z.com")).toEqual(["a@x.com", "b@y.com", "c@z.com"]);
    expect(normalizePublicUrl("https://h.ts.net/")).toBe("https://h.ts.net");
    expect(normalizePublicUrl("  ")).toBeNull();
    expect(() => normalizePublicUrl("ftp://x")).toThrow(/http/);
  });
});

describe("ageText (age of a real Robovoice answer)", () => {
  it("labels how old cached data is; unknown when there's no timestamp", () => {
    const now = Date.parse("2026-09-30T12:00:00Z");
    expect(ageText("2026-09-30T11:59:50Z", now)).toBe("just now");
    expect(ageText("2026-09-30T11:56:00Z", now)).toBe("4 min ago");
    expect(ageText("2026-09-30T09:00:00Z", now)).toBe("3 h ago");
    expect(ageText(null, now)).toBe("unknown time");
  });
});
