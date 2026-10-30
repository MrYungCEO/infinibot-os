/**
 * Content Studio posting service — one PostingRunner per tenant data dir,
 * sharing the pipeline's studio.db and media library. The host hooks
 * (approvals, owner alerts, LLM) come from the plugin api via setPostingHost.
 */

import { resolvePluginDataDir } from "../plugins/plugin-data.js";
import { CONTENT_STUDIO_PLUGIN_ID } from "./methods.js";
import { registryDroidPublisher, type DroidPublisher } from "./posting-droid.js";
import { PostingRunner, type PageInfo, type PostingHost } from "./posting-runner.js";
import { PostingStore } from "./posting-store.js";
import { getContentStudio } from "./studio.js";

let host: PostingHost = {};
let droidOverride: DroidPublisher | null = null;
const runners = new Map<string, PostingRunner>();

export function setPostingHost(next: PostingHost): void {
  host = next ?? {};
}

export function getPostingHost(): PostingHost {
  return host;
}

/** Test hook: swap the Droid Swarm adapter (null restores the registry one). */
export function setPostingDroid(droid: DroidPublisher | null): void {
  droidOverride = droid;
  for (const r of runners.values()) r.stop();
  runners.clear();
}

function legacyStateDir(): string {
  return process.env.INFINIBOT_STATE_DIR || process.env.MOLTBOT_STATE_DIR || "state";
}

/** Content page lookup (legacy content pages store). */
export function lookupContentPage(pageId: string): PageInfo | null {
  const page = pagesStore().get(pageId);
  return page && !page.deletedAt
    ? { id: page.id, name: page.name, handle: page.handle ?? null }
    : null;
}

let pagesStoreRef: {
  get: (
    id: string,
  ) => { id: string; name: string; handle?: string; deletedAt?: number | null } | null;
} | null = null;
function pagesStore() {
  if (!pagesStoreRef) throw new Error("content pages store not loaded");
  return pagesStoreRef;
}

export async function ensurePagesStore(): Promise<void> {
  if (pagesStoreRef) return;
  const { getContentPagesStore } = await import("../content/pages-store.js");
  pagesStoreRef = getContentPagesStore(legacyStateDir());
}

/** Test hook: provide a page lookup without the legacy store. */
export function setPostingPageLookup(
  lookup: {
    get: (
      id: string,
    ) => { id: string; name: string; handle?: string; deletedAt?: number | null } | null;
  } | null,
): void {
  pagesStoreRef = lookup;
}

/**
 * Post verification source: the page's Instagram account's latest media via
 * the Graph API, when the page has Instagram connected (null otherwise).
 */
async function instagramRecentMedia(
  pageId: string,
  platform: string,
): Promise<Array<{ permalink: string; caption: string; timestamp: number }> | null> {
  if (platform !== "instagram") return null;
  type IgPage = {
    integrations?: {
      instagramGraph?: { connected?: boolean; igPageId?: string; accessTokenRef?: string };
    };
  };
  const page = ((): IgPage | null => {
    try {
      return pagesStore().get(pageId) as IgPage | null;
    } catch {
      return null;
    }
  })();
  const ig = page?.integrations?.instagramGraph;
  if (ig?.connected !== true) return null;
  const { readInstagramSecrets } = await import("../content/instagram-secrets.js");
  const token = ig.accessTokenRef || readInstagramSecrets()?.accessToken;
  if (!token) return null;
  const { InstagramClient } = await import("../funnels/integrations/instagram-client.js");
  const media = await new InstagramClient(token, ig.igPageId).getMedia(10);
  return media
    .filter((m) => m.permalink)
    .map((m) => ({
      permalink: m.permalink,
      caption: m.caption ?? "",
      timestamp: Date.parse(m.timestamp) || 0,
    }));
}

export function getPostingRunner(
  dataDir = resolvePluginDataDir(CONTENT_STUDIO_PLUGIN_ID),
): PostingRunner {
  let r = runners.get(dataDir);
  if (!r) {
    const studio = getContentStudio(dataDir);
    r = new PostingRunner({
      studio,
      posting: new PostingStore(studio.store.db),
      droid: droidOverride ?? registryDroidPublisher,
      host: new Proxy({} as PostingHost, {
        get: (_t, k) => (host as Record<string, unknown>)[k as string],
      }),
      page: (id) => {
        try {
          return lookupContentPage(id);
        } catch {
          return null;
        }
      },
      recentMedia: instagramRecentMedia,
    });
    runners.set(dataDir, r);
  }
  return r;
}

/** Test hook. */
export function resetPostingRunners(): void {
  for (const r of runners.values()) r.stop();
  runners.clear();
}
