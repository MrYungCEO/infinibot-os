/**
 * Smoke tests for the <subagent-history-feed> archive component.
 *
 * Confirms:
 *  - Component registers and mounts.
 *  - Empty state renders when the gateway returns no entries.
 *  - Rows render when the gateway returns fixture data.
 *  - Clicking a row dispatches infinibot:subagent-open-detail with the runId.
 */
import { describe, expect, it, beforeEach } from "vitest";
import type { GatewayBrowserClient } from "../gateway";
import {
  SubagentHistoryFeed,
  type HistoryEntry,
} from "./subagent-history-feed";

// Trigger the @customElement decorator side-effect.
void SubagentHistoryFeed;

function makeStubClient(history: HistoryEntry[]): GatewayBrowserClient {
  return {
    connected: true,
    request: () =>
      Promise.resolve({ ok: true, history, total: history.length, serverTime: Date.now() }),
    subscribe: () => () => {},
  } as unknown as GatewayBrowserClient;
}

async function flush(host: HTMLElement) {
  // Lit batches updates; wait two microtasks + the fetch promise to settle.
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  await (host as unknown as { updateComplete: Promise<unknown> }).updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await (host as unknown as { updateComplete: Promise<unknown> }).updateComplete;
}

describe("<subagent-history-feed>", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("registers as a custom element", () => {
    expect(customElements.get("subagent-history-feed")).toBe(SubagentHistoryFeed);
  });

  it("renders the empty-state message when no entries come back", async () => {
    const feed = document.createElement("subagent-history-feed") as SubagentHistoryFeed;
    feed.gateway = makeStubClient([]);
    document.body.appendChild(feed);
    await flush(feed);
    const text = feed.shadowRoot?.textContent ?? "";
    expect(text).toContain("No completed sub-agents yet");
  });

  it("renders one row per entry when the gateway returns history", async () => {
    const now = Date.now();
    const fixture: HistoryEntry[] = [
      {
        runId: "run-x",
        label: "Coder Subagent X",
        task: "investigate the modal wiring",
        status: "complete",
        startedAt: now - 60_000,
        endedAt: now - 10_000,
        requesterSessionKey: "agent:main:main",
      },
      {
        runId: "run-y",
        label: "Voice Subagent Y",
        task: "transcribe long audio",
        status: "error",
        startedAt: now - 120_000,
        endedAt: now - 60_000,
        requesterSessionKey: "agent:main:main",
        error: "transcription failed",
      },
    ];
    const feed = document.createElement("subagent-history-feed") as SubagentHistoryFeed;
    feed.gateway = makeStubClient(fixture);
    document.body.appendChild(feed);
    await flush(feed);
    const rows = feed.shadowRoot?.querySelectorAll(".shf-row") ?? [];
    expect(rows.length).toBe(2);
    const txt = feed.shadowRoot?.textContent ?? "";
    expect(txt).toContain("Coder Subagent X");
    expect(txt).toContain("Voice Subagent Y");
  });

  it("dispatches infinibot:subagent-open-detail with the runId on row click", async () => {
    const fixture: HistoryEntry[] = [
      {
        runId: "run-click",
        label: "Click Target",
        task: "open the modal",
        status: "complete",
        endedAt: Date.now() - 1_000,
        requesterSessionKey: "agent:main:main",
      },
    ];
    const feed = document.createElement("subagent-history-feed") as SubagentHistoryFeed;
    feed.gateway = makeStubClient(fixture);
    document.body.appendChild(feed);
    await flush(feed);

    let dispatched: { runId?: string } | null = null;
    window.addEventListener(
      "infinibot:subagent-open-detail",
      (e) => {
        dispatched = (e as CustomEvent).detail as { runId?: string };
      },
      { once: true },
    );
    const row = feed.shadowRoot?.querySelector(".shf-row") as HTMLElement | null;
    expect(row).toBeTruthy();
    row?.click();

    expect(dispatched).not.toBeNull();
    expect(dispatched!.runId).toBe("run-click");
  });
});
