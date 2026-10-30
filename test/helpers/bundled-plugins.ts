/**
 * Opt a test file in to the repo's bundled plugins (`extensions/`).
 *
 * `test/setup.ts` points INFINIBOT_BUNDLED_PLUGINS_DIR at an empty directory, so
 * an ordinary unit test never discovers — and never loads — the bundled plugin
 * tree by accident. A test that needs it (config validation against plugin
 * manifests, the channel catalog, a bundled plugin's own behaviour) imports
 * this module BEFORE the code under test and calls `useBundledPlugins()` at
 * module scope:
 *
 *   import { useBundledPlugins } from "../../test/helpers/bundled-plugins.js";
 *   useBundledPlugins();
 *
 * Importing it also makes real plugin loads affordable. The loader runs plugin
 * sources through jiti and, with no built `dist/`, aliases
 * `infinibot/plugin-sdk` to `src/plugin-sdk/index.ts`; jiti then compiles the
 * SDK — most of `src/` — a second time inside the worker. Every `./x.js`
 * specifier that is really `./x.ts` fails resolution first (each failure
 * captures an unlimited stack trace) and a cold cache adds a Babel pass over
 * every file: ~60 s warm / ~100 s cold and ~1.5 GB of heap on a fast desktop,
 * and on a 2-core CI runner enough to blow the 120 s (and 300 s) test timeouts
 * and run a worker out of memory. Vitest can load the very same SDK, so jiti is
 * handed that in-process module instead. A plugin's own files still go through
 * jiti unchanged.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, vi } from "vitest";

const inProcess = vi.hoisted(() => ({ sdk: undefined as unknown }));

vi.mock("jiti", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jiti")>();
  const createJiti: typeof actual.createJiti = (id, options) =>
    actual.createJiti(
      id,
      inProcess.sdk === undefined
        ? options
        : {
            ...options,
            virtualModules: {
              ...options?.virtualModules,
              "infinibot/plugin-sdk": inProcess.sdk,
            },
          },
    );
  return { ...actual, createJiti };
});

// Loaded here rather than inside the mock factory: the SDK's own import graph
// reaches the plugin loader (and so `jiti`), and a factory that awaited it
// would wait on itself.
try {
  inProcess.sdk = await import("../../src/plugin-sdk/index.js");
} catch {
  // The test mocks something the SDK needs at import time. jiti then compiles
  // the SDK itself: slow, but still correct.
}

/** The repo's real `extensions/` tree. */
export const REPO_EXTENSIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../extensions",
);

/** Make `dir` (default: the real tree) the bundled plugins dir for every test in this file. */
export function useBundledPlugins(dir: string = REPO_EXTENSIONS_DIR): void {
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.INFINIBOT_BUNDLED_PLUGINS_DIR;
    process.env.INFINIBOT_BUNDLED_PLUGINS_DIR = dir;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.INFINIBOT_BUNDLED_PLUGINS_DIR;
    else process.env.INFINIBOT_BUNDLED_PLUGINS_DIR = previous;
  });
}
