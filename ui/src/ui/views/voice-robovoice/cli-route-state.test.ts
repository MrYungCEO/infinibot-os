import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CLI_ROUTE_STORAGE_KEY,
  isSelected,
  loadCachedRoute,
  routeSummary,
  saveCachedRoute,
  shortCwd,
  sortOpenSessions,
  streamSelectionFor,
  targetOf,
  type CliRoute,
  type OpenSession,
} from "./cli-route-state";

const here = dirname(fileURLToPath(import.meta.url));

function mem() {
  const v = new Map<string, string>();
  return { getItem: (k: string) => v.get(k) ?? null, setItem: (k: string, x: string) => void v.set(k, x), v };
}

const term: OpenSession = { kind: "terminal", id: "term-1", terminalId: "term-1", label: "api", cliType: "claude", cwd: "/home/u/Desktop/Development/api", status: "live", lastActiveAt: "2026-10-07T10:00:00Z" };
const coder: OpenSession = { kind: "coder", id: "run9", runId: "run9", terminalId: "spawn-run9", label: "fix login", cliType: "codex", cwd: "/repo/web", status: "running" };
const shell: OpenSession = { kind: "terminal", id: "term-2", terminalId: "term-2", label: "zsh", cliType: "shell", cwd: "/home/u", status: "live", lastActiveAt: "2026-10-07T11:00:00Z" };

describe("voice routing state", () => {
  it("caches the route for instant paint; malformed / target-less cli falls back to api", () => {
    const s = mem();
    expect(loadCachedRoute(s).mode).toBe("api");
    const r: CliRoute = { mode: "cli", target: targetOf(term), updatedAt: "x" };
    saveCachedRoute(r, s);
    expect(loadCachedRoute(s)).toEqual(r);
    s.setItem(CLI_ROUTE_STORAGE_KEY, JSON.stringify({ mode: "cli", updatedAt: "x" }));
    expect(loadCachedRoute(s).mode).toBe("api");
    s.setItem(CLI_ROUTE_STORAGE_KEY, "{bad");
    expect(loadCachedRoute(s).mode).toBe("api");
  });

  it("summarises the route for the chip", () => {
    expect(routeSummary({ route: { mode: "api", updatedAt: "" }, alive: null })).toMatchObject({ mode: "api", tone: "api" });
    const cli: CliRoute = { mode: "cli", target: targetOf(term), updatedAt: "" };
    expect(routeSummary({ route: cli, alive: true })).toMatchObject({ mode: "cli", label: "api", tone: "live" });
    expect(routeSummary({ route: cli, alive: true }).detail).toMatch(/Claude Code · api in ~\/Desktop\/Development\/api/);
    expect(routeSummary({ route: cli, alive: false }).tone).toBe("dead");
    expect(routeSummary({ route: cli, alive: true, approval: { question: "Proceed?", at: 1 } }).tone).toBe("warn");
    const fell: CliRoute = { mode: "api", updatedAt: "", fallback: { at: "", reason: "api: session ended" } };
    expect(routeSummary({ route: fell, alive: null })).toMatchObject({ tone: "warn", detail: "Back on the API LLM: api: session ended" });
  });

  it("points the terminal panel at the routed pane", () => {
    expect(streamSelectionFor({ mode: "api", updatedAt: "" })).toEqual({ isCliMode: false, backend: null, terminalId: null });
    expect(streamSelectionFor({ mode: "cli", target: targetOf(term), updatedAt: "" })).toEqual({ isCliMode: true, backend: "claude-code", terminalId: "term-1" });
    expect(streamSelectionFor({ mode: "cli", target: targetOf(coder), updatedAt: "" })).toEqual({ isCliMode: true, backend: "codex", terminalId: "spawn-run9" });
  });

  it("lists the routed session first, then coders, then recent terminals", () => {
    const route: CliRoute = { mode: "cli", target: targetOf(term), updatedAt: "" };
    expect(sortOpenSessions([shell, coder, term], route).map((s) => s.id)).toEqual(["term-1", "run9", "term-2"]);
    expect(isSelected(route, term)).toBe(true);
    expect(isSelected({ ...route, mode: "api" }, term)).toBe(false);
  });

  it("shortens long cwds from the right", () => {
    expect(shortCwd("/home/u/a")).toBe("~/a");
    expect(shortCwd("/home/u/Desktop/Development/some/very/deep/project/folder", 24)).toMatch(/^…\/.*folder$/);
  });
});

describe("Voice page wiring", () => {
  const consoleSrc = readFileSync(join(here, "voice-console.ts"), "utf8");
  const sessionSrc = readFileSync(join(here, "session-view.ts"), "utf8");

  it("the old text-chat toggle is gone; the routing control sits in the sub-tab bar and the call view", () => {
    expect(consoleSrc).not.toMatch(/isCliMode|renderCliMode|agent-chat-modal/);
    expect(consoleSrc).toMatch(/<voice-cli-route-control class="route-bar"[^>]*variant="bar"/);
    expect(consoleSrc).toMatch(/<voice-cli-route-control slot="route"[^>]*variant="pill"/);
    expect(consoleSrc).toMatch(/onVoiceCliRoutePayload/);
    expect(sessionSrc).toMatch(/<slot name="route"><\/slot>/);
  });
});
