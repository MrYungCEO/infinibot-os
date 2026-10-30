/**
 * Tests for the boot-time split-brain self-check (`state-dir-selfcheck.ts`).
 * The self-check must WARN — loudly but non-fatally — when the active state
 * dir diverges from a populated store, and stay quiet when things are aligned.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CANONICAL_STORE_MARKERS,
  evaluateStateDirSelfCheck,
  runStateDirSelfCheck,
} from "./state-dir-selfcheck.js";

describe("state-dir self-check", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "infinibot-selfcheck-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Populate a dir with the canonical markers so it looks initialized. */
  function seedStore(dir: string): void {
    mkdirSync(dir, { recursive: true });
    for (const marker of CANONICAL_STORE_MARKERS) {
      if (marker === "agents") {
        mkdirSync(path.join(dir, marker), { recursive: true });
      } else {
        writeFileSync(path.join(dir, marker), "{}");
      }
    }
  }

  it("is OK (no warnings) when the default ~/.infinibot store is populated", () => {
    const home = path.join(tmp, "home");
    seedStore(path.join(home, ".infinibot"));

    const result = evaluateStateDirSelfCheck({} as NodeJS.ProcessEnv, () => home);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.markersPresent.length).toBe(CANONICAL_STORE_MARKERS.length);
  });

  it("warns when the active dir has no canonical markers", () => {
    const home = path.join(tmp, "home");
    mkdirSync(path.join(home, ".infinibot"), { recursive: true }); // empty

    const result = evaluateStateDirSelfCheck({} as NodeJS.ProcessEnv, () => home);
    expect(result.ok).toBe(false);
    expect(result.warnings.join("\n")).toMatch(/NONE of the canonical store markers/);
  });

  it("warns when an override points away from a populated ~/.infinibot (split-brain)", () => {
    const home = path.join(tmp, "home");
    seedStore(path.join(home, ".infinibot")); // real data here
    const override = path.join(tmp, "elsewhere");
    seedStore(override); // active dir also populated, but a DIFFERENT dir

    const env = { INFINIBOT_STATE_DIR: override } as NodeJS.ProcessEnv;
    const result = evaluateStateDirSelfCheck(env, () => home);

    expect(result.activeStateDir).toBe(path.resolve(override));
    expect(result.ok).toBe(false);
    expect(result.warnings.join("\n")).toMatch(/DIFFERENT active state dir/);
    expect(result.warnings.join("\n")).toContain(path.join(home, ".infinibot"));
  });

  it("does not warn about divergence when the legacy default store is empty", () => {
    const home = path.join(tmp, "home");
    const override = path.join(tmp, "elsewhere");
    seedStore(override); // active dir populated; no ~/.infinibot at all

    const env = { INFINIBOT_STATE_DIR: override } as NodeJS.ProcessEnv;
    const result = evaluateStateDirSelfCheck(env, () => home);
    // Active dir has markers and there is no competing populated store.
    expect(result.warnings.join("\n")).not.toMatch(/DIFFERENT active state dir/);
    expect(result.ok).toBe(true);
  });

  it("runStateDirSelfCheck logs a WARNING and never throws", () => {
    const home = path.join(tmp, "home");
    mkdirSync(path.join(home, ".infinibot"), { recursive: true }); // empty → triggers warn
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = runStateDirSelfCheck({} as NodeJS.ProcessEnv, () => home);
      expect(result.ok).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("state-store split-brain risk"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
