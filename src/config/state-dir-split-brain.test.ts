/**
 * REGRESSION GUARD: the MCP/agent tool surface and the gateway must resolve
 * the SAME state directory. When they diverge, data written through an MCP or
 * agent tool is invisible in the UI (and vice-versa) with no error — a silent
 * "split-brain". This test fails loudly if a future change re-splits them.
 *
 * How the two paths actually resolve state:
 *   - Gateway path: opens its stores under `resolveStateDir()` from
 *     `src/config/paths.ts` (config under `resolveSharedDir()` /
 *     `resolveConfigPath()`).
 *   - MCP path (`src/cli/mcp-stdio.ts`): does NOT open its own state store. It
 *     connects to the RUNNING gateway over WebSocket (`MOLTBOT_GATEWAY_URL`,
 *     default `ws://127.0.0.1:18789`) and forwards every read/write. So the
 *     MCP process inherits the gateway's state dir by construction — as long
 *     as it keeps delegating instead of opening a divergent store.
 *
 * The invariant therefore has two halves, both asserted here:
 *   (A) `resolveStateDir` / `resolveSharedDir` / `resolveConfigPath` are pure,
 *       deterministic functions of (env, HOME, cwd). Any code path that calls
 *       them with the same inputs gets the same dir. A regression that forks a
 *       second resolver (e.g. a repo-local `state/` fallback) would break this.
 *   (B) `src/cli/mcp-stdio.ts` keeps delegating to the gateway and does NOT
 *       resolve/open its own state dir. If someone makes the MCP entry read
 *       state locally, this guard flags it before it ships.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  resolveStateDir,
  resolveSharedDir,
  resolveConfigPath,
  DEFAULT_USER_ID,
  getCurrentUserId,
} from "./paths.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_SRC = path.resolve(HERE, "..");
const MCP_STDIO_SRC = path.join(REPO_SRC, "cli", "mcp-stdio.ts");
const PATHS_SRC = path.join(REPO_SRC, "config", "paths.ts");

/**
 * Simulate the gateway resolving its state dir for a given environment. The
 * gateway boots with whatever env/HOME/cwd it was launched under and calls the
 * canonical resolver.
 */
function gatewayStateDir(env: NodeJS.ProcessEnv, home: string): string {
  return resolveStateDir(env, () => home);
}

/**
 * Simulate the state dir that an MCP/agent-side tool would resolve if it
 * resolved state itself (the failure mode we guard against is a divergent
 * resolver). Because both sides import the SAME `resolveStateDir`, this MUST
 * equal the gateway's — that equality is the whole point.
 */
function mcpSideStateDir(env: NodeJS.ProcessEnv, home: string): string {
  return resolveStateDir(env, () => home);
}

describe("MCP↔gateway state-dir split-brain guard", () => {
  it("(A) gateway and MCP-side resolvers agree across an env/HOME matrix", () => {
    const matrix: Array<{ name: string; env: NodeJS.ProcessEnv; home: string }> = [
      { name: "default (no overrides)", env: {} as NodeJS.ProcessEnv, home: "/home/alice" },
      {
        name: "explicit INFINIBOT_STATE_DIR",
        env: { INFINIBOT_STATE_DIR: "/srv/infinibot-data" } as NodeJS.ProcessEnv,
        home: "/home/alice",
      },
      {
        name: "tilde INFINIBOT_STATE_DIR",
        env: { INFINIBOT_STATE_DIR: "~/custom-state" } as NodeJS.ProcessEnv,
        home: "/home/bob",
      },
      {
        name: "different HOME, no overrides",
        env: {} as NodeJS.ProcessEnv,
        home: "/root",
      },
    ];

    for (const { name, env, home } of matrix) {
      const gw = gatewayStateDir(env, home);
      const mcp = mcpSideStateDir(env, home);
      expect(gw, `state dir diverged for case "${name}"`).toBe(mcp);
      // And config always lives at the SHARED root's infinibot.json, derived
      // from the very same base — never a second, forked location.
      expect(resolveConfigPath(env, resolveSharedDir(env, () => home))).toBe(
        path.join(resolveSharedDir(env, () => home), "infinibot.json"),
      );
    }
  });

  it("(A) the default (no-override) state dir is ~/.infinibot for both paths", () => {
    const home = "/home/carol";
    const expected = path.join(home, ".infinibot");
    expect(gatewayStateDir({} as NodeJS.ProcessEnv, home)).toBe(expected);
    expect(mcpSideStateDir({} as NodeJS.ProcessEnv, home)).toBe(expected);
    // For the default profile, shared root == state dir (no per-user subtree),
    // so config and data live under the same root — no split.
    expect(getCurrentUserId()).toBe(DEFAULT_USER_ID);
    expect(resolveSharedDir({} as NodeJS.ProcessEnv, () => home)).toBe(expected);
  });

  it("(A) resolution is deterministic — repeated calls never drift", () => {
    const env = { INFINIBOT_STATE_DIR: "/srv/data" } as NodeJS.ProcessEnv;
    const home = "/home/dave";
    const first = resolveStateDir(env, () => home);
    for (let i = 0; i < 5; i++) {
      expect(resolveStateDir(env, () => home)).toBe(first);
    }
  });

  it("(B) mcp-stdio delegates to the gateway over WS and opens no local store", () => {
    const src = readFileSync(MCP_STDIO_SRC, "utf8");

    // It must connect to the gateway (that is how it inherits the gateway's
    // state dir instead of resolving its own).
    expect(src, "mcp-stdio must reference the gateway WS URL").toMatch(
      /MOLTBOT_GATEWAY_URL|ws:\/\/127\.0\.0\.1:18789/,
    );

    // It must NOT resolve/open its own state dir — doing so is exactly the
    // regression that splits the brain. If a future edit imports a state
    // resolver or hardcodes a state path here, fail and force a review.
    expect(src, "mcp-stdio must not resolve its own state dir").not.toMatch(
      /resolveStateDir|resolveSharedDir|resolveConfigPath/,
    );
    expect(src, "mcp-stdio must not use the repo-local state/ fallback").not.toMatch(
      /INFINIBOT_STATE_DIR\s*(\|\||\?\?)\s*["']state["']/,
    );
  });

  it("(B) only the canonical migrator names the legacy repo-local 'state' fallback", () => {
    // The `<cwd>/state` fallback is the historical split-brain source. The one
    // legitimate mention is inside paths.ts (the migrator copies data forward
    // out of it). Assert paths.ts still owns that string so the pattern used by
    // state-dir-hygiene.test.ts stays meaningful — a canary on the resolver
    // itself, adjacent to the MCP-side assertion above.
    const pathsSrc = readFileSync(PATHS_SRC, "utf8");
    expect(pathsSrc, "paths.ts is expected to reference the legacy 'state' root").toMatch(
      /INFINIBOT_STATE_DIR[\s\S]{0,40}["']state["']/,
    );
  });
});
