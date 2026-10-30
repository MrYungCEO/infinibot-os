/**
 * Content Studio runtime seam — what the `content-studio` plugin calls into.
 *
 * Everything here is lazy: nothing under src/content, src/socials or the
 * content handler modules is imported until the plugin (which only loads when
 * enabled) asks for it. Core itself never calls these functions, so a gateway
 * with the plugin off never opens the content stores, never polls Instagram
 * and never registers a content RPC.
 *
 * Exposed to the plugin through `infinibot/plugin-sdk` (`contentStudio`).
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type {
  GatewayRequestHandler,
  GatewayRequestHandlers,
} from "../gateway/server-methods/types.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import {
  CONTENT_STUDIO_PLUGIN_ID,
  listContentStudioMethods,
  listContentStudioNativeMethods,
  isPostingMethod,
  type ContentStudioModule,
  type ContentStudioPipelineMethod,
  type ContentStudioPostingMethod,
} from "./methods.js";

const MODULE_LOADERS: Record<ContentStudioModule, () => Promise<GatewayRequestHandlers>> = {
  "content-intel": async () =>
    (await import("../gateway/server-methods/content-intel.js")).contentIntelHandlers,
  "viral-formats": async () =>
    (await import("../gateway/server-methods/viral-formats.js")).viralFormatsHandlers,
  "content-trends": async () =>
    (await import("../gateway/server-methods/content-trends.js")).contentTrendsHandlers,
  socials: async () => (await import("../gateway/server-methods/socials.js")).socialsHandlers,
  scripts: async () => (await import("../gateway/server-methods/scripts.js")).scriptsHandlers,
  "content-pages": async () =>
    (await import("../gateway/server-methods/content-pages.js")).contentPagesHandlers,
  instagram: async () => (await import("../gateway/server-methods/instagram.js")).instagramHandlers,
  manychat: async () => (await import("../gateway/server-methods/manychat.js")).manychatHandlers,
};

const moduleCache = new Map<ContentStudioModule, Promise<GatewayRequestHandlers>>();

function loadModule(module: ContentStudioModule): Promise<GatewayRequestHandlers> {
  let p = moduleCache.get(module);
  if (!p) {
    p = MODULE_LOADERS[module]();
    // A failed import must not poison later calls.
    p.catch(() => moduleCache.delete(module));
    moduleCache.set(module, p);
  }
  return p;
}

/**
 * Plugin-namespaced handlers (`content-studio.*`) for every content method.
 * Each one lazy-loads its handler module on first call and then delegates to
 * the legacy handler unchanged (same params, same response shape).
 */
export function createContentStudioHandlers(): Record<string, GatewayRequestHandler> {
  const out: Record<string, GatewayRequestHandler> = {};
  for (const { module, legacy, method } of listContentStudioMethods()) {
    out[method] = async (opts) => {
      let handlers: GatewayRequestHandlers;
      try {
        handlers = await loadModule(module);
      } catch (err) {
        opts.respond(false, undefined, {
          code: "UNAVAILABLE",
          message: `content studio: could not load ${module}: ${String(err)}`,
        });
        return;
      }
      const handler = handlers[legacy];
      if (!handler) {
        opts.respond(false, undefined, {
          code: "UNAVAILABLE",
          message: `content studio: ${legacy} is not implemented`,
        });
        return;
      }
      await handler(opts);
    };
  }
  // Plugin-native pipeline/pages/media methods: same lazy pattern, one module.
  for (const { method } of listContentStudioNativeMethods()) {
    if (isPostingMethod(method)) {
      out[method] = async (opts) => {
        let handlers: Record<ContentStudioPostingMethod, GatewayRequestHandler>;
        try {
          handlers = await loadPostingHandlers();
        } catch (err) {
          opts.respond(false, undefined, {
            code: "UNAVAILABLE",
            message: `content studio: could not load posting: ${String(err)}`,
          });
          return;
        }
        await handlers[method](opts);
      };
      continue;
    }
    out[method] = async (opts) => {
      let handlers: Record<ContentStudioPipelineMethod, GatewayRequestHandler>;
      try {
        handlers = await loadPipelineHandlers();
      } catch (err) {
        opts.respond(false, undefined, {
          code: "UNAVAILABLE",
          message: `content studio: could not load pipeline: ${String(err)}`,
        });
        return;
      }
      await handlers[method](opts);
    };
  }
  return out;
}

