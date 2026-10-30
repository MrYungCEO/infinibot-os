/**
 * Tests for buildAndInsertPopup's CRITICAL no-action safety guard (src/proactive/emit.ts).
 *
 * A CRITICAL pop with zero actions traps the user behind a modal with no exit;
 * the emit core must auto-inject a Dismiss action so there is always a way out.
 *
 * Uses INFINIBOT_STATE_DIR to isolate SQLite state to a tmp dir, and stubs the
 * gateway broadcaster so nothing tries to reach a live gateway.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../agents/coder-runtime/subagent-broadcast.js", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../agents/coder-runtime/subagent-broadcast.js")>();
  return {
    ...real,
    getGatewayBroadcaster: () => null,
    onGatewayBroadcasterReady: (_cb: unknown) => {
      /* no-op in tests */
    },
  };
});

import { buildAndInsertPopup, resolvePopupLink } from "./emit.js";
import { closePopupStore } from "./popup-store.js";
import type { PopupEmitInput } from "./popup-types.js";

let tmpDir = "";

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "proactive-emit-test-"));
  process.env.INFINIBOT_STATE_DIR = tmpDir;
  closePopupStore();
});

afterAll(() => {
  closePopupStore();
  delete process.env.INFINIBOT_STATE_DIR;
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function baseInput(overrides: Partial<PopupEmitInput> = {}): PopupEmitInput {
  return {
    tier: "CRITICAL",
    title: "Pipeline broke",
    body: "deploy failed",
    attribution: { agentId: "coder", agentName: "Coder" },
    dedupKey: `test:emit:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
    ...overrides,
  };
}

describe("buildAndInsertPopup CRITICAL no-action guard", () => {
  it("auto-injects a Dismiss action when CRITICAL has no actions", () => {
    const { event } = buildAndInsertPopup(baseInput({ actions: [] }), tmpDir);
    expect(event.actions).toHaveLength(1);
    expect(event.actions[0]).toMatchObject({ id: "dismiss", kind: "dismiss", label: "Dismiss" });
  });

  it("auto-injects when CRITICAL actions field is omitted entirely", () => {
    const { event } = buildAndInsertPopup(baseInput({ actions: undefined }), tmpDir);
    expect(event.actions).toHaveLength(1);
    expect(event.actions[0].kind).toBe("dismiss");
  });

  it("leaves existing CRITICAL actions untouched", () => {
    const actions = [{ id: "fix", kind: "spawn" as const, label: "Spawn fixer" }];
    const { event } = buildAndInsertPopup(baseInput({ actions }), tmpDir);
    expect(event.actions).toHaveLength(1);
    expect(event.actions[0].id).toBe("fix");
  });

  it("does NOT inject for non-CRITICAL tiers with no actions", () => {
    const { event } = buildAndInsertPopup(baseInput({ tier: "NOTABLE", actions: [] }), tmpDir);
    expect(event.actions).toHaveLength(0);
  });
});

describe("pop-up deep links", () => {
  it("derives the link from the primary open action and persists it", () => {
    const { event } = buildAndInsertPopup(
      baseInput({
        tier: "NOTABLE",
        actions: [
          { id: "src", kind: "open", label: "Source", payload: { url: "https://x.com" } },
          {
            id: "card",
            kind: "open",
            label: "Card",
            primary: true,
            payload: { target: "kanban?task=k1" },
          },
        ],
      }),
      tmpDir,
    );
    expect(event.link?.deepLink).toBe("infinibot://board/task/k1");
  });

  it("an explicit deepLink wins and gets the web opener when a base is known", () => {
    expect(
      resolvePopupLink(
        {
          deepLink: "/solatrix/alerts",
          actions: [{ id: "o", kind: "open", label: "x", payload: { tab: "dashboard" } }],
        },
        "https://h.example",
      ),
    ).toEqual({
      deepLink: "infinibot://web/solatrix/alerts",
      webUrl: "https://h.example/m/web/solatrix/alerts",
    });
    expect(resolvePopupLink({ actions: [] }, null)).toBeNull();
    expect(
      resolvePopupLink(
        { actions: [{ id: "u", kind: "open", label: "x", payload: { href: "https://evil.com" } }] },
        null,
      ),
    ).toBeNull();
  });
});
