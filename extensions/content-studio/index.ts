/**
 * Content Studio — first-party InfiniBot plugin (manifest v2).
 *
 * Content › Pages and Content › Intelligence used to be core surfaces. They
 * are now contributed by this plugin, which is bundled but OFF on a fresh
 * install (upgrading installs with content data are switched on once — see
 * src/content-studio/migration.ts). While enabled it contributes:
 *   - the two pages (plugin-gated tabs `content-pages`, `content-intel`) and
 *     the "Content" sidebar entry;
 *   - every content RPC as `content-studio.*`, plus the legacy names
 *     (`content.pages.*`, `content.intel.*`, `scripts.*`, `viralExamples.*`,
 *     `viral.formats.*`, `socials.*`, `instagram.*`, `manychat.*`,
 *     `content.trends.*`) as manifest-declared aliases, so the control UI,
 *     mobile app and satellites keep calling the names they know;
 *   - the production pipeline: a drag-and-drop stage board, a rich markdown
 *     page per content item, free-form Ideas pages and their media
 *     (`content-studio.board/stages/items/docs/ideas/media.*`, plugin-native,
 *     no legacy alias) with media served/uploaded at
 *     /plugins/content-studio/media;
 *   - the agent tools content_intel, script, viral_watch, content_pipeline and
 *     content_posting;
 *   - the video posting queue (`content-studio.posting.*`): each page bound to
 *     one Droid Swarm phone + its logged-in Instagram/TikTok account, a
 *     schedule, a caption template and an ordered queue, drained by the
 *     `content-studio-posting` ticker through Droid Swarm's publisher
 *     (`droid-swarm.publisher.*`, called through the shared plugin registry);
 *   - the CMO / content roster agents (agents/roster.json);
 *   - the Instagram background sync service and the reel video route.
 *
 * The backend code still compiles into core and is reached only through the
 * `contentStudio` seam in `infinibot/plugin-sdk`, which lazy-loads it. Turning
 * the plugin off unregisters all of the above; stored data is never touched.
 *
 * Docs: docs/plugins/CONTENT-STUDIO.md.
 */

import type { InfiniBotPluginApi, InfiniBotPluginService } from "infinibot/plugin-sdk";
import { contentStudio } from "infinibot/plugin-sdk";

type ContentStudioConfig = { instagramSync: boolean };

function readConfig(raw: Record<string, unknown> | undefined): ContentStudioConfig {
  return { instagramSync: raw?.instagramSync !== false };
}

export default function register(api: InfiniBotPluginApi) {
  const cfg = readConfig(api.pluginConfig);

  for (const [method, handler] of Object.entries(contentStudio.createHandlers())) {
    api.registerGatewayMethod(method, handler);
  }

  api.registerTool((ctx) => contentStudio.createTools({ agentId: ctx.agentId }), {
    names: [...contentStudio.toolNames],
  });

  api.registerHttpRoute({
    path: "/plugins/content-studio/video",
    handler: (req, res) => contentStudio.handleVideo(req, res),
  });

  api.registerHttpRoute({
    path: "/plugins/content-studio/media",
    handler: (req, res) => contentStudio.handleMedia(req, res),
  });

  let sync: { stop: () => void } | null = null;
  const instagramSync: InfiniBotPluginService = {
    id: "content-studio-instagram-sync",
    start: async () => {
      if (!cfg.instagramSync) return;
      sync = await contentStudio.startInstagramSync({
        info: (msg) => api.logger.info(msg),
        warn: (msg) => api.logger.warn(msg),
      });
    },
    stop: () => {
      sync?.stop();
      sync = null;
    },
  };
  api.registerService(instagramSync);

  // Video posting queue ticker: drains each page's queue through Droid Swarm
  // (droid-swarm.publisher.* via the shared plugin registry). Core's approval
  // registry, owner alerts and LLM come from api.runtime.host because this
  // plugin runs in its own module instance.
  let posting: { stop: () => void } | null = null;
  api.registerService({
    id: "content-studio-posting",
    start: async () => {
      const host = api.runtime?.host;
      posting = await contentStudio.startPosting({
        approvals: host?.approvals ?? null,
        alertOwner: host?.alertOwner ?? null,
        runLLM: host?.runLLM ?? null,
        log: { info: (msg) => api.logger.info(msg), warn: (msg) => api.logger.warn(msg) },
      });
    },
    stop: () => {
      posting?.stop();
      posting = null;
    },
  });
}
