/**
 * RPC surface guard. Defining a handler object is not the same as serving it:
 * a method that isn't spread into the dispatch map returns "method not found",
 * and one that isn't scope-classified silently becomes admin-only. Both are
 * invisible in code review, so they get asserted here instead.
 */

import { describe, it, expect } from "vitest";
import {
  androidOpsHandlers,
  ANDROID_OPS_READ_METHODS,
  ANDROID_OPS_WRITE_METHODS,
} from "./android-ops.js";

const declared = [...ANDROID_OPS_READ_METHODS, ...ANDROID_OPS_WRITE_METHODS];

describe("androidops RPC surface", () => {
  it("classifies every handler as either read or write", () => {
    const implemented = Object.keys(androidOpsHandlers).sort();
    expect(implemented).toEqual([...declared].sort());
  });

  it("does not classify a method as both read and write", () => {
    const overlap = ANDROID_OPS_READ_METHODS.filter((m) => ANDROID_OPS_WRITE_METHODS.includes(m));
    expect(overlap).toEqual([]);
  });

  it("namespaces every method under androidops.", () => {
    for (const name of Object.keys(androidOpsHandlers))
      expect(name.startsWith("androidops.")).toBe(true);
  });

  it("keeps mutating verbs out of the read set", () => {
    const mutating =
      /\.(create|update|assign|advance|retry|resolve|tick|refresh|start|step|ack|run|control|seed)$/;
    for (const name of ANDROID_OPS_READ_METHODS) expect(name).not.toMatch(mutating);
  });

  it("rejects a checkpoint resolution that names no job", async () => {
    let ok: boolean | null = null;
    let error: { code?: string } | undefined;
    await androidOpsHandlers["androidops.job.checkpoint.resolve"]({
      params: {},
      respond: (o: boolean, _p?: unknown, e?: unknown) => {
        ok = o;
        error = e as { code?: string };
      },
    } as never);
    expect(ok).toBe(false);
    expect(error?.code).toBe("INVALID_REQUEST");
  });
});

describe("gateway registration", () => {
  it("is spread into the dispatch map and both scope sets", async () => {
    // Read the wiring file rather than importing it: server-methods.ts pulls in
    // the whole gateway dependency graph, which is far too heavy for a guard.
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("../server-methods.ts", import.meta.url), "utf8");
    expect(source).toContain("...androidOpsHandlers,");
    expect(source).toContain("...ANDROID_OPS_READ_METHODS,");
    expect(source).toContain("...ANDROID_OPS_WRITE_METHODS,");
  });
});
