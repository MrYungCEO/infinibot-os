import { beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({ robovoice: false }));
vi.mock("../plugin-host.js", () => ({
  PLUGIN_HOST_EVENT: "infinibot-plugin-host",
  isTabAvailable: (tab: string) => (tab === "robovoice" ? host.robovoice : true),
}));
// The Robovoice card is lazy-loaded when the plugin is on; keep it out of node.
vi.mock("../components/robovoice-agent-voice.js", () => ({}));

import { getAgentVoiceSlot, registerAgentVoiceSlot, renderAgentVoiceSlot } from "./agents-voice-slot";

/** Flatten a lit TemplateResult (strings + values) to text for assertions. */
function text(t: unknown): string {
  if (t == null) return "";
  if (typeof t !== "object") return String(t);
  const r = t as { strings?: readonly string[]; values?: unknown[] };
  if (!r.strings) return "";
  return r.strings.map((s, i) => s + (i < (r.values?.length ?? 0) ? text(r.values![i]) : "")).join("");
}

const ctx = (agentId: string) => ({
  agentId,
  agentName: agentId,
  agentType: "native" as const,
  state: {} as never,
  client: {} as never,
  requestUpdate: () => {},
});

describe("agents voice slot (unified)", () => {
  beforeEach(() => {
    host.robovoice = false;
  });

  it("shows a neutral note when Robovoice is off", () => {
    const out = text(renderAgentVoiceSlot("main"));
    expect(out).toContain("agent-voice-slot-off");
    expect(out).not.toContain("<robovoice-agent-voice");
  });

  it("renders the Robovoice voice-agent card when the plugin is on", () => {
    host.robovoice = true;
    const out = text(getAgentVoiceSlot()(ctx("cmo")));
    expect(out).toContain("<robovoice-agent-voice");
    expect(out).toContain('variant="card"');
    expect(out).toContain("cmo");
  });

  it("points virtual CLI nodes at the Backend picker instead of an unknown agent", () => {
    host.robovoice = true;
    const out = text(renderAgentVoiceSlot("cli:claude"));
    expect(out).toContain("agent-voice-slot-cli");
    expect(out).not.toContain("<robovoice-agent-voice");
  });

  it("a registered provider replaces the built-in renderer until unregistered", () => {
    host.robovoice = true;
    const off = registerAgentVoiceSlot(() => null);
    expect(getAgentVoiceSlot()(ctx("main"))).toBeNull();
    off();
    expect(text(getAgentVoiceSlot()(ctx("main")))).toContain("<robovoice-agent-voice");
  });
});