let pipelineHandlers: Promise<Record<ContentStudioPipelineMethod, GatewayRequestHandler>> | null =
  null;

let postingHandlers: Promise<Record<ContentStudioPostingMethod, GatewayRequestHandler>> | null =
  null;

function loadPostingHandlers(): Promise<Record<ContentStudioPostingMethod, GatewayRequestHandler>> {
  if (!postingHandlers) {
    postingHandlers = import("./posting-methods.js").then((m) => m.createPostingHandlers());
    postingHandlers.catch(() => {
      postingHandlers = null;
    });
  }
  return postingHandlers;
}

function loadPipelineHandlers(): Promise<
  Record<ContentStudioPipelineMethod, GatewayRequestHandler>
> {
  if (!pipelineHandlers) {
    pipelineHandlers = import("./pipeline-methods.js").then((m) => m.createPipelineHandlers());
    pipelineHandlers.catch(() => {
      pipelineHandlers = null;
    });
  }
  return pipelineHandlers;
}

/**
 * Video posting queue ticker. `host` carries core's approval registry, owner
 * alerts and LLM from the plugin api (api.runtime.host), since the plugin runs
 * in its own module instance. Returns a stop handle.
 */
export async function startContentStudioPosting(
  host: import("./posting-runner.js").PostingHost,
  opts: { tickMs?: number } = {},
): Promise<ContentStudioServiceHandle> {
  const { ensurePagesStore, getPostingRunner, setPostingHost } =
    await import("./posting-service.js");
  setPostingHost(host);
  await ensurePagesStore();
  const runner = getPostingRunner();
  runner.start(opts.tickMs);
  return { stop: () => runner.stop() };
}

/**
 * GET/POST /plugins/content-studio/media — serve (Range-capable) or upload
 * (raw body; ?filename=&ownerKind=&ownerId=) Content Studio media.
 */
export async function handleContentStudioMedia(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const { getContentStudio } = await import("./studio.js");
  await getContentStudio().media.handleHttp(req, res);
}

/** Legacy content stores read `INFINIBOT_STATE_DIR` or the cwd-relative "state". */
export function contentLegacyStateDir(): string {
  return process.env.INFINIBOT_STATE_DIR || process.env.MOLTBOT_STATE_DIR || "state";
}

export type ContentStudioServiceHandle = { stop: () => void };

/**
 * Instagram background sync — starts only when a content page has a connected
 * Instagram Graph integration (same gate core used before the move).
 */
export async function startContentStudioInstagramSync(log: {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}): Promise<ContentStudioServiceHandle> {
  const stateDir = contentLegacyStateDir();
  const { startWhenConfigured } = await import("../gateway/integration-poller-gate.js");
  let stopped = false;
  let stopSync: (() => void) | undefined;
  const gate = await startWhenConfigured({
    name: "instagram background sync",
    isConfigured: async () => {
      if (stopped) return false;
      const { getContentPagesStore } = await import("../content/pages-store.js");
      return getContentPagesStore(stateDir)
        .list({ includeArchived: false })
        .some((page) => page.integrations?.instagramGraph?.connected === true);
    },
    start: async () => {
      if (stopped) return;
      const { startInstagramBgSync } = await import("../content/instagram-bg-sync.js");
      stopSync = startInstagramBgSync(stateDir, { runOnStart: true }).stop;
    },
    log,
  });
  return {
    stop: () => {
      stopped = true;
      gate.stop();
      stopSync?.();
    },
  };
}

/**
 * GET /plugins/content-studio/video?shortcode=<sc> — stream a locally
 * downloaded reel (Range-capable). Replaces core's /api/content-intel/video/.
 */
export async function handleContentStudioVideo(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const shortcode = url.searchParams.get("shortcode") ?? "";
  const { streamReelVideo } = await import("../gateway/content-intel-video-http.js");
  await streamReelVideo(shortcode, req, res);
}

/** True while the content-studio plugin is loaded on this gateway. */
export function isContentStudioActive(): boolean {
  const registry = getActivePluginRegistry();
  return Boolean(
    registry?.plugins.some((p) => p.id === CONTENT_STUDIO_PLUGIN_ID && p.status === "loaded"),
  );
}
